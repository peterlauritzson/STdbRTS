mod game;
mod lobby;
mod schema;

use schema::*;
use spacetimedb::{ReducerContext, Table, TimeDuration};

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.tick_schedule().insert(TickSchedule {
        scheduled_id: 0,
        scheduled_at: TimeDuration::from_micros(50_000).into(),
    });
}
