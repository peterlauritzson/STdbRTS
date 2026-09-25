# Implementation Roadmap

Status: implementation started; see [handoff](HANDOFF.md) for current evidence and the next action. This is ordered by dependency and learning value, not a calendar estimate. Estimates should follow M1 evidence and the selected asset scope.

## Delivery rules

- Keep the current playable skirmish available while the new ruleset develops.
- Each milestone ends in a playable scenario or an executable evidence report, not just new abstractions.
- No roster expansion until the three economic/territorial loops are testable.
- No competitive fog claim before adversarial subscription tests pass.
- No copy of SC2 assets, exact unit roster, or map layouts is required.
- No advanced behavior editor before bounded presets work and ordinary players can understand their decisions.
- Save experiment conditions, results, decisions, and unresolved questions beside this plan. Do not mark proposed gates as passed without new evidence.

## Milestone M0: Lock the Contracts

Dependencies: this plan and author confirmation, already obtained for the high-level direction.

Deliverables:

- Versioned first ruleset specification: dual currencies, supply subdivisions, three economic loops, refund eligibility, primary-hub victory, terrain semantics, delay configuration, and minimal original roster roles.
- Decide the unresolved rules needed immediately: production-stock cadence, territory decay/off-territory grace, transfer failure/refund handling, refinery suppression recovery, and resource quantities. Label experimental values rather than claiming historical fidelity.
- Record reference desktop/lower-tier/server configurations and current core/tick/render/network baseline using the existing skirmish.
- Author the first small map specification and scenario fixtures for expansion, raid, recovery, choke movement, and relay/territory loss.
- Pin or archive the referenced design revision when practical. Retrieve actual mod files only for consequential ambiguities; the author considers the website sufficient to start.

Exit: every first-slice mechanic has a rule, a failure rule, and a test fixture; unresolved details are explicit and do not silently borrow SC2 defaults. The author can review one compact rules table without reading engine code.

## Milestone M1: Prove the Risky Boundaries

Dependencies: M0. These bounded experiments can run independently; do not combine them into a broad rewrite.

| Experiment | Smallest useful artifact | Pass/fail decision |
| --- | --- | --- |
| Order delay and policy | One unit using hold/advance/retreat presets with delayed policy updates | Stable intent, bounded transitions, no hidden-state access, no manual-order ambiguity; compare trial delays |
| Movement | Reproducible mixed-size choke/formation/producer-exit scenarios | No permanent avoidable jam; deterministic resolution; path/tick cost measured |
| Renderer | One original animated unit, structure, resource, terrain, selection/targeting, and zone in Three.js | Readable/interactable at target zoom; frame/asset budgets; desktop/narrow screenshots and nonblank moving canvas |
| Tick/load instrumentation | Measure core, load/save, visibility, policies, pathfinding, fan-out separately | Establish supported load tier; identify actual bottleneck before optimization |

Exit: short decision records with measurements and retained/rejected options. If Three.js fails the hardware gate, adjust asset/lighting scope or retain Canvas temporarily. If a security API is unavailable, resolve that before implementing smoke or hidden scouting. Neither failure justifies publishing secret state.

## Milestone M2: Shared Strategic Foundation

Dependencies: accepted M1 decisions.

Deliverables:

- Validated map/content formats, frozen match versions, generated client catalog, dual-resource accounting, supply and costs, command lifecycle/status contract.
- Issuer-only order feedback.
- Reliable group movement, selection/control groups, minimap navigation/orders, targeting previews, command card, multi-resource HUD, reconnect restoration.
- Units auto-attack while moving (author, 2026-09-25; already true for every unit). Later: decide per kind whether a unit **stops to fire** (most of SC2) or **fires on the move** (the phoenix), and whether a plain move should ignore enemies. See [DECISIONS.md](DECISIONS.md).
- Minimal ability/status/zone primitives, bounded server policies and useful presets, investment/death/refund accounting, configurable opening assistance.
- Reproducible scenario harness and accepted-intent replay/checksum format, reusing existing core tests and real-server integration.

Exit: a two-player greybox match with one temporary shared roster can expand, mine both resources, scout, fight, lose/refund/rebuild, use policies, reconnect, and finish. Greybox is a test vehicle, not the new game's final presentation.

## Milestone M3: All Three Economic Identities

Dependencies: M2. Implement one faction loop at a time in the sandbox, but do not call the slice complete after only one faction.

| Increment | Essential content | Must demonstrate |
| --- | --- | --- |
| Network | Remote material mining, fragile relay/supply infrastructure, stationary transfer, arrival vulnerability, then shield-funded recall | Expand without a base-centered mineral loop; respond through relays; opponent can disrupt mobility; recall trades base safety for preservation |
| Industrial | Conventional labor, auto-extractors with output switch, damage suppression/burning, repair support, smoke and retreat penalty | A nonlethal raid measurably affects income; output choice changes tech/mass options; smoke affects opponents' sight only |
| Organic | Shared local production stock, free small labor (no builder conversion: construction is from the command card for everyone), growing/decaying territory, temporary terrain source, death-spawns | Worker replacement competes with army production; severing territory changes economy; defending on territory has value without infinite spawning |

This sequence is a provisional engineering order: stationary transfer tests zones, industrial smoke tests asymmetric sight, organic adds the largest entity/territory load. Reorder if M1 evidence favors it; do not infer priority from sequence.

Give each faction only the original roles needed to attack, defend, and express its loop. Make all three use the same policy framework and delay contract. Preserve a distinct catalyst tradeoff for every faction instead of letting remote/free mining eliminate resource specialization.

Exit: all three pairings plus mirrors complete on the first map with swapped starts; scripted economy and conservation tests pass; humans can describe why each economy expands, recovers, and fails differently. No numeric matchup-balance claim from this small sample.

## Milestone M4: First Polished 1v1 Slice

Dependencies: M3; production assets may be prepared after the M1 art direction passes.

Deliverables:

- Adopt the approved renderer incrementally; original faction silhouettes/materials, animation states, clear territory transitions, construction, teleports, smoke, impacts, death-spawns, and spatial audio.
- Full desktop control pass: remapping, subgroup selection, 0-9 control groups, camera bookmarks, idle cycling, production/ability targeting, order history, and clear focus rules.
- Behavior inspector with presets, a few meaningful parameters, anchors/leashes, spending limits, delayed-apply feedback, and explanations of automatic actions.
- First map visual pass, a second strategically distinct validated map, faction/map lobby selection, faction-aware practice bot, results and economy/territory timeline.
- Add only essential counter roles identified in M3, likely siege/anti-static and bounded area denial. Tune warnings and autonomous response before introducing burst attacks.

Exit: a player can enter practice or 1v1, understand their faction, execute a multi-front plan with presets, recover from a lost fight, and finish without developer help. Playwright covers the whole lifecycle; screenshot/canvas checks show real loaded assets and no overlap across desktop/narrow widths. Recorded hardware/load budgets and real-session stability gates pass.

This is the first release-shaped milestone. Do not gate it on a graphical state-machine editor, ranked play, or a large air roster.

## Milestone M5: Behavior Depth and Strategic Breadth

Dependencies: M4 playtest evidence, not just code completion.

Candidate increments, selected by evidence:

- Advanced finite-state editor over the already-tested model: bounded conditions/transitions, validation, simulator preview, versioned templates, share/import with strict parsing, and readable live state. Useful defaults remain competitive.
- Research branches that alter economy/territory/mobility rather than only adding damage percentages. Preserve the reference's meaningful tech-versus-army choice.
- Mobile relay fields, more nuanced living-territory propagation, specialized repair/smoke interactions, production morphs, and additional combined-arms roles.
- Air/anti-air, transport, elevation, detection/cloak, and richer siege only with matching visibility/navigation/counterplay tests. Decide individually rather than inheriting the entire SC2 ruleset.
- **Editors (the author wants both, 2026-09-25):**
  - **Map editor**: an in-browser editor over the shared, versioned map JSON, using the existing map validator, plus additional maps. Start once two hand-authored maps have fixed the format.
  - **Unit editor**: edit unit stats (and later abilities) as validated, versioned data instead of Rust constants in `rules::stats`. This needs unit definitions to become data that the server loads and hashes, as maps already are. Do not start it until the rosters settle through playtests.
- Experiment with gameplay command caps only if command spam or planning density actually harms the design; keep abuse limits regardless.

Exit per increment: a new strategic choice with understandable counterplay, bounded CPU/network cost, and no dominant mandatory scripting or repetitive micro. Reject features that add workload without advancing the pillars.

## Milestone M6: Hardening and Wider Play

Dependencies: stable M4/M5 ruleset.

- Multi-match capacity, 30-minute-plus real-server soak at declared target load, network degradation/reconnect, rate limiting, observability, backup/retention, and version compatibility.
- Hosted practice opponent if persistent practice is desired; the current browser bot stops thinking when its tab closes.
- Post-match replay viewer and privacy-aware sharing; observer rules before live spectating.
- **Fog of war, if ever** (demoted by the author 2026-09-25; it may never be needed): the secure-observation experiment (private canonical rows, caller-filtered views, an adversarial third client), then secure fog, last-seen observations, fog-safe events and fair bot observations. Until then every client sees the whole match, which is the intended game, not a leak.
- Account/identity recovery and deployment region decisions before persistent competitive profiles.
- Expand to 2-4-player formats with team vision, diplomacy/targeting rules, spawn/map validation, victory semantics, and performance gates. Existing lobby support alone is insufficient evidence of balanced new-ruleset multiplayer.
- Touch controls, matchmaking/ranking, social systems, cosmetics, and campaign content are separate optional follow-ups, not hidden requirements of the initial 1v1 release.

## Playtest Protocol

Start with repeatable scenario tests, then short human sessions, then full matches. Every report records build/rules/map hashes, faction/start assignment, delay, policies, machine/browser/network, and sample size.

| Session | Compare | Record | Decision |
| --- | --- | --- | --- |
| Orders and autonomy | 0.5/1/1.5s delay; defaults vs customization vs manual spam | Orders/minute, failures, perceived lag, automatic action surprises, outcome and damage | Pick a trial delay and improve intent feedback/defaults; no assumption that longer is automatically better |
| Economy openings | Expansion/army/tech starts per faction | Income by source/currency, production idle time, depletion, first contest | Detect dominant unopposed scaling and resource irrelevance |
| Raid and recovery | Same investment lost through workers, army, hub, or territory | Net loss after refund, recovery time, map access, new vulnerabilities | Preserve different recovery paths without costless reset or inevitable defeat |
| Territory interactions | Relay destroyed during transit; creep severed; smoke overlapping; extractor repeatedly hit | Ability outcome, hidden-state correctness, clarity, time to respond | Fix rules and feedback before numerical balance |
| Complete matchups | Three pairings and mirrors, swapped starts, both maps | Expansion patterns, tech choice, fight duration, surrender cause, idle/reaction workload | Identify faction/map-specific issues; don't infer global balance from a handful of games |
| Stress and reconnect | Peak harvesters/death-spawns/zone changes during reconnect | Tick/frame percentiles, bytes/sec, snapshot consistency, memory/state growth | Set supported limits and optimize measured hotspots |

Use replay comparison and conservation assertions for correctness. Use player observation and interviews for feel. Avoid invented success percentages or statistical claims until enough comparable matches exist.

## Risk Register

| Risk | Early warning | Response |
| --- | --- | --- |
| Full SC2 scope replaces mod identity | Many units, still one generic economy | Enforce M3 before roster expansion |
| Automation becomes mandatory programming | New players lose to opaque policies they cannot interpret | Strong presets, bounded expressive power, reason display, editor deferred |
| Automatic micro becomes superhuman micro | Perfect kiting/dodging dominates despite delay | Fixed evaluation cadence, legal observations, leash/commit rules, ability design changes |
| Refunds/free labor remove consequences | Endless trades, no territory loss worth exploiting | Tune production time, territory access, refund eligibility, depletion and supply together |
| Delay feels like broken controls | Repeated clicks, hidden failed orders, unreliable manual overrides | Immediate cosmetic feedback, explicit states, honest countdowns, simpler intent contract |
| Cheap expansion plus double defenses causes turtling | High income behind untouchable static positions | Test defensive investment and siege routes; historical multipliers are not sacred |
| Organic swarm overloads simulation | Spawn bursts or vision/path work exceed tick budget | Spatial queries, cached topology, bounded rules, measured entity caps |
| Fog is merely cosmetic (only if fog is ever built) | Arbitrary subscription sees unseen units/orders | Private state and caller-authorized views before any fog ships; no fog is planned (2026-09-25) |
| Render migration stalls playable work | Months of assets without tested economic loop | One M1 pilot, placeholder M3, limited original M4 asset set |
| Content/schema changes corrupt matches | Mixed catalog/map versions or destructive publish | Frozen hashes, new DB for breaking schema, non-destructive migration gate |

## Decisions Still Open

1. Final fictional names, art direction references, and original/licensed asset budget.
2. Target match duration and supported final army/worker counts. Measure swarm needs before choosing caps.
3. Exact first-slice costs/rates, resource-node quantities, zone timings, and refund percentage. Use the reference as a starting hypothesis, not a numeric mandate.
4. Primary-hub elimination proposal versus a different victory rule; settle in M0 before multi-base play.
5. How expressive advanced policies should become and which information/abilities they may use. Start bounded and review evidence in M5.
6. Whether actual mod data is needed to resolve a specific contested interaction. The author can provide it when useful; no need to postpone the whole project.
7. Production hosting/region/concurrency and minimum supported GPU/browser. Establish measured development targets first.

## Current Status

- [x] Authenticated website rules researched and evidence saved.
- [x] Author priorities clarified: economies/zones/resources over exact units; desktop 1v1; tunable delay and reduced micro.
- [x] Design, technical boundaries, UX, experiments, and dependency-ordered roadmap recorded.
- [ ] M0 contracts and baseline measurements.
- [x] First M0 foundation increment: shared versioned map data, validation CLI, static connectivity checks, unchanged-skirmish regression tests. Full map/rules match identity and M0 measurements remain outstanding.
- [x] Second M0 increment: match identity frozen at creation (ruleset version, map id/version/content hash) and a bounded ruleset command delay, verified against a real server. M0 stays open: the ruleset specification itself — dual currencies, supply subdivisions, refund eligibility, primary-hub victory, terrain semantics, roster roles — and the baseline measurements are still outstanding. See [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).
- [ ] M1 risk experiments.
- [ ] M2 shared strategic foundation.
- [ ] M3 three-faction economic slice.
- [ ] M4 polished 1v1.
- [ ] M5 selected depth extensions.
- [ ] M6 deployment hardening and wider formats.