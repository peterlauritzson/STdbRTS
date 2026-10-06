import { worldSize } from "./catalog";

export const WORLD_SIZE = worldSize;
export const TICK_MS = 50;
export const COLORS = ["#66dfba", "#ed7c8b", "#edce6d", "#86bafa"];
export { CATALOG as VISUALS } from "./catalog";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function countdown(executeTick: bigint, tick: bigint, sinceTickMs: number): number {
  return Math.max(0, Number(executeTick - tick) * TICK_MS - clamp(sinceTickMs, 0, TICK_MS)) / 1000;
}

/**
 * Keeps an ordered point inside the battlefield the match is actually played
 * on. This used to be `clamp(value, 16, 1584)` — the 1600 map's edge, written
 * out by hand — which silently forced every move and rally order into the
 * top-left quarter of a 3200 map. The extent comes from the map so it cannot
 * drift again.
 */
export function clampToMap(value: number): number {
  return clamp(value, 16, WORLD_SIZE - 16);
}

export function formation(count: number, x: number, y: number): { x: number; y: number }[] {
  const width = Math.ceil(Math.sqrt(count));
  return Array.from({ length: count }, (_, index) => ({
    x: clamp(x + (index % width - (width - 1) / 2) * 24, 16, WORLD_SIZE - 16),
    y: clamp(y + (Math.floor(index / width) - (Math.ceil(count / width) - 1) / 2) * 24, 16, WORLD_SIZE - 16),
  }));
}
/**
 * The colour a player's pieces are drawn in, from the viewer's side.
 *
 * `COLORS` is by slot, so the human in a practice match (slot 1) used to be
 * red, the colour everyone reads as the enemy. Here the viewer's slot and slot
 * 0 trade colours: you are always `COLORS[0]` (green, SC2's friendly colour)
 * and the slot that would have been green takes the viewer's old colour. It is
 * a permutation, so no two players ever share a colour. With no viewer (a
 * lobby, a spectator) it is the plain slot colour.
 */
export function ownerColor(owner: number, me: number | undefined): string {
  if (me === undefined || me < 0 || me >= COLORS.length) return COLORS[owner] ?? "#9fb39f";
  if (owner === me) return COLORS[0];
  if (owner === 0) return COLORS[me];
  return COLORS[owner] ?? "#9fb39f";
}

/**
 * The radius to draw a piece at: its real size, or enough to stay a visible
 * dot when the whole map is on screen and a real-sized unit would be under a
 * pixel. `minPixels` is on screen, so the result is in world units.
 */
export function legibleRadius(radius: number, zoom: number, minPixels = 3): number {
  return Math.max(radius, minPixels / zoom);
}
