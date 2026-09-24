import { COLORS } from "./presentation";
import { CURRENCIES, FACTION_ECONOMY, FACTION_LABEL, factionForSlot, type Cost, type FactionName } from "./catalog";
import { buildScoreboard, formatClock, formatValue, type IncomeMode, type Sample, type ScoreFacet, type Scoreboard } from "./scoreboard";

/**
 * A commander's line is told apart four ways over: the battlefield colour
 * their units already wear, a dash pattern, an end-of-line marker shape, and a
 * direct end label carrying their name. Colour is never the only channel —
 * `COLORS` is four hues chosen for units on a dark field, not for a legend, and
 * the same rule the rest of the client follows for factions and currencies
 * applies here.
 */
export const DASHES = ["", "8 4", "2 4", "12 3 2 3"];
export const MARKERS = ["circle", "square", "triangle", "diamond"] as const;

const SVG_NS = "http://www.w3.org/2000/svg";
/**
 * A facet's `viewBox` is not a fixed size: it is set, on every draw, to the
 * plot's actual rendered pixel box (CSS gives it `width: 100%` and a fixed
 * `height`), so one viewBox unit is always one real pixel. That is what lets
 * the plot fill whatever column the grid gives it — at 990 or at 1440 — with
 * axis type and stroke widths that stay the same physical size either way,
 * instead of a fixed-unit box stretched by CSS and blown up or squeezed with
 * it. `LEFT_MARGIN`/`TOP_MARGIN`/`BOTTOM_MARGIN` are the fixed-pixel axis
 * gutters; the end-label gutter on the right is a fraction of the measured
 * width, clamped so it neither starves the plot nor swamps it.
 */
const LEFT_MARGIN = 56;
const TOP_MARGIN = 12;
const BOTTOM_MARGIN = 30;
const GUTTER_FRACTION = 0.22;
const GUTTER_MIN = 130;
const GUTTER_MAX = 260;
/** The surface a facet sits on: marker rings and gaps are painted in it. */
const SURFACE = "#12201a";

function element<Type extends HTMLElement = HTMLElement>(id: string): Type {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing UI element: ${id}`);
  return value as Type;
}

function node<Key extends keyof SVGElementTagNameMap>(tag: Key, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[Key] {
  const created = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, String(value));
  return created;
}

function html(tag: string, content = "", className = ""): HTMLElement {
  const created = document.createElement(tag);
  // Names come from other players; they are text and only ever text.
  if (content) created.textContent = content;
  if (className) created.className = className;
  return created;
}

function cell(tag: "th" | "td", content: string, scope?: "col" | "row", hint?: string): HTMLTableCellElement {
  const created = document.createElement(tag);
  if (content) created.textContent = content;
  if (scope) created.scope = scope;
  if (hint) created.title = hint;
  return created;
}

/**
 * Fills an end-of-line label with a commander's name and final value, cutting
 * the name only as far as the gutter forces: whole words first, one dropped
 * at a time from the end and marked with an ellipsis, and only down to a
 * single truncated word if even that alone does not fit. Never a mid-word
 * clip with nothing to say it was cut — that's the "North / C…" bug this
 * replaces. `text` must already be attached to the document; SVG text
 * metrics are how the fit is measured, not a guessed character count.
 */
function fitLabel(text: SVGTextElement, name: string, value: string, budget: number): void {
  const room = Math.max(40, budget);
  text.textContent = `${name} ${value}`;
  if (text.getComputedTextLength() <= room) return;
  const words = name.split(" ");
  for (let end = words.length - 1; end >= 1; end--) {
    text.textContent = `${words.slice(0, end).join(" ")}… ${value}`;
    if (text.getComputedTextLength() <= room) return;
  }
  let base = words[0] ?? name;
  while (base.length > 1) {
    base = base.slice(0, -1);
    text.textContent = `${base}… ${value}`;
    if (text.getComputedTextLength() <= room) return;
  }
}

/** The marker shape for a slot, centred on the point. */
function marker(slot: number, x: number, y: number, size: number, fill: string): SVGElement {
  const shape = MARKERS[slot % MARKERS.length];
  // A 2px ring in the surface colour, so markers stay legible where lines cross.
  const common = { fill, stroke: SURFACE, "stroke-width": 2, "stroke-linejoin": "round", "data-slot": slot };
  if (shape === "circle") return node("circle", { cx: x, cy: y, r: size, ...common });
  if (shape === "square") return node("rect", { x: x - size, y: y - size, width: size * 2, height: size * 2, ...common });
  const points = shape === "triangle"
    ? `${x},${y - size * 1.25} ${x + size * 1.1},${y + size} ${x - size * 1.1},${y + size}`
    : `${x},${y - size * 1.3} ${x + size * 1.3},${y} ${x},${y + size * 1.3} ${x - size * 1.3},${y}`;
  return node("polygon", { points, ...common });
}

/** The legend key: one slot's colour, dash pattern and marker shape together. */
export function keySwatch(slot: number): SVGSVGElement {
  const svg = node("svg", { viewBox: "0 0 38 14", class: "score-key", "aria-hidden": "true", focusable: "false" });
  svg.append(node("line", {
    x1: 2, y1: 7, x2: 27, y2: 7, stroke: COLORS[slot % COLORS.length], "stroke-width": 2,
    "stroke-linecap": "round", "stroke-dasharray": DASHES[slot % DASHES.length],
  }));
  svg.append(marker(slot, 31, 7, 4, COLORS[slot % COLORS.length]));
  return svg;
}

/** "1,240 MAT" and, only when there is any, "80 CAT" — never one summed number. */
export function currencyCell(cost: Cost): HTMLElement {
  const holder = html("span", "", "score-cost");
  holder.title = CURRENCIES.map(currency => `${formatValue(cost[currency])} ${currency}`).join(" + ");
  for (const currency of CURRENCIES) {
    if (currency === "catalyst" && cost.catalyst === 0) continue;
    holder.append(html("span", `${formatValue(cost[currency])} ${currency === "material" ? "MAT" : "CAT"}`, `cost-part ${currency}`));
  }
  return holder;
}

/** A commander as the screen knows them, whether or not they are still in the room. */
export interface ScorePlayer {
  slot: number;
  name: string;
  faction: FactionName;
  /** Present only while their `player` row is: it goes the moment they leave. */
  killed: Cost | undefined;
}

export interface ScoreState {
  matchId: bigint;
  /** `room.winner`: a slot, or -1 for a draw. */
  winner: number;
  mySlot: number;
  samples: Sample[];
  players: ScorePlayer[];
}

/** The pixel geometry a facet was last painted at — see the note above `LEFT_MARGIN`. */
interface Geometry {
  view: { width: number; height: number };
  plot: { left: number; right: number; top: number; bottom: number };
}

interface Live {
  facet: ScoreFacet;
  svg: SVGSVGElement;
  hairline: SVGLineElement;
  dots: SVGElement[];
  hover: SVGGElement;
  index: number | undefined;
  geometry: Geometry;
}

const NOTHING: Cost = { material: 0, catalyst: 0 };

/**
 * The post-match score screen: who won, what each commander's economy and army
 * actually did across the match, and a way out that is never more than one key
 * away. Rebuilt only when the samples, the outcome, the roster or the income
 * reading change, because it redraws from the same render loop as the match.
 */
export class ScoreScreen {
  private board = element("scoreboard");
  private roster = element("score-roster");
  private charts = element("score-charts");
  private notes = element("score-notes");
  private tip = element("score-tip");
  private incomeToggle = element<HTMLButtonElement>("score-income-mode");
  private tableDetails = element<HTMLDetailsElement>("score-table");
  private incomeMode: IncomeMode = "cumulative";
  private signature = "";
  private names = new Map<number, string>();
  private scoreboard: Scoreboard | undefined;
  private announced = 0n;
  private redraw: (() => void) | undefined;
  /** The width `score-charts` was last painted at, so a resize that does not
   *  actually change it (a height-only change, or the observer's own initial
   *  callback firing at the same size again) does not trigger a redraw. */
  private paintedWidth = 0;
  /** Called once per match, so the way out can take focus the moment it appears. */
  onShown: () => void = () => {};

  constructor() {
    this.incomeToggle.addEventListener("click", () => {
      this.incomeMode = this.incomeMode === "cumulative" ? "rate" : "cumulative";
      this.signature = "";
      this.redraw?.();
    });
    this.tableDetails.addEventListener("toggle", () => { if (this.tableDetails.open) this.fillTable(); });
    // The plot's coordinate space is measured in real pixels (see `LEFT_MARGIN`
    // above), so a width change — the window resizing, or the 990x650 short
    // layout kicking in — has to repaint it, the same way `battlefield.ts`
    // repaints its canvas on resize.
    new ResizeObserver(entries => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      if (!width || width === this.paintedWidth || !this.scoreboard || this.board.hidden) return;
      this.drawCharts(this.scoreboard);
    }).observe(this.charts);
  }

  /** Hides the score screen. The small in-play banner is not ours to touch. */
  hide(): void {
    this.board.hidden = true;
    this.tip.hidden = true;
    this.signature = "";
    this.announced = 0n;
  }

  render(state: ScoreState): void {
    this.redraw = () => this.render(state);
    this.board.hidden = false;
    for (const player of state.players) this.names.set(player.slot, player.name);
    const roster = state.players.map(player => `${player.slot}/${player.name}/${player.faction}/${player.killed?.material ?? -1}/${player.killed?.catalyst ?? -1}`).join(",");
    const signature = `${state.matchId}:${state.winner}:${state.samples.length}:${this.incomeMode}:${roster}`;
    if (signature !== this.signature) {
      this.signature = signature;
      const board = buildScoreboard(state.samples, this.incomeMode);
      this.scoreboard = board;
      this.incomeToggle.textContent = this.incomeMode === "cumulative" ? "Show income per minute" : "Show cumulative income";
      this.drawRoster(state, board);
      this.drawCharts(board);
      this.drawNotes(board);
      this.tableDetails.open = false;
      this.tableDetails.hidden = board.seconds.length === 0;
    }
    if (this.announced !== state.matchId) {
      this.announced = state.matchId;
      this.onShown();
    }
  }

  /** Every commander, their faction, who won, and the end-of-match totals. */
  private drawRoster(state: ScoreState, board: Scoreboard): void {
    const table = html("table", "", "score-table-grid");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.append(cell("th", "Commander", "col"));
    for (const [label, hint] of [
      ["Mined", "Resources taken out of deposits. The opening stipend and every refund are excluded."],
      ["Lost", "The cost of everything of theirs that died."],
      ["Last hits", "The cost of everything they struck the killing blow on. A unit worn down by one commander and finished by another counts here entirely to the finisher, so this is not a measure of who did the damage."],
      ["Unspent", "The balance still banked when the match ended."],
    ]) headRow.append(cell("th", label, "col", hint));
    head.append(headRow);
    table.append(head);
    const body = document.createElement("tbody");
    const slots = [...new Set([...board.slots, ...state.players.map(player => player.slot)])].sort((left, right) => left - right);
    for (const slot of slots) {
      const player = state.players.find(entry => entry.slot === slot);
      const totals = board.totals.find(entry => entry.slot === slot);
      const row = document.createElement("tr");
      row.className = slot === state.mySlot ? "score-row mine" : "score-row";
      row.dataset.slot = String(slot);
      const name = cell("th", "", "row");
      const inner = html("span", "", "score-name-inner");
      inner.append(keySwatch(slot));
      inner.append(html("span", `${this.names.get(slot) ?? `Slot ${slot}`}${slot === state.mySlot ? " / you" : ""}`, "score-player"));
      const faction = player?.faction ?? factionForSlot(slot);
      const tag = html("span", FACTION_LABEL[faction], `faction-tag ${faction}`);
      tag.title = FACTION_ECONOMY[faction];
      inner.append(tag);
      if (state.winner === slot) inner.append(html("span", "Winner", "score-badge win"));
      else if (state.winner === -1) inner.append(html("span", "Draw", "score-badge"));
      if (totals?.outSeconds !== undefined) {
        const out = html("span", `Out ${formatClock(totals.outSeconds)}`, "score-badge out");
        out.title = "No units and no buildings left from this point on. A concession removes a commander's forces outright, so it looks exactly like a rout in the samples and the screen does not claim which it was.";
        inner.append(out);
      }
      name.append(inner);
      row.append(name);
      for (const cost of [totals?.mined, totals?.lost]) row.append(this.costCell(cost ?? NOTHING));
      if (player?.killed) row.append(this.costCell(player.killed));
      else row.append(cell("td", "—", undefined, "No player row was ever seen for this slot, so there is no last-hit total to show for it."));
      row.append(this.costCell(totals?.banked ?? NOTHING));
      body.append(row);
    }
    table.append(body);
    this.roster.replaceChildren(table);
  }

  private costCell(cost: Cost): HTMLTableCellElement {
    const holder = cell("td", "");
    holder.append(currencyCell(cost));
    return holder;
  }

  private drawCharts(board: Scoreboard): void {
    this.tip.hidden = true;
    this.charts.replaceChildren();
    if (!board.seconds.length) {
      this.charts.append(html("p", "The match ended before the first sample at tick 100, so there is no history to draw. The totals above are the whole record of it.", "score-empty"));
      return;
    }
    if (board.seconds.length === 1) {
      this.charts.append(html("p", `One sample only, taken at ${formatClock(board.seconds[0])} as the match ended. Every commander is a single point here, not a line.`, "score-empty"));
    }
    for (const panel of board.panels) {
      const section = html("section", "", "score-panel");
      section.dataset.panel = panel.key;
      section.append(html("h3", panel.title));
      section.append(html("p", panel.caption, "score-caption"));
      if (panel.empty) section.append(html("p", panel.empty, "score-empty"));
      const grid = html("div", "", "score-grid");
      // A facet is only sized once it is actually laid out by the grid, so
      // every figure in the panel is built as an empty shell and appended
      // first — the section joins the live document — and only then painted,
      // each against the real pixel box the grid gave it.
      const shells = panel.facets.map(facet => ({ facet, ...this.facetShell(facet) }));
      for (const shell of shells) grid.append(shell.figure);
      section.append(grid);
      this.charts.append(section);
      for (const shell of shells) this.paintFacet(board, shell.facet, shell.svg);
    }
    this.paintedWidth = Math.round(this.charts.getBoundingClientRect().width);
  }

  /** The empty figure + svg a facet is painted into, sized by CSS alone. */
  private facetShell(facet: ScoreFacet): { figure: HTMLElement; svg: SVGSVGElement } {
    const figure = html("figure", "", "score-facet");
    figure.dataset.facet = facet.key;
    figure.append(html("figcaption", facet.label, `score-facet-label${facet.currency ? ` ${facet.currency}` : ""}`));
    const svg = node("svg", { class: "score-plot", role: "img", tabindex: 0 });
    figure.append(svg);
    return { figure, svg };
  }

  /**
   * Draws one facet's axes, lines and end labels into an `svg` that is
   * already in the live document, against a viewBox set to that svg's actual
   * rendered pixel box — see the note above `LEFT_MARGIN`.
   */
  private paintFacet(board: Scoreboard, facet: ScoreFacet, svg: SVGSVGElement): void {
    const rect = svg.getBoundingClientRect();
    const width = Math.max(240, Math.round(rect.width));
    const height = Math.max(90, Math.round(rect.height));
    const gutter = Math.min(GUTTER_MAX, Math.max(GUTTER_MIN, Math.round(width * GUTTER_FRACTION)));
    const view = { width, height };
    const plot = { left: LEFT_MARGIN, right: width - gutter, top: TOP_MARGIN, bottom: height - BOTTOM_MARGIN };
    svg.setAttribute("viewBox", `0 0 ${view.width} ${view.height}`);

    const ends = board.seconds.length;
    const x = (index: number) => ends <= 1 ? plot.right : plot.left + index / (ends - 1) * (plot.right - plot.left);
    const y = (value: number) => plot.bottom - Math.min(1, Math.max(0, value) / facet.max) * (plot.bottom - plot.top);

    // Grid and axes: solid hairlines one step off the surface, and axis ticks
    // rounded to clean numbers so they carry the values nothing else labels.
    for (const fraction of [0, 0.5, 1]) {
      const value = facet.max * fraction;
      svg.append(node("line", { x1: plot.left, y1: y(value), x2: plot.right, y2: y(value), class: "score-grid-line" }));
      const label = node("text", { x: plot.left - 6, y: y(value) + 3, class: "score-axis", "text-anchor": "end" });
      label.textContent = formatValue(value);
      svg.append(label);
    }
    for (const [index, anchor] of [[0, "start"], [ends - 1, "end"]] as const) {
      if (ends === 1 && anchor === "start") continue;
      const label = node("text", { x: x(index), y: plot.bottom + 15, class: "score-axis", "text-anchor": anchor });
      label.textContent = formatClock(board.seconds[index]);
      svg.append(label);
    }

    const endLabels: { y: number; slot: number; name: string; value: string }[] = [];
    for (const series of facet.series) {
      const color = COLORS[series.slot % COLORS.length];
      const dash = DASHES[series.slot % DASHES.length];
      const point = (index: number) => `${x(index)},${y(series.values[index])}`;
      const cut = series.outIndex;
      const last = series.values.length - 1;
      const lastLive = cut === undefined ? last : Math.max(0, cut - 1);
      if (last > 0) {
        const solid = series.values.slice(0, lastLive + 1).map((_, index) => point(index));
        if (solid.length > 1) svg.append(node("polyline", { points: solid.join(" "), class: "score-line", stroke: color, "stroke-dasharray": dash, "data-slot": series.slot }));
        if (cut !== undefined) {
          const faded = series.values.slice(lastLive).map((_, offset) => point(lastLive + offset));
          if (faded.length > 1) svg.append(node("polyline", { points: faded.join(" "), class: "score-line spent", stroke: color, "stroke-dasharray": dash, "data-slot": series.slot }));
        }
      }
      // Where a commander stopped existing: a hollow ring, so the flat line
      // after it reads as "gone", not as "did nothing for ten minutes".
      if (cut !== undefined && cut <= last) {
        svg.append(node("circle", { cx: x(cut), cy: y(series.values[cut]), r: 5, fill: "none", stroke: color, "stroke-width": 2, class: "score-out" }));
      }
      svg.append(marker(series.slot, x(last), y(series.final), 4.5, color));
      endLabels.push({ y: y(series.final), slot: series.slot, name: this.names.get(series.slot) ?? `Slot ${series.slot}`, value: formatValue(series.final) });
    }

    // Direct end labels. Where two lines converge the labels are pushed apart
    // and joined back to their line with a leader, never stacked loose. Each
    // is fitted to the gutter's real width, whole where there's room.
    endLabels.sort((left, right) => left.y - right.y);
    const labelBudget = view.width - (plot.right + 13) - 4;
    for (const [index, label] of endLabels.entries()) {
      const floor = index === 0 ? plot.top + 5 : endLabels[index - 1].y + 15;
      const placed = Math.max(floor, label.y);
      if (Math.abs(placed - label.y) > 2) svg.append(node("line", { x1: plot.right + 5, y1: label.y, x2: plot.right + 11, y2: placed, class: "score-leader" }));
      const text = node("text", { x: plot.right + 13, y: placed + 3, class: "score-end", "data-slot": label.slot });
      svg.append(text);
      fitLabel(text, label.name, label.value, labelBudget);
      label.y = placed;
    }

    const hover = node("g", { class: "score-hover", visibility: "hidden" });
    const hairline = node("line", { x1: 0, y1: plot.top, x2: 0, y2: plot.bottom, class: "score-hairline" });
    hover.append(hairline);
    const dots = facet.series.map(series => {
      const dot = node("circle", { cx: 0, cy: 0, r: 4, fill: COLORS[series.slot % COLORS.length], stroke: SURFACE, "stroke-width": 2 });
      hover.append(dot);
      return dot as SVGElement;
    });
    svg.append(hover);
    svg.setAttribute("aria-label", `${facet.label}. ${facet.series.map(series =>
      `${this.names.get(series.slot) ?? `Slot ${series.slot}`} ends at ${formatValue(series.final)}`).join("; ")}.`);

    const entry: Live = { facet, svg, hairline, dots, hover, index: undefined, geometry: { view, plot } };
    svg.addEventListener("pointermove", event => {
      const bounds = svg.getBoundingClientRect();
      if (!bounds.width) return;
      const local = (event.clientX - bounds.left) / bounds.width * view.width;
      const fraction = ends <= 1 ? 1 : (local - plot.left) / (plot.right - plot.left);
      this.showHover(entry, board, Math.round(Math.min(1, Math.max(0, fraction)) * (ends - 1)));
    });
    svg.addEventListener("pointerleave", () => this.clearHover(entry));
    svg.addEventListener("blur", () => this.clearHover(entry));
    svg.addEventListener("focus", () => this.showHover(entry, board, entry.index ?? ends - 1));
    svg.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      this.showHover(entry, board, Math.min(ends - 1, Math.max(0, (entry.index ?? ends - 1) + (event.key === "ArrowRight" ? 1 : -1))));
    });
  }

  /**
   * The hover layer. One readout per facet listing every commander at that
   * sample, so the pointer never has to land on a 2px line — and the same on
   * keyboard focus, where the arrow keys walk the same index.
   */
  private showHover(entry: Live, board: Scoreboard, index: number): void {
    if (!board.seconds.length) return;
    entry.index = index;
    const { view, plot } = entry.geometry;
    const ends = board.seconds.length;
    const at = ends <= 1 ? plot.right : plot.left + index / (ends - 1) * (plot.right - plot.left);
    entry.hover.setAttribute("visibility", "visible");
    entry.hairline.setAttribute("x1", String(at));
    entry.hairline.setAttribute("x2", String(at));
    for (const [position, series] of entry.facet.series.entries()) {
      const value = series.values[index] ?? 0;
      entry.dots[position].setAttribute("cx", String(at));
      entry.dots[position].setAttribute("cy", String(plot.bottom - Math.min(1, value / entry.facet.max) * (plot.bottom - plot.top)));
    }
    this.tip.replaceChildren(html("p", `${entry.facet.label} / ${formatClock(board.seconds[index])}`, "score-tip-head"));
    for (const series of entry.facet.series) {
      const row = html("p", "", "score-tip-row");
      row.append(keySwatch(series.slot), html("b", formatValue(series.values[index] ?? 0)), html("span", this.names.get(series.slot) ?? `Slot ${series.slot}`, "score-tip-name"));
      this.tip.append(row);
    }
    this.tip.hidden = false;
    const frame = this.charts.getBoundingClientRect();
    const bounds = entry.svg.getBoundingClientRect();
    const centre = bounds.left - frame.left + at / view.width * bounds.width;
    this.tip.style.left = `${Math.max(4, Math.min(frame.width - this.tip.offsetWidth - 4, centre - this.tip.offsetWidth / 2))}px`;
    this.tip.style.top = `${Math.max(0, bounds.top - frame.top - this.tip.offsetHeight - 6)}px`;
  }

  private clearHover(entry: Live): void {
    entry.hover.setAttribute("visibility", "hidden");
    this.tip.hidden = true;
  }

  private drawNotes(board: Scoreboard): void {
    this.notes.replaceChildren(
      html("p", "Material and catalyst are drawn apart and never added together: each has its own axis, because no amount of one is worth any of the other.", "score-note"),
      html("p", "Last hits credit the whole value of a kill to whoever struck last, so a unit worn down by one commander and finished by another counts entirely to the finisher.", "score-note"),
    );
    if (board.seconds.length) {
      this.notes.append(html("p", `Sampled every five seconds of match time — ${board.seconds.length} ${board.seconds.length === 1 ? "reading" : "readings"} in all, the last of them taken the instant the match ended.`, "score-note"));
    }
  }

  /** The table view, built the first time it is opened and not before. */
  private fillTable(): void {
    const board = this.scoreboard;
    if (!board || this.tableDetails.dataset.built === this.signature) return;
    this.tableDetails.dataset.built = this.signature;
    const body = this.tableDetails.querySelector(".score-table-body");
    if (!body) return;
    body.replaceChildren();
    for (const panel of board.panels) for (const facet of panel.facets) {
      const table = html("table", "", "score-table-grid");
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      headRow.append(cell("th", "Time", "col"));
      for (const series of facet.series) headRow.append(cell("th", this.names.get(series.slot) ?? `Slot ${series.slot}`, "col"));
      head.append(headRow);
      table.append(head);
      const rows = document.createElement("tbody");
      for (const [index, seconds] of board.seconds.entries()) {
        const row = document.createElement("tr");
        row.append(cell("th", formatClock(seconds), "row"));
        for (const series of facet.series) row.append(cell("td", formatValue(series.values[index] ?? 0)));
        rows.append(row);
      }
      table.append(rows);
      const block = html("div", "", "score-table-block");
      block.append(html("h4", facet.label), table);
      body.append(block);
    }
  }
}
