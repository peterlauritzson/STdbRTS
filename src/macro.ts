import type { Node } from "./bindings/types";
import { currencyOf, isCompletedHub, isLabour, placementError } from "./catalog";
import type { Entity } from "./units";

/** A point on the map. */
export interface Site { x: number; y: number }

/** Farthest a snapped building may land from where it was aimed. */
export const SNAP_RADIUS = 160;
const SNAP_STEP = 16;
const SNAP_ANGLES = 12;
/** Refusals a nudge can cure. Radius, limit and tech refusals are never snapped around. */
const SNAPPABLE = new Set(["Site occupied", "Enemy units block the site", "Terrain obstructed", "Map boundary"]);

/**
 * Where a building aimed at `(x, y)` can stand: the aim itself when valid,
 * else the closest valid spot on rings out to `SNAP_RADIUS`. Undefined when
 * the aim is refused for a reason a nudge cannot fix, or nothing near is valid.
 * Refineries snap onto their deposit already, so they are never nudged.
 */
export function snapSite(kind: string, x: number, y: number, owner: number, units: Entity[], nodes: Node[]): Site | undefined {
  const error = placementError(kind, x, y, owner, units, nodes);
  if (!error) return { x, y };
  if (kind === "refinery" || !SNAPPABLE.has(error)) return undefined;
  for (let radius = SNAP_STEP, ring = 0; radius <= SNAP_RADIUS; radius += SNAP_STEP, ring++) {
    const offset = ring * 0.37;
    for (let step = 0; step < SNAP_ANGLES; step++) {
      const angle = offset + (step / SNAP_ANGLES) * Math.PI * 2;
      const cx = x + Math.cos(angle) * radius, cy = y + Math.sin(angle) * radius;
      if (!placementError(kind, cx, cy, owner, units, nodes)) return { x: cx, y: cy };
    }
  }
  return undefined;
}

/** Farthest a material patch can be from a hub and still count as that hub's. */
export const BASE_RADIUS = 600;
/** One base's saturation: labour mining its patches (one miner each), its patch count, idle labour nearest it. */
export interface BaseSaturation { hub: Entity; mining: number; patches: number; idle: number }

const distance = (a: Site, b: Site): number => Math.hypot(a.x - b.x, a.y - b.y);
const minable = (node: Node): boolean => node.amount > 0 && currencyOf(node.kind) === "material";

/** Your completed hubs. */
export const ownHubs = (units: Entity[], slot: number): Entity[] => units.filter(unit => unit.owner === slot && isCompletedHub(unit));

/** Idle labour of `slot`: it stands with a `stop` order. */
export const idleLabour = (units: Entity[], slot: number): Entity[] =>
  units.filter(unit => unit.owner === slot && isLabour(unit.kind) && unit.order.kind === "stop");

/** Each hub's material patches: a patch belongs to the nearest hub, if within `BASE_RADIUS`. */
export function hubPatches(hubs: Entity[], nodes: Node[]): Map<number, Node[]> {
  const result = new Map<number, Node[]>(hubs.map(hub => [hub.id, []]));
  for (const node of nodes) {
    if (!minable(node)) continue;
    let best: Entity | undefined, bestDistance = BASE_RADIUS;
    for (const hub of hubs) {
      const gap = distance(hub, node);
      if (gap <= bestDistance) { best = hub; bestDistance = gap; }
    }
    if (best) result.get(best.id)!.push(node);
  }
  return result;
}

/**
 * Per completed hub: labour on a gather order aimed at one of its patches (the
 * order stays `gather` through the walk home, so this does not flicker),
 * the patch count, and idle labour whose nearest hub this is.
 */
export function baseSaturation(units: Entity[], nodes: Node[], slot: number): BaseSaturation[] {
  const hubs = ownHubs(units, slot);
  if (!hubs.length) return [];
  const patches = hubPatches(hubs, nodes);
  const owner = new Map<number, number>();
  for (const [hubId, list] of patches) for (const node of list) owner.set(node.id, hubId);
  const rows = new Map<number, BaseSaturation>(hubs.map(hub => [hub.id, { hub, mining: 0, patches: patches.get(hub.id)!.length, idle: 0 }]));
  for (const unit of units) {
    if (unit.owner !== slot || !isLabour(unit.kind)) continue;
    if (unit.order.kind === "gather") {
      const hubId = owner.get(unit.order.target);
      if (hubId !== undefined) rows.get(hubId)!.mining++;
    } else if (unit.order.kind === "stop") {
      let best = hubs[0];
      for (const hub of hubs) if (distance(hub, unit) < distance(best, unit)) best = hub;
      rows.get(best.id)!.idle++;
    }
  }
  return [...rows.values()];
}

/** The base a labour unit works at, by its gather target; undefined when it is not gathering. */
export const baseOf = (unit: Entity, patches: Map<number, Node[]>): number | undefined => {
  if (unit.order.kind !== "gather") return undefined;
  for (const [hubId, list] of patches) if (list.some(node => node.id === unit.order.target)) return hubId;
  return undefined;
};

/**
 * Spreads `workers` over `patches` (a target base's material patches): a worker
 * takes the nearest patch nobody mines or is headed to (`taken`), closest pairs
 * first. Workers beyond the free patches are dealt round-robin over the patches
 * nearest `hub`, where the server makes them wait for or find a free one.
 * Returns patch id -> worker ids.
 */
export function assignPatches(workers: Entity[], patches: Node[], taken: Set<number>, hub: Site): Map<number, number[]> {
  const result = new Map<number, number[]>();
  if (!patches.length) return result;
  const free = patches.filter(node => node.miner === 0 && !taken.has(node.id));
  const pairs: { worker: Entity; node: Node; gap: number }[] = [];
  for (const worker of workers) for (const node of free) pairs.push({ worker, node, gap: distance(worker, node) });
  pairs.sort((left, right) => left.gap - right.gap || left.worker.id - right.worker.id || left.node.id - right.node.id);
  const placed = new Set<number>(), used = new Set<number>();
  for (const { worker, node } of pairs) {
    if (placed.has(worker.id) || used.has(node.id)) continue;
    placed.add(worker.id); used.add(node.id);
    result.set(node.id, [worker.id]);
  }
  const near = [...patches].sort((left, right) => distance(hub, left) - distance(hub, right) || left.id - right.id);
  let next = 0;
  for (const worker of workers) {
    if (placed.has(worker.id)) continue;
    const node = near[next++ % near.length];
    result.set(node.id, [...(result.get(node.id) ?? []), worker.id]);
  }
  return result;
}

/** Patches of `hub`'s base already targeted or mined by labour outside `moving`. */
export function takenPatches(units: Entity[], slot: number, patches: Node[], moving: Set<number>): Set<number> {
  const ids = new Set(patches.map(node => node.id));
  const taken = new Set<number>();
  for (const unit of units) {
    if (unit.owner !== slot || !isLabour(unit.kind) || moving.has(unit.id)) continue;
    if (unit.order.kind === "gather" && ids.has(unit.order.target)) taken.add(unit.order.target);
  }
  return taken;
}
