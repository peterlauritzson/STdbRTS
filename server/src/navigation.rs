use crate::{advance, distance, is_building, simulation::Entity};
use pathfinding::prelude::astar;
use std::sync::OnceLock;

const CELL: f32 = 40.0;
const SIDE: i32 = 40;

pub fn terrain() -> &'static Vec<[f32; 4]> {
    static TERRAIN: OnceLock<Vec<[f32; 4]>> = OnceLock::new();
    TERRAIN.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/terrain.json"))
            .expect("valid shared terrain")
    })
}

pub fn terrain_free(x: f32, y: f32, margin: f32) -> bool {
    !terrain().iter().any(|rect| {
        x > rect[0] - margin
            && x < rect[0] + rect[2] + margin
            && y > rect[1] - margin
            && y < rect[1] + rect[3] + margin
    })
}

pub fn line_of_sight(x: f32, y: f32, target_x: f32, target_y: f32) -> bool {
    let steps = (distance(x, y, target_x, target_y) / 8.0).ceil().max(1.0) as usize;
    (0..=steps).all(|index| {
        let fraction = index as f32 / steps as f32;
        terrain_free(
            x + (target_x - x) * fraction,
            y + (target_y - y) * fraction,
            0.0,
        )
    })
}

pub struct Navigation {
    buildings: Vec<(f32, f32)>,
    blocked: Vec<bool>,
}

impl Navigation {
    pub fn new(units: &[Entity]) -> Self {
        let mut result = Self {
            buildings: units
                .iter()
                .filter(|unit| is_building(&unit.kind))
                .map(|unit| (unit.x, unit.y))
                .collect(),
            blocked: vec![false; (SIDE * SIDE) as usize],
        };
        for row in 0..SIDE {
            for column in 0..SIDE {
                let (x, y) = Self::center((column, row));
                result.blocked[(row * SIDE + column) as usize] = !result.free(x, y);
            }
        }
        result
    }

    pub fn free(&self, x: f32, y: f32) -> bool {
        (16.0..=1584.0).contains(&x)
            && (16.0..=1584.0).contains(&y)
            && terrain_free(x, y, 12.0)
            && !self
                .buildings
                .iter()
                .any(|(other_x, other_y)| distance(x, y, *other_x, *other_y) < 44.0)
    }

    fn center(cell: (i32, i32)) -> (f32, f32) {
        ((cell.0 as f32 + 0.5) * CELL, (cell.1 as f32 + 0.5) * CELL)
    }

    fn clear(&self, x: f32, y: f32, target_x: f32, target_y: f32) -> bool {
        let steps = (distance(x, y, target_x, target_y) / 8.0).ceil().max(1.0) as usize;
        (1..=steps).all(|index| {
            let fraction = index as f32 / steps as f32;
            self.free(x + (target_x - x) * fraction, y + (target_y - y) * fraction)
        })
    }

    pub fn advance(
        &self,
        x: &mut f32,
        y: &mut f32,
        target_x: f32,
        target_y: f32,
        speed: f32,
        range: f32,
    ) -> bool {
        let remaining = distance(*x, *y, target_x, target_y);
        if remaining <= range + 0.01 {
            return true;
        }
        let approach = |from_x: f32, from_y: f32| {
            let gap = distance(from_x, from_y, target_x, target_y).max(0.01);
            (
                target_x + (from_x - target_x) / gap * range,
                target_y + (from_y - target_y) / gap * range,
            )
        };
        let (end_x, end_y) = approach(*x, *y);
        if self.clear(*x, *y, end_x, end_y) {
            return advance(x, y, target_x, target_y, speed, range);
        }
        let start = ((*x / CELL) as i32, (*y / CELL) as i32);
        let result = astar(
            &start,
            |cell| {
                [(1, 0), (-1, 0), (0, 1), (0, -1)]
                    .into_iter()
                    .filter_map(|(offset_x, offset_y)| {
                        let next = (cell.0 + offset_x, cell.1 + offset_y);
                        if next.0 < 0
                            || next.0 >= SIDE
                            || next.1 < 0
                            || next.1 >= SIDE
                            || self.blocked[(next.1 * SIDE + next.0) as usize]
                        {
                            return None;
                        }
                        let (from_x, from_y) = Self::center(*cell);
                        let (next_x, next_y) = Self::center(next);
                        self.clear(from_x, from_y, next_x, next_y)
                            .then_some((next, 1u32))
                    })
                    .collect::<Vec<_>>()
            },
            |cell| {
                let (center_x, center_y) = Self::center(*cell);
                ((distance(center_x, center_y, target_x, target_y) - range - CELL * 1.5).max(0.0)
                    / CELL) as u32
            },
            |cell| {
                let (center_x, center_y) = Self::center(*cell);
                let (end_x, end_y) = approach(center_x, center_y);
                distance(center_x, center_y, target_x, target_y) <= range + CELL * 1.5
                    && self.clear(center_x, center_y, end_x, end_y)
            },
        );
        if let Some((path, _)) = result {
            let next = path.get(1).copied().unwrap_or(start);
            let (mut next_x, mut next_y) = Self::center(next);
            if !self.clear(*x, *y, next_x, next_y) {
                (next_x, next_y) = Self::center(start);
            }
            if self.clear(*x, *y, next_x, next_y) {
                advance(x, y, next_x, next_y, speed, 0.0);
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_around_terrain_without_crossing_it() {
        let navigation = Navigation::new(&[]);
        let (mut x, mut y) = (500.0, 680.0);
        for _ in 0..300 {
            navigation.advance(&mut x, &mut y, 800.0, 680.0, 110.0, 0.0);
            assert!(navigation.free(x, y));
        }
        assert!(distance(x, y, 800.0, 680.0) < 1.0);
        assert!(!line_of_sight(500.0, 680.0, 800.0, 680.0));
    }

    #[test]
    fn routes_around_buildings_and_reaches_deposit_range() {
        let world = crate::simulation::World::new(&[0, 1]);
        let navigation = Navigation::new(&world.units);
        let (mut x, mut y) = (100.0, 220.0);
        for _ in 0..150 {
            navigation.advance(&mut x, &mut y, 340.0, 220.0, 100.0, 0.0);
        }
        assert!(distance(x, y, 340.0, 220.0) < 1.0);
        for _ in 0..100 {
            navigation.advance(&mut x, &mut y, 220.0, 220.0, 100.0, 45.0);
        }
        assert!((distance(x, y, 220.0, 220.0) - 45.0).abs() < 0.1);
    }
}
