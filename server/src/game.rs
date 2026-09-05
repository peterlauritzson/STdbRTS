use crate::{lobby::current_player, schema::*};
use rts_core::{
    execution_tick,
    simulation::{Command as CoreCommand, Order, World},
};
use spacetimedb::{ReducerContext, Table};

pub fn load_world(ctx: &ReducerContext, room: &Room) -> World {
    World {
        tick: room.tick,
        next_id: room.next_entity_id,
        units: ctx
            .db
            .unit()
            .match_id()
            .filter(room.id)
            .map(|row| row.data)
            .collect(),
        nodes: ctx
            .db
            .resource_node()
            .match_id()
            .filter(room.id)
            .map(|row| row.data)
            .collect(),
        commands: ctx
            .db
            .command()
            .match_id()
            .filter(room.id)
            .map(|row| CoreCommand {
                id: row.id,
                owner: row.owner,
                units: row.units,
                order: row.order,
                queued: row.queued,
                execute_tick: row.execute_tick,
                status: row.status,
                reason: row.reason,
            })
            .collect(),
        balances: ctx
            .db
            .player()
            .match_id()
            .filter(room.id)
            .map(|player| (player.slot, player.resources))
            .collect(),
        outcome: if room.state == "finished" {
            Some(room.winner)
        } else {
            None
        },
    }
}

pub fn save_world(ctx: &ReducerContext, room: &mut Room, world: &World) {
    room.tick = world.tick;
    room.next_entity_id = world.next_id;
    if let Some(winner) = world.outcome {
        room.state = "finished".into();
        room.winner = winner;
    }
    for old in ctx.db.unit().match_id().filter(room.id).collect::<Vec<_>>() {
        if !world.units.iter().any(|unit| unit.id == old.data.id) {
            ctx.db.unit().id().delete(old.id);
        }
    }
    for data in &world.units {
        let id = (room.id << 32) | data.id as u64;
        if let Some(old) = ctx.db.unit().id().find(id) {
            if old.data != *data {
                ctx.db.unit().id().update(Unit {
                    id,
                    match_id: room.id,
                    data: data.clone(),
                });
            }
        } else {
            ctx.db.unit().insert(Unit {
                id,
                match_id: room.id,
                data: data.clone(),
            });
        }
    }
    for data in &world.nodes {
        let id = (room.id << 32) | data.id as u64;
        if let Some(old) = ctx.db.resource_node().id().find(id) {
            if old.data != *data {
                ctx.db.resource_node().id().update(ResourceNode {
                    id,
                    match_id: room.id,
                    data: data.clone(),
                });
            }
        } else {
            ctx.db.resource_node().insert(ResourceNode {
                id,
                match_id: room.id,
                data: data.clone(),
            });
        }
    }
    for mut player in ctx
        .db
        .player()
        .match_id()
        .filter(room.id)
        .collect::<Vec<_>>()
    {
        if let Some(balance) = world.balances.get(&player.slot) {
            if player.resources != *balance {
                player.resources = *balance;
                ctx.db.player().identity().update(player);
            }
        }
    }
    for result in &world.commands {
        if let Some(mut row) = ctx.db.command().id().find(result.id) {
            if row.status != result.status || row.reason != result.reason {
                row.status = result.status.clone();
                row.reason = result.reason.clone();
                ctx.db.command().id().update(row);
            }
        }
    }
}

pub fn delete_room(ctx: &ReducerContext, match_id: u64) {
    ctx.db.unit().match_id().delete(match_id);
    ctx.db.resource_node().match_id().delete(match_id);
    ctx.db.command().match_id().delete(match_id);
    for mut player in ctx
        .db
        .player()
        .match_id()
        .filter(match_id)
        .collect::<Vec<_>>()
    {
        player.match_id = 0;
        player.ready = false;
        ctx.db.player().identity().update(player);
    }
    ctx.db.room().id().delete(match_id);
}

#[spacetimedb::reducer]
pub fn issue_order(
    ctx: &ReducerContext,
    request_id: String,
    units: Vec<u32>,
    kind: String,
    x: f32,
    y: f32,
    target: u32,
    queued: bool,
) -> Result<(), String> {
    let mut player = current_player(ctx)?;
    let room = ctx
        .db
        .room()
        .id()
        .find(player.match_id)
        .ok_or("Join a match first")?;
    if room.state != "playing" {
        return Err("Match is not running".into());
    }
    if request_id.is_empty() || request_id.len() > 64 {
        return Err("Invalid request ID".into());
    }
    if !x.is_finite() || !y.is_finite() {
        return Err("Invalid coordinates".into());
    }
    let world = load_world(ctx, &room);
    if ctx
        .db
        .command()
        .match_id()
        .filter(room.id)
        .any(|command| command.issuer == ctx.sender() && command.request_id == request_id)
    {
        return Ok(());
    }
    if player.last_order_tick != room.tick {
        player.last_order_tick = room.tick;
        player.orders_this_tick = 0;
    }
    if player.orders_this_tick >= 8
        || world
            .commands
            .iter()
            .filter(|command| command.owner == player.slot && command.status == "scheduled")
            .count()
            >= 32
    {
        return Err("Too many pending orders".into());
    }
    let order = Order { kind, x, y, target };
    let execute_tick = execution_tick(room.tick, room.command_delay)?;
    world.validate(&CoreCommand {
        id: 0,
        owner: player.slot,
        units: units.clone(),
        order: order.clone(),
        queued,
        execute_tick,
        status: "scheduled".into(),
        reason: String::new(),
    })?;
    player.orders_this_tick += 1;
    ctx.db.player().identity().update(player.clone());
    ctx.db.command().insert(Command {
        id: 0,
        match_id: room.id,
        issuer: ctx.sender(),
        request_id,
        owner: player.slot,
        units,
        order,
        queued,
        issued_tick: room.tick,
        execute_tick,
        status: "scheduled".into(),
        reason: String::new(),
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn game_tick(ctx: &ReducerContext, _timer: TickSchedule) -> Result<(), String> {
    if ctx.sender() != ctx.identity() || ctx.connection_id().is_some() {
        return Err("Only the server scheduler may advance the simulation".into());
    }
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    for mut room in ctx.db.room().iter().collect::<Vec<_>>() {
        let online = ctx
            .db
            .player()
            .match_id()
            .filter(room.id)
            .any(|player| player.online);
        if online {
            room.last_activity_micros = now;
        }
        if now - room.last_activity_micros > 1_800_000_000 {
            delete_room(ctx, room.id);
            continue;
        }
        if room.state == "playing" {
            let mut world = load_world(ctx, &room);
            world.step();
            save_world(ctx, &mut room, &world);
            for row in ctx
                .db
                .command()
                .match_id()
                .filter(room.id)
                .collect::<Vec<_>>()
            {
                if row.status != "scheduled" && room.tick.saturating_sub(row.execute_tick) > 200 {
                    ctx.db.command().id().delete(row.id);
                }
            }
        }
        ctx.db.room().id().update(room);
    }
    Ok(())
}
