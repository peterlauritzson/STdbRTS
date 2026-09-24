//! Per-tick cost of the core simulation at three entity tiers, on two map sizes.
//!
//! Answers one question and no other: **how expensive is `World::step_on` when
//! a four-player match holds 60, 120 or 240 mobile units per player?**
//! `ARCHITECTURE-AND-UX.md` keeps the supported tier at 60 until a larger one is
//! measured, with a budget of **p95 <= 25 ms and p99 < 50 ms** at 20 ticks per
//! second (a 50 ms tick period). `MAX_UNITS` is deliberately left alone here:
//! this example measures, it does not decide.
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
//!    That is O(entities) of row traffic per tick on top of everything measured
//!    here, and at 240 mobiles per player it may well be the *larger* half of
//!    the real tick. Not one row of it is in these numbers.
//!  * **Command validation.** The loop issues no player commands, so
//!    `validate_on` is never exercised. Real matches issue a few per second.
//!  * **Reducer scheduling, serialisation and client fan-out.**
//!
//! So: a configuration that is over budget here is certainly over budget on the
//! real server. A configuration that passes here has cleared the cheaper half.
//!
//! Run it in release — a debug timing number means nothing:
//!
//! ```text
//! cargo run --release --manifest-path server/core/Cargo.toml --example bench_load
//! ```

use rts_core::maps::MapDefinition;
use rts_core::simulation::{Order, World};
use rts_core::{is_building, Faction, TICKS_PER_SECOND};
use std::time::Instant;

/// Measured ticks per configuration. 600 is 30 s of match time at 20 TPS —
/// long enough for workers to complete many gather round trips and for the four
/// armies to meet, fight, die and be replaced repeatedly.
const MEASURED_TICKS: usize = 600;
/// Untimed ticks first, so allocator warmth and the initial path solves do not
/// land in the percentiles.
const WARMUP_TICKS: usize = 40;

const P95_BUDGET_MS: f64 = 25.0;
const P99_BUDGET_MS: f64 = 50.0;

const SLOTS: [u8; 4] = [0, 1, 2, 3];

/// The slot that plays Organic, so creep is part of the measured tick: its
/// labour is harvesters, and it holds `ORGANIC_OUTPOSTS` outposts beside its HQ,
/// each spreading a patch that sprouts and grows during the run. The other
/// three slots stay Industrial, as every earlier run of this example was.
const ORGANIC_SLOT: u8 = 3;
const ORGANIC_OUTPOSTS: usize = 4;

fn faction_of(slot: u8) -> Faction {
    if slot == ORGANIC_SLOT {
        Faction::Organic
    } else {
        Faction::Industrial
    }
}

/// Extent the *runtime* pathfinder can address, as `server/src/navigation.rs`
/// is written today: `SIDE` (40) cells of `CELL` (40) units, with `free()`
/// hardcoded to `16.0..=1584.0`, and terrain read from `maps::default_map()`
/// rather than from the map being simulated.
///
/// The static map validator became map-driven in this increment; the runtime
/// grid did not. Any row whose map is larger than this is therefore **not a
/// valid measurement of that map** — see the banner in `main`.
const RUNTIME_NAV_EXTENT: f32 = 1600.0;

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
/// between a deposit and their hub, soldiers and siege attack-move into the
/// middle where the other three armies are heading, and scouts cross the map on
/// plain move orders.
fn roster(slot: u8, mobiles: usize) -> [(&'static str, usize); 4] {
    let workers = mobiles * 45 / 100;
    let soldiers = mobiles * 35 / 100;
    let scouts = mobiles * 12 / 100;
    let siege = mobiles - workers - soldiers - scouts;
    let labour = match faction_of(slot) {
        Faction::Organic => "harvester",
        _ => "worker",
    };
    [
        (labour, workers),
        ("soldier", soldiers),
        ("scout", scouts),
        ("siege", siege),
    ]
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
        // Scouts run the map rather than parking on the centre point.
        "scout" => {
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
fn enlist(map: &MapDefinition, rng: &mut Rng, world: &mut World, slot: u8, kind: &str, index: usize) {
    let start = map.starts[slot as usize];
    let centre = map.size / 2.0;
    let order = busy_order(map, rng, slot, kind, index);
    let (x, y) = match kind {
        "worker" | "harvester" => free_spot(map, rng, order.x, order.y, 150.0),
        "scout" => free_spot(map, rng, start[0], start[1], map.size * 0.12),
        // Army stages between hub and middle, already walking in.
        _ => free_spot(
            map,
            rng,
            start[0] + (centre - start[0]) * 0.35,
            start[1] + (centre - start[1]) * 0.35,
            map.size * 0.14,
        ),
    };
    world.spawn(slot, kind, x, y);
    let unit = world.units.last_mut().expect("just spawned");
    unit.order = order;
}

/// Brings every slot up to its full roster and re-tasks anything that went
/// idle. Untimed scaffolding: without it the scenario decays into a field of
/// stationary units and the measurement drifts below the tier it claims.
fn hold_the_tier(map: &MapDefinition, rng: &mut Rng, world: &mut World, mobiles: usize) -> usize {
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
    for slot in SLOTS {
        for (kind, count) in roster(slot, mobiles) {
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

fn build_world(map: &MapDefinition, mobiles: usize) -> World {
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    // `new_on` gives each slot a hub plus three starting units and copies the
    // map's deposits in. Those three count toward the tier.
    let factions: Vec<(u8, Faction)> =
        SLOTS.iter().map(|slot| (*slot, faction_of(*slot))).collect();
    let mut world = World::new_on_with_factions(map, &factions);
    // Finished outposts ringing the Organic start, 260 out: each sprouts a
    // creep patch on the first tick and grows it through the run.
    let start = map.starts[ORGANIC_SLOT as usize];
    for index in 0..ORGANIC_OUTPOSTS {
        let angle = index as f32 / ORGANIC_OUTPOSTS as f32 * std::f32::consts::TAU;
        let (x, y) = free_spot(
            map,
            &mut rng,
            start[0] + 260.0 * angle.cos(),
            start[1] + 260.0 * angle.sin(),
            60.0,
        );
        world.spawn(ORGANIC_SLOT, "outpost", x, y);
    }
    hold_the_tier(map, &mut rng, &mut world, mobiles);
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
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let rank = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[rank]
}

fn measure(map: &MapDefinition, mobiles: usize) -> Sample {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut world = build_world(map, mobiles);
    let entities = world.units.len();
    let mut reinforcements = 0usize;
    let mut moved_total = 0usize;
    let mut alive_total = 0usize;

    for _ in 0..WARMUP_TICKS {
        world.step_on(map);
        hold_the_tier(map, &mut rng, &mut world, mobiles);
    }

    let mut costs = Vec::with_capacity(MEASURED_TICKS);
    let mut before: Vec<(u32, f32, f32)> = Vec::new();
    for _ in 0..MEASURED_TICKS {
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
                    .is_ok_and(|(_, x, y)| {
                        (unit.x - x).abs() > 0.01 || (unit.y - y).abs() > 0.01
                    })
            })
            .count();
        moved_total += moved;
        alive_total += before.len();
        reinforcements += hold_the_tier(map, &mut rng, &mut world, mobiles);
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
    }
}

fn main() {
    let skirmish = MapDefinition::parse(include_str!("../../../shared/maps/skirmish.json"))
        .expect("built-in skirmish map");
    let quadrille = MapDefinition::parse(include_str!("../../../shared/maps/quadrille.json"))
        .expect("quadrille melee map");
    let crossfire = MapDefinition::parse(include_str!("../../../shared/maps/crossfire.json"))
        .expect("crossfire melee map");
    let period_ms = 1000.0 / TICKS_PER_SECOND as f64;
    // `bench_load [tier ...] [map-id ...]` — defaults to 60/120/240 on both
    // maps. Naming tiers is how the ceiling between two of them gets located.
    let named_maps: Vec<String> = std::env::args()
        .skip(1)
        .filter(|argument| argument.parse::<usize>().is_err())
        .collect();
    let selected: Vec<&MapDefinition> = [&skirmish, &quadrille, &crossfire]
        .into_iter()
        .filter(|map| named_maps.is_empty() || named_maps.iter().any(|name| *name == map.id))
        .collect();
    assert!(!selected.is_empty(), "no map matched {named_maps:?}");
    let tiers: Vec<usize> = {
        let requested: Vec<usize> = std::env::args()
            .skip(1)
            .filter_map(|argument| argument.parse().ok())
            .filter(|tier| *tier > 0)
            .collect();
        if requested.is_empty() {
            vec![60, 120, 240]
        } else {
            requested
        }
    };

    println!(
        "Core simulation tick cost — 4 players, {MEASURED_TICKS} measured ticks per row \
         ({WARMUP_TICKS} warm-up), {period_ms:.0} ms tick period at {TICKS_PER_SECOND} TPS."
    );
    println!("Budget: p95 <= {P95_BUDGET_MS:.0} ms, p99 < {P99_BUDGET_MS:.0} ms.");
    println!("Mix per player: 45% workers gathering, 43% soldiers + siege attack-moving on the");
    println!("centre, 12% scouts crossing the map. Population held at the tier every tick.");
    println!(
        "Slot {ORGANIC_SLOT} plays Organic (harvesters for workers) with {ORGANIC_OUTPOSTS} outposts, so creep"
    );
    println!("patches sprout, grow and are carried through every measured tick.");
    println!();

    let header = format!(
        "{:<10} {:>6} {:>7} {:>9} {:>8} {:>8} {:>8} {:>8} {:>8} {:>7} {:>8}  {}",
        "map",
        "size",
        "mob/pl",
        "entities",
        "p50 ms",
        "p95 ms",
        "p99 ms",
        "max ms",
        "mean ms",
        "moved%",
        "respawns",
        "verdict"
    );
    println!("{header}");
    println!("{}", "-".repeat(header.len()));

    let mut rows = Vec::new();
    for map in selected {
        for tier in tiers.iter().copied() {
            let sample = measure(map, tier);
            let pass = sample.p95 <= P95_BUDGET_MS && sample.p99 < P99_BUDGET_MS;
            println!(
                "{:<10} {:>6.0} {:>7} {:>9} {:>8.3} {:>8.3} {:>8.3} {:>8.3} {:>8.3} {:>7.1} {:>8}  {}",
                map.id,
                map.size,
                tier,
                sample.entities,
                sample.p50,
                sample.p95,
                sample.p99,
                sample.max,
                sample.mean,
                sample.moved_percent,
                sample.reinforcements,
                if pass {
                    "WITHIN BUDGET"
                } else {
                    "OVER BUDGET"
                }
            );
            rows.push((map.id.clone(), map.size, tier, sample, pass));
        }
    }

    println!();
    if rows.iter().any(|(_, size, _, _, _)| *size > RUNTIME_NAV_EXTENT) {
        println!(
            "Note on maps larger than {RUNTIME_NAV_EXTENT:.0}: the runtime pathfinder is now map-driven, so"
        );
        println!("    these rows are real measurements. They were not before: the grid was fixed at");
        println!("    40x40 cells and read terrain from the default map, which froze every unit");
        println!("    outside a 1600 window and left moved% at 6-9% instead of the 74-90% seen now.");
        println!("    A larger map is genuinely more expensive: the grid is (size/40)^2 cells and is");
        println!("    rebuilt every tick, so 3200 costs about 4x the grid work of 1600.");
        println!();
    }
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
    println!();

    for (id, size, tier, sample, _) in &rows {
        if *size > RUNTIME_NAV_EXTENT {
            continue;
        }
        println!(
            "  {id}({size:.0}) @ {tier}/player: p95 = {:.1}% of the {period_ms:.0} ms tick period",
            sample.p95 / period_ms * 100.0
        );
    }
    println!();
    let over: Vec<_> = rows
        .iter()
        .filter(|(_, size, _, _, pass)| !*pass && *size <= RUNTIME_NAV_EXTENT)
        .map(|(id, size, tier, _, _)| format!("{id}({size:.0}) @ {tier}"))
        .collect();
    if over.is_empty() {
        println!("Every validly measured configuration is inside the core-simulation budget.");
    } else {
        println!(
            "Over budget on core simulation alone (persistence excluded): {}",
            over.join(", ")
        );
    }
}
