# STdbRTS Quick-and-Dirty MVP Prototype

This is a fast playable prototype focused on validating game feel first.

## What is implemented
- Unit selection (click/drag)
- Delayed command issue (0.6s)
- Move / attack / gather loops
- Soldier auto-engage when enemies are nearby
- Soldier attacks fire visible bullets (projectiles) that deal damage on hit
- Resource income + training workers/soldiers
- Enemy AI pressure
- Win/loss on HQ destruction
- Fixed-step simulation tick (20 TPS) for more deterministic updates

## Run locally (PowerShell)
From the repo root:

```powershell
python -m http.server 8080
```

Open:

```text
http://localhost:8080
```

## Start using SpacetimeDB (browser bindings)
This client now supports an authoritative SpacetimeDB mode when generated bindings are present.

1. Install and start SpacetimeDB locally:

```powershell
iwr https://windows.spacetimedb.com -useb | iex
spacetime start
```

Canonical install/docs links:
- https://spacetimedb.com/install
- https://spacetimedb.com/docs

2. Generate a browser module + bindings (reference flow):

```powershell
spacetime dev --template browser-ts
```

Then build the generated bindings bundle:

```powershell
npm install
npm run build
```

Reference quickstart used:
- https://spacetimedb.com/docs/quickstarts/browser

3. Copy the generated `dist/bindings.iife.js` into this project and load it before `src/main.js` in `index.html`.

4. In-game HUD:
- Set `SpacetimeDB Host` (default `ws://localhost:3000`)
- Set `Database Name` (your published module/database)
- Click `Connect SpacetimeDB`

If RTS tables/reducers are available, commands are sent as reducers (`issue_move`, `issue_attack`, `issue_gather`, `train_unit`) and local simulation pauses.

If your module uses different table or reducer names, update `src/main.js` mappings accordingly (verify against canonical docs before finalizing):
- https://spacetimedb.com/docs/clients
- https://spacetimedb.com/docs/clients/subscriptions

## Controls
- Left click: select one unit
- Left drag: box select units
- Right click on ground: move selected units
- Right click on enemy: attack
- Right click on resource node: workers gather
- Buttons: train units from HQ

## Notes
- This is intentionally not optimized (no advanced pathfinding, no spatial partitioning).
- Networking/authority is not wired yet; this is a gameplay sandbox to validate the loop quickly.

For SpacetimeDB implementation details, use canonical docs:
- https://spacetimedb.com/docs
- https://spacetimedb.com/docs/quickstarts
- https://spacetimedb.com/install