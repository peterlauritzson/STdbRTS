# Experiment C: Private State and Caller-Filtered Views

Protocol for Increment C of [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).
Written 2026-09-22, before the experiment runs. **No results are recorded here
yet.** Whoever runs it appends a Results section and a decision entry in
[DECISIONS.md](DECISIONS.md).

## Why this runs before anything else in M1

Every information-dependent mechanic in the design depends on the answer: fog,
Industrial smoke, scouting, last-seen observations, fog-safe events, and
information-limited bot vision. [ROADMAP.md](ROADMAP.md) lists cosmetic fog as a
release blocker. Building any of those on top of public tables would produce a
game that looks like it has fog and does not.

## The question

Can the installed SpacetimeDB stack express **private canonical tables plus
caller-filtered, indexed views**, such that a client can read exactly the rows
it is authorised to see and nothing else?

Not "can the official client be made to show less." The test subject is a
hostile client that has the generated bindings, a valid identity, and full
freedom to issue whatever queries and subscriptions it likes.

## Current state being replaced

`server/src/schema.rs` marks `room`, `player`, `unit`, `resource_node` and
`command` as `public`. Match-scoped subscriptions reduce traffic; they are not
access control. A custom client can read every match in the database, including
matches it never joined, along with every unit position, every command, every
rejection reason and every player's balance.

## Setup

- A **separate development database**, never the playtest or production one.
  This experiment changes table visibility, which is a breaking schema change.
- A real SpacetimeDB server. Native module tests cannot stand in for this: the
  behaviour under test is the database host's access enforcement, not module
  logic.
- Record the installed versions before starting — module SDK, CLI, and client
  library — in the Results section. The architecture doc flags that the Rust SDK
  in this workspace is older than the CLI/client, and that gap may itself be the
  finding.

## Participants

Three identities against one match:

1. **Player A** — in the match, slot 0.
2. **Player B** — in the match, slot 1, opponent.
3. **Observer X** — authenticated, *not* in the match. The adversary.

## Attack surface to test

A pass requires zero unauthorised fields across **all** of these. Each is a
separate test; a leak in any one is a failure of the whole experiment.

| # | Surface | What a leak looks like |
| --- | --- | --- |
| 1 | Direct table query | X reads `unit` rows for a match it never joined |
| 2 | Arbitrary subscription | X subscribes with a predicate the client UI would never issue and receives rows |
| 3 | Join across tables | X reaches private rows through a public table's relationship |
| 4 | Initial snapshot | the first payload on subscribe contains rows later updates correctly withhold |
| 5 | Incremental update | a row's later delta reveals a field its insert withheld |
| 6 | Deletion events | X learns a hidden unit existed by observing its deletion |
| 7 | Error text | a rejection reason names an entity, position or balance the caller cannot see |
| 8 | Reconnect | the restore path re-sends more than the live path would |
| 9 | Opponent-scoped | B, legitimately in the match, reads A's command queue, policies, exact positions of unseen units, cooldowns, or bank balance |

Surface 9 matters as much as 1-8. An opponent is the realistic adversary; a
stranger is merely the easiest one to test.

## Decision rule, fixed in advance

- **Pass** — all nine surfaces clean, on a real server, with a generated client,
  reproducibly. Not "99% of the time": visibility tests are deterministic and
  must pass every run. Record the mechanism, its index requirements, and its
  per-tick cost, then proceed to fog and smoke.
- **Insufficient SDK** — the approach is expressible in principle but not by the
  installed versions. Response: one deliberate SDK upgrade attempt in an
  isolated database, then rerun the full lifecycle tests. Record what broke.
- **Not expressible** — record it plainly as a blocker on the whole information
  design and stop. Do **not** fall back to publishing every projection and
  filtering client-side, and do not implement cosmetic fog in the meantime.

Under either failure outcome, publishing secret state is not an acceptable
interim. The skirmish can continue shipping with no fog and a documented
warning, which is what the README already does.

## Cost measurement

Whatever passes, measure before adopting it: per-tick cost of deriving each
player's permitted observations, row-change volume, and initial snapshot size,
separately from core simulation time. The architecture doc's tick budget is p95
≤25ms and p99 <50ms at 20 TPS **including** adapter persistence. A visibility
mechanism that passes the security test and blows the tick budget has not
passed.

## Results

Not yet run.
