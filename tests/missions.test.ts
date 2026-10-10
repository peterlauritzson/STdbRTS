import assert from "node:assert/strict";
import test from "node:test";
import type { MissionRow } from "../src/bindings/types";
import { TACTIC_IDS, gatherNeeded, gatherRadius, memberActivities, missionActivity, TACTICS, clampPercent, clampSize, missionAt, missionGoals, missionLabel, missionOrders, ownMissions, type Mission } from "../src/missions";

// Staffing, release, shrink and the gather state machine live on the server
// (server/src/mission.rs, with Rust tests). What is left here is how the client
// reads the rows, labels them and builds their commands.

const row = (extra: Partial<MissionRow> = {}): MissionRow => ({
  key: 1n, matchId: 1n, id: 1, owner: 0, tactic: "harass", x: 100, y: 200, size: 4, state: "",
  stateTick: 0n, rallyX: 60, rallyY: 120, gatherPercent: 80, fallbackPercent: 40, strikeStrength: 0, members: [7, 8, 9], ...extra,
});
const mission = (extra: Partial<Mission> = {}): Mission => ({
  id: 1, tactic: "harass", x: 100, y: 200, size: 4, state: "", rally: { x: 60, y: 120 }, gatherPercent: 80, fallbackPercent: 40, members: new Set([7, 8, 9]), ...extra,
});

test("own missions: only mine, in creation order, -1 reads as rest, unknown tactics are skipped", () => {
  const list = ownMissions([row({ id: 3, owner: 0 }), row({ id: 2, owner: 1 }), row({ id: 1, size: -1, tactic: "raid" }), row({ id: 4, tactic: "bogus" })], 0);
  assert.deepEqual(list.map(entry => entry.id), [1, 3]);
  assert.equal(list[0].size, "rest");
  assert.deepEqual([...list[1].members], [7, 8, 9]);
  assert.deepEqual(ownMissions([row()], undefined), []);
});

test("labels: numeric and rest missions, and the gather states", () => {
  assert.equal(missionLabel(mission()), "HARASS 3/4");
  assert.equal(missionLabel(mission({ tactic: "raid", size: "rest" })), "RAID 3");
  assert.equal(missionLabel(mission({ tactic: "rush", size: "rest" })), "RUSH 3");
  assert.equal(missionLabel(mission({ tactic: "gather", size: 8, state: "gather", members: new Set([1, 2, 3, 4, 5]) })), "GATHER 5/8");
  assert.equal(missionLabel(mission({ tactic: "gather", size: "rest", state: "gather" })), "GATHER 3");
  assert.equal(missionLabel(mission({ tactic: "gather", state: "strike", members: new Set([1, 2, 3, 4, 5, 6, 7]) })), "STRIKE 7");
  assert.equal(missionLabel(mission({ tactic: "gather", state: "fallback" })), "FALL BACK");
  assert.equal(missionLabel(mission({ tactic: "gather", state: "defend", members: new Set([1, 2, 3, 4, 5]) })), "DEFEND 5");
  // Progress toward the strike: gathered over needed (80% of 8 = 7).
  assert.equal(missionLabel(mission({ tactic: "gather", size: 8, state: "gather", members: new Set([1, 2, 3, 4, 5]) }), 3), "GATHER 3/7");
  assert.equal(missionLabel(mission({ tactic: "gather", size: "rest", state: "gather" }), 2), "GATHER 2/8");
});

test("gather radius scales with the members; needed follows size and share", () => {
  assert.equal(gatherRadius(1), 250);
  assert.equal(gatherRadius(12), 250);
  assert.ok(Math.abs(gatherRadius(100) - 700) < 1e-9);
  assert.equal(gatherNeeded({ size: 8, members: new Set(), gatherPercent: 80 }), 7);
  assert.equal(gatherNeeded({ size: 1, members: new Set(), gatherPercent: 10 }), 1);
  assert.equal(gatherNeeded({ size: "rest", members: new Set([1, 2, 3]), gatherPercent: 80 }), 8);
  assert.equal(gatherNeeded({ size: "rest", members: new Set(Array.from({ length: 20 }, (_, i) => i)), gatherPercent: 80 }), 16);
});

test("roster activity: mission tactic, or the gather state; a strike's late joiners read Gather", () => {
  assert.equal(missionActivity(mission({ tactic: "raid" })), "Hit & retreat");
  assert.equal(missionActivity(mission({ tactic: "gather", state: "gather" }), "guard"), "Gather");
  assert.equal(missionActivity(mission({ tactic: "gather", state: "strike" }), "assault"), "Strike");
  assert.equal(missionActivity(mission({ tactic: "gather", state: "strike" }), "guard"), "Gather");
  assert.equal(missionActivity(mission({ tactic: "gather", state: "defend" })), "Defend");
  assert.equal(missionActivity(mission({ tactic: "gather", state: "fallback" })), "Fall back");
  assert.deepEqual([...memberActivities([mission({ tactic: "rush", members: new Set([7]) })], [{ id: 7 }, { id: 8 }])], [[7, "Rush"]]);
});

test("tactics: five, raid keeps its id but reads Hit & retreat, defaults match the server", () => {
  assert.deepEqual(TACTIC_IDS, ["harass", "guard", "raid", "rush", "gather"]);
  assert.equal(TACTICS.raid.label, "Hit & retreat");
  assert.deepEqual(TACTIC_IDS.map(id => TACTICS[id].defaultSize), [4, 6, "rest", "rest", "rest"]);
  assert.equal(TACTICS.rush.preset, "assault");
});

test("goals: a gather mission is labelled by its rally while gathering and by its point while striking", () => {
  assert.deepEqual(missionGoals(mission({ tactic: "gather", state: "gather" })), [{ preset: "guard", x: 60, y: 120 }]);
  assert.deepEqual(missionGoals(mission({ tactic: "gather", state: "strike" })), [{ preset: "assault", x: 100, y: 200 }, { preset: "guard", x: 60, y: 120 }]);
  assert.deepEqual(missionGoals(mission({ tactic: "guard" })), [{ preset: "guard", x: 100, y: 200 }]);
});

test("click: the first mission within its radius", () => {
  const list = [mission({ id: 1, x: 0, y: 0 }), mission({ id: 2, x: 500, y: 500 })];
  assert.equal(missionAt(list, { x: 30, y: 30 })?.id, 1);
  assert.equal(missionAt(list, { x: 500, y: 560 })?.id, 2);
  assert.equal(missionAt(list, { x: 300, y: 300 }), undefined);
});

test("commands: kinds, the mission in target, rest as -1, knobs clamped to 10..100", () => {
  assert.deepEqual(missionOrders.create("gather", { x: 100, y: 200 }), { kind: "mission_new_gather", x: 100, y: 200, target: 0 });
  assert.equal(missionOrders.create("rush", { x: -50, y: 99999 }).x, 16, "placed inside the map");
  assert.deepEqual(missionOrders.tactic(5, "raid"), { kind: "mission_tactic_raid", x: 0, y: 0, target: 5 });
  assert.deepEqual(missionOrders.size(5, "rest"), { kind: "mission_size", x: -1, y: 0, target: 5 });
  assert.equal(missionOrders.size(5, 500).x, 99);
  assert.equal(missionOrders.gather(5, 3).x, 10);
  assert.equal(missionOrders.fallback(5, 250).x, 100);
  assert.deepEqual(missionOrders.rally(5, { x: 300, y: 400 }), { kind: "mission_rally", x: 300, y: 400, target: 5 });
  assert.equal(missionOrders.cancel(5).kind, "mission_cancel");
  assert.equal(missionOrders.assign(5).kind, "mission_assign");
  assert.equal(clampSize(0), 1);
  assert.equal(clampPercent(55.4), 55);
});
