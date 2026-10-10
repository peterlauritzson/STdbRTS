[Overview](1-overview.md) · [How it plays](2-how-it-plays.md) · [Encyclopedia](3-encyclopedia.md)

# The game at a glance

## What this is

- A real-time strategy game for 2 to 4 players, played in the browser. Build an economy, expand, train an army and destroy the other players' bases.
- The server runs the whole game. Your screen only shows you what it says happened.
- **Orders take effect after a short delay** (1 second by default; the room creator picks 0.5, 1.0 or 1.5 seconds). That is deliberate: it makes the game fair at any ping and rewards planning over twitch reflexes. Your order shows as a pending marker until it lands.
- You win by destroying every enemy hub (headquarters and outposts). You lose when your last finished hub falls. Leaving a match counts as surrender; closing the tab does not.

## The three factions

- **Industrial**: the conventional one. Workers carry ore home; sensor towers speed up your army; strong, simple defenses.
- **Network**: fewer, tougher units that are half shield. Drifters mine in place, and relays project a power field where shields recharge fast and units can teleport.
- **Organic**: cheap fast swarms. Harvesters are free but limited by hub stock, and your hubs and creep tumors spread creep that makes dying units leave temporary fighters behind.

## Money: three currencies, one job each

- **Material**: labour, buildings, research and tiers. Mined from patches. Late in the game a **synthesizer** (tier 2) can turn surplus material into catalyst or terrazine.
- **Catalyst**: the army, and only the army. Comes from refineries built on catalyst deposits; no workers needed.
- **Terrazine**: static defense (turrets and your faction's own defense). You earn it as a by-product of mining material: 12% of what you mine if Industrial, 10% otherwise.
- Nothing converts into anything else, except through the slow synthesizer. You start with 250 material and 100 catalyst, plus a steady trickle of free material (200 a minute for 90 seconds, then 100 a minute for the rest of the game).

## Research and tiers

- **Research is instant.** Open the Research tab and buy Weapons, Armour or Logistics. Logistics is one purchase (150 material). Weapons and Armour have **three levels** (150, 400, 800 material); level 2 needs tier 2 and level 3 needs tier 3. No building is selected and nothing queues; you own it the moment you pay, for the rest of the match.
- **Tiers gate your army.** Tier 1 (300 material, needs a finished barracks) unlocks the second unit of each barracks: marksman and medic, arcer and phantom, or prowler and devourer. Tier 2 (500, needs tier 1 and a finished factory) unlocks the factory's heavy unit: bulwark, warden or behemoth. Tier 3 (800, needs tier 2 and a finished laboratory) unlocks no unit, but opens level 3 of Weapons and Armour. Each tier also gives your faction one upgrade.
- The first unit of each building (soldier, scout, siege; sentinel, skimmer, lancer; swarmer, spitter, crusher) needs no tier.

## Mining

- **One miner per patch.** A second worker at a taken patch finds a free one nearby or waits, so more workers than patches is wasted.
- Industrial workers and Organic harvesters carry a load home to an HQ or outpost. Network drifters credit you on the spot and never walk anywhere.
- Catalyst only comes from a **refinery** (75 material) placed on a catalyst deposit.
- Material patches run out. Expand to keep your income up.

## The map and the limits

- One large map, 9600 by 9600 units, with four start positions and about two dozen base sites. Each base has material patches and a pair of catalyst deposits. Rock walls block movement and line of fire.
- Up to **400 units** and **150 buildings** per player. Each building queues up to 8 items.
- Every unit and defensive structure has **one passive ability that fires on its own**: no button, no hotkey. Read the tooltip, then play around it.

## Essential controls

- **Left click / drag** selects (a drag takes your units; it takes buildings only when there are no units in the box); **Shift + click** adds a building or a unit; **double-click** or **Ctrl + click** takes every one of that kind on screen. **Right click** moves, attacks, mines or rallies; with only production buildings selected it sets their rally point. Hold **Shift** to queue.
- **Tab** switches between the kinds in a mixed selection (the highlighted kind is the one train, rally and production act on).
- **A** then click: attack-move. **S** stops, **H** holds position.
- **J** Harass, **K** Guard, **N** Hit & retreat, **M** Rush, **,** (comma) Gather then strike (or the buttons in the **Strategy** panel), then click a place on the map or minimap: that places a **mission**. Idle and newly trained army units fill missions on their own and follow a behavior there (retreat when hurt, recover, return); army you had selected joins it at once. Giving a unit an order yourself takes it out of its mission until it is idle again. The selection panel shows each unit's state, e.g. "Harass: 6 advance, 2 retreat".
- **Stances** (Strategy window, **Stances** tab): per army kind, pick Standard / Charge / Kite / Hold. It changes how units fight on an attack-move (and missions), never a plain move, hold or explicit attack. Marksman, lancer and spitter kite by default; bulwark, behemoth and crusher charge.
- **Production** (Strategy window, **Production** tab): everything starts off. **Auto-train** makes idle barracks and factories train toward a mix you set with a 0 to 10 weight per army unit (presets: Even, Basics, Heavy), while a **reserve** keeps some catalyst unspent. **Auto-tier** and **Auto-research** buy the next tier and upgrades as soon as they are allowed and affordable. **Auto-build** first claims free catalyst deposits beside your hubs with refineries, then raises the building your next tier needs (barracks, factory, laboratory) if you have none, then adds a barracks or factory when catalyst floats 400 above the reserve (and a synthesizer at tier 2 when material passes 1500), one at a time, near your HQ and away from resource nodes. A building you queued yourself is left alone.
- **Q W E R D Z X** train labour and then your six army units. **B** then a letter builds; a site that is blocked (a worker walking by, a neighbouring building) **slides to the nearest valid spot**, shown by the ghost, instead of refusing the click.
- **Right click one of your other hubs** with labour selected: they transfer to that base's free mineral patches, one each. Right-clicking the hub they already work still drops their load.
- **Ctrl + number** saves a control group; the number recalls it.
- **F1** selects idle labour, **F2** your army, **Backspace** jumps to your base.
- **Army roster** (top left, under the player list): your army grouped by what it is doing and where. Click a row to select those units and jump to them; Shift+click adds them. Units on a mission are labelled by it (Gather, Strike, Defend, Harass...), not by the preset they run. Idle units in the field are highlighted red. The F1 button shows how many labour units are idle.
- **Space** (a tap) jumps to the latest attack on you; hold **Space** and drag to pan. An alert banner and a pulsing red ring on the minimap show where.
- **Strategy panel** (right end of the bottom bar, always visible): the mission buttons, **Expand** (**V**), **Territory** (**O**) and **Saturate workers** (**L**), a one-line summary of each mission and operation (click a name to go there), and links to Stances, Production and Orders.
- **Strategy window** (**F3**, or **Open** on the Strategy panel; **Esc** closes it): a large panel over the right of the map with four tabs. **Missions**: launch cards and every mission with its tactic picker, size controls and cancel. **Stances**: a grid of army kind by stance. **Production**: the automation switches, the army mix with each kind's share, and the catalyst reserve. **Orders**: your recent orders and why any were refused. The game keeps running beside it, and you can place a mission straight from it. See "Missions" and "Operations" below.
- **Enter** opens the room chat (or the speech-bubble button, top right); Enter sends, Esc closes. The waiting room has the same chat, and it carries on through the match and the score screen.
- **?** (or the keyboard button) shows the full control list. Scroll to zoom; middle-drag or arrow keys pan.

## Missions: say where, not who

- A **mission** is a standing objective at a place: **Harass** (default 4 units), **Guard** (6), **Hit & retreat** (all the army not needed elsewhere), **Rush** (all the rest; attack-move there and never retreat) or **Gather then strike** (all the rest; gather at a rally point, strike when enough are there, fall back if the strike goes badly, then gather again). While gathering, the group turns to defend a building of yours that three or more enemy army units threaten, and waits 15 seconds after a defence before it strikes again. A gather mission's label reads **GATHER 5/8** (gathered at the rally over the number needed to strike), **STRIKE 7**, **DEFEND 5** or **FALL BACK**. Place one with **J** / **K** / **N** / **M** / **,** or its button, then click the map or minimap. **Shift** keeps placing more.
- Missions fill themselves from idle and newly trained army units, nearest first, in the order you made them; an "all rest" mission takes what is left. Select army before placing and those units join it first.
- Order a unit yourself and it leaves its mission and is left alone until it is idle again. Right-click a mission's marker with army selected to put them in it.
- Change a mission's size with the minus and plus buttons in the Strategy window, make it "All" (rest), or cancel it. Missions live on the server, so they keep staffing themselves when the tab is closed or you reload. A mission can switch tactic from a picker in the Strategy window; Gather then strike also has gather % and fall-back % steppers and a **rally** button (click it, then click the map to move the rally point). Up to 16 missions.

## Operations: let the game do the legwork

- **Expand** (Strategy panel, or **V**): click anywhere on the map or minimap. The nearest free base site is chosen, a dashed numbered line shows the chain, and the game places it one step at a time: your faction's territory links (sensor towers, relays or creep tumors) to reach the site, an outpost beside the deposits, then two refineries on the site's catalyst. It runs one hop ahead of construction and waits when material runs short. Several can run at once; each shows in the Strategy panel's list with its step and a cancel button.
- **Territory** (Strategy panel, or **O**): click the map or minimap and your faction strings its territory link (sensor towers for Industrial, relays for Network, creep tumors for Organic) from your nearest finished building toward that point, the last one at or beside it. No outpost, no refineries: it extends reach, not income.
- **Saturate workers** (Strategy panel, or **L**; this was called auto-labour): idle hubs train one labour unit each until you have one per mining patch on your hubs' own mineral lines, plus two spare (no spares for drifters, which never leave their patch). It pauses while an expansion is waiting for material and stays on until you turn it off. A finished Expand or Territory leaves the list with a short "complete" notice.
- Operations only send the same orders you could, so they obey the same one-second delay and the same costs, and they stop when the match ends.

## Reading the screen

- **Base labels.** A tag under each finished hub reads miners/patches, for example **6/8**: amber is under-saturated, green is full, orange is over-saturated. **· 2 idle** counts idle labour nearest that hub.
- **You are always green.** Your units, buildings and the player-list entry marked "you" share one colour; opponents get the others. Zoomed out, a **YOU** tag marks your headquarters on the map and the minimap.
- The money readouts show orders you have sent but that have not run yet, for example **278 (−160)**, and the buttons use what is left after them.

## Read next

- [How it plays, and why](2-how-it-plays.md): the reasoning behind the rules, and an opening for each faction.
- [Encyclopedia](3-encyclopedia.md): every unit, building and number.
