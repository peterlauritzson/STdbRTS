pub mod maps;
pub mod navigation;
pub mod simulation;

/// Identity of the frozen rules surface. Bump this whenever anything a running
/// match depends on changes: unit stats, costs, damage rules, production
/// requirements, movement, world size, or the command-delay bounds. A match
/// records the value current at its creation and never re-reads it, so two
/// matches carrying different ruleset versions were played under different
/// rules and their replays are not comparable.
pub const RULESET_VERSION: u32 = 9;

pub const TICKS_PER_SECOND: u64 = 20;
pub const TICKS_PER_MINUTE: u64 = TICKS_PER_SECOND * 60;

/// The command delay a newly created match freezes, in ticks. 20 ticks is
/// exactly one second at `TICKS_PER_SECOND`.
pub const DEFAULT_COMMAND_DELAY: u64 = 20;

/// Ticks between two points on a match-history graph — 100 ticks, five seconds
/// at `TICKS_PER_SECOND`. Four players at this rate write 48 rows a minute, so
/// a twenty-minute match costs about 960 rows and an hour about 2880.
pub const SAMPLE_INTERVAL_TICKS: u64 = 100;

/// Whether `tick` is a point a match-history sample is taken at.
///
/// It is a property of the tick and nothing else — not of how many ticks a wake
/// advanced, not of when the server last woke — which is what makes a sample
/// point reachable exactly once in the life of a match. Tick 0 is the bootstrap
/// state, before any tick has been simulated, and is not a sample point.
pub const fn is_sample_tick(tick: u64) -> bool {
    tick > 0 && tick % SAMPLE_INTERVAL_TICKS == 0
}

/// Inclusive bounds on a frozen command delay, spanning the 0.5s / 1.0s / 1.5s
/// trial points at `TICKS_PER_SECOND`. Out-of-range values are rejected at room
/// creation, never clamped.
pub const COMMAND_DELAY_MIN: u64 = 10;
pub const COMMAND_DELAY_MAX: u64 = 30;

// ---------------------------------------------------------------------------
// Factions
// ---------------------------------------------------------------------------

/// Which economy a player is playing. The first difference between the three is
/// the labour unit and the mining loop itself, not the army roster: `Industrial`
/// mines and returns, `Network` credits in place and never walks a load home,
/// `Organic` trades material for hub stock and splits labour from construction.
///
/// `Industrial` is the default and is the baseline the skirmish has always
/// played, so a world or a row that carries no faction behaves exactly as it did
/// before factions existed.
#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Faction {
    Industrial,
    Network,
    Organic,
}

impl Default for Faction {
    fn default() -> Self {
        Self::Industrial
    }
}

/// The rotation a room hands out, in slot order. A four-player room therefore
/// holds all three economies, and slot 0 — the host, and the slot every existing
/// test and replay uses — keeps the Industrial baseline.
pub const FACTION_ROTATION: [Faction; 3] = [Faction::Industrial, Faction::Network, Faction::Organic];

/// The faction a slot is given. Deterministic and total: the same slot always
/// yields the same faction, on any host, in any order of joining.
pub const fn faction_for_slot(slot: u8) -> Faction {
    FACTION_ROTATION[slot as usize % FACTION_ROTATION.len()]
}

impl Faction {
    /// Stable lowercase spelling, for serialization and rejection messages.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Industrial => "industrial",
            Self::Network => "network",
            Self::Organic => "organic",
        }
    }
}

impl std::fmt::Display for Faction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// Economy: two currencies
// ---------------------------------------------------------------------------

/// Which of the two spendable currencies a deposit yields and a worker carries.
///
/// `Material` funds expansion, workers and the basic army and is widely
/// distributed; `Catalyst` funds technology and specialists and comes from
/// fewer, more contested sites. There is no conversion between them.
#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    Material,
    Catalyst,
}

impl Default for ResourceKind {
    fn default() -> Self {
        Self::Material
    }
}

impl ResourceKind {
    /// Stable authored spelling. Map JSON and the map content hash both use it,
    /// so it cannot change without bumping the hash encoding.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Material => "material",
            Self::Catalyst => "catalyst",
        }
    }
}

impl std::fmt::Display for ResourceKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A price in both currencies. A price is paid in full or not at all: there is
/// no partial payment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cost {
    pub material: u32,
    pub catalyst: u32,
}

impl Cost {
    pub const ZERO: Self = Self::new(0, 0);

    pub const fn new(material: u32, catalyst: u32) -> Self {
        Self { material, catalyst }
    }

    /// A price that costs no catalyst at all.
    pub const fn material(material: u32) -> Self {
        Self::new(material, 0)
    }

    pub const fn is_free(self) -> bool {
        self.material == 0 && self.catalyst == 0
    }

    pub const fn amount(self, kind: ResourceKind) -> u32 {
        match kind {
            ResourceKind::Material => self.material,
            ResourceKind::Catalyst => self.catalyst,
        }
    }

    /// `percent` of each currency, each rounded down independently. Integer
    /// arithmetic only: no balance ever carries a fractional unit.
    pub fn percent(self, percent: u32) -> Self {
        let share = |value: u32| (value as u64 * percent as u64 / 100) as u32;
        Self::new(share(self.material), share(self.catalyst))
    }
}

impl std::ops::Add for Cost {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        Self::new(
            self.material.saturating_add(other.material),
            self.catalyst.saturating_add(other.catalyst),
        )
    }
}

impl std::iter::Sum for Cost {
    fn sum<I: Iterator<Item = Self>>(iterator: I) -> Self {
        iterator.fold(Self::ZERO, |total, cost| total + cost)
    }
}

/// What one player currently holds of each currency.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Balance {
    pub material: u32,
    pub catalyst: u32,
}

impl Balance {
    pub const fn new(material: u32, catalyst: u32) -> Self {
        Self { material, catalyst }
    }

    pub const fn amount(self, kind: ResourceKind) -> u32 {
        match kind {
            ResourceKind::Material => self.material,
            ResourceKind::Catalyst => self.catalyst,
        }
    }

    /// True only when *both* currencies cover the price.
    pub const fn covers(self, cost: Cost) -> bool {
        self.material >= cost.material && self.catalyst >= cost.catalyst
    }

    /// All-or-nothing payment: a price that is not fully covered leaves the
    /// balance completely untouched and answers `false`.
    pub fn pay(&mut self, cost: Cost) -> bool {
        if !self.covers(cost) {
            return false;
        }
        self.material -= cost.material;
        self.catalyst -= cost.catalyst;
        true
    }

    pub fn credit(&mut self, cost: Cost) {
        self.material = self.material.saturating_add(cost.material);
        self.catalyst = self.catalyst.saturating_add(cost.catalyst);
    }

    pub fn credit_kind(&mut self, kind: ResourceKind, amount: u32) {
        match kind {
            ResourceKind::Material => self.material = self.material.saturating_add(amount),
            ResourceKind::Catalyst => self.catalyst = self.catalyst.saturating_add(amount),
        }
    }

    /// The currency that falls short first, for a rejection message.
    pub const fn shortfall(self, cost: Cost) -> Option<ResourceKind> {
        if self.material < cost.material {
            Some(ResourceKind::Material)
        } else if self.catalyst < cost.catalyst {
            Some(ResourceKind::Catalyst)
        } else {
            None
        }
    }
}

/// What every player starts a match holding.
pub const STARTING_BALANCE: Balance = Balance::new(250, 0);

/// Material charged per repair pulse (see `World::step`).
pub const REPAIR_COST: Cost = Cost::material(1);

/// Share of the price actually paid that an eligible army unit returns to its
/// owner when it dies. Workers and buildings return nothing.
pub const ARMY_DEATH_REFUND_PERCENT: u32 = 50;

/// Credit owed to the owner of a dying entity. Only army kinds (see
/// [`is_army`]) are eligible; every other kind — labour, buildings, temporary
/// units, unknown kinds — returns nothing.
pub fn death_refund(kind: &str) -> Cost {
    if !is_army(kind) {
        return Cost::ZERO;
    }
    stats(kind).map_or(Cost::ZERO, |definition| {
        definition.cost.percent(ARMY_DEATH_REFUND_PERCENT)
    })
}

// --- Opening stipend --------------------------------------------------------
//
// Every player is paid material on a fixed schedule so that an opening does not
// depend solely on worker travel. Accumulated in whole units against the tick
// counter: no float ever reaches a balance.

pub const STIPEND_FIRST_RATE_PER_MINUTE: u32 = 200;
pub const STIPEND_SECOND_RATE_PER_MINUTE: u32 = 100;
pub const STIPEND_FIRST_PHASE_SECONDS: u64 = 90;
pub const STIPEND_SECOND_PHASE_SECONDS: u64 = 90;

/// Last tick of the 200/minute phase.
pub const STIPEND_FIRST_PHASE_END_TICK: u64 = STIPEND_FIRST_PHASE_SECONDS * TICKS_PER_SECOND;
/// Last tick of the 100/minute phase; nothing is paid afterwards.
pub const STIPEND_SECOND_PHASE_END_TICK: u64 =
    STIPEND_FIRST_PHASE_END_TICK + STIPEND_SECOND_PHASE_SECONDS * TICKS_PER_SECOND;
/// One material every this many ticks during the first phase (1200/200 = 6).
pub const STIPEND_FIRST_INTERVAL_TICKS: u64 =
    TICKS_PER_MINUTE / STIPEND_FIRST_RATE_PER_MINUTE as u64;
/// One material every this many ticks during the second phase (1200/100 = 12).
pub const STIPEND_SECOND_INTERVAL_TICKS: u64 =
    TICKS_PER_MINUTE / STIPEND_SECOND_RATE_PER_MINUTE as u64;

/// Material due to every player on `tick`, always 1 or 0. Tick 0 is the
/// bootstrap state and pays nothing; the first payment lands on tick
/// `STIPEND_FIRST_INTERVAL_TICKS`.
pub fn stipend_payment(tick: u64) -> u32 {
    let interval = if tick == 0 {
        return 0;
    } else if tick <= STIPEND_FIRST_PHASE_END_TICK {
        STIPEND_FIRST_INTERVAL_TICKS
    } else if tick <= STIPEND_SECOND_PHASE_END_TICK {
        STIPEND_SECOND_INTERVAL_TICKS
    } else {
        return 0;
    };
    u32::from(tick % interval == 0)
}

/// Total material the stipend has paid a player present from tick 1 through
/// `tick` inclusive. Closed form; the simulation itself only ever adds
/// `stipend_payment`.
pub fn stipend_total(tick: u64) -> u64 {
    let first = tick.min(STIPEND_FIRST_PHASE_END_TICK) / STIPEND_FIRST_INTERVAL_TICKS;
    let capped = tick.min(STIPEND_SECOND_PHASE_END_TICK);
    let second =
        capped.saturating_sub(STIPEND_FIRST_PHASE_END_TICK) / STIPEND_SECOND_INTERVAL_TICKS;
    first + second
}

/// The world extent of the built-in `skirmish` map, and the legacy value every
/// position rule used to be written against.
///
/// It is a *default*, not the world size. Nothing that validates or clamps a
/// position may read it: the extent in force is a property of the map a match
/// froze, and reaches those rules as an argument. Keeping the constant only
/// spares the callers that genuinely mean "the 1600 map" — tests, and
/// `MIN_WORLD_SIZE` below.
pub const WORLD_SIZE: f32 = 1600.0;

/// Side of one navigation cell. The static route check in `maps.rs` and the
/// runtime grid in `navigation.rs` both step at this pitch, so a map whose
/// extent is not a whole number of cells would leave a partial row and column
/// that neither can address.
pub const NAV_CELL_SIZE: f32 = 40.0;

/// Smallest accepted map extent — the size of the built-in map. Anything
/// smaller cannot hold four starts 220 apart with their margins.
pub const MIN_WORLD_SIZE: f32 = WORLD_SIZE;

/// Largest accepted map extent. The static validator's BFS is O(cells) and the
/// runtime grid is rebuilt every tick, so the ceiling is a cost bound rather
/// than a geometric one. Note that 4096 is itself *not* a multiple of
/// `NAV_CELL_SIZE`: the largest extent that satisfies both rules is 4080.
pub const MAX_WORLD_SIZE: f32 = 4096.0;

/// Accepts a map's declared extent, or says why it cannot be simulated.
///
/// Three separate conditions, reported distinctly, because "3200.5 is rejected"
/// and "8000 is rejected" are different authoring mistakes.
pub fn validate_world_size(size: f32) -> Result<f32, String> {
    if !size.is_finite() || size <= 0.0 {
        return Err(format!("Map size must be a positive finite number, got {size}"));
    }
    if !(MIN_WORLD_SIZE..=MAX_WORLD_SIZE).contains(&size) {
        return Err(format!(
            "Map size must be between {MIN_WORLD_SIZE} and {MAX_WORLD_SIZE} units, got {size}"
        ));
    }
    if (size / NAV_CELL_SIZE).fract() != 0.0 {
        return Err(format!(
            "Map size must be a whole multiple of the {NAV_CELL_SIZE}-unit navigation cell, got {size}"
        ));
    }
    Ok(size)
}

pub const MAX_UNITS: usize = 120;
pub const MAX_QUEUE: usize = 8;
pub const MAX_BUILDINGS: usize = 16;

pub fn is_building(kind: &str) -> bool {
    matches!(
        kind,
        "hq" | "barracks" | "factory" | "turret" | "outpost" | "lab" | "sensor" | "relay"
    )
}

/// The faction a building belongs to, or `None` for one every faction may
/// build. The army roster and the general-purpose buildings stay shared; what
/// is faction-gated is the structure that projects that faction's territory.
///
/// This is the building-side twin of [`labour_faction`], and the build
/// validation reads it exactly the way production reads that one.
pub fn building_faction(kind: &str) -> Option<Faction> {
    match kind {
        "sensor" => Some(Faction::Industrial),
        "relay" => Some(Faction::Network),
        _ => None,
    }
}

pub fn is_army(kind: &str) -> bool {
    army_faction(kind).is_some()
}

// ---------------------------------------------------------------------------
// The army: three units per faction, one role each
// ---------------------------------------------------------------------------
//
// Every faction fields a basic fighter and a raider or support unit from its
// barracks, and an anti-structure unit from its factory. The roles line up so
// the command card reads the same for everyone; what differs is how each
// faction fills them. Every number is **experimental**.
//
// * Industrial, the conventional baseline: soldier, scout, siege — unchanged.
// * Network, "strong individual units": fewer and dearer, and every one is
//   half shields, so it regenerates and teleports inside the field.
// * Organic, "large counts": cheap, fast melee in numbers, and every army
//   death on its own creep leaves a temporary unit behind.

/// The faction an army unit belongs to, or `None` for anything that is not
/// army. Nobody can train another faction's army.
pub fn army_faction(kind: &str) -> Option<Faction> {
    match kind {
        "soldier" | "scout" | "siege" => Some(Faction::Industrial),
        "sentinel" | "skimmer" | "lancer" => Some(Faction::Network),
        "swarmer" | "spitter" | "crusher" => Some(Faction::Organic),
        _ => None,
    }
}

/// The faction any trainable unit belongs to: labour or army.
pub fn unit_faction(kind: &str) -> Option<Faction> {
    labour_faction(kind).or_else(|| army_faction(kind))
}

/// Each faction's basic fighter: the unit every slot opens the match with,
/// beside its two labour units.
pub const fn basic_fighter(faction: Faction) -> &'static str {
    match faction {
        Faction::Industrial => "soldier",
        Faction::Network => "sentinel",
        Faction::Organic => "swarmer",
    }
}

/// The building an army kind is trained at: the factory for the three
/// anti-structure units, the barracks for everything else.
pub fn army_building(kind: &str) -> Option<&'static str> {
    match kind {
        "siege" | "lancer" | "crusher" => Some("factory"),
        _ if is_army(kind) => Some("barracks"),
        _ => None,
    }
}

/// A hub: a building cargo can be delivered to, and — for Organic — a building
/// that accumulates harvester stock.
pub fn is_hub(kind: &str) -> bool {
    matches!(kind, "hq" | "outpost")
}

// ---------------------------------------------------------------------------
// Temporary units: what creep spawns when one of its owner's units dies on it
// ---------------------------------------------------------------------------

/// How long a temporary unit of `kind` lives, in ticks, or `None` for every
/// permanent kind. A temporary unit is tiny and weak by design: it costs
/// nothing, takes no supply, is not army, earns no refund, is invisible to
/// `lost`/`killed`/army value, and never spawns anything itself when it dies.
///
/// **Experimental values**, as is every number in this file.
pub fn temporary_lifetime(kind: &str) -> Option<u64> {
    match kind {
        "brood" => Some(200),
        "brute" => Some(300),
        _ => None,
    }
}

/// A unit that expires on its own. See [`temporary_lifetime`].
pub fn is_temporary(kind: &str) -> bool {
    temporary_lifetime(kind).is_some()
}

/// Can take fighting orders — attack, attack-move, hold. The army, plus the
/// temporary units creep spawns, which are controllable but are not army: they
/// cost nothing and must not move an army-value graph.
pub fn fights(kind: &str) -> bool {
    is_army(kind) || is_temporary(kind)
}

/// Total cost of a known kind in both currencies, the figure death spawns are
/// keyed on. Unknown kinds are 0.
fn total_cost(kind: &str) -> u32 {
    stats(kind).map_or(0, |definition| {
        definition.cost.material + definition.cost.catalyst
    })
}

/// Below this total cost a death on creep spawns nothing.
pub const DEATH_SPAWN_BROOD_COST: u32 = 50;
/// At or above this total cost a death on creep spawns a brute, not a brood.
pub const DEATH_SPAWN_BRUTE_COST: u32 = 200;

/// What one of the creep owner's own units spawns when it dies on that owner's
/// creep: `(kind, count)`, or `None` for nothing.
///
/// Keyed on total cost (material + catalyst): under 50 nothing (the free
/// harvester, the drifter), 50 to 199 one `brood`, 200 and up one `brute`.
/// Buildings, research and temporary units never spawn — the last is what
/// makes recursion impossible.
///
/// The reference game also split on ground versus air, a dying flyer leaving
/// small flyers. No air unit exists here, so there is no air branch: when one
/// is added, this is where a flyer's spawn is chosen.
pub fn death_spawn(kind: &str) -> Option<(&'static str, u8)> {
    if is_building(kind) || is_temporary(kind) || kind.starts_with("research_") {
        return None;
    }
    let cost = total_cost(kind);
    if cost >= DEATH_SPAWN_BRUTE_COST {
        Some(("brute", 1))
    } else if cost >= DEATH_SPAWN_BROOD_COST {
        Some(("brood", 1))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Labour: one unit per faction, three gather models
// ---------------------------------------------------------------------------

/// The faction a labour unit belongs to, or `None` for anything that is not
/// labour. Every faction trains exactly its own labour; the army roster is
/// shared for now, so this increment changes the economy and not the roster.
pub fn labour_faction(kind: &str) -> Option<Faction> {
    match kind {
        "worker" => Some(Faction::Industrial),
        "drifter" => Some(Faction::Network),
        "harvester" => Some(Faction::Organic),
        _ => None,
    }
}

/// Anything that can be ordered to work a deposit, whatever model it works it
/// under. This is also exactly the set that can repair. Nothing constructs:
/// buildings are ordered from the command card and raise themselves.
pub fn is_labour(kind: &str) -> bool {
    labour_faction(kind).is_some()
}

/// Carries a load home. True for every labour unit except the `drifter`, which
/// has no return trip at all and so never holds cargo.
pub fn carries_cargo(kind: &str) -> bool {
    matches!(kind, "worker" | "harvester")
}

/// Credits its owner directly while standing at a deposit, instead of filling
/// cargo and walking it to a hub.
pub fn gathers_in_place(kind: &str) -> bool {
    kind == "drifter"
}

/// How much one load is. `logistics` is the `research_logistics` technology,
/// which raises every carrier's load by the same 60% it always has.
pub fn cargo_capacity(kind: &str, logistics: bool) -> u32 {
    match kind {
        // The Organic harvester carries little: it is free, not efficient.
        "harvester" => {
            if logistics {
                16
            } else {
                10
            }
        }
        _ => {
            if logistics {
                40
            } else {
                25
            }
        }
    }
}

/// How much a carrier takes from a deposit per mining pulse, one pulse every
/// `MINING_PULSE_TICKS`.
pub const fn mining_yield(logistics: bool) -> u32 {
    if logistics {
        7
    } else {
        5
    }
}

/// One mining pulse every this many ticks, for carriers.
pub const MINING_PULSE_TICKS: u64 = 10;

/// The Network drifter's direct credit: `(interval, amount)`.
///
/// One material every 5 ticks is 0.20 per tick. A worker on the crossfire
/// mineral line fills 25 in five 10-tick pulses and walks 215 units each way
/// less its two stop ranges, which is about 57 ticks of travel: 25 / 107 =
/// 0.234 per tick. The drifter is therefore about 85% of a worker's rate at a
/// main, and only overtakes one whose haul is longer than about 175 units each
/// way. What it buys is the removal of travel and of the moment a full load is
/// in transit — not a higher rate.
///
/// `research_logistics` raises a worker from 0.234 to about 0.34 per tick (a
/// 60% larger load mined 40% faster); 3 every 10 ticks keeps the drifter at the
/// same relative 0.30.
pub const fn drifter_pulse(logistics: bool) -> (u64, u32) {
    if logistics {
        (10, 3)
    } else {
        (5, 1)
    }
}

/// The two labour units a slot starts a match with, in spawn order.
///
/// A faction that opened with another faction's labour would not be playing its
/// own economy at all, so the bootstrap follows the faction. Industrial's pair
/// of workers is unchanged.
pub const fn starting_labour(faction: Faction) -> [&'static str; 2] {
    let kind = match faction {
        Faction::Industrial => "worker",
        Faction::Network => "drifter",
        Faction::Organic => "harvester",
    };
    [kind, kind]
}

/// Ticks between one Organic hub accruing one point of harvester stock.
pub const HUB_STOCK_INTERVAL_TICKS: u64 = 60;
/// The most stock one Organic hub can hold. Stock is the only thing a harvester
/// costs, so this cap is what stops Organic banking an unbounded free army of
/// labour while it does something else.
pub const HUB_STOCK_CAP: u32 = 7;

/// Can `faction` train `kind` at `building`?
///
/// Faction-aware for labour and army alike: each faction trains exactly its own
/// units and no other's, so an Industrial player cannot train a harvester or a
/// sentinel at any building.
pub fn producer(kind: &str, building: &str, faction: Faction) -> bool {
    if let Some(required) = labour_faction(kind) {
        return faction == required
            && matches!(
                (kind, building),
                ("worker", "hq")
                    | ("drifter", "hq")
                    // Stock is per hub, so every hub that accrues it can spend
                    // it: an Organic expansion multiplies harvester capacity.
                    | ("harvester", "hq" | "outpost")
            );
    }
    // A hub trains labour and nothing else. An army needs the building that
    // makes it: no barracks, no soldiers. That is what gives a barracks a
    // reason to exist and what makes teching a real commitment rather than a
    // convenience, and it is why the opening is an economic decision.
    army_faction(kind) == Some(faction) && army_building(kind) == Some(building)
}

/// The factory units' multiplier against structures.
pub const ANTI_STRUCTURE_MULTIPLIER: i32 = 3;

pub fn attack_damage(kind: &str, target: &str, damage: i32) -> i32 {
    let fast_raider = matches!(target, "scout" | "skimmer");
    if matches!(kind, "siege" | "lancer" | "crusher") && is_building(target) {
        damage * ANTI_STRUCTURE_MULTIPLIER
    } else if kind == "siege" && target == "scout" {
        damage / 2
    } else if kind == "soldier" && fast_raider {
        // The basic fighter counters a raider, its own faction's or not.
        damage * 2
    } else if kind == "skimmer" && is_labour(target) {
        // The Network raider exists to hunt labour.
        damage * 3
    } else {
        damage
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stats {
    pub hp: i32,
    pub speed: f32,
    pub range: f32,
    pub damage: i32,
    pub cooldown: u64,
    pub cost: Cost,
    pub training_ticks: u64,
}

/// Experimental first-pass prices for the dual-currency economy. These are
/// starting points for playtesting, not balanced values. Material funds
/// expansion, workers and the basic army; catalyst gates the factory, the lab,
/// siege units and every technology. Training times and hit points are
/// unchanged from the single-currency skirmish.
pub fn stats(kind: &str) -> Option<Stats> {
    match kind {
        "research_weapons" | "research_armor" | "research_logistics" => Some(Stats {
            hp: 0,
            speed: 0.0,
            range: 0.0,
            damage: 0,
            cooldown: 0,
            cost: Cost::new(100, 50),
            training_ticks: 300,
        }),
        "barracks" | "factory" | "turret" | "outpost" | "lab" | "sensor" | "relay" => {
            let (hp, cost, training_ticks) = match kind {
                "barracks" => (700, Cost::material(150), 160),
                "factory" => (900, Cost::new(200, 50), 240),
                "turret" => (500, Cost::material(125), 140),
                "outpost" => (650, Cost::material(100), 120),
                // Industrial's territory projector. A support structure, not a
                // fortress: it has the least health of any building, it cannot
                // shoot, produce or receive cargo, and the only thing it does
                // is stand somewhere useful. Catalyst-gated at the same 50 as
                // the lab and the factory, because territory is technology.
                "sensor" => (450, Cost::new(125, 50), 140),
                // Network's territory projector, and the pylon of this game:
                // cheap, quick, fragile, and the thing the whole faction's
                // mobility hangs off. Material only, unlike the sensor,
                // because a Network player needs one before anything else.
                "relay" => (300, Cost::material(75), 100),
                _ => (650, Cost::new(150, 50), 200),
            };
            Some(Stats {
                hp,
                speed: 0.0,
                range: if kind == "turret" { 210.0 } else { 0.0 },
                damage: if kind == "turret" { 16 } else { 0 },
                cooldown: 18,
                cost,
                training_ticks,
            })
        }
        "scout" => Some(Stats {
            hp: 80,
            speed: 180.0,
            range: 85.0,
            damage: 10,
            cooldown: 10,
            cost: Cost::material(80),
            training_ticks: 70,
        }),
        "siege" => Some(Stats {
            hp: 220,
            speed: 65.0,
            range: 260.0,
            damage: 32,
            cooldown: 50,
            cost: Cost::new(150, 50),
            training_ticks: 160,
        }),
        "hq" => Some(Stats {
            hp: 1200,
            speed: 0.0,
            range: 0.0,
            damage: 0,
            cooldown: 0,
            cost: Cost::ZERO,
            training_ticks: 0,
        }),
        "worker" => Some(Stats {
            hp: 60,
            speed: 100.0,
            range: 0.0,
            damage: 0,
            cooldown: 0,
            cost: Cost::material(50),
            training_ticks: 60,
        }),
        // Network. Cheaper than a worker and never walks a load home, but it
        // stands at the deposit for the whole match with 40 hit points: the
        // exposure window that a worker only has in transit is permanent.
        "drifter" => Some(Stats {
            hp: 40,
            speed: 100.0,
            range: 0.0,
            damage: 0,
            cooldown: 0,
            cost: Cost::material(40),
            training_ticks: 50,
        }),
        // Organic. Free — it costs one point of hub stock and no currency at
        // all — but carries 10, and cannot fight.
        "harvester" => Some(Stats {
            hp: 45,
            speed: 100.0,
            range: 0.0,
            damage: 0,
            cooldown: 0,
            cost: Cost::ZERO,
            training_ticks: 40,
        }),
        // Network. A sentinel is a soldier and a half: dearer, tougher,
        // harder-hitting, and half of it is shields that come back.
        "sentinel" => Some(Stats {
            hp: 220,
            speed: 100.0,
            range: 115.0,
            damage: 26,
            cooldown: 13,
            cost: Cost::material(150),
            training_ticks: 130,
        }),
        // Network raider: the fastest unit in the game, fragile, and triple
        // damage against labour. Pairs with teleport for hit-and-run.
        "skimmer" => Some(Stats {
            hp: 70,
            speed: 200.0,
            range: 75.0,
            damage: 8,
            cooldown: 8,
            cost: Cost::material(90),
            training_ticks: 70,
        }),
        // Network anti-structure: long range, slow, triple against buildings.
        "lancer" => Some(Stats {
            hp: 240,
            speed: 75.0,
            range: 250.0,
            damage: 36,
            cooldown: 40,
            cost: Cost::new(175, 75),
            training_ticks: 180,
        }),
        // Organic. A swarmer is cheap, fast melee meant to come in numbers.
        // At exactly 50 it is the cheapest unit whose death on creep leaves a
        // brood behind.
        "swarmer" => Some(Stats {
            hp: 60,
            speed: 135.0,
            range: 20.0,
            damage: 7,
            cooldown: 8,
            cost: Cost::material(50),
            training_ticks: 45,
        }),
        // Organic support: out-ranges every fighter, from behind the swarm.
        "spitter" => Some(Stats {
            hp: 85,
            speed: 105.0,
            range: 150.0,
            damage: 15,
            cooldown: 16,
            cost: Cost::material(90),
            training_ticks: 80,
        }),
        // Organic anti-structure: heavy melee, triple against buildings, and
        // at 250 total cost it leaves a brute if it dies on its own creep.
        "crusher" => Some(Stats {
            hp: 420,
            speed: 85.0,
            range: 28.0,
            damage: 30,
            cooldown: 18,
            cost: Cost::new(175, 75),
            training_ticks: 180,
        }),
        "soldier" => Some(Stats {
            hp: 140,
            speed: 110.0,
            range: 105.0,
            damage: 18,
            cooldown: 12,
            cost: Cost::material(100),
            training_ticks: 100,
        }),
        // Temporary units spawned by a death on creep (see `death_spawn`).
        // Never trained, so no training time; free, so `lost`, `killed` and
        // refunds all see zero. Lifetimes are in `temporary_lifetime`.
        "brood" => Some(Stats {
            hp: 30,
            speed: 120.0,
            range: 20.0,
            damage: 6,
            cooldown: 10,
            cost: Cost::ZERO,
            training_ticks: 0,
        }),
        "brute" => Some(Stats {
            hp: 70,
            speed: 90.0,
            range: 30.0,
            damage: 14,
            cooldown: 12,
            cost: Cost::ZERO,
            training_ticks: 0,
        }),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Shields: Network's second health pool
// ---------------------------------------------------------------------------
//
// Every value below is **experimental**; none of it is playtested.

/// The share of a kind's listed health a Network entity carries as shields
/// instead of hit points. The total is unchanged, so what the faction gains is
/// regeneration, not durability. The split varies by kind, as SC2's Protoss
/// does (author's decision, 2026-09-25): every structure and the drifter are
/// half and half (nexus, pylon, cannon, probe), the skimmer too (adept 70/70),
/// while the sentinel and the lancer are a third shields (zealot 100/50,
/// immortal 200/100). A kind not listed here gets half.
pub fn network_shield_percent(kind: &str) -> i32 {
    match kind {
        "sentinel" | "lancer" => 33,
        _ => 50,
    }
}

/// Ticks an entity must go without taking damage before its shields start to
/// come back. Ten seconds, the reference game's figure.
pub const SHIELD_REGEN_DELAY_TICKS: u64 = 200;
/// Shields regenerate in whole points on ticks that are a multiple of this.
pub const SHIELD_REGEN_INTERVAL_TICKS: u64 = 10;
/// Points restored per interval outside a power field: 2 per second.
pub const SHIELD_REGEN_PER_INTERVAL: i32 = 1;

/// `(hit points, shields)` at full health for an entity of `kind` owned by a
/// player of `faction`. Only Network carries shields; every other faction, and
/// every temporary unit, gets the listed health as hit points and no shields.
/// Unknown kinds are `(0, 0)`.
///
/// Stored on the entity when it is spawned (`max_hp`, `max_shields`), so a
/// client, a repair and a construction step all read the one figure the
/// simulation decided rather than re-deriving it from the faction.
pub fn vitals(kind: &str, faction: Faction) -> (i32, i32) {
    let Some(definition) = stats(kind) else {
        return (0, 0);
    };
    if faction != Faction::Network || is_temporary(kind) || kind.starts_with("research_") {
        return (definition.hp, 0);
    }
    let shields = definition.hp * network_shield_percent(kind) / 100;
    (definition.hp - shields, shields)
}

/// Shields gained on one regeneration interval at `percent` of the base rate,
/// where 100 is outside any field. Integer arithmetic, so every machine agrees.
pub const fn shield_regen(percent: i32) -> i32 {
    SHIELD_REGEN_PER_INTERVAL * percent / 100
}

// ---------------------------------------------------------------------------
// Teleport: moving within a power field
// ---------------------------------------------------------------------------

/// Ticks a unit stands still channelling before it moves. Any damage taken
/// during the channel cancels it: the reference game's recall was interrupted
/// by incoming damage, and a teleport that could not be interrupted would be a
/// free escape from every fight fought inside a field.
pub const TELEPORT_CHANNEL_TICKS: u64 = 20;
/// Ticks a unit is inactive after arriving: it cannot move, shoot or gather,
/// but it can be shot. The arrival window is the price of the move, and it is
/// what makes an opponent's defence of the landing point worth something.
pub const TELEPORT_ARRIVAL_TICKS: u64 = 40;
/// Ticks after arriving before the same unit may teleport again: 30 seconds.
/// A cooldown and not a cost, by the author's decision (2026-09-25), so an
/// army cannot hop out of every fight inside its own field. Counted from
/// `arrive_tick`, which is never reset, so it needs no extra state.
pub const TELEPORT_COOLDOWN_TICKS: u64 = 600;

/// Can `kind` teleport at all? Anything mobile. Buildings never move, and a
/// temporary unit belongs to Organic, which projects no power field.
pub fn can_teleport(kind: &str) -> bool {
    !is_building(kind) && stats(kind).is_some_and(|definition| definition.speed > 0.0)
}

/// Can `kind` be trained at *any* finished structure standing in its owner's
/// power field, rather than only at the buildings [`producer`] names? The
/// drifter, and only the drifter: a Network economy expands by projecting
/// infrastructure, not by walking labour across the map.
pub fn trains_in_field(kind: &str) -> bool {
    kind == "drifter"
}

// ---------------------------------------------------------------------------
// Zones: the territory layer
// ---------------------------------------------------------------------------
//
// A zone is **derived state**. It is recomputed from its source every tick, it
// is never authored, never persisted and never edited in place: a source that
// died is simply not in the snapshot the field is rebuilt from, so its zone is
// gone on the same tick. See `docs/honeybadger/ZONES.md`.
//
// The one exception is creep, whose radius grows and recedes and so has to be
// carried between ticks. That carried state is a `CreepPatch`, not the zone:
// the field is still rebuilt every tick, from the units *and* the patches.

/// One of the six concepts [`GAME-DESIGN.md`] requires stay separate. A zone
/// **names the ones it participates in**; there is deliberately no single
/// "blocks" flag, because collapsing these six into one is the documented
/// failure mode of a territory layer.
///
/// Every concept is queried through its own accessor, and a zone that did not
/// name a concept answers "not participating" for it — so a zone added later
/// for one concept cannot silently give an existing zone a second effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ZoneConcept {
    /// Movement passability and cost.
    Movement,
    /// Sight obstruction and detection.
    Sight,
    /// Projectile and weapon obstruction.
    Projectile,
    /// Power, connectivity and ability eligibility.
    Connectivity,
    /// Economy and survival requirements.
    Economy,
    /// Combat and death effects.
    Death,
}

impl ZoneConcept {
    /// The six, in declaration order. Used by tests that must enumerate every
    /// concept and check that a zone participates in exactly the ones it
    /// declared — a list that cannot go stale when a seventh is added.
    pub const ALL: [Self; 6] = [
        Self::Movement,
        Self::Sight,
        Self::Projectile,
        Self::Connectivity,
        Self::Economy,
        Self::Death,
    ];

    /// Position in [`Self::ALL`], used to index per-concept lists without a
    /// map. Declaration order, so it stays in step with `ALL` by construction.
    pub const fn index(self) -> usize {
        self as usize
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Movement => "movement",
            Self::Sight => "sight",
            Self::Projectile => "projectile",
            Self::Connectivity => "connectivity",
            Self::Economy => "economy",
            Self::Death => "death",
        }
    }
}

impl std::fmt::Display for ZoneConcept {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// One participation: the concept, and the value that concept is parameterised
/// by. Adding creep or the power field means adding variants here — a new
/// variant carries a new `concept()`, so it cannot be mistaken for this one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZoneEffect {
    /// Multiplies an affected unit's movement speed by `1 + percent / 100`
    /// while it stands inside. Integer percent, never a float: the multiplier
    /// is derived identically on every machine.
    MovementSpeed { percent: i32 },
    /// Organic harvesters depend on creep: one of the owner's creep-dependent
    /// units (see [`creep_dependent`]) standing on **none** of its owner's
    /// creep moves at `percent / 100` of its speed; on creep it moves at full
    /// speed. Nothing else about it changes — no drain, no death timer — and no
    /// other unit, friendly or enemy, is affected.
    ///
    /// The inverse of `MovementSpeed`: it is the *absence* of the zone that
    /// applies, which is why it is answered by its own query rather than folded
    /// into the strongest-bonus rule.
    OffCreepSlow { percent: i32 },
    /// One of the creep owner's own units dying on that owner's creep spawns
    /// free temporary units, chosen by [`death_spawn`] from the dead unit's
    /// cost.
    DeathSpawn,
    /// Shields of the owner's entities inside regenerate at `percent` of the
    /// base rate. Combat, not movement: it changes how long a unit survives a
    /// fight, never where it can go. Overlap takes the strongest.
    ShieldRegen { percent: i32 },
    /// One of the owner's entities dying inside restores shields to the
    /// owner's other entities within `POWER_RESTORE_RADIUS` of where it fell:
    /// each gets `percent` of the dead entity's total health, hit points plus
    /// shields, capped at its own maximum.
    ShieldRestore { percent: i32 },
    /// Power: connectivity and eligibility. Standing in it is what lets a
    /// structure train a drifter and a unit teleport, and both ends of a
    /// teleport must be in it. Blocks and speeds nothing.
    Powered,
}

impl ZoneEffect {
    /// How many variants there are; the length of `ZoneField`'s per-effect
    /// index.
    pub const SLOTS: usize = 6;

    /// Which of the six this effect is an instance of.
    pub const fn concept(self) -> ZoneConcept {
        match self {
            Self::MovementSpeed { .. } => ZoneConcept::Movement,
            Self::OffCreepSlow { .. } => ZoneConcept::Movement,
            Self::DeathSpawn => ZoneConcept::Death,
            Self::ShieldRegen { .. } => ZoneConcept::Death,
            Self::ShieldRestore { .. } => ZoneConcept::Death,
            Self::Powered => ZoneConcept::Connectivity,
        }
    }

    /// Position in `ZoneField`'s per-effect index. Two effects can share a
    /// concept — the sensor bonus and the off-creep slow are both movement —
    /// and a query for one must not walk the zones of the other.
    pub const fn slot(self) -> usize {
        match self {
            Self::MovementSpeed { .. } => 0,
            Self::OffCreepSlow { .. } => 1,
            Self::DeathSpawn => 2,
            Self::ShieldRegen { .. } => 3,
            Self::ShieldRestore { .. } => 4,
            Self::Powered => 5,
        }
    }
}

/// Units whose speed depends on standing on their owner's creep. Only the
/// Organic harvester, which only an Organic owner can train.
pub fn creep_dependent(kind: &str) -> bool {
    kind == "harvester"
}

/// Who a zone applies to, relative to the zone's owner. Stated explicitly
/// because an aura that also helped the enemy would be a strange thing to
/// build, and a silent default would hide that choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZoneAudience {
    Owner,
    Enemies,
    Everyone,
}

impl ZoneAudience {
    pub const fn includes(self, owner: u8, subject: u8) -> bool {
        match self {
            Self::Owner => owner == subject,
            Self::Enemies => owner != subject,
            Self::Everyone => true,
        }
    }
}

/// How a zone reaches its full radius and how it goes away.
///
/// `Immediate` is all the sensor tower needs: its field is at full radius on
/// the tick the tower completes and gone on the tick the tower dies.
///
/// `Grows` is creep. A growing radius is carried from tick to tick, which
/// derived-from-scratch state cannot do, and it cannot live on the source
/// entity either: a receding zone outlives its source, so on the ticks that
/// matter most there is no entity to hold it. The carried state is therefore a
/// [`CreepPatch`] of its own, kept in the world beside the units and advanced by
/// [`advance_patch`]; the zone field reads the patch's radius instead of
/// `ZoneTemplate::radius`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZoneOnset {
    Immediate,
    /// Starts at `start` world units when the source completes and gains
    /// `per_second` once per second (stepped every `TICKS_PER_SECOND` ticks,
    /// on ticks that are a multiple of it) up to the source's own maximum.
    Grows { start: u16, per_second: u16 },
}

/// How a zone ends. A timed zone (a thrown grenade's field, say) would be a
/// further variant plus an expiry tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZoneLifetime {
    /// Exists while the source exists and is finished; ends the tick it does.
    WhileSourceLives,
    /// Outlives its source: holds its radius for `linger_ticks` after the
    /// source is found missing, then loses `per_second` once a second until it
    /// reaches zero and is removed.
    Recedes { linger_ticks: u64, per_second: u16 },
}

/// The static half of a zone: everything that is a property of the *kind* of
/// source rather than of the particular source projecting it.
///
/// Circles only. Polygons wait until something actually needs one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ZoneTemplate {
    /// For rejection messages and test failure text.
    pub name: &'static str,
    /// Radius in world units around the source's position. For a
    /// `ZoneOnset::Grows` zone this is only the upper bound over every source
    /// kind; the live radius is carried per source (see [`CreepPatch`]).
    pub radius: f32,
    pub applies_to: ZoneAudience,
    /// Which of the six this zone participates in, and with what value.
    /// A `&'static` slice rather than a `Vec`: every template is a constant,
    /// so rebuilding the field every tick allocates nothing.
    pub effects: &'static [ZoneEffect],
    pub onset: ZoneOnset,
    pub lifetime: ZoneLifetime,
}

impl ZoneTemplate {
    pub fn participates_in(&self, concept: ZoneConcept) -> bool {
        self.effects
            .iter()
            .any(|effect| effect.concept() == concept)
    }
}

// --- Industrial: the sensor tower ------------------------------------------

/// **Labelled experimental value.** The author's account of the reference game
/// said "about 30% faster" and was explicit about being unsure whether the real
/// figure is higher. This is a tuning dial, not a fact: change it here and
/// nowhere else.
pub const SENSOR_SPEED_BONUS_PERCENT: i32 = 30;

/// Radius of the sensor tower's movement field, in world units.
///
/// "A long radius" in the design, made concrete. 450 covers a hub *and* its
/// whole mineral line — about 215 units out on the melee maps — with 235 to
/// spare, so one tower at a main speeds the entire home economy and the first
/// stretch of any sortie leaving it. It is 28% of the 1600 skirmish extent but
/// only 14% of the 3200 melee extent, so on a real map it reaches a main and
/// its natural and nowhere near the contested centre: extending the field
/// across the map costs a tower per step, forward, where it can be killed.
///
/// It also sits just inside the 500-unit build radius, so the furthest a chain
/// can advance per tower is less than the field it already had.
pub const SENSOR_ZONE_RADIUS: f32 = 450.0;

static SENSOR_ZONE: ZoneTemplate = ZoneTemplate {
    name: "sensor field",
    radius: SENSOR_ZONE_RADIUS,
    // Owner only. The design did not say, and an aura that also sped the enemy
    // army walking through your base would be a strange thing to pay for, so
    // the ambiguity is resolved here in the open rather than hidden in a query.
    applies_to: ZoneAudience::Owner,
    // Movement cost, and nothing else. Per ZONES.md the Industrial zone blocks
    // nothing and has no death interaction.
    effects: &[ZoneEffect::MovementSpeed {
        percent: SENSOR_SPEED_BONUS_PERCENT,
    }],
    onset: ZoneOnset::Immediate,
    lifetime: ZoneLifetime::WhileSourceLives,
};

/// The zone a *finished* building of `kind` projects, or `None` for one that
/// projects nothing. The caller is responsible for only asking about sources
/// that are complete and alive.
pub fn zone_template(kind: &str) -> Option<&'static ZoneTemplate> {
    match kind {
        "sensor" => Some(&SENSOR_ZONE),
        _ => None,
    }
}

// --- Organic: creep ---------------------------------------------------------
//
// Every value below is **experimental**. None of it is playtested; change it
// here and nowhere else.

/// Radius a new patch starts at on the tick its source is first seen finished.
pub const CREEP_START_RADIUS: u16 = 60;
/// Growth per second while the source lives, applied in one step each second.
pub const CREEP_GROWTH_PER_SECOND: u16 = 10;
/// Ticks a patch holds its radius after its source is found missing.
pub const CREEP_LINGER_TICKS: u64 = 100;
/// Recession per second once the linger is over, applied in one step each
/// second.
pub const CREEP_RECESSION_PER_SECOND: u16 = 20;
/// Full creep radius around an Organic HQ.
pub const CREEP_HQ_RADIUS: u16 = 360;
/// Full creep radius around an Organic outpost.
pub const CREEP_OUTPOST_RADIUS: u16 = 300;
/// Speed, in percent of normal, of an Organic harvester standing on none of
/// its owner's creep. On creep it is 100.
pub const CREEP_OFF_SPEED_PERCENT: i32 = 60;

static CREEP_ZONE: ZoneTemplate = ZoneTemplate {
    name: "creep",
    // Upper bound only: the live radius is the patch's.
    radius: CREEP_HQ_RADIUS as f32,
    // Both effects serve the owner alone: the owner's harvesters are what creep
    // carries at full speed, and only the owner's own units dying on it spawn.
    // An enemy harvester, or an enemy dying on your creep, gets nothing.
    applies_to: ZoneAudience::Owner,
    // Movement (the off-creep slow, harvesters only) and combat/death, and
    // nothing else: per ZONES.md creep blocks no movement, sight or weapons.
    // The movement participation changes no one's passability and no other
    // unit's speed.
    effects: &[
        ZoneEffect::OffCreepSlow {
            percent: CREEP_OFF_SPEED_PERCENT,
        },
        ZoneEffect::DeathSpawn,
    ],
    onset: CREEP_ZONE_ONSET,
    lifetime: CREEP_ZONE_LIFETIME,
};

/// The creep template. Creep is not keyed on a building kind the way the
/// sensor field is — every finished hub of an Organic owner projects it — so
/// it is not returned by [`zone_template`].
pub fn creep_zone() -> &'static ZoneTemplate {
    &CREEP_ZONE
}

/// The speed factor, in percent, the creep template gives a creep-dependent
/// unit off its owner's creep. Read off the template, so the value applied is
/// the value declared; 100 if the template ever stops declaring it.
fn off_creep_percent() -> i32 {
    CREEP_ZONE
        .effects
        .iter()
        .find_map(|effect| match effect {
            ZoneEffect::OffCreepSlow { percent } => Some(*percent),
            _ => None,
        })
        .unwrap_or(100)
}

/// The full radius creep reaches around a finished Organic building of
/// `kind`, or `None` for one that spreads none. **Only hubs make creep**: the
/// HQ and the outpost. Every other building, Organic or not, spreads nothing.
pub fn creep_max_radius(kind: &str) -> Option<u16> {
    match kind {
        "hq" => Some(CREEP_HQ_RADIUS),
        "outpost" => Some(CREEP_OUTPOST_RADIUS),
        _ => None,
    }
}

/// One source's creep: a disc, carried from tick to tick.
///
/// A patch outlives its source — that is what receding means — so it cannot
/// be a field on the source entity. It is kept in `World::creep`, one per
/// source, in source-id order.
///
/// Integer radii, so growth and recession are exact on every machine.
#[cfg_attr(feature = "stdb", derive(spacetimedb::SpacetimeType))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CreepPatch {
    /// Entity id of the building projecting it. Unique for the life of a
    /// match: ids are never reused, so a dead source never comes back.
    pub source: u32,
    pub owner: u8,
    pub x: f32,
    pub y: f32,
    /// Current radius, world units.
    pub radius: u16,
    /// The radius growth stops at, fixed by the source's kind.
    pub max_radius: u16,
    /// The tick the source was first found missing, or **0 while it lives**.
    /// Tick 0 is the bootstrap state and no simulated tick is 0, so the
    /// sentinel can never collide with a real loss.
    pub lost_tick: u64,
}

impl CreepPatch {
    /// A patch for a source that has just been seen finished for the first
    /// time, at the creep template's starting radius (never above `max`).
    pub fn sprouting(source: u32, owner: u8, x: f32, y: f32, max_radius: u16) -> Self {
        Self {
            source,
            owner,
            x,
            y,
            radius: CREEP_RATES.start.min(max_radius),
            max_radius,
            lost_tick: 0,
        }
    }

    /// A patch already at its full radius — the starting HQs at tick 0.
    pub fn grown(source: u32, owner: u8, x: f32, y: f32, max_radius: u16) -> Self {
        Self {
            radius: max_radius,
            ..Self::sprouting(source, owner, x, y, max_radius)
        }
    }

    pub fn is_lost(&self) -> bool {
        self.lost_tick != 0
    }
}

struct CreepRates {
    start: u16,
    growth: u16,
    linger_ticks: u64,
    recession: u16,
}

/// The creep template's growth and recession, unpacked at compile time from
/// the same onset and lifetime the template is built from, so what
/// `advance_patch` does and what the template declares cannot drift apart. A
/// template that stopped growing or receding fails the build, not a match.
const CREEP_RATES: CreepRates = match (CREEP_ZONE_ONSET, CREEP_ZONE_LIFETIME) {
    (
        ZoneOnset::Grows { start, per_second },
        ZoneLifetime::Recedes {
            linger_ticks,
            per_second: recession,
        },
    ) => CreepRates {
        start,
        growth: per_second,
        linger_ticks,
        recession,
    },
    _ => panic!("creep must grow and recede"),
};
// Consts, not fields read off the static: a const cannot read a static.
const CREEP_ZONE_ONSET: ZoneOnset = ZoneOnset::Grows {
    start: CREEP_START_RADIUS,
    per_second: CREEP_GROWTH_PER_SECOND,
};
const CREEP_ZONE_LIFETIME: ZoneLifetime = ZoneLifetime::Recedes {
    linger_ticks: CREEP_LINGER_TICKS,
    per_second: CREEP_RECESSION_PER_SECOND,
};

/// Advances one patch to `tick`. Pure: the same patch, liveness and tick give
/// the same answer on every machine. `None` means the patch has receded to
/// nothing and is removed.
///
/// * **Source alive:** on every tick that is a multiple of
///   `TICKS_PER_SECOND`, gains `CREEP_GROWTH_PER_SECOND`, capped at
///   `max_radius`.
/// * **Source missing:** `lost_tick` is set to `tick` the first time. The
///   radius is held for `CREEP_LINGER_TICKS`; after that it loses
///   `CREEP_RECESSION_PER_SECOND` every `TICKS_PER_SECOND` ticks counted from
///   the end of the linger, and the patch is removed the tick it reaches 0. A
///   patch of radius `r` lost on tick `L` is therefore gone on tick
///   `L + linger + TICKS_PER_SECOND * ceil(r / recession)`.
/// * A lost patch never regrows, even if called with `source_alive`: ids are
///   never reused, so its source cannot come back.
pub fn advance_patch(mut patch: CreepPatch, source_alive: bool, tick: u64) -> Option<CreepPatch> {
    if !patch.is_lost() && !source_alive {
        patch.lost_tick = tick.max(1);
    }
    if !patch.is_lost() {
        if tick % TICKS_PER_SECOND == 0 {
            patch.radius = patch
                .radius
                .saturating_add(CREEP_RATES.growth)
                .min(patch.max_radius);
        }
        return Some(patch);
    }
    let elapsed = tick.saturating_sub(patch.lost_tick);
    if elapsed > CREEP_RATES.linger_ticks
        && (elapsed - CREEP_RATES.linger_ticks) % TICKS_PER_SECOND == 0
    {
        patch.radius = patch.radius.saturating_sub(CREEP_RATES.recession);
    }
    (patch.radius > 0).then_some(patch)
}

// --- Network: the power field ----------------------------------------------
//
// Every value below is **experimental**. None of it is playtested.

/// Radius of a power field around its source, in world units. Covers a hub and
/// its mineral line (about 215 out on the melee maps) with room to spare, and
/// sits well inside the 500-unit build radius so a chain of relays overlaps.
pub const POWER_FIELD_RADIUS: f32 = 320.0;
/// Shield regeneration inside a field, in percent of the base rate: 3x.
pub const POWER_FIELD_REGEN_PERCENT: i32 = 300;
/// Share of a dying entity's total health restored to each nearby friendly.
pub const POWER_RESTORE_PERCENT: i32 = 20;
/// How far from the death point the restoration reaches.
pub const POWER_RESTORE_RADIUS: f32 = 180.0;

static POWER_FIELD: ZoneTemplate = ZoneTemplate {
    name: "power field",
    radius: POWER_FIELD_RADIUS,
    // Owner only, like the other two: an enemy standing in your field gets no
    // regeneration, no restoration and no teleport.
    applies_to: ZoneAudience::Owner,
    // Connectivity (power, for production and teleport) and combat/death
    // (regeneration, restoration), per ZONES.md. It blocks no movement, sight
    // or weapons and changes no one's speed.
    effects: &[
        ZoneEffect::ShieldRegen {
            percent: POWER_FIELD_REGEN_PERCENT,
        },
        ZoneEffect::ShieldRestore {
            percent: POWER_RESTORE_PERCENT,
        },
        ZoneEffect::Powered,
    ],
    onset: ZoneOnset::Immediate,
    lifetime: ZoneLifetime::WhileSourceLives,
};

/// The power field template. Like creep it is keyed on the owner's faction as
/// well as the building, so it is not returned by [`zone_template`].
pub fn power_field() -> &'static ZoneTemplate {
    &POWER_FIELD
}

/// Does a finished `kind` owned by a `faction` player project a power field?
/// The relay, and a Network player's hubs — so a Network base opens powered and
/// an expansion powers itself. Barracks, factories, labs and turrets do not:
/// if every structure projected, "train a drifter at any structure in the
/// field" would mean "at any structure", and the relay would have no job.
pub fn projects_power(kind: &str, faction: Faction) -> bool {
    faction == Faction::Network && matches!(kind, "relay" | "hq" | "outpost")
}

/// One live zone, derived from one source on one tick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Zone {
    /// Entity this zone was derived from. Also the sort key, which is what
    /// keeps a field's order stable and independent of hash iteration.
    pub source: u32,
    pub owner: u8,
    pub x: f32,
    pub y: f32,
    /// Effective radius on this tick. Equal to `template.radius` for every
    /// `ZoneOnset::Immediate` zone; a growing zone's is its patch's radius.
    pub radius: f32,
    pub template: &'static ZoneTemplate,
}

impl Zone {
    pub fn contains(&self, x: f32, y: f32) -> bool {
        distance(self.x, self.y, x, y) <= self.radius
    }

    pub fn applies_to(&self, subject: u8) -> bool {
        self.template.applies_to.includes(self.owner, subject)
    }

    pub fn participates_in(&self, concept: ZoneConcept) -> bool {
        self.template.participates_in(concept)
    }
}

/// How overlapping zones combine, per effect. Stated per effect because the
/// right answer differs: eligibility only needs one source, an economy effect
/// might reasonably add, and a movement bonus must not.
///
/// **Movement speed takes the strongest, and never stacks.** Stacking would let
/// a player carpet a patch of ground with towers and buy unbounded speed for
/// the price of buildings, which is a worse degenerate strategy than any it
/// would counter. Refreshing means nothing for a field that is constant while
/// its source lives. So: strongest wins, and a second tower over the same
/// ground buys area, not velocity.
pub const MOVEMENT_OVERLAP_IS_STRONGEST: bool = true;

/// Every live zone in a world on one tick.
///
/// Derived state with a defined snapshot: built once per tick, before anything
/// moves, from the same start-of-tick entity list every other rule reads. Held
/// in a stable order (by source entity id) so nothing here can depend on hash
/// iteration order, and every combination rule is order-independent anyway.
///
/// Alongside the zones it keeps two indexes of positions into them: per
/// concept, which is what the concept-separation tests read, and per effect,
/// which is what the queries walk. The second exists because two effects share
/// the movement concept — the sensor bonus and creep's off-creep slow — and a
/// soldier's speed must not walk the dozens of creep patches an Organic player
/// spreads. Only a creep-dependent unit's speed visits creep at all.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ZoneField {
    zones: Vec<Zone>,
    by_concept: [Vec<usize>; ZoneConcept::ALL.len()],
    by_effect: [Vec<usize>; ZoneEffect::SLOTS],
}

impl ZoneField {
    /// Collects zones and puts them in a stable order. The caller's order is
    /// not trusted: sorting here means a field is the same field however its
    /// sources were enumerated.
    pub fn from_sources(sources: impl Iterator<Item = Zone>) -> Self {
        let mut zones: Vec<Zone> = sources.collect();
        // Template name breaks a tie, should one source ever project two zones.
        zones.sort_unstable_by_key(|zone| (zone.source, zone.template.name));
        let mut by_concept: [Vec<usize>; ZoneConcept::ALL.len()] = Default::default();
        let mut by_effect: [Vec<usize>; ZoneEffect::SLOTS] = Default::default();
        for (at, zone) in zones.iter().enumerate() {
            for concept in ZoneConcept::ALL {
                if zone.participates_in(concept) {
                    by_concept[concept.index()].push(at);
                }
            }
            for effect in zone.template.effects {
                let list = &mut by_effect[effect.slot()];
                if list.last() != Some(&at) {
                    list.push(at);
                }
            }
        }
        Self {
            zones,
            by_concept,
            by_effect,
        }
    }

    /// How many live zones participate in `concept`.
    pub fn count_in(&self, concept: ZoneConcept) -> usize {
        self.by_concept[concept.index()].len()
    }

    pub fn is_empty(&self) -> bool {
        self.zones.is_empty()
    }

    pub fn len(&self) -> usize {
        self.zones.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Zone> {
        self.zones.iter()
    }

    /// The concepts *some* live zone participates in, sorted and deduplicated.
    /// A field of sensor towers answers exactly `[Movement]`.
    pub fn concepts(&self) -> Vec<ZoneConcept> {
        let mut found: Vec<ZoneConcept> = self
            .zones
            .iter()
            .flat_map(|zone| zone.template.effects.iter().map(|effect| effect.concept()))
            .collect();
        found.sort_unstable();
        found.dedup();
        found
    }

    /// The zones that carry the effect in `slot` (see [`ZoneEffect::slot`]),
    /// apply to `subject` and contain `(x, y)`. Every query goes through this,
    /// so an effect nothing has declared yields nothing rather than
    /// accidentally matching, and a query never visits another effect's zones.
    fn active(&self, slot: usize, subject: u8, x: f32, y: f32) -> impl Iterator<Item = &Zone> {
        self.by_effect[slot]
            .iter()
            .map(move |at| &self.zones[*at])
            .filter(move |zone| zone.applies_to(subject) && zone.contains(x, y))
    }

    /// The factor a unit of `kind` owned by `subject` standing at `(x, y)`
    /// multiplies its base speed by. `1.0` when no movement effect applies.
    ///
    /// Two movement effects, answered separately:
    ///
    /// * **Sensor bonus** — overlap is **strongest**, per
    ///   `MOVEMENT_OVERLAP_IS_STRONGEST`. The maximum is taken over integer
    ///   percents, so the result is bit-identical whatever order the zones
    ///   were visited in.
    /// * **Off-creep slow** — only for a [`creep_dependent`] kind, and only
    ///   when no patch of the subject's own creep covers the point. Every other
    ///   kind returns before creep is looked at, so its cost is paid by
    ///   harvesters alone.
    pub fn movement_multiplier(&self, subject: u8, kind: &str, x: f32, y: f32) -> f32 {
        const SPEED: usize = ZoneEffect::MovementSpeed { percent: 0 }.slot();
        const OFF_CREEP: usize = ZoneEffect::OffCreepSlow { percent: 0 }.slot();
        let mut factor = 1.0;
        if !self.by_effect[SPEED].is_empty() {
            let strongest = self
                .active(SPEED, subject, x, y)
                .flat_map(|zone| zone.template.effects.iter())
                .filter_map(|effect| match effect {
                    ZoneEffect::MovementSpeed { percent } => Some(*percent),
                    // Not this effect. Named rather than `_`, so a new
                    // movement effect cannot fall in here unnoticed.
                    ZoneEffect::OffCreepSlow { .. }
                    | ZoneEffect::DeathSpawn
                    | ZoneEffect::ShieldRegen { .. }
                    | ZoneEffect::ShieldRestore { .. }
                    | ZoneEffect::Powered => None,
                })
                .max()
                .unwrap_or(0);
            factor = 1.0 + strongest as f32 / 100.0;
        }
        if creep_dependent(kind) && self.active(OFF_CREEP, subject, x, y).next().is_none() {
            factor *= off_creep_percent() as f32 / 100.0;
        }
        factor
    }

    /// Does one of `owner`'s units dying at `(x, y)` spawn? True when a patch
    /// of `owner`'s own creep covers the point. Which kind, if any, is
    /// [`death_spawn`]'s answer; this only answers *where*.
    pub fn spawns_on_death(&self, owner: u8, x: f32, y: f32) -> bool {
        const DEATH: usize = ZoneEffect::DeathSpawn.slot();
        self.active(DEATH, owner, x, y).next().is_some()
    }

    /// The shield regeneration rate, in percent of the base rate, for one of
    /// `subject`'s entities at `(x, y)`: 100 outside every field, the strongest
    /// field's figure inside. Strongest, never stacked, for the same reason
    /// movement is: a carpet of relays must buy area, not unbounded regen.
    pub fn shield_regen_percent(&self, subject: u8, x: f32, y: f32) -> i32 {
        const REGEN: usize = ZoneEffect::ShieldRegen { percent: 0 }.slot();
        self.active(REGEN, subject, x, y)
            .flat_map(|zone| zone.template.effects.iter())
            .filter_map(|effect| match effect {
                ZoneEffect::ShieldRegen { percent } => Some(*percent),
                _ => None,
            })
            .max()
            .unwrap_or(100)
            .max(100)
    }

    /// The share of its total health, in percent, that one of `owner`'s
    /// entities dying at `(x, y)` restores to each nearby friendly, or `None`
    /// outside every power field. Strongest wins.
    pub fn restores_on_death(&self, owner: u8, x: f32, y: f32) -> Option<i32> {
        const RESTORE: usize = ZoneEffect::ShieldRestore { percent: 0 }.slot();
        self.active(RESTORE, owner, x, y)
            .flat_map(|zone| zone.template.effects.iter())
            .filter_map(|effect| match effect {
                ZoneEffect::ShieldRestore { percent } => Some(*percent),
                _ => None,
            })
            .max()
    }

    /// Is `(x, y)` inside one of `owner`'s power fields?
    pub fn powered(&self, owner: u8, x: f32, y: f32) -> bool {
        const POWERED: usize = ZoneEffect::Powered.slot();
        self.active(POWERED, owner, x, y).next().is_some()
    }
}

/// Is `(x, y)` a legal destination on a map of extent `world_size`?
///
/// `world_size` is supplied by the caller — it is the frozen extent of the map
/// the match is being played on, not a compile-time constant — so the same rule
/// serves a 1600 and a 3200 map without a second code path.
pub fn validate_position(x: f32, y: f32, world_size: f32) -> Result<(), String> {
    if !world_size.is_finite()
        || !x.is_finite()
        || !y.is_finite()
        || !(16.0..=world_size - 16.0).contains(&x)
        || !(16.0..=world_size - 16.0).contains(&y)
    {
        return Err("Destination is outside the battlefield".into());
    }
    Ok(())
}

pub fn distance(x: f32, y: f32, target_x: f32, target_y: f32) -> f32 {
    (target_x - x).hypot(target_y - y)
}

pub fn advance(
    x: &mut f32,
    y: &mut f32,
    target_x: f32,
    target_y: f32,
    speed: f32,
    stop_range: f32,
) -> bool {
    let remaining = distance(*x, *y, target_x, target_y);
    if remaining <= stop_range + 0.01 {
        return true;
    }
    let step = (speed / TICKS_PER_SECOND as f32).min(remaining - stop_range);
    *x += (target_x - *x) / remaining * step;
    *y += (target_y - *y) / remaining * step;
    remaining - step <= stop_range + 0.01
}

pub fn execution_tick(current_tick: u64, delay: u64) -> Result<u64, String> {
    current_tick
        .checked_add(delay)
        .ok_or_else(|| "Match tick limit reached".into())
}

/// A command delay outside `COMMAND_DELAY_MIN..=COMMAND_DELAY_MAX`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommandDelayError {
    pub requested: u64,
}

impl std::fmt::Display for CommandDelayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Command delay must be {}-{} ticks ({:.1}-{:.1}s at {} ticks per second); {} was requested",
            COMMAND_DELAY_MIN,
            COMMAND_DELAY_MAX,
            COMMAND_DELAY_MIN as f32 / TICKS_PER_SECOND as f32,
            COMMAND_DELAY_MAX as f32 / TICKS_PER_SECOND as f32,
            TICKS_PER_SECOND,
            self.requested
        )
    }
}

impl From<CommandDelayError> for String {
    fn from(error: CommandDelayError) -> Self {
        error.to_string()
    }
}

/// Accepts a command delay inside the ruleset bounds and returns it unchanged.
/// Rejects anything else — the value is never clamped, so a misconfigured match
/// fails to start rather than silently playing under rules nobody chose.
pub fn validate_command_delay(delay: u64) -> Result<u64, CommandDelayError> {
    if (COMMAND_DELAY_MIN..=COMMAND_DELAY_MAX).contains(&delay) {
        Ok(delay)
    } else {
        Err(CommandDelayError { requested: delay })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_nonfinite_and_out_of_bounds_destinations() {
        for (x, y) in [
            (f32::NAN, 100.0),
            (100.0, f32::INFINITY),
            (-1.0, 20.0),
            (WORLD_SIZE, 20.0),
        ] {
            assert!(validate_position(x, y, WORLD_SIZE).is_err());
        }
        assert!(validate_position(16.0, WORLD_SIZE - 16.0, WORLD_SIZE).is_ok());
    }

    /// The bounds follow the map, not the constant: a point legal on a 3200 map
    /// is rejected on a 1600 one, and the same call accepts it once the larger
    /// extent is passed.
    #[test]
    fn destination_bounds_follow_the_maps_extent() {
        assert!(validate_position(2400.0, 2400.0, WORLD_SIZE).is_err());
        assert!(validate_position(2400.0, 2400.0, 3200.0).is_ok());
        assert!(validate_position(3184.0, 3184.0, 3200.0).is_ok());
        assert!(validate_position(3184.1, 3184.0, 3200.0).is_err());
        // A nonsense extent cannot widen the battlefield.
        assert!(validate_position(2400.0, 2400.0, f32::INFINITY).is_err());
        assert!(validate_position(2400.0, 2400.0, f32::NAN).is_err());
    }

    #[test]
    fn world_size_is_a_bounded_multiple_of_the_navigation_cell() {
        for accepted in [1600.0, 1640.0, 2000.0, 3200.0, 4080.0] {
            assert_eq!(validate_world_size(accepted), Ok(accepted));
        }
        // Below the floor, above the ceiling, not a whole cell, not a number.
        for rejected in [
            1560.0,
            0.0,
            -3200.0,
            4120.0,
            3210.0,
            3200.5,
            f32::NAN,
            f32::INFINITY,
        ] {
            assert!(
                validate_world_size(rejected).is_err(),
                "{rejected} should be rejected"
            );
        }
        // 4096 is the inclusive ceiling but is not itself a whole number of
        // 40-unit cells, so it fails the second rule rather than the first.
        assert!(validate_world_size(MAX_WORLD_SIZE)
            .unwrap_err()
            .contains("navigation cell"));
        assert!(validate_world_size(MIN_WORLD_SIZE - NAV_CELL_SIZE)
            .unwrap_err()
            .contains("between"));
    }

    #[test]
    fn only_known_unit_types_have_stats() {
        assert!(stats("catapult").is_none());
        assert!(stats("anything").is_none());
        assert_eq!(stats("worker").unwrap().cost, Cost::material(50));
    }

    #[test]
    fn roster_has_distinct_roles_and_production_requirements() {
        assert!(stats("scout").unwrap().speed > stats("soldier").unwrap().speed);
        assert!(stats("siege").unwrap().range > stats("turret").unwrap().range);
        assert_eq!(attack_damage("siege", "hq", 32), 96);
        assert_eq!(attack_damage("soldier", "scout", 18), 36);
        assert!(producer("siege", "factory", Faction::Industrial));
        assert!(!producer("siege", "hq", Faction::Industrial));
        for kind in ["barracks", "factory", "turret", "outpost", "lab", "sensor"] {
            assert!(is_building(kind));
            assert!(!stats(kind).unwrap().cost.is_free());
        }
    }

    #[test]
    fn movement_never_overshoots_or_moves_inside_stop_range() {
        let (mut x, mut y) = (100.0, 100.0);
        assert!(advance(&mut x, &mut y, 103.0, 104.0, 200.0, 0.0));
        assert_eq!((x, y), (103.0, 104.0));
        assert!(advance(&mut x, &mut y, 103.0, 104.0, 200.0, 30.0));
        assert_eq!((x, y), (103.0, 104.0));
    }

    #[test]
    fn commands_wait_one_full_second() {
        assert_eq!(execution_tick(42, DEFAULT_COMMAND_DELAY), Ok(62));
        assert!(execution_tick(u64::MAX, DEFAULT_COMMAND_DELAY).is_err());
    }

    #[test]
    fn default_command_delay_is_still_exactly_one_second() {
        assert_eq!(DEFAULT_COMMAND_DELAY, 20);
        assert_eq!(DEFAULT_COMMAND_DELAY, TICKS_PER_SECOND);
        assert!((COMMAND_DELAY_MIN..=COMMAND_DELAY_MAX).contains(&DEFAULT_COMMAND_DELAY));
    }

    #[test]
    fn delay_bounds_span_the_half_second_to_second_and_a_half_trial_points() {
        assert_eq!(COMMAND_DELAY_MIN, TICKS_PER_SECOND / 2);
        assert_eq!(COMMAND_DELAY_MAX, TICKS_PER_SECOND * 3 / 2);
    }

    #[test]
    fn delay_validation_accepts_the_bounds_and_rejects_outside_them() {
        for accepted in [COMMAND_DELAY_MIN, DEFAULT_COMMAND_DELAY, COMMAND_DELAY_MAX] {
            assert_eq!(validate_command_delay(accepted), Ok(accepted));
        }
        for rejected in [COMMAND_DELAY_MIN - 1, COMMAND_DELAY_MAX + 1, 0, u64::MAX] {
            assert_eq!(
                validate_command_delay(rejected),
                Err(CommandDelayError {
                    requested: rejected
                })
            );
        }
    }

    #[test]
    fn rejected_delay_reports_the_bounds_and_the_requested_value() {
        let message: String = validate_command_delay(31).unwrap_err().into();
        assert!(message.contains("10-30 ticks"), "{message}");
        assert!(message.contains("0.5-1.5s"), "{message}");
        assert!(message.contains("31 was requested"), "{message}");
    }

    #[test]
    fn out_of_range_delay_is_rejected_and_never_clamped() {
        // A clamping implementation would answer Ok(COMMAND_DELAY_MAX) here.
        assert!(validate_command_delay(COMMAND_DELAY_MAX + 1).is_err());
        assert!(validate_command_delay(COMMAND_DELAY_MIN - 1).is_err());
    }

    #[test]
    fn scheduling_follows_the_rooms_frozen_delay_not_the_constant() {
        // Mirrors the two `Room` columns `issue_order` schedules against:
        // `execution_tick(room.tick, room.command_delay)`.
        struct FrozenRoom {
            tick: u64,
            command_delay: u64,
        }
        let room = FrozenRoom {
            tick: 100,
            command_delay: validate_command_delay(COMMAND_DELAY_MAX).unwrap(),
        };
        assert_ne!(room.command_delay, DEFAULT_COMMAND_DELAY);
        assert_eq!(execution_tick(room.tick, room.command_delay), Ok(130));
        assert_ne!(
            execution_tick(room.tick, room.command_delay),
            execution_tick(room.tick, DEFAULT_COMMAND_DELAY)
        );

        let slow = FrozenRoom {
            tick: 100,
            command_delay: validate_command_delay(COMMAND_DELAY_MIN).unwrap(),
        };
        assert_eq!(execution_tick(slow.tick, slow.command_delay), Ok(110));
    }

    // --- creep -------------------------------------------------------------

    #[test]
    fn creep_participates_in_exactly_movement_and_death() {
        let creep = creep_zone();
        for concept in ZoneConcept::ALL {
            let expected = matches!(concept, ZoneConcept::Movement | ZoneConcept::Death);
            assert_eq!(
                creep.participates_in(concept),
                expected,
                "creep participation in {concept:?}"
            );
        }
        // Creep is not a building kind's zone: it comes from the faction.
        for kind in ["hq", "outpost", "barracks", "turret", "lab", "factory"] {
            assert_eq!(zone_template(kind), None, "{kind} projects no kind-zone");
        }
    }

    #[test]
    fn creep_radius_is_fixed_by_the_source_kind() {
        assert_eq!(creep_max_radius("hq"), Some(360));
        assert_eq!(creep_max_radius("outpost"), Some(300));
        // Only hubs make creep.
        for kind in ["barracks", "factory", "turret", "lab", "sensor"] {
            assert_eq!(creep_max_radius(kind), None, "{kind} spreads no creep");
        }
        for kind in ["worker", "harvester", "soldier", "siege", "brood", "brute"] {
            assert_eq!(creep_max_radius(kind), None, "{kind} is not a source");
        }
    }

    /// Runs `advance_patch` over `ticks`, with the source alive while
    /// `alive(tick)`, and records each tick's radius (`None` once removed).
    fn run_patch(
        patch: CreepPatch,
        ticks: std::ops::RangeInclusive<u64>,
        alive: impl Fn(u64) -> bool,
    ) -> Vec<(u64, Option<u16>)> {
        let mut trace = Vec::new();
        let mut current = Some(patch);
        for tick in ticks {
            current = current.and_then(|live| advance_patch(live, alive(tick), tick));
            trace.push((tick, current.map(|live| live.radius)));
        }
        trace
    }

    fn radius_at(trace: &[(u64, Option<u16>)], tick: u64) -> Option<u16> {
        trace.iter().find(|(at, _)| *at == tick).unwrap().1
    }

    #[test]
    fn a_patch_grows_once_a_second_and_stops_at_its_maximum() {
        // Sprouted on tick 5: steps land on 20, 40, ... and 24 of them take
        // 60 to 300, so the cap is reached on tick 480 and never passed.
        let patch = CreepPatch::sprouting(7, 0, 100.0, 100.0, 300);
        assert_eq!(patch.radius, 60);
        let trace = run_patch(patch, 6..=700, |_| true);
        assert_eq!(radius_at(&trace, 19), Some(60));
        assert_eq!(radius_at(&trace, 20), Some(70));
        assert_eq!(radius_at(&trace, 39), Some(70));
        assert_eq!(radius_at(&trace, 40), Some(80));
        assert_eq!(radius_at(&trace, 479), Some(290));
        assert_eq!(radius_at(&trace, 480), Some(300));
        assert!(trace
            .iter()
            .filter(|(tick, _)| *tick >= 480)
            .all(|(_, radius)| *radius == Some(300)));
    }

    #[test]
    fn a_lost_patch_lingers_then_recedes_and_is_removed() {
        // Full outpost patch, source gone from tick 1000.
        let patch = CreepPatch::grown(7, 0, 100.0, 100.0, 300);
        let trace = run_patch(patch, 990..=1500, |tick| tick < 1000);
        // Holds its full radius through the linger: 1000..=1100.
        for tick in 1000..=1100 {
            assert_eq!(radius_at(&trace, tick), Some(300), "tick {tick}");
        }
        // Then 20 a second, counted from the end of the linger.
        assert_eq!(radius_at(&trace, 1119), Some(300));
        assert_eq!(radius_at(&trace, 1120), Some(280));
        assert_eq!(radius_at(&trace, 1140), Some(260));
        assert_eq!(radius_at(&trace, 1380), Some(20));
        assert_eq!(radius_at(&trace, 1399), Some(20));
        // Gone on L + linger + 20 * ceil(300 / 20) = 1000 + 100 + 300.
        assert_eq!(radius_at(&trace, 1400), None);
        assert!(trace
            .iter()
            .filter(|(tick, _)| *tick >= 1400)
            .all(|(_, radius)| radius.is_none()));
    }

    #[test]
    fn a_lost_patch_records_the_tick_and_never_regrows() {
        let patch = CreepPatch::sprouting(7, 0, 100.0, 100.0, 300);
        let lost = advance_patch(patch, false, 33).unwrap();
        assert_eq!(lost.lost_tick, 33);
        // Told the source is alive again — impossible, ids are not reused —
        // it keeps receding on the original clock rather than growing.
        let later = advance_patch(lost, true, 40).unwrap();
        assert_eq!(later.lost_tick, 33);
        assert_eq!(later.radius, 60);
        // An odd radius still reaches exactly zero and is removed.
        let small = CreepPatch {
            radius: 25,
            lost_tick: 10,
            ..patch
        };
        assert_eq!(advance_patch(small, false, 130).unwrap().radius, 5);
        assert_eq!(advance_patch(CreepPatch { radius: 5, ..small }, false, 150), None);
    }

    #[test]
    fn a_creep_field_slows_only_its_owners_harvesters_off_it() {
        let creep = CreepPatch::grown(3, 0, 500.0, 500.0, 360);
        let field = ZoneField::from_sources(std::iter::once(Zone {
            source: creep.source,
            owner: creep.owner,
            x: creep.x,
            y: creep.y,
            radius: creep.radius as f32,
            template: creep_zone(),
        }));
        assert_eq!(field.len(), 1);
        assert_eq!(field.count_in(ZoneConcept::Movement), 1);
        assert_eq!(field.count_in(ZoneConcept::Sight), 0);
        assert_eq!(field.count_in(ZoneConcept::Projectile), 0);
        assert_eq!(field.count_in(ZoneConcept::Connectivity), 0);
        assert_eq!(field.count_in(ZoneConcept::Economy), 0);
        assert_eq!(field.count_in(ZoneConcept::Death), 1);
        assert_eq!(
            field.concepts(),
            vec![ZoneConcept::Movement, ZoneConcept::Death]
        );
        // The owner's harvester: full speed on its creep, 0.6 off it.
        assert_eq!(field.movement_multiplier(0, "harvester", 500.0, 500.0), 1.0);
        assert_eq!(field.movement_multiplier(0, "harvester", 1000.0, 1000.0), 0.6);
        // Another slot's harvester is on none of *its* owner's creep.
        assert_eq!(field.movement_multiplier(1, "harvester", 500.0, 500.0), 0.6);
        // Nothing else is touched, on creep or off it, friend or enemy.
        for kind in ["soldier", "scout", "siege", "worker", "drifter", "brood", "brute"] {
            for owner in [0, 1] {
                for (x, y) in [(500.0, 500.0), (1000.0, 1000.0)] {
                    assert_eq!(field.movement_multiplier(owner, kind, x, y), 1.0, "{kind}");
                }
            }
        }
        // Death spawns: the owner's creep, for the owner.
        assert!(field.spawns_on_death(0, 500.0, 500.0));
        assert!(!field.spawns_on_death(0, 1000.0, 1000.0));
        assert!(!field.spawns_on_death(1, 500.0, 500.0));
    }

    #[test]
    fn with_no_creep_at_all_a_harvester_is_off_creep() {
        let field = ZoneField::default();
        assert_eq!(field.movement_multiplier(0, "harvester", 10.0, 10.0), 0.6);
        assert_eq!(field.movement_multiplier(0, "soldier", 10.0, 10.0), 1.0);
    }

    #[test]
    fn death_spawns_follow_total_cost_for_every_kind_with_stats() {
        let every_kind = [
            "hq", "barracks", "factory", "turret", "outpost", "lab", "sensor",
            "research_weapons", "research_armor", "research_logistics",
            "worker", "drifter", "harvester", "soldier", "scout", "siege",
            "brood", "brute",
        ];
        for kind in every_kind {
            assert!(stats(kind).is_some(), "{kind} has stats");
            let expected = match kind {
                // 50 material.
                "worker" => Some(("brood", 1)),
                // 100 and 80.
                "soldier" | "scout" => Some(("brood", 1)),
                // 150 + 50 catalyst = 200.
                "siege" => Some(("brute", 1)),
                // Drifter 40 and harvester 0 are under 50; buildings, research
                // and the temporary kinds never spawn.
                _ => None,
            };
            assert_eq!(death_spawn(kind), expected, "{kind}");
        }
        assert_eq!(death_spawn("catapult"), None);
    }

    #[test]
    fn temporary_units_are_free_weak_expiring_and_not_army() {
        for (kind, hp, lifetime) in [("brood", 30, 200), ("brute", 70, 300)] {
            let definition = stats(kind).unwrap();
            assert_eq!(definition.hp, hp);
            assert!(definition.cost.is_free());
            assert_eq!(temporary_lifetime(kind), Some(lifetime));
            assert!(is_temporary(kind));
            assert!(fights(kind));
            assert!(!is_army(kind));
            assert!(!is_building(kind));
            assert!(!is_labour(kind));
            assert_eq!(death_refund(kind), Cost::ZERO);
            assert_eq!(death_spawn(kind), None);
        }
        for kind in ["soldier", "scout", "siege", "harvester", "worker", "hq"] {
            assert!(!is_temporary(kind), "{kind}");
        }
    }

    #[test]
    fn ruleset_version_is_recorded_and_positive() {
        // Bumped to 4 by the zone layer: a new building and a movement speed
        // that is no longer a pure function of the unit's kind. Bumped to 5 by
        // Organic creep: a zone whose radius is carried from tick to tick.
        // Bumped to 6 by creep's effects: harvesters slowed off creep, and
        // temporary units spawned by deaths on it. Bumped to 7 by Network
        // shields and the power field: health split into two pools, and
        // teleport and field-gated production. Bumped to 8 by the faction
        // armies: the roster is no longer shared. Bumped to 9 by command-card
        // construction (no builder, no cancel), shield shares by kind, and the
        // teleport cooldown.
        assert_eq!(RULESET_VERSION, 9);
        assert!(RULESET_VERSION > 0);
    }

    #[test]
    fn experimental_price_list_is_exactly_the_documented_table() {
        for (kind, material, catalyst) in [
            ("worker", 50, 0),
            ("soldier", 100, 0),
            ("scout", 80, 0),
            ("siege", 150, 50),
            ("barracks", 150, 0),
            ("turret", 125, 0),
            ("outpost", 100, 0),
            ("factory", 200, 50),
            ("lab", 150, 50),
            ("sensor", 125, 50),
            ("research_weapons", 100, 50),
            ("research_armor", 100, 50),
            ("research_logistics", 100, 50),
        ] {
            assert_eq!(
                stats(kind).unwrap().cost,
                Cost::new(material, catalyst),
                "{kind}"
            );
        }
        // The HQ is bootstrapped, never bought.
        assert_eq!(stats("hq").unwrap().cost, Cost::ZERO);
    }

    #[test]
    fn catalyst_gates_technology_and_specialists_only() {
        for basic in ["worker", "soldier", "scout", "barracks", "turret", "outpost"] {
            assert_eq!(stats(basic).unwrap().cost.catalyst, 0, "{basic}");
        }
        for advanced in [
            "siege",
            "factory",
            "lab",
            "sensor",
            "research_weapons",
            "research_armor",
            "research_logistics",
        ] {
            assert!(stats(advanced).unwrap().cost.catalyst > 0, "{advanced}");
            assert!(stats(advanced).unwrap().cost.material > 0, "{advanced}");
        }
    }

    #[test]
    fn hit_points_and_training_times_survived_the_currency_split() {
        for (kind, hp, training_ticks) in [
            ("worker", 60, 60),
            ("soldier", 140, 100),
            ("scout", 80, 70),
            ("siege", 220, 160),
            ("hq", 1200, 0),
            ("barracks", 700, 160),
            ("factory", 900, 240),
            ("turret", 500, 140),
            ("outpost", 650, 120),
            ("lab", 650, 200),
            ("sensor", 450, 140),
            ("research_weapons", 0, 300),
        ] {
            let definition = stats(kind).unwrap();
            assert_eq!((definition.hp, definition.training_ticks), (hp, training_ticks), "{kind}");
        }
    }

    #[test]
    fn a_price_is_paid_in_full_or_not_at_all() {
        let price = Cost::new(150, 50);
        let mut rich = Balance::new(150, 50);
        assert!(rich.covers(price));
        assert!(rich.pay(price));
        assert_eq!(rich, Balance::new(0, 0));

        // Material alone is enough, catalyst is one short: nothing moves.
        let mut lopsided = Balance::new(10_000, 49);
        assert!(!lopsided.covers(price));
        assert!(!lopsided.pay(price));
        assert_eq!(lopsided, Balance::new(10_000, 49));
        assert_eq!(lopsided.shortfall(price), Some(ResourceKind::Catalyst));

        // Catalyst alone is enough, material is one short: nothing moves.
        let mut starved = Balance::new(149, 10_000);
        assert!(!starved.pay(price));
        assert_eq!(starved, Balance::new(149, 10_000));
        assert_eq!(starved.shortfall(price), Some(ResourceKind::Material));
        assert_eq!(Balance::new(150, 50).shortfall(price), None);
    }

    #[test]
    fn currencies_never_substitute_for_one_another() {
        let mut balance = Balance::new(0, 500);
        assert!(!balance.pay(Cost::material(1)));
        balance.credit_kind(ResourceKind::Material, 1);
        assert_eq!(balance, Balance::new(1, 500));
        assert!(balance.pay(Cost::material(1)));
        assert_eq!(balance, Balance::new(0, 500));
    }

    #[test]
    fn army_deaths_refund_half_of_both_currencies_and_nothing_else_does() {
        assert_eq!(death_refund("siege"), Cost::new(75, 25));
        assert_eq!(death_refund("soldier"), Cost::material(50));
        assert_eq!(death_refund("scout"), Cost::material(40));
        for ineligible in [
            "worker", "hq", "barracks", "factory", "turret", "outpost", "lab", "sensor",
        ] {
            assert_eq!(death_refund(ineligible), Cost::ZERO, "{ineligible}");
        }
        assert_eq!(death_refund("catapult"), Cost::ZERO);
        assert_eq!(ARMY_DEATH_REFUND_PERCENT, 50);
    }

    #[test]
    fn refund_shares_round_down_per_currency() {
        assert_eq!(Cost::new(101, 51).percent(50), Cost::new(50, 25));
        assert_eq!(Cost::new(1, 1).percent(50), Cost::ZERO);
        assert_eq!(Cost::new(150, 50).percent(75), Cost::new(112, 37));
        assert_eq!(Cost::new(u32::MAX, u32::MAX).percent(50), Cost::new(u32::MAX / 2, u32::MAX / 2));
    }

    #[test]
    fn stipend_pays_the_documented_totals_at_both_boundaries_and_then_stops() {
        assert_eq!(STIPEND_FIRST_PHASE_END_TICK, 1800);
        assert_eq!(STIPEND_SECOND_PHASE_END_TICK, 3600);
        assert_eq!(STIPEND_FIRST_INTERVAL_TICKS, 6);
        assert_eq!(STIPEND_SECOND_INTERVAL_TICKS, 12);

        let mut paid = 0u64;
        let mut at_ninety = 0u64;
        let mut at_one_eighty = 0u64;
        for tick in 1..=4200 {
            paid += stipend_payment(tick) as u64;
            if tick == STIPEND_FIRST_PHASE_END_TICK {
                at_ninety = paid;
            }
            if tick == STIPEND_SECOND_PHASE_END_TICK {
                at_one_eighty = paid;
            }
            assert_eq!(paid, stipend_total(tick), "tick {tick}");
        }
        // 200/minute for 1.5 minutes, then 100/minute for 1.5 minutes.
        assert_eq!(at_ninety, 300);
        assert_eq!(at_one_eighty, 450);
        assert_eq!(paid, 450, "nothing is paid after the second phase");
        assert_eq!(stipend_payment(0), 0);
        assert_eq!(stipend_payment(STIPEND_FIRST_INTERVAL_TICKS), 1);
        assert_eq!(stipend_payment(STIPEND_FIRST_INTERVAL_TICKS - 1), 0);
        assert_eq!(stipend_payment(STIPEND_FIRST_PHASE_END_TICK), 1);
        // 1806 is divisible by 6 but not by 12: the rate really halves.
        assert_eq!(stipend_payment(1806), 0);
        assert_eq!(stipend_payment(1812), 1);
        assert_eq!(stipend_payment(STIPEND_SECOND_PHASE_END_TICK), 1);
        assert_eq!(stipend_payment(STIPEND_SECOND_PHASE_END_TICK + 12), 0);
        assert_eq!(stipend_total(u64::MAX), 450);
    }

    #[test]
    fn stipend_rates_are_derived_from_the_named_constants() {
        assert_eq!(
            STIPEND_FIRST_INTERVAL_TICKS * STIPEND_FIRST_RATE_PER_MINUTE as u64,
            TICKS_PER_MINUTE
        );
        assert_eq!(
            STIPEND_SECOND_INTERVAL_TICKS * STIPEND_SECOND_RATE_PER_MINUTE as u64,
            TICKS_PER_MINUTE
        );
        assert_eq!(
            stipend_total(STIPEND_FIRST_PHASE_END_TICK) * 60,
            STIPEND_FIRST_RATE_PER_MINUTE as u64 * STIPEND_FIRST_PHASE_SECONDS
        );
    }

    #[test]
    fn starting_balance_is_material_only() {
        assert_eq!(STARTING_BALANCE, Balance::new(250, 0));
        assert!(!STARTING_BALANCE.covers(Cost::new(0, 1)));
    }

    // --- factions and asymmetric labour ------------------------------------

    /// Slot assignment is a pure function of the slot: the same room always
    /// produces the same spread whatever order people joined in, and a full
    /// four-player room holds all three economies.
    #[test]
    fn factions_rotate_by_slot_deterministically_and_spread_over_four_players() {
        assert_eq!(faction_for_slot(0), Faction::Industrial);
        assert_eq!(faction_for_slot(1), Faction::Network);
        assert_eq!(faction_for_slot(2), Faction::Organic);
        assert_eq!(faction_for_slot(3), Faction::Industrial);
        let spread: Vec<Faction> = (0..4).map(faction_for_slot).collect();
        for faction in FACTION_ROTATION {
            assert!(spread.contains(&faction), "{faction} is missing from a full room");
        }
        // Deterministic, and total for every slot a u8 can hold.
        for slot in 0..=u8::MAX {
            assert_eq!(faction_for_slot(slot), faction_for_slot(slot));
            assert_eq!(faction_for_slot(slot), FACTION_ROTATION[slot as usize % 3]);
        }
        // The baseline is what anything unlabelled falls back to.
        assert_eq!(Faction::default(), Faction::Industrial);
    }

    #[test]
    fn each_faction_trains_only_its_own_labour_unit() {
        let expected = [
            (Faction::Industrial, "worker"),
            (Faction::Network, "drifter"),
            (Faction::Organic, "harvester"),
        ];
        for (faction, kind) in expected {
            assert!(producer(kind, "hq", faction), "{faction} cannot train {kind}");
            for other in FACTION_ROTATION {
                if other != faction {
                    assert!(
                        !producer(kind, "hq", other),
                        "{other} must not be able to train {kind}"
                    );
                    assert!(!producer(kind, "outpost", other));
                    assert!(!producer(kind, "barracks", other));
                }
            }
        }
        // The named case: no Industrial player may ever produce a harvester.
        for building in ["hq", "outpost", "barracks", "factory", "lab", "turret"] {
            assert!(!producer("harvester", building, Faction::Industrial));
            assert!(!producer("harvester", building, Faction::Network));
        }
        // Stock is per hub and so is spending it.
        assert!(producer("harvester", "outpost", Faction::Organic));
        assert!(!producer("worker", "outpost", Faction::Industrial));
        // There is no Organic builder unit: labour is the harvester alone.
        assert!(labour_faction("drone").is_none());
        assert!(stats("drone").is_none());
    }

    #[test]
    fn each_faction_trains_its_own_army_and_nobody_elses() {
        let rosters = [
            (Faction::Industrial, ["soldier", "scout", "siege"]),
            (Faction::Network, ["sentinel", "skimmer", "lancer"]),
            (Faction::Organic, ["swarmer", "spitter", "crusher"]),
        ];
        for (faction, [fighter, raider, heavy]) in rosters {
            assert_eq!(basic_fighter(faction), fighter);
            assert!(producer(fighter, "barracks", faction), "{fighter}");
            assert!(producer(raider, "barracks", faction), "{raider}");
            assert!(producer(heavy, "factory", faction), "{heavy}");
            assert!(!producer(heavy, "barracks", faction), "{heavy}");
            for kind in [fighter, raider, heavy] {
                assert!(is_army(kind), "{kind}");
                assert_eq!(army_faction(kind), Some(faction));
                // A hub trains labour and nothing else.
                assert!(!producer(kind, "hq", faction), "{kind}");
                // Nobody trains another faction's army.
                for other in FACTION_ROTATION {
                    if other != faction {
                        assert!(!producer(kind, army_building(kind).unwrap(), other));
                    }
                }
            }
            assert!(stats(heavy).unwrap().cost.catalyst > 0, "{heavy} is catalyst-gated");
            assert_eq!(attack_damage(heavy, "barracks", 10), 30, "{heavy} vs structures");
        }
    }

    #[test]
    fn the_three_armies_lean_the_way_their_factions_do() {
        let [sentinel, soldier, swarmer] = ["sentinel", "soldier", "swarmer"].map(|kind| stats(kind).unwrap());
        // Network: fewer, stronger. Organic: cheaper, faster, weaker.
        assert!(sentinel.cost.material > soldier.cost.material && sentinel.hp > soldier.hp);
        assert!(swarmer.cost.material < soldier.cost.material && swarmer.speed > soldier.speed);
        assert!(swarmer.hp < soldier.hp);
        // The raiders: the skimmer is the fastest thing on the map and hunts labour.
        let fastest = ["soldier", "scout", "siege", "sentinel", "lancer", "swarmer", "spitter", "crusher"]
            .map(|kind| stats(kind).unwrap().speed)
            .into_iter()
            .fold(0.0, f32::max);
        assert!(stats("skimmer").unwrap().speed > fastest);
        assert_eq!(attack_damage("skimmer", "drifter", 8), 24);
        assert_eq!(attack_damage("skimmer", "soldier", 8), 8);
        assert_eq!(attack_damage("soldier", "skimmer", 18), 36, "a fighter counters a raider");
        // Death on creep: a swarmer leaves a brood, a crusher a brute.
        assert_eq!(death_spawn("swarmer"), Some(("brood", 1)));
        assert_eq!(death_spawn("crusher"), Some(("brute", 1)));
        // Every army unit refunds half, the new ones included.
        assert_eq!(death_refund("lancer"), Cost::new(87, 37));
    }

    #[test]
    fn the_three_labour_units_are_priced_and_bodied_as_decided() {
        // 50 material and 60 hit points: the Industrial baseline, untouched.
        assert_eq!(stats("worker").unwrap().cost, Cost::material(50));
        assert_eq!(stats("worker").unwrap().hp, 60);
        // Cheaper, and markedly more fragile parked in the open.
        assert_eq!(stats("drifter").unwrap().cost, Cost::material(40));
        assert_eq!(stats("drifter").unwrap().hp, 40);
        // Free: it costs stock, and stock is not a currency.
        assert_eq!(stats("harvester").unwrap().cost, Cost::ZERO);
        assert!(stats("harvester").unwrap().cost.is_free());
        assert_eq!(stats("harvester").unwrap().hp, 45);
        for kind in ["worker", "drifter", "harvester"] {
            assert_eq!(stats(kind).unwrap().cost.catalyst, 0, "{kind}");
            assert_eq!(stats(kind).unwrap().damage, 0, "{kind} must not be armed");
            assert!(!is_army(kind), "{kind}");
            assert!(is_labour(kind), "{kind}");
            // Labour is never refunded on death, as before.
            assert_eq!(death_refund(kind), Cost::ZERO, "{kind}");
        }
    }

    #[test]
    fn only_the_drifter_carries_nothing_and_the_harvester_carries_least() {
        for carrier in ["worker", "harvester"] {
            assert!(carries_cargo(carrier), "{carrier}");
            assert!(!gathers_in_place(carrier), "{carrier}");
        }
        assert!(!carries_cargo("drifter"));
        assert!(gathers_in_place("drifter"));
        assert_eq!(cargo_capacity("harvester", false), 10);
        assert_eq!(cargo_capacity("harvester", true), 16);
        assert_eq!(cargo_capacity("worker", false), 25);
        assert_eq!(cargo_capacity("worker", true), 40);
        // Construction is driven by a labour unit for every faction alike.
        for kind in ["worker", "drifter", "harvester"] {
            assert!(is_labour(kind), "{kind}");
        }
        for kind in ["soldier", "scout", "siege", "hq", "barracks"] {
            assert!(!is_labour(kind), "{kind}");
        }
    }

    /// The Network pulse is tuned against a worker's whole round trip, not
    /// against its rate at the face of a deposit. The arithmetic is the
    /// crossfire main: a 215-unit haul, less the 28-unit gather stop range and
    /// the 45-unit hub stop range, at 100 units per second.
    #[test]
    fn the_drifter_pulse_is_comparable_to_a_round_trip_and_not_better() {
        let per_ten_thousand = |amount: u32, ticks: u64| amount as u64 * 10_000 / ticks;
        let worker_cycle = |haul: f32, logistics: bool| -> u64 {
            let capacity = cargo_capacity("worker", logistics);
            let pulses = capacity.div_ceil(mining_yield(logistics)) as u64;
            let travel = ((haul - 28.0 - 45.0) / (stats("worker").unwrap().speed / 20.0)).ceil();
            pulses * MINING_PULSE_TICKS + 2 * travel as u64
        };

        for logistics in [false, true] {
            let (interval, amount) = drifter_pulse(logistics);
            let drifter = per_ten_thousand(amount, interval);
            let capacity = cargo_capacity("worker", logistics);
            let main = per_ten_thousand(capacity, worker_cycle(215.0, logistics));
            // Comparable at a main, and strictly below it.
            assert!(drifter < main, "{drifter} vs {main} at a main");
            assert!(drifter * 100 > main * 80, "{drifter} vs {main} at a main");
            // A worker still out-earns a drifter even at the closest deposit a
            // hub can have, so there is no distance at which Network's model is
            // simply the better one.
            assert!(drifter < per_ten_thousand(capacity, worker_cycle(120.0, logistics)));
            // Past roughly 175 units each way the drifter pulls ahead — that is
            // the advantage, and it is bought with travel it does not do.
            assert!(drifter > per_ten_thousand(capacity, worker_cycle(400.0, logistics)));
        }
        // 1 every 5 ticks: 0.20 per tick against a worker's 0.234 at a main.
        assert_eq!(drifter_pulse(false), (5, 1));
        assert_eq!(drifter_pulse(true), (10, 3));
    }

    #[test]
    fn organic_hub_stock_is_the_decided_rate_and_cap() {
        assert_eq!(HUB_STOCK_INTERVAL_TICKS, 60);
        assert_eq!(HUB_STOCK_CAP, 7);
        // Three seconds a point at 20 ticks per second.
        assert_eq!(HUB_STOCK_INTERVAL_TICKS, TICKS_PER_SECOND * 3);
        assert!(is_hub("hq"));
        assert!(is_hub("outpost"));
        for not_a_hub in ["barracks", "factory", "lab", "turret", "sensor", "worker"] {
            assert!(!is_hub(not_a_hub), "{not_a_hub}");
        }
    }
}
