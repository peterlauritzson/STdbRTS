# Strategy Layers

Status: design accepted by the author 2026-10-09; implementation in increments. Extends [COMMANDS-AND-BEHAVIORS.md](COMMANDS-AND-BEHAVIORS.md).

## Summary

- Players set strategy at four layers, each a small finite-state policy: **combat stance** (how a unit fights), **mission tactic** (what a group does at a place), **production doctrine** (what to train), **economy doctrine** (expanding and holding ground).
- Every layer ships presets with a few tunable knobs. A full when→do rule editor comes later, over the same model and limits as `server/src/behavior.rs`.
- Everything runs **on the server**. Missions leave the browser tab: they keep staffing when the tab closes, the practice bot can use the same code, and they are not bound by the client's order-rate limits.
- Schema rule: add new tables, do not change columns of existing ones (the live server deploys with `--delete-data=never`).

## Layer 1: combat stance (per player, per unit kind)

Status: **implemented** 2026-10-09 (`stance` table, `stance_<kind>_<stance>` command, Stances section in the Strategy panel). Defaults as built: kite for marksman, lancer, spitter; charge for bulwark, behemoth, crusher (swarmer stays standard). Idle auto-acquire never moves a unit, so only `attack_move` is affected.

Decides how a unit fights once it has a target on an `attack_move` (or is idle and auto-acquiring). It never overrides a plain `move`, a `hold` or an explicit `attack` the player gave. Evaluated every tick inside the existing attack-move step, statelessly, so it needs no new unit fields.

| Stance | What it does | Default for |
| --- | --- | --- |
| **Standard** | Today's behaviour: close to 90% of weapon range and fire. | most units |
| **Charge** | Close to 40% of range: push into the enemy, soak fire, body-block. | heavy/melee units (bulwark, behemoth, crusher, swarmer) |
| **Kite** | While the weapon is reloading and the target is closer than 80% of the unit's range, step directly away from it; otherwise as Standard. Only useful against shorter-ranged enemies, which is the point. | long-range units (marksman, lancer, spitter) |
| **Hold ground** | Fire at anything in range; never walk toward a target. Still walks the attack-move path when nothing is in range. | none (player choice; pairs with Entrenchment) |

- Stored per `(owner, kind)` in a new table; missing rows mean the kind's default. Changing a stance is an ordinary delayed command.
- Knobs (later): kite trigger distance, charge distance.
- Risk to watch: per-tick kiting is "automatic micro". It is available to both sides and limited by the target being shorter-ranged; revisit if it dominates.

## Layer 2: mission tactics (group FSM)

Status: **implemented** 2026-10-09 (`mission` table, `mission_*` commands: `mission_new_<tactic>`, `mission_tactic_<tactic>`, `mission_size`, `mission_gather`, `mission_fallback`, `mission_rally`, `mission_cancel`, `mission_assign`; one-second pass in `server/src/mission.rs`; client staffing and localStorage removed). Deferred: the per-mission retreat-health knob (needs a change to the unit Behavior struct) and the practice bot using missions. All numbers are experimental.

A mission is a server row: owner, place, size (number or "rest"), tactic, knobs, group state, members. A one-second server pass:

1. Drops dead members. A member the player gives any ordinary order is removed from its mission **at the moment that order executes** (the server knows directly, no client guessing).
2. Recruits idle army units (no behavior, order `stop`), including newly trained ones, into missions in creation order up to size, nearest first; "rest" missions share what is left.
3. Runs the mission's group state machine, which sets each member's per-unit behavior (preset + goal). Per-unit behaviors stay as they are in `behavior.rs`.

| Tactic | Group states | Per-unit behavior used |
| --- | --- | --- |
| **Hit and retreat** (today's Raid) | — | raid: advance, retreat below 35%, return at 90% |
| **Harass** | — | harass: prefers labour, retreats when hurt or outnumbered |
| **Guard** | — | guard: hold a spot with a leash |
| **Rush** | — | assault (new): attack-move to the goal, never retreat |
| **Gather then strike** | gather → strike → fall back → gather | gather: guard at the rally point; strike: assault to the goal; fall back: move to the rally point |

During a strike, units recruited after it began wait at the rally and go in as a wave once enough are there (4 for "rest"); only members running the assault count toward the fall-back check, so a steady stream of new units can no longer hold a failing strike in place or feed it one unit at a time (added 2026-10-10).

Gather then strike knobs: rally point (default 65% of the way from the owner's nearest hub to the goal), strike when at least *G*% of the mission's size is at the rally (default 80%; for "rest", at least 8 units), fall back when strength drops below *F*% of what struck (default 40%).

Mission knobs common to all: size, retreat health % for the presets that retreat.

## Layer 3: production doctrine

Status: **implemented** 2026-10-09 (`doctrine` and `doctrine_weight` tables, `doctrine_*` commands, pass every 20 ticks in `server/src/doctrine.rs`, Production section in the Strategy panel). As built: weights 0 to 10 per army kind (default 5), a catalyst reserve (0 to 2000), Auto-train, Auto-tier, Auto-research and Auto-build, all off by default; presets Even, Basics and Heavy only set weights. Auto-build (implemented): at most one construction per owner per pass and none while a barracks, factory, laboratory or synthesizer is unfinished; first a refinery on any free catalyst deposit within 500 of a finished hub (round 4 of the same playtest: with no Expand the main's own deposits stayed empty), then the next tier's building if the owner has none (playtest 2026-10-10: the army spent catalyst as fast as it came, so the catalyst rule alone never built a factory and the float never reached a synthesizer); a barracks or factory when catalyst >= reserve + 400 (the one minimizing (count + 1) / weight sum of its roster kinds, ties to barracks, zero-weight buildings skipped), else a synthesizer at tier 2 with material >= 1500 and fewer than 4; sites on rings of 260/320/380/440 around the HQ (else lowest-id hub), 24 bearings each, never within 220 of a resource node. All numbers are experimental.

Per player: a target army composition by percentage per unit kind, plus rules such as "buy the next tier when affordable" and "add a production building when catalyst stays above N for M seconds". Idle production buildings train toward the composition while catalyst allows. Replaces nothing a player does by hand; manual queues win.

## Layer 4: economy doctrine (later increment)

Per player: saturate workers, expand when bases are ~90% saturated or their patches are running out, keep refineries on every owned deposit, connect bases with territory links, rebuild lost links. Absorbs today's client-side operations (Expand, Territory, Saturate) into server rules.

## UI

All of it lives in the Strategy panel: mission list with a tactic picker and knobs; a Stances section listing your unit kinds with a stance picker; later Production and Economy sections. Labels say what a unit is doing and why ("Gather 5/8", "kiting").
