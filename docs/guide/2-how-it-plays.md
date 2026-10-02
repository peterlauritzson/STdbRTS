[Overview](1-overview.md) · [How it plays](2-how-it-plays.md) · [Encyclopedia](3-encyclopedia.md)

# How it plays, and why

This page explains the ideas behind the rules so the numbers in the [encyclopedia](3-encyclopedia.md) make sense. If you only want the short version, read the [overview](1-overview.md).

## The command delay

Every order you give, including training, building, stop and hold, runs about **one second** after you give it. The match room fixes the exact delay when it is created, anywhere from half a second to one and a half seconds. The lobby shows it.

Why would a game do this on purpose? Because the server decides everything, and a delay that is the same for everybody is the fairest way to deal with the internet. Each order is stamped with the moment you saw when you gave it, so it lands exactly one delay after that moment, however your connection wobbled in between. Only if your ping is above about 0.3 seconds does the delay stretch a little.

What it means for you:

- You cannot win by reflex clicking. Two armies that meet are not saved by one frantic retreat order; the enemy's order is delayed as well.
- You plan ahead. Give the order for where your army will need to be, not where it is.
- Units that act on their own matter far more. That is the reason every unit has a passive ability that triggers automatically (see below).
- Money is charged when the order runs, not when you click. If you queue three things with the money for two, the third fails when its turn comes.

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

- **Material** is for growth: labour, buildings, research. It is what you get from mining, so more mining means faster growth.
- **Catalyst** is for the army. It is separate, comes from refineries that need no workers, and is not touched by your growth spending. As a result there is never a reason to hold back from building an army because you needed the money for something else.
- **Terrazine** is for static defense. You earn it as a share of the material you mine, so a defender who mined a lot can afford strong defenses, and an army that never mined gets none.

Money from losses is partly returned too: when one of your army units dies you get **half of its price back in catalyst**. Losing a fight stings but does not stop you rebuilding. Workers and buildings return nothing.

Refineries are the one place you spend material to make catalyst, and each can only sit on a catalyst deposit. That makes the catalyst deposits the strategic points of the map: you always know where the other player must build.

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
- You may only build within 500 units of a finished building of your own, so an expansion grows in steps from where you already stand.
- Catalyst deposits are the prize. A refinery on a deposit produces 8 catalyst a second with no workers; a deposit holds 2000 or 2500 before it is empty. Material patches hold 1200 or 1500.
- Patches empty. By the middle of the game your first base will thin out, and the new one has to be ready.

## First five minutes: a suggestion per faction

All three start with a headquarters, two labour units, one basic fighter, 250 material and 100 catalyst. Spend the opening material on labour first, then a refinery, then a barracks, because the barracks unlocks the army, the factory and the laboratory.

### Industrial

1. Train workers at the HQ without stopping and send them to your material patches, one per patch.
2. Early on, build a **refinery** on your main's catalyst deposit (75 material) and a **barracks** (150).
3. Fill all eight patches, then build an **outpost** near your natural expansion.
4. Add a **sensor tower** near the front of your base, then a **factory** for siege.
5. Keep your catalyst spent: soldiers and a marksman or two. Get a **lab** for weapons, armor and logistics as material allows.

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
