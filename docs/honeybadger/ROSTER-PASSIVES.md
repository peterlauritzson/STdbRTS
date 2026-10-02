# Roster expansion and passive abilities (built 2026-10-02, experimental, not committed)

**Status: implemented as step 29** (`RULESET_VERSION` 16, database `stdbrts-roster`). Server in
`rules.rs` (`passive`, one constant section per passive), `simulation.rs` (`Hits`, the unit loop and
the damage step), client in `catalog.ts` (`PASSIVES`, `PASSIVE_OF`, `ROSTER`) and `passives.ts`
(feedback). Stats below were chosen by the implementer; where the build differs from the table
in this document it says so under "As built".

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

## As built

Stats (hp / speed / range / damage / cooldown ticks / price / train ticks):

| Kind | Stats | Notes |
| --- | --- | --- |
| marksman | 100 / 100 / 170 / 24 / 18 / 125 / 110 | range 195 while entrenched |
| medic | 90 / 110 / 0 / 0 / 0 / 100 / 90 | unarmed; attack-move is a plain move for it |
| bulwark | 420 / 80 / 90 / 14 / 14 / 225 / 170 | factory |
| arcer | 90 / 100 / 130 / 20 / 16 / 140 / 110 | shields 50% |
| phantom | 100 / 150 / 40 / 30 / 14 / 160 / 120 | shields 50% |
| warden | 300 / 85 / 100 / 10 / 16 / 250 / 180 | factory, shields 33% |
| prowler | 70 / 170 / 20 / 9 / 9 / 80 / 60 | |
| devourer | 130 / 120 / 24 / 14 / 12 / 120 / 85 | |
| behemoth | 450 / 80 / 60 / 28 / 24 / 275 / 190 | factory, no anti-structure bonus |
| bunker | 800 hp / range 150 / 20 dmg / 18 cd / 125 terrazine / 160 build | Industrial |
| bastion | 500 hp / range 190 / 14 dmg / 14 cd / 125 terrazine / 150 build | Network, one bounce |
| spine | 600 hp / range 170 / 12 dmg / 12 cd / 125 terrazine / 150 build | Organic |

Death spawns key on total cost and stay sane: prowler, medic, marksman, arcer, phantom, devourer
leave a brood; bulwark, warden, behemoth leave a brute.

Choices where the spec left room (each one the simplest faithful reading):

- **Buildings are never affected** by an aura, a splash, a bounce or a burst; a unit-only rule, so
  Shield Aura reaches friendly *units* with shields.
- **One damage path.** Every shot, splash, bounce and burst goes through `Hits::deal`, which applies
  Phase Shift, then Guardian, and records the damage by slot (`killed`) and by unit (Veteran).
  Phase Shift absorbs the first hit of *any* kind in a tick and the absorbed hit changes nothing
  else (no shield delay, no contact, no attacker memory).
- **Guardian:** the nearest completed bulwark (ties on id) within 90 of the guarded unit takes
  30% of each hit, rounded down per hit, so the shares sum to the hit. A bulwark's own damage and
  buildings are never redirected.
- **Veteran** kills credit the unit that dealt the most damage to the victim on the killing tick
  (ties on the lower id). Only mobile non-temporary victims count. Attack rate is the cooldown divided
  by the speed percent, rounded to the nearest tick (12 ticks at 15 stacks is 8).
- **Splash / Ricochet** use each secondary's own armour and kind multiplier; a ricochet bounce goes to
  the nearest enemy unit within 70 of the previous target not yet struck, without a sight test.
- **Overwatch:** the window (1s) is shorter than the lancer's cooldown (2s), so in practice it
  boosts the first shot after the rest.
- **Battle Blink** is evaluated in the damage step after a hostile hit, away from the last attacker
  (the highest unit id that hit it that tick), and lands on `free` ground or the nearest `escape`
  spot; if neither exists it does not blink and the cooldown is not spent.
- **Death Burst** is resolved before damage is applied (a behemoth dies when its damage reaches its
  hit points plus shields), repeating until no further behemoth falls, so bursts chain within a tick.
  It is reduced by armour like any hit and positions are start-of-tick, like every passive query.
- **Field Medic** never heals itself and picks the most hit points missing, ties on the lower id.
- **Entrenchment** uses `passive_ready_tick` as "bonus until"; moving off the anchor resets the hold.
- **Predator** heals 30% of the landed (post-armour) damage, rounded down; the spine heals itself.
- **Regrowth** pays on whole seconds (ticks divisible by 20), 2% of maximum hit points.

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
