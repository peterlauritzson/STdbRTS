import type { Entity } from "./bindings/types";
import { isBuilding, PASSIVE_OF } from "./catalog";

/**
 * Visible feedback for the passives that fire on their own. The server tells
 * the client nothing about them beyond the entity rows, so each effect is
 * derived from how a row changed between two snapshots (a cooldown that
 * restarted, a shot that landed, a unit that vanished) and is drawn for a
 * moment. Nothing here decides anything: the server already did.
 */
export interface Fx {
  kind: "ring" | "line";
  x: number;
  y: number;
  /** The far end of a line. */
  x2: number;
  y2: number;
  /** A ring's final radius. */
  radius: number;
  color: string;
  at: number;
}

/** How long an effect is drawn, in ms. */
export const FX_MS = 450;
/** Mirrors `rules::splash_radius`. */
export const SPLASH_RADIUS: Readonly<Record<string, number>> = { siege: 45, spitter: 35 };
/** Mirrors `rules::RICOCHET_RADIUS`, `MEDIC_RANGE` and `DEATH_BURST_RADIUS`. */
export const RICOCHET_RADIUS = 70;
export const MEDIC_RANGE = 90;
export const DEATH_BURST_RADIUS = 70;

const SPLASH_COLOR = "#ffb25e";
const RICOCHET_COLOR = "#c9b2ff";
const BLINK_COLOR = "#8fd8ff";
const HEAL_COLOR = "#7cf0a0";
const BURST_COLOR = "#ff6b6b";

const ring = (x: number, y: number, radius: number, color: string, at: number): Fx => ({ kind: "ring", x, y, x2: x, y2: y, radius, color, at });
const line = (x: number, y: number, x2: number, y2: number, color: string, at: number): Fx => ({ kind: "line", x, y, x2, y2, radius: 0, color, at });

/** Is a marksman dug in? Its bonus runs until `passiveReadyTick`: `simulation::entrenched`. */
export const entrenched = (unit: Pick<Entity, "kind" | "passiveReadyTick">, tick: bigint): boolean =>
  PASSIVE_OF[unit.kind] === "entrenchment" && unit.passiveReadyTick > tick;

/**
 * The friendly unit a medic's last heal went to: the most hit points missing
 * within reach, ties on the lower id, never the medic itself. The rule the
 * server runs, re-run on the new snapshot to find who the green line is for.
 */
export function patientOf(medic: Entity, units: readonly Entity[]): Entity | undefined {
  let best: Entity | undefined;
  for (const other of units) {
    if (other.owner !== medic.owner || other.id === medic.id || other.hp >= other.maxHp || isBuilding(other.kind)) continue;
    if (Math.hypot(other.x - medic.x, other.y - medic.y) > MEDIC_RANGE) continue;
    if (!best || other.maxHp - other.hp > best.maxHp - best.hp || (other.maxHp - other.hp === best.maxHp - best.hp && other.id < best.id)) best = other;
  }
  return best;
}

/** What `unit`'s passive just did, judged from its previous row `before` and the new snapshot `units`. */
export function passiveEffects(before: Entity, unit: Entity, units: readonly Entity[], now: number): Fx[] {
  const passive = PASSIVE_OF[unit.kind];
  if (!passive) return [];
  const out: Fx[] = [];
  const shot = unit.shotTick > before.shotTick;
  const restarted = unit.passiveReadyTick > before.passiveReadyTick;
  switch (passive) {
    case "battle_blink":
      // The cooldown restarted and the unit is somewhere else: it blinked.
      if (restarted && Math.hypot(unit.x - before.x, unit.y - before.y) > 60) {
        out.push(line(before.x, before.y, unit.x, unit.y, BLINK_COLOR, now), ring(unit.x, unit.y, 24, BLINK_COLOR, now));
      }
      break;
    case "phase_shift":
      if (restarted) out.push(ring(unit.x, unit.y, 26, BLINK_COLOR, now));
      break;
    case "field_medic": {
      if (!restarted) break;
      const patient = patientOf(unit, units);
      if (patient) out.push(line(unit.x, unit.y, patient.x, patient.y, HEAL_COLOR, now));
      break;
    }
    case "overwatch":
      if (restarted) out.push(ring(unit.x, unit.y, 22, "#ffe08a", now));
      break;
    case "shrapnel":
    case "acid_splash":
      if (shot) out.push(ring(unit.shotX, unit.shotY, SPLASH_RADIUS[unit.kind], SPLASH_COLOR, now));
      break;
    case "ricochet":
    case "ricochet_one":
      if (shot) out.push(ring(unit.shotX, unit.shotY, RICOCHET_RADIUS, RICOCHET_COLOR, now));
      break;
  }
  return out;
}

/** A unit that vanished from the snapshot: a behemoth leaves its burst behind. */
export function removalEffects(last: Entity, at: { x: number; y: number }, now: number): Fx[] {
  return PASSIVE_OF[last.kind] === "death_burst" ? [ring(at.x, at.y, DEATH_BURST_RADIUS, BURST_COLOR, now)] : [];
}
