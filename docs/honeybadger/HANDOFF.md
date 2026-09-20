# Implementation Handoff

Updated: 2026-09-19. User authorized implementation and requested a handoff at every step.

## Resume Here

Completed increment: shared, versioned map definition and validation, preserving existing gameplay. No deployment or breaking database schema was performed.

Next action: address the small UX findings from [interactive playtest](PLAYTEST-2026-09-19.md), starting with inline rejected-command reasons in `src/main.ts` and short-height battlefield usability. Replay the affected interaction manually in the browser; automated tests alone are insufficient for user-visible work.

Then complete the remaining M0 ruleset contract before widening the schema. Read `server/src/schema.rs`, `server/src/game.rs`, and `server/src/lobby.rs` around room creation, command scheduling, and world persistence. Define frozen ruleset/map identity and configurable command delay without exposing per-client authority. Prove that accepted commands use a match-frozen delay and preserve the existing 20-tick default; include boundary/reconnect compatibility tests. Plan a new development database before any breaking match schema change, and keep generated bindings generated.

After that: the real-server private-state/caller-view security experiment in M1 is a prerequisite for smoke, fog, and fair policies. Do not implement cosmetic fog atop public tables.

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

## Not Implemented Yet

### Step 5: Interactive playtest (2026-09-19)

- Started local backend and Vite; non-destructively published current module to `stdbrts-playtest`. No breaking migration reported; no gameplay code edits in this step.
- Played two practice sessions using normal UI input, including construction, production, rallies, control groups, delayed orders, combat losses, reload, defeat/restart and surrender. See [full observations and limitations](PLAYTEST-2026-09-19.md).
- Findings: rejection reason hidden in tooltip; only 240px battlefield height at 990x650; early AI pressure merits a proper difficulty session, not a balance conclusion from tool-paced play.
- Session ended in the lobby, no playtest match intentionally left running. Servers left available at http://127.0.0.1:5173/ and loopback port 3000.
- Backend terminal: `1e149260-4ee5-4c8b-b9ea-cdb786d7e36f`; Vite terminal: `97ede30f-bd75-46e2-9d68-94df015d1f66`. Browser game page: `ac4d05e2-9882-4cf3-86e6-ccdacad2df8a`. Verify these are still running before reuse.
- Prior user/formatter edits to `server/src/maps.rs` and `server/core/examples/validate_map.rs` were not touched.

## Remaining Implementation

Map selection, variable map dimensions, map/rules hashes persisted in matches, dual currencies, factions, secure fog, policies, new graphics, or the M1 experiments. Do not mistake this first map increment for completed M0/M1.

## Commands

- Focused: `cargo test --manifest-path server/core/Cargo.toml maps::tests`
- Regression: `npm test`
- Types/build: `npm run typecheck`, `npm run build`
- Adapter: `cargo check --manifest-path server/Cargo.toml --target wasm32-unknown-unknown`
- Real server/browser checks are necessary when database/visible behavior changes; no server was running at this increment's start.