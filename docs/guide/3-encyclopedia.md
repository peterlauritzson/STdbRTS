[Overview](1-overview.md) · [How it plays](2-how-it-plays.md) · [Encyclopedia](3-encyclopedia.md)

# Encyclopedia

Every unit, structure, ability and number. Times are in seconds (the game runs 20 ticks a second). Speed and range are in map units per second and map units; the whole map is 9600 units across. Costs are in the currency named in the column: material, catalyst or terrazine.

Jump to: [Units](#units) · [Structures](#structures) · [Passives](#passives-in-detail) · [Zones](#zones) · [Abilities](#faction-abilities) · [Research](#research) · [Economy](#economy-constants) · [Limits and rules](#limits-and-rules) · [Hotkeys](#hotkeys)

## Units

Army units cost catalyst only. Labour costs material (or stock). Temporary units are free and cannot be trained.

### Labour

| Unit | Faction | HP | Speed | Cost | Build (s) | Cargo | How it mines |
| --- | --- | ---: | ---: | --- | ---: | --- | --- |
| **Worker** | Industrial | 60 | 100 | 50 material | 3 | 25 (40 with logistics) | Mines 5 every 0.5 s (7 with logistics), walks the load to a hub, walks back. Can repair. |
| **Drifter** | Network | 20 + 20 shields | 100 | 40 material | 2.5 | none | Credits 1 material every 0.25 s (3 every 0.5 s with logistics) while standing at the patch. Can repair. Can be trained at any finished structure inside your power field. |
| **Harvester** | Organic | 45 | 100 | 1 hub stock | 2 | 10 (16 with logistics) | Mines like a worker with a smaller load. Cannot fight. 60% speed when off your creep. Can repair. |

All three are unarmed and have no passive.

### Industrial army

| Unit | Role | Built at | HP | Speed | Range | Damage | Cooldown (s) | Cost (catalyst) | Build (s) | Passive |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **Soldier** | Basic fighter | Barracks | 140 | 110 | 105 | 18 | 0.6 | 100 | 5 | **Veteran**: each kill gives +3% attack rate and speed, up to 15 kills (+45%) |
| **Scout** | Raider | Barracks | 80 | 180 | 85 | 10 | 0.5 | 80 | 3.5 | **Forced March**: +40% speed after 10 s without dealing or taking damage |
| **Marksman** | Long-range rifle | Barracks | 100 | 100 | 170 | 24 | 0.9 | 125 | 5.5 | **Entrenchment**: holding one spot for 7.5 s gives +2 armour and +25 range |
| **Medic** | Support, no weapon | Barracks | 90 | 110 | - | - | - | 100 | 4.5 | **Field Medic**: heals the most-damaged friendly unit within 90 by 3 every 0.5 s |
| **Siege** | Anti-structure artillery | Factory | 220 | 65 | 260 | 32 | 2.5 | 200 | 8 | **Shrapnel**: each shell deals 50% to other enemies within 45 of the target |
| **Bulwark** | Tank | Factory | 420 | 80 | 90 | 14 | 0.7 | 225 | 8.5 | **Guardian**: takes 30% of damage dealt to friendly units within 90 |

Damage notes: the soldier does double damage to scouts and skimmers. Siege does triple damage to buildings but only half damage to scouts. Damage figures in the tables are before armour and research.

### Network army

Every Network unit splits its health into hit points and shields (see [shields](#shields)). The sentinel, lancer and warden are one third shields; everything else is half.

| Unit | Role | Built at | HP + shields | Speed | Range | Damage | Cooldown (s) | Cost (catalyst) | Build (s) | Passive |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **Sentinel** | Basic fighter | Barracks | 148 + 72 | 100 | 115 | 26 | 0.65 | 150 | 6.5 | **Battle Blink**: at 30% health teleports 160 away from its attacker (12 s cooldown) |
| **Skimmer** | Raider | Barracks | 35 + 35 | 200 | 75 | 8 | 0.4 | 90 | 3.5 | **Forced March**: +40% speed after 10 s without dealing or taking damage |
| **Arcer** | Chain caster | Barracks | 45 + 45 | 100 | 130 | 20 | 0.8 | 140 | 5.5 | **Ricochet**: hits jump to 2 more enemies within 70, at 50% then 25% |
| **Phantom** | Assassin | Barracks | 50 + 50 | 150 | 40 | 30 | 0.7 | 160 | 6 | **Phase Shift**: the first hit it takes every 8 s is fully absorbed |
| **Lancer** | Anti-structure artillery | Factory | 161 + 79 | 75 | 250 | 36 | 2 | 250 | 9 | **Overwatch**: +50% damage for 1 s after 10 s without attacking |
| **Warden** | Support walker | Factory | 201 + 99 | 85 | 100 | 10 | 0.8 | 250 | 9 | **Shield Aura**: friendly shields within 110 regenerate 2/s even under fire |

Damage notes: the skimmer does triple damage to labour units. The lancer does triple damage to buildings.

### Organic army

| Unit | Role | Built at | HP | Speed | Range | Damage | Cooldown (s) | Cost (catalyst) | Build (s) | Passive |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **Swarmer** | Basic fighter (melee) | Barracks | 60 | 135 | 20 | 7 | 0.4 | 50 | 2.25 | **Predator**: heals 30% of the damage it deals |
| **Spitter** | Ranged support | Barracks | 85 | 105 | 150 | 15 | 0.8 | 90 | 4 | **Acid Splash**: hits deal 50% to other enemies within 35 of the target |
| **Prowler** | Raider (melee) | Barracks | 70 | 170 | 20 | 9 | 0.45 | 80 | 3 | **Forced March**: +40% speed after 10 s without dealing or taking damage |
| **Devourer** | Bruiser (melee) | Barracks | 130 | 120 | 24 | 14 | 0.6 | 120 | 4.25 | **Veteran**: each kill gives +3% attack rate and speed, up to 15 kills (+45%) |
| **Crusher** | Anti-structure (melee) | Factory | 420 | 85 | 28 | 30 | 0.9 | 250 | 9 | **Regrowth**: after 5 s unhurt, regenerates 2% of its health every second |
| **Behemoth** | Siege beast (melee) | Factory | 450 | 80 | 60 | 28 | 1.2 | 275 | 9.5 | **Death Burst**: on death, 80 damage to every enemy unit within 70 |

Damage notes: the crusher does triple damage to buildings. The behemoth does not.

### Temporary units

Spawned free, one at a time, when one of your units dies on your own creep. They take no supply, give no refund, and never spawn anything themselves.

| Unit | Spawned when | HP | Speed | Range | Damage | Cooldown (s) | Lives (s) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **Brood** | a unit costing 50 to 199 dies | 30 | 120 | 20 | 6 | 0.5 | 10 |
| **Brute** | a unit costing 200 or more dies | 70 | 90 | 30 | 14 | 0.6 | 15 |

## Structures

Every structure is built by placing it on the map; it then raises itself and needs no worker. A site starts at 10% of its hit points and gains them as it builds. Network structures and the HQ split hit points half and half into shields (for example a Network barracks is 350 + 350).

| Structure | Who can build it | Hit points | Cost | Build (s) | Needs | What it does |
| --- | --- | ---: | ---: | ---: | --- | --- |
| **Headquarters** | Everyone | 1200 | - | - | - | Your starting hub. Trains labour, receives mined material, and creates your territory (creep for Organic, power field for Network). Lose every finished hub and you lose the match. |
| **Barracks** | Everyone | 700 | 150 material | 8 | - | Trains each faction's fighters and raiders. Required before a factory or laboratory. |
| **Factory** | Everyone | 900 | 250 material | 12 | barracks | Trains the heavy units: siege, bulwark, lancer, warden, crusher, behemoth. |
| **Laboratory** | Everyone | 650 | 200 material | 10 | barracks | Researches weapons, armor and logistics. One finished laboratory is enough. |
| **Outpost** | Everyone | 650 | 100 material | 6 | - | A second hub. Receives mined material and trains labour. For Organic it also spreads creep and stores harvester stock; for Network it projects a power field. |
| **Refinery** | Everyone | 400 | 75 material | 6 | catalyst deposit | Must be built on a catalyst deposit (it snaps to one within 60 units; one per deposit). Extracts 4 catalyst every half second with no workers. |
| **Turret** | Everyone | 500 | 100 terrazine | 7 | - | Static defense. Range 210, damage 16, cooldown 0.9 s. |
| **Sensor tower** | Industrial | 450 | 175 material | 7 | - | Projects a sensor field (radius 450) that speeds up your units by 30%. Cannot shoot or train. |
| **Bunker** | Industrial | 800 | 125 terrazine | 8 | - | Static defense. Range 150, damage 20, cooldown 0.9 s. Passive: Fortified. |
| **Relay** | Network | 300 | 75 material | 5 | - | Projects a power field (radius 320). Cannot shoot. |
| **Bastion** | Network | 500 | 125 terrazine | 7.5 | - | Static defense. Range 190, damage 14, cooldown 0.7 s. Passive: Ricochet (one bounce). |
| **Spine** | Organic | 600 | 125 terrazine | 7.5 | - | Static defense. Range 170, damage 12, cooldown 0.6 s. Passive: Predator. |

Static defense (turret, bunker, bastion, spine) fires automatically at the nearest enemy in range and in line of sight.

## Passives in detail

Every army unit and the bunker, bastion and spine has exactly one. They fire automatically and need no order. Buildings are never affected by a passive unless it says so.

| Passive | Who | Exact effect |
| --- | --- | --- |
| **Veteran** | Soldier, Devourer | Each kill adds one stack: +3% attack rate and +3% move speed. Maximum 15 stacks (+45%). The kill goes to the unit that dealt the most damage to the victim. Only mobile, non-temporary victims count. At 15 stacks a 12-tick cooldown becomes 8. |
| **Forced March** | Scout, Skimmer, Prowler | After 10 s without dealing or taking damage, move at 140% speed. Ends as soon as you fight. |
| **Shrapnel** | Siege | Each shell also hits every other enemy within 45 of the target for 50% of the damage. |
| **Acid Splash** | Spitter | Each hit also hits every other enemy within 35 of the target for 50% of the damage. |
| **Entrenchment** | Marksman | After holding within 30 units of one spot for 7.5 s: +2 armour and +25 range. The bonus lingers 2 s after the unit moves away. |
| **Field Medic** | Medic | Every 0.5 s, heals the most-damaged friendly non-building unit within 90 by 3 hit points. |
| **Guardian** | Bulwark | A friendly unit within 90 of a finished bulwark passes 30% of each hit it takes to that bulwark (rounded down; the two shares add up to the original hit). The nearest bulwark takes it. The bulwark's own damage is never redirected. |
| **Battle Blink** | Sentinel | When hit points plus shields drop to 30% of maximum, it teleports 160 units directly away from whatever hit it last. 12 s cooldown. Only a hostile hit triggers it. |
| **Overwatch** | Lancer | After 10 s without attacking, the next attack opens a 1 s window in which all its attacks deal 150% damage. |
| **Ricochet** | Arcer, Bastion | After hitting, jumps to the nearest other enemy unit within 70 of the last target that has not been struck yet. The arcer jumps twice (50% then 25% of the hit); the bastion once (50%). |
| **Phase Shift** | Phantom | The first hit it takes is absorbed completely. It recharges 8 s later. |
| **Shield Aura** | Warden | Friendly units within 110 that have shields regain 1 shield every 0.5 s (2 per second), even while being shot. Several wardens do not stack. |
| **Predator** | Swarmer, Spine | Heals itself for 30% of the damage it deals: hit points first, any overflow into shields if it has them. |
| **Regrowth** | Crusher | After 5 s without taking damage, regenerates 2% of maximum hit points every second. |
| **Death Burst** | Behemoth | When it dies, deals 80 damage to every enemy non-building unit within 70, before armour. |
| **Fortified** | Bunker | Always +2 armour. |

When several effects meet in one hit, the order is: Phase Shift, then Guardian, then armour.

## Zones

Zones belong to their owner only: an enemy standing in your zone gets nothing from it. They are recomputed every tick, so destroying the source removes the zone immediately (creep recedes first).

| Zone | Faction | Source | Radius | Effects |
| --- | --- | --- | --- | --- |
| **Sensor field** | Industrial | Finished sensor tower | 450 | +30% movement speed for your units. Overlapping fields do not add up; the strongest applies. |
| **Power field** | Network | Finished relay, HQ or outpost | 320 | Shield regeneration at 300% (6 shields per second instead of 2). When a unit of yours dies in it, each friendly unit within 180 of the death point regains 20% of the dead unit's total health. Drifters can be trained at any finished structure in it. Units can teleport inside it. |
| **Creep** | Organic | Finished HQ or outpost | 360 (HQ), 300 (outpost) | Starts at radius 60 and grows 10 per second to its full size. When its source dies it holds for 5 s, then recedes 20 per second. Harvesters move at full speed on it, and only 60% speed off it. When one of your own units dies on it, a brood or brute spawns (see [temporary units](#temporary-units)). |

Only hubs make creep. A Bloom also makes creep for its duration.

### Shields

Network units and structures carry a second pool of health. Shields take damage together with hit points as one total. When a Network unit goes 10 seconds (200 ticks) without being damaged, its shields regenerate 1 point every 0.5 s (2 per second), or 3x that inside a power field. Hit points never regenerate by themselves. The share that is shields: 33% for the sentinel, lancer and warden; 50% for everything else (drifter, skimmer, arcer, phantom and every Network structure).

## Faction abilities

Network and Organic hubs (HQ and outposts) carry energy: up to 200, starting at 50, regenerating 1 point every 1.25 seconds (0.8 per second). Industrial hubs carry none.

| Ability | Faction | Key | Energy | Cooldown (s) | Effect |
| --- | --- | --- | ---: | ---: | --- |
| **Recall** | Network | C (select a hub) | 50 | 60 | After a 3 s channel, every mobile unit of yours within 200 of the target point is pulled back to the casting hub. |
| **Bloom** | Organic | C (select a hub) | 25 | 10 | Grows a temporary creep patch of radius 200 anywhere on your own creep. Lasts 60 s, then recedes like a lost hub's creep. |
| **Teleport** | Network | T (select units) | none | 30 per unit | A unit inside your power field channels for 1 s (damage cancels it), moves to another point in the field, and is inactive for 2 s after arriving (it cannot move, shoot or gather, but can be shot). |

## Research

Bought at a finished laboratory. Each costs 150 material and takes 15 s. Each can be researched once; it applies to all your existing and future units and survives the loss of the laboratory.

| Technology | Effect |
| --- | --- |
| **Weapons** | +4 attack damage on every attack, before multipliers. |
| **Armor** | Every hit against your units and structures does 3 less damage (a hit never does less than 1). |
| **Logistics** | Carry capacity 25 to 40 (harvesters 10 to 16); mining 5 to 7 per pulse (drifters 1 every 0.25 s to 3 every 0.5 s). |

## Economy constants

| Item | Value |
| --- | --- |
| Starting resources | 250 material, 100 catalyst, no terrazine |
| Starting units | 1 HQ, 2 labour units of your faction, 1 basic fighter |
| Free income | 200 material a minute for the first 90 s, then 100 material a minute for the rest of the match |
| Mining pulse | Every 0.5 s a carrier takes 5 (7 with logistics); a worker's 25 load takes 2.5 s |
| Drifter credit | 1 material every 0.25 s (3 every 0.5 s with logistics) |
| Patch holds | Material 1200 or 1500; catalyst 2000 or 2500 |
| Miners per patch | One. A labour unit that finds its patch taken looks for a free one within 450 of itself, else waits |
| Refinery | 4 catalyst every 0.5 s (8 per second); snaps to a catalyst deposit within 60 |
| Terrazine by-product | 12% of material mined (Industrial), 10% (Network, Organic); catalyst mined adds none |
| Hub stock (Organic) | +1 per hub every 3 s, up to 7 per hub. A harvester costs 1 |
| Army death refund | 50% of the price paid (catalyst). Labour and buildings return nothing |
| Repair | Labour units only. 1 material per 0.5 s restores up to 5 hit points |
| Command delay | 1 s by default; a room sets 0.5 to 1.5 s. Orders may run up to 0.3 s earlier than the delay when your ping is low |

## Limits and rules

- Up to 400 mobile units per player (labour and army; temporary units do not count) and 150 buildings per player (construction sites count).
- Each building queues up to 8 items; production is one item at a time.
- Build within 500 units of one of your own finished buildings. A site must be 110 clear of other buildings, 55 clear of units, 75 clear of deposits (except a refinery), off terrain, and 60 from the map edge.
- A factory and a laboratory each need a finished barracks first.
- Only Industrial can build sensor towers and bunkers; only Network relays and bastions; only Organic spines. Each faction trains only its own labour and army.
- Every faction chooses in the lobby; with no choice, slots are dealt Industrial, Network, Organic in order.
- You are out when your last finished hub falls. If the last hubs of two players fall on the same tick, it is a draw.
- The map is 9600 by 9600 with four start positions. 240 deposits, grouped into about 24 base sites.

## Hotkeys

| Key | Action |
| --- | --- |
| Left click / drag | Select / box select; Shift adds |
| Double-click or Ctrl+click | Select all of that kind on screen |
| Right click | Move, attack, mine, return cargo, set rally (Shift queues) |
| A, then click | Attack-move |
| S / H | Stop / hold position |
| F / G | Repair (then click a target) / return cargo |
| Y | Set a rally point (with a production building selected) |
| T / C | Teleport / faction ability (Recall, Bloom) |
| Q W E R D Z X | Train: labour, then your six army units in card order |
| B, then Q W E R T Y U I | Build menu: barracks, outpost, turret, factory, laboratory, then your faction structure, refinery, faction defense |
| Ctrl or Alt + 0-9 | Set control group |
| Shift + 0-9 | Add to control group |
| 0-9 (twice) | Select group (second press centres the camera) |
| F1 or . | Select idle labour |
| F2 | Select whole army |
| Backspace | Centre on your base |
| Esc | Cancel targeting, then clear selection |
| ? | Show or hide the in-game control list |
| Wheel, middle-drag, Space+drag, arrow keys, screen edge | Zoom and camera |
