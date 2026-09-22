use crate::{game, schema::*};
use rts_core::{
    maps::default_map, simulation::World, validate_command_delay, DEFAULT_COMMAND_DELAY,
    RULESET_VERSION,
};
use spacetimedb::{ReducerContext, Table};

pub fn current_player(ctx: &ReducerContext) -> Result<Player, String> {
    ctx.db
        .player()
        .identity()
        .find(ctx.sender())
        .ok_or_else(|| "Connect before playing".into())
}

fn clean_name(value: String) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 24 || value.chars().any(char::is_control) {
        return Err("Names must contain 1-24 printable characters".into());
    }
    Ok(value.into())
}

#[spacetimedb::reducer(client_connected)]
pub fn connected(ctx: &ReducerContext) {
    if let Some(id) = ctx.connection_id() {
        ctx.db.connection().insert(Connection {
            id,
            identity: ctx.sender(),
        });
    }
    if let Some(mut player) = ctx.db.player().identity().find(ctx.sender()) {
        player.online = true;
        ctx.db.player().identity().update(player);
    } else {
        ctx.db.player().insert(Player {
            identity: ctx.sender(),
            match_id: 0,
            name: "Commander".into(),
            slot: 0,
            resources: 250,
            ready: false,
            online: true,
            last_order_tick: 0,
            orders_this_tick: 0,
        });
    }
}

#[spacetimedb::reducer(client_disconnected)]
pub fn disconnected(ctx: &ReducerContext) {
    if let Some(id) = ctx.connection_id() {
        ctx.db.connection().id().delete(id);
    }
    if let Some(mut player) = ctx.db.player().identity().find(ctx.sender()) {
        player.online = ctx
            .db
            .connection()
            .identity()
            .filter(ctx.sender())
            .next()
            .is_some();
        if !player.online {
            player.ready = false;
        }
        ctx.db.player().identity().update(player);
    }
}

#[spacetimedb::reducer]
pub fn set_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let mut player = current_player(ctx)?;
    player.name = clean_name(name)?;
    ctx.db.player().identity().update(player);
    Ok(())
}

#[spacetimedb::reducer]
pub fn create_room(ctx: &ReducerContext, name: String, capacity: u8) -> Result<(), String> {
    let mut player = current_player(ctx)?;
    if player.match_id != 0 {
        return Err("Leave your current room first".into());
    }
    if !(2..=4).contains(&capacity) {
        return Err("Rooms support 2-4 players".into());
    }
    if ctx.db.room().count() >= 128 {
        return Err("Server room limit reached".into());
    }
    // The delay the match will run under is validated before it is frozen, not
    // clamped: a ruleset whose default sits outside its own bounds fails room
    // creation loudly instead of quietly shipping a delay nobody chose. The
    // requested value is the ruleset default until the lobby gains a control
    // for it (M4); the bounds check is on the live path either way.
    let command_delay = validate_command_delay(DEFAULT_COMMAND_DELAY)?;
    let map = default_map().identity();
    let room = ctx.db.room().insert(Room {
        id: 0,
        name: clean_name(name)?,
        host: ctx.sender(),
        capacity,
        state: "lobby".into(),
        tick: 0,
        command_delay,
        ruleset_version: RULESET_VERSION,
        map_id: map.id,
        map_version: map.version,
        map_hash: map.hash,
        next_entity_id: 1,
        winner: -2,
        last_activity_micros: ctx.timestamp.to_micros_since_unix_epoch(),
    });
    if room.id > u32::MAX as u64 {
        return Err("Room ID limit reached".into());
    }
    player.match_id = room.id;
    player.slot = 0;
    player.ready = false;
    player.resources = 250;
    player.last_order_tick = 0;
    player.orders_this_tick = 0;
    ctx.db.player().identity().update(player);
    game::sync_tick_schedule(ctx);
    Ok(())
}

#[spacetimedb::reducer]
pub fn join_room(ctx: &ReducerContext, match_id: u64) -> Result<(), String> {
    let mut player = current_player(ctx)?;
    if player.match_id != 0 {
        return Err("Leave your current room first".into());
    }
    let room = ctx
        .db
        .room()
        .id()
        .find(match_id)
        .ok_or("Room no longer exists")?;
    if room.state != "lobby" {
        return Err("Match already started".into());
    }
    let members: Vec<Player> = ctx.db.player().match_id().filter(match_id).collect();
    if members.len() >= room.capacity as usize {
        return Err("Room is full".into());
    }
    player.slot = (0..4)
        .find(|slot| !members.iter().any(|member| member.slot == *slot))
        .ok_or("Room is full")?;
    player.match_id = match_id;
    player.ready = false;
    player.resources = 250;
    player.last_order_tick = 0;
    player.orders_this_tick = 0;
    ctx.db.player().identity().update(player);
    Ok(())
}

#[spacetimedb::reducer]
pub fn set_ready(ctx: &ReducerContext, ready: bool) -> Result<(), String> {
    let mut player = current_player(ctx)?;
    let room = ctx
        .db
        .room()
        .id()
        .find(player.match_id)
        .ok_or("Join a room first")?;
    if room.state != "lobby" {
        return Err("Match already started".into());
    }
    player.ready = ready;
    ctx.db.player().identity().update(player);
    Ok(())
}

#[spacetimedb::reducer]
pub fn start_match(ctx: &ReducerContext) -> Result<(), String> {
    let player = current_player(ctx)?;
    let mut room = ctx
        .db
        .room()
        .id()
        .find(player.match_id)
        .ok_or("Join a room first")?;
    if room.host != ctx.sender() {
        return Err("Only the host can start".into());
    }
    if room.state != "lobby" {
        return Err("Match already started".into());
    }
    let players: Vec<Player> = ctx.db.player().match_id().filter(room.id).collect();
    if players.len() < 2 || players.iter().any(|player| !player.ready || !player.online) {
        return Err("At least two players must be online and everyone ready".into());
    }
    let world = World::new(&players.iter().map(|player| player.slot).collect::<Vec<_>>());
    room.state = "playing".into();
    game::save_world(ctx, &mut room, &world);
    ctx.db.room().id().update(room);
    game::sync_tick_schedule(ctx);
    Ok(())
}

#[spacetimedb::reducer]
pub fn leave_room(ctx: &ReducerContext) -> Result<(), String> {
    let mut player = current_player(ctx)?;
    if let Some(mut room) = ctx.db.room().id().find(player.match_id) {
        if room.state == "playing" {
            let mut world = game::load_world(ctx, &room);
            world.surrender(player.slot);
            game::save_world(ctx, &mut room, &world);
        }
        player.match_id = 0;
        player.ready = false;
        ctx.db.player().identity().update(player);
        let members: Vec<Player> = ctx.db.player().match_id().filter(room.id).collect();
        if members.is_empty() {
            game::delete_room(ctx, room.id);
        } else {
            if room.host == ctx.sender() {
                room.host = members
                    .iter()
                    .min_by_key(|member| (!member.online, member.slot))
                    .unwrap()
                    .identity;
            }
            ctx.db.room().id().update(room);
        }
        game::sync_tick_schedule(ctx);
    }
    Ok(())
}
