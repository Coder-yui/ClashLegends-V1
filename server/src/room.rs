use super::*;
use deadpool_postgres::Transaction;
use model::{Deck, Room, Seat};
use serde::Deserialize;
use std::time::Duration;

pub(super) async fn fetch(tx: &Transaction<'_>, rid: &str) -> Result<Room> {
    let row = tx
        .query_opt("SELECT data FROM rooms WHERE id=$1 FOR UPDATE", &[&rid])
        .await?
        .ok_or_else(|| fail("房间不存在"))?;
    decode(row.get(0))
}
pub(super) async fn store(tx: &Transaction<'_>, r: &mut Room) -> Result<()> {
    r.revision += 1;
    tx.execute("UPDATE rooms SET data=$1 WHERE id=$2", &[&json!(r), &r.id])
        .await?;
    Ok(())
}
pub(super) fn notify(app: &App, r: &Room) {
    for s in &r.seats {
        if !s.ai {
            let _ = app.changes.send(s.player.clone());
        }
    }
}
async fn member(tx: &Transaction<'_>, p: &str) -> Result<Option<String>> {
    tx.query_one("SELECT id FROM guests WHERE id=$1 FOR UPDATE", &[&p])
        .await?;
    Ok(tx
        .query_opt("SELECT room_id FROM members WHERE guest_id=$1", &[&p])
        .await?
        .map(|row| row.get(0)))
}
async fn seat(tx: &Transaction<'_>, app: &App, p: &str, requested: Option<Deck>) -> Result<Seat> {
    let row = tx
        .query_one("SELECT name FROM guests WHERE id=$1", &[&p])
        .await?;
    let deck = requested.unwrap_or_else(|| app.catalog.default_loadout());
    app.catalog.check(&deck)?;
    tx.execute("UPDATE guests SET last_seen=now() WHERE id=$1", &[&p])
        .await?;
    Ok(Seat {
        player: p.to_owned(),
        name: row.get(0),
        deck,
        ready: false,
        version: 1,
        ai: false,
        online: true,
    })
}
#[derive(Deserialize)]
pub struct Setup {
    deck: Option<Deck>,
    kind: String,
    mode: String,
    map: String,
}
pub async fn create(
    State(app): State<App>,
    h: HeaderMap,
    Json(s): Json<Setup>,
) -> Result<Json<Value>> {
    let p = player(&app, &h).await?;
    app.catalog.settings(&s.mode, &s.map)?;
    if !["ai", "friend"].contains(&s.kind.as_str()) {
        return Err(fail("对手类型无效"));
    }
    let mut db = app.db.get().await?;
    let tx = db.transaction().await?;
    if member(&tx, &p).await?.is_some() {
        return Err(fail("请先返回或离开当前房间"));
    }
    let mut seats = vec![seat(&tx, &app, &p, s.deck).await?];
    if s.kind == "ai" {
        seats.push(Seat {
            player: "ai".into(),
            name: "训练机器人".into(),
            deck: app.catalog.ai_loadout()?,
            ready: true,
            version: 1,
            ai: true,
            online: true,
        });
    }
    let r = Room {
        id: id(),
        code: id()[..8].to_uppercase(),
        kind: s.kind,
        mode: s.mode,
        map: s.map,
        round: 1,
        settings_version: 1,
        revision: 1,
        status: "open".into(),
        match_id: None,
        seats,
    };
    tx.execute(
        "INSERT INTO rooms(id,code,data) VALUES($1,$2,$3)",
        &[&r.id, &r.code, &json!(r)],
    )
    .await?;
    tx.execute(
        "INSERT INTO members(guest_id,room_id) VALUES($1,$2)",
        &[&p, &r.id],
    )
    .await?;
    tx.commit().await?;
    notify(&app, &r);
    Ok(Json(r.view(&p)?))
}
#[derive(Deserialize)]
pub struct Invite {
    deck: Option<Deck>,
    code: String,
}
pub async fn join(
    State(app): State<App>,
    h: HeaderMap,
    Json(i): Json<Invite>,
) -> Result<Json<Value>> {
    let p = player(&app, &h).await?;
    let mut db = app.db.get().await?;
    let tx = db.transaction().await?;
    let current = member(&tx, &p).await?;
    let row = tx
        .query_opt(
            "SELECT id FROM rooms WHERE code=$1",
            &[&i.code.trim().to_uppercase()],
        )
        .await?
        .ok_or_else(|| fail("邀请码无效，请检查后重试"))?;
    let rid: String = row.get(0);
    let mut r = fetch(&tx, &rid).await?;
    if current.as_ref() == Some(&rid) {
        return Ok(Json(r.view(&p)?));
    }
    if current.is_some() {
        return Err(fail("你已有活动房间，请先离开"));
    }
    if r.status != "open" {
        return Err(fail("房间已关闭或已锁定"));
    }
    if r.kind != "friend" || r.seats.len() != 1 {
        return Err(fail("房间已满"));
    }
    r.seats.push(seat(&tx, &app, &p, i.deck).await?);
    r.settings_version += 1;
    r.reset_ready();
    tx.execute(
        "INSERT INTO members(guest_id,room_id) VALUES($1,$2)",
        &[&p, &rid],
    )
    .await?;
    store(&tx, &mut r).await?;
    tx.commit().await?;
    notify(&app, &r);
    Ok(Json(r.view(&p)?))
}
pub async fn read(
    State(app): State<App>,
    h: HeaderMap,
    Path(rid): Path<String>,
) -> Result<Json<Value>> {
    let p = player(&app, &h).await?;
    let db = app.db.get().await?;
    let row = db
        .query_opt("SELECT data FROM rooms WHERE id=$1", &[&rid])
        .await?
        .ok_or_else(|| fail("房间不存在"))?;
    let r: Room = decode(row.get(0))?;
    Ok(Json(r.view(&p)?))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    action: String,
    round: i32,
    settings_version: i64,
    deck_version: i64,
    deck: Option<Deck>,
    ready: Option<bool>,
    mode: Option<String>,
    map: Option<String>,
}
async fn leave(tx: &Transaction<'_>, r: &mut Room, i: usize) -> Result<()> {
    if i == 0 {
        r.status = "closed".into();
        tx.execute("DELETE FROM members WHERE room_id=$1", &[&r.id])
            .await?;
    } else {
        let guest = r.seats.remove(i);
        tx.execute("DELETE FROM members WHERE guest_id=$1", &[&guest.player])
            .await?;
    }
    r.settings_version += 1;
    r.reset_ready();
    Ok(())
}
pub async fn act(
    State(app): State<App>,
    h: HeaderMap,
    Path(rid): Path<String>,
    Json(a): Json<Action>,
) -> Result<Json<Value>> {
    let p = player(&app, &h).await?;
    let mut db = app.db.get().await?;
    let tx = db.transaction().await?;
    let mut r = fetch(&tx, &rid).await?;
    let i = r.index(&p)?;
    if r.round != a.round || r.status == "closed" {
        return Err(fail("房间轮次已变化，请查看最新状态"));
    }
    if a.action == "reopen" {
        if i != 0 || r.status != "locked" {
            return Err(fail("仅房主可重新组局"));
        }
        let n = tx
            .execute(
                "UPDATE matches SET status='withdrawn' WHERE id=$1 AND status='pending'",
                &[&r.match_id],
            )
            .await?;
        if n != 1 {
            return Err(fail("对局宿主已接管这场比赛"));
        }
        r.match_id = None;
        r.round += 1;
        r.status = "open".into();
        r.migrate_decks(&app.catalog)?;
        r.reset_ready();
    } else if r.status == "locked" || r.status == "playing" {
        return Ok(Json(r.view(&p)?));
    } else {
        if r.settings_version != a.settings_version
            || (a.action != "leave" && r.seats[i].version != a.deck_version)
        {
            return Err(fail("配置已更新，请重新确认"));
        }
        match a.action.as_str() {
            "settings" => {
                if i != 0 {
                    return Err(fail("仅房主可更改设置"));
                }
                let m = a.mode.unwrap_or_default();
                let map = a.map.unwrap_or_default();
                r.change_settings(&app.catalog, m, map)?;
            }
            "deck" => {
                let d = a.deck.ok_or_else(|| fail("缺少卡组"))?;
                app.catalog.check(&d)?;
                if r.seats[i].deck != d {
                    r.seats[i].deck = d;
                    r.seats[i].version += 1;
                    r.seats[i].ready = false;
                }
            }
            "ready" => {
                let value = a.ready.ok_or_else(|| fail("缺少准备状态"))?;
                if value {
                    let recent:Vec<String>=tx.query("SELECT guest_id FROM members JOIN guests ON guests.id=guest_id WHERE room_id=$1 AND last_seen > now()-interval '20 seconds'",&[&rid]).await?.iter().map(|row|row.get(0)).collect();
                    if r.seats.len() != 2
                        || r.seats
                            .iter()
                            .any(|s| !s.ai && (!s.online || !recent.contains(&s.player)))
                    {
                        return Err(fail("请等待双方在线并入座"));
                    }
                    app.catalog.check(&r.seats[i].deck)?;
                }
                r.seats[i].ready = value;
                if value && r.seats.iter().all(|s| s.ready) {
                    if std::env::var_os("LOBBY_DRAIN_FILE")
                        .is_some_and(|p| std::path::Path::new(&p).exists())
                    {
                        return Err(fail("当前对局可继续，版本更新期间暂停开新局"));
                    }
                    let cfg = r.freeze(&app.catalog)?;
                    tx.execute(
                        "INSERT INTO matches(id,room_id,round,config) VALUES($1,$2,$3,$4)",
                        &[&r.match_id, &rid, &r.round, &cfg],
                    )
                    .await?;
                }
            }
            "leave" => {
                leave(&tx, &mut r, i).await?;
            }
            _ => return Err(fail("未知房间操作")),
        }
    }
    store(&tx, &mut r).await?;
    tx.commit().await?;
    notify(&app, &r);
    if a.action == "leave" {
        let _ = app.changes.send(p);
        return Ok(Json(json!({"left":true})));
    }
    Ok(Json(r.view(&p)?))
}
pub async fn presence_loop(app: App) {
    let mut timer = tokio::time::interval(Duration::from_secs(4));
    loop {
        timer.tick().await;
        if let Err(e) = sweep(&app).await {
            eprintln!("presence: {}", e.1);
        }
    }
}
async fn sweep(app: &App) -> Result<()> {
    let mut db = app.db.get().await?;
    let rows=db.query("SELECT DISTINCT m.room_id FROM members m JOIN guests g ON g.id=m.guest_id JOIN rooms r ON r.id=m.room_id CROSS JOIN LATERAL jsonb_array_elements(r.data->'seats') s WHERE r.data->>'status'='open' AND s->>'player'=g.id AND ((s->>'online')::boolean IS DISTINCT FROM (g.last_seen>now()-interval '20 seconds') OR g.last_seen<now()-($1::bigint*interval '1 second'))",&[&app.grace]).await?;
    for row in rows {
        let rid: String = row.get(0);
        let tx = db.transaction().await?;
        let mut r = fetch(&tx, &rid).await?;
        if r.status != "open" {
            continue;
        }
        let mut removed = Vec::new();
        for i in (0..r.seats.len()).rev() {
            if r.seats[i].ai {
                continue;
            }
            let row = tx
                .query_one(
                    "SELECT extract(epoch FROM now()-last_seen)::bigint FROM guests WHERE id=$1",
                    &[&r.seats[i].player],
                )
                .await?;
            let age: i64 = row.get(0);
            if age >= app.grace {
                removed.push(r.seats[i].player.clone());
                leave(&tx, &mut r, i).await?;
            } else {
                r.seats[i].online = age < 20;
                if !r.seats[i].online {
                    r.seats[i].ready = false
                }
            }
        }
        store(&tx, &mut r).await?;
        tx.commit().await?;
        notify(app, &r);
        for p in removed {
            let _ = app.changes.send(p);
        }
    }
    Ok(())
}
