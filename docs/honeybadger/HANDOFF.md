# Implementation Handoff

Updated: 2026-09-22. User authorized implementation and requested a handoff at every step.

## Resume Here

Completed increments: the shared versioned map definition and validation (steps 1-4); the two user-visible playtest fixes (step 6); and the M0 match identity and delay contract (step 7). Ordering and scope now live in [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md); settled choices in [DECISIONS.md](DECISIONS.md).

Next action: run the private-state experiment, **Increment C**, whose protocol and pass/fail rule are already written in [EXPERIMENT-C-PRIVATE-STATE.md](EXPERIMENT-C-PRIVATE-STATE.md). It needs a real server and its own development database, three identities against one match, and all nine leak surfaces checked. Record the outcome there and add a dated entry to DECISIONS.md. Do not implement fog, smoke or hidden scouting before that result exists, and do not fall back to client-side filtering if it fails.

Two small follow-ups are known and deliberately deferred, neither blocking C:

- The client cannot yet compare `map_hash`. Bindings are regenerated and carry the column, but no client-side hash implementation or negotiation exists, so server/client hash agreement is still unproven.
- `validate_map` does not print the content hash, so authors cannot read it without running a test.

Nothing is committed and nothing is published beyond the local `stdbrts-m0` development database.

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