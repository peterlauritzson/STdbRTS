use crate::maps::MapDefinition;
use crate::{advance, distance, is_building, simulation::Entity, NAV_CELL_SIZE, TICKS_PER_SECOND};
use pathfinding::prelude::astar;

/// Side of one routing cell. The same pitch the static route check in `maps.rs`
/// walks, so a map that passes validation is a map this grid can address.
///
/// The *number* of cells is not a constant: it comes from the map being
/// simulated (`map.size / CELL`), which is why nothing here may be written
/// against the built-in 1600 extent.
const CELL: f32 = NAV_CELL_SIZE;

/// Distance a unit must keep from the map edge. The same margin
/// `validate_position` enforces on an ordered destination, so a legal order is
/// always to somewhere the pathfinder agrees a unit may stand.
const EDGE_MARGIN: f32 = 16.0;

/// Spacing of the samples that check a *single tick* of motion.
///
/// A tick moves a unit `speed / TICKS_PER_SECOND` units — about five for a
/// worker — so the long-range `clear()` sampling at eight units can step clean
/// over a blocked sliver that the unit lands in. A step is short enough that
/// sampling it finely costs almost nothing.
const STEP_SAMPLE: f32 = 3.0;

/// Directions to try when the way forward is blocked, as (cos, sin) of the turn
/// applied to the heading: 45, 90 and 135 degrees to either side, nearest turn
/// first, clockwise before counter-clockwise so the choice is deterministic.
///
/// Literal cosines rather than `f32::sin_cos` calls: the simulation is
/// lock-stepped, and a table cannot drift between two builds of libm.
const TURNS: [(f32, f32); 6] = [
    (0.707_106_77, 0.707_106_77),
    (0.707_106_77, -0.707_106_77),
    (0.0, 1.0),
    (0.0, -1.0),
    (-0.707_106_77, 0.707_106_77),
    (-0.707_106_77, -0.707_106_77),
];

/// Rings searched when walking a stranded unit back out into legal ground,
/// nearest first, so a unit nudged a hair into a margin steps a hair out of it.
/// The widest ring clears the half-extent of a large terrain rectangle, so even
/// a unit buried in the middle of a rock is recovered rather than left there.
const ESCAPE_RINGS: [f32; 7] = [6.0, 12.0, 20.0, 32.0, 48.0, 76.0, 120.0];

/// The eight compass directions tried on each ring, in a fixed order.
const ESCAPE_DIRECTIONS: [(f32, f32); 8] = [
    (1.0, 0.0),
    (-1.0, 0.0),
    (0.0, 1.0),
    (0.0, -1.0),
    (0.707_106_77, 0.707_106_77),
    (0.707_106_77, -0.707_106_77),
    (-0.707_106_77, 0.707_106_77),
    (-0.707_106_77, -0.707_106_77),
];

/// Whether a straight line between two points is free of the *simulated* map's
/// terrain — what a weapon needs to know before it fires.
///
/// The map is an argument, never `maps::default_map()`: a shot resolved on a
/// map other than skirmish used to be tested against skirmish's rectangles,
/// so units shot through walls that were there and were stopped by walls that
/// were not.
pub fn line_of_sight(
    map: &MapDefinition,
    x: f32,
    y: f32,
    target_x: f32,
    target_y: f32,
) -> bool {
    let steps = (distance(x, y, target_x, target_y) / 8.0).ceil().max(1.0) as usize;
    (0..=steps).all(|index| {
        let fraction = index as f32 / steps as f32;
        map.terrain_free(
            x + (target_x - x) * fraction,
            y + (target_y - y) * fraction,
            0.0,
        )
    })
}

/// The routing grid for **one map**.
///
/// Everything dimensional is derived from the `MapDefinition` handed to
/// `new`: the grid is `map.size / CELL` cells on a side, the legal band is
/// `EDGE_MARGIN ..= map.size - EDGE_MARGIN`, and terrain is that map's
/// terrain. Nothing in here consults the default map, so a match on a 3200
/// map is routed on a 3200 grid rather than through a 1600 window with every
/// unit outside it frozen.
pub struct Navigation<'a> {
    map: &'a MapDefinition,
    /// Cells per row and per column — `map.size / CELL`, cached because the
    /// A* neighbour test reads it once per candidate.
    side: i32,
    buildings: Vec<(f32, f32)>,
    blocked: Vec<bool>,
}

impl<'a> Navigation<'a> {
    pub fn new(map: &'a MapDefinition, units: &[Entity]) -> Self {
        let side = (map.size / CELL) as i32;
        let mut result = Self {
            map,
            side,
            buildings: units
                .iter()
                .filter(|unit| is_building(&unit.kind))
                .map(|unit| (unit.x, unit.y))
                .collect(),
            blocked: vec![false; (side * side) as usize],
        };
        for row in 0..side {
            for column in 0..side {
                let (x, y) = Self::center((column, row));
                result.blocked[(row * side + column) as usize] = !result.free(x, y);
            }
        }
        result
    }

    pub fn free(&self, x: f32, y: f32) -> bool {
        let band = EDGE_MARGIN..=self.map.size - EDGE_MARGIN;
        band.contains(&x)
            && band.contains(&y)
            && self.map.terrain_free(x, y, 12.0)
            && !self
                .buildings
                .iter()
                .any(|(other_x, other_y)| distance(x, y, *other_x, *other_y) < 44.0)
    }

    /// Off the grid counts as blocked.
    fn cell_blocked(&self, cell: (i32, i32)) -> bool {
        cell.0 < 0
            || cell.1 < 0
            || cell.0 >= self.side
            || cell.1 >= self.side
            || self.blocked[(cell.1 * self.side + cell.0) as usize]
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

    /// Whether one tick of motion from `x, y` to `next_x, next_y` is legal for
    /// its whole length — **landing point included**.
    ///
    /// `clear()` answers a different question: it asks whether a long line is
    /// plausible, at a sample spacing (8) wider than a tick of motion (~5), and
    /// its samples never coincide with where the unit actually stops. That is
    /// what let a unit walk into the clearance margin of a terrain corner: the
    /// line looked fine, the landing point was not free, and the world's
    /// end-of-tick rule put the unit back where it started, forever.
    fn walkable(&self, x: f32, y: f32, next_x: f32, next_y: f32) -> bool {
        let steps = (distance(x, y, next_x, next_y) / STEP_SAMPLE)
            .ceil()
            .max(1.0) as usize;
        (1..=steps).all(|index| {
            let fraction = index as f32 / steps as f32;
            self.free(x + (next_x - x) * fraction, y + (next_y - y) * fraction)
        })
    }

    /// One tick of motion toward a target, committed only if the unit lands
    /// somewhere it is allowed to stand.
    ///
    /// Returns `None` — leaving the unit exactly where it was — when the step
    /// would end illegally, so the caller can try something else in the same
    /// tick rather than proposing the identical blocked step next tick.
    fn step(
        &self,
        x: &mut f32,
        y: &mut f32,
        target_x: f32,
        target_y: f32,
        speed: f32,
        range: f32,
    ) -> Option<bool> {
        let (mut next_x, mut next_y) = (*x, *y);
        let arrived = advance(&mut next_x, &mut next_y, target_x, target_y, speed, range);
        if (next_x, next_y) != (*x, *y) && !self.walkable(*x, *y, next_x, next_y) {
            return None;
        }
        (*x, *y) = (next_x, next_y);
        Some(arrived)
    }

    /// Last resort: slip along the obstacle instead of standing still.
    ///
    /// Both the straight line and the routed step can be refused in the same
    /// tick — a unit pressed into a corner by `separate_units`, say. Without
    /// this the unit would recompute the same two refusals every tick and never
    /// move again. Turning the heading by a fixed, ordered fan of angles keeps
    /// the outcome deterministic while guaranteeing that a unit with any legal
    /// ground beside it makes progress out of the corner.
    fn slide(&self, x: &mut f32, y: &mut f32, target_x: f32, target_y: f32, speed: f32) -> bool {
        let gap = distance(*x, *y, target_x, target_y);
        if gap < 0.01 {
            return false;
        }
        let (toward_x, toward_y) = ((target_x - *x) / gap, (target_y - *y) / gap);
        let step = (speed / TICKS_PER_SECOND as f32).min(gap);
        for (cos, sin) in TURNS {
            let (next_x, next_y) = (
                *x + (toward_x * cos - toward_y * sin) * step,
                *y + (toward_x * sin + toward_y * cos) * step,
            );
            if self.walkable(*x, *y, next_x, next_y) {
                (*x, *y) = (next_x, next_y);
                return true;
            }
        }
        false
    }

    /// The closest legal spot to a unit that is standing somewhere illegal,
    /// searched ring by ring outwards. `None` when everything nearby is taken,
    /// which leaves the caller to fall back on where the unit came from.
    pub fn escape(&self, x: f32, y: f32) -> Option<(f32, f32)> {
        ESCAPE_RINGS.iter().find_map(|radius| {
            ESCAPE_DIRECTIONS
                .iter()
                .map(|(offset_x, offset_y)| (x + offset_x * radius, y + offset_y * radius))
                .find(|(candidate_x, candidate_y)| self.free(*candidate_x, *candidate_y))
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
        // Set once a concrete step has been computed and then refused, which is
        // the only situation the slide below is for. A unit whose target simply
        // cannot be routed to stands still, as it always has.
        let mut refused = false;
        if self.clear(*x, *y, end_x, end_y) {
            // The line looking clear is not a promise about the landing point:
            // it is sampled coarsely, and the samples straddle where this tick
            // actually ends. Only commit the step if the landing point holds
            // up; otherwise route around instead of returning early.
            match self.step(x, y, target_x, target_y, speed, range) {
                Some(arrived) => return arrived,
                None => refused = true,
            }
        }
        let mut start = ((*x / CELL) as i32, (*y / CELL) as i32);
        // A unit can legally stand in a cell whose centre is not free: a worker
        // delivering at 45 from a hub stands in a cell centred inside the hub's
        // 44 footprint. Routed from that cell, every step back to its centre is
        // refused and the unit froze for good whenever its next target lay
        // behind the hub. Route instead from the nearest free cell it can
        // walk straight to.
        if self.cell_blocked(start) {
            let (from_x, from_y) = (*x, *y);
            if let Some(free) = (-2..=2)
                .flat_map(|dy| (-2..=2).map(move |dx| (start.0 + dx, start.1 + dy)))
                .filter(|cell| !self.cell_blocked(*cell))
                .filter(|cell| {
                    let (center_x, center_y) = Self::center(*cell);
                    self.clear(from_x, from_y, center_x, center_y)
                })
                .min_by(|left, right| {
                    let (left_x, left_y) = Self::center(*left);
                    let (right_x, right_y) = Self::center(*right);
                    distance(from_x, from_y, left_x, left_y)
                        .total_cmp(&distance(from_x, from_y, right_x, right_y))
                        .then(left.cmp(right))
                })
            {
                start = free;
            }
        }
        let result = astar(
            &start,
            |cell| {
                [(1, 0), (-1, 0), (0, 1), (0, -1)]
                    .into_iter()
                    .filter_map(|(offset_x, offset_y)| {
                        let next = (cell.0 + offset_x, cell.1 + offset_y);
                        if next.0 < 0
                            || next.0 >= self.side
                            || next.1 < 0
                            || next.1 >= self.side
                            || self.blocked[(next.1 * self.side + next.0) as usize]
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
            let origin = (*x, *y);
            // Head for the next cell on the route; failing that, back to the
            // middle of the current cell, which pulls a unit hugging a corner
            // away from it.
            for (next_x, next_y) in [Self::center(next), Self::center(start)] {
                if self.clear(*x, *y, next_x, next_y) {
                    self.step(x, y, next_x, next_y, speed, 0.0);
                    if (*x, *y) != origin {
                        return false;
                    }
                }
            }
            // A route existed and the unit still did not move: it is wedged.
            refused = true;
        }
        if refused {
            // Nothing straight and nothing routed: rub along the obstacle
            // rather than freeze. A unit that cannot move for one tick is
            // fine — a unit that can never move again is not.
            self.slide(x, y, target_x, target_y, speed);
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skirmish() -> &'static MapDefinition {
        crate::maps::default_map()
    }

    /// The 3200 melee fixture, parsed once. Not the default map: nothing here
    /// installs it as the played map, it is simply handed to `Navigation` the
    /// way a match on it would.
    fn quadrille() -> &'static MapDefinition {
        static MAP: std::sync::OnceLock<MapDefinition> = std::sync::OnceLock::new();
        MAP.get_or_init(|| {
            MapDefinition::parse(include_str!("../../shared/maps/quadrille.json"))
                .expect("valid quadrille map")
        })
    }

    /// Outcome of walking a unit the way the world walks it.
    struct Trip {
        x: f32,
        y: f32,
        /// Ticks the unit ended somewhere `free()` rejects. The world undoes
        /// those, so every one of them is movement thrown away.
        reverts: usize,
        /// Longest run of consecutive ticks without moving, before arrival.
        stall: usize,
        /// Ticks whose motion passed through solid terrain.
        tunnels: usize,
        arrived: bool,
    }

    /// Steps a unit toward a target exactly as `World::step` does: advance,
    /// then, if the unit ended on a position `free()` rejects, put it back
    /// where the tick started.
    ///
    /// The revert is the point. Without it these tests pass against the bug,
    /// because the bug is not that a step lands badly — it is that the badly
    /// landed step is undone, identically, every tick, forever.
    fn travel(
        map: &MapDefinition,
        navigation: &Navigation,
        start: (f32, f32),
        target: (f32, f32),
        range: f32,
        ticks: usize,
    ) -> Trip {
        let (mut x, mut y) = start;
        let mut trip = Trip {
            x,
            y,
            reverts: 0,
            stall: 0,
            tunnels: 0,
            arrived: false,
        };
        let mut stall = 0;
        for _ in 0..ticks {
            let (previous_x, previous_y) = (x, y);
            navigation.advance(&mut x, &mut y, target.0, target.1, 100.0, range);
            if !navigation.free(x, y) {
                trip.reverts += 1;
                (x, y) = (previous_x, previous_y);
            }
            // Solid terrain, no clearance margin: a unit may brush the margin
            // of a rock, it may never pass through the rock.
            let span = distance(previous_x, previous_y, x, y);
            if span > 0.01 {
                let samples = span.ceil() as usize;
                if !(0..=samples).all(|index| {
                    let fraction = index as f32 / samples as f32;
                    map.terrain_free(
                        previous_x + (x - previous_x) * fraction,
                        previous_y + (y - previous_y) * fraction,
                        0.0,
                    )
                }) {
                    trip.tunnels += 1;
                }
                stall = 0;
            } else {
                stall += 1;
                trip.stall = trip.stall.max(stall);
            }
            if distance(x, y, target.0, target.1) <= range + 0.01 {
                trip.arrived = true;
                break;
            }
        }
        trip.x = x;
        trip.y = y;
        trip
    }

    /// The exact live-match failure: a worker that filled up at the centre
    /// deposits heads home past the bottom-left corner of terrain rect
    /// `[560, 640, 160, 80]`, whose 12-unit clearance margin reaches to
    /// x 548 and y 732. The straight step from here landed at (548.3, 731.8) —
    /// inside that margin by a fraction of a unit — the world put the worker
    /// back, and the next tick computed the identical step. The worker, and the
    /// catalyst it was carrying, never moved again.
    #[test]
    fn worker_frozen_on_a_terrain_corner_still_gets_home() {
        let world = crate::simulation::World::new(&[0, 1]);
        let navigation = Navigation::new(skirmish(), &world.units);
        assert!(navigation.free(551.0, 736.0), "the start must be legal");
        let trip = travel(skirmish(), &navigation, (551.0, 736.0), (220.0, 220.0), 45.0, 600);
        assert!(
            trip.arrived,
            "worker stalled at ({:.1}, {:.1}), {:.1} from the hub, after {} reverted ticks",
            trip.x,
            trip.y,
            distance(trip.x, trip.y, 220.0, 220.0),
            trip.reverts
        );
        assert_eq!(trip.reverts, 0, "no step may end where a unit cannot stand");
        assert_eq!(trip.tunnels, 0, "no step may cross terrain");
    }

    /// The single coordinate above is one sample of a geometric case, so sweep
    /// the whole neighbourhood of that corner: every legal start on a grid
    /// around it must get home, without ever ending a tick inside the clearance
    /// margin and without freezing on the spot.
    #[test]
    fn no_start_near_a_terrain_corner_ends_a_step_inside_clearance() {
        let world = crate::simulation::World::new(&[0, 1]);
        let navigation = Navigation::new(skirmish(), &world.units);
        let mut tested = 0;
        for column in 0..13 {
            for row in 0..11 {
                let start = (530.0 + column as f32 * 6.0, 734.0 + row as f32 * 6.0);
                if !navigation.free(start.0, start.1) {
                    continue;
                }
                tested += 1;
                let trip = travel(skirmish(), &navigation, start, (220.0, 220.0), 45.0, 600);
                assert_eq!(
                    trip.reverts, 0,
                    "start ({:.0}, {:.0}) ended {} ticks inside clearance",
                    start.0, start.1, trip.reverts
                );
                assert_eq!(
                    trip.tunnels, 0,
                    "start ({:.0}, {:.0}) crossed terrain",
                    start.0, start.1
                );
                assert!(
                    trip.stall < 5,
                    "start ({:.0}, {:.0}) stood still for {} ticks",
                    start.0,
                    start.1,
                    trip.stall
                );
                assert!(
                    trip.arrived,
                    "start ({:.0}, {:.0}) never reached the hub: stopped at ({:.1}, {:.1})",
                    start.0, start.1, trip.x, trip.y
                );
            }
        }
        assert!(tested > 80, "the sweep covered only {tested} starts");
    }

    /// A unit that somehow stands inside terrain — pushed there by crowding —
    /// is walked back out rather than left there.
    #[test]
    fn escape_finds_legal_ground_from_inside_terrain() {
        let navigation = Navigation::new(skirmish(), &[]);
        let inside = (640.0, 680.0);
        assert!(!navigation.free(inside.0, inside.1));
        let (x, y) = navigation.escape(inside.0, inside.1).expect("a way out");
        assert!(navigation.free(x, y));
        assert!(distance(x, y, inside.0, inside.1) <= 120.0);
    }

    #[test]
    fn routes_around_terrain_without_crossing_it() {
        let navigation = Navigation::new(skirmish(), &[]);
        let (mut x, mut y) = (500.0, 680.0);
        for _ in 0..300 {
            navigation.advance(&mut x, &mut y, 800.0, 680.0, 110.0, 0.0);
            assert!(navigation.free(x, y));
        }
        assert!(distance(x, y, 800.0, 680.0) < 1.0);
        assert!(!line_of_sight(skirmish(), 500.0, 680.0, 800.0, 680.0));
    }

    #[test]
    fn routes_around_buildings_and_reaches_deposit_range() {
        let world = crate::simulation::World::new(&[0, 1]);
        let navigation = Navigation::new(skirmish(), &world.units);
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
