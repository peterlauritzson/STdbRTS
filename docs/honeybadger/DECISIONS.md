# Decision Record

Settled choices, with the reason and the evidence behind each. A decision here
is binding on implementation until superseded by a later dated entry. Open
questions stay in [ROADMAP.md](ROADMAP.md) and the design docs until they are
decided; do not resolve one by writing code and calling it settled.

Format: date, decision, why, what would overturn it.

---

## 2026-09-22 — Command delay is a bounded ruleset field, default unchanged

**Decision.** The command delay is a value frozen into the match at creation
from the ruleset, bounded by `COMMAND_DELAY_MIN` and `COMMAND_DELAY_MAX`, with
`DEFAULT_COMMAND_DELAY` staying at 20 ticks (1.0s at 20 TPS). Values outside
the bounds are rejected at room creation, never clamped. No client may change
the delay for a running match, and no per-player delay exists.

**Why.** [COMMANDS-AND-BEHAVIORS.md](COMMANDS-AND-BEHAVIORS.md) requires the
delay to be a ruleset field fixed at match creation, and names 0.5s / 1s / 1.5s
as trial points — so the bounds must span 10 to 30 ticks. Keeping the default
at 20 preserves the existing playable skirmish, which is a standing constraint.
Rejecting rather than clamping keeps a misconfigured match from silently playing
under rules nobody chose.

**Would overturn it.** Human A/B trials showing a different trial point is
clearly better, which would move the default but not the mechanism. Evidence
that delay must vary within a match would overturn the mechanism itself, and
the commands doc currently forbids that.

---

## 2026-09-22 — Match identity is frozen at creation, not resolved at read time

**Decision.** Each match records its ruleset version, map id, map version, and
map content hash at creation, and those values never change for that match.

**Why.** [ARCHITECTURE-AND-UX.md](ARCHITECTURE-AND-UX.md) requires match
metadata to carry ruleset version/hash and map id/version/hash, and requires
server and client to agree on the exact map hash.
[MAP-AUTHORING.md](MAP-AUTHORING.md) records that map identity is not yet stored
or hash-checked, and warns against deploying changed geometry until it is. A
match that resolves its map by name at read time would silently change rules
underneath running games when an authored map is edited.

**Would overturn it.** Nothing foreseeable; this is a correctness requirement,
not a preference. The *representation* of the hash may change.

---

## 2026-09-22 — Fog is not attempted before the private-state experiment answers

**Decision.** No fog, smoke, hidden scouting, or information-limited bot vision
is implemented until Increment C in
[IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) produces a written result. If
the installed stack cannot enforce per-viewer access, the response is an
isolated SDK upgrade attempt, not client-side filtering.

**Why.** Current unit, resource and command tables are `public`
([schema.rs](../../server/src/schema.rs)), so a custom client reads every match
in the database. [ROADMAP.md](ROADMAP.md) lists cosmetic fog as a release
blocker, and [ARCHITECTURE-AND-UX.md](ARCHITECTURE-AND-UX.md) states plainly
that match-scoped subscriptions reduce traffic but cannot enforce fog. The
README already documents this gap for anyone hosting publicly.

**Would overturn it.** A verified server-side mechanism that passes the
adversarial-client tests. Convenience does not.
