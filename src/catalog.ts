import mapDefinition from "../shared/maps/crossfire.json";
import { mapContentHash } from "./maphash";
import { Faction } from "./bindings/types";
import type { Entity, Node, ResourceKind } from "./bindings/types";

export const terrain = mapDefinition.terrain;
// The battlefield extent comes from the map, not a constant: the server
// validates positions against the simulated map's size, so a client that
// assumed 1600 would clamp the camera and previews to a quarter of the map.
export const worldSize = mapDefinition.size;
export const mapIdentity = { id: mapDefinition.id, version: mapDefinition.version } as const;
/** `MapDefinition::content_hash` of the bundled map, compared with the room's `map_hash`. */
export const MAP_HASH = mapContentHash(mapDefinition);
/** Mobile units a player may hold, excluding temporary units: `rules::MAX_UNITS`. */
export const MAX_UNITS = 120;

/** The two currencies of the dual-currency economy, in server spelling. */
export type Currency = "material" | "catalyst";
/** A price or a balance. Both currencies are always present; zero is not absent. */
export interface Cost { material: number; catalyst: number }

export const CURRENCIES: readonly Currency[] = ["material", "catalyst"];
export const CURRENCY_LABEL: Record<Currency, string> = { material: "Material", catalyst: "Catalyst" };
const price = (material: number, catalyst = 0): Cost => ({ material, catalyst });
/** Every technology costs the same; the server has one price for all three. */
export const RESEARCH_COST: Cost = price(100, 50);
export const RESEARCH_SECONDS = 15;

export interface Definition { label: string; hp: number; radius: number; cost: Cost; seconds: number; building: boolean; icon: string; role: string }
export const CATALOG: Record<string, Definition> = {
  hq: { label: "Headquarters", hp: 1200, radius: 34, cost: price(0), seconds: 0, building: true, icon: "house", role: "Primary base / worker and infantry production" },
  worker: { label: "Worker", hp: 60, radius: 10, cost: price(50), seconds: 3, building: false, icon: "hammer", role: "Industrial labour / mines 25 and walks it home" },
  // The Network labour unit. It never holds cargo and never walks a load home,
  // so nothing that reads a load — the cargo bar, the return order, the cargo
  // line in the selection panel — applies to it.
  drifter: { label: "Drifter", hp: 40, radius: 9, cost: price(40), seconds: 2.5, building: false, icon: "radio", role: "Network labour / credits at the deposit, never returns" },
  // The Organic labour unit. Free of currency, bought with one point of hub
  // stock, carries 10, and cannot fight at all.
  harvester: { label: "Harvester", hp: 45, radius: 8, cost: price(0), seconds: 2, building: false, icon: "sprout", role: "Organic labour / costs 1 hub stock, gathers only" },
  soldier: { label: "Soldier", hp: 140, radius: 12, cost: price(100), seconds: 5, building: false, icon: "swords", role: "Infantry / counters scouts" },
  scout: { label: "Scout", hp: 80, radius: 11, cost: price(80), seconds: 3.5, building: false, icon: "radar", role: "Fast raider / vulnerable to infantry" },
  siege: { label: "Siege", hp: 220, radius: 17, cost: price(150, 50), seconds: 8, building: false, icon: "crosshair", role: "Long range / triple damage to buildings" },
  // Network army: fewer, stronger, half shields. Mirrors `rules::stats`.
  sentinel: { label: "Sentinel", hp: 220, radius: 13, cost: price(150), seconds: 6.5, building: false, icon: "shield-half", role: "Network fighter / tough, hard-hitting, counters nothing in particular" },
  skimmer: { label: "Skimmer", hp: 70, radius: 10, cost: price(90), seconds: 3.5, building: false, icon: "wind", role: "Network raider / fastest unit, triple damage to labour" },
  lancer: { label: "Lancer", hp: 240, radius: 16, cost: price(175, 75), seconds: 9, building: false, icon: "zap", role: "Network artillery / 250 range, triple damage to buildings" },
  // Organic army: cheap, fast, in numbers.
  swarmer: { label: "Swarmer", hp: 60, radius: 9, cost: price(50), seconds: 2.25, building: false, icon: "bug", role: "Organic fighter / cheap fast melee, leaves a brood if it dies on your creep" },
  spitter: { label: "Spitter", hp: 85, radius: 11, cost: price(90), seconds: 4, building: false, icon: "droplets", role: "Organic support / 150 range, fires over the swarm" },
  crusher: { label: "Crusher", hp: 420, radius: 18, cost: price(175, 75), seconds: 9, building: false, icon: "hammer", role: "Organic heavy / melee, triple damage to buildings, leaves a brute on your creep" },
  barracks: { label: "Barracks", hp: 700, radius: 34, cost: price(150), seconds: 8, building: true, icon: "tent", role: "Soldier and scout production" },
  factory: { label: "Factory", hp: 900, radius: 34, cost: price(200, 50), seconds: 12, building: true, icon: "factory", role: "Siege production / requires barracks" },
  turret: { label: "Turret", hp: 500, radius: 30, cost: price(125), seconds: 7, building: true, icon: "shield", role: "Automatic defense / 210 range" },
  outpost: { label: "Outpost", hp: 650, radius: 30, cost: price(100), seconds: 6, building: true, icon: "warehouse", role: "Resource drop-off / base expansion" },
  lab: { label: "Laboratory", hp: 650, radius: 32, cost: price(150, 50), seconds: 10, building: true, icon: "flask-conical", role: "Faction-wide research" },
  // Faction buildings: each projects its faction's zone and nobody else can
  // build it. `hp` is the listed total; a Network entity carries half of it as
  // shields, and the row's own `maxHp`/`maxShields` are what to draw against.
  sensor: { label: "Sensor tower", hp: 450, radius: 26, cost: price(125, 50), seconds: 7, building: true, icon: "satellite-dish", role: "Industrial / your units move 30% faster within 450" },
  relay: { label: "Relay", hp: 300, radius: 22, cost: price(75), seconds: 5, building: true, icon: "zap", role: "Network / power field 320: drifters train at any structure in it, shields regenerate 3x, units teleport within it" },
  // Temporary units creep spawns where one of its owner's units dies on it —
  // mirrors `rules::stats` and `rules::temporary_lifetime`. Never trained (so
  // no training time and no button), free, not army, and take no supply.
  brood: { label: "Brood", hp: 30, radius: 7, cost: price(0), seconds: 0, building: false, icon: "bug", role: "Temporary / spawned by a 50-199 cost death on your creep, lives 10s" },
  brute: { label: "Brute", hp: 70, radius: 11, cost: price(0), seconds: 0, building: false, icon: "bug", role: "Temporary / spawned by a 200+ cost death on your creep, lives 15s" },
};
export const TECHNOLOGIES = {
  weapons: { label: "Weapons", description: "+4 attack damage", icon: "swords" },
  armor: { label: "Armor", description: "-3 damage per hit", icon: "shield" },
  logistics: { label: "Logistics", description: "40 cargo / 7 per extraction", icon: "warehouse" },
};
export const isBuilding = (kind: string): boolean => CATALOG[kind]?.building ?? false;
/**
 * Each faction's army, in command-card order: fighter and raider or support
 * from the barracks, anti-structure from the factory. Mirrors
 * `rules::army_faction` and `rules::army_building`.
 */
export const ARMY: Readonly<Record<"industrial" | "network" | "organic", readonly [string, string, string]>> = {
  industrial: ["soldier", "scout", "siege"],
  network: ["sentinel", "skimmer", "lancer"],
  organic: ["swarmer", "spitter", "crusher"],
};
export const armyFaction = (kind: string): "industrial" | "network" | "organic" | undefined =>
  (Object.keys(ARMY) as ("industrial" | "network" | "organic")[]).find(faction => ARMY[faction].includes(kind));
export const isArmy = (kind: string): boolean => !!armyFaction(kind);
/** The factory trains the third unit of each roster; the barracks trains the rest. */
export const armyBuilding = (kind: string): string | undefined =>
  !isArmy(kind) ? undefined : ARMY[armyFaction(kind)!][2] === kind ? "factory" : "barracks";

/**
 * How long a temporary unit lives, in ticks, mirroring
 * `rules::temporary_lifetime`; undefined for every permanent kind. The unit
 * row carries its own `expiresTick`, so this is only the denominator of the
 * lifetime bar.
 */
export const TEMPORARY_LIFETIME: Readonly<Record<string, number>> = { brood: 200, brute: 300 };
export const isTemporary = (kind: string): boolean => kind in TEMPORARY_LIFETIME;
/**
 * Takes attack, attack-move and hold — `rules::fights`. The army plus the
 * temporary units creep spawns, which fight but are not army: they must not
 * move an army count or an army-value graph, so `isArmy` stays false for them.
 */
export const fights = (kind: string): boolean => isArmy(kind) || isTemporary(kind);
/**
 * Counts against the 60-unit limit. Buildings do not, and neither do the
 * temporary units creep spawns: the server leaves them out of that count, so a
 * client that counted them would disable training the server would accept.
 */
export const takesSupply = (kind: string): boolean => !isBuilding(kind) && !isTemporary(kind);

// --- Factions and the three labour units ------------------------------------

/**
 * A faction in lower-case server spelling — the same word the server puts in
 * its refusals ("you are playing industrial"), so a message never has to be
 * translated between the two sides.
 */
export type FactionName = "industrial" | "network" | "organic";
export const FACTIONS: readonly FactionName[] = ["industrial", "network", "organic"];
export const FACTION_LABEL: Record<FactionName, string> = { industrial: "Industrial", network: "Network", organic: "Organic" };
/** One line describing the economy, for the lobby and the match readout. */
export const FACTION_ECONOMY: Record<FactionName, string> = {
  industrial: "Workers mine 25 and walk it home",
  network: "Drifters credit in place and never return",
  organic: "Harvesters are free but cost hub stock",
};

/** The generated sum type turned into the plain word the rest of the client uses. */
export const factionOf = (faction: Faction): FactionName =>
  faction.tag === "Network" ? "network" : faction.tag === "Organic" ? "organic" : "industrial";

/** The inverse: the plain word turned back into the value `set_faction` takes. */
export const factionValue = (faction: FactionName): Faction =>
  faction === "network" ? Faction.Network : faction === "organic" ? Faction.Organic : Faction.Industrial;

/**
 * A faction read back from somewhere untrusted — a `<select>`, a stored
 * preference, a query string — or `undefined` if it is not one of the three.
 * Callers fall back rather than guess, so a stale stored value can never send
 * the server a faction it would refuse.
 */
export const parseFaction = (value: string | null | undefined): FactionName | undefined =>
  FACTIONS.find(faction => faction === value);

/**
 * The faction a slot is dealt when nobody chooses, mirroring
 * `rules::faction_for_slot` and its rotation. The client needs it to say what
 * one-click practice will give you before the server has said anything: the
 * practice room seats the human in slot 1, so the picker opens on that faction
 * and clicking straight through changes nothing.
 */
export const FACTION_ROTATION: readonly FactionName[] = ["industrial", "network", "organic"];
export const factionForSlot = (slot: number): FactionName =>
  FACTION_ROTATION[((slot % FACTION_ROTATION.length) + FACTION_ROTATION.length) % FACTION_ROTATION.length];

/** The slot the human is seated in by `Practice`: the bot creates the room and takes slot 0. */
export const PRACTICE_SLOT = 1;

/** Each faction's one labour unit. Nobody can train another faction's. */
export const LABOUR: Record<FactionName, string> = { industrial: "worker", network: "drifter", organic: "harvester" };
/** The faction a labour unit belongs to, or undefined for anything else. */
export const labourFaction = (kind: string): FactionName | undefined =>
  FACTIONS.find(faction => LABOUR[faction] === kind);
/** Anything that can gather, construct or repair — `rules::is_labour`. */
export const isLabour = (kind: string): boolean => !!labourFaction(kind);
/** Carries a load home. Every labour unit except the drifter. */
export const carriesCargo = (kind: string): boolean => kind === "worker" || kind === "harvester";
/** Credits its owner while standing at the deposit, instead of hauling. */
export const gathersInPlace = (kind: string): boolean => kind === "drifter";
/** One load, mirroring `rules::cargo_capacity`. */
export const cargoCapacity = (kind: string, logistics: boolean): number =>
  kind === "harvester" ? (logistics ? 16 : 10) : logistics ? 40 : 25;
/** The Organic harvester is labour and nothing else: it has no weapon at all. */
export const canFight = (kind: string): boolean => kind !== "harvester";

/** A building cargo is delivered to, and — for Organic — one that holds stock. */
export const isHub = (kind: string): boolean => kind === "hq" || kind === "outpost";
/** Buildings the server takes rally orders at: every producer. */
export const RALLIES: readonly string[] = ["hq", "outpost", "barracks", "factory", "lab"];
/** A finished HQ or outpost: what keeps a player in the match (primary-hub victory). */
export const isCompletedHub = (unit: { kind: string; constructionRemaining: bigint }): boolean => isHub(unit.kind) && unit.constructionRemaining === 0n;
/** Ticks between one Organic hub accruing one point of stock. */
export const HUB_STOCK_INTERVAL_TICKS = 60;
/** The most stock one Organic hub can hold. */
export const HUB_STOCK_CAP = 7;
/** Word for word the refusal the server returns for a stockless hub. */
export const STOCK_REASON = `This hub has no harvester stock; it regenerates 1 every ${HUB_STOCK_INTERVAL_TICKS} ticks up to ${HUB_STOCK_CAP}`;

/**
 * Can `faction` train `kind` at `building`? Mirrors `rules::producer`: each
 * faction trains only its own labour and its own army, and an army needs the
 * building that makes it — no barracks, no fighters.
 */
export const canProduce = (kind: string, building: string, faction: FactionName): boolean => {
  const required = labourFaction(kind);
  // Every hub is a town hall: an outpost trains labour as the HQ does.
  if (required) return faction === required && isHub(building);
  return armyFaction(kind) === faction && armyBuilding(kind) === building;
};

/** Which currency a deposit holds, or a worker carries, as a plain string. */
export const currencyOf = (kind: ResourceKind): Currency => (kind.tag === "Catalyst" ? "catalyst" : "material");

/** The price of anything orderable, including the `research_*` orders. */
export function costOf(kind: string): Cost {
  if (kind.startsWith("research_")) return RESEARCH_COST;
  return CATALOG[kind]?.cost ?? price(0);
}

/**
 * The currency that stops a purchase, checking material first so the answer
 * matches `Balance::shortfall` on the server. Both currencies must cover the
 * price: there is no partial payment and no substitution.
 */
export function shortfall(balance: Cost, cost: Cost): Currency | undefined {
  if (balance.material < cost.material) return "material";
  if (balance.catalyst < cost.catalyst) return "catalyst";
  return undefined;
}

export const affords = (balance: Cost, cost: Cost): boolean => !shortfall(balance, cost);

/**
 * The refusal the server would give for this purchase, word for word — see
 * `World::afford` in server/src/simulation.rs. Predicting it locally lets a
 * disabled button say which currency is missing before anything is sent.
 */
export function shortfallReason(balance: Cost, cost: Cost): string | undefined {
  const missing = shortfall(balance, cost);
  return missing && `Insufficient ${missing}: ${cost[missing]} needed, ${balance[missing]} available`;
}

/** A balance after paying a price. Never goes negative. */
export const spend = (balance: Cost, cost: Cost): Cost => ({
  material: Math.max(0, balance.material - cost.material),
  catalyst: Math.max(0, balance.catalyst - cost.catalyst),
});

export const addCost = (left: Cost, right: Cost): Cost => ({ material: left.material + right.material, catalyst: left.catalyst + right.catalyst });

/** "150 material + 50 catalyst", "50 material", "nothing". */
export function formatCost(cost: Cost): string {
  const parts = CURRENCIES.filter(currency => cost[currency] > 0).map(currency => `${cost[currency]} ${currency}`);
  return parts.join(" + ") || "nothing";
}

export function placementError(kind: string, x: number, y: number, owner: number, units: Entity[], nodes: Node[]): string | undefined {
  // Bounds follow the map, not a constant: hardcoding the 1600 map's 1540 edge
  // confined building to the top-left quarter of a larger map.
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 60 || x > worldSize - 60 || y < 60 || y > worldSize - 60) return "Map boundary";
  if (terrain.some(([left, top, width, height]) => x > left - 50 && x < left + width + 50 && y > top - 50 && y < top + height + 50)) return "Terrain obstructed";
  if (units.some(unit => Math.hypot(unit.x - x, unit.y - y) < (isBuilding(unit.kind) ? 110 : 55)) || nodes.some(node => Math.hypot(node.x - x, node.y - y) < 75)) return "Site occupied";
  const owned = units.filter(unit => unit.owner === owner && isBuilding(unit.kind));
  if (!owned.some(unit => unit.constructionRemaining === 0n && Math.hypot(unit.x - x, unit.y - y) <= 500)) return "Outside build radius";
  if (owned.length >= 16) return "Building limit reached";
  if (kind === "factory" && !owned.some(unit => unit.kind === "barracks" && unit.constructionRemaining === 0n)) return "Barracks required";
  return undefined;
}
