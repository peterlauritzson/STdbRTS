mod game;
mod lobby;
mod schema;

use spacetimedb::ReducerContext;

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    // No rooms exist yet, so this arms nothing. The first created room starts
    // the tick; the last removed room stops it.
    game::sync_tick_schedule(ctx);
}
