mod accounts;
mod battle;
mod model;
mod room;
mod session;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use deadpool_postgres::{Manager, Pool};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

use model::Catalog;

#[derive(Clone)]
struct App {
    accounts: Arc<accounts::Registry>,
    db: Pool,
    catalog: Arc<Catalog>,
    collection: Arc<Catalog>,
    battles: battle::Hosts,
    changes: broadcast::Sender<String>,
    grace: i64,
}
type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Debug)]
struct Error(StatusCode, String);
fn fail(s: impl Into<String>) -> Error {
    Error(StatusCode::CONFLICT, s.into())
}
fn id() -> String {
    Uuid::new_v4().to_string()
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<tokio_postgres::Error> for Error {
    fn from(e: tokio_postgres::Error) -> Self {
        eprintln!("database: {e:?}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "数据库操作失败，请重试".into(),
        )
    }
}
impl From<deadpool_postgres::PoolError> for Error {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        eprintln!("pool: {e}");
        Self(StatusCode::SERVICE_UNAVAILABLE, "暂时无法连接数据库".into())
    }
}
fn decode<T: serde::de::DeserializeOwned>(v: Value) -> Result<T> {
    serde_json::from_value(v).map_err(|_| fail("数据格式无效"))
}
fn cookie<'a>(h: &'a HeaderMap, prefix: &str) -> Option<&'a str> {
    h.get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|s| s.trim().strip_prefix(prefix))
}
async fn player(app: &App, h: &HeaderMap) -> Result<String> {
    if let Some((p, _)) = accounts::identity(app, h).await? {
        return Ok(p);
    }
    let key = cookie(h, "clash_session=").unwrap_or("");
    app.db
        .get()
        .await?
        .query_opt(
            "SELECT id FROM guests WHERE token=$1 AND id NOT LIKE 'account/%'",
            &[&key],
        )
        .await?
        .map(|r| r.get(0))
        .ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "请重新进入大厅".into()))
}
async fn match_view(
    State(app): State<App>,
    h: HeaderMap,
    Path(mid): Path<String>,
) -> Result<Json<Value>> {
    let p = player(&app, &h).await?;
    let db = app.db.get().await?;
    let row = db
        .query_opt(
            "SELECT config,status,result FROM matches WHERE id=$1",
            &[&mid],
        )
        .await?
        .ok_or_else(|| fail("找不到这场比赛"))?;
    let cfg: Value = row.get(0);
    let seats = cfg["seats"].as_array().unwrap();
    let me = seats
        .iter()
        .position(|s| s["player"] == p)
        .ok_or_else(|| fail("你没有这场比赛的席位"))?;
    let result: Option<Value> = row.get(2);
    Ok(Json(
        json!({"assetVersion":env!("BATTLE_ASSETS"),"modelResources":model::match_model_resources(&seats[me]["deck"],me), "result":result,"playable":battle::compatible(&cfg,&app.catalog),"id":mid,"roomId":cfg["roomId"],"mode":cfg["mode"],"map":cfg["map"],"round":cfg["round"],"me":me,"opponent":seats[1-me]["name"],"deck":seats[me]["deck"],"status":if result.is_some() {"finished".into()} else {row.get::<_,String>(1)}}),
    ))
}
#[tokio::main]
async fn main() {
    let db_url = std::env::var("DATABASE_URL").expect("Set DATABASE_URL before starting the lobby");
    let db = Pool::builder(Manager::new(
        db_url.parse().expect("database URL"),
        tokio_postgres::NoTls,
    ))
    .max_size(16)
    .build()
    .unwrap();
    db.get()
        .await
        .expect("connect PostgreSQL")
        .batch_execute(include_str!("../schema.sql"))
        .await
        .expect("initialize lobby schema");
    let public_collection = model::collection_catalog();
    let collection: Catalog = serde_json::from_value(public_collection.clone()).unwrap();
    let addr = std::env::var("LOBBY_ADDR").unwrap_or_else(|_| "127.0.0.1:4317".into());
    let workbench_enabled = std::env::var("LOBBY_WORKBENCH").map_or_else(
        |_| {
            addr.parse::<std::net::SocketAddr>()
                .is_ok_and(|a| a.ip().is_loopback())
        },
        |value| value == "1",
    );
    let mut public = model::battle_catalog();
    public["workbench"] = json!(workbench_enabled);
    let catalog: Catalog = serde_json::from_value(public.clone()).unwrap();
    catalog
        .check(&catalog.default_loadout())
        .unwrap_or_else(|e| panic!("{}", e.1));
    let (changes, _) = broadcast::channel(128);
    let grace = std::env::var("LOBBY_GRACE_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120i64)
        .max(30);
    let app = App {
        accounts: Arc::new(accounts::registry()),
        db,
        catalog: Arc::new(catalog),
        collection: Arc::new(collection),
        battles: Default::default(),
        changes,
        grace,
    };
    let _host_lease = battle::initialize(&app)
        .await
        .expect("initialize battle host");
    tokio::spawn(room::presence_loop(app.clone()));
    let router = Router::new()
        .route("/api/session", get(session::bootstrap))
        .route(
            "/api/catalog",
            get(move || async { Json(public_collection) }),
        )
        .route("/api/battle/catalog", get(move || async { Json(public) }))
        .route("/api/matches/{id}/live", get(battle::live))
        .route("/api/rooms", post(room::create))
        .route("/api/join", post(room::join))
        .route("/api/rooms/{id}", get(room::read).post(room::act))
        .route("/api/matches/{id}", get(match_view))
        .route("/api/live", get(session::live))
        .route("/", get(|| async { Redirect::temporary("/play/") }))
        .nest_service(
            "/play",
            ServeDir::new("web/dist").fallback(ServeFile::new("web/dist/index.html")),
        );
    let router = if app.accounts.is_empty() {
        router
    } else {
        router
            .route("/api/account/login", post(accounts::login))
            .route("/api/account/logout", post(accounts::logout))
            .route("/api/account/data", post(accounts::save))
    };
    let router = if workbench_enabled {
        router.route("/api/workbench/live", get(battle::workbench::live))
    } else {
        router
    }
    .with_state(app);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    eprintln!("ClashLegends lobby http://{addr}/play/");
    axum::serve(listener, router).await.unwrap();
}
