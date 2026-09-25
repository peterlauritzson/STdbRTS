import type { Entity, Node, Order } from "../src/bindings/types";
import { affords, ARMY, canProduce, CATALOG, carriesCargo, currencyOf, isArmy, isBuilding, isHub, isLabour, LABOUR, MAX_UNITS, placementError, RESEARCH_COST, shortfall, spend, takesSupply, TECHNOLOGIES, type Cost, type FactionName } from "../src/catalog";

export interface Decision { units: number[]; order: Order }

/** Material held back so a repair pulse is always payable. */
const REPAIR_RESERVE = 20;
/** Labour kept on catalyst once the opening labour count is reached. */
const CATALYST_MINERS = 2;
const CATALYST_MINER_THRESHOLD = 4;
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
 * The practice opponent's policy. It sees exactly what any authenticated
 * client sees — the public unit, node and command rows of its own match — and
 * decides from `balance`, which is its own two-currency purse. Both currencies
 * must cover a price; nothing here may assume one can stand in for the other.
 *
 * `faction` is the one the server dealt this slot, read from the bot's own
 * `Player` row exactly as any other client would read it. It decides which
 * labour unit is trained and how that labour is handled afterwards: a drifter
 * is left standing on its deposit instead of being cycled home, and a harvester
 * is paid for in hub stock, which is checked here so the bot never spends a
 * pass on orders the server would refuse.
 */
export function chooseOrders(owner: number, faction: FactionName, balance: Cost, units: Entity[], nodes: Node[], busy: Set<number>, holdArmy = false): Decision[] {
  const owned = units.filter(unit => unit.owner === owner);
  const hq = owned.find(unit => unit.kind === "hq");
  if (!hq) return [];
  const decisions: Decision[] = [];
  const labour = LABOUR[faction];
  // Its own labour is all a faction can ever have, but filtering on `isLabour`
  // keeps the rest of this policy true of whatever labour it is holding.
  const workers = owned.filter(unit => isLabour(unit.kind));
  const soldiers = owned.filter(unit => isArmy(unit.kind));
  const assigned = new Set(busy);
  let available: Cost = { material: balance.material, catalyst: balance.catalyst };
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
  const spendable = (): Cost => ({ material: Math.max(0, available.material - reserve), catalyst: available.catalyst });
  const has = (kind: string) => owned.some(unit => unit.kind === kind);
  const count = (kind: string) => owned.filter(unit => unit.kind === kind).length;
  const ready = (kind: string) => owned.some(unit => unit.kind === kind && unit.constructionRemaining === 0n);
  const desired = workers.length >= 4 && !has("barracks") ? "barracks"
    : workers.length >= OPENING_LABOUR && !has("outpost") ? "outpost"
    : ready("barracks") && soldiers.length >= 3 && !has("factory") ? "factory"
    // A second barracks once the factory is under way: with one, every faction
    // floated thousands of material by 3:00 that it had nowhere to spend.
    : has("factory") && count("barracks") < 2 ? "barracks"
    : soldiers.length >= 3 && !has("turret") ? "turret"
    : ready("factory") && !has("lab") ? "lab" : undefined;
  // Command-card construction: the order names the HQ and the site raises
  // itself, so no labour is taken off mining. A command still scheduled for
  // the HQ may be this build, not yet executed, so nothing is placed until it
  // clears; otherwise the one-second delay would place the same building twice.
  if (desired && !busy.has(hq.id) && affords(available, CATALOG[desired].cost)) {
    const point = buildSite(desired, hq, owner, units, nodes);
    if (point) {
      decisions.push({ units: [hq.id], order: { kind: `build_${desired}`, ...point, target: 0 } });
      available = spend(available, CATALOG[desired].cost);
    }
  }
  // Catalyst has to be mined deliberately: it is nowhere near a start position
  // and nothing else produces it, so a fixed share of the workforce is posted
  // to it once the opening worker count is up. Without this the bot can never
  // buy a factory, a laboratory, siege or any technology.
  const live = nodes.filter(node => node.amount > 0);
  const catalystNodes = live.filter(node => currencyOf(node.kind) === "catalyst");
  const materialNodes = live.filter(node => currencyOf(node.kind) === "material");
  const onCatalyst = (worker: Entity) => worker.order.kind === "gather" && catalystNodes.some(node => node.id === worker.order.target);
  let miners = workers.filter(onCatalyst).length;
  const wanted = workers.length >= CATALYST_MINER_THRESHOLD ? CATALYST_MINERS : 0;
  // Only idle labour is redirected. A drifter that is already gathering is
  // therefore never touched again: it has no return trip, so it stays parked on
  // its deposit for the rest of the match, which is the whole Network model.
  for (const worker of workers.filter(unit => unit.order.kind === "stop" && !busy.has(unit.id))) {
    if (assigned.has(worker.id)) continue;
    // Sending a drifter home is refused by name on the server, and it never
    // holds cargo in the first place, so the return trip is guarded on the
    // carrier model rather than on the cargo field alone.
    if (worker.cargo && carriesCargo(worker.kind)) { decisions.push({ units: [worker.id], order: { kind: "return", x: 0, y: 0, target: 0 } }); continue; }
    const wantsCatalyst = miners < wanted && catalystNodes.length > 0;
    const target = nearest(wantsCatalyst ? catalystNodes : materialNodes.length ? materialNodes : catalystNodes, worker);
    if (!target) continue;
    decisions.push({ units: [worker.id], order: { kind: "gather", x: 0, y: 0, target: target.id } });
    if (currencyOf(target.kind) === "catalyst") miners++;
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
  const technology = Object.keys(TECHNOLOGIES).find(kind => !hq.research.includes(`research_${kind}`) && !owned.some(unit => unit.production.some(item => item.kind === `research_${kind}`)));
  const lab = owned.find(unit => unit.kind === "lab" && unit.constructionRemaining === 0n && unit.production.length === 0 && !assigned.has(unit.id));
  // Technology costs both currencies. If it is wanted but unaffordable the bot
  // saves for it; once it has been ordered this turn it stops saving, so a
  // catalyst-poor turn never freezes unit production outright.
  let savingForResearch = !!(lab && technology);
  if (lab && technology && affords(spendable(), RESEARCH_COST)) {
    decisions.push({ units: [lab.id], order: { kind: `research_${technology}`, x: 0, y: 0, target: 0 } });
    available = spend(available, RESEARCH_COST);
    savingForResearch = false;
  }
  // Holding material back for a purchase only makes sense while material is
  // what is missing. A purchase waiting on catalyst is waiting on mining, not
  // on spending, so the army keeps being built in the meantime — otherwise a
  // catalyst shortage would quietly stop the opponent from playing.
  const saving = (cost: Cost) => shortfall(available, cost) === "material";
  let population = owned.filter(unit => takesSupply(unit.kind)).length + owned.reduce((total, unit) => total + unit.production.filter(item => !item.kind.startsWith("research_")).length, 0);
  // Stock is spent when the item is queued, so two harvesters asked of the same
  // hub in one pass would see the second refused. It is tracked locally here
  // exactly as currency is.
  const stockLeft = new Map(owned.filter(unit => isHub(unit.kind)).map(unit => [unit.id, unit.stock]));
  // The bot fields its own faction's army: a fighter, some raiders, and the
  // factory's heavy unit.
  const [fighter, raider, heavy] = ARMY[faction];
  const scouts = soldiers.filter(unit => unit.kind === raider).length;
  // What each building would make this pass, or nothing. Every answer is
  // checked against `canProduce`, the mirror of `rules::producer`, so the bot
  // never spends an order on something the server refuses: a hub trains only
  // its faction's labour (an Organic outpost included, an Industrial or Network
  // one not at all), a barracks soldiers and scouts, a factory siege.
  const wantedFrom = (building: string): string | undefined => {
    const kind = isHub(building) ? (labourCount < labourTarget ? labour : undefined)
      : building === "barracks" ? (scouts < soldiers.length / 4 ? raider : fighter)
      : building === "factory" ? heavy : undefined;
    return kind && canProduce(kind, building, faction) ? kind : undefined;
  };
  for (const producer of owned.filter(unit => unit.constructionRemaining === 0n && isBuilding(unit.kind) && !assigned.has(unit.id))) {
    const kind = wantedFrom(producer.kind);
    if (!kind) continue;
    // The opening labour is never held back: it is what pays for everything
    // else. Past it, labour waits on a wanted building exactly as the army does,
    // so a growing workforce cannot starve the barracks it is meant to feed.
    const opening = kind === labour && labourCount < OPENING_LABOUR;
    if ((desired && saving(CATALOG[desired].cost) && !opening) || (savingForResearch && saving(RESEARCH_COST) && !opening)) continue;
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
  const targets = units.filter(unit => unit.owner !== owner && unit.kind === "hq").sort((left, right) => Math.hypot(left.x - hq.x, left.y - hq.y) - Math.hypot(right.x - hq.x, right.y - hq.y));
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
