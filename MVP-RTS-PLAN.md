# Multiplayer RTS + SpacetimeDB MVP Plan

## Short answer: does this make sense?
Yes — this is a strong fit for SpacetimeDB. An RTS needs:
- authoritative game state,
- low-latency multiplayer sync,
- server-side simulation rules,
- publish/subscribe updates to many clients.

SpacetimeDB is built for this model (state + reducers + subscriptions), so a web RTS MVP is a sensible choice.

Canonical docs to use as source of truth:
- https://spacetimedb.com/docs
- https://spacetimedb.com/docs/quickstarts
- https://spacetimedb.com/install

---

## MVP Goal (4–6 weeks)
Deliver a playable browser RTS vertical slice where:
- 2–4 players join a match lobby,
- each controls units on a small map,
- units can move, attack, and die,
- one basic resource is gathered,
- one unit-production building exists,
- match ends on base destruction.

Keep it intentionally narrow: **one faction, one map, minimal art, no matchmaking service beyond simple room/lobby flow**.

---

## Suggested Tech Stack
- **Frontend:** TypeScript + Vite + lightweight renderer (Canvas 2D or PixiJS).
- **Networking/state backend:** SpacetimeDB module with reducers + subscriptions.
- **Shared contracts:** Shared TS types/schema bindings generated from SpacetimeDB client tooling.
- **Hosting (MVP):** static web host for client + one SpacetimeDB deployment.

If exact SDK/API details differ, verify against:
- https://spacetimedb.com/docs
- https://spacetimedb.com/docs/quickstarts

---

## Core Architecture (MVP)
1. **Authoritative server simulation**
   - All game actions are commands to server reducers (`Move`, `Attack`, `TrainUnit`, etc.).
   - Server validates command legality and updates canonical state.

2. **Tick model**
   - Fixed simulation tick on server (example: 10–20 ticks/sec).
   - Client renders interpolated state between snapshots.

3. **Delayed command activation (no immediate simulation prediction)**
   - Every player command is scheduled for execution at `server_now + X` seconds.
   - Before execution, clients show a countdown + visual command marker/ghost path.
   - Command effects begin only when server executes at the scheduled tick.
   - This removes most client/server reconciliation complexity and handles lag spikes more gracefully.

4. **Data partitions / subscriptions**
   - Lobby state channel.
   - Per-match subscription scoped to match ID.
   - Optional fog-of-war later; skip for first MVP.

5. **Deterministic boundary**
   - Server remains authoritative for all gameplay outcomes (movement resolution, combat, resources, win/loss).
   - Client-side deterministic logic is allowed for UX only (preview/path visualization/countdowns), never for final state authority.

### Command Delay Constraint (explicit)
- `X` is a global match parameter (start with `X = 1.0s` for MVP, then tune to `0.5–1.5s` in playtests).
- On command issue, client immediately sends command to server and shows `pending` state.
- Server replies with scheduled execution tick/time; all clients display the same countdown target.
- If command is rejected, pending indicator changes to invalid/cancelled and no effect executes.
- Optional quality-of-life: allow player-side cancel/reissue before execution time (MVP optional).

---

## MVP Feature Scope (strict)
### Must-have
- Account/session identity (guest ID is fine).
- Lobby: create room, join room, ready state, start match.
- Match state: players, units, buildings, resources, map seed.
- Commands: move, attack, stop, gather, return cargo, train unit.
- Basic combat/damage/death.
- Win condition: destroy enemy HQ.
- Reconnect handling (same player returns to match).

### Nice-to-have (only after playable)
- Minimap.
- Multiple control groups.
- Replay logs.
- Basic anti-cheat telemetry.

### Explicitly out-of-scope for MVP
- Full tech tree.
- Multiple factions.
- Sophisticated pathfinding (start with grid + simple A*/flow field).
- Ranked matchmaking.

---

## Data Model Sketch (SpacetimeDB)
Use normalized server-side entities:
- `Match` (id, state, tick, map, started_at)
- `Player` (id, match_id, name, team, resources)
- `Unit` (id, owner_id, match_id, type, hp, pos, target)
- `Building` (id, owner_id, match_id, type, hp, pos, queue)
- `Command` (id, tick_issued, execute_tick, player_id, payload, status)
- `Projectile` (optional for MVP visuals)

Reducer examples:
- `create_lobby`, `join_lobby`, `set_ready`, `start_match`
- `issue_move`, `issue_attack`, `issue_gather`, `train_unit`
- `server_tick` (applies queued commands + sim step)

Command lifecycle:
- `queued` -> `scheduled` -> `executed` (or `rejected` / `cancelled`)
- Server applies command only when `current_tick >= execute_tick`

Verify exact reducer/table definitions and best practices in canonical docs:
- https://spacetimedb.com/docs

---

## Milestone Plan
## M0 — Setup (1–2 days)
- Install and run local SpacetimeDB + hello-world module.
- Create web client skeleton with TS + render loop.
- Wire client connection and basic subscription.

Done when:
- Client receives and displays server state heartbeat.

## M1 — Lobby + Match bootstrap (3–4 days)
- Room create/join/ready/start.
- Spawn players + HQ + initial worker units.
- Transition from lobby UI to match view.

Done when:
- Two browser clients can start same match.

## M2 — Movement + selection (4–6 days)
- Click/drag select units.
- Right-click move command.
- Command pending UX (countdown ring/line + queued markers).
- Server-side movement simulation + collision-lite.

Done when:
- Multiple units move consistently for all players with synchronized delayed command start.

## M3 — Combat + resources (5–7 days)
- Attack command, target resolution, hp/death.
- Worker gather loop (mine -> return -> credit resource).
- Train unit from HQ/barracks equivalent.

Done when:
- Players can produce units and destroy each other.

## M4 — MVP hardening (3–5 days)
- Reconnect + state resync.
- Basic desync instrumentation (tick drift, command latency).
- Balance pass and bug triage.

Done when:
- 15–20 minute match is stable with 2–4 players.

---

## Testing Strategy
- **Reducer unit tests:** command validation, damage/resource math.
- **Determinism checks:** same command stream => same final state.
- **Command timing checks:** same `execute_tick` observed by all clients for each command ID.
- **Soak test:** simulated bots issuing commands for 20+ minutes.
- **Manual latency test:** add artificial delay/jitter and verify playability.

---

## Risks and Mitigations
- **Pathfinding complexity** -> start with very simple movement + obstacle constraints.
- **Server tick overload** -> cap units in MVP and optimize hotspots before adding features.
- **Input feels delayed** -> make countdown/queued markers very clear; tune `X` via playtests.
- **Scope creep** -> freeze MVP list until first playable build is stable.

---

## Client-side Deterministic Logic (recommended)
Use client determinism to reduce CPU and improve responsiveness, but keep it non-authoritative.

Safe for client-side (MVP):
- Path preview generation for selected units.
- Formation preview and queued waypoint rendering.
- Local UI countdown timers for scheduled commands.
- Camera culling, interpolation, and render-only smoothing.

Keep authoritative on server:
- Final path acceptance and movement collision outcomes.
- Attack range/line-of-sight validity.
- Damage, resource transfer, production timing, victory conditions.

Practical recommendation for MVP:
- Let client compute a proposed path and send it as a hint.
- Server either accepts if valid/cheap, or recomputes canonical path.
- Treat all client-provided paths as untrusted input.

---

## First 7-Day Execution Checklist
Day 1–2:
- SpacetimeDB local environment working.
- Client connects and renders subscribed state.

Day 3–4:
- Lobby flow complete.
- Match creation + spawn logic complete.

Day 5–7:
- Unit selection + move command + server simulation online.
- Two-player sync verified end-to-end.

---

## Definition of MVP Complete
MVP is done when all are true:
- A player can open the web client, join a room, and start a match.
- Core loop works: gather resources -> train units -> attack -> destroy HQ.
- Match stays synchronized for 2–4 concurrent players.
- Commands execute at synchronized scheduled times with visible pending indicators.
- Reconnect restores correct state.

---

## Immediate Next Steps
1. Implement M0 and M1 only.
2. Lock feature scope for two weeks.
3. Schedule one internal playtest as soon as M2 lands.
4. Keep all API/SDK specifics aligned with canonical docs:
   - https://spacetimedb.com/docs
   - https://spacetimedb.com/docs/quickstarts
   - https://spacetimedb.com/install
