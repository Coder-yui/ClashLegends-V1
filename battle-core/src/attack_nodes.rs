//! Offline-calibrated release points. No model assets are needed by the simulation.
use crate::Actor;
use serde::Deserialize;
use std::{collections::BTreeMap, sync::LazyLock};

type AttackRoles = BTreeMap<String, Vec<Node>>;
type Catalog = BTreeMap<String, Variants>;

#[derive(Deserialize)]
struct Variants {
    base: AttackRoles,
    alternate: Option<AttackRoles>,
}

#[derive(Deserialize)]
pub(crate) struct Node(u32);

impl Node {
    pub fn windup(&self, interval: u32) -> u64 {
        // Attack clock units are 1/1000 of a base tick. Round only here;
        // rounding a windup to whole ticks first compounds error at low speed.
        (u64::from(interval) * u64::from(self.0) + 500) / 1000
    }
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../content/attack_timing.json")).unwrap()
});

pub(crate) fn select(
    a: &Actor,
    tick: u64,
    segment: u32,
    structure: bool,
    first_cycle: bool,
) -> Option<(&'static str, &'static Node)> {
    let variants = CATALOG.get(a.def.key)?;
    let roles = if a.card_state.changed_form {
        variants.alternate.as_ref().unwrap_or(&variants.base)
    } else {
        &variants.base
    };
    for (role, applies) in [
        ("empowered_attack", a.card_state.empowered.is_some()),
        ("active_buff_attack", a.active_skill_buff(tick)),
        ("control_immune_attack", a.card_state.immunity > tick),
        ("attack_structure", structure),
        ("first_strike_attack", first_cycle),
        ("attack", true),
    ] {
        if let Some(nodes) = roles.get(role).filter(|_| applies) {
            return Some((role, &nodes[segment as usize % nodes.len()]));
        }
    }
    None
}
