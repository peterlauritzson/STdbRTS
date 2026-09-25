# Implementation Plan

Working document. Owns the *ordering and scope* of work; [HANDOFF.md](HANDOFF.md) owns
*what has actually been validated*. Design intent stays in
[GAME-DESIGN.md](GAME-DESIGN.md), [COMMANDS-AND-BEHAVIORS.md](COMMANDS-AND-BEHAVIORS.md),
[ARCHITECTURE-AND-UX.md](ARCHITECTURE-AND-UX.md); milestone structure in
[ROADMAP.md](ROADMAP.md); settled choices in [DECISIONS.md](DECISIONS.md).

Started: 2026-09-22.

## How work is split

Each increment below names the files it owns. Increments that own disjoint file
sets may run in parallel; increments that overlap must be sequenced. An agent
given an increment gets that file list as its boundary and must not edit outside
it. The coordinating session verifies the result itself — reads the diff, runs
the gates — before marking an increment validated in HANDOFF.md.

Gates, by area:

| Area | Command |
| --- | --- |
| Rust core | `npm run test:core` |
| Client unit | `npm run test:client` |
| Both | `npm test` |
| Types | `npm run typecheck` |
| Production build | `npm run build` |
| WASM adapter | `cargo check --manifest-path server/Cargo.toml --target wasm32-unknown-unknown` |
| Map validation | `npm run validate:maps` |

User-visible changes additionally require playing the affected interaction in a
real browser. Test passes alone do not close a UX increment.

## Increment A: playtest UX findings

Closes findings 1 and 2 of [PLAYTEST-2026-09-19.md](PLAYTEST-2026-09-19.md).
No gameplay, schema, or balance change.

Owns: `src/main.ts`, `styles.css`, `index.html`, `tests/presentation.test.ts`.

- **A1** — rejected command rows show their reason inline, wrapping, inside a
  bounded history area. Today the reason is only `row.title`
  ([main.ts:285](../../src/main.ts#L285)), so a correct rejection reads as a
  broken button. Keep the tooltip; add visible text. Do not change rejection
  timing or cancellation semantics to make the problem less visible.
- **A2** — short-height desktop layout. `.match` is
  `grid-template-rows: 50px minmax(240px, 1fr) 310px` ([styles.css:69](../../styles.css#L69)),
  so a 310px fixed command deck leaves ~240px of battlefield at 990x650. Add a
  short-height breakpoint that compacts the deck. The existing `max-width`
  breakpoints at 1000px and 760px must keep working.

Status: **validated 2026-09-22**. Measured in a real browser at 990x650: the
battlefield went from 240px (overflowing `.match` by 14px) to **302px**, and the
inline reason renders as `Production queue is already empty` on its own
full-width line. See [HANDOFF.md](HANDOFF.md) for evidence and limits.

## Increment B: M0 match identity and delay contract

The rest of the M0 contract the handoff asks for: frozen ruleset and map
identity per match, and a command delay that is a ruleset field rather than a
compile-time constant. No per-client authority over either.

Owns: `server/src/rules.rs`, `server/src/maps.rs`, `server/src/schema.rs`,
`server/src/lobby.rs`.

Already true and must be preserved: `Room.command_delay` exists
([schema.rs:15](../../server/src/schema.rs#L15)), is frozen at room creation
([lobby.rs:94](../../server/src/lobby.rs#L94)), and is what `issue_order`
schedules against ([game.rs:244](../../server/src/game.rs#L244)). The gap is
identity, bounds, and configurability.

- **B1** — map identity available from the map layer: `id`, `version`, and a
  deterministic content hash over the parsed definition.
- **B2** — ruleset identity: a `RULESET_VERSION` that must be bumped whenever
  the frozen rules surface changes.
- **B3** — `Room` records `ruleset_version`, `map_id`, `map_version`, `map_hash`
  at creation and never mutates them afterwards.
- **B4** — command delay becomes a bounded ruleset value:
  `COMMAND_DELAY_MIN`/`COMMAND_DELAY_MAX` around a `DEFAULT_COMMAND_DELAY` that
  stays **20 ticks**, covering the 0.5s/1s/1.5s trial points the commands doc
  names. Out-of-bounds values are rejected at room creation, not clamped
  silently.
- **B5** — tests: delay boundary accept/reject, default still 20, accepted
  commands schedule against the room's frozen delay and not the constant, map
  hash pinned as a regression so geometry changes are caught, and an existing
  room with the old delay still behaves after reconnect.

Out of scope here, deliberately: a lobby UI control for delay (M4 lobby work),
publishing, and any migration. Adding `Room` fields is a breaking schema change,
so it is **not** published to an existing database from this increment.

Status: **validated 2026-09-22**, against a new local database `stdbrts-m0`.
Every live room froze `command_delay 20`, `ruleset_version 1`, `skirmish` v1 and
`map_hash 5368541743987556208` — the same value pinned as
`0x4a80_e445_bc3b_ff70` in the Rust test. The pre-existing `stdbrts-playtest`
database was not touched. See [HANDOFF.md](HANDOFF.md).

## Increment D: dual-currency economy, refunds, stipend (server)

The first slice a player can *see*. Increments A-C changed plumbing and
feedback; this one changes how the game is played.

Owns: `server/src/rules.rs`, `server/src/simulation.rs`, `server/src/maps.rs`,
`server/src/schema.rs`, `server/src/game.rs`, `shared/maps/skirmish.json`.

Values are fixed in [DECISIONS.md](DECISIONS.md) and are labeled experimental.

- **D1** - Material and Catalyst replace the single ore balance, with costs that
  make specialists require both. Affordability needs both currencies; partial
  payment is impossible.
- **D2** - army deaths (soldier, scout, siege) refund 50% of both currencies,
  once, never to an eliminated player. Workers and buildings refund nothing.
- **D3** - opening stipend, 200 material/min for 90s then 100/min for 90s, on an
  integer tick accumulator rather than a float balance.
- **D4** - map deposits gain a `kind`; two of the skirmish map's eight become
  catalyst. Map version goes to 2 and `RULESET_VERSION` to 2, so the identity
  freeze from Increment B earns its keep on its first real content change.

Status: **server validated 2026-09-22**. 71 Rust tests pass (was 49). The
20-minute determinism soak now asserts **per-currency** conservation with cargo
attributed by `cargo_kind`, which is strictly stronger than the previous single
total and proves the two currencies can never convert into one another. The
agent also reduced the two catalyst deposits from 4000 to 1200, which was not
asked for but is justified: at a catalyst price of 50, a 4000 stock is
effectively infinite and not worth contesting. Not yet published or played.

## Increment E: dual-currency client

Follows D and cannot start before it, because it consumes D's regenerated
bindings. Owns `src/`, `index.html`, `styles.css`, `tests/browser/`.

The economy header shows both currencies distinctly, the command card shows
multi-resource costs and disabled reasons, catalyst deposits are visually
distinct from material ones on the battlefield and minimap, and refunds are
legible when they happen. The practice bot must understand both currencies or it
will stop functioning as an opponent.

Status: **implemented 2026-09-22; played since** through steps 13-20 (both
currencies are read, spent and mined in every scripted and bot match). Client gates pass; 14
presentation tests (was 7). Catalyst is distinguished by silhouette and label as
well as colour — three haloed spires against material's five chunks on the
battlefield, a rotated outlined diamond against a square on the minimap, and the
amount written as `1200 CAT`. Prices in `catalog.ts` were silently wrong before
this (siege 200 flat, factory 250, lab 200, research a hardcoded 150) and now
match the server table. Browser verification still outstanding.

## Increment F: first territory mechanic

The existing `outpost` becomes an autonomous extractor in the Industrial mould:
it generates income without a worker, its output is switchable between material
and catalyst, and sustained hostile damage suppresses that income for a fixed
recovery window rather than requiring demolition. This is the cheapest route to
a genuine Honey Badger territory mechanic because the building already exists.

Suppression must be driven by authoritative damage events, never by a visual
attack animation. Per [GAME-DESIGN.md](GAME-DESIGN.md) the source duration is an
open question, so it ships as a labeled experimental value.

Status: **not started, and deprioritised by the author** (2026-09-24: one of
the least important mechanics). Do not pick it up because it looks cheap.

## Sequencing note

D through F build Honey Badger mechanics onto the existing shared roster. That
is deliberate and matches M2's exit criterion, which expects a greybox match on
one temporary shared roster before the three factions diverge in M3. Splitting
into Network, Organic and Industrial comes after the mechanics work, not before.

## Increment G: map expansion to a melee layout

Map design is in scope for this conversion, not a later task. The current
skirmish map is 1600x1600 with four lone corner starts, eight single deposits
and four tiny terrain blocks: no expansions, no chokes, no contested ground.

Owns: `shared/maps/skirmish.json`, `server/src/maps.rs`, `server/src/rules.rs`,
`server/src/simulation.rs`, `src/presentation.ts`, `src/battlefield.ts`.
Sequenced **after** Increment D, which is editing several of these.

- **G1 - variable map size.** `size` is pinned to exactly `WORLD_SIZE`
  ([maps.rs](../../server/src/maps.rs) rejects anything else) and `WORLD_SIZE`
  is a compile-time constant used by `validate_position`
  ([rules.rs](../../server/src/rules.rs)) and unit separation
  ([simulation.rs](../../server/src/simulation.rs)). The client duplicates the
  constant in [presentation.ts](../../src/presentation.ts) and hardcodes its
  half-value `800` for camera centring in
  [battlefield.ts](../../src/battlefield.ts). All of this must become
  map-driven before the map can grow. Accept a bounded range, not any value.
- **G2 - the new map.** A four-player melee layout at `size: 3200`, keeping
  exactly four starts because the validator requires four and a four-spawn map
  is a standard SC2 layout; 1v1 uses cross positions. Each spawn gets a main
  with a mineral line, a natural behind a choke, an exposed third, and a
  contested centre holding the high-value catalyst. At least two attack routes
  between any two mains.
- **G3 - validation and play.** Static reachability must pass for every start
  and deposit, and the map must actually be played, not merely validated.

Constraints the engine imposes on the design: no elevation, no ramps, no
destructible rocks. Chokes are gaps between blocking rectangles. Navigation is a
40-unit grid with 12-unit clearance, so corridors need to be comfortably wider
than one cell for groups to move through.

`MAX_UNITS` was raised to **120 per player** on the author's instruction
(2026-09-25). The last measurement at 120 on crossfire was ~26-28ms p95 on a
busy machine, against a 25ms budget: rerun `bench_load` on an idle machine.

Status: **done** as HANDOFF step 9 (the crossfire melee map, played on since).

## Increment H: factions and asymmetric mining

The economies stop being one shared loop. Values are fixed in
[DECISIONS.md](DECISIONS.md).

- **H1 (server)** — a `faction` per player; three labour units (`worker`,
  `drifter`, `harvester`) plus the Organic `drone` builder; three gather models;
  Organic hub stock with regeneration and a cap. Owns `server/src/rules.rs`,
  `simulation.rs`, `schema.rs`, `lobby.rs`, `game.rs`.
- **H2 (client)** — faction selection in the lobby, the new units in the catalog
  and command card, distinct rendering per labour unit, Organic stock shown as a
  real resource readout, and a bot that can play all three. Owns `src/`,
  `index.html`, `styles.css`, `tests/`, `scripts/`.

Status: **validated 2026-09-22** against a live database `stdbrts-fac`. 99 Rust
tests, 23 client tests, 4 browser tests and 12/12 integration tests, including a
new subtest that proves the slot rotation, each faction bootstrapping with its
own labour, the three cross-faction refusals word for word, a drifter crediting
in place with `cargo == 0` and `returning == false`, and Organic stock accruing
to its cap while an Industrial hub holds zero forever. Practice runs as Network,
so drifters now do the building in the browser suite.

Follow-up, 2026-09-24: **the practice bot fields an army again** after tech
gating. Hubs are only asked for labour, checked through `canProduce`, the
client mirror of `rules::producer`; barracks and factory produce army. The bot
had never placed a barracks on crossfire — all nine hardcoded offsets were
obstructed — so site choice is now a ring search 220–460 from the HQ on 24
bearings, preferring sites more than 180 from a deposit, which also removed a
stale `hq.x < 800` extent. Live three-way on crossfire: barracks placed at
10–11s for every faction, four army alive by 60s (Industrial), 48s (Network)
and 35s (Organic), zero hub refusals.

## Increment I: zones

The territory layer, and the mechanic the author ranked first. Full design in
[ZONES.md](ZONES.md), rewritten from the author's direct account of the
reference game.

One zone per faction, each paired with that faction's mining model:

- **Industrial sensor tower** — units move about 30% faster in a long radius.
  Movement cost only. **Built first**: it needs the zone primitive plus a speed
  modifier and nothing else, so it proves the model with the least machinery.
- **Organic creep** — grows from hubs only, recedes when the source dies, slows
  the owner's harvesters to 0.6x off it (no drain or death), and **the owner's
  units dying on it spawn free temporary units** whose kind depends on the dead
  unit's cost. The ground/air split is documented only; no air unit exists.
- **Network power field** — workers can be created at any structure inside it
  and mine immediately, shields regenerate faster, a unit dying in it restores
  shields to nearby friendlies scaling with its total health, and **any unit can
  teleport from anywhere in the field to anywhere else in it**. Built last: it
  needs shields as a second health pool first, then teleport.

None of the three blocks sight, so **the territory layer is not blocked on the
private-state experiment**. The earlier draft wrongly made Industrial smoke the
third zone, which had put per-viewer visibility on the critical path for no
reason; smoke is a unit ability in the reference game, not a territory mechanic.

Status: **primitive and the sensor tower validated 2026-09-23**. 104 Rust tests,
27 client tests, 4 browser tests, 12/12 integration. Zones are derived state:
nothing persists or removes one, so a destroyed source has no field on the next
rebuild. Overlap takes the **strongest**, never stacks, so a player cannot carpet
an area for unbounded speed. `movement_speed` is the single accessor every
movement path goes through, and a test enumerates `ZoneConcept::ALL` to prove the
sensor field participates in movement and **nothing else** — that test fails if a
seventh concept is added without being considered.

Cost, measured: p95 went 7.3ms to 9.1ms at 60 units per player and 14.4ms to
18.4ms at 120. Both inside the 25ms budget, but that is +25% for one zone type
with a handful of sources. Creep will have many, so the per-tick rebuild is the
thing to watch. Creep and the power field are still to come.

Status, creep: **server, persistence and client rendering done and validated
2026-09-24**. 135 Rust tests; client 42/42; integration 12/12; browser 4/4.
`RULESET_VERSION` 6. Values and rationale in
[DECISIONS.md](DECISIONS.md), design in [ZONES.md](ZONES.md). One disc per hub
(`CreepPatch`), carried between ticks in `World::creep` because recession
outlives the source — the only zone state that is not derived. `ZoneField` is
now indexed by concept and by effect, and the off-creep slow is only walked for
creep-dependent kinds, so every non-harvester speed is bit-identical to before.
Death spawns resolve against the start-of-tick field; temporary units expire by
removal at the top of the tick, never through the death pipeline.

Cost, measured: persistence is a new `creep_patch` table diffed on save —
~0.03 row writes per tick (66 over 2400 ticks with two outposts, one lost) and
0 while radii are static. The read side, an index scan per tick, is unmeasured.
Tick cost was indistinguishable from noise on a busy machine (p95 ~12.5–14ms
against 12.6–13ms at 60 per player; ~26–28ms both ways at 120), so it must be
rerun on an idle machine before it is quoted against the 9.1/18.4ms baseline.

## Increment J: command-card construction

Remove worker-driven building. Construction is ordered from the command card and
the building raises itself, as in the reference game — see
[DECISIONS.md](DECISIONS.md). Placement rules stay; the worker requirement goes.

This touches `construction_remaining`, the `construct` order, builder
assignment, the placement UI and the practice bot, so it is its own increment
rather than a rider on another. The open questions were settled 2026-09-25: no
cancellation (remove `cancel_construction`, its refund and the client button),
no interruption (an accepted placement builds until done or destroyed), and
build radius stays part of placement.

Status: **implemented 2026-09-25** (HANDOFF step 20). The site raises itself
at one tick of work per tick; the command names the HQ only because a command
must name a unit; `construct` and `cancel_construction` are gone, as are the
75% refund and the client's cancel button. It exposed a pre-existing routing
stall (a worker at a hub's edge could not route behind the hub), fixed in
`navigation::advance`. Played by script; not yet by a person.

## Increment K: primary-hub victory

A player is out once every **completed** hub (HQ or outpost, any faction) is
gone; a same-tick last-hub loss on both sides is a draw. Settled by the author
2026-09-25, see [DECISIONS.md](DECISIONS.md). Research moves from the HQ unit
to the player row so it survives the HQ (schema change: new database
`stdbrts-hub`). The bot plays on from an outpost and attacks hubs, not only
HQs; the in-match banner reads "Eliminated"; the refusal reads "You have no
hubs left". `RULESET_VERSION` 10.

Status: **implemented 2026-09-25** (HANDOFF step 21). Followed by step 22: every outpost trains its labour, and training is C&C style (no selection needed).

## Increment M: match history and the score screen

A post-match screen with graphs. [ARCHITECTURE-AND-UX.md](ARCHITECTURE-AND-UX.md)
already asks for this in the right shape: results should explain
"territory/economy/loss/refund trends, not just kills".

- **M1 (server)** — cumulative `collected`, `lost` and, if attributable,
  `killed` counters per player, plus a `match_sample` time series written every
  100 ticks and once more the moment a match finishes. Samples die with the
  match. Owns `server/src/`.
- **M2 (client)** — the score screen itself. Owns `src/`, `index.html`,
  `styles.css`, `tests/`.

The two graphs the author asked for are **income** and **army value**. Income
must be *mined* income: the opening stipend pays 200 material/minute for 90
seconds and then 100/minute for 90 more, with no deposit drain at all, so
folding it into an economy graph would make the line a lie about how well
anyone actually mined. Worth showing — but as its own thing, not as income.

Other series worth plotting, all cheap once the samples exist: banked resources
(unspent, which reads as "floating"), labour count, army count, and cumulative
value lost. Together those say why a match was won or lost in a way a kill count
never does.

Status: **validated 2026-09-23**. 113 Rust tests, 36 client, 4 browser, 12/12
integration, and the rendered screens inspected rather than inferred from
assertions.

## Increment C: M1 private-state spike

Gates fog, smoke, hidden scouting and fair bot vision. Everything in M2/M3 that
touches information depends on the answer, so it runs before any of it.

The question: can the installed SpacetimeDB stack express private canonical
tables plus caller-filtered indexed views, such that an adversarial third client
cannot read rows it was not authorised to see — by direct query, arbitrary
subscription, join, initial snapshot, incremental update, deletion, or error
text?

This is an experiment with a written decision record, not a feature. It needs a
real server and a separate development database. If the installed SDK cannot
express it, that is a finding; the response is a deliberate, isolated SDK
upgrade attempt, **not** publishing projections and filtering on the client.

Status: **not started, and demoted to the bottom of the list** (author,
2026-09-25): fog of war may not be needed in the end. Nothing is waiting on it.
The rule in [DECISIONS.md](DECISIONS.md) still holds if fog is ever wanted: no
fog, smoke or hidden scouting without this experiment first.

## Standing design note: attacking while moving

Units auto-attack enemies in range while moving (the author's requirement,
2026-09-25). This is already true for every unit and pinned by a test. Whether
some kinds should stop to fire instead, and whether a plain move should ignore
enemies, is settled (2026-09-25): a per-kind stat, and `move` keeps firing. See
[DECISIONS.md](DECISIONS.md).

## Ordering

Fog no longer gates anything. The next chunky work is listed in
[HANDOVER-2026-09-25.md](HANDOVER-2026-09-25.md). M1's remaining experiments
(movement, renderer, tick instrumentation) are independent and may be scheduled
in any order.

## Standing constraints

- Preserve the existing playable skirmish while the new ruleset develops.
- Do not commit or publish without an explicit reason and authorisation.
- Breaking schema work goes to a new development database, non-destructively.
- Generated bindings stay generated (`npm run generate`); never hand-edited.
- Record failures honestly. Do not mark a gate passed without new evidence.
