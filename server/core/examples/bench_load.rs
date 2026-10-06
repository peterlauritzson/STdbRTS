//! Per-tick cost of the core simulation at the supported entity tiers.
//!
//! Answers one question and no other: **how expensive is `World::step_on` when
//! a match holds N players × M mobile units each?** The budget is **p95 <= 25
//! ms and p99 < 50 ms** at 20 ticks per second (a 50 ms tick period).
//!
//! The default rows are the tiers the engine is sized for: the `expanse` match
//! map (9600 × 9600, a 240 × 240 navigation grid) with 2 and 4 players at
//! `MAX_UNITS` (400) mobiles each. 2 × 400 is the must-pass target; 4 × 400 is
//! reported as best effort. A row is selected with `players:mobiles`
//! arguments, and a map by id:
//!
//! ```text
//! cargo run --release --manifest-path server/core/Cargo.toml --example bench_load
//! cargo run --release --manifest-path server/core/Cargo.toml --example bench_load -- 4:120 crossfire
//! cargo run --release --manifest-path server/core/Cargo.toml --example bench_load -- churn
//! ```
//!
//! Routing is memoised across ticks (per-goal route fields, valid while the
//! building layout stands), so a steady-state row measures warm caches. The
//! `churn` flag drops a building every few seconds of match time, which
//! invalidates every field, to show the cost of the ticks that rebuild them.
//!
//! ## What is timed
//!
//! Only `World::step_on`. Everything else the loop does — holding the
//! population at the tier, refilling deposits, keeping hubs alive, re-tasking
//! units that finished their order — happens outside the clock.
//!
//! ## What is NOT included, and why the numbers are a floor
//!
//!  * **Database persistence.** The real server reads every unit, node, command
//!    and player row out of SpacetimeDB before a tick and writes the changed
//!    ones back after it (`server/src/game.rs`, `load_world` / `save_world`).
//!    Every moving unit rewrites its row each tick. None of that is here.
//!  * **Command validation.** The loop issues no player commands, so
//!    `validate_on` is never exercised. Real matches issue a few per second.
//!  * **Reducer scheduling, serialisation and client fan-out.**
//!
//! So: a configuration that is over budget here is certainly over budget on the
//! real server. A configuration that passes here has cleared the cheaper half.
//!
//! Run it in release — a debug timing number means nothing.

use rts_core::maps::MapDefinition;
use rts_core::simulation::{Entity, Order, World};
use rts_core::{is_building, Faction, TICKS_PER_SECOND};
use std::time::Instant;

/// Measured ticks per configuration. 600 is 30 s of match time at 20 TPS —
/// long enough for workers to complete many gather round trips and for the
/// armies to meet, fight, die and be replaced repeatedly.
const MEASURED_TICKS: usize = 600;
/// Untimed ticks first, so allocator warmth does not land in the percentiles.
const WARMUP_TICKS: usize = 40;

const P95_BUDGET_MS: f64 = 25.0;
const P99_BUDGET_MS: f64 = 50.0;

/// The highest slot in the match plays Organic, so creep is part of the
/// measured tick: its labour is harvesters, and it holds `ORGANIC_OUTPOSTS`
/// outposts beside its HQ, each spreading a patch that sprouts and grows during
/// the run. Every other slot is Industrial.
const ORGANIC_OUTPOSTS: usize = 4;

fn faction_of(slot: u8, players: usize) -> Faction {
    if slot as usize == players - 1 {
        Faction::Organic
    } else {
        Faction::Industrial
    }
}

/// Deterministic xorshift, so two runs of this example compare like for like.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    /// Uniform in [0, 1).
    fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
}

/// A spot inside `radius` of `(cx, cy)` that is on the map and clear of
/// terrain. Falls back to the centre point rather than looping forever.
fn free_spot(map: &MapDefinition, rng: &mut Rng, cx: f32, cy: f32, radius: f32) -> (f32, f32) {
    for _ in 0..64 {
        let angle = rng.unit() * std::f32::consts::TAU;
        let distance = radius * rng.unit().sqrt();
        let x = (cx + distance * angle.cos()).clamp(40.0, map.size - 40.0);
        let y = (cy + distance * angle.sin()).clamp(40.0, map.size - 40.0);
        if map.terrain_free(x, y, 16.0) {
            return (x, y);
        }
    }
    (
        cx.clamp(40.0, map.size - 40.0),
        cy.clamp(40.0, map.size - 40.0),
    )
}

/// The roster one player fields at a given tier.
///
/// Idle units skip nearly all of `step_on`, so an idle benchmark measures
/// nothing. This mix keeps every unit busy: workers run gather round trips
/// between a deposit and their hub, fighters attack-move into the middle where
/// the other armies are heading, and raiders cross the map on plain move
/// orders. Each faction fields its own roster (barracks and factory units
/// alike), so every passive is exercised: veteran, forced march, splash,
/// entrenchment, field medic, guardian, battle blink, overwatch, ricochet, phase
/// shift, shield aura, predator, regrowth and death burst.
fn roster(slot: u8, players: usize, mobiles: usize) -> Vec<(&'static str, usize)> {
    let workers = mobiles * 45 / 100;
    let faction = faction_of(slot, players);
    let labour = match faction {
        Faction::Organic => "harvester",
        _ => "worker",
    };
    // Shares of the tier that is not labour (55%): the faction's own roster
    // (37%) plus a Network detachment (18%) fielded by everyone, so the
    // shield-bound passives (blink, phase shift, shield aura, ricochet,
    // overwatch) run at the 2 x 400 tier even though no slot plays Network
    // there. Kinds do not check their owner's faction, so this is legal; the
    // detachment simply carries no shields under a non-Network owner.
    let own: &[(&'static str, usize)] = match faction {
        Faction::Industrial | Faction::Network => &[
            ("soldier", 12),
            ("marksman", 6),
            ("medic", 3),
            ("siege", 4),
            ("bulwark", 4),
            ("scout", 8),
        ],
        Faction::Organic => &[
            ("swarmer", 12),
            ("devourer", 6),
            ("spitter", 4),
            ("crusher", 2),
            ("behemoth", 5),
            ("prowler", 8),
        ],
    };
    let detachment: &[(&'static str, usize)] = &[
        ("sentinel", 6),
        ("arcer", 4),
        ("phantom", 3),
        ("warden", 2),
        ("lancer", 3),
    ];
    let shares = own.iter().chain(detachment.iter());
    let mut mix = vec![(labour, workers)];
    let mut assigned = workers;
    for (kind, percent) in shares {
        let count = mobiles * percent / 100;
        mix.push((kind, count));
        assigned += count;
    }
    // Rounding remainder goes to the first fighter.
    mix[1].1 += mobiles - assigned;
    mix
}

/// Deposit IDs nearest a player's start — where that player's workers would
/// really be mining.
fn home_deposits(map: &MapDefinition, slot: u8) -> Vec<u32> {
    let start = map.starts[slot as usize];
    let mut sites: Vec<_> = map
        .deposits
        .iter()
        .map(|deposit| {
            let dx = deposit.x - start[0];
            let dy = deposit.y - start[1];
            (dx * dx + dy * dy, deposit.id)
        })
        .collect();
    sites.sort_by(|left, right| left.0.total_cmp(&right.0).then(left.1.cmp(&right.1)));
    sites.into_iter().take(8).map(|(_, id)| id).collect()
}

/// Where a player's army stands and fights: most of the way from its start to
/// the centre, so on a 9600 map the armies actually meet inside the measured
/// window instead of spending it all walking.
fn front(map: &MapDefinition, slot: u8) -> (f32, f32) {
    let start = map.starts[slot as usize];
    let centre = map.size / 2.0;
    (
        start[0] + (centre - start[0]) * 0.8,
        start[1] + (centre - start[1]) * 0.8,
    )
}

/// A standing order that keeps a unit of `kind` doing work.
fn busy_order(map: &MapDefinition, rng: &mut Rng, slot: u8, kind: &str, index: usize) -> Order {
    let centre = map.size / 2.0;
    match kind {
        "worker" | "harvester" => {
            let sites = home_deposits(map, slot);
            let id = sites[index % sites.len()];
            let site = map
                .deposits
                .iter()
                .find(|deposit| deposit.id == id)
                .expect("home deposit exists");
            Order {
                kind: "gather".into(),
                x: site.x,
                y: site.y,
                target: id,
            }
        }
        // Scouts run the map rather than parking on the centre point: long
        // routed trips, the worst case for the pathfinder.
        "scout" | "skimmer" | "prowler" => {
            let (x, y) = free_spot(map, rng, centre, centre, map.size * 0.45);
            Order {
                kind: "move".into(),
                x,
                y,
                target: 0,
            }
        }
        _ => Order {
            kind: "attack_move".into(),
            x: centre,
            y: centre,
            target: 0,
        },
    }
}

/// Spawns one unit of `kind` for `slot`, positioned where it would plausibly be
/// and carrying a standing order.
fn enlist(
    map: &MapDefinition,
    rng: &mut Rng,
    world: &mut World,
    slot: u8,
    kind: &str,
    index: usize,
) {
    let start = map.starts[slot as usize];
    let order = busy_order(map, rng, slot, kind, index);
    let (x, y) = match kind {
        "worker" | "harvester" => free_spot(map, rng, order.x, order.y, 150.0),
        "scout" | "skimmer" | "prowler" => free_spot(map, rng, start[0], start[1], 1200.0),
        // Army stages near its front, already walking in.
        _ => {
            let (front_x, front_y) = front(map, slot);
            free_spot(map, rng, front_x, front_y, 500.0)
        }
    };
    world.spawn(slot, kind, x, y);
    let unit = world.units.last_mut().expect("just spawned");
    unit.order = order;
}

/// Brings every slot up to its full roster and re-tasks anything that went
/// idle. Untimed scaffolding: without it the scenario decays into a field of
/// stationary units and the measurement drifts below the tier it claims.
fn hold_the_tier(
    map: &MapDefinition,
    rng: &mut Rng,
    world: &mut World,
    players: usize,
    mobiles: usize,
) -> usize {
    let mut reinforcements = 0;
    for (index, node) in world.nodes.iter_mut().enumerate() {
        node.amount = map.deposits[index].amount;
    }
    for unit in &mut world.units {
        if is_building(&unit.kind) {
            unit.hp = unit.max_hp;
        }
    }
    world.outcome = None;
    for slot in 0..players as u8 {
        for (kind, count) in roster(slot, players, mobiles) {
            let held = world
                .units
                .iter()
                .filter(|unit| unit.owner == slot && unit.kind == kind)
                .count();
            for index in held..count {
                enlist(map, rng, world, slot, kind, index);
                reinforcements += 1;
            }
        }
    }
    for index in 0..world.units.len() {
        let (owner, kind, idle) = {
            let unit = &world.units[index];
            (
                unit.owner,
                unit.kind.clone(),
                !is_building(&unit.kind)
                    && unit.queue.is_empty()
                    && matches!(unit.order.kind.as_str(), "stop" | "hold"),
            )
        };
        if idle {
            world.units[index].order = busy_order(map, rng, owner, &kind, index);
        }
    }
    reinforcements
}

fn build_world(map: &MapDefinition, players: usize, mobiles: usize) -> World {
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    // `new_on` gives each slot a hub plus three starting units and copies the
    // map's deposits in. Those three count toward the tier.
    let factions: Vec<(u8, Faction)> = (0..players as u8)
        .map(|slot| (slot, faction_of(slot, players)))
        .collect();
    let mut world = World::new_on_with_factions(map, &factions);
    // Finished outposts ringing the Organic start, 260 out: each sprouts a
    // creep patch on the first tick and grows it through the run.
    let organic = (players - 1) as u8;
    let start = map.starts[organic as usize];
    for index in 0..ORGANIC_OUTPOSTS {
        let angle = index as f32 / ORGANIC_OUTPOSTS as f32 * std::f32::consts::TAU;
        let (x, y) = free_spot(
            map,
            &mut rng,
            start[0] + 260.0 * angle.cos(),
            start[1] + 260.0 * angle.sin(),
            60.0,
        );
        world.spawn(organic, "outpost", x, y);
    }
    hold_the_tier(map, &mut rng, &mut world, players, mobiles);
    world
}

struct Sample {
    p50: f64,
    p95: f64,
    p99: f64,
    max: f64,
    mean: f64,
    entities: usize,
    moved_percent: f64,
    reinforcements: usize,
    /// Unit rows `save_world` would write per tick: inserted, changed or
    /// deleted by the step (its diff skips unchanged rows).
    rows_per_tick: f64,
    /// Public rows broadcast per tick after the split (cold + motion + vitals; the
    /// private state table is never sent), and the estimated BSATN bytes per
    /// tick before (one whole-entity row) and after (public parts).
    split_rows_per_tick: f64,
    bytes_before: f64,
    bytes_after: f64,
}

// --- approximate BSATN sizes of the public rows -------------------------------
// String = 4 + len, Vec = 4 + elements, Option = 1 + payload. Every row also
// carries its u64 id and u64 match_id. A row update goes over the wire as
// delete(old) + insert(new); both columns of the comparison count one row per
// write, so the ratio is unaffected.
const ROW_KEYS: usize = 16;
fn s_len(text: &str) -> usize {
    4 + text.len()
}
fn order_len(order: &Order) -> usize {
    s_len(&order.kind) + 4 + 4 + 4
}
fn cold_len(c: &rts_core::simulation::EntityCold) -> usize {
    4 + 1
        + s_len(&c.kind)
        + order_len(&c.order)
        + 4
        + c.queue.iter().map(order_len).sum::<usize>()
        + 4 + 1
        + 4
        + c.production.iter().map(|p| s_len(&p.kind) + 8).sum::<usize>()
        + 8 + 4 + 8 + 4 + 4 + 8 + 8 + 4 + 8
        + 1
        + c.cast.as_ref().map_or(0, |cast| s_len(&cast.kind) + 4 + 4 + 8)
        + 2
}
fn motion_len() -> usize {
    4 + 4
}
fn vitals_len() -> usize {
    4 + 4 + 8 + 4 + 4 + 8 + 8
}
fn state_len() -> usize {
    1 + 8 + 4 + 8 + 4 + 4 + 8
}
fn full_len(entity: &Entity) -> usize {
    let (cold, _, _, _, _) = entity.split();
    ROW_KEYS + cold_len(&cold) + motion_len() + vitals_len() + state_len()
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let rank = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[rank]
}

/// Ticks between two buildings dropped on the map when `churn` is asked for.
const CHURN_INTERVAL: usize = 50;

fn measure(map: &MapDefinition, players: usize, mobiles: usize, churn: bool) -> Sample {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut world = build_world(map, players, mobiles);
    let entities = world.units.len();
    let mut reinforcements = 0usize;
    let mut moved_total = 0usize;
    let mut alive_total = 0usize;

    for _ in 0..WARMUP_TICKS {
        world.step_on(map);
        hold_the_tier(map, &mut rng, &mut world, players, mobiles);
    }

    let mut costs = Vec::with_capacity(MEASURED_TICKS);
    let mut before: Vec<(u32, f32, f32)> = Vec::new();
    let mut rows_total = 0usize;
    let mut split_rows = 0usize;
    let mut bytes_before = 0usize;
    let mut bytes_after = 0usize;
    for tick in 0..MEASURED_TICKS {
        // A new building changes the routing layout, which invalidates every
        // cached route field: the worst tick a real match sees when someone
        // builds or loses a structure.
        if churn && tick % CHURN_INTERVAL == 0 {
            let centre = map.size / 2.0;
            let (x, y) = free_spot(map, &mut rng, centre, centre, 3000.0);
            world.spawn(0, "turret", x, y);
        }
        let mut rows_before = world.units.clone();
        rows_before.sort_unstable_by_key(|unit| unit.id);
        before.clear();
        before.extend(
            world
                .units
                .iter()
                .filter(|unit| !is_building(&unit.kind))
                .map(|unit| (unit.id, unit.x, unit.y)),
        );
        before.sort_unstable_by_key(|(id, _, _)| *id);

        let clock = Instant::now();
        world.step_on(map);
        costs.push(clock.elapsed().as_secs_f64() * 1000.0);

        let moved = world
            .units
            .iter()
            .filter(|unit| !is_building(&unit.kind))
            .filter(|unit| {
                before
                    .binary_search_by_key(&unit.id, |(id, _, _)| *id)
                    .map(|at| before[at])
                    .is_ok_and(|(_, x, y)| (unit.x - x).abs() > 0.01 || (unit.y - y).abs() > 0.01)
            })
            .count();
        moved_total += moved;
        alive_total += before.len();
        let mut rows_after = world.units.clone();
        rows_after.sort_unstable_by_key(|unit| unit.id);
        let written = rows_after
            .iter()
            .filter(|unit| {
                rows_before
                    .binary_search_by_key(&unit.id, |old| old.id)
                    .map_or(true, |at| rows_before[at] != **unit)
            })
            .count();
        for unit in &rows_after {
            let (cold, motion, vitals, _, _) = unit.split();
            let parts = ROW_KEYS + cold_len(&cold);
            match rows_before.binary_search_by_key(&unit.id, |old| old.id) {
                Err(_) => {
                    bytes_before += full_len(unit);
                    split_rows += 3;
                    bytes_after += parts + 2 * ROW_KEYS + motion_len() + vitals_len();
                }
                Ok(at) if rows_before[at] != *unit => {
                    bytes_before += full_len(unit);
                    let (old_cold, old_motion, old_vitals, _, _) = rows_before[at].split();
                    if old_cold != cold {
                        split_rows += 1;
                        bytes_after += parts;
                    }
                    if old_motion != motion {
                        split_rows += 1;
                        bytes_after += ROW_KEYS + motion_len();
                    }
                    if old_vitals != vitals {
                        split_rows += 1;
                        bytes_after += ROW_KEYS + vitals_len();
                    }
                }
                Ok(_) => {}
            }
        }
        for old in &rows_before {
            if rows_after.binary_search_by_key(&old.id, |unit| unit.id).is_err() {
                bytes_before += full_len(old);
                let (cold, _, _, _, _) = old.split();
                split_rows += 3;
                bytes_after += ROW_KEYS + cold_len(&cold) + 2 * ROW_KEYS + motion_len() + vitals_len();
            }
        }
        let deleted = rows_before
            .iter()
            .filter(|old| rows_after.binary_search_by_key(&old.id, |unit| unit.id).is_err())
            .count();
        rows_total += written + deleted;
        reinforcements += hold_the_tier(map, &mut rng, &mut world, players, mobiles);
    }

    costs.sort_by(f64::total_cmp);
    Sample {
        p50: percentile(&costs, 0.50),
        p95: percentile(&costs, 0.95),
        p99: percentile(&costs, 0.99),
        max: costs[costs.len() - 1],
        mean: costs.iter().sum::<f64>() / costs.len() as f64,
        entities,
        moved_percent: moved_total as f64 / alive_total.max(1) as f64 * 100.0,
        reinforcements,
        rows_per_tick: rows_total as f64 / MEASURED_TICKS as f64,
        split_rows_per_tick: split_rows as f64 / MEASURED_TICKS as f64,
        bytes_before: bytes_before as f64 / MEASURED_TICKS as f64,
        bytes_after: bytes_after as f64 / MEASURED_TICKS as f64,
    }
}

fn main() {
    let maps = [
        MapDefinition::parse(include_str!("../../../shared/maps/expanse.json"))
            .expect("expanse match map"),
        MapDefinition::parse(include_str!("../../../shared/maps/crossfire.json"))
            .expect("crossfire melee map"),
        MapDefinition::parse(include_str!("../../../shared/maps/quadrille.json"))
            .expect("quadrille melee map"),
        MapDefinition::parse(include_str!("../../../shared/maps/skirmish.json"))
            .expect("built-in skirmish map"),
    ];
    let period_ms = 1000.0 / TICKS_PER_SECOND as f64;
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let tier = |argument: &String| -> Option<(usize, usize)> {
        let (players, mobiles) = argument.split_once(':')?;
        Some((players.parse().ok()?, mobiles.parse().ok()?))
    };
    let churn = arguments.iter().any(|argument| argument == "churn");
    let named_maps: Vec<&String> = arguments
        .iter()
        .filter(|argument| tier(argument).is_none() && *argument != "churn")
        .collect();
    let selected: Vec<&MapDefinition> = if named_maps.is_empty() {
        vec![&maps[0]]
    } else {
        maps.iter()
            .filter(|map| named_maps.iter().any(|name| **name == map.id))
            .collect()
    };
    assert!(!selected.is_empty(), "no map matched {named_maps:?}");
    let tiers: Vec<(usize, usize)> = {
        let requested: Vec<(usize, usize)> = arguments
            .iter()
            .filter_map(tier)
            .filter(|(players, mobiles)| (1..=4).contains(players) && *mobiles > 0)
            .collect();
        if requested.is_empty() {
            vec![(2, 400), (4, 400)]
        } else {
            requested
        }
    };

    println!(
        "Core simulation tick cost — {MEASURED_TICKS} measured ticks per row ({WARMUP_TICKS} \
         warm-up), {period_ms:.0} ms tick period at {TICKS_PER_SECOND} TPS."
    );
    println!("Budget: p95 <= {P95_BUDGET_MS:.0} ms, p99 < {P99_BUDGET_MS:.0} ms.");
    println!("Mix per player: 45% workers gathering, 43% soldiers + siege attack-moving on the");
    println!("centre from a front 80% of the way there, 12% scouts crossing the map.");
    println!("Population held at the tier every tick. The highest slot plays Organic with");
    println!("{ORGANIC_OUTPOSTS} outposts, so creep sprouts, grows and is carried through every tick.");
    if churn {
        println!(
            "CHURN: a building is dropped every {CHURN_INTERVAL} ticks, invalidating every cached route field."
        );
    }
    println!();

    let header = format!(
        "{:<10} {:>6} {:>7} {:>7} {:>9} {:>8} {:>8} {:>8} {:>8} {:>8} {:>7} {:>8} {:>9}  {}",
        "map",
        "size",
        "players",
        "mob/pl",
        "entities",
        "p50 ms",
        "p95 ms",
        "p99 ms",
        "max ms",
        "mean ms",
        "moved%",
        "respawns",
        "rows/tick",
        "verdict"
    );
    println!("{header}");
    println!("{}", "-".repeat(header.len()));

    let mut over = Vec::new();
    for map in selected {
        for (players, mobiles) in tiers.iter().copied() {
            let sample = measure(map, players, mobiles, churn);
            let pass = sample.p95 <= P95_BUDGET_MS && sample.p99 < P99_BUDGET_MS;
            println!(
                "{:<10} {:>6.0} {:>7} {:>7} {:>9} {:>8.3} {:>8.3} {:>8.3} {:>8.3} {:>8.3} {:>7.1} {:>8} {:>9.0}  {}",
                map.id,
                map.size,
                players,
                mobiles,
                sample.entities,
                sample.p50,
                sample.p95,
                sample.p99,
                sample.max,
                sample.mean,
                sample.moved_percent,
                sample.reinforcements,
                sample.rows_per_tick,
                if pass { "WITHIN BUDGET" } else { "OVER BUDGET" }
            );
            println!(
                "{:>10} rows/tick {:.0} -> {:.0} (public: cold+motion+vitals); est. bytes/tick {:.0} -> {:.0} ({:.1}x less, {:.0} -> {:.0} KB/s)",
                "split:",
                sample.rows_per_tick,
                sample.split_rows_per_tick,
                sample.bytes_before,
                sample.bytes_after,
                sample.bytes_before / sample.bytes_after.max(1.0),
                sample.bytes_before * 20.0 / 1024.0,
                sample.bytes_after * 20.0 / 1024.0,
            );
            if !pass {
                over.push(format!("{}({:.0}) {players}x{mobiles}", map.id, map.size));
            }
        }
    }

    println!();
    println!("Notes");
    println!("  * Timed region is `World::step_on` only.");
    println!("  * EXCLUDES SpacetimeDB persistence. The real server loads every unit, node,");
    println!("    command and player row before each tick and writes the changed ones back");
    println!("    afterwards; none of that row traffic is in these numbers. Every figure is a");
    println!("    floor on the real server tick, not the tick itself.");
    println!("  * EXCLUDES command validation, reducer scheduling and client fan-out.");
    println!("  * `moved%` is the share of live mobile units that changed position on an");
    println!("    average tick. A low value means units were not pathing, so that row is");
    println!("    measuring less work than a real match of the same size would.");
    println!("  * `respawns` counts units replaced over the run to hold the tier — a proxy");
    println!("    for how much combat the mix produced.");
    println!("  * `rows/tick` is how many unit rows `save_world` would insert, update or");
    println!("    delete per tick (it skips unchanged rows): the persistence and client");
    println!("    fan-out load this table does not time.");
    println!("  * Route fields are memoised across ticks, so steady-state rows measure warm");
    println!("    caches. Pass `churn` to drop a building every {CHURN_INTERVAL} ticks and see the");
    println!("    cost of the tick that recomputes them.");
    println!();
    if over.is_empty() {
        println!("Every measured configuration is inside the core-simulation budget.");
    } else {
        println!(
            "Over budget on core simulation alone (persistence excluded): {}",
            over.join(", ")
        );
    }
}
