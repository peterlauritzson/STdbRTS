import type { Entity } from "./bindings/types";
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
