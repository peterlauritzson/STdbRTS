//! Production doctrine: what a player wants trained, bought and kept in reserve.
//!
//! Per player, all of it **off by default**: `enabled` (auto-train), `auto_tier`,
//! `auto_research`, `auto_build`, a catalyst reserve and a 0-10 weight per army kind of the
//! player's faction (default 5 for every kind). Every
//! [`DOCTRINE_INTERVAL_TICKS`] the simulation runs one pass over the owners that
//! switched something on, owners and buildings in id order:
//!
//! 1. at most one purchase per owner: the next tier, else the next weapons or
//!    armour level (cheaper first, weapons on a tie), else logistics;
//! 2. at most one new production building per owner (`auto_build`, see
//!    [`World::doctrine_build`]);
//! 3. every finished barracks or factory with an EMPTY production queue gets one
//!    item: the trainable kind furthest below its target share of the army.
//!
//! Nothing here has rules of its own. Every purchase and every queued unit goes
//! through `validate_on` / `execute_on` as an ordinary `tier_*`, `research_*` or
//! `train_*` command would, so cost, tier, unit cap, power-field and rally rules
//! cannot drift apart from the manual path. Manual play is untouched: a queue
//! the player filled is simply a building the pass skips.
//!
//! Commands (`doctrine_*`) go through the delayed command path. Every number is
//! **experimental**. See `docs/honeybadger/STRATEGY-LAYERS.md`, "Layer 3".

use crate::maps::MapDefinition;
use crate::simulation::{Command, Order, World};
use crate::{
    army_building, army_faction, is_army, is_building, is_hub, required_tier, research_cost_at,
    stats, tier_building, tier_number, Faction, ResourceKind, SYNTHESIZER_TIER,
};
use std::collections::BTreeMap;

/// How often, in ticks, the doctrine pass runs (once a second).
pub const DOCTRINE_INTERVAL_TICKS: u64 = 20;
pub const DEFAULT_WEIGHT: u8 = 5;
pub const MAX_WEIGHT: u8 = 10;
pub const MAX_RESERVE: u32 = 2000;
/// The step a client moves the reserve by. The server accepts any whole number
/// in range.
pub const RESERVE_STEP: u32 = 50;
/// Auto-build raises a barracks or factory only when catalyst is at least the
/// reserve plus this much. Experimental.
pub const AUTO_BUILD_CATALYST_FLOAT: u32 = 400;
/// Auto-build raises a synthesizer only when material is at least this much.
/// Experimental.
pub const AUTO_BUILD_MATERIAL_FLOAT: u32 = 1500;
/// Auto-build claims catalyst deposits this close to a finished hub.
/// Experimental.
pub const AUTO_BUILD_REFINERY_REACH: f32 = 500.0;
/// Auto-build stops raising synthesizers at this many (finished or not).
/// Experimental.
pub const MAX_AUTO_SYNTHESIZERS: usize = 4;
/// Distances from the anchor hub that auto-build tries, nearest ring first.
/// Experimental.
pub const AUTO_BUILD_RINGS: [f32; 4] = [260.0, 320.0, 380.0, 440.0];
/// Bearings tried per ring, evenly spaced starting at angle 0. Experimental.
pub const AUTO_BUILD_BEARINGS: usize = 24;
/// A site closer than this to any resource node is skipped, which keeps mining
/// lines clear. Experimental.
pub const AUTO_BUILD_NODE_CLEARANCE: f32 = 220.0;

/// One player's production doctrine. A player with the default value has no
/// entry in `World::doctrines`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Doctrine {
    pub enabled: bool,
    pub auto_tier: bool,
    pub auto_research: bool,
    pub auto_build: bool,
    pub reserve: u32,
    /// Only weights that differ from [`DEFAULT_WEIGHT`].
    pub weights: BTreeMap<String, u8>,
}

impl Doctrine {
    pub fn weight(&self, kind: &str) -> u8 {
        self.weights.get(kind).copied().unwrap_or(DEFAULT_WEIGHT)
    }

    fn is_default(&self) -> bool {
        *self == Doctrine::default()
    }
}

/// A faction's army kinds in roster order: fighter, raider, the second
/// barracks pair, then the factory pair. The tie-break order of the pass and
/// the order a client lists them in (`ROSTER` in `src/catalog.ts`).
pub const fn roster(faction: Faction) -> [&'static str; 6] {
    match faction {
        Faction::Industrial => ["soldier", "scout", "marksman", "medic", "siege", "bulwark"],
        Faction::Network => [
            "sentinel", "skimmer", "arcer", "phantom", "lancer", "warden",
        ],
        Faction::Organic => [
            "swarmer", "spitter", "prowler", "devourer", "crusher", "behemoth",
        ],
    }
}

impl World {
    /// The doctrine `owner` has set (all off and neutral if none).
    pub fn doctrine_of(&self, owner: u8) -> Doctrine {
        self.doctrines.get(&owner).cloned().unwrap_or_default()
    }

    /// Setting a doctrine value: free and instant, per player. The one unit
    /// named is only the issuer the command protocol requires.
    pub(crate) fn validate_doctrine(&self, command: &Command) -> Result<(), String> {
        if command.units.len() != 1 || command.queued {
            return Err(
                "Doctrine is set once, from the Strategy panel, and cannot be queued".into(),
            );
        }
        if !self
            .units
            .iter()
            .any(|unit| unit.id == command.units[0] && unit.owner == command.owner)
        {
            return Err("Unit is missing or belongs to another player".into());
        }
        let order = &command.order;
        let kind = order.kind.as_str();
        if !order.x.is_finite() {
            return Err("Invalid doctrine value".into());
        }
        match kind {
            "doctrine_train" | "doctrine_tier" | "doctrine_research" | "doctrine_build" => {
                if order.x != 0.0 && order.x != 1.0 {
                    return Err("A doctrine switch is 0 or 1".into());
                }
                Ok(())
            }
            "doctrine_reserve" => {
                if order.x < 0.0 || order.x > MAX_RESERVE as f32 {
                    return Err(format!("Catalyst reserve is between 0 and {MAX_RESERVE}"));
                }
                Ok(())
            }
            _ => {
                let Some(army) = kind.strip_prefix("doctrine_weight_") else {
                    return Err("Unknown doctrine command".into());
                };
                if army_faction(army) != Some(self.faction(command.owner)) {
                    return Err("Weights are set for your own faction's army units".into());
                }
                if order.x < 0.0 || order.x > MAX_WEIGHT as f32 || order.x.fract() != 0.0 {
                    return Err(format!("A weight is a whole number from 0 to {MAX_WEIGHT}"));
                }
                Ok(())
            }
        }
    }

    pub(crate) fn execute_doctrine(&mut self, command: &Command) {
        let order = &command.order;
        let mut doctrine = self.doctrine_of(command.owner);
        let on = order.x != 0.0;
        match order.kind.as_str() {
            "doctrine_train" => doctrine.enabled = on,
            "doctrine_tier" => doctrine.auto_tier = on,
            "doctrine_research" => doctrine.auto_research = on,
            "doctrine_build" => doctrine.auto_build = on,
            "doctrine_reserve" => doctrine.reserve = order.x.round() as u32,
            kind => {
                if let Some(army) = kind.strip_prefix("doctrine_weight_") {
                    let weight = order.x as u8;
                    if weight == DEFAULT_WEIGHT {
                        doctrine.weights.remove(army);
                    } else {
                        doctrine.weights.insert(army.to_string(), weight);
                    }
                }
            }
        }
        if doctrine.is_default() {
            self.doctrines.remove(&command.owner);
        } else {
            self.doctrines.insert(command.owner, doctrine);
        }
    }

    /// The pass: purchases, then training, for every owner with something on.
    pub(crate) fn run_doctrines(&mut self, map: &MapDefinition) {
        let owners: Vec<u8> = self.doctrines.keys().copied().collect();
        for owner in owners {
            let doctrine = self.doctrine_of(owner);
            if doctrine.auto_tier || doctrine.auto_research {
                self.doctrine_purchase(owner, &doctrine, map);
            }
            if doctrine.auto_build {
                self.doctrine_build(owner, &doctrine, map);
            }
            if doctrine.enabled {
                self.doctrine_train(owner, &doctrine, map);
            }
        }
    }

    /// Runs `kind` for `owner` through the ordinary command path, as if issued
    /// by `unit`. True when it executed.
    fn doctrine_issue(
        &mut self,
        owner: u8,
        unit: u32,
        kind: &str,
        (x, y): (f32, f32),
        map: &MapDefinition,
    ) -> bool {
        let command = Command {
            id: 0,
            owner,
            units: vec![unit],
            order: Order {
                kind: kind.into(),
                x,
                y,
                target: 0,
            },
            queued: false,
            execute_tick: self.tick,
            status: "executed".into(),
            reason: String::new(),
        };
        self.execute_on(&command, map).is_ok()
    }

    /// The unit research commands name as their issuer: the owner's first
    /// finished building.
    fn doctrine_issuer(&self, owner: u8) -> Option<u32> {
        self.units
            .iter()
            .find(|unit| {
                unit.owner == owner && is_building(&unit.kind) && unit.construction_remaining == 0
            })
            .map(|unit| unit.id)
    }

    /// At most one purchase: the next tier, else weapons/armour (cheaper first,
    /// weapons on a tie), else logistics.
    fn doctrine_purchase(&mut self, owner: u8, doctrine: &Doctrine, map: &MapDefinition) {
        let Some(issuer) = self.doctrine_issuer(owner) else {
            return;
        };
        if doctrine.auto_tier {
            let kind = format!("tier_{}", self.tier(owner) + 1);
            if tier_number(&kind).is_some()
                && self.doctrine_issue(owner, issuer, &kind, (0.0, 0.0), map)
            {
                return;
            }
        }
        if doctrine.auto_research {
            let mut leveled = ["research_weapons", "research_armor"];
            // Stable sort: weapons stays first on equal prices.
            leveled
                .sort_by_key(|kind| research_cost_at(kind, self.research_level(owner, kind) + 1));
            for kind in leveled.into_iter().chain(["research_logistics"]) {
                if self.doctrine_issue(owner, issuer, kind, (0.0, 0.0), map) {
                    return;
                }
            }
        }
    }

    /// At most one new building per owner: first the building the next tier
    /// needs (barracks, factory, laboratory) when the owner has none, so a
    /// catalyst-starved army still climbs to the synthesizer that feeds it;
    /// else a barracks or factory when catalyst piles up, else a synthesizer
    /// when material does. Nothing while any barracks, factory, laboratory or
    /// synthesizer is still under construction. Sites are
    /// searched on rings around the anchor hub, deterministically.
    fn doctrine_build(&mut self, owner: u8, doctrine: &Doctrine, map: &MapDefinition) {
        if self.units.iter().any(|unit| {
            unit.owner == owner
                && matches!(unit.kind.as_str(), "barracks" | "factory" | "lab" | "synthesizer")
                && unit.construction_remaining > 0
        }) {
            return;
        }
        // Refineries first: a free catalyst deposit near a finished hub of the
        // owner's is the army's income, and nothing else claims it.
        if self.doctrine_refinery(owner, map) {
            return;
        }
        let count = |world: &World, wanted: &str| {
            world
                .units
                .iter()
                .filter(|unit| unit.owner == owner && unit.kind == wanted)
                .count()
        };
        let balance = self.balances.get(&owner);
        let catalyst = balance.map_or(0, |balance| balance.catalyst);
        let material = balance.map_or(0, |balance| balance.material);
        let mut wanted: Vec<&str> = Vec::new();
        let tier = self.tier(owner);
        let next_building = (tier < 3).then(|| tier_building(tier + 1));
        if let Some(building) = next_building.filter(|building| count(self, building) == 0) {
            wanted.push(building);
        } else if catalyst >= doctrine.reserve + AUTO_BUILD_CATALYST_FLOAT {
            // Fewest buildings per unit of wanted weight; barracks on a tie.
            let mut scored: Vec<(&str, f32)> = Vec::new();
            for building in ["barracks", "factory"] {
                let weight_sum: u32 = roster(self.faction(owner))
                    .into_iter()
                    .filter(|kind| army_building(kind) == Some(building))
                    .map(|kind| doctrine.weight(kind) as u32)
                    .sum();
                if weight_sum > 0 {
                    let score = (count(self, building) + 1) as f32 / weight_sum as f32;
                    scored.push((building, score));
                }
            }
            // Stable sort: barracks stays first on equal scores.
            scored.sort_by(|a, b| a.1.total_cmp(&b.1));
            wanted.extend(scored.into_iter().map(|(kind, _)| kind));
        } else if self.tier(owner) >= SYNTHESIZER_TIER
            && material >= AUTO_BUILD_MATERIAL_FLOAT
            && count(self, "synthesizer") < MAX_AUTO_SYNTHESIZERS
        {
            wanted.push("synthesizer");
        }
        if wanted.is_empty() {
            return;
        }
        // The HQ if it stands finished, else the lowest-id finished hub.
        let anchor = self
            .units
            .iter()
            .filter(|unit| unit.owner == owner && unit.construction_remaining == 0)
            .find(|unit| unit.kind == "hq")
            .or_else(|| {
                self.units
                    .iter()
                    .filter(|unit| unit.owner == owner && unit.construction_remaining == 0)
                    .filter(|unit| is_hub(&unit.kind))
                    .min_by_key(|unit| unit.id)
            })
            .map(|unit| (unit.id, unit.x, unit.y));
        let Some((anchor, ax, ay)) = anchor else {
            return;
        };
        let step = std::f32::consts::TAU / AUTO_BUILD_BEARINGS as f32;
        for kind in wanted {
            let order = format!("build_{kind}");
            for radius in AUTO_BUILD_RINGS {
                for i in 0..AUTO_BUILD_BEARINGS {
                    let angle = i as f32 * step;
                    let site = (ax + radius * angle.cos(), ay + radius * angle.sin());
                    if self.nodes.iter().any(|node| {
                        (node.x - site.0).hypot(node.y - site.1) < AUTO_BUILD_NODE_CLEARANCE
                    }) {
                        continue;
                    }
                    if self.doctrine_issue(owner, anchor, &order, site, map) {
                        return;
                    }
                }
            }
        }
    }

    /// Places a refinery on the nearest free catalyst deposit within
    /// [`AUTO_BUILD_REFINERY_REACH`] of one of the owner's finished hubs, hubs
    /// in id order. True when one was placed. An occupied deposit simply
    /// fails validation.
    fn doctrine_refinery(&mut self, owner: u8, map: &MapDefinition) -> bool {
        let hubs: Vec<(u32, f32, f32)> = self
            .units
            .iter()
            .filter(|unit| unit.owner == owner && is_hub(&unit.kind) && unit.construction_remaining == 0)
            .map(|unit| (unit.id, unit.x, unit.y))
            .collect();
        for (hub, hx, hy) in hubs {
            let mut deposits: Vec<(f32, f32, f32)> = self
                .nodes
                .iter()
                .filter(|node| node.kind == ResourceKind::Catalyst && node.amount > 0)
                .map(|node| ((node.x - hx).hypot(node.y - hy), node.x, node.y))
                .filter(|(gap, _, _)| *gap <= AUTO_BUILD_REFINERY_REACH)
                .collect();
            deposits.sort_by(|left, right| left.0.total_cmp(&right.0));
            for (_, x, y) in deposits {
                if self.doctrine_issue(owner, hub, "build_refinery", (x, y), map) {
                    return true;
                }
            }
        }
        false
    }

    /// One item per finished, idle production building, in id order.
    fn doctrine_train(&mut self, owner: u8, doctrine: &Doctrine, map: &MapDefinition) {
        let order = roster(self.faction(owner));
        let buildings: Vec<u32> = self
            .units
            .iter()
            .filter(|unit| {
                unit.owner == owner
                    && unit.construction_remaining == 0
                    && matches!(unit.kind.as_str(), "barracks" | "factory")
            })
            .map(|unit| unit.id)
            .collect();
        for id in buildings {
            let Some(building) = self.units.iter().find(|unit| unit.id == id) else {
                continue;
            };
            if !building.production.is_empty() {
                continue;
            }
            let building_kind = building.kind.clone();
            let tier = self.tier(owner);
            // Recomputed per building: an item queued a moment ago for another
            // building already counts.
            let mut counts: BTreeMap<&str, u32> = BTreeMap::new();
            for unit in self.units.iter().filter(|unit| unit.owner == owner) {
                if is_army(&unit.kind) {
                    *counts.entry(unit.kind.as_str()).or_default() += 1;
                }
                for item in &unit.production {
                    if is_army(&item.kind) {
                        *counts.entry(item.kind.as_str()).or_default() += 1;
                    }
                }
            }
            let total: u32 = counts.values().sum();
            // Kinds some finished building of the owner can train right now.
            let trainable: Vec<&str> = order
                .into_iter()
                .filter(|kind| required_tier(kind) <= tier)
                .filter(|kind| {
                    let wanted = army_building(kind);
                    self.units.iter().any(|unit| {
                        unit.owner == owner
                            && unit.construction_remaining == 0
                            && Some(unit.kind.as_str()) == wanted
                    })
                })
                .collect();
            let weights: u32 = trainable
                .iter()
                .map(|kind| doctrine.weight(kind) as u32)
                .sum();
            if weights == 0 {
                continue;
            }
            let mut best: Option<(&str, f32)> = None;
            for kind in trainable.iter().copied() {
                let weight = doctrine.weight(kind);
                if weight == 0 || army_building(kind) != Some(building_kind.as_str()) {
                    continue;
                }
                let target = weight as f32 / weights as f32;
                let current = if total == 0 {
                    0.0
                } else {
                    counts.get(kind).copied().unwrap_or(0) as f32 / total as f32
                };
                let deficit = target - current;
                // Strictly greater: a tie keeps the earlier roster entry.
                if best.is_none_or(|(_, held)| deficit > held) {
                    best = Some((kind, deficit));
                }
            }
            let Some((kind, _)) = best else {
                continue;
            };
            let catalyst = self
                .balances
                .get(&owner)
                .map_or(0, |balance| balance.catalyst);
            let cost = stats(kind).map_or(0, |definition| definition.cost.catalyst);
            if catalyst < cost || catalyst - cost < doctrine.reserve {
                continue;
            }
            self.doctrine_issue(owner, id, &format!("train_{kind}"), (0.0, 0.0), map);
        }
    }
}

#[cfg(test)]
#[path = "doctrine_tests.rs"]
mod tests;
