# RTS Engineering Record

## Scope and Acceptance Gates

Build a browser RTS vertical slice, not a production service: 2-4 players, one
open symmetrical map, workers, soldiers, one HQ per player, 60 mobile units per
player. HQ is also the production building. No fog of war, ranked matchmaking,
terrain pathfinding, tech tree, or separate building placement in this slice.

- [x] Pure movement, bounds, type validation, and timing tests.
- [x] Headless deterministic economy, combat, production, and order tests.
- [x] Authenticated reducers, room readiness, match isolation, reconnect.
- [x] Generated contract and strictly typed client.
- [x] Playable selection, orders, pending markers, production, and results.
- [x] Real-server multiplayer regression checks and browser smoke checks.
- [x] Accurate setup, known limitations, and reproducible verification commands.

## Architecture

- `server/core`: native-testable Rust gameplay crate, source in
  `server/src/rules.rs` and `simulation.rs`. No database calls or wall clock.
- SpacetimeDB adapter: validates membership, owns scheduled ticks, loads one
  match snapshot, advances the core, writes changed normalized rows atomically.
- Public match, player, unit, resource, and command tables. Match-scoped
  subscriptions reduce traffic; they are not authorization or fog of war.
- Client networking, rendering/input, and UI have separate ownership. Generated
  bindings are the contract. No `any`, `@ts-nocheck`, or predicted simulation.

## Decisions

1. 20 simulation ticks per second, 20-tick (1 second) global command delay.
   Server ticks, not client clocks, decide activation. Queued commands obey the
   same delay. Validate both on receipt and execution. Failed reducers surface
   to the issuer; accepted commands publish executed/rejected/cancelled status.
2. Client input contains local unit IDs and intent, never spawn positions or
   damage/resources. Only the scheduler can advance the game.
3. A disconnect preserves membership and entities. Explicit leave during play
   is surrender. Multiple connections for one identity must not fake offline.
4. Sorted entity and command IDs, stable target tie-breaking, simultaneous
   damage, and explicit draw resolution make replay tests deterministic.
5. Economy transfers cargo only at HQ. Production is serial, timed, charged
   at command execution, and capacity-limited. Pending requests reserve nothing
   and can be rejected if resources are spent before activation.
6. Open map with collision-lite separation; no hand-rolled obstacle pathfinder.
   Combat is authoritative hitscan with rendered tracers, not fake projectiles
   inferred from movement. Art is generated with Canvas primitives.
7. Old live databases must not be destructively reset. Publish this breaking
   schema to a new database and preserve the prototype deployment.

## Evidence and Pitfalls

- Initial prototype accepted arbitrary unit types and spawn locations, exposed
  a global reset, destroyed matches on disconnect, merged opponents in the
  client, and suppressed TypeScript diagnostics.
- Native `cargo test` on the SpacetimeDB module fails linking host imports on
  Windows. Test the separate pure core; compile the adapter to WASM and exercise
  it against a real server. Do not add fake database host stubs.
- Existing untracked `server/src/main.ts` belongs to the user; leave untouched.
- Live integration initially exposed database iteration order affecting spawn
   IDs. Core bootstrap now sorts slots; a permuted-input regression covers it.
- SDK 2.1 generated accessor is `resource_node`, not `resourceNode`.
   Subscription errors take one context with an optional `event`, unlike the
   general docs example. Generated types and executable checks are authoritative.
- Surrender is a non-ticking core transition. Never call `step` from a player
   reducer: it lets clients accelerate time and may let surrendered units act.

## Verification Evidence (2026-09-05)

- 17 native core tests, including identical 24,000-tick replays and conservation
   of resources, delayed commands, production limits, vanished targets, combat,
   four-player elimination, draws, and surrender.
- 3 TypeScript tests: bounded countdown extrapolation, coordinate bounds,
   practice-bot ownership/resources/pending-order policy.
- Live SpacetimeDB 2.1.0 integration: 7 scenarios under one lifecycle test,
   six connections, two active matches, readiness/capacity/host checks, illegal
   orders, shared execute ticks, deduplication, production, reconnect, shared
   identity tabs, surrender, victory, and empty-room cleanup. All pass.
- Playwright: independent 1440x1000 desktop and 390x844 touch contexts. Room
   creation/join/start, training, move input, pending countdowns, reload reconnect,
   surrender/result, zero page errors, no horizontal overflow, nonblank canvas
   pixel checks. Desktop/mobile screenshots visually reviewed.
- Strict TypeScript checks include scripts and tests; production Vite build
   passes. Rust WASM adapter check passes. npm audit reports zero vulnerabilities.
- Optional `wasm-opt` unavailable: build succeeds without its optimization pass.
- A correctly serialized external `game_tick` call was rejected by the live
   module with "Only the server scheduler may advance the simulation".
- Practice bot startup and three-second bounded shutdown checked against the
   live backend. Gameplay policy is independently unit-tested.

## Canonical API References

- https://spacetimedb.com/docs
- https://spacetimedb.com/docs/quickstarts/rust
- https://spacetimedb.com/docs/functions
- https://spacetimedb.com/docs/clients/subscriptions

## Deferred Hardening

Internet-scale abuse protection, account recovery, deployment monitoring,
replay persistence, packet-loss/latency playtests, and multi-host load testing
need separate acceptance work. A simulated 20-minute soak is not evidence of
20 minutes of real multiplayer network stability.