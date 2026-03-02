// @ts-nocheck
// @ts-nocheck
import { Identity, Infer } from "spacetimedb";
import { DbConnection, tables, reducers } from "./bindings/index";
import ConfigRowSchema from "./bindings/config_table";
import PlayerRowSchema from "./bindings/player_table";
import UnitRowSchema from "./bindings/unit_table";
import WaypointRowSchema from "./bindings/waypoint_table";

type ConfigRow = Infer<typeof ConfigRowSchema>;
type PlayerRow = Infer<typeof PlayerRowSchema>;
type UnitRow = Infer<typeof UnitRowSchema>;
type WaypointRow = Infer<typeof WaypointRowSchema>;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const ui = {
  resources: document.getElementById("resources")!,
  selectedCount: document.getElementById("selected-count")!,
  hqHp: document.getElementById("hq-hp")!,
  enemyHqHp: document.getElementById("enemy-hq-hp")!,
  status: document.getElementById("status")!,
  trainWorker: document.getElementById("train-worker")!,
  trainSoldier: document.getElementById("train-soldier")!,
  buildBarracks: document.getElementById("build-barracks")!,
  stdbHost: document.getElementById("stdb-host") as HTMLInputElement,
  stdbDb: document.getElementById("stdb-db") as HTMLInputElement,
  stdbConnect: document.getElementById("stdb-connect")!,
  resetGame: document.getElementById("reset-game")!,
  autoSim: document.getElementById("auto-sim") as HTMLInputElement,
  manualTick: document.getElementById("manual-tick")!,
  minimapCanvas: document.getElementById("minimap") as HTMLCanvasElement,
};

const minimapCtx = ui.minimapCanvas.getContext("2d")!;

const WORLD = { w: canvas.width, h: canvas.height };

// Stats for rendering / defaults
const UNIT_STATS: any = {
  worker: { hp: 40, radius: 8, color: "#cbd5e1" },
  soldier: { hp: 90, radius: 10, color: "#93c5fd" },
  barracks: { hp: 500, radius: 25, color: "#fcd34d" },
  hq: { hp: 1000, radius: 30, color: "#fca5a5" }
};

const BUILDING_STATS = {
  hq: { hp: 1000, size: 44 },
};

const STDB_PREFS_KEY = "stdbrts_stdb_prefs";

// -----------------------------------------------------------------------------
// State (Synced from SpacetimeDB)
// -----------------------------------------------------------------------------

const state: any = {
  // We keep a local cache of the DB state for rendering
  units: [],      // Mapped from UnitRow
  waypoints: {},  // Mapped from WaypointRow (unitId -> Waypoint[])
  predictions: new Map(), // Client-side move predictions
  players: {},    // Mapped from PlayerRow
  config: null,   // Mapped from ConfigRow
  
  // Client-side UI state
  selectedIds: new Set(),
  selectionBox: null,
  mouse: { x: 0, y: 0 },
  
  // Connection state
  conn: null as DbConnection | null,
  connected: false,
  connecting: false,
  lastError: null as string | null,
  identity: null as Identity | null,
  simInterval: null as any,
};

// -----------------------------------------------------------------------------
// SpacetimeDB Callbacks
// -----------------------------------------------------------------------------

function getPlayerIdFromIdentity(identity: Identity): number {
  if (state.identity && identity.isEqual(state.identity)) {
    return 1; // You
  }
  return 2; // Enemy
}

function updatePlayer(ctx: any, row: PlayerRow) {
  const isMe = state.identity && row.identity.isEqual(state.identity);
  const internalId = isMe ? 1 : 2; // Simple mapping for UI colors
  
  state.players[internalId] = {
    identity: row.identity,
    name: row.name,
    resources: row.resources,
    online: row.online,
    color: isMe ? "#4ade80" : "#f87171", // Green for me, Red for enemy
    internalId: internalId
  };
}

function updateUnit(ctx: any, row: UnitRow) {
  const type = row.unitType;
  const stats = UNIT_STATS[type] || UNIT_STATS.worker;
  const ownerInternalId = getPlayerIdFromIdentity(row.owner);
  
  const existingIndex = state.units.findIndex((u: any) => u.id === Number(row.id));

  // Clear client-side prediction ID if server confirms the command in PENDING state
  const pred = state.predictions.get(Number(row.id));
  if (pred && row.pendingStartTick > 0) {
     state.predictions.delete(Number(row.id));
  }
  
  const unitData = {
    id: Number(row.id),
    ownerId: ownerInternalId,
    ownerIdentity: row.owner,
    type: row.unitType,
    // Store simulation parameters
    targetX: row.targetX,
    targetY: row.targetY,
    speed: row.speed,
    moving: row.moving,
    // Pending fields for UI
    pendingTargetX: row.pendingTargetX,
    pendingTargetY: row.pendingTargetY,
    pendingStartTick: row.pendingStartTick,
    
    // Stats
    hp: stats.hp, 
    maxHp: stats.hp,
    radius: stats.radius,
    pending: null, 
    cargo: 0,
    cargoMax: 25,
    
    // Server state for drift correction
    serverX: row.x,
    serverY: row.y
  };
  
  // WAYPOINT SYNC: Prune completed waypoints if the unit has advanced
  const wps = state.waypoints[Number(row.id)];
  if (wps) {
     // Identify if the NEW target corresponds to any existing waypoint in the queue
     // We start from the beginning because waypoints are ordered
     const matchIndex = wps.findIndex((wp: any) => 
         Math.abs(wp.x - row.targetX) < 0.1 && Math.abs(wp.y - row.targetY) < 0.1
     );
     
     if (matchIndex !== -1) {
         // The unit is now targeting 'matchIndex'.
         // This implies it has completed all previous waypoints (if any),
         // and 'matchIndex' itself is now the active target, not a queued waypoint.
         // So we remove everything up to and including 'matchIndex'.
         wps.splice(0, matchIndex + 1);
     }
  }

  if (existingIndex !== -1) {
    const oldUnit = state.units[existingIndex];
    state.units[existingIndex] = { 
      ...oldUnit,
      ...unitData,
      // Keep local X/Y for smoothing unless initializing
      x: oldUnit.x, 
      y: oldUnit.y,
    };
    
    // Snap if too far (teleport)
    const dist = Math.hypot(oldUnit.x - row.x, oldUnit.y - row.y);
    if (dist > 50) {
       state.units[existingIndex].x = row.x;
       state.units[existingIndex].y = row.y;
    }

  } else {
    // NEW UNIT: Snap to position
    state.units.push({
      ...unitData,
      x: row.x,
      y: row.y,
    });
  }
}

function deleteUnit(_ctx: any, row: UnitRow) {
  state.units = state.units.filter((u: any) => u.id !== Number(row.id));
  delete state.waypoints[Number(row.id)];
}

function updateWaypoint(ctx: any, row: WaypointRow) {
  const uid = Number(row.unitId);
  if (!state.waypoints[uid]) {
    state.waypoints[uid] = [];
  }
  
  // Update or insert
  const list = state.waypoints[uid];
  const idx = list.findIndex((w: any) => w.id === Number(row.id));
  const newWp = {
      id: Number(row.id),
      unitId: uid,
      x: row.x,
      y: row.y,
      order: row.order
  };
  
  if (idx !== -1) {
    list[idx] = newWp;
  } else {
    list.push(newWp);
  }
  
  // Keep sorted by order
  list.sort((a: any, b: any) => a.order - b.order);
}

function deleteWaypoint(ctx: any, row: WaypointRow) {
  const uid = Number(row.unitId);
  if (state.waypoints[uid]) {
    state.waypoints[uid] = state.waypoints[uid].filter((w: any) => w.id !== Number(row.id));
  }
}

function updateConfig(ctx: any, row: ConfigRow) {
  state.config = {
    version: row.version,
    worldWidth: row.worldWidth,
    worldHeight: row.worldHeight,
    lastTick: row.lastTick // Synced from server
  };
  // Update canvas/world size if needed
  if (row.worldWidth && row.worldHeight) {
    WORLD.w = row.worldWidth;
    WORLD.h = row.worldHeight;
    canvas.width = WORLD.w;
    canvas.height = WORLD.h;
  }
}

// -----------------------------------------------------------------------------
// Connection Logic
// -----------------------------------------------------------------------------

function loadStdbPrefs() {
  try {
    const raw = localStorage.getItem(STDB_PREFS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveStdbPrefs(host: string, dbName: string) {
  localStorage.setItem(STDB_PREFS_KEY, JSON.stringify({ host, dbName }));
}

function connectSpacetimeDb() {
  const host = ui.stdbHost.value.trim();
  const dbName = ui.stdbDb.value.trim();
  
  if (!host || !dbName) {
    ui.status.textContent = "Status: Enter host and database name";
    return;
  }

  saveStdbPrefs(host, dbName);
  
  // Cleanup previous connection
  if (state.simInterval) clearInterval(state.simInterval);
  if (state.conn) {
    state.conn.disconnect();
    state.conn = null;
  }
  
  state.connecting = true;
  state.connected = false;
  state.lastError = null;

  const tokenKey = `${host}/${dbName}/auth_token`;
  ui.status.textContent = "Status: Connecting to SpacetimeDB...";

  try {
    // 1. Setup connection
    state.conn = DbConnection.builder()
      .withUri(host)
      .withDatabaseName(dbName)
      .withToken(localStorage.getItem(tokenKey) || undefined)
      .onConnect((conn, identity, token) => {
        localStorage.setItem(tokenKey, token);
        state.connected = true;
        state.connecting = false;
        state.identity = identity;
        ui.status.textContent = "Status: Connected to SpacetimeDB";
        
        syncSimLoop(); // Check checkbox state and start/stop
        
        console.log("Connected with identity:", identity);
        console.log("Connection reducers available:", Object.keys(conn.reducers));
        
        // 2. Subscribe
        conn.subscriptionBuilder()
          .onApplied(() => {
             ui.status.textContent = "Status: Subscribed & Ready";
             console.log("Subscription applied");
          })
          .subscribe(["SELECT * FROM player", "SELECT * FROM unit", "SELECT * FROM config", "SELECT * FROM waypoint"]);

      })
      .onDisconnect(() => {
        state.connected = false;
        state.connecting = false;
        state.conn = null;
        if (state.simInterval) { clearInterval(state.simInterval); state.simInterval = null; }
        ui.status.textContent = "Status: Disconnected";
        console.log("Disconnected from SpacetimeDB");
      })
      .onConnectError((_ctx, err) => {
        state.connected = false;
        state.connecting = false;
        
        const errorMsg = 'Error connecting to SpacetimeDB: ' + err;
        console.error(errorMsg);
        state.lastError = errorMsg;
        ui.status.textContent = "Status: " + errorMsg;
      })
      .build();

    // 3. Register table callbacks on the connection instance
    state.conn.db.player.onInsert(updatePlayer);
    state.conn.db.player.onUpdate(updatePlayer);

    state.conn.db.unit.onInsert(updateUnit);
    state.conn.db.unit.onUpdate(updateUnit);
    state.conn.db.unit.onDelete(deleteUnit);

    state.conn.db.config.onInsert(updateConfig);
    state.conn.db.config.onUpdate(updateConfig);

    state.conn.db.waypoint.onInsert(updateWaypoint);
    state.conn.db.waypoint.onUpdate(updateWaypoint);
    state.conn.db.waypoint.onDelete(deleteWaypoint);

  } catch (e: any) {
    console.error("Critical Setup Error:", e);
    state.connecting = false;
    state.lastError = "Setup Error: " + e.message;
    ui.status.textContent = state.lastError;
  }
}

// -----------------------------------------------------------------------------
// Input & Reducers
// -----------------------------------------------------------------------------

function worldPosFromMouse(e: any) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function getSelectedOwnedUnits() {
  // Only select my units (ownerId === 1)
  return state.units.filter((u: any) => u.ownerId === 1 && state.selectedIds.has(u.id));
}

function selectInBox(x1: number, y1: number, x2: number, y2: number) {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  state.selectedIds.clear();
  for (const unit of state.units) {
    if (unit.ownerId !== 1) { // Only select my units
      continue;
    }
    if (unit.x >= minX && unit.x <= maxX && unit.y >= minY && unit.y <= maxY) {
      state.selectedIds.add(unit.id);
    }
  }
}

function selectSingle(x: number, y: number) {
  // Find unit under mouse
  // Prioritize own units
  let unit = state.units.find((u: any) => u.ownerId === 1 && Math.hypot(u.x - x, u.y - y) <= u.radius + 4);
  
  state.selectedIds.clear();
  if (unit) {
    state.selectedIds.add(unit.id);
  }
}

// Input Event Listeners

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (!state.connected || !state.conn) return;

  const pos = worldPosFromMouse(e);
  // Iterate all selected units
  const selected = [];
  for(const uid of state.selectedIds) {
      const u = state.units.find((unit: any) => unit.id === uid && unit.ownerId === 1);
      if(u) selected.push(u);
  }

  if (selected.length === 0) return;
  
  const shiftHeld = e.shiftKey;

  for (const unit of selected) {
      if (!shiftHeld) {
          // Optimistic prediction for IMMEDIATE move
          state.predictions.set(unit.id, { targetX: pos.x, targetY: pos.y });
      }
      
      // Send command
      state.conn.reducers.moveUnit({
        unitId: BigInt(unit.id),
        targetX: pos.x,
        targetY: pos.y,
        shiftHeld: shiftHeld,
      });
  }
});

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const pos = worldPosFromMouse(e);
  state.selectionBox = { x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y };
});

canvas.addEventListener("mousemove", (e) => {
  const pos = worldPosFromMouse(e);
  state.mouse = pos;
  if (state.selectionBox) {
    state.selectionBox.x2 = pos.x;
    state.selectionBox.y2 = pos.y;
  }
});

canvas.addEventListener("mouseup", (e) => {
  if (e.button !== 0 || !state.selectionBox) return;
  const { x1, y1, x2, y2 } = state.selectionBox;
  const tiny = Math.abs(x2 - x1) < 5 && Math.abs(y2 - y1) < 5;
  if (tiny) {
    selectSingle(x2, y2);
  } else {
    selectInBox(x1, y1, x2, y2);
  }
  state.selectionBox = null;
});

function getPlayerHQ(internalId: number) {
  // We don't have buildings sync yet, so simulate HQ position for training spawn
  if (internalId === 1) return { x: 160, y: 350 };
  return { x: 1040, y: 350 };
}

ui.trainWorker.addEventListener("click", () => {
    console.log("[Button] Train Worker clicked");
    console.log("  State:", { connected: state.connected, hasConn: !!state.conn });
    
    if (state.connected && state.conn) {
        console.log("  Reducers on conn:", Object.keys(state.conn.reducers));
        
        const hq = getPlayerHQ(1);
        const angle = Math.random() * Math.PI * 2;
        const r = 50;

        try {
            console.log("  Invoking trainUnit...");
            // Call reducer on the connection instance
            state.conn.reducers.trainUnit({
                unitType: "worker", 
                x: hq.x + Math.cos(angle) * r, 
                y: hq.y + Math.sin(angle) * r
            }).then(() => {
                console.log("  trainUnit promise resolved");
            }).catch((err: any) => {
                console.error("  trainUnit promise rejected:", err);
            });
        } catch (e) {
            console.error("  Error calling trainUnit:", e);
        }
    } else {
        console.warn("  Cannot train worker: Not connected or no connection object");
    }
});

ui.trainSoldier.addEventListener("click", () => {
  console.log("[Button] Train Soldier clicked");
  if (state.connected && state.conn) {
    const hq = getPlayerHQ(1);
    const angle = Math.random() * Math.PI * 2;
    const r = 50;
    
    state.conn.reducers.trainUnit({
      unitType: "soldier", 
      x: hq.x + Math.cos(angle) * r, 
      y: hq.y + Math.sin(angle) * r
    }).catch((err: any) => console.error("Train Soldier failed:", err));
  }
});

ui.buildBarracks.addEventListener("click", () => {
  console.log("[Button] Build Barracks clicked");
  if (state.connected && state.conn) {
    const hq = getPlayerHQ(1);
    // Spawn near HQ for now, later allow placement
    const angle = Math.random() * Math.PI * 2;
    const r = 100;
    
    // We assume the reducer name is buildBuilding
    state.conn.reducers.buildBuilding({
      buildingType: "barracks", 
      x: hq.x + Math.cos(angle) * r, 
      y: hq.y + Math.sin(angle) * r
    }).catch((err: any) => console.error("Build Barracks failed:", err));
  }
});

ui.stdbConnect.addEventListener("click", connectSpacetimeDb);

// -----------------------------------------------------------------------------
// Rendering (Preserved from main_old.ts)
// -----------------------------------------------------------------------------

function drawGrid() {
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1;
  for (let x = 0; x < WORLD.w; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, WORLD.h);
    ctx.stroke();
  }
  for (let y = 0; y < WORLD.h; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WORLD.w, y);
    ctx.stroke();
  }
}

function drawHealthBar(x: number, y: number, width: number, hp: number, maxHp: number) {
  const pct = Math.max(0, Math.min(1, hp / maxHp));
  ctx.fillStyle = "#111827";
  ctx.fillRect(x - width / 2, y, width, 5);
  ctx.fillStyle = pct > 0.35 ? "#22c55e" : "#ef4444";
  ctx.fillRect(x - width / 2, y, width * pct, 5);
}

function drawMinimap() {
  const mw = ui.minimapCanvas.width;
  const mh = ui.minimapCanvas.height;
  
  minimapCtx.fillStyle = "#111827";
  minimapCtx.fillRect(0, 0, mw, mh);
  
  // Scale
  const sx = mw / WORLD.w;
  const sy = mh / WORLD.h;
  
  // Draw units as dots
  for (const unit of state.units) {
    const isMe = unit.ownerId === 1;
    minimapCtx.fillStyle = isMe ? "#4ade80" : "#f87171";
    const size = unit.type === "hq" || unit.type === "barracks" ? 4 : 2;
    minimapCtx.fillRect(unit.x * sx - size/2, unit.y * sy - size/2, size, size);
  }
  
  // Viewport rect (if we had a camera, draw it here)
  minimapCtx.strokeStyle = "#ffffff";
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(0, 0, mw, mh);
}

function drawWorld() {
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  drawGrid();
  
  drawMinimap(); // Update minimap every frame
  
  // DEBUG: Show current tick
  const currentTick = state.config?.lastTick || 0;
  ctx.fillStyle = "white";
  ctx.font = "14px monospace";
  ctx.textAlign = "left";
  ctx.fillText("Server Tick: " + currentTick, 10, 20);

  // Draw Units
  for (const unit of state.units) {
    const isMe = unit.ownerId === 1;
    // Basic color from stats or owner
    let color = isMe ? "#4ade80" : "#f87171"; 
    
    // Buildings
    if (unit.type === "hq") color = isMe ? "#fca5a5" : "#7f1d1d";
    if (unit.type === "barracks") color = isMe ? "#fcd34d" : "#78350f";

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(unit.x, unit.y, unit.radius, 0, Math.PI * 2);
    ctx.fill();

    if (unit.type === "worker") {
      ctx.fillStyle = "#111827";
      ctx.fillRect(unit.x - 3, unit.y - 3, 6, 6);
    }

    if (state.selectedIds.has(unit.id)) {
      ctx.strokeStyle = "#fde047";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(unit.x, unit.y, unit.radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    
    // Draw Pending Indicator
    if (unit.pendingStartTick && unit.pendingStartTick > 0) {
        // ... (rest of logic same as before or slightly simplified)
        const delay = 6;
        let progress = 1.0;
        
        // If server hasn't updated lastTick yet, calculate diff
        const tickDiff = Number(unit.pendingStartTick) - Number(state.config?.lastTick || 0);
        if (tickDiff > 0) {
             progress = 1.0 - (tickDiff / delay); 
        } else {
             progress = 1.0;
        }
        progress = Math.max(0, Math.min(1, progress));

        // Draw Countdown Circle
        const r = unit.radius + 6;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(unit.x, unit.y, r, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = "#fbbf24"; // Amber
        ctx.lineWidth = 2;
        ctx.beginPath();
        // Draw arc based on progress (counter-clockwise from top)
        ctx.arc(unit.x, unit.y, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * progress), false);
        ctx.stroke();
        
        ctx.fillStyle = "white";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("WAIT", unit.x, unit.y - unit.radius - 8);
        
        // Target line
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(unit.x, unit.y);
        ctx.lineTo(unit.pendingTargetX, unit.pendingTargetY);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // --- WAYPOINTS RENDERING ---
    let startX = unit.x;
    let startY = unit.y;

    // If unit is actively moving, draw line to current target first
    if (unit.moving) {
       ctx.beginPath();
       ctx.moveTo(unit.x, unit.y);
       ctx.lineTo(unit.targetX, unit.targetY);
       ctx.strokeStyle = "rgba(100, 255, 100, 0.5)"; 
       ctx.setLineDash([4, 4]);
       ctx.lineWidth = 1;
       ctx.stroke();
       
       // Update start for next segments
       startX = unit.targetX;
       startY = unit.targetY;
    }

    // Now draw queued waypoints
    const wps = state.waypoints && state.waypoints[unit.id] ? state.waypoints[unit.id] : [];
    if (wps.length > 0) {
      // wps is already sorted by updateWaypoint
      
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      for (const wp of wps) {
        ctx.lineTo(wp.x, wp.y);
      }
      ctx.strokeStyle = "rgba(100, 200, 255, 0.5)"; 
      ctx.setLineDash([2, 2]); 
      ctx.lineWidth = 1;
      ctx.stroke();

      // Draw markers
      for (const wp of wps) {
         ctx.fillStyle = "rgba(100, 200, 255, 0.8)";
         ctx.beginPath();
         ctx.arc(wp.x, wp.y, 2, 0, Math.PI * 2);
         ctx.fill();
      }
    }
    ctx.setLineDash([]);
    // --- END WAYPOINTS ---

    // Health bar (mocked for now as not in DB)
    drawHealthBar(unit.x, unit.y - unit.radius - (unit.pending ? 20 : 10), 26, unit.hp, unit.maxHp);
  }
  
  // Selection Box
  if (state.selectionBox) {
    const { x1, y1, x2, y2 } = state.selectionBox;
    ctx.strokeStyle = "#f8fafc";
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.setLineDash([]);
  }
}

function updateUI() {
  const me = state.players[1];
  ui.resources.textContent = me ? Math.floor(me.resources).toString() : "0";
  ui.selectedCount.textContent = getSelectedOwnedUnits().length.toString();
  
  // Status update
  if (state.connected) {
    ui.status.textContent = "Status: Online";
  } else if (state.connecting) {
    ui.status.textContent = "Status: Connecting...";
  } else if (state.lastError) {
    ui.status.textContent = state.lastError;
  } else {
    ui.status.textContent = "Status: Disconnected (Wait for connect)";
  }
}

function loop() {
  const now = performance.now();
  // Simple dt calculation
  const lastTime = (loop as any).lastTime || now;
  const dt = (now - lastTime) / 1000;
  (loop as any).lastTime = now;
  
  // Cap dt to prevent massive jumps on lag
  const safeDt = Math.min(dt, 0.1); 
  
  const currentTick = state.config?.lastTick || 0;

  for (const unit of state.units) {
      // PREDICTION: Move towards target if we are moving
      // ONLY start moving if the server time >= unit.moveStartTick
      // With new schema, `unit.moving` is only true once start tick is reached.
      // So no extra check is needed here.
      
      const shouldMove = unit.moving && unit.targetX !== undefined;

      if (shouldMove) {
          const dx = unit.targetX - unit.x;
          const dy = unit.targetY - unit.y;
          const dist = Math.hypot(dx, dy);
          
          if (dist > 1.0) {
              const speed = unit.speed || 50;
              const move = speed * safeDt;
              
              if (move >= dist) {
                  // Arrived
                  unit.x = unit.targetX;
                  unit.y = unit.targetY;
                  // Don't set moving=false yet, wait for server to confirm stop
                  // or just clamp to target
              } else {
                  unit.x += (dx / dist) * move;
                  unit.y += (dy / dist) * move;
              }
          }
      }
      
      // RECONCILIATION: Pull towards server truth to fix drift
      // The server sends snapshots of where the unit IS (unit.serverX/Y)
      // Our local simulation `unit.x/y` should be close to `unit.serverX/Y`.
      // If the delta is small, ignore it (trust prediction).
      // If the delta is medium, lerp towards server.
      // If the delta is huge, snap.
      
      if (unit.serverX !== undefined) {
         // Current drift between where we are visually vs where server says we are
         const diffX = unit.serverX - unit.x;
         const diffY = unit.serverY - unit.y;
         const drift = Math.hypot(diffX, diffY);
         
         // If simulation is running well, drift should be near 0 (or exactly `speed * latency`).
         // We apply a soft force to pull visual back to server truth
         if (drift > 20) {
             // Strong pull (10% per frame)
             unit.x += diffX * 0.1;
             unit.y += diffY * 0.1;
         } else if (drift > 2) {
             // Gentle nudge (2% per frame)
             unit.x += diffX * 0.02;
             unit.y += diffY * 0.02;
         }
      }
      
      // PREDICTION & DISPLAY LOGIC
      // Check for pending server move first, then client prediction, then fallback
      
      if (unit.pendingStartTick && unit.pendingStartTick > 0) {
          // Server has a pending move
          unit.pending = true;
          unit.displayTargetX = unit.pendingTargetX;
          unit.displayTargetY = unit.pendingTargetY;
          unit.displayStartTick = unit.pendingStartTick;
      } else {
          // Check client prediction (latency gap before server ack)
          const pred = state.predictions.get(unit.id);
          if (pred) {
              unit.pending = true;
              unit.displayTargetX = pred.targetX;
              unit.displayTargetY = pred.targetY;
              unit.displayStartTick = null; // Unknown yet
          } else {
              unit.pending = false;
              unit.displayTargetX = unit.targetX;
              unit.displayTargetY = unit.targetY;
          }
      }
  }

  drawWorld();
  updateUI();
  
  if (state.connected) {
    ui.status.textContent = "Status: Online | Tick: " + (state.config?.lastTick || 0);
  } else if (state.connecting) {
    ui.status.textContent = "Status: Connecting...";
  } else if (state.lastError) {
    ui.status.textContent = state.lastError;
  } else {
    ui.status.textContent = "Status: Disconnected (Wait for connect)";
  }

  requestAnimationFrame(loop);
}

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

const prefs = loadStdbPrefs();
// Always default to localhost:3000 for now to fix connection issues
ui.stdbHost.value = "ws://localhost:3000"; 
if (prefs?.dbName) {
  ui.stdbDb.value = prefs.dbName;
} else {
  // Default suggestion
  ui.stdbDb.value = "server";
}

console.log("Available reducers:", Object.keys(reducers));

// -----------------------------------------------------------------------------
// Simulation Control
// -----------------------------------------------------------------------------

function syncSimLoop() {
  if (state.simInterval) clearInterval(state.simInterval);
  state.simInterval = null;
  
  if (ui.autoSim.checked && state.connected && state.conn) {
    state.simInterval = setInterval(() => {
      // Must verify connection again inside interval
      if (state.connected && state.conn) {
        state.conn.reducers.gameTick({});
      }
    }, 100);
  }
}

ui.autoSim.addEventListener("change", syncSimLoop);

ui.manualTick.addEventListener("click", () => {
    if (state.connected && state.conn) {
        state.conn.reducers.gameTick({});
    }
});

ui.resetGame.addEventListener("click", () => {
    if (state.connected && state.conn) {
        if (confirm("Are you sure you want to reset?")) {
            console.log("Resetting game...", state.conn.reducers);
            if (state.conn.reducers.resetGame) {
                state.conn.reducers.resetGame({});
            } else {
                console.error("resetGame reducer not found on connection object!", state.conn.reducers);
                alert("Error: resetGame reducer missing inside bindings. Check console.");
            }
        }
    } else {
        alert("Not connected!");
    }
});

requestAnimationFrame(loop);

// Start loop
requestAnimationFrame(loop);
