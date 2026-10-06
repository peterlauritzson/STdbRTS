import assert from "node:assert/strict";
import test from "node:test";
import { allocate, behaviorGoals, excessMembers, isOverridden, missionLabel, parse, recruitPool, serialize, type Mission, type MissionUnit } from "../src/missions";

let next = 1;
const unit = (x: number, y: number, extra: Partial<MissionUnit> = {}): MissionUnit => ({ id: next++, owner: 0, kind: "soldier", x, y, order: { kind: "stop" }, ...extra });
const mission = (id: number, kind: Mission["kind"], x: number, y: number, size: Mission["size"], members: number[] = []): Mission => ({ id, kind, x, y, size, members: new Set(members) });
const none = new Set<number>();

test("pool: idle army only; labour, buildings, enemies, members, controlled and busy units are left out", () => {
  const idle = unit(0, 0), moving = unit(0, 0, { order: { kind: "move" } }), worker = unit(0, 0, { kind: "worker" }), enemy = unit(0, 0, { owner: 1 });
  const member = unit(0, 0), controlled = unit(0, 0), busy = unit(0, 0), running = unit(0, 0, { behavior: "raid" }), hq = unit(0, 0, { kind: "hq" });
  const pool = recruitPool([idle, moving, worker, enemy, member, controlled, busy, running, hq], 0, { assigned: new Set([member.id]), controlled: new Set([controlled.id]), fresh: none, busy: new Set([busy.id]) });
  assert.deepEqual(pool.map(entry => entry.id), [idle.id]);
});

test("pool: a brand-new unit walking to its rally is recruitable, an old one on a player's move is not", () => {
  const spawned = unit(0, 0, { order: { kind: "move" } }), ordered = unit(0, 0, { order: { kind: "move" } });
  const pool = recruitPool([spawned, ordered], 0, { assigned: none, controlled: none, fresh: new Set([spawned.id]), busy: none });
  assert.deepEqual(pool.map(entry => entry.id), [spawned.id]);
});

test("allocation: numeric missions in creation order, nearest units first, up to their size", () => {
  const near = unit(100, 100), mid = unit(500, 500), far = unit(5000, 5000);
  const first = mission(1, "harass", 0, 0, 2), second = mission(2, "guard", 5200, 5200, 1);
  const result = allocate([first, second], [far, mid, near]);
  assert.deepEqual(result, [{ missionId: 1, ids: [near.id, mid.id] }, { missionId: 2, ids: [far.id] }]);
});

test("allocation: a partly staffed mission only asks for what it is missing; a full one asks for nothing", () => {
  const a = unit(0, 0), b = unit(10, 10), c = unit(20, 20);
  const result = allocate([mission(1, "harass", 0, 0, 3, [901, 902]), mission(2, "guard", 0, 0, 1, [903])], [a, b, c]);
  assert.deepEqual(result, [{ missionId: 1, ids: [a.id] }]);
});

test("allocation: a rest mission takes whatever the numeric ones left", () => {
  const units = [unit(0, 0), unit(10, 0), unit(20, 0), unit(30, 0), unit(40, 0)];
  const result = allocate([mission(1, "raid", 9000, 9000, "rest"), mission(2, "harass", 0, 0, 2)], units);
  assert.deepEqual(result.find(entry => entry.missionId === 2)?.ids, [units[0].id, units[1].id]);
  assert.deepEqual(result.find(entry => entry.missionId === 1)?.ids.sort(), [units[2].id, units[3].id, units[4].id].sort());
});

test("allocation: several rest missions split the remainder evenly, each taking its nearest", () => {
  const west = [unit(0, 0), unit(10, 0), unit(20, 0)], east = [unit(9000, 0), unit(9010, 0), unit(9020, 0)];
  const result = allocate([mission(1, "raid", 0, 0, "rest"), mission(2, "raid", 9000, 0, "rest")], [...east, ...west]);
  assert.deepEqual(result.find(entry => entry.missionId === 1)?.ids.sort(), west.map(entry => entry.id).sort());
  assert.deepEqual(result.find(entry => entry.missionId === 2)?.ids.sort(), east.map(entry => entry.id).sort());
  const odd = allocate([mission(1, "raid", 0, 0, "rest"), mission(2, "raid", 9000, 0, "rest")], [unit(1, 1), unit(2, 2), unit(3, 3)]);
  assert.deepEqual(odd.map(entry => entry.ids.length), [2, 1], "ceil for the older mission, the rest for the next");
});

test("allocation: no pool, no orders", () => {
  assert.deepEqual(allocate([mission(1, "raid", 0, 0, "rest"), mission(2, "harass", 0, 0, 4)], []), []);
});

test("shrinking releases the farthest members only", () => {
  const close = unit(10, 0), middle = unit(500, 0), far = unit(5000, 0);
  const shrunk = mission(1, "guard", 0, 0, 1, [close.id, middle.id, far.id]);
  const byId = new Map([close, middle, far].map(entry => [entry.id, entry]));
  assert.deepEqual(excessMembers(shrunk, byId).sort(), [middle.id, far.id].sort());
  assert.deepEqual(excessMembers(mission(2, "raid", 0, 0, "rest", [close.id]), byId), []);
  assert.deepEqual(excessMembers(mission(3, "raid", 0, 0, 3, [close.id]), byId), []);
});

test("override: the player's own order frees a member, but not inside the grace window", () => {
  const goal = mission(1, "raid", 1000, 1000, "rest");
  const running = unit(0, 0, { behavior: "raid" });
  assert.equal(isOverridden(running, goal, { preset: "raid", x: 1000, y: 1000 }, false), false);
  const moved = unit(0, 0, { behavior: undefined, order: { kind: "move" } });
  assert.equal(isOverridden(moved, goal, undefined, false), true);
  assert.equal(isOverridden(moved, goal, undefined, true), false, "its order is still in the command delay");
  const other = unit(0, 0, { behavior: "guard" });
  assert.equal(isOverridden(other, goal, undefined, false), true, "a different preset");
  assert.equal(isOverridden(running, goal, { preset: "raid", x: 4000, y: 1000 }, false), true, "same preset, new goal");
  assert.equal(isOverridden(running, goal, undefined, false), false, "goal unknown: trust the preset");
});

test("goals come from the newest accepted behavior command naming the unit", () => {
  const command = (id: bigint, kind: string, x: number, units: number[], status = "executed", owner = 0) => ({ id, owner, status, units, order: { kind, x, y: 0 } });
  const goals = behaviorGoals([command(1n, "raid", 100, [7]), command(3n, "raid", 300, [7]), command(4n, "raid", 400, [7], "rejected"), command(5n, "move", 500, [7]), command(6n, "guard", 600, [8], "executed", 1)], 0);
  assert.deepEqual(goals.get(7), { id: 3n, preset: "raid", x: 300, y: 0 });
  assert.equal(goals.has(8), false, "another player's command");
});

test("labels: sized missions read members/size, rest missions just the count", () => {
  assert.equal(missionLabel(mission(1, "harass", 0, 0, 4, [1, 2, 3])), "HARASS 3/4");
  assert.equal(missionLabel(mission(2, "raid", 0, 0, "rest", [1, 2, 3, 4, 5, 6, 7])), "RAID 7");
});

test("missions survive a round trip through storage; garbage is dropped", () => {
  const saved = serialize([mission(3, "guard", 12, 34, 6, [5, 6]), mission(4, "raid", 56, 78, "rest")], 5);
  const loaded = parse(saved);
  assert.equal(loaded.nextId, 5);
  assert.deepEqual(loaded.missions.map(entry => [entry.id, entry.kind, entry.x, entry.y, entry.size, [...entry.members]]), [[3, "guard", 12, 34, 6, [5, 6]], [4, "raid", 56, 78, "rest", []]]);
  assert.deepEqual(parse("not json"), { nextId: 1, missions: [] });
  assert.deepEqual(parse(null), { nextId: 1, missions: [] });
  assert.equal(parse(JSON.stringify({ nextId: 2, missions: [{ id: 1, kind: "dance", x: 0, y: 0 }, null] })).missions.length, 0);
});

test("allocation: a sized mission peels units off an 'all rest' mission after free units, nearest first; rest missions never take from the reserve", () => {
  const free = unit(0, 0), raiderNear = unit(10, 10), raiderFar = unit(4000, 4000);
  const raid = mission(1, "raid", 9000, 9000, "rest", [raiderNear.id, raiderFar.id]);
  const guard = mission(2, "guard", 0, 0, 2);
  assert.deepEqual(allocate([raid, guard], [free], [raiderNear, raiderFar]), [{ missionId: 2, ids: [free.id, raiderNear.id] }]);
  // With no sized mission short of units, the reserve stays where it is.
  assert.deepEqual(allocate([raid], [], [raiderNear, raiderFar]), []);
});
