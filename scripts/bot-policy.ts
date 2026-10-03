import type { CreepPatch, Node, Order } from "../src/bindings/types";
import type { Entity } from "../src/units";
import { abilityOf, castingHub, onCreep, recallable } from "../src/abilities";
import { affords, ARMY, ROSTER, canProduce, CATALOG, carriesCargo, currencyOf, isArmy, isBuilding, isCompletedHub, isHub, isLabour, LABOUR, MAX_UNITS, placementError, requiredTier, researchReason, RESEARCH_COST, shortfall, spend, takesSupply, TECHNOLOGIES, tierOf, tierOrder, costOf, type Cost, type FactionName } from "../src/catalog";

export interface Decision { units: number[]; order: Order }

/** Each faction's own static defense, bought with terrazine once it allows. */
const FACTION_DEFENSE: Readonly<Record<FactionName, string>> = { industrial: "bunker", network: "bastion", organic: "spine" };

/** What the bot needs to cast hub abilities; without it, it casts nothing. */
export interface AbilityView { tick: bigint; creep: readonly CreepPatch[] }

/** A recall is worth casting once this many units far from home are this badly hurt. */
const RECALL_WOUNDED = 3;
const RECALL_HEALTH = 0.35;
const RECALL_AWAY = 700;

/**
 * The bot's one ability cast this pass, if any. Organic blooms at the edge of
 * its creep on the line to the nearest enemy hub, so creep (and its death
 * spawns) creeps towards the fight. Network recalls a group of wounded units
 * that are far from home, which the shields it spends would not have saved.
 */
function castAbility(owner: number, faction: FactionName, owned: Entity[], units: Entity[], busy: Set<number>, view: AbilityView): Decision | undefined {
  const rule = abilityOf(faction);
  if (!rule) return;
  const hub = castingHub(owned.filter(unit => !busy.has(unit.id)), owner, rule, view.tick, new Set());
  if (!hub) return;
  const home = owned.find(unit => unit.kind === "hq") ?? hub;
  if (rule.kind === "bloom") {
    const target = units.filter(unit => unit.owner !== owner && isHub(unit.kind)).sort((left, right) => Math.hypot(left.x - home.x, left.y - home.y) - Math.hypot(right.x - home.x, right.y - home.y))[0];
    if (!target) return;
    const gap = Math.max(1, Math.hypot(target.x - home.x, target.y - home.y));
    let reach = 0;
    // Walk out along the line in 20-unit steps while still on this player's
    // creep; the bloom goes just inside the far edge.
    while (reach + 20 < gap && onCreep(owner, home.x + (target.x - home.x) / gap * (reach + 20), home.y + (target.y - home.y) / gap * (reach + 20), view.creep)) reach += 20;
    if (reach < 40) return;
    return { units: [hub.id], order: { kind: "bloom", x: Math.round(home.x + (target.x - home.x) / gap * reach), y: Math.round(home.y + (target.y - home.y) / gap * reach), target: 0 } };
  }
  const wounded = owned.filter(unit => isArmy(unit.kind) && (unit.hp + unit.shields) < (unit.maxHp + unit.maxShields) * RECALL_HEALTH && Math.hypot(unit.x - home.x, unit.y - home.y) > RECALL_AWAY);
  if (wounded.length < RECALL_WOUNDED) return;
  const x = wounded.reduce((sum, unit) => sum + unit.x, 0) / wounded.length;
  const y = wounded.reduce((sum, unit) => sum + unit.y, 0) / wounded.length;
  if (!recallable(owned, owner, x, y, kind => !isBuilding(kind))) return;
  return { units: [hub.id], order: { kind: "recall", x: Math.round(x), y: Math.round(y), target: 0 } };
}

/** Material held back so a repair pulse is always payable. */
const REPAIR_RESERVE = 20;
/**
 * Refineries the bot builds: the catalyst deposits nearest its HQ. Catalyst
 * buys every army unit and is extracted only by a refinery, so the first goes
 * down at the very start and a second once the barracks is under way.
 */
const REFINERIES_FIRST = 1;
const REFINERIES_WANTED = 2;
/** The labour count the opening builds up to, for every faction alike. */
const OPENING_LABOUR = 6;
/**
 * Labour each completed hub supports once a barracks exists, and the ceiling on
 * the whole workforce. Past this a hub orders nothing: a hub trains labour and
 * nothing else, so asking it for an army unit is refused by the server and
 * burns a slot of the per-tick order allowance.
 */
const LABOUR_PER_HUB = 8;
const LABOUR_CAP = 20;

const nearest = (points: Node[], unit: Entity): Node | undefined =>
  [...points].sort((left, right) => Math.hypot(left.x - unit.x, left.y - unit.y) - Math.hypot(right.x - unit.x, right.y - unit.y))[0];

/** Rings searched for a building site, all inside the 500 build radius of the HQ. */
const SITE_RINGS = [220, 280, 340, 400, 460];
const SITE_BEARINGS = 24;
/** A site this close to a deposit sits in the mining line and is used last. */
const MINING_LINE = 180;

/**
 * A legal site for `kind` near the HQ, or undefined. A fixed list of offsets
 * pointed at the map centre found nothing on the crossfire map — the main is
 * walled towards the middle, so every offset was terrain or occupied and the
 * bot never built a barracks at all. Rings of bearings around the HQ always
 * include open ground behind it. Sites clear of the mining line are preferred,
 * then the nearest, so the choice is deterministic.
 */
function buildSite(kind: string, hq: Entity, owner: number, units: Entity[], nodes: Node[]): { x: number; y: number } | undefined {
  const live = nodes.filter(node => node.amount > 0);
  const candidates = SITE_RINGS.flatMap(radius => Array.from({ length: SITE_BEARINGS }, (_, index) => {
    const angle = (index / SITE_BEARINGS) * 2 * Math.PI;
    return { x: Math.round(hq.x + Math.cos(angle) * radius), y: Math.round(hq.y + Math.sin(angle) * radius), radius };
  })).filter(point => !placementError(kind, point.x, point.y, owner, units, nodes));
  const inLine = (point: { x: number; y: number }) => live.some(node => Math.hypot(node.x - point.x, node.y - point.y) < MINING_LINE);
  const best = candidates.find(point => !inLine(point)) ?? candidates[0];
  return best && { x: best.x, y: best.y };
}

/**
 * The catalyst deposit nearest the HQ that can take a refinery right now, or
 * undefined: every legal site has to pass the same placement check the build
 * preview uses, so the bot never orders a refinery the server would refuse.
 */
function refinerySite(hq: Entity, owner: number, units: Entity[], nodes: Node[]): { x: number; y: number } | undefined {
  return nodes
    .filter(node => currencyOf(node.kind) === "catalyst" && node.amount > 0 && !placementError("refinery", node.x, node.y, owner, units, nodes))
    .sort((left, right) => Math.hypot(left.x - hq.x, left.y - hq.y) - Math.hypot(right.x - hq.x, right.y - hq.y) || left.id - right.id)
    .map(node => ({ x: node.x, y: node.y }))[0];
}

/**
 * The practice opponent's policy. It sees exactly what any authenticated
 * client sees — the public unit, node and command rows of its own match — and
 * decides from `balance`, which is its own three-currency purse. Every currency
 * must cover a price; nothing here may assume one can stand in for another:
 * labour, structures and research are material, the army is catalyst and
 * turrets are terrazine.
 *
 * `faction` is the one the server dealt this slot, read from the bot's own
 * `Player` row exactly as any other client would read it. It decides which
 * labour unit is trained and how that labour is handled afterwards: a drifter
 * is left standing on its deposit instead of being cycled home, and a harvester
 * is paid for in hub stock, which is checked here so the bot never spends a
 * pass on orders the server would refuse.
 */
export function chooseOrders(owner: number, faction: FactionName, balance: Cost & { research?: readonly string[] }, units: Entity[], nodes: Node[], busy: Set<number>, holdArmy = false, abilities?: AbilityView): Decision[] {
  const owned = units.filter(unit => unit.owner === owner);
  // Primary-hub victory: after the HQ falls the bot plays on from any
  // completed outpost, which then anchors building, repair and the attack.
  const hq = owned.find(unit => unit.kind === "hq") ?? owned.find(isCompletedHub);
  const researched = balance.research ?? [];
  if (!hq) return [];
  const decisions: Decision[] = [];
  // First, so the per-pass order cap never drops it.
  const cast = abilities && castAbility(owner, faction, owned, units, busy, abilities);
  if (cast) decisions.push(cast);
  const labour = LABOUR[faction];
  // Its own labour is all a faction can ever have, but filtering on `isLabour`
  // keeps the rest of this policy true of whatever labour it is holding.
  const workers = owned.filter(unit => isLabour(unit.kind));
  const soldiers = owned.filter(unit => isArmy(unit.kind));
  const assigned = new Set(busy);
  let available: Cost = { material: balance.material, catalyst: balance.catalyst, terrazine: balance.terrazine };
  const repairing = workers.some(unit => unit.order.kind === "repair");
  // Three quarters of full hit points: 900 of 1200 for most HQs, 450 of the
  // 600 a Network HQ carries beside its shields.
  const repairer = hq.hp < hq.maxHp * 3 / 4 && available.material > 0 && !repairing
    ? workers.find(unit => !busy.has(unit.id)) : undefined;
  if (repairer) decisions.push({ units: [repairer.id], order: { kind: "repair", x: 0, y: 0, target: hq.id } });
  if (repairer) assigned.add(repairer.id);
  // What is spendable after the repair reserve; the reserve is material only,
  // because repair is only ever charged in material.
  const reserve = repairing || repairer ? REPAIR_RESERVE : 0;
  const spendable = (): Cost => ({ ...available, material: Math.max(0, available.material - reserve) });
  const has = (kind: string) => owned.some(unit => unit.kind === kind);
  const count = (kind: string) => owned.filter(unit => unit.kind === kind).length;
  const ready = (kind: string) => owned.some(unit => unit.kind === kind && unit.constructionRemaining === 0n);
  const refineries = count("refinery");
  const defense = FACTION_DEFENSE[faction];
  const refineryAt = refinerySite(hq, owner, units, nodes);
  const desired = refineryAt && refineries < REFINERIES_FIRST ? "refinery"
    : workers.length >= 4 && !has("barracks") ? "barracks"
    : workers.length >= OPENING_LABOUR && !has("outpost") ? "outpost"
    : ready("barracks") && soldiers.length >= 3 && !has("factory") ? "factory"
    // A second barracks once the factory is under way: with one, every faction
    // floated thousands of material by 3:00 that it had nowhere to spend.
    : has("factory") && count("barracks") < 2 ? "barracks"
    : refineryAt && has("barracks") && refineries < REFINERIES_WANTED ? "refinery"
    // Static defense costs terrazine, a by-product of mining that only builds
    // up over time: each is built when it is affordable, never waited for. The
    // faction's own defense comes first and the shared turret after it.
    : soldiers.length >= 3 && !has(defense) && affords(available, CATALOG[defense].cost) ? defense
    : soldiers.length >= 3 && has(defense) && !has("turret") && affords(available, CATALOG.turret.cost) ? "turret"
    : ready("factory") && !has("lab") ? "lab" : undefined;
  // Command-card construction: the order names the HQ and the site raises
  // itself, so no labour is taken off mining. A command still scheduled for
  // the HQ may be this build, not yet executed, so nothing is placed until it
  // clears; otherwise the one-second delay would place the same building twice.
  if (desired && !busy.has(hq.id) && affords(available, CATALOG[desired].cost)) {
    const point = desired === "refinery" ? refineryAt : buildSite(desired, hq, owner, units, nodes);
    if (point) {
      decisions.push({ units: [hq.id], order: { kind: `build_${desired}`, ...point, target: 0 } });
      available = spend(available, CATALOG[desired].cost);
    }
  }
  // Labour only ever mines material: catalyst comes from the refineries above
  // and the server refuses a gather order on a catalyst deposit. The server
  // also spreads labour across the patches (one miner each), so every idle
  // worker is simply sent to the nearest one.
  const live = nodes.filter(node => node.amount > 0);
  const materialNodes = live.filter(node => currencyOf(node.kind) === "material");
  // Only idle labour is redirected. A drifter that is already gathering is
  // therefore never touched again: it has no return trip, so it stays parked on
  // its deposit for the rest of the match, which is the whole Network model.
  for (const worker of workers.filter(unit => unit.order.kind === "stop" && !busy.has(unit.id))) {
    if (assigned.has(worker.id)) continue;
    // Sending a drifter home is refused by name on the server, and it never
    // holds cargo in the first place, so the return trip is guarded on the
    // carrier model rather than on the cargo field alone.
    if (worker.cargo && carriesCargo(worker.kind)) { decisions.push({ units: [worker.id], order: { kind: "return", x: 0, y: 0, target: 0 } }); continue; }
    const target = nearest(materialNodes, worker);
    if (!target) continue;
    decisions.push({ units: [worker.id], order: { kind: "gather", x: 0, y: 0, target: target.id } });
  }
  // Labour can be queued at any hub now, not only at the HQ, so what is already
  // on order is counted across every building this player owns.
  let labourCount = workers.length + owned.reduce((total, unit) => total + unit.production.filter(item => item.kind === labour).length, 0);
  // The opening builds to a fixed count. Once a barracks is down the workforce
  // grows with the hubs that can feed it, up to a ceiling; past that a hub
  // simply orders nothing, because an army only ever comes from a barracks or
  // a factory.
  const hubs = owned.filter(unit => isHub(unit.kind) && unit.constructionRemaining === 0n).length;
  const labourTarget = has("barracks") ? Math.min(LABOUR_CAP, Math.max(OPENING_LABOUR, LABOUR_PER_HUB * hubs)) : OPENING_LABOUR;
  // Research is instant and global, ordered in the name of the HQ. Tiers come
  // first and in order: tier 1 once a barracks stands, tier 2 once a factory
  // does (tier 3 once a lab does), because the second-tier units below stay
  // locked without them. A technology waits for a finished lab, as it always
  // did, and for the tiers it could buy first.
  const tier = tierOf(researched);
  const nextTier = tier < 3 ? tierOrder(tier + 1) : undefined;
  const technology = Object.keys(TECHNOLOGIES).map(kind => `research_${kind}`).find(kind => !researched.includes(kind));
  const wanted = nextTier && !researchReason(nextTier, researched, owned, owner) ? nextTier
    : technology && ready("lab") && !researchReason(technology, researched, owned, owner) ? technology : undefined;
  // What is wanted but unaffordable the bot saves for; once it has been ordered
  // this pass it stops saving. A command already scheduled for the HQ may be
  // this very purchase, so nothing is ordered until it clears.
  let savingForResearch = !!wanted;
  if (wanted && !busy.has(hq.id) && affords(spendable(), costOf(wanted))) {
    decisions.push({ units: [hq.id], order: { kind: wanted, x: 0, y: 0, target: 0 } });
    available = spend(available, costOf(wanted));
    savingForResearch = false;
  }
  const savingCost = wanted ? costOf(wanted) : RESEARCH_COST;
  // Holding material back for a purchase only makes sense while material is
  // what is missing, and only against another material purchase. The army is
  // paid for in catalyst, so a purchase waiting on material never holds it up,
  // and one waiting on catalyst is waiting on refineries, not on spending.
  const saving = (cost: Cost) => shortfall(available, cost) === "material";
  let population = owned.filter(unit => takesSupply(unit.kind)).length + owned.reduce((total, unit) => total + unit.production.filter(item => !item.kind.startsWith("research_")).length, 0);
  // Stock is spent when the item is queued, so two harvesters asked of the same
  // hub in one pass would see the second refused. It is tracked locally here
  // exactly as currency is.
  const stockLeft = new Map(owned.filter(unit => isHub(unit.kind)).map(unit => [unit.id, unit.stock]));
  // The bot fields its own faction's army: a fighter, some raiders, and the
  // factory's heavy unit, with one more barracks unit and one more factory unit
  // mixed in so the new roster (and its passives) is actually played.
  const [fighter, raider, heavy] = ARMY[faction];
  const [, , barracksExtra, , , factoryExtra] = ROSTER[faction];
  const scouts = soldiers.filter(unit => unit.kind === raider).length;
  const extras = soldiers.filter(unit => unit.kind === barracksExtra).length;
  const heavies = soldiers.filter(unit => unit.kind === heavy).length;
  const factoryExtras = soldiers.filter(unit => unit.kind === factoryExtra).length;
  // What each building would make this pass, or nothing. Every answer is
  // checked against `canProduce`, the mirror of `rules::producer`, so the bot
  // never spends an order on something the server refuses: a hub trains only
  // its faction's labour (an Organic outpost included, an Industrial or Network
  // one not at all), a barracks soldiers and scouts, a factory siege.
  const wantedFrom = (building: string): string | undefined => {
    // A second-tier unit is only asked for once its tier is bought; until
    // then the building makes its first-tier unit.
    const unlocked = (kind: string) => requiredTier(kind) <= tier;
    const kind = isHub(building) ? (labourCount < labourTarget ? labour : undefined)
      : building === "barracks" ? (scouts < soldiers.length / 4 ? raider : extras < soldiers.length / 4 && unlocked(barracksExtra) ? barracksExtra : fighter)
      : building === "factory" ? (factoryExtras < heavies && unlocked(factoryExtra) ? factoryExtra : heavy) : undefined;
    return kind && canProduce(kind, building, faction) ? kind : undefined;
  };
  for (const producer of owned.filter(unit => unit.constructionRemaining === 0n && isBuilding(unit.kind) && !assigned.has(unit.id))) {
    const kind = wantedFrom(producer.kind);
    if (!kind) continue;
    // The opening labour is never held back: it is what pays for everything
    // else. Past it, labour waits on a wanted building exactly as the army does,
    // so a growing workforce cannot starve the barracks it is meant to feed.
    const opening = kind === labour && labourCount < OPENING_LABOUR;
    const usesMaterial = CATALOG[kind].cost.material > 0;
    if (usesMaterial && ((desired && saving(CATALOG[desired].cost) && !opening) || (savingForResearch && saving(savingCost) && !opening))) continue;
    // A harvester is free of currency and bought with one point of this hub's
    // stock. Without this the bot would order one every pass and be refused
    // every pass, because `affords` is trivially true for a price of nothing.
    if (kind === "harvester" && !(stockLeft.get(producer.id) ?? 0)) continue;
    if (affords(spendable(), CATALOG[kind].cost) && producer.production.length < 2 && population < MAX_UNITS) {
      decisions.push({ units: [producer.id], order: { kind: `train_${kind}`, x: 0, y: 0, target: 0 } });
      available = spend(available, CATALOG[kind].cost); population++;
      if (kind === labour) labourCount++;
      if (kind === "harvester") stockLeft.set(producer.id, (stockLeft.get(producer.id) ?? 0) - 1);
    }
  }
  // Hubs, not just the HQ: a player is out only when every completed hub is gone.
  const targets = units.filter(unit => unit.owner !== owner && isHub(unit.kind)).sort((left, right) => Math.hypot(left.x - hq.x, left.y - hq.y) - Math.hypot(right.x - hq.x, right.y - hq.y));
  const idle = soldiers.filter(unit => unit.order.kind === "stop" && !busy.has(unit.id));
  // `holdArmy` keeps the army at home: it still trains and still fights what
  // walks into range, but it is not sent across the map. Practice sets it for
  // the opening minutes so a new player sees an opponent before its first push.
  if (!holdArmy && soldiers.length >= 4 && targets.length && idle.length) {
    const target = targets[0];
    const gap = Math.hypot(hq.x - target.x, hq.y - target.y);
    decisions.push({ units: idle.map(unit => unit.id), order: { kind: "attack_move", x: target.x + (hq.x - target.x) / gap * 90, y: target.y + (hq.y - target.y) / gap * 90, target: 0 } });
  }
  return decisions.slice(0, 6);
}
