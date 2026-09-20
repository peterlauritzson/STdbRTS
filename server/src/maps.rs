use crate::{distance, WORLD_SIZE};
use pathfinding::prelude::bfs_reach;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::sync::OnceLock;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Deposit {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub amount: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MapDefinition {
    pub id: String,
    pub version: u32,
    pub size: f32,
    pub starts: Vec<[f32; 2]>,
    pub deposits: Vec<Deposit>,
    pub terrain: Vec<[f32; 4]>,
}

impl MapDefinition {
    pub fn parse(source: &str) -> Result<Self, String> {
        let map: Self = serde_json::from_str(source).map_err(|error| error.to_string())?;
        map.validate()?;
        Ok(map)
    }

    pub fn terrain_free(&self, x: f32, y: f32, margin: f32) -> bool {
        !self.terrain.iter().any(|rect| {
            x > rect[0] - margin
                && x < rect[0] + rect[2] + margin
                && y > rect[1] - margin
                && y < rect[1] + rect[3] + margin
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 64
            || !self
                .id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || self.version == 0
        {
            return Err("Map needs a stable lowercase ID and positive version".into());
        }
        if self.size != WORLD_SIZE {
            return Err("Only 1600-unit square maps are currently supported".into());
        }
        if self.starts.len() != 4
            || self.deposits.is_empty()
            || self.deposits.len() > 256
            || self.terrain.len() > 256
        {
            return Err(
                "Map requires four starts, 1-256 deposits, and at most 256 obstacles".into(),
            );
        }
        for rect in &self.terrain {
            if rect.iter().any(|value| !value.is_finite())
                || rect[0] < 0.0
                || rect[1] < 0.0
                || rect[2] <= 0.0
                || rect[3] <= 0.0
                || rect[0] + rect[2] > self.size
                || rect[1] + rect[3] > self.size
            {
                return Err("Terrain rectangle is invalid or outside the map".into());
            }
        }
        let inside = |x: f32, y: f32, margin: f32| {
            x.is_finite()
                && y.is_finite()
                && (margin..=self.size - margin).contains(&x)
                && (margin..=self.size - margin).contains(&y)
        };
        for (index, &[x, y]) in self.starts.iter().enumerate() {
            if !inside(x, y, 60.0)
                || !self.terrain_free(x, y, 50.0)
                || self.starts[..index]
                    .iter()
                    .any(|other| distance(x, y, other[0], other[1]) < 220.0)
            {
                return Err("Starting hubs must be clear, separated, and inside the map".into());
            }
            for (offset_x, offset_y) in [(55.0, 0.0), (0.0, 55.0), (55.0, 55.0)] {
                if !inside(x + offset_x, y + offset_y, 16.0)
                    || !self.terrain_free(x + offset_x, y + offset_y, 12.0)
                {
                    return Err("Starting units are blocked or outside the map".into());
                }
            }
        }
        let mut ids = BTreeSet::new();
        for (index, deposit) in self.deposits.iter().enumerate() {
            if deposit.id == 0
                || !ids.insert(deposit.id)
                || deposit.amount == 0
                || !inside(deposit.x, deposit.y, 32.0)
                || !self.terrain_free(deposit.x, deposit.y, 32.0)
                || self
                    .starts
                    .iter()
                    .any(|start| distance(deposit.x, deposit.y, start[0], start[1]) < 110.0)
                || self.deposits[..index]
                    .iter()
                    .any(|other| distance(deposit.x, deposit.y, other.x, other.y) < 64.0)
            {
                return Err(
                    "Deposits need unique positive IDs, stock, and clear separated sites".into(),
                );
            }
        }
        self.validate_routes()
    }

    fn validate_routes(&self) -> Result<(), String> {
        let cell_size = 40.0;
        let side = (self.size / cell_size) as i32;
        let center = |cell: (i32, i32)| {
            (
                (cell.0 as f32 + 0.5) * cell_size,
                (cell.1 as f32 + 0.5) * cell_size,
            )
        };
        let clear_segment = |from_x: f32, from_y: f32, to_x: f32, to_y: f32| {
            let steps = (distance(from_x, from_y, to_x, to_y) / 8.0).ceil().max(1.0) as usize;
            (0..=steps).all(|index| {
                let fraction = index as f32 / steps as f32;
                self.terrain_free(
                    from_x + (to_x - from_x) * fraction,
                    from_y + (to_y - from_y) * fraction,
                    12.0,
                )
            })
        };
        let start = (
            ((self.starts[0][0] + 55.0) / cell_size) as i32,
            (self.starts[0][1] / cell_size) as i32,
        );
        let reachable: BTreeSet<_> = bfs_reach(start, |cell| {
            let (from_x, from_y) = center(*cell);
            [(1, 0), (-1, 0), (0, 1), (0, -1)]
                .into_iter()
                .filter_map(|(offset_x, offset_y)| {
                    let next = (cell.0 + offset_x, cell.1 + offset_y);
                    if next.0 < 0 || next.1 < 0 || next.0 >= side || next.1 >= side {
                        return None;
                    }
                    let (to_x, to_y) = center(next);
                    clear_segment(from_x, from_y, to_x, to_y).then_some(next)
                })
                .collect::<Vec<_>>()
        })
        .collect();
        let accessible = |x: f32, y: f32| {
            reachable.iter().any(|cell| {
                let (center_x, center_y) = center(*cell);
                distance(center_x, center_y, x, y) <= cell_size * 1.5
                    && clear_segment(center_x, center_y, x, y)
            })
        };
        if self
            .starts
            .iter()
            .any(|start| !accessible(start[0] + 55.0, start[1]))
        {
            return Err("Starting worker exits must share a connected terrain route".into());
        }
        if self
            .deposits
            .iter()
            .any(|deposit| !accessible(deposit.x, deposit.y))
        {
            return Err("Every deposit must be reachable from the starting region".into());
        }
        Ok(())
    }
}

pub fn default_map() -> &'static MapDefinition {
    static MAP: OnceLock<MapDefinition> = OnceLock::new();
    MAP.get_or_init(|| {
        MapDefinition::parse(include_str!("../../shared/maps/skirmish.json"))
            .expect("valid built-in skirmish map")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_map_preserves_the_existing_layout() {
        let map = default_map();
        assert_eq!(map.id, "skirmish");
        assert_eq!(map.version, 1);
        assert_eq!(
            map.starts,
            [
                [220.0, 220.0],
                [1380.0, 1380.0],
                [1380.0, 220.0],
                [220.0, 1380.0]
            ]
        );
        assert_eq!(map.deposits.len(), 8);
        assert!(map.deposits.iter().all(|deposit| deposit.amount == 4000));
        assert_eq!(
            map.terrain,
            [
                [560.0, 640.0, 160.0, 80.0],
                [880.0, 880.0, 160.0, 80.0],
                [640.0, 880.0, 80.0, 160.0],
                [880.0, 560.0, 80.0, 160.0],
            ]
        );
        assert_eq!(
            map.deposits
                .iter()
                .map(|deposit| (deposit.id, deposit.x, deposit.y))
                .collect::<Vec<_>>(),
            [
                (1, 360.0, 360.0),
                (2, 1240.0, 1240.0),
                (3, 1240.0, 360.0),
                (4, 360.0, 1240.0),
                (5, 800.0, 600.0),
                (6, 800.0, 1000.0),
                (7, 600.0, 800.0),
                (8, 1000.0, 800.0),
            ]
        );
    }

    #[test]
    fn world_bootstrap_uses_map_starts_and_deposits() {
        let world = crate::simulation::World::new(&[3, 1, 0, 2]);
        let map = default_map();
        for (slot, start) in map.starts.iter().enumerate() {
            let hub = world
                .units
                .iter()
                .find(|unit| unit.owner == slot as u8 && unit.kind == "hq")
                .unwrap();
            assert_eq!([hub.x, hub.y], *start);
            assert_eq!(hub.id, slot as u32 * 4 + 1);
        }
        assert_eq!(world.nodes.len(), map.deposits.len());
        for (node, deposit) in world.nodes.iter().zip(&map.deposits) {
            assert_eq!(
                (node.id, node.x, node.y, node.amount),
                (deposit.id, deposit.x, deposit.y, deposit.amount)
            );
        }
    }

    #[test]
    fn rejects_invalid_identity_dimensions_and_geometry() {
        let valid = default_map().clone();
        let mut invalid = valid.clone();
        invalid.id = "../map".into();
        assert!(invalid.validate().is_err());
        invalid = valid.clone();
        invalid.version = 0;
        assert!(invalid.validate().is_err());
        invalid = valid.clone();
        invalid.size = 2000.0;
        assert!(invalid.validate().is_err());
        invalid = valid.clone();
        invalid.terrain[0][2] = -10.0;
        assert!(invalid.validate().is_err());
        invalid = valid;
        invalid.terrain[0][0] = f32::NAN;
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn rejects_blocked_overlapping_or_missing_starts() {
        let mut map = default_map().clone();
        map.starts[0] = [600.0, 680.0];
        assert!(map.validate().is_err());
        map = default_map().clone();
        map.starts[1] = map.starts[0];
        assert!(map.validate().is_err());
        map = default_map().clone();
        map.terrain.push([270.0, 270.0, 20.0, 20.0]);
        assert!(map.validate().is_err());
        map = default_map().clone();
        map.starts.pop();
        assert!(map.validate().is_err());
    }

    #[test]
    fn rejects_separated_starts_and_enclosed_deposits() {
        let mut map = default_map().clone();
        map.terrain.push([780.0, 0.0, 40.0, 1600.0]);
        map.deposits.retain(|deposit| deposit.x != 800.0);
        assert!(map
            .validate()
            .unwrap_err()
            .contains("connected terrain route"));
        map = default_map().clone();
        map.terrain.extend([
            [290.0, 290.0, 20.0, 140.0],
            [410.0, 290.0, 20.0, 140.0],
            [290.0, 290.0, 140.0, 20.0],
            [290.0, 410.0, 140.0, 20.0],
        ]);
        assert!(map
            .validate()
            .unwrap_err()
            .contains("Every deposit must be reachable"));
    }

    #[test]
    fn rejects_thin_walls_between_grid_centers() {
        let mut map = default_map().clone();
        map.terrain.push([798.0, 0.0, 4.0, 1600.0]);
        map.deposits.retain(|deposit| deposit.x != 800.0);
        assert!(map
            .validate()
            .unwrap_err()
            .contains("connected terrain route"));
    }

    #[test]
    fn rejects_invalid_deposits_and_unknown_json_fields() {
        let mut map = default_map().clone();
        map.deposits[1].id = map.deposits[0].id;
        assert!(map.validate().is_err());
        map = default_map().clone();
        map.deposits[0].amount = 0;
        assert!(map.validate().is_err());
        map = default_map().clone();
        map.deposits[0].x = f32::INFINITY;
        assert!(map.validate().is_err());
        let source = include_str!("../../shared/maps/skirmish.json").replacen(
            "\"version\": 1",
            "\"version\": 1, \"typo\": true",
            1,
        );
        assert!(MapDefinition::parse(&source).is_err());
    }
}
