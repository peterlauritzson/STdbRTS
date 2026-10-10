import type { MissionRow, Order } from "./bindings/types";
import type { Session } from "./network";
import { isArmy } from "./catalog";
import { BEHAVIORS, type BehaviorKind } from "./behaviors";
import { clampToMap } from "./presentation";

/**
 * Missions: standing, map-anchored objectives ("harass over here", "guard
 * there", "gather, then strike that base") that the SERVER keeps staffed
 * (server/src/mission.rs, the `mission` table). They keep running with this
 * tab closed. The client only reads its own `mission` rows to draw and list
 * them, and sends `mission_*` commands through the ordinary delayed command
 * path to create, resize, retarget or cancel them.
 *
 * Staffing rules live on the server: dead members drop out; a unit the player
 * orders leaves its mission at that moment; idle army units are dealt to the
 * missions in creation order up to their size, nearest first, then the "rest"
 * missions share what remains; a shrunk mission stops its farthest extras.
 */

export interface Point { x: number; y: number }
export type MissionSize = number | "rest";
export type Tactic = "harass" | "guard" | "raid" | "rush" | "gather";

export interface TacticInfo {
  id: Tactic;
  /** Panel and button name. */
  label: string;
  /** The per-unit preset members run while the mission holds its point (a gather mission also gathers under guard). */
  preset: BehaviorKind;
  color: string;
  hint: string;
  defaultSize: MissionSize;
}

/** Every tactic, in the order the picker lists them. `raid` keeps its id (and order kinds) but reads "Hit & retreat". */
export const TACTICS: Readonly<Record<Tactic, TacticInfo>> = {
  harass: { id: "harass", label: "Harass", preset: "harass", color: BEHAVIORS.harass.color, defaultSize: 4, hint: BEHAVIORS.harass.hint },
  guard: { id: "guard", label: "Guard", preset: "guard", color: BEHAVIORS.guard.color, defaultSize: 6, hint: BEHAVIORS.guard.hint },
  raid: { id: "raid", label: "Hit & retreat", preset: "raid", color: BEHAVIORS.raid.color, defaultSize: "rest", hint: "Hit & retreat: push to the point; each unit retreats home below 35% health, recovers to 90%, then pushes again" },
  rush: { id: "rush", label: "Rush", preset: "assault", color: BEHAVIORS.assault.color, defaultSize: "rest", hint: "Rush: attack-move to the point and never retreat" },
  gather: { id: "gather", label: "Gather then strike", preset: "assault", color: "#c9b2ff", defaultSize: "rest", hint: "Gather then strike: gather at a rally point short of the point; once enough are there, attack-move to the point; fall back to the rally if the strike loses most of its strength, then gather again" },
};
export const TACTIC_IDS = Object.keys(TACTICS) as Tactic[];
export const isTactic = (value: string | undefined): value is Tactic => !!value && value in TACTICS;

export const MAX_MISSIONS = 16;
export const MAX_SIZE = 99;
export const MIN_PERCENT = 10;
export const MAX_PERCENT = 100;
export const PERCENT_STEP = 10;
/** The least a member may be from the rally and still count as gathered (server/src/mission.rs). */
export const RALLY_RADIUS = 250;
/** The gathered radius grows with the mission so a big force can fit around the rally: max(250, 70 * sqrt(members)). */
export const gatherRadius = (members: number): number => Math.max(RALLY_RADIUS, 70 * Math.sqrt(members));
/** A right-click this close to a mission's point (world units) assigns the selection to it. */
export const MISSION_CLICK_RADIUS = 60;

export interface Mission {
  id: number;
  tactic: Tactic;
  x: number;
  y: number;
  size: MissionSize;
  /** For gather: "gather", "strike", "fallback" or "defend" (gatherers answering a threat to one of my buildings). Empty for the other tactics. */
  state: string;
  rally: Point;
  gatherPercent: number;
  fallbackPercent: number;
  members: Set<number>;
}

/** My missions from the subscribed rows, in creation order. Rows of an unknown tactic (a newer server) are skipped. */
export function ownMissions(rows: readonly MissionRow[], slot: number | undefined): Mission[] {
  if (slot === undefined) return [];
  return rows
    .filter(row => row.owner === slot && isTactic(row.tactic))
    .sort((left, right) => left.id - right.id)
    .map(row => ({
      id: row.id, tactic: row.tactic as Tactic, x: row.x, y: row.y,
      size: row.size < 0 ? "rest" : row.size,
      state: row.state, rally: { x: row.rallyX, y: row.rallyY },
      gatherPercent: row.gatherPercent, fallbackPercent: row.fallbackPercent,
      members: new Set(row.members),
    }));
}

const distance = (left: Point, right: Point): number => Math.hypot(left.x - right.x, left.y - right.y);

/** The mission whose marker a click at `point` falls on, if any. */
export const missionAt = (list: readonly Mission[], point: Point): Mission | undefined => list.find(mission => distance(mission, point) <= MISSION_CLICK_RADIUS);

/** Members that must be gathered before a gather mission strikes: ceil(size * share) for a number, at least 8 * share for "rest" (server/src/mission.rs). */
export function gatherNeeded(mission: Pick<Mission, "size" | "members" | "gatherPercent">): number {
  return mission.size === "rest"
    ? Math.max(8, Math.ceil(mission.members.size * mission.gatherPercent / 100))
    : Math.max(1, Math.ceil(mission.size * mission.gatherPercent / 100));
}

/**
 * "HARASS 3/4", "RAID 7" for a rest mission; a gather mission shows its state:
 * "GATHER 5/8" (members gathered at the rally over the number needed to strike,
 * when `gathered` is known; else members over size), "STRIKE 7", "DEFEND 5", "FALL BACK".
 */
export function missionLabel(mission: Pick<Mission, "tactic" | "size" | "members" | "state"> & Partial<Pick<Mission, "gatherPercent">>, gathered?: number): string {
  const count = mission.size === "rest" ? `${mission.members.size}` : `${mission.members.size}/${mission.size}`;
  if (mission.tactic === "gather") {
    if (mission.state === "strike") return `STRIKE ${mission.members.size}`;
    if (mission.state === "defend") return `DEFEND ${mission.members.size}`;
    if (mission.state === "fallback") return "FALL BACK";
    if (gathered !== undefined && mission.gatherPercent !== undefined) return `GATHER ${gathered}/${gatherNeeded({ size: mission.size, members: mission.members, gatherPercent: mission.gatherPercent })}`;
    return `GATHER ${count}`;
  }
  return `${mission.tactic.toUpperCase()} ${count}`;
}

/** What the army roster calls a mission member: its mission's tactic, or for a gather mission its state. A strike's late joiners wait at the rally under "guard" and read "Gather". */
export function missionActivity(mission: Pick<Mission, "tactic" | "state">, behavior?: string): string {
  if (mission.tactic !== "gather") return TACTICS[mission.tactic].label;
  if (mission.state === "strike") return behavior === "guard" ? "Gather" : "Strike";
  if (mission.state === "defend") return "Defend";
  if (mission.state === "fallback") return "Fall back";
  return "Gather";
}

/** My units' mission activity labels by unit id, for the roster. */
export function memberActivities(list: readonly Mission[], units: readonly { id: number; behavior?: string | undefined }[]): Map<number, string> {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const result = new Map<number, string>();
  for (const mission of list) for (const id of mission.members) result.set(id, missionActivity(mission, byId.get(id)?.behavior));
  return result;
}

/** The preset-and-point pairs a mission's members run now, so a unit goal on one is labelled by the mission marker. During a strike, members recruited after it began wait at the rally until enough gather to go in as a wave. */
export function missionGoals(mission: Pick<Mission, "tactic" | "state" | "x" | "y" | "rally">): { preset: string; x: number; y: number }[] {
  if (mission.tactic !== "gather") return [{ preset: TACTICS[mission.tactic].preset, x: mission.x, y: mission.y }];
  // While defending, members run "assault" toward the threatened building, a point the client does not know.
  const rally = { preset: "guard", x: mission.rally.x, y: mission.rally.y };
  return mission.state === "strike" ? [{ preset: "assault", x: mission.x, y: mission.y }, rally] : [rally];
}

export const clampSize = (size: number): number => Math.max(1, Math.min(MAX_SIZE, Math.round(size)));
export const clampPercent = (percent: number): number => Math.max(MIN_PERCENT, Math.min(MAX_PERCENT, Math.round(percent)));

/** The order kinds, one per server command (see server/src/mission.rs). The mission an order names rides in `target`. */
export const missionOrders = {
  create: (tactic: Tactic, point: Point): Order => ({ kind: `mission_new_${tactic}`, x: clampToMap(point.x), y: clampToMap(point.y), target: 0 }),
  tactic: (id: number, tactic: Tactic): Order => ({ kind: `mission_tactic_${tactic}`, x: 0, y: 0, target: id }),
  /** -1 is "rest". */
  size: (id: number, size: MissionSize): Order => ({ kind: "mission_size", x: size === "rest" ? -1 : clampSize(size), y: 0, target: id }),
  gather: (id: number, percent: number): Order => ({ kind: "mission_gather", x: clampPercent(percent), y: 0, target: id }),
  fallback: (id: number, percent: number): Order => ({ kind: "mission_fallback", x: clampPercent(percent), y: 0, target: id }),
  rally: (id: number, point: Point): Order => ({ kind: "mission_rally", x: clampToMap(point.x), y: clampToMap(point.y), target: id }),
  cancel: (id: number): Order => ({ kind: "mission_cancel", x: 0, y: 0, target: id }),
  assign: (id: number): Order => ({ kind: "mission_assign", x: 0, y: 0, target: id }),
};

/** A thin sender: every action is one delayed command; the server does the rest and the rows come back through the subscription. */
export class Missions {
  constructor(private session: Session, private issuer: () => { id: number } | undefined) {}

  get list(): Mission[] {
    const { me, missions } = this.session.snapshot;
    return ownMissions(missions, me?.slot);
  }

  at(point: Point): Mission | undefined { return missionAt(this.list, point); }
  get(id: number): Mission | undefined { return this.list.find(mission => mission.id === id); }

  /** The army ids of a selection: the only units that may join a mission. */
  armyIds(ids: readonly number[]): number[] {
    const { me, units } = this.session.snapshot;
    const wanted = new Set(ids);
    return me ? units.filter(unit => unit.owner === me.slot && wanted.has(unit.id) && isArmy(unit.kind)).map(unit => unit.id) : [];
  }

  /** Places a mission; the selected army units join it at once. With none selected, any unit of mine is the issuer. */
  add(tactic: Tactic, point: Point, selected: readonly number[] = []): void {
    const army = this.armyIds(selected);
    this.send(army, missionOrders.create(tactic, point));
  }

  assign(id: number, selected: readonly number[]): void {
    const army = this.armyIds(selected);
    if (army.length) void this.session.order(army, missionOrders.assign(id));
  }

  setTactic(id: number, tactic: Tactic): void { this.send([], missionOrders.tactic(id, tactic)); }
  setSize(id: number, size: MissionSize): void { this.send([], missionOrders.size(id, size)); }
  setGather(id: number, percent: number): void { this.send([], missionOrders.gather(id, percent)); }
  setFallback(id: number, percent: number): void { this.send([], missionOrders.fallback(id, percent)); }
  setRally(id: number, point: Point): void { this.send([], missionOrders.rally(id, point)); }
  remove(id: number): void { this.send([], missionOrders.cancel(id)); }

  private send(units: number[], order: Order): void {
    const issuer = units.length ? undefined : this.issuer();
    const ids = units.length ? units : issuer ? [issuer.id] : [];
    if (ids.length) void this.session.order(ids, order);
  }
}
