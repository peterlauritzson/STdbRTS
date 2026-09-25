import assert from "node:assert/strict";
import test from "node:test";
import { clamp, COLORS, countdown, formation } from "../src/presentation";
import { buildScoreboard, formatClock, formatValue, niceMax, SAMPLE_INTERVAL_TICKS, TICKS_PER_SECOND, type Sample, type Scoreboard } from "../src/scoreboard";
import { DASHES, MARKERS } from "../src/scorescreen";
import { chooseOrders } from "../scripts/bot-policy";
import { pickOpponent, PRACTICE_FIRST_PUSH_TICK } from "../src/practice";
import { clampToMap, WORLD_SIZE } from "../src/presentation";
import { affords, cargoCapacity, carriesCargo, CATALOG, costOf, currencyOf, factionForSlot, factionOf, FACTION_ECONOMY, FACTION_LABEL, factionValue, FACTIONS, formatCost, gathersInPlace, HUB_STOCK_CAP, HUB_STOCK_INTERVAL_TICKS, isHub, isLabour, labourFaction, LABOUR, parseFaction, placementError, canProduce, mapIdentity, PRACTICE_SLOT, RESEARCH_COST, shortfall, shortfallReason, spend, STOCK_REASON, terrain, type Cost, type Currency, type FactionName } from "../src/catalog";
import { Faction, ResourceKind, type CreepPatch, type Entity, type Node } from "../src/bindings/types";
import { creepGoneTick, creepSecondsLeft, lifetimeFraction, offCreep } from "../src/creep";
import { ARMY, armyBuilding, armyFaction, fights, isArmy, isTemporary, takesSupply, TEMPORARY_LIFETIME } from "../src/catalog";

test("client renders the same map matches are actually played on", () => {
  // The server freezes this id into every new room, so a mismatch here means
  // the client would draw terrain the simulation does not have.
  assert.deepEqual(mapIdentity, { id: "crossfire", version: 1 });
  assert.equal(WORLD_SIZE, 3200);
  assert.equal(terrain.length, 28);
  // Four-fold rotational symmetry: every rectangle has its 90-degree image.
  const key = (r: readonly number[]) => r.join(",");
  const present = new Set(terrain.map(key));
  for (const [left, top, width, height] of terrain) {
    assert.ok(present.has(key([WORLD_SIZE - top - height, left, height, width])),
      `terrain rect ${key([left, top, width, height])} has no rotated twin`);
  }
});

test("countdown uses server ticks and freezes extrapolation during a stall", () => {
  assert.equal(countdown(120n, 100n, 0), 1);
  assert.equal(countdown(120n, 100n, 10000), 0.95);
  assert.equal(countdown(120n, 120n, 50), 0);
  assert.equal(countdown(120n, 130n, 0), 0);
});

test("an order is clamped to the map being played, not to the old 1600 extent", () => {
  // The bug this pins: `clamp(value, 16, 1584)` was written out by hand in the
  // order dispatch, so on a 3200 map every move and rally was forced into the
  // top-left quarter — you could not command the other three quadrants at all.
  assert.equal(WORLD_SIZE, 3200);
  for (const beyond of [1585, 1600, 2400, 3183]) {
    assert.equal(clampToMap(beyond), beyond, `${beyond} is on the map and must survive untouched`);
  }
  // It still keeps a point on the battlefield at both ends.
  assert.equal(clampToMap(-40), 16);
  assert.equal(clampToMap(WORLD_SIZE + 500), WORLD_SIZE - 16);
  assert.equal(clampToMap(16), 16);
  assert.equal(clampToMap(WORLD_SIZE - 16), WORLD_SIZE - 16);
});

test("presentation coordinates stay on the battlefield", () => {
  assert.equal(clamp(-50, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
  const edge = WORLD_SIZE - 20;
  assert.ok(formation(60, edge, 16).every(point => point.x >= 16 && point.x <= WORLD_SIZE - 16 && point.y >= 16 && point.y <= WORLD_SIZE - 16));
});

// --- Dual-currency economy --------------------------------------------------

test("the command card prices everything exactly as the ruleset does", () => {
  // The table in docs/honeybadger/DECISIONS.md, which server/src/rules.rs
  // implements. A client that quotes a different price sends orders the server
  // refuses, so this is pinned rather than inferred.
  const expected: [string, number, number][] = [
    ["worker", 50, 0], ["drifter", 40, 0], ["harvester", 0, 0], ["soldier", 100, 0], ["scout", 80, 0], ["siege", 150, 50],
    ["barracks", 150, 0], ["turret", 125, 0], ["outpost", 100, 0], ["factory", 200, 50], ["lab", 150, 50],
  ];
  for (const [kind, material, catalyst] of expected) assert.deepEqual(CATALOG[kind].cost, { material, catalyst }, kind);
  for (const kind of ["research_weapons", "research_armor", "research_logistics"]) assert.deepEqual(costOf(kind), { material: 100, catalyst: 50 }, kind);
  assert.deepEqual(costOf("worker"), CATALOG.worker.cost);
  // Only specialists and technology reach for catalyst.
  for (const kind of ["worker", "drifter", "harvester", "soldier", "scout", "barracks", "turret", "outpost"]) assert.equal(CATALOG[kind].cost.catalyst, 0, kind);
  for (const kind of ["siege", "factory", "lab"]) assert.ok(CATALOG[kind].cost.catalyst > 0 && CATALOG[kind].cost.material > 0, kind);
});

test("a multi-resource cost renders both currencies and never sums them", () => {
  assert.equal(formatCost(CATALOG.worker.cost), "50 material");
  assert.equal(formatCost(CATALOG.siege.cost), "150 material + 50 catalyst");
  assert.equal(formatCost(RESEARCH_COST), "100 material + 50 catalyst");
  assert.equal(formatCost({ material: 0, catalyst: 50 }), "50 catalyst");
  assert.equal(formatCost({ material: 0, catalyst: 0 }), "nothing");
});

test("affordability needs both currencies and names the one that is missing", () => {
  const price = CATALOG.siege.cost;
  assert.ok(affords({ material: 150, catalyst: 50 }, price));
  assert.equal(shortfall({ material: 150, catalyst: 50 }, price), undefined);
  // Material alone is not enough, and catalyst cannot be paid in material.
  assert.equal(shortfall({ material: 9000, catalyst: 20 }, price), "catalyst");
  assert.equal(shortfall({ material: 149, catalyst: 9000 }, price), "material");
  // Material is checked first, matching Balance::shortfall on the server.
  assert.equal(shortfall({ material: 0, catalyst: 0 }, price), "material");
  assert.ok(!affords({ material: 150, catalyst: 49 }, price));
  // Word for word what World::afford would have answered.
  assert.equal(shortfallReason({ material: 9000, catalyst: 20 }, price), "Insufficient catalyst: 50 needed, 20 available");
  assert.equal(shortfallReason({ material: 100, catalyst: 0 }, CATALOG.barracks.cost), "Insufficient material: 150 needed, 100 available");
  assert.equal(shortfallReason({ material: 150, catalyst: 50 }, price), undefined);
  assert.deepEqual(spend({ material: 250, catalyst: 60 }, price), { material: 100, catalyst: 10 });
});

test("resource kinds map to the currency a deposit or a load actually holds", () => {
  assert.equal(currencyOf(ResourceKind.Material), "material");
  assert.equal(currencyOf(ResourceKind.Catalyst), "catalyst");
});

// --- Practice opponent ------------------------------------------------------

function unit(id: number, owner: number, kind: string, stock = 0): Entity {
  const hp = kind === "hq" ? 1200 : 60;
  return { id, owner, kind, x: 220, y: 220, hp, maxHp: hp, shields: 0, maxShields: 0, damagedTick: 0n, warpTick: 0n, arriveTick: 0n, order: { kind: "stop", x: 0, y: 0, target: 0 }, queue: [], cargo: 0, cargoKind: ResourceKind.Material, returning: false, nextAttack: 0n, shotTick: 0n, shotX: 0, shotY: 0, production: [], constructionRemaining: 0n, research: [], stock, expiresTick: 0n };
}

function deposit(id: number, x: number, y: number, amount: number, currency: Currency = "material"): Node {
  return { id, x, y, amount, kind: currency === "catalyst" ? ResourceKind.Catalyst : ResourceKind.Material };
}

const purse = (material: number, catalyst = 0): Cost => ({ material, catalyst });

test("bot respects ownership, funds, pending orders and depleted nodes", () => {
  const units = [unit(1, 0, "hq"), unit(2, 0, "worker"), unit(3, 1, "worker")];
  assert.deepEqual(chooseOrders(0, "industrial", purse(0), units, [deposit(1, 300, 300, 0)], new Set()), []);
  assert.deepEqual(chooseOrders(0, "industrial", purse(250), units, [deposit(1, 300, 300, 50)], new Set([1, 2])), []);
  const decisions = chooseOrders(0, "industrial", purse(250), units, [deposit(1, 300, 300, 50)], new Set());
  assert.equal(decisions[0].order.kind, "gather");
  assert.equal(decisions[1].order.kind, "train_worker");
  assert.ok(decisions.every(decision => !decision.units.includes(3)));
});

test("bot reserves repair funds, assigns one worker and uses attack-move", () => {
  const units = [unit(1, 0, "hq"), unit(2, 0, "worker"), unit(3, 0, "worker"), ...[4, 5, 6, 7].map(id => unit(id, 0, "soldier")), unit(8, 1, "hq")];
  units[0].hp = 500;
  units[7].x = 1380;
  const decisions = chooseOrders(0, "industrial", purse(50), units, [], new Set());
  assert.equal(decisions.filter(decision => decision.order.kind === "repair").length, 1);
  assert.deepEqual(decisions[0].units, [2]);
  assert.equal(decisions[0].order.target, 1);
  assert.ok(!decisions.some(decision => decision.order.kind.startsWith("train_")));
  assert.equal(decisions[1].order.kind, "attack_move");
  assert.equal(decisions[1].order.x, 1290);
  units[1].order.kind = "repair";
  assert.ok(!chooseOrders(0, "industrial", purse(50), units, [], new Set()).some(decision => decision.order.kind === "repair"));
});

test("placement previews reject occupied, remote, terrain and prerequisite sites", () => {
  // Sited on the crossfire main hub, since that is where a match now starts.
  const hub = { ...unit(1, 0, "hq"), x: 600, y: 600 };
  const units = [hub];
  assert.equal(placementError("barracks", 600, 400, 0, units, []), undefined);
  assert.equal(placementError("barracks", 600, 600, 0, units, []), "Site occupied");
  // Inside the inner jaw of the natural choke, rect [820, 620, 110, 270].
  assert.equal(placementError("barracks", 870, 700, 0, units, []), "Terrain obstructed");
  assert.equal(placementError("barracks", 1800, 1800, 0, units, []), "Outside build radius");
  // The map boundary follows the map: this is legal ground on a 3200 map and
  // would have been rejected outright while the 1540 limit was hardcoded.
  assert.notEqual(placementError("barracks", 2600, 2600, 0, units, []), "Map boundary");
  assert.equal(placementError("factory", 600, 400, 0, units, []), "Barracks required");
  assert.ok(canProduce("scout", "barracks", "industrial"));
  assert.ok(!canProduce("siege", "hq", "industrial"));
});

test("bot builds a valid base without assigning a builder two simultaneous orders", () => {
  const units = [unit(1, 0, "hq"), ...[2, 3, 4, 5].map(id => unit(id, 0, "worker"))];
  const decisions = chooseOrders(0, "industrial", purse(250), units, [deposit(1, 360, 360, 4000)], new Set());
  const build = decisions.find(decision => decision.order.kind === "build_barracks")!;
  assert.ok(build);
  assert.equal(placementError("barracks", build.order.x, build.order.y, 0, units, []), undefined);
  assert.equal(decisions.filter(decision => decision.units.includes(build.units[0])).length, 1);
});

test("bot posts a share of its workers to catalyst once the opening is up", () => {
  const catalyst = deposit(7, 600, 800, 1200, "catalyst");
  const material = deposit(1, 360, 360, 4000);
  const opening = [unit(1, 0, "hq"), ...[2, 3, 4].map(id => unit(id, 0, "worker"))];
  // Three workers is still the opening: every one of them mines material, which
  // is what the early build order is actually paid in.
  const early = chooseOrders(0, "industrial", purse(250), opening, [material, catalyst], new Set()).filter(decision => decision.order.kind === "gather");
  assert.equal(early.length, 3);
  assert.ok(early.every(decision => decision.order.target === material.id));

  const grown = [unit(1, 0, "hq"), ...[2, 3, 4, 5].map(id => unit(id, 0, "worker"))];
  const decisions = chooseOrders(0, "industrial", purse(250), grown, [material, catalyst], new Set());
  const gathers = decisions.filter(decision => decision.order.kind === "gather");
  // One worker is taken by the barracks; of the three left, exactly two go to
  // catalyst — enough to reach the tech that needs it, not enough to starve the
  // material economy that pays for the army.
  assert.equal(gathers.filter(decision => decision.order.target === catalyst.id).length, 2);
  assert.equal(gathers.filter(decision => decision.order.target === material.id).length, 1);
  // Workers already on catalyst are counted, so the posting does not grow.
  const posted = grown.map(worker => worker.kind === "worker" && worker.id > 3 ? { ...worker, order: { kind: "gather", x: 0, y: 0, target: catalyst.id } } : worker);
  const resent = chooseOrders(0, "industrial", purse(250), posted, [material, catalyst], new Set()).filter(decision => decision.order.kind === "gather");
  assert.ok(resent.every(decision => decision.order.target === material.id));
  // A map with no catalyst left must not idle the workforce.
  const drained = chooseOrders(0, "industrial", purse(250), grown, [material, { ...catalyst, amount: 0 }], new Set()).filter(decision => decision.order.kind === "gather");
  assert.equal(drained.length, 3);
  assert.ok(drained.every(decision => decision.order.target === material.id));
});

test("bot will not order a specialist it cannot pay the catalyst for", () => {
  const units = [unit(1, 0, "hq"), unit(2, 0, "barracks"), unit(3, 0, "factory")];
  const starved = chooseOrders(0, "industrial", purse(400, 49), units, [], new Set());
  assert.ok(!starved.some(decision => decision.order.kind === "train_siege"));
  // Material was plentiful the whole time: it is the catalyst that stopped it.
  assert.equal(shortfall(purse(400, 49), CATALOG.siege.cost), "catalyst");
  const funded = chooseOrders(0, "industrial", purse(400, 50), units, [], new Set());
  assert.ok(funded.some(decision => decision.order.kind === "train_siege"));
  // 400/50 buys a worker, a soldier and the siege exactly; nothing is ordered
  // twice out of the same coin.
  assert.deepEqual(funded.map(decision => decision.order.kind), ["train_worker", "train_soldier", "train_siege"]);
});

test("bot buys catalyst-gated technology as soon as both currencies cover it", () => {
  const units = [unit(1, 0, "hq"), unit(2, 0, "lab")];
  const starved = chooseOrders(0, "industrial", purse(100, 49), units, [], new Set());
  assert.ok(!starved.some(decision => decision.order.kind.startsWith("research_")));
  // A catalyst shortage must not freeze the rest of the economy: the material
  // it cannot spend on technology still buys units, so the bot keeps playing.
  assert.deepEqual(starved.map(decision => decision.order.kind), ["train_worker"]);
  const decisions = chooseOrders(0, "industrial", purse(100, 50), units, [], new Set());
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].order.kind, "research_weapons");
  assert.deepEqual(decisions[0].units, [2]);
  // With the technology paid for, the bot goes back to producing units.
  const rich = chooseOrders(0, "industrial", purse(300, 50), units, [], new Set());
  assert.deepEqual(rich.map(decision => decision.order.kind), ["research_weapons", "train_worker"]);
  // A technology already owned is not bought twice.
  const done = units.map(entity => entity.kind === "hq" ? { ...entity, research: ["research_weapons", "research_armor", "research_logistics"] } : entity);
  assert.ok(!chooseOrders(0, "industrial", purse(300, 50), done, [], new Set()).some(decision => decision.order.kind.startsWith("research_")));
});

// --- Factions and the three labour units ------------------------------------

test("the generated faction sum type reads as the server's own spelling", () => {
  assert.equal(factionOf(Faction.Industrial), "industrial");
  assert.equal(factionOf(Faction.Network), "network");
  assert.equal(factionOf(Faction.Organic), "organic");
  // The server's refusals name the faction in exactly these words, so a
  // message never has to be translated between the two sides.
  assert.deepEqual([...FACTIONS], ["industrial", "network", "organic"]);
});

test("a chosen faction survives the trip to the reducer and back", () => {
  // `set_faction` takes the generated sum value, and every row that comes back
  // is read with `factionOf`. A picker is only ever as good as that round trip:
  // if it did not close, a player would choose one faction and play another.
  for (const faction of FACTIONS) assert.equal(factionOf(factionValue(faction)), faction);
  assert.deepEqual(factionValue("network"), Faction.Network);
  assert.deepEqual(factionValue("organic"), Faction.Organic);
  assert.deepEqual(factionValue("industrial"), Faction.Industrial);
});

test("a faction read back from a control or a stored preference is verified, never trusted", () => {
  for (const faction of FACTIONS) assert.equal(parseFaction(faction), faction);
  // Anything else is undefined so the caller falls back to a faction the server
  // will accept, rather than sending it a word it would refuse.
  for (const value of ["", "Industrial", "netvork", "worker", null, undefined]) {
    assert.equal(parseFaction(value), undefined, String(value));
  }
});

test("the client deals the same faction by slot as the server does", () => {
  // `rules::faction_for_slot` and its rotation, mirrored: the picker has to say
  // what one-click practice will give you before the server has said anything.
  assert.deepEqual([0, 1, 2, 3].map(factionForSlot), ["industrial", "network", "organic", "industrial"]);
  // Practice seats the human in slot 1 behind a bot that created the room, so
  // an untouched picker opens on exactly what that slot deals.
  assert.equal(PRACTICE_SLOT, 1);
  assert.equal(factionForSlot(PRACTICE_SLOT), "network");
});

test("every faction option says what the faction does, not only what it is called", () => {
  // The picker's options are built from these two records, which the lobby
  // brief and the match readout already use, so nothing is described twice.
  for (const faction of FACTIONS) {
    assert.ok(FACTION_LABEL[faction].length > 0, faction);
    assert.ok(FACTION_ECONOMY[faction].length > 0, faction);
    assert.ok(FACTION_ECONOMY[faction].toLowerCase().includes(LABOUR[faction]), `${faction} never names its labour unit`);
  }
});

test("each faction has exactly one labour unit and cannot see the other two", () => {
  assert.deepEqual(LABOUR, { industrial: "worker", network: "drifter", organic: "harvester" });
  for (const faction of FACTIONS) {
    assert.equal(labourFaction(LABOUR[faction]), faction);
    assert.ok(isLabour(LABOUR[faction]), faction);
    // Its own labour, at its own hub.
    assert.ok(canProduce(LABOUR[faction], "hq", faction), `${faction} cannot train ${LABOUR[faction]}`);
    for (const other of FACTIONS) {
      if (other === faction) continue;
      for (const building of ["hq", "outpost", "barracks", "factory"]) {
        assert.ok(!canProduce(LABOUR[other], building, faction), `${faction} must not train a ${LABOUR[other]} at a ${building}`);
      }
    }
  }
  // The named case from the server: no Industrial player may ever produce one.
  assert.ok(!canProduce("harvester", "hq", "industrial"));
  // Stock is per hub, so an Organic outpost has its own harvester capacity —
  // and an Industrial outpost still trains nothing at all.
  assert.ok(canProduce("harvester", "outpost", "organic"));
  assert.ok(!canProduce("worker", "outpost", "industrial"));
  assert.ok(!canProduce("drifter", "outpost", "network"));
  // Each faction trains its own army and nobody else's.
  for (const faction of FACTIONS) {
    const [fighter, raider, heavy] = ARMY[faction];
    assert.ok(canProduce(fighter, "barracks", faction), faction);
    assert.ok(canProduce(raider, "barracks", faction), faction);
    assert.ok(canProduce(heavy, "factory", faction) && !canProduce(heavy, "barracks", faction), faction);
    for (const other of FACTIONS) if (other !== faction) assert.ok(!canProduce(ARMY[other][0], "barracks", faction), `${faction} trained ${ARMY[other][0]}`);
    // A hub trains labour and nothing else: no barracks, no army.
    assert.ok(!canProduce(fighter, "hq", faction), faction);
    assert.ok(!canProduce("scout", "hq", faction), faction);
    assert.ok(!canProduce("siege", "hq", faction), faction);
  }
  // There is no builder unit for any faction; labour is the whole list.
  assert.ok(!isLabour("drone"));
  assert.ok(!isLabour("soldier"));
});

test("only the drifter carries nothing and the harvester carries least", () => {
  for (const carrier of ["worker", "harvester"]) {
    assert.ok(carriesCargo(carrier), carrier);
    assert.ok(!gathersInPlace(carrier), carrier);
  }
  // A cargo bar, a return order and a "returning" state all mean nothing for a
  // unit that credits at the deposit and never holds a load.
  assert.ok(!carriesCargo("drifter"));
  assert.ok(gathersInPlace("drifter"));
  assert.equal(cargoCapacity("harvester", false), 10);
  assert.equal(cargoCapacity("harvester", true), 16);
  assert.equal(cargoCapacity("worker", false), 25);
  assert.equal(cargoCapacity("worker", true), 40);
  // Bodies, mirroring rules::stats: cheaper and flimsier the less it hauls.
  assert.equal(CATALOG.worker.hp, 60);
  assert.equal(CATALOG.drifter.hp, 40);
  assert.equal(CATALOG.harvester.hp, 45);
  // Training times, in the seconds the command card quotes: 60, 50 and 40 ticks.
  assert.equal(CATALOG.worker.seconds, 3);
  assert.equal(CATALOG.drifter.seconds, 2.5);
  assert.equal(CATALOG.harvester.seconds, 2);
  // Free is not free of everything: a harvester costs one point of hub stock.
  assert.deepEqual(CATALOG.harvester.cost, { material: 0, catalyst: 0 });
  assert.equal(formatCost(CATALOG.harvester.cost), "nothing");
  assert.equal(formatCost(CATALOG.drifter.cost), "40 material");
  // The three are told apart by silhouette size as well as by shape: each one
  // has its own radius, so none of them is another's unit in a different hue.
  const radii = [CATALOG.worker.radius, CATALOG.drifter.radius, CATALOG.harvester.radius];
  assert.equal(new Set(radii).size, 3);
  assert.ok(CATALOG.harvester.radius < CATALOG.worker.radius, "the harvester is the smallest");
});

test("hub stock is the decided rate and cap, and the refusal is word for word", () => {
  assert.equal(HUB_STOCK_INTERVAL_TICKS, 60);
  assert.equal(HUB_STOCK_CAP, 7);
  assert.ok(isHub("hq"));
  assert.ok(isHub("outpost"));
  assert.ok(!isHub("barracks"));
  // Exactly what simulation.rs returns, so the disabled harvester button can
  // explain the rate and the cap before anything is sent.
  assert.equal(STOCK_REASON, "This hub has no harvester stock; it regenerates 1 every 60 ticks up to 7");
});

// --- The practice opponent plays all three factions --------------------------

const hubWith = (id: number, owner: number, kind: string, stock: number): Entity => unit(id, owner, kind, stock);

test("the bot trains its own faction's labour and never another's", () => {
  const deposits = [deposit(1, 300, 300, 4000)];
  const opening: Record<FactionName, Entity[]> = {
    industrial: [unit(1, 0, "hq"), unit(2, 0, "worker")],
    network: [unit(1, 0, "hq"), unit(2, 0, "drifter")],
    // The Organic hub opens with stock in hand; a stockless hub is its own case.
    organic: [hubWith(1, 0, "hq", 3), unit(2, 0, "harvester")],
  };
  for (const faction of FACTIONS) {
    const decisions = chooseOrders(0, faction, purse(250), opening[faction], deposits, new Set());
    const trained = decisions.filter(decision => decision.order.kind.startsWith("train_")).map(decision => decision.order.kind);
    assert.deepEqual(trained, [`train_${LABOUR[faction]}`], faction);
    // It also puts its opening labour on a deposit, whatever model it mines by.
    assert.ok(decisions.some(decision => decision.order.kind === "gather" && decision.units.includes(2)), faction);
  }
});

test("the bot leaves a drifter standing on its deposit and never orders a return", () => {
  const material = deposit(1, 300, 300, 4000);
  const parked = { ...unit(2, 0, "drifter"), order: { kind: "gather", x: 0, y: 0, target: material.id } };
  const decisions = chooseOrders(0, "network", purse(250), [unit(1, 0, "hq"), parked], [material], new Set());
  // A working drifter is never re-ordered: it has no return trip, so it stays
  // where it is for the rest of the match.
  assert.ok(!decisions.some(decision => decision.units.includes(2)));
  assert.ok(!decisions.some(decision => decision.order.kind === "return"));
  // Even a drifter that somehow shows a load is not sent home: the server
  // refuses that order by name, so the bot never issues it.
  const loaded = { ...unit(2, 0, "drifter"), cargo: 12 };
  const after = chooseOrders(0, "network", purse(250), [unit(1, 0, "hq"), loaded], [material], new Set());
  assert.ok(!after.some(decision => decision.order.kind === "return"));
  assert.equal(after.find(decision => decision.units.includes(2))?.order.kind, "gather");
  // A worker in the same position is sent home, because a worker does haul.
  const hauling = { ...unit(2, 0, "worker"), cargo: 12 };
  const industrial = chooseOrders(0, "industrial", purse(250), [unit(1, 0, "hq"), hauling], [material], new Set());
  assert.equal(industrial.find(decision => decision.units.includes(2))?.order.kind, "return");
});

test("the bot spends harvester stock and stops when the hub is empty", () => {
  const deposits = [deposit(1, 300, 300, 4000)];
  const stockless = [hubWith(1, 0, "hq", 0), unit(2, 0, "harvester")];
  // A price of nothing is always affordable, so a bot that checked only money
  // would order a harvester every pass and be refused every pass.
  assert.ok(affords(purse(0), CATALOG.harvester.cost));
  assert.ok(!chooseOrders(0, "organic", purse(250), stockless, deposits, new Set()).some(decision => decision.order.kind === "train_harvester"));
  // One point of stock buys exactly one harvester, not two out of the same hub.
  const single = [hubWith(1, 0, "hq", 1), unit(2, 0, "harvester")];
  const ordered = chooseOrders(0, "organic", purse(250), single, deposits, new Set()).filter(decision => decision.order.kind === "train_harvester");
  assert.equal(ordered.length, 1);
  assert.deepEqual(ordered[0].units, [1]);
  // An Organic outpost holds its own stock and spends it on its own harvester.
  const expanded = [hubWith(1, 0, "hq", 0), hubWith(3, 0, "outpost", 2), unit(2, 0, "harvester")];
  const fromOutpost = chooseOrders(0, "organic", purse(250), expanded, deposits, new Set()).filter(decision => decision.order.kind === "train_harvester");
  assert.deepEqual(fromOutpost.map(decision => decision.units), [[3]]);
  // An Industrial outpost is a drop-off and nothing else: it trains nobody.
  const industrial = [unit(1, 0, "hq"), unit(3, 0, "outpost"), unit(2, 0, "worker")];
  assert.ok(chooseOrders(0, "industrial", purse(250), industrial, deposits, new Set()).every(decision => !decision.units.includes(3)));
});

test("every faction still builds, mines catalyst and attacks, so it plays as an opponent", () => {
  const material = deposit(1, 360, 360, 4000);
  const catalyst = deposit(7, 600, 800, 1200, "catalyst");
  for (const faction of FACTIONS) {
    const kind = LABOUR[faction];
    const base: Entity[] = [hubWith(1, 0, "hq", HUB_STOCK_CAP), ...[2, 3, 4, 5].map(id => unit(id, 0, kind))];
    const decisions = chooseOrders(0, faction, purse(250), base, [material, catalyst], new Set());
    // Four labour is the barracks threshold for every faction alike, and the
    // site it picks is a legal one.
    const build = decisions.find(decision => decision.order.kind === "build_barracks");
    assert.ok(build, `${faction} never builds a barracks`);
    assert.equal(placementError("barracks", build!.order.x, build!.order.y, 0, base, []), undefined, faction);
    // A share of the workforce goes to catalyst, or the faction can never buy a
    // factory, a laboratory, siege or any technology at all.
    const gathers = decisions.filter(decision => decision.order.kind === "gather");
    assert.equal(gathers.filter(decision => decision.order.target === catalyst.id).length, 2, faction);
    // And it attacks with its army, never with labour.
    const army: Entity[] = [hubWith(1, 0, "hq", HUB_STOCK_CAP), ...[2, 3, 4, 5].map(id => unit(id, 0, "soldier")), { ...unit(9, 1, "hq"), x: 1380 }];
    const attack = chooseOrders(0, faction, purse(50), army, [], new Set()).find(decision => decision.order.kind === "attack_move");
    assert.ok(attack, `${faction} never attacks`);
    assert.deepEqual(attack!.units, [2, 3, 4, 5], faction);
    // Held, the same army stays home: practice holds the first push.
    assert.ok(!chooseOrders(0, faction, purse(50), army, [], new Set(), true).some(decision => decision.order.kind === "attack_move"), faction);
  }
});

test("the practice opponent is the picked faction, or any of the three at random", () => {
  assert.equal(pickOpponent("organic", 0.99), "organic");
  assert.deepEqual([0, 0.34, 0.67, 0.999999].map(roll => pickOpponent("random", roll)), ["industrial", "network", "organic", "organic"]);
  assert.equal(PRACTICE_FIRST_PUSH_TICK, 3600n);
});

test("the bot never asks a hub for an army unit, and a saturated hub orders nothing", () => {
  const deposits = [deposit(1, 300, 300, 4000)];
  const gathering = (id: number, kind: string): Entity => ({ ...unit(id, 0, kind), order: { kind: "gather", x: 0, y: 0, target: 1 } });
  for (const faction of FACTIONS) {
    const kind = LABOUR[faction];
    // Six labour is the opening for all three, and no barracks is down yet. A
    // hub trains labour and nothing else, so the HQ has nothing to make: the
    // old policy asked it for a soldier here, which the server refuses.
    const opening: Entity[] = [hubWith(1, 0, "hq", HUB_STOCK_CAP), ...[2, 3, 4, 5, 6, 7].map(id => gathering(id, kind))];
    const early = chooseOrders(0, faction, purse(400), opening, deposits, new Set());
    assert.ok(!early.some(decision => decision.units.includes(1)), `${faction} asked its HQ for something past the opening`);
    // It is building the barracks instead — the only route to an army.
    assert.ok(early.some(decision => decision.order.kind === "build_barracks"), `${faction} never builds a barracks`);

    // With a barracks up, the barracks makes the army and the HQ keeps growing
    // labour up to its per-hub share.
    const barracks = { ...unit(20, 0, "barracks"), x: 440, y: 220 };
    const outpost = { ...hubWith(21, 0, "outpost", HUB_STOCK_CAP), x: 220, y: 580 };
    const grown: Entity[] = [...opening, barracks, outpost];
    const trained = chooseOrders(0, faction, purse(600), grown, deposits, new Set()).filter(decision => decision.order.kind.startsWith("train_"));
    for (const decision of trained) {
      const producer = grown.find(entity => entity.id === decision.units[0])!;
      assert.ok(canProduce(decision.order.kind.slice("train_".length), producer.kind, faction), `${faction}: ${decision.order.kind} at ${producer.kind}`);
    }
    assert.ok(trained.some(decision => ARMY[faction].slice(0, 2).map(kind => `train_${kind}`).includes(decision.order.kind) && decision.units[0] === 20), faction);
    assert.ok(trained.some(decision => decision.order.kind === `train_${kind}` && decision.units[0] === 1), faction);
    // Only an Organic outpost trains anything, and only its own labour.
    assert.equal(trained.some(decision => decision.units[0] === 21), faction === "organic", faction);

    // A saturated workforce: every hub goes quiet, the barracks does not.
    const saturated: Entity[] = [...grown, ...Array.from({ length: 20 }, (_, index) => gathering(100 + index, kind))];
    const late = chooseOrders(0, faction, purse(600), saturated, deposits, new Set());
    assert.ok(!late.some(decision => decision.units.includes(1) || decision.units.includes(21)), `${faction} kept a saturated hub busy`);
    assert.ok(late.some(decision => ARMY[faction].slice(0, 2).map(kind => `train_${kind}`).includes(decision.order.kind)), faction);
  }
});

// --- The post-match score screen ---------------------------------------------

function sample(tick: number, slot: number, fields: Partial<Sample> = {}): Sample {
  return {
    tick: BigInt(tick), slot, material: 0, catalyst: 0, collectedMaterial: 0, collectedCatalyst: 0,
    armyValueMaterial: 0, armyValueCatalyst: 0, labour: 0, army: 0, buildings: 0,
    lostMaterial: 0, lostCatalyst: 0, ...fields,
  };
}

const facets = (board: Scoreboard) => board.panels.flatMap(panel => panel.facets);
const facet = (board: Scoreboard, key: string) => facets(board).find(entry => entry.key === key);
const values = (board: Scoreboard, key: string, slot: number) => facet(board, key)!.series.find(entry => entry.slot === slot)!.values;

/** A two-player match, sampled three times, with both currencies in play. */
function match(): Sample[] {
  return [
    sample(100, 0, { material: 120, collectedMaterial: 100, armyValueMaterial: 100, labour: 4, army: 1, buildings: 2 }),
    sample(100, 1, { material: 400, collectedMaterial: 60, labour: 3, army: 0, buildings: 1 }),
    sample(200, 0, { material: 40, catalyst: 30, collectedMaterial: 400, collectedCatalyst: 60, armyValueMaterial: 400, armyValueCatalyst: 50, labour: 7, army: 4, buildings: 3 }),
    sample(200, 1, { material: 900, collectedMaterial: 150, armyValueMaterial: 100, labour: 4, army: 1, buildings: 1 }),
    sample(300, 0, { material: 60, catalyst: 10, collectedMaterial: 800, collectedCatalyst: 140, armyValueMaterial: 700, armyValueCatalyst: 100, labour: 9, army: 7, buildings: 4, lostMaterial: 180 }),
    sample(300, 1, { material: 1400, collectedMaterial: 210, labour: 0, army: 0, buildings: 0, lostMaterial: 640 }),
  ];
}

test("the score screen plots mined income, army value, floating balance and labour", () => {
  const board = buildScoreboard(match());
  // Ticks become match time at the rate the simulation actually runs at.
  assert.equal(TICKS_PER_SECOND, 20);
  assert.equal(SAMPLE_INTERVAL_TICKS, 100);
  assert.deepEqual(board.seconds, [5, 10, 15]);
  assert.deepEqual(board.slots, [0, 1]);
  assert.deepEqual(board.panels.map(panel => panel.key), ["income", "army", "banked", "labour"]);
  // The two graphs the author asked for, and the two that explain them.
  assert.deepEqual(values(board, "mined-material", 0), [100, 400, 800]);
  assert.deepEqual(values(board, "mined-material", 1), [60, 150, 210]);
  assert.deepEqual(values(board, "army-material", 0), [100, 400, 700]);
  assert.deepEqual(values(board, "banked-material", 1), [400, 900, 1400]);
  assert.deepEqual(values(board, "labour", 0), [4, 7, 9]);
  // Income is mined income. The opening stipend pays 200 material a minute for
  // the first 90 seconds and is deliberately absent from the counter, so the
  // line is exactly what the server recorded and never that plus an opening.
  assert.equal(facet(board, "mined-material")!.series.find(entry => entry.slot === 0)!.final, 800);
  assert.equal(board.totals.find(entry => entry.slot === 0)!.mined.material, 800);
});

test("the two currencies are graphed apart and never added into one number", () => {
  const board = buildScoreboard(match());
  // Every facet is denominated in exactly one currency, or in no currency at
  // all. There is no axis anywhere that material and catalyst share.
  for (const entry of facets(board)) {
    assert.ok(entry.currency === "material" || entry.currency === "catalyst" || entry.currency === undefined, entry.key);
    if (entry.currency) assert.ok(entry.label.toLowerCase().includes(entry.currency), entry.label);
  }
  assert.deepEqual(values(board, "mined-catalyst", 0), [0, 60, 140]);
  assert.deepEqual(values(board, "mined-catalyst", 1), [0, 0, 0]);
  // A summed series would have to reach 800 + 140 somewhere; nothing does.
  assert.ok(!facets(board).some(entry => entry.series.some(series => series.final === 940)));
  const totals = board.totals.find(entry => entry.slot === 0)!;
  assert.deepEqual(totals.mined, { material: 800, catalyst: 140 });
  assert.deepEqual(totals.banked, { material: 60, catalyst: 10 });
  assert.deepEqual(totals.lost, { material: 180, catalyst: 0 });
});

test("a currency nobody ever touched is not given an empty axis of its own", () => {
  // Catalyst sits in contested ground and a great many matches end with none
  // of it mined at all. A flat-zero line reads as a claim; the facet goes.
  const board = buildScoreboard(match().map(row => ({ ...row, collectedCatalyst: 0, catalyst: 0, armyValueCatalyst: 0 })));
  assert.equal(facet(board, "mined-catalyst"), undefined);
  assert.equal(facet(board, "banked-catalyst"), undefined);
  assert.equal(facet(board, "army-catalyst"), undefined);
  assert.ok(facet(board, "mined-material"));
  assert.ok(board.panels.every(panel => !panel.empty), "no panel is empty while material is still in play");
});

test("a match that ended before the first sample says so instead of drawing a line", () => {
  // Nothing at all: tick 100 was never reached and the match ended on a tick
  // no final sample was taken for either.
  const empty = buildScoreboard([]);
  assert.deepEqual(empty.seconds, []);
  assert.deepEqual(empty.totals, []);
  assert.deepEqual(empty.panels.flatMap(panel => panel.facets), []);
  for (const panel of empty.panels) assert.ok(panel.empty.length > 0, panel.key);

  // One row per player: the final sample, taken the moment a very short match
  // ended. Every series is a single point, and none of it is NaN.
  const single = buildScoreboard([
    sample(63, 0, { collectedMaterial: 25, material: 275, labour: 3, buildings: 1 }),
    sample(63, 1, { material: 300, labour: 3, buildings: 1 }),
  ]);
  assert.deepEqual(single.seconds, [3.15]);
  assert.deepEqual(values(single, "mined-material", 0), [25]);
  assert.equal(facet(single, "mined-material")!.series[0].final, 25);
  assert.ok(facets(single).every(entry => entry.series.every(series => series.values.every(Number.isFinite))));
  assert.ok(facets(single).every(entry => entry.max > 0), "a facet always has a top, so a flat series still has a baseline");
  assert.equal(formatClock(single.seconds[0]), "00:03");
});

test("a commander with nothing left is marked out rather than flat-lining unexplained", () => {
  const board = buildScoreboard(match());
  const mined = facet(board, "mined-material")!;
  const wiped = mined.series.find(entry => entry.slot === 1)!;
  const alive = mined.series.find(entry => entry.slot === 0)!;
  // Slot 1 holds no labour, no army and no buildings at the last sample.
  assert.equal(wiped.outIndex, 2);
  assert.equal(alive.outIndex, undefined);
  assert.equal(board.totals.find(entry => entry.slot === 1)!.outSeconds, 15);
  assert.equal(board.totals.find(entry => entry.slot === 0)!.outSeconds, undefined);

  // A concession is the other way a commander reaches zero: World::surrender
  // removes their units outright, so it looks exactly like a rout here. The
  // transform marks the moment and claims nothing about which it was.
  const conceded = buildScoreboard([
    sample(100, 0, { collectedMaterial: 100, labour: 4, buildings: 2 }),
    sample(100, 1, { collectedMaterial: 90, labour: 4, buildings: 2 }),
    sample(140, 0, { collectedMaterial: 130, labour: 4, buildings: 2 }),
    sample(140, 1, { collectedMaterial: 110, material: 800, labour: 0, army: 0, buildings: 0 }),
  ]);
  const series = facet(conceded, "mined-material")!.series.find(entry => entry.slot === 1)!;
  assert.equal(series.outIndex, 1);
  assert.equal(conceded.totals.find(entry => entry.slot === 1)!.outSeconds, 7);
  // Everything they had is still on the record: the line flattens, it does not stop.
  assert.deepEqual(series.values, [90, 110]);
  assert.deepEqual(values(conceded, "banked-material", 1), [0, 800]);

  // A slot already gone at the very first sample is out from index 0.
  const gone = buildScoreboard([sample(100, 0, { labour: 3 }), sample(100, 1, { labour: 0 })]);
  assert.equal(facet(gone, "labour")!.series.find(entry => entry.slot === 1)!.outIndex, 0);
});

test("a sample that never arrived carries the line forward instead of punching a hole in it", () => {
  const board = buildScoreboard([
    sample(100, 0, { collectedMaterial: 100, labour: 3 }),
    sample(100, 1, { collectedMaterial: 80, labour: 3 }),
    sample(200, 0, { collectedMaterial: 300, labour: 5 }),
    sample(300, 0, { collectedMaterial: 500, labour: 6 }),
    sample(300, 1, { collectedMaterial: 240, labour: 4 }),
  ]);
  assert.deepEqual(values(board, "mined-material", 1), [80, 80, 240]);
  assert.deepEqual(values(board, "labour", 1), [3, 3, 4]);
});

test("income can be read as a rate as well as a total, from the same counter", () => {
  // Cumulative is the default: the counter is monotone, so its slope already
  // is the rate and its end point already is the match total. The rate view
  // differences the same counter into material a minute, measuring the first
  // point from the start of the match — honest, because the counter starts at
  // zero on tick zero.
  const board = buildScoreboard(match(), "rate");
  assert.equal(board.incomeMode, "rate");
  assert.deepEqual(values(board, "mined-material", 0), [1200, 3600, 4800]);
  assert.deepEqual(values(board, "mined-catalyst", 0), [0, 720, 960]);
  // Army value, banked and labour are untouched by the reading of income.
  assert.deepEqual(values(board, "army-material", 0), [100, 400, 700]);
  // A single-sample match still has a rate rather than a division by zero.
  const single = buildScoreboard([sample(60, 0, { collectedMaterial: 30 })], "rate");
  assert.deepEqual(values(single, "mined-material", 0), [600]);
  // And a sample at tick zero has no elapsed time to divide by: it reads as
  // nothing rather than as Infinity.
  const instant = buildScoreboard([sample(0, 0, { collectedMaterial: 40, labour: 3 }), sample(100, 0, { collectedMaterial: 140, labour: 3 })], "rate");
  assert.deepEqual(values(instant, "mined-material", 0), [0, 1200]);
  // With nothing mined at all the income panel says so rather than drawing a
  // pair of flat lines along the floor.
  const dry = buildScoreboard([sample(100, 0, { labour: 3 }), sample(100, 1, { labour: 3 })]);
  assert.equal(facet(dry, "mined-material"), undefined);
  assert.ok(dry.panels.find(panel => panel.key === "income")!.empty.length > 0);
  assert.ok(facet(dry, "labour"), "labour is still a real series");
});

test("axis ticks and clocks round to numbers a reader can hold", () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(-5), 1);
  assert.equal(niceMax(1), 1);
  assert.equal(niceMax(587), 1000);
  assert.equal(niceMax(1400), 2000);
  assert.equal(niceMax(2300), 2500);
  assert.equal(niceMax(4000), 5000);
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(65), "01:05");
  assert.equal(formatClock(600), "10:00");
  assert.equal(formatValue(1240), "1,240");
});

test("a commander's line is told apart by more than its colour", () => {
  // The battlefield colour is the mapping a player already knows, so it stays
  // the identity channel — but it is never the only one. Every slot also has
  // its own dash pattern and its own end marker, and the roster row pairs both
  // with the name, so the legend is readable without colour at all.
  assert.equal(DASHES.length, COLORS.length);
  assert.equal(MARKERS.length, COLORS.length);
  assert.equal(new Set(DASHES).size, DASHES.length);
  assert.equal(new Set(MARKERS).size, MARKERS.length);
  assert.equal(new Set(COLORS).size, COLORS.length);
});

// --- Organic creep and the temporary units it spawns ------------------------

const patch = (owner: number, x: number, y: number, radius: number, lostTick = 0n): CreepPatch =>
  ({ source: 1, owner, x, y, radius, maxRadius: 360, lostTick });

test("only an owner's own harvester, standing on none of its owner's creep, is off creep", () => {
  const creep = [patch(0, 220, 220, 100), patch(1, 900, 900, 300)];
  const at = (owner: number, kind: string, x: number, y: number) => ({ ...unit(9, owner, kind), x, y });
  assert.equal(offCreep(at(0, "harvester", 220, 220), creep), false);
  // The edge counts as on, as `Zone::contains` is `<=`.
  assert.equal(offCreep(at(0, "harvester", 320, 220), creep), false);
  assert.equal(offCreep(at(0, "harvester", 321, 220), creep), true);
  // Standing on somebody else's creep is still off your own.
  assert.equal(offCreep(at(0, "harvester", 900, 900), creep), true);
  // A receding patch still counts until it is removed.
  assert.equal(offCreep(at(0, "harvester", 220, 220), [patch(0, 220, 220, 20, 500n)]), false);
  // Nothing else is ever slowed by creep, so nothing else is "off" it.
  for (const kind of ["worker", "drifter", "soldier", "brood", "brute", "hq"]) assert.equal(offCreep(at(0, kind, 2000, 2000), creep), false, kind);
  assert.equal(offCreep(at(0, "harvester", 2000, 2000), []), true);
});

test("a receding patch's countdown mirrors advance_patch", () => {
  // Source alive: no countdown at all.
  assert.equal(creepGoneTick(patch(0, 0, 0, 360), 5000n), undefined);
  assert.equal(creepSecondsLeft(patch(0, 0, 0, 360), 5000n), undefined);
  // Lost on 1000 at radius 60: held to 1100, then -20 at 1120, 1140, 1160 —
  // gone on 1160 = L + 100 + 20 * ceil(60 / 20).
  assert.equal(creepGoneTick(patch(0, 0, 0, 60, 1000n), 1000n), 1160n);
  assert.equal(creepGoneTick(patch(0, 0, 0, 60, 1000n), 1119n), 1160n);
  // The row carries the current radius; the steps taken are counted back in.
  assert.equal(creepGoneTick(patch(0, 0, 0, 40, 1000n), 1120n), 1160n);
  assert.equal(creepGoneTick(patch(0, 0, 0, 40, 1000n), 1139n), 1160n);
  assert.equal(creepGoneTick(patch(0, 0, 0, 20, 1000n), 1140n), 1160n);
  // A radius that is not a multiple of 20 takes one more whole step.
  assert.equal(creepGoneTick(patch(0, 0, 0, 70, 1000n), 1000n), 1180n);
  // A full HQ patch: 5s of linger plus 18 one-second steps.
  assert.equal(creepSecondsLeft(patch(0, 0, 0, 360, 1000n), 1000n), 23);
  assert.equal(creepSecondsLeft(patch(0, 0, 0, 60, 1000n), 1100n), 3);

  // Walk it tick by tick through a local copy of advance_patch, so the two
  // are checked against each other rather than both against arithmetic.
  let radius = 90;
  const lost = 777n;
  const expected = creepGoneTick(patch(0, 0, 0, radius, lost), lost)!;
  for (let tick = lost; ; tick++) {
    const elapsed = tick - lost;
    if (elapsed > 100n && (elapsed - 100n) % 20n === 0n) radius = Math.max(0, radius - 20);
    if (radius === 0) { assert.equal(tick, expected); break; }
    assert.equal(creepGoneTick(patch(0, 0, 0, radius, lost), tick), expected, `tick ${tick}`);
  }
});

test("a temporary unit's lifetime bar runs from full at spawn to empty at expiry", () => {
  const brood = { ...unit(9, 0, "brood"), expiresTick: 1201n };
  assert.equal(lifetimeFraction(brood, 1001n), 1);
  assert.equal(lifetimeFraction(brood, 1101n), 0.5);
  assert.equal(lifetimeFraction(brood, 1201n), 0);
  assert.equal(lifetimeFraction(brood, 1300n), 0);
  assert.equal(lifetimeFraction({ ...unit(9, 0, "brute"), expiresTick: 1300n }, 1150n), 0.5);
  assert.equal(lifetimeFraction(unit(9, 0, "soldier"), 1000n), undefined);
});

test("brood and brutes fight but are not army, not trainable and take no supply", () => {
  for (const kind of ["brood", "brute"]) {
    assert.ok(isTemporary(kind) && fights(kind), kind);
    assert.equal(isArmy(kind), false, kind);
    assert.equal(takesSupply(kind), false, kind);
    assert.deepEqual(costOf(kind), { material: 0, catalyst: 0 });
    for (const building of ["hq", "outpost", "barracks", "factory"]) for (const faction of FACTIONS) assert.equal(canProduce(kind, building, faction), false);
  }
  assert.deepEqual([CATALOG.brood.hp, CATALOG.brute.hp], [30, 70]);
  assert.deepEqual([TEMPORARY_LIFETIME.brood, TEMPORARY_LIFETIME.brute], [200, 300]);
  assert.ok(takesSupply("soldier") && takesSupply("harvester") && !takesSupply("hq"));
  assert.equal(fights("harvester"), false);
});

test("the bot does not count brood toward its unit limit", () => {
  const army = Array.from({ length: 58 }, (_, index) => unit(100 + index, 0, "soldier"));
  const brood = Array.from({ length: 6 }, (_, index) => ({ ...unit(200 + index, 0, "brood"), expiresTick: 500n }));
  const units = [unit(1, 0, "hq"), { ...unit(2, 0, "barracks"), x: 400 }, ...army, ...brood];
  const decisions = chooseOrders(0, "organic", purse(5000, 5000), units, [], new Set(army.map(soldier => soldier.id)));
  assert.ok(decisions.some(decision => decision.order.kind === "train_swarmer" || decision.order.kind === "train_spitter"), JSON.stringify(decisions.map(decision => decision.order.kind)));
});

// --- Power and sensor fields, shields, teleport -------------------------------

import { arriving, BUILDING_FACTION, canTeleport, canTrainAt, channelFraction, fieldsOf, powered, POWER_FIELD_RADIUS, projectsPower, SENSOR_FIELD_RADIUS, shieldsRegenerating } from "../src/zones";

const factions: Record<number, FactionName> = { 0: "network", 1: "industrial" };
const placed = (id: number, owner: number, kind: string, x: number, y: number, remaining = 0n): Entity => ({ ...unit(id, owner, kind), x, y, constructionRemaining: remaining });

test("power fields come from Network relays and hubs only, and only once finished", () => {
  assert.ok(projectsPower("relay", "network") && projectsPower("hq", "network") && projectsPower("outpost", "network"));
  assert.ok(!projectsPower("hq", "industrial") && !projectsPower("hq", "organic") && !projectsPower("barracks", "network"));
  const units = [placed(1, 0, "hq", 200, 200), placed(2, 0, "relay", 1000, 200, 40n), placed(3, 1, "hq", 2000, 2000), placed(4, 1, "sensor", 2400, 2000)];
  const fields = fieldsOf(units, slot => factions[slot]);
  assert.deepEqual(fields.map(field => [field.kind, field.owner, field.radius]), [["power", 0, POWER_FIELD_RADIUS], ["sensor", 1, SENSOR_FIELD_RADIUS]]);
  assert.ok(powered(0, 200 + POWER_FIELD_RADIUS, 200, fields), "the edge counts, as `<=` on the server");
  assert.ok(!powered(0, 200 + POWER_FIELD_RADIUS + 1, 200, fields));
  assert.ok(!powered(1, 200, 200, fields), "owner only");
  assert.ok(!powered(0, 1000, 200, fields), "an unfinished relay projects nothing");
  assert.ok(!powered(1, 2400, 2000, fields), "a sensor field is not power");
  assert.deepEqual(BUILDING_FACTION, { sensor: "industrial", relay: "network" });
});

test("a drifter trains at any finished structure in its owner's field; nothing else changes", () => {
  const units = [placed(1, 0, "hq", 200, 200), placed(2, 0, "barracks", 400, 200), placed(3, 0, "barracks", 1200, 200), placed(4, 0, "lab", 450, 250, 10n)];
  const fields = fieldsOf(units, slot => factions[slot]);
  assert.ok(canTrainAt("drifter", units[0], "network", fields));
  assert.ok(canTrainAt("drifter", units[1], "network", fields), "barracks inside the HQ's field");
  assert.ok(!canTrainAt("drifter", units[2], "network", fields), "barracks outside every field");
  assert.ok(!canTrainAt("drifter", units[3], "network", fields), "unfinished");
  assert.ok(!canTrainAt("worker", units[1], "industrial", fields), "only the drifter trains in a field");
  assert.ok(canTrainAt("sentinel", units[1], "network", fields) && !canTrainAt("sentinel", units[0], "network", fields), "the army table is untouched");
});

test("shield, channel and arrival state read off the unit row", () => {
  const soldier = { ...unit(1, 0, "soldier"), maxHp: 70, shields: 30, maxShields: 70 };
  assert.ok(shieldsRegenerating({ ...soldier, damagedTick: 0n }, 50n), "never hit");
  assert.ok(!shieldsRegenerating({ ...soldier, damagedTick: 1000n }, 1199n), "inside the ten-second delay");
  assert.ok(shieldsRegenerating({ ...soldier, damagedTick: 1000n }, 1200n));
  assert.ok(!shieldsRegenerating({ ...soldier, shields: 70 }, 5000n), "full");
  assert.ok(!shieldsRegenerating({ ...unit(2, 1, "soldier") }, 5000n), "no shields at all");
  const channelling = { ...soldier, order: { kind: "teleport", x: 0, y: 0, target: 0 }, warpTick: 120n };
  assert.equal(channelFraction(channelling, 100n), 0);
  assert.equal(channelFraction(channelling, 110n), 0.5);
  assert.equal(channelFraction(channelling, 130n), 1);
  assert.equal(channelFraction(soldier, 110n), undefined);
  assert.ok(arriving({ arriveTick: 140n }, 139n) && !arriving({ arriveTick: 140n }, 140n));
  assert.ok(canTeleport("soldier") && canTeleport("drifter") && !canTeleport("relay") && !canTeleport("hq"));
});

test("each faction's army is priced and bodied as the server lists it", () => {
  // Mirrors rules::stats for the six faction units.
  const expected: Record<string, [number, number, number]> = {
    sentinel: [220, 150, 0], skimmer: [70, 90, 0], lancer: [240, 175, 75],
    swarmer: [60, 50, 0], spitter: [85, 90, 0], crusher: [420, 175, 75],
  };
  for (const [kind, [hp, material, catalyst]] of Object.entries(expected)) {
    assert.deepEqual([CATALOG[kind].hp, CATALOG[kind].cost.material, CATALOG[kind].cost.catalyst], [hp, material, catalyst], kind);
    assert.ok(isArmy(kind) && fights(kind) && takesSupply(kind), kind);
  }
  assert.deepEqual(FACTIONS.map(faction => ARMY[faction][2]).map(armyBuilding), ["factory", "factory", "factory"]);
  assert.equal(armyFaction("lancer"), "network");
  assert.equal(armyFaction("brood"), undefined);
});
