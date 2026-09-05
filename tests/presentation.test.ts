import assert from "node:assert/strict";
import test from "node:test";
import { clamp, countdown, formation } from "../src/presentation";
import { chooseOrders } from "../scripts/bot-policy";
import type { Entity } from "../src/bindings/types";

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
  return { id, owner, kind, x: 220, y: 220, hp: 60, order: { kind: "stop", x: 0, y: 0, target: 0 }, queue: [], cargo: 0, returning: false, nextAttack: 0n, shotTick: 0n, shotX: 0, shotY: 0, production: [] };
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