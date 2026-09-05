export const WORLD_SIZE = 1600;
export const TICK_MS = 50;
export const COLORS = ["#66dfba", "#ed7c8b", "#edce6d", "#86bafa"];
export { CATALOG as VISUALS } from "./catalog";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function countdown(executeTick: bigint, tick: bigint, sinceTickMs: number): number {
  return Math.max(0, Number(executeTick - tick) * TICK_MS - clamp(sinceTickMs, 0, TICK_MS)) / 1000;
}

export function formation(count: number, x: number, y: number): { x: number; y: number }[] {
  const width = Math.ceil(Math.sqrt(count));
  return Array.from({ length: count }, (_, index) => ({
    x: clamp(x + (index % width - (width - 1) / 2) * 24, 16, WORLD_SIZE - 16),
    y: clamp(y + (Math.floor(index / width) - (Math.ceil(count / width) - 1) / 2) * 24, 16, WORLD_SIZE - 16),
  }));
}