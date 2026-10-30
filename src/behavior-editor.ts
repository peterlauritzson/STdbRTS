import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "../styles.css";
import "./guide.css";
import "./behavior-editor.css";
import { createIcons, ClipboardCopy, Copy, Download, LayoutGrid, Plus, Trash2, Upload } from "lucide";
import { appendLayout, assignSlot, addEntry, createEntry, deleteEntry, duplicateEntry, entryName, entryStatus, exportJson, findEntry, importText, LIBRARY_KEY, loadLibrary, removeLayoutAt, saveLibrary, slotOf, stateCount, updateEntry, type Library, type Position } from "./behavior-library";
import { BLANK_TEXT, CONDITIONS, CUSTOM_COLORS, MAX_CUSTOM, MAX_POLICY_TEXT, MAX_STATES, MAX_TRANSITIONS, PRESET_TEXTS, actionLabel, clonePolicy, cleanName, describeCondition, nextTransition, parsePolicy, removeState, serializePolicy, type Policy, type PolicyState, type Situation } from "./policies";
import { policyForm, text } from "./policy-form";

createIcons({ icons: { ClipboardCopy, Copy, Download, LayoutGrid, Plus, Trash2, Upload } });

const $ = <Type extends HTMLElement = HTMLElement>(id: string): Type => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element ${id}`);
  return node as Type;
};

// ---- State ----------------------------------------------------------------

let library: Library = loadLibrary();
let selectedId: string | null = null;
/** The parsed draft of the selected entry; null when no entry is selected or its text is broken. */
let draft: Policy | null = null;
let layout: Position[] = [];
/** The text last written to (or read from) the library for the selected entry. */
let savedText = "";
let draftError: string | null = null;
let selection: { kind: "state"; index: number } | { kind: "edge"; from: number; at: number } | null = null;
let persisted = true;
const tryState = { index: 0, situation: { healthPercent: 100, goalDistance: 500, homeDistance: 100, enemyDistance: Infinity, enemies: 0, allies: 0, secondsInState: 2 } as Situation };

// ---- Diagram geometry -----------------------------------------------------

const BOX_W = 150;
const BOX_H = 60;
const ACTION_COLOR = { attack: "#ee8a92", move: "#74bde8", hold: "#dcc06f" } as const;
const actionColor = (state: PolicyState): string => state.action.startsWith("attack") ? ACTION_COLOR.attack : state.action.startsWith("move") ? ACTION_COLOR.move : ACTION_COLOR.hold;

/** Layered top to bottom by breadth-first distance from state 0 (wide arrow labels sit in the gaps between rows); a tall chain folds into a second column. */
export function autoLayout(policy: Policy): Position[] {
  const count = policy.states.length;
  const depth: number[] = Array(count).fill(-1);
  depth[0] = 0;
  const queue = [0];
  for (const at of queue) for (const transition of policy.states[at].transitions) if (depth[transition.to] < 0) { depth[transition.to] = depth[at] + 1; queue.push(transition.to); }
  const stray = [...Array(count).keys()].filter(index => depth[index] < 0);
  const layers = Math.max(...depth) + 1;
  const sizes: number[] = Array(layers).fill(0);
  for (const layer of depth) if (layer >= 0) sizes[layer] += 1;
  const widest = Math.max(...sizes);
  const perColumn = layers > 5 ? Math.ceil(layers / 2) : layers;
  const seen: number[] = Array(layers).fill(0);
  const result: Position[] = Array(count);
  for (let index = 0; index < count; index++) {
    const layer = depth[index];
    if (layer < 0) continue;
    const column = Math.floor(layer / perColumn);
    const x = column * (widest * 250 + 40) + (widest - sizes[layer]) * 125 + seen[layer]++ * 250;
    result[index] = [x, 20 + (layer % perColumn) * 150];
  }
  // States nothing leads to yet go in rows of three below the rest.
  const below = 20 + Math.min(layers, perColumn) * 150;
  stray.forEach((index, at) => { result[index] = [(at % 3) * 250, below + Math.floor(at / 3) * 110]; });
  return result;
}

/** A layout with a position for every state: stored ones where they fit, an automatic layout otherwise. */
function fitLayout(policy: Policy, stored: Position[] | undefined): Position[] {
  if (stored && stored.length === policy.states.length) return stored.map(([x, y]) => [x, y] as Position);
  return autoLayout(policy);
}

const centre = (at: number): Position => [layout[at][0] + BOX_W / 2, layout[at][1] + BOX_H / 2];

/** Where the line from a box's centre toward `target` leaves the box. */
function clip(at: number, target: Position, gap = 0): Position {
  const [cx, cy] = centre(at);
  const dx = target[0] - cx;
  const dy = target[1] - cy;
  if (!dx && !dy) return [cx, cy];
  const scale = Math.min((BOX_W / 2 + gap) / Math.abs(dx || 1e-9), (BOX_H / 2 + gap) / Math.abs(dy || 1e-9));
  return [cx + dx * scale, cy + dy * scale];
}

interface Edge { from: number; at: number; to: number; path: string; label: Position; badge: Position }

/** Every transition as an arrow: straight, curved apart from its parallel and opposite siblings, or a loop above its box. */
function edges(policy: Policy): Edge[] {
  const all: { from: number; at: number; to: number }[] = [];
  policy.states.forEach((state, from) => state.transitions.forEach((transition, at) => all.push({ from, at, to: transition.to })));
  const groups = new Map<string, typeof all>();
  for (const edge of all) {
    if (edge.from === edge.to) continue;
    const key = `${Math.min(edge.from, edge.to)}-${Math.max(edge.from, edge.to)}`;
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }
  const loops = new Map<number, number>();
  return all.map(edge => {
    if (edge.from === edge.to) {
      const nth = loops.get(edge.from) ?? 0;
      loops.set(edge.from, nth + 1);
      const [x, y] = layout[edge.from];
      const rise = 36 + nth * 26;
      const spread = 10 + nth * 8;
      const left = x + BOX_W * 0.3;
      const right = x + BOX_W * 0.7;
      return { ...edge, path: `M ${left} ${y} C ${left - spread} ${y - rise} ${right + spread} ${y - rise} ${right} ${y}`, label: [x + BOX_W / 2, y - rise * 0.75 - 6] as Position, badge: [left - spread * 0.4, y - rise * 0.55] as Position };
    }
    const group = groups.get(`${Math.min(edge.from, edge.to)}-${Math.max(edge.from, edge.to)}`)!;
    const nth = group.indexOf(edge);
    // Parallel arrows carry their labels at different heights along the arrow, so the wide labels do not collide.
    const tLabel = 0.5 + (nth - (group.length - 1) / 2) * 0.3;
    const canonical = (nth - (group.length - 1) / 2) * 30;
    const base = edge.from < edge.to ? canonical : -canonical;
    const [ax, ay] = centre(edge.from);
    const [bx, by] = centre(edge.to);
    const length = Math.hypot(bx - ax, by - ay) || 1;
    const normal: Position = [-(by - ay) / length, (bx - ax) / length];
    const shape = (bend: number) => {
      const control: Position = [(ax + bx) / 2 + normal[0] * bend * 2, (ay + by) / 2 + normal[1] * bend * 2];
      const start = clip(edge.from, control, 2);
      const end = clip(edge.to, control, 5);
      const at = (t: number): Position => [(1 - t) ** 2 * start[0] + 2 * (1 - t) * t * control[0] + t * t * end[0], (1 - t) ** 2 * start[1] + 2 * (1 - t) * t * control[1] + t * t * end[1]];
      return { control, start, end, at };
    };
    // Bend further when the arrow would pass through a box that is neither its source nor its target.
    const crosses = (curve: ReturnType<typeof shape>): boolean => {
      for (let t = 0.12; t <= 0.88; t += 0.06) {
        const [px, py] = curve.at(t);
        if (layout.some(([x, y], other) => other !== edge.from && other !== edge.to && px > x - 8 && px < x + BOX_W + 8 && py > y - 8 && py < y + BOX_H + 8)) return true;
      }
      return false;
    };
    let curve = shape(base);
    for (const extra of [70, -70, 140, -140]) { if (!crosses(curve)) break; curve = shape(base + extra); }
    const { control, start, end, at } = curve;
    return { ...edge, path: `M ${start[0]} ${start[1]} Q ${control[0]} ${control[1]} ${end[0]} ${end[1]}`, label: at(edge.from < edge.to ? tLabel : 1 - tLabel), badge: at(0.14) };
  });
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgNode<Tag extends keyof SVGElementTagNameMap>(tag: Tag, attributes: Record<string, string | number> = {}, ...children: (SVGElement | string)[]): SVGElementTagNameMap[Tag] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  for (const child of children) node.append(child);
  return node;
}

const shorten = (value: string, longest: number): string => value.length > longest ? `${value.slice(0, longest - 1)}…` : value;
const conditionLabel = (when: { type: never; value: number }[] | Policy["states"][number]["transitions"][number]["when"]): string => when.length ? when.map(condition => describeCondition(condition)).join(" & ") : "after 1 s";

const labelWords = (transition: Policy["states"][number]["transitions"][number]): string => shorten(conditionLabel(transition.when), 34);
const labelWidth = (words: string): number => words.length * 6.5 + 14;

let frozenBox: [number, number, number, number] | null = null;
/** Fits every box and every arrow label (arcs swing labels out past the outermost boxes). */
function viewBox(policy: Policy): [number, number, number, number] {
  const xs = layout.map(([x]) => x);
  const ys = layout.map(([, y]) => y);
  let minX = Math.min(...xs) - 60;
  let maxX = Math.max(...xs) + BOX_W + 60;
  let minY = Math.min(...ys) - 110;
  let maxY = Math.max(...ys) + BOX_H + 70;
  for (const edge of edges(policy)) {
    const half = labelWidth(labelWords(policy.states[edge.from].transitions[edge.at])) / 2 + 16;
    minX = Math.min(minX, edge.label[0] - half); maxX = Math.max(maxX, edge.label[0] + half);
    minY = Math.min(minY, edge.label[1] - 24); maxY = Math.max(maxY, edge.label[1] + 24);
  }
  const width = Math.max(360, maxX - minX);
  const height = Math.max(300, maxY - minY);
  minX -= (width - (maxX - minX)) / 2; maxX = minX + width;
  minY -= (height - (maxY - minY)) / 2; maxY = minY + height;
  return [minX, minY, maxX - minX, maxY - minY];
}

function renderDiagram(): void {
  const canvas = $("be-canvas");
  if (!draft) { canvas.replaceChildren(text("p", draftError ? "Fix the text in the inspector to see the diagram." : "No behavior selected.", "be-hint be-placeholder")); return; }
  const policy = draft;
  const [vx, vy, vw, vh] = frozenBox ?? viewBox(policy);
  const root = svgNode("svg", { viewBox: `${vx} ${vy} ${vw} ${vh}`, role: "img", "aria-label": `State diagram of ${policy.label}, ${policy.states.length} states`, class: "be-svg" });
  root.style.aspectRatio = `${vw} / ${vh}`;
  root.style.maxWidth = `${Math.round(vw * 1.15)}px`;
  root.replaceChildren(...scene(policy));
  bindDiagram(root);
  canvas.replaceChildren(root);
}

/** The drawn contents of the diagram: arrow heads, arrows, boxes and labels. */
function scene(policy: Policy): SVGElement[] {
  const defs = svgNode("defs", {},
    ...[["arrow", "#8fa598"], ["arrow-hot", "#cce48c"]].map(([id, fill]) => svgNode("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, orient: "auto-start-reverse" }, svgNode("path", { d: "M 0 1 L 10 5 L 0 9 z", fill }))));
  const wires = svgNode("g", { class: "be-wires" });
  const labels = svgNode("g", { class: "be-labels" });
  const list = edges(policy);
  // Selected arrows are drawn last so they stay readable above the rest.
  const picked = (edge: Edge): boolean => selection?.kind === "edge" && selection.from === edge.from && selection.at === edge.at;
  const firing = openTry() ? nextTransition(policy, tryState.index, tryState.situation) : null;
  for (const edge of [...list].sort((left, right) => Number(picked(left)) - Number(picked(right)))) {
    const transition = policy.states[edge.from].transitions[edge.at];
    const hot = picked(edge);
    const fires = firing?.fired === edge.at && tryState.index === edge.from;
    const cls = `be-edge${hot ? " selected" : ""}${fires ? " fires" : ""}`;
    wires.append(
      svgNode("path", { d: edge.path, class: "be-edge-hit", "data-edge": `${edge.from}:${edge.at}` }),
      svgNode("path", { d: edge.path, class: cls, "marker-end": `url(#${hot || fires ? "arrow-hot" : "arrow"})` }),
    );
    const words = labelWords(transition);
    const width = labelWidth(words);
    labels.append(svgNode("g", { class: `be-label${hot ? " selected" : ""}`, "data-edge": `${edge.from}:${edge.at}`, transform: `translate(${edge.label[0]} ${edge.label[1]})` },
      svgNode("title", {}, `${policy.states[edge.from].name} → ${policy.states[edge.to]?.name ?? "?"}: ${conditionLabel(transition.when)}`),
      svgNode("rect", { x: -width / 2, y: -10, width, height: 20, rx: 10 }),
      svgNode("text", { "text-anchor": "middle", y: 4 }, words)));
    labels.append(svgNode("g", { class: "be-badge", transform: `translate(${edge.badge[0]} ${edge.badge[1]})` }, svgNode("circle", { r: 8 }), svgNode("text", { "text-anchor": "middle", y: 4 }, String(edge.at + 1))));
  }
  const boxes = svgNode("g", { class: "be-boxes" });
  policy.states.forEach((state, index) => {
    const [x, y] = layout[index];
    const color = actionColor(state);
    const chosen = selection?.kind === "state" && selection.index === index;
    const current = openTry() && tryState.index === index;
    const group = svgNode("g", { class: `be-box${chosen ? " selected" : ""}${current ? " current" : ""}`, "data-state": index, transform: `translate(${x} ${y})` },
      svgNode("title", {}, `#${index} ${state.name}: ${actionLabel(state.action)}`),
      svgNode("rect", { width: BOX_W, height: BOX_H, rx: 10, class: "be-box-body" }),
      svgNode("rect", { width: 6, height: BOX_H - 16, x: 0, y: 8, rx: 3, fill: color }),
      svgNode("text", { x: 18, y: 25, class: "be-box-name" }, shorten(state.name, 13)),
      svgNode("text", { x: 18, y: 44, class: "be-box-action", fill: color }, shorten(actionLabel(state.action), 22)),
      svgNode("circle", { cx: BOX_W, cy: BOX_H / 2, r: 7, class: "be-port", "data-port": index }, svgNode("title", {}, "Drag to another state to add a transition")));
    if (index === 0) group.append(svgNode("g", { class: "be-start" }, svgNode("rect", { x: 8, y: -11, width: 52, height: 18, rx: 9 }), svgNode("text", { x: 34, y: 2, "text-anchor": "middle" }, "START")));
    boxes.append(group);
  });
  return [defs, wires, boxes, labels];
}

const openTry = (): boolean => (document.getElementById("be-try") as HTMLDetailsElement | null)?.open === true;

// ---- Diagram interaction --------------------------------------------------

type Drag = { mode: "move"; index: number; start: Position; origin: Position; moved: boolean } | { mode: "link"; from: number; line: SVGLineElement; moved: boolean } | { mode: "pick"; target: string; start: Position; moved: boolean };

function bindDiagram(root: SVGSVGElement): void {
  let drag: Drag | null = null;
  const point = (event: PointerEvent): Position => {
    const matrix = root.getScreenCTM();
    if (!matrix) return [event.clientX, event.clientY];
    const mapped = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return [mapped.x, mapped.y];
  };
  root.addEventListener("pointerdown", event => {
    if (!draft || event.button !== 0) return;
    const target = event.target as Element;
    const port = target.closest("[data-port]");
    const box = target.closest("[data-state]");
    const edge = target.closest("[data-edge]");
    const at = point(event);
    frozenBox = viewBoxOf(root);
    if (port) {
      const from = Number(port.getAttribute("data-port"));
      const [cx, cy] = [layout[from][0] + BOX_W, layout[from][1] + BOX_H / 2];
      const line = svgNode("line", { x1: cx, y1: cy, x2: cx, y2: cy, class: "be-rubber", "marker-end": "url(#arrow-hot)" });
      root.append(line);
      drag = { mode: "link", from, line, moved: false };
    } else if (box) {
      const index = Number(box.getAttribute("data-state"));
      drag = { mode: "move", index, start: at, origin: [...layout[index]] as Position, moved: false };
    } else if (edge) {
      drag = { mode: "pick", target: edge.getAttribute("data-edge")!, start: at, moved: false };
    } else {
      selection = null; frozenBox = null; drag = null;
      renderAll(false);
      return;
    }
    root.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  root.addEventListener("pointermove", event => {
    if (!drag) return;
    const at = point(event);
    if (drag.mode === "move") {
      const dx = at[0] - drag.start[0];
      const dy = at[1] - drag.start[1];
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      const [vx, vy, vw, vh] = frozenBox!;
      layout[drag.index] = [Math.round(Math.min(Math.max(drag.origin[0] + dx, vx + 4), vx + vw - BOX_W - 4)), Math.round(Math.min(Math.max(drag.origin[1] + dy, vy + 14), vy + vh - BOX_H - 4))];
      root.replaceChildren(...scene(draft!));
    } else if (drag.mode === "link") {
      drag.moved = true;
      drag.line.setAttribute("x2", String(at[0])); drag.line.setAttribute("y2", String(at[1]));
    } else if (Math.hypot(at[0] - drag.start[0], at[1] - drag.start[1]) >= 4) drag.moved = true;
  });
  const finish = (event: PointerEvent, cancelled: boolean): void => {
    const current = drag;
    drag = null;
    if (!current || !draft) return;
    const at = point(event);
    frozenBox = null;
    if (cancelled) { renderAll(false); return; }
    if (current.mode === "move") {
      if (current.moved) { commit(); renderAll(false); }
      else { selection = { kind: "state", index: current.index }; renderAll(true); }
    } else if (current.mode === "link") {
      current.line.remove();
      const hit = draft.states.findIndex((_, index) => at[0] >= layout[index][0] - 6 && at[0] <= layout[index][0] + BOX_W + 6 && at[1] >= layout[index][1] - 6 && at[1] <= layout[index][1] + BOX_H + 6);
      if (hit < 0) { renderAll(false); return; }
      const source = draft.states[current.from];
      if (source.transitions.length >= MAX_TRANSITIONS) { notice(`"${source.name}" already has ${MAX_TRANSITIONS} transitions, the most a state may have.`); renderAll(false); return; }
      source.transitions.push({ to: hit, when: [{ type: CONDITIONS[0].id, value: CONDITIONS[0].fallback }] });
      selection = { kind: "edge", from: current.from, at: source.transitions.length - 1 };
      commit(); renderAll(true);
    } else {
      const [from, at2] = current.target.split(":").map(Number);
      selection = { kind: "edge", from, at: at2 };
      renderAll(true);
    }
  };
  root.addEventListener("pointerup", event => finish(event, false));
  root.addEventListener("pointercancel", event => finish(event, true));
}

/** The viewBox an svg currently shows, so a drag does not rescale the picture under the pointer. */
function viewBoxOf(root: SVGSVGElement): [number, number, number, number] {
  const box = root.viewBox.baseVal;
  return [box.x, box.y, box.width, box.height];
}

// ---- Editing --------------------------------------------------------------

let noticeTimer: number | undefined;
function notice(message: string): void {
  const line = $("be-notice");
  line.textContent = message;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { line.textContent = ""; }, 5000);
}

function currentEntry() { return findEntry(library, selectedId); }

/** Writes the draft to the library if it parses; otherwise keeps it in memory and says why. */
function commit(): void {
  if (!draft || !selectedId) return;
  const next = serializePolicy(draft);
  const check = parsePolicy(next);
  draftError = check.ok ? null : check.error;
  if (check.ok) {
    library = updateEntry(loadLibrary(), selectedId, { text: next, layout: layout.map(([x, y]) => [x, y] as Position) });
    persisted = saveLibrary(library);
    savedText = next;
  }
  renderStatus();
  renderLibrary();
}

function selectEntry(id: string | null): void {
  selectedId = id;
  selection = null;
  tryState.index = 0; tryState.situation.secondsInState = 2;
  const entry = currentEntry();
  draft = null; draftError = null; layout = [];
  if (entry) {
    savedText = entry.text;
    const parsed = parsePolicy(entry.text);
    if (parsed.ok) { draft = clonePolicy(parsed.policy); layout = fitLayout(draft, entry.layout); selection = { kind: "state", index: 0 }; }
    else draftError = parsed.error;
  }
  renderAll(true);
}

/** Replaces the draft from raw text. */
function applyText(raw: string): boolean {
  const parsed = parsePolicy(raw.trim());
  if (!parsed.ok) { draftError = parsed.error; renderStatus(); return false; }
  const previous = draft;
  draft = clonePolicy(parsed.policy);
  layout = previous && previous.states.length === draft.states.length ? layout : fitLayout(draft, undefined);
  selection = { kind: "state", index: Math.min(selection?.kind === "state" ? selection.index : 0, draft.states.length - 1) };
  commit(); renderAll(true);
  return true;
}

function addState(): void {
  if (!draft) return;
  if (draft.states.length >= MAX_STATES) { notice(`A behavior has at most ${MAX_STATES} states.`); return; }
  const lowest = Math.max(...layout.map(([, y]) => y));
  const anchor = selection ? layout[selection.kind === "state" ? selection.index : selection.from] : layout[layout.length - 1];
  const position: Position = [anchor[0], lowest + 150];
  draft.states.push({ name: cleanName(`state${draft.states.length}`), action: "attack_move:goal", transitions: [] });
  layout = appendLayout(layout, position);
  selection = { kind: "state", index: draft.states.length - 1 };
  commit(); renderAll(true);
}

function removeSelection(): void {
  if (!draft || !selection) return;
  if (selection.kind === "state") {
    if (draft.states.length <= 1) { notice("A behavior needs at least one state."); return; }
    const index = selection.index;
    removeState(draft, index);
    layout = removeLayoutAt(layout, index);
    selection = { kind: "state", index: Math.min(index, draft.states.length - 1) };
  } else {
    draft.states[selection.from].transitions.splice(selection.at, 1);
    selection = { kind: "state", index: selection.from };
  }
  commit(); renderAll(true);
}

document.addEventListener("keydown", event => {
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  const target = event.target as HTMLElement;
  if (target.closest("input, textarea, select, [contenteditable]") || (document.getElementById("be-import-dialog") as HTMLDialogElement).open) return;
  if (!selection) return;
  event.preventDefault();
  removeSelection();
});

// ---- Library column -------------------------------------------------------

function renderLibrary(): void {
  const list = $("be-list");
  $("be-library-count").textContent = `${library.entries.length}`;
  $("be-empty").hidden = library.entries.length > 0;
  list.replaceChildren(...library.entries.map(entry => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button"; button.className = "be-entry"; button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(entry.id === selectedId));
    button.dataset.id = entry.id;
    const ok = entryStatus(entry).ok;
    // The selected entry shows the draft's name while it is being typed.
    const name = entry.id === selectedId && draft ? draft.label || "(unnamed)" : entryName(entry);
    const count = entry.id === selectedId && draft ? draft.states.length : stateCount(entry);
    const body = text("span", "", "be-entry-body");
    body.append(text("strong", name), text("small", ok ? `${count} state${count === 1 ? "" : "s"}` : "Broken: needs fixing", ok ? "mono" : "mono be-broken"));
    button.append(body);
    const slot = slotOf(library, entry.id);
    if (slot) {
      const badge = text("span", `Slot ${slot}`, "be-slot-badge");
      badge.style.setProperty("--slot", CUSTOM_COLORS[slot - 1]);
      button.append(badge);
    }
    button.addEventListener("click", () => selectEntry(entry.id));
    item.append(button);
    return item;
  }));
  ($("be-duplicate") as HTMLButtonElement).disabled = !selectedId;
  ($("be-delete") as HTMLButtonElement).disabled = !selectedId;
  syncLoadout();
}

let slotSignature = "";
const slotSelects: HTMLSelectElement[] = [];
function buildLoadout(): void {
  const host = $("be-slots");
  for (let number = 1; number <= MAX_CUSTOM; number++) {
    const row = text("label", "", "be-slot");
    const swatch = text("span", "", "be-swatch");
    swatch.style.background = CUSTOM_COLORS[number - 1];
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Slot ${number}`);
    select.addEventListener("change", () => {
      library = assignSlot(loadLibrary(), number, select.value || null);
      saveLibrary(library);
      renderLibrary();
    });
    slotSelects.push(select);
    row.append(swatch, text("span", `Slot ${number}`, "be-slot-name"), select);
    host.append(row);
  }
  const auto = $("be-auto") as HTMLInputElement;
  auto.addEventListener("change", () => { library = { ...loadLibrary(), autoInstall: auto.checked }; saveLibrary(library); });
}

function syncLoadout(): void {
  const signature = JSON.stringify(library.entries.map(entry => [entry.id, entryName(entry)]));
  slotSelects.forEach((select, at) => {
    if (signature !== slotSignature || !select.options.length) {
      select.replaceChildren(new Option("(empty)", ""), ...library.entries.map(entry => new Option(entryName(entry) + (entryStatus(entry).ok ? "" : " (broken)"), entry.id)));
    }
    select.value = library.loadout[at] ?? "";
  });
  slotSignature = signature;
  ($("be-auto") as HTMLInputElement).checked = library.autoInstall;
}

function setupLibraryButtons(): void {
  const menu = $("be-new-list");
  const templates: [string, string][] = [["Harass", PRESET_TEXTS.harass], ["Guard", PRESET_TEXTS.guard], ["Raid", PRESET_TEXTS.raid], ["Rush", PRESET_TEXTS.assault], ["Blank", BLANK_TEXT]];
  for (const [label, source] of templates) {
    const button = text("button", label, "be-menu-item") as HTMLButtonElement;
    button.type = "button";
    button.addEventListener("click", () => {
      ($("be-new") as HTMLDetailsElement).open = false;
      const entry = createEntry(source);
      library = addEntry(loadLibrary(), entry);
      persisted = saveLibrary(library);
      selectEntry(entry.id);
    });
    menu.append(button);
  }
  document.addEventListener("click", event => { const details = $("be-new") as HTMLDetailsElement; if (details.open && !details.contains(event.target as Node)) details.open = false; });
  $("be-duplicate").addEventListener("click", () => {
    if (!selectedId) return;
    const result = duplicateEntry(loadLibrary(), selectedId);
    if (!result.entry) return;
    library = result.library; saveLibrary(library);
    selectEntry(result.entry.id);
  });
  $("be-delete").addEventListener("click", () => {
    const entry = currentEntry();
    if (!entry || !window.confirm(`Delete "${entryName(entry)}" from your library? This cannot be undone.`)) return;
    library = deleteEntry(loadLibrary(), entry.id); saveLibrary(library);
    selectEntry(library.entries[0]?.id ?? null);
  });
  $("be-export").addEventListener("click", () => {
    const blob = new Blob([exportJson(loadLibrary())], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = "behavior-library.json";
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  const dialog = $("be-import-dialog") as HTMLDialogElement;
  const result = $("be-import-result");
  $("be-import").addEventListener("click", () => { ($("be-import-text") as HTMLTextAreaElement).value = ""; result.textContent = ""; dialog.showModal(); });
  ($("be-import-file") as HTMLInputElement).addEventListener("change", event => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void file.text().then(content => { ($("be-import-text") as HTMLTextAreaElement).value = content; });
  });
  $("be-import-go").addEventListener("click", () => {
    const imported = importText(($("be-import-text") as HTMLTextAreaElement).value);
    if (imported.entries.length) {
      library = loadLibrary();
      for (const entry of imported.entries) library = addEntry(library, entry);
      persisted = saveLibrary(library);
      selectEntry(imported.entries[0].id);
    }
    result.textContent = `${imported.entries.length ? `Imported ${imported.entries.length}. ` : ""}${imported.errors.join(" ")}`;
    result.className = imported.errors.length ? "be-hint be-error" : "be-hint";
    if (imported.entries.length && !imported.errors.length) dialog.close();
  });
  $("be-add-state").addEventListener("click", addState);
  $("be-layout").addEventListener("click", () => { if (!draft) return; layout = autoLayout(draft); commit(); renderAll(false); });
}

// ---- Inspector ------------------------------------------------------------

let form: ReturnType<typeof policyForm> | null = null;

function renderInspector(rebuildForm: boolean): void {
  const entry = currentEntry();
  $("be-inspector-empty").hidden = !!entry;
  $("be-inspector-body").hidden = !entry;
  const policy = draft;
  ($("be-name") as HTMLInputElement).disabled = !policy;
  ($("be-labour") as HTMLInputElement).disabled = !policy;
  ($("be-add-state") as HTMLButtonElement).disabled = !policy;
  ($("be-layout") as HTMLButtonElement).disabled = !policy;
  $("be-stage-title").textContent = policy ? policy.label || "State diagram" : "State diagram";
  if (policy) {
    const name = $("be-name") as HTMLInputElement;
    if (document.activeElement !== name) name.value = policy.label;
    ($("be-labour") as HTMLInputElement).checked = policy.labour;
  }
  if (rebuildForm) {
    const host = $("be-form");
    const selected = $("be-selected");
    form = null;
    if (!policy || !selection) {
      host.replaceChildren();
      selected.replaceChildren(text("p", policy ? "Click a state or an arrow in the diagram to edit it." : "", "be-hint"));
    } else {
      const index = selection.kind === "state" ? selection.index : selection.from;
      const heading = selection.kind === "state" ? `State #${index}: ${policy.states[index].name}` : `Transition ${selection.at + 1} of #${index} ${policy.states[index].name}`;
      const removeButton = text("button", selection.kind === "state" ? "Delete state" : "Delete transition", "danger") as HTMLButtonElement;
      removeButton.type = "button"; removeButton.disabled = selection.kind === "state" && policy.states.length <= 1;
      removeButton.addEventListener("click", removeSelection);
      selected.replaceChildren(text("strong", heading), removeButton);
      form = policyForm(policy, {
        only: index,
        highlight: selection.kind === "edge" ? { state: selection.from, transition: selection.at } : undefined,
        onChange: () => { form?.refresh(); commit(); renderDiagram(); renderTry(); renderLibrary(); },
        onStructure: () => { commit(); renderAll(true); },
        removeState: at => { removeState(policy, at); layout = removeLayoutAt(layout, at); selection = { kind: "state", index: Math.min(at, policy.states.length - 1) }; },
      });
      host.replaceChildren(form.element);
    }
  }
  renderStatus();
}

function renderStatus(): void {
  const valid = $("be-valid");
  const raw = $("be-raw") as HTMLTextAreaElement;
  const policy = draft;
  const textNow = policy ? serializePolicy(policy) : currentEntry()?.text ?? "";
  if (document.activeElement !== raw) raw.value = textNow;
  const check = parsePolicy(textNow);
  const message = draftError ?? (check.ok ? null : check.error);
  valid.className = message ? "be-error" : "be-ok";
  valid.textContent = message ?? `OK: ${policy ? policy.states.length : stateCount(currentEntry()!)} state${policy?.states.length === 1 ? "" : "s"} in a valid behavior`;
  $("be-counts").textContent = `${policy?.states.length ?? 0}/${MAX_STATES} states · ${textNow.length}/${MAX_POLICY_TEXT} chars`;
  $("be-save-state").textContent = !currentEntry() ? "" : message ? "Not saved: fix the problem above" : !persisted ? "Could not save: browser storage is blocked" : "Saved to your library";
  $("be-save-state").className = message || !persisted ? "be-hint be-error" : "be-hint";
}

// ---- Try it ---------------------------------------------------------------

const TRY_FIELDS: { key: keyof Situation; label: string; min: number; max: number; step: number }[] = [
  { key: "healthPercent", label: "Health %", min: 0, max: 100, step: 1 },
  { key: "goalDistance", label: "Distance to goal", min: 0, max: 2000, step: 10 },
  { key: "homeDistance", label: "Distance to home", min: 0, max: 2000, step: 10 },
  { key: "enemyDistance", label: "Nearest enemy at", min: 0, max: 600, step: 10 },
  { key: "enemies", label: "Enemies near", min: 0, max: 30, step: 1 },
  { key: "allies", label: "Other friends near", min: 0, max: 30, step: 1 },
  { key: "secondsInState", label: "Seconds in state", min: 0, max: 30, step: 0.5 },
];
const tryInputs = new Map<keyof Situation, HTMLInputElement>();
let noEnemy: HTMLInputElement;

function buildTry(): void {
  const host = $("be-try-body");
  host.append(text("p", "A what-if check of the state logic, not a battle simulation: set what a unit senses, and see which transition the server would take.", "be-hint"));
  const grid = text("div", "", "be-try-grid");
  for (const field of TRY_FIELDS) {
    const label = text("label", field.label);
    const input = document.createElement("input");
    input.type = "number"; input.min = String(field.min); input.max = String(field.max); input.step = String(field.step);
    input.value = String(field.key === "enemyDistance" ? 300 : tryState.situation[field.key]);
    input.addEventListener("input", () => {
      const value = input.valueAsNumber;
      if (Number.isFinite(value)) (tryState.situation[field.key] as number) = value;
      readNoEnemy(); renderTry(); renderDiagram();
    });
    tryInputs.set(field.key, input);
    label.append(input);
    if (field.key === "enemyDistance") {
      noEnemy = document.createElement("input");
      noEnemy.type = "checkbox"; noEnemy.checked = true; noEnemy.setAttribute("aria-label", "No enemy nearby");
      noEnemy.addEventListener("change", () => { readNoEnemy(); renderTry(); renderDiagram(); });
      const none = text("label", "", "be-check be-none");
      none.append(noEnemy, text("span", "none nearby"));
      label.append(none);
    }
    grid.append(label);
  }
  host.append(grid);
  const buttons = text("div", "", "be-toolbar");
  const step = text("button", "Step", "primary") as HTMLButtonElement;
  step.type = "button"; step.id = "be-step"; step.title = "Move to the target of the transition that fires, and restart the clock in the new state";
  step.addEventListener("click", () => {
    if (!draft) return;
    const verdict = nextTransition(draft, tryState.index, tryState.situation);
    if (verdict.fired === undefined) return;
    tryState.index = draft.states[tryState.index].transitions[verdict.fired].to;
    tryState.situation.secondsInState = 0;
    tryInputs.get("secondsInState")!.value = "0";
    renderTry(); renderDiagram();
  });
  const reset = text("button", "Reset") as HTMLButtonElement;
  reset.type = "button"; reset.title = "Back to state 0, 2 s in state";
  reset.addEventListener("click", () => { tryState.index = 0; tryState.situation.secondsInState = 2; tryInputs.get("secondsInState")!.value = "2"; renderTry(); renderDiagram(); });
  buttons.append(step, reset);
  host.append(buttons, text("div", "", "be-try-result"));
  readNoEnemy();
  $("be-try").addEventListener("toggle", () => { renderTry(); renderDiagram(); });
}

function readNoEnemy(): void {
  const input = tryInputs.get("enemyDistance")!;
  input.disabled = noEnemy.checked;
  tryState.situation.enemyDistance = noEnemy.checked ? Infinity : Number(input.value) || 0;
}

function renderTry(): void {
  const host = $("be-try-body").querySelector(".be-try-result") as HTMLElement | null;
  if (!host) return;
  const policy = draft;
  if (!policy) { host.replaceChildren(text("p", "Select a valid behavior to try it.", "be-hint")); return; }
  if (tryState.index >= policy.states.length) tryState.index = 0;
  const state = policy.states[tryState.index];
  const verdict = nextTransition(policy, tryState.index, tryState.situation);
  const rows: HTMLElement[] = [text("p", `Now in #${tryState.index} ${state.name} (${actionLabel(state.action)}), ${tryState.situation.secondsInState} s in.`, "be-try-now")];
  if (!verdict.ready) rows.push(text("p", "Nothing can fire before 1 s in a state.", "be-hint"));
  if (!state.transitions.length) rows.push(text("p", "This state has no transitions: the unit stays here.", "be-hint"));
  state.transitions.forEach((transition, at) => {
    const check = verdict.checks[at];
    const row = text("div", "", `be-try-row${verdict.fired === at ? " fires" : ""}`);
    row.append(text("strong", `${at + 1}. → #${transition.to} ${policy.states[transition.to]?.name ?? "?"}`));
    if (!transition.when.length) row.append(text("span", verdict.ready ? "✓ after 1 s" : "✗ after 1 s (not yet)", verdict.ready ? "be-yes" : "be-no"));
    transition.when.forEach((condition, which) => row.append(text("span", `${check.conditions[which] ? "✓" : "✗"} ${describeCondition(condition)}`, check.conditions[which] ? "be-yes" : "be-no")));
    row.append(text("em", verdict.fired === at ? "fires" : check.holds && verdict.ready ? "holds, but an earlier one wins" : check.holds ? "holds, waiting for 1 s" : ""));
    rows.push(row);
  });
  rows.push(text("p", verdict.fired === undefined ? "No transition fires: the unit stays." : `Fires: transition ${verdict.fired + 1}.`, "be-try-verdict"));
  host.replaceChildren(...rows);
  ($("be-step") as HTMLButtonElement).disabled = verdict.fired === undefined;
}

// ---- Wiring ---------------------------------------------------------------

function renderAll(rebuildForm: boolean): void {
  renderLibrary();
  renderInspector(rebuildForm);
  renderDiagram();
  renderTry();
}

($("be-name") as HTMLInputElement).addEventListener("input", event => {
  if (!draft) return;
  const input = event.target as HTMLInputElement;
  const clean = cleanName(input.value);
  if (clean !== input.value) input.value = clean;
  draft.label = clean;
  commit(); renderInspector(false); renderDiagram();
});
($("be-labour") as HTMLInputElement).addEventListener("change", event => { if (!draft) return; draft.labour = (event.target as HTMLInputElement).checked; commit(); renderInspector(false); });
$("be-apply").addEventListener("click", () => {
  const raw = ($("be-raw") as HTMLTextAreaElement).value;
  if (!currentEntry()) return;
  if (applyText(raw)) return;
  // A broken entry has no draft yet: a text that parses fixes it.
});
$("be-copy").addEventListener("click", () => {
  const raw = ($("be-raw") as HTMLTextAreaElement);
  const done = (): void => notice("Copied the behavior text");
  if (navigator.clipboard) void navigator.clipboard.writeText(raw.value).then(done, () => { raw.select(); notice("Select the text and copy it"); });
  else { raw.select(); document.execCommand("copy"); done(); }
});

// Two open tabs stay in sync: the other tab's write wins unless this draft has unsaved (invalid) edits.
window.addEventListener("storage", event => {
  if (event.key !== LIBRARY_KEY && event.key !== null) return;
  library = loadLibrary();
  const entry = currentEntry();
  if (selectedId && !entry) { selectEntry(library.entries[0]?.id ?? null); return; }
  if (entry && entry.text !== savedText && !draftError) {
    savedText = entry.text;
    const parsed = parsePolicy(entry.text);
    if (parsed.ok) { draft = clonePolicy(parsed.policy); layout = fitLayout(draft, entry.layout); if (selection?.kind === "state") selection.index = Math.min(selection.index, draft.states.length - 1); else selection = { kind: "state", index: 0 }; draftError = null; }
    renderAll(true);
  } else renderLibrary();
});

buildLoadout();
setupLibraryButtons();
buildTry();
selectEntry(library.entries[0]?.id ?? null);
