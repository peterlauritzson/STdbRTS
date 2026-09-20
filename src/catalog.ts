import mapDefinition from "../shared/maps/skirmish.json";
import type { Entity, Node } from "./bindings/types";

export const terrain = mapDefinition.terrain;
export const mapIdentity = { id: mapDefinition.id, version: mapDefinition.version } as const;
export interface Definition { label: string; hp: number; radius: number; cost: number; seconds: number; building: boolean; icon: string; role: string }
export const CATALOG: Record<string, Definition> = {
  hq: { label: "Headquarters", hp: 1200, radius: 34, cost: 0, seconds: 0, building: true, icon: "house", role: "Primary base / worker and infantry production" },
  worker: { label: "Worker", hp: 60, radius: 10, cost: 50, seconds: 3, building: false, icon: "hammer", role: "Mining / construction / repair" },
  soldier: { label: "Soldier", hp: 140, radius: 12, cost: 100, seconds: 5, building: false, icon: "swords", role: "Infantry / counters scouts" },
  scout: { label: "Scout", hp: 80, radius: 11, cost: 80, seconds: 3.5, building: false, icon: "radar", role: "Fast raider / vulnerable to infantry" },
  siege: { label: "Siege", hp: 220, radius: 17, cost: 200, seconds: 8, building: false, icon: "crosshair", role: "Long range / triple damage to buildings" },
  barracks: { label: "Barracks", hp: 700, radius: 34, cost: 150, seconds: 8, building: true, icon: "tent", role: "Soldier and scout production" },
  factory: { label: "Factory", hp: 900, radius: 34, cost: 250, seconds: 12, building: true, icon: "factory", role: "Siege production / requires barracks" },
  turret: { label: "Turret", hp: 500, radius: 30, cost: 125, seconds: 7, building: true, icon: "shield", role: "Automatic defense / 210 range" },
  outpost: { label: "Outpost", hp: 650, radius: 30, cost: 100, seconds: 6, building: true, icon: "warehouse", role: "Ore drop-off / base expansion" },
  lab: { label: "Laboratory", hp: 650, radius: 32, cost: 200, seconds: 10, building: true, icon: "flask-conical", role: "Faction-wide research" },
};
export const TECHNOLOGIES = {
  weapons: { label: "Weapons", description: "+4 attack damage", icon: "swords" },
  armor: { label: "Armor", description: "-3 damage per hit", icon: "shield" },
  logistics: { label: "Logistics", description: "40 cargo / 7 ore per extraction", icon: "warehouse" },
};
export const isBuilding = (kind: string): boolean => CATALOG[kind]?.building ?? false;
export const isArmy = (kind: string): boolean => ["soldier", "scout", "siege"].includes(kind);
export const canProduce = (kind: string, building: string): boolean =>
  kind === "worker" ? building === "hq" : kind === "soldier" ? ["hq", "barracks"].includes(building) : kind === "scout" ? building === "barracks" : kind === "siege" && building === "factory";

export function placementError(kind: string, x: number, y: number, owner: number, units: Entity[], nodes: Node[]): string | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 60 || x > 1540 || y < 60 || y > 1540) return "Map boundary";
  if (terrain.some(([left, top, width, height]) => x > left - 50 && x < left + width + 50 && y > top - 50 && y < top + height + 50)) return "Terrain obstructed";
  if (units.some(unit => Math.hypot(unit.x - x, unit.y - y) < (isBuilding(unit.kind) ? 110 : 55)) || nodes.some(node => Math.hypot(node.x - x, node.y - y) < 75)) return "Site occupied";
  const owned = units.filter(unit => unit.owner === owner && isBuilding(unit.kind));
  if (!owned.some(unit => unit.constructionRemaining === 0n && Math.hypot(unit.x - x, unit.y - y) <= 500)) return "Outside build radius";
  if (owned.length >= 16) return "Building limit reached";
  if (kind === "factory" && !owned.some(unit => unit.kind === "barracks" && unit.constructionRemaining === 0n)) return "Barracks required";
  return undefined;
}