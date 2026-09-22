pub mod maps;
pub mod navigation;
pub mod simulation;

/// Identity of the frozen rules surface. Bump this whenever anything a running
/// match depends on changes: unit stats, costs, damage rules, production
/// requirements, movement, world size, or the command-delay bounds. A match
/// records the value current at its creation and never re-reads it, so two
/// matches carrying different ruleset versions were played under different
/// rules and their replays are not comparable.
pub const RULESET_VERSION: u32 = 1;

pub const TICKS_PER_SECOND: u64 = 20;

/// The command delay a newly created match freezes, in ticks. 20 ticks is
/// exactly one second at `TICKS_PER_SECOND`.
pub const DEFAULT_COMMAND_DELAY: u64 = 20;

/// Inclusive bounds on a frozen command delay, spanning the 0.5s / 1.0s / 1.5s
/// trial points at `TICKS_PER_SECOND`. Out-of-range values are rejected at room
/// creation, never clamped.
pub const COMMAND_DELAY_MIN: u64 = 10;
pub const COMMAND_DELAY_MAX: u64 = 30;

pub const WORLD_SIZE: f32 = 1600.0;
pub const MAX_UNITS: usize = 60;
pub const MAX_QUEUE: usize = 8;
pub const MAX_BUILDINGS: usize = 16;

pub fn is_building(kind: &str) -> bool {
    matches!(
        kind,
        "hq" | "barracks" | "factory" | "turret" | "outpost" | "lab"
    )
}

pub fn is_army(kind: &str) -> bool {
    matches!(kind, "soldier" | "scout" | "siege")
}

pub fn producer(kind: &str, building: &str) -> bool {
    matches!(
        (kind, building),
        ("worker", "hq")
            | ("soldier", "hq" | "barracks")
            | ("scout", "barracks")
            | ("siege", "factory")
    )
}

pub fn attack_damage(kind: &str, target: &str, damage: i32) -> i32 {
    if kind == "siege" && is_building(target) {
        damage * 3
    } else if kind == "siege" && target == "scout" {
        damage / 2
    } else if kind == "soldier" && target == "scout" {
        damage * 2
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
    pub cost: u32,
    pub training_ticks: u64,
}

pub fn stats(kind: &str) -> Option<Stats> {
    match kind {
        "research_weapons" | "research_armor" | "research_logistics" => Some(Stats {
            hp: 0,
            speed: 0.0,
            range: 0.0,
            damage: 0,
            cooldown: 0,
            cost: 150,
            training_ticks: 300,
        }),
        "barracks" | "factory" | "turret" | "outpost" | "lab" => {
            let (hp, cost, training_ticks) = match kind {
                "barracks" => (700, 150, 160),
                "factory" => (900, 250, 240),
                "turret" => (500, 125, 140),
                "outpost" => (650, 100, 120),
                _ => (650, 200, 200),
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
            cost: 80,
            training_ticks: 70,
        }),
        "siege" => Some(Stats {
            hp: 220,
            speed: 65.0,
            range: 260.0,
            damage: 32,
            cooldown: 50,
            cost: 200,
            training_ticks: 160,
        }),
        "hq" => Some(Stats {
            hp: 1200,
            speed: 0.0,
            range: 0.0,
            damage: 0,
            cooldown: 0,
            cost: 0,
            training_ticks: 0,
        }),
        "worker" => Some(Stats {
            hp: 60,
            speed: 100.0,
            range: 0.0,
            damage: 0,
            cooldown: 0,
            cost: 50,
            training_ticks: 60,
        }),
        "soldier" => Some(Stats {
            hp: 140,
            speed: 110.0,
            range: 105.0,
            damage: 18,
            cooldown: 12,
            cost: 100,
            training_ticks: 100,
        }),
        _ => None,
    }
}

pub fn validate_position(x: f32, y: f32) -> Result<(), String> {
    if !x.is_finite()
        || !y.is_finite()
        || !(16.0..=WORLD_SIZE - 16.0).contains(&x)
        || !(16.0..=WORLD_SIZE - 16.0).contains(&y)
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
            assert!(validate_position(x, y).is_err());
        }
        assert!(validate_position(16.0, WORLD_SIZE - 16.0).is_ok());
    }

    #[test]
    fn only_known_unit_types_have_stats() {
        assert!(stats("catapult").is_none());
        assert!(stats("anything").is_none());
        assert_eq!(stats("worker").unwrap().cost, 50);
    }

    #[test]
    fn roster_has_distinct_roles_and_production_requirements() {
        assert!(stats("scout").unwrap().speed > stats("soldier").unwrap().speed);
        assert!(stats("siege").unwrap().range > stats("turret").unwrap().range);
        assert_eq!(attack_damage("siege", "hq", 32), 96);
        assert_eq!(attack_damage("soldier", "scout", 18), 36);
        assert!(producer("siege", "factory"));
        assert!(!producer("siege", "hq"));
        for kind in ["barracks", "factory", "turret", "outpost", "lab"] {
            assert!(is_building(kind));
            assert!(stats(kind).unwrap().cost > 0);
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

    #[test]
    fn ruleset_version_is_recorded_and_positive() {
        assert_eq!(RULESET_VERSION, 1);
        assert!(RULESET_VERSION > 0);
    }
}
