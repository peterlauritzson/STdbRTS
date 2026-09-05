# RTS Engineering Record

## Initial Scope and Acceptance Gates

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

## Mechanics Extension

The existing generic order contract carries the additional mechanics without a
table/schema change. The updated module was published with `--delete-data=never`.

- Attack-move: delayed soldier-only intent; acquire enemies within 180 units,
   retain a valid acquired target, pursue and fire, then resume the destination.
- Hold: delayed soldier-only intent; fire in range, never pursue, remain anchored
   during separation. A replacement order releases hold. Hold cannot be queued.
- HQ rally: persistent ground/resource destination stored in HQ order. Births
   inherit worker move/gather or soldier attack-move. Depleted resource rallies
   produce idle units. Clearing a rally leaves deployed units unchanged.
- Cancel production: cancel all items present when the command activates, refund
   their full cost, and retain the rally. Commands run before production completion
   on a tick, so cancellation wins if both are due on that tick. A second cancel
   against an empty queue is rejected, preventing duplicate refunds. Pending train
   commands are separate intents and are not cancelled by this control.
- Repairs: friendly other-unit targets only, 45-unit HQ/24-unit mobile range,
   5 HP per 10 ticks for 1 ore, including partial final repairs. Missing-health
   allocation is shared in stable worker-ID order. Repairs apply before that tick's
   simultaneous damage, cannot exceed maximum HP, and never revive removed units.
   Zero funds pause the order; full health/missing target completes it. Stop or a
   replacement order interrupts it after the standard activation delay.
- Bot: attack-move assaults; one emergency HQ repair worker and a 20-ore repair
   reserve while repairing. Still uses ordinary player permissions and commands.

Verification for this extension:

- 23 native core tests pass, including delayed attack-move/hold, rally inheritance,
   cancellation/refunds, multi-worker repair accounting, zero funds, missing targets,
   and the existing deterministic 24,000-tick replay.
- 4 TypeScript tests pass, including repair budgeting and attack-move bot policy.
- Live integration: 8 lifecycle scenarios plus a separate combat-repair scenario
   pass. Actual enemy damage is repaired through delayed reducers; ore charges and
   stop interruption are checked against subscribed state.
- Playwright desktop/touch multiplayer flow passes with rally set/clear, production
   refunds, attack-move, hold, keyboard targeting cancellation, reconnect, and victory.
   Canvas pixel checks and 320/390/1440/1920-width overflow checks pass; desktop and
   mobile screenshots visually reviewed. Repair simulation/live reducers are tested;
   successful repair targeting through the browser is not yet automated.

## Skirmish Playtest Build

The next stage completes the base/economy/army loop for playtesting, retaining the
one-second delay, authoritative simulation, and 2-4 player lobby. Entity state now
has explicit `construction_remaining` and `research` fields. Bindings were generated
with CLI 2.1.0 and published to a new `stdbrts-playtest` database; prior data remains.

- Five buildable structures: barracks, factory, turret, outpost, laboratory.
   Workers perform construction, can resume/assist paused sites, and sites retain
   battle damage. Cancellation refunds 75% exactly once. Per-player building cap 16.
- Scouts and siege join the army; producer restrictions and cross-building unit
   reservations prevent bypassing the 60-unit cap. Turrets defend automatically.
- Three serial, unique faction technologies: weapons, armor, logistics. Completion
   is stored on HQ, not the lab; cancellation uses the existing paid-queue refund.
- Shared JSON terrain; established `pathfinding` crate A* on a 40-unit grid;
   terrain firing occlusion, blocked-site checks, physical buildings, clear spawn
   exits, and cover-aware pursuit. Mobile separation remains lightweight.
- Nearest completed HQ/outpost accepts cargo. Repair range is now 55 for all
   structures and 24 for mobile units; construction uses 60-unit labor range.
- Client build previews, producer selector, production/build/research tabs,
   distinct roster visuals, idle-worker cycling, optional audio, and outcome return.
- Browser practice uses a separate saved guest identity and ordinary reducers.
   The AI shares its policy with the headless bot and builds/researches/mixes units.
   Browser AI reconnects after reload; closing the tab stops its decisions, not time.

Verification added: roster/counter rules; worker-driven construction and resumption;
site refunds; research uniqueness; outpost deposits; turret attacks; A* routes and
deposit reachability; siege repositioning behind cover; a constructed/researched
combined-arms army reaching victory with exact resource accounting. The combined-arms
fixture starts with 3000 ore to exercise the complete tech sequence quickly, not as
an AI fairness test. Live research instead uses ordinary mined income.

The full set comprises 31 Rust tests, 6 client/AI tests, live lifecycle/combat-repair/
laboratory tests, and two Playwright flows. Practice browser coverage includes actual
barracks construction, scout training, outpost cancellation, reload recovery, AI
cleanup, and 320/390px panels. Expanded desktop/mobile screenshots were reviewed.
The small-screen test caught and fixed intrinsic-grid overflow. Build metadata is
duplicated only for presentation; server costs and validation remain authoritative.

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