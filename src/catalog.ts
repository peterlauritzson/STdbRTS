import mapDefinition from "../shared/maps/expanse.json";
import { mapContentHash } from "./maphash";
import { Faction } from "./bindings/types";
import type { Entity, Node, ResourceKind } from "./bindings/types";

export const terrain = mapDefinition.terrain;
/** Each slot's start position on the bundled map, where its HQ is placed. */
export const starts = mapDefinition.starts as [number, number][];
// The battlefield extent comes from the map, not a constant: the server
// validates positions against the simulated map's size, so a client that
// assumed 1600 would clamp the camera and previews to a quarter of the map.
export const worldSize = mapDefinition.size;
export const mapIdentity = { id: mapDefinition.id, version: mapDefinition.version } as const;
/** `MapDefinition::content_hash` of the bundled map, compared with the room's `map_hash`. */
export const MAP_HASH = mapContentHash(mapDefinition);
/** Mobile units a player may hold, excluding temporary units: `rules::MAX_UNITS`. */
export const MAX_UNITS = 400;
/** Buildings a player may hold, construction sites included: `rules::MAX_BUILDINGS`. */
export const MAX_BUILDINGS = 150;

/**
 * The three currencies, in server spelling, one purpose each: material buys
 * labour, structures and research; catalyst buys the army; terrazine buys
 * static defense.
 */
export type Currency = "material" | "catalyst" | "terrazine";
/** A price or a balance. Every currency is always present; zero is not absent. */
export interface Cost { material: number; catalyst: number; terrazine: number }

export const CURRENCIES: readonly Currency[] = ["material", "catalyst", "terrazine"];
export const CURRENCY_LABEL: Record<Currency, string> = { material: "Material", catalyst: "Catalyst", terrazine: "Terrazine" };
/** A price in each currency, mirroring `Cost::new` and `Cost::terrazine`. */
export const price = (material: number, catalyst = 0, terrazine = 0): Cost => ({ material, catalyst, terrazine });
export const NO_COST: Cost = price(0);
/** Every technology costs the same; the server has one price for all three. */
export const RESEARCH_COST: Cost = price(150);
export const RESEARCH_SECONDS = 15;

export interface Definition { label: string; hp: number; radius: number; cost: Cost; seconds: number; building: boolean; icon: string; role: string }
export const CATALOG: Record<string, Definition> = {
  hq: { label: "Headquarters", hp: 1200, radius: 34, cost: price(0), seconds: 0, building: true, icon: "house", role: "Primary base / labour production" },
  worker: { label: "Worker", hp: 60, radius: 10, cost: price(50), seconds: 3, building: false, icon: "hammer", role: "Industrial labour / mines 25 and walks it home, one miner per patch" },
  // The Network labour unit. It never holds cargo and never walks a load home,
  // so nothing that reads a load — the cargo bar, the return order, the cargo
  // line in the selection panel — applies to it.
  drifter: { label: "Drifter", hp: 40, radius: 9, cost: price(40), seconds: 2.5, building: false, icon: "radio", role: "Network labour / credits at the deposit, never returns" },
  // The Organic labour unit. Free of currency, bought with one point of hub
  // stock, carries 10, and cannot fight at all.
  harvester: { label: "Harvester", hp: 45, radius: 8, cost: price(0), seconds: 2, building: false, icon: "sprout", role: "Organic labour / costs 1 hub stock, gathers only" },
  soldier: { label: "Soldier", hp: 140, radius: 12, cost: price(0, 100), seconds: 5, building: false, icon: "swords", role: "Infantry / counters scouts" },
  scout: { label: "Scout", hp: 80, radius: 11, cost: price(0, 80), seconds: 3.5, building: false, icon: "radar", role: "Fast raider / vulnerable to infantry" },
  siege: { label: "Siege", hp: 220, radius: 17, cost: price(0, 200), seconds: 8, building: false, icon: "crosshair", role: "Long range / triple damage to buildings" },
  // Network army: fewer, stronger, half shields. Mirrors `rules::stats`.
  sentinel: { label: "Sentinel", hp: 220, radius: 13, cost: price(0, 150), seconds: 6.5, building: false, icon: "shield-half", role: "Network fighter / tough, hard-hitting, counters nothing in particular" },
  skimmer: { label: "Skimmer", hp: 70, radius: 10, cost: price(0, 90), seconds: 3.5, building: false, icon: "wind", role: "Network raider / fastest unit, triple damage to labour" },
  lancer: { label: "Lancer", hp: 240, radius: 16, cost: price(0, 250), seconds: 9, building: false, icon: "zap", role: "Network artillery / 250 range, triple damage to buildings" },
  // Organic army: cheap, fast, in numbers.
  swarmer: { label: "Swarmer", hp: 60, radius: 9, cost: price(0, 50), seconds: 2.25, building: false, icon: "bug", role: "Organic fighter / cheap fast melee, leaves a brood if it dies on your creep" },
  spitter: { label: "Spitter", hp: 85, radius: 11, cost: price(0, 90), seconds: 4, building: false, icon: "droplets", role: "Organic support / 150 range, fires over the swarm" },
  crusher: { label: "Crusher", hp: 420, radius: 18, cost: price(0, 250), seconds: 9, building: false, icon: "hammer", role: "Organic heavy / melee, triple damage to buildings, leaves a brute on your creep" },
  // The second tier of each roster (docs/honeybadger/ROSTER-PASSIVES.md).
  // Mirrors `rules::stats`; each role string ends where the passive line begins.
  marksman: { label: "Marksman", hp: 100, radius: 11, cost: price(0, 125), seconds: 5.5, building: false, icon: "target", role: "Industrial rifle / 170 range, fragile" },
  medic: { label: "Medic", hp: 90, radius: 11, cost: price(0, 100), seconds: 4.5, building: false, icon: "heart-pulse", role: "Industrial support / no weapon" },
  bulwark: { label: "Bulwark", hp: 420, radius: 17, cost: price(0, 225), seconds: 8.5, building: false, icon: "brick-wall", role: "Industrial tank / slow, tough, weak gun" },
  arcer: { label: "Arcer", hp: 90, radius: 11, cost: price(0, 140), seconds: 5.5, building: false, icon: "waypoints", role: "Network caster / 130 range, light" },
  phantom: { label: "Phantom", hp: 100, radius: 11, cost: price(0, 160), seconds: 6, building: false, icon: "ghost", role: "Network assassin / fast, short range, hits hard" },
  warden: { label: "Warden", hp: 300, radius: 16, cost: price(0, 250), seconds: 9, building: false, icon: "eye", role: "Network support walker / barely armed" },
  prowler: { label: "Prowler", hp: 70, radius: 10, cost: price(0, 80), seconds: 3, building: false, icon: "footprints", role: "Organic raider / fast melee" },
  devourer: { label: "Devourer", hp: 130, radius: 12, cost: price(0, 120), seconds: 4.25, building: false, icon: "flame", role: "Organic bruiser / tougher than a swarmer" },
  behemoth: { label: "Behemoth", hp: 450, radius: 19, cost: price(0, 275), seconds: 9.5, building: false, icon: "skull", role: "Organic siege beast / heavy, slow" },
  barracks: { label: "Barracks", hp: 700, radius: 34, cost: price(150), seconds: 8, building: true, icon: "tent", role: "Fighter and raider production" },
  factory: { label: "Factory", hp: 900, radius: 34, cost: price(250), seconds: 12, building: true, icon: "factory", role: "Heavy production / requires barracks" },
  turret: { label: "Turret", hp: 500, radius: 30, cost: price(0, 0, 100), seconds: 7, building: true, icon: "shield", role: "Automatic defense / 210 range / costs terrazine" },
  // Faction static defenses: terrazine, shoot like the turret, faction-gated.
  bunker: { label: "Bunker", hp: 800, radius: 30, cost: price(0, 0, 125), seconds: 8, building: true, icon: "brick-wall", role: "Industrial defense / 150 range, high hit points / costs terrazine" },
  bastion: { label: "Bastion", hp: 500, radius: 30, cost: price(0, 0, 125), seconds: 7.5, building: true, icon: "castle", role: "Network defense / 190 range / costs terrazine" },
  spine: { label: "Spine", hp: 600, radius: 30, cost: price(0, 0, 125), seconds: 7.5, building: true, icon: "triangle", role: "Organic defense / 170 range / costs terrazine" },
  refinery: { label: "Refinery", hp: 400, radius: 28, cost: price(75), seconds: 6, building: true, icon: "fuel", role: "Extracts catalyst from the deposit it stands on, with no workers / build on a catalyst deposit" },
  outpost: { label: "Outpost", hp: 650, radius: 30, cost: price(100), seconds: 6, building: true, icon: "warehouse", role: "Resource drop-off / base expansion" },
  lab: { label: "Laboratory", hp: 650, radius: 32, cost: price(200), seconds: 10, building: true, icon: "flask-conical", role: "Faction-wide research" },
  // Faction buildings: each projects its faction's zone and nobody else can
  // build it. `hp` is the listed total; a Network entity carries half of it as
  // shields, and the row's own `maxHp`/`maxShields` are what to draw against.
  sensor: { label: "Sensor tower", hp: 450, radius: 26, cost: price(175), seconds: 7, building: true, icon: "satellite-dish", role: "Industrial / your units move 30% faster within 450" },
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
/**
 * The whole roster per faction in command-card order: the barracks units, then
 * the factory units. `ARMY` above is the original trio each faction opens
 * with, which the bot and the tests still read as fighter, raider, heavy.
 */
export const ROSTER: Readonly<Record<"industrial" | "network" | "organic", readonly string[]>> = {
  industrial: ["soldier", "scout", "marksman", "medic", "siege", "bulwark"],
  network: ["sentinel", "skimmer", "arcer", "phantom", "lancer", "warden"],
  organic: ["swarmer", "spitter", "prowler", "devourer", "crusher", "behemoth"],
};
/** Trained at the factory: `rules::army_building`. */
export const FACTORY_KINDS: readonly string[] = ["siege", "lancer", "crusher", "bulwark", "warden", "behemoth"];
export const armyFaction = (kind: string): "industrial" | "network" | "organic" | undefined =>
  (Object.keys(ROSTER) as ("industrial" | "network" | "organic")[]).find(faction => ROSTER[faction].includes(kind));
export const isArmy = (kind: string): boolean => !!armyFaction(kind);
/** The factory trains each faction's heavy units; the barracks trains the rest. */
export const armyBuilding = (kind: string): string | undefined =>
  !isArmy(kind) ? undefined : FACTORY_KINDS.includes(kind) ? "factory" : "barracks";
/** A building that shoots: `rules::is_static_defense`. */
export const isStaticDefense = (kind: string): boolean => ["turret", "bunker", "bastion", "spine"].includes(kind);

// --- Passives -----------------------------------------------------------------

/**
 * Each kind's one passive and what it says, the single table every tooltip
 * reads. Mirrors `rules::passive`; the numbers are the constants in rules.rs.
 */
export const PASSIVES: Readonly<Record<string, { name: string; text: string }>> = {
  veteran: { name: "Veteran", text: "each kill gives +3% attack rate and speed, up to 15 stacks" },
  forced_march: { name: "Forced March", text: "+40% speed after 10s without dealing or taking damage" },
  shrapnel: { name: "Shrapnel", text: "each shell deals 50% to other enemies within 45 of the target" },
  acid_splash: { name: "Acid Splash", text: "hits deal 50% to other enemies within 35 of the target" },
  entrenchment: { name: "Entrenchment", text: "holding one spot for 7.5s gives +2 armour and +25 range" },
  field_medic: { name: "Field Medic", text: "heals the most-damaged friendly unit within 90 by 3 every 0.5s" },
  guardian: { name: "Guardian", text: "takes 30% of damage dealt to friendly units within 90" },
  battle_blink: { name: "Battle Blink", text: "at 30% health teleports 160 away from its attacker (12s)" },
  overwatch: { name: "Overwatch", text: "+50% damage for 1s after 10s without attacking" },
  ricochet: { name: "Ricochet", text: "hits jump to 2 more enemies within 70, at 50% then 25%" },
  ricochet_one: { name: "Ricochet", text: "each hit jumps to 1 more enemy within 70, at 50%" },
  phase_shift: { name: "Phase Shift", text: "the first hit it takes every 8s is fully absorbed" },
  shield_aura: { name: "Shield Aura", text: "friendly shields within 110 regenerate even under fire" },
  predator: { name: "Predator", text: "heals 30% of the damage it deals" },
  regrowth: { name: "Regrowth", text: "after 5s unhurt, regenerates 2% of its health every second" },
  death_burst: { name: "Death Burst", text: "when it dies, deals 80 to every enemy unit within 70" },
  fortified: { name: "Fortified", text: "always +2 armour" },
};
/** Kind to passive id: `rules::passive`. */
export const PASSIVE_OF: Readonly<Record<string, string>> = {
  soldier: "veteran", devourer: "veteran",
  scout: "forced_march", skimmer: "forced_march", prowler: "forced_march",
  siege: "shrapnel", spitter: "acid_splash",
  marksman: "entrenchment", medic: "field_medic", bulwark: "guardian",
  sentinel: "battle_blink", lancer: "overwatch", arcer: "ricochet", bastion: "ricochet_one",
  phantom: "phase_shift", warden: "shield_aura",
  swarmer: "predator", spine: "predator", crusher: "regrowth", behemoth: "death_burst", bunker: "fortified",
};
/** "Veteran: each kill ...", or undefined for a kind with no passive. */
export const passiveLine = (kind: string): string | undefined => {
  const passive = PASSIVES[PASSIVE_OF[kind]];
  return passive && `${passive.name}: ${passive.text}`;
};
/** A button's tooltip: the role, then the passive in one line. */
export const describe = (kind: string): string => {
  const role = CATALOG[kind]?.role ?? kind;
  const passive = passiveLine(kind);
  return passive ? `${role} / ${passive}` : role;
};
/** Veteran stacks held after `kills` kills: `rules::veteran_stacks`. */
export const veteranStacks = (kills: number): number => Math.min(15, kills);
/** Veteran kinds, whose stacks are drawn. */
export const isVeteran = (kind: string): boolean => PASSIVE_OF[kind] === "veteran";

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
export const currencyOf = (kind: ResourceKind): Currency => (kind.tag === "Catalyst" ? "catalyst" : kind.tag === "Terrazine" ? "terrazine" : "material");

/** The price of anything orderable, including the `research_*` orders. */
export function costOf(kind: string): Cost {
  if (kind.startsWith("research_")) return RESEARCH_COST;
  return CATALOG[kind]?.cost ?? NO_COST;
}

/**
 * The currency that stops a purchase, checking material first so the answer
 * matches `Balance::shortfall` on the server. Both currencies must cover the
 * price: there is no partial payment and no substitution.
 */
export function shortfall(balance: Cost, cost: Cost): Currency | undefined {
  if (balance.material < cost.material) return "material";
  if (balance.catalyst < cost.catalyst) return "catalyst";
  if (balance.terrazine < cost.terrazine) return "terrazine";
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
  terrazine: Math.max(0, balance.terrazine - cost.terrazine),
});

export const addCost = (left: Cost, right: Cost): Cost => ({
  material: left.material + right.material,
  catalyst: left.catalyst + right.catalyst,
  terrazine: left.terrazine + right.terrazine,
});

/** "100 catalyst + 100 terrazine", "50 material", "nothing". */
export function formatCost(cost: Cost): string {
  const parts = CURRENCIES.filter(currency => cost[currency] > 0).map(currency => `${cost[currency]} ${currency}`);
  return parts.join(" + ") || "nothing";
}

/** How far from a catalyst deposit a refinery may be aimed and still snap onto it: `rules::REFINERY_SNAP_DISTANCE`. */
export const REFINERY_SNAP_DISTANCE = 60;

/**
 * The catalyst deposit a refinery aimed at `(x, y)` would stand on, or why none
 * will take it. Mirrors `World::build_site`: the nearest deposit within the snap
 * distance that still holds catalyst and has no refinery on it yet.
 */
export function refinerySite(x: number, y: number, units: Entity[], nodes: Node[]): { node: Node } | { error: string } {
  const near = nodes.filter(node => currencyOf(node.kind) === "catalyst" && Math.hypot(node.x - x, node.y - y) <= REFINERY_SNAP_DISTANCE);
  if (!near.length) return { error: "A refinery must be built on a catalyst deposit" };
  const free = near
    .filter(node => node.amount > 0 && !units.some(unit => unit.kind === "refinery" && Math.hypot(unit.x - node.x, unit.y - node.y) < 1))
    .sort((left, right) => Math.hypot(left.x - x, left.y - y) - Math.hypot(right.x - x, right.y - y) || left.id - right.id);
  return free.length ? { node: free[0] } : { error: "That catalyst deposit is empty or already has a refinery" };
}

/**
 * Where a building aimed at `(x, y)` will actually stand. Every kind stands
 * where it was aimed except the refinery, which snaps onto its deposit; the
 * build preview draws here so what you see is where it goes.
 */
export function buildSite(kind: string, x: number, y: number, units: Entity[], nodes: Node[]): { x: number; y: number } {
  if (kind !== "refinery") return { x, y };
  const site = refinerySite(x, y, units, nodes);
  return "node" in site ? { x: site.node.x, y: site.node.y } : { x, y };
}

export function placementError(kind: string, aimX: number, aimY: number, owner: number, units: Entity[], nodes: Node[]): string | undefined {
  let x = aimX, y = aimY;
  if (kind === "refinery") {
    const site = refinerySite(aimX, aimY, units, nodes);
    if ("error" in site) return site.error;
    ({ x, y } = site.node);
  }
  // Bounds follow the map, not a constant: hardcoding the 1600 map's 1540 edge
  // confined building to the top-left quarter of a larger map.
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 60 || x > worldSize - 60 || y < 60 || y > worldSize - 60) return "Map boundary";
  if (terrain.some(([left, top, width, height]) => x > left - 50 && x < left + width + 50 && y > top - 50 && y < top + height + 50)) return "Terrain obstructed";
  // A refinery stands on a deposit by definition, so only other buildings and units obstruct it.
  if (units.some(unit => Math.hypot(unit.x - x, unit.y - y) < (isBuilding(unit.kind) ? 110 : 55)) || (kind !== "refinery" && nodes.some(node => Math.hypot(node.x - x, node.y - y) < 75))) return "Site occupied";
  const owned = units.filter(unit => unit.owner === owner && isBuilding(unit.kind));
  if (!owned.some(unit => unit.constructionRemaining === 0n && Math.hypot(unit.x - x, unit.y - y) <= 500)) return "Outside build radius";
  if (owned.length >= MAX_BUILDINGS) return "Building limit reached";
  if ((kind === "factory" || kind === "lab") && !owned.some(unit => unit.kind === "barracks" && unit.constructionRemaining === 0n)) return "Barracks required";
  return undefined;
}
