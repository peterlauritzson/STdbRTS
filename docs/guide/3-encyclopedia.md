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

Tier gates: the marksman and medic need tier 1, the bulwark tier 2; the soldier, scout and siege need none. Tier upgrades: Combat Shields (tier 1) gives the soldier +20 hit points, Dig In (tier 2) cuts the marksman's Entrenchment hold to 4 s, Reinforced Plating (tier 3) gives every building +2 armour.

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

Tier gates: the arcer and phantom need tier 1, the warden tier 2; the sentinel, skimmer and lancer need none. Tier upgrades: Quick Blink (tier 1) cuts the sentinel's Battle Blink cooldown to 8 s, Focusing Lens (tier 2) gives the lancer +20 range, Resonance (tier 3) cuts the phantom's Phase Shift cooldown to 5 s and doubles the warden's aura to 4 shields a second.

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

Tier gates: the prowler and devourer need tier 1, the behemoth tier 2; the swarmer, spitter and crusher need none. Tier upgrades: Metabolic Boost (tier 1) gives the swarmer and prowler +15% speed, Grooved Spines (tier 2) gives the spitter +20 range, Adrenal Glands (tier 3) makes the swarmer and devourer attack 20% faster and gives the crusher +2 armour.

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
| **Barracks** | Everyone | 700 | 150 material | 8 | - | Trains each faction's fighters and raiders (the second unit of each needs tier 1). Required before a factory or laboratory, and for buying tier 1. |
| **Factory** | Everyone | 900 | 250 material | 12 | barracks | Trains the heavy units: siege, lancer, crusher (no tier) and bulwark, warden, behemoth (tier 2). Required for buying tier 2. |
| **Laboratory** | Everyone | 650 | 200 material | 10 | barracks | Required for buying tier 3. It researches nothing itself: research is instant and needs no building. |
| **Outpost** | Everyone | 650 | 300 material | 6 | - | A second hub, and an investment. Receives mined material and trains labour. For Organic it also spreads creep and stores harvester stock; for Network it projects a power field. |
| **Refinery** | Everyone | 400 | 75 material | 6 | catalyst deposit | Must be built on a catalyst deposit (it snaps to one within 60 units; one per deposit). Extracts 4 catalyst every half second with no workers. |
| **Turret** | Everyone | 500 | 100 terrazine | 7 | - | Static defense. Range 210, damage 16, cooldown 0.9 s. |
| **Sensor tower** | Industrial | 450 | 100 material | 7 | - | Projects a sensor field (radius 450) that speeds up your units by 30%. Cannot shoot or train. |
| **Bunker** | Industrial | 800 | 125 terrazine | 8 | - | Static defense. Range 150, damage 20, cooldown 0.9 s. Passive: Fortified. |
| **Relay** | Network | 300 | 75 material | 5 | - | Projects a power field (radius 320). Cannot shoot. |
| **Bastion** | Network | 500 | 125 terrazine | 7.5 | - | Static defense. Range 190, damage 14, cooldown 0.7 s. Passive: Ricochet (one bounce). |
| **Creep tumor** | Organic | 250 | 75 material | 5 | - | Spreads creep out to a radius of 250. Cannot shoot, train or receive cargo. Can be built anywhere in your build reach, on creep or not. |
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
| **Creep** | Organic | Finished HQ, outpost or creep tumor | 360 (HQ), 300 (outpost), 250 (tumor) | Starts at radius 60 and grows 10 per second to its full size. When its source dies it holds for 5 s, then recedes 20 per second. Harvesters move at full speed on it, and only 60% speed off it. When one of your own units dies on it, a brood or brute spawns (see [temporary units](#temporary-units)). |

Only hubs and creep tumors make creep. A Bloom also makes creep for its duration.

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

Bought from the Research tab with material. It is **instant**: no building is selected, nothing queues, and you own it the moment you pay. Each can be bought once; it applies to all your existing and future units and is never lost, even if every building falls.

| Technology | Cost | Effect |
| --- | ---: | --- |
| **Weapons** | 150 material | +4 attack damage on every attack, before multipliers. |
| **Armor** | 150 material | Every hit against your units and structures does 3 less damage (a hit never does less than 1). |
| **Logistics** | 150 material | Carry capacity 25 to 40 (harvesters 10 to 16); mining 5 to 7 per pulse (drifters 1 every 0.25 s to 3 every 0.5 s). |

### Tiers

Bought in order, instantly, with material. The finished building is needed only at the moment of purchase. Refusals: "Already researched", "Requires Tier N first", "Requires a finished barracks" (factory, lab), or the usual material shortfall. Training a locked unit is refused with "Requires Tier N".

| Tier | Cost | Needs | Unlocks | Industrial | Network | Organic |
| --- | ---: | --- | --- | --- | --- | --- |
| **1 Mobilisation** | 300 material | a finished barracks | marksman, medic / arcer, phantom / prowler, devourer | **Combat Shields**: soldier +20 maximum hit points (existing soldiers are raised at the purchase, later ones are born with it) | **Quick Blink**: Battle Blink cooldown 12 s to 8 s | **Metabolic Boost**: swarmer and prowler +15% speed |
| **2 Escalation** | 500 material | tier 1, a finished factory | bulwark / warden / behemoth | **Dig In**: Entrenchment arms in 4 s instead of 7.5 s | **Focusing Lens**: lancer +20 range | **Grooved Spines**: spitter +20 range |
| **3 Dominion** | 800 material | tier 2, a finished laboratory | nothing | **Reinforced Plating**: every own building +2 armour (stacks with Armor research and Fortified) | **Resonance**: Phase Shift every 5 s instead of 8 s; warden aura 2 to 4 shields a second | **Adrenal Glands**: swarmer and devourer attack 20% faster; crusher +2 armour |

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
| Command delay | 1 s by default; the room creator picks 0.5, 1.0 or 1.5 s at creation. Orders may run up to 0.3 s earlier than the delay when your ping is low |

## Limits and rules

- Up to 400 mobile units per player (labour and army; temporary units do not count) and 150 buildings per player (construction sites count).
- Each building queues up to 8 items; production is one item at a time.
- Build within 500 units (`BUILD_RADIUS`) of one of your own finished buildings, or within 500 of an unfinished building of yours that is itself within 500 of a finished one (one hop, not transitive). A site must be 110 clear of other buildings, 55 clear of enemy units (your own units standing there are moved to the nearest legal ground when the site is placed, orders kept), 75 clear of deposits (except a refinery), off terrain, and 60 from the map edge.
- A factory and a laboratory each need a finished barracks first. Tiers need the building of their number (barracks, factory, laboratory) finished when bought, and the tier before.
- Only Industrial can build sensor towers and bunkers; only Network relays and bastions; only Organic spines and creep tumors. Each faction trains only its own labour and army.
- Every faction chooses in the lobby; with no choice, slots are dealt Industrial, Network, Organic in order.
- You are out when your last finished hub falls. If the last hubs of two players fall on the same tick, it is a draw.
- Chat goes to everyone in your room, never further: lines up to 200 characters, at most 5 lines in 5 seconds per player, and the room keeps its latest 100 lines. New lines show on the battlefield for 10 seconds; open the chat to see the rest.
- The map is 9600 by 9600 with four start positions. 240 deposits, grouped into about 24 base sites.

## Behaviors

Army units can be given a behavior instead of a single order. It goes through the normal command delay once; after that the server re-evaluates it every 0.25 s, so the unit reacts without a further delay. A state is held at least 1 s before it can change. Any other order to the unit ends the behavior. Behaviors cannot be queued, and labour and buildings cannot take one.

Home is a spot beside your hub nearest the unit when the behavior started.

Behavior rally (`rally_harass`, `rally_guard`, `rally_raid`): still accepted by the server, no longer sent by the client, which uses missions instead (below). A producer that already carries one still starts it on each army unit it trains.

| Behavior | States |
| --- | --- |
| Harass | **advance**: attack-move to the goal, preferring enemy labour within reach. Retreats below 50% health, or when armed enemies within 350 outnumber its armed allies there (itself included). **retreat**: move home; within 250 of home it recovers. **recover**: hold; advances again at 80% health (a unit that cannot heal stays home as a defender) |
| Guard | **return**: move to the goal without fighting; within 150 it watches. **watch**: attack-move around the goal; more than 600 from the goal it returns |
| Raid | **advance**: attack-move to the goal. Retreats below 35% health. **retreat**: move home; within 250 it recovers. **recover**: hold; advances again at 90% health |

Health is hit points plus shields.

## Missions

Client-side standing objectives, in the spirit of operations: only ordinary orders, one pass a second, after the normal command delay. They live in the tab; the point, size and members are saved in localStorage under the room id and restored on reload in the same room, and dropped when the room ends or you leave it.

| Rule | Details |
| --- | --- |
| Placing | J / K / N or the Strategy panel buttons arm placement; the next map or minimap click places it (Shift keeps the mode armed, Escape or right-click cancels). Works with any selection. Selected army units join it at once (taken from other missions) and a numeric size is raised to at least their number |
| Size | Default Harass 4, Guard 6, Raid "rest". Numeric sizes run 1 to 99. "Rest" takes every recruit left after the numeric missions. Several rest missions split the recruits evenly, in creation order: each takes its nearest ceil(left / rest missions left) |
| Army | Your own living units for which the army test passes (labour, buildings and temporary units never join) |
| Pass | 1: members that died drop out. 2: a member whose behavior is not the mission's preset, or whose newest accepted behavior command has another goal, is released as player-controlled; a unit with an order of its own or of the pass still in the command delay is never judged (plus 3.5 s of grace after the pass sent it one). 3: a mission over its size stops its farthest members. 4: the pool is dealt out, numeric missions in creation order, nearest first, then rest missions. A numeric mission still short after the free pool takes the nearest members of rest missions (leftovers by definition); rest missions only ever take free units. 5: one behavior order per mission per pass |
| Pool | Own army, in no mission, not player-controlled, not mid-order, running no behavior, and either idle (order stop) or newly seen since the last pass and walking a plain move (a fresh unit going to its rally point). A player-controlled unit is forgotten once it is idle again, which is also why a plain Stop does not remove a unit from the pool for long |
| Limits | At most 8 orders per pass, none while 24 or more of your orders are pending (the server refuses more than 8 per tick and 32 pending); what does not fit waits for the next pass |
| Removing | Cancelling a mission sends its members a Stop, so they are idle and the remaining missions recruit them on the next pass |
| Display | Marker at the point in the preset's colour (guard also its 600 leash), label "HARASS 3/4" or "RAID 7", a diamond on the minimap. Right-click a marker with army selected: those units join it |

## Operations

Client-side helpers that send ordinary orders for you, once a second. They exist only in your browser tab: closing it forgets them (buildings already ordered stay ordered). They end when the match ends.

| Operation | Details |
| --- | --- |
| Expand | Armed with the Strategy panel's Expand button or V. Click the map or minimap. Base sites are clusters of deposits within 400 of each other with no hub (anyone's, finished or not) within 600 of their centre. The plan starts at your finished building nearest the site and hops at most 488 units per link, each hop your faction's territory link (Industrial sensor, Network relay, Organic tumor); the last building is an outpost 150-250 from the deposits (at least 112 from any catalyst deposit, so a refinery still fits), then up to two refineries on the site's catalysts. A hop that already has any of your buildings within 45 counts as built. The next link is ordered while the previous one is still under construction if that one is within 500 of a finished building (the build-radius look-ahead), so it runs one hop ahead. One order per pass; none while an earlier build of yours is still waiting out the command delay |
| Territory | Armed with the Strategy panel's Territory button or O. Click the map or minimap. The same chain logic from your finished building nearest the point, every link your faction's territory link (hops at most 488), the last on the legal spot nearest the point (searched within 200). No outpost, no refineries. Refused with a notice when the faction has no link building, no finished building exists, or no legal spot is near the point |
| Saturate workers (auto-labour) | Toggled with the Strategy panel's Saturate workers button or L. Each pass, every finished hub with an empty queue and no train order pending trains one labour unit while your labour (including queued) is below the number of non-empty material patches within 320 of your finished hubs (their mineral lines; a natural counts once it has its own hub) plus 2 (plus 0 for Network: a drifter holds its patch for good), you can afford it (Organic: the hub has stock) and you are under the unit cap. Paused while an expansion waits for material. Newly trained labour goes to work on its own |
| Pending spend | Not an operation: the money readouts show (−N) for build, train and research orders that are sent but not yet run, and buttons use the balance after them |

## Macro helpers

| Helper | Rule |
| --- | --- |
| Snap placement | An invalid aim (Site occupied, Enemy units block the site, Terrain obstructed, Map boundary) searches 16-unit rings out to 160, 12 angles per ring, for the nearest spot `placementError` accepts. Never snaps around Outside build radius, Building limit, Barracks required, or a refinery (which snaps to its deposit). Used for both the click and the ghost. `src/macro.ts` `snapSite` |
| Base label | Per finished hub: miners / material patches, plus idle labour nearest it. Patch owner: nearest finished own hub within 600; empty and catalyst deposits are excluded. Miner: own labour with a gather order targeting one of the base's patches (incl. the walk home). Colours: under amber, equal green, over orange. `baseSaturation` |
| Transfer | Labour not already gathering at the clicked hub's base is assigned to distinct free patches (no `miner`, not targeted by other labour), closest worker-patch pairs first; extras are dealt round-robin over the patches nearest the hub. One gather order per patch, Shift queues. `assignPatches` |
| Idle labour | `idleLabour(units, slot)`: own labour with a stop order (the F1 set) |

## Hotkeys

| Key | Action |
| --- | --- |
| Left click / drag | Select / box select; Shift adds |
| Double-click or Ctrl+click | Select all of that kind on screen (units or buildings) |
| Shift+click | Add a unit or building to the selection (or remove it) |
| Tab / Shift+Tab | Make the next / previous kind in a mixed selection the active subgroup; train and rally act on it |
| Right click | Move, attack, mine, return cargo (Shift queues). With only production buildings selected: set their rally point |
| Right click own hub (labour selected) | Transfer labour to that base's free material patches; the base they already work: return cargo |
| A, then click | Attack-move |
| S / H | Stop / hold position |
| F / G | Repair (then click a target) / return cargo |
| Y | Set a rally point (with a production building selected) |
| T / C | Teleport / faction ability (Recall, Bloom) |
| Q W E R D Z X | Train: labour, then your six army units in card order. With the Research tab open: Weapons, Armor, Logistics, Tier 1, Tier 2, Tier 3 |
| B, then Q W E R T Y U I | Build menu: barracks, outpost, turret, factory, laboratory, then your faction structure, refinery, faction defense |
| V | Expand (operation, see above) |
| O | Territory (operation, see above) |
| J / K / N, then click | Place a Harass / Guard / Raid mission at the clicked point (selected army joins it; see Missions) |
| L | Toggle Saturate workers (auto-labour) |
| Space (tap) | Jump to the latest attack on you |
| Ctrl or Alt + 0-9 | Set control group |
| Shift + 0-9 | Add to control group |
| 0-9 (twice) | Select group (second press centres the camera) |
| F1 or . | Select idle labour |
| F2 | Select whole army |
| Backspace | Centre on your base |
| Esc | Cancel targeting, then clear selection |
| Enter | Open room chat; Enter sends, Esc closes |
| ? | Show or hide the in-game control list |
| Wheel, middle-drag, Space+drag, arrow keys, screen edge | Zoom and camera |

## Army roster

A panel under the player list (hidden on phone widths, and when you have no army). Army means the same units F2 selects: your own combat units, not labour, buildings or temporary units.

- Grouping: by activity first, then by distance. Units chained within 400 of one another form one cluster, so two squads standing apart are two rows.
- Activity: a running behavior (Harass, Guard, Raid) wins; otherwise the order: attack-move is "Attack-moving", attack "Attacking", move "Moving", hold "Holding", stop "Idle"; any other order shows its name.
- Row: activity, unit count, "at base" (cluster centre within 600 of a finished hub) or "field", and the makeup, most numerous first.
- Order: fighting, moving, holding, idle. Idle clusters in the field are tinted red and are never cut off; other rows beyond six collapse into "+N more".
- Click selects exactly that cluster and centres the camera on it; Shift+click adds it to the selection without moving the camera. The header ("ARMY n") collapses the panel and the choice is remembered in this browser.
- The F1 idle-labour button shows a red count of labour units whose order is stop; it is hidden at zero.
