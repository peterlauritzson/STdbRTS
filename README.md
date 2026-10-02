# Spacetime RTS

A server-authoritative browser skirmish RTS. Play against the built-in practice
opponent or 2-4 human players as one of three factions: mine material, extract
catalyst, expand across a large map, field armies whose units each carry a
passive ability, and destroy every opposing hub.

**Player guide** (also opened from the Guide link in the game): [The game at a glance](docs/guide/1-overview.md), [How it plays, and why](docs/guide/2-how-it-plays.md) and the [Encyclopedia](docs/guide/3-encyclopedia.md) of every unit, building and number.

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
Click **Practice vs AI** for a self-contained match. Workers start mining after
the normal command delay. The AI uses a separate guest identity and ordinary
reducers, constructs a base, researches upgrades, and fields mixed armies.
Reloading reconnects both identities. Keep the tab open for AI decisions;
closing it pauses the browser AI, but does not pause the server simulation.

For multiplayer, create a room, join from the other profile, mark everyone Ready,
then the host can Deploy. Up to four players can join before deployment.

For an independent headless opponent, leave both servers running and start:

```powershell
npm run bot
```

Join **Practice / Automaton** and mark Ready. The bot starts when both players
are ready. It gathers, builds its economy, trains soldiers, repairs a badly
damaged HQ, and uses attack-move assaults through
the same delayed reducers as human players. It has no resource or authority
advantages. Stop with Ctrl+C to surrender. Alternatively, join an existing room
with `npm run bot -- --room=123`. `--duration=30` limits a run to 30 seconds.

## Controls

- Left click selects; drag selects owned mobile units; Shift adds to selection.
- Right click ground to move, an enemy to attack, a material patch to gather, or your HQ to
  return cargo. Mixed selections apply attack only to soldiers and gather only
  to workers. Shift queues an order after its activation delay.
- Touch uses the Select / Order / Pan segmented controls. Drag selects in
  Select mode; tap a destination in Order mode; drag the map in Pan mode.
- Scroll wheel or zoom buttons zoom. Middle drag, Space+drag, arrow keys, or
  Pan mode move the camera. The minimap recenters the camera.
- Backspace centers on HQ; S stops selected mobile units; H holds army units. Train
  hotkeys are Q W E R D Z X (labour, then your six army units); B opens the build card.
- Period or the hard-hat button selects an idle worker. Double-click selects
  owned units of the same type. The army button selects soldiers, scouts, and siege.
- A (or the crosshair command button) arms attack-move, then click a destination.
  Army units engage enemies within 180 world units (260 for siege) and resume their route afterward.
  Hold position fires within weapon range without chasing or collision displacement.
- R (or the wrench button) arms repair, then click a damaged friendly unit or HQ.
  Only selected workers receive the order. Right-clicking a damaged friendly mobile
  unit also repairs it; right-clicking HQ still returns cargo.
- Escape cancels targeting first, otherwise clears selection. Touch can arm the
  same command buttons and tap a target, regardless of the pointer mode.
- Ctrl+1 through Ctrl+5 assigns control groups; 1 through 5 recalls them.
- The Production tab follows the selected HQ, barracks, or factory. The building
  selector changes the active producer. Production is serial within each building.
- Build tab: choose a structure, then place its valid preview on the battlefield.
  A selected worker, or the closest available worker, receives the order.
  Right-click an unfinished friendly building with workers to resume or assist.
  Stop pauses construction. Select a site and use the trash button to cancel it
  for a 75% refund; destroyed sites yield no refund.
- Research tab queues faction-wide upgrades in a completed laboratory.
- Economy: three currencies, one purpose each.
  Material (mined, one miner per patch) buys labour, structures and research.
  Catalyst buys the whole army and comes only from a refinery (U) built on a
  catalyst deposit, no workers needed. Terrazine, a share of the material you mine
  (12% Industrial, 10% otherwise), buys static defense: the shared turret and your
  faction's bunker (Industrial), bastion (Network) or spine (Organic). Labour cannot
  gather catalyst; right-clicking a deposit with it shows why.
- Army, six units per faction, each with one passive that fires on its own (hover a
  button for the line): Industrial soldier (Veteran), scout (Forced March), marksman
  (Entrenchment), medic (Field Medic), siege (Shrapnel), bulwark (Guardian). Network
  sentinel (Battle Blink), skimmer (Forced March), arcer (Ricochet), phantom (Phase
  Shift), lancer (Overwatch), warden (Shield Aura). Organic swarmer (Predator),
  spitter (Acid Splash), prowler (Forced March), devourer (Veteran), crusher
  (Regrowth), behemoth (Death Burst). Barracks trains the first four, the factory
  the last two. Details: [ROSTER-PASSIVES.md](docs/honeybadger/ROSTER-PASSIVES.md).
- Select a production building and right-click ground or a material patch to set its rally.
  The flag button also arms rally targeting. Clear it with the crossed-out flag.
  New workers move to ground rallies or gather at patch rallies; soldiers attack-move
  to either. Rally changes affect future births, not units already deployed.
- The production X button cancels all unfinished production and refunds its full
  cost. Completed units are never refunded. It does not cancel train commands
  that are still waiting for their activation tick.
- Every player-issued action, including stop, hold, repair, rally, and production
  cancellation, respects the one-second delay. Hold and production controls cannot
  be Shift-queued; queued orders behind hold wait until hold is replaced.
- Leaving a running match is surrender. Closing/reloading a tab is not.
- The speaker toggle controls battle/construction audio. Completed matches offer
  a direct return to the lobby, where another practice or multiplayer game can start.

## Roster and Base

Units, structures, passive abilities, costs and every other number are in the
[Encyclopedia](docs/guide/3-encyclopedia.md). It is kept current with the code
(`server/src/rules.rs`), so they are not repeated here.

## Rules and Authority

All gameplay runs in Rust on scheduled 20 TPS simulation ticks. The tick is
armed on demand: it is not scheduled at all while no rooms exist, drops to
every 5 seconds for the idle-room sweep while rooms sit in the lobby, and runs
at 20 TPS while any room is playing, so an idle deployment costs no energy.
Commands publish
one shared execution tick; the client displays pending markers and interpolates
received positions, never predicts gameplay. Scheduling under load may run
slower than wall time; the server tick remains authoritative.

Economy, production limits, repair and combat rules are described in the
[player guide](docs/guide/2-how-it-plays.md); numbers are in the
[Encyclopedia](docs/guide/3-encyclopedia.md). Resources are charged when the
delayed train command executes, not when it is sent.
Terrain blocks movement and firing lines. The authoritative 40-unit navigation
grid routes with shared, cached route fields (one search per goal), with direct
movement on clear routes.
Buildings block movement, and production waits if no clear exit exists.
Combat is simultaneous hitscan damage with visual tracers. A destroyed HQ
eliminates its owner's remaining units. The last HQ wins; simultaneous final HQ
destruction is a draw.

Reconnect restores the same membership and entities using a locally stored
guest token. Multiple tabs are tracked independently. Matches continue while
players are offline. Rooms with no online members expire after 30 minutes;
rooms with no members are removed immediately.

## Development

The expanded game uses `stdbrts-playtest`, stored under ignored `.spacetime-dev/`.
Construction and research add entity fields; the earlier `stdbrts-v2-dev` and
prototype databases are preserved, not migrated or reset. Publishing uses
`--delete-data=never`. Schema-breaking future changes require an intentional migration or a
new database name, not an automatic destructive reset.

- `server/src/rules.rs`, `simulation.rs`: pure gameplay, compiled by
  `server/core/Cargo.toml` for native tests.
- `server/src/navigation.rs`, `shared/maps/skirmish.json`: authoritative navigation and
  shared visible terrain. `src/catalog.ts` supplies UI balance metadata/previews.
- `server/src/schema.rs`: normalized match-scoped tables.
- `server/src/lobby.rs`: identity, membership, ready/start/leave reducers.
- `server/src/game.rs`: command validation, scheduled ticks, persistence adapter.
- `src/network.ts`: connection, identity persistence, subscriptions, errors.
- `src/battlefield.ts`: rendering, camera, selection, command input.
- `src/main.ts`: lobby and HUD. `src/bindings/` is generated, never hand-edited.
- `src/practice.ts`, `scripts/bot-policy.ts`: browser practice lifecycle and shared AI.
- `src/feedback.ts`: optional audio and base/construction notifications.
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

This is a playable three-faction, one-map build for playtesting, not a
production-ready online service. No fog of war, teams, ranked matchmaking, replay
storage, or campaign. Unit-to-unit separation is lightweight;
large-army congestion and dynamic blocked routes need playtesting. Tables are public;
match-scoped subscriptions reduce traffic but do not hide enemy data. A custom
client can read every match in the database, including matches it has not
joined. SpacetimeDB row-level security is unimplemented and unenforced as of
2.10.1, so this cannot be fixed server-side today; see
[docs/DEPLOY.md](docs/DEPLOY.md) for what that means when hosting publicly.

Per-player command, queue, unit, and global room caps exist; account-level abuse
protection and production operations are not complete. The bot uses a fixed build
priority, not adaptive strategic planning; the headless bot does not reconnect
after a server restart. Browser practice does reconnect. Automated simulated soak
coverage does not replace 15-20 minute multiplayer sessions with real latency,
packet loss, load, and balance testing. `wasm-opt` is optional and was not
installed during verification.

See [docs/PLAYTEST.md](docs/PLAYTEST.md) for a focused playtest checklist.

## Deploy

See [docs/DEPLOY.md](docs/DEPLOY.md): publish the module to SpacetimeDB
Maincloud, then serve the built `dist/` from any static host. PythonAnywhere
config lives in [deploy/pythonanywhere/wsgi.py](deploy/pythonanywhere/wsgi.py).

## Canonical SpacetimeDB References

- Installation: https://spacetimedb.com/install
- Rust quickstart: https://spacetimedb.com/docs/quickstarts/rust
- Reducers: https://spacetimedb.com/docs/functions/reducers
- Scheduled tables: https://spacetimedb.com/docs/tables/schedule-tables
- Subscriptions: https://spacetimedb.com/docs/clients/subscriptions
- TypeScript SDK: https://spacetimedb.com/docs/clients/typescript