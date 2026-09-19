# Delayed Commands and Unit Behaviors

Status: proposed contract. Existing engine facts are marked separately. The author wants intentional delay for robustness and less emphasis on micro; configurable automatic behavior is a direction to explore, not permission to execute arbitrary user code.

## Authority and timing

**Existing:** 20 authoritative ticks/second, 20-tick command delay, stable command ordering, validation on receipt and activation, and presentation interpolation without predicted gameplay. Keep these foundations.

**Proposed:** delay is a ruleset field fixed at match creation. Compare 0.5s, 1s, and 1.5s during experiments; these are trial points, not selected balance. Never change it per player or dynamically to hide congestion. Server tick at acceptance determines `execute_tick`; no client backdating. Network transit adds to perceived delay and must be measured separately.

Intentional delay gives the simulation a future activation point and room for coherent feedback. It does not by itself solve tick overruns, transport stalls, reconnects, or fair information access. Keep authoritative scheduling, deduplication, admission limits, and bounded work.

Selection, camera, UI navigation, local targeting, and editing an unpublished behavior draft respond immediately. Movement, attacks, construction, resource-mode changes, rally changes, ability use, and publishing behavior changes activate after the same gameplay delay. Autonomous actions use the already-active policy and normal ability constraints; they do not recursively submit delayed player commands.

## Command lifecycle

`local draft -> sent/unacknowledged -> accepted/scheduled -> activated -> completed or failed`

An accepted intent is not a promise of success. At activation, recheck ownership, living entities, resource availability, visibility/target validity, terrain, capacity, cooldowns, and prerequisite state. Return specific issuer-only reasons. Hidden state must never leak through error detail.

| Situation | Proposed rule |
| --- | --- |
| Duplicate request | Stable request ID; at most one accepted intent and one debit/effect; acknowledge original outcome |
| Reconnect | Restore authoritative scheduled and active intent for the owner; do not auto-resend ambiguous commands under new IDs |
| Replace vs shift-queue | Replacement only replaces the current unit order when it activates; earlier scheduled intents are not retroactively erased |
| Local cancel | Escape cancels an unsent targeting draft immediately |
| Scheduled cancellation | A cancellation is itself delayed; cancels a specific request only if still pending when cancellation activates; no instantaneous tactical bypass |
| Active stop | Delayed stop; cannot undo resolved damage, deaths, transfers, or payments |
| Scheduled cancellation arrives too late | Explicit outcome; user may instead issue delayed stop or the relevant production/ability cancellation |
| Same-tick conflicts | Stable acceptance sequence/ID order, then deterministic phase order; no client timestamp priority |
| Partial selection invalid | Command class declares atomic or per-unit semantics; group movement applies to surviving owned members and reports skips; multi-unit morph/transfer groups have explicit all-or-none constraints |
| Target disappears | No continued knowledge of hidden movement; apply the command's declared fallback, never silently attack an unrelated hidden target |
| Capacity/abuse | Always enforce finite request size, unit-list size, pending intents, behavior size and per-identity rate limits; distinct from any future competitive queue cap |

**Economy:** initially keep charging at activation, as the current engine does. Accepted pending purchases reserve no banked resources. UI shows authoritative available funds and separately estimated pending commitments; deterministic activation order resolves oversubscription. Never present estimates as spendable guarantees. Escrow at acceptance is an alternative only if failures are too confusing; it changes cancel/refund semantics and needs a separate decision.

Production queues, scheduled commands, unit action queues, and behavior transitions are separate concepts and separate limits. A future queue cap must define which of these it restricts, how groups count, and whether replacing/canceling consumes capacity. Do not use HTTP/reducer rate limits as game balance.

## Behavior contract

Start with an allowlisted, server-evaluated finite-state model behind simple presets. No JavaScript, user plugins, unbounded scripts, recursion, arbitrary queries, or client-side authoritative decisions.

**Proposed policy shape:** stable policy ID/version; initial state; a small ordered list of states; allowed condition/action transitions; parameter bounds; per-state minimum dwell; fallback. Ruleset defines maxima and evaluation cadence. An initial experiment may cap policies at 8 states and 4 transitions/state, with at most one transition per evaluation and fixed work per unit. These are engineering trial limits, not approved gameplay caps.

Permitted facts: own HP/shields/cargo/cooldowns, current task, legal zone membership, visible enemies, local friendly information, and explicitly authorized last-seen observations. Never expose the private world, hidden enemy orders/resources/cooldowns, or arbitrary entity-ID probes. A retreat predicate cannot detect an invisible attacker beyond information a player legitimately receives.

Permitted actions: move to an assigned anchor, attack a legal target category, maintain a bounded range, hold, retreat, gather/return, repair within budget, or use an eligible ability. Actions reuse ordinary movement/combat/economy code and costs. They cannot spawn, teleport, heal, or issue orders outside the unit's capabilities.

### Initial presets

| Preset | Player intent | Safeguards |
| --- | --- | --- |
| Hold territory | Defend an anchor and attack within range | No pursuit outside leash; remain clear of production exits |
| Advance cautiously | Move/attack toward a goal, stop for visible resistance | Bounded acquisition radius; no global target hunt |
| Skirmish | Maintain useful weapon distance while pursuing the assigned objective | Leash and retreat anchor; no perfect hidden-state dodging |
| Preserve force | Retreat below a chosen health threshold | Hysteresis/minimum dwell; a valid anchor; avoid oscillating between combat and retreat |
| Support | Repair or use an approved support ability | Spend cap/reserve, target priority, cooldown, friendly-health constraints |
| Economic | Gather, deposit when applicable, seek a legal next node | Territory survival rules, danger policy, no knowledge of undiscovered deposits |

Policies are optional specialization over useful defaults. First UI exposes presets, retreat thresholds, pursuit limits, and ability toggles. Advanced transitions become editable only after this model is understandable and performant.

### Manual intent versus autonomy

Manual orders define the task and its stance, not direct per-frame motor control. On activation, an explicit task supersedes the prior task. A player's enabled retreat/support policy can still act within that task's contract; the UI must show this, including why a unit retreated. Provide a deliberate "commit" stance that disables optional automatic retreat for that task, not an invisible manual-order grace timer. Hard game states such as stun, channel, arrival lock, or blocked passage still apply.

Policies survive loss of client connection and run on the server. Policy changes are versioned and delayed. Mass assignment is one bounded group operation; updates do not grant instantaneous actions or reset cooldowns. New units inherit a producer's selected policy/version according to an explicit rule, with that inherited policy shown before purchase.

## Ability adaptation

| Mechanic | Proposed activation sequence | Counterplay and failure cases |
| --- | --- | --- |
| Relay transfer | Delayed intent, validate source/destination, channel, land in valid slots, arrival state | Revalidate relay and occupancy at resolution; source/destination loss cancels without duplicating units; partial group handling declared |
| Recall | Delayed intent, pay permitted shield cost at cast, short channel, resolve eligible units, arrival state | Incoming damage interrupts affected units; no refund on ordinary interruption unless explicitly specified; do not kill casting hub through cost |
| Smoke | Delayed cast or active policy action, bounded lifetime/charges, owner-aware visibility | Sight-only effect initially; not bullet collision; leaving fog removes live tracking; opposing fields have explicit overlap rules |
| Retreat boost | Delayed command or active policy, speed phase, recovery penalty | Cannot toggle away the penalty; policy cannot evade it by issuing another action |
| Organic sacrifice/morph | Delayed intent; consume eligible inputs atomically at start; timed output | Death/cancel races and input ownership tested; combine consumes exactly four selected eligible workers in the reference-inspired design |
| Temporary death-spawns | Resolve after simultaneous deaths against the defined territory snapshot | Child entities ineligible for recursive spawning/refunds; budgets cannot nondeterministically drop effects |
| Area damage | Telegraph, windup/travel, resolve gameplay area; visuals follow events | Give warning proportional to delay or support preconfigured avoidance; do not import twitch-dependent attacks unchanged |

Ordinary automatic attacks remain ordinary combat, not delayed casts. Autonomous ability timing must be accessible to both sides through the same policy framework. A warning shorter than order delay is only reasonable when positioning or available preconfigured behavior is intended counterplay; the game must make that clear.

## Information and feedback

Show distinct sent, scheduled, active, and failed states using shape/icon plus color. Give scheduled orders a bounded server-tick countdown, a world marker, and a queue entry. Display current task and active behavior separately. Explain policy actions with compact reasons such as low shields, retreat anchor, no safe route, or insufficient reserve; do not spam notifications every tick.

During stalls, freeze inferred progress at the existing bounded extrapolation limit and show connection/tick status. Do not make delayed movement appear to have executed through predicted combat or resource changes. Cosmetic click feedback is immediate; gameplay state is not.

## Required tests

- Deterministic repeated replay for identical accepted intents, policies, maps, and rules versions.
- Before/due/after activation boundaries; duplicate submissions; disconnect/reconnect; two tabs; same-tick death/cancel/payment; stale ownership and target loss.
- Policy cycles, transition limits, priority ties, hysteresis, resource caps, inherited versions, and invalid policy rejection.
- Metamorphic privacy test: changing only information unavailable to a player must not change that player's policy decisions until it becomes observable.
- Refund conservation across morphs, summons, cancellation, surrender, simultaneous elimination, and repeated callbacks.
- Burst commands and maximum policies under target unit counts; policy work cannot starve other matches.
- Human A/B trials for delay length and manual versus preset versus customized control. Record orders/minute, outcomes, avoidable losses, policy-caused surprises, and reported intent failures without inventing a required win-rate target.