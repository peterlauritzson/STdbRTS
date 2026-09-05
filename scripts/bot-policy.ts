import type { Entity, Node, Order } from "../src/bindings/types";
import { CATALOG, isArmy, isBuilding, placementError, TECHNOLOGIES } from "../src/catalog";

export interface Decision { units: number[]; order: Order }

export function chooseOrders(owner: number, resources: number, units: Entity[], nodes: Node[], busy: Set<number>): Decision[] {
  const owned = units.filter(unit => unit.owner === owner);
  const hq = owned.find(unit => unit.kind === "hq");
  if (!hq) return [];
  const decisions: Decision[] = [];
  const workers = owned.filter(unit => unit.kind === "worker");
  const soldiers = owned.filter(unit => isArmy(unit.kind));
  const assigned = new Set(busy);
  let available = resources;
  const repairing = workers.some(unit => unit.order.kind === "repair");
  const repairer = hq.hp < 900 && resources > 0 && !repairing
    ? workers.find(unit => !busy.has(unit.id)) : undefined;
  if (repairer) decisions.push({ units: [repairer.id], order: { kind: "repair", x: 0, y: 0, target: hq.id } });
  if (repairer) assigned.add(repairer.id);
  const site = owned.find(unit => unit.constructionRemaining > 0n && !workers.some(worker => worker.order.kind === "construct" && worker.order.target === unit.id));
  const builder = workers.filter(worker => !assigned.has(worker.id) && !["construct", "repair"].includes(worker.order.kind)).sort((left, right) => Number(left.order.kind !== "stop") - Number(right.order.kind !== "stop"))[0];
  if (site && builder) { decisions.push({ units: [builder.id], order: { kind: "construct", x: 0, y: 0, target: site.id } }); assigned.add(builder.id); }
  const has = (kind: string) => owned.some(unit => unit.kind === kind);
  const ready = (kind: string) => owned.some(unit => unit.kind === kind && unit.constructionRemaining === 0n);
  const desired = workers.length >= 4 && !has("barracks") ? "barracks"
    : workers.length >= 6 && !has("outpost") ? "outpost"
    : ready("barracks") && soldiers.length >= 3 && !has("factory") ? "factory"
    : soldiers.length >= 3 && !has("turret") ? "turret"
    : ready("factory") && !has("lab") ? "lab" : undefined;
  if (desired && builder && !assigned.has(builder.id) && available >= CATALOG[desired].cost) {
    const horizontal = hq.x < 800 ? 1 : -1;
    const vertical = hq.y < 800 ? 1 : -1;
    const point = [[220, 0], [0, 220], [220, 220], [360, 0], [0, 360], [360, 240], [240, 360], [-140, 140], [140, -140]]
      .map(([x, y]) => ({ x: hq.x + x * horizontal, y: hq.y + y * vertical }))
      .find(point => !placementError(desired, point.x, point.y, owner, units, nodes));
    if (point) {
      decisions.push({ units: [builder.id], order: { kind: `build_${desired}`, ...point, target: 0 } });
      available -= CATALOG[desired].cost; assigned.add(builder.id);
    }
  }
  for (const worker of workers.filter(unit => unit.order.kind === "stop" && !busy.has(unit.id))) {
    if (assigned.has(worker.id)) continue;
    const nearest = nodes.filter(node => node.amount > 0).sort((left, right) => Math.hypot(left.x - worker.x, left.y - worker.y) - Math.hypot(right.x - worker.x, right.y - worker.y))[0];
    if (worker.cargo) decisions.push({ units: [worker.id], order: { kind: "return", x: 0, y: 0, target: 0 } });
    else if (nearest) decisions.push({ units: [worker.id], order: { kind: "gather", x: 0, y: 0, target: nearest.id } });
  }
  const training = workers.length + hq.production.filter(item => item.kind === "worker").length < 6 ? "worker" : "soldier";
  const reserve = repairing || repairer ? 20 : 0;
  const technology = Object.keys(TECHNOLOGIES).find(kind => !hq.research.includes(`research_${kind}`) && !owned.some(unit => unit.production.some(item => item.kind === `research_${kind}`)));
  const lab = owned.find(unit => unit.kind === "lab" && unit.constructionRemaining === 0n && unit.production.length === 0 && !assigned.has(unit.id));
  if (lab && technology && available - reserve >= 150) {
    decisions.push({ units: [lab.id], order: { kind: `research_${technology}`, x: 0, y: 0, target: 0 } }); available -= 150;
  }
  let population = owned.filter(unit => !isBuilding(unit.kind)).length + owned.reduce((total, unit) => total + unit.production.filter(item => !item.kind.startsWith("research_")).length, 0);
  for (const producer of owned.filter(unit => unit.constructionRemaining === 0n && ["hq", "barracks", "factory"].includes(unit.kind) && !assigned.has(unit.id))) {
    const kind = producer.kind === "hq" ? training : producer.kind === "factory" ? "siege" : soldiers.filter(unit => unit.kind === "scout").length < soldiers.length / 4 ? "scout" : "soldier";
    if ((desired && available < CATALOG[desired].cost && kind !== "worker") || (lab && technology && available < 150)) continue;
    if (available - reserve >= CATALOG[kind].cost && producer.production.length < 2 && population < 60) {
      decisions.push({ units: [producer.id], order: { kind: `train_${kind}`, x: 0, y: 0, target: 0 } });
      available -= CATALOG[kind].cost; population++;
    }
  }
  const targets = units.filter(unit => unit.owner !== owner && unit.kind === "hq").sort((left, right) => Math.hypot(left.x - hq.x, left.y - hq.y) - Math.hypot(right.x - hq.x, right.y - hq.y));
  const idle = soldiers.filter(unit => unit.order.kind === "stop" && !busy.has(unit.id));
  if (soldiers.length >= 4 && targets.length && idle.length) {
    const target = targets[0];
    const gap = Math.hypot(hq.x - target.x, hq.y - target.y);
    decisions.push({ units: idle.map(unit => unit.id), order: { kind: "attack_move", x: target.x + (hq.x - target.x) / gap * 90, y: target.y + (hq.y - target.y) / gap * 90, target: 0 } });
  }
  return decisions.slice(0, 6);
}