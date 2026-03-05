// @ts-nocheck
// @ts-nocheck
import { Identity, Infer } from "spacetimedb";
import { DbConnection, tables, reducers } from "./bindings/index";
import ConfigRowSchema from "./bindings/config_table";
import PlayerRowSchema from "./bindings/player_table";
import UnitRowSchema from "./bindings/unit_table";
import WaypointRowSchema from "./bindings/waypoint_table";
import ResourceNodeRowSchema from "./bindings/resource_node_table";

type ConfigRow = Infer<typeof ConfigRowSchema>;
type PlayerRow = Infer<typeof PlayerRowSchema>;
type UnitRow = Infer<typeof UnitRowSchema>;
type WaypointRow = Infer<typeof WaypointRowSchema>;
type ResourceNodeRow = Infer<typeof ResourceNodeRowSchema>;

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
  minimapCanvas: document.getElementById("minimap") as HTMLCanvasElement,
};

const minimapCtx = ui.minimapCanvas.getContext("2d")!;

const WORLD = { w: canvas.width, h: canvas.height };

// Stats for rendering / defaults
const UNIT_STATS: any = {
  worker:   { hp: 40,   radius: 8,  attackRange: 0   },
  soldier:  { hp: 90,   radius: 10, attackRange: 80  },
  catapult: { hp: 400,  radius: 22, attackRange: 300 },
  hq:       { hp: 1000, radius: 30, attackRange: 0   },
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
  resourceNodes: [] as any[], // Mapped from ResourceNodeRow
  
  // Client-side UI state
  selectedIds: new Set(),
  selectionBox: null,
  mouse: { x: 0, y: 0 },
  projectiles: [] as any[],
  gameResult: null as string | null,
  
  // Connection state
  conn: null as DbConnection | null,
  connected: false,
  connecting: false,
  subscriptionReady: false,
  lastError: null as string | null,
  identity: null as Identity | null,
  simInterval: null as any,
  // Set to true only when the player has explicitly started/joined a match,
  // so updateMatchInstance doesn't auto-enter the game on stale subscription data.
  expectingGame: false,
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
  
  // If my matchId changed to 0 (left game), clear the canvas!
  if (isMe && state.players[1] && Number(row.matchId) !== Number(state.players[1].matchId)) {
     if (Number(row.matchId) === 0) {
        state.units = [];
        state.waypoints = {};
        state.selectedIds.clear();
        state.projectiles = [];
        state.gameResult = null;
        state.resourceNodes = [];
     }
  }

  state.players[internalId] = {
    identity: row.identity,
    name: row.name,
    resources: row.resources,
    online: row.online,
    matchId: row.matchId,
    color: isMe ? "#4ade80" : "#60a5fa", // Green for me, Blue for enemy
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
    hp: Number(row.hp ?? stats.hp),
    maxHp: stats.hp,
    radius: stats.radius,
    attackRange: stats.attackRange ?? 0,
    pending: null, 
    cargo: 0,
    cargoMax: 25,
    
    // Server state for drift correction
    serverX: row.x,
    serverY: row.y
  };
  
  // WAYPOINT SYNC: 
  // If the unit moved to a new target, clean up any ghosts or promoted waypoints.
  const wps = state.waypoints[Number(row.id)];
  if (wps && wps.length > 0) {
     // 1. If we have any GHOSTS that match the new target, removing them fixes the gap.
     // 2. If the new target matches a normal waypoint, it's a promotion.
     
     // Filter out any waypoints (ghost or not) that match the new target.
     // ALSO, filter out any ghosts that DO NOT match (stale ghosts from cancelled commands).
     
     state.waypoints[Number(row.id)] = wps.filter((wp: any) => {
         const dx = Math.abs(wp.x - row.targetX);
         const dy = Math.abs(wp.y - row.targetY);
         const isMatch = (dx < 0.1 && dy < 0.1);
         
         if (isMatch) return false; // Arrived/Promoted -> Remove from queue
         if (wp.isGhost && !isMatch) return false; // Stale ghost -> Remove
         
         return true; // Keep future waypoints
     });
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
  // HQ destroyed — show win/lose
  if (row.unitType === "hq" && !state.gameResult) {
    const isMyHQ = state.identity && row.owner.isEqual(state.identity);
    state.gameResult = isMyHQ ? "DEFEAT" : "VICTORY";
  }
}

function updateResourceNode(_ctx: any, row: ResourceNodeRow) {
  const myPlayer = state.players[1];
  if (!myPlayer || Number(row.matchId) !== Number(myPlayer.matchId)) return;
  const idx = state.resourceNodes.findIndex((n: any) => n.id === Number(row.id));
  const node = {
    id: Number(row.id),
    matchId: Number(row.matchId),
    x: row.x,
    y: row.y,
    amount: Number(row.amount),
    maxAmount: Number(row.maxAmount),
  };
  if (idx !== -1) {
    state.resourceNodes[idx] = node;
  } else {
    state.resourceNodes.push(node);
  }
}

function deleteResourceNode(_ctx: any, row: ResourceNodeRow) {
  state.resourceNodes = state.resourceNodes.filter((n: any) => n.id !== Number(row.id));
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
  const list = state.waypoints[uid];
  if (!list) return;
  
  const unit = state.units.find((u: any) => u.id === uid);
  const wpIndex = list.findIndex((w: any) => w.id === Number(row.id));
  if (wpIndex === -1) return;
  
  // LOGIC: If we delete a waypoint that matches the CURRENT unit target,
  // it means we are just cleaning up after arrival. We can delete it.
  // BUT if we delete a waypoint that is NOT the current target,
  // it means the server has promoted it to current target, but the Unit update 
  // hasn't reached us yet. In this case, we KEEP it as a ghost to bridge the gap.
  // Exception: If the unit doesn't exist or is undetermined, just delete.
  
  let shouldKeepGhost = false;
  
  if (unit) {
      const wp = list[wpIndex];
      const dx = Math.abs(unit.targetX - wp.x);
      const dy = Math.abs(unit.targetY - wp.y);
      const isCurrentTarget = (dx < 0.1 && dy < 0.1);
      
      if (!isCurrentTarget) {
          shouldKeepGhost = true; 
      }
  }

  if (shouldKeepGhost) {
      list[wpIndex].isGhost = true;
  } else {
      list.splice(wpIndex, 1);
  }
}

function spawnProjectile(oldRow: any, newRow: any) {
  // Find the attacker: closest enemy unit with attackRange > 0
  const targetX = Number(newRow.x);
  const targetY = Number(newRow.y);
  const targetOwnerIsMe = state.identity && newRow.owner.isEqual(state.identity);
  const attacker = state.units
    .filter((u: any) => (u.ownerId === 1) !== targetOwnerIsMe && u.attackRange > 0)
    .sort((a: any, b: any) => Math.hypot(a.x - targetX, a.y - targetY) - Math.hypot(b.x - targetX, b.y - targetY))[0];
  if (!attacker) return;
  const isCatapult = attacker.type === "catapult";
  state.projectiles.push({
    x: attacker.x, y: attacker.y,
    tx: targetX,   ty: targetY,
    speed: isCatapult ? 220 : 400,
    color: attacker.ownerId === 1 ? "#fde047" : "#fb923c",
    radius: isCatapult ? 5 : 3,
    done: false,
  });
}

function enterGame() {
  state.expectingGame = false;
  document.getElementById("main-menu")!.style.display = "none";
  document.getElementById("multi-lobby")!.style.display = "none";
  document.getElementById("in-game-menu")!.style.display = "none";
  document.getElementById("game-app")!.style.display = "grid";
  // Center viewport on own HQ (units may not be synced yet, retry briefly)
  const tryCenter = (attempts: number) => {
    const myHQ = state.units.find((u: any) => u.ownerId === 1 && u.type === "hq");
    if (myHQ) {
      const sc = document.getElementById("scroll-container");
      if (sc) {
        sc.scrollLeft = myHQ.x - sc.clientWidth / 2;
        sc.scrollTop  = myHQ.y - sc.clientHeight / 2;
      }
    } else if (attempts > 0) {
      setTimeout(() => tryCenter(attempts - 1), 300);
    }
  };
  setTimeout(() => tryCenter(10), 100);
}

function updateMatchInstance(ctx: any, row: any) {
  const myPlayer = state.players[1];
  // Match by host identity (reliable for host) OR by matchId (reliable for joiner)
  const isHostOfThisMatch = state.identity && row.host?.isEqual?.(state.identity);
  const isInThisMatch = myPlayer && Number(row.id) === Number(myPlayer.matchId);

  console.log("[matchInstance]", {
    rowId: Number(row.id),
    active: row.active,
    isHostOfThisMatch,
    isInThisMatch,
    expectingGame: state.expectingGame,
    myMatchId: myPlayer ? Number(myPlayer.matchId) : null,
    identitySet: !!state.identity,
  });

  if (isHostOfThisMatch || isInThisMatch) {
     if (!state.config) state.config = {};
     state.config.lastTick = row.lastTick ?? row.last_tick;
     if (row.active && state.expectingGame) {
       enterGame();
     }
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
    // Don't squish canvas in scroll container
    canvas.style.minWidth = WORLD.w + "px";
    canvas.style.minHeight = WORLD.h + "px";
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
    // 1. Setup connection — build() returns the connection object
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
        
        console.log("Connected with identity:", identity);
        console.log("Connection reducers available:", Object.keys(conn.reducers));

        // Auto-start match only for single player; multiplayer users host/join manually
        const isMulti = (window as any).gameMode === 'multi';
        if (!isMulti && conn.reducers.startMatch) {
            state.expectingGame = true;
            conn.reducers.startMatch({ isMultiplayer: false });
        }
        
        // 2. Subscribe
        conn.subscriptionBuilder()
          .onApplied(() => {
             ui.status.textContent = "Status: Subscribed & Ready";
             state.subscriptionReady = true;
             console.log("Subscription applied");
             // Auto-refresh lobby once data is ready (for the joining client)
             if ((window as any).gameMode === 'multi' && (window as any).onRefreshLobby) {
               (window as any).onRefreshLobby();
             }
          })
          .subscribe([
              "SELECT * FROM player", 
              "SELECT * FROM unit", 
              "SELECT * FROM config", 
              "SELECT * FROM waypoint", 
              "SELECT * FROM match_instance",
              "SELECT * FROM resource_node"
          ]);

      })
      .onDisconnect(() => {
        state.connected = false;
        state.connecting = false;
        state.subscriptionReady = false;
        state.conn = null;
        state.projectiles = [];
        state.gameResult = null;
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
    state.conn.db.player.onUpdate((ctx: any, _old: any, newRow: any) => updatePlayer(ctx, newRow));

    state.conn.db.unit.onInsert(updateUnit);
    state.conn.db.unit.onUpdate((ctx: any, oldRow: any, newRow: any) => {
      updateUnit(ctx, newRow);
      if (Number(oldRow.hp) > Number(newRow.hp)) spawnProjectile(oldRow, newRow);
    });
    state.conn.db.unit.onDelete(deleteUnit);

    state.conn.db.config.onInsert(updateConfig);
    state.conn.db.config.onUpdate((ctx: any, _old: any, newRow: any) => updateConfig(ctx, newRow));

    state.conn.db.waypoint.onInsert(updateWaypoint);
    state.conn.db.waypoint.onUpdate((ctx: any, _old: any, newRow: any) => updateWaypoint(ctx, newRow));
    state.conn.db.waypoint.onDelete(deleteWaypoint);

    state.conn.db.resource_node.onInsert(updateResourceNode);
    state.conn.db.resource_node.onUpdate((ctx: any, _old: any, newRow: any) => updateResourceNode(ctx, newRow));
    state.conn.db.resource_node.onDelete(deleteResourceNode);

    state.conn.db.match_instance.onInsert(updateMatchInstance);
    state.conn.db.match_instance.onUpdate((ctx: any, _old: any, newRow: any) => updateMatchInstance(ctx, newRow));

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

ui.minimapCanvas.addEventListener("mousedown", (e) => {
  const rect = ui.minimapCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  
  const sx = WORLD.w / ui.minimapCanvas.width;
  const sy = WORLD.h / ui.minimapCanvas.height;
  
  const targetWorldX = mx * sx;
  const targetWorldY = my * sy;
  
  const scrollContainer = document.getElementById("scroll-container");
  if (scrollContainer) {
     scrollContainer.scrollLeft = targetWorldX - scrollContainer.clientWidth / 2;
     scrollContainer.scrollTop = targetWorldY - scrollContainer.clientHeight / 2;
  }
});

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
      // HQ cannot be ordered to move
      if (unit.type === "hq") continue;

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

function getMyHQPos() {
  const hq = state.units.find((u: any) => u.ownerId === 1 && u.type === "hq");
  if (hq) return { x: hq.x, y: hq.y };
  // Fallback: use known start positions based on player slot
  return state.players[1]?.matchId ? { x: 2700, y: 2700 } : { x: 300, y: 300 };
}

ui.trainWorker.addEventListener("click", () => {
    console.log("[Button] Train Worker clicked");
    console.log("  State:", { connected: state.connected, hasConn: !!state.conn });
    
    if (state.connected && state.conn) {
        console.log("  Reducers on conn:", Object.keys(state.conn.reducers));
        
        const hq = getMyHQPos();
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
    const hq = getMyHQPos();
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
  console.log("[Button] Build Catapult clicked");
  if (state.connected && state.conn) {
    const hq = getMyHQPos();
    const angle = Math.random() * Math.PI * 2;
    const r = 100;
    state.conn.reducers.buildBuilding({
      buildingType: "catapult",
      x: hq.x + Math.cos(angle) * r,
      y: hq.y + Math.sin(angle) * r
    }).catch((err: any) => console.error("Build Catapult failed:", err));
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
  
  // Draw resource nodes as gold dots
  for (const node of state.resourceNodes) {
    minimapCtx.fillStyle = "#fbbf24";
    minimapCtx.fillRect(node.x * sx - 2, node.y * sy - 2, 4, 4);
  }

  // Draw units as dots
  for (const unit of state.units) {
    const isMe = unit.ownerId === 1;
    minimapCtx.fillStyle = isMe ? "#4ade80" : "#60a5fa";
    const size = unit.type === "hq" || unit.type === "barracks" ? 4 : 2;
    minimapCtx.fillRect(unit.x * sx - size/2, unit.y * sy - size/2, size, size);
  }

  // Start position markers on minimap
  const startPositions = [{ x: 300, y: 300, color: "#4ade80" }, { x: 2700, y: 2700, color: "#60a5fa" }];
  for (const sp of startPositions) {
    minimapCtx.strokeStyle = sp.color;
    minimapCtx.globalAlpha = 0.6;
    minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(sp.x * sx - 5, sp.y * sy - 5, 10, 10);
    minimapCtx.globalAlpha = 1.0;
  }
  
  // Viewport rect
  const scrollContainer = document.getElementById("scroll-container");
  if (scrollContainer) {
    const vx = scrollContainer.scrollLeft * sx;
    const vy = scrollContainer.scrollTop * sy;
    const vw = scrollContainer.clientWidth * sx;
    const vh = scrollContainer.clientHeight * sy;
    minimapCtx.strokeStyle = "#ffffff";
    minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(vx, vy, vw, vh);
  }
}

function drawWorld() {
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  drawGrid();

  // Start position zone markers
  const startZones = [
    { x: 300, y: 300,   color: "rgba(74, 222, 128, 0.08)", border: "rgba(74, 222, 128, 0.4)",  label: "P1 Start" },
    { x: 2700, y: 2700, color: "rgba(96, 165, 250, 0.08)", border: "rgba(96, 165, 250, 0.4)",  label: "P2 Start" },
  ];
  for (const zone of startZones) {
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, 160, 0, Math.PI * 2);
    ctx.fillStyle = zone.color;
    ctx.fill();
    ctx.strokeStyle = zone.border;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = zone.border;
    ctx.font = "bold 18px monospace";
    ctx.textAlign = "center";
    ctx.fillText(zone.label, zone.x, zone.y - 170);
  }

  drawMinimap(); // Update minimap every frame
  
  // DEBUG: Show current tick
  const currentTick = state.config?.lastTick || 0;
  ctx.fillStyle = "white";
  ctx.font = "14px monospace";
  ctx.textAlign = "left";
  ctx.fillText("Server Tick: " + currentTick, 10, 20);

  // --- Resource Nodes ---
  for (const node of state.resourceNodes) {
    const pct = node.maxAmount > 0 ? node.amount / node.maxAmount : 0;
    const r = 14;
    // Glow
    ctx.shadowColor = "#fbbf24";
    ctx.shadowBlur = 12;
    // Hexagon
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const px = node.x + r * Math.cos(angle);
      const py = node.y + r * Math.sin(angle);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(251, 191, 36, ${0.3 + 0.5 * pct})`;
    ctx.fill();
    ctx.strokeStyle = "#fde68a";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Amount label
    ctx.fillStyle = "#fef3c7";
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "center";
    ctx.fillText(node.amount.toString(), node.x, node.y + 4);
  }

    // Draw Units
  for (const unit of state.units) {
    const isMe = unit.ownerId === 1;
    let color = isMe ? "#4ade80" : "#60a5fa";

    if (unit.type === "hq")      color = isMe ? "#86efac" : "#93c5fd";
    if (unit.type === "barracks") color = isMe ? "#fcd34d" : "#818cf8";
    if (unit.type === "catapult") color = isMe ? "#fcd34d" : "#818cf8";

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(unit.x, unit.y, unit.radius, 0, Math.PI * 2);
    ctx.fill();

    if (unit.type === "worker") {
      ctx.fillStyle = "#111827";
      ctx.fillRect(unit.x - 3, unit.y - 3, 6, 6);
    }

    if (state.selectedIds.has(unit.id)) {
      // Selection ring — rect for HQ, arc for others
      ctx.strokeStyle = "#fde047";
      ctx.lineWidth = 2;
      if (unit.type === "hq") {
        const s = unit.radius * 2 + 8;
        ctx.strokeRect(unit.x - s / 2, unit.y - s / 2, s, s);
      } else {
        ctx.beginPath();
        ctx.arc(unit.x, unit.y, unit.radius + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Draw attack range ring for units that have one
      if (unit.attackRange > 0) {
        ctx.beginPath();
        ctx.arc(unit.x, unit.y, unit.attackRange, 0, Math.PI * 2);
        ctx.strokeStyle = isMe ? "rgba(253,224,71,0.25)" : "rgba(96,165,250,0.25)";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
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
         // Debug visual for ghosts
         // ctx.fillStyle = wp.isGhost ? "rgba(255, 100, 100, 0.8)" : "rgba(100, 200, 255, 0.8)";
         ctx.arc(wp.x, wp.y, 2, 0, Math.PI * 2);
         ctx.fill();
      }
    }
    ctx.setLineDash([]);
    // --- END WAYPOINTS ---

    // Health bar — position correctly for rect (HQ) vs circle
    const hpBarY = unit.type === "hq"
      ? unit.y + unit.radius + 4
      : unit.y - unit.radius - (unit.pending ? 20 : 10);
    drawHealthBar(unit.x, hpBarY, unit.type === "hq" ? 60 : 26, unit.hp, unit.maxHp);
  }

  // --- Projectiles ---
  for (const proj of state.projectiles) {
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, proj.radius, 0, Math.PI * 2);
    ctx.fillStyle = proj.color;
    ctx.shadowColor = proj.color;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // --- Game Result Banner ---
  if (state.gameResult) {
    const cx = WORLD.w / 2;
    const cy = WORLD.h / 2;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(cx - 260, cy - 70, 520, 140);
    ctx.font = "bold 72px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = state.gameResult === "VICTORY" ? "#4ade80" : "#f87171";
    ctx.fillText(state.gameResult, cx, cy + 20);
    ctx.font = "20px monospace";
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText("Destroy the enemy HQ to win", cx, cy + 55);
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

  // --- Advance projectiles ---
  for (const proj of state.projectiles) {
    const dx = proj.tx - proj.x;
    const dy = proj.ty - proj.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 2) { proj.done = true; continue; }
    const move = proj.speed * safeDt;
    if (move >= dist) { proj.x = proj.tx; proj.y = proj.ty; proj.done = true; }
    else { proj.x += (dx / dist) * move; proj.y += (dy / dist) * move; }
  }
  state.projectiles = state.projectiles.filter((p: any) => !p.done);

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

(window as any).onLeaveGame = () => {
    if (state.connected && state.conn) {
        if (state.conn.reducers.leaveMatch) {
            state.conn.reducers.leaveMatch({});
        }
    }
};

const prefs = loadStdbPrefs();
// Always default to localhost:3000 for now to fix connection issues
ui.stdbHost.value = "ws://localhost:3000"; 
if (prefs?.dbName) {
  ui.stdbDb.value = prefs.dbName;
} else {
  // Default suggestion
  ui.stdbDb.value = "main";
}

console.log("Available reducers:", Object.keys(reducers));

// -----------------------------------------------------------------------------
// Reset button
// -----------------------------------------------------------------------------

ui.resetGame.addEventListener("click", () => {
    if (state.connected && state.conn) {
        if (confirm("Are you sure you want to reset?")) {
            if (state.conn.reducers.resetGame) {
                state.conn.reducers.resetGame({});
            }
        }
    } else {
        alert("Not connected!");
    }
});

// -----------------------------------------------------------------------------
// Multiplayer Lobby API (called from index.html globals)
// -----------------------------------------------------------------------------

(window as any).connectSpacetimeDb = () => {
    if (!state.connected && !state.connecting) {
        document.getElementById("stdb-connect")!.click();
    }
};

(window as any).onHostMultiMatch = (name: string) => {
    if (!state.connected || !state.conn) {
        alert("Not connected yet — please wait a moment and try again.");
        return;
    }
    state.conn.reducers.setName({ name });
    state.expectingGame = true;
    state.conn.reducers.startMatch({ isMultiplayer: true });
    // Stay in lobby view — match is inactive until opponent joins.
    // Poll every second as a fallback in case onUpdate doesn't fire in time.
    document.getElementById("lobby-list")!.innerHTML =
        "<em style='color:#fbbf24'>Waiting for opponent…</em>";
    const pollId = setInterval(() => {
        if (!state.expectingGame) { clearInterval(pollId); return; }
        if (!state.conn) { clearInterval(pollId); return; }
        const matchTable = (state.conn.db as any).match_instance;
        if (!matchTable) return;
        for (const m of matchTable.iter()) {
            if (m.host?.isEqual?.(state.identity) && m.active) {
                clearInterval(pollId);
                enterGame();
                return;
            }
        }
    }, 500);
};

(window as any).onRefreshLobby = () => {
    const list = document.getElementById("lobby-list")!;
    if (!state.connected || !state.conn) {
        list.innerHTML = "<em style='color:#666'>Connecting… please wait</em>";
        return;
    }
    if (!state.subscriptionReady) {
        list.innerHTML = "<em style='color:#666'>Syncing data… please wait</em>";
        return;
    }
    // Call iter() directly on the table object to preserve `this` binding
    const matchTable = (state.conn.db as any).match_instance;
    const rows: any[] = matchTable ? [...matchTable.iter()] : [];
    const open = rows.filter((m: any) => m.isMultiplayer && !m.active);
    if (open.length === 0) {
        list.innerHTML = "<em style='color:#666'>No open matches yet</em>";
        return;
    }
    list.innerHTML = open.map((m: any) => {
        const hostPlayer = Object.values(state.players).find(
            (p: any) => p.identity?.isEqual?.(m.host)
        ) as any;
        const hostName = hostPlayer?.name || "Unknown";
        const matchId = m.id.toString(); // safe BigInt → string for onclick
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #222;">
            <span>${hostName}'s match</span>
            <button onclick="window.joinMultiMatch('${matchId}')" style="padding:4px 10px;background:#16a34a;color:white;border:none;border-radius:4px;cursor:pointer;">Join</button>
        </div>`;
    }).join("");
};

(window as any).joinMultiMatch = (matchId: number) => {
    if (!state.connected || !state.conn) return;
    const nameEl = document.getElementById("player-name") as HTMLInputElement;
    const name = nameEl?.value.trim();
    if (name) state.conn.reducers.setName({ name });
    state.conn.reducers.joinMatch({ matchId: BigInt(matchId) });
    // Enter the game immediately — the joiner activates the match
    enterGame();
};

requestAnimationFrame(loop);
