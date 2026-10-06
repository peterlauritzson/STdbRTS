/**
 * "You are under attack" bookkeeping, kept pure so the throttle can be tested.
 *
 * A fight hurts many units every tick, so an alert is raised at most once per
 * area per `ALERT_THROTTLE_MS`. Units and buildings are separate alerts in the
 * same area: a base under attack must not be swallowed by a skirmish that
 * began a second earlier.
 */

export type AlertKind = "units" | "base";

/** Side of one alert area, in world units. */
export const ALERT_CELL = 800;
/** Quiet time before the same area may alert again. */
export const ALERT_THROTTLE_MS = 8000;
/** How long the banner stays up. */
export const ALERT_BANNER_MS = 3500;

export const alertCell = (x: number, y: number): string => `${Math.floor(x / ALERT_CELL)},${Math.floor(y / ALERT_CELL)}`;

export const alertText = (kind: AlertKind): string => kind === "base" ? "Your base is under attack" : "Your units are under attack";

export class AlertThrottle {
  private last = new Map<string, number>();

  /** True when this hit should raise an alert; records it when it does. */
  accept(kind: AlertKind, x: number, y: number, now: number): boolean {
    const key = `${kind}:${alertCell(x, y)}`;
    const before = this.last.get(key);
    if (before !== undefined && now - before < ALERT_THROTTLE_MS) return false;
    this.last.set(key, now);
    return true;
  }

  clear(): void { this.last.clear(); }
}
