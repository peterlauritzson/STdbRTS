import type { Order } from "./bindings/types";
import type { Session } from "./network";
import { isArmy } from "./catalog";
import { BEHAVIORS, isBehavior, type BehaviorKind } from "./behaviors";
import { clampToMap } from "./presentation";

/**
 * Missions: standing, map-anchored objectives ("harass over here", "guard
 * there", "raid that base") that the client keeps staffed for the player.
 * Like operations (src/operations.ts) they use only ordinary orders, one pass a
 * second, after the same command delay as everything else, and live in this
 * tab: close it and nothing keeps staffing them (the units already on a
 * behavior keep running it on the server). A mission's point and size are kept
 * in localStorage per room, so a reload picks them up again.
 *
 * Each pass: dead members drop out; a member the player has re-ordered
 * (its behavior or goal no longer matches the mission) is released and left
 * alone until it is idle again; idle and newly trained army units are dealt
 * to the missions in creation order up to their size, nearest first, then
 * the "rest" missions split what remains. Each group gets one behavior order.
 */

export interface Point { x: number; y: number }
export type MissionSize = number | "rest";
export interface Mission { id: number; kind: BehaviorKind; x: number; y: number; size: MissionSize; members: Set<number> }

export const DEFAULT_SIZE: Readonly<Record<BehaviorKind, MissionSize>> = { harass: 4, guard: 6, raid: "rest" };
/** An order the pass just sent counts as "not yet overridden" for this long, past the command delay. */
export const GRACE_MS = 3500;
/** The server refuses more than 8 orders a tick and 32 pending; one pass stays well inside both. */
export const ORDERS_PER_PASS = 8;
export const PENDING_CEILING = 24;
export const MAX_SIZE = 99;
/** A right-click this close to a mission's point (world units) assigns the selection to it. */
export const MISSION_CLICK_RADIUS = 60;

/** The fields of a unit the mission rules read; a full Entity satisfies it. */
export interface MissionUnit {
  id: number; owner: number; kind: string; x: number; y: number;
  order: { kind: string };
  behavior?: string | undefined;
}
export interface BehaviorGoal { preset: string; x: number; y: number }

const distance = (left: Point, right: Point): number => Math.hypot(left.x - right.x, left.y - right.y);

/** My living army units, the only ones a mission may hold. */
export const myArmy = <T extends MissionUnit>(units: readonly T[], slot: number): T[] => units.filter(unit => unit.owner === slot && isArmy(unit.kind));

/** Nothing to do: no behavior and standing still. */
export const isIdle = (unit: MissionUnit): boolean => !unit.behavior && unit.order.kind === "stop";

/**
 * Whether the player took this member away from its mission: it no longer
 * runs the mission's preset, or runs it toward a different goal (the newest
 * accepted command that named it, when one is known). A unit with an order of
 * ours or the player's still in the command delay is never judged.
 */
export function isOverridden(unit: MissionUnit, mission: Pick<Mission, "kind" | "x" | "y">, goal: BehaviorGoal | undefined, graced: boolean): boolean {
  if (graced) return false;
  if (unit.behavior !== mission.kind) return true;
  return !!goal && goal.preset === mission.kind && distance(goal, mission) > 1;
}

/** Per unit, the newest non-rejected behavior command of mine that named it (goals are not on the unit row). */
export function behaviorGoals(commands: readonly { id: bigint; owner: number; status: string; units: readonly number[]; order: Pick<Order, "kind" | "x" | "y"> }[], slot: number): Map<number, BehaviorGoal & { id: bigint }> {
  const goals = new Map<number, BehaviorGoal & { id: bigint }>();
  for (const command of commands) {
    if (command.owner !== slot || command.status === "rejected" || !isBehavior(command.order.kind)) continue;
    for (const id of command.units) {
      const seen = goals.get(id);
      if (!seen || command.id > seen.id) goals.set(id, { id: command.id, preset: command.order.kind, x: command.order.x, y: command.order.y });
    }
  }
  return goals;
}

export interface PoolContext {
  /** Every unit already in some mission. */
  assigned: ReadonlySet<number>;
  /** Units the player took over and has not left idle since. */
  controlled: ReadonlySet<number>;
  /** Units first seen this pass (newly trained). */
  fresh: ReadonlySet<number>;
  /** Units with an order of the player's or ours still in the command delay. */
  busy: ReadonlySet<number>;
}

/**
 * Who may be recruited: my army, in no mission, not taken over by the player
 * and not mid-order, that is idle or brand new and walking to its rally.
 */
export function recruitPool<T extends MissionUnit>(units: readonly T[], slot: number, context: PoolContext): T[] {
  return myArmy(units, slot).filter(unit => {
    if (context.assigned.has(unit.id) || context.controlled.has(unit.id) || context.busy.has(unit.id)) return false;
    if (unit.behavior) return false;
    return isIdle(unit) || (context.fresh.has(unit.id) && unit.order.kind === "move");
  });
}

export interface Allocation { missionId: number; ids: number[] }

/**
 * Deals the pool out. Numeric missions first, in creation order, each taking
 * its nearest units up to its missing count. Then the remainder is split
 * evenly over the "rest" missions in creation order: each takes the nearest
 * ceil(left / restMissionsLeft) of what is left. Pure; nothing is sent.
 */
export function allocate<T extends MissionUnit>(missions: readonly Mission[], pool: readonly T[], reserve: readonly T[] = []): Allocation[] {
  const left = [...pool];
  const spare = [...reserve];
  const result: Allocation[] = [];
  const nearest = (units: T[], mission: Mission, count: number): number[] => {
    units.sort((a, b) => distance(a, mission) - distance(b, mission) || a.id - b.id);
    return units.splice(0, Math.max(0, count)).map(unit => unit.id);
  };
  const take = (mission: Mission, count: number): void => {
    if (count <= 0 || !left.length) return;
    const taken = nearest(left, mission, count);
    if (taken.length) result.push({ missionId: mission.id, ids: taken });
  };
  // A sized mission is filled from free units first, then from the members of
  // "all rest" missions (`reserve`): those are by definition what is left over,
  // so a Guard placed after a Raid peels units off the raid instead of waiting
  // for new ones.
  for (const mission of missions) {
    if (mission.size === "rest") continue;
    const wanted = mission.size - mission.members.size;
    const taken = [...nearest(left, mission, wanted)];
    taken.push(...nearest(spare, mission, wanted - taken.length));
    if (taken.length) result.push({ missionId: mission.id, ids: taken });
  }
  const rest = missions.filter(mission => mission.size === "rest");
  rest.forEach((mission, index) => take(mission, Math.ceil(left.length / (rest.length - index))));
  return result;
}

/** The members a shrunk mission must give up: the farthest from its point. */
export function excessMembers(mission: Mission, units: ReadonlyMap<number, MissionUnit>): number[] {
  if (mission.size === "rest" || mission.members.size <= mission.size) return [];
  return [...mission.members]
    .sort((a, b) => distance(units.get(b) ?? mission, mission) - distance(units.get(a) ?? mission, mission) || b - a)
    .slice(0, mission.members.size - mission.size);
}

/** "HARASS 3/4", or "RAID 7" for a rest mission. */
export const missionLabel = (mission: Pick<Mission, "kind" | "size" | "members">): string =>
  `${BEHAVIORS[mission.kind].label.toUpperCase()} ${mission.size === "rest" ? mission.members.size : `${mission.members.size}/${mission.size}`}`;

export const clampSize = (size: number): number => Math.max(1, Math.min(MAX_SIZE, Math.round(size)));

/** What a mission looks like on disk, and back. Anything malformed is dropped. */
export function serialize(missions: readonly Mission[], nextId: number): string {
  return JSON.stringify({ nextId, missions: missions.map(mission => ({ id: mission.id, kind: mission.kind, x: mission.x, y: mission.y, size: mission.size, members: [...mission.members] })) });
}
export function parse(text: string | null | undefined): { nextId: number; missions: Mission[] } {
  try {
    const data = JSON.parse(text ?? "") as { nextId?: unknown; missions?: unknown };
    const rows = Array.isArray(data.missions) ? data.missions : [];
    const missions = rows.flatMap((row: Record<string, unknown>): Mission[] => {
      if (!row || !isBehavior(row.kind as string) || typeof row.id !== "number" || typeof row.x !== "number" || typeof row.y !== "number") return [];
      const size = row.size === "rest" ? "rest" : typeof row.size === "number" ? clampSize(row.size) : DEFAULT_SIZE[row.kind as BehaviorKind];
      const members = Array.isArray(row.members) ? row.members.filter((id): id is number => typeof id === "number") : [];
      return [{ id: row.id, kind: row.kind as BehaviorKind, x: row.x, y: row.y, size, members: new Set(members) }];
    });
    return { nextId: typeof data.nextId === "number" ? data.nextId : Math.max(0, ...missions.map(mission => mission.id)) + 1, missions };
  } catch { return { nextId: 1, missions: [] }; }
}

const STORAGE_PREFIX = "stdbrts:missions:";

/** The timer and the bookkeeping around the pure rules above. */
export class Missions {
  list: Mission[] = [];
  onChange: () => void = () => {};
  private nextId = 1;
  private room = 0n;
  private controlled = new Set<number>();
  private known = new Set<number>();
  private sentAt = new Map<number, number>();

  constructor(private session: Session) {
    setInterval(() => this.pass(), 1000);
  }

  /** The mission a click at `point` falls on, if any. */
  at(point: Point): Mission | undefined {
    return this.list.find(mission => distance(mission, point) <= MISSION_CLICK_RADIUS);
  }

  get(id: number): Mission | undefined { return this.list.find(mission => mission.id === id); }

  /** Places a mission; `selected` (army ids) join it first, and a numeric size grows to hold them. */
  add(kind: BehaviorKind, point: Point, selected: readonly number[] = []): Mission {
    const army = this.armyIds(selected);
    const size = DEFAULT_SIZE[kind];
    const mission: Mission = { id: this.nextId++, kind, x: clampToMap(point.x), y: clampToMap(point.y), size: size === "rest" ? size : clampSize(Math.max(size, army.length)), members: new Set() };
    this.list.push(mission);
    if (army.length) this.give(mission, army);
    this.changed();
    this.pass();
    return mission;
  }

  /** Puts these army units into an existing mission, taking them out of any other. */
  assign(id: number, selected: readonly number[]): void {
    const mission = this.get(id);
    const army = this.armyIds(selected);
    if (!mission || !army.length) return;
    if (mission.size !== "rest") mission.size = clampSize(Math.max(mission.size, mission.members.size + army.filter(unit => !mission.members.has(unit)).length));
    this.give(mission, army);
    this.changed();
  }

  setSize(id: number, size: MissionSize): void {
    const mission = this.get(id);
    if (!mission) return;
    mission.size = size === "rest" ? size : clampSize(size);
    this.changed();
    this.pass();
  }

  /** Cancels a mission; its members are stopped, so they are idle and free for the others. */
  remove(id: number): void {
    const mission = this.get(id);
    if (!mission) return;
    this.list = this.list.filter(other => other.id !== id);
    this.free([...mission.members]);
    this.changed();
    this.pass();
  }

  private armyIds(ids: readonly number[]): number[] {
    const { me, units } = this.session.snapshot;
    if (!me) return [];
    const wanted = new Set(ids);
    return myArmy(units, me.slot).filter(unit => wanted.has(unit.id)).map(unit => unit.id);
  }

  /** One behavior order for a group; they become members now, and are given grace until it shows. */
  private give(mission: Mission, ids: number[]): void {
    for (const other of this.list) for (const id of ids) if (other !== mission) other.members.delete(id);
    const now = performance.now();
    for (const id of ids) { mission.members.add(id); this.controlled.delete(id); this.sentAt.set(id, now); }
    const order: Order = { kind: mission.kind, x: mission.x, y: mission.y, target: 0 };
    void this.session.order(ids, order);
  }

  /** Stop these units so their behavior clears and they are idle again. */
  private free(ids: number[]): void {
    if (!ids.length) return;
    const now = performance.now();
    for (const id of ids) this.sentAt.set(id, now);
    void this.session.order(ids, { kind: "stop", x: 0, y: 0, target: 0 });
  }

  private key(room: bigint): string { return `${STORAGE_PREFIX}${room}`; }

  private changed(): void {
    try { if (this.room) localStorage.setItem(this.key(this.room), serialize(this.list, this.nextId)); } catch { /* storage may be unavailable */ }
    this.onChange();
  }

  private drop(room: bigint): void {
    try { localStorage.removeItem(this.key(room)); } catch { /* ignore */ }
  }

  private load(room: bigint): void {
    this.list = []; this.nextId = 1;
    this.controlled.clear(); this.known.clear(); this.sentAt.clear();
    if (room) {
      try {
        for (let index = localStorage.length - 1; index >= 0; index--) {
          const name = localStorage.key(index);
          if (name?.startsWith(STORAGE_PREFIX) && name !== this.key(room)) localStorage.removeItem(name);
        }
        const saved = parse(localStorage.getItem(this.key(room)));
        this.list = saved.missions; this.nextId = saved.nextId;
      } catch { /* storage may be unavailable */ }
    }
    this.onChange();
  }

  private pass(): void {
    const { room, me, units, commands } = this.session.snapshot;
    if ((room?.id ?? 0n) !== this.room) {
      if (!room && this.room && this.session.ready) this.drop(this.room);
      this.room = room?.id ?? 0n;
      this.load(this.room);
    }
    if (!room || !me || !this.session.matchReady) return;
    if (room.state === "finished") { if (this.list.length) { this.drop(room.id); this.list = []; this.onChange(); } return; }
    if (room.state !== "playing") return;
    const mine = myArmy(units, me.slot);
    // The first rows of a match (or after a reconnect) can arrive before the army: never judge a mission by an empty roster.
    if (!units.some(unit => unit.owner === me.slot)) return;
    const byId = new Map<number, MissionUnit>(mine.map(unit => [unit.id, unit]));
    const now = performance.now();
    for (const [id, at] of this.sentAt) if (now - at > GRACE_MS) this.sentAt.delete(id);
    const busy = new Set<number>(this.sentAt.keys());
    for (const command of commands) if (command.owner === me.slot && command.status === "scheduled") for (const id of command.units) busy.add(id);
    for (const pending of this.session.pending.values()) for (const id of pending.units) busy.add(id);

    let changed = false;
    // 1 and 2: the dead drop out; a unit the player re-ordered is released and left alone.
    const goals = behaviorGoals(commands, me.slot);
    for (const mission of this.list) for (const id of [...mission.members]) {
      const unit = byId.get(id);
      if (!unit) { mission.members.delete(id); changed = true; continue; }
      if (isOverridden(unit, mission, goals.get(id), busy.has(id))) { mission.members.delete(id); this.controlled.add(id); changed = true; }
    }
    for (const id of [...this.controlled]) { const unit = byId.get(id); if (!unit || (isIdle(unit) && !busy.has(id))) this.controlled.delete(id); }

    let budget = this.session.pending.size >= PENDING_CEILING ? 0 : ORDERS_PER_PASS;
    // 3: a shrunk mission gives up its farthest members.
    for (const mission of this.list) {
      const extra = excessMembers(mission, byId);
      if (!extra.length || budget <= 0) continue;
      for (const id of extra) mission.members.delete(id);
      this.free(extra); budget--; changed = true;
    }
    // 4 and 5: recruit and send, one order per mission.
    const fresh = new Set<number>();
    if (this.known.size) for (const unit of mine) if (!this.known.has(unit.id)) fresh.add(unit.id);
    for (const unit of mine) this.known.add(unit.id);
    const assigned = new Set<number>(this.list.flatMap(mission => [...mission.members]));
    const pool = recruitPool(mine, me.slot, { assigned, controlled: this.controlled, fresh, busy });
    const leftovers = new Set(this.list.filter(mission => mission.size === "rest").flatMap(mission => [...mission.members]));
    const reserve = mine.filter(unit => leftovers.has(unit.id) && !busy.has(unit.id));
    for (const { missionId, ids } of allocate(this.list, pool, reserve)) {
      const mission = this.get(missionId);
      if (!mission || budget <= 0) continue;
      this.give(mission, ids); budget--; changed = true;
    }
    if (changed) this.changed();
  }
}
