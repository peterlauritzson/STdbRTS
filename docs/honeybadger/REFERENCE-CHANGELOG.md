# Reference Changelog (H0)

Transcribed 2026-09-29 from the author's published spreadsheet:
[Honey Badger changelog](https://docs.google.com/spreadsheets/d/e/2PACX-1vT1YxwepoM8Iu1c73e5X9ZnIseoCoub0Xv4O5CCwo1F8NylZsGLCbCHrvyPEY8tni340Y6BRR3dOzZ7/pubhtml).
The author supplied it as a better account of the mod than the website page
(H1) that [RESEARCH.md](RESEARCH.md) was first built on. It is the **primary
reference source**. How it compares with H1, and what it means for this
project, is in [RESEARCH.md](RESEARCH.md).

The sheet has six tabs. Three carry rules and are transcribed below: *Race
Specific Stuff*, *Tier Ability Upgrades* and *Units*. The other three
(*Matchup*, *UnitMatcher*, *Scratch*) are DPS/time-to-kill calculators with no
rules in them.

This is a transcription, not an interpretation. Wording is kept close to the
source; spelling is corrected. Values are the mod's, for SC2, and are not
approved balance for this game.

## Sheet notes

- All time-based numbers are in SC2 **Normal** game-speed seconds. Real time on
  Faster is the value divided by 1.4 (a 30s Stasis Ward lasts 30/1.4 = 21s), and
  a per-second rate is multiplied by 1.4 (powerfield shield regeneration of 0.5/s
  is 0.7/s real time).
- Ranges, attack speeds and movement speeds are the values **after every Tier
  Ability upgrade** is done.

## General rules

- Refineries, assimilators and extractors **mine gas automatically**.
- Gas buildings refund 50% on death.
- Army units refund 50% on death.
- All races build with a **hero builder**.
- All upgrades are researched on the hero builder, are **instant**, and apply to
  every unit (for example, +attack gives both the ground and the air attack
  upgrade).
- **Terrazine** comes from mining minerals and is used to build static defense.
- Minerals and gas are **infinite** (they replenish periodically).
- Mineral walls are replaced with destructible rocks.
- **No unit is cloaked**: not burrowed units, not Dark Templar, nothing.
- For the first X minutes you cannot build on your opponent's side of the map
  (no proxy rushes). X is not given.
- Build rules: a structure can be built within 40 range of another **finished**
  structure. Static defense can only be built in a powerfield, on creep, or near
  a sensor tower.
- Structures can capture Xel'Naga towers.

## Protoss

- Probes refund 50% on death.
- In a powerfield, shield, life and energy regenerate faster: +0.5, +0.5 and
  +0.25 per second respectively.
- **Ricochet**: overkill damage bounces to a nearby unit. Projectiles that miss
  because their target already died do not count as overkill and do not
  ricochet (Tempests often do this).
- A unit fighting and dying in a powerfield regenerates the shields of nearby
  units.
- Probes can mine without a base.
- Shields also regenerate in combat.
- Pylons have a very large sight range and see over cliffs and sight blockers.
- Cannons and shield batteries work without a powerfield.
- Shield batteries start with 0 energy.

## Zerg

- Burrowed units regenerate life faster.
- Burrowed units can move.
- Units dying on your creep (near your creep tumor, base, overseer, ...)
  generally produce extra time-limited units: broodlings, infested terrans or
  mosquitolisks.
- Bases refund 50% on death.
- Lair and Hive have a 50% faster larva production rate.

## Terran

- Gets 20% more Terrazine than the other races.
- Sensor towers give a large speed boost to friendly army units inside their
  area.
- Tech reactors can be built on the barracks, factory and starport. They allow
  researching as well as double production.
- Orbital Commands create **repair drones** on the map for 75 energy. A drone
  travels from the nearest orbital with enough energy to the destination, heals
  and repairs for a short time (about 300 life) and then expires. Each unit can
  be healed by only one drone at a time.
- The Command Center starts with 16 SCVs.

## Tier Ability Upgrades

Global tiers bought in order. The currency of the Cost column is not stated.

| Tier | Cost | Terran | Zerg | Protoss |
| --- | --- | --- | --- | --- |
| 1 | 500 | Combat Shields; Concussive Shells; Stimpack; Odin Strike Cannons; Boost enabled for Medivac, Hellion, Cyclone, Reaper, Scout | Overlord speed; Zergling, Roach and Hydralisk speed; Burrow; Tunneling Claws; Hydralisk range; Overlords become Droplords | Zealot Charge; Blink; Resonating Glaives; Observer speed |
| 2 | 750 | Scout and Banshee speed; Rapid Reignition System (Medivac energy regeneration x2); Liberator range; Reaper shield and damage buff on boost; Smart Servos | Infestor's Queen becomes Creeping; Ultralisk Burrow Charge; Lurker range +1; Infestor Pathogen Glands; Mutalisk speed | Zealot impact damage; Colossus Extended Thermal Lance; Phoenix range; Void Ray speed (2.25 to 2.95); Dark Templar Blink attack; Immortal "Last Stand"; Warp Prism speed (Gravitic Drive) |
| 3 | 1000 | Enhanced Shockwave (EMP); fast Siege/Unsiege; Medivac unload speed; Stim attack speed 30% to 50% faster; buildings (including towers) +2 armour | Adrenal Glands; Chitinous Plating; Anabolic Synthesis (Ultralisk speed); Lurker range +1; extra Zergling per egg; Enhanced Lair (+500 health, +2 larva cap, +30% larva production) | Tempest Tectonic Destabilizers; Carrier Graviton Catapult; Khaydarian Amulet (High Templar start +25 energy); powerfield life/energy regeneration bonus +0.3/+0.15 per second; Mothership Core Recall area 4 to 6; Recall pre-recall stun 5s to 3s |
| "4" | 7500 | Increased speed, +0.5 range | Increased speed, +0.5 range | Increased speed, +0.5 range |

## Units

"Cost" is the sheet's `Cost (G)` column. Its derived columns are "DPS per 100
gas" and "HP per 100 gas", so unit prices appear to be in **gas**; the sheet
does not say so outright. Speed is movement speed, Period is seconds between
attacks, Bonus is extra damage versus Light/Armoured, and Air/L/A mark flying,
Light and Armoured. Blank cells are blank in the source. Derived DPS columns
are omitted.

| Unit | Race | Cost | From | Life | Shield | Armour | Speed | Range | Damage | Period | Bonus L/A | Air | L | A | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Adept | P | 75 | Gateway | 70 | 70 | 1 | 2.7 | 5.5 | 12 | 1.55 | +8/+0 |  | y |  | Can shoot air |
| Archon (Air) | P | 175 | Gateway | 10 | 200 | 0 | 2.75 | 6 | 25 | 1.9 | +0/+15 |  |  |  | Archon reset to have the same attack vs ground and air |
| Archon (Grd) | P | 175 | Gateway | 10 | 200 | 0 | 2.75 | 4 | 12 | 0.5 |  |  |  |  | Archon reset to have the same attack vs ground and air |
| Carrier | P | 300 | Stargate | 150 | 100 | 1 | 2.5 | 8 | 5x16 | 3 |  | y |  | y | Not massive |
| Colossus | P | 250 | Robotics Facility | 200 | 150 | 1 | 2.25 | 9 | 8x3 | 0.75 | +2/+0 |  |  | y | Gains energy every attack; Each 10 energy, shoots AOE attack; Targets lowest life first automatically |
| Dark Templar | P | 100 | Gateway | 200 | 110 | 1 | 2.8125 | 5 | 20 | 1.7 |  |  |  |  | Rage Ability automatically triggered when all shields gone - Moving and attacking 2x faster but dying after 6 seconds; Blinks in to attack |
| Disruptor | P |  |  |  |  | 0 |  |  |  |  |  |  |  | y |  |
| High Templar | P | 165 | Gateway | 40 | 40 | 0 | 2.6 | 7 | 1 | 1.75 |  |  |  |  | Feedback does no damage; Has Time Warp (20% reduction); Has Phase Shift (AOE friendly units get invulnerable but can't attack, move slower) |
| Immortal | P | 200 | Robotics Facility | 200 | 100 | 1 | 2.25 | 6 | 20 | 1.45 | +0/+15 |  |  | y | Takes max 10 damage as long as it has energy; Last Stand ability - Attacks 50% faster when out of energy, +1 range, (no shields while active) |
| Interceptor | P | 10 | Carrier | 15 | 15 | 0 | 3 | 2 | 3x2 | 3 |  | y | y |  |  |
| Mothership Core | P | 150 | ? | 130 | 60 | 0 |  | 5 | 10 | 1.5 |  |  |  |  | Has Stasis Ward (uncloaked, 250hp, lasts 30s, stasised units duration 5s); Has Mass Recall to Nexus; Has Reaper Grenade (only affects enemy units) |
| Noogard | P | 100 | Robotics Facility | 75 | 50 | 1 | 2.95 | 7.5 | 22 | 1.5 |  |  |  | y | Can teleport between powerfields |
| Observer | P | 25 | Robotics Facility |  |  | 0 |  |  |  |  |  | y | y |  | Always visible |
| Oracle | P | 150 | Stargate | 100 | 60 | 0 | 4 | 6 | 15 | 0.86 |  | y |  | y | Weapon is always on; Each shot takes energy; Being attacked consumes energy; Has +2 armor as long as it has energy |
| Phoenix | P | 150 | Stargate | 120 | 60 | 0 | 4.25 | 5 | 5x2 | 0.6 |  | y | y |  |  |
| Photon Cannon | P | 100 |  | 100 | 100 | 1 |  | 8.5 | 16 | 1.25 |  |  |  | y | Static Defense |
| Probe | P | 50 | Hero Builder | 5 | 25 | 0 | 2.8125 |  |  |  |  |  | y |  | Has long range teleport |
| Sentry | P | 135 | Gateway | 40 | 40 | 0 | 3 | 7 | 6 | 1 |  |  |  |  | No Hallucination; Can give energy to friendly units; Has Force Field ability (FF can be attacked (400 hp), does not die by massive); Higher base energy regen (1.0 /s) |
| Stalker | P | 75 | Gateway | 80 | 80 | 1 | 2.95 | 6 | 13 | 1.87 | +0/+5 |  |  | y | Uses energy for blink (no cooldown) |
| Tempest | P | 200 | Stargate | 100 | 50 | 2 | 2.25 | 12 | 40 | 3.3 |  |  |  | y |  |
| Void Ray | P | 200 | Stargate | 150 | 100 | 0 | 3.35 | 6 | 8 | 0.5 | +0/+8 | y |  | y | Bonus damage vs armour charges over time: +4 damage on 1 charge +8 damage on 2 charges |
| Warp Prism | P | 100 | Robotics Facility | 80 | 100 | 0 | 2.95 |  |  |  |  | y |  | y | Larger powerfield radius; Bigger cargo space (12) |
| Zealot | P | 75 | Gateway | 100 | 50 | 1 | 3.375 | 0 | 8x2 | 1.2 |  |  | y |  | Can teleport between powerfields; Has sundering impact (small splash damage in a cone on charging impact) |
| Banshee | T | 150 | Starport | 140 |  | 0 |  | 6 | 9x2 | 1.25 | +0/+5 | y | y |  |  |
| Battlecruiser | T | NA |  |  |  | 0 |  |  |  |  |  | y |  | y |  |
| Cyclone | T | 100 | Factory | 120 |  | 1 | 3.375 | 8 | 13 | 1 | +0/+4 |  |  | y | No Lock On; Has Boost; Boost can not be done on Creep. |
| Ghost | T | 150 | Barracks | 100 |  | 0 | 2.8125 | 6 | 10 | 1.5 | +10/+0 |  |  |  | Emp (-75 energy, 100 energy damage, no shield dmg, concussive effect, anti-armour effect) |
| Ghost (S) | T | 150 | Barracks | 100 |  | 0 | 2.8125 | 10 | 25 | 1.5 |  |  |  |  |  |
| HERC | T | 35 | Barracks | 80 |  | 2 | 3.4 | 1.5 | 8 | 2.5 |  |  |  | y | Has Adrenaline; Has Stimpack |
| Hellbat | T | 50 | Factory | 135 |  | 0 | 2.4 | 3 | 12 | 2 |  |  | y |  |  |
| Hellion | T | 50 | Factory | 90 |  | 0 | 3.8 | 5 | 12 | 2.5 | +4/+0 |  | y |  | Has Boost; Boost can not be done on Creep. |
| Liberator | T | 120 | Starport | 180 |  | 0 | 3.375 | 6 | 5 | 0.225 |  | y |  | y |  |
| Liberator (S) | T | 120 | Starport | 180 |  | 0 | 3.375 | 13 | 12 | 0.6 |  | y |  | y | Locks onto target in circle; Ramping attack; Targets largest life first |
| Marauder | T | 60 | Barracks | 125 |  | 1 | 2.25 | 6 | 10 | 1.5 | +0/+10 |  |  | y | Has Adrenaline |
| Marine | T | 35 | Barracks | 45 |  | 0 | 2.25 | 5 | 6 | 0.86 |  |  | y |  | Has Adrenaline |
| Medivac | T | 100 | Starport | 150 |  | 1 | 2.5 |  |  |  |  | y |  | y |  |
| Odin (Air) | T | 600 | Hero Builder | 1500 |  | 1 | 2.25 | 5 | 15x4 | 2.1 | +10/+0 |  |  | y | Has Self-Repair ability; Has Cannons ability; Anti-Air attack - Each missile splashes on 2 targets (4x2=8 targets in total); Can be attacked by Anti-Air |
| Odin (Grd) | T | 600 | Hero Builder | 1500 |  | 1 | 2.25 | 5 | 50x2 | 2.1 |  |  |  | y | Has Self-Repair ability; Has Cannons ability; Can be attacked by Anti-Air |
| Raven | T |  | Starport |  |  | 0 | ??? |  |  |  |  |  | y |  | Can fire seeker missiles for 75 energy, has max 100 energy, flies very fast |
| Reaper | T | 80 | Barracks | 60 |  | 0 | 3 | 5 | 4x2 | 1.1 |  |  | y |  | Can Boost (gains damage and shields while boosted); Boost can not be done on Creep.; Regenerates life in combat also |
| Reaper (Boost) | T | 80 | Barracks | 60 | 60 | 0 | 3 | 3 | 8x2 | 1.1 |  |  | y |  | Attacks while moving; Can Boost (gains damage and shields while boosted); Regenerates life in combat also |
| SCV | T | 15 | Command Centre | 25 |  | 0 | 2.8125 |  |  |  |  |  | y |  |  |
| Scout | T | 150 | Starport | 100 |  | 1 | 3.5 | 7 | 4 | 0.25 | +2/+0 | y | y |  | Can Boost |
| Siege Tank (S) | T | 175 | Factory | 175 |  | 1 | 0 | 13 | 40 | 3 | +0/+30 |  |  | y | Targets furthest away automatically |
| Siege Tank (US) | T | 175 | Factory | 175 |  | 1 | 2.25 | 7 | 15 | 1.04 | +0/+10 |  |  | y |  |
| Thor (Air) | T | 300 | Factory | 400 |  | 1 | 1.875 | 11 | 25 | 1.28 |  |  |  | y |  |
| Thor (Grd) | T | 300 | Factory | 400 |  | 1 | 1.875 | 7 | 30x2 | 1.28 |  |  |  | y |  |
| Viking (Air-Air) | T | 130 | Starport | 175 |  | 0 | 2.75 | 10 | 10x2 | 2 | +0/+4 | y |  | y |  |
| Viking (Grd-Grd) | T | 130 | Starport | 175 |  | 0 | 2.75 | 6 | 12 | 1 |  |  |  | y | +8 extra dmg vs Mechanical |
| Warhound | T | 100 |  | 220 |  | 1 |  | 7 | 13 | 0.9 | +0/+3 |  |  | y | Static Defense |
| Widow Mine | T |  |  |  |  | 0 |  |  |  |  |  |  | y |  |  |
| Baneling | Z | 40 |  |  |  |  |  |  |  |  |  |  |  |  | Vanilla Stats, but only 40 dmg vs buildings |
| Broodling | Z | 22 | Unit Death on Creep | 30 |  | 0 | 4.4 | 0 | 4 | 0.6455 |  |  | y |  | Overkill damage bounces to a nearby Broodling |
| Broodlord | Z | 300 | Larva / Eggs | 225 |  | 1 | 2.7 | 6 | 20 | 2.5 |  | y |  | y | Spawns 3 Mosquitolisks on death on creep |
| Corruptor | Z | 130 | Larva / Eggs | 200 |  | 2 | 3.375 | 6 | 14 | 1.9 |  | y |  | y | Spawns 3 mosquitolisks on death on creep; Slows target movement by 50% for 2.25 seconds |
| Harvester | Z | 0 |  | 9 |  | 0 | 2.8125 |  |  |  |  |  |  |  |  |
| Hydralisk | Z | 80 | Larva / Eggs | 90 |  | 0 | 2.8125 | 6 | 12 | 0.9 |  |  | y |  | Spawns an infested terran on death on creep |
| Infested T (Air) | Z | 40 | Larva / Eggs | 75 |  | 0 | 0.9375 | 6 | 10 | 1.33 |  |  | y |  | Only spawns when unit dies on creep |
| Infested T (Grd) | Z | 40 | Larva / Eggs | 75 |  | 0 | 0.9375 | 5 | 8 | 0.86 |  |  | y |  | Only spawns when unit dies on creep |
| Infestor | Z | 165 | Larva / Eggs | 90 |  | 0 | 2.25 | 7 | 1 | 1.75 |  |  |  | y | Transfuse; Spawn Queen (gives creep after tier2); Fungal (no damage) |
| Locust | Z | 30 | Larva / Eggs | 30.0 |  | 0 | 1.875 | 3 | 5 | 1 |  |  | y |  | Starts flying, lands when attacks; Built from larva |
| Lurker | Z | 150 | Larva / Eggs | 120 |  | 1 | 2.95 | 5 | 30 | 2 |  |  |  | y | Spawns 4 broodlings on death on creep; Shoots ravager biles; Biles do not do friendly fire |
| Mosquitolisk | Z | 30 | Larva / Eggs | 30.0 |  | 0 | 3.2 | 4 | 2.3x3 | 1 |  | y | y |  | Only spawned by units dying on creep; Does 3+2+2 damage with bounces; Low target priority (not attacked first) |
| Mutalisk | Z | 120 | Larva / Eggs | 120 |  | 0 | 4 | 3 | 4x3 | 1.525 |  | y | y |  | Spawns 3 mosquitolisks on death always; Does 9+3+1 damage with bounces |
| Overlord | Z |  | Larva / Eggs |  |  |  | 1.5 |  |  |  |  |  |  |  | Automatically becomes Droplord at Hive |
| Overseer | Z |  | Eggs (requires Hive) |  |  | 0 |  |  |  |  |  | y |  | y | Spreads creep under it |
| Queen | Z | 50 | Larva / Eggs | 200 |  | 1 | 3.4 | 2.5 | 4x2 | 1 |  |  |  |  | Can only be summoned from Infestor; Is uncontrollable |
| Ravager | Z | 70 | Larva / Eggs | 120 |  | 1 | 2.75 | 7.5 | 9 | 1.2 | +7/+0 |  |  |  | Cannot Bile; Spawns an infested terran on death on creep |
| Roach | Z | 60 | Larva / Eggs | 145 |  | 1 | 3 | 4 | 16 | 2 |  |  |  | y | Spawns 2 broodlings on death on creep |
| Spine Crawler | Z | 100 |  | 300 |  | 2 |  | 7 | 25 | 1.85 | +0/+5 |  |  | y | Static Defense |
| Swarmhost | Z |  | Larva / Eggs |  |  | 0 |  |  |  |  |  |  |  | y |  |
| Ultralisk | Z | 250 | Larva / Eggs | 500 |  | 0 | 2.95 | 1 | 35 | 0.86 |  |  |  | y | Spawns 6 broodlings on death on creep; Has Burrow Charge; Walks over units; Smaller Splash on Attack |
| Viper | Z | 200 | Larva / Eggs | 150 |  | 1 | 2.95 | 7 | 1 | 1.75 |  | y |  | y | Consume; Microbial Shroud; Energy Plague (removes energy over time); Blinding Cloud |
| Zergling | Z | 17 | Larva / Eggs | 35 |  | 0 | 4.7 | 0 | 5 | 0.696 |  |  | y |  | Spawns a broodling on death (also not on creep) |

Units absent from, or unusual for, SC2 multiplayer: **Noogard** (Protoss
robotics unit), **Warhound** (listed as Terran static defense), **HERC**
(barracks infantry), **Scout** (Terran starport), **Odin** (hero-builder unit),
**Mosquitolisk**, **Locust** built from larva, and the **Harvester** (free Zerg
labour, 9 life). The Disruptor, Battlecruiser, Widow Mine, Raven, Swarm Host and
Overseer rows are mostly empty.
