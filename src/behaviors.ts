import { isArmy } from "./catalog";
import { CUSTOM_COLORS, customLabel, customNumber } from "./policies";

/**
 * The server's behavior presets (server/src/behavior.rs) as the client presents
 * them: an order kind, a colour, and a one-line promise for the button tooltip.
 * The client sends one ordinary `issue_order` with the goal in x,y and the
 * server runs the state machine from there; nothing here predicts its states.
 */
export type BehaviorKind = "harass" | "guard" | "raid" | "assault";

export const BEHAVIORS: Readonly<Record<BehaviorKind, { label: string; color: string; hint: string }>> = {
  harass: { label: "Harass", color: "#ffa94d", hint: "Harass: attack-move to the goal, preferring enemy labour; retreat home below 50% health or when outnumbered, recover to 80%, then go back" },
  guard: { label: "Guard", color: "#6ea8ff", hint: "Guard: hold the area around the goal and fight there; if chased more than 600 away, walk back without fighting" },
  raid: { label: "Raid", color: "#ff6b6b", hint: "Raid: push to the goal; retreat home below 35% health, recover to 90%, then push again" },
  assault: { label: "Rush", color: "#ff9ec4", hint: "Rush: attack-move to the goal and never retreat" },
};

/** A preset, or one of the player's own `custom_<n>` slots. */
export type BehaviorName = BehaviorKind | `custom_${1 | 2 | 3 | 4}`;

/** My own slots' names, from my `policy` rows; set from the snapshot (main.ts) so every label below can name a custom behavior. */
let customLabels: ReadonlyMap<number, string> = new Map();
export const setCustomLabels = (labels: ReadonlyMap<number, string>): void => { customLabels = labels; };
export const customName = (n: number): string => customLabels.get(n) ?? `Custom ${n}`;

export const isBehavior = (kind: string | undefined): kind is BehaviorName => !!kind && (kind in BEHAVIORS || customNumber(kind) !== undefined);

/** Label, colour and tooltip of any behavior, preset or custom. */
export function behaviorInfo(kind: BehaviorName | string): { label: string; color: string; hint: string } {
  const number = customNumber(kind);
  if (number !== undefined) {
    const label = customLabel(kind, customLabels)!;
    return { label, color: CUSTOM_COLORS[number - 1], hint: `${label}: your own behavior (Strategy window, Behaviors tab)` };
  }
  return BEHAVIORS[kind as BehaviorKind];
}

/** The behavior a `rally_<behavior>` order carries (a producer's behavior rally), if it is one. */
export const rallyBehavior = (kind: string | undefined): BehaviorName | undefined => {
  const preset = kind?.startsWith("rally_") ? kind.slice(6) : undefined;
  return isBehavior(preset) ? preset : undefined;
};

/** What each state means, for the label and the tooltip over a unit's marker. */
export const STATE_COLOR: Readonly<Record<string, string>> = { advance: "#ffa94d", watch: "#6ea8ff", return: "#c9b2ff", retreat: "#ff5f6d", recover: "#6fd3ff" };
export const stateColor = (state: string | undefined): string => (state && STATE_COLOR[state]) || "#cfd8c8";

/** The units a behavior can be given to: army only. A mixed selection is refused whole by the server, so only these are sent. */
export const behaviorUnits = <T extends { kind: string }>(units: readonly T[]): T[] => units.filter(unit => isArmy(unit.kind));

const title = (word: string): string => customNumber(word) !== undefined ? customName(customNumber(word)!) : word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The selection panel's line: "Harass · retreat" for one unit,
 * "Harass: 6 advance, 2 retreat" for a group, groups of different presets joined with " / ".
 * A burrowed unit adds "Burrowed" ("3 burrowed" for a group). Empty when nothing selected runs a behavior or is burrowed.
 */
export function behaviorLine(units: readonly { behavior?: string | undefined; behaviorState?: string | undefined; burrowed?: boolean | undefined }[]): string {
  const presets = new Map<string, Map<string, number>>();
  for (const unit of units) {
    if (!unit.behavior) continue;
    const states = presets.get(unit.behavior) ?? new Map<string, number>();
    const state = unit.behaviorState ?? "starting";
    states.set(state, (states.get(state) ?? 0) + 1);
    presets.set(unit.behavior, states);
  }
  const single = units.length === 1 && presets.size === 1;
  const lines = [...presets].map(([preset, states]) => single
    ? `${title(preset)} · ${[...states.keys()][0]}`
    : `${title(preset)}: ${[...states].map(([state, count]) => `${count} ${state}`).join(", ")}`);
  const burrowed = units.filter(unit => unit.burrowed).length;
  if (burrowed) lines.push(units.length === 1 ? "Burrowed" : `${burrowed} burrowed`);
  return lines.join(" / ");
}
