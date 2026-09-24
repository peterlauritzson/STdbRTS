# `quadrille` — four-player melee map proposal (size 3200)

**Data proposal only.** Nothing in the repository was modified. The artefacts live
next to this file:

| File | What it is |
| --- | --- |
| `map-proposal.json` | the map definition, ready for `validate_map` |
| `build_map.py` | generator — authors one quadrant, rotates it four times |
| `check_map.py` | independent re-implementation of `maps.rs` validation + melee metrics |
| `map-proposal-meta.json` | sidecar (labels, intended choke windows) consumed by the checker |
| `map-proposal-render.txt` | 80x80 ASCII render on the engine's own 40-unit navigation grid |
| `selfcheck.txt` | full checker output |
| `arc_search.py` | brute-force search behind the mineral-arc fairness decision |

Run: `python build_map.py && python check_map.py map-proposal.json`

---

## 1. What it is

A four-corner, four-fold rotationally symmetric melee map. Mains in the corners,
each with a natural toward the centre and a third out on a map edge, an outer lane
running the perimeter, and an open contested plaza in the middle.

```
  P0 main ........ north lane ........ P1 third .... P1 main
     |  \                                              /  |
  ring   natural --[nat_east]--\      /--[nat_east]-- natural
  road       |                  PLAZA                    |
     |    [ring_gate]         (5 catalyst)          [ring_gate]
  P0 third                                            P1 ...
```

**Totals: 81 deposits — 64 material, 17 catalyst. 24 terrain rectangles.**

Per player (16 deposits, identical in all four quadrants):

| Base | Deposits | Amounts | Distance from main |
| --- | --- | --- | --- |
| Main | 6 material arc + 1 catalyst | 6x1600 + 2000 | arc at r=140, gas at r=215 |
| Natural | 5 material arc + 1 catalyst | 5x1600 + 2000 | 652 straight / **840 walked** |
| Third | 5 material arc + 1 catalyst | 5x1400 + 1600 | 873 straight / **1120 walked** |

Shared and contested: **4 catalyst at 3600** on a 300-radius ring about the centre,
plus **1 catalyst at 5000 on the exact centre point** (the centre is its own rotation
image, so a single deposit there is symmetric by construction).

Bank totals: 98,400 material, 41,800 catalyst. Of the catalyst, **19,400 (46%) is in
the plaza** and cannot be mined safely by anyone.

## 2. Distances (all script-measured)

Straight line, and walked on the engine's own 40-unit / 12-clearance grid:

```
  P0 main -> natural     840 walk  vs    652 straight
  P0 main -> third      1120 walk  vs    873 straight
  P0 main -> centre     2000 walk  vs   1414 straight
  P0 natural -> centre  1160 walk  vs    791 straight
  P0 natural -> third   1400 walk  vs    901 straight   (routed through the main by design)

  start[0] -> start[1]: 2880 walk  (2000 straight)   adjacent
  start[0] -> start[3]: 2800 walk  (2000 straight)   adjacent
  start[1] -> start[2]: 3040 walk  (2000 straight)   adjacent
  start[2] -> start[3]: 2960 walk  (2000 straight)   adjacent
  start[0] -> start[2]: 4000 walk  (2828 straight)   CROSS - the 1v1 pairing
  start[1] -> start[3]: 4000 walk  (2828 straight)   CROSS - the 1v1 pairing
```

Against `rules.rs` speeds (worker 100, soldier 110, scout 180, siege 65):

- worker to the natural: **8.4 s** one way; to the third **11.2 s**
- soldier main-to-main, 1v1 cross positions: **36 s**; scout **22 s**; siege **61 s**
- soldier main to plaza: **18 s**

For reference, SC2's marine rush distance on a standard 1v1 map is roughly 45-50 s, so
36 s is on the short side of normal, not absurd. The two adjacent walks differ
(2800 vs 3040) purely because the BFS seed cell is `((x+55)/40, y/40)`, which is not
rotation-equivariant; the geometry itself is exactly symmetric (see §5).

## 3. Chokes and the two attack routes

Terrain is the only tool — no elevation, no ramps, no rocks — so every choke is a
gap left between two blocking rectangles.

**Six named chokes per quadrant, 24 in total.** Measured cross-section is the widest
free run with the engine's 12-unit mobile clearance, i.e. the usable width, so a
160-unit gap measures 138.

| Choke (P0's copy) | Gap | Usable | Connects |
| --- | --- | --- | --- |
| `main_door_a` | 180 | **158** | main <-> natural — the "ramp" |
| `main_door_b` | 160 | **138** | main <-> third — the back door |
| `nat_north` | 160 | **138** | natural <-> north lane |
| `nat_east` | 160 | **138** | natural <-> centre — the natural's front |
| `map_edge` | 160 | **150** | outer lane past the ridge, into the neighbour |
| `ring_gate` | 160 | **138** | third <-> next quadrant's ring road |

All 24 measure identically per role across the four quadrants (see `selfcheck.txt`).

### The main has two doors, on purpose

`main_door_a` (180) faces the natural; `main_door_b` (160) faces the third. A single
choke therefore never seals a player into their main. The cost of that decision is
that the **natural and the third are not directly connected** — the short path
between them runs back through the main (1400 walked vs 901 straight, a 55% detour).
That is deliberate: the main is the hub, the two expansions face opposite ways, and
holding both spreads you. It is also the single thing I would most expect a playtest
to complain about.

### Route P0 <-> P1 (adjacent)

1. **Outer lane** — Door A, natural, `nat_north`, the north antechamber, `map_edge`
   past the ridge's head, straight onto P1's *third*, then P1's `main_door_b`.
2. **Centre lane** — Door A, natural, `nat_east` past the ridge's tail, up the
   320-wide north-south corridor, into P1's `nat_east` and natural.
3. **Plaza** — same corridor turned south into the plaza's NE gate.

### Route P0 <-> P2 (the 1v1 cross pairing)

1. **Through the plaza** — natural, `nat_east`, NE corridor, plaza, SE gate, P2's
   `nat_east`.
2. **Ring road clockwise** — third, `ring_gate`, through P3's quadrant.
3. **Ring road anticlockwise** — through P1's quadrant.

### Verified, not asserted

Naming routes is design talk. The script does the actual proof: it takes each of the
24 choke windows in turn, deletes every navigation cell in it (plus a one-cell
apron), re-runs the BFS, and checks all four starts are still mutually reachable.

```
  block P0 main_door_a (main <-> natural)              all four starts still connected
  block P0 main_door_b (main <-> third)                all four starts still connected
  ... (24 of 24)
```

**24 of 24 pass.** No single choke seals any player in, and no single choke is the
only way between any two mains.

### The plaza

Four blades pinwheel around the centre, leaving **four 340-wide gates** at NE, SE, SW
and NW. The interior is a clear ~580x580 arena holding all five contested catalyst
deposits. 340-wide gates on four sides is far more frontage than a 60-unit army can
garrison, which is what "deliberately hard to hold" has to mean in an engine with no
high ground. The wide gates are also the requested open flanking space.

## 4. How four-fold symmetry was achieved

One quadrant is authored; the other three are generated. About the centre (1600,1600):

```
rot(x, y)         = (3200 - y, x)
rot([l,t,w,h])    = [3200 - t - h, l, h, w]     (axis-aligned rects stay axis-aligned)
```

Every start, deposit and rectangle is emitted as an orbit of four. The checker
independently verifies closure rather than trusting the generator:

```
-- symmetry -- rot90 about (1600,1600) closes over 4 starts, 81 deposit sites, 24 rects
```

Each deposit site is compared as `(x, y, amount, kind)`, so a rotation that landed on
the right spot with the wrong stock or currency would still fail.

Because `rot` applied twice is a 180-degree point reflection, **the two cross
positions used for 1v1 are an exact point symmetry of each other** — the strongest
fairness property available, and the reason four starts costs 1v1 nothing.

The mineral lines pinwheel too: P0's is pressed against the left edge, P1's against
the top, P2's against the right, P3's against the bottom. Each hub stands between its
mineral line and the open map.

## 5. Self-check

`check_map.py` re-implements `MapDefinition::validate` and `validate_routes` from
`server/src/maps.rs` rather than paraphrasing them. Three details matter and are
reproduced exactly:

- **`terrain_free` is not a distance test.** It is a per-axis expanded-rectangle test
  with strict inequalities: blocked iff `x > l-m && x < l+w+m && y > t-m && y < t+h+m`.
  A point off a rect's corner by (20, 40) is *free* at margin 32. Treating it as
  Euclidean would have rejected valid placements and, worse, accepted invalid ones.
- **The BFS seed is `((starts[0].x + 55)/40, starts[0].y/40)` with `as i32`
  truncation** — note the `+55` on x only. Seed cell (16, 15), centre (660, 620).
- **Edges are segment tests**, not cell tests: 4-neighbour, sampled every 8 units at
  12-unit clearance, which is what catches thin walls between grid centres.

### Result: zero violations, zero warnings

```
== quadrille v1 size 3200 ==
  starts 4  deposits 81 (64 material / 17 catalyst)  terrain 24
  total material 98400, total catalyst 41800
  BFS seed cell (16, 15) centre (660.0, 620.0)  -> 4972 cells of 6400
  navigation components: 1429 total, 1 larger than one cell (sizes [4972]);
                         1428 isolated single cells (inside terrain)
  ...
-- warnings --
  none
-- violations --
  none  ** map satisfies every validator rule **
```

**Reachability.** The grid has 6400 cells. 1428 sit inside terrain and are singletons.
The remaining **4972 form exactly one connected region**, and the BFS from start 0
reaches all 4972 — so nothing is isolated anywhere on the map, not merely "the
deposits happen to be reachable". All four worker-exit points and all 81 deposits pass
the `accessible()` test (a reachable cell centre within 60 units with a clear segment).

### Margin headroom, not just pass/fail

A map that passes by 0.2 units is a map that fails after an f32 round-trip. Every rule
was also re-checked with 1.0 unit of extra slack (zero warnings), and the worst case
for each rule was measured:

| Rule | Floor | Worst in this map |
| --- | --- | --- |
| deposit -> terrain | 32 | **78.0** |
| deposit -> start | 110 | **140.0** |
| deposit -> deposit | 64 | **72.4** |
| deposit -> map edge | 32 | **200.0** |
| start -> terrain | 50 | **200.0** |
| start-unit spot -> terrain | 12 | **145.0** |
| start -> start | 220 | **2000.0** |

The tightest is deposit-to-deposit at 72.4 (the 30-degree mineral-arc chord at r=140),
8.4 units of slack. Everything else has 30+ units. f32 error on these coordinates is
under 1e-4, so nothing is near a boundary.

## 6. Concerns

Ordered by how likely they are to actually bite.

### 6.1 The map cannot be loaded yet — `WORLD_SIZE` is still 1600

`server/src/rules.rs:258` is `pub const WORLD_SIZE: f32 = 1600.0;` and `maps.rs`
rejects anything else ("Only 1600-unit square maps are currently supported"). This
proposal is dead on arrival until the in-flight `size`-3200 work lands. `validate_position`
in `rules.rs` also clamps to `16.0..=WORLD_SIZE-16.0`, and the client presentation is
documented as assuming 1600. **I could not run `validate_map` against this file** —
both because the constant is wrong and because I was told not to run cargo. The
Python checker is a faithful re-implementation, not a substitute for the real one;
somebody should run `cargo run --example validate_map` once the size change lands.

### 6.2 MAX_UNITS = 60 is the real problem with a 3200 map

`rules.rs:259` caps a player at 60 units *including workers*. Saturating three bases
is roughly 30-36 workers, leaving ~24-30 army. On this map that army has to cover a
main with two doors, a natural with three, a third on a crossroads, and four
340-wide plaza gates, with 36 s between the cross-position mains.

I do not think 24-30 units can hold three bases here. The likely failure modes are
(a) nobody takes a third, so the map plays as a 1600-scale map with a long walk, or
(b) whoever attacks first always wins because defence cannot be everywhere. **This is
the one thing I would change first**, and the cheapest fix is on the rules side
(raise the cap, or exclude workers from it) rather than shrinking the map.

### 6.3 Chokes are 3-4 navigation cells wide

A 160-unit gap leaves 136 of clearance-12 space, which is 3 cell centres on the
40-unit grid (4 for the 180-wide `main_door_a`). The static validator is happy, but
runtime flow-field or steering behaviour through a 3-cell aperture with 20-30 units is
exactly where RTS pathing misbehaves. `MAP-AUTHORING.md` says as much: grid validation
is "not proof of ... flawless runtime movement". If units jam, widen all six chokes to
200 (usable 176, 4-5 cells) — the generator makes that a one-line change per rect.

### 6.4 Starting units spawn at fixed, unrotated offsets

The engine spawns the three starting units at `(+55,0)`, `(0,+55)`, `(+55,+55)` — the
same offsets for every slot, never rotated. A rotationally symmetric map therefore
*cannot* give all four players identical first walks. My first draft was badly skewed
(nearest deposit 122.1 for P0 vs 67.9 for the rest). Choosing mineral-arc angles that
satisfy `A == -A` (mirror-symmetric about +x) halves the problem, because `rot` adds
+90 degrees and that condition makes each quadrant's arc the mirror of the previous
one's about the 45-degree spawn diagonal:

```
  start[0] nearest deposit from a spawn spot   88.0, sum over the three spots  372.5
  start[1] nearest deposit from a spawn spot   88.0, sum over the three spots  372.5
  start[2] nearest deposit from a spawn spot   62.2, sum over the three spots  238.2
  start[3] nearest deposit from a spawn spot   62.2, sum over the three spots  238.2
```

`arc_search.py` brute-forces spacing, radius, arc centre and catalyst offset and
confirms **no 6-point arc equalises all four** — it needs a set invariant under +90
degrees, which requires a multiple of 4 points, i.e. a full 60-degree ring rather than
an arc. The residual gap is 25.8 units of first walk (~0.26 s at worker speed 100) and
134 units summed over three workers (~1.3 worker-seconds). Negligible in practice, but
it is a genuine asymmetry and it is the engine's, not the map's. **The correct fix is
to rotate the spawn offsets per slot in `simulation.rs`**; then a full-ring or any arc
would be exactly fair.

### 6.5 The natural has three entrances

Door A, `nat_north` and `nat_east`. GAME-DESIGN asks for "a reasonably defensible
first expansion"; three 138-158 unit apertures is defensible-ish but not cheap. I
considered sealing `nat_north`, but that would have made `nat_east` the natural's only
outward link and the two-route requirement then leans entirely on the main's back
door. Design judgement, not a measured result.

### 6.6 Resource amounts are guesses

98,400 material is about four times the current skirmish map's total, and no economy
tuning exists to justify any of it. I set main/natural material to 1600 and third to
1400 so a third is worth less than a natural, and made the plaza catalyst (3600, and
5000 on the centre point) clearly the best per-trip prize on the map. All seven
numbers are placeholders — they should move with the dual-currency work, not be
treated as balanced.

### 6.7 Other judgement calls, not verified by anything

- **Natural at 652 from the main, 791 from the centre.** The brief's 600-750 band on a
  3200 map forces the natural roughly halfway to the middle; it is more forward,
  relative to map size, than an SC2 natural.
- **The third is on the far side of the main from the natural** (§3). Distinctive, and
  the thing most likely to feel wrong in play.
- **Each third sits next to the neighbour's `map_edge` choke** — P1's third at
  (1750, 400) is a short walk from P0's exit. Intentional ("more exposed than the
  natural") and spicy in FFA; irrelevant in 1v1 cross, where both neighbour slots are
  empty.
- **No terrain inside the plaza.** With no line-of-sight or projectile masks in the
  engine, obstacles there would only obstruct movement and annoy pathing without
  adding cover. Revisit once sight/fire masks exist.
- **24 of 256 rectangles used.** The map is deliberately open. There is a lot of
  headroom to add texture, but every addition appears four times and I preferred
  fewer rectangles I could reason about to more that might pinch a rotated corridor.

## 7. What is verified by script vs. what is judgement

**Verified by `check_map.py`** (all pass, zero violations, zero warnings):

- every ID / version / size / count rule
- every terrain rectangle's bounds and positive extent
- start edge margin (60), terrain clearance (50), mutual separation (220)
- all three start-unit spots: inside-16 and terrain-free-12, for all four starts
- every deposit: unique positive id, positive amount, edge-32, terrain-32, start-110,
  deposit-64
- the full route BFS, reproducing the seed cell, the 4-neighbour expansion, the 8-unit
  segment sampling and the `accessible()` rule
- whole-grid connectivity: exactly one multi-cell region, 4972 of 4972 free cells
- exact rot90 closure over starts, deposit sites (position, amount and kind) and rects
- the measured cross-section of all 24 chokes
- the two-route property, by deleting each choke in turn and re-testing connectivity
- worst-case headroom on every margin rule, plus a full re-run with 1.0 unit of slack
- grid walking distances between every pair of mains and within a quadrant
- the starting-unit spawn asymmetry (§6.4), and the arc search proving it is unfixable
  by map data alone

**Design judgement, not verified by anything:**

- that 138-158 is a *good* choke width rather than merely a legal one
- that three natural entrances and two main doors is the right trade
- that routing natural-to-third through the main is interesting rather than annoying
- that a 340-wide four-gate plaza is genuinely contestable
- every resource amount
- that a 3200 map is playable at all under MAX_UNITS = 60 (§6.2) — I think it may not be
- that runtime movement through these chokes will behave (§6.3)

None of it is a substitute for a game. Per GAME-DESIGN's own warning: symmetry does not
prove matchup fairness, and this proposal proves geometry, not balance.
