import { ACTIONS, CONDITIONS, MAX_CONDITIONS, MAX_TRANSITIONS, TICKS_PER_SECOND, cleanName, describeState, removeState, type ActionId, type ConditionType, type Policy } from "./policies";

/** A DOM node with text and a class: the one-line builder the game and the editor share. */
export function text(tag: string, content: string, className = ""): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = content;
  node.className = className;
  return node;
}

export interface PolicyFormOptions {
  /** A value changed in place (typing, a select); nothing needs rebuilding. */
  onChange(): void;
  /** The shape changed (state or transition or condition added, removed, moved): rebuild the form. */
  onStructure(): void;
  /** Show only this state's editor (the standalone editor's inspector). */
  only?: number;
  /** Mark one transition of a state as the selected one. */
  highlight?: { state: number; transition?: number };
  /** Replace the default state removal (the editor also splices its layout). */
  removeState?(index: number): void;
}

export interface PolicyForm { element: HTMLElement; /** Update target names and summaries after an in-place change. */ refresh(): void }

/**
 * The per-state editor shared by the game's Behaviors tab and the standalone
 * editor: name, action, transitions (order is priority), conditions. It edits
 * `policy` in place and reports through the options.
 */
export function policyForm(policy: Policy, options: PolicyFormOptions): PolicyForm {
  const list = text("div", "", "behavior-states");
  const summaries: [HTMLElement, number][] = [];
  const targets: HTMLSelectElement[] = [];
  const structural = (change: () => void): void => { change(); options.onStructure(); };
  const add = (parent: HTMLElement, label: string, title: string, action: () => void, disabled = false): HTMLButtonElement => {
    const button = text("button", label, "strategy-tool") as HTMLButtonElement;
    button.title = title; button.setAttribute("aria-label", title); button.disabled = disabled;
    button.addEventListener("click", action);
    parent.append(button);
    return button;
  };

  policy.states.forEach((state, index) => {
    if (options.only !== undefined && options.only !== index) return;
    const box = text("div", "", "behavior-state");
    const line = text("div", "", "behavior-line");
    const stateName = document.createElement("input");
    stateName.type = "text"; stateName.maxLength = 12; stateName.value = state.name; stateName.setAttribute("aria-label", `State ${index} name`);
    stateName.addEventListener("input", () => { const clean = cleanName(stateName.value); if (clean !== stateName.value) stateName.value = clean; state.name = clean; options.onChange(); });
    const action = document.createElement("select");
    action.setAttribute("aria-label", `State ${index} action`);
    for (const entry of ACTIONS) action.append(new Option(entry.label, entry.id, false, entry.id === state.action));
    action.addEventListener("change", () => { state.action = action.value as ActionId; options.onChange(); });
    line.append(text("span", index === 0 ? "#0 start" : `#${index}`, "index mono"), stateName, action);
    add(line, "×", `Remove state ${index}`, () => structural(() => (options.removeState ?? (at => removeState(policy, at)))(index)), policy.states.length <= 1);
    box.append(line);

    state.transitions.forEach((transition, at) => {
      const row = text("div", "", "behavior-line behavior-transition");
      if (options.highlight?.state === index && options.highlight.transition === at) row.classList.add("selected");
      row.append(text("span", `${at + 1}.`, "behavior-ok behavior-priority"));
      row.append(text("span", "go to", "behavior-ok"));
      const target = document.createElement("select");
      target.className = "behavior-target"; target.setAttribute("aria-label", `State ${index} transition ${at + 1} target`);
      policy.states.forEach((other, to) => target.append(new Option(`#${to} ${other.name}`, String(to), false, to === transition.to)));
      target.addEventListener("change", () => { transition.to = Number(target.value); options.onChange(); });
      targets.push(target);
      row.append(target);
      if (!transition.when.length) row.append(text("span", "after 1 s", "behavior-ok"));
      transition.when.forEach((condition, which) => {
        row.append(text("span", which ? "and" : "when", "behavior-ok"));
        const kind = document.createElement("select");
        kind.setAttribute("aria-label", `Condition ${which + 1} type`);
        for (const entry of CONDITIONS) kind.append(new Option(entry.label, entry.id, false, entry.id === condition.type));
        const info = (): (typeof CONDITIONS)[number] => CONDITIONS.find(entry => entry.id === condition.type)!;
        const amount = document.createElement("input");
        amount.type = "number"; amount.setAttribute("aria-label", `Condition ${which + 1} value`);
        const sync = (): void => {
          const { unit } = info();
          amount.min = unit === "radius" ? "1" : "0";
          amount.max = unit === "percent" ? "100" : unit === "radius" ? "600" : unit === "ticks" ? "600" : "";
          amount.step = unit === "ticks" ? "0.5" : "1";
          amount.value = String(unit === "ticks" ? condition.value / TICKS_PER_SECOND : condition.value);
        };
        sync();
        kind.addEventListener("change", () => {
          const before = info().unit;
          condition.type = kind.value as ConditionType;
          if (info().unit !== before) condition.value = info().fallback;
          sync(); options.onChange();
        });
        amount.addEventListener("input", () => {
          const entered = amount.valueAsNumber;
          condition.value = Number.isFinite(entered) ? (info().unit === "ticks" ? Math.round(entered * TICKS_PER_SECOND) : entered) : NaN;
          options.onChange();
        });
        row.append(kind, amount);
        add(row, "−", `Remove condition ${which + 1}`, () => structural(() => { transition.when.splice(which, 1); }));
      });
      add(row, "+ when", "Add a condition (up to 2; all must hold)", () => structural(() => { transition.when.push({ type: CONDITIONS[0].id, value: CONDITIONS[0].fallback }); }), transition.when.length >= MAX_CONDITIONS);
      add(row, "↑", "Try this transition earlier (order is priority: the first that holds wins)", () => structural(() => { [state.transitions[at - 1], state.transitions[at]] = [state.transitions[at], state.transitions[at - 1]]; }), at === 0);
      add(row, "↓", "Try this transition later", () => structural(() => { [state.transitions[at + 1], state.transitions[at]] = [state.transitions[at], state.transitions[at + 1]]; }), at === state.transitions.length - 1);
      add(row, "×", `Remove transition ${at + 1}`, () => structural(() => { state.transitions.splice(at, 1); }));
      box.append(row);
    });
    const tools = text("div", "", "behavior-line behavior-transition");
    add(tools, "+ transition", "Add a transition (up to 4; the first that holds wins)", () => structural(() => { state.transitions.push({ to: (index + 1) % policy.states.length, when: [{ type: CONDITIONS[0].id, value: CONDITIONS[0].fallback }] }); }), state.transitions.length >= MAX_TRANSITIONS);
    box.append(tools);
    const summary = text("p", "", "behavior-summary");
    summaries.push([summary, index]);
    box.append(summary);
    list.append(box);
  });

  const refresh = (): void => {
    for (const select of targets) [...select.options].forEach((option, to) => { option.textContent = `#${to} ${policy.states[to]?.name ?? ""}`; });
    for (const [summary, index] of summaries) summary.textContent = describeState(policy, policy.states[index]);
  };
  refresh();
  return { element: list, refresh };
}
