use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table, TimeDuration};

#[spacetimedb::table(public, accessor = match_instance)]
pub struct MatchInstance {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub is_multiplayer: bool,
    pub active: bool,
    pub host: Identity,
    pub last_tick: u64,
}

#[spacetimedb::table(public, accessor = finished_match)]
pub struct FinishedMatch {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub winner_identity: String,
    pub final_tick: u64,
}

#[spacetimedb::table(public, accessor = config)]
pub struct Config {
    #[primary_key]
    pub version: u32,
    pub world_width: u32,
    pub world_height: u32,
    pub last_tick: u64,
}

#[spacetimedb::table(public, accessor = player)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    pub match_id: u64,
    pub name: String,
    pub resources: u32,
    pub online: bool,
}

#[spacetimedb::table(public, accessor = unit)]
pub struct Unit {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub owner: Identity,
    pub unit_type: String, // "worker", "soldier", "hq", "catapult"
    pub x: f32,
    pub y: f32,
    pub target_x: f32,
    pub target_y: f32,
    pub speed: f32,
    pub moving: bool,
    pub hp: i32,
    // Pending move (latency simulation)
    pub pending_target_x: f32,
    pub pending_target_y: f32,
    pub pending_start_tick: u64, // 0 = no pending move
}

#[spacetimedb::table(public, accessor = waypoint)]
pub struct Waypoint {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub unit_id: u64,
    pub x: f32,
    pub y: f32,
    pub order: u32,
}

#[spacetimedb::table(public, accessor = resource_node)]
pub struct ResourceNode {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub x: f32,
    pub y: f32,
    pub amount: u32,
    pub max_amount: u32,
}

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.config().insert(Config {
        version: 0,
        world_width: 3000,
        world_height: 3000,
        last_tick: 0,
    });

    let loop_duration = TimeDuration::from_micros(100_000);
    ctx.db.game_tick_schedule().insert(GameTickSchedule {
        scheduled_id: 0,
        scheduled_at: loop_duration.into(),
    });
}

/// The game tick occurs continuously once every 100 milliseconds.
#[spacetimedb::table(accessor = game_tick_schedule, scheduled(game_tick))]
pub struct GameTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

#[spacetimedb::reducer]
pub fn game_tick(ctx: &ReducerContext, _args: GameTickSchedule) {
    let dt = 0.1;

    // 0. Update active match ticks
    let mut match_ticks = std::collections::HashMap::new();
    for mut m in ctx.db.match_instance().iter().filter(|m| m.active) {
        m.last_tick += 1;
        match_ticks.insert(m.id, m.last_tick);
        ctx.db.match_instance().id().update(m);
    }

    for mut unit in ctx.db.unit().iter() {
        let current_tick = match match_ticks.get(&unit.match_id) {
            Some(&t) => t,
            None => continue, // unit not in active match
        };

        let mut dirty = false;

        // 1. Check for Pending Move Activation
        if unit.pending_start_tick > 0 && current_tick >= unit.pending_start_tick {
            unit.target_x = unit.pending_target_x;
            unit.target_y = unit.pending_target_y;
            unit.moving = true;
            unit.pending_start_tick = 0; // Clear pending
            dirty = true;
        }

        // 2. Process Movement
        if unit.moving {
            let dx = unit.target_x - unit.x;
            let dy = unit.target_y - unit.y;
            let dist = (dx.powi(2) + dy.powi(2)).sqrt();

            if dist < 0.1 {
                unit.x = unit.target_x;
                unit.y = unit.target_y;
                unit.moving = false;
                dirty = true;
            } else {
                let move_dist = unit.speed * dt;
                if move_dist >= dist {
                    unit.x = unit.target_x;
                    unit.y = unit.target_y;
                    unit.moving = false; // Stopped at target
                } else {
                    unit.x += (dx / dist) * move_dist;
                    unit.y += (dy / dist) * move_dist;
                }
                dirty = true;
            }
        }

        // 3. Process Waypoints for Idle Units
        if !unit.moving && unit.pending_start_tick == 0 {
            let mut next_wp: Option<Waypoint> = None;
            for wp in ctx.db.waypoint().iter().filter(|w| w.unit_id == unit.id) {
                if next_wp.is_none() || wp.order < next_wp.as_ref().unwrap().order {
                    next_wp = Some(wp);
                }
            }

            if let Some(wp) = next_wp {
                unit.target_x = wp.x;
                unit.target_y = wp.y;
                unit.moving = true;
                ctx.db.waypoint().id().delete(wp.id);
                dirty = true;
            }
        }

        if dirty {
            ctx.db.unit().id().update(unit);
        }
    }

    // --- Resource collection: idle workers near resource nodes harvest automatically ---
    const COLLECT_RANGE: f32 = 30.0;
    const COLLECT_AMOUNT: u32 = 5;
    const COLLECT_RATE: u64 = 10; // every 10 ticks (1 second)

    let active_nodes: Vec<ResourceNode> = ctx.db.resource_node().iter()
        .filter(|n| n.amount > 0 && match_ticks.get(&n.match_id).map_or(false, |&t| t > 0 && t % COLLECT_RATE == 0))
        .collect();

    for mut node in active_nodes {
        for worker in ctx.db.unit().iter().filter(|u| {
            u.match_id == node.match_id && u.unit_type == "worker" && !u.moving
        }) {
            if node.amount == 0 { break; }
            let dist = ((worker.x - node.x).powi(2) + (worker.y - node.y).powi(2)).sqrt();
            if dist <= COLLECT_RANGE {
                let actual = COLLECT_AMOUNT.min(node.amount);
                node.amount -= actual;
                if let Some(mut player) = ctx.db.player().identity().find(worker.owner) {
                    player.resources += actual;
                    ctx.db.player().identity().update(player);
                }
            }
        }
        if node.amount == 0 {
            ctx.db.resource_node().id().delete(node.id);
        } else {
            ctx.db.resource_node().id().update(node);
        }
    }

    // --- Combat: soldiers and catapults attack ---
    const SOLDIER_RANGE: f32  = 80.0;
    const SOLDIER_DMG: i32    = 15;
    const SOLDIER_RATE: u64   = 5;  // every 5 ticks = 0.5s
    const CATAPULT_RANGE: f32 = 300.0;
    const CATAPULT_DAMAGE: i32 = 50;
    const CATAPULT_FIRE_RATE: u64 = 20;

    let mut damage_map: std::collections::HashMap<u64, i32> = std::collections::HashMap::new();
    for attacker in ctx.db.unit().iter().filter(|u| u.unit_type == "soldier" || u.unit_type == "catapult") {
        let tick = match match_ticks.get(&attacker.match_id) {
            Some(&t) => t,
            None => continue,
        };
        let (range, dmg, rate) = if attacker.unit_type == "catapult" {
            (CATAPULT_RANGE, CATAPULT_DAMAGE, CATAPULT_FIRE_RATE)
        } else {
            (SOLDIER_RANGE, SOLDIER_DMG, SOLDIER_RATE)
        };
        if tick == 0 || tick % rate != 0 { continue; }
        let mut best: Option<(u64, f32)> = None;
        for target in ctx.db.unit().iter().filter(|u| u.match_id == attacker.match_id && u.owner != attacker.owner) {
            let dist = ((target.x - attacker.x).powi(2) + (target.y - attacker.y).powi(2)).sqrt();
            if dist <= range {
                if best.is_none() || dist < best.unwrap().1 {
                    best = Some((target.id, dist));
                }
            }
        }
        if let Some((target_id, _)) = best {
            *damage_map.entry(target_id).or_insert(0) += dmg;
        }
    }
    // Apply damage; check for HQ kills (win condition) and delete dead units
    let mut dead_ids: Vec<u64> = Vec::new();
    for (id, dmg) in &damage_map {
        if let Some(mut unit) = ctx.db.unit().id().find(*id) {
            unit.hp -= dmg;
            if unit.hp <= 0 {
                dead_ids.push(*id);
                // HQ death = match over
                if unit.unit_type == "hq" {
                    if let Some(mut m) = ctx.db.match_instance().id().find(unit.match_id) {
                        m.active = false;
                        ctx.db.match_instance().id().update(m);
                    }
                }
            } else {
                ctx.db.unit().id().update(unit);
            }
        }
    }
    for id in dead_ids {
        let wps: Vec<u64> = ctx.db.waypoint().iter().filter(|w| w.unit_id == id).map(|w| w.id).collect();
        for wp_id in wps { ctx.db.waypoint().id().delete(wp_id); }
        ctx.db.unit().id().delete(id);
    }
}

#[spacetimedb::reducer(client_connected)]
pub fn identity_connected(ctx: &ReducerContext) {
    if let Some(mut player) = ctx.db.player().identity().find(ctx.sender()) {
        player.online = true;
        player.match_id = 0; // Reset — force them to start/join a new match
        ctx.db.player().identity().update(player);
    } else {
        ctx.db.player().insert(Player {
            identity: ctx.sender(),
            match_id: 0,
            name: "Player".to_string(),
            resources: 250,
            online: true,
        });
    }
}

#[spacetimedb::reducer(client_disconnected)]
pub fn identity_disconnected(ctx: &ReducerContext) {
    if let Some(mut player) = ctx.db.player().identity().find(ctx.sender()) {
        // Delete any match this player was in so it doesn't linger
        if player.match_id != 0 {
            delete_match(ctx, player.match_id);
        }
        player.online = false;
        player.match_id = 0;
        ctx.db.player().identity().update(player);
    }
}

/// Delete a match instance and all its units/waypoints.
fn delete_match(ctx: &ReducerContext, match_id: u64) {
    let match_units: Vec<u64> = ctx
        .db
        .unit()
        .iter()
        .filter(|u| u.match_id == match_id)
        .map(|u| u.id)
        .collect();
    for unit_id in match_units {
        let wps: Vec<u64> = ctx
            .db
            .waypoint()
            .iter()
            .filter(|w| w.unit_id == unit_id)
            .map(|w| w.id)
            .collect();
        for wp_id in wps {
            ctx.db.waypoint().id().delete(wp_id);
        }
        ctx.db.unit().id().delete(unit_id);
    }
    // Delete resource nodes for this match
    let rn_ids: Vec<u64> = ctx.db.resource_node().iter()
        .filter(|n| n.match_id == match_id)
        .map(|n| n.id)
        .collect();
    for id in rn_ids {
        ctx.db.resource_node().id().delete(id);
    }
    ctx.db.match_instance().id().delete(match_id);
}

/// Spawn resource nodes symmetrically across the map for a match.
fn spawn_resource_nodes(ctx: &ReducerContext, match_id: u64) {
    let positions: &[(f32, f32)] = &[
        (1500.0, 1500.0), // center
        ( 750.0,  750.0), // near P1 quadrant
        (2250.0, 2250.0), // near P2 quadrant
        ( 750.0, 2250.0), // off-diagonal
        (2250.0,  750.0), // off-diagonal
        (1500.0,  750.0), // top middle
        (1500.0, 2250.0), // bottom middle
        ( 750.0, 1500.0), // left middle
        (2250.0, 1500.0), // right middle
    ];
    for &(x, y) in positions {
        ctx.db.resource_node().insert(ResourceNode {
            id: 0, match_id, x, y, amount: 500, max_amount: 500,
        });
    }
}

/// Spawn HQ + 2 starting workers for a player at a given position.
fn spawn_starting_units(ctx: &ReducerContext, owner: Identity, match_id: u64, hq_x: f32, hq_y: f32) {
    ctx.db.unit().insert(Unit {
        id: 0, match_id, owner,
        unit_type: "hq".to_string(),
        x: hq_x, y: hq_y, target_x: hq_x, target_y: hq_y,
        speed: 0.0, moving: false, hp: 1000,
        pending_target_x: 0.0, pending_target_y: 0.0, pending_start_tick: 0,
    });
    ctx.db.unit().insert(Unit {
        id: 0, match_id, owner,
        unit_type: "worker".to_string(),
        x: hq_x + 70.0, y: hq_y, target_x: hq_x + 70.0, target_y: hq_y,
        speed: 50.0, moving: false, hp: 40,
        pending_target_x: 0.0, pending_target_y: 0.0, pending_start_tick: 0,
    });
    ctx.db.unit().insert(Unit {
        id: 0, match_id, owner,
        unit_type: "worker".to_string(),
        x: hq_x, y: hq_y + 70.0, target_x: hq_x, target_y: hq_y + 70.0,
        speed: 50.0, moving: false, hp: 40,
        pending_target_x: 0.0, pending_target_y: 0.0, pending_start_tick: 0,
    });
}

#[spacetimedb::reducer]
pub fn move_unit(
    ctx: &ReducerContext,
    unit_id: u64,
    target_x: f32,
    target_y: f32,
    shift_held: bool,
) {
    if let Some(mut unit) = ctx.db.unit().id().find(unit_id) {
        if unit.owner == ctx.sender() {
            // Only HQ cannot move
            if unit.unit_type == "hq" {
                return;
            }
            if !shift_held {
                // IMMEDIATE MOVE: Clear waypoints and set pending
                for wp in ctx
                    .db
                    .waypoint()
                    .iter()
                    .filter(|w| w.unit_id == unit_id)
                    .map(|w| w.id)
                    .collect::<Vec<u64>>()
                {
                    ctx.db.waypoint().id().delete(wp);
                }

                let current_tick = if let Some(m) = ctx.db.match_instance().id().find(unit.match_id)
                {
                    m.last_tick
                } else {
                    0
                };

                // Schedule start for 6 ticks in future
                unit.pending_target_x = target_x;
                unit.pending_target_y = target_y;
                unit.pending_start_tick = current_tick + 6;
                ctx.db.unit().id().update(unit);
            } else {
                // QUEUE MOVE: Add waypoint
                let max_order = ctx
                    .db
                    .waypoint()
                    .iter()
                    .filter(|w| w.unit_id == unit_id)
                    .map(|w| w.order)
                    .max()
                    .unwrap_or(0);
                ctx.db.waypoint().insert(Waypoint {
                    id: 0,
                    unit_id,
                    x: target_x,
                    y: target_y,
                    order: max_order + 1,
                });
            }
        }
    }
}

#[spacetimedb::reducer]
pub fn train_unit(ctx: &ReducerContext, unit_type: String, x: f32, y: f32) {
    if let Some(mut player) = ctx.db.player().identity().find(ctx.sender()) {
        // Simple costs
        let cost = if unit_type == "worker" { 50 } else { 100 };
        if player.resources >= cost {
            let m_id = player.match_id;
            let (hp, speed) = if unit_type == "worker" { (40, 50.0) } else { (90, 100.0) };
            player.resources -= cost;
            ctx.db.player().identity().update(player);

            // Spawn unit
            ctx.db.unit().insert(Unit {
                id: 0,
                match_id: m_id,
                owner: ctx.sender(),
                unit_type,
                x,
                y,
                target_x: x,
                target_y: y,
                speed: speed,
                moving: false,
                hp,
                pending_target_x: 0.0,
                pending_target_y: 0.0,
                pending_start_tick: 0,
            });
        }
    }
}

#[spacetimedb::reducer]
pub fn build_building(ctx: &ReducerContext, building_type: String, x: f32, y: f32) {
    if let Some(mut player) = ctx.db.player().identity().find(ctx.sender()) {
        let cost = 200;
        if player.resources >= cost {
            let m_id = player.match_id;
            player.resources -= cost;
            ctx.db.player().identity().update(player);

            ctx.db.unit().insert(Unit {
                id: 0,
                match_id: m_id,
                owner: ctx.sender(),
                unit_type: building_type,
                x,
                y,
                target_x: x,
                target_y: y,
                speed: 25.0, // Catapult moves slowly
                moving: false,
                hp: 400,
                pending_target_x: 0.0,
                pending_target_y: 0.0,
                pending_start_tick: 0,
            });
        }
    }
}

#[spacetimedb::reducer]
pub fn reset_game(ctx: &ReducerContext, _args: ()) {
    // Delete all units
    let unit_ids: Vec<u64> = ctx.db.unit().iter().map(|u| u.id).collect();
    for id in unit_ids {
        ctx.db.unit().id().delete(id);
    }

    // Delete all waypoints
    let waypoint_ids: Vec<u64> = ctx.db.waypoint().iter().map(|w| w.id).collect();
    for id in waypoint_ids {
        ctx.db.waypoint().id().delete(id);
    }

    // Delete all resource nodes
    let rn_ids: Vec<u64> = ctx.db.resource_node().iter().map(|n| n.id).collect();
    for id in rn_ids {
        ctx.db.resource_node().id().delete(id);
    }

    // Reset all players
    let players: Vec<Player> = ctx.db.player().iter().collect();
    for mut player in players {
        player.resources = 250;
        ctx.db.player().identity().update(player);
    }

    // Reset Config tick
    if let Some(mut config) = ctx.db.config().version().find(0) {
        config.last_tick = 0;
        ctx.db.config().version().update(config);
    }
}

#[spacetimedb::reducer]
pub fn start_match(ctx: &ReducerContext, is_multiplayer: bool) {
    // Clean up ALL old matches hosted by this player (match_id may be 0 after reconnect)
    let old_match_ids: Vec<u64> = ctx
        .db
        .match_instance()
        .iter()
        .filter(|m| m.host == ctx.sender())
        .map(|m| m.id)
        .collect();
    for old_id in old_match_ids {
        delete_match(ctx, old_id);
    }

    // For multiplayer, match starts inactive (waiting for opponent). Single player starts immediately.
    let match_instance = ctx.db.match_instance().insert(MatchInstance {
        id: 0,
        is_multiplayer,
        active: !is_multiplayer,
        host: ctx.sender(),
        last_tick: 0,
    });

    if let Some(mut p) = ctx.db.player().identity().find(ctx.sender()) {
        p.match_id = match_instance.id;
        ctx.db.player().identity().update(p);
    }
    // Spawn starting units at top-left for the host
    spawn_starting_units(ctx, ctx.sender(), match_instance.id, 300.0, 300.0);
    // Spawn resource nodes across the map
    spawn_resource_nodes(ctx, match_instance.id);
}

#[spacetimedb::reducer]
pub fn set_name(ctx: &ReducerContext, name: String) {
    if let Some(mut player) = ctx.db.player().identity().find(ctx.sender()) {
        player.name = name;
        ctx.db.player().identity().update(player);
    }
}

/// Join an open multiplayer match. Sets the match active and assigns the player.
#[spacetimedb::reducer]
pub fn join_match(ctx: &ReducerContext, match_id: u64) {
    // Must be an open, inactive, multiplayer match
    if let Some(mut m) = ctx.db.match_instance().id().find(match_id) {
        if !m.is_multiplayer || m.active {
            return; // Already started or not multiplayer
        }
        if m.host == ctx.sender() {
            return; // Can't join your own hosted match
        }
        m.active = true;
        ctx.db.match_instance().id().update(m);

        // Assign the joiner and spawn their starting units at bottom-right
        if let Some(mut p) = ctx.db.player().identity().find(ctx.sender()) {
            p.match_id = match_id;
            ctx.db.player().identity().update(p);
        }
        spawn_starting_units(ctx, ctx.sender(), match_id, 2700.0, 2700.0);
    }
}
