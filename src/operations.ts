import type { Node, Order } from "./bindings/types";
import type { Entity } from "./units";
import type { Session } from "./network";
import { availableAfter, orderCost, pendingSpend } from "./spend";
import { canProduce, CATALOG, currencyOf, gathersInPlace, isBuilding, isCompletedHub, isHub, isLabour, LABOUR, MAX_UNITS, placementError, shortfall, spend, takesSupply, factionOf, type Cost, type FactionName } from "./catalog";

/**
 * Operations: multi-step intents the client carries out for the player, using
 * only the ordinary orders a human would send (a `build_*` in the name of a
 * unit of theirs, a `train_*` at a hub), one pass a second, after the same
 * one-second command delay as everything else. Nothing here talks to the
 * server in any special way, and nothing is remembered outside this tab: close
 * it and the operations are gone, the buildings already ordered are not.
 *
 * The planning and the per-pass decisions are pure functions over a snapshot
 * (`planExpansion`, `stepExpansion`, `autoLabourOrders`); `Operations` at the
 * bottom is the timer and the bookkeeping around them.
 */

export interface Point { x: number; y: number }
export interface Intent { units: number[]; order: Order }

/** Deposits this close together (single-linkage) form one resource site. */
export const CLUSTER_LINK = 400;
/** A site with any hub (anyone's, finished or not) this close to its centre is taken. */
export const HUB_CLEARANCE = 600;
/** The server's build radius: a building must be within this of a finished one of yours. */
export const BUILD_REACH = 500;
/**
 * A patch this close to a finished hub of yours is on that hub's mineral line.
 * Between a main line (140-215 from its hub on every map) and the nearest
 * natural (424 on crossfire), so a natural counts only once it has its own hub.
 */
export const MINING_LINE = 320;
/** The longest hop between chained outposts: inside the server's 500, with a margin for rounding. */
export const CHAIN_STEP = 488;
/** An outpost this close to a deposit would block its refinery (`placementError`'s 110 around any building). */
const REFINERY_CLEARANCE = 112;
/** How close an outpost must stand to a planned link to count as it. */
const LINK_TOLERANCE = 45;
const REFINERIES_WANTED = 2;

/** A resource site: a cluster of deposits and where they centre. */
export interface Cluster { x: number; y: number; materials: Node[]; catalysts: Node[] }

/**
 * Groups the live material and catalyst deposits into sites: deposits within
 * `CLUSTER_LINK` of each other, directly or through a chain of neighbours, are
 * one site. Terrazine is a by-product, not a deposit, and never appears here.
 */
export function depositClusters(nodes: readonly Node[], link = CLUSTER_LINK): Cluster[] {
  const live = nodes.filter(node => node.amount > 0 && ["material", "catalyst"].includes(currencyOf(node.kind)));
  const parent = live.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  for (let left = 0; left < live.length; left++) for (let right = left + 1; right < live.length; right++) {
    if (Math.hypot(live[left].x - live[right].x, live[left].y - live[right].y) <= link) parent[find(left)] = find(right);
  }
  const groups = new Map<number, Node[]>();
  live.forEach((node, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), node]));
  return [...groups.values()].map(members => ({
    x: members.reduce((sum, node) => sum + node.x, 0) / members.length,
    y: members.reduce((sum, node) => sum + node.y, 0) / members.length,
    materials: members.filter(node => currencyOf(node.kind) === "material"),
    catalysts: members.filter(node => currencyOf(node.kind) === "catalyst"),
  }));
}

/** Sites worth a base: they have material to mine and no hub of anyone's already claiming them. */
export function expansionSites(nodes: readonly Node[], units: readonly Entity[]): Cluster[] {
  const hubs = units.filter(unit => isHub(unit.kind));
  return depositClusters(nodes).filter(site => site.materials.length > 0 && !hubs.some(hub => Math.hypot(hub.x - site.x, hub.y - site.y) < HUB_CLEARANCE));
}

/** The site whose centre is nearest `point`, or nothing when there is no site at all. */
export function nearestSite(point: Point, sites: readonly Cluster[]): Cluster | undefined {
  return [...sites].sort((left, right) => Math.hypot(left.x - point.x, left.y - point.y) - Math.hypot(right.x - point.x, right.y - point.y))[0];
}

export interface Plan { site: Cluster; origin: Point; chain: Point[]; refineries: number[] }

/** A stand-in for a planned outpost, so later links are planned around the earlier ones. */
const planned = (owner: number, index: number, point: Point): Entity =>
  ({ id: -1 - index, owner, kind: "outpost", x: point.x, y: point.y, constructionRemaining: 0n } as unknown as Entity);

/**
 * Whether `placementError` would allow an outpost here once it is in reach of
 * a finished building. The build-radius rule is what the chain exists to
 * satisfy, so planning ignores it and `CHAIN_LIMIT` enforces it link by link.
 */
function plannable(x: number, y: number, owner: number, units: Entity[], nodes: Node[]): boolean {
  const error = placementError("outpost", x, y, owner, units, nodes);
  return error === undefined || error === "Outside build radius";
}

/**
 * The outpost chain that takes `site`: from the finished building of yours
 * nearest to it, hops of at most `CHAIN_STEP`, each an outpost on a legal
 * point, the last one 150-250 from the deposits on the side facing your base
 * and clear of the catalyst so its refineries still fit. Nothing is ordered;
 * the caller shows it and `stepExpansion` carries it out.
 */
export function planExpansion(site: Cluster, owner: number, units: readonly Entity[], nodes: readonly Node[]): Plan | { error: string } {
  const all = [...units];
  const homes = all.filter(unit => unit.owner === owner && isBuilding(unit.kind) && unit.constructionRemaining === 0n);
  const origin = [...homes].sort((left, right) => Math.hypot(left.x - site.x, left.y - site.y) - Math.hypot(right.x - site.x, right.y - site.y))[0];
  if (!origin) return { error: "No finished building to expand from" };
  const toward = Math.atan2(origin.y - site.y, origin.x - site.x);
  let spot: Point | undefined;
  // Smallest swing away from "facing home" first, then the distances in order of preference.
  search: for (const swing of [0, 15, -15, 30, -30, 45, -45, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
    for (const reach of [200, 170, 230, 150, 250]) {
      const angle = toward + swing * Math.PI / 180;
      const x = Math.round(site.x + Math.cos(angle) * reach);
      const y = Math.round(site.y + Math.sin(angle) * reach);
      if (site.catalysts.some(node => Math.hypot(node.x - x, node.y - y) < REFINERY_CLEARANCE)) continue;
      if (plannable(x, y, owner, all, nodes as Node[])) { spot = { x, y }; break search; }
    }
  }
  if (!spot) return { error: "No legal spot for an outpost beside those deposits" };
  // Walk from the origin toward the spot, each hop as long as it can be on a
  // legal point: the candidate nearest the spot among a fan of bearings around
  // the straight line. Walls and obstacles are walked around instead of
  // failing the whole plan, and the line is as short as it can be.
  const chain: Point[] = [];
  let previous: Point = origin;
  while (Math.hypot(spot.x - previous.x, spot.y - previous.y) > CHAIN_STEP) {
    const extra = chain.map((point, index) => planned(owner, index, point));
    const link = nextHop(previous, spot, owner, [...all, ...extra], nodes as Node[]);
    if (!link || chain.length >= MAX_CHAIN) return { error: "Could not find a connected line of outposts to that site" };
    chain.push(link);
    previous = link;
  }
  chain.push(spot);
  const refineries = [...site.catalysts].sort((left, right) => Math.hypot(left.x - spot.x, left.y - spot.y) - Math.hypot(right.x - spot.x, right.y - spot.y) || left.id - right.id)
    .slice(0, REFINERIES_WANTED).map(node => node.id);
  return { site, origin: { x: origin.x, y: origin.y }, chain, refineries };
}

/** More links than this is not a plan, it is a map crossing. */
const MAX_CHAIN = 40;

/**
 * The next outpost on the way from `from` to `goal`: of the legal points a
 * hop or less away, within 90 degrees of the straight line, the one nearest the
 * goal. Nothing if no candidate gets meaningfully closer.
 */
function nextHop(from: Point, goal: Point, owner: number, units: Entity[], nodes: Node[]): Point | undefined {
  const heading = Math.atan2(goal.y - from.y, goal.x - from.x);
  const here = Math.hypot(goal.x - from.x, goal.y - from.y);
  let best: Point | undefined;
  let bestLeft = here - 60;
  for (const reach of [CHAIN_STEP, 470, 440, 400, 350]) {
    for (let swing = -90; swing <= 90; swing += 10) {
      const angle = heading + swing * Math.PI / 180;
      const x = Math.round(from.x + Math.cos(angle) * reach);
      const y = Math.round(from.y + Math.sin(angle) * reach);
      const left = Math.hypot(goal.x - x, goal.y - y);
      if (left < bestLeft && plannable(x, y, owner, units, nodes)) { best = { x, y }; bestLeft = left; }
    }
  }
  return best;
}

/** What a pass sees: the snapshot, narrowed to what operations may read. */
export interface View {
  owner: number;
  units: readonly Entity[];
  nodes: readonly Node[];
  /** Your own build/train orders that are sent but not yet executed: scheduled rows and orders still in flight. */
  sent: readonly { units: readonly number[]; order: Order }[];
}

export interface Expansion {
  id: number;
  kind: "expand";
  label: string;
  plan: Plan;
  /** The chain as it stands: a link is re-planned in place if its point stops being legal. */
  chain: Point[];
}

export interface StepResult {
  intents: Intent[];
  /** Steps finished and steps in all: chained outposts, then refineries. */
  done: number;
  total: number;
  /** One line for the Operations list: what it is doing or waiting for. */
  note: string;
  finished: boolean;
  /** True when it is waiting for material, so lower-priority spending can stand aside. */
  starved: boolean;
}

const near = (a: Point, b: Point, within: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= within;

/** Is a `build_<kind>` already sent for this point? An order in the delay is not a building yet. */
function ordered(view: View, kind: string, point: Point): boolean {
  return view.sent.some(sent => sent.order.kind === `build_${kind}` && near(sent.order, point, 5));
}

/**
 * One pass of an expansion. Looks at the world, never at its own memory of what
 * it sent: a link is done when a finished outpost stands on it, in progress when
 * an unfinished one does or its order is still in the delay, and otherwise it is
 * the next thing to place. At most one order per pass, in the name of `issuer`,
 * and none while `issuerBusy`: a build of yours is still waiting out the delay.
 * `available` is what can still be spent; the order's price is taken from it
 * so several operations in one pass do not spend the same material twice.
 */
export function stepExpansion(operation: Expansion, view: View, issuer: Entity | undefined, issuerBusy: boolean, available: Cost): StepResult {
  const { owner, units, nodes } = view;
  const total = operation.chain.length + operation.plan.refineries.length;
  const ownOutposts = units.filter(unit => unit.owner === owner && unit.kind === "outpost");
  const outpostAt = (point: Point) => ownOutposts.find(unit => near(unit, point, LINK_TOLERANCE));
  const linkDone = (point: Point) => outpostAt(point)?.constructionRemaining === 0n;
  const stepsDone = operation.chain.filter(linkDone).length;
  const result = (partial: Partial<StepResult> & { note: string }): StepResult => ({ intents: [], done: stepsDone, total, finished: false, starved: false, ...partial });
  const place = (kind: string, point: Point, cost: Cost, what: string): StepResult => {
    if (shortfall(available, cost)) return result({ note: `Waiting for ${shortfall(available, cost)} (${what})`, starved: shortfall(available, cost) === "material" });
    if (!issuer) return result({ note: "No headquarters to order from" });
    if (issuerBusy) return result({ note: `Placing ${what}` });
    return result({ note: `Placing ${what}`, intents: [{ units: [issuer.id], order: { kind: `build_${kind}`, x: point.x, y: point.y, target: 0 } }] });
  };

  const next = operation.chain.findIndex(point => !linkDone(point));
  if (next >= 0) {
    const point = operation.chain[next];
    const label = `outpost ${next + 1}/${operation.chain.length}`;
    if (outpostAt(point) || ordered(view, "outpost", point)) return result({ note: `Building ${label}` });
    // The point may have been taken since it was planned (a unit standing on it,
    // someone building beside it). Move this link to the nearest legal point in
    // range, or report why it cannot.
    const error = placementError("outpost", point.x, point.y, owner, units as Entity[], nodes as Node[]);
    if (error) {
      const from = next === 0 ? operation.plan.origin : operation.chain[next - 1];
      const home = units.filter(unit => unit.owner === owner && isBuilding(unit.kind) && unit.constructionRemaining === 0n);
      const anchor = [...home].sort((left, right) => Math.hypot(left.x - point.x, left.y - point.y) - Math.hypot(right.x - point.x, right.y - point.y))[0] ?? from;
      const moved = nearLegalLive(point, anchor, owner, units as Entity[], nodes as Node[]);
      if (!moved) return result({ note: `Blocked at ${label}: ${error}` });
      operation.chain[next] = moved;
      return place("outpost", moved, CATALOG.outpost.cost, label);
    }
    return place("outpost", point, CATALOG.outpost.cost, label);
  }

  // Every outpost stands: the refineries, on the site's catalyst deposits.
  const targets = operation.plan.refineries.map(id => nodes.find(node => node.id === id));
  let built = 0;
  let waiting: StepResult | undefined;
  for (const [index, node] of targets.entries()) {
    const label = `refinery ${index + 1}/${targets.length}`;
    if (!node || node.amount === 0) { built++; continue; }
    const refinery = units.find(unit => unit.owner === owner && unit.kind === "refinery" && near(unit, node, 1));
    if (refinery?.constructionRemaining === 0n) { built++; continue; }
    if (refinery || ordered(view, "refinery", node)) { waiting ??= result({ note: `Building ${label}`, done: stepsDone + built }); continue; }
    const error = placementError("refinery", node.x, node.y, owner, units as Entity[], nodes as Node[]);
    // Out of reach of every finished building is permanent for this operation
    // (it will not extend the chain again); anything else may be a unit in the way.
    if (error === "Outside build radius") { built++; continue; }
    if (error) { waiting ??= result({ note: `Waiting to place ${label}: ${error}`, done: stepsDone + built }); continue; }
    if (!waiting?.intents.length) waiting = { ...place("refinery", node, CATALOG.refinery.cost, label), done: stepsDone + built };
  }
  if (waiting) return { ...waiting, done: stepsDone + built };
  return result({ note: "Complete", done: total, finished: true });
}

/** `nearLegal`, but strict: the live rules, build radius included, measured from `anchor`. */
function nearLegalLive(ideal: Point, anchor: Point, owner: number, units: Entity[], nodes: Node[]): Point | undefined {
  for (const ring of [0, 40, 80, 120, 160]) {
    for (let bearing = 0; bearing < (ring === 0 ? 1 : 12); bearing++) {
      const angle = bearing / 12 * Math.PI * 2;
      const x = Math.round(ideal.x + Math.cos(angle) * ring);
      const y = Math.round(ideal.y + Math.sin(angle) * ring);
      if (Math.hypot(x - anchor.x, y - anchor.y) <= CHAIN_STEP && !placementError("outpost", x, y, owner, units, nodes)) return { x, y };
    }
  }
  return undefined;
}

/**
 * Auto-labour: one labour unit at every finished hub with nothing queued, while
 * the workforce is below one per live material patch on your hubs' mineral
 * lines (plus two spare for carriers, which free their patch on every trip
 * home; none for drifters, which hold theirs for good) and the price is covered.
 * A patch takes one miner at a time, so anything past that only queues beside it. A hub is skipped while a train
 * order for it is in the delay, so a pass never orders twice for one empty queue.
 */
export function autoLabourOrders(view: View, faction: FactionName, available: Cost): Intent[] {
  const { owner, units, nodes, sent } = view;
  const labour = LABOUR[faction];
  const own = units.filter(unit => unit.owner === owner);
  const hubs = own.filter(isCompletedHub).sort((left, right) => left.id - right.id);
  const patches = nodes.filter(node => node.amount > 0 && currencyOf(node.kind) === "material" && hubs.some(hub => Math.hypot(hub.x - node.x, hub.y - node.y) <= MINING_LINE));
  const trains = sent.filter(item => item.order.kind.startsWith("train_"));
  let workforce = own.filter(unit => isLabour(unit.kind)).length
    + own.reduce((count, unit) => count + unit.production.filter(item => item.kind === labour).length, 0)
    + trains.filter(item => item.order.kind === `train_${labour}`).length;
  let population = own.filter(unit => takesSupply(unit.kind)).length
    + own.reduce((count, unit) => count + unit.production.filter(item => !item.kind.startsWith("research_")).length, 0)
    + trains.length;
  const cap = patches.length + (gathersInPlace(labour) ? 0 : 2);
  const intents: Intent[] = [];
  let left = available;
  for (const hub of hubs) {
    if (workforce >= cap || population >= MAX_UNITS) break;
    if (hub.production.length > 0 || trains.some(item => item.units.includes(hub.id))) continue;
    if (!canProduce(labour, hub.kind, faction)) continue;
    // A harvester is paid for in hub stock, not currency.
    if (labour === "harvester" && hub.stock <= 0) continue;
    if (shortfall(left, CATALOG[labour].cost)) continue;
    intents.push({ units: [hub.id], order: { kind: `train_${labour}`, x: 0, y: 0, target: 0 } });
    left = spend(left, CATALOG[labour].cost);
    workforce++; population++;
  }
  return intents;
}

/** A planned chain as the map draws it: where it starts, its numbered links, and how many are finished. */
export interface OverlayPath { origin: Point; points: Point[]; done: number }

/**
 * The timer and bookkeeping around the pure steps. Runs a pass a second while
 * a match is being played, clears everything when the match changes or ends,
 * and orders through the ordinary `Session.order`.
 */
export class Operations {
  list: (Expansion & { done: number; total: number; note: string })[] = [];
  onChange: () => void = () => {};
  private nextId = 1;
  private room = 0n;
  private auto = new Map<bigint, boolean>();
  private previews = new Map<string, Plan | { error: string }>();

  constructor(private session: Session, private issuer: () => Entity | undefined) {
    setInterval(() => this.pass(), 1000);
  }

  /** Auto-labour is saved for this match only, in memory. */
  get autoLabour(): boolean { return this.auto.get(this.room) ?? false; }

  toggleAutoLabour(): boolean {
    this.auto.set(this.room, !this.autoLabour);
    this.onChange();
    return this.autoLabour;
  }

  private view(): View | undefined {
    const { me, units, nodes, commands } = this.session.snapshot;
    if (!me) return undefined;
    const sent = [
      ...commands.filter(command => command.owner === me.slot && command.status === "scheduled").map(command => ({ units: command.units, order: command.order })),
      ...[...this.session.pending.values()].map(pending => ({ units: pending.units, order: pending.order })),
    ];
    return { owner: me.slot, units, nodes, sent };
  }

  /** Plans an expansion toward the site nearest `point`. Returns why it could not, or nothing on success. */
  begin(point: Point): string | undefined {
    const view = this.view();
    if (!view) return "Not in a match";
    const sites = expansionSites(view.nodes, view.units).filter(site => !this.list.some(operation => near(operation.plan.site, site, 300)));
    const site = nearestSite(point, sites);
    if (!site) return this.list.length ? "No other free resource site on the map" : "No free resource site on the map";
    const plan = planExpansion(site, view.owner, view.units, view.nodes);
    if ("error" in plan) return plan.error;
    this.list.push({ id: this.nextId++, kind: "expand", label: `Expand to ${Math.round(site.x)}, ${Math.round(site.y)}`, plan, chain: plan.chain.map(link => ({ ...link })), done: 0, total: plan.chain.length + plan.refineries.length, note: "Planned" });
    this.onChange();
    this.pass();
    return undefined;
  }

  cancel(id: number): void {
    this.list = this.list.filter(operation => operation.id !== id);
    this.onChange();
  }

  /** The chain an expansion armed at `point` would build, for the preview under the cursor. Cached per site. */
  preview(point: Point): OverlayPath | undefined {
    const view = this.view();
    if (!view) return undefined;
    const sites = expansionSites(view.nodes, view.units);
    const site = nearestSite(point, sites);
    if (!site) return undefined;
    const buildings = view.units.filter(unit => unit.owner === view.owner && isBuilding(unit.kind)).length;
    const key = `${Math.round(site.x)},${Math.round(site.y)}:${buildings}`;
    let plan = this.previews.get(key);
    if (!plan) { if (this.previews.size > 20) this.previews.clear(); plan = planExpansion(site, view.owner, view.units, view.nodes); this.previews.set(key, plan); }
    return "error" in plan ? undefined : { origin: plan.origin, points: plan.chain, done: 0 };
  }

  /** Every running expansion's chain, for the map and the minimap. */
  paths(): OverlayPath[] {
    return this.list.map(operation => ({ origin: operation.plan.origin, points: operation.chain, done: Math.min(operation.done, operation.chain.length) }));
  }

  private pass(): void {
    const { room, me, matchReady } = { ...this.session.snapshot, matchReady: this.session.matchReady };
    if ((room?.id ?? 0n) !== this.room) {
      this.room = room?.id ?? 0n;
      this.list = [];
      this.previews.clear();
      this.onChange();
    }
    if (!room || !me || !matchReady || room.state !== "playing") {
      if (this.list.length && room?.state === "finished") { this.list = []; this.onChange(); }
      return;
    }
    const view = this.view();
    const issuer = this.issuer();
    if (!view || !issuer) return;
    let available = availableAfter({ material: me.material, catalyst: me.catalyst, terrazine: me.terrazine }, pendingSpend(this.session.snapshot.commands, this.session.pending.values(), me.slot));
    // A build of yours still in the delay holds the issuer: the same build must not be ordered twice.
    let busy = view.sent.some(item => item.order.kind.startsWith("build_") && item.units.includes(issuer.id));
    let starved = false;
    let changed = false;
    for (const operation of [...this.list]) {
      const step = stepExpansion(operation, view, issuer, busy, available);
      if (step.done !== operation.done || step.note !== operation.note || step.total !== operation.total) changed = true;
      operation.done = step.done; operation.total = step.total; operation.note = step.note;
      starved ||= step.starved;
      for (const intent of step.intents) {
        void this.session.order(intent.units, intent.order);
        available = availableAfter(available, orderCost(intent.order.kind));
        busy = true;
      }
      if (step.finished) { this.list = this.list.filter(other => other.id !== operation.id); this.session.onNotice(`${operation.label} complete`); changed = true; }
    }
    // Expansions come first: labour waits a pass while one is short of material.
    if (this.autoLabour && !starved) {
      const sentNow = [...view.sent];
      for (const intent of autoLabourOrders({ ...view, sent: sentNow }, factionOf(me.faction), available)) {
        void this.session.order(intent.units, intent.order);
        available = availableAfter(available, orderCost(intent.order.kind));
      }
    }
    if (changed) this.onChange();
  }
}
