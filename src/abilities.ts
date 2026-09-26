import type { CreepPatch, Entity } from "./bindings/types";
import { isCompletedHub, type FactionName } from "./catalog";

/**
 * Hub abilities, mirroring `server/src/rules.rs` ("Abilities"): Network and
 * Organic hubs carry energy that regenerates on its own, and each ability
 * spends some and then recharges on a cooldown. Industrial has none yet.
 */

export type AbilityKind = "recall" | "bloom";

export interface AbilityRule {
  kind: AbilityKind;
  label: string;
  faction: FactionName;
  energy: number;
  cooldownTicks: bigint;
  channelTicks: bigint;
  /** The circle the targeting preview draws: units recalled, or creep grown. */
  radius: number;
}

/** `rules::HUB_MAX_ENERGY`. */
export const HUB_MAX_ENERGY = 200;

/** `rules::RECALL`, `rules::BLOOM` and their radii. */
export const ABILITIES: Readonly<Record<AbilityKind, AbilityRule>> = {
  recall: { kind: "recall", label: "Recall", faction: "network", energy: 50, cooldownTicks: 1200n, channelTicks: 60n, radius: 200 },
  bloom: { kind: "bloom", label: "Bloom", faction: "organic", energy: 25, cooldownTicks: 200n, channelTicks: 0n, radius: 200 },
};

/** The one ability each faction casts, if any. */
export const abilityOf = (faction: FactionName | undefined): AbilityRule | undefined =>
  Object.values(ABILITIES).find(rule => rule.faction === faction);

/** `rules::max_energy`: hubs of a faction that has an ability. */
export const maxEnergy = (kind: string, faction: FactionName | undefined): number =>
  (kind === "hq" || kind === "outpost") && !!abilityOf(faction) ? HUB_MAX_ENERGY : 0;

type Caster = Pick<Entity, "id" | "owner" | "kind" | "constructionRemaining" | "energy" | "abilityReadyTick" | "cast">;

/** Why `hub` cannot cast `rule` right now, or undefined if it can. The server's `validate_cast`, less the target. */
export function castRefusal(hub: Caster, rule: AbilityRule, tick: bigint, scheduled: ReadonlySet<number> = new Set()): string | undefined {
  if (!isCompletedHub(hub)) return `${rule.label} is cast by a finished hub`;
  if (hub.cast || scheduled.has(hub.id)) return "This hub is already casting";
  if (tick < hub.abilityReadyTick) return `${rule.label} is recharging: ${Number((hub.abilityReadyTick - tick + 19n) / 20n)}s left`;
  if (hub.energy < rule.energy) return `Not enough energy: ${rule.energy} needed, ${hub.energy} available`;
  return undefined;
}

/** Hub ids with an ability command sent but not yet executed. */
export function scheduledCasts(commands: readonly { owner: number; status: string; units: number[]; order: { kind: string } }[], owner: number): Set<number> {
  const ids = new Set<number>();
  for (const command of commands) {
    if (command.owner === owner && command.status === "scheduled" && command.order.kind in ABILITIES) for (const id of command.units) ids.add(id);
  }
  return ids;
}

/**
 * Which hub casts, C&C style like training: a selected hub that can cast
 * wins; otherwise the ready hub with the most energy, ties to the lowest id.
 */
export function castingHub<T extends Caster>(units: readonly T[], owner: number, rule: AbilityRule, tick: bigint, selected: ReadonlySet<number>, scheduled: ReadonlySet<number> = new Set()): T | undefined {
  const ready = units
    .filter(unit => unit.owner === owner && castRefusal(unit, rule, tick, scheduled) === undefined)
    .sort((left, right) => right.energy - left.energy || left.id - right.id);
  return ready.find(unit => selected.has(unit.id)) ?? ready[0];
}

/** `World::on_creep`: inside any of `owner`'s creep patches, blooms included. */
export const onCreep = (owner: number, x: number, y: number, creep: readonly CreepPatch[]): boolean =>
  creep.some(patch => patch.owner === owner && Math.hypot(patch.x - x, patch.y - y) <= patch.radius);

/** `simulation::recallable`: `owner`'s mobile units within the recall radius of a point. */
export const recallable = (units: readonly Pick<Entity, "owner" | "kind" | "x" | "y">[], owner: number, x: number, y: number, isMobile: (kind: string) => boolean): number =>
  units.filter(unit => unit.owner === owner && isMobile(unit.kind) && Math.hypot(unit.x - x, unit.y - y) <= ABILITIES.recall.radius).length;
