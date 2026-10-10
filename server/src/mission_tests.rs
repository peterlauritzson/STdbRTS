//! Tests for `crate::mission`: recruitment, release, shrink and cancel, the
//! gather state machine, the default rally and command validation.

use super::*;
use crate::maps::default_map;
use crate::simulation::Entity;
use crate::Faction;

const POINT: (f32, f32) = (1100.0, 520.0);
const HQ: (f32, f32) = (200.0, 1300.0);

/// Tick 1000 is a mission-pass tick.
fn arena() -> World {
    let mut world = World::new_on_with_factions(
        default_map(),
        &[(0, Faction::Industrial), (1, Faction::Industrial)],
    );
    world.units.clear();
    world.spawn(0, "hq", HQ.0, HQ.1);
    world.spawn(1, "hq", 1400.0, 1400.0);
    world.tick = 1000;
    world
}

fn soldier(world: &mut World, at: (f32, f32)) -> u32 {
    world.spawn(0, "soldier", at.0, at.1);
    world.units.last().unwrap().id
}

fn unit(world: &World, id: u32) -> &Entity {
    world.units.iter().find(|unit| unit.id == id).unwrap()
}

fn command(owner: u8, units: Vec<u32>, kind: &str, at: (f32, f32), target: u32) -> Command {
    Command {
        id: 1,
        owner,
        units,
        order: Order {
            kind: kind.into(),
            x: at.0,
            y: at.1,
            target,
        },
        queued: false,
        execute_tick: 0,
        status: "scheduled".into(),
        reason: String::new(),
    }
}

fn hq(world: &World) -> u32 {
    world
        .units
        .iter()
        .find(|unit| unit.owner == 0 && unit.kind == "hq")
        .unwrap()
        .id
}

fn run(
    world: &mut World,
    units: Vec<u32>,
    kind: &str,
    at: (f32, f32),
    target: u32,
) -> Result<(), String> {
    let command = command(0, units, kind, at, target);
    world.execute_on(&command, default_map())
}

/// Creates a mission, with the HQ as the issuer when nobody is selected.
fn create(world: &mut World, tactic: &str, at: (f32, f32), selected: Vec<u32>) -> u32 {
    let issuer = if selected.is_empty() {
        vec![hq(world)]
    } else {
        selected
    };
    run(world, issuer, &format!("mission_new_{tactic}"), at, 0).unwrap();
    world.missions.last().unwrap().id
}

fn mission(world: &World, id: u32) -> &Mission {
    world
        .missions
        .iter()
        .find(|mission| mission.id == id)
        .unwrap()
}

fn set_size(world: &mut World, id: u32, size: f32) {
    let issuer = hq(world);
    run(world, vec![issuer], "mission_size", (size, 0.0), id).unwrap();
}

fn members(world: &World, id: u32) -> Vec<u32> {
    let mut members = mission(world, id).members.clone();
    members.sort_unstable();
    members
}

fn is_idle(world: &World, id: u32) -> bool {
    let unit = unit(world, id);
    unit.behavior.is_none() && unit.order.kind == "stop"
}

fn line(world: &mut World, count: usize, from: (f32, f32), gap: f32) -> Vec<u32> {
    (0..count)
        .map(|i| soldier(world, (from.0 + gap * i as f32, from.1)))
        .collect()
}

#[test]
fn sized_missions_recruit_nearest_first_in_id_order_and_rest_takes_the_remainder() {
    let mut world = arena();
    let near = line(&mut world, 6, POINT, 30.0);
    // Harass (default size 4) is first: the four nearest to its point.
    let harass = create(&mut world, "harass", POINT, vec![]);
    assert_eq!(mission(&world, harass).size, 4);
    assert_eq!(members(&world, harass), near[..4].to_vec());
    // Raid (rest) then takes what is left.
    let raid = create(&mut world, "raid", (POINT.0 + 400.0, POINT.1), vec![]);
    assert_eq!(mission(&world, raid).size, REST);
    assert_eq!(members(&world, raid), near[4..].to_vec());
    assert_eq!(
        unit(&world, near[0]).behavior.as_ref().unwrap().preset,
        "harass"
    );
    assert_eq!(
        unit(&world, near[5]).behavior.as_ref().unwrap().preset,
        "raid"
    );
    // A unit is in at most one mission.
    assert!(members(&world, harass)
        .iter()
        .all(|id| !members(&world, raid).contains(id)));
}

#[test]
fn rest_missions_split_the_remainder_and_a_later_sized_mission_peels_a_rest_one() {
    let mut world = arena();
    let units = line(&mut world, 5, POINT, 40.0);
    let left = create(&mut world, "raid", (POINT.0 - 200.0, POINT.1), vec![]);
    // The only rest mission took all five.
    assert_eq!(members(&world, left).len(), 5);
    let right = create(&mut world, "rush", (POINT.0 - 600.0, POINT.1), vec![]);
    assert!(mission(&world, right).members.is_empty());
    // One new idle unit: ceil(1 / 2) = 1 goes to the first rest mission in id order.
    let extra = soldier(&mut world, (POINT.0 + 500.0, POINT.1));
    world.run_missions(default_map());
    assert!(mission(&world, left).members.contains(&extra));
    // Two more: the first rest mission takes one, the second the other.
    let more = line(&mut world, 2, (POINT.0 + 300.0, POINT.1 + 100.0), 10.0);
    world.run_missions(default_map());
    assert_eq!(
        members(&world, left).len(),
        7,
        "{:?}",
        members(&world, left)
    );
    assert_eq!(members(&world, right), vec![more[1]]);
    // A Guard placed now peels the nearest members off the rest missions.
    let guard = create(&mut world, "guard", (POINT.0 + 100.0, POINT.1), vec![]);
    assert_eq!(mission(&world, guard).size, 6);
    assert_eq!(members(&world, guard).len(), 6);
    assert!(units
        .iter()
        .take(4)
        .all(|id| mission(&world, guard).members.contains(id)));
}

#[test]
fn a_player_command_releases_the_unit_at_once_and_the_pass_does_not_take_it_back() {
    let mut world = arena();
    let units = line(&mut world, 3, POINT, 30.0);
    let id = create(&mut world, "raid", POINT, vec![]);
    assert_eq!(members(&world, id).len(), 3);
    run(
        &mut world,
        vec![units[1]],
        "move",
        (POINT.0, POINT.1 + 200.0),
        0,
    )
    .unwrap();
    assert_eq!(members(&world, id), vec![units[0], units[2]]);
    assert!(unit(&world, units[1]).behavior.is_none());
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert!(
        !mission(&world, id).members.contains(&units[1]),
        "moving, so not idle"
    );
    // Another behavior releases too.
    run(&mut world, vec![units[0]], "harass", POINT, 0).unwrap();
    assert_eq!(members(&world, id), vec![units[2]]);
    // The pass's own assignments never release: the third is kept.
    world.run_missions(default_map());
    assert_eq!(members(&world, id), vec![units[2]]);
}

#[test]
fn the_pass_does_not_reset_a_path_that_already_matches() {
    let mut world = arena();
    let id = soldier(&mut world, POINT);
    create(&mut world, "guard", (POINT.0 + 300.0, POINT.1), vec![id]);
    let before = unit(&world, id).behavior.clone().unwrap();
    world.tick += 40;
    world.run_missions(default_map());
    assert_eq!(unit(&world, id).behavior.as_ref().unwrap(), &before);
}

#[test]
fn dead_members_drop_out() {
    let mut world = arena();
    let units = line(&mut world, 3, POINT, 30.0);
    let id = create(&mut world, "raid", POINT, vec![]);
    world.units.retain(|unit| unit.id != units[0]);
    world.run_missions(default_map());
    assert_eq!(members(&world, id), vec![units[1], units[2]]);
}

#[test]
fn shrinking_stops_the_farthest_extras_and_cancel_stops_everyone() {
    let mut world = arena();
    let units = line(&mut world, 4, POINT, 100.0);
    let id = create(&mut world, "harass", POINT, vec![]);
    assert_eq!(members(&world, id).len(), 4);
    set_size(&mut world, id, 2.0);
    assert_eq!(mission(&world, id).size, 2);
    assert_eq!(members(&world, id), units[..2].to_vec());
    for extra in &units[2..] {
        assert!(is_idle(&world, *extra), "{extra} stopped and free");
    }
    // A rest mission placed afterwards takes the freed units.
    let rest = create(&mut world, "raid", (POINT.0 - 500.0, POINT.1), vec![]);
    assert_eq!(members(&world, rest), units[2..].to_vec());
    // Cancel releases and stops the members; the rest mission then takes them.
    let issuer = hq(&world);
    run(&mut world, vec![issuer], "mission_cancel", (0.0, 0.0), id).unwrap();
    assert!(world.missions.iter().all(|mission| mission.id != id));
    assert_eq!(members(&world, rest).len(), 4);
    run(&mut world, vec![issuer], "mission_cancel", (0.0, 0.0), rest).unwrap();
    assert!(world.missions.is_empty());
    assert!(units.iter().all(|id| is_idle(&world, *id)));
}

#[test]
fn assault_is_what_a_rush_runs() {
    let mut world = arena();
    let id = soldier(&mut world, POINT);
    create(&mut world, "rush", (POINT.0 + 300.0, POINT.1), vec![id]);
    let running = unit(&world, id).behavior.as_ref().unwrap();
    assert_eq!(running.preset, "assault");
    assert_eq!((running.goal_x, running.goal_y), (POINT.0 + 300.0, POINT.1));
    assert_eq!(unit(&world, id).order.kind, "attack_move");
}

#[test]
fn the_default_rally_is_sixty_five_percent_of_the_way_from_the_nearest_hub() {
    let mut world = arena();
    let id = create(&mut world, "gather", POINT, vec![]);
    let rally = mission(&world, id);
    let expected = (
        HQ.0 + (POINT.0 - HQ.0) * 0.65,
        HQ.1 + (POINT.1 - HQ.1) * 0.65,
    );
    assert!(
        distance(rally.rally_x, rally.rally_y, expected.0, expected.1) < 120.0,
        "{:?}",
        (rally.rally_x, rally.rally_y)
    );
    assert_eq!((rally.gather_percent, rally.fallback_percent), (80, 40));
    assert_eq!(rally.state, STATE_GATHER);
    // A nearer finished hub wins over the HQ.
    world.spawn(0, "outpost", 900.0, 700.0);
    world.units.last_mut().unwrap().construction_remaining = 0;
    let near = create(&mut world, "gather", POINT, vec![]);
    let rally = mission(&world, near);
    let expected = (
        900.0 + (POINT.0 - 900.0) * 0.65,
        700.0 + (POINT.1 - 700.0) * 0.65,
    );
    assert!(distance(rally.rally_x, rally.rally_y, expected.0, expected.1) < 120.0);
}

#[test]
fn strike_needs_the_gathered_share_of_the_target_size() {
    let sample = |size: i32, members: usize, percent: u8| Mission {
        id: 1,
        owner: 0,
        tactic: "gather".into(),
        x: 0.0,
        y: 0.0,
        size,
        state: String::new(),
        state_tick: 0,
        rally_x: 0.0,
        rally_y: 0.0,
        gather_percent: percent,
        fallback_percent: 40,
        strike_strength: 0,
        members: (0..members as u32).collect(),
    };
    // Size 5 at 80% needs 4.
    assert!(!ready_to_strike(&sample(5, 5, 80), 3));
    assert!(ready_to_strike(&sample(5, 5, 80), 4));
    // Rest needs eight present, and the share of current members.
    assert!(!ready_to_strike(&sample(REST, 7, 10), 7));
    assert!(ready_to_strike(&sample(REST, 10, 80), 8));
    assert!(!ready_to_strike(&sample(REST, 11, 80), 8));
}

#[test]
fn gather_strikes_falls_back_and_gathers_again() {
    let mut world = arena();
    let id = create(&mut world, "gather", POINT, vec![]);
    let rally = (mission(&world, id).rally_x, mission(&world, id).rally_y);
    // Seven are at the rally: not yet eight.
    let mut units = line(&mut world, 7, rally, 20.0);
    world.run_missions(default_map());
    assert_eq!(members(&world, id).len(), 7);
    assert_eq!(mission(&world, id).state, STATE_GATHER);
    let running = unit(&world, units[0]).behavior.as_ref().unwrap();
    assert_eq!(running.preset, "guard");
    assert_eq!((running.goal_x, running.goal_y), rally);
    // The eighth arrives: strike with everyone, assaulting the point.
    units.push(soldier(&mut world, (rally.0 + 150.0, rally.1)));
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_STRIKE);
    assert_eq!(mission(&world, id).strike_strength, 8);
    for unit_id in &units {
        let running = unit(&world, *unit_id).behavior.as_ref().unwrap();
        assert_eq!(running.preset, "assault");
        assert_eq!((running.goal_x, running.goal_y), POINT);
    }
    // Losses down to 3 of 8 (under 40%): fall back to the rally.
    world.units.retain(|unit| !units[3..].contains(&unit.id));
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_FALLBACK);
    let running = unit(&world, units[0]).behavior.as_ref().unwrap();
    assert_eq!(
        (running.preset.as_str(), (running.goal_x, running.goal_y)),
        ("guard", rally)
    );
    // They are at the rally already, so the next pass regroups.
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_GATHER);
    assert_eq!(mission(&world, id).strike_strength, 0);
    // Too few to strike again.
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_GATHER);
}

#[test]
fn a_fall_back_that_cannot_regroup_ends_after_the_limit() {
    let mut world = arena();
    let id = create(&mut world, "gather", POINT, vec![]);
    let far = soldier(&mut world, POINT);
    run(&mut world, vec![far], "mission_assign", (0.0, 0.0), id).unwrap();
    world.missions[0].state = STATE_FALLBACK.into();
    world.missions[0].state_tick = world.tick;
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(
        mission(&world, id).state,
        STATE_FALLBACK,
        "far from the rally and not yet timed out"
    );
    world.tick += FALLBACK_REGROUP_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_GATHER);
}

#[test]
fn tactic_and_knob_commands_change_the_mission_and_clamp() {
    let mut world = arena();
    let id = create(&mut world, "raid", POINT, vec![]);
    let issuer = hq(&world);
    run(
        &mut world,
        vec![issuer],
        "mission_tactic_gather",
        (0.0, 0.0),
        id,
    )
    .unwrap();
    assert_eq!(mission(&world, id).tactic, "gather");
    assert_eq!(mission(&world, id).state, STATE_GATHER);
    run(&mut world, vec![issuer], "mission_gather", (3.0, 0.0), id).unwrap();
    run(
        &mut world,
        vec![issuer],
        "mission_fallback",
        (250.0, 0.0),
        id,
    )
    .unwrap();
    assert_eq!(
        (
            mission(&world, id).gather_percent,
            mission(&world, id).fallback_percent
        ),
        (10, 100)
    );
    run(
        &mut world,
        vec![issuer],
        "mission_rally",
        (600.0, 600.0),
        id,
    )
    .unwrap();
    assert_eq!(
        (mission(&world, id).rally_x, mission(&world, id).rally_y),
        (600.0, 600.0)
    );
    set_size(&mut world, id, 500.0);
    assert_eq!(mission(&world, id).size, MAX_MISSION_SIZE);
    set_size(&mut world, id, -1.0);
    assert_eq!(mission(&world, id).size, REST);
    run(
        &mut world,
        vec![issuer],
        "mission_tactic_harass",
        (0.0, 0.0),
        id,
    )
    .unwrap();
    assert_eq!(mission(&world, id).state, "");
}

#[test]
fn assigning_replaces_the_old_membership_and_grows_a_numeric_size() {
    let mut world = arena();
    let units = line(&mut world, 3, POINT, 30.0);
    let rest = create(&mut world, "raid", POINT, vec![]);
    let guard = create(&mut world, "guard", (POINT.0 - 500.0, POINT.1), vec![]);
    // The guard (size 6) peeled all three off the rest mission; shrink it to
    // one and the freed two go back to the rest mission.
    assert_eq!(members(&world, guard).len(), 3);
    assert!(members(&world, rest).is_empty());
    set_size(&mut world, guard, 1.0);
    assert_eq!(members(&world, guard).len(), 1);
    assert_eq!(members(&world, rest).len(), 2);
    // Assigning all three: they leave the rest mission and the size grows.
    run(
        &mut world,
        units.clone(),
        "mission_assign",
        (0.0, 0.0),
        guard,
    )
    .unwrap();
    assert_eq!(mission(&world, guard).size, 3);
    assert_eq!(members(&world, guard), units);
}

#[test]
fn mission_commands_are_validated() {
    let mut world = arena();
    let issuer = hq(&world);
    let check =
        |world: &World, owner: u8, units: Vec<u32>, kind: &str, at: (f32, f32), target: u32| {
            world.validate_on(&command(owner, units, kind, at, target), default_map())
        };
    assert!(check(&world, 0, vec![issuer], "mission_new_rush", POINT, 0).is_ok());
    assert!(check(&world, 0, vec![issuer], "mission_new_bogus", POINT, 0).is_err());
    assert!(check(&world, 0, vec![issuer], "mission_bogus", POINT, 0).is_err());
    assert!(
        check(&world, 0, vec![issuer], "mission_new_rush", (-5.0, 10.0), 0).is_err(),
        "off the map"
    );
    assert!(
        check(&world, 0, vec![issuer], "mission_new_rush", HQ, 0).is_err(),
        "inside the HQ"
    );
    let mut queued = command(0, vec![issuer], "mission_new_rush", POINT, 0);
    queued.queued = true;
    assert!(world.validate_on(&queued, default_map()).is_err());
    // Another player's unit as issuer.
    let enemy = world.units.iter().find(|unit| unit.owner == 1).unwrap().id;
    assert!(check(&world, 0, vec![enemy], "mission_new_rush", POINT, 0).is_err());
    // Mission targets: missing, and someone else's.
    assert!(check(&world, 0, vec![issuer], "mission_cancel", POINT, 9).is_err());
    let id = create(&mut world, "guard", POINT, vec![]);
    assert!(check(&world, 0, vec![issuer], "mission_cancel", POINT, id).is_ok());
    assert!(
        check(&world, 1, vec![enemy], "mission_cancel", POINT, id).is_err(),
        "owner-only"
    );
    assert!(check(&world, 1, vec![enemy], "mission_size", (3.0, 0.0), id).is_err());
    assert!(check(&world, 0, vec![issuer], "mission_size", (f32::NAN, 0.0), id).is_err());
    assert!(check(&world, 0, vec![issuer], "mission_rally", (-1.0, 0.0), id).is_err());
    // Assign needs army units.
    assert!(check(&world, 0, vec![issuer], "mission_assign", POINT, id).is_err());
    let mate = soldier(&mut world, (POINT.0 + 50.0, POINT.1));
    assert!(check(&world, 0, vec![mate], "mission_assign", POINT, id).is_ok());
    // The per-player limit; another player is not counted against it.
    for _ in 1..MAX_MISSIONS {
        create(&mut world, "rush", POINT, vec![]);
    }
    assert_eq!(
        world
            .missions
            .iter()
            .filter(|mission| mission.owner == 0)
            .count(),
        MAX_MISSIONS
    );
    assert!(check(&world, 0, vec![issuer], "mission_new_rush", POINT, 0).is_err());
    assert!(check(&world, 1, vec![enemy], "mission_new_rush", POINT, 0).is_ok());
}

#[test]
fn the_step_loop_runs_the_pass_every_second() {
    let mut world = arena();
    let units = line(&mut world, 2, POINT, 30.0);
    let id = create(&mut world, "harass", POINT, vec![]);
    // A unit that shows up later is recruited by the step loop's own pass.
    let late = soldier(&mut world, (POINT.0 + 200.0, POINT.1));
    for _ in 0..40 {
        world.step();
    }
    assert_eq!(members(&world, id).len(), 3);
    assert!(members(&world, id).contains(&late));
    assert!(units.iter().all(|u| members(&world, id).contains(u)));
}

#[test]
fn a_running_strike_holds_late_recruits_at_the_rally_and_sends_them_as_a_wave() {
    let mut world = arena();
    let id = create(&mut world, "gather", POINT, vec![]);
    let rally = (mission(&world, id).rally_x, mission(&world, id).rally_y);
    let first = line(&mut world, 8, rally, 20.0);
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_STRIKE);
    // A recruit trained at home during the strike waits at the rally instead
    // of walking into the fight alone.
    let late = soldier(&mut world, (HQ.0 + 100.0, HQ.1));
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert!(members(&world, id).contains(&late));
    let running = unit(&world, late).behavior.as_ref().unwrap();
    assert_eq!(
        (running.preset.as_str(), (running.goal_x, running.goal_y)),
        ("guard", rally)
    );
    // The strikers keep striking.
    assert_eq!(
        unit(&world, first[0]).behavior.as_ref().unwrap().preset,
        "assault"
    );
    // It reaches the rally and three more join there: four waiting is a wave.
    let mut wave = line(&mut world, 3, rally, 20.0);
    if let Some(unit) = world.units.iter_mut().find(|unit| unit.id == late) {
        (unit.x, unit.y) = (rally.0 + 60.0, rally.1);
    }
    wave.push(late);
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).strike_strength, 12);
    for unit_id in &wave {
        assert_eq!(
            unit(&world, *unit_id).behavior.as_ref().unwrap().preset,
            "assault"
        );
    }
}

#[test]
fn strikers_alone_decide_the_fall_back() {
    let mut world = arena();
    let id = create(&mut world, "gather", POINT, vec![]);
    let rally = (mission(&world, id).rally_x, mission(&world, id).rally_y);
    let first = line(&mut world, 8, rally, 20.0);
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_STRIKE);
    // Three recruits far from the rally: not a wave, and not strikers.
    for _ in 0..3 {
        soldier(&mut world, (HQ.0 + 100.0, HQ.1));
    }
    world.units.retain(|unit| !first[2..].contains(&unit.id));
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(members(&world, id).len(), 5);
    assert_eq!(mission(&world, id).state, STATE_FALLBACK);
}

#[test]
fn the_gathered_radius_grows_with_the_group() {
    assert_eq!(gather_radius(0), RALLY_RADIUS);
    assert_eq!(gather_radius(8), RALLY_RADIUS);
    assert!(
        gather_radius(41) > 440.0,
        "forty units cannot stand within 250"
    );
}

#[test]
fn a_big_gathered_army_strikes_even_when_spread_past_the_small_radius() {
    let mut world = arena();
    let id = create(&mut world, "gather", POINT, vec![]);
    let rally = (mission(&world, id).rally_x, mission(&world, id).rally_y);
    // Forty in a loose block around the rally, many beyond 250 of it.
    let mut units = vec![];
    for row in 0..5 {
        let y = rally.1 - 160.0 + row as f32 * 80.0;
        units.extend(line(&mut world, 8, (rally.0 - 300.0, y), 80.0));
    }
    world.run_missions(default_map());
    assert_eq!(members(&world, id).len(), 40);
    assert_eq!(mission(&world, id).state, STATE_STRIKE);
}

#[test]
fn a_gathering_army_defends_a_threatened_building_then_gathers_again() {
    let mut world = arena();
    let id = create(&mut world, "gather", POINT, vec![]);
    let rally = (mission(&world, id).rally_x, mission(&world, id).rally_y);
    let mine = line(&mut world, 3, rally, 20.0);
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_GATHER);
    // Two raiders at the HQ are left to Guard missions and defenses...
    for offset in [0.0, 30.0] {
        world.spawn(1, "soldier", HQ.0 + 200.0 + offset, HQ.1);
    }
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_GATHER);
    // ...a third makes it an attack: the army attack-moves to the HQ.
    world.spawn(1, "soldier", HQ.0 + 260.0, HQ.1);
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_DEFEND);
    let running = unit(&world, mine[0]).behavior.as_ref().unwrap();
    assert_eq!(
        (running.preset.as_str(), (running.goal_x, running.goal_y)),
        ("assault", HQ)
    );
    // The attackers die: back to the rally.
    world
        .units
        .retain(|unit| unit.owner != 1 || unit.kind != "soldier");
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_GATHER);
    let running = unit(&world, mine[0]).behavior.as_ref().unwrap();
    assert_eq!(
        (running.preset.as_str(), (running.goal_x, running.goal_y)),
        ("guard", rally)
    );
}

#[test]
fn a_running_strike_does_not_turn_back_to_defend() {
    let mut world = arena();
    let id = create(&mut world, "gather", POINT, vec![]);
    let rally = (mission(&world, id).rally_x, mission(&world, id).rally_y);
    line(&mut world, 8, rally, 20.0);
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_STRIKE);
    for offset in [0.0, 30.0, 60.0] {
        world.spawn(1, "soldier", HQ.0 + 200.0 + offset, HQ.1);
    }
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_STRIKE);
}

#[test]
fn after_a_defence_the_group_settles_before_it_strikes() {
    let mut world = arena();
    let id = create(&mut world, "gather", POINT, vec![]);
    let rally = (mission(&world, id).rally_x, mission(&world, id).rally_y);
    line(&mut world, 8, rally, 20.0);
    world.missions[0].state = STATE_DEFEND.into();
    // No threat: back to gathering, but not straight into a strike.
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_GATHER);
    world.tick += MISSION_INTERVAL_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_GATHER, "eight gathered, but still settling");
    world.tick += DEFEND_SETTLE_TICKS;
    world.run_missions(default_map());
    assert_eq!(mission(&world, id).state, STATE_STRIKE);
}
