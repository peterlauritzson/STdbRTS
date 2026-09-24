import type { Entity } from "./bindings/types";
import { canProduce, isBuilding, labourFaction, type FactionName } from "./catalog";

/**
 * Pure readings of the two building-projected zones — Network's power field
 * and Industrial's sensor field — and of the shield and teleport state on a
 * unit row, mirroring `server/src/rules.rs`. Creep lives in `creep.ts`: it is
 * carried in its own table, while these two are derived from the units every
 * tick exactly as the server derives them.
 */

/** `rules::POWER_FIELD_RADIUS`. */
export const POWER_FIELD_RADIUS = 320;
/** `rules::SENSOR_ZONE_RADIUS`. */
export const SENSOR_FIELD_RADIUS = 450;
/** `rules::POWER_RESTORE_RADIUS`: how far a death in the field restores shields. */
export const POWER_RESTORE_RADIUS = 180;
/** `rules::SHIELD_REGEN_DELAY_TICKS`: shields wait this long after a hit. */
export const SHIELD_REGEN_DELAY_TICKS = 200;
/** `rules::TELEPORT_CHANNEL_TICKS`. */
export const TELEPORT_CHANNEL_TICKS = 20;
/** `rules::TELEPORT_ARRIVAL_TICKS`. */
export const TELEPORT_ARRIVAL_TICKS = 40;

/** The faction-owned structure that projects each faction's building zone. */
export const BUILDING_FACTION: Readonly<Record<string, FactionName>> = { sensor: "industrial", relay: "network" };

type Placed = Pick<Entity, "owner" | "kind" | "x" | "y" | "constructionRemaining">;

export interface Field { kind: "power" | "sensor"; owner: number; x: number; y: number; radius: number }

/** `rules::projects_power`: the relay, and a Network player's hubs. */
export const projectsPower = (kind: string, faction: FactionName | undefined): boolean =>
  faction === "network" && (kind === "relay" || kind === "hq" || kind === "outpost");

/**
 * Every live power and sensor field, from the unit rows. An unfinished building
 * projects nothing, as on the server. `factionOf` answers for a slot, and a
 * slot it cannot answer for projects no power field.
 */
export function fieldsOf(units: readonly Placed[], factionOf: (slot: number) => FactionName | undefined): Field[] {
  const fields: Field[] = [];
  for (const unit of units) {
    if (unit.constructionRemaining > 0n) continue;
    if (projectsPower(unit.kind, factionOf(unit.owner))) fields.push({ kind: "power", owner: unit.owner, x: unit.x, y: unit.y, radius: POWER_FIELD_RADIUS });
    if (unit.kind === "sensor") fields.push({ kind: "sensor", owner: unit.owner, x: unit.x, y: unit.y, radius: SENSOR_FIELD_RADIUS });
  }
  return fields;
}

/** Inside one of `owner`'s power fields? `Zone::contains` is `<=`. */
export function powered(owner: number, x: number, y: number, fields: readonly Field[]): boolean {
  return fields.some(field => field.kind === "power" && field.owner === owner && Math.hypot(field.x - x, field.y - y) <= field.radius);
}

/** `rules::can_teleport`: anything mobile. */
export const canTeleport = (kind: string): boolean => !isBuilding(kind);
/** `rules::trains_in_field`: the drifter, at any finished structure in its owner's field. */
export const trainsInField = (kind: string): boolean => kind === "drifter";

/**
 * Can `building` train `kind` for a `faction` player? The fixed producer table,
 * plus the drifter at any finished structure standing in its owner's field —
 * the validation `World::validate_on` runs for `train_*`.
 */
export function canTrainAt(kind: string, building: Placed, faction: FactionName, fields: readonly Field[]): boolean {
  if (canProduce(kind, building.kind, faction)) return true;
  return trainsInField(kind) && labourFaction(kind) === faction && isBuilding(building.kind)
    && building.constructionRemaining === 0n && powered(building.owner, building.x, building.y, fields);
}

type Shielded = Pick<Entity, "shields" | "maxShields" | "damagedTick">;

/** Shields below maximum and past the post-hit delay, so coming back. */
export function shieldsRegenerating(unit: Shielded, tick: bigint): boolean {
  return unit.maxShields > 0 && unit.shields < unit.maxShields
    && (unit.damagedTick === 0n || tick - unit.damagedTick >= BigInt(SHIELD_REGEN_DELAY_TICKS));
}

/** How far through its channel a teleporting unit is, 0 to 1; undefined if it is not channelling. */
export function channelFraction(unit: Pick<Entity, "order" | "warpTick">, tick: bigint): number | undefined {
  if (unit.order.kind !== "teleport") return undefined;
  const left = Number(unit.warpTick - tick);
  return Math.min(1, Math.max(0, 1 - left / TELEPORT_CHANNEL_TICKS));
}

/** Just arrived from a teleport and still inactive. */
export const arriving = (unit: Pick<Entity, "arriveTick">, tick: bigint): boolean => unit.arriveTick > tick;
