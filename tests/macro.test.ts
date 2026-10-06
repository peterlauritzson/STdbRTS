import assert from "node:assert/strict";
import test from "node:test";
import { placementError } from "../src/catalog";
import { assignPatches, baseSaturation, idleLabour, snapSite, SNAP_RADIUS, takenPatches } from "../src/macro";
import { ResourceKind, type Node } from "../src/bindings/types";
import type { Entity } from "../src/units";

function unit(id: number, owner: number, kind: string, x: number, y: number, order: Partial<Entity["order"]> = {}): Entity {
  const hp = kind === "hq" || kind === "outpost" ? 1200 : 60;
  return { id, owner, kind, x, y, hp, maxHp: hp, shields: 0, maxShields: 0, damagedTick: 0n, warpTick: 0n, arriveTick: 0n, order: { kind: "stop", x: 0, y: 0, target: 0, ...order }, queue: [], cargo: 0, cargoKind: ResourceKind.Material, shotTick: 0n, shotX: 0, shotY: 0, production: [], constructionRemaining: 0n, stock: 0, expiresTick: 0n, energy: 0, abilityReadyTick: 0n, cast: undefined, passiveReadyTick: 0n, kills: 0 } as Entity;
}
const patch = (id: number, x: number, y: number, miner = 0, amount = 1000): Node => ({ id, x, y, amount, kind: ResourceKind.Material, miner }) as Node;

const hub = unit(1, 0, "hq", 600, 600);

test("snapSite returns a valid aim unchanged", () => {
  assert.deepEqual(snapSite("barracks", 600, 400, 0, [hub], []), { x: 600, y: 400 });
});

test("your own units do not block a site, an enemy's do", () => {
  const own = unit(2, 0, "worker", 600, 400);
  assert.equal(placementError("barracks", 600, 400, 0, [hub, own], []), undefined);
  const enemy = unit(3, 1, "hq", 3000, 3000);
  assert.equal(placementError("barracks", 600, 400, 1, [enemy, own], []), "Enemy units block the site");
});

test("build reach looks one hop ahead through an unfinished building, and no further", () => {
  // The first row of the map with clear ground along the whole run.
  for (let y = 300; y < 3000; y += 100) {
    const base = unit(1, 0, "hq", 600, y);
    const building = (id: number, x: number) => ({ ...unit(id, 0, "barracks", x, y), constructionRemaining: 100n });
    const stepping = building(2, 1050);
    // 900 from the finished HQ, 450 from the unfinished barracks that is 450 from it.
    if (placementError("barracks", 1500, y, 0, [base, stepping], []) !== undefined) continue;
    assert.equal(placementError("barracks", 1500, y, 0, [base], []), "Outside build radius");
    // An unfinished building beyond reach of any finished one extends nothing.
    assert.equal(placementError("barracks", 1700, y, 0, [base, building(3, 1300)], []), "Outside build radius");
    // Not transitive: a second unfinished link off the first does not count.
    assert.equal(placementError("barracks", 1950, y, 0, [base, stepping, building(4, 1500)], []), "Outside build radius");
    return;
  }
  assert.fail("no clear row found");
});

test("snapSite slides an occupied aim to the nearest valid spot", () => {
  // An enemy worker standing on the aim blocks it; the nudge is short and valid.
  const worker = unit(2, 1, "worker", 600, 400);
  const units = [hub, worker];
  assert.equal(placementError("barracks", 600, 400, 0, units, []), "Enemy units block the site");
  const site = snapSite("barracks", 600, 400, 0, units, [])!;
  assert.ok(site);
  assert.equal(placementError("barracks", site.x, site.y, 0, units, []), undefined);
  assert.ok(Math.hypot(site.x - 600, site.y - 400) <= SNAP_RADIUS);
});

test("snapSite refuses when nothing near is valid or the refusal is not a nudge problem", () => {
  // Hemmed in by a ring of buildings, with a deposit on the aim.
  const ring = Array.from({ length: 24 }, (_, index) => unit(10 + index, 0, "barracks", 600 + Math.cos(index) * 120, 400 + Math.sin(index) * 120));
  const blocked = [hub, unit(40, 0, "barracks", 600, 400), ...ring];
  assert.equal(snapSite("barracks", 600, 400, 0, blocked, [{ ...patch(90, 600, 400) }]), undefined);
  // Out of build radius is a refusal, not something to jump around.
  assert.equal(snapSite("barracks", 1300, 1300, 0, [hub], []), undefined);
  // Factory without a barracks is refused whatever the spot.
  assert.equal(snapSite("factory", 600, 400, 0, [hub], []), undefined);
});

test("baseSaturation counts miners per base, including walking home, and idle labour by nearest hub", () => {
  const second = unit(2, 0, "outpost", 3000, 600);
  const nodes = [patch(1, 700, 700), patch(2, 700, 760), patch(3, 3100, 700), patch(4, 1500, 5000), patch(5, 720, 640, 0, 0)];
  const units = [
    hub, second,
    unit(10, 0, "worker", 650, 650, { kind: "gather", target: 1 }),
    unit(11, 0, "worker", 640, 640, { kind: "gather", target: 2 }),
    unit(12, 0, "worker", 3050, 650, { kind: "gather", target: 3 }),
    unit(13, 0, "worker", 2900, 600),
    unit(14, 1, "worker", 650, 650, { kind: "gather", target: 1 }),
  ];
  const rows = baseSaturation(units, nodes, 0);
  const a = rows.find(row => row.hub.id === 1)!, b = rows.find(row => row.hub.id === 2)!;
  assert.deepEqual([a.mining, a.patches, a.idle], [2, 2, 0]);
  assert.deepEqual([b.mining, b.patches, b.idle], [1, 1, 1]);
  assert.equal(idleLabour(units, 0).length, 1);
  assert.deepEqual(baseSaturation([], nodes, 0), []);
});

test("assignPatches gives each worker a distinct free patch, nearest first, then overflows", () => {
  const patches = [patch(1, 100, 100), patch(2, 200, 100), patch(3, 300, 100, 99)];
  const workers = [unit(10, 0, "worker", 90, 100), unit(11, 0, "worker", 210, 100), unit(12, 0, "worker", 205, 100)];
  const plan = assignPatches(workers, patches, new Set(), { x: 150, y: 100 });
  assert.deepEqual(plan.get(2), [12]);
  assert.ok(plan.get(1)!.includes(10));
  // Patch 3 has a miner, so the worker left over queues on the patch nearest the hub.
  assert.ok(!plan.has(3));
  const all = [...plan.values()].flat().sort();
  assert.deepEqual(all, [10, 11, 12]);
  // A patch other workers already head for is not free.
  const taken = assignPatches([workers[0]], patches, new Set([1]), { x: 150, y: 100 });
  assert.deepEqual([...taken.keys()], [2]);
  assert.equal(assignPatches(workers, [], new Set(), { x: 0, y: 0 }).size, 0);
});

test("takenPatches ignores the workers being moved", () => {
  const patches = [patch(1, 100, 100), patch(2, 200, 100)];
  const units = [unit(10, 0, "worker", 0, 0, { kind: "gather", target: 1 }), unit(11, 0, "worker", 0, 0, { kind: "gather", target: 2 })];
  assert.deepEqual([...takenPatches(units, 0, patches, new Set([10]))], [2]);
});
