use crate::{distance, validate_world_size, ResourceKind, NAV_CELL_SIZE};
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
    /// Which currency this site yields. Required, never defaulted: a map author
    /// must state it, because it decides what the deposit is worth.
    pub kind: ResourceKind,
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

/// Frozen identity of the map a match is played on: the authored ID, the
/// authored version, and a content hash over the parsed geometry. The hash is
/// what catches an edited map republished under an unchanged version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MapIdentity {
    pub id: String,
    pub version: u32,
    pub hash: u64,
}

/// FNV-1a over an explicit canonical encoding. Deliberately not
/// `std::hash::Hasher`/`DefaultHasher`: those carry no cross-process or
/// cross-version stability guarantee, and this value is written into match
/// records and compared between server and client.
struct ContentHasher(u64);

impl ContentHasher {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    fn new() -> Self {
        Self(Self::OFFSET_BASIS)
    }

    fn bytes(&mut self, bytes: &[u8]) -> &mut Self {
        for byte in bytes {
            self.0 ^= *byte as u64;
            self.0 = self.0.wrapping_mul(Self::PRIME);
        }
        self
    }

    fn u32(&mut self, value: u32) -> &mut Self {
        self.bytes(&value.to_le_bytes())
    }

    fn u64(&mut self, value: u64) -> &mut Self {
        self.bytes(&value.to_le_bytes())
    }

    /// Hashes the exact IEEE-754 bit pattern, so the result is independent of
    /// formatting, rounding and platform float printing.
    fn f32(&mut self, value: f32) -> &mut Self {
        self.bytes(&value.to_bits().to_le_bytes())
    }

    /// Length-prefixed, so neither concatenation nor reordering of adjacent
    /// fields can produce the same byte stream.
    fn text(&mut self, value: &str) -> &mut Self {
        self.u64(value.len() as u64).bytes(value.as_bytes())
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

impl MapDefinition {
    /// Deterministic content hash over the parsed definition. Stable across
    /// processes, runs, builds and platforms: same geometry in, same number out.
    pub fn content_hash(&self) -> u64 {
        let mut hasher = ContentHasher::new();
        // Domain tag: bump the suffix if the encoding below ever changes. v2
        // added the per-deposit resource kind.
        hasher.text("rts-map-v2");
        hasher.text(&self.id);
        hasher.u32(self.version);
        hasher.f32(self.size);
        hasher.u64(self.starts.len() as u64);
        for start in &self.starts {
            hasher.f32(start[0]).f32(start[1]);
        }
        hasher.u64(self.deposits.len() as u64);
        for deposit in &self.deposits {
            hasher
                .u32(deposit.id)
                .f32(deposit.x)
                .f32(deposit.y)
                .u32(deposit.amount)
                .text(deposit.kind.as_str());
        }
        hasher.u64(self.terrain.len() as u64);
        for rect in &self.terrain {
            for value in rect {
                hasher.f32(*value);
            }
        }
        hasher.finish()
    }

    /// ID, version and content hash together — what a match freezes at creation.
    pub fn identity(&self) -> MapIdentity {
        MapIdentity {
            id: self.id.clone(),
            version: self.version,
            hash: self.content_hash(),
        }
    }

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
        // The extent is the map's own, inside a bounded range, and a whole
        // number of navigation cells so the static BFS grid divides evenly.
        validate_world_size(self.size)?;
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
        let cell_size = NAV_CELL_SIZE;
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
        assert_eq!(map.version, 2);
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
        assert!(map
            .deposits
            .iter()
            .filter(|deposit| deposit.kind == ResourceKind::Material)
            .all(|deposit| deposit.amount == 4000));
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

    /// Catalyst must be worth fighting over: exactly the two sites flanking the
    /// centre, each smaller than a material deposit, each far from every start.
    #[test]
    fn only_the_two_central_sites_yield_catalyst() {
        let map = default_map();
        assert_eq!(
            map.deposits
                .iter()
                .filter(|deposit| deposit.kind == ResourceKind::Catalyst)
                .map(|deposit| (deposit.id, deposit.x, deposit.y, deposit.amount))
                .collect::<Vec<_>>(),
            [(7, 600.0, 800.0, 1200), (8, 1000.0, 800.0, 1200)]
        );
        assert_eq!(
            map.deposits
                .iter()
                .filter(|deposit| deposit.kind == ResourceKind::Material)
                .count(),
            6
        );
        let centre = map.size / 2.0;
        for deposit in &map.deposits {
            let to_centre = distance(deposit.x, deposit.y, centre, centre);
            let to_nearest_start = map
                .starts
                .iter()
                .map(|start| distance(deposit.x, deposit.y, start[0], start[1]))
                .fold(f32::INFINITY, f32::min);
            if deposit.kind == ResourceKind::Catalyst {
                assert!(to_centre <= 200.0, "catalyst {} is not central", deposit.id);
                assert!(
                    to_nearest_start > 600.0,
                    "catalyst {} is too safe",
                    deposit.id
                );
                assert!(deposit.amount < 4000);
            }
        }
    }

    /// Pinned so that any edit to the built-in skirmish geometry fails loudly
    /// here instead of silently changing what running matches were created
    /// against. If this fires because the change was intended, bump
    /// `MapDefinition.version` in shared/maps/skirmish.json and re-pin.
    const SKIRMISH_CONTENT_HASH: u64 = 0x4756_989d_5a0d_f082;

    /// The map new matches are created on. `default_map()` stays on skirmish so
    /// the simulation tests keep their small, coordinate-stable world; this is
    /// what a player actually gets.
    #[test]
    fn matches_are_created_on_a_four_base_melee_map_with_no_resources_in_the_centre() {
        let map = by_id(DEFAULT_MATCH_MAP).expect("the configured match map must exist");
        assert_eq!(map.id, "crossfire");
        assert_eq!(map.size, 3200.0);
        assert_eq!(map.starts.len(), 4);
        assert_eq!(map.deposits.len(), 152);
        assert_eq!(map.terrain.len(), 28);
        map.validate().expect("the match map must pass validation");

        let catalyst = map
            .deposits
            .iter()
            .filter(|d| d.kind == ResourceKind::Catalyst)
            .count();
        assert_eq!(catalyst, 32, "eight catalyst sites per player, two per base");
        assert_eq!(map.deposits.len() - catalyst, 120);

        // Catalyst is per-base, like gas, and the centre is fought over for
        // position rather than income: nothing may be mined near the middle.
        let centre = map.size / 2.0;
        let nearest = map
            .deposits
            .iter()
            .map(|d| distance(centre, centre, d.x, d.y))
            .fold(f32::MAX, f32::min);
        assert!(
            nearest > 700.0,
            "a deposit sits {nearest:.0} units from the centre; the centre must carry no resources"
        );
    }

    #[test]
    fn a_match_map_id_always_resolves_to_the_same_definition() {
        assert_eq!(by_id("crossfire").unwrap().id, "crossfire");
        assert_eq!(by_id("skirmish").unwrap().id, "skirmish");
        assert!(by_id("no-such-map").is_none());
        // A frozen id must keep resolving to one fixed map for the match's life.
        assert_eq!(
            by_id("crossfire").unwrap().content_hash(),
            by_id("crossfire").unwrap().content_hash()
        );
    }

    #[test]
    fn built_in_map_hash_is_pinned() {
        let map = default_map();
        assert_eq!(
            map.content_hash(),
            SKIRMISH_CONTENT_HASH,
            "built-in skirmish geometry changed; actual hash {:#018x}",
            map.content_hash()
        );
        assert_eq!(
            map.identity(),
            MapIdentity {
                id: "skirmish".into(),
                version: 2,
                hash: SKIRMISH_CONTENT_HASH,
            }
        );
    }

    #[test]
    fn content_hash_is_deterministic_across_parses() {
        let source = include_str!("../../shared/maps/skirmish.json");
        let first = MapDefinition::parse(source).unwrap();
        let second = MapDefinition::parse(source).unwrap();
        assert_eq!(first.content_hash(), second.content_hash());
        assert_eq!(first.content_hash(), default_map().content_hash());
        // Whitespace and integer/float spelling are not part of the identity.
        let reformatted = source.replace("\n", " ").replace("1600", "1600.0");
        assert_eq!(
            MapDefinition::parse(&reformatted).unwrap().content_hash(),
            first.content_hash()
        );
    }

    #[test]
    fn content_hash_is_value_sensitive() {
        let base = default_map().clone();
        let mut changed = base.clone();
        changed.deposits[3].amount += 1;
        assert_ne!(changed.content_hash(), base.content_hash());

        changed = base.clone();
        changed.deposits[0].x += 0.001;
        assert_ne!(changed.content_hash(), base.content_hash());

        // The currency a deposit yields is part of the frozen map content.
        changed = base.clone();
        changed.deposits[0].kind = ResourceKind::Catalyst;
        assert_ne!(changed.content_hash(), base.content_hash());
        changed = base.clone();
        changed.deposits[6].kind = ResourceKind::Material;
        assert_ne!(changed.content_hash(), base.content_hash());

        changed = base.clone();
        changed.terrain[2][3] = 161.0;
        assert_ne!(changed.content_hash(), base.content_hash());

        changed = base.clone();
        changed.terrain.push([100.0, 100.0, 10.0, 10.0]);
        assert_ne!(changed.content_hash(), base.content_hash());

        changed = base.clone();
        changed.version += 1;
        assert_ne!(changed.content_hash(), base.content_hash());

        changed = base.clone();
        changed.id = "skirmish-2".into();
        assert_ne!(changed.content_hash(), base.content_hash());
    }

    #[test]
    fn content_hash_is_order_sensitive() {
        let base = default_map().clone();
        let mut swapped = base.clone();
        swapped.deposits.swap(0, 1);
        assert_ne!(swapped.content_hash(), base.content_hash());

        swapped = base.clone();
        swapped.starts.swap(1, 2);
        assert_ne!(swapped.content_hash(), base.content_hash());

        swapped = base.clone();
        swapped.terrain.swap(0, 3);
        assert_ne!(swapped.content_hash(), base.content_hash());
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
                (node.id, node.x, node.y, node.amount, node.kind),
                (
                    deposit.id,
                    deposit.x,
                    deposit.y,
                    deposit.amount,
                    deposit.kind
                )
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
        // Not a whole number of navigation cells.
        invalid.size = 2010.0;
        assert!(invalid.validate().is_err());
        invalid = valid.clone();
        // Past the ceiling.
        invalid.size = 8000.0;
        assert!(invalid.validate().is_err());
        invalid = valid.clone();
        invalid.terrain[0][2] = -10.0;
        assert!(invalid.validate().is_err());
        invalid = valid;
        invalid.terrain[0][0] = f32::NAN;
        assert!(invalid.validate().is_err());
    }

    /// The size rule is a bounded range, not a single value and not "anything".
    /// Checked through `validate` so the message a map author sees is the one
    /// under test.
    #[test]
    fn map_size_is_a_bounded_range_rather_than_a_single_value() {
        let sized = |size: f32| {
            let mut map = default_map().clone();
            map.size = size;
            map.validate()
        };
        // The floor is the built-in map, so it still validates unchanged.
        assert!(sized(crate::MIN_WORLD_SIZE).is_ok());
        // A larger extent only adds empty ground around the same geometry.
        assert!(sized(2400.0).is_ok());
        assert!(sized(4080.0).is_ok());

        assert!(sized(1560.0).unwrap_err().contains("between"));
        assert!(sized(4120.0).unwrap_err().contains("between"));
        assert!(sized(3210.0).unwrap_err().contains("navigation cell"));
        assert!(sized(0.0).unwrap_err().contains("positive finite"));
        assert!(sized(f32::NAN).unwrap_err().contains("positive finite"));
        assert!(sized(f32::INFINITY).unwrap_err().contains("positive finite"));
    }

    /// The 3200 melee proposal, parsed and validated by the real validator —
    /// including `validate_routes`, whose BFS is the expensive part and the
    /// part an external re-implementation is least able to stand in for.
    ///
    /// This map is a **fixture**, not the built-in map: `default_map` must stay
    /// `skirmish` until the client can draw a variable extent.
    #[test]
    fn a_3200_map_parses_validates_and_is_statically_reachable() {
        let map = MapDefinition::parse(include_str!("../../shared/maps/quadrille.json"))
            .expect("quadrille must pass the real validator");
        assert_eq!(map.id, "quadrille");
        assert_eq!(map.size, 3200.0);
        assert_eq!(map.starts.len(), 4);
        assert_eq!(map.deposits.len(), 81);
        assert_eq!(map.terrain.len(), 24);
        assert_eq!(
            map.deposits
                .iter()
                .filter(|deposit| deposit.kind == ResourceKind::Catalyst)
                .count(),
            17
        );
        // `parse` already ran it; assert it explicitly so a future refactor that
        // drops the route check out of `validate` fails here.
        assert_eq!(map.validate_routes(), Ok(()));
        // Everything outside the 1600 legacy extent would have been rejected
        // before this increment.
        assert!(map
            .deposits
            .iter()
            .any(|deposit| deposit.x > crate::WORLD_SIZE || deposit.y > crate::WORLD_SIZE));
        // Loading it did not change which map the engine boots on.
        assert_eq!(default_map().id, "skirmish");
        assert_eq!(default_map().size, crate::WORLD_SIZE);
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
            "\"version\": 2",
            "\"version\": 2, \"typo\": true",
            1,
        );
        assert!(MapDefinition::parse(&source).is_err());
    }

    #[test]
    fn deposits_must_declare_a_known_resource_kind() {
        let source = include_str!("../../shared/maps/skirmish.json");
        // Omitted entirely: no silent default.
        let missing = source.replacen(", \"kind\": \"material\" }", " }", 1);
        assert!(MapDefinition::parse(&missing).is_err());
        // Misspelled: rejected rather than coerced.
        let unknown = source.replacen("\"catalyst\"", "\"Catalyst\"", 1);
        assert!(MapDefinition::parse(&unknown).is_err());
        let invented = source.replacen("\"catalyst\"", "\"plasma\"", 1);
        assert!(MapDefinition::parse(&invented).is_err());
    }
}

/// The melee map new matches are created on: four spawns, four bases each, and
/// a centre that carries no resources at all.
pub fn crossfire_map() -> &'static MapDefinition {
    static MAP: OnceLock<MapDefinition> = OnceLock::new();
    MAP.get_or_init(|| {
        MapDefinition::parse(include_str!("../../shared/maps/crossfire.json"))
            .expect("valid built-in crossfire map")
    })
}

/// The map a newly created match is played on.
pub const DEFAULT_MATCH_MAP: &str = "crossfire";

/// Resolves a frozen `Room.map_id` back to its definition. A match records the
/// map it was created on and must keep resolving to that same map for its whole
/// life, so this never falls back to a different one.
pub fn by_id(id: &str) -> Option<&'static MapDefinition> {
    match id {
        "crossfire" => Some(crossfire_map()),
        "skirmish" => Some(default_map()),
        _ => None,
    }
}
