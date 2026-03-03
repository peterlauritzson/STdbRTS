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

## Development Pre-Requisites
- **SpacetimeDB**: follow instructions at [spacetimedb.com](https://spacetimedb.com/install)
- **Rust**: install via [rustup.rs](https://rustup.rs/) (for server build)
- **Node/NPM**: LTS version recommended

## Project Structure
- `server/`: Rust source code for the SpacetimeDB module.
- `src/`: TypeScript source code for the browser client.
- `src/bindings/`: Generated code connecting client to server (do not edit manually).

## Development Workflow

This project uses SpacetimeDB for the backend simulation and Vite/React/TypeScript for the frontend.

### 1. Start SpacetimeDB
First, ensure you have SpacetimeDB installed and running.
```powershell
spacetime start
```
Keep this terminal open.

### 2. Publish Server & Reset Data
When you change Rust code (`server/src/lib.rs`), or just want to reset the game state, rebuild and publish the server module.
The `--delete-data` flag ensures a clean slate, removing old entities.

```powershell
cd server
spacetime publish --server local -y --delete-data server
```

### 3. Generate Client Bindings
If you modified the schema (tables/reducers in Rust), you must regenerate the TypeScript bindings so the client knows about the changes.

```powershell
npm run generate
```
*Note: This runs `spacetime generate` targeting the `src/bindings` folder.*

### 4. Run the Client
Start the Vite development server.

```powershell
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### 5. Verification
To verify everything is working:
1. Open the browser console (F12).
2. Look for "Connected with identity: ..." and "Status: Subscribed & Ready".
3. If you see "RangeError" or serialization issues, it usually means your **bindings are out of sync** with the server. Repeat steps 2 and 3.

## Controls
- Left click: select one unit
- Left drag: box select units
- Right click on ground: move selected units (Shift-click to queue waypoints)
- Right click on enemy: attack
- Right click on resource node: workers gather
- Buttons: update config or reset game

## Notes
- This is a prototype MVP.
- Networking/authority is handled by SpacetimeDB.

For SpacetimeDB implementation details, use canonical docs:
- https://spacetimedb.com/docs
- https://spacetimedb.com/docs/quickstarts
- https://spacetimedb.com/install