//! One authoritative simulation per frozen match. Only the host chooses teams and ticks.
use super::*;
#[path = "presentation.rs"]
mod presentation;
#[path = "workbench.rs"]
pub mod workbench;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use clash_battle_core::{
    classic::{
        bot_input, replay::RULESET, representative_deck, resolve_deck, Card, ClassicMatch, Input,
        Intent, MatchError, Outcome,
    },
    Aim, Point, Team,
};
use model::Deck;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

const TEAMS: [Team; 2] = [Team::Blue, Team::Red];
pub type Hosts = Arc<Mutex<HashMap<String, Host>>>;
#[derive(Clone)]
pub struct Host {
    frames: [watch::Sender<String>; 2],
    queue: mpsc::Sender<Request>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum Command {
    Play {
        sequence: u64,
        slot: u8,
        version: u64,
        x: f64,
        y: f64,
    },
    Activate {
        sequence: u64,
        slot: u8,
    },
}
impl Command {
    fn input(self, team: Team) -> Input {
        let (sequence, intent) = match self {
            Self::Play {
                sequence,
                slot,
                version,
                x,
                y,
            } => (
                sequence,
                Intent::Play {
                    slot,
                    version,
                    point: Point::new(x, y),
                },
            ),
            Self::Activate { sequence, slot } => (
                sequence,
                Intent::Activate {
                    slot,
                    aim: Aim::Instant,
                },
            ),
        };
        Input {
            team,
            sequence,
            intent,
        }
    }
}
struct Request {
    input: Logged,
    reply: oneshot::Sender<std::result::Result<u64, &'static str>>,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
struct Logged {
    input_tick: u64,
    seat: usize,
    command: Command,
}
#[derive(Serialize, Deserialize)]
struct Batch {
    tick: u64,
    inputs: Vec<Logged>,
}

fn cards(deck: &Deck, catalog: &[Card]) -> Result<[Card; 8]> {
    let choices: Vec<_> = deck
        .cards
        .iter()
        .map(|key| (key.as_str(), deck.skills.get(key).map(String::as_str)))
        .collect();
    resolve_deck(
        choices.try_into().map_err(|_| fail("比赛卡位无效"))?,
        catalog,
    )
    .map_err(|_| fail("比赛包含尚未接入的卡牌或技能"))
}
fn outcome(out: Outcome, tick: u64) -> Value {
    json!({"winner":out.winner.map(Team::index),"reason":format!("{:?}",out.reason),"tick":tick})
}
fn frame(sim: &Simulation, team: Team, started: bool) -> String {
    field_frame(
        &sim.game,
        sim.game.view(team),
        team,
        started,
        &sim.streams[team.index()],
    )
    .to_string()
}

fn field_frame(
    game: &ClassicMatch,
    view: clash_battle_core::classic::MatchView,
    team: Team,
    started: bool,
    stream: &presentation::Stream,
) -> Value {
    let units: Vec<_> = view.field.units.iter().map(|u| json!({
        "id":u.id,"kind":u.kind,"team":u.team.index(),"x":u.position.x,"y":u.position.y,
        "visual":u.visual,"attack":u.attack,"impactTick":u.impact_tick,"movementRate":u.movement_rate,"castStart":u.cast_start,
        "castEnd":u.cast_end,"skill":u.skill,"bar":u.bar,"dormant":u.dormant,"alternateForm":u.form_changed,"activity":u.activity,"facing":u.facing,"target":u.target,"actionSerial":u.action_serial,"readyTick":u.ready_tick,"deployStart":u.deploy_start,"since":u.since,"controls":u.controls,"name":u.name,"structure":u.structure,"hidden":u.hidden,"shield":u.shield,"radius":u.radius,"hp":u.hp,"maxHp":u.max_hp,"frozen":u.controls.contains(&clash_battle_core::Control::Freeze)
    })).collect();
    let shots: Vec<_> = view
        .field
        .projectiles
        .iter()
        .map(|p| json!({"id":p.id,"born":p.born,"sourceKind":p.source_kind,"team":p.team.index(),"owner":p.owner,"target":p.target,"origin":p.origin,"position":p.position}))
        .collect();
    let hand = view.own;
    let map = clash_battle_core::classic::maps()
        .iter()
        .find(|m| m.id == game.map().id)
        .unwrap();
    json!({"type":"frame","protocol":2,"map":{"id":map.id,"width":map.width,"height":map.height,"tile":map.tile,"terrain":map.terrain,"projection":map.projection,"backMargin":map.back_margin,"backdropWidth":map.backdrop_width,"obstacles":map.obstacles},"ruinedTowers":game.ruined_towers().map(|(id,t,p)|json!({"id":id,"team":t.index(),"x":p.x,"y":p.y})).collect::<Vec<_>>(),"deployment":game.deployment_regions(team),"presentation":stream.window(),"areas":view.field.areas,"spells":game.spell_views().collect::<Vec<_>>(),"pending":game.pending(team).collect::<Vec<_>>(),"started":started,"tick":game.tick(),"remaining":view.remaining_ticks,
        "overtime":view.overtime,"units":units,"shots":shots,"hand":hand.hand,"costs":hand.costs,"lastCard":hand.last,"activeCards":hand.active_keys,"next":hand.next,"nextCost":hand.next_cost,
        "gold":hand.gold,"version":hand.version,"ack":hand.acknowledged,
        "skillResource":view.skill_resource,"activeWait":view.active_wait,"activeCost":view.active_cost,"active":hand.active.map(|a| a.map(|v| json!({"caster":v.caster,"uses":v.uses}))),
        "buttons":view.buttons.map(|button| button.map(|b| json!({"locked":b.locked,"cooldownLeft":b.cooldown_left,"cooldownTotal":b.cooldown_total,"freeRecast":b.free_recast}))),
        "result":view.result.map(|o| outcome(o,game.tick()))})
}

pub fn compatible(cfg: &Value, catalog: &Catalog) -> bool {
    cfg["rulesVersion"] == RULESET && catalog.playable(&cfg["contentVersion"])
}
struct Simulation {
    game: ClassicMatch,
    ai: [bool; 2],
    full_roster: bool,
    streams: [presentation::Stream; 2],
}
impl Simulation {
    fn load(cfg: &Value, catalog: &Catalog) -> Result<Self> {
        if !compatible(cfg, catalog) {
            return Err(fail("比赛版本与对局内核不兼容"));
        }
        let uuid: Uuid = decode(cfg["seed"].clone())?;
        let seed = uuid.as_u64_pair().0;
        let seats = &cfg["seats"];
        let legacy = representative_deck();
        let choices = if cfg["contentVersion"] == catalog.version {
            clash_battle_core::classic::battle_cards()
        } else {
            &legacy
        };
        let decks = [
            cards(&decode(seats[0]["deck"].clone())?, choices)?,
            cards(&decode(seats[1]["deck"].clone())?, choices)?,
        ];
        let mode = clash_battle_core::classic::modes()
            .iter()
            .find(|m| cfg["mode"] == m.id && m.map_ids.iter().any(|id| cfg["map"] == *id))
            .ok_or_else(|| fail("无效模式或地图"))?;
        let map = clash_battle_core::classic::MatchMap::named(cfg["map"].as_str().unwrap_or(""))
            .ok_or_else(|| fail("无效地图"))?;
        let game =
            ClassicMatch::with_rules(seed, decks, map, mode).map_err(|_| fail("无法建立战场"))?;
        Ok(Self {
            game,
            streams: Default::default(),
            full_roster: cfg["contentVersion"] == catalog.version,
            ai: [seats[0]["ai"] == true, seats[1]["ai"] == true],
        })
    }
    fn decisions(&self) -> Vec<Logged> {
        let mut inputs = Vec::new();
        for team in TEAMS {
            if !self.ai[team.index()] {
                continue;
            }
            let decide = if self.full_roster {
                clash_battle_core::classic::roster_bot_input
            } else {
                bot_input
            };
            if let Some(Input {
                sequence, intent, ..
            }) = decide(team, &self.game.view(team))
            {
                let command = match intent {
                    Intent::Play {
                        slot,
                        version,
                        point,
                    } => Command::Play {
                        sequence,
                        slot,
                        version,
                        x: point.x,
                        y: point.y,
                    },
                    Intent::Activate {
                        slot,
                        aim: Aim::Instant,
                    } => Command::Activate { sequence, slot },
                    _ => unreachable!("classic bots use instant activations"),
                };
                inputs.push(Logged {
                    seat: team.index(),
                    input_tick: self.game.tick(),
                    command,
                });
            }
        }
        inputs
    }
    fn step(&mut self, inputs: &[Logged]) -> Vec<std::result::Result<u64, MatchError>> {
        let receipts = inputs
            .iter()
            .map(|l| {
                self.game
                    .schedule(l.input_tick, l.command.input(TEAMS[l.seat]))
            })
            .collect();
        self.game.step(&[]);
        let facts: Vec<_> = self.game.drain_events().collect();
        let done = self.game.take_completions();
        for team in TEAMS {
            if self.ai[team.index()] {
                continue;
            }
            let completed: Vec<_> = done
                .iter()
                .filter(|(t, _, _)| *t == team)
                .map(|(_, seq, r)| (*seq, r.err().map(explanation)))
                .collect();
            self.streams[team.index()].advance(&self.game.view(team).field, &facts, &completed);
        }
        receipts
    }
    fn restore(&mut self, until: i32, log: Vec<Batch>) -> Result<()> {
        if until < 0
            || until as u64 > self.game.rules().end
            || log.iter().flat_map(|b| &b.inputs).any(|i| i.seat >= 2)
        {
            return Err(fail("无效的比赛检查点"));
        }
        let mut batches = log.iter().peekable();
        for tick in 1..=until as u64 {
            if self.game.result().is_some() {
                return Err(fail("检查点超过终局"));
            }
            let batch = batches
                .next_if(|b| b.tick == tick)
                .map_or(&[][..], |b| b.inputs.as_slice());
            self.step(batch);
        }
        if batches.next().is_some() {
            return Err(fail("无效的比赛检查点"));
        }
        Ok(())
    }
}

pub async fn initialize(app: &App) -> Result<deadpool_postgres::Object> {
    // This deployment serves both peers from one lobby process. Hold ownership
    // across recovery so a second process cannot advance the same database.
    let lease = app.db.get().await?;
    if !lease
        .query_one("SELECT pg_try_advisory_lock(43017, 1)", &[])
        .await?
        .get::<_, bool>(0)
    {
        return Err(fail("此大厅数据库已有运行中的对局宿主"));
    }
    // Preserve saved collection presets. Old, still-open rooms need playable
    // loadouts before either seat can confirm a new round.
    for row in lease
        .query("SELECT id FROM rooms WHERE data->>'status'='open'", &[])
        .await?
    {
        let mut db = app.db.get().await?;
        let tx = db.transaction().await?;
        let mut room = room::fetch(&tx, &row.get::<_, String>(0)).await?;
        if room.status == "open" && room.migrate_decks(&app.catalog)? {
            room::store(&tx, &mut room).await?;
            tx.commit().await?;
        }
    }
    // Incompatible logs stay intact for the pinned host. Never run a new bot or
    // new content against a historical match and silently change its outcome.
    let rows = lease
        .query(
            "SELECT id,config FROM matches WHERE status='claimed' AND result IS NULL",
            &[],
        )
        .await?;
    for row in rows {
        let id: String = row.get(0);
        if compatible(&row.get(1), &app.catalog) {
            host(app, &id).await?;
        } else {
            eprintln!("battle {id} requires its archived rules host");
        }
    }
    Ok(lease)
}

async fn host(app: &App, mid: &str) -> Result<Host> {
    let mut hosts = app.battles.lock().await;
    if let Some(h) = hosts.get(mid) {
        return Ok(h.clone());
    }
    let db = app.db.get().await?;
    let row = db.query_opt("SELECT config,status,battle_tick,inputs FROM matches WHERE id=$1 AND status <> 'withdrawn' AND result IS NULL", &[&mid]).await?.ok_or_else(|| fail("对局已结束"))?;
    let cfg: Value = row.get(0);
    let started = row.get::<_, String>(1) == "claimed";
    let mut sim = Simulation::load(&cfg, &app.catalog)?;
    sim.restore(row.get(2), decode(row.get(3))?)?;
    let frames = TEAMS.map(|team| watch::channel(frame(&sim, team, started)).0);
    let (queue, rx) = mpsc::channel(64);
    let handle = Host {
        frames: frames.clone(),
        queue,
    };
    hosts.insert(mid.to_owned(), handle.clone());
    let app = app.clone();
    let mid = mid.to_owned();
    tokio::spawn(async move {
        let rid = cfg["roomId"].as_str().unwrap();
        if let Err(e) = drive(&app, &mid, rid, sim, started, frames, rx).await {
            eprintln!("battle {mid}: {}", e.1);
        }
        app.battles.lock().await.remove(&mid);
    });
    Ok(handle)
}

async fn start(app: &App, mid: &str, rid: &str) -> Result<bool> {
    let mut db = app.db.get().await?;
    let tx = db.transaction().await?;
    let mut r = room::fetch(&tx, rid).await?;
    if r.match_id.as_deref() != Some(mid) || r.status != "locked" {
        return Ok(false);
    }
    if tx
        .query_opt("SELECT * FROM claim_pending_match($1)", &[&mid])
        .await?
        .is_none()
    {
        return Ok(false);
    }
    r.status = "playing".into();
    room::store(&tx, &mut r).await?;
    tx.commit().await?;
    room::notify(app, &r);
    Ok(true)
}
async fn finish(
    app: &App,
    mid: &str,
    rid: &str,
    result: Value,
    batch: Value,
    tick: i32,
) -> Result<()> {
    let mut db = app.db.get().await?;
    let tx = db.transaction().await?;
    let mut r = room::fetch(&tx, rid).await?;
    tx.execute("UPDATE matches SET result=$2, inputs=inputs || $3, battle_tick=$4 WHERE id=$1 AND result IS NULL", &[&mid,&result,&batch,&tick]).await?;
    if r.match_id.as_deref() == Some(mid) {
        r.status = "open".into();
        r.round += 1;
        r.match_id = None;
        r.reset_ready();
        room::store(&tx, &mut r).await?;
    }
    tx.commit().await?;
    room::notify(app, &r);
    Ok(())
}

async fn drive(
    app: &App,
    mid: &str,
    rid: &str,
    mut sim: Simulation,
    mut started: bool,
    frames: [watch::Sender<String>; 2],
    mut rx: mpsc::Receiver<Request>,
) -> Result<()> {
    let mut clock = tokio::time::interval(Duration::from_millis(50));
    clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut idle = 0;
    loop {
        clock.tick().await;
        if !started {
            if !TEAMS
                .iter()
                .all(|t| sim.ai[t.index()] || frames[t.index()].receiver_count() > 0)
            {
                while let Ok(request) = rx.try_recv() {
                    let _ = request.reply.send(Err("正在等待双方进入战场"));
                }
                idle += 1;
                if idle % 20 == 0
                    && (frames.iter().all(|f| f.receiver_count() == 0)
                        || app
                            .db
                            .get()
                            .await?
                            .query_opt(
                                "SELECT id FROM matches WHERE id=$1 AND status='pending'",
                                &[&mid],
                            )
                            .await?
                            .is_none())
                {
                    return Ok(());
                }
                continue;
            }
            if !start(app, mid, rid).await? {
                return Ok(());
            }
            started = true;
        }
        let mut requests = Vec::new();
        while let Ok(req) = rx.try_recv() {
            requests.push(req);
        }
        let mut inputs: Vec<_> = requests.iter().map(|r| r.input).collect();
        inputs.extend(sim.decisions());
        let has_inputs = !inputs.is_empty();
        let receipts = sim.step(&inputs);
        let tick = sim.game.tick();
        let log = if inputs.is_empty() {
            json!([])
        } else {
            json!([Batch { tick, inputs }])
        };
        if let Some(out) = sim.game.result() {
            finish(app, mid, rid, outcome(out, tick), log, tick as i32).await?;
        } else if has_inputs || tick % 20 == 0 {
            app.db
                .get()
                .await?
                .execute(
                    "UPDATE matches SET battle_tick=$2,inputs=inputs || $3 WHERE id=$1",
                    &[&mid, &(tick as i32), &log],
                )
                .await?;
        }
        for team in TEAMS {
            if !sim.ai[team.index()] {
                frames[team.index()].send_replace(frame(&sim, team, true));
            }
        }
        for (request, receipt) in requests.into_iter().zip(receipts) {
            let _ = request.reply.send(receipt.map_err(explanation));
        }
        if sim.game.result().is_some() {
            return Ok(());
        }
    }
}

pub async fn live(
    State(app): State<App>,
    h: HeaderMap,
    Path(mid): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    session::check_origin(&h)?;
    let p = player(&app, &h).await?;
    let db = app.db.get().await?;
    let row = db
        .query_opt(
            "SELECT config,result FROM matches WHERE id=$1 AND status <> 'withdrawn'",
            &[&mid],
        )
        .await?
        .ok_or_else(|| fail("对局已结束"))?;
    let cfg: Value = row.get(0);
    let seat = cfg["seats"]
        .as_array()
        .and_then(|s| s.iter().position(|v| v["player"] == p && v["ai"] == false))
        .ok_or_else(|| fail("你没有这场比赛的席位"))?;
    drop(db);
    if let Some(result) = row.get::<_, Option<Value>>(1) {
        return Ok(ws.on_upgrade(move |mut socket| async move {
            let _ = socket
                .send(Message::Text(
                    json!({"type":"result","result":result}).to_string().into(),
                ))
                .await;
        }));
    }
    let host = host(&app, &mid).await?;
    let frames = host.frames[seat].subscribe();
    Ok(ws
        .max_message_size(1024)
        .on_upgrade(move |socket| stream(socket, seat, frames, host.queue)))
}

fn explanation(e: MatchError) -> &'static str {
    match e {
        MatchError::Timing => "指令已超出排程时间，请重试",
        MatchError::Gold => "金币不足",
        MatchError::Placement => "无法在这里部署，请选择己方空地",
        MatchError::StaleHand | MatchError::Sequence => "手牌已更新，请重新选择",
        MatchError::NoAbility => "主动技能当前不可用",
        MatchError::Rule(clash_battle_core::Error::Cooldown) => "技能正在冷却",
        MatchError::Rule(clash_battle_core::Error::Controlled) => "单位正在部署或被控制",
        _ => "当前无法执行此操作",
    }
}
async fn stream(
    mut socket: WebSocket,
    seat: usize,
    mut frames: watch::Receiver<String>,
    queue: mpsc::Sender<Request>,
) {
    loop {
        let frame = frames.borrow_and_update().clone();
        if socket.send(Message::Text(frame.into())).await.is_err() {
            return;
        }
        tokio::select! {
            changed = frames.changed() => if changed.is_err() {return;},
            message = socket.recv() => match message {
                Some(Ok(Message::Text(raw))) => {
                    let (reply, answer) = oneshot::channel();
                    #[derive(Deserialize)] struct Wire{#[serde(rename="inputTick")] input_tick:u64,#[serde(flatten)]command:Command}
                    let admitted = match serde_json::from_str::<Wire>(&raw) {
                        Err(_) => Err("无效指令"),
                        Ok(Wire{command,input_tick}) => {
                            if queue.try_send(Request{input:Logged{seat,input_tick,command},reply}).is_err() { return; }
                            match answer.await {Ok(error) => error, Err(_) => return}
                        }
                    };
                    let receipt = json!({"type":"receipt","error":admitted.err(),"executeTick":admitted.ok()});
                    if socket.send(Message::Text(receipt.to_string().into())).await.is_err() {return;}
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => (),
                _ => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_restores_both_private_views_and_the_same_outcome() {
        let catalog: Catalog = serde_json::from_value(model::battle_catalog()).unwrap();
        let deck = catalog.default_loadout();
        for (ai, map) in [(false, "rift"), (true, "training-crossing")] {
            let cfg = json!({"rulesVersion":RULESET, "contentVersion":catalog.version,
                "mode":"classic", "map":map, "seed":"9655102d-42b4-41de-bc01-202611191117",
                "seats":[{"ai":false,"deck":deck},{"ai":ai,"deck":deck}]});
            let mut sim = Simulation::load(&cfg, &catalog).unwrap();
            let mut log = vec![];
            for tick in 1..=420 {
                let mut inputs = vec![];
                if tick % 23 == 0 {
                    for team in TEAMS.into_iter().filter(|team| !sim.ai[team.index()]) {
                        let own = sim.game.view(team).own;
                        inputs.push(Logged {
                            input_tick: tick - 1,
                            seat: team.index(),
                            command: Command::Play {
                                sequence: own.acknowledged + 1,
                                version: own.version,
                                slot: 0,
                                x: 220.,
                                y: if team == Team::Blue { 820. } else { 460. },
                            },
                        });
                    }
                }
                inputs.extend(sim.decisions());
                sim.step(&inputs);
                if !inputs.is_empty() {
                    log.push(Batch { tick, inputs });
                }
            }
            let mut restored = Simulation::load(&cfg, &catalog).unwrap();
            restored.restore(420, decode(json!(log)).unwrap()).unwrap();
            if ai {
                assert!(log.iter().flat_map(|b| &b.inputs).any(|i| i.seat == 1));
            }
            assert!(sim
                .game
                .pending(Team::Blue)
                .eq(restored.game.pending(Team::Blue)));
            for team in TEAMS {
                assert_eq!(frame(&sim, team, true), frame(&restored, team, true));
                assert_eq!(sim.game.view(team), restored.game.view(team));
            }
            while sim.game.result().is_none() {
                let inputs = sim.decisions();
                sim.step(&inputs);
                restored.step(&inputs);
            }
            assert_eq!(sim.game.result(), restored.game.result());
            assert_eq!(sim.game.tick(), restored.game.tick());
        }
    }
}
