# Zones: the territory layer

Design for Increment I of [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).
Rewritten 2026-09-22 from the author's direct account of the reference game,
which **supersedes** the earlier draft and parts of
[RESEARCH.md](RESEARCH.md) that were read off the mod's public pages.

Zones are the mechanic the author ranked first, ahead of per-faction mining and
far ahead of the autonomous extractor.

## Correcting the earlier draft

The first draft named "Industrial smoke" as the third faction's zone. That was
wrong. Smoke exists in the reference game as a HERC *ability* — a small
opponent-only sight blocker — and the research ledger recorded it as such. It is
not the Industrial territory mechanic, and turning an ability into a zone put
the only per-viewer-visibility mechanic on the critical path for no reason.

The three real zones are below. Notably **none of the three blocks sight**, so
nothing in this increment depends on the private-state experiment in
[EXPERIMENT-C-PRIVATE-STATE.md](EXPERIMENT-C-PRIVATE-STATE.md). That unblocks
the whole territory layer.

## The rule that shapes everything else

[GAME-DESIGN.md](GAME-DESIGN.md) requires six concepts stay separate, and that
collapsing them into one "terrain" flag is the failure mode: movement, sight,
projectiles, connectivity and eligibility, economy and survival, and combat and
death effects. So a zone has no single "blocks" boolean; it declares which of
the six it participates in, and each is queried separately.

The engine already keeps two apart and must not regress: buildings block
movement while terrain alone blocks weapon line of sight.

## The three zones

Each faction's zone pairs with that faction's mining model, and two of the three
also change what happens when a unit **dies** inside them.

### Organic — creep

Pairs with free, tiny, weak harvesters.

- **Only hubs make creep** (author's decision, 2026-09-24): an Organic HQ to a
  radius of 360, an outpost to 300. No other building spreads any.
- Grows from its source; recedes when the source dies. A patch sprouts at 60
  the tick its hub is first seen finished (the starting HQs are full at tick
  0) and grows 10 per second, stepped once every 20 ticks. When the source is
  lost the patch holds for 100 ticks, then recedes 20 per second and is removed
  at 0.
- **Harvesters off their owner's creep are slowed to 0.6x.** Nothing else — no
  drain, no death timer. This supersedes the earlier "harvesters depend on it"
  and [RESEARCH.md](RESEARCH.md)'s "dies quickly off creep"; see
  [DECISIONS.md](DECISIONS.md). Cutting creep still hurts the economy, through
  travel time rather than through losses. No other unit, friendly or enemy, is
  affected.
- **Units dying on creep spawn free temporary units.** Only the creep owner's
  own units, on that owner's creep; buildings spawn nothing. Keyed on the dead
  unit's total cost: under 50 nothing, 50–199 one `brood`, 200 and up one
  `brute`. The reference game also split on **ground or air** — broodlings,
  infested terrans, or small flyers — and the air branch (a mite) is
  documented only: no air unit exists yet.
- Spawned units are controllable and start attack-moving on the spot where the
  unit died. They take no supply, do not count toward `MAX_UNITS`, earn no
  refund, never spawn anything themselves, and expire on their own (brood 200
  ticks, brute 300). Expiry is a removal, not a death, so it never touches
  `lost`, `killed` or army value. An army unit dying on creep gets both its
  refund and its spawn.
- Participates in **movement** (the harvester slow) and **combat/death** (the
  spawn), and nothing else. It is not an economy/survival zone. It does not
  block movement, sight or weapons.

**Representation.** One disc per source (`CreepPatch`, radius stored as an
integer), not a grid. It is the only zone state carried between ticks, because
recession needs state that outlives its source. Patches are bounded by
`MAX_BUILDINGS`, persisted in their own `creep_patch` table and diffed on save,
so a patch at a steady radius costs no write. Every number above is
experimental.

### Network — power field

Pairs with mining that needs no return trip.

- Projected by the Network `relay` and by a Network player's hubs (HQ,
  outpost), radius 320. Other Network buildings project nothing.
- **Workers can be created at any structure inside the field and start mining
  immediately**, so the economy expands by projecting infrastructure rather than
  by walking labour across the map.
- **Shields regenerate faster** inside the field.
- **A unit dying in the field restores shields to nearby friendly units**,
  scaling with the dead unit's total health, hit points plus shields.
- **Any unit can teleport from anywhere in the field to anywhere else in the
  owner's field.** This is the faction's defining mobility mechanic and the
  reason its infrastructure is worth attacking.
- Participates in connectivity/eligibility and in combat/death effects.

### Industrial — sensor tower

Pairs with baseline, conventional mining.

- **Units move about 30% faster** within a long radius. The author was unsure
  whether the real figure was higher, so this ships as a labeled experimental
  value and is a tuning dial, not a fact.
- Participates in movement cost only. It does not block anything and has no
  death interaction.

## What this introduces that the engine does not have

Each of these is a genuine new concept, and the order below is roughly the
order they must be built:

1. **A zone primitive** — derived state recomputed from sources, with growth and
   decay, overlap rules per effect, and the six-way separation above.
2. **A movement-speed modifier** from zone membership. The smallest of the
   three, and the reason Industrial's sensor tower is the right first build.
3. **Shields** as a second health pool, with regeneration, separate from hit
   points. Network cannot exist without this.
4. **Death effects that read the zone under the dying unit** — spawning for
   creep, shield restoration for the power field. Both must resolve against a
   defined snapshot, and spawned units must never recursively spawn or earn
   refunds.
   Creep's half exists: spawns resolve against the start-of-tick field, at
   the dead unit's end-of-tick position, and spawned units cannot spawn.
5. **Teleport within a field**, with a channel, arrival state and failure rules.
   The largest single mechanic here.
6. **Worker creation at any structure in a field**, which changes where
   production may legally place a unit.

## Ordering

**Sensor tower first.** It needs only the zone primitive plus a speed modifier,
so it proves the zone model end to end with the least new machinery.

**Creep second.** It adds growth, decay and death-spawns — the first real
territory dynamics — and it is what makes the Organic economy legible.
Implemented in the simulation, persisted, and rendered on the client, all
validated 2026-09-24.

**Power field last**, because it needs shields first, and teleport after that.
Shields, the power field, field-gated drifter production, death restoration and
teleport are implemented, persisted and rendered on the client, validated
2026-09-24. Values and open questions are in [DECISIONS.md](DECISIONS.md).

## What would make this wrong

A zone that is cosmetic — drawn but not consulted by the simulation — or one
that quietly acquires a second effect because it was convenient. If creep ever
starts blocking sight or movement "because it looks like it should", the
separation has failed and the six concepts have collapsed again.
