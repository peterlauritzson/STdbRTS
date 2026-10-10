//! Tests for `crate::doctrine`: off by default, the deficit rule, locked kinds,
//! the catalyst reserve, idle buildings only, tier and research order, and
//! command validation.

use super::*;
use crate::maps::default_map;
use crate::{Balance, Faction, ResourceKind};

const HQ: (f32, f32) = (200.0, 1300.0);

fn arena() -> World {
    let mut world = World::new_on_with_factions(
        default_map(),
        &[(0, Faction::Industrial), (1, Faction::Industrial)],
    );
    world.units.clear();
    world.spawn(0, "hq", HQ.0, HQ.1);
    world.spawn(1, "hq", 1400.0, 1400.0);
    world.tick = 1000;
    world.balances.insert(0, Balance::new(5000, 5000));
    world
}

fn building(world: &mut World, kind: &str) -> u32 {
    world.spawn(0, kind, 300.0, 1200.0);
    world.units.last().unwrap().id
}

fn queued(world: &World, id: u32) -> Vec<String> {
    world
        .units
        .iter()
        .find(|unit| unit.id == id)
        .unwrap()
        .production
        .iter()
        .map(|item| item.kind.clone())
        .collect()
}

fn on() -> Doctrine {
    Doctrine {
        enabled: true,
        ..Doctrine::default()
    }
}

fn pass(world: &mut World) {
    world.run_doctrines(default_map());
}

fn command(owner: u8, unit: u32, kind: &str, x: f32) -> Command {
    Command {
        id: 1,
        owner,
        units: vec![unit],
        order: Order {
            kind: kind.into(),
            x,
            y: 0.0,
            target: 0,
        },
        queued: false,
        execute_tick: 0,
        status: "scheduled".into(),
        reason: String::new(),
    }
}

#[test]
fn off_by_default_does_nothing() {
    let mut world = arena();
    let barracks = building(&mut world, "barracks");
    pass(&mut world);
    assert!(queued(&world, barracks).is_empty());
    // Auto-tier and auto-research alone do not train either.
    world.doctrines.insert(
        0,
        Doctrine {
            auto_tier: true,
            auto_research: true,
            ..Doctrine::default()
        },
    );
    pass(&mut world);
    assert!(queued(&world, barracks).is_empty());
    // And a player with nothing on buys nothing.
    world.doctrines.clear();
    let held = world.research.get(&0).map_or(0, Vec::len);
    pass(&mut world);
    assert_eq!(world.research.get(&0).map_or(0, Vec::len), held);
}

#[test]
fn deficit_picks_the_underrepresented_kind() {
    let mut world = arena();
    let barracks = building(&mut world, "barracks");
    for _ in 0..3 {
        world.spawn(0, "soldier", 400.0, 1200.0);
    }
    world.doctrines.insert(0, on());
    pass(&mut world);
    assert_eq!(queued(&world, barracks), vec!["scout"]);
}

#[test]
fn ties_go_to_the_earlier_roster_entry() {
    let mut world = arena();
    let barracks = building(&mut world, "barracks");
    world.doctrines.insert(0, on());
    pass(&mut world);
    assert_eq!(queued(&world, barracks), vec!["soldier"]);
}

#[test]
fn locked_kinds_are_skipped_until_the_tier_is_bought() {
    let mut world = arena();
    let barracks = building(&mut world, "barracks");
    let mut doctrine = on();
    doctrine.weights.insert("scout".into(), 0);
    doctrine.weights.insert("marksman".into(), 10);
    doctrine.weights.insert("soldier".into(), 1);
    world.doctrines.insert(0, doctrine);
    pass(&mut world);
    assert_eq!(
        queued(&world, barracks),
        vec!["soldier"],
        "marksman needs tier 1"
    );
    world
        .units
        .iter_mut()
        .find(|unit| unit.id == barracks)
        .unwrap()
        .production
        .clear();
    world.research.insert(0, vec!["tier_1".into()]);
    pass(&mut world);
    assert_eq!(queued(&world, barracks), vec!["marksman"]);
}

#[test]
fn reserve_is_respected() {
    let mut world = arena();
    let barracks = building(&mut world, "barracks");
    let cost = stats("soldier").unwrap().cost.catalyst;
    let mut doctrine = on();
    doctrine.reserve = 150;
    world.doctrines.insert(0, doctrine);
    world.balances.insert(0, Balance::new(0, cost + 149));
    pass(&mut world);
    assert!(queued(&world, barracks).is_empty());
    world.balances.insert(0, Balance::new(0, cost + 150));
    pass(&mut world);
    assert_eq!(queued(&world, barracks), vec!["soldier"]);
    assert_eq!(world.balances[&0].catalyst, 150);
}

#[test]
fn only_empty_queues_get_an_item_and_only_one() {
    let mut world = arena();
    let busy = building(&mut world, "barracks");
    let idle = building(&mut world, "barracks");
    world
        .execute_on(&command(0, busy, "train_scout", 0.0), default_map())
        .unwrap();
    world.doctrines.insert(0, on());
    pass(&mut world);
    assert_eq!(
        queued(&world, busy),
        vec!["scout"],
        "a manual queue is left alone"
    );
    // The scout already queued counts, so the idle building adds a soldier.
    assert_eq!(queued(&world, idle), vec!["soldier"]);
}

#[test]
fn unfinished_buildings_are_skipped() {
    let mut world = arena();
    let barracks = building(&mut world, "barracks");
    world
        .units
        .iter_mut()
        .find(|unit| unit.id == barracks)
        .unwrap()
        .construction_remaining = 50;
    world.doctrines.insert(0, on());
    pass(&mut world);
    assert!(queued(&world, barracks).is_empty());
}

#[test]
fn tier_then_research_one_purchase_per_pass() {
    let mut world = arena();
    building(&mut world, "barracks");
    world.doctrines.insert(
        0,
        Doctrine {
            auto_tier: true,
            auto_research: true,
            ..Doctrine::default()
        },
    );
    pass(&mut world);
    assert_eq!(
        world.research[&0],
        vec!["tier_1"],
        "the tier first, and nothing else"
    );
    // No factory, so tier 2 is refused and research goes: weapons on a tie.
    pass(&mut world);
    assert!(world.has_research(0, "research_weapons"));
    assert!(!world.has_research(0, "research_armor"));
    pass(&mut world);
    assert!(world.has_research(0, "research_armor"));
    assert_eq!(world.research_level(0, "research_weapons"), 1);
    pass(&mut world);
    assert!(world.has_research(0, "research_logistics"));
    // Level 2 needs tier 2, which needs a factory: nothing more to buy.
    let held = world.research[&0].len();
    pass(&mut world);
    assert_eq!(world.research[&0].len(), held);
    // With a factory the next pass buys tier 2.
    building(&mut world, "factory");
    pass(&mut world);
    assert_eq!(world.tier(0), 2);
}

#[test]
fn auto_research_waits_for_the_money() {
    let mut world = arena();
    building(&mut world, "barracks");
    world.balances.insert(0, Balance::new(149, 0));
    world.doctrines.insert(
        0,
        Doctrine {
            auto_research: true,
            ..Doctrine::default()
        },
    );
    pass(&mut world);
    assert!(world.research.get(&0).is_none_or(Vec::is_empty));
    world.balances.insert(0, Balance::new(150, 0));
    pass(&mut world);
    assert!(world.has_research(0, "research_weapons"));
}

#[test]
fn commands_set_and_clear_the_doctrine() {
    let mut world = arena();
    let hq = world.units[0].id;
    let run = |world: &mut World, kind: &str, x: f32| {
        world.execute_on(&command(0, hq, kind, x), default_map())
    };
    run(&mut world, "doctrine_train", 1.0).unwrap();
    run(&mut world, "doctrine_tier", 1.0).unwrap();
    run(&mut world, "doctrine_research", 1.0).unwrap();
    run(&mut world, "doctrine_build", 1.0).unwrap();
    run(&mut world, "doctrine_reserve", 250.0).unwrap();
    run(&mut world, "doctrine_weight_scout", 0.0).unwrap();
    run(&mut world, "doctrine_weight_soldier", 5.0).unwrap();
    let doctrine = world.doctrine_of(0);
    assert!(doctrine.enabled && doctrine.auto_tier && doctrine.auto_research);
    assert!(doctrine.auto_build);
    assert_eq!(doctrine.reserve, 250);
    assert_eq!(doctrine.weight("scout"), 0);
    assert_eq!(doctrine.weight("soldier"), 5, "the default is not stored");
    assert_eq!(doctrine.weights.len(), 1);
    for (kind, x) in [
        ("doctrine_train", 0.0),
        ("doctrine_tier", 0.0),
        ("doctrine_research", 0.0),
        ("doctrine_build", 0.0),
        ("doctrine_reserve", 0.0),
        ("doctrine_weight_scout", 5.0),
    ] {
        run(&mut world, kind, x).unwrap();
    }
    assert!(world.doctrines.is_empty(), "back to default means no entry");
}

#[test]
fn commands_are_validated() {
    let world = arena();
    let hq = world.units[0].id;
    let foreign = world.units[1].id;
    let check = |kind: &str, x: f32| world.validate(&command(0, hq, kind, x));
    assert!(check("doctrine_train", 2.0).is_err());
    assert!(check("doctrine_train", f32::NAN).is_err());
    assert!(check("doctrine_reserve", 2001.0).is_err());
    assert!(check("doctrine_reserve", -1.0).is_err());
    assert!(check("doctrine_reserve", 2000.0).is_ok());
    assert!(check("doctrine_weight_soldier", 11.0).is_err());
    assert!(check("doctrine_weight_soldier", 2.5).is_err());
    assert!(check("doctrine_weight_soldier", 10.0).is_ok());
    assert!(
        check("doctrine_weight_sentinel", 3.0).is_err(),
        "another faction's kind"
    );
    assert!(
        check("doctrine_weight_hq", 3.0).is_err(),
        "not an army kind"
    );
    assert!(check("doctrine_bogus", 1.0).is_err());
    // Only the owner's own unit may issue it, and it cannot be queued.
    assert!(world
        .validate(&command(0, foreign, "doctrine_train", 1.0))
        .is_err());
    let mut queued = command(0, hq, "doctrine_train", 1.0);
    queued.queued = true;
    assert!(world.validate(&queued).is_err());
}

#[test]
fn stepping_runs_the_pass_on_its_interval() {
    let mut world = arena();
    let barracks = building(&mut world, "barracks");
    world.tick = 0;
    world.doctrines.insert(0, on());
    for _ in 0..DOCTRINE_INTERVAL_TICKS - 1 {
        world.step();
    }
    assert!(queued(&world, barracks).is_empty(), "not before tick 20");
    world.step();
    assert_eq!(world.tick, DOCTRINE_INTERVAL_TICKS);
    assert_eq!(queued(&world, barracks).len(), 1);
}

fn count(world: &World, kind: &str) -> usize {
    world
        .units
        .iter()
        .filter(|unit| unit.owner == 0 && unit.kind == kind)
        .count()
}

fn auto_build() -> Doctrine {
    Doctrine {
        auto_build: true,
        ..Doctrine::default()
    }
}

#[test]
fn auto_build_is_off_by_default() {
    let mut world = arena();
    building(&mut world, "barracks");
    world.balances.insert(0, Balance::new(5000, 5000));
    let before = world.units.len();
    world.doctrines.insert(0, on());
    pass(&mut world);
    assert_eq!(world.units.len(), before, "training alone builds nothing");
}

#[test]
fn auto_build_follows_the_weight_formula() {
    let mut world = arena();
    building(&mut world, "barracks");
    world.doctrines.insert(0, auto_build());
    pass(&mut world);
    // Default weights: barracks 4 kinds (2 barracks buildings' worth: (1+1)/20),
    // factory 2 kinds ((0+1)/10). 0.1 vs 0.1 is a tie, which goes to barracks.
    assert_eq!(count(&world, "barracks"), 2);
    assert_eq!(count(&world, "factory"), 0);
    // Finish it; now barracks scores 3/20 against factory 1/10: factory.
    for unit in world.units.iter_mut() {
        unit.construction_remaining = 0;
    }
    pass(&mut world);
    assert_eq!(count(&world, "factory"), 1);
}

#[test]
fn auto_build_waits_for_unfinished_production_buildings() {
    let mut world = arena();
    let barracks = building(&mut world, "barracks");
    world
        .units
        .iter_mut()
        .find(|unit| unit.id == barracks)
        .unwrap()
        .construction_remaining = 50;
    world.doctrines.insert(0, auto_build());
    let before = world.units.len();
    pass(&mut world);
    assert_eq!(world.units.len(), before);
}

#[test]
fn auto_build_ignores_buildings_with_no_wanted_units() {
    let mut world = arena();
    building(&mut world, "barracks");
    let mut doctrine = auto_build();
    for kind in ["crusher", "siege", "bulwark"] {
        doctrine.weights.insert(kind.into(), 0);
    }
    world.doctrines.insert(0, doctrine);
    for _ in 0..3 {
        pass(&mut world);
        for unit in world.units.iter_mut() {
            unit.construction_remaining = 0;
        }
    }
    assert_eq!(count(&world, "factory"), 0, "factory kinds weigh nothing");
    assert_eq!(count(&world, "barracks"), 4);
}

#[test]
fn auto_build_raises_a_synthesizer_when_material_floats() {
    let mut world = arena();
    building(&mut world, "barracks");
    world.research.insert(0, vec!["tier_1".into(), "tier_2".into()]);
    world.balances.insert(0, Balance::new(2000, 100));
    world.doctrines.insert(0, auto_build());
    assert_eq!(world.tier(0), 2);
    // Tier 3 needs a laboratory, which comes first.
    pass(&mut world);
    assert_eq!(count(&world, "lab"), 1);
    assert_eq!(count(&world, "synthesizer"), 0);
    for unit in world.units.iter_mut() {
        unit.construction_remaining = 0;
    }
    world.balances.insert(0, Balance::new(2000, 100));
    pass(&mut world);
    assert_eq!(count(&world, "synthesizer"), 1);
    assert_eq!(count(&world, "barracks"), 1);
    // Tier 1 is not enough.
    let mut low = arena();
    low.research.insert(0, vec!["tier_1".into()]);
    low.balances.insert(0, Balance::new(2000, 100));
    low.doctrines.insert(0, auto_build());
    pass(&mut low);
    assert_eq!(count(&low, "synthesizer"), 0);
}

#[test]
fn auto_build_sites_clear_nodes_and_within_reach() {
    let mut world = arena();
    building(&mut world, "barracks");
    world.doctrines.insert(0, auto_build());
    pass(&mut world);
    let placed = world.units.last().unwrap();
    assert_eq!(placed.kind, "barracks");
    assert!(placed.construction_remaining > 0);
    assert!(!world.nodes.is_empty());
    for node in &world.nodes {
        assert!((node.x - placed.x).hypot(node.y - placed.y) >= AUTO_BUILD_NODE_CLEARANCE);
    }
    assert!((HQ.0 - placed.x).hypot(HQ.1 - placed.y) <= crate::BUILD_RADIUS);
}

#[test]
fn auto_build_raises_the_building_the_next_tier_needs_even_when_catalyst_is_short() {
    let mut world = arena();
    building(&mut world, "barracks");
    world.research.insert(0, vec!["tier_1".into()]);
    world.balances.insert(0, Balance::new(2000, 0));
    world.doctrines.insert(0, auto_build());
    pass(&mut world);
    assert_eq!(count(&world, "factory"), 1, "tier 2 needs a factory");
}

#[test]
fn auto_build_claims_a_free_catalyst_deposit_beside_a_hub_first() {
    let mut world = arena();
    let deposit = world
        .nodes
        .iter()
        .find(|node| node.kind == ResourceKind::Catalyst)
        .map(|node| (node.x, node.y))
        .expect("the default map has catalyst");
    world.spawn(0, "outpost", deposit.0 + 250.0, deposit.1);
    world.research.insert(0, vec!["tier_1".into()]);
    world.doctrines.insert(0, auto_build());
    pass(&mut world);
    assert_eq!(count(&world, "refinery"), 1, "the refinery comes before the factory");
    assert_eq!(count(&world, "factory"), 0);
    let refinery = world.units.iter().find(|unit| unit.kind == "refinery").unwrap();
    assert!(world.nodes.iter().any(|node| node.kind == ResourceKind::Catalyst
        && (node.x - refinery.x).hypot(node.y - refinery.y) <= 60.0));
    // Off: nothing claimed.
    let mut off = arena();
    off.spawn(0, "outpost", deposit.0 + 250.0, deposit.1);
    pass(&mut off);
    assert_eq!(count(&off, "refinery"), 0);
}
