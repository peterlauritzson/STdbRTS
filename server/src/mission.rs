//! Missions: standing, map-anchored objectives the server keeps staffed.
//!
//! A mission is a row of the world (`World::missions`): an owner, a point on the
//! map, a tactic, a size (a number of units, or "rest" = whatever is left) and
//! the ids of its members. Every [`MISSION_INTERVAL_TICKS`] the simulation runs
//! one bounded pass over them, in id order:
//!
//! 1. dead members drop out;
//! 2. a mission whose size shrank gives up its farthest extras (stopped);
//! 3. idle army units are recruited, nearest first, into the sized missions in
//!    id order, then the "rest" missions split what is left;
//! 4. the Gather-then-strike group state machine advances;
//! 5. every member is handed the preset and goal its mission wants, through
//!    `activate_behavior`, and only when it differs, so a path is never reset
//!    just because a pass ran.
//!
//! During a strike, a unit recruited after the strike began does not trickle
//! into the fight alone: it waits at the rally, and the waiting units go in as
//! a wave once enough of them are gathered there. Who is striking needs no
//! extra state: it is the members running the assault preset.
//!
//! A member leaves its mission the moment a *player* command executes on it
//! (`World::release_from_missions`, called from the command path). The pass's
//! own assignments never go through that path, so they never release anyone.
//!
//! Commands (`mission_*`) go through the ordinary delayed command path and are
//! validated on receipt and again on activation. Every number here is
//! **experimental**.
//! See `docs/honeybadger/STRATEGY-LAYERS.md`, "Layer 2: mission tactics".

use crate::behavior;
use crate::navigation::Navigation;
use crate::simulation::{Command, Order, World};
use crate::{distance, is_army, is_building, is_hub, validate_position, MAX_UNITS};
use std::collections::BTreeSet;

/// How often, in ticks, the mission pass runs (once a second).
pub const MISSION_INTERVAL_TICKS: u64 = 20;
/// The most missions one player may hold.
pub const MAX_MISSIONS: usize = 16;
/// The largest numeric size.
pub const MAX_MISSION_SIZE: i32 = 99;
/// The `size` of a mission that takes whatever is left.
pub const REST: i32 = -1;
/// A member this close to the rally point counts as gathered, for a small
/// group. A big group cannot stand inside it, so the radius grows with the
/// square root of the members (see [`gather_radius`]).
pub const RALLY_RADIUS: f32 = 250.0;
pub const RALLY_RADIUS_PER_ROOT: f32 = 70.0;
/// Enemy army this close to one of the owner's buildings is a threat to it.
pub const THREAT_RADIUS: f32 = 600.0;
/// A gathering mission turns to defend once this many enemy army units
/// threaten one building; fewer is left to Guard missions and defenses.
pub const THREAT_MINIMUM: usize = 3;
/// The default rally sits this far along the way from the nearest hub to the point.
pub const RALLY_FRACTION: f32 = 0.65;
pub const DEFAULT_GATHER_PERCENT: u8 = 80;
pub const DEFAULT_FALLBACK_PERCENT: u8 = 40;
/// The knobs are clamped to this range.
pub const MIN_PERCENT: u8 = 10;
pub const MAX_PERCENT: u8 = 100;
/// A "rest" mission strikes only with at least this many gathered.
pub const REST_STRIKE_MINIMUM: usize = 8;
/// During a strike, reinforcements waiting at the rally go in together once at
/// least this many (a "rest" mission) are gathered.
pub const REST_WAVE_MINIMUM: usize = 4;
/// After a defence the group gathers for at least this long before it may
/// strike, so it does not leave the base the moment a raid thins out.
pub const DEFEND_SETTLE_TICKS: u64 = 300;
/// A fall back that has not regrouped by itself ends after this long.
pub const FALLBACK_REGROUP_TICKS: u64 = 400;

/// Every tactic, in the order a client lists them.
pub const TACTICS: [&str; 5] = ["harass", "guard", "raid", "rush", "gather"];

pub const STATE_GATHER: &str = "gather";
pub const STATE_STRIKE: &str = "strike";
pub const STATE_FALLBACK: &str = "fallback";
pub const STATE_DEFEND: &str = "defend";

/// The radius within which `members` units count as gathered at a rally.
pub fn gather_radius(members: usize) -> f32 {
    RALLY_RADIUS.max(RALLY_RADIUS_PER_ROOT * (members as f32).sqrt())
}

pub fn is_tactic(name: &str) -> bool {
    TACTICS.contains(&name)
}

/// The size a new mission of `tactic` starts with.
pub fn default_size(tactic: &str) -> i32 {
    match tactic {
        "harass" => 4,
        "guard" => 6,
        _ => REST,
    }
}

/// The per-unit preset a plain (non-gather) tactic runs.
fn plain_preset(tactic: &str) -> &'static str {
    match tactic {
        "harass" => "harass",
        "guard" => "guard",
        "raid" => "raid",
        _ => "assault",
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Mission {
    pub id: u32,
    pub owner: u8,
    pub tactic: String,
    pub x: f32,
    pub y: f32,
    /// A unit count, or [`REST`].
    pub size: i32,
    /// `gather`, `strike`, `fallback` or `defend` for the gather tactic, else
    /// empty.
    pub state: String,
    /// When the state began; on leaving a defence it is set
    /// [`DEFEND_SETTLE_TICKS`] ahead, and the group may not strike before it.
    pub state_tick: u64,
    pub rally_x: f32,
    pub rally_y: f32,
    pub gather_percent: u8,
    pub fallback_percent: u8,
    /// Members when the current strike began.
    pub strike_strength: u32,
    /// Living members, in the order they joined.
    pub members: Vec<u32>,
}

impl Mission {
    /// The preset and goal every member should be running now.
    pub fn wanted(&self) -> (&'static str, (f32, f32)) {
        if self.tactic == "gather" {
            if self.state == STATE_STRIKE {
                ("assault", (self.x, self.y))
            } else {
                // Gathering and falling back are both "stand at the rally":
                // the guard preset walks there, then holds it with a leash.
                ("guard", (self.rally_x, self.rally_y))
            }
        } else {
            (plain_preset(&self.tactic), (self.x, self.y))
        }
    }
}

/// Gathered members needed to strike, given the mission's size and members.
fn ready_to_strike(mission: &Mission, gathered: usize) -> bool {
    let percent = mission.gather_percent.clamp(MIN_PERCENT, MAX_PERCENT) as usize;
    if mission.size == REST {
        gathered >= REST_STRIKE_MINIMUM && gathered * 100 >= percent * mission.members.len()
    } else {
        let needed = (mission.size as usize * percent).div_ceil(100).max(1);
        gathered >= needed
    }
}

/// Waiting reinforcements needed to send a wave into a running strike: for a
/// "rest" mission [`REST_WAVE_MINIMUM`]; for a sized one, enough to bring the
/// strikers back up to the gathered share, and never fewer than a quarter of
/// the size.
fn wave_ready(mission: &Mission, strikers: usize, gathered_waiting: usize) -> bool {
    if gathered_waiting == 0 {
        return false;
    }
    if mission.size == REST {
        return gathered_waiting >= REST_WAVE_MINIMUM;
    }
    let size = mission.size.max(1) as usize;
    let percent = mission.gather_percent.clamp(MIN_PERCENT, MAX_PERCENT) as usize;
    let needed = (size * percent).div_ceil(100).max(1);
    gathered_waiting >= needed.saturating_sub(strikers).max(size.div_ceil(4))
}

/// Splits `mission_new_<tactic>` and `mission_tactic_<tactic>` order kinds.
fn tactic_of<'a>(kind: &'a str, prefix: &str) -> Option<&'a str> {
    kind.strip_prefix(prefix).filter(|name| is_tactic(name))
}

impl World {
    fn mission_index(&self, id: u32) -> Option<usize> {
        self.missions.iter().position(|mission| mission.id == id)
    }

    /// Takes `id` out of whatever mission holds it. Called when a player's
    /// order executes on the unit.
    pub(crate) fn release_from_missions(&mut self, id: u32) {
        for mission in &mut self.missions {
            mission.members.retain(|member| *member != id);
        }
    }

    /// Stops a unit so it is idle and free for another mission.
    fn stand_down(&mut self, ids: &[u32]) {
        let lookup = self.id_lookup();
        for id in ids {
            if let Some(at) = lookup.get(*id) {
                let unit = &mut self.units[at];
                unit.behavior = None;
                unit.order = Order::idle();
                unit.queue.clear();
                unit.returning = false;
            }
        }
    }

    /// The default rally: [`RALLY_FRACTION`] of the way from the owner's
    /// nearest finished hub to the point, clamped to the map and nudged onto a
    /// free spot. The point itself when the owner has no hub.
    fn default_rally(
        &self,
        owner: u8,
        point: (f32, f32),
        navigation: &Navigation,
        size: f32,
    ) -> (f32, f32) {
        let hub = self
            .units
            .iter()
            .filter(|hub| {
                hub.owner == owner && is_hub(&hub.kind) && hub.construction_remaining == 0
            })
            .min_by(|left, right| {
                distance(point.0, point.1, left.x, left.y)
                    .total_cmp(&distance(point.0, point.1, right.x, right.y))
                    .then(left.id.cmp(&right.id))
            });
        let Some(hub) = hub else {
            return point;
        };
        let band = 16.0..=size - 16.0;
        let x = (hub.x + (point.0 - hub.x) * RALLY_FRACTION).clamp(*band.start(), *band.end());
        let y = (hub.y + (point.1 - hub.y) * RALLY_FRACTION).clamp(*band.start(), *band.end());
        if navigation.free(x, y) {
            (x, y)
        } else {
            navigation.escape(x, y).unwrap_or(point)
        }
    }

    // --- commands -----------------------------------------------------------

    /// Validates a `mission_*` command. The units named must be the issuer's;
    /// for create and assign the army among them are the ones that join.
    pub(crate) fn validate_mission(
        &self,
        command: &Command,
        map: &crate::maps::MapDefinition,
    ) -> Result<(), String> {
        let order = &command.order;
        if command.queued {
            return Err("Mission commands cannot be queued".into());
        }
        if command.units.len() > MAX_UNITS {
            return Err(format!("Select between 1 and {MAX_UNITS} units"));
        }
        let lookup = self.id_lookup();
        for id in &command.units {
            let owned = lookup
                .get(*id)
                .is_some_and(|at| self.units[at].owner == command.owner);
            if !owned {
                return Err("Unit is missing or belongs to another player".into());
            }
        }
        let army = self.joining(command);
        let kind = order.kind.as_str();
        let existing = || -> Result<(), String> {
            match self
                .missions
                .iter()
                .find(|mission| mission.id == order.target)
            {
                Some(mission) if mission.owner == command.owner => Ok(()),
                _ => Err("That mission does not exist".into()),
            }
        };
        let navigation = Navigation::new(map, &self.units);
        let place = |x: f32, y: f32| -> Result<(), String> {
            validate_position(x, y, map.size)?;
            if !navigation.free(x, y) {
                return Err("Destination is obstructed".into());
            }
            Ok(())
        };
        if tactic_of(kind, "mission_new_").is_some() {
            if self
                .missions
                .iter()
                .filter(|mission| mission.owner == command.owner)
                .count()
                >= MAX_MISSIONS
            {
                return Err(format!("Mission limit reached ({MAX_MISSIONS})"));
            }
            return place(order.x, order.y);
        }
        if tactic_of(kind, "mission_tactic_").is_some() {
            return existing();
        }
        match kind {
            "mission_size" => {
                existing()?;
                if !order.x.is_finite() {
                    return Err("Invalid mission size".into());
                }
                Ok(())
            }
            "mission_gather" | "mission_fallback" => {
                existing()?;
                if !order.x.is_finite() {
                    return Err("Invalid percentage".into());
                }
                Ok(())
            }
            "mission_rally" => {
                existing()?;
                place(order.x, order.y)
            }
            "mission_cancel" => existing(),
            "mission_assign" => {
                existing()?;
                if army.is_empty() {
                    return Err("Select army units to assign".into());
                }
                Ok(())
            }
            _ => Err("Unknown mission command".into()),
        }
    }

    /// The command's army units: the ones that may join a mission.
    fn joining(&self, command: &Command) -> Vec<u32> {
        let lookup = self.id_lookup();
        command
            .units
            .iter()
            .copied()
            .filter(|id| {
                lookup.get(*id).is_some_and(|at| {
                    let unit = &self.units[at];
                    unit.owner == command.owner
                        && is_army(&unit.kind)
                        && unit.construction_remaining == 0
                })
            })
            .collect()
    }

    /// Moves `ids` into mission `index`, out of any other.
    fn give(&mut self, index: usize, ids: &[u32]) {
        for (at, mission) in self.missions.iter_mut().enumerate() {
            if at != index {
                mission.members.retain(|member| !ids.contains(member));
            }
        }
        let mission = &mut self.missions[index];
        for id in ids {
            if !mission.members.contains(id) {
                mission.members.push(*id);
            }
        }
        if mission.size != REST {
            mission.size = mission
                .size
                .max(mission.members.len() as i32)
                .min(MAX_MISSION_SIZE);
        }
    }

    /// Runs a validated `mission_*` command.
    pub(crate) fn execute_mission(&mut self, command: &Command, map: &crate::maps::MapDefinition) {
        let order = &command.order;
        let kind = order.kind.as_str();
        let army = self.joining(command);
        if let Some(tactic) = tactic_of(kind, "mission_new_") {
            let navigation = Navigation::new(map, &self.units);
            let rally =
                self.default_rally(command.owner, (order.x, order.y), &navigation, map.size);
            let id = self.next_mission_id;
            self.next_mission_id += 1;
            self.missions.push(Mission {
                id,
                owner: command.owner,
                tactic: tactic.into(),
                x: order.x,
                y: order.y,
                size: default_size(tactic),
                state: if tactic == "gather" {
                    STATE_GATHER.into()
                } else {
                    String::new()
                },
                state_tick: self.tick,
                rally_x: rally.0,
                rally_y: rally.1,
                gather_percent: DEFAULT_GATHER_PERCENT,
                fallback_percent: DEFAULT_FALLBACK_PERCENT,
                strike_strength: 0,
                members: vec![],
            });
            let index = self.missions.len() - 1;
            self.give(index, &army);
        } else if let Some(tactic) = tactic_of(kind, "mission_tactic_") {
            let tick = self.tick;
            let index = self.mission_index(order.target).expect("validated mission");
            let mission = &mut self.missions[index];
            if mission.tactic != tactic {
                mission.tactic = tactic.into();
                mission.state = if tactic == "gather" {
                    STATE_GATHER.into()
                } else {
                    String::new()
                };
                mission.state_tick = tick;
                mission.strike_strength = 0;
            }
        } else {
            let index = self.mission_index(order.target).expect("validated mission");
            match kind {
                "mission_size" => {
                    let wanted = order.x.round();
                    self.missions[index].size = if wanted < 1.0 {
                        REST
                    } else {
                        (wanted as i32).clamp(1, MAX_MISSION_SIZE)
                    };
                }
                "mission_gather" => {
                    self.missions[index].gather_percent = (order.x.round() as i32)
                        .clamp(MIN_PERCENT as i32, MAX_PERCENT as i32)
                        as u8;
                }
                "mission_fallback" => {
                    self.missions[index].fallback_percent = (order.x.round() as i32)
                        .clamp(MIN_PERCENT as i32, MAX_PERCENT as i32)
                        as u8;
                }
                "mission_rally" => {
                    self.missions[index].rally_x = order.x;
                    self.missions[index].rally_y = order.y;
                }
                "mission_cancel" => {
                    let gone = self.missions.remove(index);
                    self.stand_down(&gone.members);
                }
                "mission_assign" => self.give(index, &army),
                _ => unreachable!("validated mission command"),
            }
        }
        // Applied now rather than at the next pass: the player sees the group
        // react to the command, and the result is the same on every replay.
        self.run_missions(map);
    }

    // --- the pass -----------------------------------------------------------

    /// One mission pass. Deterministic, id order, work bounded by the missions
    /// (at most [`MAX_MISSIONS`] per player) and the player's army.
    pub(crate) fn run_missions(&mut self, map: &crate::maps::MapDefinition) {
        if self.missions.is_empty() {
            return;
        }
        let tick = self.tick;
        let lookup = self.id_lookup();
        // 1. The dead drop out (and a unit that somehow stopped being army).
        for mission in &mut self.missions {
            let owner = mission.owner;
            mission.members.retain(|id| {
                lookup.get(*id).is_some_and(|at| {
                    self.units[at].owner == owner && is_army(&self.units[at].kind)
                })
            });
        }
        let distance_to = |units: &[crate::simulation::Entity], id: u32, point: (f32, f32)| {
            lookup.get(id).map_or(f32::MAX, |at| {
                distance(units[at].x, units[at].y, point.0, point.1)
            })
        };
        // 2. Shrink: the farthest extras are released and stopped.
        let mut stopped: Vec<u32> = vec![];
        for mission in &mut self.missions {
            if mission.size == REST || mission.members.len() <= mission.size as usize {
                continue;
            }
            let point = (mission.x, mission.y);
            let units = &self.units;
            mission.members.sort_by(|left, right| {
                distance_to(units, *left, point)
                    .total_cmp(&distance_to(units, *right, point))
                    .then(left.cmp(right))
            });
            stopped.extend(mission.members.split_off(mission.size as usize));
        }
        self.stand_down(&stopped);

        // 3. Recruit, owner by owner.
        let owners: BTreeSet<u8> = self.missions.iter().map(|mission| mission.owner).collect();
        for owner in owners {
            self.recruit(owner);
        }

        // 4. The gather state machines. A gathering (or falling back) army
        // turns to defend a building under attack, then gathers again.
        let threats = self.threats();
        let lookup = self.id_lookup();
        // Waiting reinforcements sent into a running strike this pass.
        let mut waves: BTreeSet<u32> = BTreeSet::new();
        for mission in &mut self.missions {
            if mission.tactic != "gather" {
                continue;
            }
            let rally = (mission.rally_x, mission.rally_y);
            let radius = gather_radius(mission.members.len());
            // An empty mission has nobody to send home.
            let threat = threats
                .get(&mission.owner)
                .copied()
                .flatten()
                .filter(|_| !mission.members.is_empty());
            let gathered = mission
                .members
                .iter()
                .filter(|id| {
                    lookup.get(**id).is_some_and(|at| {
                        distance(self.units[at].x, self.units[at].y, rally.0, rally.1) <= radius
                    })
                })
                .count();
            match mission.state.as_str() {
                STATE_STRIKE => {
                    // Strikers are the members running the assault; the rest
                    // joined later and wait at the rally.
                    let units = &self.units;
                    let striking = |id: &u32| {
                        lookup.get(*id).is_some_and(|at| {
                            units[at]
                                .behavior
                                .as_ref()
                                .is_some_and(|running| running.preset == "assault")
                        })
                    };
                    let strikers = mission.members.iter().filter(|id| striking(id)).count();
                    if (strikers as u64) * 100
                        < mission.fallback_percent as u64 * mission.strike_strength as u64
                    {
                        mission.state = STATE_FALLBACK.into();
                        mission.state_tick = tick;
                        continue;
                    }
                    let waiting: Vec<u32> = mission
                        .members
                        .iter()
                        .copied()
                        .filter(|id| !striking(id))
                        .filter(|id| {
                            lookup.get(*id).is_some_and(|at| {
                                distance(units[at].x, units[at].y, rally.0, rally.1) <= radius
                            })
                        })
                        .collect();
                    if wave_ready(mission, strikers, waiting.len()) {
                        mission.strike_strength += waiting.len() as u32;
                        waves.extend(waiting);
                    }
                }
                STATE_DEFEND => {
                    if threat.is_none() {
                        mission.state = STATE_GATHER.into();
                        mission.state_tick = tick + DEFEND_SETTLE_TICKS;
                    }
                }
                STATE_FALLBACK if threat.is_some() => {
                    mission.state = STATE_DEFEND.into();
                    mission.state_tick = tick;
                    mission.strike_strength = 0;
                }
                STATE_FALLBACK => {
                    if gathered == mission.members.len()
                        || tick.saturating_sub(mission.state_tick) >= FALLBACK_REGROUP_TICKS
                    {
                        mission.state = STATE_GATHER.into();
                        mission.state_tick = tick;
                        mission.strike_strength = 0;
                    }
                }
                _ => {
                    if mission.state != STATE_GATHER {
                        mission.state = STATE_GATHER.into();
                        mission.state_tick = tick;
                    }
                    if threat.is_some() {
                        mission.state = STATE_DEFEND.into();
                        mission.state_tick = tick;
                    } else if tick >= mission.state_tick && ready_to_strike(mission, gathered) {
                        mission.state = STATE_STRIKE.into();
                        mission.state_tick = tick;
                        mission.strike_strength = mission.members.len() as u32;
                    }
                }
            }
        }

        // 5. Hand every member its preset and goal, only where it differs.
        let mut navigation: Option<Navigation> = None;
        for index in 0..self.missions.len() {
            let mission = &self.missions[index];
            let (preset, goal) = match threats.get(&mission.owner).copied().flatten() {
                Some(point) if mission.tactic == "gather" && mission.state == STATE_DEFEND => {
                    ("assault", point)
                }
                _ => mission.wanted(),
            };
            // A strike that began on an earlier pass only takes the members
            // already in it, and this pass's wave.
            let joined_strike = mission.tactic == "gather"
                && mission.state == STATE_STRIKE
                && mission.state_tick != tick;
            let waiting = ("guard", (mission.rally_x, mission.rally_y));
            let members = mission.members.clone();
            for id in members {
                let Some(at) = lookup.get(id) else {
                    continue;
                };
                let (preset, goal) = if joined_strike
                    && !waves.contains(&id)
                    && self.units[at]
                        .behavior
                        .as_ref()
                        .is_none_or(|running| running.preset != "assault")
                {
                    waiting
                } else {
                    (preset, goal)
                };
                let Some(policy) = behavior::policy(preset) else {
                    continue;
                };
                let differs = match &self.units[at].behavior {
                    Some(running) => {
                        running.preset != policy.name || (running.goal_x, running.goal_y) != goal
                    }
                    None => true,
                };
                if !differs {
                    continue;
                }
                let navigation =
                    navigation.get_or_insert_with(|| Navigation::new(map, &self.units));
                let home = self.home_of(at, navigation);
                Self::activate_behavior(&mut self.units[at], policy, goal, home, tick);
            }
        }
    }

    /// For every owner with a gather mission that could defend, the building
    /// (not a territory link) most threatened (most enemy army within [`THREAT_RADIUS`], at least
    /// [`THREAT_MINIMUM`]; lowest id on a tie), or `None`.
    fn threats(&self) -> std::collections::BTreeMap<u8, Option<(f32, f32)>> {
        let owners: BTreeSet<u8> = self
            .missions
            .iter()
            .filter(|mission| mission.tactic == "gather" && mission.state != STATE_STRIKE)
            .map(|mission| mission.owner)
            .collect();
        owners
            .into_iter()
            .map(|owner| {
                let enemies: Vec<(f32, f32)> = self
                    .units
                    .iter()
                    .filter(|unit| unit.owner != owner && is_army(&unit.kind) && unit.hp > 0)
                    .map(|unit| (unit.x, unit.y))
                    .collect();
                let mut best: Option<(usize, (f32, f32))> = None;
                if !enemies.is_empty() {
                    // Territory links are not worth pulling the army across the map for.
                    let worth = |kind: &str| {
                        is_building(kind) && !matches!(kind, "sensor" | "relay" | "tumor")
                    };
                    for building in self
                        .units
                        .iter()
                        .filter(|unit| unit.owner == owner && worth(&unit.kind))
                    {
                        let near = enemies
                            .iter()
                            .filter(|at| {
                                distance(at.0, at.1, building.x, building.y) <= THREAT_RADIUS
                            })
                            .count();
                        if near >= THREAT_MINIMUM && best.is_none_or(|(held, _)| near > held) {
                            best = Some((near, (building.x, building.y)));
                        }
                    }
                }
                (owner, best.map(|(_, point)| point))
            })
            .collect()
    }

    /// Deals the owner's idle army out to their missions.
    fn recruit(&mut self, owner: u8) {
        let taken: BTreeSet<u32> = self
            .missions
            .iter()
            .flat_map(|mission| mission.members.iter().copied())
            .collect();
        // Idle: no behavior, standing still, finished, in no mission. Units are
        // id-sorted, so the pool is too.
        let mut pool: Vec<(u32, f32, f32)> = self
            .units
            .iter()
            .filter(|unit| {
                unit.owner == owner
                    && is_army(&unit.kind)
                    && unit.construction_remaining == 0
                    && unit.behavior.is_none()
                    && unit.order.kind == "stop"
                    && !taken.contains(&unit.id)
            })
            .map(|unit| (unit.id, unit.x, unit.y))
            .collect();
        let positions: std::collections::BTreeMap<u32, (f32, f32)> = self
            .units
            .iter()
            .filter(|unit| unit.owner == owner)
            .map(|unit| (unit.id, (unit.x, unit.y)))
            .collect();
        let mine: Vec<usize> = (0..self.missions.len())
            .filter(|index| self.missions[*index].owner == owner)
            .collect();

        let nearest =
            |units: &mut Vec<(u32, f32, f32)>, point: (f32, f32), count: usize| -> Vec<u32> {
                units.sort_by(|left, right| {
                    distance(left.1, left.2, point.0, point.1)
                        .total_cmp(&distance(right.1, right.2, point.0, point.1))
                        .then(left.0.cmp(&right.0))
                });
                let count = count.min(units.len());
                units.drain(..count).map(|unit| unit.0).collect()
            };

        // Sized missions first, in id order: free units, then members of the
        // "rest" missions, which are by definition what is left over (a Guard
        // placed after a Raid peels units off the raid).
        for &index in &mine {
            let mission = &self.missions[index];
            if mission.size == REST {
                continue;
            }
            let point = (mission.x, mission.y);
            let wanted = (mission.size as usize).saturating_sub(mission.members.len());
            if wanted == 0 {
                continue;
            }
            let mut ids = nearest(&mut pool, point, wanted);
            if ids.len() < wanted {
                let mut spare: Vec<(u32, f32, f32)> = mine
                    .iter()
                    .filter(|other| self.missions[**other].size == REST)
                    .flat_map(|other| self.missions[*other].members.iter().copied())
                    .filter_map(|id| positions.get(&id).map(|at| (id, at.0, at.1)))
                    .collect();
                ids.extend(nearest(&mut spare, point, wanted - ids.len()));
            }
            if !ids.is_empty() {
                self.give(index, &ids);
            }
        }
        // The rest split the remainder: each takes the nearest
        // ceil(left / missions still to fill) of what is left.
        let rest: Vec<usize> = mine
            .iter()
            .copied()
            .filter(|index| self.missions[*index].size == REST)
            .collect();
        for (position, &index) in rest.iter().enumerate() {
            if pool.is_empty() {
                break;
            }
            let point = (self.missions[index].x, self.missions[index].y);
            let share = pool.len().div_ceil(rest.len() - position);
            let ids = nearest(&mut pool, point, share);
            self.give(index, &ids);
        }
    }
}

#[cfg(test)]
#[path = "mission_tests.rs"]
mod tests;
