# Decision Record

Settled choices, with the reason and the evidence behind each. A decision here
is binding on implementation until superseded by a later dated entry. Open
questions stay in [ROADMAP.md](ROADMAP.md) and the design docs until they are
decided; do not resolve one by writing code and calling it settled.

Format: date, decision, why, what would overturn it.

---

## 2026-09-22 — Command delay is a bounded ruleset field, default unchanged

**Decision.** The command delay is a value frozen into the match at creation
from the ruleset, bounded by `COMMAND_DELAY_MIN` and `COMMAND_DELAY_MAX`, with
`DEFAULT_COMMAND_DELAY` staying at 20 ticks (1.0s at 20 TPS). Values outside
the bounds are rejected at room creation, never clamped. No client may change
the delay for a running match, and no per-player delay exists.

**Why.** [COMMANDS-AND-BEHAVIORS.md](COMMANDS-AND-BEHAVIORS.md) requires the
delay to be a ruleset field fixed at match creation, and names 0.5s / 1s / 1.5s
as trial points — so the bounds must span 10 to 30 ticks. Keeping the default
at 20 preserves the existing playable skirmish, which is a standing constraint.
Rejecting rather than clamping keeps a misconfigured match from silently playing
under rules nobody chose.

**Would overturn it.** Human A/B trials showing a different trial point is
clearly better, which would move the default but not the mechanism. Evidence
that delay must vary within a match would overturn the mechanism itself, and
the commands doc currently forbids that.

---

## 2026-09-22 — Match identity is frozen at creation, not resolved at read time

**Decision.** Each match records its ruleset version, map id, map version, and
map content hash at creation, and those values never change for that match.

**Why.** [ARCHITECTURE-AND-UX.md](ARCHITECTURE-AND-UX.md) requires match
metadata to carry ruleset version/hash and map id/version/hash, and requires
server and client to agree on the exact map hash.
[MAP-AUTHORING.md](MAP-AUTHORING.md) records that map identity is not yet stored
or hash-checked, and warns against deploying changed geometry until it is. A
match that resolves its map by name at read time would silently change rules
underneath running games when an authored map is edited.

**Would overturn it.** Nothing foreseeable; this is a correctness requirement,
not a preference. The *representation* of the hash may change.

---

## 2026-09-22 — Fog is not attempted before the private-state experiment answers

**Decision.** No fog, smoke, hidden scouting, or information-limited bot vision
is implemented until Increment C in
[IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) produces a written result. If
the installed stack cannot enforce per-viewer access, the response is an
isolated SDK upgrade attempt, not client-side filtering.

**Why.** Current unit, resource and command tables are `public`
([schema.rs](../../server/src/schema.rs)), so a custom client reads every match
in the database. [ROADMAP.md](ROADMAP.md) lists cosmetic fog as a release
blocker, and [ARCHITECTURE-AND-UX.md](ARCHITECTURE-AND-UX.md) states plainly
that match-scoped subscriptions reduce traffic but cannot enforce fog. The
README already documents this gap for anyone hosting publicly.

**Would overturn it.** A verified server-side mechanism that passes the
adversarial-client tests. Convenience does not.

---

## 2026-09-22 — First dual-currency economy values

**Decision.** Two currencies replace the single ore balance. **Material** funds
expansion, workers and basic army; **Catalyst** funds technology and
specialists. Opening balance is 250 material, 0 catalyst. First-pass costs:

| Thing | Material | Catalyst |
| --- | --- | --- |
| worker | 50 | 0 |
| soldier | 100 | 0 |
| scout | 80 | 0 |
| siege | 150 | 50 |
| barracks | 150 | 0 |
| turret | 125 | 0 |
| outpost | 100 | 0 |
| factory | 200 | 50 |
| lab | 150 | 50 |
| research (each) | 100 | 50 |

Army deaths — soldier, scout, siege only — refund 50% of both currencies
actually paid, rounded down, paid exactly once, never to an eliminated player.
Workers and buildings refund nothing. Every player receives an opening stipend
of 200 material/minute for 90 seconds, then 100/minute for 90 seconds, then
nothing, accumulated in integer ticks.

Map deposits gain a `kind` of `material` or `catalyst`. Two of the skirmish
map's eight deposits become catalyst, placed centrally so the scarcer currency
is the contested one.

**Why.** [GAME-DESIGN.md](GAME-DESIGN.md) requires two currencies with genuinely
different purposes, and states plainly that a generic ore balance with faction
income bonuses would lose the essential decisions. The refund and stipend come
from [RESEARCH.md](RESEARCH.md)'s documented 50% army refund and 200-then-100
per minute opening, which exist to make losses recoverable and expansion
attractive without making either safe. Specialists costing both currencies is
what stops catalyst from being an optional side resource.

**These are labeled experimental values, not balance.** The research ledger is
explicit that its numbers are historical reference for a different game on a
different engine, and that expansion behaviour depends on income, travel,
depletion and build time evaluated together. Nothing here is validated by play.

**Would overturn it.** Playtest evidence from the economy-openings and
raid-and-recovery sessions in [ROADMAP.md](ROADMAP.md)'s protocol — in
particular a dominant unopposed scaling pattern, or catalyst turning out to be
irrelevant or mandatory rather than a choice.

---

## 2026-09-22 — Catalyst is per-base, like SC2 gas; the centre holds no resources

**Decision.** Every base — main, natural, third, fourth — carries its own
catalyst, in roughly SC2 gas proportions (about 2 catalyst sites per base
alongside 6-8 material). No catalyst exists anywhere else, and the centre of the
map holds **no resources at all**: it is open ground contested for position, not
for income. This supersedes the earlier choice to concentrate catalyst at the
contested centre.

**Why.** Stated by the user on 2026-09-22: the map did not look like an SC2 map
and catalyst in the middle was wrong. They are right, and the play evidence
agrees. In StarCraft II gas is not a central objective; every base has geysers.
Concentrating the second currency in the middle made teching contingent on
holding the centre, which a live integration match showed in the worst way — a
laboratory could not be afforded from the starting balance at all, and a worker
had to walk to the centre and back twice before any tech existed.

The earlier reading of [GAME-DESIGN.md](GAME-DESIGN.md) — "catalyst: fewer
contestable sources" — was over-applied. Fewer sources than material does not
mean *one shared source in the middle*. Per-base gas already satisfies it:
catalyst sites are scarcer per base and deplete faster, so specialists still
compete with expansion, without making the centre a tech gate.

**What this does not change.** Catalyst still gates technology and specialists,
and specialists still cost both currencies. The scarcity now comes from stock
and from having to hold more bases, not from map position.

**Would overturn it.** Playtest evidence that per-base catalyst makes tech so
freely available that the material/catalyst tradeoff stops being a decision. The
response would be to cut per-base catalyst stock, not to move it back to the
centre.

---

## 2026-09-22 — The match clock follows wall time, not the scheduler's wake rate

**Decision.** `game_tick` advances by however many whole simulation ticks of wall
time have elapsed since the room was last simulated, capped at 4 ticks per wake,
carrying the remainder on `Room.last_tick_micros`. The scheduler is asked to
wake more often than one tick, and its wake rate no longer determines the tick
rate.

**Why.** The host does not deliver the requested period. Measured on this
machine: a 50ms request arrived every 61.7ms, a 25ms request every 31.4ms, a
15.625ms request every 26.7ms — neither a constant overhead nor a clean
quantization. Stepping once per wake therefore ran matches at **16.2 TPS instead
of 20, about 81% of real time, on every map**. That is not cosmetic: it stretched
the frozen one-second command delay to roughly 1.23 seconds, and the command
delay is the single most important tuning knob in the design. Every delay,
economy and balance measurement taken before this was against a clock running
19% slow.

After the change the same probe reads exactly 20.0 TPS at a 50.0ms period.

**Why the cap.** Without one, a stalled host hands the next wake an unbounded
catch-up and the simulation spirals trying to overtake it. Four ticks is a fifth
of a second of recovery per wake; beyond that the match legitimately falls behind
and the clock says so, which is the honest behaviour the architecture doc asks
for — report degraded wall-clock progress rather than skip gameplay ticks.

**Would overturn it.** Evidence that catch-up stepping harms determinism or
fairness under real network load. Stepping N ticks in one reducer call is
identical to N calls by construction, so this is a robustness question, not a
correctness one.

---

## 2026-09-22 — Three factions, distinguished first by how they mine

**Decision.** Introduce a `faction` on each player — **Network**, **Organic**,
**Industrial** (working names) — and make the first difference between them the
worker and the mining loop itself, not the unit roster.

| | Labour unit | Cost | How it gathers |
| --- | --- | --- | --- |
| **Industrial** | `worker` | 50 material | Mine and return. Fills 25 cargo, walks it to a hub. The baseline. |
| **Network** | `drifter` | 40 material | **No return trip.** Credits directly while working a deposit, in smaller pulses. Fragile, and it stands out on the map the whole time. |
| **Organic** | `harvester` | 0 material and 1 stock | Harvesters are **free** but limited by hub stock, carry little, and **cannot fight**. |

*Superseded in part on 2026-09-22: an Organic `drone` builder was originally
specified here and has been removed. See "Buildings are built from the command
card" below — the reference game has no builder unit for any faction.*

Organic hubs accumulate one stock every 60 ticks up to a cap of 7. A harvester
consumes one stock and no material.

**Why.** The user's priority, stated 2026-09-22: zones and per-faction mining
matter far more than the autonomous extractor, which is "one of the least
important mechanics". [GAME-DESIGN.md](GAME-DESIGN.md) agrees — different
economies must create different vulnerabilities, and resource choice, travel,
territory and production capacity must not collapse into one income multiplier.
Mining is where that difference is most felt, every second of the match.

Each model buys its advantage with a matching exposure: Network pays no travel
time but leaves its labour parked in the open; Organic replaces losses for free
but is throughput-limited by stock regeneration and cannot defend or build with
its harvesters; Industrial is safe and steady and has no special escape.

**Experimental values, not balance.** Every number above is a first pass.

**Would overturn it.** Playtest evidence that one model dominates regardless of
map position, or that no-return-trip mining removes so much decision-making that
Network has no economic gameplay left.

---

## 2026-09-22 — Buildings are built from the command card, not by workers

**Decision.** Construction is ordered from the command card and the building
raises itself. No worker is needed to start it, to work on it, or to transform
into it. This applies to every faction, so no faction has a builder unit.

**Why.** Stated by the author: the reference game builds this way, closer to
Command & Conquer than to StarCraft. The current engine instead requires a
worker to place a site and then stand on it — `construction_remaining`,
`construct` orders and builder assignment all exist to serve that. It is a
StarCraft assumption inherited from the prototype, not a Honey Badger one.

It also removes a reason for the Organic `drone` to exist at all, which is why
that half of the faction decision above is withdrawn rather than adjusted.

**What this changes, and what it does not.** Placement rules, build radius,
terrain and occupancy checks all stay: where you may build is unchanged. What
goes away is *who* must be there. Construction time stays a real cost, so
buildings are still committed in advance rather than appearing instantly, and a
site under construction is still destructible.

**Settled by the author (2026-09-25).**

- **No cancellation.** Once placed, a building cannot be cancelled and nothing
  is refunded. The current `cancel_construction` order, its 75% refund
  (`CONSTRUCTION_CANCEL_REFUND_PERCENT`) and the client's "Cancel construction"
  button are removed in Increment J.
- **No interruption.** Construction cannot be paused, sped up or stopped. If the
  placement was accepted, the building keeps building until it finishes or is
  destroyed. This is Command & Conquer style, not StarCraft style.
- **Build radius stays**, as part of whether a placement is acceptable. The
  placement check is the only gate on construction.
- No worker ever builds anything, including a builder unit: Organic labour does
  not combine into builders.

**Would overturn it.** Nothing foreseeable; this is the author's account of the
game being converted, not a balance preference.

---

## 2026-09-24 — Organic creep slows harvesters; it does not starve them

**Decision.** An Organic harvester standing on none of its owner's creep moves
at 0.6x speed. That is the whole penalty: no drain, no death timer, no effect on
any other unit, friendly or enemy. Creep therefore participates in the
**movement** and **combat/death** concepts only, and is **not** an
economy/survival zone. This supersedes [RESEARCH.md](RESEARCH.md)'s "dies
quickly off creep" and the earlier [ZONES.md](ZONES.md) phrasing "harvesters
depend on it".

**Why.** The author's call, 2026-09-24. Cutting creep still costs the Organic
economy — harvesters walk slower between deposit and hub — without turning a
severed patch into mass labour death, which is the readable response window
the handover asked for.

**Would overturn it.** Playtest evidence that a 0.6x slow makes creep
irrelevant to the Organic economy. The response would be a harsher slow before
a survival mechanic.

---

## 2026-09-24 — Creep: hubs only, one disc per source, owner-only death spawns

**Decision.**

- **Only hubs make creep**: HQ to 360, outpost to 300. Every other building,
  Organic or not, spreads none.
- **One disc per source**, a `CreepPatch` with a stored integer radius, not a
  grid. A patch sprouts at 60 when its hub completes (starting HQs are full at
  tick 0), grows 10/s stepped every 20 ticks, and on losing its source holds
  for 100 ticks, recedes 20/s, and is removed at 0.
- **Only the creep owner's own units, dying on that owner's creep, spawn.**
  Buildings, research and temporary units spawn nothing. By total cost: under
  50 nothing, 50–199 one `brood` (hp 30, speed 120, range 20, damage 6,
  cooldown 10, lives 200 ticks), 200 and up one `brute` (hp 70, speed 90,
  range 30, damage 14, cooldown 12, lives 300 ticks). An army unit dying on
  creep gets both its refund and its spawn.
- **Spawned units are tiny and weak for a reason**: controllable, attack-moving
  to the death point on arrival, free, no supply, not counted toward
  `MAX_UNITS`, not army. Expiry removes them outside the death pipeline, so it
  never reaches `lost`, `killed`, refunds or spawns.
- The reference game's air branch (a dying flyer leaving small flyers, a
  "mite") is documented in `death_spawn` only. No air unit exists.

`RULESET_VERSION` 6. Every number is experimental.

**Why.** Hubs-only and owner-only are the author's decisions. A disc per source
rather than a grid because the count is bounded by `MAX_BUILDINGS`, it is cheap
to persist and diff, and recession needs state that outlives its source — which
also makes creep the one zone carried between ticks instead of derived. Keeping
spawns off supply and the unit cap stops a lost fight on creep from blocking
the owner's own production.

**Would overturn it.** Playtest evidence that death spawns dominate fights on
creep, or that a shape other than a disc per hub is needed for creep to read as
territory. Either would change values or representation, not ownership.

---

## 2026-09-24 — Shields and the Network power field

**Decision.**

- **Only Network carries shields, as half its listed health.** A Network
  entity of any kind gets `hp - hp * 50%` hit points and the rest as shields:
  a soldier is 70 + 70, an HQ 600 + 600, a drifter 20 + 20. The total is
  unchanged, so the faction gains regeneration, not durability. Temporary
  units never carry shields. Both maxima are stored on the entity at spawn
  (`max_hp`, `max_shields`) so repair, construction and the client all read
  the figure the simulation chose.
- **Shields take damage first.** Armour and weapon upgrades apply to the hit
  before the split, exactly as before. Hit points never regenerate; repair
  still restores them only.
- **Regeneration waits 200 ticks (10s) after the last hit**, then restores 1
  shield every 10 ticks (2/s). Inside the owner's power field it is 3x (6/s).
  Construction raises shields from 0 to full alongside hit points, so a
  finished building is at full health.
- **The power field is projected by the new Network `relay` and by a Network
  player's hubs** (HQ, outpost), radius 320. Barracks, factories, labs and
  turrets project nothing. The relay is Network-only, 75 material, 300 listed
  health (150 + 150), 5s build.
- **Drifters train at any finished structure standing in the owner's field**,
  on top of the HQ, and a drifter with no rally goes straight to the nearest
  material deposit.
- **A death in the field restores shields**: each of the owner's entities
  within 180 of the death point gains 20% of the dead entity's total health
  (hit points plus shields, at maximum), capped at its own maximum. Same
  snapshot rule as creep's death spawns.
- **Teleport**: any mobile unit standing in its owner's field can be sent to
  any point in that field. It channels for 20 ticks (1s) without moving or
  firing; any damage cancels it. When the channel completes, both ends are
  checked again, and a destroyed relay strands the unit where it is. On arrival
  it is inactive for 40 ticks (2s): it can be shot but does nothing. No
  cooldown and no cost beyond that. Cannot be queued.
- The power field participates in **connectivity** (power) and
  **combat/death** (regeneration, restoration), and nothing else. It blocks
  nothing and changes no one's speed.

`RULESET_VERSION` 7. Every number is experimental.

**Why.** The 50/50 split follows the reference game's shielded faction and
keeps the change honest: Network is not simply given more health. Hubs project
power so a Network base opens powered and every expansion powers itself; if
every structure projected, "train at any structure in the field" would mean "at
any structure" and the relay would have no job. Damage cancelling the channel
follows the reference game's recall, and without it a teleport would be a free
exit from every fight inside a field. The arrival window replaces a cooldown as
the price of the move.

**Confirmed by the author (2026-09-25):** hubs and relays both project power,
as above (not the relays-only pylon reading).

**Settled by the author (2026-09-25).**

- Teleport gets a **cooldown, not a cost**: 30s from arrival
  (`TELEPORT_COOLDOWN_TICKS` 600, experimental), derived from `arrive_tick`,
  so no new state.
- The split **varies by kind, as in SC2**: every structure, the drifter and
  the skimmer are half and half (nexus, pylon, cannon, probe, adept); the
  sentinel and the lancer are a third shields (zealot 100/50, immortal 200/100).
  Totals are unchanged. `rules::network_shield_percent`. `RULESET_VERSION` 9.

**Would overturn it.** Playtest evidence that teleport without a cooldown lets
an army dodge every fight in its own base, or that 6/s regeneration makes
Network bases untakeable. Either changes values, not the model.

---

## 2026-09-25 — Faction armies: three units each, one per role

**Decision.** Each faction trains only its own army: a fighter and a raider or
support unit from the barracks, and an anti-structure unit from the factory.
Industrial keeps soldier, scout and siege unchanged. Network gets sentinel,
skimmer and lancer: fewer, dearer, tougher, and half shields. Organic gets
swarmer, spitter and crusher: cheap, fast, massed, and feeding creep's death
spawns. Every slot opens with its own fighter. Stats are in `rules::stats` and
the step 18 table in [HANDOFF.md](HANDOFF.md). All experimental. `RULESET_VERSION` 8.

**Why.** GAME-DESIGN.md asks for a fighter and a specialist per faction, plus
an anti-structure role, using original designs rather than SC2 copies. Its
themes set the lean: Network has "strong individual units", Organic has
"large counts", and Industrial is the conventional baseline. Giving every
faction the same three roles keeps the command card, and the bot, uniform.

**Confirmed by the author (2026-09-25):** the unit names and roles as listed.

**Settled by the author (2026-09-25).** Organic labour does **not** combine into
builders: construction comes from the command card for every faction (see
2026-09-22). Units **will** get abilities, but in a later increment. For now
they differ by stats only.

**Would overturn it.** Play showing one faction's roster dominating, or a role
that no faction's player ever builds.

---

## 2026-09-25 — Fog of war demoted; it may never be built

**Decision.** Fog of war, and the private-state experiment (Increment C) that
gates it, move to the very bottom of the roadmap (M6, "if ever"). Every client
sees the whole match. That is the intended game for now, not a leak.

**Why.** Stated by the author: "that might not even be needed in the end."
Nothing else waits on it: none of the three territory zones blocks sight.

**What still holds.** The 2026-09-22 rule stands if fog is ever wanted: no fog,
smoke or hidden scouting until the experiment passes. Only the priority changed.

---

## 2026-09-25 — Unit cap 120; map hash compared on the client

**Decision.** `MAX_UNITS` is 120 per player (author's instruction). The client
computes the bundled map's content hash (`src/maphash.ts`, a byte-for-byte port
of `MapDefinition::content_hash`, pinned against both maps in tests) and shows a
notice if it differs from the room's `map_hash`.

**Why the hash, given server authority.** The server decides everything, so a
mismatch cannot cheat. But the client draws terrain and previews placement from
its own bundled copy: after a republish, a stale tab would show walls that are
not there and pre-reject legal sites. The check costs one hash at load. When a
map editor exists, the client should receive the map from the server instead,
and this check becomes a guard on that transfer.

**Would overturn it.** Tick cost at 120 per player: the last reading, on a busy
machine, was ~26-28ms p95 against a 25ms budget. Measure on an idle machine.

---

## 2026-09-25 — Units auto-attack while moving

**Decision (author).** Units should auto-attack enemies in range while they move,
not only when idle or on attack-move. Otherwise, with a one-second command
delay, micro is too hard.

**Already true.** Every unit with a weapon fires at the nearest enemy in range
whenever its cooldown is ready, whatever its order (teleport channelling
excepted), and on a `move` order it keeps walking while it does. Pinned by
`a_unit_on_a_move_order_fires_at_enemies_in_range_without_stopping`.

**Open, for later.** Whether some or all kinds should **stop to fire** (most of
SC2) or keep **firing on the move** (SC2's phoenix), which is what every unit
does today. Probably a per-kind stat once units differ enough. A side effect to
decide at the same time: there is no "move and ignore enemies" order (SC2's
plain move), so a retreat still spends its shots and never breaks off for them.
Belongs with the behaviour presets, whose retreat preset needs an answer.

**Settled by the author (2026-09-25, later).** Firing on the move becomes a
**per-kind stat**: some kinds stop to fire, others keep firing while moving.
Which kinds do which is not yet decided. The `move` order keeps today's
behaviour, which the author treats as SC2's attack-move: it fires at anything
in range. A plain "only move and run" order that holds fire may come later,
not yet.

---

## 2026-09-25 — Behaviour presets deferred to late in the plan

**Decision (author).** Behaviour presets (hold / advance / retreat and the
rest in [COMMANDS-AND-BEHAVIORS.md](COMMANDS-AND-BEHAVIORS.md)) move to one of
the last things built. Players micro everything themselves for now.

**Why.** Stated by the author: how presets are created, and how players set up
their own strategies, needs more thought first. So the questions of which
presets come first and whether they belong to units, groups or production
buildings stay open until then.

**What still holds.** The design's bounded, server-evaluated policy model is
still the intended shape. Only the timing changed. The M1 "order delay and
policy" experiment waits with it.

---

## 2026-09-25 — Primary-hub victory

**Decision (author).** A player is eliminated once they have lost every
**completed** hub: the HQ and every outpost, for all three factions, Organic
included. A hub still under construction does not keep a player alive. If the
last players all lose their last hub on the same tick, the match is a draw.
Surrender is unchanged. This replaces the one-HQ rule
([GAME-DESIGN.md](GAME-DESIGN.md), "Victory").

**Follow-on (implementation default, not asked).** Research belongs to the
player, not to the HQ unit, so a player who loses the HQ but keeps an outpost
keeps their upgrades, as in SC2. Research is still done at the lab, and
research in progress is lost with the lab. The HQ cannot be rebuilt.

---

## 2026-09-25 — Outposts are town halls; C&C-style training

**Decision (author).** Outposts work like SC2 and Warcraft town halls: every
faction's outpost trains that faction's labour (worker, drifter, harvester) and
takes a rally. The HQ can stay special in other ways. Before this, only the
Organic outpost trained anything, so a player who survived on outposts could
never rebuild labour.

**Decision (author).** Training works like Command & Conquer: a train button
on the command card needs no building selected. "Much cleaner UX."

**How the building is chosen (implementation default, the author invited a
proposal).** Per click, on the client (`src/production.ts`, `trainingSite`):
only finished buildings that can train the unit and still have queue room,
counting `train_*` commands still inside the command delay. A harvester also
needs stock left at that hub. If the player has any of those selected, only
those are used, so selecting a building still means "train here". Otherwise
the shortest queue wins, and ties go to the lowest id. So repeated clicks
spread over parallel barracks. The server protocol is unchanged: the client
still names one building per `train_*` order.

**Would change it.** A "primary building" per kind (C&C's primary structure),
or choosing by camera position, if players find shortest-queue surprising.

---

## 2026-09-25 — First abilities: recall and bloom, paid in energy

**Decision (author).** Abilities use SC2's model: **energy and a cooldown**.
The first two are Network **recall** and Organic **temporary creep** (built
as "bloom"). **Industrial gets no ability for now**: smoke, retreat and outpost
suppression were all offered and turned down as leftovers of earlier Honey
Badger versions. What Industrial gets instead is open.

**How it is built (implementation defaults, not asked).**

- The casters are **hubs** (HQ and outposts), like SC2's nexus. A Network or
  Organic hub starts with 50 energy, holds up to 200 and gains 1 every 25 ticks
  (0.8/s). Industrial hubs hold none. Casting needs no selection: the client
  uses a selected hub that can cast, otherwise the ready hub with the most
  energy, as C&C-style training does.
- **Recall**: 50 energy, 60s cooldown, a 3s channel shown to everyone (circle
  and a line to the hub). At the end, the caster's mobile units within 200 of
  the point land around the hub, inactive for 2s like a teleport arrival,
  with **shields spent to 0**. That is the reference game's "shield-funded"
  recall. A hub destroyed during the channel recalls nobody. Units in the area
  are not interrupted by damage; only the hub matters.
- **Bloom**: 25 energy, 10s cooldown, instant. Placed anywhere on your own
  creep, it adds a patch that grows like a hub's to radius 200, lives 60s, then
  lingers and recedes like a dead hub's patch. Blooms chain: a bloom's creep
  takes the next one. There is no entity to kill; the timer is the counterplay.
  It is creep in every respect, so death spawns and the harvester slow follow
  it.
- `RULESET_VERSION` 12. Schema change (energy, cooldown and a pending cast on
  every entity; an expiry on creep patches): new database `stdbrts-cast`.

**Would change it.** Recall wiping shields may be too harsh or too cheap once
played. Blooms may need a limit per hub if chained creep crosses the map too
quickly. Casting from hubs keeps the command card uniform, but a unit caster
(SC2's queen) is the obvious alternative for Organic.

---

## 2026-09-29 — The author's changelog sheet is the reference source

**Decision (author).** The author's changelog spreadsheet (H0, transcribed in
[REFERENCE-CHANGELOG.md](REFERENCE-CHANGELOG.md)) replaces the mod's website
page (H1) as the reference for what Honey Badger was. H1 describes an earlier
version. [RESEARCH.md](RESEARCH.md) is updated to match.

**What this does not do.** It overturns no entry above. Every earlier entry
was either the author's own call or labeled experimental, and several already
matched H0 rather than H1: construction with no builder unit, the sensor
tower, shield restoration on death in the power field, owner-only death spawns
on creep, and dropping smoke, retreat and suppression. A reference source
informs decisions; it does not make them.

**Where the built game now differs from H0.** These were open questions for the
author; the answers are the next entry. Each needs a decision before code changes.

| Built today | H0 says | Question |
| --- | --- | --- |
| Finite deposits that deplete | Minerals and gas are infinite and replenish | Keep depletion (it pushes expansion) or go infinite? |
| Opening stipend 200 then 100/min | Not present (H1 only) | Keep as a tuning aid or remove? |
| Refund: army only | Also gas buildings, Zerg bases, Protoss probes | Widen eligibility? |
| Material buys units; catalyst buys tech and specialists | Unit prices look gas-denominated; Terrazine, a third resource, buys static defense | Is the currency split right, and is a third resource for defense wanted? |
| Research at a lab, with a timer | Instant, global, on the hero builder, plus four global ability tiers | Adopt instant research and tiers? |
| Build anywhere legal | Within 40 of a finished structure; static defense only in a faction zone; no building on the enemy half early | Adopt adjacency and zone-gated defense? |
| Network shields regenerate after 10s out of combat; hit points never regenerate | Shields regenerate in combat; the power field also regenerates life and energy | Change regeneration? |
| Industrial has no ability | Orbital repair drones (75 energy), tech reactors | Is the repair drone the Industrial ability? |
| No overkill rule | Protoss ricochet: overkill bounces to a nearby unit | Wanted for Network? |
| No burrow | Zerg burrowed units move and regenerate faster | Wanted for Organic? |
| Every faction opens with its labour plus one fighter | Terran opens with 16 SCVs | Opening counts per faction? |

**Would overturn it.** A later or more authoritative source from the author,
such as the mod's data files.

---

## 2026-09-29 — Three currencies, base income, instant research, build rules

The author's answers to the questions in the previous entry. All settled;
every number is still experimental.

**Currencies (author: "a huge part of the schtick").** Each currency buys one
kind of thing, so spending on the army never competes with building or
teching:

| Currency (working name) | SC2 reference | Buys |
| --- | --- | --- |
| Material | minerals | Structures, research, ability tiers |
| Catalyst | gas | Army units |
| Terrazine | Terrazine | Static defense (turrets) |

Terrazine is earned by mining material, as a by-product; Industrial earns 20%
more of it (H0). This supersedes the 2026-09-22 split (material for workers,
buildings and basic army; catalyst for tech and specialists).

**Base income never stops.** The opening stipend becomes permanent base
income. The 90-second phases stop mattering after the opening.

**Depletion stays**, for now, although H0 has infinite resources.

**Research is instant and global**, bought from the command card with no
building, as on H0's hero builder. H0's four global ability tiers come with it.
The lab's research queue goes.

**Build rules.** A structure must be placed within a fixed range of one of the
owner's *finished* structures. Static defense can only be placed inside the
owner's faction zone: power field, creep, or sensor-tower radius. No building
on the opponent's half of the map for the first few minutes.

**Network regeneration.** Shields regenerate in combat (no 10s delay). Inside
the power field, hit points and energy regenerate as well as shields, faster.

**Industrial ability: the repair drone.** Cast from an Industrial hub for
energy (H0: 75). A drone flies from the nearest hub with enough energy to the
target and heals **hit points of any unit**, not only mechanical ones, for a
bounded total (H0: about 300), then expires. One drone per target at a time.
Industrial hubs therefore gain energy.

**Yes to the rest:** Network ricochet (overkill damage bounces to a nearby
enemy); Organic burrow (burrowed units move and regenerate faster, and are
never hidden); wider refunds at 50% for gas buildings, Organic hubs and Network
drifters, on top of army units.

**Still open (not asked yet).**

- Base income rate and which currencies it pays. Implementation default until
  answered: 100 material per minute, the stipend's second-phase rate, forever.
- ~~What labour costs~~: material (author, 2026-09-29, later).
- ~~How catalyst is gathered~~: **automatic refineries for every faction**
  (author, 2026-09-29, later). A refinery on a catalyst site produces catalyst
  on its own, with no workers, as H0's gas buildings do. This revives the
  demoted autonomous extractor (Increment F) as a shared mechanic, not an
  Industrial identity, and without suppression or an output switch.
- **Cross-income, as the author remembers it (unconfirmed):** every X material
  mined also gave Y catalyst, and every X catalyst gave Y material. Exact
  values, and whether this is the same mechanism as Terrazine's by-product
  income, are not known. Not in H0.
- Refinery rate, cost, and whether workers can still mine catalyst at all.
- The Terrazine rate per material mined, the placement range, the no-build
  window's length and what counts as "the opponent's half", and what the four
  tiers contain for this game's three rosters.
- Whether the Organic burrow and the Network ricochet are per-kind or
  faction-wide.

**Would overturn it.** Play showing that separate currencies make one of them
irrelevant (for example, static defense never built), or that permanent base
income removes the pressure to expand.

---

## 2026-09-30 — Orders run at the client's stamped tick, not at arrival

**Decision (author).** The command delay exists so that the network never
decides when an order runs. The client stamps each order with the tick it
should run on: the newest tick it has seen plus the match's delay. The server
honours the stamp while the order arrives within `COMMAND_LATENESS_ALLOWANCE`
(6 ticks, 300ms), and clamps it into
`[room.tick + delay - allowance, room.tick + delay]` otherwise. An unstamped
order (stamp 0, scripts and tools) waits the full delay from arrival, as
before. The stamp is stored as `Command.requested_tick`. `RULESET_VERSION` 13.

**Why.** Before this, the server stamped `room.tick + delay` on arrival, so a
player's real delay was their ping plus one second, and a lag spike moved
execution by the length of the spike. That paid the whole price of the delay
and got none of its value. With the stamp, every player under ~300ms round
trip gets exactly one delay after the state they were looking at, whatever the
jitter, and the client knows the execution tick at the click, so its countdown
ring starts at once. The simulation stays server-only: no lockstep, no client
prediction, no rollback. A server that goes quiet for 500ms shows "Waiting
for server" instead of a silently frozen picture.

**Cheating bound.** A client may stamp any tick; the floor stops it from
skipping the delay. The most it gains is the allowance, which an honest
player at 300ms round trip gets anyway. Clamping, not rejecting, is right here
because the stamp is a timing request, not a rule the match was created under
(the delay itself is still rejected when out of range).

**Would overturn it.** Real online play showing typical round trips above
300ms (raise the allowance, accepting a larger cheat bound), or players
exploiting the allowance measurably.

---

## 2026-10-03 — N2: instant research and three tiers

**Decision (Claude, on the author's instruction to "yolo decide upgrades and
units, so we actually have more depth").** Every number is experimental.

Research and tiers are instant, global to the player, bought from the Research
tab with material, and never lost (they outlive every building, as research
does today). No building is selected and none queues anything; the lab's
research queue goes.

- **Weapons / Armour / Logistics**: unchanged effects and price (150 material
  each), now instant, with no building required.
- **Tiers** are bought in order. Each one unlocks the second-tier units of one
  production building and gives every faction one upgrade that sharpens its
  identity. The building requirement is checked only at purchase.

| Tier | Cost | Requires | Unlocks | Industrial | Network | Organic |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Mobilisation | 300 | a finished barracks | marksman, medic / arcer, phantom / prowler, devourer | **Combat Shields**: soldier +20 max hit points | **Quick Blink**: Battle Blink cooldown 12s to 8s | **Metabolic Boost**: swarmer and prowler +15% speed |
| 2 Escalation | 500 | tier 1, a finished factory | bulwark / warden / behemoth | **Dig In**: Entrenchment arms in 4s instead of 7.5s | **Focusing Lens**: lancer +20 range | **Grooved Spines**: spitter +20 range |
| 3 Dominion | 800 | tier 2, a finished lab | — | **Reinforced Plating**: every own building +2 armour | **Resonance**: Phase Shift every 5s instead of 8s; warden aura 2 to 4 shields per second | **Adrenal Glands**: swarmer and devourer attack 20% faster; crusher +2 armour |

The first-tier units (soldier, scout, siege; sentinel, skimmer, lancer;
swarmer, spitter, crusher) need no tier. Training a gated kind without its tier
is refused ("Requires Tier N"). The lab stays as the tier 3 gate, which gives
the opponent a target that delays the late game.

**Why.** Before this, every unit was available the moment its building stood,
so there was no tech path to choose or deny. Tiers turn material into a real
decision: tech up now, or spend on structures and expansion. They also give
the lab a purpose. Each upgrade amplifies a passive the unit already has, so
nothing new needs to be drawn. Tiers sit in the player's existing `research`
list (`tier_1` to `tier_3`), so no schema change is needed. H0's fourth tier
(7500, speed and range for everything) is not built.

**Would overturn it.** Play showing tiers too cheap (everything unlocked by
4:00) or too dear, or the author's own tier contents.

---

## 2026-10-06 — The command delay is chosen at room creation

**Decision.** `create_room` takes the delay as a `command_delay` argument in
ticks. The lobby offers the three trial points, 10 / 20 / 30 (0.5s / 1.0s /
1.5s), both in the create-room form and beside "Practice vs AI"; the default
is 20. The value is validated against `COMMAND_DELAY_MIN`/`MAX` (rejected,
never clamped) and then frozen for the match exactly as before.

**Why.** This is the lobby control the bounded-field decision above was
waiting for, so the trial points can be compared in play. The mechanism is
unchanged: one delay per match, no per-player or mid-match changes.

**Would overturn it.** Trials settling on one value, which would remove the
control and move the default.

---

## 2026-10-06 — One-hop build reach, and your own units step aside

**Decision.** A building site is in reach when it is within 500
(`rules::BUILD_RADIUS`) of a finished building of yours, or within 500 of an
unfinished building of yours that is itself within 500 of a finished one. One
hop, deliberately not transitive. Separately, only enemy mobile units within 55
refuse a site ("Enemy units block the building site"); your own units standing
on it are moved to the nearest legal ground when the construction site is
created (`Navigation::escape`, the search the end-of-tick recovery already
uses, in unit order, orders untouched). The client mirrors both in
`placementError`, and the placement overlay draws the look-ahead circles.
`RULESET_VERSION` 19. No schema change.

**Why.** Building out a base felt click-heavy: you waited for each structure to
finish before the next could be placed, and had to walk workers off every site.
One hop lets you queue the next building off one under construction, but not
chain static defense across the map in seconds: reach is at most about 1000
from finished structures.

**Would overturn it.** Play showing the look-ahead abused for forward turret
creep (then drop it or shrink the second hop), or players still waiting on
completions (then allow a second hop).

## 2026-10-06 - A rally can carry a behavior

**Decision.** A producer's rally may carry a behavior preset: orders
`rally_harass`, `rally_guard`, `rally_raid` (x, y = goal), validated exactly as
`rally_move` is. When a unit finishes training there, army units start the
behavior at spawn via the same `activate_behavior` the `issue_order` kinds use
(home anchor beside the nearest completed hub, computed at spawn time); labour
walks to the point as with `rally_move`. Client: with only producers selected,
J/K/N arm and the click sends `rally_<preset>` to every selected producer; the
rally marker and panel text name the preset. `RULESET_VERSION` 20. No schema
change, no reducer signature change.

**Why.** Setting up strats meant re-selecting every new soldier. Select the
barracks, press K, click the ramp: every soldier it trains guards the ramp.

**Would overturn it.** Players wanting different behaviors per unit type from
one building (then a per-unit rally), or labour needing the goal as something
better than a plain move.
