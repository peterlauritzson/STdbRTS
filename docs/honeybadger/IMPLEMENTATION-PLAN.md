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

Status: **not started**. Blocked on nothing; scheduled after A and B land so the
tree is clean when the spike starts.

## Ordering after C

Per [ROADMAP.md](ROADMAP.md), the rest of M0's contract work — dual currencies,
supply subdivisions, refund eligibility, primary-hub victory, terrain semantics,
minimal original roster roles — is specification, and lands in
[DECISIONS.md](DECISIONS.md) before code. M1's other experiments (movement,
renderer, tick instrumentation) are independent of C and may be scheduled in any
order once C's answer is recorded.

## Standing constraints

- Preserve the existing playable skirmish while the new ruleset develops.
- Do not commit or publish without an explicit reason and authorisation.
- Breaking schema work goes to a new development database, non-destructively.
- Generated bindings stay generated (`npm run generate`); never hand-edited.
- Record failures honestly. Do not mark a gate passed without new evidence.
