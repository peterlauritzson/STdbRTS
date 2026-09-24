import type { CreepPatch, Entity } from "./bindings/types";
import { clamp } from "./presentation";
import { TEMPORARY_LIFETIME } from "./catalog";

/**
 * Pure readings of Organic creep and the temporary units it spawns, mirroring
 * `server/src/rules.rs`. Nothing here predicts growth: the radius steps once a
 * second on the server and the client draws the row it was sent.
 */

export const CREEP_TICKS_PER_SECOND = 20;
/** `rules::CREEP_LINGER_TICKS`: a lost patch holds its radius this long. */
export const CREEP_LINGER_TICKS = 100;
/** `rules::CREEP_RECESSION_PER_SECOND`: then loses this much once a second. */
export const CREEP_RECESSION_PER_SECOND = 20;

/** Units whose speed depends on their owner's creep — `rules::creep_dependent`. */
export const creepDependent = (kind: string): boolean => kind === "harvester";

type Placed = Pick<Entity, "owner" | "kind" | "x" | "y">;

/** On any of `owner`'s creep, lost patches included: `Zone::contains` is `<=`. */
export function onOwnCreep(owner: number, x: number, y: number, patches: readonly CreepPatch[]): boolean {
  return patches.some(patch => patch.owner === owner && patch.radius > 0 && Math.hypot(patch.x - x, patch.y - y) <= patch.radius);
}

/**
 * Is this unit being slowed for standing off its owner's creep? True only for a
 * creep-dependent unit (the Organic harvester) standing on none of its owner's
 * patches. Every other kind is never slowed, so it is never "off creep".
 */
export function offCreep(unit: Placed, patches: readonly CreepPatch[]): boolean {
  return creepDependent(unit.kind) && !onOwnCreep(unit.owner, unit.x, unit.y, patches);
}

/**
 * The tick a lost patch is removed on, or undefined while its source lives.
 *
 * `rules::advance_patch` holds the radius for `CREEP_LINGER_TICKS` after
 * `lostTick`, then subtracts `CREEP_RECESSION_PER_SECOND` on each tick where
 * `elapsed > linger` and `(elapsed - linger) % 20 == 0` — first at
 * `lostTick + 120` — and removes the patch when it reaches 0. A patch of radius
 * `r` lost on `L` is gone on `L + linger + 20 * ceil(r / recession)`.
 *
 * Only the current radius is on the row, so the steps already taken by `tick`
 * are counted back in to recover the radius it was lost at.
 */
export function creepGoneTick(patch: Pick<CreepPatch, "radius" | "lostTick">, tick: bigint): bigint | undefined {
  if (patch.lostTick === 0n) return undefined;
  const lingerEnd = patch.lostTick + BigInt(CREEP_LINGER_TICKS);
  const step = BigInt(CREEP_TICKS_PER_SECOND);
  const taken = tick > lingerEnd ? (tick - lingerEnd) / step : 0n;
  const left = BigInt(Math.ceil(patch.radius / CREEP_RECESSION_PER_SECOND));
  return lingerEnd + step * (taken + left);
}

/** Seconds until a lost patch is gone, or undefined while its source lives. */
export function creepSecondsLeft(patch: Pick<CreepPatch, "radius" | "lostTick">, tick: bigint): number | undefined {
  const gone = creepGoneTick(patch, tick);
  if (gone === undefined) return undefined;
  return Math.max(0, Number(gone - tick)) / CREEP_TICKS_PER_SECOND;
}

/**
 * The share of its life a temporary unit has left, 1 when spawned and 0 when
 * it expires; undefined for a permanent unit (`expiresTick` 0).
 */
export function lifetimeFraction(unit: Pick<Entity, "kind" | "expiresTick">, tick: bigint): number | undefined {
  if (unit.expiresTick === 0n) return undefined;
  const lifetime = TEMPORARY_LIFETIME[unit.kind];
  if (!lifetime) return undefined;
  return clamp(Number(unit.expiresTick - tick) / lifetime, 0, 1);
}
