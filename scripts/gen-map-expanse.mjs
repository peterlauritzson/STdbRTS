#!/usr/bin/env node
// Deterministic generator for shared/maps/expanse.json (9600 units, 4 players).
//
// Run: node scripts/gen-map-expanse.mjs [--preview out.svg]
//
// The map is authored for ONE quadrant (player 0, top-left) and rotated 90
// degrees clockwise three times about the centre, so the 4-fold rotational
// symmetry is exact rather than eyeballed. Each base reuses crossfire's 8+2
// deposit arc verbatim (copied from its main base) and only rotates it to face
// the chosen direction, so mining distances match crossfire's economy.
//
// Deposit count note: maps.rs caps deposits at 256, so 24 bases (6 per
// quadrant, 240 deposits) is the most a 10-deposit base template allows.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const S = 9600;
const r1 = (v) => Math.round(v * 10) / 10;

// Crossfire's main-base template: offsets from the hall spot, in crossfire's
// own order (catalyst, 8 material, catalyst) with its kinds.
const cf = JSON.parse(readFileSync(path.join(root, "shared/maps/crossfire.json"), "utf8"));
const hall0 = cf.starts[0];
const template = cf.deposits.slice(0, 10).map((d) => ({
  dx: d.x - hall0[0],
  dy: d.y - hall0[1],
  kind: d.kind,
}));
const cx = template.reduce((a, t) => a + t.dx, 0) / 10;
const cy = template.reduce((a, t) => a + t.dy, 0) / 10;
const templateAngle = Math.atan2(cy, cx); // direction the arc faces

// Quadrant-0 bases. `face` is the direction the patch arc sits in relative to
// the hall (i.e. the hall's open side is opposite). `rich` = main-size stock.
const bases = [
  { name: "main", x: 850, y: 850, face: [-1, -1], rich: true },
  { name: "natural", x: 1150, y: 2300, face: [-1, 0.25], rich: true },
  { name: "third", x: 2600, y: 2300, face: [0.2, 1], rich: false },
  { name: "edge", x: 1000, y: 4200, face: [-1, 0], rich: false },
  { name: "diag", x: 3500, y: 3500, face: [-1, -1], rich: false },
  { name: "lane", x: 2400, y: 4800, face: [0, 1], rich: false },
];

// Blocking rectangles [left, top, width, height] for quadrant 0.
const rects = [
  // Main: closed on its east and south sides, one 300-wide ramp south.
  [1480, 0, 60, 1540],
  [0, 1480, 900, 60],
  [1200, 1480, 340, 60],
  // Ramp funnel just outside the gap.
  [860, 1540, 40, 320],
  [1200, 1540, 40, 320],
  // Natural: shield on its east side leaves exits north-east (to the third) and south.
  [1750, 1500, 80, 720],
  // Third: backed by a wall to the north so attacks come from the east/south.
  [2200, 1500, 900, 80],
  [3100, 1500, 80, 500],
  // Edge base: east shield with a lane gap.
  [1550, 3700, 80, 500],
  [1550, 4500, 80, 400],
  // Diagonal base brackets (open on the centre side).
  [2800, 3000, 80, 600],
  [3000, 2800, 600, 80],
  // Lane base: pillars north and south form an east-west corridor to the middle.
  [3000, 4300, 500, 80],
  [3000, 5220, 500, 80],
  // Centre: L-shaped blocks leave the two axes and the diagonals open.
  [4000, 4000, 500, 100],
  [4000, 4000, 100, 500],
  // Mid-field cover between third and centre.
  [4000, 2400, 100, 500],
  [2400, 4000, 500, 100],
];

const rot = (x, y) => [S - y, x]; // 90 degrees clockwise in screen space
const rotRect = ([x, y, w, h]) => [S - (y + h), x, h, w];

function arcFor(base, k) {
  let [fx, fy] = base.face;
  const target = Math.atan2(fy, fx);
  const turn = target - templateAngle;
  const c = Math.cos(turn), s = Math.sin(turn);
  return template.map((t) => ({
    x: base.x + t.dx * c - t.dy * s,
    y: base.y + t.dx * s + t.dy * c,
    kind: t.kind,
  }));
}

const starts = [];
const deposits = [];
const terrain = [];
const hallSpots = [];
let id = 1;
let rects_k = rects;
for (let k = 0; k < 4; k++) {
  for (const [i, base] of bases.entries()) {
    let b = { ...base };
    let face = base.face;
    let hx = base.x, hy = base.y;
    for (let n = 0; n < k; n++) {
      [hx, hy] = rot(hx, hy);
      face = [-face[1], face[0]]; // same rotation applied to a direction vector
    }
    b = { ...base, x: hx, y: hy, face };
    if (i === 0) starts.push([r1(hx), r1(hy)]);
    hallSpots.push({ name: `${base.name}${k}`, x: hx, y: hy });
    arcFor(b).forEach((d) => {
      const rich = base.rich;
      const amount = d.kind === "catalyst" ? (rich ? 2500 : 2000) : rich ? 1500 : 1200;
      deposits.push({ id: id++, x: r1(d.x), y: r1(d.y), amount, kind: d.kind });
    });
  }
  for (const r of rects_k) terrain.push(r);
  rects_k = rects_k.map(rotRect);
}

// Authoring self-checks: fail the generator rather than ship a bad layout.
const minRectDist = (x, y) => {
  let best = Infinity;
  for (const [rx, ry, rw, rh] of terrain) {
    const dx = Math.max(rx - x, 0, x - (rx + rw));
    const dy = Math.max(ry - y, 0, y - (ry + rh));
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
};
for (const h of hallSpots) {
  const d = minRectDist(h.x, h.y);
  if (d < 250) throw new Error(`hall ${h.name} only ${d.toFixed(0)} from terrain`);
}
for (const d of deposits) {
  const m = minRectDist(d.x, d.y);
  if (m < 70) throw new Error(`deposit ${d.id} only ${m.toFixed(0)} from terrain`);
}
for (let i = 0; i < hallSpots.length; i++)
  for (let j = i + 1; j < hallSpots.length; j++) {
    const d = Math.hypot(hallSpots[i].x - hallSpots[j].x, hallSpots[i].y - hallSpots[j].y);
    if (d < 1000) throw new Error(`bases ${hallSpots[i].name}/${hallSpots[j].name} only ${d.toFixed(0)} apart`);
  }
if (deposits.length > 256 || terrain.length > 256) throw new Error("exceeds validator caps");

const map = { id: "expanse", version: 1, size: S, starts, deposits, terrain };
writeFileSync(path.join(root, "shared/maps/expanse.json"), JSON.stringify(map, null, 1) + "\n");
console.log(`expanse: ${hallSpots.length} bases, ${deposits.length} deposits, ${terrain.length} rects`);

const pv = process.argv.indexOf("--preview");
if (pv > 0) {
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="1000" height="1000"><rect width="${S}" height="${S}" fill="#1b1f24"/>`];
  for (const [x, y, w, h] of terrain) o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#8a8f98"/>`);
  for (const d of deposits) o.push(`<circle cx="${d.x}" cy="${d.y}" r="32" fill="${d.kind === "catalyst" ? "#c04cff" : "#4cc2ff"}"/>`);
  for (const h of hallSpots) o.push(`<circle cx="${h.x}" cy="${h.y}" r="120" fill="none" stroke="#ffd24c" stroke-width="20"/><text x="${h.x}" y="${h.y}" font-size="160" fill="#fff">${h.name}</text>`);
  starts.forEach(([x, y], i) => o.push(`<circle cx="${x}" cy="${y}" r="60" fill="#5f5"/><text x="${x}" y="${y - 150}" font-size="260" fill="#5f5">P${i}</text>`));
  o.push("</svg>");
  writeFileSync(process.argv[pv + 1], o.join("\n"));
}
