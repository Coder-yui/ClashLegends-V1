//! Local two-bot match viewer. All connected browsers share one simulation.
//! Only public geometry crosses this spectator endpoint.
use axum::{
    extract::{
        ws::{Message, WebSocketUpgrade},
        State,
    },
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use clash_battle_core::{
    classic::{bot_input, representative_deck, ClassicMatch},
    Point, Team,
};
use serde_json::json;
use std::time::Duration;
use tokio::sync::watch;
fn xy(p: Point) -> [f64; 2] {
    [p.x, p.y]
}
fn frame(game: &ClassicMatch) -> String {
    let blue = game.view(Team::Blue);
    let field = blue.field;
    let visible: std::collections::BTreeSet<_> = field
        .units
        .iter()
        .filter(|u| !u.hidden)
        .map(|u| u.id)
        .collect();
    let actors: Vec<_> = field
        .units
        .iter()
        .filter(|u| visible.contains(&u.id))
        .map(|u| {
            json!({
                "id":u.id, "kind":u.kind, "team":u.team.index(), "center":xy(u.position),
                "radius":u.radius, "hp":u.hp, "maxHp":u.max_hp, "facing":xy(u.facing),
                "sight":u.sight, "range":u.range, "action":format!("{:?}",u.activity),
                "target":u.target.filter(|id|visible.contains(id))
            })
        })
        .collect();
    let shots: Vec<_> = field
        .projectiles
        .iter()
        .map(|p| json!([p.id, p.team.index(), p.position.x, p.position.y]))
        .collect();
    let result = blue
        .result
        .map(|r| json!({"winner":r.winner.map(Team::index),"reason":format!("{:?}",r.reason)}));
    json!({"version":1,"tick":field.tick,"remaining":blue.remaining_ticks,"overtime":blue.overtime,"units":actors,"shots":shots,"result":result}).to_string()
}
async fn stream(
    State(mut latest): State<watch::Receiver<String>>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |mut ws| async move {
        loop {
            let frame = latest.borrow_and_update().clone();
            if ws.send(Message::Text(frame.into())).await.is_err() { break; }
            loop {
                tokio::select! {
                    change = latest.changed() => {
                        if change.is_err() { return; }
                        break;
                    }
                    message = ws.recv() => {
                        if matches!(message, None | Some(Err(_)) | Some(Ok(Message::Close(_)))) { return; }
                    }
                }
            }
        }
    })
}
#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let speed: u32 = args
        .first()
        .map_or(1, |s| s.parse().expect("speed must be 1..100"));
    assert!((1..=100).contains(&speed));
    let seed = args
        .get(1)
        .map_or(20261118, |s| s.parse().expect("invalid seed"));
    let port = args
        .get(2)
        .map_or(4318, |s| s.parse().expect("invalid port"));
    let d = representative_deck();
    let mut game = ClassicMatch::new(seed, [d, d]).unwrap();
    let (tx, rx) = watch::channel(frame(&game));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
    println!(
        "Local match viewer http://{}",
        listener.local_addr().unwrap()
    );
    tokio::spawn(async move {
        let mut clock = tokio::time::interval(Duration::from_millis(50));
        clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        while game.result().is_none() {
            clock.tick().await;
            for _ in 0..speed {
                let inputs: Vec<_> = [Team::Blue, Team::Red]
                    .into_iter()
                    .filter_map(|team| bot_input(team, &game.view(team)))
                    .collect();
                game.step(&inputs);
                game.drain_events().for_each(drop);
                if game.result().is_some() {
                    break;
                }
            }
            tx.send_replace(frame(&game));
        }
    });
    let app = Router::new()
        .route("/", get(|| async { Html(include_str!("viewer.html")) }))
        .route("/stream", get(stream))
        .with_state(rx);
    axum::serve(listener, app).await.unwrap();
}
