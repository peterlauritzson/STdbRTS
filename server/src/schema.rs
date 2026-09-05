use rts_core::simulation::{Entity, Node, Order};
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
    pub command_delay: u64,
    pub next_entity_id: u32,
    pub winner: i16,
    pub last_activity_micros: i64,
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
    pub resources: u32,
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

#[spacetimedb::table(accessor = tick_schedule, scheduled(crate::game::game_tick))]
pub struct TickSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}
