import type { MatchSample } from "./bindings/types";
import type { Cost, Currency } from "./catalog";

/** Server ticks per second — `TICK_MS` is 50, so twenty. */
export const TICKS_PER_SECOND = 20;
/** `rules::SAMPLE_INTERVAL_TICKS`: one row per player every hundred ticks. */
export const SAMPLE_INTERVAL_TICKS = 100;

/**
 * One `match_sample` row, minus the two keys the screen never reads. Written
 * as an `Omit` of the generated row so a column renamed in the module breaks
 * the build here instead of silently plotting `undefined`.
 */
export type Sample = Omit<MatchSample, "id" | "matchId">;

/**
 * How the income graph reads the same cumulative counter.
 *
 * `cumulative` is the default and the one the screen opens on: the counter is
 * monotone, so its *slope* already is the rate and its end point already is
 * the match total — one line answers both questions, and it survives a match
 * with one or two samples in it, where a difference between samples does not
 * exist at all. `rate` differences the same series into material per minute,
 * which is the better read for "who was ahead *right then*" but is spiky at a
 * five-second cadence and undefined at the first point of a one-sample match.
 */
export type IncomeMode = "cumulative" | "rate";

export interface ScoreSeries {
  slot: number;
  /** One value per entry in `Scoreboard.seconds`. */
  values: number[];
  final: number;
  /**
   * The first index at which this slot held no labour, no army and no
   * buildings — a rout or a concession, which look identical in the samples
   * because `World::surrender` removes the conceding player's units outright.
   * `undefined` while they still had something on the field at the last
   * sample. Everything from here on is a flat line by construction, and the
   * screen draws it faded rather than pretending it is still play.
   */
  outIndex: number | undefined;
}

export interface ScoreFacet {
  key: string;
  label: string;
  /** The currency this facet is denominated in, or `undefined` for a count. */
  currency: Currency | undefined;
  series: ScoreSeries[];
  /** Top of the y axis. Never zero, so a flat-zero facet still has a baseline. */
  max: number;
}

export interface ScorePanel {
  key: string;
  title: string;
  /** The caveat or the reading. Always rendered; never optional small print. */
  caption: string;
  facets: ScoreFacet[];
  /** Set when every facet was dropped for holding nothing but zeroes. */
  empty: string;
}

export interface ScoreTotals {
  slot: number;
  /** Mined only. Excludes the opening stipend and every refund. */
  mined: Cost;
  lost: Cost;
  banked: Cost;
  labour: number;
  army: number;
  buildings: number;
  /** Match time at which this slot's last unit or building went, if it did. */
  outSeconds: number | undefined;
}

export interface Scoreboard {
  ticks: number[];
  /** Match time of each sample index, in seconds. */
  seconds: number[];
  slots: number[];
  panels: ScorePanel[];
  totals: ScoreTotals[];
  incomeMode: IncomeMode;
}

/** "07:25" — the same clock the match bar counts up on. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/** Thousands-separated, for axis ticks and end labels. */
export function formatValue(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/**
 * The next clean number at or above `value` — 1, 2, 2.5 or 5 times a power of
 * ten — so an axis is labelled 0 / 600 / 1,200 rather than 0 / 587 / 1,174.
 */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find(factor => value <= factor * magnitude + 1e-9) ?? 10;
  return step * magnitude;
}

function emptySample(slot: number, tick: bigint): Sample {
  return {
    tick, slot, material: 0, catalyst: 0, collectedMaterial: 0, collectedCatalyst: 0,
    armyValueMaterial: 0, armyValueCatalyst: 0, labour: 0, army: 0, buildings: 0,
    lostMaterial: 0, lostCatalyst: 0,
  };
}

/**
 * Every slot's row at every sampled tick, in tick order. The server writes one
 * row per slot per sample, but a row that never arrived — a dropped update, a
 * subscription applied mid-match — carries the previous one forward rather
 * than punching a hole in the line.
 */
function align(samples: readonly Sample[], ticks: number[], slots: number[]): Map<number, Sample[]> {
  const byKey = new Map<string, Sample>();
  for (const sample of samples) byKey.set(`${sample.slot}:${Number(sample.tick)}`, sample);
  const rows = new Map<number, Sample[]>();
  for (const slot of slots) {
    const list: Sample[] = [];
    let previous: Sample | undefined;
    for (const tick of ticks) {
      const row = byKey.get(`${slot}:${tick}`) ?? previous ?? emptySample(slot, BigInt(tick));
      list.push(row);
      previous = row;
    }
    rows.set(slot, list);
  }
  return rows;
}

/** The index from which this slot had nothing left on the field at all. */
function outIndexOf(rows: Sample[]): number | undefined {
  let lastAlive = -1;
  for (const [index, row] of rows.entries()) if (row.labour + row.army + row.buildings > 0) lastAlive = index;
  if (lastAlive === rows.length - 1) return undefined;
  return lastAlive + 1;
}

function facetOf(
  key: string, label: string, currency: Currency | undefined,
  slots: number[], rows: Map<number, Sample[]>, outs: Map<number, number | undefined>,
  read: (sample: Sample, index: number, all: Sample[]) => number,
): ScoreFacet {
  const series = slots.map(slot => {
    const list = rows.get(slot) ?? [];
    const values = list.map((sample, index) => read(sample, index, list));
    return { slot, values, final: values.length ? values[values.length - 1] : 0, outIndex: outs.get(slot) };
  });
  const peak = series.reduce((top, entry) => entry.values.reduce((inner, value) => Math.max(inner, value), top), 0);
  return { key, label, currency, series, max: niceMax(peak) };
}

/** Dropped from the screen when nobody ever had any of it. */
function carries(facet: ScoreFacet): boolean {
  return facet.series.some(entry => entry.values.some(value => value > 0));
}

function panelOf(key: string, title: string, caption: string, facets: ScoreFacet[], empty: string): ScorePanel {
  const kept = facets.filter(facet => facet.currency !== "catalyst" || carries(facet));
  const live = kept.some(carries) ? kept : [];
  return { key, title, caption, facets: live, empty: live.length ? "" : empty };
}

/**
 * Cumulative mined turned into mined per minute. The first point measures from
 * the start of the match, which is honest because the counter starts at zero
 * on tick zero; every later point measures from the sample before it.
 */
function perMinute(value: number, index: number, all: Sample[], seconds: number[], read: (sample: Sample) => number): number {
  const elapsed = index === 0 ? seconds[0] : seconds[index] - seconds[index - 1];
  if (!(elapsed > 0)) return 0;
  const gained = index === 0 ? value : value - read(all[index - 1]);
  return Math.max(0, gained) / elapsed * 60;
}

/**
 * Every series the score screen can draw, from the rows the server wrote.
 *
 * Pure: same samples in, same scoreboard out, no clock and no DOM. The screen
 * only ever chooses which of these panels to paint.
 */
export function buildScoreboard(samples: readonly Sample[], incomeMode: IncomeMode = "cumulative"): Scoreboard {
  const ticks = [...new Set(samples.map(sample => Number(sample.tick)))].sort((left, right) => left - right);
  const slots = [...new Set(samples.map(sample => sample.slot))].sort((left, right) => left - right);
  const seconds = ticks.map(tick => tick / TICKS_PER_SECOND);
  const rows = align(samples, ticks, slots);
  const outs = new Map(slots.map(slot => [slot, outIndexOf(rows.get(slot) ?? [])] as const));
  const facet = (
    key: string, label: string, currency: Currency | undefined,
    read: (sample: Sample, index: number, all: Sample[]) => number,
  ) => facetOf(key, label, currency, slots, rows, outs, read);

  const minedMaterial = (sample: Sample) => sample.collectedMaterial;
  const minedCatalyst = (sample: Sample) => sample.collectedCatalyst;
  const mined = (read: (sample: Sample) => number) =>
    incomeMode === "rate"
      ? (sample: Sample, index: number, all: Sample[]) => perMinute(read(sample), index, all, seconds, read)
      : (sample: Sample) => read(sample);
  const suffix = incomeMode === "rate" ? " per minute" : " mined";

  const panels = [
    panelOf("income", incomeMode === "rate" ? "Income rate" : "Income", incomeMode === "rate"
      ? "Mined per minute, sample to sample. Mining only: the opening stipend (200 material a minute for 90 seconds, then 100 a minute for 90 more) and every refund are excluded, so this is how well each commander actually worked the deposits and nothing else."
      : "Cumulative mined. Mining only: the opening stipend (200 material a minute for 90 seconds, then 100 a minute for 90 more) and every refund are excluded, so this is how well each commander actually worked the deposits and nothing else. The slope is the rate; the end of the line is the match total.",
      [facet("mined-material", `Material${suffix}`, "material", mined(minedMaterial)),
        facet("mined-catalyst", `Catalyst${suffix}`, "catalyst", mined(minedCatalyst))],
      "Neither commander mined anything before the match ended."),
    panelOf("army", "Army value", "The summed cost of the army units alive at each sample. A cliff is a battle; a line that never leaves the floor is a commander who never built one.",
      [facet("army-material", "Army value in material", "material", sample => sample.armyValueMaterial),
        facet("army-catalyst", "Army value in catalyst", "catalyst", sample => sample.armyValueCatalyst)],
      "No army units were alive at any sample."),
    panelOf("banked", "Unspent", "Banked and doing nothing. Income that keeps climbing here never became army, labour or buildings — floating is usually the story of a lost match.",
      [facet("banked-material", "Unspent material", "material", sample => sample.material),
        facet("banked-catalyst", "Unspent catalyst", "catalyst", sample => sample.catalyst)],
      "Neither commander held a balance at any sample."),
    panelOf("labour", "Labour", "Workers, drifters or harvesters alive. This is the cause the income graph is the effect of.",
      [facet("labour", "Labour units", undefined, sample => sample.labour)],
      "No labour units were alive at any sample."),
  ];

  const totals = slots.map(slot => {
    const list = rows.get(slot) ?? [];
    const last = list[list.length - 1] ?? emptySample(slot, 0n);
    const outIndex = outs.get(slot);
    return {
      slot,
      mined: { material: last.collectedMaterial, catalyst: last.collectedCatalyst },
      lost: { material: last.lostMaterial, catalyst: last.lostCatalyst },
      banked: { material: last.material, catalyst: last.catalyst },
      labour: last.labour, army: last.army, buildings: last.buildings,
      outSeconds: outIndex === undefined ? undefined : seconds[outIndex],
    };
  });

  return { ticks, seconds, slots, panels, totals, incomeMode };
}
