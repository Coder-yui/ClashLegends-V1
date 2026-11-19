use super::*;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::header::SET_COOKIE;
use model::Deck;
use serde::Deserialize;
use std::time::Duration;

pub async fn bootstrap(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    let db = app.db.get().await?;
    let old = token(&h).unwrap_or("");
    let existing = db
        .query_opt("SELECT id,name FROM guests WHERE token=$1", &[&old])
        .await?;
    let (p, name, new_token) = if let Some(row) = existing {
        (row.get(0), row.get(1), None)
    } else {
        let p = id();
        let key = id();
        let name = format!("召唤师 {}", &p[..4].to_uppercase());
        db.execute(
            "INSERT INTO guests(id,token,name) VALUES($1,$2,$3)",
            &[&p, &key, &name],
        )
        .await?;
        (p, name, Some(key))
    };
    let room = db
        .query_opt("SELECT room_id FROM members WHERE guest_id=$1", &[&p])
        .await?
        .map(|r| r.get::<_, String>(0));
    let presets:Vec<Value>=db.query("SELECT id,name,deck,revision FROM presets WHERE owner_id=$1 ORDER BY (id IS NOT DISTINCT FROM (SELECT last_preset FROM guests WHERE id=$1)) DESC,name,id",&[&p]).await?.iter().map(|r|json!({"id":r.get::<_,String>(0),"name":r.get::<_,String>(1),"deck":r.get::<_,Value>(2),"battleDeck":decode::<Deck>(r.get(2)).ok().and_then(|d|app.catalog.room_deck(d)),"revision":r.get::<_,i64>(3)})).collect();
    let mut resp = Json(json!({"name":name,"roomId":room,"presets":presets})).into_response();
    resp.headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    if let Some(key) = new_token {
        resp.headers_mut().insert(
            SET_COOKIE,
            format!("clash_session={key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000")
                .parse()
                .unwrap(),
        );
    }
    Ok(resp)
}
#[derive(Deserialize)]
pub struct Preset {
    id: Option<String>,
    name: String,
    deck: Deck,
    revision: Option<i64>,
}
pub async fn save_preset(
    State(app): State<App>,
    h: HeaderMap,
    Json(input): Json<Preset>,
) -> Result<Json<Value>> {
    let p = player(&app, &h).await?;
    if app.catalog.check(&input.deck).is_err() {
        app.collection.check(&input.deck)?;
    }
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 32 {
        return Err(fail("卡组名需为 1–32 个字"));
    }
    let mut db = app.db.get().await?;
    let tx = db.transaction().await?;
    let deck = json!(input.deck);
    let key = if let Some(key) = input.id {
        let n=tx.execute("UPDATE presets SET name=$1,deck=$2,revision=revision+1 WHERE id=$3 AND owner_id=$4 AND revision=$5",&[&name,&deck,&key,&p,&input.revision]).await?;
        if n == 0 {
            return Err(fail("预设已更改，请重新载入"));
        }
        key
    } else {
        let key = id();
        tx.execute(
            "INSERT INTO presets(id,owner_id,name,deck) VALUES($1,$2,$3,$4)",
            &[&key, &p, &name, &deck],
        )
        .await?;
        key
    };
    tx.execute("UPDATE guests SET last_preset=$1 WHERE id=$2", &[&key, &p])
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"id":key})))
}
pub async fn remove_preset(
    State(app): State<App>,
    h: HeaderMap,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    let p = player(&app, &h).await?;
    app.db
        .get()
        .await?
        .execute(
            "DELETE FROM presets WHERE id=$1 AND owner_id=$2",
            &[&key, &p],
        )
        .await?;
    Ok(Json(json!({})))
}
pub async fn live(State(app): State<App>, h: HeaderMap, ws: WebSocketUpgrade) -> Result<Response> {
    let p = player(&app, &h).await?;
    check_origin(&h)?;
    Ok(ws.on_upgrade(move |socket| async move {
        if let Err(e) = stream(app, p, socket).await {
            eprintln!("socket: {}", e.1)
        }
    }))
}
pub(super) fn check_origin(h: &HeaderMap) -> Result<()> {
    if let Some(origin) = h.get("origin") {
        let uri = origin
            .to_str()
            .ok()
            .and_then(|s| s.parse::<axum::http::Uri>().ok());
        if uri.as_ref().and_then(|u| u.authority()).map(|a| a.as_str())
            != h.get("host").and_then(|v| v.to_str().ok())
        {
            return Err(fail("连接来源无效"));
        }
    }
    Ok(())
}
async fn stream(app: App, p: String, mut ws: WebSocket) -> Result<()> {
    let mut changes = app.changes.subscribe();
    let mut timer = tokio::time::interval(Duration::from_secs(5));
    let mut last = tokio::time::Instant::now();
    loop {
        tokio::select! {
            msg=ws.recv()=>match msg {
                Some(Ok(Message::Pong(_)))=>{last=tokio::time::Instant::now();app.db.get().await?.execute("UPDATE guests SET last_seen=now() WHERE id=$1",&[&p]).await?;}
                Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,
                _=>{}
            },
            _=timer.tick()=>{if last.elapsed()>Duration::from_secs(20)||ws.send(Message::Ping(vec![1].into())).await.is_err(){break}},
            event=changes.recv()=> {
                let notify=match event {Ok(who)=>who==p,Err(broadcast::error::RecvError::Lagged(_))=>true,Err(_)=>break};
                if notify && ws.send(Message::Text("refresh".into())).await.is_err(){break}
            }
        }
    }
    Ok(())
}
