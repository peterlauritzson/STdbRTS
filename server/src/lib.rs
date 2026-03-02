use spacetimedb::{Identity, ReducerContext, Table};

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
    pub name: String,
    pub resources: u32,
    pub online: bool,
}

#[spacetimedb::table(public, accessor = unit)]
pub struct Unit {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub owner: Identity,
    pub unit_type: String, // "worker", "soldier", "hq", "barracks"
    pub x: f32,
    pub y: f32,
    pub target_x: f32,
    pub target_y: f32,
    pub speed: f32,
    pub moving: bool,
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

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.config().insert(Config {
        version: 0,
        world_width: 1200,
        world_height: 700,
        last_tick: 0, 
    });
}

#[spacetimedb::reducer]
pub fn game_tick(ctx: &ReducerContext, _args: ()) {
    // Increment global tick counter
    let mut config = ctx.db.config().version().find(0).expect("Config missing");
    config.last_tick += 1;
    let current_tick = config.last_tick;
    ctx.db.config().version().update(config);

    let dt = 0.1; 

    for mut unit in ctx.db.unit().iter() {
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
}

#[spacetimedb::reducer(client_connected)]
pub fn identity_connected(ctx: &ReducerContext) {
    if let Some(mut player) = ctx.db.player().identity().find(ctx.sender()) {
        player.online = true;
        ctx.db.player().identity().update(player);
    } else {
        ctx.db.player().insert(Player {
            identity: ctx.sender(),
            name: "Player".to_string(), 
            resources: 250,
            online: true,
        });
    }
}

#[spacetimedb::reducer(client_disconnected)]
pub fn identity_disconnected(ctx: &ReducerContext) {
    if let Some(mut player) = ctx.db.player().identity().find(ctx.sender()) {
        player.online = false;
        ctx.db.player().identity().update(player);
    }
}

#[spacetimedb::reducer]
pub fn move_unit(ctx: &ReducerContext, unit_id: u64, target_x: f32, target_y: f32, shift_held: bool) {
    if let Some(mut unit) = ctx.db.unit().id().find(unit_id) {
        if unit.owner == ctx.sender() {
            if !shift_held {
                // IMMEDIATE MOVE: Clear waypoints and set pending
                for wp in ctx.db.waypoint().iter().filter(|w| w.unit_id == unit_id).map(|w| w.id).collect::<Vec<u64>>() {
                    ctx.db.waypoint().id().delete(wp);
                }
                
                let config = ctx.db.config().version().find(0).expect("Config missing");
                let current_tick = config.last_tick;
                
                // Schedule start for 6 ticks in future
                unit.pending_target_x = target_x;
                unit.pending_target_y = target_y;
                unit.pending_start_tick = current_tick + 6;
                ctx.db.unit().id().update(unit);
            
            } else {
                // QUEUE MOVE: Add waypoint
                let max_order = ctx.db.waypoint().iter().filter(|w| w.unit_id == unit_id).map(|w| w.order).max().unwrap_or(0);
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
            player.resources -= cost;
            ctx.db.player().identity().update(player);
            
            // Spawn unit
            ctx.db.unit().insert(Unit {
                id: 0, 
                owner: ctx.sender(),
                unit_type,
                x,
                y,
                target_x: x,
                target_y: y,
                speed: 50.0,
                moving: false,
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
            player.resources -= cost;
            ctx.db.player().identity().update(player);
            
            ctx.db.unit().insert(Unit {
                id: 0, 
                owner: ctx.sender(),
                unit_type: building_type,
                x,
                y,
                target_x: x,
                target_y: y,
                speed: 0.0, // Buildings don't move
                moving: false,
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




