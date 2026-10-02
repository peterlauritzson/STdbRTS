# Roster expansion and passive abilities (proposal, 2026-10-02)

Asked for by the user on 2026-10-02: more units and buildings, and every unit
gets an ability that is **passive**: it fires on its own, with a cooldown where
one makes sense. Nothing goes on the command card and nothing needs a hotkey.
Several abilities come from the Tardigrade modifier list (Battle Blink, Forced
March, Predator Protocol, Overwatch, Entrenchment, Veteran Forces, Shared
Damage), here applied to one unit kind instead of a whole side.

Every number is **experimental**. The scale conversion used: SC2 range 1 is
about 21 units here (marine 5, soldier 105); SC2 speed 3.15 is about 110.

## Rules every passive follows

- It is decided inside `step_on` from start-of-tick state, in unit-id order, so
  replays stay deterministic.
- Its state lives on the entity (cooldown ticks, stacks, anchors), never in a
  side table, so a reconnecting client sees the same thing as the server.
- A passive never targets or affects buildings unless it says so.
- Temporary units (brood, brute) have no passive.
- Each kind has exactly one passive, so a player can read a unit from its name.
  Duplicates across factions are allowed (both raiders get Forced March).

## The roster

Existing units keep their stats and gain a passive. **New** rows are new
kinds. Army prices are catalyst-only (settled 2026-09-29); static defense is
Terrazine.

### Industrial: conventional, disciplined

| Unit | Built at | Role | Passive |
| --- | --- | --- | --- |
| soldier | barracks | basic fighter | **Veteran**: each kill gives +3% attack rate and move speed, up to 15 stacks. |
| scout | barracks | raider | **Forced March**: +40% speed after 10s without dealing or taking damage. |
| siege | factory | anti-structure | **Shrapnel**: each shell deals 50% to other enemies within 45 of the target. |
| **marksman** (new) | barracks | long-range rifle, 125 | **Entrenchment**: after 7.5s holding within 30 of one spot, +2 armour and +25 range; lingers 2s after moving. |
| **medic** (new) | barracks | support, no weapon, 100 | **Field Medic**: every 0.5s heals the most-damaged friendly non-building within 90 by 3 hit points. |
| **bulwark** (new) | factory | heavy tank, 225 | **Guardian**: 30% of damage dealt to friendly units within 90 is redirected to the bulwark instead. |
| **bunker** (new building) | — | static defense, Terrazine 125 | **Fortified**: always +2 armour; short range (150), high hit points. |

### Network: strong individual units, shields

| Unit | Built at | Role | Passive |
| --- | --- | --- | --- |
| sentinel | barracks | basic fighter | **Battle Blink**: at 30% of hit points plus shields, teleports 160 straight away from whatever last hit it. 12s cooldown. Only a hostile hit triggers it. |
| skimmer | barracks | raider | **Forced March** (as scout). |
| lancer | factory | anti-structure | **Overwatch**: after 10s without attacking, +50% damage for its next 1s of attacks. |
| **arcer** (new) | barracks | chain caster, 140 | **Ricochet**: each hit jumps to up to 2 more enemies within 70, at 50% then 25%. |
| **phantom** (new) | barracks | assassin, 160 | **Phase Shift**: the first hit it takes every 8s is fully absorbed. |
| **warden** (new) | factory | support walker, 250 | **Shield Aura**: friendly shields within 110 regenerate 2 per second even while taking damage. |
| **bastion** (new building) | — | static defense, Terrazine 125 | **Ricochet** (as arcer, one bounce). |

### Organic: large counts, regrowth

| Unit | Built at | Role | Passive |
| --- | --- | --- | --- |
| swarmer | barracks | basic fighter | **Predator**: heals 30% of the damage it deals. |
| spitter | barracks | ranged support | **Acid Splash**: 50% to other enemies within 35 of the target. |
| crusher | factory | anti-structure | **Regrowth**: after 5s without taking damage, regenerates 2% of maximum hit points per second. |
| **prowler** (new) | barracks | raider, 80 | **Forced March** (as scout). |
| **devourer** (new) | barracks | bruiser, 120 | **Veteran** (as soldier). |
| **behemoth** (new) | factory | siege beast, 275 | **Death Burst**: when it dies, deals 80 to every enemy within 70. |
| **spine** (new building) | — | static defense, Terrazine 125 | **Predator** (as swarmer): heals itself 30% of damage dealt. |

## Entity state the passives need

New persisted fields on `Entity` (one schema change, batched with the engine
increment so it costs one new database, not two):

- `passive_ready_tick: u64`: Battle Blink and Phase Shift cooldowns.
- `last_attacker: u32`: who to blink away from.
- `contact_tick: u64`: last tick it dealt or took damage (Forced March).
  `damaged_tick` and `shot_tick` already exist; this is their max, kept
  separately so neither of those changes meaning.
- `kills: u16`: Veteran stacks.
- `anchor_x`, `anchor_y`, `anchor_tick`: Entrenchment.

The auras (Guardian, Field Medic, Shield Aura) and the splashes need "everything
within R of here" queries. The spatial index from the engine increment provides
them; without it they would multiply the tick's O(n²) cost.

## Ordering

The passives land after the engine-scaling increment, which provides the spatial
index, and after the economy increment, which sets catalyst-only army prices.
Static defenses need Terrazine, so they come after the economy increment too.
