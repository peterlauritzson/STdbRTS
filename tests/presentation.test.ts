import assert from "node:assert/strict";
import test from "node:test";
import { clamp, countdown, formation } from "../src/presentation";
import { chooseOrders } from "../scripts/bot-policy";
import { placementError, canProduce, mapIdentity, terrain } from "../src/catalog";
import type { Entity } from "../src/bindings/types";

test("client uses the versioned skirmish terrain without changing its layout", () => {
  assert.deepEqual(mapIdentity, { id: "skirmish", version: 1 });
  assert.deepEqual(terrain, [[560, 640, 160, 80], [880, 880, 160, 80], [640, 880, 80, 160], [880, 560, 80, 160]]);
});

test("countdown uses server ticks and freezes extrapolation during a stall", () => {
  assert.equal(countdown(120n, 100n, 0), 1);
  assert.equal(countdown(120n, 100n, 10000), 0.95);
  assert.equal(countdown(120n, 120n, 50), 0);
  assert.equal(countdown(120n, 130n, 0), 0);
});

test("presentation coordinates stay on the battlefield", () => {
  assert.equal(clamp(-50, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
  assert.ok(formation(60, 1580, 16).every(point => point.x >= 16 && point.x <= 1584 && point.y >= 16 && point.y <= 1584));
});

function unit(id: number, owner: number, kind: string): Entity {
  return { id, owner, kind, x: 220, y: 220, hp: kind === "hq" ? 1200 : 60, order: { kind: "stop", x: 0, y: 0, target: 0 }, queue: [], cargo: 0, returning: false, nextAttack: 0n, shotTick: 0n, shotX: 0, shotY: 0, production: [], constructionRemaining: 0n, research: [] };
}

test("bot respects ownership, funds, pending orders and depleted nodes", () => {
  const units = [unit(1, 0, "hq"), unit(2, 0, "worker"), unit(3, 1, "worker")];
  assert.deepEqual(chooseOrders(0, 0, units, [{ id: 1, x: 300, y: 300, amount: 0 }], new Set()), []);
  assert.deepEqual(chooseOrders(0, 250, units, [{ id: 1, x: 300, y: 300, amount: 50 }], new Set([1, 2])), []);
  const decisions = chooseOrders(0, 250, units, [{ id: 1, x: 300, y: 300, amount: 50 }], new Set());
  assert.equal(decisions[0].order.kind, "gather");
  assert.equal(decisions[1].order.kind, "train_worker");
  assert.ok(decisions.every(decision => !decision.units.includes(3)));
});

test("bot reserves repair funds, assigns one worker and uses attack-move", () => {
  const units = [unit(1, 0, "hq"), unit(2, 0, "worker"), unit(3, 0, "worker"), ...[4, 5, 6, 7].map(id => unit(id, 0, "soldier")), unit(8, 1, "hq")];
  units[0].hp = 500;
  units[7].x = 1380;
  const decisions = chooseOrders(0, 50, units, [], new Set());
  assert.equal(decisions.filter(decision => decision.order.kind === "repair").length, 1);
  assert.deepEqual(decisions[0].units, [2]);
  assert.equal(decisions[0].order.target, 1);
  assert.ok(!decisions.some(decision => decision.order.kind.startsWith("train_")));
  assert.equal(decisions[1].order.kind, "attack_move");
  assert.equal(decisions[1].order.x, 1290);
  units[1].order.kind = "repair";
  assert.ok(!chooseOrders(0, 50, units, [], new Set()).some(decision => decision.order.kind === "repair"));
});

test("placement previews reject occupied, remote, terrain and prerequisite sites", () => {
  const units = [unit(1, 0, "hq")];
  assert.equal(placementError("barracks", 440, 220, 0, units, []), undefined);
  assert.equal(placementError("barracks", 220, 220, 0, units, []), "Site occupied");
  assert.equal(placementError("barracks", 600, 680, 0, units, []), "Terrain obstructed");
  assert.equal(placementError("barracks", 1400, 1400, 0, units, []), "Outside build radius");
  assert.equal(placementError("factory", 440, 220, 0, units, []), "Barracks required");
  assert.ok(canProduce("scout", "barracks"));
  assert.ok(!canProduce("siege", "hq"));
});

test("bot builds a valid base without assigning a builder two simultaneous orders", () => {
  const units = [unit(1, 0, "hq"), ...[2, 3, 4, 5].map(id => unit(id, 0, "worker"))];
  const decisions = chooseOrders(0, 250, units, [{ id: 1, x: 360, y: 360, amount: 4000 }], new Set());
  const build = decisions.find(decision => decision.order.kind === "build_barracks")!;
  assert.ok(build);
  assert.equal(placementError("barracks", build.order.x, build.order.y, 0, units, []), undefined);
  assert.equal(decisions.filter(decision => decision.units.includes(build.units[0])).length, 1);
});