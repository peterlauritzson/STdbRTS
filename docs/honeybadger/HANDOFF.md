# Implementation Handoff

Updated: 2026-09-24. User authorized implementation and requested a handoff at every step.

## Resume Here

Completed increments: the shared versioned map definition and validation (steps 1-4); the playtest UX fixes (step 6); the M0 match identity and delay contract (step 7); and the dual-currency economy plus a navigation livelock fix (step 8). Ordering and scope live in [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md); settled choices in [DECISIONS.md](DECISIONS.md).

Completed increment: **the melee map (step 9)**. The playable build is on the local database `stdbrts-map`. Earlier databases were not touched.

**Resolved (step 10): the tick rate.** Matches ran at 16.2 TPS instead of 20 because the tick stepped once per scheduler wake and the host does not deliver the requested period — 50ms requests arrived every 61.7ms. The loop now advances by elapsed wall time, capped at 4 ticks per wake. Measured after: exactly 20.0 TPS at a 50.0ms period. The one-second command delay had been running at ~1.23s, so **every delay and balance observation taken before this was against a clock 19% slow.**

Completed since: **faction selection and the first zone (step 12)**, **auto-gather and a live conservation audit (step 13)**, and **the post-match score screen (step 14)**. The playable build is on `stdbrts-live2`.

Since then: **the practice bot fields an army again (step 15)** and **Organic creep, including its client rendering (step 16)**. Creep's client rendering is done and validated 2026-09-24.

Latest: **shields and the Network power field (step 17)**, including the relay, drifter training at any powered structure, death restoration, teleport, and the Industrial sensor tower becoming buildable and visible on the client. All three factions' zones now exist in play. The playable build is on `stdbrts-shield`.

Next action. The zone layer is complete, so this is ordered by what most changes how a faction plays:

1. **Faction-specific army units.** Apart from labour and the two zone buildings, the rosters are still shared.
2. **Network survival.** In every live run the practice bot's first push, led by a siege unit out-ranging the defenders, killed a Network HQ at 80-115s. That is balance and bot behaviour, not a shield bug, but Network needs a playtest by a person before any values move.
3. The three open questions in [DECISIONS.md](DECISIONS.md) under shields: whether hubs should project power, whether teleport needs a cooldown or a cost, and whether the shield split should vary by kind.

**Increment F, the autonomous extractor, is explicitly deprioritised** — the author called it one of the least important mechanics. Do not pick it up because it looks cheap.

Before **Increment J (command-card construction)**, three questions need answers that are not guessable: whether an unfinished building can be cancelled for a refund and on what terms, whether construction can be interrupted now that no worker is attached, and whether build radius still means anything when nothing walks to the site.

Also open: raise `MAX_UNITS` if wanted (120/player is measured-safe on the 1600 map, 240 is not; on crossfire 60 is 21.5ms p95 and 120 is over), and the **Increment C** private-state experiment — which the zone rewrite no longer blocks, since none of the three real zones obstructs sight.

Smaller open items:

- [EXPERIMENT-C-PRIVATE-STATE.md](EXPERIMENT-C-PRIVATE-STATE.md) holds the private-state protocol and its pass/fail rule. Nothing about fog, smoke or hidden scouting may be built before it reports.
- The client cannot compare `map_hash`; bindings carry the column but no negotiation exists. `validate_map` does not print the hash.
- `tests/integration.test.ts` mirrors the stipend formula so its balance assertions can stay exact. If the Rust constants move, that helper must move with them.
- [quadrille](../../shared/maps/quadrille.json) is the superseded first melee map, kept as a 3200 test fixture. It still has catalyst in the centre and is not played.
- Unit costs, stats and resource amounts are all still first-pass experimental values, including the sensor tower's 450 radius and 30% speed bonus.
- The zone field is rebuilt every tick and cost +25% on p95 for one zone type with few sources. Creep's added tick cost could not be separated from noise on a busy machine; rerun `bench_load` on an idle one before quoting it. The `creep_patch` read (an index scan per tick) is unmeasured.
- Practice-bot observations not acted on: Network was eliminated before 120s in both live three-way runs (balance or combat, not the bot); Industrial floats ~3.4k material at 180s, which a second barracks would fix; every player opens with its labour **plus one soldier** — confirm that is intended.
- The rosters are still shared apart from the sensor tower and the relay. Faction-specific units beyond labour are not started.
- After placing a building, the builder stays selected, so placing a second building at once pulls the same labourer off the first site. Existing behaviour, found while playing step 17; press Escape between placements.

Work up to step 16 is committed (`c43ed34`). Step 17 is not committed.

## Constraints

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

## Remaining Implementation

Map/rules identity is now persisted per match, so that item is done. Still outstanding: map selection, variable map dimensions, client-side hash negotiation, dual currencies, supply subdivisions, refund eligibility, primary-hub victory, factions, secure fog, policies, new graphics, and every M1 experiment including the one in [EXPERIMENT-C-PRIVATE-STATE.md](EXPERIMENT-C-PRIVATE-STATE.md). M0's specification work — the rules that need deciding rather than coding — belongs in [DECISIONS.md](DECISIONS.md) before implementation. Do not mistake these increments for completed M0/M1.

## Commands

- Focused: `cargo test --manifest-path server/core/Cargo.toml maps::tests`
- Regression: `npm test`
- Types/build: `npm run typecheck`, `npm run build`
- Adapter: `cargo check --manifest-path server/Cargo.toml --target wasm32-unknown-unknown`
- Bindings: `npm run generate` after any schema change; never hand-edit `src/bindings/`.
- Real server: `npm run server:start`, then `spacetime publish --server http://127.0.0.1:3000 --module-path server --yes <database>`. Use a new database name for breaking schema changes; `stdbrts-m0` currently holds the step 7 schema.
- Browser: `npm run dev`, then `STDB_DATABASE=<database> npx playwright test`. Required whenever database or visible behavior changes; test passes alone do not close user-visible work.