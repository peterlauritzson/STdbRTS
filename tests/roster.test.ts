import assert from "node:assert/strict";
import test from "node:test";
import { activityOf, armyRoster, cluster, composition, visibleRows, type RosterUnit } from "../src/roster";

let next = 1;
const unit = (kind: string, x: number, y: number, order = "stop", extra: Partial<RosterUnit> = {}): RosterUnit => ({ id: next++, owner: 0, kind, x, y, order: { kind: order }, ...extra });
const hub = { kind: "hq", x: 0, y: 0, constructionRemaining: 0n };

test("army only: own army units, no labour, no buildings, no enemies", () => {
  const units = [unit("soldier", 1000, 1000), unit("worker", 1000, 1000), unit("hq", 0, 0), { ...unit("soldier", 1000, 1000), owner: 1 }];
  const rows = armyRoster(units, 0, [hub]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 1);
});

test("activities come from orders; behaviors take precedence", () => {
  assert.deepEqual(activityOf({ order: { kind: "attack_move" } }), ["Attack-moving", 0]);
  assert.deepEqual(activityOf({ order: { kind: "stop" } }), ["Idle", 3]);
  assert.equal(activityOf({ order: { kind: "rally_move" } })[0], "Rally move");
  assert.deepEqual(activityOf({ order: { kind: "move" }, behavior: "guard", behaviorState: "watch" }), ["Guard", 0]);
});

test("single-link clustering splits distant groups deterministically", () => {
  const a = unit("soldier", 1000, 1000), b = unit("soldier", 1300, 1000), c = unit("soldier", 1600, 1000), far = unit("soldier", 3000, 3000);
  const groups = cluster([far, c, b, a]);
  assert.deepEqual(groups.map(group => group.map(member => member.id)), [[a.id, b.id, c.id], [far.id]]);
});

test("rows sort fighting, moving, holding, idle; idle in the field is flagged, idle at base is not", () => {
  const units = [unit("soldier", 100, 100, "stop"), unit("soldier", 3000, 3000, "stop"), unit("scout", 2000, 2000, "move"), unit("soldier", 2500, 500, "hold"), unit("soldier", 500, 2500, "attack_move")];
  const rows = armyRoster(units, 0, [hub]);
  assert.deepEqual(rows.map(row => row.activity), ["Attack-moving", "Moving", "Holding", "Idle", "Idle"]);
  const idle = rows.filter(row => row.activity === "Idle");
  assert.deepEqual(idle.map(row => [row.location, row.forgotten]).sort(), [["base", false], ["field", true]]);
});

test("an unfinished hub is not home", () => {
  const rows = armyRoster([unit("soldier", 10, 10)], 0, [{ ...hub, constructionRemaining: 5n }]);
  assert.equal(rows[0].location, "field");
});

test("composition lists the most numerous kind first", () => {
  assert.equal(composition(["scout", "soldier", "soldier"]), "2 Soldier · 1 Scout");
});

test("visibleRows caps at six, never hiding forgotten units", () => {
  const units = Array.from({ length: 8 }, (_, index) => unit("soldier", 5000 + index * 1000, 5000, index === 7 ? "stop" : "move"));
  const { shown, more } = visibleRows(armyRoster(units, 0, [hub]));
  assert.equal(shown.length, 7);
  assert.equal(more, 1);
  assert.ok(shown.some(row => row.forgotten));
});

test("stance defaults and order names mirror the server", async () => {
  const { defaultStance, stanceOrder, ROSTER } = await import("../src/catalog");
  for (const kind of ["marksman", "lancer", "spitter"]) assert.equal(defaultStance(kind), "kite");
  for (const kind of ["bulwark", "behemoth", "crusher"]) assert.equal(defaultStance(kind), "charge");
  assert.equal(defaultStance("soldier"), "standard");
  assert.equal(Object.values(ROSTER).flat().filter(kind => defaultStance(kind) !== "standard").length, 6);
  assert.equal(stanceOrder("marksman", "hold_ground"), "stance_marksman_hold_ground");
});

test("doctrine presets follow the roster and the order names mirror the server", async () => {
  const { presetWeights, doctrineWeightOrder, ROSTER, armyBuilding, DOCTRINE_SWITCH } = await import("../src/catalog");
  assert.deepEqual({ ...DOCTRINE_SWITCH }, { train: "doctrine_train", tier: "doctrine_tier", research: "doctrine_research", build: "doctrine_build" });
  assert.equal(doctrineWeightOrder("scout"), "doctrine_weight_scout");
  for (const faction of ["industrial", "network", "organic"] as const) {
    const kinds = ROSTER[faction];
    assert.deepEqual(Object.keys(presetWeights(faction, "even")), [...kinds]);
    assert.ok(Object.values(presetWeights(faction, "even")).every(weight => weight === 5));
    const basics = presetWeights(faction, "basics");
    assert.deepEqual(kinds.map(kind => basics[kind]), [10, 4, 0, 0, 0, 0]);
    const heavy = presetWeights(faction, "heavy");
    for (const kind of kinds) assert.equal(heavy[kind], armyBuilding(kind) === "factory" ? 8 : 3);
  }
});

test("mission members are labelled by their mission, not by the preset it runs", () => {
  const gatherer = unit("soldier", 1000, 1000, "move", { behavior: "guard" }), striker = unit("soldier", 3000, 3000, "attack_move", { behavior: "assault" }), free = unit("soldier", 2000, 100, "stop");
  const rows = armyRoster([gatherer, striker, free], 0, [hub], new Map([[gatherer.id, "Gather"], [striker.id, "Strike"]]));
  assert.deepEqual(rows.map(row => row.activity).sort(), ["Gather", "Idle", "Strike"]);
});
