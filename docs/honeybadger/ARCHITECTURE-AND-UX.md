# Architecture and Player Experience

Status: proposals and decision gates, not a completed implementation. Read alongside [commands and behaviors](COMMANDS-AND-BEHAVIORS.md) and the [roadmap](ROADMAP.md).

## Keep the foundation

| Existing owner | Keep | Evolve when required |
| --- | --- | --- |
| [Rust rules](../../server/src/rules.rs) and [simulation](../../server/src/simulation.rs) | Pure authoritative core, stable ordering, existing combat/economy regression tests | Versioned rules/content, resource vectors, ability states, zones, policies; split by actual responsibility as features arrive |
| [Schema](../../server/src/schema.rs), [game adapter](../../server/src/game.rs), [lobby](../../server/src/lobby.rs) | Authenticated intents, scheduled ticks, room lifecycle, row-diff persistence, reconnect | Private canonical world, secure projections, indexed match/player access, versioned match setup |
| [Navigation](../../server/src/navigation.rs) | Established A* library and deterministic rules | Footprints, formation goals, cache invalidation, spatial queries, map-specific grids |
| [Networking](../../src/network.ts) | Generated bindings, subscription lifecycle, request IDs, snapshots | Restricted views, own order status, visible events, initial snapshot/reconnect consistency |
| [Battlefield](../../src/battlefield.ts) | Input conventions, selection, camera behavior, minimap and feedback requirements | Extract input/selection/camera from Canvas renderer; renderer-neutral visible snapshot interface |
| [UI](../../src/main.ts) and [catalog](../../src/catalog.ts) | Working lobby/HUD, typed presentation metadata | Proper command card, behavior inspector, multi-resource costs, map/faction selection, generated shared catalog |
| [Practice](../../src/practice.ts) and [bot policy](../../scripts/bot-policy.ts) | Ordinary authenticated-client decision path | Information-limited faction-aware policy; eventually hosted practice decisions if needed |

Do not add a second authoritative TypeScript simulation, custom networking layer, new UI framework, or generic ECS rewrite as a prerequisite. A focused module extraction is justified by a tested boundary, not by hoped-for future extensibility. Current Canvas remains usable during the renderer experiment; maintaining two feature-complete renderers indefinitely is not a goal.

## Rules and match data

Introduce a validated, versioned content catalog for original unit/structure/ability/resource definitions. Generate typed presentation metadata from the same source, replacing duplicated prices incrementally. Server definitions remain authoritative even if a client modifies its catalog.

Match metadata needs ruleset version/hash, map ID/version/hash, faction assignments, tick rate, command delay, and a deterministic seed if randomness is introduced. Freeze gameplay configuration per match. Replay headers include all of these; a seed alone is insufficient.

Economy uses integer resource units and explicit fractional accumulators for rates, not floating-point bank balances. Store supply in a common integer subdivision supporting quarter-supply workers. All monetary rounding is specified and regression-tested. Movement currently uses floating point; do not claim cross-platform bit-identical replay until tested. Quantization/fixed-point movement is a gated decision if reproducibility requires it, not an automatic rewrite.

Model only needed entity capabilities: movement, weapons, production, construction, resource storage/harvesting, ability cooldowns, investment/refund eligibility, and active behavior state. Avoid growing one string-based order switch indefinitely, but migrate commands incrementally with compatibility tests.

## Deterministic systems

Before adding interactions, define and test a phase contract. Candidate sequence:

1. Activate due player intents in stable order; validate and start costs/actions.
2. Update scheduled expirations and topology changes according to their specified boundary rules.
3. Derive each player's permitted observations; evaluate bounded policies in stable entity order.
4. Resolve movement, path following, and separation against the tick's obstacle state.
5. Advance construction, production, harvesting, repairs, and ability windups under explicit same-tick rules.
6. Compute eligible attacks/effects, apply simultaneous damage, and resolve deaths/morphs/refunds/spawns exactly once.
7. Recompute changed territory/visibility as required, decide elimination, and publish sanitized state/events.

This is a proposed ordering, not a claim that the current loop already matches it. Preserve existing tested repair-before-damage and cancel-before-production-completion semantics unless consciously changed. Define which zone snapshot governs death-spawns and what happens when source and unit die together. Do not let DB iteration order, unordered maps, client timestamps, or animation frames decide gameplay.

Use spatial indexing for nearby units, vision, zones, and targeting when profiling demonstrates the need. Bound temporary spawns, path requests, and behavior evaluation through deterministic admission/game rules; never silently discard effects based on wall-clock load. Keep an explicit overload policy: preserve simulation order and report degraded wall-clock progress rather than skipping gameplay ticks unpredictably.

## Visibility and information security

**Observed blocker:** current public unit/resource/command tables expose authoritative state. Match-scoped subscriptions reduce traffic but cannot enforce fog. Public rows indexed by player are still public to a malicious client.

**Proposed model:** canonical entities, orders, private economy, and full events become private. The server derives authorized per-player observations, indexed by viewer/match. Caller-aware public views expose only the sender's permitted rows/columns. Opponent command queues, policies, precise hidden positions, cooldowns, and bank balances remain private. Public lobby metadata is a separate surface.

Use [SpacetimeDB access permissions](https://spacetimedb.com/docs/tables/access-permissions) and [subscriptions](https://spacetimedb.com/docs/clients/subscriptions). The installed Rust SDK is older than the CLI/client; first prove view/index/projection support with a real-server test and generated client. If support is insufficient, make a deliberate compatible SDK upgrade in an isolated database and rerun lifecycle tests. Do not fall back to publicly publishing all projections and asking the client to filter.

Visibility states: currently visible, last observed, and unknown. Last-seen observations retain only authorized historical fields and do not update with hidden movement or production. Map-static terrain may be public; whether resource deposits are known at match start is a ruleset choice. Re-entering sight replaces stale observations atomically. Owner state and legal feedback remain available across camera positions.

Compute sight/detection independently from weapon LOS and movement. Smoke filters sight by observer relationship. Detection/cloak and elevation can be added later without making smoke a collision wall. Current buildings block movement, while terrain alone blocks weapon LOS; keep that fact distinct from any proposed building occlusion changes.

Leak tests must inspect direct queries, arbitrary subscriptions, joins, initial snapshots, incremental changes, deletions, error text, events, spectator access, and reconnect. Effects originating in fog cannot reveal hidden exact coordinates via tracers/audio unless explicitly designed to reveal them. Spectating and replay access remain post-match/private by default until a fair live-observer policy is designed. Bots and unit policies consume the same legal observations, not the full private world.

## Maps and movement

Replace the one hardcoded terrain arrangement with a shared validated map format. Minimum fields: ID/version, world bounds, playable regions, terrain movement/sight/fire flags, starts, resource sites/type/quantity, no-build regions, and presentation asset references. Reserve height/layers in the format only when their behavior is defined.

Validation covers bounds, non-overlapping starts, worker access, producer exit space, reachable expansion routes, resource footprints, connected navigation, legal placement clearances, and faction-specific requirements. Server and client must agree on the exact map hash. Start with authored JSON and a validator; an in-browser editor comes after two maps expose actual authoring needs.

Movement work proceeds from replayable failure cases: mixed-size selection through a choke; production exits blocked by friendly workers; builders reaching a footprint perimeter; miners queuing at a node; ranged units seeking a firing lane; formation arrivals near map edges; new structure blocking a cached path. Add stable formation slots and deterministic alternatives rather than giving every selected unit the same destination.

Keep the existing pathfinding crate. Cache routes against a map/obstacle revision, request new paths only when needed, and use a spatial broad phase before replacing algorithms. Benchmark a finer grid or hierarchical routing if the current 40-unit cells cannot fit intended geometry. Ground and air movement need separate layers when air is introduced. Do not buy visual terrain complexity before movement can handle it.

## Graphics direction

**Recommendation:** evaluate an orthographic Three.js battlefield with original low-poly/painted assets, animated units, restrained lighting, and GPU-instanced repeated props. Preserve a tactical top-down camera and DOM HUD. The pilot compares readability and frame times against Canvas, not just screenshots.

Working visual themes: geometric luminous relay technology; growing, branching living terrain; compact industrial extraction/repair machinery. These are shape/material directions, not Blizzard art references to copy. Team identity uses patterns and silhouettes as well as color; zone colors must remain distinguishable under team-color changes. Use green, warm neutral, cyan, and warning accents intentionally without making every faction a hue swap.

One unframed full-viewport battlefield; no decorative card around the game. UI uses restrained rails and panels, existing fonts/icons where suitable, compact production queues, and a readable minimap. Terrain details establish location but never hide resource nodes, target markers, or silhouettes.

The renderer consumes visible snapshots and typed, sequenced presentation events. Core resolves projectiles if travel/collision affect gameplay; the renderer cannot infer damage from particles. Interpolate authoritative movement without predicting combat. Cosmetic events have bounded retention, IDs for deduplication, and explicit reconnect behavior so old deaths/explosions do not replay as new events.

Asset pipeline: licensed/original glTF models and animations, texture compression where supported, atlases/instancing, explicit budgets, preload by selected map/factions, progress/error handling, and a manifest recording author/license/source. No extracted SC2 models, sound, icons, race branding, or copied map layouts. User-owned mod mechanics inform design; do not assume third-party assets in a mod are reusable.

Animations prioritize idle/move/attack/death, construction growth, harvesting, and ability phases. Effects show source, intended area, warning, resolution, and aftermath. Camera shake, flashing, particles, and sound have settings; reduced-motion mode preserves tactical signals. Audio uses distinct action/alert categories with cooldowns, positional limits, fog-safe source data, volume controls, and an original or licensed sound library.

Gate the renderer on desktop and narrow/mobile viewports even though competitive touch controls are deferred: nonblank canvas pixels, actual asset rendering, moving/interacting scene, correct camera framing, no text overlap, recoverable WebGL context loss, and useful unsupported-device messaging. Quality tiers reduce shadows/particles/resolution before sacrificing gameplay indicators.

## Controls and HUD

Desktop mouse/keyboard first, with remappable keys and no gameplay logic inside event handlers.

- Left select/box-select; Shift add/remove or queue as appropriate; double-click/select-same-type with explicit screen/global scope; mixed selection with subgroup cycling and count summaries.
- Right-click contextual action with cursor/preview showing the resolved action before dispatch. Right-drag formation facing is a later ergonomic addition if the movement model supports it.
- Control groups 0-9 with assign/add/recall and optional camera centering; camera bookmarks; minimap camera and order input; home/base and idle-worker cycling.
- Attack-move, hold, stop, patrol, repair, build, and ability targeting with predictable Escape behavior; queued order paths and placement previews; avoid hidden modifier conflicts.
- Edge pan optional; middle/space drag, keyboard pan, cursor-centered zoom; controls cannot steal typing in chat/name/settings inputs.
- Selected-unit panel separates health/shields, active task, active behavior, cooldowns, and production. Command card shows prerequisites, multi-resource costs, disabled reasons, hotkeys, and target type.
- Economy header shows two resources, supply, income trends, and pending spending estimates distinctly. Production and research have queue/cancel feedback and clear ownership.
- Behavior inspector exposes presets, thresholds, anchors/leashes, budget, and current reason. Apply/save/reset are explicit; draft changes are not silently active before their delayed publish.
- Notification history for blocked orders, lost territory, idle production, and attacks; clicking a visible/known alert moves camera without revealing new hidden information.
- Lobby supports map/faction choice, readiness, settings summary, practice opponent, and reconnect. Results explain territory/economy/loss/refund trends, not just kills.

No broad frontend framework migration is needed. Extract typed input intents, selection state, camera model, and renderer interface from the current battlefield class as tested increments. Preserve the existing skirmish until the new slice reaches equivalent lifecycle reliability.

## Verification and provisional budgets

These are proposed acceptance targets, not measurements. M0 must record exact test hardware, browser versions, viewport, server resources, map, and load so numbers are meaningful.

| Area | Initial gate |
| --- | --- |
| Server timing | At 20 TPS, target p95 total tick cost <=25ms and p99 <50ms under declared supported load; record maximum and sustained lag, including adapter persistence rather than core-only timings |
| Entity load | Measure 60, 120, and 240 mobiles/player plus buildings and a declared temporary-spawn burst; current supported cap remains 60 until a larger tier passes |
| Rendering | Reference desktop targets 60fps with p95 frame time <=16.7ms; lower tier targets 30fps with p95 <=33.3ms at a declared load; record CPU/GPU and asset memory separately |
| Feedback | Immediate local click/selection feedback by next rendered frame; authoritative accepted/activated states measured separately with network latency |
| Security | Zero unauthorized fields in the defined adversarial scenarios; deterministic visibility tests must pass every time, not 99% |
| Stability | At least one measured 30-minute real-server run at the selected load, reconnect during action, bounded state/event growth, and no sustained scheduler backlog |
| Network | Record bytes/sec, row changes, snapshot size, initial sync time, latency/jitter/disconnect behavior; set deployment bandwidth/concurrency budgets after baseline, not by guess |

Test latency profiles at 0/100/250ms added round-trip latency and jitter/stall/reconnect scenarios, with intent delay independently varied. These are test inputs, not promised supported Internet conditions. Use native core tests for deterministic logic, real SpacetimeDB integration for permission/scheduling/persistence, and Playwright for controls, desktop/narrow layout, screenshots, and canvas-pixel/asset checks. Native module tests cannot replace the real-server tests because of database host imports.

Add an accepted-command log plus map/rules versions and periodic checksums/checkpoints when implementing reproducible scenarios. Existing core replay tests are not a durable replay product. Active-match secrets must not become downloadable replay files before the match ends. Replay retention and deployment monitoring need explicit limits.

## Migration and deployment

Preserve existing databases. Breaking private-state/resource/faction schema work goes to a new development database with non-destructive publish; generate bindings through the existing command. Test simultaneous old/new client behavior and reject incompatible match/catalog versions clearly. Do not promise in-place migration for nested entity changes before verifying SDK tooling.

Keep simulation per match isolated logically. The current scheduler processes active matches in one path; profile multi-match work before adding concurrency targets. Rate limits, bounded queues, authenticated ownership, observation limits, scheduled cleanup, logs/metrics, and client error recovery are required hardening. Hosting region, concurrent-match capacity, account recovery, and live matchmaking remain deployment decisions after the 1v1 vertical slice.