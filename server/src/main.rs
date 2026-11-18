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
    db: Pool,
    catalog: Arc<Catalog>,
    changes: broadcast::Sender<String>,
    grace: i64,
}
type Result<T> = std::result::Result<T, Error>;
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
fn token(h: &HeaderMap) -> Option<&str> {
    h.get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|s| s.trim().strip_prefix("clash_session="))
}
async fn player(app: &App, h: &HeaderMap) -> Result<String> {
    let key = token(h).unwrap_or("");
    app.db
        .get()
        .await?
        .query_opt("SELECT id FROM guests WHERE token=$1", &[&key])
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
        .query_opt("SELECT config,status FROM matches WHERE id=$1", &[&mid])
        .await?
        .ok_or_else(|| fail("找不到这场比赛"))?;
    let cfg: Value = row.get(0);
    let seats = cfg["seats"].as_array().unwrap();
    let me = seats
        .iter()
        .position(|s| s["player"] == p)
        .ok_or_else(|| fail("你没有这场比赛的席位"))?;
    Ok(Json(
        json!({"id":mid,"roomId":cfg["roomId"],"mode":cfg["mode"],"map":cfg["map"],"round":cfg["round"],"me":me,"opponent":seats[1-me]["name"],"deck":seats[me]["deck"],"status":row.get::<_,String>(1)}),
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
    let catalog: Catalog =
        serde_json::from_str(include_str!("../../content/catalog.json")).unwrap();
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
        db,
        catalog: Arc::new(catalog),
        changes,
        grace,
    };
    tokio::spawn(room::presence_loop(app.clone()));
    let router = Router::new()
        .route("/api/session", get(session::bootstrap))
        .route(
            "/api/catalog",
            get(|| async {
                (
                    [(axum::http::header::CONTENT_TYPE, "application/json")],
                    include_str!("../../content/catalog.json"),
                )
            }),
        )
        .route("/api/presets", post(session::save_preset))
        .route(
            "/api/presets/{id}",
            axum::routing::delete(session::remove_preset),
        )
        .route("/api/rooms", post(room::create))
        .route("/api/join", post(room::join))
        .route("/api/rooms/{id}", get(room::read).post(room::act))
        .route("/api/matches/{id}", get(match_view))
        .route("/api/live", get(session::live))
        .route("/", get(|| async { Redirect::temporary("/play/") }))
        .nest_service(
            "/play",
            ServeDir::new("web/dist").fallback(ServeFile::new("web/dist/index.html")),
        )
        .with_state(app);
    let addr = std::env::var("LOBBY_ADDR").unwrap_or_else(|_| "127.0.0.1:4317".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    eprintln!("ClashLegends lobby http://{addr}/play/");
    axum::serve(listener, router).await.unwrap();
}
