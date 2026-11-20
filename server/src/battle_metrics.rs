//! Opt-in timings for the 50 ms host tick. WebSocket delivery is measured at each receiving seat.
use std::time::Instant;
pub(super) struct Ticks {
    samples: Vec<[u64; 4]>,
}
impl Ticks {
    pub fn enabled() -> Option<Self> {
        (std::env::var("LOBBY_BATTLE_METRICS").as_deref() == Ok("1")).then(|| Self {
            samples: Vec::with_capacity(200),
        })
    }
    pub fn record(
        &mut self,
        id: &str,
        tick: u64,
        start: Instant,
        simulated: Instant,
        durable: Instant,
        finished: bool,
    ) {
        let end = Instant::now();
        self.samples.push(
            [
                simulated - start,
                durable - simulated,
                end - durable,
                end - start,
            ]
            .map(|d| d.as_micros() as u64),
        );
        if self.samples.len() < 200 && !finished {
            return;
        }
        let p95 = [0, 1, 2, 3].map(|i| {
            let mut times: Vec<_> = self.samples.iter().map(|s| s[i]).collect();
            times.sort_unstable();
            times[(times.len() * 95).div_ceil(100) - 1]
        });
        let over = self.samples.iter().filter(|s| s[3] > 50_000).count();
        eprintln!(
            "battle tick metrics {}",
            serde_json::json!({"match":id,"tick":tick,"samples":self.samples.len(),"simulationAndViewsP95us":p95[0],"dbP95us":p95[1],"frameBuildP95us":p95[2],"totalP95us":p95[3],"over50ms":over})
        );
        self.samples.clear();
    }
}
