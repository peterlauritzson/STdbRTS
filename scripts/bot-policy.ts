import type { Entity, Node, Order } from "../src/bindings/types";

export interface Decision { units: number[]; order: Order }

export function chooseOrders(owner: number, resources: number, units: Entity[], nodes: Node[], busy: Set<number>): Decision[] {
  const owned = units.filter(unit => unit.owner === owner);
  const hq = owned.find(unit => unit.kind === "hq");
  if (!hq) return [];
  const decisions: Decision[] = [];
  const workers = owned.filter(unit => unit.kind === "worker");
  const soldiers = owned.filter(unit => unit.kind === "soldier");
  for (const worker of workers.filter(unit => unit.order.kind === "stop" && !busy.has(unit.id))) {
    const nearest = nodes.filter(node => node.amount > 0).sort((left, right) => Math.hypot(left.x - worker.x, left.y - worker.y) - Math.hypot(right.x - worker.x, right.y - worker.y))[0];
    if (worker.cargo) decisions.push({ units: [worker.id], order: { kind: "return", x: 0, y: 0, target: 0 } });
    else if (nearest) decisions.push({ units: [worker.id], order: { kind: "gather", x: 0, y: 0, target: nearest.id } });
  }
  const training = workers.length + hq.production.filter(item => item.kind === "worker").length < 4 ? "worker" : "soldier";
  if (!busy.has(hq.id) && resources >= (training === "worker" ? 50 : 100) && hq.production.length < 3 && owned.length - 1 + hq.production.length < 60) {
    decisions.push({ units: [hq.id], order: { kind: `train_${training}`, x: 0, y: 0, target: 0 } });
  }
  const targets = units.filter(unit => unit.owner !== owner && unit.kind === "hq").sort((left, right) => Math.hypot(left.x - hq.x, left.y - hq.y) - Math.hypot(right.x - hq.x, right.y - hq.y));
  const idle = soldiers.filter(unit => unit.order.kind === "stop" && !busy.has(unit.id));
  if (soldiers.length >= 4 && targets.length && idle.length) decisions.push({ units: idle.map(unit => unit.id), order: { kind: "attack", x: 0, y: 0, target: targets[0].id } });
  return decisions.slice(0, 6);
}