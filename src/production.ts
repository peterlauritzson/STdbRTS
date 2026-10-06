import type { Entity } from "./units";
import { BEHAVIORS, rallyBehavior } from "./behaviors";
import { isBuilding, type FactionName } from "./catalog";
import { canTrainAt, type Field } from "./zones";

/** The server's `MAX_QUEUE`: a building refuses a ninth queued item. */
export const MAX_QUEUE = 8;

/** A `train_*` command already sent but not yet executed, per building id. */
export type Scheduled = ReadonlyMap<number, { total: number; harvesters: number }>;

/** Counts this player's scheduled `train_*` commands per building, from the command rows. */
export function scheduledTraining(commands: readonly { owner: number; status: string; units: number[]; order: { kind: string } }[], owner: number): Map<number, { total: number; harvesters: number }> {
  const counts = new Map<number, { total: number; harvesters: number }>();
  for (const command of commands) {
    if (command.owner !== owner || command.status !== "scheduled" || !command.order.kind.startsWith("train_")) continue;
    for (const id of command.units) {
      const entry = counts.get(id) ?? { total: 0, harvesters: 0 };
      entry.total++;
      if (command.order.kind === "train_harvester") entry.harvesters++;
      counts.set(id, entry);
    }
  }
  return counts;
}

/**
 * Where a unit bought from the command card is trained, C&C style: the
 * player never has to select a building first.
 *
 * - Only finished buildings of this player that can train `kind` and still
 *   have queue room, counting commands still inside the command delay.
 * - A harvester also needs stock left at that hub.
 * - If the player has any of those selected, only the selected ones are used,
 *   so selecting a building still means "train here".
 * - Otherwise the shortest queue wins, so parallel buildings share the work;
 *   ties go to the lowest id, which keeps the choice stable between frames.
 */
export function trainingSite(kind: string, faction: FactionName, owned: readonly Entity[], selected: ReadonlySet<number>, scheduled: Scheduled, fields: readonly Field[]): Entity | undefined {
  const load = (unit: Entity) => unit.production.length + (scheduled.get(unit.id)?.total ?? 0);
  const candidates = owned.filter(unit =>
    isBuilding(unit.kind)
    && unit.constructionRemaining === 0n
    && canTrainAt(kind, unit, faction, fields)
    && load(unit) < MAX_QUEUE
    && (kind !== "harvester" || unit.stock - (scheduled.get(unit.id)?.harvesters ?? 0) > 0));
  const chosen = candidates.some(unit => selected.has(unit.id)) ? candidates.filter(unit => selected.has(unit.id)) : candidates;
  return [...chosen].sort((left, right) => load(left) - load(right) || left.id - right.id)[0];
}

/** One line of the production queue: what, where, and how far along. */
export interface QueueRow {
  building: number;
  kind: string;
  /** 0 to 1; 0 for an order still inside the command delay. */
  progress: number;
  seconds: number;
  /** Sent but not yet executed by the server (inside the one-second command delay). */
  scheduled: boolean;
}

type TrainCommand = { owner: number; status: string; units: number[]; order: { kind: string } };

/** The unit kinds of this player's `train_*` commands still inside the command delay, for one building. */
function scheduledOf(commands: readonly TrainCommand[], owner: number, building: number): string[] {
  return commands
    .filter(command => command.owner === owner && command.status === "scheduled" && command.order.kind.startsWith("train_") && command.units.includes(building))
    .map(command => command.order.kind.slice(6));
}

/**
 * The queue the player is looking at. Selected producers show their own
 * queues; with none selected (or none of them busy) it is everything in
 * production. Orders still inside the command delay are listed too, marked
 * `scheduled`, so a click is answered at once instead of a second later.
 * Research is instant and never queues, so it is left out. `tick` is the
 * current tick, fractional if interpolated.
 *
 * An item's `finishTick` is cumulative (it starts when the one before it
 * finishes), so progress is the share of its own training time already
 * elapsed: 0 for an item more than one training time from finishing.
 */
export function queueView(units: readonly Entity[], commands: readonly TrainCommand[], owner: number, selected: ReadonlySet<number>, tick: number, durationTicks: (kind: string) => number): { scope: "selected" | "all"; rows: QueueRow[] } {
  const own = units.filter(unit => unit.owner === owner && isBuilding(unit.kind));
  const busy = (unit: Entity) => unit.production.some(item => !item.kind.startsWith("research_")) || scheduledOf(commands, owner, unit.id).length > 0;
  const chosen = own.filter(unit => selected.has(unit.id) && busy(unit));
  const scope = chosen.length ? "selected" : "all";
  const rows: QueueRow[] = [];
  for (const unit of scope === "selected" ? chosen : own) {
    for (const item of unit.production) {
      if (item.kind.startsWith("research_")) continue;
      const total = durationTicks(item.kind);
      const left = Number(item.finishTick) - tick;
      rows.push({ building: unit.id, kind: item.kind, progress: total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 0, seconds: Math.max(0, left / 20), scheduled: false });
    }
    for (const kind of scheduledOf(commands, owner, unit.id)) rows.push({ building: unit.id, kind, progress: 0, seconds: durationTicks(kind) / 20, scheduled: true });
  }
  return { scope, rows };
}

/**
 * A rally in words instead of coordinates: "Material rally / 190 away",
 * "Rally set / at Outpost / 640 away" or "Rally unset". `rallyNode` is the
 * deposit a gather rally points at; `landmark` names a building the point is on.
 */
export function rallyText(producer: Pick<Entity, "x" | "y" | "order">, rallyNode: { kind: { tag: string }; x: number; y: number } | undefined, landmark: { label: string } | undefined): string {
  const order = producer.order;
  const preset = rallyBehavior(order.kind);
  if (preset) return `Rally: ${BEHAVIORS[preset].label} at ${Math.round(order.x)}, ${Math.round(order.y)} / ${Math.round(Math.hypot(order.x - producer.x, order.y - producer.y))} away`;
  if (order.kind !== "rally_move" && order.kind !== "rally_gather") return "Rally unset";
  const target = order.kind === "rally_gather" && rallyNode ? rallyNode : order;
  const away = `${Math.round(Math.hypot(target.x - producer.x, target.y - producer.y))} away`;
  if (order.kind === "rally_gather") return `${rallyNode ? (rallyNode.kind.tag === "Catalyst" ? "Catalyst" : "Material") : "Deposit"} rally / ${away}`;
  return `Rally set / ${landmark ? `at ${landmark.label} / ` : ""}${away}`;
}
