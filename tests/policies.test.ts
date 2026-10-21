import assert from "node:assert/strict";
import test from "node:test";
import { PRESET_TEXTS, customColor, customLabel, describeState, describeTransition, parsePolicy, policyLabels, serializePolicy } from "../src/policies";
import { BEHAVIORS } from "../src/behaviors";

// The format and its limits are the server's (server/src/behavior.rs parse_policy);
// these are the cases the editor must agree with it on.

test("every preset text round-trips through parse and serialize", () => {
  for (const [name, text] of Object.entries(PRESET_TEXTS)) {
    const parsed = parsePolicy(text);
    assert.ok(parsed.ok, `${name}: ${parsed.ok ? "" : parsed.error}`);
    assert.equal(serializePolicy(parsed.policy), text, name);
  }
});

test("harass parses into its states, labour flag and conditions", () => {
  const parsed = parsePolicy(PRESET_TEXTS.harass);
  assert.ok(parsed.ok);
  assert.equal(parsed.policy.label, "Harass");
  assert.equal(parsed.policy.labour, true);
  assert.deepEqual(parsed.policy.states.map(state => state.name), ["advance", "retreat", "recover"]);
  assert.deepEqual(parsed.policy.states[0].transitions[1], { to: 1, when: [{ type: "outnumbered", value: 350 }] });
});

const refused = (text: string, pattern: RegExp): void => {
  const parsed = parsePolicy(text);
  assert.ok(!parsed.ok, text);
  assert.match(parsed.error, pattern, text);
};

test("the server's limits are refused", () => {
  const state = (index: number): string => `s${index},hold`;
  refused(`Many|0|${Array.from({ length: 9 }, (_, index) => state(index)).join("|")}`, /1 to 8 states/);
  assert.ok(parsePolicy(`Eight|0|${Array.from({ length: 8 }, (_, index) => state(index)).join("|")}`).ok);
  refused("Moves|0|a,hold,0:,0:,0:,0:,0:", /at most 4 transitions/);
  refused("Conds|0|a,hold,0:health_below=5&near_goal=1&near_home=1", /at most 2 conditions/);
  refused("Radius|0|a,hold,0:outnumbered=900", /radius/);
  refused("Radius|0|a,hold,0:no_enemy=0", /radius/);
  refused("Health|0|a,hold,0:health_below=101", /percentage/);
  refused("Dwell|0|a,hold,0:dwell=12001", /dwell/);
  refused(`Long|0|a,hold${",0:".repeat(1000)}`, /at most 2000/);
});

test("malformed text is refused", () => {
  refused("Bad|label|0|a,hold", /prefer labour/);
  refused("Bad,name|0|a,hold", /behavior name/);
  refused("|0|a,hold", /behavior name/);
  refused("A very long behavior name indeed|0|a,hold", /behavior name/);
  refused("Name|0|bad!,hold", /state name/);
  refused("Name|0|a,dance", /Unknown action/);
  refused("Name|0|a,attack_move:sky", /Unknown action/);
  refused("Name|0|a,hold,5:", /does not exist/);
  refused("Name|2|a,hold", /prefer labour/);
  refused("Name|0", /1 to 8 states/);
  refused("Name|0|a,hold,0:mood=3", /Unknown condition/);
  refused("Name|0|a,hold,0:near_home", /name=value/);
  refused("Name|0|a,hold,0:near_home=soon", /not a number/);
  refused("Name|0|a,hold,x:", /state number/);
});

test("descriptions read in plain English, dwell in seconds", () => {
  const parsed = parsePolicy(PRESET_TEXTS.harass);
  assert.ok(parsed.ok);
  assert.equal(describeState(parsed.policy, parsed.policy.states[0]), "advance: attack-move to goal; \u2192 retreat when health < 50%; \u2192 retreat when outnumbered within 350");
  assert.equal(describeState(parsed.policy, parsed.policy.states[1]), "retreat: move home; \u2192 recover when within 250 of home");
  const timed = parsePolicy("T|0|a,hold,1:dwell=100|b,hold,0:");
  assert.ok(timed.ok);
  assert.equal(describeTransition(timed.policy, timed.policy.states[0].transitions[0]), "\u2192 b when 5 s in this state");
  assert.equal(describeTransition(timed.policy, timed.policy.states[1].transitions[0]), "\u2192 a after 1 s");
});

test("custom slots resolve to the owner's label and a colour apart from the presets", () => {
  const rows = [{ slot: 0, number: 2, text: PRESET_TEXTS.guard }, { slot: 1, number: 1, text: PRESET_TEXTS.raid }];
  const labels = policyLabels(rows, 0);
  assert.equal(customLabel("custom_2", labels), "Guard");
  assert.equal(customLabel("custom_3", labels), "Custom 3");
  assert.equal(customLabel("harass", labels), undefined);
  const colors = ["custom_1", "custom_2", "custom_3", "custom_4"].map(kind => customColor(kind));
  assert.equal(new Set(colors).size, 4);
  for (const color of colors) assert.ok(!Object.values(BEHAVIORS).some(preset => preset.color === color));
});
