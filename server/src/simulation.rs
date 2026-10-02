use crate::maps::MapDefinition;
use crate::navigation::Navigation;
use crate::spatial::SpatialIndex;
use crate::{
    ability, advance_patch, is_static_defense, passive, veteran_cooldown, veteran_percent, Passive,
    BLINK_COOLDOWN_TICKS, BLINK_DISTANCE, BLINK_THRESHOLD_PERCENT, DEATH_BURST_DAMAGE,
    DEATH_BURST_RADIUS, ENTRENCH_ARMOUR, ENTRENCH_HOLD_TICKS, ENTRENCH_LINGER_TICKS,
    ENTRENCH_RADIUS, ENTRENCH_RANGE, FORCED_MARCH_IDLE_TICKS, FORCED_MARCH_SPEED_PERCENT,
    GUARDIAN_PERCENT, GUARDIAN_RADIUS, MEDIC_HEAL, MEDIC_INTERVAL_TICKS, MEDIC_RANGE,
    OVERWATCH_IDLE_TICKS, OVERWATCH_PERCENT, OVERWATCH_WINDOW_TICKS, PHASE_COOLDOWN_TICKS,
    PREDATOR_PERCENT, REGROWTH_DELAY_TICKS, REGROWTH_PERCENT_PER_SECOND, RICOCHET_PERCENTS,
    RICOCHET_RADIUS, SHIELD_AURA_PER_INTERVAL, SHIELD_AURA_RADIUS, SPLASH_PERCENT,
    fortified_armour, ricochet_bounces, splash_radius, TICKS_PER_SECOND, attack_damage, building_faction, can_teleport, cargo_capacity,
    carries_cargo, creep_max_radius, creep_zone, death_refund, death_spawn, distance,
    drifter_pulse, fights, gathers_in_place, is_army, is_building, is_hub, is_labour, is_temporary,
    labour_faction, max_energy, mining_yield, power_field, producer, projects_power, shield_regen,
    stats, stipend_payment, temporary_lifetime, terrazine_owed, trains_in_field, validate_position,
    vitals, zone_template, Ability, Balance, Cost, CreepPatch, Faction, ResourceKind, Zone,
    ZoneField, BLOOM, BLOOM_LIFETIME_TICKS, ENERGY_REGEN_INTERVAL_TICKS, HUB_START_ENERGY,
    HUB_STOCK_CAP, HUB_STOCK_INTERVAL_TICKS, MAX_BUILDINGS, MAX_QUEUE, MAX_UNITS,
    MINER_RETARGET_RADIUS, MINING_PULSE_TICKS, POWER_RESTORE_RADIUS, RECALL, RECALL_RADIUS,
    REFINERY_INTERVAL_TICKS, REFINERY_SNAP_DISTANCE, REFINERY_YIELD, REPAIR_COST,
    SHIELD_REGEN_DELAY_TICKS, SHIELD_REGEN_INTERVAL_TICKS, STARTING_BALANCE,
    TELEPORT_ARRIVAL_TICKS, TELEPORT_CHANNEL_TICKS, TELEPORT_COOLDOWN_TICKS,
};
use std::collections::{BTreeMap, BTreeSet};

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
/// The power field is keyed on the owner's faction as well as the building —
/// a Network HQ projects one and an Industrial HQ does not — which is why the
/// factions are passed in. A slot missing from `factions` is Industrial.
///
/// The order of neither slice matters: `ZoneField::from_sources` sorts by
/// source entity id, so membership never depends on iteration order.
pub fn zones_of(
    units: &[Entity],
    creep: &[CreepPatch],
    factions: &BTreeMap<u8, Faction>,
) -> ZoneField {
    let powered = units.iter().filter_map(|unit| {
        let faction = factions.get(&unit.owner).copied().unwrap_or_default();
        if unit.construction_remaining > 0 || !projects_power(&unit.kind, faction) {
            return None;
        }
        Some(Zone {
            source: unit.id,
            owner: unit.owner,
            x: unit.x,
            y: unit.y,
            radius: power_field().radius,
            template: power_field(),
        })
    });
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
    ZoneField::from_sources(projected.chain(spread).chain(powered))
}

/// Bucket width of the per-tick spatial indexes. Wide enough that the common
/// queries (a 180 acquisition radius, a 20 exit check) touch a handful of
/// buckets, narrow enough that a bucket holds a fight's worth of units, not an
/// army's.
const SPATIAL_CELL: f32 = 128.0;

/// Everything that damages, heals or credits during one tick, accumulated while
/// the unit loop runs and applied after it. **Every source of damage goes through
/// [`Hits::deal`]** — a shot, a splash, a ricochet bounce, a death burst — so
/// the guardian redirect, the phase shift and the kill attribution see all of
/// them, and nothing writes a hit point mid-loop.
#[derive(Default)]
struct Hits {
    /// Damage each entity takes this tick, after any redirect or absorption.
    damage: BTreeMap<u32, i32>,
    /// The same damage by the slot that dealt it: `(target id, attacker slot)`.
    /// Written beside `damage` and never read by anything that decides an
    /// outcome; its consumer is the kill attribution.
    dealt: BTreeMap<(u32, u8), i32>,
    /// And by the unit that dealt it, `(target id, attacker id)`: Veteran
    /// credit goes to the unit that did the most damage to the victim this
    /// tick, ties on the lower id.
    by_unit: BTreeMap<(u32, u32), i32>,
    /// The last unit to damage each entity this tick (units run in id order,
    /// so the highest id wins).
    last_attacker: BTreeMap<u32, u32>,
    /// Phantoms whose first hit this tick was absorbed.
    phased: BTreeSet<u32>,
    /// Field Medic heals: hit points only.
    medic: BTreeMap<u32, i32>,
    /// Predator heals: hit points first, overflow into shields.
    feed: BTreeMap<u32, i32>,
    /// Friendly units under a shield aura this interval.
    aura: BTreeSet<u32>,
}

impl Hits {
    /// `amount` of damage from the unit `from_id` of slot `from_owner` on
    /// `target`. A phantom ready to phase absorbs the first hit whole; a unit
    /// within a friendly bulwark's reach hands it `GUARDIAN_PERCENT` of the hit
    /// (rounded down, so the two shares always sum to `amount`).
    fn deal(
        &mut self,
        snapshot: &[Entity],
        guardians: &SpatialIndex,
        tick: u64,
        target: &Entity,
        (from_owner, from_id): (u8, u32),
        amount: i32,
    ) {
        if amount <= 0 {
            return;
        }
        if passive(&target.kind) == Some(Passive::PhaseShift)
            && target.passive_ready_tick <= tick
            && self.phased.insert(target.id)
        {
            return;
        }
        let guardian = (!is_building(&target.kind) && passive(&target.kind) != Some(Passive::Guardian))
            .then(|| {
                guardians.nearest(target.x, target.y, GUARDIAN_RADIUS, |at| {
                    snapshot[at].owner == target.owner
                })
            })
            .flatten();
        let redirected = guardian.map_or(0, |_| amount * GUARDIAN_PERCENT / 100);
        self.add(target.id, from_owner, from_id, amount - redirected);
        if let Some(at) = guardian {
            self.add(snapshot[at].id, from_owner, from_id, redirected);
        }
    }

    fn add(&mut self, target: u32, from_owner: u8, from_id: u32, amount: i32) {
        if amount <= 0 {
            return;
        }
        *self.damage.entry(target).or_default() += amount;
        *self.dealt.entry((target, from_owner)).or_default() += amount;
        *self.by_unit.entry((target, from_id)).or_default() += amount;
        self.last_attacker.insert(target, from_id);
    }
}

/// Is a marksman entrenched on this tick? Its bonus runs until
/// `passive_ready_tick`, which the unit loop pushes `ENTRENCH_LINGER_TICKS`
/// ahead every tick it has held its anchor long enough.
fn entrenched(unit: &Entity, tick: u64) -> bool {
    passive(&unit.kind) == Some(Passive::Entrenchment) && unit.passive_ready_tick > tick
}

/// What reduces a hit on `target`: the owner's armour research, a bunker's
/// fortification, an entrenched marksman's position. A hit is never below 1.
fn mitigated(hit: i32, target: &Entity, researched_armour: bool, tick: u64) -> i32 {
    let armour = if researched_armour { 3 } else { 0 }
        + fortified_armour(&target.kind)
        + if entrenched(target, tick) { ENTRENCH_ARMOUR } else { 0 };
    (hit - armour).max(1)
}

/// Sorted `(id, index)` pairs, for finding entities by id in an unsorted list.
struct IdLookup(Vec<(u32, usize)>);

impl IdLookup {
    fn get(&self, id: u32) -> Option<usize> {
        self.0
            .binary_search_by_key(&id, |(other, _)| *other)
            .ok()
            .map(|at| self.0[at].1)
    }
}

/// The entity with `id` in an id-sorted slice — the tick snapshot.
fn by_id(sorted: &[Entity], id: u32) -> Option<&Entity> {
    sorted
        .binary_search_by_key(&id, |unit| unit.id)
        .ok()
        .map(|at| &sorted[at])
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
///
/// Passives that change speed (Veteran, Forced March) are applied here too, for
/// the same reason: `tick` is the tick being stepped.
pub fn movement_speed(unit: &Entity, zones: &ZoneField, tick: u64) -> f32 {
    let base = stats(&unit.kind).map_or(0.0, |definition| definition.speed);
    if base <= 0.0 || is_building(&unit.kind) {
        return base;
    }
    let passive_percent = match passive(&unit.kind) {
        Some(Passive::Veteran) => veteran_percent(unit.kills),
        Some(Passive::ForcedMarch)
            if tick.saturating_sub(unit.contact_tick) >= FORCED_MARCH_IDLE_TICKS =>
        {
            FORCED_MARCH_SPEED_PERCENT
        }
        _ => 100,
    };
    base * zones.movement_multiplier(unit.owner, &unit.kind, unit.x, unit.y)
        * (passive_percent as f32 / 100.0)
}

/// Would a recall by `owner` at `(x, y)` take `unit`? The owner's mobile
/// units within `RECALL_RADIUS`.
fn recallable(unit: &Entity, owner: u8, x: f32, y: f32) -> bool {
    unit.owner == owner
        && can_teleport(&unit.kind)
        && distance(unit.x, unit.y, x, y) <= RECALL_RADIUS
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

/// An ability a caster has started and not yet resolved: today only a
/// Network recall channelling. Kept apart from `order` so a hub's rally
/// survives the cast.
#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Debug, PartialEq)]
pub struct Cast {
    pub kind: String,
    pub x: f32,
    pub y: f32,
    /// The tick the effect happens on.
    pub complete_tick: u64,
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
    /// Hit points at full health, fixed at spawn by `vitals` from the kind and
    /// the owner's faction. A Network entity carries half its listed health
    /// here and half as shields; everyone else carries all of it here.
    pub max_hp: i32,
    /// Current shields: a second health pool that absorbs damage before hit
    /// points and regenerates on its own. Always 0 when `max_shields` is.
    pub shields: i32,
    pub max_shields: i32,
    /// The last tick this entity took damage, or 0 if it never has. Shields
    /// wait `SHIELD_REGEN_DELAY_TICKS` after it before regenerating.
    pub damaged_tick: u64,
    /// While the order is `teleport`: the tick the channel completes on. Read
    /// only while that order stands, so a stale value is harmless.
    pub warp_tick: u64,
    /// The tick a teleported unit becomes active again, or 0. Until then it
    /// neither moves, shoots nor gathers, but it can be shot.
    pub arrive_tick: u64,
    /// Ability energy, up to `max_energy` for the kind and faction. Always 0
    /// on anything that casts nothing.
    pub energy: i32,
    /// The first tick this caster may cast again, or 0.
    pub ability_ready_tick: u64,
    /// A cast channelling towards its effect, if any.
    pub cast: Option<Cast>,
    /// A passive's own timer, read by exactly one passive per kind (a kind has
    /// one): the tick Battle Blink or Phase Shift is ready again, the tick the
    /// next Field Medic heal is due, the end of the open Overwatch window, or
    /// the tick Entrenchment's bonus runs out. 0 when unused.
    pub passive_ready_tick: u64,
    /// The unit that most recently damaged this one (the last hit of the
    /// latest damaged tick, in id order), or 0. Battle Blink blinks away from it.
    pub last_attacker: u32,
    /// The last tick this entity dealt or took damage, or 0. Forced March is
    /// the time since. Kept apart from `damaged_tick` and `shot_tick` so
    /// neither of those changes meaning.
    pub contact_tick: u64,
    /// Enemy units this unit has killed (see `credit_kills`): Veteran stacks.
    pub kills: u16,
    /// Entrenchment: the spot being held, and the tick it began being held.
    pub anchor_x: f32,
    pub anchor_y: f32,
    pub anchor_tick: u64,
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
    /// The labour unit currently mining this patch, or 0 when it is free. One
    /// miner per material patch, as in SC2. Only labour ever claims a patch
    /// (a catalyst deposit is worked by a refinery, which claims nothing), and
    /// a claim is cleared at the start of every tick if it is stale (see
    /// `World::release_stale_claims`), so a patch can never be locked forever.
    pub miner: u32,
}

/// How far a claimant may stand from its patch and still hold it. A mining
/// stop range is 28; the rest is slack for crowd separation.
const MINER_CLAIM_REACH: f32 = 60.0;

/// Can labour work this deposit right now? Material with something left.
/// Catalyst is extracted by refineries and never mined by hand.
fn minable(node: &Node) -> bool {
    node.kind == ResourceKind::Material && node.amount > 0
}

/// The id of the best material patch for `unit` to work, measured from
/// `(x, y)`: the nearest by distance, ties on lower node id. `free_only` skips a
/// patch another unit is mining, and `radius` bounds the search.
fn pick_patch(
    nodes: &[Node],
    x: f32,
    y: f32,
    unit: u32,
    radius: Option<f32>,
    free_only: bool,
) -> Option<u32> {
    nodes
        .iter()
        .filter(|node| minable(node))
        .filter(|node| !free_only || node.miner == 0 || node.miner == unit)
        .filter(|node| radius.is_none_or(|radius| distance(x, y, node.x, node.y) <= radius))
        .min_by(|left, right| {
            distance(x, y, left.x, left.y)
                .total_cmp(&distance(x, y, right.x, right.y))
                .then(left.id.cmp(&right.id))
        })
        .map(|node| node.id)
}

/// Where a depleted or taken patch sends `unit`: the nearest free material patch
/// to it, else the nearest one at all (it will wait beside it).
fn replacement_patch(nodes: &[Node], unit: &Entity) -> Option<u32> {
    pick_patch(nodes, unit.x, unit.y, unit.id, None, true)
        .or_else(|| pick_patch(nodes, unit.x, unit.y, unit.id, None, false))
}

/// Credits mined income to a balance, to `collected`, and — for material — the
/// terrazine by-product. The by-product is derived from the cumulative
/// `collected.material`, so no delivery's remainder is ever lost; the amount
/// already paid is kept in `collected.terrazine`.
fn credit_mined(
    balances: &mut BTreeMap<u8, Balance>,
    collected: &mut BTreeMap<u8, Balance>,
    owner: u8,
    faction: Faction,
    kind: ResourceKind,
    amount: u32,
) {
    let balance = balances.entry(owner).or_default();
    let total = collected.entry(owner).or_default();
    balance.credit_kind(kind, amount);
    // Mined income, so it is history as well as money.
    total.credit_kind(kind, amount);
    if kind == ResourceKind::Material {
        let owed = terrazine_owed(total.material, faction).saturating_sub(total.terrazine);
        balance.credit_kind(ResourceKind::Terrazine, owed);
        total.credit_kind(ResourceKind::Terrazine, owed);
    }
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
    /// Completed research per slot. It belongs to the player, not to a
    /// building, so a player who loses the HQ and fights on from an outpost
    /// keeps every upgrade. Round-trips through the player row.
    pub research: BTreeMap<u8, Vec<String>>,
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
            research: BTreeMap::new(),
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
            world.spawn(*slot, crate::basic_fighter(*faction), x + 55.0, y + 55.0);
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
                miner: 0,
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
        let (max_hp, max_shields) = vitals(kind, self.faction(owner));
        self.units.push(Entity {
            id: self.next_id,
            owner,
            kind: kind.into(),
            x,
            y,
            hp: max_hp,
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
            stock: 0,
            expires_tick: 0,
            max_hp,
            shields: max_shields,
            max_shields,
            damaged_tick: 0,
            warp_tick: 0,
            arrive_tick: 0,
            energy: max_energy(kind, self.faction(owner)).min(HUB_START_ENERGY),
            ability_ready_tick: 0,
            cast: None,
            passive_ready_tick: 0,
            last_attacker: 0,
            contact_tick: 0,
            kills: 0,
            anchor_x: x,
            anchor_y: y,
            anchor_tick: self.tick,
        });
        self.next_id += 1;
    }

    /// Spawns a temporary unit of `kind` at `(x, y)`, due to expire after its
    /// kind's lifetime, already attack-moving on the spot so it fights
    /// whatever is near and is otherwise the player's to command. Not capped
    /// by `MAX_UNITS`: it takes no supply. Every spawn follows a non-temporary
    /// death, so the count is bounded by what the players built.
    fn spawn_temporary(&mut self, owner: u8, kind: &str, x: f32, y: f32) {
        let lifetime = temporary_lifetime(kind).expect("only temporary kinds are spawned this way");
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
    /// The zone field as the world stands, for validation. The tick builds its
    /// own from the start-of-tick snapshot; this one answers "is that point
    /// powered right now" for a command being checked between ticks.
    pub fn zone_field(&self) -> ZoneField {
        zones_of(&self.units, &self.creep, &self.factions)
    }

    /// Entity id -> index into `self.units`, which is not id-sorted between
    /// ticks (the database hands rows back in no promised order).
    fn id_lookup(&self) -> IdLookup {
        let mut slots: Vec<(u32, usize)> = self
            .units
            .iter()
            .enumerate()
            .map(|(at, unit)| (unit.id, at))
            .collect();
        slots.sort_unstable();
        IdLookup(slots)
    }

    pub fn validate(&self, command: &Command) -> Result<(), String> {
        self.validate_on(command, crate::maps::default_map())
    }

    /// Labour can only be sent to a material patch with something left in it.
    fn validate_gather_target(&self, target: u32) -> Result<(), String> {
        match self.nodes.iter().find(|node| node.id == target) {
            Some(node) if node.kind == ResourceKind::Catalyst => Err(
                "Catalyst is extracted by a refinery; labour cannot gather it. Build a refinery on the deposit"
                    .into(),
            ),
            Some(node) if node.amount > 0 => Ok(()),
            _ => Err("Resource node is depleted".into()),
        }
    }

    /// Where a building of `kind` ordered at `(x, y)` actually stands. Every kind
    /// stands where it was ordered, except the refinery, which must be ordered
    /// within `REFINERY_SNAP_DISTANCE` of a catalyst deposit that still holds
    /// catalyst and has no refinery yet, and is snapped onto that deposit.
    pub fn build_site(&self, kind: &str, x: f32, y: f32) -> Result<(f32, f32), String> {
        if kind != "refinery" {
            return Ok((x, y));
        }
        let near: Vec<&Node> = self
            .nodes
            .iter()
            .filter(|node| {
                node.kind == ResourceKind::Catalyst
                    && distance(x, y, node.x, node.y) <= REFINERY_SNAP_DISTANCE
            })
            .collect();
        if near.is_empty() {
            return Err("A refinery must be built on a catalyst deposit".into());
        }
        near.into_iter()
            .filter(|node| {
                node.amount > 0
                    && !self.units.iter().any(|unit| {
                        unit.kind == "refinery" && distance(unit.x, unit.y, node.x, node.y) < 1.0
                    })
            })
            .min_by(|left, right| {
                distance(x, y, left.x, left.y)
                    .total_cmp(&distance(x, y, right.x, right.y))
                    .then(left.id.cmp(&right.id))
            })
            .map(|node| (node.x, node.y))
            .ok_or_else(|| "That catalyst deposit is empty or already has a refinery".into())
    }

    /// Clears every claim that no longer describes a labour unit mining its
    /// patch: the claimant is gone, is no longer on a gather order for that
    /// patch, is carrying a load home, has wandered off, or the patch is
    /// empty. Run at the start of each tick, after commands, so a patch is
    /// never locked by a unit that died, was re-ordered or left. Expects
    /// `self.units` sorted by id.
    fn release_stale_claims(&mut self) {
        let units = &self.units;
        for node in &mut self.nodes {
            if node.miner == 0 {
                continue;
            }
            let held = node.amount > 0
                && units
                    .binary_search_by_key(&node.miner, |unit| unit.id)
                    .ok()
                    .map(|at| &units[at])
                    .is_some_and(|unit| {
                        unit.order.kind == "gather"
                            && unit.order.target == node.id
                            && !unit.returning
                            && distance(unit.x, unit.y, node.x, node.y) <= MINER_CLAIM_REACH
                    });
            if !held {
                node.miner = 0;
            }
        }
    }

    /// Validates a command against the map the match froze. Every bound that
    /// depends on how big the battlefield is reads `map.size`.
    pub fn validate_on(&self, command: &Command, map: &MapDefinition) -> Result<(), String> {
        if self.outcome.is_some() {
            return Err("Match has ended".into());
        }
        if !self.survivors().contains(&command.owner) {
            return Err("You have no hubs left".into());
        }
        if command.units.is_empty() || command.units.len() > MAX_UNITS {
            return Err(format!("Select between 1 and {MAX_UNITS} units"));
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
            // Construction is ordered from the command card and raises itself:
            // no worker is sent, assigned or needed. The one unit named is only
            // the issuer the command protocol requires; nothing happens to it.
            if command.units.len() != 1 || command.queued {
                return Err(
                    "Construction is ordered once, from the command card, and cannot be queued"
                        .into(),
                );
            }
            validate_position(order.x, order.y, map.size)?;
            // A refinery snaps onto the catalyst deposit it is ordered at; every
            // other building stands exactly where it was ordered.
            let (site_x, site_y) = self.build_site(kind, order.x, order.y)?;
            if !map.terrain_free(site_x, site_y, 50.0) {
                return Err("Building site intersects terrain".into());
            }
            let build_margin = 60.0..=map.size - 60.0;
            if !build_margin.contains(&site_x) || !build_margin.contains(&site_y) {
                return Err("Building too close to map edge".into());
            }
            // A refinery stands on a deposit by definition, so the deposit
            // clearance only applies to buildings that are not one.
            if self.units.iter().any(|unit| {
                is_building(&unit.kind) && distance(site_x, site_y, unit.x, unit.y) < 110.0
            }) || (kind != "refinery"
                && self
                    .nodes
                    .iter()
                    .any(|node| distance(site_x, site_y, node.x, node.y) < 75.0))
            {
                return Err("Building site is obstructed".into());
            }
            if self.units.iter().any(|unit| {
                !is_building(&unit.kind) && distance(site_x, site_y, unit.x, unit.y) < 55.0
            }) {
                return Err("Move units clear of the building site".into());
            }
            if !self.units.iter().any(|unit| {
                unit.owner == command.owner
                    && is_building(&unit.kind)
                    && unit.construction_remaining == 0
                    && distance(site_x, site_y, unit.x, unit.y) <= 500.0
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
                return Err(format!("Building limit reached ({MAX_BUILDINGS})"));
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
        // Built once per command, and only for the two orders that ask where
        // a power field is.
        let field = (training.is_some() || order.kind == "teleport").then(|| self.zone_field());
        // Looked up once per command rather than once per selected unit: a
        // 400-unit order otherwise scans the world 400 times.
        let lookup = self.id_lookup();
        let find = |id: u32| lookup.get(id).map(|at| &self.units[at]);
        // Every unit of one command shares one destination, so whether it is
        // obstructed is asked once. Lazily: most orders never ask.
        let destination_free = std::cell::OnceCell::new();
        let destination_free = || {
            *destination_free.get_or_init(|| Navigation::new(map, &self.units).free(order.x, order.y))
        };
        for id in &command.units {
            let unit = find(*id)
                .filter(|unit| unit.owner == command.owner)
                .ok_or("Unit is missing or belongs to another player")?;
            if unit.construction_remaining > 0 {
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
                    || ability(&order.kind).is_some()
                    || matches!(order.kind.as_str(), "stop" | "hold" | "teleport"))
            {
                return Err("Order queue is full or action cannot be queued".into());
            }
            match order.kind.as_str() {
                kind if kind.starts_with("build_") => {}
                "research_weapons" | "research_armor" | "research_logistics" => {
                    if unit.kind != "lab" || command.queued || command.units.len() != 1 {
                        return Err("Research requires one completed lab".into());
                    }
                    if self.has_research(unit.owner, &order.kind)
                        || self.units.iter().any(|other| {
                            other.owner == unit.owner
                                && other.production.iter().any(|item| item.kind == order.kind)
                        })
                    {
                        return Err("Technology already researched or queued".into());
                    }
                    if unit.production.len() >= MAX_QUEUE {
                        return Err("Research queue is full".into());
                    }
                    self.afford(unit.owner, stats(&order.kind).unwrap().cost)?;
                }
                "rally_move" | "rally_gather" | "clear_rally" | "cancel_production" => {
                    // Any building that can hold a queue can have it cancelled
                    // — a relay training drifters, an Organic outpost training
                    // harvesters. Rallies stay with the buildings that produce,
                    // outposts included now that every hub trains labour.
                    let cancellable = order.kind == "cancel_production" && is_building(&unit.kind);
                    if !cancellable
                        && !matches!(
                            unit.kind.as_str(),
                            "hq" | "outpost" | "barracks" | "factory" | "lab"
                        )
                    {
                        return Err(
                            "Production controls require an HQ or production building".into()
                        );
                    }
                    if order.kind == "rally_move" {
                        validate_position(order.x, order.y, map.size)?;
                        if !destination_free() {
                            return Err("Rally destination is obstructed".into());
                        }
                    }
                    if order.kind == "rally_gather" {
                        self.validate_gather_target(order.target)?;
                    }
                    if order.kind == "cancel_production" && unit.production.is_empty() {
                        return Err("Production queue is already empty".into());
                    }
                }
                "repair" => {
                    if !is_labour(&unit.kind) {
                        return Err("Only labour units can repair".into());
                    }
                    let target = find(order.target)
                        .filter(|target| target.owner == unit.owner && target.id != unit.id)
                        .ok_or("Select another friendly unit or HQ to repair")?;
                    if target.construction_remaining > 0 {
                        return Err(
                            "This building is still under construction; it finishes on its own"
                                .into(),
                        );
                    }
                    if target.hp >= target.max_hp {
                        return Err("Target is already fully repaired".into());
                    }
                }
                "move" | "attack_move" => {
                    validate_position(order.x, order.y, map.size)?;
                    if !destination_free() {
                        return Err("Destination is obstructed".into());
                    }
                    if order.kind == "attack_move" && !fights(&unit.kind) {
                        return Err(
                            "Only fighting units can attack-move; labour and buildings cannot"
                                .into(),
                        );
                    }
                    if is_building(&unit.kind) {
                        return Err("HQ and buildings cannot move".into());
                    }
                }
                "teleport" => {
                    if !can_teleport(&unit.kind) {
                        return Err("Only mobile units can teleport".into());
                    }
                    if unit.arrive_tick > self.tick {
                        return Err("Unit is still arriving from its last teleport".into());
                    }
                    if unit.arrive_tick > 0
                        && self.tick < unit.arrive_tick + TELEPORT_COOLDOWN_TICKS
                    {
                        let left =
                            (unit.arrive_tick + TELEPORT_COOLDOWN_TICKS - self.tick).div_ceil(20);
                        return Err(format!("Teleport is recharging: {left}s left"));
                    }
                    validate_position(order.x, order.y, map.size)?;
                    let field = field.as_ref().unwrap();
                    if !field.powered(unit.owner, unit.x, unit.y) {
                        return Err(
                            "Teleport starts inside your power field; this unit is outside it"
                                .into(),
                        );
                    }
                    if !field.powered(unit.owner, order.x, order.y) {
                        return Err("Teleport destination must be inside your power field".into());
                    }
                    if !destination_free() {
                        return Err("Destination is obstructed".into());
                    }
                }
                kind if ability(kind).is_some() => {
                    let spell = ability(kind).unwrap();
                    if command.units.len() != 1 {
                        return Err(format!("{} is cast by one hub", spell.label));
                    }
                    self.validate_cast(unit, &spell, order, map)?;
                }
                "hold" => {
                    if !fights(&unit.kind) {
                        return Err(
                            "Only fighting units can hold position; labour and buildings cannot"
                                .into(),
                        );
                    }
                }
                "attack" => {
                    if !fights(&unit.kind) {
                        return Err(
                            "Only fighting units can attack; labour and buildings cannot".into(),
                        );
                    }
                    if !find(order.target).is_some_and(|target| target.owner != unit.owner) {
                        return Err("Enemy target no longer exists".into());
                    }
                }
                "gather" => {
                    if !is_labour(&unit.kind) {
                        return Err("Only labour units can gather".into());
                    }
                    self.validate_gather_target(order.target)?;
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
                // Any trainable kind, read from the rules rather than listed
                // here, so a unit added to the roster cannot be forgotten.
                _ if training.is_some_and(|kind| crate::unit_faction(kind).is_some()) => {
                    let trained = training.unwrap();
                    let faction = self.faction(unit.owner);
                    // A drifter can also be trained at any finished structure
                    // standing in its owner's power field.
                    let in_field = trains_in_field(trained)
                        && labour_faction(trained) == Some(faction)
                        && is_building(&unit.kind)
                        && field
                            .as_ref()
                            .is_some_and(|field| field.powered(unit.owner, unit.x, unit.y));
                    if !producer(trained, &unit.kind, faction) && !in_field {
                        // A faction asking for another faction's unit is a
                        // different mistake from asking the wrong building for
                        // it, and is reported as one.
                        if let Some(required) = crate::unit_faction(trained) {
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
                        return Err(format!("Unit limit reached ({MAX_UNITS})"));
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
            // Already validated, so the site resolves; a refinery is snapped
            // onto its deposit.
            let (site_x, site_y) = self
                .build_site(kind, command.order.x, command.order.y)
                .expect("validated build site");
            self.spawn(command.owner, kind, site_x, site_y);
            let site = self.units.last_mut().unwrap();
            site.construction_remaining = definition.training_ticks;
            site.hp = site.max_hp / 10;
            // Shields are raised by construction alongside hit points.
            site.shields = 0;
            // No cancellation and no interruption: from here the site builds
            // itself one tick at a time until it is finished or destroyed.
            debug_assert_eq!(site.id, building_id);
            return Ok(());
        }
        if let Some(spell) = ability(&command.order.kind) {
            self.cast(command.units[0], &spell, &command.order);
            return Ok(());
        }
        let lookup = self.id_lookup();
        for id in &command.units {
            let at = lookup.get(*id).expect("validated unit");
            let unit = &mut self.units[at];
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
                if unit.order.kind == "teleport" {
                    unit.warp_tick = self.tick + TELEPORT_CHANNEL_TICKS;
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
        self.release_stale_claims();
        self.resolve_casts(map);
        // Before the snapshot, so the field this tick is built from the creep
        // as it stands after this tick's growth or recession.
        self.advance_creep();
        let snapshot = self.units.clone();
        // Copied out so the per-unit loop can read an owner's faction while it
        // holds `self.units` mutably.
        let factions = self.factions.clone();
        let navigation = Navigation::new(map, &snapshot);
        // Who is near whom, from the same snapshot every rule reads: every
        // entity, and the mobile ones alone (what a building's exit must not
        // be crowded by). Queries come back as snapshot indices, so an
        // id-ordered answer is an index-ordered one.
        let nearby = SpatialIndex::new(
            map.size,
            SPATIAL_CELL,
            snapshot
                .iter()
                .enumerate()
                .map(|(at, unit)| (at, unit.x, unit.y)),
        );
        let mobiles = SpatialIndex::new(
            map.size,
            SPATIAL_CELL,
            snapshot
                .iter()
                .enumerate()
                .filter(|(_, unit)| !is_building(&unit.kind))
                .map(|(at, unit)| (at, unit.x, unit.y)),
        );
        // Every completed hub, the only things a carrier delivers to.
        let hubs: Vec<&Entity> = snapshot
            .iter()
            .filter(|target| is_hub(&target.kind) && target.construction_remaining == 0)
            .collect();
        // Deposit id -> position in `self.nodes`. Nodes are never added,
        // removed or reordered during a tick.
        let mut node_slots: Vec<(u32, usize)> = self
            .nodes
            .iter()
            .enumerate()
            .map(|(at, node)| (node.id, at))
            .collect();
        node_slots.sort_unstable();
        let node_at = |id: u32| {
            node_slots
                .binary_search_by_key(&id, |(node, _)| *node)
                .ok()
                .map(|at| node_slots[at].1)
        };
        // Zones are rebuilt from the same start-of-tick snapshot every other
        // rule reads, so every unit moving this tick sees one defined field and
        // not a field that shifts as earlier units in the loop move.
        let zones = zones_of(&snapshot, &self.creep, &factions);
        // Takes the unit rather than a speed. There is deliberately no way to
        // pass a speed in: that is what stops one movement path from quietly
        // skipping the zone layer.
        let advance = |unit: &mut Entity, target_x: f32, target_y: f32, range: f32| {
            let speed = movement_speed(unit, &zones, tick);
            navigation.advance(&mut unit.x, &mut unit.y, target_x, target_y, speed, range)
        };
        let mut hits = Hits::default();
        // Completed bulwarks, for the guardian redirect.
        let guardians = SpatialIndex::new(
            map.size,
            SPATIAL_CELL,
            snapshot
                .iter()
                .enumerate()
                .filter(|(_, unit)| {
                    unit.construction_remaining == 0
                        && passive(&unit.kind) == Some(Passive::Guardian)
                })
                .map(|(at, unit)| (at, unit.x, unit.y)),
        );
        // Has this owner researched armour? Fixed at the start of the tick, so
        // a discovery completing on it applies from the next.
        let armoured: BTreeSet<u8> = self
            .research
            .iter()
            .filter(|(_, research)| research.iter().any(|item| item == "research_armor"))
            .map(|(owner, _)| *owner)
            .collect();
        let researched_armour = |owner: u8| armoured.contains(&owner);
        let mut repairs = BTreeMap::<u32, i32>::new();
        let mut births = Vec::new();
        let mut construction = BTreeMap::<u32, u64>::new();
        let mut discoveries = Vec::new();
        for unit in &mut self.units {
            // Command-card construction: every unfinished building advances by
            // one tick of work on its own, and does nothing else.
            if unit.construction_remaining > 0 {
                construction.insert(unit.id, 1);
                continue;
            }
            if self.tick % ENERGY_REGEN_INTERVAL_TICKS == 0 {
                let faction = factions
                    .get(&unit.owner)
                    .copied()
                    .unwrap_or(Faction::Industrial);
                unit.energy = (unit.energy + 1).min(max_energy(&unit.kind, faction));
            }
            // Just arrived from a teleport: inactive until `arrive_tick`. It
            // does nothing at all this tick, but it is still in the snapshot,
            // so it can be targeted and shot.
            if unit.arrive_tick > self.tick {
                continue;
            }
            let definition = stats(&unit.kind).unwrap();
            let technology = self.research.get(&unit.owner);
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
                // Where a finished unit steps out: the first free spot on three
                // rings that no mobile unit is crowding. Searched only when an
                // item is actually due — nothing else reads it.
                let due = unit
                    .production
                    .first()
                    .is_some_and(|item| item.finish_tick <= self.tick);
                let research = unit
                    .production
                    .first()
                    .is_some_and(|item| item.kind.starts_with("research_"));
                let exit = (due && !research)
                    .then(|| {
                        [65.0, 100.0, 140.0].into_iter().find_map(|radius| {
                            (0..8).find_map(|index| {
                                let angle = (index as f32 + 2.0) * std::f32::consts::FRAC_PI_4;
                                let point =
                                    (unit.x + radius * angle.cos(), unit.y + radius * angle.sin());
                                (navigation.free(point.0, point.1)
                                    && !mobiles.any_within(point.0, point.1, 20.0, true, |_| true))
                                .then_some(point)
                            })
                        })
                    })
                    .flatten();
                if due && (research || exit.is_some()) {
                    let item = unit.production.remove(0);
                    if item.kind.starts_with("research_") {
                        discoveries.push((unit.owner, item.kind));
                    } else {
                        let (spawn_x, spawn_y) = exit.unwrap();
                        births.push((unit.owner, item.kind, spawn_x, spawn_y, unit.order.clone()));
                    }
                }
                // A finished refinery extracts catalyst from the deposit under
                // it on its own, with no workers, until the deposit is empty.
                if unit.kind == "refinery" && self.tick % REFINERY_INTERVAL_TICKS == 0 {
                    if let Some(node) = self.nodes.iter_mut().find(|node| {
                        node.kind == ResourceKind::Catalyst
                            && node.amount > 0
                            && distance(node.x, node.y, unit.x, unit.y) < 1.0
                    }) {
                        let amount = REFINERY_YIELD.min(node.amount);
                        node.amount -= amount;
                        credit_mined(
                            &mut self.balances,
                            &mut self.collected,
                            unit.owner,
                            factions.get(&unit.owner).copied().unwrap_or_default(),
                            node.kind,
                            amount,
                        );
                    }
                }
                if !is_static_defense(&unit.kind) {
                    continue;
                }
            }
            // Passive upkeep that runs whatever the unit is doing, from
            // start-of-tick state: Entrenchment's anchor, a medic's heal and a
            // warden's aura. The rest of the passives fire where their trigger
            // is (the shot, the damage step, the death).
            match passive(&unit.kind) {
                Some(Passive::Entrenchment) => {
                    if distance(unit.x, unit.y, unit.anchor_x, unit.anchor_y) > ENTRENCH_RADIUS {
                        unit.anchor_x = unit.x;
                        unit.anchor_y = unit.y;
                        unit.anchor_tick = self.tick;
                    } else if self.tick.saturating_sub(unit.anchor_tick) >= ENTRENCH_HOLD_TICKS {
                        unit.passive_ready_tick = self.tick + ENTRENCH_LINGER_TICKS;
                    }
                }
                Some(Passive::FieldMedic) if unit.passive_ready_tick <= self.tick => {
                    // The most-damaged friendly unit in reach (most hit points
                    // missing, ties on the lower id), never the medic itself.
                    let patient = mobiles
                        .within(unit.x, unit.y, MEDIC_RANGE)
                        .into_iter()
                        .map(|at| &snapshot[at])
                        .filter(|other| {
                            other.owner == unit.owner && other.id != unit.id && other.hp < other.max_hp
                        })
                        .max_by_key(|other| (other.max_hp - other.hp, std::cmp::Reverse(other.id)));
                    if let Some(patient) = patient {
                        *hits.medic.entry(patient.id).or_default() += MEDIC_HEAL;
                        unit.passive_ready_tick = self.tick + MEDIC_INTERVAL_TICKS;
                    }
                }
                Some(Passive::ShieldAura) if self.tick % SHIELD_REGEN_INTERVAL_TICKS == 0 => {
                    for at in mobiles.within(unit.x, unit.y, SHIELD_AURA_RADIUS) {
                        let other = &snapshot[at];
                        if other.owner == unit.owner && other.max_shields > 0 {
                            hits.aura.insert(other.id);
                        }
                    }
                }
                _ => {}
            }
            // Weapon range, with an entrenched marksman's bonus.
            let range = definition.range
                + if entrenched(unit, self.tick) {
                    ENTRENCH_RANGE
                } else {
                    0.0
                };
            let mut completed = false;
            match unit.order.kind.as_str() {
                "repair" => {
                    if let Some(target) = by_id(&snapshot, unit.order.target)
                        .filter(|target| target.owner == unit.owner)
                    {
                        let missing = target.max_hp
                            - target.hp
                            - repairs.get(&target.id).copied().unwrap_or(0);
                        if missing <= 0 {
                            completed = true;
                        } else if advance(
                            unit,
                            target.x,
                            target.y,
                            if is_building(&target.kind) {
                                55.0
                            } else {
                                24.0
                            },
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
                    let reach = range.max(180.0);
                    // An unarmed unit (the medic) attack-moves as a plain move:
                    // it never walks into a fight it cannot join.
                    let target = by_id(&snapshot, unit.order.target)
                        .filter(|target| {
                            definition.damage > 0
                                && target.owner != unit.owner
                                && distance(unit.x, unit.y, target.x, target.y) <= reach
                        })
                        .or_else(|| {
                            // Nearest enemy in reach, ties on the lower id.
                            if definition.damage == 0 {
                                return None;
                            }
                            nearby
                                .nearest(unit.x, unit.y, reach, |at| {
                                    snapshot[at].owner != unit.owner
                                })
                                .map(|at| &snapshot[at])
                        });
                    if let Some(target) = target {
                        unit.order.target = target.id;
                        let stop_range = if navigation.line_of_sight(unit.x, unit.y, target.x, target.y) {
                            range * 0.9
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
                // Network: channel in place, then move instantly to anywhere
                // in the owner's power field. Both ends are checked again when
                // the channel completes, against this tick's field: a relay
                // killed during the channel strands the unit where it stands.
                // Damage during the channel cancels it (see the damage step).
                "teleport" => {
                    if self.tick >= unit.warp_tick {
                        let (destination_x, destination_y) = (unit.order.x, unit.order.y);
                        if zones.powered(unit.owner, unit.x, unit.y)
                            && zones.powered(unit.owner, destination_x, destination_y)
                        {
                            let landing = if navigation.free(destination_x, destination_y) {
                                Some((destination_x, destination_y))
                            } else {
                                navigation.escape(destination_x, destination_y)
                            };
                            if let Some((x, y)) = landing {
                                unit.x = x;
                                unit.y = y;
                                unit.arrive_tick = self.tick + TELEPORT_ARRIVAL_TICKS;
                            }
                        }
                        completed = true;
                    }
                }
                "attack" => {
                    if let Some(target) = by_id(&snapshot, unit.order.target) {
                        let stop_range = if navigation.line_of_sight(unit.x, unit.y, target.x, target.y) {
                            range * 0.9
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
                    if !node_at(unit.order.target).is_some_and(|at| minable(&self.nodes[at]))
                    {
                        match replacement_patch(&self.nodes, unit) {
                            Some(id) => unit.order.target = id,
                            None => completed = true,
                        }
                    }
                    let (interval, pulse) = drifter_pulse(logistics);
                    if let Some(index) = node_at(unit.order.target).filter(|at| minable(&self.nodes[*at]))
                    {
                        let (node_x, node_y) = (self.nodes[index].x, self.nodes[index].y);
                        if advance(unit, node_x, node_y, 28.0) {
                            let miner = self.nodes[index].miner;
                            if miner != 0 && miner != unit.id {
                                // Taken: move to a free patch on the same line,
                                // else wait here until it frees.
                                if let Some(id) = pick_patch(
                                    &self.nodes,
                                    unit.x,
                                    unit.y,
                                    unit.id,
                                    Some(MINER_RETARGET_RADIUS),
                                    true,
                                ) {
                                    unit.order.target = id;
                                }
                            } else {
                                // A drifter holds its patch for as long as it
                                // stands here gathering.
                                let node = &mut self.nodes[index];
                                node.miner = unit.id;
                                if self.tick % interval == 0 {
                                    // What leaves the deposit arrives in exactly
                                    // one balance, in the deposit's own currency.
                                    let amount = pulse.min(node.amount);
                                    node.amount -= amount;
                                    credit_mined(
                                        &mut self.balances,
                                        &mut self.collected,
                                        unit.owner,
                                        factions.get(&unit.owner).copied().unwrap_or_default(),
                                        node.kind,
                                        amount,
                                    );
                                }
                            }
                        }
                    }
                }
                "gather" | "return" => {
                    if unit.cargo >= capacity {
                        unit.returning = true;
                    }
                    if unit.returning || unit.order.kind == "return" {
                        if let Some(hq) = hubs
                            .iter()
                            .copied()
                            .filter(|target| target.owner == unit.owner)
                            .min_by(|left, right| {
                                distance(unit.x, unit.y, left.x, left.y)
                                    .total_cmp(&distance(unit.x, unit.y, right.x, right.y))
                                    .then(left.id.cmp(&right.id))
                            })
                        {
                            if advance(unit, hq.x, hq.y, 45.0) {
                                // The load came out of a deposit, so the
                                // delivery is the moment it becomes collected.
                                // Both carriers — worker and harvester — arrive
                                // here; the drifter never does.
                                credit_mined(
                                    &mut self.balances,
                                    &mut self.collected,
                                    unit.owner,
                                    factions.get(&unit.owner).copied().unwrap_or_default(),
                                    unit.cargo_kind,
                                    unit.cargo,
                                );
                                unit.cargo = 0;
                                unit.returning = false;
                                completed = unit.order.kind == "return";
                            }
                        } else {
                            completed = true;
                        }
                    } else {
                        // A depleted patch (or one that is not material) sends
                        // the carrier to the nearest *free* patch, else the
                        // nearest at all.
                        if !node_at(unit.order.target).is_some_and(|at| minable(&self.nodes[at]))
                        {
                            if let Some(id) = replacement_patch(&self.nodes, unit) {
                                unit.order.target = id;
                            } else if unit.cargo > 0 {
                                unit.returning = true;
                            } else {
                                completed = true;
                            }
                        }
                        if let Some(index) = node_at(unit.order.target).filter(|at| minable(&self.nodes[*at]))
                        {
                            let (node_x, node_y) = (self.nodes[index].x, self.nodes[index].y);
                            if unit.cargo > 0 && unit.cargo_kind != self.nodes[index].kind {
                                // One load is one currency: deliver first.
                                unit.returning = true;
                            } else if advance(unit, node_x, node_y, 28.0) {
                                let miner = self.nodes[index].miner;
                                if miner != 0 && miner != unit.id {
                                    // Taken (claims resolve in unit-id order,
                                    // the order this loop runs in): move to a
                                    // free patch on the same line, else wait
                                    // beside this one until it frees.
                                    if let Some(id) = pick_patch(
                                        &self.nodes,
                                        unit.x,
                                        unit.y,
                                        unit.id,
                                        Some(MINER_RETARGET_RADIUS),
                                        true,
                                    ) {
                                        unit.order.target = id;
                                    }
                                } else {
                                    let node = &mut self.nodes[index];
                                    node.miner = unit.id;
                                    if self.tick % MINING_PULSE_TICKS == 0 {
                                        let amount = mining_yield(logistics)
                                            .min(node.amount)
                                            .min(capacity - unit.cargo);
                                        node.amount -= amount;
                                        unit.cargo_kind = node.kind;
                                        unit.cargo += amount;
                                        if unit.cargo == capacity || node.amount == 0 {
                                            unit.returning = true;
                                            // Turning to walk home frees the
                                            // patch for the next miner.
                                            node.miner = 0;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
            // A channelling unit holds its fire: the channel is a commitment,
            // not something to do between shots.
            if definition.damage > 0
                && unit.next_attack <= self.tick
                && unit.order.kind != "teleport"
            {
                let target = if matches!(unit.order.kind.as_str(), "attack" | "attack_move") {
                    by_id(&snapshot, unit.order.target)
                } else {
                    // Nearest enemy in range with a clear shot, ties on the
                    // lower id. Sight is only tested on a candidate that would
                    // beat the best so far, which picks the same target.
                    nearby
                        .nearest(unit.x, unit.y, range, |at| {
                            let target = &snapshot[at];
                            target.owner != unit.owner
                                && navigation.line_of_sight(unit.x, unit.y, target.x, target.y)
                        })
                        .map(|at| &snapshot[at])
                };
                if let Some(target) = target.filter(|target| {
                    distance(unit.x, unit.y, target.x, target.y) <= range
                        && navigation.line_of_sight(unit.x, unit.y, target.x, target.y)
                }) {
                    let base = definition.damage + if has_tech("research_weapons") { 4 } else { 0 };
                    let mut hit = attack_damage(&unit.kind, &target.kind, base);
                    let attacker = passive(&unit.kind);
                    // Overwatch: the first attack after a long rest opens a
                    // window in which every attack hits harder.
                    if attacker == Some(Passive::Overwatch) {
                        let open = unit.passive_ready_tick > self.tick;
                        if !open
                            && self.tick.saturating_sub(unit.shot_tick) >= OVERWATCH_IDLE_TICKS
                        {
                            unit.passive_ready_tick = self.tick + OVERWATCH_WINDOW_TICKS;
                        }
                        if unit.passive_ready_tick > self.tick {
                            hit = hit * OVERWATCH_PERCENT / 100;
                        }
                    }
                    let source = (unit.owner, unit.id);
                    let landed = mitigated(hit, target, researched_armour(target.owner), self.tick);
                    hits.deal(&snapshot, &guardians, self.tick, target, source, landed);
                    match attacker {
                        // Splash: a share of the hit on every other enemy unit
                        // around the target, each by its own armour and kind.
                        Some(Passive::Splash) => {
                            if let Some(radius) = splash_radius(&unit.kind) {
                                for at in nearby.within(target.x, target.y, radius) {
                                    let other = &snapshot[at];
                                    if other.owner != unit.owner
                                        && other.id != target.id
                                        && !is_building(&other.kind)
                                    {
                                        let share =
                                            attack_damage(&unit.kind, &other.kind, base) * SPLASH_PERCENT / 100;
                                        let share = mitigated(
                                            share,
                                            other,
                                            researched_armour(other.owner),
                                            self.tick,
                                        );
                                        hits.deal(&snapshot, &guardians, self.tick, other, source, share);
                                    }
                                }
                            }
                        }
                        // Ricochet: the hit jumps from target to target, each
                        // time to the nearest enemy unit not yet struck.
                        Some(Passive::Ricochet) => {
                            let mut struck = vec![target.id];
                            let mut from = (target.x, target.y);
                            for percent in RICOCHET_PERCENTS.iter().take(ricochet_bounces(&unit.kind)) {
                                let next = nearby.nearest(from.0, from.1, RICOCHET_RADIUS, |at| {
                                    let other = &snapshot[at];
                                    other.owner != unit.owner
                                        && !is_building(&other.kind)
                                        && !struck.contains(&other.id)
                                });
                                let Some(at) = next else { break };
                                let other = &snapshot[at];
                                let share = attack_damage(&unit.kind, &other.kind, base) * percent / 100;
                                let share =
                                    mitigated(share, other, researched_armour(other.owner), self.tick);
                                hits.deal(&snapshot, &guardians, self.tick, other, source, share);
                                struck.push(other.id);
                                from = (other.x, other.y);
                            }
                        }
                        // Predator: a share of the damage dealt heals the
                        // attacker when the damage step runs.
                        Some(Passive::Predator) => {
                            *hits.feed.entry(unit.id).or_default() += landed * PREDATOR_PERCENT / 100;
                        }
                        _ => {}
                    }
                    let cooldown = if attacker == Some(Passive::Veteran) {
                        veteran_cooldown(definition.cooldown, unit.kills)
                    } else {
                        definition.cooldown
                    };
                    unit.next_attack = self.tick + cooldown;
                    unit.shot_tick = self.tick;
                    unit.contact_tick = self.tick;
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
        for (owner, research) in discoveries {
            let known = self.research.entry(owner).or_default();
            if !known.contains(&research) {
                known.push(research);
            }
        }
        // Death Burst, before anything is applied: a behemoth whose damage this
        // tick would kill it hits every enemy unit around it, and the burst can
        // kill another behemoth, so this runs until no new one falls. A burst
        // goes through `deal` like any other damage, attributed to the dying
        // behemoth's slot.
        let mut burst = BTreeSet::<u32>::new();
        loop {
            let fresh: Vec<u32> = hits
                .damage
                .iter()
                .filter(|(id, incoming)| {
                    !burst.contains(*id)
                        && by_id(&snapshot, **id).is_some_and(|unit| {
                            passive(&unit.kind) == Some(Passive::DeathBurst)
                                && unit.construction_remaining == 0
                                && **incoming
                                    >= unit.hp + repairs.get(&unit.id).copied().unwrap_or(0) + unit.shields
                        })
                })
                .map(|(id, _)| *id)
                .collect();
            if fresh.is_empty() {
                break;
            }
            for id in fresh {
                burst.insert(id);
                let dying = by_id(&snapshot, id).expect("a burst source is in the snapshot");
                for at in mobiles.within(dying.x, dying.y, DEATH_BURST_RADIUS) {
                    let other = &snapshot[at];
                    if other.owner != dying.owner {
                        let amount = mitigated(
                            DEATH_BURST_DAMAGE,
                            other,
                            researched_armour(other.owner),
                            self.tick,
                        );
                        hits.deal(&snapshot, &guardians, self.tick, other, (dying.owner, dying.id), amount);
                    }
                }
            }
        }
        for unit in &mut self.units {
            if let Some(work) = construction.get(&unit.id) {
                let definition = stats(&unit.kind).unwrap();
                let before = unit.construction_remaining;
                unit.construction_remaining = before.saturating_sub(*work);
                let total = unit.max_hp - unit.max_hp / 10;
                let old_hp =
                    total as u64 * (definition.training_ticks - before) / definition.training_ticks;
                let new_hp = total as u64
                    * (definition.training_ticks - unit.construction_remaining)
                    / definition.training_ticks;
                unit.hp = (unit.hp + (new_hp - old_hp) as i32).min(unit.max_hp);
                // Shields rise from nothing to full over the same work, so a
                // finished Network building is at full health rather than
                // waiting minutes to regenerate half of it.
                let shields = unit.max_shields as u64;
                let old_shields =
                    shields * (definition.training_ticks - before) / definition.training_ticks;
                let new_shields = shields
                    * (definition.training_ticks - unit.construction_remaining)
                    / definition.training_ticks;
                unit.shields =
                    (unit.shields + (new_shields - old_shields) as i32).min(unit.max_shields);
            }
            unit.hp += repairs.get(&unit.id).copied().unwrap_or(0);
            if let Some(heal) = hits.medic.get(&unit.id) {
                unit.hp = (unit.hp + heal).min(unit.max_hp);
            }
            if let Some(heal) = hits.feed.get(&unit.id) {
                // Predator: hit points first, and only the overflow reaches
                // shields, for a unit that has any.
                let healed = (*heal).min(unit.max_hp - unit.hp).max(0);
                unit.hp += healed;
                unit.shields = (unit.shields + heal - healed).min(unit.max_shields);
            }
            let incoming = hits.damage.get(&unit.id).copied().unwrap_or(0);
            if hits.phased.contains(&unit.id) {
                unit.passive_ready_tick = self.tick + PHASE_COOLDOWN_TICKS;
            }
            let aura = self.tick % SHIELD_REGEN_INTERVAL_TICKS == 0
                && hits.aura.contains(&unit.id)
                && unit.shields < unit.max_shields
                && unit.construction_remaining == 0;
            let mut natural_regen = false;
            if incoming > 0 {
                // Shields take the hit first; hit points only take what the
                // shields could not.
                let absorbed = incoming.min(unit.shields);
                unit.shields -= absorbed;
                unit.hp -= incoming - absorbed;
                unit.damaged_tick = self.tick;
                unit.contact_tick = self.tick;
                if let Some(attacker) = hits.last_attacker.get(&unit.id) {
                    unit.last_attacker = *attacker;
                }
                if unit.order.kind == "teleport" {
                    unit.order = if unit.queue.is_empty() {
                        Order::idle()
                    } else {
                        unit.queue.remove(0)
                    };
                }
            } else if unit.shields < unit.max_shields
                && unit.construction_remaining == 0
                && self.tick % SHIELD_REGEN_INTERVAL_TICKS == 0
                && (unit.damaged_tick == 0
                    || self.tick - unit.damaged_tick >= SHIELD_REGEN_DELAY_TICKS)
            {
                // Faster in the owner's power field. Read at the end-of-tick
                // position against the start-of-tick field.
                let rate = shield_regen(zones.shield_regen_percent(unit.owner, unit.x, unit.y));
                unit.shields = (unit.shields + rate).min(unit.max_shields);
                natural_regen = true;
            }
            // Shield Aura: a regeneration step with no damage delay, unless the
            // ordinary one already ran on this tick (they do not stack).
            if aura && !natural_regen {
                unit.shields = (unit.shields + SHIELD_AURA_PER_INTERVAL).min(unit.max_shields);
            }
            // Regrowth: after a spell without damage, a share of maximum hit
            // points every second.
            if incoming == 0
                && passive(&unit.kind) == Some(Passive::Regrowth)
                && unit.hp > 0
                && unit.hp < unit.max_hp
                && self.tick % TICKS_PER_SECOND == 0
                && self.tick.saturating_sub(unit.damaged_tick) >= REGROWTH_DELAY_TICKS
            {
                unit.hp = (unit.hp + (unit.max_hp * REGROWTH_PERCENT_PER_SECOND / 100).max(1))
                    .min(unit.max_hp);
            }
            // Battle Blink: a survivor of a hostile hit that left it at or
            // below the threshold jumps `BLINK_DISTANCE` straight away from
            // whatever hit it last, to legal ground, once per cooldown.
            if incoming > 0
                && unit.hp > 0
                && passive(&unit.kind) == Some(Passive::BattleBlink)
                && unit.passive_ready_tick <= self.tick
                && (unit.hp + unit.shields) * 100
                    <= BLINK_THRESHOLD_PERCENT * (unit.max_hp + unit.max_shields)
            {
                if let Some(attacker) = by_id(&snapshot, unit.last_attacker) {
                    let (dx, dy) = (unit.x - attacker.x, unit.y - attacker.y);
                    let length = (dx * dx + dy * dy).sqrt();
                    let (nx, ny) = if length < 0.01 { (1.0, 0.0) } else { (dx / length, dy / length) };
                    let destination = (
                        (unit.x + nx * BLINK_DISTANCE).clamp(16.0, map.size - 16.0),
                        (unit.y + ny * BLINK_DISTANCE).clamp(16.0, map.size - 16.0),
                    );
                    let landing = if navigation.free(destination.0, destination.1) {
                        Some(destination)
                    } else {
                        navigation.escape(destination.0, destination.1)
                    };
                    if let Some((x, y)) = landing {
                        unit.x = x;
                        unit.y = y;
                        unit.passive_ready_tick = self.tick + BLINK_COOLDOWN_TICKS;
                    }
                }
            }
        }
        // Veteran credit: each dead enemy unit counts one kill for the unit
        // that did the most damage to it this tick (ties on the lower id).
        // Buildings and temporary units are not counted. Damage from earlier
        // ticks is not remembered, the same last-hit convention as `killed`.
        let mut credits = BTreeMap::<u32, u16>::new();
        for unit in self.units.iter().filter(|unit| {
            unit.hp <= 0 && !is_building(&unit.kind) && !is_temporary(&unit.kind)
        }) {
            let killer = hits
                .by_unit
                .range((unit.id, u32::MIN)..=(unit.id, u32::MAX))
                .max_by_key(|((_, attacker), amount)| (**amount, std::cmp::Reverse(*attacker)))
                .map(|((_, attacker), _)| *attacker);
            if let Some(killer) = killer {
                *credits.entry(killer).or_default() += 1;
            }
        }
        for unit in &mut self.units {
            if let Some(count) = credits.get(&unit.id) {
                unit.kills = unit.kills.saturating_add(*count);
            }
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
        // The same deaths, read for the power field. One of an owner's entities
        // dying inside that owner's field restores shields to the owner's other
        // entities nearby, by a share of the dead entity's total health. Same
        // snapshot rule as the spawns, and applied with them, after
        // elimination. The additions are each capped at the recipient's
        // maximum, so the order they are applied in cannot change the result.
        let restores: Vec<(u8, f32, f32, i32)> = self
            .units
            .iter()
            .filter(|unit| unit.hp <= 0)
            .filter_map(|unit| {
                let percent = zones.restores_on_death(unit.owner, unit.x, unit.y)?;
                let amount = (unit.max_hp + unit.max_shields) * percent / 100;
                (amount > 0).then_some((unit.owner, unit.x, unit.y, amount))
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
                let killer = hits
                    .dealt
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
        let survivors = self.survivors();
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
        for (owner, x, y, amount) in restores {
            for unit in &mut self.units {
                if unit.owner == owner
                    && unit.max_shields > 0
                    && distance(unit.x, unit.y, x, y) <= POWER_RESTORE_RADIUS
                {
                    unit.shields = (unit.shields + amount).min(unit.max_shields);
                }
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
                        .filter(|node| !is_labour(&kind) || minable(node))
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
                } else if is_labour(&kind) {
                    // No rally: new labour goes straight to work on the nearest
                    // material deposit to where it appeared. An idle worker by
                    // the HQ is never what a player wants, and for a drifter
                    // trained at a far relay it is what makes that an expansion.
                    self.nodes
                        .iter()
                        .filter(|node| node.kind == ResourceKind::Material && node.amount > 0)
                        .min_by(|left, right| {
                            distance(x, y, left.x, left.y)
                                .total_cmp(&distance(x, y, right.x, right.y))
                                .then(left.id.cmp(&right.id))
                        })
                        .map(|node| Order {
                            kind: "gather".into(),
                            x: 0.0,
                            y: 0.0,
                            target: node.id,
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
            let previous = by_id(&snapshot, unit.id).map(|old| (old.x, old.y));
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
        // A bloom has no source entity: it is live until it expires.
        let mut creep: Vec<CreepPatch> = self
            .creep
            .iter()
            .filter_map(|patch| {
                let alive = if patch.expires_tick > 0 {
                    tick < patch.expires_tick
                } else {
                    live(patch.source)
                };
                advance_patch(*patch, alive, tick)
            })
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
                creep.push(CreepPatch::sprouting(
                    unit.id, unit.owner, unit.x, unit.y, max,
                ));
            }
        }
        creep.sort_unstable_by_key(|patch| patch.source);
        self.creep = creep;
    }

    /// Everything that decides whether `caster` may cast `spell` at `order`
    /// right now, beyond the checks every order shares.
    fn validate_cast(
        &self,
        caster: &Entity,
        spell: &Ability,
        order: &Order,
        map: &MapDefinition,
    ) -> Result<(), String> {
        let faction = self.faction(caster.owner);
        if faction != spell.faction {
            return Err(format!(
                "Only the {} faction can cast {}; you are playing {faction}",
                spell.faction, spell.label
            ));
        }
        if !is_hub(&caster.kind) {
            return Err(format!("{} is cast by a hub", spell.label));
        }
        if caster.cast.is_some() {
            return Err("This hub is already channelling".into());
        }
        if self.tick < caster.ability_ready_tick {
            let left = (caster.ability_ready_tick - self.tick).div_ceil(20);
            return Err(format!("{} is recharging: {left}s left", spell.label));
        }
        if caster.energy < spell.energy {
            return Err(format!(
                "Not enough energy: {} needed, {} available",
                spell.energy, caster.energy
            ));
        }
        validate_position(order.x, order.y, map.size)?;
        match spell.kind {
            "recall" => {
                if !self
                    .units
                    .iter()
                    .any(|unit| recallable(unit, caster.owner, order.x, order.y))
                {
                    return Err("None of your units are near that point to recall".into());
                }
            }
            "bloom" => {
                if !self.on_creep(caster.owner, order.x, order.y) {
                    return Err("Bloom must be placed on your own creep".into());
                }
            }
            _ => unreachable!("every ability is validated"),
        }
        Ok(())
    }

    /// Is `(x, y)` on any of `owner`'s creep, blooms included?
    pub fn on_creep(&self, owner: u8, x: f32, y: f32) -> bool {
        self.creep.iter().any(|patch| {
            patch.owner == owner && distance(x, y, patch.x, patch.y) <= f32::from(patch.radius)
        })
    }

    /// Spends the energy, starts the cooldown and either takes effect at once
    /// or starts the channel. Called only after `validate_cast` passed.
    fn cast(&mut self, caster: u32, spell: &Ability, order: &Order) {
        let tick = self.tick;
        let Some(unit) = self.units.iter_mut().find(|unit| unit.id == caster) else {
            return;
        };
        unit.energy -= spell.energy;
        unit.ability_ready_tick = tick + spell.cooldown_ticks;
        if spell.channel_ticks > 0 {
            unit.cast = Some(Cast {
                kind: spell.kind.into(),
                x: order.x,
                y: order.y,
                complete_tick: tick + spell.channel_ticks,
            });
            return;
        }
        let owner = unit.owner;
        if spell.kind == BLOOM.kind {
            // The id is taken from the entity counter so it sorts and never
            // collides, but no entity is ever spawned with it.
            let source = self.next_id;
            self.next_id += 1;
            self.creep.push(CreepPatch::bloom(
                source,
                owner,
                order.x,
                order.y,
                tick + BLOOM_LIFETIME_TICKS,
            ));
            self.creep.sort_unstable_by_key(|patch| patch.source);
        }
    }

    /// Resolves every channelled cast that completes this tick. A hub that
    /// died during the channel took its cast with it, so there is nothing to
    /// interrupt here. Expects `self.units` sorted by id.
    fn resolve_casts(&mut self, map: &MapDefinition) {
        let tick = self.tick;
        let due: Vec<(u8, f32, f32, Cast)> = self
            .units
            .iter_mut()
            .filter(|unit| {
                unit.cast
                    .as_ref()
                    .is_some_and(|cast| cast.complete_tick <= tick)
            })
            .map(|unit| (unit.owner, unit.x, unit.y, unit.cast.take().unwrap()))
            .collect();
        for (owner, hub_x, hub_y, cast) in due {
            debug_assert_eq!(cast.kind, RECALL.kind);
            // Landing spots are searched against the world as it stands
            // before anyone moves: units never block landing, and the
            // separation step spreads the arrivals out afterwards.
            let navigation = Navigation::new(map, &self.units);
            let mut landed = 0usize;
            for unit in &mut self.units {
                if !recallable(unit, owner, cast.x, cast.y) {
                    continue;
                }
                // A spiral around the hub: the golden angle keeps neighbours
                // apart, and every eight arrivals step one ring further out.
                let angle = landed as f32 * 2.399_963;
                let ring = 60.0 + 16.0 * (landed / 8) as f32;
                let (x, y) = (hub_x + angle.cos() * ring, hub_y + angle.sin() * ring);
                let landing = if navigation.free(x, y) {
                    Some((x, y))
                } else {
                    navigation.escape(x, y)
                };
                let Some((x, y)) = landing else {
                    continue;
                };
                landed += 1;
                unit.x = x;
                unit.y = y;
                unit.order = Order::idle();
                unit.queue.clear();
                unit.returning = false;
                unit.arrive_tick = tick + TELEPORT_ARRIVAL_TICKS;
                // Shield-funded: every recalled unit arrives with its shields
                // spent, and they wait the usual delay before regenerating.
                unit.shields = 0;
                unit.damaged_tick = tick;
            }
        }
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

    /// Slots still in the match: those holding at least one *completed* hub,
    /// the HQ or any outpost. A hub still under construction does not keep a
    /// player alive, so a last-second outpost site cannot stall elimination.
    pub fn survivors(&self) -> BTreeSet<u8> {
        self.units
            .iter()
            .filter(|unit| is_hub(&unit.kind) && unit.construction_remaining == 0)
            .map(|unit| unit.owner)
            .collect()
    }

    pub fn has_research(&self, owner: u8, kind: &str) -> bool {
        self.research
            .get(&owner)
            .is_some_and(|research| research.iter().any(|item| item == kind))
    }

    fn resolve_outcome(&mut self) {
        let survivors = self.survivors();
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
    ///
    /// The rule is a single ordered pass: for each mobile `left` in index
    /// order, every later mobile `right` in index order is pushed apart from it
    /// if the two are closer than `SEPARATION` *at that moment* — positions
    /// change as the pass runs, and later pairs see earlier pushes.
    ///
    /// That rule is unchanged; only how the later units are found is. Instead
    /// of visiting every later unit, `left` visits the later units a bucket
    /// grid places within `SEPARATION + DRIFT` of where `left` stood when it
    /// asked. The grid follows every push, and the moment `left` itself has
    /// been pushed more than `DRIFT` from where it asked, it asks again. A
    /// later unit that is not a candidate is therefore at least `SEPARATION`
    /// away whenever the full pass would have compared it, so the pairs pushed,
    /// their order and their arithmetic are exactly those of the full pass.
    fn separate_units(&mut self, world_size: f32) {
        const SEPARATION: f32 = 18.0;
        const DRIFT: f32 = 12.0;
        const BUCKET: f32 = 64.0;
        let side = ((world_size / BUCKET).ceil() as i32).max(1);
        let bucket_of = |x: f32, y: f32| -> usize {
            let column = ((x / BUCKET) as i32).clamp(0, side - 1);
            let row = ((y / BUCKET) as i32).clamp(0, side - 1);
            (row * side + column) as usize
        };
        let mut buckets: Vec<Vec<u32>> = vec![Vec::new(); (side * side) as usize];
        let mut home = vec![usize::MAX; self.units.len()];
        for (at, unit) in self.units.iter().enumerate() {
            if !is_building(&unit.kind) {
                home[at] = bucket_of(unit.x, unit.y);
                buckets[home[at]].push(at as u32);
            }
        }
        // Later mobiles in buckets near `(x, y)`, ascending by index.
        let gather = |buckets: &Vec<Vec<u32>>, x: f32, y: f32, after: usize, out: &mut Vec<usize>| {
            out.clear();
            let reach = SEPARATION + DRIFT + 1.0;
            let clamp = |value: f32| ((value / BUCKET) as i32).clamp(0, side - 1);
            for row in clamp(y - reach)..=clamp(y + reach) {
                for column in clamp(x - reach)..=clamp(x + reach) {
                    out.extend(
                        buckets[(row * side + column) as usize]
                            .iter()
                            .map(|at| *at as usize)
                            .filter(|at| *at > after),
                    );
                }
            }
            out.sort_unstable();
        };
        let mut candidates = Vec::new();
        for left_index in 0..self.units.len() {
            if is_building(&self.units[left_index].kind) {
                continue;
            }
            let mut origin = (self.units[left_index].x, self.units[left_index].y);
            gather(&buckets, origin.0, origin.1, left_index, &mut candidates);
            let mut cursor = 0;
            while cursor < candidates.len() {
                let right_index = candidates[cursor];
                cursor += 1;
                let (left_slice, right_slice) = self.units.split_at_mut(left_index + 1);
                let left = &mut left_slice[left_index];
                let right = &mut right_slice[right_index - left_index - 1];
                let gap = distance(left.x, left.y, right.x, right.y);
                if gap >= SEPARATION {
                    continue;
                }
                let (normal_x, normal_y) = if gap < 0.01 {
                    (1.0, 0.0)
                } else {
                    ((right.x - left.x) / gap, (right.y - left.y) / gap)
                };
                let push = (SEPARATION - gap) * 0.5;
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
                let moved = bucket_of(right.x, right.y);
                if moved != home[right_index] {
                    let list = &mut buckets[home[right_index]];
                    let slot = list
                        .iter()
                        .position(|at| *at as usize == right_index)
                        .expect("every mobile is in its bucket");
                    list.swap_remove(slot);
                    buckets[moved].push(right_index as u32);
                    home[right_index] = moved;
                }
                let (left_x, left_y) = (left.x, left.y);
                if distance(origin.0, origin.1, left_x, left_y) > DRIFT {
                    origin = (left_x, left_y);
                    gather(&buckets, left_x, left_y, right_index, &mut candidates);
                    cursor = 0;
                }
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

    /// Material the permanent base income paid between two ticks.
    fn stipend_between(from: u64, to: u64) -> u32 {
        (crate::stipend_total(to) - crate::stipend_total(from)) as u32
    }

    /// What a `factional` world's untouched slot holds: nothing but the base
    /// income, which no longer ends.
    fn base_income_only(world: &World) -> Balance {
        Balance::new(
            stipend_between(crate::STIPEND_SECOND_PHASE_END_TICK, world.tick),
            0,
        )
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
    fn every_army_kind_of_every_faction_can_be_ordered_at_its_building() {
        for faction in crate::FACTION_ROTATION {
            let mut world = World::new_on_with_factions(crate::maps::default_map(), &[(0, faction)]);
            idle_labour(&mut world);
            world.balances.insert(0, Balance::new(5000, 5000));
            let [x, y] = crate::maps::default_map().starts[0];
            world.spawn(0, "barracks", x + 200.0, y);
            let barracks = world.units.last().unwrap().id;
            world.spawn(0, "factory", x, y + 200.0);
            let factory = world.units.last().unwrap().id;
            let roster: Vec<&str> = crate::ARMY_KINDS
                .iter()
                .copied()
                .filter(|kind| crate::army_faction(kind) == Some(faction))
                .collect();
            assert_eq!(roster.len(), 6, "{faction} fields six army kinds");
            for kind in roster {
                let building = if crate::army_building(kind) == Some("factory") {
                    factory
                } else {
                    barracks
                };
                world
                    .validate(&command(1, 0, building, &format!("train_{kind}"), 0))
                    .unwrap_or_else(|reason| panic!("{faction} cannot train {kind}: {reason}"));
            }
        }
    }

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
                refused.contains("HQ")
                    || refused.contains("barracks")
                    || refused.contains("factory"),
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
        world
            .validate(&command(3, 0, barracks, "train_soldier", 0))
            .unwrap();
        world
            .validate(&command(4, 0, barracks, "train_scout", 0))
            .unwrap();
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
    fn a_worker_sent_behind_its_hub_after_a_delivery_routes_around_it() {
        // Worker 2 delivers on the north-east side of the crossfire HQ and is
        // then sent to a material patch behind it, to the west. It stands at
        // 45 from the hub, in a cell centred inside the hub's 44 footprint;
        // routing from that cell used to fail, and the worker stood there for
        // the rest of the match. Labour is no longer walked off to build
        // sites, so nothing else ever moved it out.
        let map = crate::maps::by_id("crossfire").unwrap();
        let mut world =
            World::new_on_with_factions(map, &[(0, Faction::Industrial), (1, Faction::Network)]);
        for _ in 0..60 {
            world.step_on(map);
        }
        world
            .execute_on(&command(1, 0, 2, "gather", 4), map)
            .unwrap();
        for _ in 0..400 {
            world.step_on(map);
            if node_of(&world, 4).amount < 1500 {
                return;
            }
        }
        panic!(
            "worker 2 never reached the patch behind the hub: {:?}",
            (unit_of(&world, 2).x, unit_of(&world, 2).y)
        );
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
        assert_eq!(
            after, before,
            "a movement field must not extend weapon reach"
        );
    }

    // --- Organic creep -------------------------------------------------------

    fn patch_of(world: &World, source: u32) -> Option<CreepPatch> {
        world
            .creep
            .iter()
            .find(|patch| patch.source == source)
            .copied()
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
                expires_tick: 0,
            }],
            "one full patch, the Organic HQ's; the Industrial HQ spreads nothing"
        );
        // The field reads it on the very first tick, as movement (the
        // harvesters' off-creep slow) and death only.
        let field = zones_of(&world.units, &world.creep, &world.factions);
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
        let field = zones_of(&world.units, &world.creep, &world.factions);
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
            let field = zones_of(&world.units, &world.creep, &world.factions);
            assert!(
                field.iter().any(
                    |zone| zone.template.name == "creep" && zone.contains(soldier.x, soldier.y)
                ),
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
        assert!(
            world.units.iter().all(|unit| unit.id != victim),
            "{kind} died"
        );
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
        let brood = world
            .units
            .iter()
            .find(|unit| unit.kind == "brood")
            .unwrap();
        assert!(brood.id > victim);
        assert_eq!((brood.x, brood.y), IN_FIELD, "spawned where it fell");
        assert_eq!(brood.expires_tick, 1 + 200);
        assert_eq!(brood.hp, 30);
        assert_eq!(brood.order.kind, "attack_move");
        assert_eq!((brood.order.x, brood.order.y), IN_FIELD);
        // The refund is paid as well: half of 100 catalyst, plus the tick's
        // stipend in material.
        assert_eq!(world.balance(0).catalyst, before.catalyst + 50);
        assert_eq!(
            world.balance(0).material,
            before.material + crate::stipend_payment(1)
        );
        assert_eq!(world.lost(0), Cost::catalyst(100));
        assert_eq!(world.killed(1), Cost::catalyst(100));
    }

    #[test]
    fn siege_dying_on_creep_spawns_a_brute_and_a_scout_a_brood() {
        let (world, _) = death_on(Some(0), 0, "siege");
        assert_eq!(temporaries(&world), vec![(0, "brute".to_string())]);
        let brute = world
            .units
            .iter()
            .find(|unit| unit.kind == "brute")
            .unwrap();
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
        assert!(
            world.units.iter().all(|unit| unit.id != outpost),
            "source died"
        );
        assert!(world
            .units
            .iter()
            .all(|unit| unit.kind != "soldier" || unit.owner == 1));
        assert_eq!(temporaries(&world), vec![(0, "brood".to_string())]);
    }

    #[test]
    fn an_expired_spawn_is_removed_without_touching_lost_killed_or_balances() {
        let (mut world, _) = death_on(Some(0), 0, "soldier");
        // Clear the killer so nothing else can happen to the brood.
        world
            .units
            .retain(|unit| unit.owner != 1 || unit.kind == "hq");
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
            world.spawn_temporary(
                0,
                if index % 2 == 0 { "brood" } else { "brute" },
                700.0,
                700.0,
            );
        }
        assert_eq!(world.army_value(0), army, "spawns are not army value");
        // 59 soldiers and 30 spawns: one more fighter still fits.
        let train = command(1, 0, barracks, "train_swarmer", 0);
        assert_eq!(world.validate(&train), Ok(()));
        world.spawn(0, "soldier", 700.0, 100.0);
        assert!(world.validate(&train).unwrap_err().contains("Unit limit"));
        // And spawns are controllable fighters.
        let brood = world
            .units
            .iter()
            .find(|unit| unit.kind == "brood")
            .unwrap()
            .id;
        for kind in ["attack_move", "hold", "move", "stop"] {
            let mut order = command(2, 0, brood, kind, 0);
            order.order.x = 700.0;
            order.order.y = 750.0;
            assert_eq!(world.validate(&order), Ok(()), "{kind}");
        }
    }

    #[test]
    fn a_unit_on_a_move_order_fires_at_enemies_in_range_without_stopping() {
        // Current behaviour, recorded on purpose (2026-09-25): every unit shoots
        // while it moves, like SC2's phoenix. Whether some kinds should stop to
        // fire instead is an open design question; see ROADMAP M2.
        let mut world = World::new(&[0, 1]);
        world.spawn(0, "soldier", 600.0, 300.0);
        let soldier = world.units.last().unwrap().id;
        world.spawn(1, "worker", 700.0, 360.0);
        let target = world.units.last().unwrap().id;
        let before = unit_of(&world, target).hp;
        let mut order = command(world.tick, 0, soldier, "move", 0);
        order.order.x = 900.0;
        order.order.y = 300.0;
        world.execute(&order).unwrap();
        let mut positions = Vec::new();
        for _ in 0..30 {
            world.step();
            positions.push(unit_of(&world, soldier).x);
        }
        assert!(
            unit_of(&world, target).hp < before,
            "it fired while passing"
        );
        assert!(
            positions.windows(2).all(|pair| pair[1] > pair[0]),
            "it never stopped to fire: {positions:?}"
        );
    }

    #[test]
    fn a_fight_on_creep_with_spawns_and_expiry_replays_identically() {
        let mut first = creep_arena(Some(0));
        for index in 0..4 {
            first.spawn(0, "soldier", IN_FIELD.0, IN_FIELD.1 + index as f32 * 25.0);
            first.spawn(
                1,
                "soldier",
                IN_FIELD.0 + 90.0,
                IN_FIELD.1 + index as f32 * 25.0,
            );
        }
        let mut second = first.clone();
        let mut spawned = false;
        for _ in 0..400 {
            first.step();
            second.step();
            spawned |= !temporaries(&first).is_empty();
        }
        assert!(spawned, "the fight spawned something on creep");
        assert_eq!(
            temporaries(&first),
            vec![],
            "and every spawn expired or died"
        );
        assert_eq!(first, second);
    }

    #[test]
    fn only_the_industrial_faction_may_build_a_sensor() {
        for (faction, allowed) in [
            (Faction::Industrial, true),
            (Faction::Network, false),
            (Faction::Organic, false),
        ] {
            let mut world = World::new_on_with_factions(
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
        world
            .balances
            .insert(0, Balance::new(3000, 1000).with_terrazine(200));
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
        assert_eq!(world.research[&0].len(), 3);
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
        // Spent 700 material on four buildings, 450 on three technologies, 900
        // catalyst on three siege and three soldiers and 100 terrazine on the
        // turret, from 3000, 1000 and 200. Material also gains the base income
        // accumulated up to the tick the match ended; the catalyst total shows
        // the whole army survived, so no death refund was paid.
        assert_eq!(
            world.balances[&0],
            Balance::new((3000 - 1150 + crate::stipend_total(world.tick)) as u32, 100)
                .with_terrazine(100)
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
    fn construction_raises_itself_from_the_command_card_and_unlocks_units() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        world.balances.insert(0, Balance::new(1000, 100));
        // Issued with the HQ (unit 1) as the command's one unit: nothing walks
        // to the site and nothing is assigned to it.
        let mut build = command(1, 0, 1, "build_barracks", 0);
        build.order.x = 440.0;
        build.order.y = 220.0;
        world.commands.push(build.clone());
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.units.len(), 8);
        world.step();
        // 1000 - 150 for the barracks, + 3 stipend material paid by tick 20.
        assert_eq!(world.balances[&0], Balance::new(853, 100));
        assert!(world.validate(&build).is_err());
        let site = world.next_id - 1;
        assert!(world
            .validate(&command(2, 0, site, "train_scout", 0))
            .is_err());
        // No labour moved: every labour unit is still idle.
        assert!(world
            .units
            .iter()
            .filter(|unit| is_labour(&unit.kind))
            .all(|unit| unit.order.kind == "stop"));
        // It builds on its own at one tick of work per tick, and there is no
        // way to cancel it.
        assert!(world
            .validate(&command(3, 0, site, "cancel_construction", 0))
            .is_err());
        let ticks = stats("barracks").unwrap().training_ticks;
        for _ in 0..ticks {
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
            .execute(&command(world.tick, 0, site, "train_scout", 0))
            .unwrap();
        for _ in 0..70 {
            world.step();
        }
        assert!(world.units.iter().any(|unit| unit.kind == "scout"));
    }

    #[test]
    fn construction_cannot_be_cancelled_and_research_is_unique_and_persistent() {
        let mut world = World::new(&[0, 1]);
        // A laboratory needs a finished barracks before anything else
        // about it can be tested.
        barracks_for(&mut world, 0);
        world.balances.insert(0, Balance::new(1000, 0));
        world.execute(&command(1, 0, 2, "build_lab", 0)).unwrap();
        let site = world.next_id - 1;
        // Placement is final: there is no cancellation and no refund.
        assert!(world
            .execute(&command(2, 0, site, "cancel_construction", 0))
            .is_err());
        assert_eq!(world.balances[&0], Balance::new(800, 0));
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
        assert!(world.has_research(0, "research_weapons"));
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
        // The delivered 25 material, and the 12% terrazine by-product of it.
        assert_eq!(
            world.balances[&0],
            Balance::new(275, STARTING_BALANCE.catalyst).with_terrazine(3)
        );
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
        world
            .commands
            .push(command(2, 0, barracks, "train_soldier", 0));
        // The rally belongs to whatever produces, and soldiers come from the
        // barracks now, so that is where the rally under test lives.
        world
            .commands
            .push(command(3, 0, barracks, "rally_move", 0));
        for _ in 0..80 {
            world.step();
        }
        // 250 - 50 worker + 13 stipend material by tick 80; the soldier is
        // paid for in catalyst, all 100 of it.
        assert_eq!(world.balances[&0], Balance::new(213, 0));
        let mut cancel = command(4, 0, barracks, "cancel_production", 0);
        cancel.execute_tick = 100;
        world.commands.push(cancel.clone());
        cancel.id = 5;
        world.commands.push(cancel);
        for _ in 80..99 {
            world.step();
        }
        assert_eq!(world.balances[&0], Balance::new(216, 0));
        world.step();
        // Only the unfinished soldier is refunded, and only by the first of the
        // two identical cancel commands.
        assert_eq!(world.balances[&0], Balance::new(216, 100));
        let producer = world.units.iter().find(|unit| unit.id == barracks).unwrap();
        assert!(producer.production.is_empty());
        assert_eq!(
            producer.order.kind, "rally_move",
            "cancelling keeps the rally"
        );
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
        assert_eq!(world.balances[&0], Balance::new(253, 100));
        world.step();
        assert_eq!(world.units[0].hp, 1200);
        // Two workers each pay one material; repair never touches catalyst.
        assert_eq!(world.balances[&0], Balance::new(251, 100));
        for _ in 0..20 {
            world.step();
        }
        assert_eq!(world.balances[&0], Balance::new(254, 100));
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
        // Base income never ends, so the window is chosen by tick: ticks 3601
        // to 3610 hold a repair pulse (3610) and no base-income payment (the
        // next is 3612), which is what lets an empty balance really stay empty.
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.balances.insert(0, Balance::default());
        world.commands.push(command(1, 0, 2, "repair", 4));
        for _ in 0..10 {
            world.step();
        }
        assert_eq!(world.units[3].hp, 100);
        assert_eq!(world.units[1].order.kind, "repair");
        assert_eq!(world.balances[&0], Balance::default());
        world.balances.insert(0, Balance::new(1, 0));
        for _ in 0..10 {
            world.step();
        }
        // 3612 paid one material, and the 3620 pulse spent one.
        assert_eq!(world.units[3].hp, 105);
        assert_eq!(world.balances[&0], Balance::new(1, 0));
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
        world.balances.insert(0, Balance::new(250, 250));
        for id in 1..=3 {
            world
                .commands
                .push(command(id, 0, barracks, "train_soldier", 0));
        }
        for _ in 0..19 {
            world.step();
        }
        assert_eq!(world.balances[&0], Balance::new(253, 250));
        world.step();
        // Two soldiers at 100 catalyst each; the third is refused.
        assert_eq!(world.balances[&0], Balance::new(253, 50));
        assert_eq!(world.commands[2].status, "rejected");
        assert!(world.commands[2].reason.contains("Insufficient catalyst"));
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
        assert_eq!(world.balances[&0], Balance::new(260, 100));
        assert_eq!(world.units[1].cargo, 25);
        assert_eq!(world.units[1].cargo_kind, ResourceKind::Material);
        for _ in 0..50 {
            world.step();
        }
        // 25 delivered, and 3 terrazine (12% of 25, rounded down).
        assert_eq!(world.balances[&0], Balance::new(293, 100).with_terrazine(3));
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
    fn a_completed_outpost_keeps_a_player_alive_after_the_hq_falls() {
        let mut world = World::new(&[0, 1]);
        world.spawn(0, "outpost", 700.0, 400.0);
        world.research.insert(0, vec!["research_armor".into()]);
        world.units[0].hp = 0;
        world.step();
        assert_eq!(world.outcome, None);
        assert!(world
            .units
            .iter()
            .any(|unit| unit.owner == 0 && unit.kind == "outpost"));
        assert!(world
            .units
            .iter()
            .any(|unit| unit.owner == 0 && !is_building(&unit.kind)));
        assert!(
            world.has_research(0, "research_armor"),
            "research outlives the HQ"
        );
        let outpost = world
            .units
            .iter()
            .find(|unit| unit.kind == "outpost")
            .unwrap()
            .id;
        world.units.retain(|unit| unit.id != outpost);
        world.step();
        assert_eq!(world.outcome, Some(1));
    }

    #[test]
    fn an_unfinished_outpost_does_not_keep_a_player_alive() {
        let mut world = World::new(&[0, 1]);
        world.spawn(0, "outpost", 700.0, 400.0);
        world.units.last_mut().unwrap().construction_remaining = 100;
        world.units[0].hp = 0;
        world.step();
        assert_eq!(world.outcome, Some(1));
        assert!(!world.units.iter().any(|unit| unit.owner == 0));
    }

    #[test]
    fn losing_the_last_outposts_on_the_same_tick_is_a_draw() {
        let mut world = World::new(&[0, 1]);
        world.spawn(0, "outpost", 700.0, 400.0);
        world.spawn(1, "outpost", 900.0, 400.0);
        world.units.retain(|unit| unit.kind != "hq");
        world.step();
        assert_eq!(world.outcome, None);
        for unit in world.units.iter_mut().filter(|unit| unit.kind == "outpost") {
            unit.hp = 0;
        }
        world.step();
        assert_eq!(world.outcome, Some(-1));
    }

    #[test]
    fn an_outpost_trains_labour_and_takes_a_rally_like_the_hq() {
        let mut world = World::new(&[0, 1]);
        world.spawn(0, "outpost", 700.0, 400.0);
        let outpost = world.units.last().unwrap().id;
        let train = command(1, 0, outpost, "train_worker", 0);
        assert_eq!(world.validate(&train), Ok(()));
        let rally = command(2, 0, outpost, "rally_move", 0);
        assert_eq!(world.validate(&rally), Ok(()));
    }

    #[test]
    fn a_player_without_a_hub_is_refused_every_order() {
        let mut world = World::new(&[0, 1, 2]);
        world
            .units
            .retain(|unit| !(unit.owner == 0 && unit.kind == "hq"));
        let order = command(1, 0, 2, "move", 0);
        assert_eq!(world.validate(&order), Err("You have no hubs left".into()));
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
        // leaks, and the only new money is the base income. 24000 material in
        // six deposits plus 4 x 250 starting material plus 4 stipends; 2400
        // catalyst in the two central sites plus 4 x 100 starting catalyst,
        // none of it spent here.
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
        assert!(
            crate::stipend_total(first.tick) > 450,
            "base income went on"
        );
        assert_eq!(
            held(ResourceKind::Material),
            24000 + 4 * 250 + 4 * crate::stipend_total(first.tick)
        );
        assert_eq!(held(ResourceKind::Catalyst), 2400 + 4 * 100);
        // Terrazine is minted only as the by-product of what was mined.
        let owed: u64 = (0u8..4)
            .map(|slot| {
                crate::terrazine_owed(first.collected(slot).material, first.faction(slot)) as u64
            })
            .sum();
        assert!(owed > 0);
        assert_eq!(held(ResourceKind::Terrazine), owed);
    }

    // --- engine scaling ----------------------------------------------------

    /// The separation pass as it was written before it was bucketed: every
    /// later mobile visited for every mobile. The reference the bucketed pass
    /// must reproduce bit for bit.
    fn separate_linearly(units: &mut [Entity], world_size: f32) {
        for left_index in 0..units.len() {
            let (left_slice, right_slice) = units.split_at_mut(left_index + 1);
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

    /// Crowds dense enough that units are shoved many times, and shoved far
    /// enough to make the bucketed pass re-ask for neighbours, packed against
    /// the map edge, stacked exactly on one point, mixed with holds and
    /// buildings: the bucketed pass ends every unit on exactly the position
    /// the full pass does.
    #[test]
    fn bucketed_separation_matches_the_full_pass_bit_for_bit() {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 40) as f32 / (1u64 << 24) as f32
        };
        for (crowd, spread, centre) in [
            (600, 120.0, (800.0, 800.0)),
            (400, 40.0, (20.0, 20.0)),
            (300, 0.0, (500.0, 500.0)),
            (900, 400.0, (1200.0, 300.0)),
        ] {
            let mut world = World::new(&[0, 1]);
            for index in 0..crowd {
                let kind = ["soldier", "scout", "siege", "worker", "turret"][index % 5];
                world.spawn(
                    (index % 2) as u8,
                    kind,
                    centre.0 + (next() - 0.5) * spread,
                    centre.1 + (next() - 0.5) * spread,
                );
                if index % 7 == 0 {
                    world.units.last_mut().unwrap().order.kind = "hold".into();
                }
            }
            let mut expected = world.units.clone();
            separate_linearly(&mut expected, 1600.0);
            world.separate_units(1600.0);
            for (got, want) in world.units.iter().zip(&expected) {
                assert_eq!(
                    (got.id, got.x.to_bits(), got.y.to_bits()),
                    (want.id, want.x.to_bits(), want.y.to_bits()),
                    "unit {} ended at ({}, {}) instead of ({}, {})",
                    got.id,
                    got.x,
                    got.y,
                    want.x,
                    want.y
                );
            }
        }
    }

    /// A 400-unit command is validated and executed without scanning the world
    /// per selected unit, and still refuses exactly what it refused before: a
    /// foreign or missing id anywhere in the selection.
    #[test]
    fn a_full_selection_of_four_hundred_is_one_command() {
        let mut world = World::new(&[0, 1]);
        for index in 0..MAX_UNITS - 1 {
            world.spawn(0, "soldier", 300.0 + (index % 20) as f32 * 10.0, 300.0 + (index / 20) as f32 * 10.0);
        }
        let selection: Vec<u32> = world
            .units
            .iter()
            .filter(|unit| unit.owner == 0 && fights(&unit.kind) && !is_building(&unit.kind))
            .map(|unit| unit.id)
            .collect();
        assert_eq!(selection.len(), MAX_UNITS);
        let order = Order {
            kind: "attack_move".into(),
            x: 800.0,
            y: 800.0,
            target: 0,
        };
        let mut command = Command {
            id: 1,
            owner: 0,
            units: selection.clone(),
            order: order.clone(),
            queued: false,
            execute_tick: 0,
            status: "scheduled".into(),
            reason: String::new(),
        };
        // The database hands rows back in no promised order.
        world.units.reverse();
        assert_eq!(world.validate(&command), Ok(()));
        world.execute(&command).unwrap();
        assert!(world
            .units
            .iter()
            .filter(|unit| selection.contains(&unit.id))
            .all(|unit| unit.order == Order { target: 0, ..order.clone() }));
        let enemy = world.units.iter().find(|unit| unit.owner == 1).unwrap().id;
        command.units[200] = enemy;
        assert_eq!(
            world.validate(&command),
            Err("Unit is missing or belongs to another player".into())
        );
        command.units.push(selection[0]);
        assert_eq!(
            world.validate(&command),
            Err(format!("Select between 1 and {MAX_UNITS} units"))
        );
    }

    // --- dual-currency economy ---------------------------------------------

    #[test]
    fn each_currency_buys_exactly_one_thing_and_no_other_substitutes() {
        let mut world = World::new(&[0, 1]);
        world.spawn(0, "factory", 440.0, 220.0);
        let factory = world.next_id - 1;

        // An army unit costs catalyst only: all the material and terrazine in
        // the world do not buy a siege.
        world
            .balances
            .insert(0, Balance::new(10_000, 0).with_terrazine(10_000));
        let refusal = world
            .validate(&command(1, 0, factory, "train_siege", 0))
            .unwrap_err();
        assert!(refusal.contains("Insufficient catalyst"), "{refusal}");
        world.balances.insert(0, Balance::new(10_000, 199));
        assert!(world
            .validate(&command(2, 0, factory, "train_siege", 0))
            .is_err());
        world.balances.insert(0, Balance::new(0, 200));
        world
            .execute(&command(3, 0, factory, "train_siege", 0))
            .unwrap();
        assert_eq!(world.balances[&0], Balance::default());

        // A turret costs terrazine only.
        let mut turret = command(4, 0, 2, "build_turret", 0);
        turret.order.x = 220.0;
        turret.order.y = 600.0;
        world
            .balances
            .insert(0, Balance::new(10_000, 10_000).with_terrazine(99));
        let refusal = world.validate(&turret).unwrap_err();
        assert!(refusal.contains("Insufficient terrazine"), "{refusal}");
        assert_eq!(
            world.balances[&0],
            Balance::new(10_000, 10_000).with_terrazine(99),
            "a refusal debits nothing"
        );
        world
            .balances
            .insert(0, Balance::new(10_000, 10_000).with_terrazine(100));
        world.execute(&turret).unwrap();
        assert_eq!(world.balances[&0], Balance::new(10_000, 10_000));

        // Structures and research cost material only.
        let mut barracks = command(5, 0, 2, "build_barracks", 0);
        barracks.order.x = 440.0;
        barracks.order.y = 440.0;
        world
            .balances
            .insert(0, Balance::new(149, 10_000).with_terrazine(10_000));
        let refusal = world.validate(&barracks).unwrap_err();
        assert!(refusal.contains("Insufficient material"), "{refusal}");
        world.balances.insert(0, Balance::new(150, 0));
        world.execute(&barracks).unwrap();
        assert_eq!(world.balances[&0], Balance::default());
    }

    #[test]
    fn a_material_shortfall_blocks_buildings_and_research() {
        let mut world = World::new(&[0, 1]);
        // A laboratory needs a finished barracks before anything else
        // about it can be tested.
        barracks_for(&mut world, 0);
        world
            .balances
            .insert(0, Balance::new(199, 10_000).with_terrazine(10_000));
        let mut build = command(1, 0, 2, "build_lab", 0);
        build.order.x = 440.0;
        build.order.y = 220.0;
        assert!(world.validate(&build).unwrap_err().contains("material"));
        world.balances.insert(0, Balance::new(200, 0));
        world.execute(&build).unwrap();
        assert_eq!(world.balances[&0], Balance::default());

        world.spawn(0, "lab", 600.0, 220.0);
        let lab = world.next_id - 1;
        world.balances.insert(0, Balance::new(149, 10_000));
        assert!(world
            .validate(&command(2, 0, lab, "research_weapons", 0))
            .unwrap_err()
            .contains("material"));
    }

    /// The labour order and every automatic route to catalyst are closed: it is
    /// extracted by refineries and never mined by hand.
    #[test]
    fn labour_cannot_gather_catalyst_by_order_rally_or_auto_target() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        let catalyst = world
            .nodes
            .iter()
            .find(|node| node.kind == ResourceKind::Catalyst)
            .unwrap()
            .clone();
        let refusal = world
            .validate(&command(1, 0, 2, "gather", catalyst.id))
            .unwrap_err();
        assert!(refusal.contains("refinery"), "{refusal}");
        let refusal = world
            .validate(&command(2, 0, 1, "rally_gather", catalyst.id))
            .unwrap_err();
        assert!(refusal.contains("refinery"), "{refusal}");
        // Material is still fine.
        world.validate(&command(3, 0, 2, "gather", 1)).unwrap();
        world
            .validate(&command(4, 0, 1, "rally_gather", 1))
            .unwrap();

        // Even a unit that is somehow handed a catalyst target goes to
        // material instead, and no worker ever carries catalyst.
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.balances.insert(0, Balance::default());
        let worker = world.units.iter_mut().find(|unit| unit.id == 2).unwrap();
        worker.x = catalyst.x;
        worker.y = catalyst.y + 40.0;
        worker.order = Order {
            kind: "gather".into(),
            x: 0.0,
            y: 0.0,
            target: catalyst.id,
        };
        for _ in 0..400 {
            world.step();
            assert_ne!(unit_of(&world, 2).cargo_kind, ResourceKind::Catalyst);
        }
        assert_eq!(node_of(&world, catalyst.id).amount, catalyst.amount);
        assert_eq!(world.collected(0).catalyst, 0);
        assert_ne!(unit_of(&world, 2).order.target, catalyst.id);
    }

    #[test]
    fn army_deaths_refund_half_of_the_catalyst_price_exactly_once() {
        let mut world = World::new(&[0, 1]);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.balances.insert(0, Balance::new(1000, 100));
        world.spawn(0, "siege", 400.0, 400.0);
        let siege = world.next_id - 1;
        world.units.iter_mut().find(|u| u.id == siege).unwrap().hp = 0;
        world.step();
        assert!(!world.units.iter().any(|unit| unit.id == siege));
        // Siege costs 200 catalyst; half of it comes back.
        assert_eq!(world.balances[&0], Balance::new(1000, 200));
        for _ in 0..20 {
            world.step();
        }
        assert_eq!(
            world.balances[&0],
            Balance::new(1000 + stipend_between(3600, world.tick), 200),
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
        // scout (40) and one siege (100) all pay, in catalyst.
        assert_eq!(world.balances[&0], Balance::new(0, 240));
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
        world.balances.insert(0, Balance::new(1000, 1000));
        world
            .execute(&command(1, 0, barracks, "train_soldier", 0))
            .unwrap();
        assert_eq!(world.balances[&0], Balance::new(1000, 900));
        world
            .execute(&command(2, 0, barracks, "cancel_production", 0))
            .unwrap();
        // Cancellation returns the whole price, and the soldier never exists.
        assert_eq!(world.balances[&0], Balance::new(1000, 1000));
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
        let income = stipend_between(3600, world.tick);
        assert_eq!(world.balances[&0], Balance::new(1000 + income, 1000));

        // The soldier that was really built pays its one death refund.
        world
            .units
            .iter_mut()
            .find(|unit| unit.owner == 0 && unit.kind == "soldier")
            .unwrap()
            .hp = 0;
        let before = world.tick;
        world.step();
        assert_eq!(
            world.balances[&0],
            Balance::new(1000 + income + stipend_between(before, world.tick), 1050)
        );
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
        assert_eq!(plain.units.iter().filter(|u| u.kind == "worker").count(), 4);
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
            if first_credit.is_none() && world.collected(0).material > 0 {
                first_credit = Some(world.tick);
            }
        }
        let credited = world.collected(0).material;
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
        assert!(world.collected(0).material > 0);
        assert_eq!(unit_of(&world, 2).cargo, 0);
        // Industrial: holding a load, paid nothing yet.
        assert!(unit_of(&world, 6).cargo > 0);
        assert_eq!(
            world.balances[&1],
            base_income_only(&world),
            "a worker is paid on delivery, not at the face"
        );
        for _ in 0..140 {
            world.step();
        }
        // And the round trip does pay, once it is walked.
        assert!(world.collected(1).material >= 25);
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
        assert_eq!(world.balances[&0], base_income_only(&world));
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
            base_income_only(&world),
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
        assert_eq!(world.balances[&0], base_income_only(&world));
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
        assert_eq!(world.balances[&0], base_income_only(&world));
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
            let refusal = world.validate(&command(1, 0, 2, kind, target)).unwrap_err();
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
            // Each faction trains its own fighter and is refused another's.
            let fighter = crate::basic_fighter(faction);
            assert!(world
                .validate(&command(3, 0, barracks, &format!("train_{fighter}"), 0))
                .is_ok());
            for other in ["soldier", "sentinel", "swarmer"] {
                if other != fighter {
                    let refusal = world
                        .validate(&command(3, 0, barracks, &format!("train_{other}"), 0))
                        .unwrap_err();
                    assert!(refusal.contains(faction.as_str()), "{refusal}");
                }
            }
        }
    }

    /// Per-currency conservation with all three models running at once,
    /// including the one that never carries a load, and with refineries
    /// extracting catalyst: material and catalyst are each conserved exactly
    /// (plus the base income, the only minted material), neither converts into
    /// the other, and terrazine exists only as the by-product of what was mined.
    #[test]
    fn every_currency_is_conserved_under_all_three_gather_models() {
        let mut world = factional(&[
            (0, Faction::Industrial),
            (1, Faction::Network),
            (2, Faction::Organic),
        ]);
        let material_before = held(&world, ResourceKind::Material);
        let catalyst_before = held(&world, ResourceKind::Catalyst);
        // Each player works its own mineral line with both labour units (the
        // second one is turned away to a free patch or waits), and two of them
        // have a finished refinery on a catalyst site.
        for (id, (slot, node)) in [(2u32, (0u8, 1u32)), (6, (1, 2)), (10, (2, 3))] {
            world
                .commands
                .push(command(id as u64, slot, id, "gather", node));
        }
        for (slot, id, node) in [(0u8, 3u32, 1u32), (1, 7, 2), (2, 11, 3)] {
            world
                .commands
                .push(command(id as u64 + 100, slot, id, "gather", node));
        }
        for (slot, node) in [(0u8, 7u32), (1, 8)] {
            let site = node_of(&world, node).clone();
            world.spawn(slot, "refinery", site.x, site.y);
        }
        let start = world.tick;
        for _ in 0..2000 {
            world.step();
        }
        // Everyone was actually paid, so this is not conservation by idleness.
        for slot in 0u8..3 {
            assert!(
                world.collected(slot).material > 0,
                "slot {slot} mined no material"
            );
        }
        assert!(world.collected(0).catalyst > 0 && world.collected(1).catalyst > 0);
        assert_eq!(world.collected(2).catalyst, 0, "no refinery, no catalyst");
        assert_eq!(
            held(&world, ResourceKind::Material),
            material_before + 3 * stipend_between(start, world.tick) as u64
        );
        assert_eq!(held(&world, ResourceKind::Catalyst), catalyst_before);
        // Terrazine is exactly the by-product of the material mined.
        for slot in 0u8..3 {
            let owed = crate::terrazine_owed(world.collected(slot).material, world.faction(slot));
            assert_eq!(world.balances[&slot].terrazine, owed, "slot {slot}");
            assert_eq!(world.collected(slot).terrazine, owed, "slot {slot}");
        }
        // The drifter still holds nothing: its whole yield is already banked.
        for unit in world.units.iter().filter(|u| u.kind == "drifter") {
            assert_eq!(unit.cargo, 0);
            assert!(!unit.returning);
        }
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
        // Each player works its own mineral line with one labour unit, and two
        // of them also run a refinery on a central catalyst site.
        for (id, (slot, node)) in [(2u32, (0u8, 1u32)), (6, (1, 2)), (10, (2, 3))] {
            world
                .commands
                .push(command(id as u64, slot, id, "gather", node));
        }
        for (slot, node) in [(0u8, 7u32), (1, 8)] {
            let site = node_of(&world, node).clone();
            world.spawn(slot, "refinery", site.x, site.y);
        }
        let start = world.tick;
        for _ in 0..2000 {
            world.step();
        }
        for (kind, before) in [
            (ResourceKind::Material, material_before),
            (ResourceKind::Catalyst, catalyst_before),
        ] {
            let drained = before - in_ground(&world, kind);
            assert!(
                drained > 0,
                "{kind}: nothing was mined, so nothing is proved"
            );
            assert_eq!(
                collected_total(&world, kind),
                drained - aboard(&world, kind),
                "{kind}: collected is the deposit drain less what is still in transit"
            );
        }
        // `factional` opens with empty balances and nothing is ever spent here,
        // so every slot's balance is its mined income exactly, plus the base
        // income in material. Anything else minted - a refund - would break
        // this. Catalyst and terrazine are mined income to the unit.
        for slot in 0u8..3 {
            assert!(
                world.collected(slot).material > 0,
                "slot {slot} mined no material"
            );
            let mined = world.collected(slot);
            assert_eq!(
                world.balances[&slot],
                Balance::new(
                    mined.material + stipend_between(start, world.tick),
                    mined.catalyst
                )
                .with_terrazine(mined.terrazine),
                "slot {slot} was paid something it did not mine"
            );
        }
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
            assert_eq!(
                world.balances[&slot],
                Balance::new(250 + 450, STARTING_BALANCE.catalyst)
            );
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
            Balance::new(700, STARTING_BALANCE.catalyst + 100),
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
        // A bootstrap worker (50 material), the bootstrap soldier (100
        // catalyst), a barracks (150 material) and a siege (200 catalyst).
        for id in [2, 4, barracks, siege] {
            world.units.iter_mut().find(|u| u.id == id).unwrap().hp = 0;
        }
        world.step();
        assert_eq!(world.lost(0), Cost::new(50 + 150, 100 + 200));
        assert_eq!(world.lost(1), Cost::ZERO, "nothing of slot 1's died");
        // Nobody shot any of them, so nobody is credited with killing them.
        assert_eq!(world.killed(0), Cost::ZERO);
        assert_eq!(world.killed(1), Cost::ZERO);
        // And the refund rule is untouched: half of the army only.
        assert_eq!(world.balances[&0], Balance::new(1000, 100 + 50 + 100));
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
        assert_eq!(world.killed(0), Cost::catalyst(80), "a scout lists at 80");
        assert_eq!(world.lost(1), Cost::catalyst(80));
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
        assert_eq!(world.army_value(0), Cost::catalyst(100));
        world.spawn(0, "worker", 400.0, 400.0);
        world.spawn(0, "barracks", 440.0, 220.0);
        assert_eq!(
            world.army_value(0),
            Cost::catalyst(100),
            "labour and buildings are not army"
        );
        world.spawn(0, "siege", 420.0, 400.0);
        let siege = world.next_id - 1;
        assert_eq!(
            world.army_value(0),
            Cost::catalyst(300),
            "it rises on a build"
        );
        world.units.iter_mut().find(|u| u.id == siege).unwrap().hp = 0;
        world.step();
        assert_eq!(
            world.army_value(0),
            Cost::catalyst(100),
            "and falls again on a death"
        );
        assert_eq!(world.army_value(1), Cost::catalyst(100));
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
        assert_eq!(
            points,
            vec![100, 200],
            "one row per point, never one per wake"
        );
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
    fn the_stipend_pays_every_player_on_schedule_and_never_stops() {
        let mut world = World::new(&[0, 1, 2, 3]);
        idle_labour(&mut world);
        for _ in 0..crate::STIPEND_FIRST_PHASE_END_TICK {
            world.step();
        }
        for slot in 0u8..4 {
            assert_eq!(
                world.balances[&slot],
                Balance::new(250 + 300, STARTING_BALANCE.catalyst)
            );
        }
        for _ in crate::STIPEND_FIRST_PHASE_END_TICK..crate::STIPEND_SECOND_PHASE_END_TICK {
            world.step();
        }
        for slot in 0u8..4 {
            assert_eq!(
                world.balances[&slot],
                Balance::new(250 + 450, STARTING_BALANCE.catalyst)
            );
        }
        // Five more minutes at the second-phase rate: base income is permanent.
        for _ in 0..crate::TICKS_PER_MINUTE * 5 {
            world.step();
        }
        for slot in 0u8..4 {
            assert_eq!(
                world.balances[&slot],
                Balance::new(250 + 450 + 500, STARTING_BALANCE.catalyst),
                "the stipend never stops: 100 a minute, forever"
            );
        }
    }

    // --- shields and the Network power field ---------------------------------

    /// Network's base: an HQ, which projects a power field of 320, at
    /// `NETWORK_HQ`. Industrial is parked in the far corner so a one-player
    /// world does not resolve to victory, and projects nothing.
    const NETWORK_HQ: (f32, f32) = (200.0, 1300.0);
    /// Inside the Network HQ's field, clear of the HQ's footprint.
    const POWERED: (f32, f32) = (300.0, 1250.0);
    /// Outside every field, 800 from the Network HQ, on open ground.
    const UNPOWERED: (f32, f32) = (1000.0, 1300.0);
    /// A relay far from the HQ, and a point inside its field.
    const RELAY: (f32, f32) = (600.0, 300.0);
    const BY_RELAY: (f32, f32) = (600.0, 390.0);

    fn power_arena() -> World {
        let mut world = World::new_on_with_factions(
            crate::maps::default_map(),
            &[(0, Faction::Network), (1, Faction::Industrial)],
        );
        world.units.clear();
        world.spawn(0, "hq", NETWORK_HQ.0, NETWORK_HQ.1);
        world.spawn(1, "hq", 1400.0, 200.0);
        world
    }

    fn spawned(world: &mut World, owner: u8, kind: &str, at: (f32, f32)) -> u32 {
        world.spawn(owner, kind, at.0, at.1);
        world.units.last().unwrap().id
    }

    fn order_at(unit: u32, kind: &str, at: (f32, f32)) -> Command {
        Command {
            order: Order {
                kind: kind.into(),
                x: at.0,
                y: at.1,
                target: 0,
            },
            ..command(1, 0, unit, kind, 0)
        }
    }

    #[test]
    fn network_splits_health_into_shields_and_nobody_else_has_any() {
        assert_eq!(vitals("soldier", Faction::Network), (70, 70));
        assert_eq!(vitals("hq", Faction::Network), (600, 600));
        assert_eq!(vitals("drifter", Faction::Network), (20, 20));
        assert_eq!(vitals("relay", Faction::Network), (150, 150));
        for faction in [Faction::Industrial, Faction::Organic] {
            assert_eq!(vitals("soldier", faction), (140, 0), "{faction}");
            assert_eq!(vitals("hq", faction), (1200, 0), "{faction}");
        }
        // Temporary units never carry shields, whoever is asked about.
        assert_eq!(vitals("brood", Faction::Network), (30, 0));
        let world = power_arena();
        let network = world.units.iter().find(|unit| unit.owner == 0).unwrap();
        assert_eq!((network.hp, network.max_hp), (600, 600));
        assert_eq!((network.shields, network.max_shields), (600, 600));
        let industrial = world.units.iter().find(|unit| unit.owner == 1).unwrap();
        assert_eq!(
            (industrial.hp, industrial.shields, industrial.max_shields),
            (1200, 0, 0)
        );
    }

    #[test]
    fn shields_take_damage_before_hit_points() {
        let mut world = power_arena();
        let target = spawned(&mut world, 0, "soldier", UNPOWERED);
        spawned(&mut world, 1, "soldier", (UNPOWERED.0 + 60.0, UNPOWERED.1));
        world.step();
        let hit = unit_of(&world, target);
        assert_eq!((hit.shields, hit.hp), (52, 70), "18 off the shields only");
        assert_eq!(hit.damaged_tick, world.tick);

        // A hit bigger than the shields left spills the rest onto hit points.
        let mut world = power_arena();
        let target = spawned(&mut world, 0, "soldier", UNPOWERED);
        world.units.last_mut().unwrap().shields = 5;
        spawned(&mut world, 1, "soldier", (UNPOWERED.0 + 60.0, UNPOWERED.1));
        world.step();
        let hit = unit_of(&world, target);
        assert_eq!((hit.shields, hit.hp), (0, 57));
    }

    #[test]
    fn shields_wait_ten_seconds_then_regenerate_three_times_faster_in_a_field() {
        let mut world = power_arena();
        world.tick = 1000;
        let inside = spawned(&mut world, 0, "soldier", POWERED);
        let outside = spawned(&mut world, 0, "soldier", UNPOWERED);
        for unit in world.units.iter_mut().filter(|unit| unit.kind == "soldier") {
            unit.shields = 10;
            unit.damaged_tick = 1000;
        }
        for _ in 0..199 {
            world.step();
        }
        assert_eq!(world.tick, 1199);
        assert_eq!(
            unit_of(&world, inside).shields,
            10,
            "still inside the delay"
        );
        assert_eq!(
            unit_of(&world, outside).shields,
            10,
            "still inside the delay"
        );
        for _ in 0..101 {
            world.step();
        }
        // Regeneration pulses on 1200, 1210, ... 1300: eleven of them.
        assert_eq!(unit_of(&world, outside).shields, 10 + 11, "2 per second");
        assert_eq!(unit_of(&world, inside).shields, 10 + 33, "6 per second");
        for _ in 0..200 {
            world.step();
        }
        assert_eq!(
            unit_of(&world, inside).shields,
            70,
            "never past the maximum"
        );
        // Hit points never regenerate: that is what repair is for.
        assert_eq!(unit_of(&world, inside).hp, 70);
    }

    #[test]
    fn a_death_in_the_field_restores_shields_to_nearby_friendlies_only() {
        let restored = |at: (f32, f32)| {
            let mut world = power_arena();
            let victim = spawned(&mut world, 0, "soldier", at);
            let unit = world.units.last_mut().unwrap();
            unit.hp = 1;
            unit.shields = 0;
            let friend = spawned(&mut world, 0, "soldier", (at.0 + 30.0, at.1 + 40.0));
            world.units.last_mut().unwrap().shields = 0;
            let far = spawned(&mut world, 0, "soldier", (at.0 - 190.0, at.1));
            world.units.last_mut().unwrap().shields = 0;
            let shooter = spawned(&mut world, 1, "soldier", (at.0 + 70.0, at.1));
            world.units.last_mut().unwrap().order = Order {
                kind: "attack".into(),
                x: 0.0,
                y: 0.0,
                target: victim,
            };
            world.step();
            assert!(
                world.units.iter().all(|unit| unit.id != victim),
                "victim died"
            );
            assert!(world.units.iter().any(|unit| unit.id == shooter));
            (
                unit_of(&world, friend).shields,
                unit_of(&world, far).shields,
            )
        };
        // 20% of the dead soldier's 70 + 70 to the friend 50 away; nothing to
        // the one 190 away, outside the 180 reach.
        assert_eq!(restored(POWERED), (28, 0));
        // The same death outside any field restores nothing at all.
        assert_eq!(restored(UNPOWERED), (0, 0));
    }

    #[test]
    fn a_drifter_trains_at_any_structure_in_the_field_and_goes_straight_to_work() {
        let mut world = power_arena();
        world.balances.insert(0, Balance::new(1000, 0));
        let relay = spawned(&mut world, 0, "relay", RELAY);
        let barracks = spawned(&mut world, 0, "barracks", UNPOWERED);
        let far_barracks = world.validate(&command(1, 0, barracks, "train_drifter", 0));
        assert_eq!(
            far_barracks,
            Err("Production requires the correct HQ, barracks, or factory".into()),
            "a barracks outside every field cannot train a drifter"
        );
        // A soldier still needs a barracks, field or no field.
        assert!(world
            .validate(&command(1, 0, relay, "train_soldier", 0))
            .is_err());
        world
            .execute(&command(1, 0, relay, "train_drifter", 0))
            .unwrap();
        for _ in 0..60 {
            world.step();
        }
        let drifter = world
            .units
            .iter()
            .find(|unit| unit.kind == "drifter")
            .expect("the relay trained a drifter");
        assert_eq!(drifter.order.kind, "gather", "it goes to work unordered");
        let node = node_of(&world, drifter.order.target);
        assert_eq!(node.kind, ResourceKind::Material);
        let nearest = world
            .nodes
            .iter()
            .filter(|node| node.kind == ResourceKind::Material)
            .map(|node| distance(RELAY.0, RELAY.1, node.x, node.y))
            .fold(f32::MAX, f32::min);
        assert!(distance(RELAY.0, RELAY.1, node.x, node.y) <= nearest + 150.0);

        // An unfinished relay projects nothing, so a barracks beside it is
        // still unpowered.
        let mut world = power_arena();
        world.balances.insert(0, Balance::new(1000, 0));
        spawned(&mut world, 0, "relay", RELAY);
        world.units.last_mut().unwrap().construction_remaining = 50;
        let beside = spawned(&mut world, 0, "barracks", (RELAY.0 + 120.0, RELAY.1));
        assert!(world
            .validate(&command(1, 0, beside, "train_drifter", 0))
            .is_err());
        world.units.retain(|unit| unit.kind != "relay");
        spawned(&mut world, 0, "relay", RELAY);
        assert_eq!(
            world.validate(&command(1, 0, beside, "train_drifter", 0)),
            Ok(())
        );
    }

    #[test]
    fn only_network_projects_power_and_only_from_relays_and_hubs() {
        for kind in ["relay", "hq", "outpost"] {
            assert!(crate::projects_power(kind, Faction::Network), "{kind}");
            assert!(!crate::projects_power(kind, Faction::Industrial), "{kind}");
            assert!(!crate::projects_power(kind, Faction::Organic), "{kind}");
        }
        for kind in ["barracks", "factory", "lab", "turret", "soldier", "drifter"] {
            assert!(!crate::projects_power(kind, Faction::Network), "{kind}");
        }
        let field = power_arena().zone_field();
        assert!(field.powered(0, POWERED.0, POWERED.1));
        assert!(!field.powered(1, POWERED.0, POWERED.1), "owner only");
        assert!(!field.powered(0, UNPOWERED.0, UNPOWERED.1));
        assert!(
            !field.powered(1, 1400.0, 260.0),
            "an Industrial HQ projects none"
        );
        // Connectivity and combat/death, and nothing else.
        let template = crate::power_field();
        for concept in crate::ZoneConcept::ALL {
            let expected = matches!(
                concept,
                crate::ZoneConcept::Connectivity | crate::ZoneConcept::Death
            );
            assert_eq!(template.participates_in(concept), expected, "{concept}");
        }
        // It changes no one's speed.
        assert_eq!(
            field.movement_multiplier(0, "soldier", POWERED.0, POWERED.1),
            1.0
        );
    }

    #[test]
    fn a_unit_teleports_across_its_field_after_a_channel_and_arrives_inactive() {
        let mut world = power_arena();
        spawned(&mut world, 0, "relay", RELAY);
        let soldier = spawned(&mut world, 0, "soldier", POWERED);
        world
            .execute(&order_at(soldier, "teleport", BY_RELAY))
            .unwrap();
        for _ in 0..19 {
            world.step();
        }
        let waiting = unit_of(&world, soldier);
        assert_eq!((waiting.x, waiting.y), POWERED, "channelling in place");
        world.step();
        let arrived = unit_of(&world, soldier);
        assert!(distance(arrived.x, arrived.y, BY_RELAY.0, BY_RELAY.1) < 20.0);
        assert_eq!(arrived.order.kind, "stop");
        assert_eq!(
            arrived.arrive_tick,
            world.tick + crate::TELEPORT_ARRIVAL_TICKS
        );
        let landed = (arrived.x, arrived.y);
        // Inactive on arrival: a move order waits out the window.
        assert!(world
            .validate(&order_at(soldier, "teleport", POWERED))
            .unwrap_err()
            .contains("still arriving"));
        world
            .execute(&order_at(
                soldier,
                "move",
                (RELAY.0 + 200.0, RELAY.1 + 200.0),
            ))
            .unwrap();
        for _ in 0..39 {
            world.step();
        }
        let idle = unit_of(&world, soldier);
        assert_eq!((idle.x, idle.y), landed, "inactive until arrival ends");
        for _ in 0..10 {
            world.step();
        }
        let moving = unit_of(&world, soldier);
        assert!((moving.x, moving.y) != landed, "active again");
        // Active, but the teleport itself recharges for 30s from arrival.
        let ready = moving.arrive_tick + crate::TELEPORT_COOLDOWN_TICKS;
        assert!(world
            .validate(&order_at(soldier, "teleport", BY_RELAY))
            .unwrap_err()
            .contains("recharging"));
        while world.tick < ready {
            world.step();
        }
        world
            .validate(&order_at(soldier, "teleport", BY_RELAY))
            .unwrap();
    }

    #[test]
    fn network_shield_shares_vary_by_kind() {
        // SC2-style: structures and the worker half and half, the skimmer too,
        // the sentinel and the lancer a third shields. Totals never change.
        for (kind, split) in [
            ("hq", (600, 600)),
            ("relay", (150, 150)),
            ("drifter", (20, 20)),
            ("skimmer", (35, 35)),
            ("sentinel", (148, 72)),
            ("lancer", (161, 79)),
        ] {
            assert_eq!(vitals(kind, Faction::Network), split, "{kind}");
            assert_eq!(split.0 + split.1, stats(kind).unwrap().hp, "{kind}");
        }
        assert_eq!(vitals("lancer", Faction::Industrial).1, 0);
    }

    #[test]
    fn teleport_is_refused_outside_the_field_and_cancelled_by_damage() {
        let mut world = power_arena();
        let outside = spawned(&mut world, 0, "soldier", UNPOWERED);
        let inside = spawned(&mut world, 0, "soldier", POWERED);
        let hq = world.units[0].id;
        let refused = |world: &World, unit: u32, at: (f32, f32)| {
            world.validate(&order_at(unit, "teleport", at)).unwrap_err()
        };
        assert!(refused(&world, outside, POWERED).contains("this unit is outside it"));
        assert!(refused(&world, inside, UNPOWERED).contains("destination"));
        assert!(refused(&world, hq, POWERED).contains("Only mobile units"));
        let mut queued = order_at(inside, "teleport", (POWERED.0, POWERED.1 - 100.0));
        queued.queued = true;
        assert!(
            world.validate(&queued).is_err(),
            "teleport cannot be queued"
        );

        // An Industrial unit has no field to teleport in.
        let industrial = spawned(&mut world, 1, "soldier", (1400.0, 300.0));
        let mut theirs = order_at(industrial, "teleport", (1400.0, 350.0));
        theirs.owner = 1;
        assert!(world.validate(&theirs).is_err());

        // Damage during the channel cancels it: the unit stays where it was.
        let mut world = power_arena();
        spawned(&mut world, 0, "relay", RELAY);
        let soldier = spawned(&mut world, 0, "soldier", POWERED);
        world
            .execute(&order_at(soldier, "teleport", BY_RELAY))
            .unwrap();
        spawned(&mut world, 1, "scout", (POWERED.0 + 60.0, POWERED.1));
        for _ in 0..25 {
            world.step();
        }
        let stayed = unit_of(&world, soldier);
        assert_ne!(stayed.order.kind, "teleport");
        assert!(
            distance(stayed.x, stayed.y, RELAY.0, RELAY.1) > 300.0,
            "never left"
        );
    }

    #[test]
    fn a_network_building_raises_its_shields_with_construction() {
        let mut world = power_arena();
        world.balances.insert(0, Balance::new(1000, 0));
        let drifter = spawned(&mut world, 0, "drifter", (POWERED.0, POWERED.1 - 60.0));
        world
            .execute(&order_at(
                drifter,
                "build_relay",
                (POWERED.0 + 150.0, POWERED.1 - 80.0),
            ))
            .unwrap();
        let site = world
            .units
            .iter()
            .find(|unit| unit.kind == "relay")
            .unwrap();
        assert_eq!((site.shields, site.max_shields), (0, 150));
        let id = site.id;
        for _ in 0..400 {
            world.step();
            if unit_of(&world, id).construction_remaining == 0 {
                break;
            }
        }
        let relay = unit_of(&world, id);
        assert_eq!(relay.construction_remaining, 0, "the drifter built it");
        assert_eq!(relay.shields, relay.max_shields, "finished at full shields");
    }

    #[test]
    fn every_faction_opens_with_its_own_basic_fighter() {
        let world = factional(&[
            (0, Faction::Industrial),
            (1, Faction::Network),
            (2, Faction::Organic),
        ]);
        for (slot, fighter) in [(0, "soldier"), (1, "sentinel"), (2, "swarmer")] {
            let army: Vec<&str> = world
                .units
                .iter()
                .filter(|unit| unit.owner == slot && is_army(&unit.kind))
                .map(|unit| unit.kind.as_str())
                .collect();
            assert_eq!(army, vec![fighter], "slot {slot}");
        }
        // The Network fighter is a third shields (SC2's zealot split): 220 is
        // 148 hit points and 72 shields.
        let sentinel = world
            .units
            .iter()
            .find(|unit| unit.kind == "sentinel")
            .unwrap();
        assert_eq!((sentinel.hp, sentinel.shields), (148, 72));
    }

    // --- abilities: energy, recall and bloom -----------------------------------

    #[test]
    fn network_and_organic_hubs_carry_energy_and_industrial_ones_do_not() {
        let mut world = power_arena();
        let hq = world.units[0].id;
        let industrial = world.units[1].id;
        assert_eq!(unit_of(&world, hq).energy, crate::HUB_START_ENERGY);
        assert_eq!(unit_of(&world, industrial).energy, 0);
        for _ in 0..crate::ENERGY_REGEN_INTERVAL_TICKS * 10 {
            world.step();
        }
        assert_eq!(unit_of(&world, hq).energy, crate::HUB_START_ENERGY + 10);
        assert_eq!(unit_of(&world, industrial).energy, 0);
        world.units[0].energy = crate::HUB_MAX_ENERGY;
        for _ in 0..crate::ENERGY_REGEN_INTERVAL_TICKS * 2 {
            world.step();
        }
        assert_eq!(unit_of(&world, hq).energy, crate::HUB_MAX_ENERGY, "capped");
    }

    #[test]
    fn recall_channels_then_brings_units_home_inactive_and_without_shields() {
        let mut world = power_arena();
        let hq = world.units[0].id;
        let near = spawned(&mut world, 0, "sentinel", UNPOWERED);
        let also = spawned(&mut world, 0, "skimmer", (UNPOWERED.0 + 60.0, UNPOWERED.1));
        let far = spawned(
            &mut world,
            0,
            "sentinel",
            (UNPOWERED.0 + 300.0, UNPOWERED.1),
        );
        // A rally set before the cast survives it.
        world
            .execute(&order_at(hq, "rally_move", (400.0, 1300.0)))
            .unwrap();
        world.execute(&order_at(hq, "recall", UNPOWERED)).unwrap();
        let caster = unit_of(&world, hq);
        assert_eq!(
            caster.energy,
            crate::HUB_START_ENERGY - crate::RECALL.energy
        );
        assert_eq!(caster.order.kind, "rally_move");
        assert!(world
            .validate(&order_at(hq, "recall", UNPOWERED))
            .unwrap_err()
            .contains("already channelling"));
        for _ in 0..crate::RECALL.channel_ticks - 1 {
            world.step();
        }
        assert_eq!(
            (unit_of(&world, near).x, unit_of(&world, near).y),
            UNPOWERED,
            "still channelling"
        );
        world.step();
        for id in [near, also] {
            let unit = unit_of(&world, id);
            assert!(
                distance(unit.x, unit.y, NETWORK_HQ.0, NETWORK_HQ.1) < 120.0,
                "recalled next to the hub"
            );
            assert_eq!(unit.shields, 0, "recall is paid in shields");
            assert_eq!(unit.arrive_tick, world.tick + crate::TELEPORT_ARRIVAL_TICKS);
        }
        let (near_unit, also_unit) = (unit_of(&world, near), unit_of(&world, also));
        assert!(distance(near_unit.x, near_unit.y, also_unit.x, also_unit.y) > 20.0);
        let stayed = unit_of(&world, far);
        assert_eq!(
            (stayed.x, stayed.y),
            (UNPOWERED.0 + 300.0, UNPOWERED.1),
            "out of range"
        );
        let caster = unit_of(&world, hq);
        assert!(caster.cast.is_none());
        assert_eq!(caster.order.kind, "rally_move");
        // The cooldown runs from the cast, whatever the energy.
        world
            .units
            .iter_mut()
            .find(|unit| unit.id == hq)
            .unwrap()
            .energy = 200;
        assert!(world
            .validate(&order_at(hq, "recall", (UNPOWERED.0 + 300.0, UNPOWERED.1)))
            .unwrap_err()
            .contains("recharging"));
    }

    #[test]
    fn recall_is_refused_without_energy_units_or_the_right_faction() {
        let mut world = power_arena();
        let hq = world.units[0].id;
        let industrial = world.units[1].id;
        spawned(&mut world, 0, "sentinel", UNPOWERED);
        assert!(world
            .validate(&order_at(hq, "recall", (1000.0, 600.0)))
            .unwrap_err()
            .contains("None of your units"));
        let mut theirs = order_at(industrial, "recall", UNPOWERED);
        theirs.owner = 1;
        assert!(world.validate(&theirs).unwrap_err().contains("Only the"));
        world.units[0].energy = crate::RECALL.energy - 1;
        assert!(world
            .validate(&order_at(hq, "recall", UNPOWERED))
            .unwrap_err()
            .contains("Not enough energy"));
        world.units[0].energy = crate::RECALL.energy;
        let mut queued = order_at(hq, "recall", UNPOWERED);
        queued.queued = true;
        assert!(
            world.validate(&queued).is_err(),
            "abilities cannot be queued"
        );
        let relay = spawned(&mut world, 0, "relay", RELAY);
        assert!(world
            .validate(&order_at(relay, "recall", UNPOWERED))
            .unwrap_err()
            .contains("cast by a hub"));
    }

    #[test]
    fn a_hub_destroyed_while_channelling_recalls_nobody() {
        let mut world = power_arena();
        world.spawn(0, "outpost", 700.0, 1300.0);
        let outpost = world.units.last().unwrap().id;
        let sentinel = spawned(&mut world, 0, "sentinel", UNPOWERED);
        world
            .execute(&order_at(outpost, "recall", UNPOWERED))
            .unwrap();
        world.step();
        world.units.retain(|unit| unit.id != outpost);
        for _ in 0..crate::RECALL.channel_ticks {
            world.step();
        }
        let stayed = unit_of(&world, sentinel);
        assert_eq!((stayed.x, stayed.y), UNPOWERED);
        assert_eq!(stayed.shields, stayed.max_shields);
    }

    #[test]
    fn bloom_grows_temporary_creep_on_your_own_creep_then_recedes() {
        let mut world = organic_versus_industrial();
        let hq = world
            .units
            .iter()
            .find(|unit| unit.owner == 0 && unit.kind == "hq")
            .unwrap()
            .clone();
        // Towards the middle of the map, just inside the HQ's creep.
        let (dx, dy) = (800.0 - hq.x, 800.0 - hq.y);
        let length = (dx * dx + dy * dy).sqrt();
        let at = |reach: f32| (hq.x + dx / length * reach, hq.y + dy / length * reach);
        let edge = at(f32::from(crate::CREEP_HQ_RADIUS) - 20.0);
        let beyond = at(f32::from(crate::CREEP_HQ_RADIUS) + 150.0);
        assert!(world
            .validate(&order_at(hq.id, "bloom", beyond))
            .unwrap_err()
            .contains("your own creep"));
        world.execute(&order_at(hq.id, "bloom", edge)).unwrap();
        let bloom = *world.creep.last().unwrap();
        assert_eq!(bloom.expires_tick, crate::BLOOM_LIFETIME_TICKS);
        assert_eq!(bloom.max_radius, crate::BLOOM_RADIUS);
        assert!(world.units.iter().all(|unit| unit.id != bloom.source));
        assert_eq!(
            unit_of(&world, hq.id).energy,
            crate::HUB_START_ENERGY - crate::BLOOM.energy
        );
        // Grows to full, and extends the creep past the HQ's own edge.
        for _ in 0..400 {
            world.step();
        }
        assert_eq!(
            patch_of(&world, bloom.source).unwrap().radius,
            crate::BLOOM_RADIUS
        );
        assert!(world.on_creep(0, beyond.0, beyond.1));
        // Blooms chain: the new creep takes another, once the cooldown is up.
        world
            .units
            .iter_mut()
            .find(|unit| unit.id == hq.id)
            .unwrap()
            .energy = 100;
        world.execute(&order_at(hq.id, "bloom", beyond)).unwrap();
        // Lives out its lifetime, then lingers and recedes like a lost hub's.
        while world.tick < crate::BLOOM_LIFETIME_TICKS + crate::CREEP_LINGER_TICKS {
            world.step();
        }
        assert_eq!(
            patch_of(&world, bloom.source).unwrap().radius,
            crate::BLOOM_RADIUS
        );
        for _ in 0..crate::TICKS_PER_SECOND * 11 {
            world.step();
        }
        assert!(
            patch_of(&world, bloom.source).is_none(),
            "receded to nothing"
        );
    }

    // --- one miner per patch, refineries and terrazine ----------------------

    /// A crossfire world for slot 0 (and a far-away slot 1), with the opening
    /// labour idle, and the two labour units 2 and 3 standing beside material
    /// patch 9 with a gather order on it.
    fn two_on_one_patch(faction: Faction) -> (World, &'static MapDefinition) {
        let map = crate::maps::by_id("crossfire").expect("the match map");
        let mut world = World::new_on_with_factions(map, &[(0, faction), (1, Faction::Industrial)]);
        idle_labour(&mut world);
        let patch = node_of(&world, 9).clone();
        for (id, offset) in [(2u32, 35.0), (3, 40.0)] {
            let unit = world.units.iter_mut().find(|unit| unit.id == id).unwrap();
            unit.x = patch.x;
            unit.y = patch.y + offset;
            unit.order = Order {
                kind: "gather".into(),
                x: 0.0,
                y: 0.0,
                target: 9,
            };
        }
        (world, map)
    }

    #[test]
    fn two_workers_never_mine_one_patch_at_once_and_the_second_takes_a_free_patch() {
        let (mut world, map) = two_on_one_patch(Faction::Industrial);
        let mut previous: BTreeMap<u32, u32> = world
            .nodes
            .iter()
            .map(|node| (node.id, node.amount))
            .collect();
        let mut retargeted = false;
        let mut both_mined = [false, false];
        for _ in 0..800 {
            world.step_on(map);
            // A node is only ever worked by one unit: its stock can fall by at
            // most one pulse in a tick, never two.
            for node in &world.nodes {
                let drop = previous[&node.id] - node.amount;
                assert!(
                    drop <= mining_yield(false),
                    "node {} lost {drop} in one tick: two miners at once",
                    node.id
                );
                previous.insert(node.id, node.amount);
            }
            if unit_of(&world, 3).order.target != 9 {
                retargeted = true;
            }
            for (index, id) in [2u32, 3].into_iter().enumerate() {
                both_mined[index] |= unit_of(&world, id).cargo > 0;
            }
        }
        assert!(retargeted, "the second worker never left the taken patch");
        assert_ne!(
            unit_of(&world, 2).order.target,
            unit_of(&world, 3).order.target,
            "each worker ends on a patch of its own"
        );
        assert!(both_mined[0] && both_mined[1], "both workers mined");
        assert!(world.collected(0).material >= 50);
    }

    #[test]
    fn a_worker_with_no_free_patch_in_reach_waits_and_takes_over_when_it_frees() {
        let (mut world, map) = two_on_one_patch(Faction::Industrial);
        // Only one material patch exists: nowhere to retarget to.
        world
            .nodes
            .retain(|node| node.id == 9 || node.kind == ResourceKind::Catalyst);
        for _ in 0..40 {
            world.step_on(map);
        }
        assert_eq!(node_of(&world, 9).miner, 2, "the lower id claims first");
        assert!(unit_of(&world, 2).cargo > 0);
        assert_eq!(unit_of(&world, 3).cargo, 0, "worker 3 waits its turn");
        assert_eq!(unit_of(&world, 3).order.target, 9);
        let mut took_over = false;
        for _ in 0..600 {
            world.step_on(map);
            if unit_of(&world, 3).cargo > 0 {
                took_over = true;
                assert_eq!(node_of(&world, 9).miner, 3);
                break;
            }
        }
        assert!(took_over, "the waiting worker never got the patch");
    }

    #[test]
    fn a_patch_is_released_when_its_miner_dies_is_reordered_or_walks_home() {
        // Dies.
        let (mut world, map) = two_on_one_patch(Faction::Industrial);
        world.nodes.retain(|node| node.id == 9);
        world.step_on(map);
        world.step_on(map);
        assert_eq!(node_of(&world, 9).miner, 2);
        world.units.retain(|unit| unit.id != 2);
        world.step_on(map);
        assert_ne!(
            node_of(&world, 9).miner,
            2,
            "a dead miner cannot hold a patch"
        );
        let mut took_it = false;
        for _ in 0..6 {
            world.step_on(map);
            took_it |= node_of(&world, 9).miner == 3;
        }
        assert!(took_it, "the waiting worker took it");

        // Reordered.
        let (mut world, map) = two_on_one_patch(Faction::Industrial);
        world.nodes.retain(|node| node.id == 9);
        world.step_on(map);
        world.step_on(map);
        assert_eq!(node_of(&world, 9).miner, 2);
        world
            .units
            .iter_mut()
            .find(|unit| unit.id == 2)
            .unwrap()
            .order = Order::idle();
        world.step_on(map);
        assert_ne!(node_of(&world, 9).miner, 2);

        // Turns to walk home with a full load.
        let (mut world, map) = two_on_one_patch(Faction::Industrial);
        world.nodes.retain(|node| node.id == 9);
        let mut held = false;
        for _ in 0..80 {
            world.step_on(map);
            held |= node_of(&world, 9).miner == 2;
            if unit_of(&world, 2).returning {
                assert_ne!(
                    node_of(&world, 9).miner,
                    2,
                    "a worker walking home still holds the patch"
                );
                assert!(held);
                return;
            }
        }
        panic!("worker 2 never filled its load");
    }

    #[test]
    fn a_drifter_holds_its_patch_while_it_gathers_and_a_second_one_moves_on() {
        let (mut world, map) = two_on_one_patch(Faction::Network);
        assert_eq!(unit_of(&world, 2).kind, "drifter");
        for _ in 0..200 {
            world.step_on(map);
        }
        assert_eq!(node_of(&world, 9).miner, 2);
        assert_ne!(unit_of(&world, 3).order.target, 9, "it took another patch");
        let other = unit_of(&world, 3).order.target;
        assert_eq!(node_of(&world, other).miner, 3);
        assert!(world.collected(0).material > 0);
    }

    #[test]
    fn auto_retargeting_after_depletion_prefers_a_free_patch() {
        let (mut world, map) = two_on_one_patch(Faction::Industrial);
        // Patch 9 is empty under worker 2, and its nearest neighbour, patch 8,
        // is being mined by worker 3. Worker 2 must go past it to a free patch.
        world
            .nodes
            .iter_mut()
            .find(|node| node.id == 9)
            .unwrap()
            .amount = 0;
        let patch8 = node_of(&world, 8).clone();
        {
            let unit = world.units.iter_mut().find(|unit| unit.id == 3).unwrap();
            unit.x = patch8.x;
            unit.y = patch8.y - 28.0;
            unit.order.target = 8;
        }
        world
            .nodes
            .iter_mut()
            .find(|node| node.id == 8)
            .unwrap()
            .miner = 3;
        world.step_on(map);
        let target = unit_of(&world, 2).order.target;
        assert!(
            target != 8 && target != 9,
            "worker 2 went to occupied patch {target}"
        );
        assert_eq!(node_of(&world, 8).miner, 3);
        // With every patch taken it falls back to the nearest one and waits
        // there rather than giving up.
        let mut crowded = world.nodes.clone();
        for node in &mut crowded {
            if node.kind == ResourceKind::Material {
                node.miner = 99;
            }
        }
        let worker = unit_of(&world, 2).clone();
        assert!(replacement_patch(&crowded, &worker).is_some());
    }

    #[test]
    fn a_refinery_stands_on_a_catalyst_deposit_and_extracts_on_its_own() {
        let map = crate::maps::by_id("crossfire").expect("the match map");
        let mut world =
            World::new_on_with_factions(map, &[(0, Faction::Industrial), (1, Faction::Industrial)]);
        idle_labour(&mut world);
        world.balances.insert(0, Balance::new(1000, 0));
        let deposit = node_of(&world, 1).clone();
        assert_eq!(deposit.kind, ResourceKind::Catalyst);
        let build = |at: (f32, f32), id: u64| {
            let mut build = command(id, 0, 2, "build_refinery", 0);
            build.order.x = at.0;
            build.order.y = at.1;
            build
        };
        // Not on a deposit, and on a material patch: refused with a reason.
        let refusal = world
            .validate_on(&build((600.0, 400.0), 1), map)
            .unwrap_err();
        assert!(refusal.contains("catalyst deposit"), "{refusal}");
        let material = node_of(&world, 2).clone();
        let refusal = world
            .validate_on(&build((material.x, material.y), 2), map)
            .unwrap_err();
        assert!(refusal.contains("catalyst deposit"), "{refusal}");
        // Ordered near the deposit, it snaps onto it.
        world
            .execute_on(&build((deposit.x + 30.0, deposit.y - 20.0), 3), map)
            .unwrap();
        assert_eq!(world.balances[&0], Balance::new(1000 - 75, 0));
        let refinery = world.units.last().unwrap().clone();
        assert_eq!(refinery.kind, "refinery");
        assert_eq!((refinery.x, refinery.y), (deposit.x, deposit.y));
        // A second refinery on the same deposit is refused.
        let refusal = world
            .validate_on(&build((deposit.x, deposit.y), 4), map)
            .unwrap_err();
        assert!(refusal.contains("already has a refinery"), "{refusal}");
        // Nothing is extracted while it is unfinished.
        let ticks = stats("refinery").unwrap().training_ticks;
        for _ in 0..ticks - 1 {
            world.step_on(map);
        }
        assert_eq!(node_of(&world, 1).amount, deposit.amount);
        assert_eq!(world.collected(0).catalyst, 0);
        // Once finished it extracts REFINERY_YIELD every interval, with no
        // worker anywhere near, crediting the balance and `collected`.
        let finished_at = world.tick + 1;
        let intervals = 10;
        while world.tick < finished_at + crate::REFINERY_INTERVAL_TICKS * intervals {
            world.step_on(map);
        }
        let mined = world.collected(0).catalyst;
        assert!(
            mined >= crate::REFINERY_YIELD * (intervals as u32 - 1),
            "{mined}"
        );
        assert_eq!(mined % crate::REFINERY_YIELD, 0);
        assert_eq!(
            world.balances[&0].catalyst, mined,
            "owner is credited the catalyst"
        );
        assert_eq!(node_of(&world, 1).amount, deposit.amount - mined);
        assert_eq!(
            world.collected(0).terrazine,
            0,
            "catalyst pays no terrazine"
        );
        assert_eq!(world.collected(1).catalyst, 0);
        // Destroyed, it stops.
        world.units.retain(|unit| unit.kind != "refinery");
        for _ in 0..40 {
            world.step_on(map);
        }
        assert_eq!(world.collected(0).catalyst, mined);
    }

    #[test]
    fn a_refinery_idles_on_an_empty_deposit_and_drains_it_exactly() {
        let map = crate::maps::by_id("crossfire").expect("the match map");
        let mut world =
            World::new_on_with_factions(map, &[(0, Faction::Industrial), (1, Faction::Industrial)]);
        idle_labour(&mut world);
        let deposit = node_of(&world, 1).clone();
        world
            .nodes
            .iter_mut()
            .find(|node| node.id == 1)
            .unwrap()
            .amount = 10;
        world.spawn(0, "refinery", deposit.x, deposit.y);
        for _ in 0..200 {
            world.step_on(map);
        }
        assert_eq!(node_of(&world, 1).amount, 0);
        assert_eq!(world.collected(0).catalyst, 10, "4 + 4 + 2, never more");
        assert_eq!(world.balances[&0].catalyst, STARTING_BALANCE.catalyst + 10);
        // A drained deposit takes no new refinery.
        let mut build = command(1, 0, 2, "build_refinery", 0);
        build.order.x = deposit.x;
        build.order.y = deposit.y;
        world.units.retain(|unit| unit.kind != "refinery");
        assert!(world.validate_on(&build, map).is_err());
    }

    #[test]
    fn a_refinery_counts_toward_the_building_limit_and_is_not_faction_gated() {
        for faction in [Faction::Industrial, Faction::Network, Faction::Organic] {
            assert_eq!(crate::building_faction("refinery"), None);
            let map = crate::maps::by_id("crossfire").unwrap();
            let mut world =
                World::new_on_with_factions(map, &[(0, faction), (1, Faction::Industrial)]);
            world.balances.insert(0, Balance::new(1000, 0));
            let deposit = node_of(&world, 1).clone();
            let labour = world
                .units
                .iter()
                .find(|unit| unit.owner == 0 && is_labour(&unit.kind))
                .unwrap()
                .id;
            let mut build = command(1, 0, labour, "build_refinery", 0);
            build.order.x = deposit.x;
            build.order.y = deposit.y;
            world
                .validate_on(&build, map)
                .unwrap_or_else(|reason| panic!("{faction} cannot build one: {reason}"));
            // At the building limit it is refused like anything else.
            for index in 0..MAX_BUILDINGS {
                world.spawn(0, "outpost", 100.0 + index as f32, 100.0);
            }
            assert!(world
                .validate_on(&build, map)
                .unwrap_err()
                .contains("limit"));
        }
    }

    #[test]
    fn terrazine_is_an_exact_share_of_material_mined_with_no_remainder_lost() {
        for (faction, percent) in [
            (Faction::Industrial, 12u64),
            (Faction::Network, 10),
            (Faction::Organic, 10),
        ] {
            let mut balances = BTreeMap::new();
            let mut collected = BTreeMap::new();
            let mut mined = 0u64;
            // Deliveries of every awkward size: each one on its own would round
            // to nothing, and the cumulative figure must still be exact.
            for round in 0..3 {
                for amount in 1..=40u32 {
                    credit_mined(
                        &mut balances,
                        &mut collected,
                        0,
                        faction,
                        ResourceKind::Material,
                        amount,
                    );
                    mined += amount as u64;
                    let expected = (mined * percent / 100) as u32;
                    assert_eq!(
                        balances[&0].terrazine, expected,
                        "{faction} after {mined} mined (round {round})"
                    );
                    assert_eq!(collected[&0].terrazine, expected);
                    assert_eq!(balances[&0].material as u64, mined);
                }
            }
            // Catalyst never pays a by-product.
            let before = balances[&0].terrazine;
            credit_mined(
                &mut balances,
                &mut collected,
                0,
                faction,
                ResourceKind::Catalyst,
                500,
            );
            assert_eq!(balances[&0].terrazine, before);
        }
        // The settled "+20%": Industrial earns 12 for every 10 anyone else does.
        let mut industrial = BTreeMap::new();
        let mut network = BTreeMap::new();
        let mut industrial_total = BTreeMap::new();
        let mut network_total = BTreeMap::new();
        for _ in 0..100 {
            credit_mined(
                &mut industrial,
                &mut industrial_total,
                0,
                Faction::Industrial,
                ResourceKind::Material,
                25,
            );
            credit_mined(
                &mut network,
                &mut network_total,
                0,
                Faction::Network,
                ResourceKind::Material,
                25,
            );
        }
        assert_eq!(industrial[&0].terrazine, 300);
        assert_eq!(network[&0].terrazine, 250);
        assert_eq!(industrial[&0].terrazine * 100 / network[&0].terrazine, 120);
    }

    #[test]
    fn terrazine_arrives_through_the_real_delivery_and_pays_for_a_turret() {
        let mut world = World::new(&[0, 1]);
        idle_labour(&mut world);
        world.units[1].x = 360.0;
        world.units[1].y = 335.0;
        world.commands.push(command(1, 0, 2, "gather", 1));
        for _ in 0..400 {
            world.step();
        }
        let mined = world.collected(0).material;
        assert!(mined >= 100, "{mined}");
        let terrazine = world.balances[&0].terrazine;
        assert_eq!(terrazine, mined * 12 / 100);
        assert_eq!(world.collected(0).terrazine, terrazine);
        // Enough of it buys a turret, and the turret costs nothing else.
        world
            .balances
            .insert(0, Balance::new(0, 0).with_terrazine(100));
        let mut turret = command(2, 0, 2, "build_turret", 0);
        turret.order.x = 220.0;
        turret.order.y = 600.0;
        world.execute(&turret).unwrap();
        assert_eq!(world.balances[&0], Balance::default());
        assert!(world.units.iter().any(|unit| unit.kind == "turret"));
    }

    #[test]
    fn lost_tallies_every_currency_including_terrazine() {
        let mut world = World::new(&[0, 1]);
        world.tick = crate::STIPEND_SECOND_PHASE_END_TICK;
        world.spawn(0, "turret", 600.0, 220.0);
        world.spawn(0, "refinery", 600.0, 800.0);
        let [turret, refinery] = [world.next_id - 2, world.next_id - 1];
        for id in [turret, refinery] {
            world.units.iter_mut().find(|u| u.id == id).unwrap().hp = 0;
        }
        world.step();
        assert_eq!(
            world.lost(0),
            Cost::terrazine(100) + Cost::material(75),
            "every currency is tallied"
        );
    }

    // --- roster and passives -------------------------------------------------

    /// Where the passive fights happen: open ground on the 1600 map, clear of
    /// terrain and deposits.
    const ARENA: (f32, f32) = (1100.0, 520.0);

    fn at(dx: f32, dy: f32) -> (f32, f32) {
        (ARENA.0 + dx, ARENA.1 + dy)
    }

    /// A world with nothing in it but each player's HQ, far from `ARENA`, at
    /// tick 1000 (so every "N seconds since" condition starts satisfied).
    fn passive_arena(roster: &[(u8, Faction)]) -> World {
        let mut world = World::new_on_with_factions(crate::maps::default_map(), roster);
        world.units.clear();
        world.spawn(0, "hq", 200.0, 1300.0);
        world.spawn(1, "hq", 1400.0, 1400.0);
        world.tick = 1000;
        world
    }

    fn industrial_arena() -> World {
        passive_arena(&[(0, Faction::Industrial), (1, Faction::Industrial)])
    }

    fn unit_mut(world: &mut World, id: u32) -> &mut Entity {
        world.units.iter_mut().find(|unit| unit.id == id).unwrap()
    }

    /// Sets current and maximum hit points, for a target that must outlast the
    /// measurement.
    fn tough(world: &mut World, id: u32, hp: i32) {
        let unit = unit_mut(world, id);
        unit.hp = hp;
        unit.max_hp = hp;
    }

    fn present(world: &World, id: u32) -> bool {
        world.units.iter().any(|unit| unit.id == id)
    }

    #[test]
    fn every_kind_has_at_most_one_passive_and_the_roster_is_complete() {
        use crate::{passive, passive_name, Passive};
        let army = [
            "soldier", "scout", "siege", "marksman", "medic", "bulwark", "sentinel", "skimmer",
            "lancer", "arcer", "phantom", "warden", "swarmer", "spitter", "crusher", "prowler",
            "devourer", "behemoth",
        ];
        for kind in army {
            assert!(crate::is_army(kind), "{kind}");
            assert!(passive(kind).is_some(), "{kind} has a passive");
            assert!(
                stats(kind).unwrap().cost.catalyst > 0 && stats(kind).unwrap().cost.material == 0,
                "{kind} costs catalyst only"
            );
            assert!(!passive_name(passive(kind).unwrap()).is_empty());
        }
        for kind in ["bunker", "bastion", "spine"] {
            assert!(passive(kind).is_some(), "{kind}");
            assert!(crate::is_static_defense(kind) && is_building(kind));
        }
        for kind in ["worker", "drifter", "harvester", "brood", "brute", "hq", "turret", "barracks"] {
            assert_eq!(passive(kind), None, "{kind}");
        }
        assert_eq!(passive("devourer"), Some(Passive::Veteran));
        // The medic is army, has no weapon, and cannot be starved of a fight by it.
        assert_eq!(stats("medic").unwrap().damage, 0);
    }

    #[test]
    fn new_units_are_trained_where_the_spec_says_and_only_by_their_faction() {
        use crate::{army_building, producer};
        for (kind, faction, building) in [
            ("marksman", Faction::Industrial, "barracks"),
            ("medic", Faction::Industrial, "barracks"),
            ("bulwark", Faction::Industrial, "factory"),
            ("arcer", Faction::Network, "barracks"),
            ("phantom", Faction::Network, "barracks"),
            ("warden", Faction::Network, "factory"),
            ("prowler", Faction::Organic, "barracks"),
            ("devourer", Faction::Organic, "barracks"),
            ("behemoth", Faction::Organic, "factory"),
        ] {
            assert_eq!(army_building(kind), Some(building), "{kind}");
            for other in [Faction::Industrial, Faction::Network, Faction::Organic] {
                assert_eq!(producer(kind, building, other), other == faction, "{kind} {other}");
            }
            assert!(!producer(kind, "hq", faction));
        }
        // The spec prices.
        for (kind, price) in [
            ("marksman", 125),
            ("medic", 100),
            ("bulwark", 225),
            ("arcer", 140),
            ("phantom", 160),
            ("warden", 250),
            ("prowler", 80),
            ("devourer", 120),
            ("behemoth", 275),
        ] {
            assert_eq!(stats(kind).unwrap().cost, Cost::catalyst(price), "{kind}");
        }
        // Death spawns key on total cost and stay sane for the new kinds.
        assert_eq!(death_spawn("prowler"), Some(("brood", 1)));
        assert_eq!(death_spawn("medic"), Some(("brood", 1)));
        for heavy in ["bulwark", "warden", "behemoth"] {
            assert_eq!(death_spawn(heavy), Some(("brute", 1)), "{heavy}");
        }
    }

    #[test]
    fn faction_static_defenses_are_gated_by_faction_and_cost_terrazine_only() {
        for (kind, owner_faction) in [
            ("bunker", Faction::Industrial),
            ("bastion", Faction::Network),
            ("spine", Faction::Organic),
        ] {
            assert_eq!(crate::building_faction(kind), Some(owner_faction));
            assert_eq!(
                stats(kind).unwrap().cost,
                Cost::terrazine(crate::FACTION_DEFENSE_TERRAZINE_COST)
            );
            for faction in [Faction::Industrial, Faction::Network, Faction::Organic] {
                let mut world = World::new_on_with_factions(
                    crate::maps::default_map(),
                    &[(0, faction), (1, Faction::Industrial)],
                );
                world.balances.insert(
                    0,
                    Balance::new(3000, 1000).with_terrazine(crate::FACTION_DEFENSE_TERRAZINE_COST),
                );
                let labour = world
                    .units
                    .iter()
                    .find(|unit| is_labour(&unit.kind) && unit.owner == 0)
                    .unwrap()
                    .id;
                let mut build = command(world.tick, 0, labour, &format!("build_{kind}"), 0);
                build.order.x = 600.0;
                build.order.y = 300.0;
                let result = world.validate(&build);
                assert_eq!(result.is_ok(), faction == owner_faction, "{faction} {kind}: {result:?}");
                if faction == owner_faction {
                    world.execute(&build).unwrap();
                    assert_eq!(world.balances[&0].terrazine, 0);
                    assert_eq!((world.balances[&0].material, world.balances[&0].catalyst), (3000, 1000));
                }
            }
        }
        // Without terrazine the right faction is still refused.
        let mut world = World::new_on_with_factions(
            crate::maps::default_map(),
            &[(0, Faction::Industrial), (1, Faction::Industrial)],
        );
        world.balances.insert(0, Balance::new(3000, 1000));
        let labour = world.units.iter().find(|unit| is_labour(&unit.kind) && unit.owner == 0).unwrap().id;
        let mut build = command(world.tick, 0, labour, "build_bunker", 0);
        build.order.x = 600.0;
        build.order.y = 300.0;
        assert!(world.validate(&build).is_err());
    }

    #[test]
    fn every_static_defense_fires_without_orders_and_a_turret_still_does() {
        for (kind, faction) in [
            ("turret", Faction::Industrial),
            ("bunker", Faction::Industrial),
            ("bastion", Faction::Network),
            ("spine", Faction::Organic),
        ] {
            let mut world = passive_arena(&[(0, faction), (1, Faction::Industrial)]);
            let defense = spawned(&mut world, 0, kind, ARENA);
            let range = stats(kind).unwrap().range;
            let near = spawned(&mut world, 1, "worker", at(range - 10.0, 0.0));
            let far = spawned(&mut world, 1, "worker", at(0.0, range + 60.0));
            tough(&mut world, near, 10_000);
            tough(&mut world, far, 10_000);
            for _ in 0..40 {
                world.step();
            }
            assert!(unit_of(&world, near).hp < unit_of(&world, near).max_hp, "{kind} shot");
            assert_eq!(unit_of(&world, far).hp, unit_of(&world, far).max_hp, "{kind} out of range");
            assert!(unit_of(&world, defense).shot_tick > 0, "{kind}");
        }
    }

    #[test]
    fn fortified_adds_two_armour_to_a_bunker_and_stacks_with_the_research() {
        let mut world = industrial_arena();
        let bunker = spawned(&mut world, 0, "bunker", ARENA);
        spawned(&mut world, 1, "soldier", at(60.0, 0.0));
        let before = unit_of(&world, bunker).hp;
        world.step();
        assert_eq!(unit_of(&world, bunker).hp, before - (18 - crate::FORTIFIED_ARMOUR));
        // A turret in the same place takes the full hit.
        let mut world = industrial_arena();
        let turret = spawned(&mut world, 0, "turret", ARENA);
        spawned(&mut world, 1, "soldier", at(60.0, 0.0));
        world.step();
        assert_eq!(unit_of(&world, turret).hp, stats("turret").unwrap().hp - 18);
        // With armour research the bunker takes 18 - 3 - 2.
        let mut world = industrial_arena();
        world.research.entry(0).or_default().push("research_armor".into());
        let bunker = spawned(&mut world, 0, "bunker", ARENA);
        spawned(&mut world, 1, "soldier", at(60.0, 0.0));
        world.step();
        assert_eq!(unit_of(&world, bunker).hp, stats("bunker").unwrap().hp - 13);
    }

    #[test]
    fn veteran_stacks_come_from_kills_cap_at_fifteen_and_speed_the_unit() {
        let mut world = industrial_arena();
        let soldier = spawned(&mut world, 0, "soldier", ARENA);
        for index in 0..3 {
            let victim = spawned(&mut world, 1, "worker", at(40.0, index as f32 * 25.0));
            unit_mut(&mut world, victim).hp = 1;
        }
        for _ in 0..60 {
            world.step();
        }
        assert_eq!(unit_of(&world, soldier).kills, 3);
        let zones = ZoneField::default();
        let base = stats("soldier").unwrap().speed;
        let speed = movement_speed(unit_of(&world, soldier), &zones, world.tick);
        assert!((speed - base * 1.09).abs() < 0.01, "3 stacks is +9%: {speed}");
        // The cap.
        unit_mut(&mut world, soldier).kills = 40;
        let speed = movement_speed(unit_of(&world, soldier), &zones, world.tick);
        assert!((speed - base * 1.45).abs() < 0.01, "15 stacks is +45%: {speed}");
        // Attack rate goes the same way: a shorter cooldown, never below one tick.
        assert_eq!(crate::veteran_cooldown(12, 0), 12);
        assert_eq!(crate::veteran_cooldown(12, 15), 8);
        assert_eq!(crate::veteran_cooldown(12, 500), 8, "stacks cap");
        assert_eq!(crate::veteran_cooldown(1, 15), 1);
        // A unit that is not a veteran kind does not speed up with kills.
        let scout = spawned(&mut world, 0, "scout", at(0.0, 300.0));
        unit_mut(&mut world, scout).kills = 15;
        unit_mut(&mut world, scout).contact_tick = world.tick;
        assert_eq!(movement_speed(unit_of(&world, scout), &zones, world.tick), 180.0);
    }

    #[test]
    fn veteran_credit_goes_to_the_biggest_contributor_and_ties_to_the_lower_id() {
        let mut world = industrial_arena();
        let first = spawned(&mut world, 0, "soldier", ARENA);
        let second = spawned(&mut world, 0, "soldier", at(0.0, 40.0));
        let victim = spawned(&mut world, 1, "worker", at(60.0, 20.0));
        unit_mut(&mut world, victim).hp = 10;
        world.step();
        assert!(!present(&world, victim));
        assert_eq!((unit_of(&world, first).kills, unit_of(&world, second).kills), (1, 0));
        // A bigger contributor wins over a lower id: a marksman (24) beats a soldier (18).
        let mut world = industrial_arena();
        let soldier = spawned(&mut world, 0, "soldier", ARENA);
        let marksman = spawned(&mut world, 0, "marksman", at(0.0, 40.0));
        let victim = spawned(&mut world, 1, "worker", at(60.0, 20.0));
        unit_mut(&mut world, victim).hp = 30;
        world.step();
        assert!(!present(&world, victim));
        assert_eq!((unit_of(&world, soldier).kills, unit_of(&world, marksman).kills), (0, 1));
    }

    #[test]
    fn forced_march_needs_ten_quiet_seconds_and_any_contact_resets_it() {
        let mut world = industrial_arena();
        let scout = spawned(&mut world, 0, "scout", at(0.0, 300.0));
        let zones = ZoneField::default();
        let base = stats("scout").unwrap().speed;
        let speed_at = |world: &World, tick: u64| movement_speed(unit_of(world, scout), &zones, tick);
        assert!((speed_at(&world, 1000) - base * 1.4).abs() < 0.01);
        unit_mut(&mut world, scout).contact_tick = 900;
        assert_eq!(speed_at(&world, 1099), base, "99 ticks is not enough");
        assert!((speed_at(&world, 1100) - base * 1.4).abs() < 0.01, "ten seconds");
        // Dealing damage is contact...
        let victim = spawned(&mut world, 1, "worker", at(40.0, 300.0));
        tough(&mut world, victim, 1000);
        world.step();
        assert_eq!(unit_of(&world, scout).contact_tick, world.tick);
        assert_eq!(speed_at(&world, world.tick), base);
        // ... and so is taking it.
        let mut world = industrial_arena();
        let scout = spawned(&mut world, 0, "scout", at(0.0, 300.0));
        spawned(&mut world, 1, "marksman", at(120.0, 300.0));
        world.step();
        assert_eq!(unit_of(&world, scout).contact_tick, world.tick);
        assert_eq!(movement_speed(unit_of(&world, scout), &zones, world.tick), base);
    }

    #[test]
    fn splash_hits_other_enemy_units_for_half_and_credits_its_kills() {
        for (kind, radius) in [("siege", 45.0f32), ("spitter", 35.0)] {
            let faction = crate::army_faction(kind).unwrap();
            let mut world = passive_arena(&[(0, faction), (1, Faction::Industrial)]);
            let shooter = spawned(&mut world, 0, kind, ARENA);
            let target = spawned(&mut world, 1, "worker", at(80.0, 0.0));
            let inside = spawned(&mut world, 1, "worker", at(80.0, radius - 5.0));
            let outside = spawned(&mut world, 1, "worker", at(80.0, radius + 15.0));
            let building = spawned(&mut world, 1, "barracks", at(80.0 + 60.0, 0.0));
            let friend = spawned(&mut world, 0, "worker", at(80.0, -(radius - 5.0)));
            for id in [target, inside, outside, building, friend] {
                let max = unit_of(&world, id).max_hp;
                assert_eq!(unit_of(&world, id).hp, max);
            }
            world.step();
            let shot = stats(kind).unwrap().damage;
            assert!(unit_of(&world, shooter).shot_tick == world.tick);
            assert_eq!(unit_of(&world, target).hp, 60 - shot, "{kind} primary");
            assert_eq!(unit_of(&world, inside).hp, 60 - shot * 50 / 100, "{kind} splash");
            assert_eq!(unit_of(&world, outside).hp, 60, "{kind} outside the radius");
            assert_eq!(unit_of(&world, friend).hp, 60, "{kind} friendly fire");
            assert_eq!(unit_of(&world, building).hp, unit_of(&world, building).max_hp);
        }
        // Kill attribution: a unit killed by splash counts for the shooter's slot.
        let mut world = passive_arena(&[(0, Faction::Industrial), (1, Faction::Industrial)]);
        spawned(&mut world, 0, "siege", ARENA);
        let target = spawned(&mut world, 1, "worker", at(80.0, 0.0));
        let victim = spawned(&mut world, 1, "worker", at(80.0, 30.0));
        tough(&mut world, target, 1000);
        unit_mut(&mut world, victim).hp = 10;
        world.step();
        assert!(!present(&world, victim));
        assert_eq!(world.killed(0), Cost::material(50));
        assert_eq!(world.lost(1), Cost::material(50));
    }

    #[test]
    fn entrenchment_needs_seven_and_a_half_seconds_holding_and_lingers_two_after() {
        let mut world = industrial_arena();
        let marksman = spawned(&mut world, 0, "marksman", ARENA);
        let reach = stats("marksman").unwrap().range;
        // Just beyond ordinary range, inside the entrenched one.
        let target = spawned(&mut world, 1, "worker", at(reach + 15.0, 0.0));
        tough(&mut world, target, 10_000);
        for _ in 0..149 {
            world.step();
        }
        assert!(!super::entrenched(unit_of(&world, marksman), world.tick));
        assert_eq!(unit_of(&world, target).hp, 10_000, "out of range until it digs in");
        for _ in 0..12 {
            world.step();
        }
        assert!(super::entrenched(unit_of(&world, marksman), world.tick));
        assert!(unit_of(&world, target).hp < 10_000, "the extra range reaches it");
        // Armour: a hit of 18 lands for 16.
        let unit = unit_of(&world, marksman);
        assert_eq!(super::mitigated(18, unit, false, world.tick), 16);
        assert_eq!(super::mitigated(1, unit, false, world.tick), 1, "never below 1");
        // Move off the anchor: the bonus lingers, then goes, and has to be re-earned.
        unit_mut(&mut world, marksman).x += 100.0;
        world.step();
        assert_eq!(unit_of(&world, marksman).anchor_tick, world.tick, "re-anchored");
        for _ in 0..20 {
            world.step();
        }
        assert!(super::entrenched(unit_of(&world, marksman), world.tick), "lingering");
        for _ in 0..40 {
            world.step();
        }
        assert!(!super::entrenched(unit_of(&world, marksman), world.tick), "gone");
        assert_eq!(
            super::mitigated(18, unit_of(&world, marksman), false, world.tick),
            18
        );
    }

    #[test]
    fn a_medic_heals_the_most_damaged_friendly_unit_in_reach_every_half_second() {
        let mut world = industrial_arena();
        let medic = spawned(&mut world, 0, "medic", ARENA);
        let light = spawned(&mut world, 0, "soldier", at(40.0, 0.0));
        let heavy = spawned(&mut world, 0, "soldier", at(0.0, 60.0));
        let distant = spawned(&mut world, 0, "soldier", at(0.0, 200.0));
        let building = spawned(&mut world, 0, "barracks", at(-200.0, 0.0));
        let enemy = spawned(&mut world, 1, "soldier", at(200.0, 200.0));
        unit_mut(&mut world, light).hp = 100;
        unit_mut(&mut world, heavy).hp = 60;
        unit_mut(&mut world, distant).hp = 10;
        unit_mut(&mut world, building).hp = 10;
        unit_mut(&mut world, enemy).hp = 50;
        unit_mut(&mut world, medic).hp = 40;
        world.step();
        assert_eq!(unit_of(&world, heavy).hp, 63, "the most damaged in reach");
        assert_eq!(unit_of(&world, light).hp, 100);
        for id in [distant, building, enemy, medic] {
            let expected = match id {
                x if x == distant => 10,
                x if x == building => 10,
                x if x == enemy => 50,
                _ => 40,
            };
            assert_eq!(unit_of(&world, id).hp, expected, "{id} is not healed");
        }
        for _ in 0..9 {
            world.step();
        }
        assert_eq!(unit_of(&world, heavy).hp, 63, "nothing between heals");
        world.step();
        assert_eq!(unit_of(&world, heavy).hp, 66);
        // Never past the maximum.
        unit_mut(&mut world, heavy).hp = unit_of(&world, heavy).max_hp - 1;
        unit_mut(&mut world, light).hp = unit_of(&world, light).max_hp;
        for _ in 0..30 {
            world.step();
        }
        assert_eq!(unit_of(&world, heavy).hp, unit_of(&world, heavy).max_hp);
        // A medic cannot be ordered into a fight it has no weapon for: attack-move is a move.
        let mut order = command(world.tick, 0, medic, "attack_move", 0);
        order.order.x = at(300.0, 0.0).0;
        order.order.y = at(300.0, 0.0).1;
        world.execute(&order).unwrap();
        for _ in 0..40 {
            world.step();
        }
        assert!(unit_of(&world, medic).hp > 0);
    }

    #[test]
    fn guardian_takes_thirty_percent_of_hits_on_friends_and_never_more_than_the_damage() {
        let mut world = industrial_arena();
        let bulwark = spawned(&mut world, 0, "bulwark", ARENA);
        let friend = spawned(&mut world, 0, "soldier", at(40.0, 40.0));
        let far_friend = spawned(&mut world, 0, "soldier", at(0.0, 300.0));
        let shooters: Vec<u32> = (0..5)
            .map(|index| spawned(&mut world, 1, "marksman", at(110.0, 40.0 + index as f32 * 20.0 - 40.0)))
            .collect();
        for id in shooters.iter().copied().chain([friend, bulwark, far_friend]) {
            tough(&mut world, id, 5000);
        }
        // Five marksmen fire at the nearest unit, the friend.
        world.step();
        let hit = stats("marksman").unwrap().damage;
        let redirected = hit * crate::GUARDIAN_PERCENT / 100;
        let taken_friend = 5000 - unit_of(&world, friend).hp;
        let taken_bulwark = 5000 - unit_of(&world, bulwark).hp;
        assert!(taken_friend > 0 && taken_bulwark > 0);
        // Return fire does not touch these two, so the damage is exactly the volley.
        assert!(taken_friend + taken_bulwark <= 5 * hit, "never more than the damage");
        let volley = taken_friend + taken_bulwark;
        assert_eq!(volley % hit, 0, "the shares always sum to whole hits");
        assert_eq!(taken_bulwark, redirected * (volley / hit));
        assert_eq!(unit_of(&world, far_friend).hp, 5000, "outside reach nothing is redirected");
        // A bulwark never redirects its own damage, and buildings are not guarded.
        let mut world = industrial_arena();
        let bulwark = spawned(&mut world, 0, "bulwark", ARENA);
        let bunker = spawned(&mut world, 0, "bunker", at(40.0, 0.0));
        spawned(&mut world, 1, "soldier", at(60.0, 0.0));
        world.step();
        assert_eq!(unit_of(&world, bulwark).hp, stats("bulwark").unwrap().hp, "building hit stays on the building");
        assert!(unit_of(&world, bunker).hp < stats("bunker").unwrap().hp);
    }

    #[test]
    fn guardian_redirected_damage_is_credited_to_the_attacker_when_it_kills() {
        let mut world = industrial_arena();
        let bulwark = spawned(&mut world, 0, "bulwark", ARENA);
        let friend = spawned(&mut world, 0, "soldier", at(40.0, 0.0));
        spawned(&mut world, 1, "marksman", at(130.0, 0.0));
        unit_mut(&mut world, bulwark).hp = 3;
        tough(&mut world, friend, 5000);
        world.step();
        assert!(!present(&world, bulwark), "the redirected share killed it");
        assert_eq!(world.killed(1), Cost::catalyst(225));
        assert_eq!(world.lost(0), Cost::catalyst(225));
    }

    fn blink_setup(sentinel_at: (f32, f32), attacker_at: (f32, f32)) -> (World, u32, u32) {
        let mut world = passive_arena(&[(0, Faction::Industrial), (1, Faction::Network)]);
        let attacker = spawned(&mut world, 0, "soldier", attacker_at);
        let sentinel = spawned(&mut world, 1, "sentinel", sentinel_at);
        tough(&mut world, attacker, 5000);
        let unit = unit_mut(&mut world, sentinel);
        unit.shields = 0;
        unit.hp = 60;
        (world, attacker, sentinel)
    }

    #[test]
    fn battle_blink_jumps_160_away_from_the_attacker_once_per_cooldown() {
        let start = at(0.0, 0.0);
        let (mut world, attacker, sentinel) = blink_setup(start, at(-60.0, 0.0));
        world.step();
        let unit = unit_of(&world, sentinel);
        assert!(((unit.x - start.0) - 160.0).abs() < 2.0, "straight away: {}", unit.x - start.0);
        assert!((unit.y - start.1).abs() < 2.0);
        assert_eq!(unit.passive_ready_tick, world.tick + crate::BLINK_COOLDOWN_TICKS);
        assert_eq!(unit.last_attacker, attacker);
        assert!(Navigation::new(crate::maps::default_map(), &world.units).free(unit.x, unit.y));
        // On cooldown: hit again from beside it and it stays.
        let landed = (unit.x, unit.y);
        unit_mut(&mut world, attacker).x = landed.0 - 50.0;
        unit_mut(&mut world, attacker).y = landed.1;
        unit_mut(&mut world, sentinel).hp = 40;
        unit_mut(&mut world, attacker).next_attack = 0;
        world.step();
        assert_eq!((unit_of(&world, sentinel).x, unit_of(&world, sentinel).y), landed);
        // Ready again after twelve seconds.
        world.tick += 240;
        unit_mut(&mut world, sentinel).hp = 40;
        unit_mut(&mut world, attacker).next_attack = 0;
        world.step();
        assert!(unit_of(&world, sentinel).x > landed.0 + 100.0, "second blink");
    }

    #[test]
    fn battle_blink_needs_the_threshold_and_lands_on_legal_ground() {
        // Healthy: no blink.
        let (mut world, _, sentinel) = blink_setup(at(0.0, 0.0), at(-60.0, 0.0));
        unit_mut(&mut world, sentinel).hp = 140;
        world.step();
        assert_eq!(unit_of(&world, sentinel).x, ARENA.0);
        // Away points into terrain (the 880..960 x 560..720 block): it lands on legal ground anyway.
        let (mut world, _, sentinel) = blink_setup((1060.0, 640.0), (1120.0, 640.0));
        world.step();
        let unit = unit_of(&world, sentinel);
        assert!((unit.x - 1060.0).abs() > 40.0, "it blinked: {}", unit.x);
        let map = crate::maps::default_map();
        assert!(map.terrain_free(unit.x, unit.y, 0.0), "landed in terrain at {},{}", unit.x, unit.y);
        assert!(Navigation::new(map, &world.units).free(unit.x, unit.y));
    }

    #[test]
    fn overwatch_boosts_the_first_attack_after_ten_idle_seconds_for_one_second() {
        let mut world = passive_arena(&[(0, Faction::Network), (1, Faction::Industrial)]);
        let lancer = spawned(&mut world, 0, "lancer", ARENA);
        let target = spawned(&mut world, 1, "worker", at(100.0, 0.0));
        tough(&mut world, target, 10_000);
        let shot = stats("lancer").unwrap().damage;
        let lost = |world: &World| 10_000 - unit_of(world, target).hp;
        world.step();
        assert_eq!(lost(&world), shot * 3 / 2, "the first shot after a rest");
        // The window (20 ticks) closes before the next shot (40 ticks later).
        for _ in 0..40 {
            world.step();
        }
        assert_eq!(lost(&world), shot * 3 / 2 + shot, "the second is normal");
        // Not rested again yet: still normal.
        for _ in 0..80 {
            world.step();
        }
        let before = lost(&world);
        for _ in 0..40 {
            world.step();
        }
        assert_eq!(lost(&world) - before, shot, "no overwatch without ten idle seconds");
        // Idle for ten seconds (no target): the next first shot is boosted again.
        unit_mut(&mut world, target).x += 2000.0;
        for _ in 0..205 {
            world.step();
        }
        unit_mut(&mut world, target).x -= 2000.0;
        let before = lost(&world);
        world.step();
        assert_eq!(lost(&world) - before, shot * 3 / 2);
        assert!(unit_of(&world, lancer).passive_ready_tick > 0);
    }

    #[test]
    fn ricochet_jumps_to_up_to_two_more_enemy_units_at_half_then_a_quarter() {
        let mut world = passive_arena(&[(0, Faction::Network), (1, Faction::Industrial)]);
        let arcer = spawned(&mut world, 0, "arcer", ARENA);
        let first = spawned(&mut world, 1, "worker", at(100.0, 0.0));
        let second = spawned(&mut world, 1, "worker", at(100.0, 50.0));
        let third = spawned(&mut world, 1, "worker", at(100.0, 110.0));
        let fourth = spawned(&mut world, 1, "worker", at(100.0, 170.0));
        let off_line = spawned(&mut world, 1, "worker", at(100.0, -60.0));
        let building = spawned(&mut world, 1, "barracks", at(160.0, 0.0));
        for id in [first, second, third, fourth, off_line] {
            tough(&mut world, id, 1000);
        }
        let shot = stats("arcer").unwrap().damage;
        world.step();
        assert!(unit_of(&world, arcer).shot_tick == world.tick);
        assert_eq!(1000 - unit_of(&world, first).hp, shot);
        assert_eq!(1000 - unit_of(&world, second).hp, shot / 2);
        assert_eq!(1000 - unit_of(&world, third).hp, shot / 4);
        assert_eq!(unit_of(&world, fourth).hp, 1000, "two bounces at most");
        assert_eq!(unit_of(&world, off_line).hp, 1000, "the nearest unstruck enemy is next, not the first one in reach");
        assert_eq!(unit_of(&world, building).hp, unit_of(&world, building).max_hp);
        // A bounce kill is credited to the arcer's slot.
        let mut world = passive_arena(&[(0, Faction::Network), (1, Faction::Industrial)]);
        spawned(&mut world, 0, "arcer", ARENA);
        let first = spawned(&mut world, 1, "worker", at(100.0, 0.0));
        let second = spawned(&mut world, 1, "worker", at(100.0, 50.0));
        tough(&mut world, first, 1000);
        unit_mut(&mut world, second).hp = 5;
        world.step();
        assert!(!present(&world, second));
        assert_eq!(world.killed(0), Cost::material(50));
    }

    #[test]
    fn a_bastion_ricochets_once() {
        let mut world = passive_arena(&[(0, Faction::Network), (1, Faction::Industrial)]);
        spawned(&mut world, 0, "bastion", ARENA);
        let first = spawned(&mut world, 1, "worker", at(100.0, 0.0));
        let second = spawned(&mut world, 1, "worker", at(100.0, 50.0));
        let third = spawned(&mut world, 1, "worker", at(100.0, 110.0));
        for id in [first, second, third] {
            tough(&mut world, id, 1000);
        }
        world.step();
        let shot = stats("bastion").unwrap().damage;
        assert_eq!(1000 - unit_of(&world, first).hp, shot);
        assert_eq!(1000 - unit_of(&world, second).hp, shot / 2);
        assert_eq!(unit_of(&world, third).hp, 1000);
    }

    #[test]
    fn phase_shift_absorbs_the_first_hit_of_every_eight_seconds() {
        let mut world = passive_arena(&[(0, Faction::Industrial), (1, Faction::Network)]);
        let soldier = spawned(&mut world, 0, "soldier", ARENA);
        let phantom = spawned(&mut world, 1, "phantom", at(30.0, 0.0));
        tough(&mut world, soldier, 100_000);
        let unit = unit_mut(&mut world, phantom);
        unit.max_hp = 100_000;
        unit.hp = 100_000;
        unit.max_shields = 0;
        unit.shields = 0;
        let start = world.tick;
        let mut absorbed = Vec::new();
        for _ in 0..200 {
            let before = unit_of(&world, phantom).hp;
            world.step();
            if unit_of(&world, soldier).shot_tick == world.tick {
                if unit_of(&world, phantom).hp == before {
                    absorbed.push(world.tick - start);
                }
            }
        }
        assert_eq!(absorbed, vec![1, 169], "the first shot, then the first one after eight seconds");
    }

    #[test]
    fn a_warden_keeps_shields_regenerating_under_fire_and_wardens_do_not_stack() {
        let run = |wardens: &[(f32, f32)]| {
            let mut world = passive_arena(&[(0, Faction::Industrial), (1, Faction::Network)]);
            let attacker = spawned(&mut world, 0, "soldier", ARENA);
            let sentinel = spawned(&mut world, 1, "sentinel", at(60.0, 0.0));
            for at_spot in wardens {
                let warden = spawned(&mut world, 1, "warden", at(at_spot.0, at_spot.1));
                tough(&mut world, warden, 5000);
            }
            tough(&mut world, attacker, 100_000);
            let unit = unit_mut(&mut world, sentinel);
            unit.max_shields = 5000;
            unit.shields = 2500;
            for _ in 0..100 {
                world.step();
            }
            unit_of(&world, sentinel).shields
        };
        let alone = run(&[]);
        let covered = run(&[(60.0, 60.0)]);
        let doubled = run(&[(60.0, 60.0), (60.0, -60.0)]);
        let distant = run(&[(60.0, 160.0)]);
        // Ticks 1001..=1100 contain ten multiples of ten: one point each.
        assert_eq!(covered - alone, 10);
        assert_eq!(doubled, covered, "two wardens do not stack");
        assert_eq!(distant, alone, "outside the aura (110) nothing changes");
    }

    #[test]
    fn predator_heals_hit_points_first_and_shields_only_if_it_has_any() {
        let mut world = passive_arena(&[(0, Faction::Organic), (1, Faction::Industrial)]);
        let swarmer = spawned(&mut world, 0, "swarmer", ARENA);
        let target = spawned(&mut world, 1, "worker", at(15.0, 0.0));
        tough(&mut world, target, 1000);
        let heal = stats("swarmer").unwrap().damage * crate::PREDATOR_PERCENT / 100;
        assert_eq!(heal, 2);
        unit_mut(&mut world, swarmer).hp = 30;
        world.step();
        assert_eq!(unit_of(&world, swarmer).hp, 30 + heal);
        // Full health and no shields: nothing to heal, nothing gained.
        let mut world = passive_arena(&[(0, Faction::Organic), (1, Faction::Industrial)]);
        let swarmer = spawned(&mut world, 0, "swarmer", ARENA);
        let target = spawned(&mut world, 1, "worker", at(15.0, 0.0));
        tough(&mut world, target, 1000);
        world.step();
        let unit = unit_of(&world, swarmer);
        assert_eq!((unit.hp, unit.shields), (unit.max_hp, 0));
        // A unit with shields spills the overflow into them: one point of hit
        // points missing, two healed.
        let unit = unit_mut(&mut world, swarmer);
        unit.max_shields = 10;
        unit.shields = 0;
        unit.hp = unit.max_hp - 1;
        unit.next_attack = 0;
        world.step();
        let unit = unit_of(&world, swarmer);
        assert_eq!((unit.hp, unit.shields), (unit.max_hp, 1));
        // The spine heals itself the same way.
        let mut world = passive_arena(&[(0, Faction::Organic), (1, Faction::Industrial)]);
        let spine = spawned(&mut world, 0, "spine", ARENA);
        let target = spawned(&mut world, 1, "worker", at(100.0, 0.0));
        tough(&mut world, target, 1000);
        unit_mut(&mut world, spine).hp = 100;
        world.step();
        assert_eq!(unit_of(&world, spine).hp, 100 + stats("spine").unwrap().damage * 30 / 100);
    }

    #[test]
    fn regrowth_waits_five_quiet_seconds_then_restores_two_percent_a_second() {
        let mut world = passive_arena(&[(0, Faction::Organic), (1, Faction::Industrial)]);
        let crusher = spawned(&mut world, 0, "crusher", ARENA);
        let max = unit_of(&world, crusher).max_hp;
        unit_mut(&mut world, crusher).hp = 200;
        unit_mut(&mut world, crusher).damaged_tick = world.tick;
        for _ in 0..99 {
            world.step();
        }
        assert_eq!(unit_of(&world, crusher).hp, 200, "five seconds of quiet first");
        for _ in 0..20 {
            world.step();
        }
        assert_eq!(unit_of(&world, crusher).hp, 200 + max * 2 / 100);
        // Damage resets the wait.
        unit_mut(&mut world, crusher).damaged_tick = world.tick;
        let held = unit_of(&world, crusher).hp;
        for _ in 0..90 {
            world.step();
        }
        assert_eq!(unit_of(&world, crusher).hp, held);
        // Never past the maximum.
        unit_mut(&mut world, crusher).hp = max - 1;
        for _ in 0..200 {
            world.step();
        }
        assert_eq!(unit_of(&world, crusher).hp, max);
    }

    #[test]
    fn a_behemoth_bursts_eighty_into_every_enemy_unit_around_it_as_it_dies() {
        let mut world = passive_arena(&[(0, Faction::Organic), (1, Faction::Industrial)]);
        let behemoth = spawned(&mut world, 0, "behemoth", ARENA);
        unit_mut(&mut world, behemoth).hp = 1;
        let near = spawned(&mut world, 1, "soldier", at(30.0, 0.0));
        let mid = spawned(&mut world, 1, "soldier", at(0.0, 65.0));
        let dies = spawned(&mut world, 1, "soldier", at(-65.0, 0.0));
        let outside = spawned(&mut world, 1, "soldier", at(0.0, -100.0));
        let building = spawned(&mut world, 1, "barracks", at(-40.0, -40.0));
        let friend = spawned(&mut world, 0, "worker", at(20.0, 20.0));
        tough(&mut world, friend, 10_000);
        unit_mut(&mut world, dies).hp = 70;
        world.step();
        assert!(!present(&world, behemoth));
        // The behemoth's own blow lands on the nearest (`near`), so it loses 28 + 80.
        assert_eq!(unit_of(&world, near).hp, 140 - 28 - 80);
        assert_eq!(unit_of(&world, mid).hp, 140 - 80);
        assert_eq!(unit_of(&world, outside).hp, 140, "outside 70");
        assert_eq!(unit_of(&world, building).hp, unit_of(&world, building).max_hp, "buildings are spared");
        // The soldiers shoot the friend (it is nearer to them): a burst would be 80.
        assert!(10_000 - unit_of(&world, friend).hp <= 4 * 18, "friends are spared");
        // The unit the burst killed counts for the behemoth's slot.
        assert!(!present(&world, dies));
        assert_eq!(world.killed(0), Cost::catalyst(100));
    }

    #[test]
    fn death_bursts_chain_through_behemoths_the_burst_kills() {
        let mut world = passive_arena(&[(0, Faction::Organic), (1, Faction::Organic)]);
        let first = spawned(&mut world, 0, "behemoth", ARENA);
        let second = spawned(&mut world, 1, "behemoth", at(50.0, 0.0));
        let third = spawned(&mut world, 0, "behemoth", at(100.0, 0.0));
        spawned(&mut world, 1, "soldier", at(-90.0, 0.0));
        unit_mut(&mut world, first).hp = 1;
        unit_mut(&mut world, second).hp = 60;
        world.step();
        assert!(!present(&world, first));
        assert!(!present(&world, second), "the first burst killed it");
        assert!(unit_of(&world, third).hp <= 450 - 80, "and its burst reached the third");
    }

    #[test]
    fn phantoms_and_bursts_share_the_damage_path_with_guardian_and_phase() {
        // A burst on a phantom is a hit, so it is absorbed whole.
        let mut world = passive_arena(&[(0, Faction::Organic), (1, Faction::Network)]);
        let behemoth = spawned(&mut world, 0, "behemoth", ARENA);
        unit_mut(&mut world, behemoth).hp = 1;
        // 65 away: inside the burst (70), outside the behemoth's own reach (60).
        let phantom = spawned(&mut world, 1, "phantom", at(0.0, 65.0));
        let shooter = spawned(&mut world, 1, "sentinel", at(100.0, 0.0));
        let before = unit_of(&world, phantom).hp + unit_of(&world, phantom).shields;
        world.step();
        assert!(!present(&world, behemoth));
        let after = unit_of(&world, phantom).hp + unit_of(&world, phantom).shields;
        assert_eq!(before, after, "the burst was the phantom's absorbed hit");
        assert!(present(&world, shooter));
    }

    /// Several passives in one brawl, replayed twice from one clone.
    fn passive_brawl() -> World {
        let mut world = World::new_on_with_factions(
            crate::maps::default_map(),
            &[
                (0, Faction::Industrial),
                (1, Faction::Network),
                (2, Faction::Organic),
            ],
        );
        world.units.clear();
        world.spawn(0, "hq", 200.0, 1300.0);
        world.spawn(1, "hq", 1400.0, 1400.0);
        world.spawn(2, "hq", 1400.0, 200.0);
        let mut place = |owner: u8, kind: &str, x: f32, y: f32| {
            world.spawn(owner, kind, x, y);
            let id = world.units.last().unwrap().id;
            world.units.last_mut().unwrap().order = Order {
                kind: "attack_move".into(),
                x: 1100.0,
                y: 520.0,
                target: 0,
            };
            id
        };
        let mut row = 0.0;
        for kind in ["soldier", "marksman", "medic", "bulwark", "siege", "scout"] {
            for column in 0..4 {
                place(0, kind, 800.0 + column as f32 * 24.0, 400.0 + row);
            }
            row += 26.0;
        }
        let mut row = 0.0;
        for kind in ["sentinel", "arcer", "phantom", "warden", "lancer", "skimmer"] {
            for column in 0..4 {
                place(1, kind, 1400.0 - column as f32 * 24.0, 420.0 + row);
            }
            row += 26.0;
        }
        let mut row = 0.0;
        for kind in ["swarmer", "devourer", "prowler", "spitter", "crusher", "behemoth"] {
            for column in 0..6 {
                place(2, kind, 1100.0 + column as f32 * 20.0, 700.0 + row);
            }
            row += 24.0;
        }
        world.spawn(2, "spine", 1180.0, 640.0);
        world.spawn(0, "bunker", 760.0, 380.0);
        world.spawn(1, "bastion", 1440.0, 380.0);
        world
    }

    #[test]
    fn a_fight_with_every_passive_replays_identically() {
        let mut first = passive_brawl();
        let mut second = first.clone();
        for _ in 0..1500 {
            first.step();
            second.step();
        }
        assert_eq!(first, second);
        assert!(first.killed(0).total() + first.killed(1).total() + first.killed(2).total() > 0, "the brawl produced kills");
        assert!(first.units.iter().any(|unit| unit.kills > 0), "veteran stacks accrued");
        assert!(first.units.iter().all(|unit| unit.x.is_finite() && unit.y.is_finite()));
        assert!(first.units.iter().all(|unit| unit.hp <= unit.max_hp && unit.shields <= unit.max_shields));
    }

    fn eight_patch_line() -> Vec<Node> {
        (0..8)
            .map(|index| Node {
                id: 100 + index,
                x: 1000.0 + index as f32 * 70.0,
                y: 450.0,
                amount: 4000,
                kind: ResourceKind::Material,
                miner: 0,
            })
            .collect()
    }

    #[test]
    fn labour_waiting_at_a_taken_patch_reaches_free_ones_at_the_far_end_of_a_long_line() {
        // Drifters, because they stay on their patch: a worker's claim is
        // released every time it walks home, which would blur what is measured.
        let mut world = World::new_on_with_factions(
            crate::maps::default_map(),
            &[(0, Faction::Network), (1, Faction::Industrial)],
        );
        world.units.clear();
        world.spawn(0, "hq", 900.0, 300.0);
        world.spawn(1, "hq", 1400.0, 1400.0);
        world.nodes = eight_patch_line();
        // Five already mining the first five patches of a 490-wide line...
        for index in 0..5u32 {
            let id = spawned(&mut world, 0, "drifter", (1000.0 + index as f32 * 70.0, 470.0));
            unit_mut(&mut world, id).order = Order { kind: "gather".into(), x: 0.0, y: 0.0, target: 100 + index };
        }
        // ... and two more sent to the first one. The free patches are 350 and
        // 420 from it: out of reach of the old radius (250, from the taken
        // patch), inside the new one (450, from the unit).
        for index in 0..2 {
            let id = spawned(&mut world, 0, "drifter", (1000.0 + index as f32 * 20.0, 480.0));
            unit_mut(&mut world, id).order = Order { kind: "gather".into(), x: 0.0, y: 0.0, target: 100 };
        }
        for _ in 0..400 {
            world.step();
        }
        let held: BTreeSet<u32> = world.nodes.iter().filter(|node| node.miner != 0).map(|node| node.id).collect();
        let holders: BTreeSet<u32> = world.nodes.iter().filter(|node| node.miner != 0).map(|node| node.miner).collect();
        assert_eq!(held.len(), 7, "seven distinct patches are held");
        assert_eq!(holders.len(), 7, "by seven distinct units");
        let targets: BTreeSet<u32> = world.units.iter().filter(|unit| unit.kind == "drifter").map(|unit| unit.order.target).collect();
        assert_eq!(targets.len(), 7, "and nobody is still waiting at a taken one");
    }
}
