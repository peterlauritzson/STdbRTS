import assert from "node:assert/strict";
import test from "node:test";
import { LIBRARY_KEY, addEntry, appendLayout, assignSlot, createEntry, deleteEntry, duplicateEntry, emptyLibrary, entryStatus, exportJson, importText, loadLibrary, loadoutTexts, removeLayoutAt, saveLibrary } from "../src/behavior-library";
import { PRESET_TEXTS, nextTransition, parsePolicy, removeState, serializePolicy, type Policy, type Situation } from "../src/policies";

const store = (value: string | null | (() => never)) => ({ getItem: (_key: string) => typeof value === "function" ? value() : value });
const policyOf = (text: string): Policy => {
  const parsed = parsePolicy(text);
  assert.ok(parsed.ok, text);
  return parsed.policy;
};

test("missing, corrupt or blocked storage reads as an empty library", () => {
  for (const source of [store(null), store("{not json"), store("[]"), store("42"), store(() => { throw new Error("blocked"); }), undefined]) {
    const library = loadLibrary(source);
    assert.deepEqual(library.entries, []);
    assert.deepEqual(library.loadout, [null, null, null, null]);
    assert.equal(library.autoInstall, true);
  }
  assert.equal(saveLibrary(emptyLibrary(), { setItem: () => { throw new Error("full"); } }), false);
});

test("a saved library round-trips, and a loadout id with no entry is dropped", () => {
  const entry = createEntry(PRESET_TEXTS.guard, [[0, 0], [230, 0]], 5);
  let library = assignSlot(addEntry(emptyLibrary(), entry), 2, entry.id);
  library = { ...library, autoInstall: false };
  let written = "";
  assert.ok(saveLibrary(library, { setItem: (key, value) => { assert.equal(key, LIBRARY_KEY); written = value; } }));
  const back = loadLibrary(store(written));
  assert.equal(back.autoInstall, false);
  assert.deepEqual(back.entries[0].layout, [[0, 0], [230, 0]]);
  assert.equal(back.loadout[1], entry.id);
  const stale = JSON.parse(written);
  stale.loadout[0] = "nobody";
  assert.equal(loadLibrary(store(JSON.stringify(stale))).loadout[0], null);
});

test("a broken entry is kept but flagged", () => {
  const stored = JSON.stringify({ version: 1, entries: [{ id: "a", text: "garbage", updated: 1 }, { id: "b", text: PRESET_TEXTS.raid, updated: 2 }, { nope: true }], loadout: [], autoInstall: true });
  const library = loadLibrary(store(stored));
  assert.equal(library.entries.length, 2);
  assert.equal(entryStatus(library.entries[0]).ok, false);
  assert.equal(entryStatus(library.entries[1]).ok, true);
});

test("importText takes mixed lines, reporting the bad ones", () => {
  const result = importText(`${PRESET_TEXTS.harass}\n\n  \nnot a policy\n${PRESET_TEXTS.guard}\r\nX|1|a,fly`);
  assert.equal(result.entries.length, 2);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /^Line 4:/);
  assert.match(result.errors[1], /^Line 6:/);
  assert.equal(importText("  ").errors.length, 1);
});

test("importText reads the exported library JSON, giving entries new ids and keeping layouts that fit", () => {
  const first = createEntry(PRESET_TEXTS.guard, [[0, 0], [230, 0]]);
  const second = createEntry(PRESET_TEXTS.raid, [[1, 1]]);
  const bad = createEntry("nope");
  let library = addEntry(addEntry(addEntry(emptyLibrary(), first), second), bad);
  library = assignSlot(library, 1, first.id);
  const result = importText(exportJson(library));
  assert.equal(result.entries.length, 2);
  assert.equal(result.errors.length, 1);
  assert.notEqual(result.entries[0].id, first.id);
  assert.deepEqual(result.entries[0].layout, [[0, 0], [230, 0]]);
  assert.equal(result.entries[1].layout, undefined, "a layout of the wrong length is dropped");
  assert.equal(importText("{ nope").errors.length, 1);
});

test("assigning a loadout slot moves the entry, and null clears", () => {
  const a = createEntry(PRESET_TEXTS.guard);
  const b = createEntry(PRESET_TEXTS.raid);
  let library = addEntry(addEntry(emptyLibrary(), a), b);
  library = assignSlot(library, 1, a.id);
  library = assignSlot(library, 3, a.id);
  assert.deepEqual(library.loadout, [null, null, a.id, null]);
  library = assignSlot(library, 3, b.id);
  assert.deepEqual(library.loadout, [null, null, b.id, null]);
  library = assignSlot(library, 3, null);
  assert.deepEqual(library.loadout, [null, null, null, null]);
  assert.deepEqual(assignSlot(library, 9, a.id), library);
  assert.deepEqual(assignSlot(library, 1, "ghost"), library);
});

test("deleting an entry clears its slot; duplicating copies it after the original", () => {
  const a = createEntry(PRESET_TEXTS.guard);
  const b = createEntry(PRESET_TEXTS.raid);
  let library = assignSlot(addEntry(addEntry(emptyLibrary(), a), b), 2, a.id);
  const copy = duplicateEntry(library, a.id);
  assert.equal(copy.library.entries.length, 3);
  assert.equal(copy.library.entries[1].id, copy.entry!.id);
  assert.ok(parsePolicy(copy.entry!.text).ok);
  assert.equal(copy.library.loadout[1], a.id, "the copy does not take the slot");
  library = deleteEntry(library, a.id);
  assert.deepEqual(library.loadout, [null, null, null, null]);
  assert.deepEqual(library.entries.map(entry => entry.id), [b.id]);
});

test("loadoutTexts lists valid entries by slot number", () => {
  const good = createEntry(PRESET_TEXTS.guard);
  const broken = createEntry("broken");
  let library = addEntry(addEntry(emptyLibrary(), good), broken);
  library = assignSlot(assignSlot(library, 4, good.id), 2, broken.id);
  assert.deepEqual(loadoutTexts(library), [{ number: 4, text: PRESET_TEXTS.guard }]);
});

test("removeState drops transitions into the state and renumbers later targets", () => {
  const policy = policyOf(PRESET_TEXTS.harass);
  removeState(policy, 1); // retreat
  assert.deepEqual(policy.states.map(state => state.name), ["advance", "recover"]);
  assert.deepEqual(policy.states[0].transitions, []);
  assert.equal(policy.states[1].transitions[0].to, 0);
  assert.ok(parsePolicy(serializePolicy(policy)).ok);
  const chain = policyOf("T|0|a,hold,2:dwell=20|b,hold,0:dwell=20|c,hold,1:dwell=20");
  removeState(chain, 0);
  assert.deepEqual(chain.states.map(state => state.transitions.map(transition => transition.to)), [[], [0]]);
});

test("layout positions follow states that are removed or added", () => {
  const layout: [number, number][] = [[0, 0], [10, 10], [20, 20]];
  assert.deepEqual(removeLayoutAt(layout, 1), [[0, 0], [20, 20]]);
  assert.deepEqual(appendLayout(layout, [5, 6]), [[0, 0], [10, 10], [20, 20], [5, 6]]);
  assert.equal(layout.length, 3, "inputs are not changed");
});

const calm: Situation = { healthPercent: 100, goalDistance: 500, homeDistance: 100, enemyDistance: Infinity, enemies: 0, allies: 0, secondsInState: 5 };

test("nextTransition takes the first transition that holds, in declaration order", () => {
  const policy = policyOf(PRESET_TEXTS.harass);
  // advance: 1:health_below=50, 1:outnumbered=350. Hurt and outnumbered: the first wins.
  const verdict = nextTransition(policy, 0, { ...calm, healthPercent: 20, enemyDistance: 100, enemies: 5 });
  assert.equal(verdict.fired, 0);
  assert.deepEqual(verdict.checks.map(check => check.holds), [true, true]);
  assert.equal(nextTransition(policy, 0, { ...calm, enemyDistance: 100, enemies: 5 }).fired, 1);
  assert.equal(nextTransition(policy, 0, calm).fired, undefined);
});

test("nothing fires before one second in a state, and a transition with no conditions fires after it", () => {
  const policy = policyOf(PRESET_TEXTS.harass);
  assert.equal(nextTransition(policy, 0, { ...calm, healthPercent: 1, secondsInState: 0.9 }).fired, undefined);
  assert.equal(nextTransition(policy, 0, { ...calm, healthPercent: 1, secondsInState: 1 }).fired, 0);
  const plain = policyOf("P|0|a,hold,1:|b,hold");
  assert.equal(nextTransition(plain, 0, { ...calm, secondsInState: 0.5 }).fired, undefined);
  assert.equal(nextTransition(plain, 0, { ...calm, secondsInState: 1 }).fired, 0);
});

test("conditions read the situation as the server does", () => {
  const policy = policyOf("C|0|a,hold,0:health_below=50,0:health_at_least=50,0:near_goal=150,0:far_home=300|b,hold");
  const holds = (situation: Partial<Situation>) => nextTransition(policy, 0, { ...calm, ...situation }).checks.map(check => check.holds);
  assert.deepEqual(holds({ healthPercent: 49 }).slice(0, 2), [true, false]);
  assert.deepEqual(holds({ healthPercent: 50 }).slice(0, 2), [false, true]);
  assert.equal(holds({ goalDistance: 150 })[2], true);
  assert.equal(holds({ goalDistance: 151 })[2], false);
  assert.equal(holds({ homeDistance: 300 })[3], false, "farther than is strict");
  assert.equal(holds({ homeDistance: 301 })[3], true);
});

test("dwell counts the seconds in the state, and no_enemy reads the nearest enemy distance", () => {
  const policy = policyOf("D|0|a,hold,0:dwell=100,0:no_enemy=350|b,hold");
  const run = (situation: Partial<Situation>) => nextTransition(policy, 0, { ...calm, ...situation }).checks.map(check => check.holds);
  assert.deepEqual(run({ secondsInState: 4.5 }), [false, true]);
  assert.deepEqual(run({ secondsInState: 5, enemyDistance: 350, enemies: 1 }), [true, false]);
  assert.equal(run({ enemyDistance: 351, enemies: 1 })[1], true);
});

test("outnumbered counts the unit itself as a friend: strictly more enemies than friends", () => {
  const policy = policyOf("O|0|a,hold,0:outnumbered=350|b,hold");
  const run = (situation: Partial<Situation>) => nextTransition(policy, 0, { ...calm, ...situation }).fired;
  assert.equal(run({ enemies: 1, enemyDistance: 100, allies: 0 }), undefined, "1 enemy against just the unit is not outnumbered");
  assert.equal(run({ enemies: 2, enemyDistance: 100, allies: 0 }), 0);
  assert.equal(run({ enemies: 2, enemyDistance: 100, allies: 1 }), undefined, "2 against 2");
  assert.equal(run({ enemies: 3, enemyDistance: 100, allies: 1 }), 0);
  assert.equal(run({ enemies: 9, enemyDistance: 351, allies: 0 }), undefined, "enemies beyond the radius do not count");
});
