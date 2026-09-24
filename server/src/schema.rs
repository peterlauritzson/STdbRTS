use rts_core::simulation::{Entity, Node, Order};
use rts_core::CreepPatch;
use rts_core::Faction;
use spacetimedb::{ConnectionId, Identity, ScheduleAt};

#[spacetimedb::table(public, accessor = room)]
#[derive(Clone)]
pub struct Room {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub name: String,
    pub host: Identity,
    pub capacity: u8,
    pub state: String,
    pub tick: u64,
    // Frozen at creation in `lobby::create_room` and never mutated afterwards:
    // the delay and the identity of the rules and map this match is played
    // under. Resolving any of these at read time would let an edited ruleset or
    // map change the rules underneath a running match.
    pub command_delay: u64,
    pub ruleset_version: u32,
    pub map_id: String,
    pub map_version: u32,
    pub map_hash: u64,
    pub next_entity_id: u32,
    pub winner: i16,
    pub last_activity_micros: i64,
    /// Wall-clock time the match has already been simulated up to. The tick
    /// loop advances by the whole ticks elapsed since this, so scheduler jitter
    /// changes how often ticks are delivered, never how fast the match runs.
    pub last_tick_micros: i64,
}

#[spacetimedb::table(public, accessor = player)]
#[derive(Clone)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    #[index(btree)]
    pub match_id: u64,
    pub name: String,
    pub slot: u8,
    // The two spendable currencies. Replaces the single `resources` column:
    // material funds expansion and the basic army, catalyst funds technology
    // and specialists, and neither converts into the other.
    pub material: u32,
    pub catalyst: u32,
    // --- match history, cumulative for the life of the match ---------------
    //
    // These ride beside the balances and round-trip through `load_world` /
    // `save_world` exactly as the balances do, so the simulation is the single
    // author of all of them and no reducer has to remember to keep a running
    // total by hand.
    /// Everything this player has mined, ever: deliveries and drifter pulses
    /// only. The opening stipend and every refund are excluded on purpose — see
    /// `World::collected`.
    pub collected_material: u32,
    pub collected_catalyst: u32,
    /// List price of this player's own entities that were destroyed.
    pub lost_material: u32,
    pub lost_catalyst: u32,
    /// List price of other players' entities this player destroyed.
    pub killed_material: u32,
    pub killed_catalyst: u32,
    /// Which economy this player is playing. Assigned from the slot when the
    /// room is created or joined, so a four-player room holds all three, and
    /// carried into the simulation at `start_match`. There is no lobby control
    /// for it yet; that is the client increment.
    pub faction: Faction,
    pub ready: bool,
    pub online: bool,
    pub last_order_tick: u64,
    pub orders_this_tick: u32,
}

#[spacetimedb::table(accessor = connection)]
pub struct Connection {
    #[primary_key]
    pub id: ConnectionId,
    #[index(btree)]
    pub identity: Identity,
}

#[spacetimedb::table(public, accessor = unit)]
pub struct Unit {
    #[primary_key]
    pub id: u64,
    #[index(btree)]
    pub match_id: u64,
    pub data: Entity,
}

#[spacetimedb::table(public, accessor = resource_node)]
pub struct ResourceNode {
    #[primary_key]
    pub id: u64,
    #[index(btree)]
    pub match_id: u64,
    pub data: Node,
}

/// One Organic creep patch, keyed like `unit`: `(match_id << 32) | source`.
///
/// A patch outlives its source entity while it recedes, so it cannot ride on
/// the `unit` row and gets its own table. `data` round-trips `World::creep`
/// through `game::load_world` / `game::save_world`, which diff it so a patch
/// whose radius did not move this tick costs no row write. Dropped with the
/// match in `game::delete_room`.
#[spacetimedb::table(public, accessor = creep_patch)]
pub struct CreepPatchRow {
    #[primary_key]
    pub id: u64,
    #[index(btree)]
    pub match_id: u64,
    pub data: CreepPatch,
}

#[spacetimedb::table(public, accessor = command)]
pub struct Command {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub match_id: u64,
    pub issuer: Identity,
    pub request_id: String,
    pub owner: u8,
    pub units: Vec<u32>,
    pub order: Order,
    pub queued: bool,
    pub issued_tick: u64,
    pub execute_tick: u64,
    pub status: String,
    pub reason: String,
}

/// One point on one player's graphs: the whole of what a post-game score screen
/// plots, frozen at a tick. Written on the sampling cadence in
/// `game::record_sample` and once more the instant a match finishes.
///
/// It is a time series, not a projection of `Player`: the current row is only
/// ever the last point, and re-deriving an earlier point is impossible once the
/// match has moved on. Indexed by `match_id` like `unit` and `command`, and
/// dropped with the match in `game::delete_room`.
#[spacetimedb::table(public, accessor = match_sample)]
pub struct MatchSample {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub match_id: u64,
    /// The simulation tick this row describes, not the wall clock. A sample is
    /// written when the world first reaches this tick and never rewritten, so
    /// `(match_id, slot, tick)` is unique without being declared so.
    pub tick: u64,
    pub slot: u8,
    /// Banked: spendable right now.
    pub material: u32,
    pub catalyst: u32,
    /// Cumulative mined, stipend and refunds excluded.
    pub collected_material: u32,
    pub collected_catalyst: u32,
    /// List price of the living army — labour and buildings excluded.
    pub army_value_material: u32,
    pub army_value_catalyst: u32,
    /// Living head counts, by role.
    pub labour: u32,
    pub army: u32,
    pub buildings: u32,
    /// Cumulative list price of this player's entities destroyed.
    pub lost_material: u32,
    pub lost_catalyst: u32,
}

#[spacetimedb::table(accessor = tick_schedule, scheduled(crate::game::game_tick))]
pub struct TickSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}
