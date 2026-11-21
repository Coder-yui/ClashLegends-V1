//! One transient field per socket. No room, checkpoint or match commands.
use super::*;
use clash_battle_core::{
    classic::workbench::{objects, Workbench},
    Control, Id,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "action", deny_unknown_fields)]
enum Edit {
    Clock {
        paused: bool,
        speed: u8,
    },
    Step,
    Clear,
    Deploy {
        card: String,
        skill: Option<String>,
        team: usize,
        x: f64,
        y: f64,
    },
    Select {
        id: Option<Id>,
    },
    Cast,
    Transform,
    Control {
        kind: String,
    },
    Scene {
        scene: String,
        card: String,
        skill: Option<String>,
        team: usize,
    },
}

fn scenario(
    name: &str,
    key: &str,
    skill: Option<&str>,
    team: Team,
) -> std::result::Result<(Workbench, Option<Id>), MatchError> {
    let mut world = Workbench::new();
    let point = |x: f64, y: f64| {
        if team == Team::Blue {
            Point::new(x, y)
        } else {
            Point::new(x, 1280. - y)
        }
    };
    let (x, y) = if name == "bridge" {
        (140., 820.)
    } else {
        (380., 820.)
    };
    match name {
        "duel" => {
            world.deploy("garen", None, team.enemy(), point(x, y - 160.))?;
        }
        "dummy" => {
            world.deploy("training_dummy", None, team.enemy(), point(x, y - 100.))?;
        }
        "surround" => {
            for (dx, dy) in [
                (-80., -80.),
                (0., -120.),
                (80., -80.),
                (-120., 0.),
                (120., 0.),
                (-80., 80.),
                (0., 120.),
                (80., 80.),
            ] {
                world.deploy("melee_minion", None, team.enemy(), point(x + dx, y + dy))?;
            }
        }
        "pincer" => {
            for (dx, dy) in [(-120., -200.), (120., -200.), (-160., -120.), (160., -120.)] {
                world.deploy("ranged_minion", None, team.enemy(), point(x + dx, y + dy))?;
            }
            for dx in [-40., 40.] {
                world.deploy("melee_minion", None, team.enemy(), point(x + dx, y - 80.))?;
            }
        }
        "bridge" => {
            // Leave a tile between the back row and the live tower footprint.
            for column in [100., 140., 180.] {
                for row in [740., 780., 860., 900.] {
                    world.deploy("melee_minion", None, team, point(column, row))?;
                }
                for row in [460., 420.] {
                    world.deploy("melee_minion", None, team.enemy(), point(column, row))?;
                }
            }
        }
        _ => return Err(MatchError::Loadout),
    }
    let id = world.deploy(key, skill, team, point(x, y))?;
    Ok((world, id))
}

struct Lab {
    world: Workbench,
    stream: presentation::Stream,
    selected: Option<Id>,
    epoch: u64,
    paused: bool,
    speed: u8, // quarters of normal speed
}
impl Lab {
    fn team(index: usize) -> std::result::Result<Team, MatchError> {
        TEAMS.get(index).copied().ok_or(MatchError::Placement)
    }
    fn replace(&mut self, world: Workbench, selected: Option<Id>) {
        self.world = world;
        self.selected = selected;
        self.epoch += 1;
        self.stream = Default::default();
    }
    fn edit(&mut self, edit: Edit) -> std::result::Result<(), MatchError> {
        match edit {
            Edit::Clock { paused, speed } if [1, 2, 4].contains(&speed) => {
                self.paused = paused;
                self.speed = speed;
            }
            Edit::Step if self.paused => self.world.step(),
            Edit::Clear => self.replace(self.world.cleared(), None),
            Edit::Deploy {
                card,
                skill,
                team,
                x,
                y,
            } => {
                if let Some(id) = self.world.deploy(
                    &card,
                    skill.as_deref(),
                    Self::team(team)?,
                    Point::new(x, y),
                )? {
                    self.selected = Some(id);
                }
            }
            Edit::Select { id } => self.selected = id,
            Edit::Transform => self
                .world
                .transform(self.selected.ok_or(MatchError::NoAbility)?)?,
            Edit::Cast => self
                .world
                .cast(self.selected.ok_or(MatchError::NoAbility)?)?,
            Edit::Control { kind } => {
                let effect = match kind.as_str() {
                    "freeze" => Control::Freeze,
                    "stun" => Control::Stun,
                    "root" => Control::Root,
                    "silence" => Control::Silence,
                    "stasis" => Control::Stasis,
                    _ => return Err(MatchError::Loadout),
                };
                self.world
                    .control(self.selected.ok_or(MatchError::NoAbility)?, effect)?;
            }
            Edit::Scene {
                scene,
                card,
                skill,
                team,
            } => {
                let (world, target) = scenario(&scene, &card, skill.as_deref(), Self::team(team)?)?;
                self.replace(world, target);
            }
            _ => return Err(MatchError::Timing),
        }
        Ok(())
    }
    fn snapshot(&mut self) -> String {
        let facts = self.world.facts();
        let view = self.world.game().view(Team::Blue);
        self.stream.advance(&view.field, &facts, &[]);
        self.selected = self
            .selected
            .filter(|id| view.field.units.iter().any(|u| u.id == *id));
        let mut frame = field_frame(self.world.game(), &view, Team::Blue, true, &self.stream);
        frame["presentation"] = self.stream.window();
        // The lab can change loadouts between two deployments of the same card.
        for unit in frame["units"].as_array_mut().unwrap() {
            if let Some(skill) = unit["id"]
                .as_u64()
                .and_then(|id| self.world.equipped(id as Id))
            {
                unit["equippedSkill"] = json!(skill);
            }
        }
        frame["lab"] = json!({"selected":self.selected,"members":self.selected.and_then(|id|self.world.batch(id)),"skill":self.selected.and_then(|id|self.world.equipped(id)),"epoch":self.epoch,"paused":self.paused,"speed":self.speed});
        frame.to_string()
    }
}
pub async fn live(State(app): State<App>, h: HeaderMap, ws: WebSocketUpgrade) -> Result<Response> {
    session::check_origin(&h)?;
    player(&app, &h).await?;
    if !app.accounts.is_empty()
        && !crate::accounts::identity(&app, &h)
            .await?
            .is_some_and(|(_, role)| role == "admin")
    {
        return Err(crate::Error(
            axum::http::StatusCode::FORBIDDEN,
            "仅管理员可进入开发工作台".into(),
        ));
    }
    Ok(ws.max_message_size(2048).on_upgrade(run))
}
async fn run(mut socket: WebSocket) {
    let mut lab = Lab {
        world: Workbench::new(),
        stream: Default::default(),
        selected: None,
        epoch: 0,
        paused: true,
        speed: 4,
    };
    if socket
        .send(Message::Text(
            json!({"type":"objects","cards":objects()})
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    let mut next = tokio::time::Instant::now();
    let mut remaining = 1.0;
    loop {
        if socket
            .send(Message::Text(lab.snapshot().into()))
            .await
            .is_err()
        {
            return;
        }
        let period = Duration::from_millis(200 / u64::from(lab.speed));
        let message = tokio::select! {
            _ = tokio::time::sleep_until(next), if !lab.paused => {
                lab.world.step();
                next = (next + period).max(tokio::time::Instant::now());
                continue;
            }
            message = socket.recv() => message,
        };
        let raw = match message {
            Some(Ok(Message::Text(raw))) => raw,
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            _ => return,
        };
        let clock = (lab.paused, lab.speed);
        let result = serde_json::from_str(&raw)
            .map_err(|_| "无效的实验操作")
            .and_then(|edit| {
                lab.edit(edit).map_err(|e| match e {
                    MatchError::Slot => "实验场已满，请先清场",
                    MatchError::Placement
                    | MatchError::Rule(clash_battle_core::Error::InvalidPoint) => {
                        "落点不可用，请选择空地"
                    }
                    MatchError::NoAbility => "请检查操作目标或先放置可镜像的卡",
                    _ => explanation(e),
                })
            });
        if clock != (lab.paused, lab.speed) {
            let now = tokio::time::Instant::now();
            if !clock.0 {
                remaining = (next.saturating_duration_since(now).as_secs_f64()
                    / period.as_secs_f64())
                .min(1.);
            }
            next = now + Duration::from_millis(200 / u64::from(lab.speed)).mul_f64(remaining);
        }
        if let Err(msg) = result {
            if socket
                .send(Message::Text(
                    json!({"type":"error","message":msg}).to_string().into(),
                ))
                .await
                .is_err()
            {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_layout_rebuilds_for_both_sides() {
        for team in TEAMS {
            for (scene, others) in [
                ("dummy", 1),
                ("duel", 1),
                ("surround", 8),
                ("bridge", 18),
                ("pincer", 6),
            ] {
                let (world, selected) = scenario(scene, "ashe", Some("ashe.volley"), team)
                    .unwrap_or_else(|e| panic!("{scene} {team:?}: {e:?}"));
                let view = world.game().view(team);
                assert_eq!(view.field.units.len(), 6 + 1 + others);
                assert!(view
                    .field
                    .units
                    .iter()
                    .any(|u| Some(u.id) == selected && u.kind == "ashe" && u.team == team));
            }
        }
    }
}

#[cfg(test)]
#[path = "workbench_effect_tests.rs"]
mod effect_stages;
