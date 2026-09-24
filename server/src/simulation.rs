use crate::maps::MapDefinition;
use crate::navigation::{line_of_sight, Navigation};
use crate::{
    attack_damage, building_faction, cargo_capacity, carries_cargo, death_refund, distance,
    drifter_pulse, gathers_in_place, is_army, is_building, is_hub, is_labour, labour_faction,
    advance_patch, creep_max_radius, creep_zone, death_spawn, fights, is_temporary, mining_yield,
    producer, stats, stipend_payment, temporary_lifetime, validate_position, zone_template,
    Balance,
    Cost, CreepPatch, Faction, ResourceKind, Zone, ZoneField, CONSTRUCTION_CANCEL_REFUND_PERCENT,
    HUB_STOCK_CAP, HUB_STOCK_INTERVAL_TICKS, MAX_BUILDINGS, MAX_QUEUE, MAX_UNITS,
    MINING_PULSE_TICKS, REPAIR_COST, STARTING_BALANCE,
};
use std::collections::BTreeMap;

/// The zone field an entity snapshot and the creep patches project on one tick.
///
/// Zones are derived state and this is the derivation: nothing persists a zone,
/// nothing authors one, and there is no removal path. A source that died is not
/// in `units`, so its zone is not in the field — the disappearance is a
/// consequence of the rebuild rather than a separate rule that could be
/// forgotten.
///
/// Creep is the one zone whose radius is carried between ticks, so it comes
/// from `creep` rather than from `units`: a receding patch has no source entity
/// left to derive it from. What the patch carries is only the radius; the zone
/// itself is rebuilt here like every other.
///
/// The order of neither slice matters: `ZoneField::from_sources` sorts by
/// source entity id, so membership never depends on iteration order.
pub fn zones_of(units: &[Entity], creep: &[CreepPatch]) -> ZoneField {
    let projected = units.iter().filter_map(|unit| {
        // An unfinished building projects nothing. Same rule cargo delivery and
        // the build-radius check already follow: a site is not a building yet.
        if unit.construction_remaining > 0 {
            return None;
        }
        let template = zone_template(&unit.kind)?;
        Some(Zone {
            source: unit.id,
            owner: unit.owner,
            x: unit.x,
            y: unit.y,
            // `ZoneOnset::Immediate` — full radius from the tick the source is
            // finished.
            radius: template.radius,
            template,
        })
    });
    let spread = creep.iter().map(|patch| Zone {
        source: patch.source,
        owner: patch.owner,
        x: patch.x,
        y: patch.y,
        radius: patch.radius as f32,
        template: creep_zone(),
    });
    ZoneField::from_sources(projected.chain(spread))
}

/// The speed `unit` moves at on this tick, zone modifiers applied.
///
/// **This is the only place a movement path may obtain a speed.** Every
/// `advance` in `step_on` goes through the one closure that calls this, so a
/// zone added later cannot be applied at eight movement call sites and
/// forgotten at the ninth. Nothing in this file reads `Stats::speed` directly.
///
/// Buildings are excluded explicitly rather than by accident: their base speed
/// is already 0, but a zone must never be able to make a structure mobile.
///
/// The kind is passed through because creep's off-creep slow applies to
/// harvesters only; every other kind's speed never looks at creep.
pub fn movement_speed(unit: &Entity, zones: &ZoneField) -> f32 {
    let base = stats(&unit.kind).map_or(0.0, |definition| definition.speed);
    if base <= 0.0 || is_building(&unit.kind) {
        return base;
    }
    base * zones.movement_multiplier(unit.owner, &unit.kind, unit.x, unit.y)
}

#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Debug, PartialEq)]
pub struct Order {
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub target: u32,
}

impl Order {
    pub fn idle() -> Self {
        Self {
            kind: "stop".into(),
            x: 0.0,
            y: 0.0,
            target: 0,
        }
    }
}

#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Debug, PartialEq)]
pub struct Production {
    pub kind: String,
    pub finish_tick: u64,
}

#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Debug, PartialEq)]
pub struct Entity {
    pub id: u32,
    pub owner: u8,
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub hp: i32,
    pub order: Order,
    pub queue: Vec<Order>,
    pub cargo: u32,
    /// Which currency `cargo` is. A worker never mixes currencies in one load:
    /// carrying one kind and reaching a deposit of the other sends it home
    /// first.
    pub cargo_kind: ResourceKind,
    pub returning: bool,
    pub next_attack: u64,
    pub shot_tick: u64,
    pub shot_x: f32,
    pub shot_y: f32,
    pub production: Vec<Production>,
    pub construction_remaining: u64,
    pub research: Vec<String>,
    /// Organic harvester stock held by this hub. Accrues one point every
    /// `HUB_STOCK_INTERVAL_TICKS` up to `HUB_STOCK_CAP`, for Organic owners
    /// only, and is the entire price of a harvester. Always 0 on anything that
    /// is not an Organic hub, and persisted so a client can show it.
    pub stock: u32,
    /// The tick this entity is removed on, or **0 for a permanent one**. Set
    /// only on temporary units (see `temporary_lifetime`). Expiry is a removal,
    /// not a death: an expired unit never reaches the death pipeline, so it
    /// pays no refund, moves neither `lost` nor `killed`, and spawns nothing.
    pub expires_tick: u64,
}

#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub amount: u32,
    /// The currency this deposit yields, copied from the frozen map.
    pub kind: ResourceKind,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Command {
    pub id: u64,
    pub owner: u8,
    pub units: Vec<u32>,
    pub order: Order,
    pub queued: bool,
    pub execute_tick: u64,
    pub status: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct World {
    pub tick: u64,
    pub next_id: u32,
    pub units: Vec<Entity>,
    pub nodes: Vec<Node>,
    pub commands: Vec<Command>,
    /// Per-slot holdings of both currencies.
    pub balances: BTreeMap<u8, Balance>,
    /// Which economy each slot is playing. A slot that is missing here is
    /// `Faction::Industrial`, the baseline, so nothing behaves differently until
    /// a faction is actually assigned.
    pub factions: BTreeMap<u8, Faction>,
    /// Every unit of each currency that has ever arrived in a slot's balance
    /// **out of the ground**: a carrier delivering a load at a hub, or a
    /// drifter's in-place pulse at a deposit. Nothing else is counted — not the
    /// opening stipend, not a death refund, not a cancelled-construction
    /// refund. Those are free income, and folding them in here would make an
    /// economy graph flatter than the economy actually was.
    ///
    /// Cumulative and monotonic: spending never lowers it. It is the answer to
    /// "how much did I mine", which `balances` cannot give once a single unit
    /// has been bought.
    pub collected: BTreeMap<u8, Balance>,
    /// Full `stats(kind).cost` of each slot's own entities that died — army,
    /// labour and buildings alike, at list price rather than at the refunded
    /// half. Only an entity that actually reached zero hit points counts: an
    /// eliminated player's leftovers and a surrendered player's army are swept
    /// out of the world without ever being destroyed, exactly as they are
    /// swept out of the refund path.
    pub lost: BTreeMap<u8, Cost>,
    /// The same total, for *other* slots' entities this slot destroyed. See
    /// the kill attribution note in `step_on`: the credit goes to whoever dealt
    /// the most damage in the tick the entity died, never to whoever was
    /// nearest.
    pub killed: BTreeMap<u8, Cost>,
    /// Organic creep, one patch per source building, in source-id order.
    ///
    /// The only zone state carried between ticks: a creep radius grows while
    /// its source lives and recedes after it dies, and a receding patch has no
    /// source left to hold it. Advanced by `advance_creep` at the top of every
    /// tick; read by `zones_of`.
    pub creep: Vec<CreepPatch>,
    pub outcome: Option<i16>,
}

impl World {
    /// Bootstraps a match on the built-in map.
    pub fn new(slots: &[u8]) -> Self {
        Self::new_on(crate::maps::default_map(), slots)
    }

    /// Bootstraps a match on an explicit map.
    ///
    /// The map is *the* source of the world extent. It is passed in rather than
    /// read from a constant or a mutable global, so two worlds of different
    /// sizes can exist in one process — which is what a test, a validator run
    /// and a benchmark all need.
    pub fn new_on(map: &MapDefinition, slots: &[u8]) -> Self {
        let roster: Vec<(u8, Faction)> = slots
            .iter()
            .map(|slot| (*slot, Faction::default()))
            .collect();
        Self::new_on_with_factions(map, &roster)
    }

    /// Bootstraps a match whose slots are playing named factions. Each slot
    /// opens with its own faction's labour, so a player is playing their own
    /// economy from the first tick rather than inheriting Industrial's.
    pub fn new_on_with_factions(map: &MapDefinition, roster: &[(u8, Faction)]) -> Self {
        let mut world = Self {
            tick: 0,
            next_id: 1,
            units: vec![],
            nodes: vec![],
            commands: vec![],
            balances: roster
                .iter()
                .map(|(slot, _)| (*slot, STARTING_BALANCE))
                .collect(),
            factions: roster.iter().copied().collect(),
            collected: BTreeMap::new(),
            lost: BTreeMap::new(),
            killed: BTreeMap::new(),
            creep: vec![],
            outcome: None,
        };
        let mut ordered = roster.to_vec();
        ordered.sort_unstable();
        for (slot, faction) in &ordered {
            let [x, y] = map.starts[*slot as usize];
            let labour = crate::starting_labour(*faction);
            world.spawn(*slot, "hq", x, y);
            world.spawn(*slot, labour[0], x + 55.0, y);
            world.spawn(*slot, labour[1], x, y + 55.0);
            world.spawn(*slot, "soldier", x + 55.0, y + 55.0);
        }
        // Organic HQs open on a full spread of creep. Every other patch starts
        // small when its building is finished and grows from there.
        for unit in &world.units {
            if world.faction(unit.owner) != Faction::Organic {
                continue;
            }
            if let Some(max) = creep_max_radius(&unit.kind) {
                world
                    .creep
                    .push(CreepPatch::grown(unit.id, unit.owner, unit.x, unit.y, max));
            }
        }
        for deposit in &map.deposits {
            world.nodes.push(Node {
                id: deposit.id,
                x: deposit.x,
                y: deposit.y,
                amount: deposit.amount,
                kind: deposit.kind,
            });
        }
        // Starting labour goes to work immediately, on the nearest *material*
        // deposit. An idle opening is never what a player wants, and catalyst
        // is a decision rather than a default. Ties break on node id so the
        // opening is identical on every machine.
        let material: Vec<(u32, f32, f32)> = world
            .nodes
            .iter()
            .filter(|node| node.kind == ResourceKind::Material && node.amount > 0)
            .map(|node| (node.id, node.x, node.y))
            .collect();
        for unit in &mut world.units {
            if !is_labour(&unit.kind) {
                continue;
            }
            let nearest = material.iter().min_by(|left, right| {
                distance(unit.x, unit.y, left.1, left.2)
                    .total_cmp(&distance(unit.x, unit.y, right.1, right.2))
                    .then(left.0.cmp(&right.0))
            });
            if let Some((id, _, _)) = nearest {
                unit.order = Order {
                    kind: "gather".into(),
                    x: 0.0,
                    y: 0.0,
                    target: *id,
                };
            }
        }
        world
    }

    pub fn spawn(&mut self, owner: u8, kind: &str, x: f32, y: f32) {
        self.units.push(Entity {
            id: self.next_id,
            owner,
            kind: kind.into(),
            x,
            y,
            hp: stats(kind).unwrap().hp,
            order: Order::idle(),
            queue: vec![],
            cargo: 0,
            cargo_kind: ResourceKind::default(),
            returning: false,
            next_attack: 0,
            shot_tick: 0,
            shot_x: x,
            shot_y: y,
            production: vec![],
            construction_remaining: 0,
            research: vec![],
            stock: 0,
            expires_tick: 0,
        });
        self.next_id += 1;
    }

    /// Spawns a temporary unit of `kind` at `(x, y)`, due to expire after its
    /// kind's lifetime, already attack-moving on the spot so it fights
    /// whatever is near and is otherwise the player's to command. Not capped
    /// by `MAX_UNITS`: it takes no supply. Every spawn follows a non-temporary
    /// death, so the count is bounded by what the players built.
    fn spawn_temporary(&mut self, owner: u8, kind: &str, x: f32, y: f32) {
        let lifetime =
            temporary_lifetime(kind).expect("only temporary kinds are spawned this way");
        self.spawn(owner, kind, x, y);
        let unit = self.units.last_mut().unwrap();
        unit.expires_tick = self.tick + lifetime;
        unit.order = Order {
            kind: "attack_move".into(),
            x,
            y,
            target: 0,
        };
    }

    /// What `owner` holds. An unknown slot holds nothing rather than panicking.
    pub fn balance(&self, owner: u8) -> Balance {
        self.balances.get(&owner).copied().unwrap_or_default()
    }

    /// Which economy `owner` is playing. An unknown slot is Industrial, the
    /// baseline, so an unlabelled world plays exactly as it did before.
    pub fn faction(&self, owner: u8) -> Faction {
        self.factions.get(&owner).copied().unwrap_or_default()
    }

    /// Everything `owner` has ever mined. A slot that has mined nothing reads
    /// zero rather than being absent.
    pub fn collected(&self, owner: u8) -> Balance {
        self.collected.get(&owner).copied().unwrap_or_default()
    }

    /// List price of everything of `owner`'s that has been destroyed.
    pub fn lost(&self, owner: u8) -> Cost {
        self.lost.get(&owner).copied().unwrap_or_default()
    }

    /// List price of everything `owner` has destroyed of other slots'.
    pub fn killed(&self, owner: u8) -> Cost {
        self.killed.get(&owner).copied().unwrap_or_default()
    }

    /// List price of `owner`'s living army units. Labour and buildings are
    /// deliberately not army: this is the line a score screen draws to show a
    /// push being built up and then traded away, and a worker count moving it
    /// would hide exactly that.
    pub fn army_value(&self, owner: u8) -> Cost {
        self.units
            .iter()
            .filter(|unit| unit.owner == owner && is_army(&unit.kind))
            .map(|unit| stats(&unit.kind).map_or(Cost::ZERO, |entry| entry.cost))
            .sum()
    }

    /// Both currencies must cover the price; there is no partial payment and no
    /// substituting one currency for the other.
    fn afford(&self, owner: u8, cost: Cost) -> Result<(), String> {
        let balance = self.balance(owner);
        match balance.shortfall(cost) {
            None => Ok(()),
            Some(kind) => Err(format!(
                "Insufficient {kind}: {} needed, {} available",
                cost.amount(kind),
                balance.amount(kind)
            )),
        }
    }

    /// Deducts a price that `afford` has already accepted. Answers `false` and
    /// changes nothing if it no longer fits, so a caller can never half-pay.
    fn charge(&mut self, owner: u8, cost: Cost) -> bool {
        self.balances.entry(owner).or_default().pay(cost)
    }

    fn credit(&mut self, owner: u8, amount: Cost) {
        self.balances.entry(owner).or_default().credit(amount);
    }

    /// Validates a command against the built-in map.
    pub fn validate(&self, command: &Command) -> Result<(), String> {
        self.validate_on(command, crate::maps::default_map())
    }

    /// Validates a command against the map the match froze. Every bound that
    /// depends on how big the battlefield is reads `map.size`.
    pub fn validate_on(&self, command: &Command, map: &MapDefinition) -> Result<(), String> {
        if self.outcome.is_some() {
            return Err("Match has ended".into());
        }
        if !self
            .units
            .iter()
            .any(|unit| unit.owner == command.owner && unit.kind == "hq")
        {
            return Err("Your HQ has been destroyed".into());
        }
        if command.units.is_empty() || command.units.len() > MAX_UNITS {
            return Err("Select between 1 and 60 units".into());
        }
        let mut ids = command.units.clone();
        ids.sort_unstable();
        ids.dedup();
        if ids.len() != command.units.len() {
            return Err("Duplicate unit IDs".into());
        }
        let order = &command.order;
        if let Some(kind) = order.kind.strip_prefix("build_") {
            if !is_building(kind) || kind == "hq" {
                return Err("Unknown building".into());
            }
            // Faction-gated buildings, the same way production gates labour: a
            // faction asking for another faction's structure is told which
            // faction owns it and which one it is playing, rather than being
            // handed a geometry complaint about a site it was never allowed to
            // use.
            if let Some(required) = building_faction(kind) {
                let faction = self.faction(command.owner);
                if faction != required {
                    return Err(format!(
                        "Only the {required} faction can build a {kind}; you are playing {faction}"
                    ));
                }
            }
            if command.units.len() != 1 || command.queued {
                return Err("Select one labour unit; construction cannot be queued".into());
            }
            validate_position(order.x, order.y, map.size)?;
            if !map.terrain_free(order.x, order.y, 50.0) {
                return Err("Building site intersects terrain".into());
            }
            let build_margin = 60.0..=map.size - 60.0;
            if !build_margin.contains(&order.x) || !build_margin.contains(&order.y) {
                return Err("Building too close to map edge".into());
            }
            if self.units.iter().any(|unit| {
                is_building(&unit.kind) && distance(order.x, order.y, unit.x, unit.y) < 110.0
            }) || self
                .nodes
                .iter()
                .any(|node| distance(order.x, order.y, node.x, node.y) < 75.0)
            {
                return Err("Building site is obstructed".into());
            }
            if self.units.iter().any(|unit| {
                !is_building(&unit.kind) && distance(order.x, order.y, unit.x, unit.y) < 55.0
            }) {
                return Err("Move units clear of the building site".into());
            }
            if !self.units.iter().any(|unit| {
                unit.owner == command.owner
                    && is_building(&unit.kind)
                    && unit.construction_remaining == 0
                    && distance(order.x, order.y, unit.x, unit.y) <= 500.0
            }) {
                return Err("Build within 500 units of your established base".into());
            }
            // Tech prerequisites. A completed barracks is the gate to the rest
            // of the tree: it is the first real commitment of the opening, and
            // everything past it should cost that decision.
            let has_finished = |needed: &str| {
                self.units.iter().any(|unit| {
                    unit.owner == command.owner
                        && unit.kind == needed
                        && unit.construction_remaining == 0
                })
            };
            for (wants, needs) in [("factory", "barracks"), ("lab", "barracks")] {
                if kind == wants && !has_finished(needs) {
                    return Err(format!("Build a {needs} before a {wants}"));
                }
            }
            if self
                .units
                .iter()
                .filter(|unit| unit.owner == command.owner && is_building(&unit.kind))
                .count()
                >= MAX_BUILDINGS
            {
                return Err("Building limit reached (16)".into());
            }
            self.afford(command.owner, stats(kind).unwrap().cost)?;
        }
        let training = order.kind.strip_prefix("train_");
        let production_control = matches!(
            order.kind.as_str(),
            "rally_move" | "rally_gather" | "clear_rally" | "cancel_production"
        );
        if production_control && (command.units.len() != 1 || command.queued) {
            return Err("Select one HQ; production controls cannot be queued".into());
        }
        if training.is_some() && command.units.len() != 1 {
            return Err("Select one HQ for production".into());
        }
        for id in &command.units {
            let unit = self
                .units
                .iter()
                .find(|unit| unit.id == *id && unit.owner == command.owner)
                .ok_or("Unit is missing or belongs to another player")?;
            if unit.construction_remaining > 0 && order.kind != "cancel_construction" {
                return Err("Building is still under construction".into());
            }
            // The Organic harvester is labour and nothing else. Refused here,
            // server-side and by name, rather than merely left off a command
            // card: a client that asks anyway is told exactly why.
            if unit.kind == "harvester"
                && matches!(order.kind.as_str(), "attack" | "attack_move" | "hold")
            {
                return Err(
                    "Harvesters cannot fight; they gather only. Use soldiers, scouts or siege"
                        .into(),
                );
            }
            if command.queued
                && (unit.queue.len() >= MAX_QUEUE
                    || training.is_some()
                    || matches!(order.kind.as_str(), "stop" | "hold"))
            {
                return Err("Order queue is full or action cannot be queued".into());
            }
            match order.kind.as_str() {
                kind if kind.starts_with("build_") => {
                    if !is_labour(&unit.kind) {
                        return Err("Only labour units can construct buildings".into());
                    }
                }
                "construct" => {
                    if !is_labour(&unit.kind)
                        || !self.units.iter().any(|target| {
                            target.id == order.target
                                && target.owner == unit.owner
                                && target.construction_remaining > 0
                        })
                    {
                        return Err(
                            "Select a labour unit and an unfinished friendly building".into()
                        );
                    }
                }
                "cancel_construction" => {
                    if command.queued
                        || command.units.len() != 1
                        || unit.construction_remaining == 0
                    {
                        return Err("Select one unfinished building".into());
                    }
                }
                "research_weapons" | "research_armor" | "research_logistics" => {
                    if unit.kind != "lab" || command.queued || command.units.len() != 1 {
                        return Err("Research requires one completed lab".into());
                    }
                    if self.units.iter().any(|other| {
                        other.owner == unit.owner
                            && (other.research.contains(&order.kind)
                                || other.production.iter().any(|item| item.kind == order.kind))
                    }) {
                        return Err("Technology already researched or queued".into());
                    }
                    if unit.production.len() >= MAX_QUEUE {
                        return Err("Research queue is full".into());
                    }
                    self.afford(unit.owner, stats(&order.kind).unwrap().cost)?;
                }
                "rally_move" | "rally_gather" | "clear_rally" | "cancel_production" => {
                    if !matches!(unit.kind.as_str(), "hq" | "barracks" | "factory" | "lab") {
                        return Err(
                            "Production controls require an HQ or production building".into()
                        );
                    }
                    if order.kind == "rally_move" {
                        validate_position(order.x, order.y, map.size)?;
                        if !Navigation::new(map, &self.units).free(order.x, order.y) {
                            return Err("Rally destination is obstructed".into());
                        }
                    }
                    if order.kind == "rally_gather"
                        && !self
                            .nodes
                            .iter()
                            .any(|node| node.id == order.target && node.amount > 0)
                    {
                        return Err("Resource node is depleted".into());
                    }
                    if order.kind == "cancel_production" && unit.production.is_empty() {
                        return Err("Production queue is already empty".into());
                    }
                }
                "repair" => {
                    if !is_labour(&unit.kind) {
                        return Err("Only labour units can repair".into());
                    }
                    let target = self
                        .units
                        .iter()
                        .find(|target| {
                            target.id == order.target
                                && target.owner == unit.owner
                                && target.id != unit.id
                        })
                        .ok_or("Select another friendly unit or HQ to repair")?;
                    if target.construction_remaining > 0 {
                        return Err("Resume construction instead of repairing this building".into());
                    }
                    if target.hp >= stats(&target.kind).unwrap().hp {
                        return Err("Target is already fully repaired".into());
                    }
                }
                "move" | "attack_move" => {
                    validate_position(order.x, order.y, map.size)?;
                    if !Navigation::new(map, &self.units).free(order.x, order.y) {
                        return Err("Destination is obstructed".into());
                    }
                    if order.kind == "attack_move" && !fights(&unit.kind) {
                        return Err(
                            "Only fighting units (soldiers, scouts, siege, brood, brutes) can attack-move"
                                .into(),
                        );
                    }
                    if is_building(&unit.kind) {
                        return Err("HQ and buildings cannot move".into());
                    }
                }
                "hold" => {
                    if !fights(&unit.kind) {
                        return Err(
                            "Only fighting units (soldiers, scouts, siege, brood, brutes) can hold position"
                                .into(),
                        );
                    }
                }
                "attack" => {
                    if !fights(&unit.kind) {
                        return Err(
                            "Only fighting units (soldiers, scouts, siege, brood, brutes) can attack"
                                .into(),
                        );
                    }
                    if !self
                        .units
                        .iter()
                        .any(|target| target.id == order.target && target.owner != unit.owner)
                    {
                        return Err("Enemy target no longer exists".into());
                    }
                }
                "gather" => {
                    if !is_labour(&unit.kind) {
                        return Err("Only labour units can gather".into());
                    }
                    if !self
                        .nodes
                        .iter()
                        .any(|node| node.id == order.target && node.amount > 0)
                    {
                        return Err("Resource node is depleted".into());
                    }
                }
                "return" => {
                    if gathers_in_place(&unit.kind) {
                        return Err(
                            "Drifters never carry a load; they credit at the deposit".into()
                        );
                    }
                    if !carries_cargo(&unit.kind) {
                        return Err("Only labour units carry resources".into());
                    }
                }
                "stop" => {
                    if is_building(&unit.kind) {
                        return Err("HQ cannot receive movement orders".into());
                    }
                }
                "train_worker" | "train_drifter" | "train_harvester" | "train_soldier"
                | "train_scout" | "train_siege" => {
                    let trained = training.unwrap();
                    let faction = self.faction(unit.owner);
                    if !producer(trained, &unit.kind, faction) {
                        // A faction asking for another faction's labour is a
                        // different mistake from asking the wrong building for
                        // it, and is reported as one.
                        if let Some(required) = labour_faction(trained) {
                            if required != faction {
                                return Err(format!(
                                    "Only the {required} faction can train a {trained}; you are playing {faction}"
                                ));
                            }
                        }
                        return Err(
                            "Production requires the correct HQ, barracks, or factory".into()
                        );
                    }
                    // A harvester is bought with hub stock and nothing else.
                    if trained == "harvester" && unit.stock == 0 {
                        return Err(format!(
                            "This hub has no harvester stock; it regenerates 1 every {} ticks up to {}",
                            HUB_STOCK_INTERVAL_TICKS, HUB_STOCK_CAP
                        ));
                    }
                    self.afford(unit.owner, stats(trained).unwrap().cost)?;
                    // Temporary units take no supply: they are not population
                    // and never block production.
                    let count = self
                        .units
                        .iter()
                        .filter(|other| {
                            other.owner == unit.owner
                                && !is_building(&other.kind)
                                && !is_temporary(&other.kind)
                        })
                        .count();
                    let pending: usize = self
                        .units
                        .iter()
                        .filter(|other| other.owner == unit.owner)
                        .map(|other| {
                            other
                                .production
                                .iter()
                                .filter(|item| !item.kind.starts_with("research_"))
                                .count()
                        })
                        .sum();
                    if count + pending >= MAX_UNITS {
                        return Err("Unit limit reached (60)".into());
                    }
                    if unit.production.len() >= MAX_QUEUE {
                        return Err("Production queue is full".into());
                    }
                }
                _ => return Err("Unknown order".into()),
            }
        }
        Ok(())
    }

    /// Convenience for the tests in this file, which all play the built-in map.
    #[cfg(test)]
    fn execute(&mut self, command: &Command) -> Result<(), String> {
        self.execute_on(command, crate::maps::default_map())
    }

    fn execute_on(&mut self, command: &Command, map: &MapDefinition) -> Result<(), String> {
        self.validate_on(command, map)?;
        if let Some(kind) = command.order.kind.strip_prefix("build_") {
            let definition = stats(kind).unwrap();
            if !self.charge(command.owner, definition.cost) {
                return Err("Insufficient resources".into());
            }
            let building_id = self.next_id;
            self.spawn(command.owner, kind, command.order.x, command.order.y);
            let site = self.units.last_mut().unwrap();
            site.construction_remaining = definition.training_ticks;
            site.hp = definition.hp / 10;
            let worker = self
                .units
                .iter_mut()
                .find(|unit| unit.id == command.units[0])
                .unwrap();
            worker.order = Order {
                kind: "construct".into(),
                target: building_id,
                ..command.order.clone()
            };
            worker.queue.clear();
            return Ok(());
        }
        if command.order.kind == "cancel_construction" {
            let site = self
                .units
                .iter()
                .find(|unit| unit.id == command.units[0])
                .unwrap();
            let refund = stats(&site.kind)
                .unwrap()
                .cost
                .percent(CONSTRUCTION_CANCEL_REFUND_PERCENT);
            self.credit(command.owner, refund);
            // The site is removed, not killed: cancellation has already paid,
            // so no death refund can follow for the same entity.
            self.units.retain(|unit| unit.id != command.units[0]);
            return Ok(());
        }
        for id in &command.units {
            let unit = self.units.iter_mut().find(|unit| unit.id == *id).unwrap();
            if let Some(kind) = command.order.kind.strip_prefix("train_").or_else(|| {
                command
                    .order
                    .kind
                    .starts_with("research_")
                    .then_some(command.order.kind.as_str())
            }) {
                let definition = stats(kind).unwrap();
                // Hub stock is the harvester's whole price. It is spent here,
                // when the item is queued, exactly as currency is.
                if kind == "harvester" && unit.stock == 0 {
                    return Err("This hub has no harvester stock".into());
                }
                if !self
                    .balances
                    .entry(unit.owner)
                    .or_default()
                    .pay(definition.cost)
                {
                    return Err("Insufficient resources".into());
                }
                if kind == "harvester" {
                    unit.stock -= 1;
                }
                let start = unit
                    .production
                    .last()
                    .map_or(self.tick, |item| item.finish_tick.max(self.tick));
                unit.production.push(Production {
                    kind: kind.into(),
                    finish_tick: start + definition.training_ticks,
                });
            } else if command.order.kind == "cancel_production" {
                // Cancelling an unfinished item returns its full price. The
                // item never became an entity, so no death refund can follow.
                let refund: Cost = unit
                    .production
                    .iter()
                    .map(|item| stats(&item.kind).unwrap().cost)
                    .sum();
                // A cancelled harvester returns the stock it was bought with,
                // to the hub that spent it. Stock over the cap is lost, exactly
                // as regeneration over the cap is.
                let stocked = unit
                    .production
                    .iter()
                    .filter(|item| item.kind == "harvester")
                    .count() as u32;
                unit.stock = unit.stock.saturating_add(stocked).min(HUB_STOCK_CAP);
                self.balances.entry(unit.owner).or_default().credit(refund);
                unit.production.clear();
            } else if command.order.kind == "clear_rally" {
                unit.order = Order::idle();
            } else if command.queued && unit.order.kind != "stop" {
                unit.queue.push(command.order.clone());
            } else {
                unit.order = command.order.clone();
                if unit.order.kind == "attack_move" {
                    unit.order.target = 0;
                }
                unit.returning = command.order.kind == "return";
                if !command.queued {
                    unit.queue.clear();
                }
            }
        }
        Ok(())
    }

    /// Advances one tick on the built-in map.
    pub fn step(&mut self) {
        self.step_on(crate::maps::default_map())
    }

    /// Advances up to `ticks` ticks, handing `sample` a read-only view of the
    /// world at every sample point it crosses.
    ///
    /// This exists because the server does not tick once per wake: it advances
    /// however many whole ticks of wall time have elapsed, up to a catch-up
    /// cap. Sampling after such a loop would date every point it crossed to the
    /// tick the loop happened to stop on, and sampling per wake would produce a
    /// series whose spacing is the scheduler's jitter rather than match time.
    /// Sampling here, between steps, gives each row the tick whose state it
    /// actually holds.
    ///
    /// The early `break` is the other half of that guarantee. `step_on` returns
    /// without advancing once an outcome is set, so a match that ends part way
    /// through a wake would otherwise sit on one tick for the rest of the loop
    /// and fire `sample` again for it on every remaining iteration — several
    /// identical rows for a single sample point. Ending the loop at the end of
    /// the match keeps one point to one row.
    ///
    /// `sample` takes `&World`: there is deliberately no way for a sampler to
    /// reach into the simulation, so recording history cannot perturb it.
    pub fn step_many_on(
        &mut self,
        map: &MapDefinition,
        ticks: u64,
        mut sample: impl FnMut(&World),
    ) {
        for _ in 0..ticks {
            if self.outcome.is_some() {
                break;
            }
            self.step_on(map);
            if crate::is_sample_tick(self.tick) {
                sample(self);
            }
        }
    }

    /// Advances one tick on an explicit map. `map.size` is the only source of
    /// the world extent used for clamping this tick.
    pub fn step_on(&mut self, map: &MapDefinition) {
        if self.outcome.is_some() {
            return;
        }
        self.tick += 1;
        // Temporary units whose time is up are removed — not killed. Before
        // anything reads the world, so an expired unit neither acts nor is
        // targeted on this tick, and never through the death pipeline: no
        // refund, no `lost`, no `killed`, no spawn.
        let tick = self.tick;
        self.units
            .retain(|unit| unit.expires_tick == 0 || unit.expires_tick > tick);
        // Opening stipend: whole material units accumulated against the tick
        // counter, so balances stay integral and replays stay exact.
        let stipend = stipend_payment(self.tick);
        if stipend > 0 {
            for balance in self.balances.values_mut() {
                balance.credit_kind(ResourceKind::Material, stipend);
            }
        }
        self.commands
            .sort_by_key(|command| (command.execute_tick, command.id));
        for index in 0..self.commands.len() {
            if self.commands[index].status != "scheduled"
                || self.commands[index].execute_tick > self.tick
            {
                continue;
            }
            let command = self.commands[index].clone();
            match self.execute_on(&command, map) {
                Ok(()) => self.commands[index].status = "executed".into(),
                Err(reason) => {
                    self.commands[index].status = "rejected".into();
                    self.commands[index].reason = reason;
                }
            }
        }

        self.units.sort_by_key(|unit| unit.id);
        // Before the snapshot, so the field this tick is built from the creep
        // as it stands after this tick's growth or recession.
        self.advance_creep();
        let snapshot = self.units.clone();
        // Copied out so the per-unit loop can read an owner's faction while it
        // holds `self.units` mutably.
        let factions = self.factions.clone();
        let navigation = Navigation::new(map, &snapshot);
        // Zones are rebuilt from the same start-of-tick snapshot every other
        // rule reads, so every unit moving this tick sees one defined field and
        // not a field that shifts as earlier units in the loop move.
        let zones = zones_of(&snapshot, &self.creep);
        // Takes the unit rather than a speed. There is deliberately no way to
        // pass a speed in: that is what stops one movement path from quietly
        // skipping the zone layer.
        let advance = |unit: &mut Entity, target_x: f32, target_y: f32, range: f32| {
            let speed = movement_speed(unit, &zones);
            navigation.advance(&mut unit.x, &mut unit.y, target_x, target_y, speed, range)
        };
        let mut damage = BTreeMap::<u32, i32>::new();
        // The same damage, split by who dealt it: `(target id, attacker slot)`.
        // It is written beside `damage` and never read by anything that decides
        // an outcome, so it cannot move a hit point. Its only consumer is the
        // kill attribution below.
        let mut dealt = BTreeMap::<(u32, u8), i32>::new();
        let mut repairs = BTreeMap::<u32, i32>::new();
        let mut births = Vec::new();
        let mut construction = BTreeMap::<u32, u64>::new();
        let mut discoveries = Vec::new();
        for unit in &mut self.units {
            if unit.construction_remaining > 0 {
                continue;
            }
            let definition = stats(&unit.kind).unwrap();
            let technology = snapshot
                .iter()
                .find(|other| other.owner == unit.owner && other.kind == "hq")
                .map(|hq| &hq.research);
            let has_tech = |kind: &str| {
                technology.is_some_and(|research| research.iter().any(|item| item == kind))
            };
            let logistics = has_tech("research_logistics");
            let capacity = cargo_capacity(&unit.kind, logistics);
            if is_building(&unit.kind) {
                // An Organic hub grows the stock that harvesters are bought
                // with: one point every `HUB_STOCK_INTERVAL_TICKS`, never past
                // `HUB_STOCK_CAP`, and only for an Organic owner. Everyone
                // else's hubs hold 0 forever.
                if is_hub(&unit.kind)
                    && factions.get(&unit.owner).copied().unwrap_or_default() == Faction::Organic
                    && self.tick % HUB_STOCK_INTERVAL_TICKS == 0
                    && unit.stock < HUB_STOCK_CAP
                {
                    unit.stock += 1;
                }
                let exit = [65.0, 100.0, 140.0].into_iter().find_map(|radius| {
                    (0..8).find_map(|index| {
                        let angle = (index as f32 + 2.0) * std::f32::consts::FRAC_PI_4;
                        let point = (unit.x + radius * angle.cos(), unit.y + radius * angle.sin());
                        (navigation.free(point.0, point.1)
                            && !snapshot.iter().any(|other| {
                                !is_building(&other.kind)
                                    && distance(point.0, point.1, other.x, other.y) < 20.0
                            }))
                        .then_some(point)
                    })
                });
                if unit.production.first().is_some_and(|item| {
                    item.finish_tick <= self.tick
                        && (item.kind.starts_with("research_") || exit.is_some())
                }) {
                    let item = unit.production.remove(0);
                    if item.kind.starts_with("research_") {
                        discoveries.push((unit.owner, item.kind));
                    } else {
                        let (spawn_x, spawn_y) = exit.unwrap();
                        births.push((unit.owner, item.kind, spawn_x, spawn_y, unit.order.clone()));
                    }
                }
                if unit.kind != "turret" {
                    continue;
                }
            }
            let mut completed = false;
            match unit.order.kind.as_str() {
                "construct" => {
                    if let Some(target) = snapshot.iter().find(|target| {
                        target.id == unit.order.target
                            && target.owner == unit.owner
                            && target.construction_remaining > 0
                    }) {
                        if advance(unit, target.x, target.y, 60.0) {
                            *construction.entry(target.id).or_default() += 1;
                        }
                    } else {
                        completed = true;
                    }
                }
                "repair" => {
                    if let Some(target) = snapshot
                        .iter()
                        .find(|target| target.id == unit.order.target && target.owner == unit.owner)
                    {
                        let missing = stats(&target.kind).unwrap().hp
                            - target.hp
                            - repairs.get(&target.id).copied().unwrap_or(0);
                        if missing <= 0 {
                            completed = true;
                        } else if advance(
                            unit,
                            target.x,
                            target.y,
                            if is_building(&target.kind) { 55.0 } else { 24.0 },
                        ) && self.tick % 10 == 0
                        {
                            let balance = self.balances.entry(unit.owner).or_default();
                            if balance.pay(REPAIR_COST) {
                                let repaired = missing.min(5);
                                *repairs.entry(target.id).or_default() += repaired;
                                completed = repaired == missing;
                            }
                        }
                    } else {
                        completed = true;
                    }
                }
                "attack_move" => {
                    let target = snapshot
                        .iter()
                        .find(|target| {
                            target.id == unit.order.target
                                && target.owner != unit.owner
                                && distance(unit.x, unit.y, target.x, target.y)
                                    <= definition.range.max(180.0)
                        })
                        .or_else(|| {
                            snapshot
                                .iter()
                                .filter(|target| {
                                    target.owner != unit.owner
                                        && distance(unit.x, unit.y, target.x, target.y)
                                            <= definition.range.max(180.0)
                                })
                                .min_by(|left, right| {
                                    distance(unit.x, unit.y, left.x, left.y)
                                        .total_cmp(&distance(unit.x, unit.y, right.x, right.y))
                                        .then(left.id.cmp(&right.id))
                                })
                        });
                    if let Some(target) = target {
                        unit.order.target = target.id;
                        let stop_range = if line_of_sight(map, unit.x, unit.y, target.x, target.y) {
                            definition.range * 0.9
                        } else {
                            55.0
                        };
                        advance(unit, target.x, target.y, stop_range);
                    } else {
                        unit.order.target = 0;
                        let (destination_x, destination_y) = (unit.order.x, unit.order.y);
                        completed = advance(unit, destination_x, destination_y, 0.0);
                    }
                }
                "move" => {
                    let (destination_x, destination_y) = (unit.order.x, unit.order.y);
                    completed = advance(unit, destination_x, destination_y, 0.0);
                }
                "attack" => {
                    if let Some(target) = snapshot
                        .iter()
                        .find(|target| target.id == unit.order.target)
                    {
                        let stop_range = if line_of_sight(map, unit.x, unit.y, target.x, target.y) {
                            definition.range * 0.9
                        } else {
                            55.0
                        };
                        advance(unit, target.x, target.y, stop_range);
                    } else {
                        completed = true;
                    }
                }
                // Network: no return trip at all. A drifter walks to a deposit
                // once and then credits its owner directly, in small pulses,
                // for as long as it stands there. It never fills cargo and
                // never sets `returning`, so there is no moment when a load is
                // in transit — and no moment when it is anywhere but in the
                // open at a deposit.
                "gather" if gathers_in_place(&unit.kind) => {
                    if !self
                        .nodes
                        .iter()
                        .any(|node| node.id == unit.order.target && node.amount > 0)
                    {
                        match self.nodes.iter().filter(|node| node.amount > 0).min_by(
                            |left, right| {
                                distance(unit.x, unit.y, left.x, left.y)
                                    .total_cmp(&distance(unit.x, unit.y, right.x, right.y))
                                    .then(left.id.cmp(&right.id))
                            },
                        ) {
                            Some(node) => unit.order.target = node.id,
                            None => completed = true,
                        }
                    }
                    let (interval, pulse) = drifter_pulse(logistics);
                    if let Some(node) = self
                        .nodes
                        .iter_mut()
                        .find(|node| node.id == unit.order.target && node.amount > 0)
                    {
                        if advance(unit, node.x, node.y, 28.0) && self.tick % interval == 0
                        {
                            // What leaves the deposit arrives in exactly one
                            // balance, in the deposit's own currency.
                            let amount = pulse.min(node.amount);
                            node.amount -= amount;
                            self.balances
                                .entry(unit.owner)
                                .or_default()
                                .credit_kind(node.kind, amount);
                            // Mined income, so it is history as well as money.
                            self.collected
                                .entry(unit.owner)
                                .or_default()
                                .credit_kind(node.kind, amount);
                        }
                    }
                }
                "gather" | "return" => {
                    if unit.cargo >= capacity {
                        unit.returning = true;
                    }
                    if unit.returning || unit.order.kind == "return" {
                        if let Some(hq) = snapshot
                            .iter()
                            .filter(|target| {
                                target.owner == unit.owner
                                    && is_hub(&target.kind)
                                    && target.construction_remaining == 0
                            })
                            .min_by(|left, right| {
                                distance(unit.x, unit.y, left.x, left.y)
                                    .total_cmp(&distance(unit.x, unit.y, right.x, right.y))
                                    .then(left.id.cmp(&right.id))
                            })
                        {
                            if advance(unit, hq.x, hq.y, 45.0) {
                                self.balances
                                    .entry(unit.owner)
                                    .or_default()
                                    .credit_kind(unit.cargo_kind, unit.cargo);
                                // The load came out of a deposit, so the
                                // delivery is the moment it becomes collected.
                                // Both carriers — worker and harvester — arrive
                                // here; the drifter never does.
                                self.collected
                                    .entry(unit.owner)
                                    .or_default()
                                    .credit_kind(unit.cargo_kind, unit.cargo);
                                unit.cargo = 0;
                                unit.returning = false;
                                completed = unit.order.kind == "return";
                            }
                        } else {
                            completed = true;
                        }
                    } else {
                        if !self
                            .nodes
                            .iter()
                            .any(|node| node.id == unit.order.target && node.amount > 0)
                        {
                            if let Some(node) =
                                self.nodes.iter().filter(|node| node.amount > 0).min_by(
                                    |left, right| {
                                        distance(unit.x, unit.y, left.x, left.y)
                                            .total_cmp(&distance(unit.x, unit.y, right.x, right.y))
                                            .then(left.id.cmp(&right.id))
                                    },
                                )
                            {
                                unit.order.target = node.id;
                            } else if unit.cargo > 0 {
                                unit.returning = true;
                            } else {
                                completed = true;
                            }
                        }
                        if let Some(node) = self
                            .nodes
                            .iter_mut()
                            .find(|node| node.id == unit.order.target && node.amount > 0)
                        {
                            if unit.cargo > 0 && unit.cargo_kind != node.kind {
                                // One load is one currency: deliver first.
                                unit.returning = true;
                            } else if advance(unit, node.x, node.y, 28.0)
                                && self.tick % MINING_PULSE_TICKS == 0
                            {
                                let amount = mining_yield(logistics)
                                    .min(node.amount)
                                    .min(capacity - unit.cargo);
                                node.amount -= amount;
                                unit.cargo_kind = node.kind;
                                unit.cargo += amount;
                                if unit.cargo == capacity || node.amount == 0 {
                                    unit.returning = true;
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
            if definition.damage > 0 && unit.next_attack <= self.tick {
                let target = if matches!(unit.order.kind.as_str(), "attack" | "attack_move") {
                    snapshot
                        .iter()
                        .find(|target| target.id == unit.order.target)
                } else {
                    snapshot
                        .iter()
                        .filter(|target| {
                            target.owner != unit.owner
                                && distance(unit.x, unit.y, target.x, target.y) <= definition.range
                                && line_of_sight(map, unit.x, unit.y, target.x, target.y)
                        })
                        .min_by(|left, right| {
                            distance(unit.x, unit.y, left.x, left.y)
                                .total_cmp(&distance(unit.x, unit.y, right.x, right.y))
                                .then(left.id.cmp(&right.id))
                        })
                };
                if let Some(target) = target.filter(|target| {
                    distance(unit.x, unit.y, target.x, target.y) <= definition.range
                        && line_of_sight(map, unit.x, unit.y, target.x, target.y)
                }) {
                    let armor = snapshot.iter().any(|other| {
                        other.owner == target.owner
                            && other.kind == "hq"
                            && other.research.iter().any(|item| item == "research_armor")
                    });
                    let hit = attack_damage(
                        &unit.kind,
                        &target.kind,
                        definition.damage + if has_tech("research_weapons") { 4 } else { 0 },
                    );
                    let landed = (hit - if armor { 3 } else { 0 }).max(1);
                    *damage.entry(target.id).or_default() += landed;
                    *dealt.entry((target.id, unit.owner)).or_default() += landed;
                    unit.next_attack = self.tick + definition.cooldown;
                    unit.shot_tick = self.tick;
                    unit.shot_x = target.x;
                    unit.shot_y = target.y;
                }
            }
            if completed {
                unit.order = if unit.queue.is_empty() {
                    Order::idle()
                } else {
                    unit.queue.remove(0)
                };
                unit.returning = unit.order.kind == "return";
            }
        }
        for unit in &mut self.units {
            if let Some(work) = construction.get(&unit.id) {
                let definition = stats(&unit.kind).unwrap();
                let before = unit.construction_remaining;
                unit.construction_remaining = before.saturating_sub(*work);
                let total = definition.hp - definition.hp / 10;
                let old_hp =
                    total as u64 * (definition.training_ticks - before) / definition.training_ticks;
                let new_hp = total as u64
                    * (definition.training_ticks - unit.construction_remaining)
                    / definition.training_ticks;
                unit.hp = (unit.hp + (new_hp - old_hp) as i32).min(definition.hp);
            }
            for (owner, research) in &discoveries {
                if unit.owner == *owner && unit.kind == "hq" && !unit.research.contains(research) {
                    unit.research.push(research.clone());
                }
            }
            unit.hp += repairs.get(&unit.id).copied().unwrap_or(0);
            unit.hp -= damage.get(&unit.id).copied().unwrap_or(0);
        }
        // Death is a terminal event that pays once, for army units only. It is
        // measured before the dead are removed, and paid after elimination is
        // resolved, so a refund can never rescue a player who has just lost
        // their last HQ.
        let refunds: Vec<(u8, Cost)> = self
            .units
            .iter()
            .filter(|unit| unit.hp <= 0)
            .map(|unit| (unit.owner, death_refund(&unit.kind)))
            .filter(|(_, refund)| !refund.is_free())
            .collect();
        // The same deaths, read for creep. One of an owner's own units dying on
        // that owner's creep spawns a temporary unit where it fell, chosen by
        // `death_spawn` from its cost; buildings, cheap labour and temporary
        // units spawn nothing, so a spawn can never spawn. Resolved against the
        // start-of-tick field — a creep source killed this same tick still
        // counts — at the dead unit's end-of-tick position, in dead-unit id
        // order (`self.units` was sorted by id and nothing has reordered it).
        // Collected here beside the refunds and, like them, applied only after
        // elimination and only for players still in the match. An army unit
        // gets both its refund and its spawn: the two are independent.
        let spawns: Vec<(u8, &'static str, f32, f32)> = self
            .units
            .iter()
            .filter(|unit| unit.hp <= 0 && zones.spawns_on_death(unit.owner, unit.x, unit.y))
            .filter_map(|unit| death_spawn(&unit.kind).map(|(kind, count)| (unit, kind, count)))
            .flat_map(|(unit, kind, count)| {
                (0..count).map(move |_| (unit.owner, kind, unit.x, unit.y))
            })
            .collect();
        // The same deaths, read a second time for the match history. Hit points
        // only ever fall through `damage` — repair only raises them, and a
        // temporary unit's expiry is a removal at the top of the tick, not a
        // loss of hit points — so an entity at zero was hit on this tick.
        // `dealt` names an attacker for it unless all of that damage came from
        // its own slot, in which case no one is credited with the kill.
        // Otherwise the kill goes to the slot that dealt the most of that
        // tick's damage — the slot that actually shot it — with ties broken
        // on the lower slot so two identical volleys resolve the same way on
        // every machine. What this cannot see is damage from earlier ticks: a
        // unit worn down by one player and finished by another is credited to
        // the finisher, which is the usual last-hit convention and is recorded
        // here as such.
        let casualties: Vec<(u8, Option<u8>, Cost)> = self
            .units
            .iter()
            .filter(|unit| unit.hp <= 0)
            .map(|unit| {
                let killer = dealt
                    .range((unit.id, u8::MIN)..=(unit.id, u8::MAX))
                    .filter(|((_, slot), _)| *slot != unit.owner)
                    .max_by_key(|((_, slot), amount)| (**amount, std::cmp::Reverse(*slot)))
                    .map(|((_, slot), _)| *slot);
                let value = stats(&unit.kind).map_or(Cost::ZERO, |entry| entry.cost);
                (unit.owner, killer, value)
            })
            .filter(|(_, _, value)| !value.is_free())
            .collect();
        // Unconditional, unlike the refunds below: a player being eliminated
        // this very tick still lost the HQ that eliminated them, and a score
        // screen that hid the losing blow would be describing a different
        // match.
        for (owner, killer, value) in casualties {
            let total = self.lost.entry(owner).or_default();
            *total = *total + value;
            if let Some(killer) = killer {
                let total = self.killed.entry(killer).or_default();
                *total = *total + value;
            }
        }
        self.units.retain(|unit| unit.hp > 0);
        let survivors: Vec<u8> = self
            .units
            .iter()
            .filter(|unit| unit.kind == "hq")
            .map(|unit| unit.owner)
            .collect();
        // Units of an eliminated player are cleaned up, not killed: no refund.
        self.units.retain(|unit| survivors.contains(&unit.owner));
        for (owner, refund) in refunds {
            if survivors.contains(&owner) {
                self.credit(owner, refund);
            }
        }
        for (owner, kind, x, y) in spawns {
            if survivors.contains(&owner) {
                self.spawn_temporary(owner, kind, x, y);
            }
        }
        for (owner, kind, x, y, rally) in births {
            if survivors.contains(&owner) {
                self.spawn(owner, &kind, x, y);
                let destination = if rally.kind == "rally_move" {
                    Some(Order {
                        kind: if is_army(&kind) {
                            "attack_move".into()
                        } else {
                            "move".into()
                        },
                        target: 0,
                        ..rally
                    })
                } else if rally.kind == "rally_gather" {
                    self.nodes
                        .iter()
                        .find(|node| node.id == rally.target && node.amount > 0)
                        .map(|node| Order {
                            kind: if is_labour(&kind) {
                                "gather".into()
                            } else {
                                "attack_move".into()
                            },
                            x: node.x,
                            y: node.y,
                            target: if is_labour(&kind) { node.id } else { 0 },
                        })
                } else {
                    None
                };
                if let Some(order) = destination {
                    self.units.last_mut().unwrap().order = order;
                }
            }
        }
        self.separate_units(map.size);
        // Nothing mobile may end a tick standing where it cannot stand: inside
        // terrain, inside a building, or off the map. Movement itself now
        // checks its own landing point, so what is left to catch here is
        // `separate_units` shoving a crowded unit into a wall.
        //
        // The rule used to answer that by restoring the position the unit held
        // at the start of the tick, which is safe but not enough on its own: if
        // whatever produced the illegal position is still true next tick, the
        // unit is put back again, and again, and is frozen for the rest of the
        // match with its cargo aboard — a one-tick geometry glitch turned into
        // a dead economy, silently. So recovery comes first and the freeze is
        // only the last resort: step back if that spot is legal, otherwise walk
        // out to the nearest legal ground.
        for unit in &mut self.units {
            if is_building(&unit.kind) || navigation.free(unit.x, unit.y) {
                continue;
            }
            let previous = snapshot
                .iter()
                .find(|old| old.id == unit.id)
                .map(|old| (old.x, old.y));
            let recovered = previous
                .filter(|(x, y)| navigation.free(*x, *y))
                .or_else(|| navigation.escape(unit.x, unit.y))
                .or(previous);
            if let Some((x, y)) = recovered {
                unit.x = x;
                unit.y = y;
            }
        }
        self.resolve_outcome();
    }

    /// Advances every creep patch one tick and sprouts a patch for each
    /// finished Organic hub that has none. Only hubs make creep (see
    /// `creep_max_radius`).
    ///
    /// A source is *live* while an entity with its id exists and is finished.
    /// Buildings never move and never become unfinished, so a patch never has
    /// to follow its source. Expects `self.units` sorted by id.
    fn advance_creep(&mut self) {
        let tick = self.tick;
        let units = &self.units;
        let live = |source: u32| {
            units
                .binary_search_by_key(&source, |unit| unit.id)
                .is_ok_and(|at| units[at].construction_remaining == 0)
        };
        let mut creep: Vec<CreepPatch> = self
            .creep
            .iter()
            .filter_map(|patch| advance_patch(*patch, live(patch.source), tick))
            .collect();
        for unit in units {
            if unit.construction_remaining > 0
                || self.factions.get(&unit.owner) != Some(&Faction::Organic)
            {
                continue;
            }
            let Some(max) = creep_max_radius(&unit.kind) else {
                continue;
            };
            // `self.creep`, not `creep`: a patch that receded to nothing this
            // tick must not be resprouted. Its source is dead anyway, so it
            // would never reach here — but the check costs nothing.
            if self
                .creep
                .binary_search_by_key(&unit.id, |patch| patch.source)
                .is_err()
            {
                creep.push(CreepPatch::sprouting(unit.id, unit.owner, unit.x, unit.y, max));
            }
        }
        creep.sort_unstable_by_key(|patch| patch.source);
        self.creep = creep;
    }

    pub fn surrender(&mut self, owner: u8) {
        if self.outcome.is_some() {
            return;
        }
        self.units.retain(|unit| unit.owner != owner);
        for command in &mut self.commands {
            if command.owner == owner && command.status == "scheduled" {
                command.status = "cancelled".into();
                command.reason = "Player surrendered".into();
            }
        }
        self.resolve_outcome();
    }

    fn resolve_outcome(&mut self) {
        let survivors: Vec<u8> = self
            .units
            .iter()
            .filter(|unit| unit.kind == "hq")
            .map(|unit| unit.owner)
            .collect();
        if survivors.len() <= 1 {
            self.outcome = Some(survivors.first().map_or(-1, |slot| *slot as i16));
            for command in &mut self.commands {
                if command.status == "scheduled" {
                    command.status = "cancelled".into();
                    command.reason = "Match ended".into();
                }
            }
        }
    }

    /// Pushes overlapping mobiles apart, keeping them inside the *map's*
    /// bounds. `world_size` comes from the frozen map, never from a constant.
    fn separate_units(&mut self, world_size: f32) {
        for left_index in 0..self.units.len() {
            let (left_slice, right_slice) = self.units.split_at_mut(left_index + 1);
            let left = &mut left_slice[left_index];
            if is_building(&left.kind) {
                continue;
            }
            for right in right_slice {
                if is_building(&right.kind) {
                    continue;
                }
                let gap = distance(left.x, left.y, right.x, right.y);
                if gap >= 18.0 {
                    continue;
                }
                let (normal_x, normal_y) = if gap < 0.01 {
                    (1.0, 0.0)
                } else {
                    ((right.x - left.x) / gap, (right.y - left.y) / gap)
                };
                let push = (18.0 - gap) * 0.5;
                let left_held = left.order.kind == "hold";
                let right_held = right.order.kind == "hold";
                let left_push = if left_held {
                    0.0
                } else if right_held {
                    push * 2.0
                } else {
                    push
                };
                let right_push = if right_held {
                    0.0
                } else if left_held {
                    push * 2.0
                } else {
                    push
                };
                left.x = (left.x - normal_x * left_push).clamp(16.0, world_size - 16.0);
                left.y = (left.y - normal_y * left_push).clamp(16.0, world_size - 16.0);
                right.x = (right.x + normal_x * right_push).clamp(16.0, world_size - 16.0);
                right.y = (right.y + normal_y * right_push).clamp(16.0, world_size - 16.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stills the starting labour.
    ///
    /// A match now opens with every labour unit already gathering the nearest
    /// material deposit, which is what a player wants and what the game does.
    /// The tests below measure something else — command delay, credit on
    /// return, refunds, the stipend — and were written against a quiet
    /// opening, so they say so explicitly rather than having mining income
    /// leak into their arithmetic.
    fn idle_labour(world: &mut World) {
        for unit in &mut world.units {
            if is_labour(&unit.kind) {
                unit.order = Order::idle();
            }
        }
    }

    /// A finished barracks for `owner`, and its id.
    ///
    /// Soldiers and scouts are trained here, never at a hub — tests that used
    /// to train an army straight from the HQ need the building that makes one.
    fn barracks_for(world: &mut World, owner: u8) -> u32 {
        let hub = world
            .units
            .iter()
            .find(|unit| unit.owner == owner && unit.kind == "hq")
            .map(|unit| (unit.x, unit.y))
            .unwrap_or((400.0, 400.0));
        world.spawn(owner, "barracks", hub.0, hub.1 - 170.0);
        let built = world.units.last_mut().unwrap();
        built.construction_remaining = 0;
        built.id
    }

    fn command(id: u64, owner: u8, unit: u32, kind: &str, target: u32) -> Command {
        Command {
            id,
            owner,
            units: vec![unit],
            order: Order {
                kind: kind.into(),
                x: 500.0,
                y: 500.0,
                target,
            },
            queued: false,
            execute_tick: 20,
            status: "scheduled".into(),
            reason: String::new(),
        }
    }

    /// One isolated measurement: a fresh world, `towers` built by slot 0, and a
    /// single soldier owned by `owner` walking 300 units east from `start`.
    /// Returns how far it actually got in `ticks`.
    ///
    /// Isolated deliberately. Measuring two soldiers in one world let them
    /// shoot each other, and measuring the same soldier twice started the
    /// second run 255 units further on — outside the field being measured.
    fn travel(owner: u8, start: (f32, f32), towers: &[(f32, f32)], ticks: usize) -> f32 {
        let mut world = World::new_on_with_factions(
            crate::maps::default_map(),
            &[(0, Faction::Industrial), (1, Faction::Network)],
        );
        world.units.clear();
        // Hubs keep the match alive and orders legal; parked far from the lane.
        world.spawn(0, "hq", 200.0, 1300.0);
        world.spawn(1, "hq", 420.0, 1300.0);
        for (x, y) in towers {
            world.spawn(0, "sensor", *x, *y);
        }
        world.spawn(owner, "soldier", start.0, start.1);
        for unit in &mut world.units {
            unit.construction_remaining = 0;
        }
        let soldier = world.units.last().unwrap().id;
        let mut order = command(world.tick, owner, soldier, "move", 0);
        order.order.x = start.0 + 300.0;
        order.order.y = start.1;
        world.execute(&order).unwrap();
        for _ in 0..ticks {
            world.step();
        }
        let now = world.units.iter().find(|unit| unit.id == soldier).unwrap();
        distance(start.0, start.1, now.x, now.y)
    }

    // (600, 300) is clear of every skirmish terrain rect and within the 500
    // build radius of start 0's hub. The tower's radius is 450, so a soldier
    // starting 600 units away is outside the field for the whole run.
    // The soldier starts 100 units off the tower, not on it: unit separation
    // shoves a unit out of a building's footprint, and that push inflated the
    // measured distance regardless of who owned the field.
    const IN_FIELD: (f32, f32) = (700.0, 300.0);
    const TOWER: (f32, f32) = (600.0, 300.0);

    #[test]
    fn an_army_needs_the_building_that_makes_it() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        world.balances.insert(0, Balance::new(3000, 1000));

        // A hub trains labour and nothing else. Without a barracks there is no
        // army at all, so the opening is a real economic decision.
        for kind in ["soldier", "scout"] {
            let refused = world
                .validate(&command(1, 0, 1, &format!("train_{kind}"), 0))
                .unwrap_err();
            assert!(
                refused.contains("HQ") || refused.contains("barracks") || refused.contains("factory"),
                "training a {kind} at a hub should say where it is made: {refused}"
            );
        }

        // A laboratory is behind the same gate.
        // Clear of skirmish terrain and inside the build radius, so the only
        // thing that can refuse it is the prerequisite under test.
        let mut lab = command(2, 0, 2, "build_lab", 0);
        lab.order.x = 600.0;
        lab.order.y = 300.0;
        assert!(
            world.validate(&lab).unwrap_err().contains("barracks"),
            "a lab needs a barracks first"
        );

        // With one finished, both open up.
        let barracks = barracks_for(&mut world, 0);
        world.validate(&command(3, 0, barracks, "train_soldier", 0)).unwrap();
        world.validate(&command(4, 0, barracks, "train_scout", 0)).unwrap();
        world.validate(&lab).unwrap();

        // Siege still needs its own building, not merely a barracks.
        let mut factory = command(5, 0, 2, "build_factory", 0);
        factory.order.x = 300.0;
        factory.order.y = 600.0;
        world.validate(&factory).unwrap();
        assert!(world
            .validate(&command(6, 0, barracks, "train_siege", 0))
            .is_err());
    }

    #[test]
    fn every_faction_opens_with_its_labour_already_mining_the_nearest_material() {
        let map = crate::maps::by_id("crossfire").expect("the match map");
        let world = World::new_on_with_factions(
            map,
            &[
                (0, Faction::Industrial),
                (1, Faction::Network),
                (2, Faction::Organic),
            ],
        );
        let material: Vec<&Node> = world
            .nodes
            .iter()
            .filter(|node| node.kind == ResourceKind::Material)
            .collect();

        for unit in world.units.iter().filter(|unit| is_labour(&unit.kind)) {
            assert_eq!(
                unit.order.kind, "gather",
                "{} #{} opened idle",
                unit.kind, unit.id
            );
            let target = world
                .nodes
                .iter()
                .find(|node| node.id == unit.order.target)
                .expect("the opening target exists");
            assert_eq!(
                target.kind,
                ResourceKind::Material,
                "opening labour must go to material; catalyst is a decision"
            );
            // And it must be the nearest material deposit, not merely one.
            let nearest = material
                .iter()
                .map(|node| distance(unit.x, unit.y, node.x, node.y))
                .fold(f32::MAX, f32::min);
            let chosen = distance(unit.x, unit.y, target.x, target.y);
            assert!(
                (chosen - nearest).abs() < 0.01,
                "{} #{} walks {chosen} to its target when {nearest} was available",
                unit.kind,
                unit.id
            );
        }

        // The soldier is not labour and must not be sent to work.
        for unit in world.units.iter().filter(|unit| unit.kind == "soldier") {
            assert_eq!(unit.order.kind, "stop");
        }
    }

    #[test]
    fn a_sensor_field_speeds_its_owner_and_nobody_else() {
        let plain = travel(0, IN_FIELD, &[], 30);
        let boosted = travel(0, IN_FIELD, &[TOWER], 30);
        let enemy = travel(1, IN_FIELD, &[TOWER], 30);

        assert!(
            boosted > plain * 1.2,
            "inside an owned field {boosted}, with no field {plain}"
        );
        assert!(
            (enemy - plain).abs() < 1.0,
            "an enemy inside the field covered {enemy} against {plain} with no field; the aura must not help them"
        );
    }

    #[test]
    fn a_sensor_field_dies_with_its_source() {
        // Nothing removes a zone: it is derived from the units, so a destroyed
        // source simply is not there on the next rebuild. Measuring with and
        // without the tower is measuring exactly that.
        let with_tower = travel(0, IN_FIELD, &[TOWER], 30);
        let without = travel(0, IN_FIELD, &[], 30);
        assert!(
            with_tower > without * 1.2,
            "with the tower {with_tower}, without it {without}"
        );
    }

    #[test]
    fn overlapping_sensor_fields_take_the_strongest_and_never_stack() {
        let one = travel(0, IN_FIELD, &[TOWER], 30);
        // Two more fields covering the same lane, their bodies well clear of it
        // — a building on the route blocks movement and would read as the
        // opposite of stacking.
        let three = travel(0, IN_FIELD, &[TOWER, (600.0, 500.0), (900.0, 500.0)], 30);
        assert!(
            (three - one).abs() < 1.0,
            "one field gave {one}, three gave {three}; fields must not stack"
        );
    }

    #[test]
    fn a_sensor_zone_changes_movement_and_nothing_else() {
        let template = zone_template("sensor").expect("the sensor projects a zone");
        // Enumerated from ZoneConcept::ALL rather than a hand-written list, so
        // adding a seventh concept makes this fail until it is considered.
        for concept in crate::ZoneConcept::ALL {
            let expected = concept == crate::ZoneConcept::Movement;
            assert_eq!(
                template.participates_in(concept),
                expected,
                "sensor field participation in {concept:?}"
            );
        }

        // Observably too: a target beyond weapon range stays beyond it.
        let mut world = World::new_on_with_factions(
            crate::maps::default_map(),
            &[(0, Faction::Industrial), (1, Faction::Network)],
        );
        world.units.clear();
        world.spawn(0, "hq", 200.0, 1300.0);
        world.spawn(1, "hq", 420.0, 1300.0);
        world.spawn(0, "sensor", TOWER.0, TOWER.1);
        world.spawn(0, "soldier", IN_FIELD.0, IN_FIELD.1);
        let reach = stats("soldier").unwrap().range;
        world.spawn(1, "soldier", IN_FIELD.0 + reach + 60.0, IN_FIELD.1);
        for unit in &mut world.units {
            unit.construction_remaining = 0;
        }
        let before = world
            .units
            .iter()
            .find(|unit| unit.owner == 1 && unit.kind == "soldier")
            .unwrap()
            .hp;
        for _ in 0..40 {
            world.step();
        }
        let after = world
            .units
            .iter()
            .find(|unit| unit.owner == 1 && unit.kind == "soldier")
            .unwrap()
            .hp;
        assert_eq!(after, before, "a movement field must not extend weapon reach");
    }

    // --- Organic creep -------------------------------------------------------

    fn patch_of(world: &World, source: u32) -> Option<CreepPatch> {
        world.creep.iter().find(|patch| patch.source == source).copied()
    }

    fn organic_versus_industrial() -> World {
        let mut world = World::new_on_with_factions(
            crate::maps::default_map(),
            &[(0, Faction::Organic), (1, Faction::Industrial)],
        );
        idle_labour(&mut world);
        world
    }

    #[test]
    fn an_organic_hq_opens_on_full_creep_and_nobody_else_has_any() {
        let mut world = organic_versus_industrial();
        assert_eq!(world.tick, 0);
        let hq = world
            .units
            .iter()
            .find(|unit| unit.owner == 0 && unit.kind == "hq")
            .unwrap()
            .clone();
        assert_eq!(
            world.creep,
            vec![CreepPatch {
                source: hq.id,
                owner: 0,
                x: hq.x,
                y: hq.y,
                radius: crate::CREEP_HQ_RADIUS,
                max_radius: crate::CREEP_HQ_RADIUS,
                lost_tick: 0,
            }],
            "one full patch, the Organic HQ's; the Industrial HQ spreads nothing"
        );
        // The field reads it on the very first tick, as movement (the
        // harvesters' off-creep slow) and death only.
        let field = zones_of(&world.units, &world.creep);
        assert_eq!(field.count_in(crate::ZoneConcept::Death), 1);
        assert_eq!(field.count_in(crate::ZoneConcept::Movement), 1);
        assert_eq!(field.count_in(crate::ZoneConcept::Economy), 0);
        for _ in 0..100 {
            world.step();
        }
        assert_eq!(world.outcome, None);
        assert_eq!(world.creep.len(), 1);
        assert_eq!(patch_of(&world, hq.id).unwrap().radius, 360);
    }

    #[test]
    fn an_outpost_grows_from_60_to_300_in_24_seconds_and_recedes_when_killed() {
        let mut world = organic_versus_industrial();
        for _ in 0..19 {
            world.step();
        }
        // A finished outpost appears during tick 19; the patch sprouts at the
        // top of tick 20. Growth steps land on multiples of 20, so 24 of them
        // — 40 through 500 — take it from 60 to 300: exactly 480 ticks.
        world.spawn(0, "outpost", 600.0, 300.0);
        let outpost = world.units.last().unwrap().id;
        world.step();
        assert_eq!(world.tick, 20);
        let sprouted = patch_of(&world, outpost).expect("sprouts when finished");
        assert_eq!((sprouted.radius, sprouted.max_radius), (60, 300));
        let mut trace = BTreeMap::new();
        while world.tick < 600 {
            world.step();
            trace.insert(world.tick, patch_of(&world, outpost).unwrap().radius);
        }
        assert_eq!(world.outcome, None);
        assert_eq!(trace[&39], 60);
        assert_eq!(trace[&40], 70);
        assert_eq!(trace[&499], 290);
        assert_eq!(trace[&500], 300);
        assert_eq!(trace[&600], 300);
        assert!(trace.values().all(|radius| *radius <= 300));

        // Destroyed after tick 600. The patch notices at the top of 601, holds
        // for 100 ticks, then loses 20 a second: gone on 601 + 100 + 300.
        world.units.retain(|unit| unit.id != outpost);
        world.step();
        assert_eq!(patch_of(&world, outpost).unwrap().lost_tick, 601);
        while world.tick < 1000 {
            world.step();
        }
        assert_eq!(world.outcome, None);
        assert_eq!(patch_of(&world, outpost).unwrap().radius, 20);
        world.step();
        assert_eq!(world.tick, 1001);
        assert_eq!(patch_of(&world, outpost), None, "removed at radius 0");
        // And gone from the field with it, while the HQ's creep stays.
        let field = zones_of(&world.units, &world.creep);
        assert!(field.iter().all(|zone| zone.source != outpost));
        assert_eq!(field.count_in(crate::ZoneConcept::Death), 1);
    }

    #[test]
    fn an_unfinished_organic_building_spreads_no_creep() {
        let mut world = organic_versus_industrial();
        world.spawn(0, "outpost", 600.0, 300.0);
        let site = world.units.last_mut().unwrap();
        site.construction_remaining = 50;
        let site = site.id;
        for _ in 0..40 {
            world.step();
        }
        assert_eq!(patch_of(&world, site), None);
    }

    /// `travel`, for creep: slot 0 is Organic when `creep` is set and
    /// Industrial otherwise, with the same units either way — an outpost at
    /// `TOWER` and a soldier owned by `owner` walking 300 east from `IN_FIELD`.
    /// With creep, the outpost's patch is already at full radius.
    fn travel_over_creep(owner: u8, creep: bool, ticks: usize) -> (f32, World) {
        let first = if creep {
            Faction::Organic
        } else {
            Faction::Industrial
        };
        let mut world = World::new_on_with_factions(
            crate::maps::default_map(),
            &[(0, first), (1, Faction::Network)],
        );
        world.units.clear();
        world.creep.clear();
        world.spawn(0, "hq", 200.0, 1300.0);
        world.spawn(1, "hq", 420.0, 1300.0);
        world.spawn(0, "outpost", TOWER.0, TOWER.1);
        let outpost = world.units.last().unwrap().id;
        if creep {
            world.creep.push(CreepPatch::grown(
                outpost,
                0,
                TOWER.0,
                TOWER.1,
                crate::CREEP_OUTPOST_RADIUS,
            ));
        }
        world.spawn(owner, "soldier", IN_FIELD.0, IN_FIELD.1);
        let soldier = world.units.last().unwrap().id;
        let mut order = command(world.tick, owner, soldier, "move", 0);
        order.order.x = IN_FIELD.0 + 300.0;
        order.order.y = IN_FIELD.1;
        world.execute(&order).unwrap();
        for _ in 0..ticks {
            world.step();
        }
        let now = unit_of(&world, soldier);
        let covered = distance(IN_FIELD.0, IN_FIELD.1, now.x, now.y);
        (covered, world)
    }

    #[test]
    fn creep_changes_neither_a_soldiers_movement_nor_weapon_reach() {
        for owner in [0, 1] {
            let (plain, _) = travel_over_creep(owner, false, 30);
            let (on_creep, world) = travel_over_creep(owner, true, 30);
            // Not vacuous: the soldier really walked on creep the whole way.
            let soldier = world
                .units
                .iter()
                .find(|unit| unit.kind == "soldier")
                .unwrap();
            let field = zones_of(&world.units, &world.creep);
            assert!(
                field.iter().any(|zone| zone.template.name == "creep"
                    && zone.contains(soldier.x, soldier.y)),
                "the soldier ended on creep"
            );
            assert!(plain > 50.0, "the soldier moved at all: {plain}");
            assert_eq!(
                on_creep, plain,
                "slot {owner} covered {on_creep} on creep and {plain} without it"
            );
        }

        // A target just beyond weapon range, both soldiers on full creep.
        let mut world = organic_versus_industrial();
        world.units.clear();
        world.creep.clear();
        world.spawn(0, "hq", 200.0, 1300.0);
        world.spawn(1, "hq", 420.0, 1300.0);
        world.spawn(0, "outpost", TOWER.0, TOWER.1);
        let outpost = world.units.last().unwrap().id;
        world.creep.push(CreepPatch::grown(
            outpost,
            0,
            TOWER.0,
            TOWER.1,
            crate::CREEP_OUTPOST_RADIUS,
        ));
        world.spawn(0, "soldier", IN_FIELD.0, IN_FIELD.1);
        let reach = stats("soldier").unwrap().range;
        world.spawn(1, "soldier", IN_FIELD.0 + reach + 60.0, IN_FIELD.1);
        let target = world.units.last().unwrap().id;
        assert!(
            distance(TOWER.0, TOWER.1, IN_FIELD.0 + reach + 60.0, IN_FIELD.1)
                < crate::CREEP_OUTPOST_RADIUS as f32,
            "the target stands on creep"
        );
        let before = unit_of(&world, target).hp;
        for _ in 0..40 {
            world.step();
        }
        assert_eq!(
            unit_of(&world, target).hp,
            before,
            "creep must not extend weapon reach"
        );
    }

    // --- Organic creep: effects ---------------------------------------------

    /// Both slots Organic, their HQs parked far from the test lane so the match
    /// stays live and orders stay legal. With `creep_owner` set, that slot owns
    /// an outpost at `TOWER` whose patch is already at full radius (300), which
    /// covers the lane from `IN_FIELD` 200 units east. The HQs' own patches
    /// sprout at the lane's far end of the map and never reach it.
    fn creep_arena(creep_owner: Option<u8>) -> World {
        let mut world = World::new_on_with_factions(
            crate::maps::default_map(),
            &[(0, Faction::Organic), (1, Faction::Organic)],
        );
        world.units.clear();
        world.creep.clear();
        world.spawn(0, "hq", 200.0, 1300.0);
        world.spawn(1, "hq", 420.0, 1300.0);
        if let Some(owner) = creep_owner {
            world.spawn(owner, "outpost", TOWER.0, TOWER.1);
            let outpost = world.units.last().unwrap().id;
            world.creep.push(CreepPatch::grown(
                outpost,
                owner,
                TOWER.0,
                TOWER.1,
                crate::CREEP_OUTPOST_RADIUS,
            ));
        }
        world
    }

    /// How far one unit of `kind` owned by `owner` walks east from `IN_FIELD`
    /// in 30 ticks, alone in a `creep_arena(creep_owner)`.
    fn walk(kind: &str, owner: u8, creep_owner: Option<u8>) -> f32 {
        let mut world = creep_arena(creep_owner);
        world.spawn(owner, kind, IN_FIELD.0, IN_FIELD.1);
        let walker = world.units.last().unwrap().id;
        let mut order = command(world.tick, owner, walker, "move", 0);
        order.order.x = IN_FIELD.0 + 300.0;
        order.order.y = IN_FIELD.1;
        world.execute(&order).unwrap();
        for _ in 0..30 {
            world.step();
        }
        assert_eq!(world.outcome, None);
        let now = unit_of(&world, walker);
        distance(IN_FIELD.0, IN_FIELD.1, now.x, now.y)
    }

    #[test]
    fn a_harvester_is_slowed_off_its_owners_creep_and_nothing_else_is() {
        let base = |kind: &str| stats(kind).unwrap().speed / 20.0 * 30.0;
        let close = |left: f32, right: f32| (left - right).abs() < 0.01;

        // The owner's harvester: full speed on its creep, 0.6x off it.
        let on = walk("harvester", 0, Some(0));
        let off = walk("harvester", 0, None);
        assert!(close(on, base("harvester")), "on creep {on}");
        assert!(close(off, base("harvester") * 0.6), "off creep {off}");

        // An enemy harvester walking on slot 0's creep is exactly as slow as
        // it is with no creep anywhere: your creep does nothing for it.
        assert_eq!(walk("harvester", 1, Some(0)), walk("harvester", 1, None));

        // Nothing but a harvester is touched, friend or enemy, on or off.
        for kind in ["soldier", "scout", "worker", "drifter"] {
            for owner in [0, 1] {
                let on = walk(kind, owner, Some(0));
                assert!(close(on, base(kind)), "{kind} of {owner} on creep: {on}");
                assert_eq!(on, walk(kind, owner, None), "{kind} of {owner}");
            }
        }
    }

    /// One unit of `kind` owned by `owner`, at `IN_FIELD` with 1 hit point,
    /// shot dead on tick 1 by a soldier of the other slot 60 units east.
    /// Returns the world after that tick and the victim's id.
    fn death_on(creep_owner: Option<u8>, owner: u8, kind: &str) -> (World, u32) {
        let mut world = creep_arena(creep_owner);
        world.spawn(owner, kind, IN_FIELD.0, IN_FIELD.1);
        let victim = world.units.last_mut().unwrap();
        victim.hp = 1;
        let victim = victim.id;
        world.spawn(1 - owner, "soldier", IN_FIELD.0 + 60.0, IN_FIELD.1);
        world.step();
        assert!(world.units.iter().all(|unit| unit.id != victim), "{kind} died");
        assert_eq!(world.outcome, None);
        (world, victim)
    }

    fn temporaries(world: &World) -> Vec<(u8, String)> {
        world
            .units
            .iter()
            .filter(|unit| crate::is_temporary(&unit.kind))
            .map(|unit| (unit.owner, unit.kind.clone()))
            .collect()
    }

    #[test]
    fn a_soldier_dying_on_its_owners_creep_spawns_one_brood_and_keeps_its_refund() {
        let before = creep_arena(Some(0)).balance(0);
        let (world, victim) = death_on(Some(0), 0, "soldier");
        assert_eq!(temporaries(&world), vec![(0, "brood".to_string())]);
        let brood = world.units.iter().find(|unit| unit.kind == "brood").unwrap();
        assert!(brood.id > victim);
        assert_eq!((brood.x, brood.y), IN_FIELD, "spawned where it fell");
        assert_eq!(brood.expires_tick, 1 + 200);
        assert_eq!(brood.hp, 30);
        assert_eq!(brood.order.kind, "attack_move");
        assert_eq!((brood.order.x, brood.order.y), IN_FIELD);
        // The refund is paid as well: half of 100 material, plus the tick's
        // stipend.
        assert_eq!(
            world.balance(0).material,
            before.material + 50 + crate::stipend_payment(1)
        );
        assert_eq!(world.lost(0), Cost::material(100));
        assert_eq!(world.killed(1), Cost::material(100));
    }

    #[test]
    fn siege_dying_on_creep_spawns_a_brute_and_a_scout_a_brood() {
        let (world, _) = death_on(Some(0), 0, "siege");
        assert_eq!(temporaries(&world), vec![(0, "brute".to_string())]);
        let brute = world.units.iter().find(|unit| unit.kind == "brute").unwrap();
        assert_eq!(brute.expires_tick, 1 + 300);
        let (world, _) = death_on(Some(0), 0, "scout");
        assert_eq!(temporaries(&world), vec![(0, "brood".to_string())]);
    }

    #[test]
    fn nothing_spawns_off_creep_on_enemy_creep_or_from_cheap_or_temporary_or_buildings() {
        // Off creep.
        assert_eq!(temporaries(&death_on(None, 0, "soldier").0), vec![]);
        // Slot 1's soldier dying on slot 0's creep: not its owner's creep.
        assert_eq!(temporaries(&death_on(Some(0), 1, "soldier").0), vec![]);
        // On the owner's own creep, but a kind that spawns nothing.
        for kind in ["brood", "brute", "harvester", "barracks"] {
            assert_eq!(temporaries(&death_on(Some(0), 0, kind).0), vec![], "{kind}");
        }
    }

    #[test]
    fn a_creep_source_killed_on_the_same_tick_still_spawns() {
        let mut world = creep_arena(Some(0));
        let outpost = world.units.last_mut().unwrap();
        assert_eq!(outpost.kind, "outpost");
        outpost.hp = 1;
        let outpost = outpost.id;
        world.spawn(0, "soldier", IN_FIELD.0, IN_FIELD.1);
        world.units.last_mut().unwrap().hp = 1;
        // One shooter for each, neither in range of the other's target.
        world.spawn(1, "soldier", IN_FIELD.0 + 60.0, IN_FIELD.1);
        world.spawn(1, "soldier", TOWER.0, TOWER.1 + 80.0);
        world.step();
        assert!(world.units.iter().all(|unit| unit.id != outpost), "source died");
        assert!(world.units.iter().all(|unit| unit.kind != "soldier" || unit.owner == 1));
        assert_eq!(temporaries(&world), vec![(0, "brood".to_string())]);
    }

    #[test]
    fn an_expired_spawn_is_removed_without_touching_lost_killed_or_balances() {
        let (mut world, _) = death_on(Some(0), 0, "soldier");
        // Clear the killer so nothing else can happen to the brood.
        world.units.retain(|unit| unit.owner != 1 || unit.kind == "hq");
        let lost = world.lost.clone();
        let killed = world.killed.clone();
        let balances = world.balances.clone();
        let tick = world.tick;
        while world.tick < 200 {
            world.step();
        }
        assert_eq!(temporaries(&world).len(), 1, "still alive on tick 200");
        world.step();
        assert_eq!(world.tick, 201);
        assert_eq!(temporaries(&world), vec![], "gone on tick 201");
        assert_eq!(world.lost, lost);
        assert_eq!(world.killed, killed);
        // Only the stipend moved any balance.
        let paid = (crate::stipend_total(201) - crate::stipend_total(tick)) as u32;
        for (owner, balance) in &balances {
            assert_eq!(
                world.balance(*owner),
                Balance::new(balance.material + paid, balance.catalyst)
            );
        }
        assert_eq!(world.outcome, None);
    }

    #[test]
    fn spawned_units_take_no_supply_and_are_not_army() {
        let mut world = creep_arena(None);
        world.balances.insert(0, Balance::new(3000, 1000));
        let barracks = barracks_for(&mut world, 0);
        for index in 0..crate::MAX_UNITS - 1 {
            let (column, row) = ((index % 10) as f32, (index / 10) as f32);
            world.spawn(0, "soldier", 100.0 + column * 30.0, 200.0 + row * 30.0);
        }
        let army = world.army_value(0);
        for index in 0..30 {
            world.spawn_temporary(0, if index % 2 == 0 { "brood" } else { "brute" }, 700.0, 700.0);
        }
        assert_eq!(world.army_value(0), army, "spawns are not army value");
        // 59 soldiers and 30 spawns: one more soldier still fits.
        let train = command(1, 0, barracks, "train_soldier", 0);
        assert_eq!(world.validate(&train), Ok(()));
        world.spawn(0, "soldier", 700.0, 100.0);
        assert!(world.validate(&train).unwrap_err().contains("Unit limit"));
        // And spawns are controllable fighters.
        let brood = world.units.iter().find(|unit| unit.kind == "brood").unwrap().id;
        for kind in ["attack_move", "hold", "move", "stop"] {
            let mut order = command(2, 0, brood, kind, 0);
            order.order.x = 700.0;
            order.order.y = 750.0;
            assert_eq!(world.validate(&order), Ok(()), "{kind}");
        }
    }

    #[test]
    fn a_fight_on_creep_with_spawns_and_expiry_replays_identically() {
        let mut first = creep_arena(Some(0));
        for index in 0..4 {
            first.spawn(0, "soldier", IN_FIELD.0, IN_FIELD.1 + index as f32 * 25.0);
            first.spawn(1, "soldier", IN_FIELD.0 + 90.0, IN_FIELD.1 + index as f32 * 25.0);
        }
        let mut second = first.clone();
        let mut spawned = false;
        for _ in 0..400 {
            first.step();
            second.step();
            spawned |= !temporaries(&first).is_empty();
        }
        assert!(spawned, "the fight spawned something on creep");
        assert_eq!(temporaries(&first), vec![], "and every spawn expired or died");
        assert_eq!(first, second);
    }

    #[test]
    fn only_the_industrial_faction_may_build_a_sensor() {
        for (faction, allowed) in [
            (Faction::Industrial, true),
            (Faction::Network, false),
            (Faction::Organic, false),
        ] {
            let mut world =
                World::new_on_with_factions(
                    crate::maps::default_map(),
                    &[(0, faction), (1, Faction::Industrial)],
                );
            world.balances.insert(0, Balance::new(3000, 1000));
            let labour = world
                .units
                .iter()
                .find(|unit| is_labour(&unit.kind) && unit.owner == 0)
                .expect("a starting labour unit")
                .id;
            let mut build = command(world.tick, 0, labour, "build_sensor", 0);
            build.order.x = 600.0;
            build.order.y = 300.0;
            let result = world.validate(&build);
            assert_eq!(result.is_ok(), allowed, "{faction} sensor: {result:?}");
            if let Err(reason) = result {
                assert!(
                    reason.contains("industrial") && reason.contains("sensor"),
                    "refusal should name the owning faction: {reason}"
                );
            }
        }
    }

    #[test]
    fn combined_arms_base_building_and_research_reach_victory() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        world.balances.insert(0, Balance::new(3000, 1000));
        for (kind, x, y) in [
            ("barracks", 440.0, 220.0),
            ("factory", 220.0, 440.0),
            ("lab", 440.0, 440.0),
            ("outpost", 600.0, 220.0),
            ("turret", 220.0, 600.0),
        ] {
            let mut build = command(world.tick, 0, 2, &format!("build_{kind}"), 0);
            build.order.x = x;
            build.order.y = y;
            world.execute(&build).unwrap();
            for _ in 0..400 {
                world.step();
            }
            assert!(
                world
                    .units
                    .iter()
                    .any(|unit| unit.kind == kind && unit.construction_remaining == 0),
                "{kind} did not complete"
            );
        }
        let factory = world
            .units
            .iter()
            .find(|unit| unit.kind == "factory")
            .unwrap()
            .id;
        let barracks = world
            .units
            .iter()
            .find(|unit| unit.kind == "barracks")
            .unwrap()
            .id;
        let lab = world
            .units
            .iter()
            .find(|unit| unit.kind == "lab")
            .unwrap()
            .id;
        for kind in ["weapons", "armor", "logistics"] {
            world
                .execute(&command(world.tick, 0, lab, &format!("research_{kind}"), 0))
                .unwrap();
        }
        for _ in 0..3 {
            world
                .execute(&command(world.tick, 0, factory, "train_siege", 0))
                .unwrap();
            world
                .execute(&command(world.tick, 0, barracks, "train_soldier", 0))
                .unwrap();
        }
        for _ in 0..900 {
            world.step();
        }
        assert_eq!(world.units[0].research.len(), 3);
        assert_eq!(
            world
                .units
                .iter()
                .filter(|unit| unit.kind == "siege")
                .count(),
            3
        );
        world.spawn(1, "turret", 1250.0, 1380.0);
        world.spawn(1, "turret", 1380.0, 1250.0);
        let mut assault = command(world.tick, 0, 4, "attack_move", 0);
        assault.units = world
            .units
            .iter()
            .filter(|unit| unit.owner == 0 && is_army(&unit.kind))
            .map(|unit| unit.id)
            .collect();
        assault.order.x = 1300.0;
        assault.order.y = 1300.0;
        world.execute(&assault).unwrap();
        for _ in 0..5000 {
            world.step();
            if world.outcome.is_some() {
                break;
            }
        }
        assert_eq!(world.outcome, Some(0));
        assert!(world.units.iter().all(|unit| unit.owner == 0));
        // Spent 1775 material and 400 catalyst on five buildings, three
        // technologies, three siege and three soldiers, from 3000 and 1000.
        // The material surplus over 1225 is the opening stipend accumulated up
        // to the tick the match ended; the catalyst total shows the whole army
        // survived, so no death refund was paid.
        assert_eq!(world.balances[&0], Balance::new(1658, 600));
        assert_eq!(
            world.balances[&0].material as u64,
            3000 - 1775 + crate::stipend_total(world.tick)
        );
    }

    #[test]
    fn siege_repositions_when_cover_blocks_a_target_in_range() {
        let mut world = World::new(&[0, 1]);
        world.spawn(0, "siege", 540.0, 680.0);
        let siege = world.next_id - 1;
        world.units[5].x = 740.0;
        world.units[5].y = 680.0;
        world.execute(&command(1, 0, siege, "attack", 6)).unwrap();
        for _ in 0..300 {
            world.step();
        }
        assert!(!world.units.iter().any(|unit| unit.id == 6));
        assert!(world.units.iter().find(|unit| unit.id == siege).unwrap().y != 680.0);
    }

    #[test]
    fn construction_requires_labor_can_resume_and_unlocks_units() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        world.balances.insert(0, Balance::new(1000, 0));
        let mut build = command(1, 0, 2, "build_barracks", 0);
        build.order.x = 440.0;
        build.order.y = 220.0;
        world.commands.push(build.clone());
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.units.len(), 8);
        world.step();
        // 1000 - 150 for the barracks, + 3 stipend material paid by tick 20.
        assert_eq!(world.balances[&0], Balance::new(853, 0));
        assert!(world.validate(&build).is_err());
        let site = world.next_id - 1;
        assert!(world
            .validate(&command(2, 0, site, "train_scout", 0))
            .is_err());
        world.execute(&command(3, 0, 2, "stop", 0)).unwrap();
        for _ in 0..200 {
            world.step();
        }
        assert!(
            world
                .units
                .iter()
                .find(|unit| unit.id == site)
                .unwrap()
                .construction_remaining
                > 0
        );
        world.execute(&command(4, 0, 2, "construct", site)).unwrap();
        for _ in 0..250 {
            world.step();
        }
        assert_eq!(
            world
                .units
                .iter()
                .find(|unit| unit.id == site)
                .unwrap()
                .construction_remaining,
            0
        );
        world
            .execute(&command(5, 0, site, "train_scout", 0))
            .unwrap();
        for _ in 0..70 {
            world.step();
        }
        assert!(world.units.iter().any(|unit| unit.kind == "scout"));
        // 1000 - 150 barracks - 80 scout + 90 stipend material by tick 540.
        assert_eq!(world.balances[&0], Balance::new(860, 0));
        assert_eq!(world.tick, 540);
    }

    #[test]
    fn construction_refunds_once_and_research_is_unique_and_persistent() {
        let mut world = World::new(&[0, 1]);
        // A laboratory needs a finished barracks before anything else
        // about it can be tested.
        barracks_for(&mut world, 0);
        world.balances.insert(0, Balance::new(1000, 200));
        world.execute(&command(1, 0, 2, "build_lab", 0)).unwrap();
        let site = world.next_id - 1;
        world
            .execute(&command(2, 0, site, "cancel_construction", 0))
            .unwrap();
        // The lab costs 150 material and 50 catalyst; cancelling returns 75% of
        // each, rounded down independently: 112 and 37.
        assert_eq!(world.balances[&0], Balance::new(962, 187));
        assert!(world
            .execute(&command(3, 0, site, "cancel_construction", 0))
            .is_err());
        world.spawn(0, "lab", 440.0, 220.0);
        let lab = world.next_id - 1;
        world
            .execute(&command(4, 0, lab, "research_weapons", 0))
            .unwrap();
        assert!(world
            .validate(&command(5, 0, lab, "research_weapons", 0))
            .is_err());
        for _ in 0..300 {
            world.step();
        }
        assert!(world.units[0].research.contains(&"research_weapons".into()));
        assert!(world
            .validate(&command(6, 0, lab, "research_weapons", 0))
            .is_err());
        assert!(!world
            .units
            .iter()
            .any(|unit| unit.kind == "research_weapons"));
    }

    #[test]
    fn outposts_receive_cargo_and_turrets_fire_without_moving() {
        let mut world = World::new(&[0, 1]);
        world.spawn(0, "outpost", 600.0, 200.0);
        world.units[1].x = 650.0;
        world.units[1].y = 200.0;
        world.units[1].cargo = 25;
        world.units[1].order.kind = "return".into();
        world.spawn(0, "turret", 700.0, 200.0);
        world.units[5].x = 850.0;
        world.units[5].y = 200.0;
        for _ in 0..5 {
            world.step();
        }
        assert_eq!(world.balances[&0], Balance::new(275, 0));
        assert_eq!(world.units[5].hp, 44);
        assert_eq!(
            (world.units.last().unwrap().x, world.units.last().unwrap().y),
            (700.0, 200.0)
        );
    }

    #[test]
    fn attack_move_waits_engages_and_resumes_after_combat() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        world
            .units
            .retain(|unit| unit.kind == "hq" || unit.id == 4 || unit.id == 6);
        let enemy = world.units.iter_mut().find(|unit| unit.id == 6).unwrap();
        enemy.x = 430.0;
        enemy.y = 275.0;
        enemy.hp = 18;
        world.commands.push(command(1, 0, 4, "attack_move", 0));
        for _ in 0..19 {
            world.step();
        }
        let soldier = world.units.iter().find(|unit| unit.id == 4).unwrap();
        assert_eq!((soldier.x, soldier.y), (275.0, 275.0));
        world.step();
        let soldier = world.units.iter().find(|unit| unit.id == 4).unwrap();
        assert_eq!(soldier.order.target, 6);
        assert_eq!(soldier.y, 275.0);
        for _ in 0..120 {
            world.step();
        }
        assert!(!world.units.iter().any(|unit| unit.id == 6));
        let soldier = world.units.iter().find(|unit| unit.id == 4).unwrap();
        assert_eq!((soldier.x, soldier.y), (500.0, 500.0));
        assert_eq!(soldier.order.kind, "stop");
    }

    #[test]
    fn hold_fires_without_pursuit_or_collision_displacement() {
        let mut world = World::new(&[0, 1]);
        world.units[3].order.kind = "hold".into();
        world.units[1].x = 275.0;
        world.units[1].y = 275.0;
        world.units[5].x = 375.0;
        world.units[5].y = 275.0;
        world.step();
        assert_eq!((world.units[3].x, world.units[3].y), (275.0, 275.0));
        assert_eq!(world.units[5].hp, 42);
        world.units[5].x = 425.0;
        for _ in 0..20 {
            world.step();
        }
        assert_eq!((world.units[3].x, world.units[3].y), (275.0, 275.0));
        assert_eq!(world.units[5].hp, 42);
        assert!(world.validate(&command(1, 0, 2, "hold", 0)).is_err());
        assert!(world.validate(&command(1, 0, 2, "attack_move", 0)).is_err());
    }

    #[test]
    fn rally_is_delayed_and_new_units_inherit_it_without_moving_hq() {
        let mut world = World::new(&[0, 1]);
        world.commands.push(command(1, 0, 1, "rally_gather", 1));
        world.commands.push(command(2, 0, 1, "train_worker", 0));
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.units[0].order.kind, "stop");
        world.step();
        assert_eq!(world.units[0].order.kind, "rally_gather");
        for _ in 20..80 {
            world.step();
        }
        assert_eq!(world.units.last().unwrap().order.kind, "gather");
        assert_eq!(world.units.last().unwrap().order.target, 1);
        assert_eq!((world.units[0].x, world.units[0].y), (220.0, 220.0));
        let mut clear = command(3, 0, 1, "clear_rally", 0);
        clear.execute_tick = world.tick + 20;
        world.commands.push(clear);
        for _ in 0..20 {
            world.step();
        }
        assert_eq!(world.units[0].order.kind, "stop");
    }

    #[test]
    fn cancel_refunds_only_unfinished_production_once_and_preserves_rally() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        let barracks = barracks_for(&mut world, 0);
        world.commands.push(command(1, 0, 1, "train_worker", 0));
        world.commands.push(command(2, 0, barracks, "train_soldier", 0));
        // The rally belongs to whatever produces, and soldiers come from the
        // barracks now, so that is where the rally under test lives.
        world.commands.push(command(3, 0, barracks, "rally_move", 0));
        for _ in 0..80 {
            world.step();
        }
        // 250 - 50 worker - 100 soldier + 13 stipend material by tick 80.
        assert_eq!(world.balances[&0], Balance::new(113, 0));
        let mut cancel = command(4, 0, barracks, "cancel_production", 0);
        cancel.execute_tick = 100;
        world.commands.push(cancel.clone());
        cancel.id = 5;
        world.commands.push(cancel);
        for _ in 80..99 {
            world.step();
        }
        assert_eq!(world.balances[&0], Balance::new(116, 0));
        world.step();
        // Only the unfinished soldier is refunded, and only by the first of the
        // two identical cancel commands.
        assert_eq!(world.balances[&0], Balance::new(216, 0));
        let producer = world.units.iter().find(|unit| unit.id == barracks).unwrap();
        assert!(producer.production.is_empty());
        assert_eq!(producer.order.kind, "rally_move", "cancelling keeps the rally");
        assert_eq!(world.commands.last().unwrap().status, "rejected");
        // hq, two labour, the starting soldier, the trained worker, and the
        // barracks the soldier was being made in.
        assert_eq!(world.units.iter().filter(|unit| unit.owner == 0).count(), 6);
    }

    #[test]
    fn repair_waits_costs_ore_and_never_overheals_with_multiple_workers() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        world.units[0].hp = 1194;
        world.units[1].x = 250.0;
        world.units[2].y = 250.0;
        world.commands.push(command(1, 0, 2, "repair", 1));
        world.commands.push(command(2, 0, 3, "repair", 1));
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.units[0].hp, 1194);
        assert_eq!(world.balances[&0], Balance::new(253, 0));
        world.step();
        assert_eq!(world.units[0].hp, 1200);
        // Two workers each pay one material; repair never touches catalyst.
        assert_eq!(world.balances[&0], Balance::new(251, 0));
        for _ in 0..20 {
            world.step();
        }
        assert_eq!(world.balances[&0], Balance::new(254, 0));
        assert!(world.validate(&command(3, 0, 2, "repair", 5)).is_err());
        assert!(world.validate(&command(3, 0, 4, "repair", 1)).is_err());
        assert!(world.validate(&command(3, 0, 2, "repair", 2)).is_err());
    }

    #[test]
    fn repairs_pause_without_funds_and_stop_when_target_disappears() {
        let mut world = World::new(&[0, 1]);
        world.units[3].hp = 100;
        world.units[1].x = 275.0;
        world.units[1].y = 250.0;
        // Past the opening stipend, so an empty balance really stays empty.
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.balances.insert(0, Balance::default());
        world.commands.push(command(1, 0, 2, "repair", 4));
        for _ in 0..40 {
            world.step();
        }
        assert_eq!(world.units[3].hp, 100);
        assert_eq!(world.units[1].order.kind, "repair");
        world.balances.insert(0, Balance::new(1, 0));
        for _ in 0..10 {
            world.step();
        }
        assert_eq!(world.units[3].hp, 105);
        assert_eq!(world.balances[&0], Balance::default());
        world.units.retain(|unit| unit.id != 4);
        world.step();
        assert_eq!(world.units[1].order.kind, "stop");
    }

    #[test]
    fn bootstrap_is_independent_of_database_iteration_order() {
        assert_eq!(World::new(&[3, 1, 0, 2]), World::new(&[0, 1, 2, 3]));
    }

    #[test]
    fn movement_waits_until_execution_tick() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        let start = world.units[1].clone();
        world.commands.push(command(1, 0, start.id, "move", 0));
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.units[1], start);
        world.step();
        assert!(world.units[1].x > start.x);
        assert_eq!(world.commands[0].status, "executed");
    }

    #[test]
    fn rejects_foreign_units_and_unknown_actions() {
        let world = World::new(&[0, 1]);
        assert!(world.validate(&command(1, 1, 2, "move", 0)).is_err());
        assert!(world.validate(&command(1, 0, 2, "teleport", 0)).is_err());
        assert!(world.validate(&command(1, 0, 1, "train_hq", 0)).is_err());
        assert!(world.validate(&command(1, 0, 2, "attack", 5)).is_err());
    }

    #[test]
    fn production_is_delayed_serial_and_resource_limited() {
        let mut world = World::new(&[0, 1]);
        let barracks = barracks_for(&mut world, 0);
        for id in 1..=3 {
            world.commands.push(command(id, 0, barracks, "train_soldier", 0));
        }
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.balances[&0], Balance::new(253, 0));
        world.step();
        // Two soldiers at 100 material each; the third is refused.
        assert_eq!(world.balances[&0], Balance::new(53, 0));
        assert_eq!(world.commands[2].status, "rejected");
        assert!(world.commands[2].reason.contains("Insufficient material"));
        // The queue is on the barracks now, not on the hub: a hub trains labour.
        let queue = |world: &World| {
            world
                .units
                .iter()
                .find(|unit| unit.id == barracks)
                .unwrap()
                .production
                .clone()
        };
        assert_eq!(queue(&world)[0].finish_tick, 120);
        assert_eq!(queue(&world)[1].finish_tick, 220);
        for _ in 20..120 {
            world.step();
        }
        assert_eq!(
            world
                .units
                .iter()
                .filter(|unit| unit.owner == 0 && unit.kind == "soldier")
                .count(),
            2
        );
    }

    #[test]
    fn workers_credit_only_after_returning_cargo() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        world.units[1].x = 360.0;
        world.units[1].y = 335.0;
        world.commands.push(command(1, 0, 2, "gather", 1));
        for _ in 0..60 {
            world.step();
        }
        // 10 stipend material by tick 60; the load itself is not credited yet.
        assert_eq!(world.balances[&0], Balance::new(260, 0));
        assert_eq!(world.units[1].cargo, 25);
        assert_eq!(world.units[1].cargo_kind, ResourceKind::Material);
        for _ in 0..50 {
            world.step();
        }
        assert_eq!(world.balances[&0], Balance::new(293, 0));
        assert_eq!(world.units[1].cargo, 0);
    }

    /// The live failure, end to end and through the real tick: a loaded worker
    /// parked on the clearance margin of the centre terrain used to walk into
    /// that margin, be put back by the end-of-tick rule, and repeat that for
    /// the rest of the match — cargo aboard, economy silently dead.
    #[test]
    fn a_loaded_worker_on_a_terrain_corner_still_delivers() {
        let mut world = World::new(&[0, 1]);
        let before = world.balances[&0].material;
        world.units[1].x = 551.0;
        world.units[1].y = 736.0;
        world.units[1].cargo = 25;
        world.units[1].cargo_kind = ResourceKind::Material;
        world.units[1].returning = true;
        world.units[1].order = Order {
            kind: "return".into(),
            x: 0.0,
            y: 0.0,
            target: 0,
        };
        for _ in 0..400 {
            world.step();
            if world.units[1].cargo == 0 {
                break;
            }
        }
        assert_eq!(world.units[1].cargo, 0, "worker never reached its hub");
        assert!(world.balances[&0].material >= before + 25);
        assert!(distance(world.units[1].x, world.units[1].y, 220.0, 220.0) < 50.0);
    }

    #[test]
    fn simultaneous_hq_deaths_are_a_draw() {
        let mut world = World::new(&[0, 1]);
        world.units[0].hp = 18;
        world.units[4].hp = 18;
        world.units[3].x = 1370.0;
        world.units[3].y = 1370.0;
        world.units[3].order = Order {
            kind: "attack".into(),
            x: 0.0,
            y: 0.0,
            target: 5,
        };
        world.units[7].x = 230.0;
        world.units[7].y = 230.0;
        world.units[7].order = Order {
            kind: "attack".into(),
            x: 0.0,
            y: 0.0,
            target: 1,
        };
        world.step();
        assert_eq!(world.outcome, Some(-1));
        assert!(world.units.is_empty());
    }

    #[test]
    fn four_player_match_continues_after_one_elimination() {
        let mut world = World::new(&[0, 1, 2, 3]);
        world.units[0].hp = 0;
        world.step();
        assert_eq!(world.outcome, None);
        assert!(!world.units.iter().any(|unit| unit.owner == 0));
    }

    #[test]
    fn queued_orders_do_not_activate_early_and_stop_clears_them() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        let mut queued = command(1, 0, 2, "move", 0);
        queued.queued = true;
        world.commands.push(queued);
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.units[1].order.kind, "stop");
        world.step();
        let mut stop = command(2, 0, 2, "stop", 0);
        stop.execute_tick = 40;
        world.commands.push(stop);
        for _ in 20..40 {
            world.step();
        }
        assert_eq!(world.units[1].order.kind, "stop");
        assert!(world.units[1].queue.is_empty());
    }

    #[test]
    fn surrender_never_advances_time_or_executes_orders() {
        let mut world = World::new(&[0, 1, 2, 3]);
        world.commands.push(command(1, 0, 2, "move", 0));
        world.surrender(0);
        assert_eq!(world.tick, 0);
        assert_eq!(world.outcome, None);
        assert_eq!(world.commands[0].status, "cancelled");
        assert!(!world.units.iter().any(|unit| unit.owner == 0));
        world.surrender(1);
        world.surrender(2);
        assert_eq!(world.outcome, Some(3));
    }

    #[test]
    fn disappeared_targets_are_rejected_at_execution() {
        let mut world = World::new(&[0, 1]);
        world.commands.push(command(1, 0, 4, "attack", 6));
        assert!(world.validate(&world.commands[0]).is_ok());
        world.units.retain(|unit| unit.id != 6);
        for _ in 0..20 {
            world.step();
        }
        assert_eq!(world.commands[0].status, "rejected");
        assert_eq!(
            world
                .units
                .iter()
                .find(|unit| unit.id == 4)
                .unwrap()
                .order
                .kind,
            "stop"
        );
    }

    #[test]
    fn production_and_order_queues_are_bounded() {
        let mut world = World::new(&[0, 1]);
        while world
            .units
            .iter()
            .filter(|unit| unit.owner == 0 && unit.kind != "hq")
            .count()
            < MAX_UNITS
        {
            world.spawn(0, "worker", 600.0, 600.0);
        }
        assert!(world
            .validate(&command(1, 0, 1, "train_worker", 0))
            .is_err());
        world.units[1].queue = vec![Order::idle(); MAX_QUEUE];
        let mut queued = command(2, 0, 2, "move", 0);
        queued.queued = true;
        assert!(world.validate(&queued).is_err());
    }

    #[test]
    fn soldiers_pursue_and_destroy_a_target_hq() {
        let mut world = World::new(&[0, 1]);
        world
            .units
            .retain(|unit| unit.owner == 0 || unit.kind == "hq");
        world.commands.push(command(1, 0, 4, "attack", 5));
        for _ in 0..1500 {
            world.step();
        }
        assert_eq!(world.outcome, Some(0));
        assert!(world.units.iter().all(|unit| unit.owner == 0));
    }

    #[test]
    fn replay_and_twenty_minute_soak_remain_deterministic() {
        // One slot of each gather model, and an Organic slot so creep is
        // carried through the whole soak and compared with the rest.
        let mut first = World::new_on_with_factions(
            crate::maps::default_map(),
            &[
                (0, Faction::Industrial),
                (1, Faction::Network),
                (2, Faction::Organic),
                (3, Faction::Industrial),
            ],
        );
        for slot in 0..4 {
            first.commands.push(command(
                slot as u64 + 1,
                slot,
                slot as u32 * 4 + 2,
                "gather",
                slot as u32 + 1,
            ));
        }
        let mut second = first.clone();
        for _ in 0..24000 {
            first.step();
            second.step();
        }
        assert_eq!(first, second);
        assert!(
            first.creep.iter().any(|patch| patch.owner == 2),
            "the Organic slot's creep survived the soak and was compared"
        );
        assert!(first
            .units
            .iter()
            .all(|unit| unit.x.is_finite() && unit.y.is_finite()));
        // Each currency is conserved on its own: nothing converts, nothing
        // leaks, and the only new money is the opening stipend. 24000 material
        // in six deposits plus 4 x 250 starting material plus 4 x 450 stipend;
        // 2400 catalyst in the two central sites, none of it spent here.
        let held = |kind: ResourceKind| -> u64 {
            first
                .balances
                .values()
                .map(|balance| balance.amount(kind) as u64)
                .sum::<u64>()
                + first
                    .nodes
                    .iter()
                    .filter(|node| node.kind == kind)
                    .map(|node| node.amount as u64)
                    .sum::<u64>()
                + first
                    .units
                    .iter()
                    .filter(|unit| unit.cargo_kind == kind)
                    .map(|unit| unit.cargo as u64)
                    .sum::<u64>()
        };
        assert_eq!(crate::stipend_total(first.tick), 450);
        assert_eq!(held(ResourceKind::Material), 24000 + 4 * 250 + 4 * 450);
        assert_eq!(held(ResourceKind::Catalyst), 2400);
    }

    // --- dual-currency economy ---------------------------------------------

    #[test]
    fn a_two_currency_price_is_refused_when_only_one_currency_covers_it() {
        let mut world = World::new(&[0, 1]);
        world.spawn(0, "factory", 440.0, 220.0);
        let factory = world.next_id - 1;

        // Material to spare, no catalyst at all: siege costs 150 and 50.
        world.balances.insert(0, Balance::new(10_000, 0));
        let refusal = world
            .validate(&command(1, 0, factory, "train_siege", 0))
            .unwrap_err();
        assert!(refusal.contains("Insufficient catalyst"), "{refusal}");
        assert_eq!(world.balances[&0], Balance::new(10_000, 0));

        // Catalyst to spare, one material short: refused the other way round,
        // and again nothing is debited.
        world.balances.insert(0, Balance::new(149, 10_000));
        let refusal = world
            .validate(&command(2, 0, factory, "train_siege", 0))
            .unwrap_err();
        assert!(refusal.contains("Insufficient material"), "{refusal}");
        assert_eq!(world.balances[&0], Balance::new(149, 10_000));

        // Exactly enough of both: accepted, and both are charged.
        world.balances.insert(0, Balance::new(150, 50));
        world
            .execute(&command(3, 0, factory, "train_siege", 0))
            .unwrap();
        assert_eq!(world.balances[&0], Balance::default());
    }

    #[test]
    fn a_catalyst_only_shortfall_also_blocks_buildings_and_research() {
        let mut world = World::new(&[0, 1]);
        // A laboratory needs a finished barracks before anything else
        // about it can be tested.
        barracks_for(&mut world, 0);
        world.balances.insert(0, Balance::new(10_000, 49));
        let mut build = command(1, 0, 2, "build_lab", 0);
        build.order.x = 440.0;
        build.order.y = 220.0;
        assert!(world.validate(&build).unwrap_err().contains("catalyst"));
        world.balances.insert(0, Balance::new(10_000, 50));
        world.execute(&build).unwrap();
        assert_eq!(world.balances[&0], Balance::new(9850, 0));

        world.spawn(0, "lab", 600.0, 220.0);
        let lab = world.next_id - 1;
        assert!(world
            .validate(&command(2, 0, lab, "research_weapons", 0))
            .unwrap_err()
            .contains("catalyst"));
    }

    #[test]
    fn harvesting_a_catalyst_deposit_credits_catalyst_and_not_material() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.balances.insert(0, Balance::default());
        let catalyst = world
            .nodes
            .iter()
            .find(|node| node.kind == ResourceKind::Catalyst)
            .unwrap()
            .clone();
        world.units[1].x = catalyst.x;
        world.units[1].y = catalyst.y + 40.0;
        world.commands.push(command(1, 0, 2, "gather", catalyst.id));
        for _ in 0..40 {
            world.step();
        }
        let worker = world.units.iter().find(|unit| unit.id == 2).unwrap();
        assert!(worker.cargo > 0);
        assert_eq!(worker.cargo_kind, ResourceKind::Catalyst);
        assert_eq!(
            world.balances[&0],
            Balance::default(),
            "cargo is credited on delivery, not on pickup"
        );
        for _ in 0..400 {
            world.step();
        }
        let balance = world.balances[&0];
        assert_eq!(balance.material, 0, "a catalyst site never yields material");
        assert!(balance.catalyst >= 25, "{balance:?}");
        assert!(
            world
                .nodes
                .iter()
                .find(|node| node.id == catalyst.id)
                .unwrap()
                .amount
                < catalyst.amount
        );
    }

    #[test]
    fn a_worker_never_mixes_currencies_in_one_load() {
        let mut world = World::new(&[0, 1]);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.balances.insert(0, Balance::default());
        let catalyst = world
            .nodes
            .iter()
            .find(|node| node.kind == ResourceKind::Catalyst)
            .unwrap()
            .clone();
        let worker = world.units.iter_mut().find(|unit| unit.id == 2).unwrap();
        worker.x = catalyst.x;
        worker.y = catalyst.y + 40.0;
        worker.cargo = 10;
        worker.cargo_kind = ResourceKind::Material;
        world.commands.push(command(1, 0, 2, "gather", catalyst.id));
        for _ in 0..40 {
            world.step();
        }
        let worker = world.units.iter().find(|unit| unit.id == 2).unwrap();
        assert_eq!(worker.cargo, 10, "it must deliver material before catalyst");
        assert_eq!(worker.cargo_kind, ResourceKind::Material);
        assert!(worker.returning);
        assert_eq!(
            world
                .nodes
                .iter()
                .find(|node| node.id == catalyst.id)
                .unwrap()
                .amount,
            catalyst.amount
        );
    }

    #[test]
    fn army_deaths_refund_half_of_both_currencies_exactly_once() {
        let mut world = World::new(&[0, 1]);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.balances.insert(0, Balance::new(1000, 100));
        world.spawn(0, "siege", 400.0, 400.0);
        let siege = world.next_id - 1;
        world.units.iter_mut().find(|u| u.id == siege).unwrap().hp = 0;
        world.step();
        assert!(!world.units.iter().any(|unit| unit.id == siege));
        // Siege costs 150 material and 50 catalyst; half of each comes back.
        assert_eq!(world.balances[&0], Balance::new(1075, 125));
        for _ in 0..20 {
            world.step();
        }
        assert_eq!(
            world.balances[&0],
            Balance::new(1075, 125),
            "a death pays exactly once"
        );
    }

    #[test]
    fn every_army_kind_refunds_and_simultaneous_deaths_each_pay() {
        let mut world = World::new(&[0, 1]);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.balances.insert(0, Balance::default());
        for kind in ["soldier", "scout", "siege"] {
            world.spawn(0, kind, 400.0, 400.0);
        }
        for unit in &mut world.units {
            if unit.owner == 0 && is_army(&unit.kind) {
                unit.hp = 0;
            }
        }
        world.step();
        // The bootstrap soldier dies as well, so two soldiers (50 each), one
        // scout (40) and one siege (75 material and 25 catalyst) all pay.
        assert_eq!(world.balances[&0], Balance::new(215, 25));
    }

    #[test]
    fn worker_and_building_losses_refund_nothing() {
        let mut world = World::new(&[0, 1]);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.balances.insert(0, Balance::new(500, 100));
        world.spawn(0, "barracks", 440.0, 220.0);
        let barracks = world.next_id - 1;
        for id in [2, barracks] {
            world.units.iter_mut().find(|u| u.id == id).unwrap().hp = 0;
        }
        world.step();
        assert!(!world
            .units
            .iter()
            .any(|unit| unit.id == 2 || unit.id == barracks));
        assert_eq!(world.balances[&0], Balance::new(500, 100));
    }

    #[test]
    fn cancelled_production_and_a_death_never_both_pay() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        let barracks = barracks_for(&mut world, 0);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.balances.insert(0, Balance::new(1000, 0));
        world
            .execute(&command(1, 0, barracks, "train_soldier", 0))
            .unwrap();
        assert_eq!(world.balances[&0], Balance::new(900, 0));
        world
            .execute(&command(2, 0, barracks, "cancel_production", 0))
            .unwrap();
        // Cancellation returns the whole price, and the soldier never exists.
        assert_eq!(world.balances[&0], Balance::new(1000, 0));
        for _ in 0..200 {
            world.step();
        }
        assert_eq!(
            world
                .units
                .iter()
                .filter(|unit| unit.owner == 0 && unit.kind == "soldier")
                .count(),
            1,
            "only the bootstrap soldier exists"
        );
        assert_eq!(world.balances[&0], Balance::new(1000, 0));

        // The soldier that was really built pays its one death refund.
        world
            .units
            .iter_mut()
            .find(|unit| unit.owner == 0 && unit.kind == "soldier")
            .unwrap()
            .hp = 0;
        world.step();
        assert_eq!(world.balances[&0], Balance::new(1050, 0));
    }

    #[test]
    fn a_refund_cannot_rescue_an_eliminated_player() {
        let mut world = World::new(&[0, 1, 2, 3]);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.balances.insert(0, Balance::default());
        world.spawn(0, "siege", 400.0, 400.0);
        let siege = world.next_id - 1;
        world.units.iter_mut().find(|u| u.id == siege).unwrap().hp = 0;
        // The HQ falls on the same tick as the siege unit.
        world.units[0].hp = 0;
        world.step();
        assert!(!world.units.iter().any(|unit| unit.owner == 0));
        assert_eq!(world.outcome, None);
        assert_eq!(
            world.balances[&0],
            Balance::default(),
            "a dead player is not paid for dying"
        );
    }

    // --- factions and the three gather models -------------------------------

    /// A world on the built-in map whose slots play named factions, started
    /// past the opening stipend with empty balances so every unit of currency
    /// that appears afterwards came out of a deposit.
    fn factional(roster: &[(u8, Faction)]) -> World {
        let mut world = World::new_on_with_factions(crate::maps::default_map(), roster);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        for (slot, _) in roster {
            world.balances.insert(*slot, Balance::default());
        }
        world
    }

    fn unit_of(world: &World, id: u32) -> &Entity {
        world.units.iter().find(|unit| unit.id == id).unwrap()
    }

    fn node_of(world: &World, id: u32) -> &Node {
        world.nodes.iter().find(|node| node.id == id).unwrap()
    }

    /// Every unit of each currency that exists anywhere: in a balance, still in
    /// the ground, or aboard a carrier.
    fn held(world: &World, kind: ResourceKind) -> u64 {
        world
            .balances
            .values()
            .map(|balance| balance.amount(kind) as u64)
            .sum::<u64>()
            + world
                .nodes
                .iter()
                .filter(|node| node.kind == kind)
                .map(|node| node.amount as u64)
                .sum::<u64>()
            + world
                .units
                .iter()
                .filter(|unit| unit.cargo_kind == kind)
                .map(|unit| unit.cargo as u64)
                .sum::<u64>()
    }

    #[test]
    fn each_faction_opens_with_its_own_labour() {
        let world = World::new_on_with_factions(
            crate::maps::default_map(),
            &[
                (0, Faction::Industrial),
                (1, Faction::Network),
                (2, Faction::Organic),
            ],
        );
        for (slot, kind) in [(0u8, "worker"), (1, "drifter"), (2, "harvester")] {
            assert_eq!(
                world
                    .units
                    .iter()
                    .filter(|unit| unit.owner == slot && unit.kind == kind)
                    .count(),
                2,
                "{kind}"
            );
            assert_eq!(world.faction(slot), crate::faction_for_slot(slot));
        }
        // An unlabelled world is the Industrial baseline, exactly as before.
        let plain = World::new(&[0, 1]);
        assert_eq!(plain.faction(0), Faction::Industrial);
        assert_eq!(
            plain.units.iter().filter(|u| u.kind == "worker").count(),
            4
        );
    }

    /// The Network model, stated as its own claim: a drifter is credited while
    /// it stands at the deposit, holds no cargo at any point, and never once
    /// sets `returning` — and what it is credited is exactly what left the
    /// ground.
    #[test]
    fn a_drifter_credits_in_place_and_never_returns() {
        let mut world = factional(&[(0, Faction::Network), (1, Faction::Industrial)]);
        assert_eq!(unit_of(&world, 2).kind, "drifter");
        let before = node_of(&world, 1).amount;
        world.commands.push(command(1, 0, 2, "gather", 1));
        let mut first_credit = None;
        for _ in 0..200 {
            world.step();
            let drifter = unit_of(&world, 2);
            assert!(!drifter.returning, "a drifter must never set returning");
            assert_eq!(drifter.cargo, 0, "a drifter must never hold cargo");
            if first_credit.is_none() && world.balances[&0].material > 0 {
                first_credit = Some(world.tick);
            }
        }
        let credited = world.balances[&0].material;
        assert!(credited > 0, "the drifter was never paid");
        assert_eq!(world.balances[&0].catalyst, 0);
        // Conservation at the smallest scale: the deposit lost exactly what one
        // balance gained, with nothing in flight in between.
        assert_eq!(before - node_of(&world, 1).amount, credited);
        // It is paid without ever going home, and is still at the deposit.
        let drifter = unit_of(&world, 2);
        let node = node_of(&world, 1);
        assert!(distance(drifter.x, drifter.y, node.x, node.y) <= 29.0);
        assert_eq!(drifter.order.kind, "gather");
        // Pulses are small and frequent rather than one large delivery.
        let (interval, pulse) = crate::drifter_pulse(false);
        assert_eq!((interval, pulse), (5, 1));
        assert!(credited >= 25, "{credited} credited in 200 ticks");
    }

    /// The same order, at the same moment, under the two models: the drifter
    /// has already been paid while the worker is still holding its load.
    #[test]
    fn the_worker_still_needs_the_round_trip_the_drifter_does_not() {
        let mut world = factional(&[(0, Faction::Network), (1, Faction::Industrial)]);
        world.commands.push(command(1, 0, 2, "gather", 1));
        world.commands.push(command(2, 1, 6, "gather", 2));
        assert_eq!(unit_of(&world, 6).kind, "worker");
        for _ in 0..70 {
            world.step();
        }
        // Network: paid, empty-handed, still standing at the deposit.
        assert!(world.balances[&0].material > 0);
        assert_eq!(unit_of(&world, 2).cargo, 0);
        // Industrial: holding a load, paid nothing yet.
        assert!(unit_of(&world, 6).cargo > 0);
        assert_eq!(
            world.balances[&1],
            Balance::default(),
            "a worker is paid on delivery, not at the face"
        );
        for _ in 0..140 {
            world.step();
        }
        // And the round trip does pay, once it is walked.
        assert!(world.balances[&1].material >= 25);
        assert!(world.units.iter().any(|unit| unit.id == 6));
    }

    #[test]
    fn a_drifter_cannot_be_ordered_to_return_a_load_it_never_has() {
        let world = factional(&[(0, Faction::Network), (1, Faction::Industrial)]);
        let refusal = world.validate(&command(1, 0, 2, "return", 0)).unwrap_err();
        assert!(refusal.contains("never carry a load"), "{refusal}");
        // The Industrial worker of the other slot is still allowed to.
        assert!(world.validate(&command(2, 1, 6, "return", 0)).is_ok());
    }

    /// The Organic model: labour is free of currency and limited by stock.
    #[test]
    fn a_harvester_costs_stock_and_no_material_and_is_refused_without_it() {
        let mut world = factional(&[(0, Faction::Organic), (1, Faction::Industrial)]);
        idle_labour(&mut world);
        // Not one unit of either currency, for the whole test.
        assert_eq!(world.balances[&0], Balance::default());
        assert_eq!(unit_of(&world, 1).stock, 0);
        let refusal = world
            .validate(&command(1, 0, 1, "train_harvester", 0))
            .unwrap_err();
        assert!(refusal.contains("no harvester stock"), "{refusal}");

        for _ in 0..crate::HUB_STOCK_INTERVAL_TICKS {
            world.step();
        }
        assert_eq!(unit_of(&world, 1).stock, 1);
        world
            .execute(&command(2, 0, 1, "train_harvester", 0))
            .unwrap();
        assert_eq!(unit_of(&world, 1).stock, 0, "the stock was spent");
        assert_eq!(
            world.balances[&0],
            Balance::default(),
            "a harvester is free of currency"
        );
        // Spent, so the next one is refused until the hub regenerates.
        let refusal = world
            .validate(&command(3, 0, 1, "train_harvester", 0))
            .unwrap_err();
        assert!(refusal.contains("no harvester stock"), "{refusal}");

        let before = world.units.iter().filter(|u| u.kind == "harvester").count();
        for _ in 0..stats("harvester").unwrap().training_ticks + 2 {
            world.step();
        }
        assert_eq!(
            world.units.iter().filter(|u| u.kind == "harvester").count(),
            before + 1,
            "the free harvester was actually built"
        );
        assert_eq!(world.balances[&0], Balance::default());
    }

    /// Two harvester orders arriving in the same tick cannot spend one point
    /// of stock twice: each is validated against the world the previous one
    /// already changed.
    #[test]
    fn one_point_of_stock_cannot_be_spent_twice_in_a_tick() {
        let mut world = factional(&[(0, Faction::Organic), (1, Faction::Industrial)]);
        world.units[0].stock = 1;
        world.commands.push(command(1, 0, 1, "train_harvester", 0));
        world.commands.push(command(2, 0, 1, "train_harvester", 0));
        world.step();
        assert_eq!(unit_of(&world, 1).stock, 0);
        assert_eq!(world.commands[0].status, "executed");
        assert_eq!(world.commands[1].status, "rejected");
        assert!(world.commands[1].reason.contains("stock"));
        assert_eq!(unit_of(&world, 1).production.len(), 1);
    }

    #[test]
    fn cancelling_a_queued_harvester_returns_its_stock() {
        let mut world = factional(&[(0, Faction::Organic), (1, Faction::Industrial)]);
        world.units[0].stock = 2;
        world
            .execute(&command(1, 0, 1, "train_harvester", 0))
            .unwrap();
        assert_eq!(unit_of(&world, 1).stock, 1);
        world
            .execute(&command(2, 0, 1, "cancel_production", 0))
            .unwrap();
        assert_eq!(unit_of(&world, 1).stock, 2);
        assert_eq!(world.balances[&0], Balance::default());
    }

    #[test]
    fn hub_stock_regenerates_to_the_cap_for_organic_hubs_only_and_stops() {
        let mut world = World::new_on_with_factions(
            crate::maps::default_map(),
            &[(0, Faction::Organic), (1, Faction::Industrial)],
        );
        // A second Organic hub: stock is per hub, so an expansion earns its own.
        world.spawn(0, "outpost", 600.0, 220.0);
        let outpost = world.next_id - 1;
        for _ in 0..crate::HUB_STOCK_INTERVAL_TICKS * crate::HUB_STOCK_CAP as u64 {
            world.step();
        }
        assert_eq!(unit_of(&world, 1).stock, crate::HUB_STOCK_CAP);
        assert_eq!(unit_of(&world, outpost).stock, crate::HUB_STOCK_CAP);
        // The Industrial hub across the map never accrues anything.
        assert_eq!(unit_of(&world, 5).stock, 0);
        for _ in 0..crate::HUB_STOCK_INTERVAL_TICKS * 5 {
            world.step();
        }
        assert_eq!(
            unit_of(&world, 1).stock,
            crate::HUB_STOCK_CAP,
            "stock stops at the cap"
        );
        assert_eq!(unit_of(&world, 5).stock, 0);
        // And the outpost can spend what it grew.
        world
            .execute(&command(1, 0, outpost, "train_harvester", 0))
            .unwrap();
        assert_eq!(unit_of(&world, outpost).stock, crate::HUB_STOCK_CAP - 1);
    }

    /// Harvesters being unable to fight is a server rule with its own reason,
    /// not a command card that happens to omit the buttons.
    #[test]
    fn a_harvester_is_refused_every_fighting_order_by_name() {
        let world = factional(&[(0, Faction::Organic), (1, Faction::Industrial)]);
        assert_eq!(unit_of(&world, 2).kind, "harvester");
        for (kind, target) in [("attack", 5), ("attack_move", 0), ("hold", 0)] {
            let refusal = world
                .validate(&command(1, 0, 2, kind, target))
                .unwrap_err();
            assert!(
                refusal.contains("Harvesters cannot fight"),
                "{kind}: {refusal}"
            );
        }
        // What it is for still works.
        assert!(world.validate(&command(2, 0, 2, "gather", 1)).is_ok());
        assert!(world.validate(&command(3, 0, 2, "move", 0)).is_ok());
    }

    #[test]
    fn a_faction_can_only_train_its_own_labour_unit() {
        for faction in crate::FACTION_ROTATION {
            let mut world = factional(&[(0, faction), (1, Faction::Industrial)]);
        let barracks = barracks_for(&mut world, 0);
            world.balances.insert(0, Balance::new(1000, 200));
            world.units[0].stock = 1;
            let own = crate::starting_labour(faction)[0];
            assert!(
                world
                    .validate(&command(1, 0, 1, &format!("train_{own}"), 0))
                    .is_ok(),
                "{faction} cannot train its own {own}"
            );
            for other in ["worker", "drifter", "harvester"] {
                if other == own {
                    continue;
                }
                let refusal = world
                    .validate(&command(2, 0, 1, &format!("train_{other}"), 0))
                    .unwrap_err();
                assert!(
                    refusal.contains(other) && refusal.contains(faction.as_str()),
                    "{faction} was given {other} with: {refusal}"
                );
            }
            // The army roster is unchanged and shared by all three.
            assert!(world.validate(&command(3, 0, barracks, "train_soldier", 0)).is_ok());
        }
    }

    /// Per-currency conservation with all three models running at once,
    /// including the one that never carries a load: material and catalyst are
    /// each conserved exactly, and neither converts into the other.
    #[test]
    fn every_currency_is_conserved_under_all_three_gather_models() {
        let mut world = factional(&[
            (0, Faction::Industrial),
            (1, Faction::Network),
            (2, Faction::Organic),
        ]);
        let material_before = held(&world, ResourceKind::Material);
        let catalyst_before = held(&world, ResourceKind::Catalyst);
        // Each player works its own mineral line with one labour unit and the
        // contested centre catalyst with the other.
        for (id, (slot, node)) in [(2u32, (0u8, 1u32)), (6, (1, 2)), (10, (2, 3))] {
            world.commands.push(command(id as u64, slot, id, "gather", node));
        }
        for (slot, id) in [(0u8, 3u32), (1, 7), (2, 11)] {
            world
                .commands
                .push(command(id as u64 + 100, slot, id, "gather", 7));
        }
        for _ in 0..2000 {
            world.step();
        }
        // Everyone was actually paid, so this is not conservation by idleness.
        for slot in 0u8..3 {
            assert!(
                world.balances[&slot].material > 0,
                "slot {slot} earned no material"
            );
        }
        assert!(world
            .balances
            .values()
            .any(|balance| balance.catalyst > 0));
        assert_eq!(held(&world, ResourceKind::Material), material_before);
        assert_eq!(held(&world, ResourceKind::Catalyst), catalyst_before);
        // The drifter still holds nothing: its whole yield is already banked.
        for unit in world.units.iter().filter(|u| u.kind == "drifter") {
            assert_eq!(unit.cargo, 0);
            assert!(!unit.returning);
        }
        // And the stipend is genuinely over, so nothing was minted.
        assert_eq!(crate::stipend_payment(world.tick), 0);
    }

    // --- match history ------------------------------------------------------

    /// Every unit of `kind` still sitting in the ground.
    fn in_ground(world: &World, kind: ResourceKind) -> u64 {
        world
            .nodes
            .iter()
            .filter(|node| node.kind == kind)
            .map(|node| node.amount as u64)
            .sum()
    }

    /// Every unit of `kind` that has left a deposit but not yet reached a
    /// balance: a carrier's load, in transit.
    fn aboard(world: &World, kind: ResourceKind) -> u64 {
        world
            .units
            .iter()
            .filter(|unit| unit.cargo_kind == kind)
            .map(|unit| unit.cargo as u64)
            .sum()
    }

    fn collected_total(world: &World, kind: ResourceKind) -> u64 {
        world
            .collected
            .values()
            .map(|balance| balance.amount(kind) as u64)
            .sum()
    }

    /// The only honest check on `collected`: it is measured against what the
    /// deposits actually lost, not against a balance that free income also
    /// feeds. All three gather models run at once, so the worker's round trip,
    /// the drifter's in-place pulse and the harvester's small load are each
    /// covered by the same equation.
    #[test]
    fn collected_is_exactly_the_drain_from_the_deposits_under_all_three_models() {
        let mut world = factional(&[
            (0, Faction::Industrial),
            (1, Faction::Network),
            (2, Faction::Organic),
        ]);
        let material_before = in_ground(&world, ResourceKind::Material);
        let catalyst_before = in_ground(&world, ResourceKind::Catalyst);
        // Each player works its own mineral line with one labour unit and the
        // contested centre catalyst with the other.
        for (id, (slot, node)) in [(2u32, (0u8, 1u32)), (6, (1, 2)), (10, (2, 3))] {
            world.commands.push(command(id as u64, slot, id, "gather", node));
        }
        for (slot, id) in [(0u8, 3u32), (1, 7), (2, 11)] {
            world
                .commands
                .push(command(id as u64 + 100, slot, id, "gather", 7));
        }
        for _ in 0..2000 {
            world.step();
        }
        for (kind, before) in [
            (ResourceKind::Material, material_before),
            (ResourceKind::Catalyst, catalyst_before),
        ] {
            let drained = before - in_ground(&world, kind);
            assert!(drained > 0, "{kind}: nothing was mined, so nothing is proved");
            assert_eq!(
                collected_total(&world, kind),
                drained - aboard(&world, kind),
                "{kind}: collected is the deposit drain less what is still in transit"
            );
        }
        // `factional` opens past the stipend with empty balances and nothing is
        // ever spent here, so every slot's balance is its mined income exactly.
        // Anything minted - a stipend payment, a refund - would break this.
        for slot in 0u8..3 {
            assert!(
                world.collected(slot).material > 0,
                "slot {slot} mined no material"
            );
            assert_eq!(
                world.balances[&slot],
                world.collected(slot),
                "slot {slot} was paid something it did not mine"
            );
        }
        assert_eq!(crate::stipend_payment(world.tick), 0);
    }

    /// The two sources of free income, held out by name. A graph that folded
    /// either one in would show an economy nobody ran.
    #[test]
    fn neither_the_stipend_nor_a_refund_ever_reaches_collected() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        for _ in 0..crate::STIPEND_SECOND_PHASE_END_TICK {
            world.step();
        }
        for slot in 0u8..2 {
            assert_eq!(world.balances[&slot], Balance::new(250 + 450, 0));
            assert_eq!(
                world.collected(slot),
                Balance::default(),
                "450 material arrived, and nobody mined a unit of it"
            );
        }
        // A death refund is free income too: it pays the balance and no more.
        world.spawn(0, "siege", 400.0, 400.0);
        let siege = world.next_id - 1;
        world.units.iter_mut().find(|u| u.id == siege).unwrap().hp = 0;
        world.step();
        assert_eq!(
            world.balances[&0],
            Balance::new(700 + 75, 25),
            "half of the siege came back"
        );
        assert_eq!(world.collected(0), Balance::default());
    }

    /// `lost` is list price and covers the whole roster - not the refunded
    /// half, and not the army alone.
    #[test]
    fn lost_is_the_list_price_of_everything_of_yours_that_died() {
        let mut world = World::new(&[0, 1]);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.balances.insert(0, Balance::new(1000, 100));
        world.spawn(0, "barracks", 440.0, 220.0);
        let barracks = world.next_id - 1;
        world.spawn(0, "siege", 400.0, 400.0);
        let siege = world.next_id - 1;
        // A bootstrap worker (50), the bootstrap soldier (100), a barracks
        // (150) and a siege (150 and 50).
        for id in [2, 4, barracks, siege] {
            world.units.iter_mut().find(|u| u.id == id).unwrap().hp = 0;
        }
        world.step();
        assert_eq!(world.lost(0), Cost::new(50 + 100 + 150 + 150, 50));
        assert_eq!(world.lost(1), Cost::ZERO, "nothing of slot 1's died");
        // Nobody shot any of them, so nobody is credited with killing them.
        assert_eq!(world.killed(0), Cost::ZERO);
        assert_eq!(world.killed(1), Cost::ZERO);
        // And the refund rule is untouched: half of the army only.
        assert_eq!(world.balances[&0], Balance::new(1000 + 50 + 75, 100 + 25));
    }

    /// The kill goes to the slot that fired, read out of the damage it dealt.
    #[test]
    fn a_kill_is_credited_to_whoever_actually_dealt_the_damage() {
        let mut world = World::new(&[0, 1]);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        idle_labour(&mut world);
        let (x, y) = {
            let soldier = unit_of(&world, 4);
            (soldier.x, soldier.y)
        };
        // Slot 1's scout, one hit from death, inside slot 0's soldier's range.
        world.spawn(1, "scout", x + 30.0, y);
        let scout = world.next_id - 1;
        world.units.iter_mut().find(|u| u.id == scout).unwrap().hp = 1;
        world.step();
        assert!(
            !world.units.iter().any(|unit| unit.id == scout),
            "the scout should have died"
        );
        assert_eq!(world.killed(0), Cost::material(80), "a scout lists at 80");
        assert_eq!(world.lost(1), Cost::material(80));
        assert_eq!(world.killed(1), Cost::ZERO);
        assert_eq!(world.lost(0), Cost::ZERO);
    }

    /// Army value is the push, so labour and buildings must not move it.
    #[test]
    fn army_value_counts_the_army_and_nothing_else() {
        let mut world = World::new(&[0, 1]);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        idle_labour(&mut world);
        // The bootstrap roster is a hub, two workers and one soldier.
        assert_eq!(world.army_value(0), Cost::material(100));
        world.spawn(0, "worker", 400.0, 400.0);
        world.spawn(0, "barracks", 440.0, 220.0);
        assert_eq!(
            world.army_value(0),
            Cost::material(100),
            "labour and buildings are not army"
        );
        world.spawn(0, "siege", 420.0, 400.0);
        let siege = world.next_id - 1;
        assert_eq!(world.army_value(0), Cost::new(250, 50), "it rises on a build");
        world.units.iter_mut().find(|u| u.id == siege).unwrap().hp = 0;
        world.step();
        assert_eq!(
            world.army_value(0),
            Cost::material(100),
            "and falls again on a death"
        );
        assert_eq!(world.army_value(1), Cost::material(100));
    }

    /// The server advances several ticks per wake. A sample point must still be
    /// one point and one row, dated by the tick it describes.
    #[test]
    fn one_sample_point_yields_one_sample_however_many_ticks_a_wake_advances() {
        let map = crate::maps::default_map();
        let mut world = World::new(&[0, 1, 2, 3]);
        let mut points = Vec::new();
        // 252 ticks delivered in wakes of four, the server's catch-up cap.
        for _ in 0..63 {
            world.step_many_on(map, 4, |world| points.push(world.tick));
        }
        assert_eq!(world.tick, 252);
        assert_eq!(points, vec![100, 200], "one row per point, never one per wake");
        // And a wake that swallows several points at once still separates them.
        let mut long = World::new(&[0, 1]);
        let mut all = Vec::new();
        long.step_many_on(map, 350, |world| all.push(world.tick));
        assert_eq!(all, vec![100, 200, 300]);
    }

    /// A match that ends on a sample point is sampled there once, and the
    /// remaining ticks of that wake add nothing - `step_on` freezes the clock
    /// once an outcome is set, so a loop that kept going would re-fire the same
    /// point for every tick it had left.
    #[test]
    fn a_match_ending_on_a_sample_point_samples_it_exactly_once() {
        let map = crate::maps::default_map();
        let mut world = World::new(&[0, 1]);
        world.tick = 99;
        world.units.iter_mut().find(|unit| unit.id == 5).unwrap().hp = 0;
        let mut points = Vec::new();
        world.step_many_on(map, 4, |world| points.push(world.tick));
        assert_eq!(world.outcome, Some(0));
        assert_eq!(world.tick, 100, "time stopped on the tick the match ended");
        assert_eq!(points, vec![100]);
        // `record_final_sample` reads exactly this and so adds no second row.
        assert!(crate::is_sample_tick(world.tick));
    }

    /// A match that ends between two sample points has no row for its end
    /// state, which is why the final sample exists - and it lands on the true
    /// last tick rather than on the next multiple of the interval.
    #[test]
    fn a_match_ending_between_sample_points_needs_a_final_one() {
        let map = crate::maps::default_map();
        let mut world = World::new(&[0, 1]);
        world.tick = 150;
        world.units.iter_mut().find(|unit| unit.id == 5).unwrap().hp = 0;
        let mut points = Vec::new();
        world.step_many_on(map, 4, |world| points.push(world.tick));
        assert_eq!(world.outcome, Some(0));
        assert_eq!(world.tick, 151, "the real last tick of the match");
        assert!(points.is_empty(), "no sample point was crossed");
        assert!(!crate::is_sample_tick(world.tick));
    }

    #[test]
    fn the_stipend_pays_every_player_on_schedule_and_then_stops() {
        let mut world = World::new(&[0, 1, 2, 3]);
        idle_labour(&mut world);
        for _ in 0..crate::STIPEND_FIRST_PHASE_END_TICK {
            world.step();
        }
        for slot in 0u8..4 {
            assert_eq!(world.balances[&slot], Balance::new(250 + 300, 0));
        }
        for _ in crate::STIPEND_FIRST_PHASE_END_TICK..crate::STIPEND_SECOND_PHASE_END_TICK {
            world.step();
        }
        for slot in 0u8..4 {
            assert_eq!(world.balances[&slot], Balance::new(250 + 450, 0));
        }
        for _ in 0..1200 {
            world.step();
        }
        for slot in 0u8..4 {
            assert_eq!(
                world.balances[&slot],
                Balance::new(250 + 450, 0),
                "the stipend stops after three minutes"
            );
        }
    }
}
