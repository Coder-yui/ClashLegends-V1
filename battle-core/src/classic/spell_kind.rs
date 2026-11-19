#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CardSpell {
    Heal,
    Freeze,
    Stasis,
    Zap,
    Lightning,
    MediumLightning,
    Corrosion,
    Cask,
    InfernoBomb,
    SolarFlare,
    Pool,
    FinalSpark,
    Pulse,
    Bolt,
    Tidal,
    Horizon,
    Stellar,
    Bear,
    Summoning,
}
impl CardSpell {
    pub fn from_kind(kind: &str) -> Option<Self> {
        Some(match kind {
            "final_spark" => Self::FinalSpark,
            "convergent_pulse" => Self::Pulse,
            "severing_bolt" => Self::Bolt,
            "tidal_wave" => Self::Tidal,
            "event_horizon" => Self::Horizon,
            "stellar_convergence" => Self::Stellar,
            "airdrop_bear" => Self::Bear,
            "void_summoning" => Self::Summoning,
            "heal" => Self::Heal,
            "freeze" => Self::Freeze,
            "stasis" => Self::Stasis,
            "zap" => Self::Zap,
            "lightning" => Self::Lightning,
            "medium_lightning" => Self::MediumLightning,
            "corrosion" => Self::Corrosion,
            "explosive_cask" => Self::Cask,
            "mega_inferno_bomb" => Self::InfernoBomb,
            "solar_flare" => Self::SolarFlare,
            "pool_of_reflection" => Self::Pool,
            _ => return None,
        })
    }
}
