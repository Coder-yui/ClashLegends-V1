//! Authored encounters for the host's audio regression. All cues come from the battle clock.
use super::{battle_cards, objects, Workbench};
use crate::{vitals::Change, Action, Id, Point, Team, UnitDef};

struct Encounter<'a> {
    world: Workbench,
    observe: &'a mut dyn FnMut(&mut Workbench),
}

impl<'a> Encounter<'a> {
    fn new(observe: &'a mut dyn FnMut(&mut Workbench)) -> Self {
        Self {
            world: Workbench::new(),
            observe,
        }
    }
    fn sample(&mut self) {
        (self.observe)(&mut self.world);
    }
    fn step(&mut self, count: u32) {
        for _ in 0..count {
            self.world.step();
            self.sample();
        }
    }
    fn unit(&mut self, kind: &str, slot: usize, pos: Point) -> Id {
        let skill = battle_cards()
            .iter()
            .filter(|c| c.key == kind)
            .nth(slot)
            .and_then(|c| c.skill_key.map(str::to_owned))
            .or_else(|| {
                objects()
                    .into_iter()
                    .find(|o| o["id"] == kind)
                    .and_then(|o| o["skills"][slot]["id"].as_str().map(str::to_owned))
            });
        let id = self
            .world
            .deploy(kind, skill.as_deref(), Team::Blue, pos)
            .unwrap()
            .unwrap();
        self.sample();
        id
    }
    fn target(&mut self, pos: Point, hp: i32) -> Id {
        let def = UnitDef {
            hp,
            speed: 0.,
            action: Action::Idle,
            ..UnitDef::melee()
        };
        self.world.game.battle.spawn(Team::Red, pos, def).unwrap()
    }
    fn ready(&mut self, id: Id, stacks: f64) {
        let a = self.world.game.battle.actors.get_mut(&id).unwrap();
        a.ready_tick = 0;
        a.card_state.resource = stacks;
        a.facing = Point::new(0., -1.);
    }
    fn damage(&mut self, source: Id, target: Id, amount: i32) {
        self.world
            .game
            .battle
            .commit(vec![Change::delivered(source, target, -amount)]);
        self.world.game.spell_deaths();
        self.sample();
    }
    fn cast(&mut self, id: Id) {
        self.world.cast(id).unwrap();
        self.sample();
    }
}

// Invoke begin for each scene so stream cursors and newly assigned unit IDs stay independent.
pub fn audio_encounters(mut visit: impl FnMut(bool, &mut Workbench)) -> usize {
    let pos = Point::new(340., 900.);
    let mut cases = 0;
    let mut run = |scene: &mut dyn FnMut(&mut Encounter)| {
        let mut first = true;
        let mut observe = |world: &mut Workbench| {
            visit(first, world);
            first = false;
        };
        let mut field = Encounter::new(&mut observe);
        field.sample();
        scene(&mut field);
        cases += 1;
    };
    for stacks in 0..=3 {
        for lateral in [0., 52.] {
            run(&mut |scene| {
                let id = scene.unit("gwen", 0, pos);
                scene.ready(id, f64::from(stacks));
                scene.cast(id);
                let a = &scene.world.game.battle.actors[&id];
                let center = a.pos + a.facing * (a.def.radius + 95.);
                scene.target(center + Point::new(lateral, 0.), 4000);
                scene.step(35);
            });
        }
    }
    run(&mut |scene| {
        let id = scene.unit("aurelionsol", 0, pos);
        scene.ready(id, 5.);
        let origin = scene.world.game.battle.actors[&id].pos;
        scene.cast(id);
        scene.target(origin + Point::new(0., -175.), 4000);
        scene.target(origin + Point::new(240., -175.), 4000);
        scene.step(120);
    });
    for kind in [
        "gnar",
        "aatrox",
        "jinx",
        "jayce",
        "anivia",
        "void_scuttle_crab",
        "powder_keg",
        "blitzcrank",
        "olaf_single",
        "kayn",
        "kayn_assassin",
        "kayn_slayer",
        "void_spawn",
        "void_spawn_single",
        "darius",
    ] {
        run(&mut |scene| {
            let id = scene.unit(kind, usize::from(kind == "olaf_single"), pos);
            scene.ready(id, 0.);
            let p = scene.world.game.battle.actors[&id].pos;
            let other = scene.target(p + Point::new(0., -125.), 4000);
            scene.step(2);
            match kind {
                "gnar" => {
                    scene.damage(other, id, 9999);
                }
                "anivia" => {
                    scene.damage(other, id, 9999);
                    scene.step(180);
                    scene.damage(other, id, 9999);
                }
                "void_scuttle_crab" | "powder_keg" => {
                    scene.damage(other, id, 1);
                    scene.damage(other, id, 9999);
                }
                "blitzcrank" => scene.step(90),
                "jinx" | "jayce" | "aatrox" => {
                    scene.world.cast(id).unwrap();
                    scene.sample();
                    scene.step(32);
                    let target = scene.target(p + Point::new(0., -52.), 1);
                    scene.step(95);
                    if scene.world.game.battle.actors.contains_key(&target) {
                        scene.damage(id, target, 9999);
                    }
                    scene.step(260);
                }
                "darius" => {
                    let target = scene.target(p + Point::new(0., -55.), 30);
                    scene.cast(id);
                    scene.step(90);
                    let _ = target;
                }
                _ => {
                    scene.cast(id);
                    scene.step(120);
                }
            }
        });
    }
    // Cross the blocked river stretch rather than either bridge.
    for kind in ["kayn", "kayn_assassin", "kayn_slayer"] {
        run(&mut |scene| {
            let id = scene.unit(kind, 0, Point::new(340., 740.));
            scene.ready(id, 0.);
            scene.target(Point::new(340., 520.), 5000);
            scene.step(130);
        });
    }
    for kind in ["jinx", "aatrox", "gnar", "jayce", "ornn", "rift_herald"] {
        run(&mut |scene| {
            let id = scene.unit(kind, 0, pos);
            scene.ready(id, 0.);
            let p = scene.world.game.battle.actors[&id].pos;
            match kind {
                "aatrox" => {
                    scene.cast(id);
                    scene.step(25);
                    let victim = scene.target(p - Point::new(0., 75.), 10);
                    scene.damage(id, victim, 100);
                    scene.step(2);
                }
                "gnar" => {
                    scene.world.transform(id).unwrap();
                    scene.step(40);
                    scene.cast(id);
                    let a = &scene.world.game.battle.actors[&id];
                    scene.target(a.pos + a.facing * 75., 3000);
                    scene.step(60);
                }
                "jinx" => {
                    let tower = scene.world.game.towers[Team::Red.index()][0];
                    let target = scene.world.game.battle.actors[&tower].pos;
                    for form in 0..2 {
                        let gun = scene.world.game.battle.actors.get_mut(&id).unwrap();
                        gun.pos = target + Point::new(0., 140.);
                        gun.hp = gun.def.hp;
                        let building = UnitDef {
                            hp: 1,
                            role: crate::Role::Building,
                            ..UnitDef::melee()
                        };
                        let place = gun.pos - Point::new(60., 20.);
                        scene
                            .world
                            .game
                            .battle
                            .spawn(Team::Red, place, building)
                            .unwrap();
                        scene.step(90);
                        if form == 0 {
                            scene.cast(id);
                        }
                    }
                    scene.cast(id);
                    scene.step(25);
                }
                "jayce" => {
                    // Carry cannon charges over the automatic switch into hammer form.
                    scene.step(149);
                    scene.cast(id);
                    scene.step(32);
                    let pos = scene.world.game.battle.actors[&id].pos;
                    scene.target(pos - Point::new(0., 55.), 5000);
                    scene.step(140);
                }
                "ornn" => {
                    scene.cast(id);
                    scene.target(p - Point::new(0., 95.), 5000);
                    scene.step(60);
                }
                "rift_herald" => {
                    let tower = scene.world.game.towers[Team::Red.index()][0];
                    let goal = scene.world.game.battle.actors[&tower].pos;
                    scene.world.game.battle.actors.get_mut(&id).unwrap().pos =
                        goal + Point::new(0., 340.);
                    for _ in 0..180 {
                        scene.step(1);
                        let actor = &scene.world.game.battle.actors[&id];
                        if actor.card_state.sweep.is_some() {
                            scene.target(actor.pos + actor.facing * 50., 5000);
                            scene.step(50);
                            break;
                        }
                    }
                }
                _ => unreachable!(),
            }
        });
    }
    for (kind, distance) in [("samira", 50.), ("samira", 165.), ("yorick", 50.)] {
        run(&mut |scene| {
            let id = scene.unit(kind, 0, pos);
            scene.ready(id, 0.);
            let p = scene.world.game.battle.actors[&id].pos;
            scene.target(p - Point::new(0., distance), 10000);
            scene.step(220);
        });
    }
    for team in [Team::Red, Team::Blue] {
        run(&mut |scene| {
            let map = &scene.world.game.map.sides[team.index()];
            let target = scene.world.game.towers[team.index()][0];
            let nexus = scene.world.game.nexus[team.index()];
            let attacker = scene.target(map.towers[0] - Point::new(0., 85.), 3000);
            let max = scene.world.game.battle.actors[&target].hp;
            for _ in 0..3 {
                scene.damage(attacker, target, max / 3 + 1);
                scene.step(1);
            }
            scene.damage(attacker, nexus, 99999);
        });
    }
    cases
}
