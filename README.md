# Spacetime RTS

A server-authoritative browser RTS vertical slice. Create a room, ready up with
2-4 players, gather ore, train soldiers, and destroy every opposing HQ.

The current implementation replaces the original ad hoc prototype. The original
ideas remain in [MVP-RTS-PLAN.md](MVP-RTS-PLAN.md); implementation decisions and
verification are tracked in [docs/ENGINEERING.md](docs/ENGINEERING.md).

## Play Locally

Prerequisites: Node.js 22.12+, Rust with the `wasm32-unknown-unknown` target, and
SpacetimeDB CLI 2.1.0. The client is TypeScript + Vite + Canvas 2D, not React.

```powershell
npm ci
rustup target add wasm32-unknown-unknown
npm run server:start
```

Keep the server running. In another terminal:

```powershell
npm run server:publish
npm run generate
npm run dev -- --host 127.0.0.1 --port 5173
```

Open http://127.0.0.1:5173. Use separate browser profiles or an incognito window
for independent players. Tabs in the same profile share the saved identity.
Create a room, join from the other profile, mark everyone Ready, then the host
can Deploy. Up to four players can join before deployment.

For a practice opponent, leave both servers running and start:

```powershell
npm run bot
```

Join **Practice / Automaton** and mark Ready. The bot starts when both players
are ready. It gathers, builds its economy, trains soldiers, and attacks using
the same delayed reducers as human players. It has no resource or authority
advantages. Stop with Ctrl+C to surrender. Alternatively, join an existing room
with `npm run bot -- --room=123`. `--duration=30` limits a run to 30 seconds.

## Controls

- Left click selects; drag selects owned mobile units; Shift adds to selection.
- Right click ground to move, an enemy to attack, ore to gather, or your HQ to
  return cargo. Mixed selections apply attack only to soldiers and gather only
  to workers. Shift queues an order after its activation delay.
- Touch uses the Select / Order / Pan segmented controls. Drag selects in
  Select mode; tap a destination in Order mode; drag the map in Pan mode.
- Scroll wheel or zoom buttons zoom. Middle drag, Space+drag, arrow keys, or
  Pan mode move the camera. The minimap recenters the camera.
- H centers on HQ; S stops selected mobile units; Escape clears selection.
- Ctrl+1 through Ctrl+5 assigns control groups; 1 through 5 recalls them.
- HQ production buttons train workers (50 ore, 3 seconds) and soldiers
  (100 ore, 5 seconds), after the command's one-second activation delay.
- Stop and return-cargo commands also respect the one-second delay.
- Leaving a running match is surrender. Closing/reloading a tab is not.

## Rules and Authority

All gameplay runs in Rust on scheduled 20 TPS simulation ticks. Commands publish
one shared execution tick; the client displays pending markers and interpolates
received positions, never predicts gameplay. Scheduling under load may run
slower than wall time; the server tick remains authoritative.

Workers carry 25 ore and must return to HQ to credit resources. Production is
serial, capped at eight queued units and 60 mobile units per player. Resources
are charged when the delayed train command executes, not when it is sent.
Soldiers pursue explicit attack targets and automatically shoot nearby enemies.
Combat is simultaneous hitscan damage with visual tracers. A destroyed HQ
eliminates its owner's remaining units. The last HQ wins; simultaneous final HQ
destruction is a draw.

Reconnect restores the same membership and entities using a locally stored
guest token. Multiple tabs are tracked independently. Matches continue while
players are offline. Rooms with no online members expire after 30 minutes;
rooms with no members are removed immediately.

## Development

The new database is `stdbrts-v2-dev`, stored under ignored `.spacetime-dev/`.
Publishing uses `--delete-data=never`: it does not reset the old prototype
database. Schema-breaking future changes require an intentional migration or a
new database name, not an automatic destructive reset.

- `server/src/rules.rs`, `simulation.rs`: pure gameplay, compiled by
  `server/core/Cargo.toml` for native tests.
- `server/src/schema.rs`: normalized match-scoped tables.
- `server/src/lobby.rs`: identity, membership, ready/start/leave reducers.
- `server/src/game.rs`: command validation, scheduled ticks, persistence adapter.
- `src/network.ts`: connection, identity persistence, subscriptions, errors.
- `src/battlefield.ts`: rendering, camera, selection, command input.
- `src/main.ts`: lobby and HUD. `src/bindings/` is generated, never hand-edited.
- `tests/`: pure presentation, real-server integration, and Playwright tests.

Older `src/main_old.js`, `tick_bot.cjs`, and `server/src/bindings/` are retained
as legacy artifacts and are not part of the active application. Do not run the
old tick bot; only the server scheduler may advance the simulation.

Set `VITE_STDB_HOST` and `VITE_STDB_DATABASE` in `.env.local` or use the
Connection settings in the UI. For scripts/tests, use `STDB_HOST` and
`STDB_DATABASE`. The browser test client URL can be overridden with `CLIENT_URL`.
Changing server/database uses a separate identity token. Do not share tokens.

## Verification

```powershell
npm test
npm run typecheck
npm run build
cargo check --manifest-path server/Cargo.toml --target wasm32-unknown-unknown
```

With the published backend and Vite running:

```powershell
npm run test:integration
npx playwright install chromium
npm run test:browser
```

Native tests use the separate core crate because a SpacetimeDB module depends
on database host imports that cannot link into a native test executable.
Browser screenshots and failure traces are written under `test-results/`.
Tests create their own identities/rooms and do not reset the database.

## Current Limits

This is a tested playable vertical slice, not a production-ready online service.
The map is open terrain with collision-lite separation; buildings are not solid
pathfinding obstacles. No fog of war, teams, ranked matchmaking, replay storage,
terrain obstacles, or buildable secondary structures. Tables are public;
match-scoped subscriptions reduce traffic but do not hide enemy data.

Per-player command, queue, unit, and global room caps exist; account-level abuse
protection and production operations are not complete. The bot is deliberately
simple and does not reconnect after a server restart. Automated simulated soak
coverage does not replace 15-20 minute multiplayer sessions with real latency,
packet loss, load, and balance testing. `wasm-opt` is optional and was not
installed during verification.

## Canonical SpacetimeDB References

- Installation: https://spacetimedb.com/install
- Rust quickstart: https://spacetimedb.com/docs/quickstarts/rust
- Reducers: https://spacetimedb.com/docs/functions/reducers
- Scheduled tables: https://spacetimedb.com/docs/tables/schedule-tables
- Subscriptions: https://spacetimedb.com/docs/clients/subscriptions
- TypeScript SDK: https://spacetimedb.com/docs/clients/typescript