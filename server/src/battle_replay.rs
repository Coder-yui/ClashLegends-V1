//! Re-enact a saved checkpoint using the same engine and stamped inputs as its host.
use super::*;

pub async fn save(
    State(app): State<App>,
    h: HeaderMap,
    Path(mid): Path<String>,
) -> Result<Json<Value>> {
    let p = player(&app, &h).await?;
    if !p.starts_with("account/") {
        return Err(fail("游客回放保存在此浏览器"));
    }
    let db = app.db.get().await?;
    let exists = db
        .query_opt(
            "SELECT 1 FROM matches
         WHERE id=$1 AND status <> 'withdrawn'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(config->'seats') s WHERE s->>'player'=$2)",
            &[&mid, &p],
        )
        .await?;
    if exists.is_none() {
        return Err(fail("找不到你参与的对局"));
    }
    db.execute(
        "INSERT INTO recordings(player, match_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        &[&p, &mid],
    )
    .await?;
    Ok(Json(json!({"saved":true})))
}

pub async fn list(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let p = player(&app, &h).await?;
    let rows = app.db.get().await?.query(
        "SELECT m.id, m.config, m.battle_tick, m.result IS NOT NULL, extract(epoch from r.saved_at)::bigint
         FROM recordings r JOIN matches m ON m.id=r.match_id
         WHERE r.player=$1 AND m.status <> 'withdrawn' ORDER BY r.saved_at DESC", &[&p]).await?;
    Ok(entries(&app, &p, rows))
}
pub async fn lookup(
    State(app): State<App>,
    h: HeaderMap,
    Json(ids): Json<Vec<String>>,
) -> Result<Json<Value>> {
    let p = player(&app, &h).await?;
    let rows = app
        .db
        .get()
        .await?
        .query(
            "SELECT id,config,battle_tick,result IS NOT NULL,0::bigint FROM matches
         WHERE id=ANY($1) AND status <> 'withdrawn' AND
         EXISTS (SELECT 1 FROM jsonb_array_elements(config->'seats') s WHERE s->>'player'=$2)",
            &[&ids, &p],
        )
        .await?;
    Ok(entries(&app, &p, rows))
}
fn entries(app: &App, p: &str, rows: Vec<tokio_postgres::Row>) -> Json<Value> {
    let entries = rows
        .into_iter()
        .filter_map(|row| {
            let cfg: Value = row.get(1);
            let seats = cfg["seats"].as_array()?;
            let me = seats.iter().position(|s| s["player"] == p)?;
            Some(json!({
                "id": row.get::<_, String>(0),
                "map": cfg["map"],
                "opponent": model::opponent_names(seats,me),
                "tick": row.get::<_, i32>(2),
                "finished": row.get::<_, bool>(3),
                "savedAt": row.get::<_, i64>(4),
                "compatible": compatible(&cfg, &app.catalog)
            }))
        })
        .collect();
    Json(Value::Array(entries))
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Control {
    Seek(u64),
    Rate(f64),
}

pub async fn open(
    State(app): State<App>,
    h: HeaderMap,
    Path(mid): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    session::check_origin(&h)?;
    let p = player(&app, &h).await?;
    let row = app
        .db
        .get()
        .await?
        .query_opt(
            "SELECT m.config, m.battle_tick, m.inputs
         FROM matches m WHERE m.id=$2 AND m.status <> 'withdrawn'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.config->'seats') s WHERE s->>'player'=$1)",
            &[&p, &mid],
        )
        .await?
        .ok_or_else(|| fail("找不到已保存的回放"))?;
    let cfg: Value = row.get(0);
    let end = row.get::<_, i32>(1).max(0) as u64;
    let log: Vec<Batch> = decode(row.get(2))?;
    let seat = cfg["seats"]
        .as_array()
        .and_then(|s| s.iter().position(|v| v["player"] == p))
        .ok_or_else(|| fail("你没有这场比赛的席位"))?;
    let sim = Simulation::load(&cfg, &app.catalog)?;
    Ok(ws.max_message_size(256).on_upgrade(move |socket| {
        playback(socket, sim, app.catalog, cfg, seat, end, Arc::new(log))
    }))
}

fn advance(sim: &mut Simulation, until: u64, log: &[Batch]) {
    let mut next = log.partition_point(|b| b.tick <= sim.game.tick());
    while sim.game.tick() < until && sim.game.result().is_none() {
        let inputs = if next < log.len() && log[next].tick == sim.game.tick() + 1 {
            next += 1;
            &log[next - 1].inputs[..]
        } else {
            &[]
        };
        sim.step(inputs);
    }
}

async fn playback(
    mut socket: WebSocket,
    mut sim: Simulation,
    catalog: Arc<Catalog>,
    cfg: Value,
    seat: usize,
    end: u64,
    log: Arc<Vec<Batch>>,
) {
    let mut rate = 0.0_f64;
    let mut cursor = None;
    let mut clock = tokio::time::interval(Duration::from_millis(50));
    if socket
        .send(Message::Text(
            json!({"type":"replay","end":end,"protocol":PROTOCOL})
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    loop {
        let frame = SeatFrame::new(&sim, seat, true);
        if socket
            .send(Message::Text(frame.encode(cursor).into()))
            .await
            .is_err()
        {
            break;
        }
        cursor = Some(frame.history.cursor);
        if sim.game.tick() >= end || sim.game.result().is_some() {
            rate = 0.0;
        }
        let incoming = tokio::select! {
            _ = clock.tick(), if rate > 0.0 => {
                let next = sim.game.tick() + 1;
                advance(&mut sim, next, &log);
                continue;
            }
            incoming = socket.recv() => incoming,
        };
        let raw = match incoming {
            Some(Ok(Message::Text(text))) => text,
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            _ => break,
        };
        match serde_json::from_str::<Control>(&raw) {
            Ok(Control::Rate(r)) if [0.0, 0.25, 0.5, 1.0, 2.0, 4.0].contains(&r) => {
                rate = r;
                if r > 0.0 {
                    clock = tokio::time::interval(Duration::from_secs_f64(0.05 / r));
                    clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                    clock.reset();
                }
            }
            Ok(Control::Seek(t)) => {
                let cfg = cfg.clone();
                let catalog = catalog.clone();
                let log = log.clone();
                let rebuilt = tokio::task::spawn_blocking(move || {
                    let mut replay = Simulation::load(&cfg, &catalog)?;
                    advance(&mut replay, t.min(end), &log);
                    Ok::<_, Error>(replay)
                })
                .await;
                let Ok(Ok(replay)) = rebuilt else {
                    break;
                };
                sim = replay;
                cursor = None;
                clock.reset();
            }
            _ => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_seeks_and_reaches_the_recorded_final_frame() {
        let catalog: Catalog = serde_json::from_value(model::battle_catalog()).unwrap();
        let deck = catalog.default_loadout();
        let cfg = json!({"rulesVersion":RULESET, "contentVersion":catalog.version,
            "mode":"classic", "map":"rift", "seed":"9655102d-42b4-41de-bc01-202611191117",
            "seats":[{"ai":false,"deck":deck},{"ai":true,"deck":deck}]});
        let mut live = Simulation::load(&cfg, &catalog).unwrap();
        let mut log = Vec::new();
        let mut sample = String::new();
        while live.game.result().is_none() {
            // Both seats issue real commands, while the first seat retains its presentation stream.
            live.ai[0] = true;
            let inputs = live.decisions();
            live.ai[0] = false;
            live.step(&inputs);
            let tick = live.game.tick();
            if !inputs.is_empty() {
                log.push(Batch { tick, inputs });
            }
            if tick == 300 {
                sample = SeatFrame::new(&live, 0, true).encode(None);
            }
        }
        let mut replay = Simulation::load(&cfg, &catalog).unwrap();
        advance(&mut replay, 300, &log);
        assert_eq!(SeatFrame::new(&replay, 0, true).encode(None), sample);
        advance(&mut replay, live.game.tick(), &log);
        assert_eq!(
            SeatFrame::new(&replay, 0, true).encode(None),
            SeatFrame::new(&live, 0, true).encode(None)
        );
        assert_eq!(replay.streams[0].window(), live.streams[0].window());
    }
}
