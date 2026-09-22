# Deploying for Friends

Two independent pieces have to be hosted:

| Piece | What it is | Where it goes |
| --- | --- | --- |
| The module | `server/`, Rust compiled to wasm | A SpacetimeDB host (Maincloud) |
| The client | `npm run build` output in `dist/` | Any static host (PythonAnywhere) |

The browser loads the client from the static host, then opens a WebSocket
straight to the SpacetimeDB host. The static host never sees game traffic.

PythonAnywhere cannot host the module. It runs a WSGI application, offers no
arbitrary listening ports, and does not support WebSockets. It is a fine home
for `dist/` and nothing else.

## 1. Publish the module to Maincloud

```powershell
spacetime login
spacetime publish --server maincloud --module-path server --delete-data=never stdbrts-playtest
```

Pick a name nobody else is likely to have taken; the name is how clients
address the database. Confirm it came up:

```powershell
spacetime logs --server maincloud stdbrts-playtest
spacetime sql --server maincloud stdbrts-playtest "SELECT * FROM room"
```

`--delete-data=never` is deliberate. A schema-breaking change is refused rather
than silently wiping the database; publish under a new name if you need one.

## 2. Point the client at it

[`.env.production`](../.env.production) is read by `npm run build` only, so
local development is unaffected. Set the database name to whatever you
published:

```
VITE_STDB_HOST=wss://maincloud.spacetimedb.com
VITE_STDB_DATABASE=stdbrts-playtest
```

`wss://`, not `ws://`. The deployed page is served over HTTPS and browsers
refuse a plaintext WebSocket from a secure page. The same rule rules out
self-hosting SpacetimeDB on a bare-IP VPS without a TLS certificate.

## 3. Build

```powershell
npm ci
npm run build
```

Confirm the host was baked in, rather than discovering it in the browser:

```powershell
Select-String -Path dist/assets/*.js -Pattern "maincloud" | Select-Object -First 1
```

## 4. Serve `dist/` from PythonAnywhere

Upload the contents of `dist/` to `/home/<user>/stdbrts/dist`. Either push the
repo and build elsewhere, or zip `dist/` and upload it through the Files tab —
PythonAnywhere has no Node toolchain worth fighting, so build locally.

On the **Web** tab:

1. Add a new web app, **Manual configuration**, any Python 3 version. Do not
   pick the Flask wizard; the app below is pure standard library.
2. Open the **WSGI configuration file** link and replace its entire contents
   with [`deploy/pythonanywhere/wsgi.py`](../deploy/pythonanywhere/wsgi.py),
   editing `DIST` to your real home directory.
3. Under **Static files**, map URL `/assets/` to
   `/home/<user>/stdbrts/dist/assets`. This is optional but serves the 150 kB
   bundle and the fonts straight from the web server instead of through Python.
4. **Reload** the web app.

The WSGI app falls back to `index.html` for unknown paths, so reloads and deep
links work. It sends immutable cache headers for the fingerprinted files under
`/assets/` and `no-store` for `index.html`, so a redeploy is picked up
immediately instead of stranding friends on a stale bundle.

Send friends `https://<user>.pythonanywhere.com`.

## 5. Smoke test before inviting anyone

Open the URL in two different browser profiles — tabs in one profile share a
saved identity. Create a room in one, join from the other, both Ready, Deploy.
Check that the status indicator reads `Connected` and that units respond.

## Redeploying

A client-only change needs `npm run build` and a re-upload plus **Reload**.
A gameplay change needs `spacetime publish` as in step 1, and `npm run generate`
first if reducers or tables changed shape.

## Cost and tick behaviour

The simulation runs on a scheduled reducer, and Maincloud bills energy per
reducer call. The schedule is therefore armed on demand by
`game::sync_tick_schedule`:

| Database state | Tick rate |
| --- | --- |
| No rooms | Not scheduled at all |
| Rooms exist, none playing | Every 5s, for the idle-room expiry sweep |
| Any room playing | Every 50ms (20 TPS) |

An idle database costs nothing. Note that a match whose players have all
disconnected keeps simulating at 20 TPS until the room expires 30 minutes
later; that is the documented "matches continue while players are offline"
behaviour, and it is the one case where energy is spent with nobody watching.

## What this does not protect against

**Anyone who can reach the database can read every table in it.** All gameplay
tables are `public`, which in SpacetimeDB means readable by any connected
client. SpacetimeDB's row-level security (`#[client_visibility_filter]`) is
still unimplemented and unenforced as of 2.10.1 — the attribute compiles and
does nothing — so this cannot currently be fixed server-side.

In practice:

- The shipped client only subscribes to its own match, so ordinary players see
  nothing extra.
- Somebody who knows the database name and writes their own client could
  subscribe to every match in progress and watch it, and could join any room
  that is in the lobby state.
- Within a match this changes nothing: the game has no fog of war by design,
  so opponents already see each other's units.

For a private game among friends this is acceptable, and the database name is
the only thing keeping strangers out. Do not treat it as a secret with any
strength. If the game is ever opened up more widely, the mitigation that works
today is an application-level join code checked inside the `join_room` reducer,
which stops strangers joining but still cannot stop them reading.
