//! A uniform bucket grid over points, for "who is near here" queries.
//!
//! Built once per tick from a slice of positions (in practice the id-sorted
//! entity snapshot), it answers radius queries by visiting only the buckets the
//! query circle overlaps instead of every entity. That is what turns target
//! acquisition, building exits and similar per-unit scans from O(n²) into
//! roughly O(n · local density).
//!
//! ## Determinism
//!
//! The index never decides anything by itself; it only narrows a candidate set.
//! Every query reports items as **indices into the slice it was built from**,
//! and the ordered queries (`within`, `candidates`) return them in ascending
//! index order — for an id-sorted snapshot, ascending entity id. Nothing in here
//! is keyed by a hash, so no iteration order can leak out of it.
//!
//! The unordered visitor (`for_each_candidate`) walks buckets in a fixed order
//! too, but callers should use it only for order-independent reductions (a
//! minimum with an id tie-break, an `any`), and filter by exact distance
//! themselves.
//!
//! ## Exactness
//!
//! A candidate set always contains every item whose position is within the
//! query radius by the simulation's own `distance` — bucket ranges are padded
//! so that float rounding at a bucket edge cannot drop one. Positions outside
//! `[0, size]` are clamped into the edge buckets, which keeps them findable.

use crate::distance;

/// Padding added to every query radius when choosing buckets, so an item that
/// `distance()` places exactly on the radius is never in a bucket the query
/// skipped because of rounding.
const PAD: f32 = 1.0;

#[derive(Clone, Debug)]
pub struct SpatialIndex {
    cell: f32,
    side: i32,
    /// Compressed rows: bucket `b` holds `items[starts[b]..starts[b + 1]]`.
    starts: Vec<u32>,
    /// Item indices grouped by bucket, ascending within each bucket.
    items: Vec<u32>,
    /// Position of each indexed item, by item index. Unindexed indices hold NaN.
    positions: Vec<(f32, f32)>,
}

impl SpatialIndex {
    /// Indexes `points` — `(index, x, y)` — over a square world `size` on a
    /// side, in buckets `cell` wide. Indices need not be contiguous or cover
    /// the whole source slice: a caller can index only the mobile units, say,
    /// and still get indices into the full snapshot back.
    pub fn new(size: f32, cell: f32, points: impl IntoIterator<Item = (usize, f32, f32)>) -> Self {
        let cell = cell.max(1.0);
        let side = ((size / cell).ceil() as i32).max(1);
        let points: Vec<(usize, f32, f32)> = points.into_iter().collect();
        let length = points.iter().map(|(index, _, _)| index + 1).max().unwrap_or(0);
        let mut positions = vec![(f32::NAN, f32::NAN); length];
        let buckets = (side * side) as usize;
        let mut counts = vec![0u32; buckets + 1];
        let mut keyed: Vec<(u32, u32)> = Vec::with_capacity(points.len());
        let bucket_of = |x: f32, y: f32| -> u32 {
            let column = ((x / cell) as i32).clamp(0, side - 1);
            let row = ((y / cell) as i32).clamp(0, side - 1);
            (row * side + column) as u32
        };
        for (index, x, y) in points {
            positions[index] = (x, y);
            let bucket = bucket_of(x, y);
            counts[bucket as usize + 1] += 1;
            keyed.push((bucket, index as u32));
        }
        for at in 1..counts.len() {
            counts[at] += counts[at - 1];
        }
        // Stable by (bucket, index): ascending index inside every bucket.
        keyed.sort_unstable();
        Self {
            cell,
            side,
            starts: counts,
            items: keyed.into_iter().map(|(_, index)| index).collect(),
            positions,
        }
    }

    /// Number of indexed items.
    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// The bucket rectangle a query circle can touch, inclusive.
    fn range(&self, x: f32, y: f32, radius: f32) -> (i32, i32, i32, i32) {
        let reach = radius.max(0.0) + PAD;
        let clamp = |value: f32| ((value / self.cell) as i32).clamp(0, self.side - 1);
        (clamp(x - reach), clamp(y - reach), clamp(x + reach), clamp(y + reach))
    }

    /// Visits every item in a bucket the circle overlaps — a superset of the
    /// items within `radius` — in a fixed bucket-major order. Callers filter by
    /// exact distance and must only fold the result order-independently.
    pub fn for_each_candidate(&self, x: f32, y: f32, radius: f32, mut visit: impl FnMut(usize)) {
        if self.items.is_empty() {
            return;
        }
        let (left, top, right, bottom) = self.range(x, y, radius);
        for row in top..=bottom {
            let base = row * self.side;
            let from = self.starts[(base + left) as usize] as usize;
            let to = self.starts[(base + right + 1) as usize] as usize;
            for item in &self.items[from..to] {
                visit(*item as usize);
            }
        }
    }

    /// Every candidate (see `for_each_candidate`), ascending by index.
    pub fn candidates(&self, x: f32, y: f32, radius: f32, out: &mut Vec<usize>) {
        out.clear();
        self.for_each_candidate(x, y, radius, |index| out.push(index));
        out.sort_unstable();
    }

    /// Indices of the items within `radius` of `(x, y)` by `distance()`,
    /// ascending by index.
    pub fn within(&self, x: f32, y: f32, radius: f32) -> Vec<usize> {
        let mut out = Vec::new();
        self.for_each_candidate(x, y, radius, |index| {
            let (item_x, item_y) = self.positions[index];
            if distance(x, y, item_x, item_y) <= radius {
                out.push(index);
            }
        });
        out.sort_unstable();
        out
    }

    /// Whether any item within `radius` (strictly closer than, when `strict`)
    /// satisfies `accept`.
    pub fn any_within(
        &self,
        x: f32,
        y: f32,
        radius: f32,
        strict: bool,
        mut accept: impl FnMut(usize) -> bool,
    ) -> bool {
        let mut found = false;
        self.for_each_candidate(x, y, radius, |index| {
            if found {
                return;
            }
            let (item_x, item_y) = self.positions[index];
            let gap = distance(x, y, item_x, item_y);
            if (if strict { gap < radius } else { gap <= radius }) && accept(index) {
                found = true;
            }
        });
        found
    }

    /// The item within `radius` nearest to `(x, y)` that satisfies `accept`,
    /// ties broken on the lower index — the same answer as a linear
    /// `min_by(distance, then id)` over an id-sorted slice, whatever order the
    /// buckets are visited in.
    pub fn nearest(
        &self,
        x: f32,
        y: f32,
        radius: f32,
        mut accept: impl FnMut(usize) -> bool,
    ) -> Option<usize> {
        let mut best: Option<(f32, usize)> = None;
        self.for_each_candidate(x, y, radius, |index| {
            let (item_x, item_y) = self.positions[index];
            let gap = distance(x, y, item_x, item_y);
            if gap > radius {
                return;
            }
            let better = best.is_none_or(|(best_gap, best_index)| {
                gap.total_cmp(&best_gap).then(index.cmp(&best_index)).is_lt()
            });
            if better && accept(index) {
                best = Some((gap, index));
            }
        });
        best.map(|(_, index)| index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scatter(count: usize) -> Vec<(f32, f32)> {
        let mut state = 0x1234_5678_9abc_def1u64;
        (0..count)
            .map(|_| {
                let mut next = || {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    (state >> 40) as f32 / (1u64 << 24) as f32
                };
                (next() * 1000.0, next() * 1000.0)
            })
            .collect()
    }

    #[test]
    fn queries_match_a_linear_scan_exactly() {
        let points = scatter(500);
        let index = SpatialIndex::new(
            1000.0,
            64.0,
            points.iter().enumerate().map(|(at, (x, y))| (at, *x, *y)),
        );
        assert_eq!(index.len(), 500);
        for (qx, qy, radius) in [
            (500.0, 500.0, 100.0),
            (0.0, 0.0, 250.0),
            (999.0, 10.0, 18.0),
            (300.0, 700.0, 0.0),
            (-50.0, 1200.0, 400.0),
        ] {
            let linear: Vec<usize> = points
                .iter()
                .enumerate()
                .filter(|(_, (x, y))| distance(qx, qy, *x, *y) <= radius)
                .map(|(at, _)| at)
                .collect();
            assert_eq!(index.within(qx, qy, radius), linear);
            let nearest = points
                .iter()
                .enumerate()
                .filter(|(at, (x, y))| at % 3 != 0 && distance(qx, qy, *x, *y) <= radius)
                .min_by(|left, right| {
                    distance(qx, qy, left.1 .0, left.1 .1)
                        .total_cmp(&distance(qx, qy, right.1 .0, right.1 .1))
                        .then(left.0.cmp(&right.0))
                })
                .map(|(at, _)| at);
            assert_eq!(index.nearest(qx, qy, radius, |at| at % 3 != 0), nearest);
            assert_eq!(
                index.any_within(qx, qy, radius, true, |at| at % 2 == 0),
                linear
                    .iter()
                    .any(|at| at % 2 == 0 && distance(qx, qy, points[*at].0, points[*at].1) < radius)
            );
        }
    }

    #[test]
    fn items_off_the_map_are_still_found() {
        let index = SpatialIndex::new(100.0, 10.0, [(0, -20.0, 50.0), (3, 130.0, 130.0)]);
        assert_eq!(index.within(-15.0, 50.0, 6.0), vec![0]);
        assert_eq!(index.within(125.0, 125.0, 10.0), vec![3]);
        assert!(index.within(50.0, 50.0, 10.0).is_empty());
    }
}
