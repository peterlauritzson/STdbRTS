pub mod maps;
pub mod navigation;
pub mod simulation;

pub const TICKS_PER_SECOND: u64 = 20;
pub const COMMAND_DELAY: u64 = 20;
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
        assert_eq!(execution_tick(42, COMMAND_DELAY), Ok(62));
        assert!(execution_tick(u64::MAX, COMMAND_DELAY).is_err());
    }
}
