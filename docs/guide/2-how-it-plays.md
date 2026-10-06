[Overview](1-overview.md) · [How it plays](2-how-it-plays.md) · [Encyclopedia](3-encyclopedia.md)

# How it plays, and why

This page explains the ideas behind the rules so the numbers in the [encyclopedia](3-encyclopedia.md) make sense. If you only want the short version, read the [overview](1-overview.md).

## The command delay

Every order you give, including training, building, stop and hold, runs about **one second** after you give it. The match room fixes the exact delay when it is created, whoever creates the room picks 0.5, 1.0 (the default) or 1.5 seconds in the lobby, including for Practice vs AI.

Why would a game do this on purpose? Because the server decides everything, and a delay that is the same for everybody is the fairest way to deal with the internet. Each order is stamped with the moment you saw when you gave it, so it lands exactly one delay after that moment, however your connection wobbled in between. Only if your ping is above about 0.3 seconds does the delay stretch a little.

What it means for you:

- You cannot win by reflex clicking. Two armies that meet are not saved by one frantic retreat order; the enemy's order is delayed as well.
- You plan ahead. Give the order for where your army will need to be, not where it is.
- Units that act on their own matter far more. That is the reason every unit has a passive ability that triggers automatically (see below).
- Money is charged when the order runs, not when you click. If you queue three things with the money for two, the third fails when its turn comes. The screen helps with this: money already promised to orders still waiting out the delay shows next to the balance, as **278 (−160)**, and the train, build and research buttons are worked out from what is left, so rapid clicks cannot overspend. A refused order flashes the readout it was short of and names the reason in the notice line.

## Three economies, three kinds of exposure

Every faction mines material from patches, one miner per patch. A main base has about eight material patches, so about eight miners fill it. What differs is how the material gets from patch to purse, and that decides what each faction is afraid of.

### Industrial: round trips

A worker mines 25 material in about 2.5 seconds, then walks it to the nearest HQ or outpost and walks back. Distance is the cost. So the Industrial player cares about where hubs stand (an outpost near new patches is a short commute) and about the moment a loaded worker is out in the open. Industrial earns the most terrazine, 12% of everything mined, which pays for its strong bunkers.

### Network: drifters in place

A drifter never carries anything. It stands at its patch and credits your account directly, which is a little slower than a good worker run but has no travel and no loads in transit. It is cheaper than a worker, and fragile: 40 health, half of it shield. The cost is that drifters stand at their patches all game, which makes them a standing target for raiders.

The Network trick is that drifters can be trained at **any finished structure inside your power field**, not only at a hub. Build a relay next to a new set of patches and you can bring labour straight to them. Relays are cheap and fragile, so the field is a thing you can lose.

### Organic: stock, not money

A harvester costs no currency at all. It costs one point of **hub stock**. Each hub makes one point of stock every 3 seconds and holds at most 7, so every extra hub (an outpost) multiplies how fast you can build labour. Harvesters carry only 10 per trip and cannot fight, but you can have a lot of them. They also move at 60% speed when off your own creep, so keep them close to home or extend your creep.

The Organic risks are all about territory. Lose a hub and its creep recedes; lose your stock and you are stuck with the harvesters you have.

## Why each currency buys one kind of thing

The three currencies are kept strictly apart on purpose.

- **Material** is for growth: labour, buildings, research and tiers. It is what you get from mining, so more mining means faster growth.
- **Catalyst** is for the army. It is separate, comes from refineries that need no workers, and is not touched by your growth spending. As a result there is never a reason to hold back from building an army because you needed the money for something else.
- **Terrazine** is for static defense. You earn it as a share of the material you mine, so a defender who mined a lot can afford strong defenses, and an army that never mined gets none.

Money from losses is partly returned too: when one of your army units dies you get **half of its price back in catalyst**. Losing a fight stings but does not stop you rebuilding. Workers and buildings return nothing.

Refineries are the one place you spend material to make catalyst, and each can only sit on a catalyst deposit. That makes the catalyst deposits the strategic points of the map: you always know where the other player must build.

## Tiers: tech is a purchase, not a building

Before tiers, every unit was available the moment its building stood, so there was nothing to choose or deny. Now material buys a decision: tech up now, or spend on structures and expansion.

- Tiers are bought from the **Research tab**, instantly, in order, and are never lost. The building requirement is checked only at the moment you buy: tier 1 needs a finished barracks (300 material), tier 2 a finished factory (500), tier 3 a finished laboratory (800). Destroying a building afterwards does not undo anything, but an opponent who kills your only factory before you buy tier 2 has delayed it.
- A locked unit's button is greyed with its tier on it, and the server refuses it with "Requires Tier N". The units are the marksman, medic, arcer, phantom, prowler and devourer (tier 1) and the bulwark, warden and behemoth (tier 2).
- Each tier also makes one of your faction's passives better, so nothing new needs learning:

| Tier | Industrial | Network | Organic |
| --- | --- | --- | --- |
| 1 | **Combat Shields**: soldier +20 maximum hit points (existing soldiers too) | **Quick Blink**: Battle Blink cooldown 8 s instead of 12 s | **Metabolic Boost**: swarmer and prowler move 15% faster |
| 2 | **Dig In**: Entrenchment arms in 4 s instead of 7.5 s | **Focusing Lens**: lancer +20 range | **Grooved Spines**: spitter +20 range |
| 3 | **Reinforced Plating**: every building +2 armour | **Resonance**: Phase Shift every 5 s instead of 8 s; warden aura 4 shields a second instead of 2 | **Adrenal Glands**: swarmer and devourer attack 20% faster; crusher +2 armour |

- The laboratory is the tier 3 gate. It no longer researches anything, but it is a target for your opponent that delays your late game.

## Territory: creep, power fields and sensors

Each faction has a way of making ground "yours". These areas only help their owner, are rebuilt every tick from their source, and vanish when the source dies.

- **Sensor towers (Industrial)**: your units move 30% faster inside a radius of 450 around each tower. One tower beside your main covers the whole mineral line and the first stretch of any attack. To cover more of the map you build more towers, forward, where they can be killed.
- **Power field (Network)**: a radius of 320 around each relay and each of your hubs. Inside it your shields recharge three times as fast, a dying unit restores a share of its health to friends nearby, drifters can be trained at any structure, and units can teleport. A teleport takes a second of channelling (damage cancels it), leaves the unit helpless for two seconds on arrival, and has a 30 second cooldown. A Network hub can also **Recall** nearby units back to itself.
- **Creep (Organic)**: your HQ spreads creep out to 360, an outpost to 300. It spreads slowly (10 a second) and recedes after the hub dies. Harvesters move at full speed on it, and whenever one of your units dies on it, a temporary free fighter spawns: a brood for a mid-priced unit, a brute for an expensive one. A hub can also cast **Bloom** to grow a temporary patch anywhere on your creep.

The common idea: an advantage tied to a building is also a target. Raid the source, and the advantage goes.

## Faction identities and play styles

- **Industrial** plays the long game: steady economy, tough units, good defense. It has the only real anti-raider unit in the soldier (double damage to raiders) and the best long-range gun. Win by keeping your army together inside your sensor field and pushing forward tower by tower.
- **Network** plays few, strong units. Everything has shields, so skirmishes where you retreat and recharge are a Network strength. It teleports and recalls to hold more map than its numbers should allow. Defend your relays and drifters; skimmers will punish an undefended mining line.
- **Organic** plays numbers and speed. Swarmers are very cheap, and anything that dies on creep leaves something behind. It is at its best near its own hubs and at its worst far from them, so it wants to expand constantly and fight on or near its creep.

## How passive abilities shape fights

Every army unit has one passive that triggers without being asked (the full list is in the [encyclopedia](3-encyclopedia.md)). A few examples of the play they create:

- **Hold position for Entrenchment.** A marksman that stands still for 7.5 seconds gains +2 armour and +25 range. Park them in a line, press **H**, and do not wander.
- **Raiders get Forced March when out of combat.** Scouts, skimmers and prowlers move 40% faster after 10 quiet seconds. Send them around, not through, and arrive fast.
- **Veteran rewards keeping units alive.** Soldiers and devourers speed up with every kill, up to 15. Pulling a veteran back is worth more than it looks.
- **Guardian and Shield Aura reward clumping.** Keep a bulwark or warden in the middle of the group; their effects reach only 90 and 110 units.
- **Splash and Ricochet punish clumping.** Siege shells and spitter globs hit neighbours for half damage, and arcer bolts jump twice. Spread out against them.
- **Phase Shift, Battle Blink and Death Burst** change the shape of a fight in one moment: an assassin walks into the first hit for free, a sentinel escapes at 30% health, and a dying behemoth takes everything near it for 80 damage.

Since your orders are delayed, these automatic triggers are what keep a unit useful in the second between your thought and your order taking effect.

## Static defense

Turrets and your faction's own defense (bunker, bastion or spine) shoot on their own and cost terrazine only. They are the answer to a raid on a base you cannot be at, and they are hard for a small army to chew through. They cannot move and they cost real mining, so they do not win a game by themselves. Siege, lancers and crushers do triple damage to buildings, so a defense line needs army support. The faction defenses also carry a passive of their own: Fortified armour on the bunker, one bounce on the bastion, and healing from damage dealt on the spine.

## Expanding on the large map

The map is huge and travel takes time. A basic unit needs well over a minute to cross it, so you cannot defend everywhere. A few rules of thumb:

- Build an **outpost** (100 material) next to new patches. It works as a drop-off point, a second hub that trains labour, and, for Organic, a creep source and a stock tank.
- You may only build within 500 units of a finished building of your own, or within 500 of an unfinished building of yours that is itself within 500 of a finished one (one hop of look-ahead, not a chain: your reach is at most about 1000 from finished structures, so you can queue the next building before the last one completes). Your own units standing on the site step aside when it is placed; only enemy units block it. You do not have to place every step by hand: **Expand toward** (Strategy panel, or **V**) plans the chain for you. It picks the base site nearest your click, walks from your nearest finished building toward it in hops of at most 488 units (each hop an outpost, 100 material, 6 seconds), puts the last outpost 150 to 250 units from the deposits on the side facing your base, and then builds two refineries on the site's catalyst. The chain is drawn as a dashed line with numbered ghost outposts on the map and minimap, and it is carried out one step at a time: the next outpost is ordered when the previous one is finished and the material is there.
- **Saturate workers** (the old auto-labour; Strategy panel or **L**) keeps your hubs busy: any finished hub with an empty queue trains one labour unit, until you have one per live material patch on your hubs' mineral lines (within 320 of a finished hub) plus two, or exactly one per patch for Network, since a drifter never leaves its patch and a patch takes one miner at a time. It is a convenience, not a strategy; it will happily build workers you do not need if you stop spending.
- Catalyst deposits are the prize. A refinery on a deposit produces 8 catalyst a second with no workers; a deposit holds 2000 or 2500 before it is empty. Material patches hold 1200 or 1500.
- Patches empty. By the middle of the game your first base will thin out, and the new one has to be ready.

## Behaviors: orders that think

Because every order is delayed, a unit that must wait for you to tell it to run away will usually die first. A **behavior** is one order that carries its own rules, which the server re-checks four times a second without further delay. You do not give a behavior to units, you give it to a **place**: press **J** (Harass), **K** (Guard) or **N** (Raid), or use the buttons in the Strategy panel, then click the map or minimap. That is a **mission**, described below; the encyclopedia has the exact numbers.

- **Harass** goes after enemy labour near the goal and pulls back when hurt or outnumbered. Use it to bleed an economy with a small, fast group.
- **Guard** holds a spot and fights around it, walking back if chased far away. Use it for the approach to an outpost.
- **Raid** is a plain push: units retreat below 35% health and come back at 90%.
- On screen, selected units draw a faint line to their goal and a marker labelled with the preset; each unit wears a coloured dot for its state, and a unit that is retreating or recovering is ringed and labelled, so you can see why it left the fight. Any ordinary order you give a unit ends its behavior and takes it out of its mission. Behaviors go to army units only and cannot be Shift-queued.

### Missions: strategy is about places

Setting up a strategy by hand is a chore: select the army, give it a raid, and every soldier trained afterwards just stands at home. Strategy is really a list of places ("harass over there", "push here", "guard this ramp") and a question of how many units each place gets. So you say the places, and the game staffs them.

- A mission is a behavior, a point and a size. Idle and newly trained army units are dealt to missions automatically: older missions first, nearest units first, up to each mission's size. A Raid defaults to "all rest": it takes every army unit nothing else needs, so new soldiers walk out to the front without you.
- Army units you had selected when you placed the mission join it immediately. You can also right-click a mission's marker with army selected.
- Your own orders always win. A unit you move, stop-and-reorder, or give another behavior leaves its mission and is not recruited again until it is idle. A shrunk or cancelled mission stops the units it lets go, so they become idle and the other missions can take them.
- Missions are drawn on the map and minimap in their preset's colour, labelled with how full they are (HARASS 3/4, RAID 7), and listed in the Strategy panel beside your operations.
- Like operations, missions are managed by your browser tab, using ordinary orders after the usual delay. If you close the tab, units keep what they were doing but nothing fills the missions; reload and they pick up again.

## Macro without the clicking

Three small rules remove the busywork of running several bases, none of them changing what the server allows.

- **Snap placement.** Building sites used to refuse whenever a unit stood within 55 units or a building within 110 of the aim (now only an enemy unit within 55 blocks a site; your own units are moved out of the way). The click now slides to the closest valid spot within 160 units (searched in rings), and the ghost drawn at the cursor already shows where it will land, with a faint line back to your aim. A site refused for another reason (outside build radius, building limit, missing Barracks, no catalyst deposit for a refinery) is still refused, with its reason.
- **Base labels.** Each finished hub shows miners/patches. A material patch belongs to the nearest of your finished hubs within 600 units. A labour unit counts as mining a base while it holds a gather order on one of its patches, which the server keeps through the walk home, so the number does not flicker with each delivery. Idle labour is counted at the hub nearest it, so a base that is draining or a squad that finished a build shows up without hunting for it.
- **Transfer.** Splitting workers to a new base is one right click on that hub. Each selected labour unit is sent to a different patch of the target base with no miner and no worker already headed for it, closest pair first. If there are more workers than free patches the rest go to the patches nearest the hub; the server moves a worker that finds its patch taken to a free one on the same line, or has it wait. Workers already mining that base are left to it.

## Knowing what your army is doing

Selecting units to read one line of text does not scale past a handful of squads, and the usual failure is a squad that finished its order and has stood idle in a corner since. The army roster lists every cluster of army units with its activity, size and makeup, so a forgotten squad is a red row rather than something you notice ten minutes later. Behaviors (Harass, Guard, Raid) show under their own name, since the preset, not the raw order underneath it, is what the units are doing. The F1 button carries a count of idle labour for the same reason.

## Knowing you are under attack

- A red banner at the top of the battlefield says **Your units are under attack** or **Your base is under attack** the first time something of yours is hit in an area, and at most once per area every 8 seconds after that. A sound plays with it.
- **Space** (a tap) jumps the camera to the most recent attack. Holding Space and dragging still pans.
- Off-screen fights also pulse as a red ring on the minimap for a few seconds; a ring with a dot means a building was hit.
- A building that is training shows a small bar with the number queued and the progress of the first item above it. The **queue** panel in the Production tab lists every item with its own progress bar, for the selected buildings or, if none are selected, all of them.

## First five minutes: a suggestion per faction

All three start with a headquarters, two labour units, one basic fighter, 250 material and 100 catalyst. Spend the opening material on labour first, then a refinery, then a barracks, because the barracks unlocks the army, the factory and the laboratory.

### Industrial

1. Train workers at the HQ without stopping and send them to your material patches, one per patch.
2. Early on, build a **refinery** on your main's catalyst deposit (75 material) and a **barracks** (150).
3. Fill all eight patches, then build an **outpost** near your natural expansion.
4. Add a **sensor tower** near the front of your base, then a **factory** for siege.
5. Keep your catalyst spent: soldiers and a marksman or two. Buy **tier 1** once the barracks stands (that unlocks the marksman), then weapons, armor and logistics from the Research tab as material allows; a **factory**, **tier 2** and a **lab** come later.

### Network

1. Build a **relay** early (75 material) beside your patches, then train drifters at the HQ or at any structure in the field.
2. Build a **refinery**, then a **barracks**. Your units regenerate shields three times faster in the field, so fight near it.
3. Put a **second relay** where you want to expand, then fill it with drifters trained right there.
4. Keep a few **skimmers** to harass the enemy's labour, and add **lancers** from a factory when you want to break buildings.
5. Use your hub's **Recall** to save a trapped army, and teleport units back into the field rather than walking them.

### Organic

1. Spend your first stock on harvesters straight away and keep spending it: stock sitting at 7 is wasted.
2. Build a **refinery** and a **barracks**. Swarmers are 50 catalyst each, so catalyst goes a long way.
3. Take an **outpost** early: it doubles your stock income and extends your creep.
4. Fight on your creep when you can. Swarmers and spitters in numbers, with a crusher or behemoth later for buildings and crowds.
5. Use **Bloom** to extend creep for a key fight, and keep harvesters near creep.
