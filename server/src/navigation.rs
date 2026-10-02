use crate::maps::MapDefinition;
use crate::{advance, distance, is_building, simulation::Entity, NAV_CELL_SIZE, TICKS_PER_SECOND};
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

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

/// Clearance a mobile unit keeps from terrain.
const TERRAIN_CLEARANCE: f32 = 12.0;

/// A point closer than this to a building's centre is inside its footprint.
const BUILDING_FOOTPRINT: f32 = 44.0;

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

/// The four routing moves, in the order a route prefers them when two are
/// equally short.
const MOVES: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

/// Whether a straight line between two points is free of the *simulated* map's
/// terrain — what a weapon needs to know before it fires.
///
/// The map is an argument, never `maps::default_map()`: a shot resolved on a
/// map other than skirmish used to be tested against skirmish's rectangles,
/// so units shot through walls that were there and were stopped by walls that
/// were not.
///
/// Inside a tick, `Navigation::line_of_sight` answers the same question from
/// the cached terrain grid and is what the simulation calls.
pub fn line_of_sight(map: &MapDefinition, x: f32, y: f32, target_x: f32, target_y: f32) -> bool {
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

/// The long-line test behind `Navigation::clear`: samples every 8 units from
/// just past the start to the end inclusive, all of which `free` must accept.
/// One function, so the precomputed routing edges and the live check can
/// never sample differently.
fn sampled(x: f32, y: f32, target_x: f32, target_y: f32, free: impl Fn(f32, f32) -> bool) -> bool {
    let steps = (distance(x, y, target_x, target_y) / 8.0).ceil().max(1.0) as usize;
    (1..=steps).all(|index| {
        let fraction = index as f32 / steps as f32;
        free(x + (target_x - x) * fraction, y + (target_y - y) * fraction)
    })
}

/// The routing moves out of `cell` that are legal, as bits by `MOVES` index:
/// the neighbour is on the grid and not `blocked`, and the run between the
/// two centres is clear by `free`.
fn moves_from(
    side: i32,
    cell: i32,
    blocked: &[bool],
    free: impl Fn(f32, f32) -> bool,
) -> u8 {
    let here = (cell % side, cell / side);
    let (from_x, from_y) = Navigation::center(here);
    let mut bits = 0;
    for (direction, (offset_x, offset_y)) in MOVES.iter().enumerate() {
        let there = (here.0 + offset_x, here.1 + offset_y);
        if there.0 < 0 || there.1 < 0 || there.0 >= side || there.1 >= side {
            continue;
        }
        if blocked[(there.1 * side + there.0) as usize] {
            continue;
        }
        let (to_x, to_y) = Navigation::center(there);
        if sampled(from_x, from_y, to_x, to_y, &free) {
            bits |= 1 << direction;
        }
    }
    bits
}

/// Lists of item indices per grid cell, in compressed-row form.
#[derive(Default)]
struct CellLists {
    starts: Vec<u32>,
    items: Vec<u32>,
}

impl CellLists {
    /// `spans` yields, per item, the inclusive cell rectangle it may touch.
    fn build(side: i32, spans: impl Iterator<Item = (u32, [i32; 4])>) -> Self {
        let cells = (side * side) as usize;
        let mut keyed = Vec::new();
        for (item, [left, top, right, bottom]) in spans {
            for row in top.max(0)..=bottom.min(side - 1) {
                for column in left.max(0)..=right.min(side - 1) {
                    keyed.push(((row * side + column) as u32, item));
                }
            }
        }
        keyed.sort_unstable();
        let mut starts = vec![0u32; cells + 1];
        for (cell, _) in &keyed {
            starts[*cell as usize + 1] += 1;
        }
        for at in 1..starts.len() {
            starts[at] += starts[at - 1];
        }
        Self {
            starts,
            items: keyed.into_iter().map(|(_, item)| item).collect(),
        }
    }

    fn of(&self, cell: usize) -> &[u32] {
        &self.items[self.starts[cell] as usize..self.starts[cell + 1] as usize]
    }
}

/// Everything about routing that depends on the map alone: computed once per
/// map (per thread) and shared by every tick and every match on it.
struct TerrainGrid {
    size: f32,
    terrain: Vec<[f32; 4]>,
    side: i32,
    /// Rectangles that may contain a point of each cell once grown by the
    /// unit clearance — the only ones `free()` has to test there.
    clearance: CellLists,
    /// The same, ungrown: what line of sight tests.
    solid: CellLists,
    /// Cell centres that fail the terrain and edge half of `free()`.
    blocked: Vec<bool>,
    /// Legal routing moves per cell with no buildings on the map.
    moves: Vec<u8>,
}

impl TerrainGrid {
    fn new(map: &MapDefinition) -> Self {
        let side = (map.size / CELL) as i32;
        // One unit of slack either side, so float rounding at a cell edge can
        // never leave a rectangle off a list it belongs on.
        let span = |margin: f32| {
            move |(index, rect): (usize, &[f32; 4])| {
                let cell = |value: f32| (value / CELL).floor() as i32;
                (
                    index as u32,
                    [
                        cell(rect[0] - margin - 1.0),
                        cell(rect[1] - margin - 1.0),
                        cell(rect[0] + rect[2] + margin + 1.0),
                        cell(rect[1] + rect[3] + margin + 1.0),
                    ],
                )
            }
        };
        let mut grid = Self {
            size: map.size,
            terrain: map.terrain.clone(),
            side,
            clearance: CellLists::build(
                side,
                map.terrain.iter().enumerate().map(span(TERRAIN_CLEARANCE)),
            ),
            solid: CellLists::build(side, map.terrain.iter().enumerate().map(span(0.0))),
            blocked: Vec::new(),
            moves: Vec::new(),
        };
        grid.blocked = (0..side * side)
            .map(|at| {
                let (x, y) = Navigation::center((at % side, at / side));
                !grid.open(x, y)
            })
            .collect();
        grid.moves = (0..side * side)
            .map(|at| moves_from(side, at, &grid.blocked, |x, y| grid.open(x, y)))
            .collect();
        grid
    }

    fn matches(&self, map: &MapDefinition) -> bool {
        self.size.to_bits() == map.size.to_bits()
            && self.terrain.len() == map.terrain.len()
            && self
                .terrain
                .iter()
                .zip(&map.terrain)
                .all(|(left, right)| left.map(f32::to_bits) == right.map(f32::to_bits))
    }

    /// Cell holding a point, clamped onto the grid.
    fn cell_of(&self, x: f32, y: f32) -> usize {
        let column = ((x / CELL) as i32).clamp(0, self.side - 1);
        let row = ((y / CELL) as i32).clamp(0, self.side - 1);
        (row * self.side + column) as usize
    }

    /// Exactly `map.terrain_free(x, y, margin)` for the rectangles in `list`.
    fn clear_of(&self, list: &CellLists, x: f32, y: f32, margin: f32) -> bool {
        !list.of(self.cell_of(x, y)).iter().any(|at| {
            let rect = &self.terrain[*at as usize];
            x > rect[0] - margin
                && x < rect[0] + rect[2] + margin
                && y > rect[1] - margin
                && y < rect[1] + rect[3] + margin
        })
    }

    /// The terrain and edge half of `Navigation::free`.
    fn open(&self, x: f32, y: f32) -> bool {
        let band = EDGE_MARGIN..=self.size - EDGE_MARGIN;
        band.contains(&x)
            && band.contains(&y)
            && self.clear_of(&self.clearance, x, y, TERRAIN_CLEARANCE)
    }
}

/// Everything that depends on the map *and* the buildings standing on it:
/// rebuilt only when a building appears or disappears, and shared by every tick
/// in between. It also owns the route fields solved on that layout.
struct Overlay {
    terrain: Rc<TerrainGrid>,
    /// Building centres in a canonical order (by bit pattern) — the cache key.
    buildings: Vec<(f32, f32)>,
    /// Buildings whose footprint may reach into each cell.
    near: CellLists,
    /// Cell centres that are not free: terrain, edge or building.
    blocked: Vec<bool>,
    /// Legal routing moves per cell with these buildings standing.
    moves: Vec<u8>,
    fields: RefCell<Fields>,
}

impl Overlay {
    fn new(terrain: Rc<TerrainGrid>, buildings: Vec<(f32, f32)>) -> Self {
        let side = terrain.side;
        let reach = BUILDING_FOOTPRINT + 1.0;
        let near = CellLists::build(
            side,
            buildings.iter().enumerate().map(|(index, (x, y))| {
                let cell = |value: f32| (value / CELL).floor() as i32;
                (
                    index as u32,
                    [
                        cell(x - reach),
                        cell(y - reach),
                        cell(x + reach),
                        cell(y + reach),
                    ],
                )
            }),
        );
        let mut overlay = Self {
            blocked: terrain.blocked.clone(),
            moves: terrain.moves.clone(),
            terrain,
            buildings,
            near,
            fields: RefCell::new(Fields::default()),
        };
        // Stamp only the footprint cells: every other cell keeps the terrain
        // answer it already had.
        for cell in 0..overlay.blocked.len() {
            if !overlay.blocked[cell] && !overlay.near.of(cell).is_empty() {
                let (x, y) = Navigation::center((cell as i32 % side, cell as i32 / side));
                overlay.blocked[cell] = !overlay.clear_of_buildings(x, y);
            }
        }
        // A move's samples lie in its two cells, so only moves touching a
        // cell some footprint reaches into can differ from the terrain
        // answer. Those are recomputed in full; the rest are kept.
        for cell in 0..side * side {
            let here = (cell % side, cell / side);
            let touched = [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)]
                .into_iter()
                .map(|(x, y)| (here.0 + x, here.1 + y))
                .filter(|there| there.0 >= 0 && there.1 >= 0 && there.0 < side && there.1 < side)
                .any(|there| !overlay.near.of((there.1 * side + there.0) as usize).is_empty());
            if touched {
                overlay.moves[cell as usize] = moves_from(side, cell, &overlay.blocked, |x, y| {
                    overlay.terrain.open(x, y) && overlay.clear_of_buildings(x, y)
                });
            }
        }
        overlay
    }

    fn clear_of_buildings(&self, x: f32, y: f32) -> bool {
        !self
            .near
            .of(self.terrain.cell_of(x, y))
            .iter()
            .any(|at| {
                let (other_x, other_y) = self.buildings[*at as usize];
                distance(x, y, other_x, other_y) < BUILDING_FOOTPRINT
            })
    }

    fn matches(&self, terrain: &Rc<TerrainGrid>, buildings: &[(f32, f32)]) -> bool {
        Rc::ptr_eq(&self.terrain, terrain)
            && self.buildings.len() == buildings.len()
            && self.buildings.iter().zip(buildings).all(|(left, right)| {
                (left.0.to_bits(), left.1.to_bits()) == (right.0.to_bits(), right.1.to_bits())
            })
    }
}

/// Route fields solved on one overlay, keyed by goal, least recently used
/// evicted first once they exceed a memory budget.
///
/// A `HashMap` is safe here because it is only ever used for lookup: nothing
/// read out of it depends on its iteration order (eviction picks the unique
/// oldest `used` stamp, and eviction only ever costs a recomputation).
#[derive(Default)]
struct Fields {
    entries: HashMap<GoalKey, Field>,
    clock: u64,
}

/// A goal exactly as `advance` was asked for it: target point and stop range,
/// compared bit for bit.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct GoalKey(u32, u32, u32);

/// Bytes of route fields kept per overlay before the least recently used are
/// dropped. Eviction only ever costs a recomputation: a field is a pure
/// function of the overlay and its goal.
const FIELD_BUDGET_BYTES: usize = 24 << 20;

/// Marks in `Field::step`.
const UNSEEN: u8 = 255;
const GOAL: u8 = 4;

/// A lazily grown reverse breadth-first search from one goal: for each cell it
/// has reached, the first move of a shortest route from that cell to the goal.
///
/// It is a pure function of the overlay and the goal. The search grows only as
/// far as the cells asked about so far, and a grown search answers every cell
/// it already holds exactly as a fresh one would — breadth-first order fixes
/// each cell's parent the moment the cell is first reached — so how often a
/// field was evicted, or which unit asked first, can never change a route.
struct Field {
    step: Vec<u8>,
    /// Reached cells not yet expanded, oldest first. Only the wavefront is
    /// held, so a field's memory is its marks plus a perimeter.
    frontier: VecDeque<u32>,
    used: u64,
}

impl Field {
    fn bytes(&self) -> usize {
        self.step.len() + self.frontier.capacity() * 4
    }
}

/// Most recently used first.
type Memo = (Vec<Rc<TerrainGrid>>, Vec<Rc<Overlay>>);

thread_local! {
    /// Per-thread memo of terrain grids and overlays. A cache, never state:
    /// every value in it is recomputed identically on a miss.
    static CACHE: RefCell<Memo> =
        const { RefCell::new((Vec::new(), Vec::new())) };
}

/// Terrain grids and overlays remembered per thread. A building layout that
/// changed is rarely seen again, so only two overlays are kept — enough for two
/// matches ticking in turn — which bounds route-field memory at twice
/// `FIELD_BUDGET_BYTES`. More concurrent matches stay correct; they only
/// recompute more.
const CACHED_TERRAINS: usize = 4;
const CACHED_OVERLAYS: usize = 2;

/// The routing grid for **one map**.
///
/// Everything dimensional is derived from the `MapDefinition` handed to
/// `new`: the grid is `map.size / CELL` cells on a side, the legal band is
/// `EDGE_MARGIN ..= map.size - EDGE_MARGIN`, and terrain is that map's
/// terrain. Nothing in here consults the default map, so a match on a 3200
/// map is routed on a 3200 grid rather than through a 1600 window with every
/// unit outside it frozen.
///
/// Construction is cheap after the first tick on a map: the terrain grid is
/// computed once per map, and the building overlay once per building layout,
/// both memoised per thread. Routes are breadth-first fields per goal, shared
/// by every unit heading for the same goal and kept across ticks while the
/// layout stands (see `Field`).
pub struct Navigation<'a> {
    /// Cells per row and per column — `map.size / CELL`.
    side: i32,
    overlay: Rc<Overlay>,
    /// Ties a navigation to the map it was built for, as it always has been.
    map: std::marker::PhantomData<&'a MapDefinition>,
}

impl<'a> Navigation<'a> {
    pub fn new(map: &'a MapDefinition, units: &[Entity]) -> Self {
        // In a canonical order, so the same layout is the same cache key
        // whether it came from the id-sorted tick snapshot or from rows in
        // database order. Nothing built from it depends on the order.
        let mut buildings: Vec<(f32, f32)> = units
            .iter()
            .filter(|unit| is_building(&unit.kind))
            .map(|unit| (unit.x, unit.y))
            .collect();
        buildings.sort_unstable_by_key(|(x, y)| (x.to_bits(), y.to_bits()));
        let overlay = CACHE.with(|cache| {
            let (terrains, overlays) = &mut *cache.borrow_mut();
            let terrain = match terrains.iter().position(|grid| grid.matches(map)) {
                Some(at) => {
                    let grid = terrains.remove(at);
                    terrains.insert(0, grid.clone());
                    grid
                }
                None => {
                    let grid = Rc::new(TerrainGrid::new(map));
                    terrains.insert(0, grid.clone());
                    terrains.truncate(CACHED_TERRAINS);
                    grid
                }
            };
            match overlays
                .iter()
                .position(|overlay| overlay.matches(&terrain, &buildings))
            {
                Some(at) => {
                    let overlay = overlays.remove(at);
                    overlays.insert(0, overlay.clone());
                    overlay
                }
                None => {
                    let overlay = Rc::new(Overlay::new(terrain, buildings));
                    overlays.insert(0, overlay.clone());
                    overlays.truncate(CACHED_OVERLAYS);
                    overlay
                }
            }
        });
        Self {
            side: overlay.terrain.side,
            overlay,
            map: std::marker::PhantomData,
        }
    }

    /// Whether a mobile unit may stand at `(x, y)`: inside the edge band, clear
    /// of terrain by the unit clearance, and outside every building footprint.
    pub fn free(&self, x: f32, y: f32) -> bool {
        self.overlay.terrain.open(x, y) && self.overlay.clear_of_buildings(x, y)
    }

    /// `line_of_sight` for this navigation's map, answered from the terrain
    /// grid: the same samples, the same rectangles that can contain them.
    pub fn line_of_sight(&self, x: f32, y: f32, target_x: f32, target_y: f32) -> bool {
        let grid = &self.overlay.terrain;
        let steps = (distance(x, y, target_x, target_y) / 8.0).ceil().max(1.0) as usize;
        (0..=steps).all(|index| {
            let fraction = index as f32 / steps as f32;
            grid.clear_of(
                &grid.solid,
                x + (target_x - x) * fraction,
                y + (target_y - y) * fraction,
                0.0,
            )
        })
    }

    /// Off the grid counts as blocked.
    fn cell_blocked(&self, cell: (i32, i32)) -> bool {
        cell.0 < 0
            || cell.1 < 0
            || cell.0 >= self.side
            || cell.1 >= self.side
            || self.overlay.blocked[(cell.1 * self.side + cell.0) as usize]
    }

    fn center(cell: (i32, i32)) -> (f32, f32) {
        ((cell.0 as f32 + 0.5) * CELL, (cell.1 as f32 + 0.5) * CELL)
    }

    fn clear(&self, x: f32, y: f32, target_x: f32, target_y: f32) -> bool {
        sampled(x, y, target_x, target_y, |x, y| self.free(x, y))
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

    /// Where a unit routed from the centre of `cell` stops short of the target:
    /// `range` back from it along the line it approaches on.
    fn approach(cell_x: f32, cell_y: f32, target_x: f32, target_y: f32, range: f32) -> (f32, f32) {
        let gap = distance(cell_x, cell_y, target_x, target_y).max(0.01);
        (
            target_x + (cell_x - target_x) / gap * range,
            target_y + (cell_y - target_y) / gap * range,
        )
    }

    /// Whether a route may end in `cell`: close enough to the target, with a
    /// straight run from the cell centre to the approach point.
    fn is_goal(&self, cell: (i32, i32), target_x: f32, target_y: f32, range: f32) -> bool {
        let (center_x, center_y) = Self::center(cell);
        let (end_x, end_y) = Self::approach(center_x, center_y, target_x, target_y, range);
        distance(center_x, center_y, target_x, target_y) <= range + CELL * 1.5
            && self.clear(center_x, center_y, end_x, end_y)
    }

    /// A fresh field for a goal: every free goal cell seeded, in row-major
    /// order, as the zeroth breadth-first layer.
    fn seed(&self, target_x: f32, target_y: f32, range: f32) -> Field {
        let cells = (self.side * self.side) as usize;
        let mut field = Field {
            step: vec![UNSEEN; cells],
            frontier: VecDeque::new(),
            used: 0,
        };
        let reach = range + CELL * 1.5 + 1.0;
        let bound = |value: f32| ((value / CELL).floor() as i32).clamp(0, self.side - 1);
        if !(target_x.is_finite() && target_y.is_finite() && reach.is_finite()) {
            return field;
        }
        for row in bound(target_y - reach)..=bound(target_y + reach) {
            for column in bound(target_x - reach)..=bound(target_x + reach) {
                if !self.cell_blocked((column, row))
                    && self.is_goal((column, row), target_x, target_y, range)
                {
                    let at = (row * self.side + column) as usize;
                    field.step[at] = GOAL;
                    field.frontier.push_back(at as u32);
                }
            }
        }
        field
    }

    /// Grows `field` until `cell` is reached or the search is exhausted, and
    /// returns the cell's mark: a `MOVES` index, `GOAL`, or `UNSEEN`.
    ///
    /// Reverse search: expanding a reached cell `c` reaches each neighbour `n`
    /// that could step *into* `c` (`passable(n, c)`), recording the move from
    /// `n` to `c`. A blocked neighbour is recorded — a unit can leave a blocked
    /// start cell — but never expanded, since no route passes through one.
    fn grow(&self, field: &mut Field, cell: usize) -> u8 {
        let side = self.side as usize;
        let cells = field.step.len();
        let moves = &self.overlay.moves[..cells];
        let blocked = &self.overlay.blocked[..cells];
        let Field { step, frontier, .. } = field;
        let step = &mut step[..cells];
        // Reaches `index` from the cell being expanded, if the move `back`
        // out of `index` (the one leading back here) is legal.
        #[inline(always)]
        fn reach(
            step: &mut [u8],
            moves: &[u8],
            blocked: &[bool],
            frontier: &mut VecDeque<u32>,
            index: usize,
            back: u8,
        ) {
            if step[index] == UNSEEN && moves[index] & (1 << back) != 0 {
                step[index] = back;
                if !blocked[index] {
                    frontier.push_back(index as u32);
                }
            }
        }
        while step[cell] == UNSEEN {
            let Some(at) = frontier.pop_front() else {
                break;
            };
            let at = at as usize;
            let column = at % side;
            // Neighbours in `MOVES` order — right, left, down, up — each with
            // the move that leads from it back here (the opposite one).
            if column + 1 < side {
                reach(step, moves, blocked, frontier, at + 1, 1);
            }
            if column > 0 {
                reach(step, moves, blocked, frontier, at - 1, 0);
            }
            if at + side < cells {
                reach(step, moves, blocked, frontier, at + side, 3);
            }
            if at >= side {
                reach(step, moves, blocked, frontier, at - side, 2);
            }
        }
        if frontier.is_empty() {
            // Exhausted: nothing more will ever be reached, so drop the queue.
            *frontier = VecDeque::new();
        }
        step[cell]
    }

    /// The next cell on a shortest route from `start` to the goal, `start`
    /// itself when it already is a goal cell, or `None` when no route exists.
    ///
    /// Routes are 4-connected and unit cost, exactly as the A* search this
    /// replaced; among equally short routes the first move in `MOVES` order
    /// toward the earliest-reached cell is taken.
    fn route(
        &self,
        start: (i32, i32),
        target_x: f32,
        target_y: f32,
        range: f32,
    ) -> Option<(i32, i32)> {
        if self.cell_blocked(start) {
            // A blocked start is never seeded, so test it as a goal directly.
            if self.is_goal(start, target_x, target_y, range) {
                return Some(start);
            }
            if start.0 < 0 || start.1 < 0 || start.0 >= self.side || start.1 >= self.side {
                return None;
            }
        }
        let cell = (start.1 * self.side + start.0) as usize;
        let key = GoalKey(target_x.to_bits(), target_y.to_bits(), range.to_bits());
        let mut fields = self.overlay.fields.borrow_mut();
        fields.clock += 1;
        let clock = fields.clock;
        let fresh = !fields.entries.contains_key(&key);
        let mark = {
            let field = fields
                .entries
                .entry(key)
                .or_insert_with(|| self.seed(target_x, target_y, range));
            field.used = clock;
            self.grow(field, cell)
        };
        if fresh {
            // Keep the memo inside its budget, dropping the least recently
            // used fields (never the one just used).
            let mut total: usize = fields.entries.values().map(Field::bytes).sum();
            while total > FIELD_BUDGET_BYTES && fields.entries.len() > 1 {
                let (oldest, bytes) = fields
                    .entries
                    .iter()
                    .min_by_key(|(_, field)| field.used)
                    .map(|(key, field)| (*key, field.bytes()))
                    .unwrap();
                total -= bytes;
                fields.entries.remove(&oldest);
            }
        }
        match mark {
            UNSEEN => None,
            GOAL => Some(start),
            direction => {
                let (offset_x, offset_y) = MOVES[direction as usize];
                Some((start.0 + offset_x, start.1 + offset_y))
            }
        }
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
        let (end_x, end_y) = Self::approach(*x, *y, target_x, target_y, range);
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
        if let Some(next) = self.route(start, target_x, target_y, range) {
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
        let trip = travel(
            skirmish(),
            &navigation,
            (551.0, 736.0),
            (220.0, 220.0),
            45.0,
            600,
        );
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

    /// Deterministic points in `[0, size)`, plus a few just off the map.
    fn scatter(size: f32, count: usize) -> Vec<(f32, f32)> {
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 40) as f32 / (1u64 << 24) as f32
        };
        (0..count)
            .map(|_| (next() * (size + 40.0) - 20.0, next() * (size + 40.0) - 20.0))
            .collect()
    }

    fn expanse() -> &'static MapDefinition {
        crate::maps::by_id("expanse").expect("expanse is registered")
    }

    /// A world on `map` with every slot's opening plus a ring of extra
    /// buildings, so footprints overlap terrain margins and each other.
    fn built_up(map: &MapDefinition) -> Vec<Entity> {
        let mut world = crate::simulation::World::new_on(map, &[0, 1, 2, 3]);
        for (index, (x, y)) in scatter(map.size, 60).into_iter().enumerate() {
            world.spawn((index % 4) as u8, "barracks", x, y);
        }
        world.units
    }

    /// The bucketed `free()` and `line_of_sight` are the old linear
    /// definitions, sample for sample: the same terrain margin, the same edge
    /// band, the same footprint test against every building.
    #[test]
    fn the_grid_answers_free_and_sight_exactly_as_the_linear_definitions() {
        for map in [skirmish(), quadrille(), expanse()] {
            let units = built_up(map);
            let buildings: Vec<(f32, f32)> = units
                .iter()
                .filter(|unit| is_building(&unit.kind))
                .map(|unit| (unit.x, unit.y))
                .collect();
            let navigation = Navigation::new(map, &units);
            let points = scatter(map.size, 20_000);
            for (x, y) in &points {
                let band = EDGE_MARGIN..=map.size - EDGE_MARGIN;
                let linear = band.contains(x)
                    && band.contains(y)
                    && map.terrain_free(*x, *y, 12.0)
                    && !buildings
                        .iter()
                        .any(|(bx, by)| distance(*x, *y, *bx, *by) < 44.0);
                assert_eq!(navigation.free(*x, *y), linear, "free({x}, {y}) on {}", map.id);
            }
            for pair in points.chunks(2).take(2_000) {
                let [(x, y), (to_x, to_y)] = [pair[0], pair[1]];
                assert_eq!(
                    navigation.line_of_sight(x, y, to_x, to_y),
                    line_of_sight(map, x, y, to_x, to_y),
                    "sight ({x}, {y}) -> ({to_x}, {to_y}) on {}",
                    map.id
                );
            }
        }
    }

    /// The A* search the fields replaced, kept here as the reference: same
    /// moves, same move test, same goal test.
    fn astar_length(
        navigation: &Navigation,
        start: (i32, i32),
        target: (f32, f32),
        range: f32,
    ) -> Option<usize> {
        let (target_x, target_y) = target;
        pathfinding::prelude::astar(
            &start,
            |cell| {
                MOVES
                    .into_iter()
                    .filter_map(|(offset_x, offset_y)| {
                        let next = (cell.0 + offset_x, cell.1 + offset_y);
                        if navigation.cell_blocked(next) {
                            return None;
                        }
                        let (from_x, from_y) = Navigation::center(*cell);
                        let (next_x, next_y) = Navigation::center(next);
                        navigation
                            .clear(from_x, from_y, next_x, next_y)
                            .then_some((next, 1u32))
                    })
                    .collect::<Vec<_>>()
            },
            |cell| {
                let (center_x, center_y) = Navigation::center(*cell);
                ((distance(center_x, center_y, target_x, target_y) - range - CELL * 1.5).max(0.0)
                    / CELL) as u32
            },
            |cell| navigation.is_goal(*cell, target_x, target_y, range),
        )
        .map(|(path, _)| path.len() - 1)
    }

    /// Walks the field's route from `start` to a goal cell, counting moves.
    fn field_length(
        navigation: &Navigation,
        start: (i32, i32),
        target: (f32, f32),
        range: f32,
    ) -> Option<usize> {
        let mut cell = start;
        for moves in 0..=(navigation.side * navigation.side) as usize {
            let next = navigation.route(cell, target.0, target.1, range)?;
            if next == cell {
                return Some(moves);
            }
            assert!(
                MOVES.iter().any(|(x, y)| (cell.0 + x, cell.1 + y) == next),
                "a route step must be one move"
            );
            cell = next;
        }
        panic!("route from {start:?} never arrived");
    }

    /// Fields route exactly as far as A* did — the same reachability and the
    /// same shortest length from every start — on a built-up map, for move
    /// orders (range 0) and weapon-range approaches alike. Only which of
    /// several equally short routes is taken may differ.
    #[test]
    fn field_routes_are_exactly_as_short_as_astar() {
        let map = quadrille();
        let units = built_up(map);
        let navigation = Navigation::new(map, &units);
        let points = scatter(map.size, 400);
        let mut routed = 0;
        for (index, pair) in points.chunks(2).enumerate() {
            let [(x, y), target] = [pair[0], pair[1]];
            let start = ((x / CELL) as i32, (y / CELL) as i32);
            let range = [0.0, 45.0, 162.0][index % 3];
            let expected = astar_length(&navigation, start, target, range);
            assert_eq!(
                field_length(&navigation, start, target, range),
                expected,
                "route {start:?} -> {target:?} at range {range}"
            );
            routed += usize::from(expected.is_some_and(|length| length > 3));
        }
        assert!(routed > 50, "only {routed} pairs needed a real route");
    }

    /// A field is a pure function of the layout and the goal: the answers do
    /// not depend on which unit asked first, how far the search had grown, or
    /// whether the memo was cold. Asked in two different orders, from two
    /// separately built caches, every start gets the same next cell.
    #[test]
    fn a_field_answers_the_same_however_it_was_grown() {
        let map = expanse();
        let units = built_up(map);
        let starts: Vec<(i32, i32)> = scatter(map.size, 300)
            .into_iter()
            .map(|(x, y)| ((x / CELL) as i32, (y / CELL) as i32))
            .collect();
        let target = (4810.0, 4790.0);
        let ask = |order: &[(i32, i32)]| {
            CACHE.with(|cache| *cache.borrow_mut() = Default::default());
            let navigation = Navigation::new(map, &units);
            let mut answers: Vec<((i32, i32), Option<(i32, i32)>)> = order
                .iter()
                .map(|start| (*start, navigation.route(*start, target.0, target.1, 0.0)))
                .collect();
            answers.sort_unstable();
            answers
        };
        let forward = ask(&starts);
        let mut reversed = starts.clone();
        reversed.reverse();
        assert_eq!(forward, ask(&reversed));
    }
}
