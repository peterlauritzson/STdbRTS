import type { PolicyRow } from "./bindings/types";

/**
 * Player-authored behaviors (custom unit state machines). The server owns the
 * interpreter and the text format (server/src/behavior.rs: `parse_policy`,
 * `PRESET_TEXTS`); this file mirrors the format and its limits so the editor
 * can say what the server would refuse, and builds the one-line texts the
 * `policy_set_<n>:<text>` order carries. Keep it in sync with the Rust.
 */
export const MAX_CUSTOM = 4;
export const MAX_STATES = 8;
export const MAX_TRANSITIONS = 4;
export const MAX_CONDITIONS = 2;
export const MAX_QUERY_RADIUS = 600;
export const MAX_DWELL_TICKS = 12_000;
export const MAX_POLICY_TEXT = 2000;
export const MAX_LABEL = 20;
export const MAX_STATE_NAME = 12;
export const TICKS_PER_SECOND = 20;

export type ActionId = "attack_move:goal" | "attack_move:home" | "move:goal" | "move:home" | "hold";
export const ACTIONS: readonly { id: ActionId; label: string }[] = [
  { id: "attack_move:goal", label: "Attack-move to goal" },
  { id: "attack_move:home", label: "Attack-move home" },
  { id: "move:goal", label: "Move to goal" },
  { id: "move:home", label: "Move home" },
  { id: "hold", label: "Hold position" },
];

export type ConditionType = "health_below" | "health_at_least" | "outnumbered" | "no_enemy" | "near_goal" | "near_home" | "far_goal" | "far_home" | "dwell";
/** What each condition's number means: a percentage, a query radius, a distance, or ticks (shown to players as seconds). */
export type ConditionUnit = "percent" | "radius" | "distance" | "ticks";
export const CONDITIONS: readonly { id: ConditionType; label: string; unit: ConditionUnit; fallback: number }[] = [
  { id: "health_below", label: "health below %", unit: "percent", fallback: 50 },
  { id: "health_at_least", label: "health at least %", unit: "percent", fallback: 80 },
  { id: "outnumbered", label: "outnumbered within", unit: "radius", fallback: 350 },
  { id: "no_enemy", label: "no enemy within", unit: "radius", fallback: 350 },
  { id: "near_goal", label: "within … of goal", unit: "distance", fallback: 150 },
  { id: "near_home", label: "within … of home", unit: "distance", fallback: 250 },
  { id: "far_goal", label: "farther than … from goal", unit: "distance", fallback: 600 },
  { id: "far_home", label: "farther than … from home", unit: "distance", fallback: 600 },
  { id: "dwell", label: "seconds in this state", unit: "ticks", fallback: 5 * TICKS_PER_SECOND },
];
const CONDITION_INFO = new Map(CONDITIONS.map(info => [info.id, info]));
const ACTION_IDS = new Set<string>(ACTIONS.map(action => action.id));

export interface Condition { type: ConditionType; /** Percent, radius or distance as written; dwell in ticks. */ value: number }
export interface Transition { to: number; when: Condition[] }
export interface PolicyState { name: string; action: ActionId; transitions: Transition[] }
export interface Policy { label: string; labour: boolean; states: PolicyState[] }
export type ParseResult = { ok: true; policy: Policy } | { ok: false; error: string };

/** The server's presets in the text a policy is submitted in (server/src/behavior.rs PRESET_TEXTS). */
export const PRESET_TEXTS: Readonly<Record<"harass" | "guard" | "raid" | "assault", string>> = {
  harass: "Harass|1|advance,attack_move:goal,1:health_below=50,1:outnumbered=350|retreat,move:home,2:near_home=250|recover,hold,0:health_at_least=80",
  guard: "Guard|0|return,move:goal,1:near_goal=150|watch,attack_move:goal,0:far_goal=600",
  raid: "Raid|0|advance,attack_move:goal,1:health_below=35|retreat,move:home,2:near_home=250|recover,hold,0:health_at_least=90",
  assault: "Rush|0|assault,attack_move:goal",
};
/** A starting point that does something: one state that attack-moves to the goal. */
export const BLANK_TEXT = "New|0|start,attack_move:goal";

const NAME = /^[A-Za-z0-9 _-]+$/;
const DIGITS = /^\d+$/;
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Drops every character a label or state name may not contain, so it can never hold the text's own separators. */
export const cleanName = (value: string): string => value.replace(/[^A-Za-z0-9 _-]/g, "");

function checkedName(raw: string, longest: number, what: string): string {
  const name = raw.trim();
  if (!name || name.length > longest || !NAME.test(name)) throw new Error(`A ${what} is 1 to ${longest} letters, digits, spaces, - or _`);
  return name;
}

function parseAction(raw: string): ActionId {
  if (!ACTION_IDS.has(raw)) throw new Error(`Unknown action "${raw}"`);
  return raw as ActionId;
}

function parseCondition(raw: string): Condition {
  const at = raw.indexOf("=");
  if (at < 0) throw new Error(`A condition is name=value, not "${raw}"`);
  const name = raw.slice(0, at);
  const value = raw.slice(at + 1);
  const info = CONDITION_INFO.get(name as ConditionType);
  if (!info) throw new Error(`Unknown condition "${name}"`);
  if (info.unit === "percent") {
    if (!DIGITS.test(value) || Number(value) > 255) throw new Error(`"${value}" is not a percentage`);
  } else if (info.unit === "ticks") {
    if (!DIGITS.test(value)) throw new Error(`"${value}" is not a tick count`);
  } else if (!FLOAT.test(value) || !Number.isFinite(Number(value))) throw new Error(`"${value}" is not a number`);
  return { type: info.id, value: Number(value) };
}

/** The limits on a whole policy, as the server checks them after parsing. */
function validate(policy: Policy): void {
  if (!policy.states.length || policy.states.length > MAX_STATES) throw new Error(`A policy has 1 to ${MAX_STATES} states`);
  for (const state of policy.states) {
    if (state.transitions.length > MAX_TRANSITIONS) throw new Error(`A state has at most ${MAX_TRANSITIONS} transitions`);
    for (const transition of state.transitions) {
      if (transition.when.length > MAX_CONDITIONS) throw new Error(`A transition tests at most ${MAX_CONDITIONS} conditions`);
      if (!Number.isInteger(transition.to) || transition.to < 0 || transition.to >= policy.states.length) throw new Error("A transition leads to a state that does not exist");
      for (const { type, value } of transition.when) {
        const unit = CONDITION_INFO.get(type)!.unit;
        if (unit === "percent") { if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("A health threshold is a percentage"); }
        else if (unit === "distance") { if (!Number.isFinite(value) || value < 0) throw new Error("A distance must be a finite, non-negative number"); }
        else if (unit === "ticks") { if (!Number.isInteger(value) || value < 0 || value > MAX_DWELL_TICKS) throw new Error(`A dwell is at most ${MAX_DWELL_TICKS / TICKS_PER_SECOND} seconds`); }
        else if (!Number.isFinite(value) || value <= 0 || value > MAX_QUERY_RADIUS) throw new Error(`A query radius is above 0 and at most ${MAX_QUERY_RADIUS}`);
      }
    }
  }
}

/** Parses a policy's text exactly as the server does, or says why it would refuse it. */
export function parsePolicy(text: string): ParseResult {
  try {
    if (text.length > MAX_POLICY_TEXT) throw new Error(`A policy is at most ${MAX_POLICY_TEXT} characters`);
    const parts = text.split("|");
    const label = checkedName(parts[0] ?? "", MAX_LABEL, "behavior name");
    const flag = parts[1]?.trim();
    if (flag !== "0" && flag !== "1") throw new Error("The second field is 1 (prefer labour) or 0");
    const states: PolicyState[] = [];
    for (const part of parts.slice(2)) {
      if (states.length === MAX_STATES) throw new Error(`A policy has 1 to ${MAX_STATES} states`);
      const fields = part.split(",").map(field => field.trim());
      const name = checkedName(fields[0] ?? "", MAX_STATE_NAME, "state name");
      const action = parseAction(fields[1] ?? "");
      const transitions: Transition[] = [];
      for (const field of fields.slice(2)) {
        if (transitions.length === MAX_TRANSITIONS) throw new Error(`A state has at most ${MAX_TRANSITIONS} transitions`);
        const colon = field.indexOf(":");
        if (colon < 0) throw new Error(`A transition is to:conditions, not "${field}"`);
        const to = field.slice(0, colon).trim();
        if (!DIGITS.test(to) || Number(to) > 255) throw new Error(`"${to}" is not a state number`);
        const when = field.slice(colon + 1).split("&").map(condition => condition.trim()).filter(condition => condition).slice(0, MAX_CONDITIONS + 1).map(parseCondition);
        transitions.push({ to: Number(to), when });
      }
      states.push({ name, action, transitions });
    }
    const policy: Policy = { label, labour: flag === "1", states };
    validate(policy);
    return { ok: true, policy };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The text the server parses back to this policy. */
export function serializePolicy(policy: Policy): string {
  const state = (entry: PolicyState): string => [entry.name, entry.action, ...entry.transitions.map(transition => `${transition.to}:${transition.when.map(condition => `${condition.type}=${condition.value}`).join("&")}`)].join(",");
  return [policy.label, policy.labour ? "1" : "0", ...policy.states.map(state)].join("|");
}

/** A deep copy, so a draft can be edited without touching the parsed row. */
export const clonePolicy = (policy: Policy): Policy => ({ ...policy, states: policy.states.map(state => ({ ...state, transitions: state.transitions.map(transition => ({ ...transition, when: transition.when.map(condition => ({ ...condition })) })) })) });

const trim = (value: number): string => String(Math.round(value * 100) / 100);

export const actionLabel = (action: ActionId): string => ACTIONS.find(entry => entry.id === action)?.label ?? action;

/** "health < 50%", "outnumbered within 350", "5 s in this state". */
export function describeCondition(condition: Condition): string {
  const { value } = condition;
  switch (condition.type) {
    case "health_below": return `health < ${value}%`;
    case "health_at_least": return `health ≥ ${value}%`;
    case "outnumbered": return `outnumbered within ${trim(value)}`;
    case "no_enemy": return `no enemy within ${trim(value)}`;
    case "near_goal": return `within ${trim(value)} of goal`;
    case "near_home": return `within ${trim(value)} of home`;
    case "far_goal": return `farther than ${trim(value)} from goal`;
    case "far_home": return `farther than ${trim(value)} from home`;
    case "dwell": return `${trim(value / TICKS_PER_SECOND)} s in this state`;
  }
}

const ACTION_WORDS: Readonly<Record<ActionId, string>> = {
  "attack_move:goal": "attack-move to goal", "attack_move:home": "attack-move home", "move:goal": "move to goal", "move:home": "move home", hold: "hold position",
};

/** "→ retreat when health < 50% and outnumbered within 350"; no conditions means as soon as the 1 s minimum has passed. */
export function describeTransition(policy: Pick<Policy, "states">, transition: Transition): string {
  const target = policy.states[transition.to]?.name ?? `#${transition.to}`;
  return `→ ${target} ${transition.when.length ? `when ${transition.when.map(describeCondition).join(" and ")}` : "after 1 s"}`;
}

/** "advance: attack-move to goal; → retreat when health < 50%; → retreat when outnumbered within 350". */
export function describeState(policy: Pick<Policy, "states">, state: PolicyState): string {
  return [`${state.name}: ${ACTION_WORDS[state.action]}`, ...state.transitions.map(transition => describeTransition(policy, transition))].join("; ");
}

/** Four colours apart from the presets' (behaviors.ts BEHAVIORS) and the gather mission's. */
export const CUSTOM_COLORS: readonly string[] = ["#5fd38d", "#f2d94e", "#3fd0d4", "#e08cff"];

/** `n` for the order kind `custom_<n>`, or undefined. Also reads `rally_custom_<n>` and `mission_*_custom_<n>` when given the bare suffix. */
export function customNumber(kind: string | undefined): number | undefined {
  const match = kind ? /^custom_([1-4])$/.exec(kind) : null;
  return match ? Number(match[1]) : undefined;
}

export const customKind = (number: number): string => `custom_${number}`;

/** The player's own slots by number: the parsed label of each defined row, "Custom n" if the text no longer parses. */
export function policyLabels(rows: readonly Pick<PolicyRow, "slot" | "number" | "text">[], owner: number | undefined): Map<number, string> {
  const labels = new Map<number, string>();
  if (owner === undefined) return labels;
  for (const row of rows) if (row.slot === owner) {
    const parsed = parsePolicy(row.text);
    labels.set(row.number, parsed.ok ? parsed.policy.label : `Custom ${row.number}`);
  }
  return labels;
}

/** A behavior kind's display name for an owner's slots: "Custom 2" when the slot has no row (or is not custom at all, the kind itself). */
export function customLabel(kind: string, labels: ReadonlyMap<number, string>): string | undefined {
  const number = customNumber(kind);
  return number === undefined ? undefined : labels.get(number) ?? `Custom ${number}`;
}

export const customColor = (kind: string): string | undefined => {
  const number = customNumber(kind);
  return number === undefined ? undefined : CUSTOM_COLORS[number - 1];
};

/** The text of the player's slot `number`, if defined. */
export const policyText = (rows: readonly Pick<PolicyRow, "slot" | "number" | "text">[], owner: number | undefined, number: number): string | undefined =>
  owner === undefined ? undefined : rows.find(row => row.slot === owner && row.number === number)?.text;

/** The order kinds: define, clear, and the use of a slot. */
export const policyOrders = {
  set: (number: number, text: string) => ({ kind: `policy_set_${number}:${text}`, x: 0, y: 0, target: 0 }),
  clear: (number: number) => ({ kind: `policy_clear_${number}`, x: 0, y: 0, target: 0 }),
};
