# Implementation Handoff

Updated: 2026-09-25. User authorized implementation and requested a handoff at every step.

## Resume Here

**Step 30: bandwidth (2026-10-02, not committed).** Server-to-client load cut about 7x. `RULESET_VERSION` 17, a schema change: new local database `stdbrts-net` (`stdbrts-roster` and Maincloud untouched). The core `Entity` is unchanged; `Entity::split()`/`join()` (simulation.rs, round-trip test) persist it as four tables keyed by the same id with a `match_id` index: `unit` (public, cold: owner, kind, order, queue, cargo, cargo_kind, production, construction_remaining, stock, expires_tick, max_hp, max_shields, warp_tick, arrive_tick, energy, ability_ready_tick, cast, kills), `unit_motion` (public, hot: x, y only), `unit_vitals` (public, combat: hp, shields, shot_tick/x/y, damaged_tick, passive_ready_tick; Entrenchment rewrites the last every tick while held) and `unit_state` (PRIVATE: returning, next_attack, last_attacker, contact_tick, anchor_x/y/tick). `save_world` diffs each part against its own row; `load_world` joins by id through hash maps (O(n)). Client: `src/units.ts` `UnitMerger` merges the three subscriptions into one `Entity` (reused object while no part changed, so the battlefield's `before !== unit` check still works; a unit shows once all three rows are present, in any arrival order); `Entity` is now imported from `./units` (the generated type no longer exists). Bots, `scripts/client.ts`, integration test use it (the test no longer reads `returning`, which is private). Bench (`bench_load`, per subscribed client, estimated BSATN, update counted once; real wire sends old+new): 2x400 expanse 759 -> 791 public rows/tick, 161.8 KB -> 22.1 KB per tick (3159 -> 432 KB/s); 4x400 1499 -> 1562 rows/tick, 318.8 KB -> 43.6 KB per tick (6227 -> 852 KB/s). Measured in a browser (Playwright websocket frames, small practice match, one client): 42-49 KB/s. Checked and left alone: `command` rows are already pruned 200 ticks after execution and the client needs scheduled ones of all owners only for its own slot (owner-only filtering needs per-row visibility, not done); `match_sample` is written every 100 ticks only; `room` is rewritten every tick (one small row); `resource_node` rewrites on each mining tick (small); subscriptions are already scoped by `match_id`. Not done: fog of war or interest filtering, tick rate.

**Step 29: roster and passives (2026-10-02, experimental, not committed).** Nine new army kinds (marksman, medic, bulwark; arcer, phantom, warden; prowler, devourer, behemoth), three faction static defenses (bunker, bastion, spine; terrazine 125, gated by `building_faction`, fired through `is_static_defense`), and one passive per kind including the existing ones ([ROSTER-PASSIVES.md](ROSTER-PASSIVES.md) is the spec plus an "As built" section). `RULESET_VERSION` 16; the `Entity` row gained `passive_ready_tick`, `last_attacker`, `contact_tick`, `kills`, `anchor_x/y/tick`, so this is a schema change: the build is on the new local database `stdbrts-roster` (Maincloud untouched, nothing deployed). `rules.rs` holds `passive(kind)` and a constant section per passive; `step_on` routes every shot, splash, bounce and burst through `Hits::deal` (phase shift, guardian, attribution), speed passives go through `movement_speed(unit, zones, tick)`. Client: roster and tooltips from `catalog.ts` tables, train keys Q W E R D Z X, refinery stays on U for every faction, sprites and passive feedback (`passives.ts`: blink line, splash/ricochet/burst rings, medic line, entrenched bar, bunker plate, veteran pips). Bots and practice train one new barracks unit and one new factory unit and build the faction defense (then the turret). Also: miners retarget to a free patch within 450 of the *unit* (was 250 from the taken patch); a failed placement notice is cleared by the next successful one; a mixed selection right-clicking catalyst shows the notice and sends only the non-labour units; README Controls describe the three-currency economy and the roster. Tests: 212 core (185 before), 66 client; bench at 2x400 on expanse stayed 1.2 / 1.4 / 1.5 ms (p50/p95/p99). Not done: no browser (Playwright) run, so sprites and feedback are unseen by a person; the Playwright spec still quotes old prices; values are first-pass and unplayed; WASM tick time with the passives is unmeasured.

**Step 28: engine scaling (2026-10-02, not committed).** `MAX_UNITS` 400 and `MAX_BUILDINGS` 150 per player (client `catalog.ts` mirrors both), new matches on the 9600 `expanse` map (`DEFAULT_MATCH_MAP`, client bundles `shared/maps/expanse.json`, hash pinned both sides as `0x18f42e085fe019b4`), `RULESET_VERSION` 15. No persisted struct changed (generated bindings identical); the build is published to the new local database `stdbrts-scale` (Maincloud untouched). What changed in `step_on`: the navigation terrain grid is computed once per map and the building overlay once per building layout (thread-local memo, `navigation.rs`); per-unit A* is replaced by breadth-first route fields per goal, grown lazily, shared by every unit with the same goal and memoised across ticks while the building layout stands (pure function of layout + goal, so a cold cache gives identical routes); `free()`/line of sight test only the terrain rectangles and buildings bucketed to the point's cell; a per-tick `spatial::SpatialIndex` replaces the O(n²) scans (attack-move acquisition, auto-fire, building exits, id lookups); `separate_units` is bucketed but provably identical to the full pass (bit-for-bit test); `ZoneField` buckets effects carried by >16 zones; `validate_on`/`execute_on` look units up once per command and test the destination once; `save_world` deletes by sorted-id lookup. Bench (`bench_load`, release, `step_on` only, 600 ticks):

| tier | before p50/p95/p99 ms | after p50/p95/p99 ms |
|---|---|---|
| expanse 2×400 (must pass) | 979 / 1551 / 1614 | 1.2 / 1.3 / 1.9 (max 2.0) |
| expanse 4×400 | 2294 / 3685 / 3966 | 2.0 / 2.3 / 2.4 (max 2.6) |
| crossfire 4×120 (reference) | 32.3 / 52.1 / 54.5 | 0.40 / 0.46 / 0.54 |
| expanse 2×400, `churn` (a building every 2.5 s) | — | 1.1 / 1.4 / 10.6 (max 18) |
| expanse 4×400, `churn` | — | 2.0 / 2.5 / 25.1 (max 36) |

Known costs: a building appearing or dying invalidates every route field, so that tick re-grows them (the `churn` rows: in the bench ~160 scouts each route to a different far point, the worst case; real orders share goals). Route-field memory is bounded at 24 MB per cached layout, two layouts cached. Persistence is now the larger half: ~760 unit rows rewritten per tick at 2×400 and ~1510 at 4×400 (every moving unit; unchanged rows are already skipped). Behaviour differences: among equally short routes the field may pick a different one than A* did (lengths and reachability are identical, tested against A*). Integration test coordinates moved to the expanse main; the repair test now walks the 7900-unit cross-spawn (~100 s). Not done: browser Playwright specs still assume crossfire geometry and were not run; WASM tick time and whether the thread-local memo survives between reducer calls on SpacetimeDB are unmeasured.

**Step 27: the three-currency economy (2026-10-02, experimental, not committed).** `RULESET_VERSION` 14, a schema change: the build is on the new local database `stdbrts-econ` (Maincloud untouched). One miner per material patch (`Node.miner`, claimed on arrival, released on return/death/re-order, stale claims cleared every tick; a labour unit at a taken patch retargets to a free one within 250 or waits). Catalyst only from a `refinery` (75 material) built on a catalyst deposit (server snaps it to the node), 4 catalyst per 10 ticks, no workers; labour gather on catalyst is refused. Terrazine: 10% of material mined (Industrial 12%) derived from cumulative `collected.material`, no remainder lost; the turret costs 100 terrazine. Army is catalyst only, labour/structures/research material only. Base income is permanent (100 material/minute after the first 180s). Start balance 250 material, 100 catalyst. Bots and the practice AI build refineries first; HUD shows three balances; Build card key `I` is the refinery. Not done: the Playwright spec (`tests/browser/game.spec.ts`) still quotes the old prices and was not run. Every number is a named constant in `rules.rs`.

**Reference source changed (2026-09-29, docs only).** The author's changelog sheet ([REFERENCE-CHANGELOG.md](REFERENCE-CHANGELOG.md)) replaces the mod website as the reference; the website describes an earlier version. No code changed. Several built mechanics came from the website and differ from the sheet: depletion (the sheet has infinite resources), the opening stipend, army-only refunds, the 10s shield-regeneration delay, research at a lab. The author answered the same day (DECISIONS.md, "Three currencies, base income, instant research, build rules"): minerals/material for structures and research, gas/catalyst for the army, Terrazine for static defense; permanent base income; depletion kept; instant global research and tiers; build rules; Network regeneration and ricochet; the Industrial repair drone; Organic burrow; wider refunds. **Next action: Increment N in [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md), starting with N1**, Both sub-questions are answered: labour costs material; catalyst comes from automatic refineries for every faction. Treat RESEARCH.md's H1 sections as possibly obsolete.

Completed increments: the shared versioned map definition and validation (steps 1-4); the playtest UX fixes (step 6); the M0 match identity and delay contract (step 7); and the dual-currency economy plus a navigation livelock fix (step 8). Ordering and scope live in [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md); settled choices in [DECISIONS.md](DECISIONS.md).

Completed increment: **the melee map (step 9)**. The playable build is on the local database `stdbrts-map`. Earlier databases were not touched.

**Resolved (step 10): the tick rate.** Matches ran at 16.2 TPS instead of 20 because the tick stepped once per scheduler wake and the host does not deliver the requested period — 50ms requests arrived every 61.7ms. The loop now advances by elapsed wall time, capped at 4 ticks per wake. Measured after: exactly 20.0 TPS at a 50.0ms period. The one-second command delay had been running at ~1.23s, so **every delay and balance observation taken before this was against a clock 19% slow.**

Completed since: **faction selection and the first zone (step 12)**, **auto-gather and a live conservation audit (step 13)**, and **the post-match score screen (step 14)**. The playable build is on `stdbrts-live2`.

Since then: **the practice bot fields an army again (step 15)** and **Organic creep, including its client rendering (step 16)**. Creep's client rendering is done and validated 2026-09-24.

Latest: **shields and the Network power field (step 17)**, including the relay, drifter training at any powered structure, death restoration, teleport, and the Industrial sensor tower becoming buildable and visible on the client. All three factions' zones now exist in play. The playable build is on `stdbrts-shield`.

Latest after that: **faction armies (step 18)** and **practice opponent choice with a held first push (step 19)**, committed by the author as `2a5459b`.

After that: **command-card construction (step 20, Increment J)**, plus the unit cap at 120, a second barracks for the bot, a client-side map-hash check, the teleport cooldown, SC2-style shield shares by kind, and a fix for workers freezing behind their own hub. Committed as `11602c1`. The build is on `stdbrts-j`.

Latest: **primary-hub victory (step 21, Increment K)**. A player is out once every completed hub is gone, and research moved to the player row. This was a schema change, so the build is on the new database `stdbrts-hub`. Not committed.

Then: **outposts as town halls and C&C-style training (step 22)**. Every outpost trains its faction's labour, and train buttons need no building selected. Same database, `RULESET_VERSION` 11. Not committed.

Latest: **orders run at the client's stamped tick (step 26)**: the command delay now absorbs network jitter instead of adding to it, and a 500ms server stall shows a banner. Schema and ruleset change (`RULESET_VERSION` 13): the build is on the new database `stdbrts-sched`. Not committed.

Before that: **controls and layout (step 24)**: full-height battlefield, hotkeys on every button, control groups, edge scroll, minimap orders, and the map painted at its real size. Client only; the build is on `stdbrts-ux`. Not committed.

**The next chunky steps, with the questions to ask the author first, are in [HANDOVER-2026-09-25.md](HANDOVER-2026-09-25.md).** In short:

1. A person plays steps 18-20. The scripts are weak players and cannot judge the held push, drawing legibility or how construction feels.
2. ~~Behaviour presets~~: deferred by the author to near the end (2026-09-25). Players micro for now. Firing on the move becomes a per-kind stat.
3. ~~Primary-hub victory~~: done (step 21).
4. First faction abilities.
5. Movement and tick load at 120 units per player.
6. Renderer pilot.

**Demoted by the author:** fog of war and the private-state experiment (Increment C), which may never be built, and Increment F, the autonomous extractor. Do not pick either up because it looks cheap. *(2026-09-29: the extractor returns as the automatic refinery every faction uses for catalyst, inside Increment N1, without suppression or an output switch.)*

Smaller open items:

- [EXPERIMENT-C-PRIVATE-STATE.md](EXPERIMENT-C-PRIVATE-STATE.md) still holds the private-state protocol. The rule stands if fog is ever wanted: nothing about fog, smoke or hidden scouting without it.
- The client compares `map_hash` and warns on a mismatch. It still bundles its own map instead of receiving it from the server. `validate_map` does not print the hash.
- `tests/integration.test.ts` mirrors the stipend formula so its balance assertions can stay exact. If the Rust constants move, that helper must move with them.
- [quadrille](../../shared/maps/quadrille.json) is the superseded first melee map, kept as a 3200 test fixture. It still has catalyst in the centre and is not played.
- Unit costs, stats and resource amounts are all still first-pass experimental values.
- Tick cost: the zone field is rebuilt every tick; creep's cost and the 120 cap were only measured on a busy machine (~26-28ms p95 at 120 against a 25ms budget). Rerun `bench_load` on an idle machine. The `creep_patch` read is unmeasured.
- Every player opens with its labour **plus one fighter**: confirm that is intended.
- Only buildings (barracks, factory, lab, turret, outpost) are shared between factions, apart from the sensor tower and the relay.

Steps up to 20 are committed (`11602c1`). Steps 21 and 22 are not committed.

## Constraints

- **Keep the player guide current.** [docs/guide/](../guide/1-overview.md) is what players read, from the Guide link in the game. Any change a player could notice (a unit, building, ability, cost, stat, currency rule, control, map, or cap) updates the guide in the same change: the [overview](../guide/1-overview.md) if it changes the big picture, [how it plays](../guide/2-how-it-plays.md) if it changes how or why to play, and the [encyclopedia](../guide/3-encyclopedia.md) for every number. Numbers come from `server/src/rules.rs`. A client test fails if a unit or building kind is missing from the encyclopedia, but it cannot catch a wrong number. A change is not done until the guide matches it.
- Preserve the existing playable skirmish and all user changes. Do not commit or publish without an explicit reason/authorization.
- New direction: three asymmetric economies, territory buffs, resource-purpose differences, original units, desktop 1v1 first, intentional tunable command delay, bounded configurable server-side behaviors.
- Plan index: [README](README.md); implementation order: [roadmap](ROADMAP.md). Website rules are sufficient initially; actual mod data can be requested for consequential ambiguity.
- Manual edits use apply_patch. Core tests live in the isolated `server/core` crate; database behavior needs real-server integration, not native host stubs.
- Update this document after every validated increment and before starting another. Record failures honestly and leave the next command/action explicit.
- User explicitly requires playing the game, not only running tests. After user-visible increments, exercise normal browser controls and record actual observations separately from test passes and unverified assumptions.

## Completed and In Progress

### Step 1: Map contract (validated)

- Starting worktree was clean.
- Evidence: simulation hardcodes four starts/eight deposits; navigation/client share only terrain rectangles. Navigation is fixed to a 1600-square battlefield and 40-unit grid.
- Hypothesis: a single validated map asset can replace duplicated bootstrap data without changing state, navigation, or balance.
- First change: typed Rust map contract, built-in shared JSON, validation and narrow tests. Keep unsupported sizes rejected until all runtime consumers can accept them.
- Validation: `cargo test --manifest-path server/core/Cargo.toml maps::tests` passed all 4 focused tests.

### Step 2: Runtime map integration (validated)

- Simulation startup and navigation now consume the validated built-in map; client catalog reads the same asset.
- Removed the old terrain-only JSON; historical layout values are pinned in regression tests.
- Added world bootstrap and client layout tests. `npm test` passed: 36 Rust tests and 7 client tests, including deterministic replay and existing navigation/combat/economy tests.
- No database schema, balance, generated bindings, or live deployment changes.

### Step 3: Authoring validation (validated)

- Step 2 gates also passed: `npm run typecheck`, `npm run build`, WASM adapter `cargo check`.
- Added terrain connectivity validation using the existing pathfinding library, current 40-unit grid, 12-unit clearance, and 8-unit edge sampling. All starting worker exits and deposits must be accessible in one static terrain region.
- Added isolated-start, enclosed-deposit, and thin-wall regressions plus CLI example exposed as `npm run validate:maps`.
- Validation: 7 focused map tests passed; final `npm test` passed 38 Rust tests and 7 client tests. `npm run validate:maps` reports skirmish v1 with 4 starts, 8 deposits, 4 obstacles and valid static routes. Final WASM compilation passes; new Rust files formatted and editor diagnostics clean.
- This does not prove future building layouts stay reachable, faction balance, or map/rules version compatibility in live matches.

### Step 4: Documentation and resume checkpoint

- [Map authoring](MAP-AUTHORING.md) documents format, command, and intentionally unsupported features.
- Main plan index now links this handoff; roadmap records partial M0 progress, not completion.
- No live integration/browser tests rerun: schema and exact map geometry remain unchanged. No backend/dev server started or database published. Existing historical integration results are not new evidence.
- Typecheck and production build passed after runtime integration; later changes only affect Rust validation, package script and documentation.
- Both Cargo lockfiles have the expected direct serde dependency entry. New files must be included with tracked edits if the user later commits; no commit was made.

## Validated Sessions and Increments

### Step 5: Interactive playtest (2026-09-19)

- Started local backend and Vite; non-destructively published current module to `stdbrts-playtest`. No breaking migration reported; no gameplay code edits in this step.
- Played two practice sessions using normal UI input, including construction, production, rallies, control groups, delayed orders, combat losses, reload, defeat/restart and surrender. See [full observations and limitations](PLAYTEST-2026-09-19.md).
- Findings: rejection reason hidden in tooltip; only 240px battlefield height at 990x650; early AI pressure merits a proper difficulty session, not a balance conclusion from tool-paced play.
- Session ended in the lobby, no playtest match intentionally left running. Servers left available at http://127.0.0.1:5173/ and loopback port 3000.
- Terminal and browser handles recorded here on 2026-09-19 are stale; the 2026-09-22 session started and stopped its own backend and Vite. Nothing is left running.
- Prior user/formatter edits to `server/src/maps.rs` and `server/core/examples/validate_map.rs` were not touched.

### Step 6: Playtest UX findings (validated 2026-09-22)

- Closes findings 1 and 2 of [PLAYTEST-2026-09-19.md](PLAYTEST-2026-09-19.md). Touched only `src/main.ts` and `styles.css`.
- Rejected command rows now append a `.command-reason` span; `.command-row.rejected` wraps so the reason takes its own full-width line. The `title` tooltip is unchanged, and rejection timing and cancellation semantics were not touched.
- A `@media (max-height: 800px)` rule compacts the command deck from a 310px to a 240px track, reducing padding, minimap, history and button heights. It sets only vertical properties and sits between the 1000px and 760px width rules, so it composes with either instead of overriding horizontal padding.
- Browser evidence at 990x650, measured not calculated: battlefield **240px to 302px**, and the previous 14px vertical overflow of `.match` is gone. The inline reason reads `Production queue is already empty`, on its own line, over 90% of the row width, with the history area still bounded at 64px. At 1440x1000 the battlefield is still exactly 576px.
- New [tests/browser/feedback.spec.ts](../../tests/browser/feedback.spec.ts) provokes a real rejection by issuing two production cancels inside the delay window. It reads all geometry in a single `evaluate`, because `renderTimers` rebuilds the list with `replaceChildren` on a timer and separate `boundingBox()` calls race that re-render. Ran clean three times consecutively.
- Not verified: touch interaction, other viewport sizes, and whether the compacted deck overflows on platforms with different font fallbacks. No unit test covers the row builder; it is inline in `main.ts`, which has top-level side effects and cannot be imported by the node test. Extracting it into `src/presentation.ts` is the follow-up if coverage is wanted.

### Step 7: M0 match identity and delay contract (validated 2026-09-22)

- `rules.rs` gains `RULESET_VERSION`, `DEFAULT_COMMAND_DELAY` (still 20), `COMMAND_DELAY_MIN`/`MAX` of 10 and 30, and `validate_command_delay` returning a `CommandDelayError`. The old `COMMAND_DELAY` constant is gone, not aliased. Out-of-range is rejected, never clamped.
- `maps.rs` gains `MapIdentity` and `content_hash`, an explicit FNV-1a over a domain-tagged, length-prefixed encoding with floats hashed via `to_bits()`. Deliberately not `DefaultHasher`, which carries no cross-process stability guarantee.
- `Room` gains `ruleset_version`, `map_id`, `map_version`, `map_hash`, frozen in `create_room` and never mutated after. `create_room`'s reducer signature is unchanged, so the client contract held.
- 11 new Rust tests, 38 to 49 total. They cover delay bounds, that rejection is not clamping, that scheduling follows a room's frozen delay rather than the constant, and that the map hash is pinned, deterministic across reparses and reformatting, and order- and value-sensitive.
- Real-server evidence: published to a **new** local database `stdbrts-m0`; `stdbrts-playtest` was not touched. All four browser tests pass against the new schema, and every live room row carries `command_delay 20`, `ruleset_version 1`, `skirmish` v1 and `map_hash 5368541743987556208`, matching the pinned `0x4a80_e445_bc3b_ff70`. This is the end-to-end link the module's own tests cannot prove.
- Bindings regenerated with `npm run generate`; the diff is four added columns in `room_table.ts` and `types.ts`.
- Adding these columns is a breaking schema change. It is published only to the local development database, never to production.
- Not proven: reconnect to a room created *before* this change, since the new database has no such rows. The delay-reject branch never fires in production while the default is in range; it is exercised only by tests until a lobby control supplies a caller-chosen delay, which must arrive as a creation-time argument because the freeze-at-creation decision forbids a mutator.

### Step 8: Dual-currency economy and a navigation livelock (validated 2026-09-22)

- Material and Catalyst replace the single ore balance, with an army death refund of 50% and an opening stipend. Values are recorded as **experimental** in [DECISIONS.md](DECISIONS.md); none of them are validated by play.
- Map deposits gained a required `kind`; the two central sites became catalyst at 1200 stock. Map version 2, `RULESET_VERSION` 2. The identity freeze from step 7 caught the geometry change exactly as intended.
- World size is no longer pinned to 1600. `maps.rs` accepts 1600..=4096 in whole navigation cells (so 4080 is the real ceiling, since 4096 is not a multiple of 40), and `validate_position` and unit separation take the map's extent instead of a constant. The default map is unchanged.
- A four-player melee map, [quadrille](../../shared/maps/quadrille.json), exists at size 3200 with 81 deposits and 24 terrain rects. It passes the real static reachability validator. **It cannot be played yet** — see below.
- **Engine bug found by playing, not by testing.** Units could freeze permanently against a terrain corner: a worker at (551, 736) stepped to (548.3, 731.8), inside a rect's 12-unit clearance, and the end-of-tick revert rule restored it to its start, recomputing the identical blocked step forever. The clearance check samples the whole path at 8-unit intervals while a unit moves ~5 units per tick, so a thin sliver fell between samples. Movement now validates its own landing point and falls through to routing, with a slide backstop; the revert rule recovers via an escape search instead of pinning the unit. This predates the economy work and only became reachable because catalyst sits at the map centre.
- Evidence: 79 Rust tests, 14 client tests, 4 browser tests, and **11/11 integration tests against a live server**, including the research path that previously hung — mine catalyst at the centre, build a lab, mine again, research. Published to a new database `stdbrts-hb`; `stdbrts-playtest` and `stdbrts-m0` untouched.
- Measured entity load, core simulation only, persistence excluded: 60/player p95 7.3ms, 120/player p95 14.4ms, both inside the 25ms budget; 240/player p95 33.5ms, over. **120 is measured-safe, 240 is measured-unsafe.** `MAX_UNITS` is still 60 and raising it is the user's call.
- Not done: `navigation.rs` is still hardcoded to a 1600 grid and reads terrain from `default_map()` regardless of the map being simulated, so quadrille validates but cannot be played. The client also still hardcodes 1600/800. Both block playing the larger map.

### Step 9: The melee map (validated 2026-09-22)

- **[crossfire](../../shared/maps/crossfire.json)** is now the map matches are created on: size 3200, four spawns, 152 deposits (120 material / 32 catalyst), 28 terrain rectangles, four-fold rotational symmetry.
- Four bases per player — main, natural, third, and a shared edge base equidistant from two mains. Each carries its own catalyst, two sites per base, **like SC2 gas**. The centre holds **no resources**: the nearest deposit to the middle is 943 units away, so the central arena is roughly 1900 across and is fought over for position, not income. This reverses the earlier centre-catalyst design; see [DECISIONS.md](DECISIONS.md).
- Verified by script before installation and then by the real Rust validator: zero violations of any placement rule, whole-grid flood fill with **zero isolated cells**, exact rot90 closure over starts, deposits (position, amount and kind) and terrain, and the two-route property proven by growing each of the 28 obstacles by 130 units in turn — **28/28 keep all four starts mutually connected**.
- Per-match map selection: `Room.map_id` is resolved through `maps::by_id` and the match is simulated with `step_on`/`validate_on` on that map. `default_map()` stays on skirmish, so the simulation tests keep their small, coordinate-stable world. Switching the *default* map instead made the suite take 392 seconds and broke 23 tests; selection keeps it at 16.
- The client is map-driven: `catalog.ts` exports `worldSize` from the map, `presentation.ts` derives `WORLD_SIZE` from it, and `battlefield.ts` no longer hardcodes the 800 half-extent. `placementError` clamped building to `x > 1540` — the 1600 map's edge — which would have confined all building to the top-left quarter; it now follows the map.
- Evidence: 81 Rust tests, 14 client tests, 4 browser tests and **11/11 integration tests against a live server** on the new map. The research test dropped from 113s to 66s because catalyst is now mined at the main base.

#### Two false trails worth recording

- A single match runs at **16.2 TPS instead of 20 (81% of real time)**. I attributed this to the new map and cut deposits from 152 to 108 — which changed nothing, 16.2 either way. The control settles it: the **same build on the old 1600 skirmish map is also 16.2 TPS**. This is a pre-existing property of the local scheduler and has nothing to do with map size. The deposit reduction was reverted.
- Core simulation is not the bottleneck: at 4 units per player on crossfire it is 0.43ms p50 against a 50ms tick. Whatever costs the other ~60ms is outside `World::step`, and is worth finding before blaming content.

### Step 11: Factions and asymmetric mining (validated 2026-09-22)

- Three factions, dealt by slot (0 Industrial, 1 Network, 2 Organic, 3 Industrial), each opening with **its own labour** rather than a shared worker.
- **Industrial `worker`** mines and returns, unchanged. **Network `drifter`** credits in place and never returns. **Organic `harvester`** is free but spends hub stock, carries least, and cannot fight. Rejections are enforced server-side with specific reasons, not hidden in the UI.
- The drifter is deliberately **85% of a worker's rate** at a main — 0.200/tick against 0.234/tick — and only overtakes a worker hauling beyond ~175 units each way. It buys no travel and no in-transit load, never a higher rate. Per material invested it is ~10% better, paid for by 40 hp and by standing exposed at the deposit all match.
- Organic hubs accrue 1 stock every 60 ticks to a cap of 7, on both `hq` and `outpost`, so an Organic expansion multiplies harvester capacity.
- Conservation tests are load-bearing: mutating the drifter to credit half its yield fails two tests with concrete numbers. Direct crediting is exactly where resources could appear from nowhere.
- `RULESET_VERSION` 3. Breaking schema change (`Player.faction`, `Entity.stock`), published to a new database `stdbrts-fac`.
- One forced change: the four `kind != "worker"` gates became `!is_labour(kind)`. Network has only drifters and Organic only harvesters, so a worker-only rule left two factions unable to build anything.
- The Organic **`drone` builder was removed mid-implementation** on the author's correction — the reference game builds from the command card with no worker at all. Two negative guards remain in `rules.rs` so the concept cannot return unnoticed.

### Step 12: Faction selection and the first zone (validated 2026-09-23)

- **`set_faction`** lets a player choose their faction while the room is in lobby state, and refuses once the match is running — faction is frozen for the match exactly as the map and command delay are. Slot assignment remains the default for anyone who never chooses. Practice has its own picker that opens on the slot default, so one-click launch survives.
- **The zone primitive**, per [ZONES.md](ZONES.md): zones are derived from their sources every tick, so there is no removal path and a destroyed source cannot leave a field behind. `ZoneTemplate` declares which of the six concepts a zone participates in; overlap takes the strongest.
- **The Industrial `sensor` tower**, the first zone and the first faction-unique building: 450-unit radius, +30% movement for the owner only. Both values are labeled experimental — the author was unsure whether 30% was the real figure.
- Evidence: 104 Rust tests, 27 client, 4 browser, 12/12 integration against `stdbrts-zone`.
- Zone cost measured honestly: p95 7.3 to 9.1ms at 60 per player, 14.4 to 18.4ms at 120. Inside budget, but +25% for one zone with few sources.

#### Three test errors of mine worth recording

The zone tests failed four times before passing, and every failure was the test, not the engine:

1. Clearing `world.units` removed the HQ, and orders require one.
2. A one-player world resolves to victory immediately, so every zone test needs an opponent.
3. Measuring two soldiers in one world let them shoot each other, and measuring the same soldier twice started the second run outside the field. Fixed by a helper that builds a fresh isolated world per measurement.
4. Most instructive: the soldier spawned **on top of** the tower, and unit separation shoved it clear — inflating the measured distance by about 26%, which looked exactly like the aura wrongly boosting an enemy. The audience logic was correct all along.

### Step 13: Labour opens mining, and conservation verified live (validated 2026-09-23)

- **Starting labour now opens already gathering the nearest *material* deposit**, for every faction and every mode, set in the match bootstrap rather than in the client. Catalyst is a decision, not a default. Ties break on node id so the opening is identical on every machine. The soldier is not sent to work.
- Twelve existing tests assumed a quiet opening and measured something else entirely — command delay, credit-on-return, refunds, the stipend. They now call an `idle_labour` helper that stills the starting labour explicitly, so mining income cannot leak into their arithmetic. None were weakened.
- **Resource conservation was questioned and measured against a live database, not argued.** Over 800 ticks with four labour units working: deposits drained 709, stipend paid 266 across two players, balances plus in-transit cargo rose by exactly 975. Expected 709 + 266 = 975. **Discrepancy: 0.** Deposits really do drain by exactly what is collected, and nothing is cosmetic.
- What the author was actually seeing is real and by design: the **opening stipend** pays 200 material/minute for 90 seconds then 100/minute for 90 seconds, with no deposit drain at all. In that sample it was 266 of the 975 gained — 27% of early income arriving from nowhere. That is what "minerals just keep ticking up anyway" looks like, and it stops after three minutes.
- Evidence: 105 Rust tests, 27 client, 4 browser, 12/12 integration against `stdbrts-mine`.

### Step 14: The post-match score screen (validated 2026-09-23)

- A `match_sample` time series, one row per player every 100 ticks plus a final row the instant a match ends. Samples die with the match. Cumulative `collected`, `lost` and `killed` counters live on `Player` and round-trip like the balances.
- The screen itself shows a roster — faction, Winner/Out badges, Mined / Lost / Last hits / Unspent — over charts for income, army value, unspent balance and labour. One line per commander in that commander's battlefield colour, told apart by line style as well, with the name written at the end of its own line instead of in a detached legend.
- **Income means mined income.** The opening stipend and every refund are excluded, and the caption on the panel says so. Folding free money into an economy graph would have made the line a lie about how well anyone actually mined. `collected` is asserted against real deposit drain, minus cargo still in transit, which is the only honest check.
- **`killed` is last-hit attribution** and the column tooltip says exactly that: a unit worn down by one commander and finished by another counts entirely to the finisher. It was only possible at all because the simulation gained a `dealt` map splitting damage by the slot that dealt it; before that the attacker was discarded at the point of impact.

#### Three bugs worth recording

1. **Duplicate samples at a match's final tick.** `step_on` returns without advancing the tick once `outcome` is set, so a naive per-wake sampler would re-fire for every remaining iteration of the wake — up to four identical rows per player, but only when a match ended exactly on a multiple of 100. Fixed structurally: `is_sample_tick` is a property of the tick alone, and the sampler takes `&World` so it cannot perturb the simulation.
2. **A browser test hung for the full 180s budget.** Cause was the auto-gather change of step 13: every labour unit now has a gather order from spawn, so "Select idle worker" is permanently disabled and an unconditioned `.click()` retried forever. The button being disabled is correct — labour still goes idle after construction finishes or a deposit exhausts.
3. **The roster table was invisible** while its text was in the DOM and passing assertions. `.score-roster` had `overflow-x: auto`; setting overflow on one axis makes the browser treat the other as non-visible too, and a grid item with non-visible overflow has its automatic content contribution forced to zero. The row collapsed to 0px while the table inside laid out at its real 94px and overflowed out of it. Moving the scroll one level down onto the table, which is not a grid item, fixed it. Diagnosed by measuring the live element, not by reading CSS.

### Step 15: The practice bot fields an army again (validated 2026-09-24)

- Tech gating left the bot asking a hub for soldiers, which is refused. Hubs are now only asked for labour, checked through `canProduce` — the client mirror of `rules::producer` — and barracks and factory produce the army.
- **The bot had never been able to place a barracks on crossfire.** All nine hardcoded offsets pointed at the map centre, and the main is walled that way, so every one was terrain or occupied. Replaced with a ring search 220–460 from the HQ on 24 bearings, preferring sites more than 180 from a deposit so the mining line stays clear. This also removed a stale `hq.x < 800` extent from the 1600 map.
- Live three-way on crossfire: barracks placed at 10–11s for all three factions; four army alive by 60s (Industrial), 48s (Network), 35s (Organic); zero hub refusals.
- Observed, not acted on: Network was eliminated before 120s in both runs, which is balance or combat rather than the bot; Industrial floats ~3.4k material at 180s; each player opens with its labour plus one soldier.

### Step 16: Organic creep, simulation, persistence and client rendering (validated 2026-09-24)

- **One disc per source** (`CreepPatch`, integer radius), not a grid: bounded by `MAX_BUILDINGS`, cheap to persist, and recession needs state that outlives its source. It lives in `World::creep`, the only zone state carried between ticks. `advance_patch` is pure.
- **Only hubs make creep** (author's decision): HQ 360, outpost 300. Sprouts at 60 when a hub completes, starting HQs full at tick 0, +10/s stepped every 20 ticks. Source lost → holds 100 ticks → recedes 20/s → removed at 0.
- **Harvesters off their owner's creep are slowed to 0.6x — no drain, no death** (author's decision). Creep is a movement and combat/death zone, not economy/survival; this supersedes RESEARCH.md's "dies quickly off creep", recorded in [DECISIONS.md](DECISIONS.md). `ZoneField` is now indexed by concept and by effect, and the slow is walked only for creep-dependent kinds, so every non-harvester speed is bit-identical.
- **Death spawns**: only the creep owner's own units dying on that owner's creep; buildings spawn nothing. `death_spawn` by total cost: under 50 nothing, 50–199 one brood (hp 30, speed 120, range 20, damage 6, cooldown 10, 200 ticks), 200+ one brute (hp 70, speed 90, range 30, damage 14, cooldown 12, 300 ticks). Spawns are controllable and start attack-moving at the death point; they take no supply and do not count toward `MAX_UNITS`. An army unit dying on creep gets both refund and spawn. The air branch (mite) is documented only — no air units exist.
- **Expiry is removal, not death**: `retain` at the top of the tick, so an expired unit never reaches refunds, `lost`, `killed` or spawns. `Entity.expires_tick` persists because `Entity` is embedded whole.
- **Persistence**: a `creep_patch` table, diffed in `save_world` like units. Measured ~0.03 row writes per tick (66 over 2400 ticks, two outposts, one lost), and 0 while radii are static. The read side is unmeasured.
- `RULESET_VERSION` 6. Evidence: 135 Rust tests; client 42/42; integration 12/12; browser 4/4. **Client rendering is done and validated 2026-09-24.** The client draws owner-tinted creep discs on the map and minimap; a receding patch gets a pulsing dashed edge and a "CREEP GONE IN Xs" countdown, with `creepGoneTick` in `src/creep.ts` mirroring `advance_patch`. An owner's harvester caught off its own creep gets an amber chevron, and a brood or brute is drawn distinctly with a lifetime bar. The unit counter, train limit and bot population all exclude temporary units (`takesSupply`), and attack, attack-move and hold all accept a brood or brute.
- Verified live: a patch lost its source at tick 1192 with radius 300 was removed at tick 1592, exactly as `advance_patch` predicts, and the countdown read 12.4s at tick 1343.
- Still unverified: no brute has been seen on screen; a brood has not been given orders through the UI; no browser test covers creep; the creep tint is faint at default zoom (the author's judgement, not measured); and the bench still needs an idle-machine rerun.
- Bench: indistinguishable from noise on a busy machine — p95 ~12.5–14ms against 12.6–13ms at 60 per player, ~26–28ms both ways at 120. Rerun on an idle machine before comparing to the 9.1/18.4ms zone baseline.

### Step 17: Shields and the Network power field (validated 2026-09-24)

- **Shields**, Network only: half of every listed health total becomes shields (soldier 70 + 70, HQ 600 + 600, drifter 20 + 20), so total durability is unchanged. They absorb damage before hit points, wait 200 ticks after a hit, then regenerate 2/s, or 6/s inside the owner's power field. Construction raises them alongside hit points. `Entity` gains `max_hp`, `shields`, `max_shields`, `damaged_tick`, `warp_tick` and `arrive_tick`; repair and construction read `max_hp` instead of the kind's listed health.
- **The power field** (`rules::power_field`, radius 320) is projected by the new Network-only **`relay`** (75 material, 150 + 150, 5s) and by a Network player's HQ and outposts. It participates in connectivity and combat/death only. `zones_of` now takes the factions, because an HQ projects power only for Network.
- **Drifters train at any finished structure in the field**, and a drifter with no rally goes straight to the nearest material deposit. `cancel_production` is accepted on any building, so a relay's queue can be cancelled.
- **A death in the field** restores 20% of the dead entity's total health as shields to each of the owner's entities within 180.
- **Teleport**: a new `teleport` order. A 1s channel with no movement or fire, cancelled by any damage. Both ends are rechecked on completion, and the unit is then inactive for 2s. It can't be queued and has no cooldown. The client has a Teleport button and the **T** hotkey, a destination preview reading "TELEPORT HERE" or "OUTSIDE YOUR FIELD", a closing ring while channelling, and a pulsing ring on arrival.
- **Client**: power fields drawn as owner-tinted discs with a drifting dotted edge (also on the minimap), sensor fields as long-dashed rings, a pale-blue shield bar above health that brightens while regenerating, and relay and sensor visuals. Faction build buttons are hidden from other factions. **The sensor tower was server-only until now**: it had no build button, no visual and no drawn field, so the Industrial zone had never been visible in play. The pure readings live in `src/zones.ts`.
- Other fixes this forced: the bot's HQ repair trigger was `hp < 900`, which fires forever for a 600-hp Network HQ, and is now three quarters of `maxHp`. The building-under-attack alert now counts shields. One integration test used `teleport` as its example of an unknown order; it now uses `summon`, and separately asserts that an Industrial unit is refused teleport.
- `RULESET_VERSION` 7. Breaking schema change, published to a new database `stdbrts-shield`; earlier databases untouched.
- Evidence: **144 Rust tests** (9 new, covering the split, absorption and spill-over, regeneration timing inside and outside a field, restoration reach, field-gated training including an unfinished relay, power ownership and concept participation, the teleport channel and arrival, refusals, damage cancelling a channel, and shields rising with construction); **client 45/45** (3 new); **integration 12/12** and **browser 4/4** against `stdbrts-shield`; typecheck, build and the WASM check pass.
- **Played through the browser** in four Network practice matches, using the Build and Production tabs, map clicks, box select and the T hotkey. Observed: the HQ field drawn at match start; relay placed, built and selected, reading "150 HP / 150 shields"; the producer list offering the relay and Train Drifter enabled there; a drifter trained there and mining at once; the soldier channelling, then standing beside the relay. In a defended match, rows read straight from the database showed the HQ's shields falling 600 → 420 → 186 with hit points at 600/600; a rise from 186 to 251 in 107 ticks, which regeneration alone cannot give and which matches two nearby soldier deaths restoring 28 each; and hit points falling only once shields reached 0.
- **Not verified**: a teleport with the enemy firing on the channel (covered by a unit test only); a relay killed mid-channel stranding a unit; the minimap field ring by eye; touch input for teleport; Network surviving past two minutes against the practice bot, which it never did. The bench was not rerun.

### Step 18: Faction armies (implemented 2026-09-25; played through scripted browser UI, not yet by a person)

- The army roster is no longer shared. `rules::army_faction`, `unit_faction`, `basic_fighter` and `army_building` define it, and `producer` is faction-aware for the army as it already was for labour. Refusals name the faction ("Only the organic faction can train a soldier; you are playing industrial").

  | | Fighter (barracks) | Raider/support (barracks) | Anti-structure (factory) |
  |---|---|---|---|
  | Industrial | soldier (unchanged) | scout (unchanged) | siege (unchanged) |
  | Network | **sentinel**: 150 mat, 220 health (110 + 110), range 115, dmg 26/13 ticks | **skimmer**: 90 mat, 70 health, speed 200 (fastest), dmg 8, **x3 vs labour** | **lancer**: 175 + 75, 240 health, range 250, dmg 36/40, **x3 vs buildings** |
  | Organic | **swarmer**: 50 mat, 60 health, speed 135, melee, dmg 7/8 | **spitter**: 90 mat, 85 health, range 150, dmg 15/16 | **crusher**: 175 + 75, 420 health, melee, dmg 30/18, **x3 vs buildings** |

- Also: the soldier's x2 counter now covers the skimmer as well as the scout. Every slot opens with its own faction's fighter instead of the shared soldier. The new kinds fall straight into the existing rules: refunds via `is_army`, creep death spawns by cost (a swarmer leaves a brood, a crusher a brute), and Network shields via `vitals`. The "fighting units" refusal text no longer lists unit names.
- Client: `ARMY`, `armyFaction`, `armyBuilding` in `catalog.ts`; only your own faction's training buttons are shown; new silhouettes for all six units in `battlefield.ts`; the practice bot trains its faction's fighter, raider and heavy unit.
- `RULESET_VERSION` 8. No schema change, so no binding regeneration. Published to the new database `stdbrts-army`.
- Evidence: **146 Rust tests**, including a new roster test, a lean test (Network dearer and tougher, Organic cheaper and faster, the skimmer fastest) and an opening-fighter test; **client 46/46**; **browser 4/4** (the Network practice test now uses the lancer and skimmer buttons and checks that other factions' units are hidden); **integration 12/12, three consecutive runs**; typecheck and build pass.
- **Two latent integration flakes fixed**, both exposed rather than caused by the new units:
  1. The repair test never stilled the defender's auto-mining workers, so a load landing inside the measured window broke its material arithmetic. It passed only by timing luck, and the sentinel's slower walk shifted the timing. It now stops both workers first. I confirmed with a replay of the simulation that the HQ took no extra damage.
  2. The production test's 150ms settle raced the room tick against the player's material. It is now a 500ms poll, and the check stays exact. When it failed it also took the rally test down with it.
- **Not verified** at implementation time: any of it by hand; balance of any kind; whether 50-material swarmers plus free broods snowball on creep.

#### Step 18 play observations (2026-09-25)

How it was played: one practice match per faction through the browser UI on `stdbrts-army`, driven by a Playwright script (normal clicks and hotkeys, state checked with `spacetime sql`), **not by a person**. Two headless bot-vs-bot matches were also run with the repo's own `chooseOrders` policy (a scratch script, not committed), because practice mode cannot show a non-Industrial bot.

Observed directly:

- **The practice bot is always Industrial.** It keeps slot 0 and its dealt faction (`src/practice.ts`), so in a practice match you only ever meet soldier, scout and siege. In all three matches it fielded only Industrial kinds. This is existing design, not a step 18 bug, but it means **no player has faced a Network or Organic army.**
- **Non-Industrial bots field their own army.** Network vs Organic (bot vs bot): Network built drifter, sentinel, skimmer and lancer; Organic built harvester, swarmer, spitter and crusher. No other faction's kinds appeared. Network vs Industrial: the same clean split.
- **Creep death spawns work.** In the Network vs Organic match: 26 broods and 7 brutes, every brute right after a crusher death (for example, crusher #68 died at 82s and brute #82 spawned at the same moment), and the broods after swarmer and spitter deaths near the Organic HQ. Swarmers killed at 51-66s, before the fight reached the creep, left nothing, which is correct. In the Organic practice match a **spitter** (cost 90) left a brood. The rule is by cost, not by kind, as documented.
- **Skimmer vs labour.** A worker lost exactly 24 in one hit (8 x 3) in Network vs Industrial. The other worker hits were 26 (sentinel). In the Network practice match, a 2-sentinel, 2-skimmer raid on the bot's worker line was killed before landing a hit.
- **Drawings at default zoom (0.8)**: units are about 15px. Magnified crops of default-zoom screenshots show distinct silhouettes (skimmer dart, sentinel gem, drifter ring, harvester seed, swarmer dome). At native size, owner colour carries most of the reading and the kind is hard to tell at a glance. The lancer, spitter and crusher were not captured close enough to judge.
- **UI**: each faction's production card shows only its own units (Network: Drifter/Sentinel/Skimmer/Lancer; Organic: Harvester/Swarmer/Spitter/Crusher). No console or page errors in any match. The score screen renders. A "Headquarters under attack" toast stays over the Organic score screen (cosmetic).
- **Outcomes**: all three practice matches were lost to the bot's first push at 91-97s, with the scripted player's small opening (barracks, 2 fighters and 2 raiders), including the Industrial mirror. The scripted player never sent labour to catalyst, so it never reached a factory. That is a player-script limitation, not a game bug; the bots reach factories in every match. Bot vs bot: **Network beat Organic at 156s and Industrial at 102s.** One match each is not balance evidence, but it does not support "Network is weak" as a faction-level problem. The earlier early-death reading comes from weak human-side openings against the bot.

No code was changed as a result of these matches. Rerun afterwards against `stdbrts-army`: Rust 146/146, client 46/46, integration 12/12, browser 4/4.

### Step 19: Practice opponent choice and a held first push (committed as `2a5459b`)

- The author chose "both" for Network survival: let practice meet every faction, and make the first push gentler.
- **Opponent picker.** The lobby has an "Opponent" select (`#practice-opponent`: Random, Industrial, Network or Organic; default Random, remembered in `stdbrts:v1:practice-opponent`). The bot still takes slot 0 and sets the picked faction in the lobby with `set_faction`, as the human does. `pickOpponent` in `src/practice.ts`. No server change.
- **Held first push.** `chooseOrders` takes `holdArmy`. While it is set, the army still trains and fights whatever comes into range, but is never sent across the map. Practice sets it until `PRACTICE_FIRST_PUSH_TICK` (180s). `scripts/bot.ts` does not use it.
- Tests: client 47/47 (a hold assertion and an opponent test); browser 4/4 (the practice test now picks an Organic opponent and checks it); typecheck passes. Integration not rerun: no server or integration-facing change.
- **Played** (Playwright through the UI, not a person): Network vs an Organic bot, and Industrial vs a Network bot. The lobby picker defaults to Random and survives a reload. Each bot's faction matched the pick and it fielded only its own kinds, up to crusher and lancer. No bot unit came near the human HQ before 3:00: first contact at 212s, and the HQs fell at 222s and 209s. No console or page errors.
- **The hold alone does not make the push gentler.** At 3:00 the bot's army was 36 units (12 swarmer, 9 spitter, 15 crusher) and 29 units (9 sentinel, 8 skimmer, 12 lancer). The scripted player had 5 units and never reached a factory, so it is not a fair stand-in for a person. Still, three minutes of banking makes the first wave bigger, not smaller. The author chose to keep only the 3:00 hold for now and judge the wave by hand before softening it further (options offered: cap the army during the hold, send a partial first wave, or keep heavy units home for the first push).

### Step 20: Command-card construction and the author's 2026-09-25 list (implemented; played by script; committed)

- **Increment J.** A `build_*` order still names one of your units (the protocol needs one; the client sends the HQ), but nothing happens to it: the site is spawned at 10% health and advances one tick of work per tick on its own (`construction` in `step_on`). The `construct` and `cancel_construction` orders, `CONSTRUCTION_CANCEL_REFUND_PERCENT` and the client's cancel button are gone. Repair on an unfinished building is refused ("finishes on its own"). The bot places buildings in the HQ's name and waits while a command for the HQ is still scheduled, so the one-second delay cannot place a building twice.
- **Routing stall fixed** (pre-existing, exposed by J). A worker delivering at 45 from a hub stands in a nav cell centred inside the hub's 44 footprint. Routing from that cell failed, so a worker sent to anything behind its hub froze for the rest of the match. Labour used to be walked off to build sites, which hid this. `navigation::advance` now routes from the nearest free cell the unit can walk straight to. Regression test: `a_worker_sent_behind_its_hub_after_a_delivery_routes_around_it`. This probably explains why the step 18/19 scripted players never mined catalyst.
- **Unit cap 120** (server, bot, UI and tests). **Second barracks** for the bot once its factory is under way. **Map hash**: `src/maphash.ts` ports the server's hash byte for byte (pinned for skirmish and crossfire); the client warns once per match on a mismatch.
- **Teleport cooldown** 30s from arrival (`TELEPORT_COOLDOWN_TICKS`, derived from `arrive_tick`, no schema change); the client skips recharging units. **Shield shares by kind**: sentinel and lancer a third shields, everything else Network half. `RULESET_VERSION` 9. Published to the new database `stdbrts-j`; no schema change.
- Tests: Rust 149 (was 146; construction rewritten, cooldown, shield split, routing, and one pinning that units fire while moving); client 49; integration 12/12; browser 4/4; typecheck and build pass. Two tests changed their assumptions, not their intent: the integration test now expects `construct` to be an unknown order, and the browser test's purchase checks read the largest fall from the running peak, because labour now keeps mining through every purchase and a ~25 load can land inside the command delay.
- **Played** (Playwright through the UI, plus SQL polling, not a person): Industrial vs an Organic bot and Network vs an Industrial bot.
  - Buildings placed from the Build tab and finished on their own (construction_remaining 44 to 0 in about 8s). The worker's order stayed `gather`, and no unit ever had a `construct` order.
  - The selection read "Constructing / 7.5s left". Repair on the site showed the notice. There is no cancel button.
  - The unit readout shows `/ 120`. Both bots reached 2 barracks by about 62s and kept mining.
  - A worker sent from the HQ to catalyst walked there and cycled 25 per trip, and catalyst rose 0 to 150 in 36s. In match B, 485 catalyst was mined.
  - A sentinel read 148 hp + 72 shields. After one teleport the button was disabled, and a forced click sent no second order.
  - No console or page errors.
  - **Unexplained:** in the first run of match A the scripted catalyst order never took effect (0 catalyst all match). A clean retest and match B both worked. It may be the script's timing, but that is not proven.
- Both scripted players lost at about 3:25-3:30 to the held push while keeping their army home.
- **Played by a person:** not yet (author, asked 2026-09-25). The held push, drawing legibility at default zoom and how construction feels are still unjudged. The author chose to commit step 20 anyway and start behaviour presets.

### Step 21: Primary-hub victory (implemented; played by script; not committed)

- **Asked first (2026-09-25).** The author had not played steps 18-20. They chose to commit step 20 (`11602c1`) and deferred behaviour presets to near the end, so players micro everything for now. Settled at the same time: firing on the move becomes a per-kind stat (which kinds stop to fire is still open), and `move` keeps firing like SC2's attack-move. For victory, the author confirmed three things: only completed hubs count, a same-tick last-hub loss on both sides is a draw, and outposts count for every faction, Organic included. See [DECISIONS.md](DECISIONS.md).
- **Server.** `World::survivors()` returns the owners of at least one completed hub. Both elimination (the cleanup of an eliminated player's units) and `resolve_outcome` use it. The old code counted HQ rows, not owners, which would have broken with several hubs. The refusal is now "You have no hubs left".
- **Research moved to the player.** Before, it lived on the HQ entity, so losing the HQ would have wiped it. Now it is `World.research` and the `Player.research` column; `Entity.research` is removed. This is a schema change, so the database is new: `stdbrts-hub`. This was an implementation default, not asked: research survives the HQ, as in SC2. `RULESET_VERSION` 10.
- **Client.** The in-match banner reads "Eliminated" instead of "HQ destroyed". Orders are allowed while any completed hub survives. Research status comes from the player row. The build issuer and Home fall back to a surviving completed hub.
- **Bot.** It plays on from a completed outpost when its HQ is gone, reads research from its player row, and attacks the nearest enemy hub, not only HQs.
- **Tests.**

  | Suite | Result |
  | --- | --- |
  | Rust | 153 (4 new: an outpost keeps you alive and keeps research; an unfinished outpost does not; last outposts on the same tick draw; no hubs means every order is refused) |
  | Client | 50 (1 new: the bot without an HQ attacks the enemy outpost; with only an unfinished hub it does nothing) |
  | Integration (`stdbrts-hub`) | 12/12 (research now read from the player row) |
  | Browser (`stdbrts-hub`) | 4/4 (checked against Playwright's `.last-run.json`) |
  | Typecheck and build | clean |
- **Played** by a Sonnet agent with a Playwright script through the UI, plus `spacetime sql` filtered by match; not by a person. Two practice matches, Industrial vs an Industrial bot. I checked the log, the final SQL and a screenshot myself.
  - An outpost placed from the Build tab 490 east of the HQ finished ("Outpost complete").
  - The bot's push killed the HQ at 03:18 (structures 2 → 1). The match continued: there was no banner, and SQL showed no HQ for slot 1 while its outpost (hp 650), two workers and a soldier remained. The notice switched to "Outpost under attack", and the outpost fell at 03:27. The result was "Defeat", with the score screen showing "Out 03:28", room `finished`, winner 0, and no rows left for slot 1. No console or page errors.
  - The outpost stood on the bot's line of march, so the HQ-less window lasted only ~9 seconds. A longer life on an outpost was not observed.
  - After the HQ fell, Train Worker was disabled: Industrial (and Network) labour trains only at the HQ. **Open for the author:** a player left with only outposts cannot rebuild labour, which makes surviving on an outpost nearly hollow. Should outposts of every faction train labour?
  - The bot researched all three technologies, and they appear on its `player.research` row. The scripted player's lab never went down (first attempt: "Terrain obstructed"; second: no lab row, cause not diagnosed), so the client's research display was not exercised with a completed technology in play. The integration test covers it against the real server.
  - Home after the HQ fell centred on the outpost, clamped by the map edge.

### Step 22: Outposts train labour; C&C-style training (implemented; played by script; not committed)

- **Asked by the author (2026-09-25)** after step 21's play showed that a player who keeps only outposts cannot rebuild labour. "Outposts should be like townhalls in sc and wc", and training should work like C&C, with no building selected. See [DECISIONS.md](DECISIONS.md).
- **Server.** `rules::producer`: worker and drifter train at `hq | outpost`, as the harvester already did. Rally orders are accepted at outposts. `RULESET_VERSION` 11. No schema change; republished to `stdbrts-hub`.
- **Client.** New `src/production.ts`:
  - `trainingSite` picks the building per click. It uses only finished buildings that can train the unit and still have queue room, counting `train_*` commands still inside the delay; a harvester also needs stock at that hub. A selected eligible building wins; otherwise the shortest queue, and ties go to the lowest id.
  - Train buttons are enabled whenever any building qualifies, and the tooltip names it ("Trains at Barracks #22").
  - `#production-queue` lists all queued units, soonest first, when no producer is selected.
  - The Organic stock readout sums every finished hub unless one is selected.
  - Fixed: the train buttons blocked at 60 units instead of `MAX_UNITS` (120).
- **Tests.**

  | Suite | Result |
  | --- | --- |
  | Rust | 154 (1 new: an outpost trains a worker and takes a rally; the labour-producer test now pins outposts) |
  | Client | 52 (2 new: `trainingSite` and `scheduledTraining`; the bot tests updated to "outposts train their own labour, never an army") |
  | Integration (`stdbrts-hub`) | 12/12 |
  | Browser (`stdbrts-hub`) | 4/4 twice, run by me on a quiet server |
  | Typecheck and build | clean |

  **Flake noted:** the agent's two runs of the browser suite failed "desktop and touch multiplayer flow" at its worker-purchase dip check (`game.spec.ts:330`, received 0 against >= 35) while other matches were running on the same server. The worker was trained (units 4 / 120 in the failure screenshot). A solo rerun and two full runs passed. So the material-dip assertion is load-sensitive; the product is not shown to be wrong.
- **Played** by a Sonnet agent with a Playwright script through the UI, plus SQL, Industrial vs Industrial on `stdbrts-hub`; not by a person. I checked the claims below against its raw log.
  - With nothing selected ("No selection"), the Worker tooltip read "... / Trains at Headquarters #5", and two clicks trained at the HQ.
  - After the outpost was complete, 4 rapid Worker clicks split HQ 2 / outpost 1 (the 4th was refused: "Insufficient material: 50 needed, 39 available"). SQL showed outpost #9 with `production = (worker)`. The queue display read "worker 1.9s / worker 2.0s / worker 4.8s".
  - The Soldier tooltip read "... / Trains at Barracks #22" with nothing selected. Selecting the barracks and clicking twice put both soldiers there.
  - A rally set on the outpost showed "Rally 3184, 900", and SQL showed the outpost's order as `rally_move` to (3184, 900).
  - Not observed: soldiers splitting across two barracks. The script's second barracks never went down; most likely a unit stood on the site at execution, but the rejection had been pruned. No console or page errors.
- **Open:** whether shortest-queue feels right in a person's hands, or whether a C&C "primary building" per kind is wanted.

### Step 23: First abilities, recall and bloom (implemented; played by script; not committed)

- **Asked first (2026-09-25).** The author chose SC2-style energy plus cooldowns, Network recall and Organic temporary creep, and **no Industrial ability for now** (smoke, retreat and outpost suppression were turned down as leftovers of earlier Honey Badger versions). The caster, the costs and the shield price of recall are implementation defaults; see [DECISIONS.md](DECISIONS.md).
- **Server.** `rules::Ability` with `RECALL` (50 energy, 60s cooldown, 3s channel, radius 200) and `BLOOM` (25 energy, 10s cooldown, instant, radius 200, 60s life); `max_energy` (Network and Organic hubs, 200, start 50, +1 per 25 ticks). `Entity` gains `energy`, `ability_ready_tick` and `cast: Option<Cast>`, kept apart from `order` so a rally survives a cast. `CreepPatch` gains `expires_tick`; a bloom is a sourceless patch whose id comes from the entity counter. `resolve_casts` runs after commands, before the creep advance: recalled units land in a spiral around the hub, inactive for `TELEPORT_ARRIVAL_TICKS`, shields 0. Abilities cannot be queued. `RULESET_VERSION` 12. Schema change: new database `stdbrts-cast`.
- **Client.** `src/abilities.ts` (the rules mirror, `castingHub`, `castRefusal`, `onCreep`, `recallable`). Recall and Bloom buttons in the selection tool row, hotkey C, no selection needed; the tooltip names the casting hub or the reason none can cast. Targeting preview circle; a recall channel is drawn for every player (arc, dashed circle, line to the hub, countdown). A violet energy bar on hubs.
- **Bot.** Organic blooms just inside its creep edge on the line to the nearest enemy hub. Network recalls when three or more army units are under 35% of total health and over 700 from home. The headless bot now subscribes to `creep_patch`.
- **Tests.**

  | Suite | Result |
  | --- | --- |
  | Rust | 159 (5 new: hub energy by faction and its cap; recall channel, landing, shields and cooldown, with the rally kept; recall refusals; a hub destroyed mid-channel; bloom placement, growth, chaining and recession) |
  | Client | 55 (3 new: caster choice and refusals; the bot's bloom and recall decisions; creep and recall targeting) |
  | Integration (`stdbrts-cast`) | 12/12 |
  | Browser (`stdbrts-cast`) | 4/4 |
  | Typecheck and build | clean |
- **Played** by a Sonnet agent with a Playwright script through the UI, plus `spacetime sql`; not by a person. I checked one channel screenshot myself.
  - Organic vs Industrial: the Bloom tooltip read "... / Casts from Headquarters #5 (51 energy)" with nothing selected. A click off creep showed "Bloom must be placed on your own creep" and sent no command. A bloom about 350 from the HQ created a `creep_patch` row with `expires_tick` 1265 and `max_radius` 200; it grew 70 → 100 → 140 → 170 → 200 within about 12s. HQ energy 51 → 28. The button then read "Bloom is recharging: 9s left".
  - Network vs an Organic bot: the starting sentinel was walked 867 from the HQ; Recall with nothing selected, clicked on it. During the channel the screenshot shows the circle, "RECALL 2.6s" and the line to the HQ. Afterwards the sentinel stood 60 from the HQ with shields 72 → 0 and `arrive_tick` set; HQ energy 59 → 13; the button read "Recall is recharging: 56s left".
  - The Organic practice bot bloomed on its own: two bot-owned patches with `expires_tick` set, cast from two different hubs.
  - No console or page errors. The energy bar is visible on hubs.
  - Not observed: a bloom receding (covered by the Rust test), a cast from an outpost, or the Network bot recalling.
- **Open for the author:** what Industrial gets instead of an ability; whether recall should spend all shields; whether chained blooms need a cap.

### Step 24: Controls and layout (implemented; played by script; not committed)

Client only: no server, schema or balance change. Build on the new database `stdbrts-ux` (same module as step 23).

- **Layout.** The site masthead is hidden in a match (`body.in-match`), and the deck is 214px (196 compact). The battlefield is **642px at 1440x900 (was ~475) and 414px at 990x650 (was 302)**, with no page overflow. Select/Order/Pan shows only on touch devices (`navigator.maxTouchPoints`). The CSS `pointer: fine` version hid it from Playwright's emulated phone and broke the multiplayer test.
- **Map painting was still the 1600 map.** Ground tiles covered one quarter, the pads sat at the old starts, and the lobby said 1600. The terrain is now painted from the map (`starts` exported from `catalog.ts`).
- **Clutter.** Health and shield bars show only when a unit is hurt, selected, hovered or under construction; hub energy bars always show. Deposit amounts show on hover or at zoom >= 1.4. There is a hover ring, and the cursor previews the right-click (attack, gather). Default zoom is 1.0.
- **Keys** ([src/hotkeys.ts](../../src/hotkeys.ts), printed on each button):
  - Q W E R train labour/fighter/raider/heavy, with no selection needed. B opens the build card, then Q..U. The keys belong to whichever card is open.
  - A, S, **H hold** (was D), **F repair** (was R), G return, T teleport, C ability, Y rally, **Backspace home** (was H), F1 or . for idle labour, F2 for the army, ? for help.
  - A disabled button's key shows its refusal as a notice.
- **Groups 0-9:** Ctrl or Alt sets a group (Chrome keeps Ctrl+1..9 for switching tabs), Shift adds, and a double tap centres the camera. Chips over the battlefield show them.
- **Other controls:**
  - Edge scrolling at the **battlefield's** edges (12px band), not the window's. The author found the window version scrolled up and down only at the top of the page and under the deck (fixed 2026-09-26).
  - Minimap: left-drag moves the camera, right-click gives an order.
  - Double-click or Ctrl+click selects every unit of that kind **on screen** (it used to be the whole map).
  - Wireframe tiles for a selection of two or more units.
  - Red minimap pings for damage to your units off-screen.
- **Tests:** client 58 (3 new: group chords, edge direction, no key collisions), browser 4/4 on `stdbrts-ux` (the tall-window height pin moved 576 → 742), typecheck and build clean.
- **Played** by a Sonnet agent through real mouse and keyboard in Playwright: 13/13 control checks passed, with no page or console errors. Its one real bug was fixed: a disabled train key now says "Needs a finished barracks/factory/hub", not the unit blurb. Not played by a person. Not tested: Shift+group add in the browser, and the enemy-hover cursor.
- **Open for the author:** whether the key changes (H, F, Backspace) suit you; map growth, which the author says is needed but deferred to the engine-optimisation work (2026-09-26); and the playtest's note that first-barracks placement near the HQ is often refused by terrain.

### Step 25: Order feel (implemented; checked by script; not committed)

Client only: no server, schema or balance change. Runs on `stdbrts-ux`. The author said the game still felt clunky next to SC2 (2026-09-27). The one-second command delay stays (a ruleset decision). This step makes the client answer every click at once, as [ARCHITECTURE-AND-UX.md](ARCHITECTURE-AND-UX.md) asks ("immediate local click feedback by next rendered frame").

- **Click acknowledgement.** Every order draws a ping where it was aimed on the next frame, in the order's colour: green move, red attack, gold gather/return/repair, cyan build, violet cast (`orderColor`). The target unit or deposit blinks, and a short quiet blip plays (`Feedback.ack`, lower for fights).
- **Intent while the delay runs.** Your scheduled and still-sending orders draw faint lines from every unit that will carry them out to the aim, plus a ring that fills as the delay elapses. This replaces the "1.0s" / "..." text markers for your own orders; an opponent's still show the old marker.
- **Order lines** for selected units are coloured by order, with a dot at each waypoint.
- **Shift-queue like SC2.** With Shift held, an armed mode (attack-move, repair, build placement) stays armed after the click, and releasing Shift disarms it. A right-click while armed cancels the mode instead of firing it (battlefield and minimap).
- **Selection.** Selected units get an ellipse at their feet: green for yours, red for others. While a box is dragged, the units it would take are highlighted. A box with no mobile units selects your buildings in it.
- **Placement overlay.** While placing a building, the reach of your finished buildings (500) is tinted, and the halos `placementError` refuses (terrain +50, deposits 75, buildings 110, units 55 near the pointer) are shaded red. This shows why first-barracks sites near the HQ were refused: deposit and HQ halos cover most of the main.
- **Combat reading.** A unit that loses health flashes pale for 140ms. A removed unit leaves a short burst in its owner's colour, larger for buildings. A snapshot that empties at once (reconnect) draws no bursts.
- **Motion smoothing.** Interpolation spans the measured time per tick (EMA, 40-120ms), not a fixed 50ms, so units glide instead of stepping when updates arrive unevenly.
- **Tests:** typecheck clean; client 58/58; browser 4/4 on `stdbrts-ux`. No new unit tests: everything here is drawing and input timing.
- **Checked** with a scratch Playwright script (not committed), Industrial vs a Network bot, with screenshots I read myself: box preview, gather ping and deposit flash, intent line, placement overlay, and two Shift-queued attack-moves (armed while Shift is held, disarmed on release, red legs with waypoints). Right-click cancelled build placement. No page or console errors. Not seen on screen: the hit flash and the death burst (no fight happened in the window), and the sound.
- **Not played by a person.**
- **Open for the author** (larger levers, not done here):
  - The 1.0s command delay is the biggest remaining gap to SC2's feel. The ruleset already allows 0.5s (`COMMAND_DELAY_MIN`); a practice trial at 0.5s would be cheap.
  - Group moves converge on one point. SC2 keeps the group's shape (server side).
  - Your own units standing on a site refuse placement. SC2 pushes them aside (server side).
  - Tab to cycle subgroups, and a command card that follows the selection.

### Step 26: Stamped execution ticks (implemented; checked by script; not committed)

- **Asked by the author (2026-09-30).** The point of a fixed command delay is that the network never decides when an order runs; the server stamped orders on arrival, so a player's real delay was ping + 1s and a lag spike moved execution. See [DECISIONS.md](DECISIONS.md).
- **Server.** `issue_order` takes `requested_tick`; `rules::scheduled_tick` clamps it into `[tick + delay - COMMAND_LATENESS_ALLOWANCE, tick + delay]`, never before the next tick; 0 means unstamped and waits the full delay from arrival. `Command.requested_tick` is stored. `RULESET_VERSION` 13. New database `stdbrts-sched`.
- **Client.** `Session.order` stamps `room.tick + room.commandDelay` and keeps it on the pending order, so the intent ring and the command list count down from the click rather than from the server's answer ("Sending" is gone). `Session.lateTicks` records how late your newest order ran; the telemetry line shows `LATE +Nms` when the round trip exceeds the allowance. `Session.stalled()` (500ms without a tick) draws "WAITING FOR SERVER" over the battlefield and `STALL` in the telemetry. Nothing is predicted: a stall freezes the picture, as before.
- **Tests.**

  | Suite | Result |
  | --- | --- |
  | Rust | 164 (5 new: unstamped orders wait the full delay; a stamp inside the allowance is exact; a late stamp runs at the floor; a stamp cannot skip or exceed the delay; the floor is after the next tick for every legal delay) |
  | Client | 58 |
  | Integration (`stdbrts-sched`) | 13/13 (1 new: a client-style stamp runs exactly on its stamp; a stamp of tick 1 is clamped to issue + 14) |
  | Browser (`stdbrts-sched`) | 3/4 then 4/4. The first run failed "desktop and touch multiplayer flow", the load-sensitive test noted at step 22; it passed alone and in a full rerun. The failing assertion was not captured. |
  | Typecheck | clean |
- **Checked** by a Sonnet agent with a scratch Playwright script on `stdbrts-sched`, 1440x900, screenshots read by it. Right-click move with F2: the command list read "move / 1 / 1.0s" 6ms after the click and 0.6s at 300ms ("Sending" never appeared); the intent ring was ~40% at 570ms and nearly closed at 950ms, and the unit moved after about 1s. Telemetry "TICK n / ACK 10ms", no LATE. CDP `Network.emulateNetworkConditions` offline stalled the socket: telemetry counted "STALL 1.0s ... 3.1s" and the canvas showed "WAITING FOR SERVER 3.1s". No page or console errors. At ~70ms the click ping sits on the ring, so its fill is not readable that early.
- **Not verified:** real online latency. `LATE` and the allowance are exercised only by the Rust and integration tests, never at a real 200ms+ round trip. Not played by a person.

## Remaining Implementation

Map/rules identity is now persisted per match, so that item is done. Still outstanding: map selection, variable map dimensions, client-side hash negotiation, dual currencies, supply subdivisions, refund eligibility, factions, secure fog, policies, new graphics, and every M1 experiment including the one in [EXPERIMENT-C-PRIVATE-STATE.md](EXPERIMENT-C-PRIVATE-STATE.md). M0's specification work — the rules that need deciding rather than coding — belongs in [DECISIONS.md](DECISIONS.md) before implementation. Do not mistake these increments for completed M0/M1.

## Commands

- Focused: `cargo test --manifest-path server/core/Cargo.toml maps::tests`
- Regression: `npm test`
- Types/build: `npm run typecheck`, `npm run build`
- Adapter: `cargo check --manifest-path server/Cargo.toml --target wasm32-unknown-unknown`
- Bindings: `npm run generate` after any schema change; never hand-edit `src/bindings/`.
- Real server: `npm run server:start`, then `spacetime publish --server http://127.0.0.1:3000 --module-path server --yes <database>`. Use a new database name for breaking schema changes; `stdbrts-m0` currently holds the step 7 schema.
- Browser: `npm run dev`, then `STDB_DATABASE=<database> npx playwright test`. Required whenever database or visible behavior changes; test passes alone do not close user-visible work.