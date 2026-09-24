use crate::{lobby::current_player, schema::*};
use rts_core::{
    execution_tick, is_army, is_building, is_labour, is_sample_tick, maps,
    simulation::{Command as CoreCommand, Order, World},
    stats, Balance, Cost,
};
use spacetimedb::{ReducerContext, ScheduleAt, Table, TimeDuration};

/// How often the scheduler is *asked* to wake while a match is running. This is
/// deliberately shorter than one simulation tick: the host does not deliver an
/// exact period (a 50ms request was measured arriving every 61.7ms, a 25ms
/// request every 31.4ms), so the tick rate cannot be derived from the wake rate.
/// Each wake instead advances however many whole ticks of wall time have
/// actually elapsed, which keeps 20 TPS honest regardless of scheduler drift.
const PLAYING_TICK_MICROS: i64 = 25_000;
/// One simulation tick of wall time, the cadence the ruleset is defined in.
const SIMULATION_TICK_MICROS: i64 = 1_000_000 / rts_core::TICKS_PER_SECOND as i64;
/// The most ticks one wake may advance. Without a cap, a host that stalls would
/// hand the next wake an unbounded catch-up and the simulation would spiral
/// trying to overtake it. Falling behind is reported by the clock, not hidden.
const MAX_CATCHUP_TICKS: i64 = 4;
/// Housekeeping cadence while rooms exist but none are running. Lobbies only
/// need the idle-expiry sweep, not 20 TPS.
const LOBBY_TICK_MICROS: i64 = 5_000_000;

fn desired_schedule(ctx: &ReducerContext) -> Option<ScheduleAt> {
    let mut micros = None;
    for room in ctx.db.room().iter() {
        if room.state == "playing" {
            micros = Some(PLAYING_TICK_MICROS);
            break;
        }
        micros = Some(LOBBY_TICK_MICROS);
    }
    micros.map(|value| TimeDuration::from_micros(value).into())
}

/// Arms, re-rates, or disarms the tick so an empty database costs nothing.
/// Call after anything that creates, removes, or changes the state of a room.
pub fn sync_tick_schedule(ctx: &ReducerContext) {
    let desired = desired_schedule(ctx);
    let mut rows = ctx.db.tick_schedule().iter().collect::<Vec<_>>();
    let current = rows.pop();
    for extra in rows {
        ctx.db
            .tick_schedule()
            .scheduled_id()
            .delete(extra.scheduled_id);
    }
    if current.as_ref().map(|row| row.scheduled_at) == desired {
        return;
    }
    if let Some(row) = current {
        ctx.db.tick_schedule().scheduled_id().delete(row.scheduled_id);
    }
    if let Some(scheduled_at) = desired {
        ctx.db.tick_schedule().insert(TickSchedule {
            scheduled_id: 0,
            scheduled_at,
        });
    }
}

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
            .map(|player| (player.slot, Balance::new(player.material, player.catalyst)))
            .collect(),
        // Every owner's economy, so the simulation can read a faction per slot
        // without reaching back into the database mid-tick.
        factions: ctx
            .db
            .player()
            .match_id()
            .filter(room.id)
            .map(|player| (player.slot, player.faction))
            .collect(),
        // The three cumulative history counters, round-tripped exactly as the
        // balances above are: the simulation owns them for the length of a tick
        // and the row owns them between ticks.
        collected: ctx
            .db
            .player()
            .match_id()
            .filter(room.id)
            .map(|player| {
                (
                    player.slot,
                    Balance::new(player.collected_material, player.collected_catalyst),
                )
            })
            .collect(),
        lost: ctx
            .db
            .player()
            .match_id()
            .filter(room.id)
            .map(|player| {
                (
                    player.slot,
                    Cost::new(player.lost_material, player.lost_catalyst),
                )
            })
            .collect(),
        killed: ctx
            .db
            .player()
            .match_id()
            .filter(room.id)
            .map(|player| {
                (
                    player.slot,
                    Cost::new(player.killed_material, player.killed_catalyst),
                )
            })
            .collect(),
        // Organic creep, the only zone state carried between ticks. The world
        // keeps it in source-id order and the index hands rows back in no
        // promised order, so it is sorted here rather than assumed.
        creep: {
            let mut creep = ctx
                .db
                .creep_patch()
                .match_id()
                .filter(room.id)
                .map(|row| row.data)
                .collect::<Vec<_>>();
            creep.sort_unstable_by_key(|patch| patch.source);
            creep
        },
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
    // Creep is diffed exactly as units are: a patch holds its radius between
    // growth steps, so most ticks this loop writes nothing at all.
    for old in ctx
        .db
        .creep_patch()
        .match_id()
        .filter(room.id)
        .collect::<Vec<_>>()
    {
        if world
            .creep
            .binary_search_by_key(&old.data.source, |patch| patch.source)
            .is_err()
        {
            ctx.db.creep_patch().id().delete(old.id);
        }
    }
    for data in &world.creep {
        let id = (room.id << 32) | data.source as u64;
        if let Some(old) = ctx.db.creep_patch().id().find(id) {
            if old.data != *data {
                ctx.db.creep_patch().id().update(CreepPatchRow {
                    id,
                    match_id: room.id,
                    data: *data,
                });
            }
        } else {
            ctx.db.creep_patch().insert(CreepPatchRow {
                id,
                match_id: room.id,
                data: *data,
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
        let balance = world.balances.get(&player.slot);
        let faction = world.factions.get(&player.slot).copied();
        let collected = world.collected(player.slot);
        let lost = world.lost(player.slot);
        let killed = world.killed(player.slot);
        let changed = balance.is_some_and(|balance| {
            (player.material, player.catalyst) != (balance.material, balance.catalyst)
        }) || faction.is_some_and(|faction| player.faction != faction)
            || (player.collected_material, player.collected_catalyst)
                != (collected.material, collected.catalyst)
            || (player.lost_material, player.lost_catalyst) != (lost.material, lost.catalyst)
            || (player.killed_material, player.killed_catalyst)
                != (killed.material, killed.catalyst);
        if changed {
            if let Some(balance) = balance {
                player.material = balance.material;
                player.catalyst = balance.catalyst;
            }
            if let Some(faction) = faction {
                player.faction = faction;
            }
            // Written unconditionally once anything moved. Unlike the balance
            // and the faction these have no "absent means leave alone" case:
            // a slot the world does not know has mined, lost and killed
            // nothing, and zero is the honest value.
            player.collected_material = collected.material;
            player.collected_catalyst = collected.catalyst;
            player.lost_material = lost.material;
            player.lost_catalyst = lost.catalyst;
            player.killed_material = killed.material;
            player.killed_catalyst = killed.catalyst;
            ctx.db.player().identity().update(player);
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

/// Writes one `match_sample` row per player for the world's current tick.
///
/// Read-only with respect to the simulation: it takes `&World`, so there is no
/// way for it to move a unit, spend a currency or end a match, and a replay run
/// without a database behaves identically to one with it.
///
/// Only ever called from a branch that has already established the room is
/// `playing` — a lobby has no history and a finished match's history is closed
/// by its own final sample.
pub fn record_sample(ctx: &ReducerContext, match_id: u64, world: &World) {
    // One pass over the units for every player at once, rather than one pass
    // each: at the supported tier this is a few hundred entities every
    // hundredth tick, which is why the cadence costs nothing measurable.
    #[derive(Clone, Copy, Default)]
    struct Roster {
        labour: u32,
        army: u32,
        // A building still going up is counted: it is on the field, it can be
        // killed, and a graph that only showed finished structures would miss
        // the whole of an expansion being contested.
        buildings: u32,
        army_value: Cost,
    }
    let mut rosters = std::collections::BTreeMap::<u8, Roster>::new();
    for unit in &world.units {
        let roster = rosters.entry(unit.owner).or_default();
        if is_army(&unit.kind) {
            roster.army += 1;
            roster.army_value =
                roster.army_value + stats(&unit.kind).map_or(Cost::ZERO, |entry| entry.cost);
        } else if is_labour(&unit.kind) {
            roster.labour += 1;
        } else if is_building(&unit.kind) {
            roster.buildings += 1;
        }
    }
    // Driven by `balances`, which holds every slot in the match from the first
    // tick, so a player who has been wiped off the map still gets a row and
    // their graph ends in a flat line rather than simply stopping.
    for (slot, balance) in &world.balances {
        let roster = rosters.get(slot).copied().unwrap_or_default();
        let collected = world.collected(*slot);
        let lost = world.lost(*slot);
        ctx.db.match_sample().insert(MatchSample {
            id: 0,
            match_id,
            tick: world.tick,
            slot: *slot,
            material: balance.material,
            catalyst: balance.catalyst,
            collected_material: collected.material,
            collected_catalyst: collected.catalyst,
            army_value_material: roster.army_value.material,
            army_value_catalyst: roster.army_value.catalyst,
            labour: roster.labour,
            army: roster.army,
            buildings: roster.buildings,
            lost_material: lost.material,
            lost_catalyst: lost.catalyst,
        });
    }
}

/// The last point on every graph, taken the instant a match ends so the screen
/// shows the real end state instead of one up to five seconds stale. A no-op
/// while the match is still running, and skipped when the cadence already
/// covered this exact tick.
pub fn record_final_sample(ctx: &ReducerContext, match_id: u64, world: &World) {
    // `is_sample_tick` is the whole duplicate guard: a tick that is a sample
    // point already has its rows, written the moment the world first reached
    // it, and a tick that is not never will have.
    if world.outcome.is_some() && !is_sample_tick(world.tick) {
        record_sample(ctx, match_id, world);
    }
}

pub fn delete_room(ctx: &ReducerContext, match_id: u64) {
    ctx.db.match_sample().match_id().delete(match_id);
    ctx.db.unit().match_id().delete(match_id);
    ctx.db.creep_patch().match_id().delete(match_id);
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
    let map = maps::by_id(&room.map_id).ok_or("This match was created on an unknown map")?;
    world.validate_on(
        &CoreCommand {
        id: 0,
        owner: player.slot,
        units: units.clone(),
        order: order.clone(),
        queued,
        execute_tick,
            status: "scheduled".into(),
            reason: String::new(),
        },
        map,
    )?;
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
            // Advance by elapsed wall time rather than once per wake. The
            // remainder stays on the room, so partial ticks are never lost and
            // the match clock tracks real seconds instead of the wake rate.
            let elapsed = now.saturating_sub(room.last_tick_micros);
            let due = (elapsed / SIMULATION_TICK_MICROS).clamp(0, MAX_CATCHUP_TICKS);
            if due == 0 {
                ctx.db.room().id().update(room);
                continue;
            }
            room.last_tick_micros = room
                .last_tick_micros
                .saturating_add(due * SIMULATION_TICK_MICROS);
            let mut world = load_world(ctx, &room);
            match maps::by_id(&room.map_id) {
                Some(map) => {
                    // The sampling happens between steps, inside the core loop,
                    // so a wake that advances four ticks still writes one row
                    // per sample point and dates it by the tick it describes.
                    // See `World::step_many_on`.
                    world.step_many_on(map, due as u64, |world| {
                        record_sample(ctx, room.id, world)
                    });
                    record_final_sample(ctx, room.id, &world);
                }
                // A match frozen on a map this build no longer ships cannot be
                // simulated correctly, so it is left untouched rather than
                // silently played out on a different map.
                None => continue,
            }
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
    sync_tick_schedule(ctx);
    Ok(())
}
