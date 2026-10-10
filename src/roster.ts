import { CATALOG, isArmy, isCompletedHub } from "./catalog";
import { BEHAVIORS, isBehavior } from "./behaviors";

/** The fields of a unit row the roster reads; a full Entity satisfies it. */
export interface RosterUnit {
  id: number; owner: number; kind: string; x: number; y: number;
  order: { kind: string };
  behavior?: string | undefined; behaviorState?: string | undefined;
}
export interface RosterHub { kind: string; x: number; y: number; owner?: number; constructionRemaining: bigint }

export type Where = "base" | "field";
export interface RosterRow {
  activity: string;
  /** Sort rank: 0 fighting, 1 moving, 2 holding, 3 idle, 4 anything else. */
  rank: number;
  ids: number[];
  count: number;
  composition: string;
  centroid: { x: number; y: number };
  location: Where;
  /** Idle in the field: the forgotten units. */
  forgotten: boolean;
}

export const CLUSTER_RANGE = 400;
export const BASE_RANGE = 600;
export const MAX_ROWS = 6;

const ORDER_ACTIVITY: Readonly<Record<string, [string, number]>> = {
  attack_move: ["Attack-moving", 0], attack: ["Attacking", 0], move: ["Moving", 1], hold: ["Holding", 2], stop: ["Idle", 3],
};

/** What a unit is doing, in words, and where that sorts. A running behavior preset wins over its raw order. */
export function activityOf(unit: Pick<RosterUnit, "order" | "behavior" | "behaviorState">): [string, number] {
  if (isBehavior(unit.behavior)) return [BEHAVIORS[unit.behavior].label, 0];
  const known = ORDER_ACTIVITY[unit.order.kind];
  if (known) return known;
  const words = unit.order.kind.split("_").join(" ");
  return [words.charAt(0).toUpperCase() + words.slice(1), 4];
}

/** "5 Soldier · 2 Scout": most numerous kind first, ties by label. */
export function composition(kinds: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => ({ label: CATALOG[kind]?.label ?? kind, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .map(entry => `${entry.count} ${entry.label}`).join(" · ");
}

/** Single-link clusters: units chained by gaps <= range. Deterministic: seeded in id order, members returned in id order. */
export function cluster<T extends { id: number; x: number; y: number }>(units: readonly T[], range = CLUSTER_RANGE): T[][] {
  const sorted = [...units].sort((left, right) => left.id - right.id);
  const taken = new Set<number>();
  const groups: T[][] = [];
  for (const seed of sorted) {
    if (taken.has(seed.id)) continue;
    const group = [seed]; taken.add(seed.id);
    for (let next = 0; next < group.length; next++) {
      for (const other of sorted) {
        if (!taken.has(other.id) && Math.hypot(other.x - group[next].x, other.y - group[next].y) <= range) { taken.add(other.id); group.push(other); }
      }
    }
    groups.push(group.sort((left, right) => left.id - right.id));
  }
  return groups;
}

/** All my army (`missionActivity`: unit id to its mission's label), grouped by activity then spatial cluster, ordered fighting, moving, holding, idle (field before base), biggest first. */
export function armyRoster(units: readonly RosterUnit[], slot: number, hubs: readonly RosterHub[] = [], missionActivity: ReadonlyMap<number, string> = new Map()): RosterRow[] {
  const mine = units.filter(unit => unit.owner === slot && isArmy(unit.kind));
  const byActivity = new Map<string, { rank: number; members: RosterUnit[] }>();
  for (const unit of mine) {
    // A mission member is labelled by its mission ("Gather", "Strike", "Harass"), not by the preset the mission runs on it.
    const [preset, rank] = activityOf(unit);
    const activity = missionActivity.get(unit.id) ?? preset;
    const entry = byActivity.get(activity) ?? { rank, members: [] };
    entry.members.push(unit); byActivity.set(activity, entry);
  }
  const homes = hubs.filter(isCompletedHub);
  const rows: RosterRow[] = [];
  for (const [activity, { rank, members }] of byActivity) {
    for (const group of cluster(members)) {
      const centroid = { x: group.reduce((sum, unit) => sum + unit.x, 0) / group.length, y: group.reduce((sum, unit) => sum + unit.y, 0) / group.length };
      const location: Where = homes.some(hub => Math.hypot(hub.x - centroid.x, hub.y - centroid.y) <= BASE_RANGE) ? "base" : "field";
      rows.push({ activity, rank, ids: group.map(unit => unit.id), count: group.length, composition: composition(group.map(unit => unit.kind)), centroid, location, forgotten: rank === 3 && location === "field" });
    }
  }
  return rows.sort((left, right) => left.rank - right.rank || right.count - left.count || left.ids[0] - right.ids[0]);
}

/** The rows shown and how many were cut. */
export function visibleRows(rows: readonly RosterRow[], max = MAX_ROWS): { shown: RosterRow[]; more: number } {
  // Forgotten units must never fall off the end of the list.
  const shown = rows.slice(0, max);
  for (const row of rows.slice(max)) if (row.forgotten) shown.push(row);
  return { shown, more: rows.length - shown.length };
}
