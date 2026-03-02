const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const ui = {
  resources: document.getElementById("resources"),
  selectedCount: document.getElementById("selected-count"),
  hqHp: document.getElementById("hq-hp"),
  enemyHqHp: document.getElementById("enemy-hq-hp"),
  status: document.getElementById("status"),
  trainWorker: document.getElementById("train-worker"),
  trainSoldier: document.getElementById("train-soldier"),
  stdbHost: document.getElementById("stdb-host"),
  stdbDb: document.getElementById("stdb-db"),
  stdbConnect: document.getElementById("stdb-connect"),
};

const COMMAND_DELAY = 0.6;
const SIM_TICK = 1 / 20;
const WORLD = { w: canvas.width, h: canvas.height };
const PROJECTILE_STATS = { speed: 360, radius: 3, ttl: 1.2 };

const UNIT_STATS = {
  worker: { hp: 40, speed: 70, range: 14, damage: 3, cooldown: 0.8, radius: 8, cost: 50 },
  soldier: { hp: 90, speed: 60, range: 65, damage: 12, cooldown: 0.75, radius: 10, cost: 100 },
};

const BUILDING_STATS = {
  hq: { hp: 1000, size: 44 },
};

const STDB_PREFS_KEY = "stdbrts_stdb_prefs";

const state = {
  time: 0,
  accumulator: 0,
  nextId: 1,
  gameOver: false,
  winner: null,
  players: {
    1: { id: 1, name: "You", color: "#4ade80", resources: 250 },
    2: { id: 2, name: "Enemy", color: "#f87171", resources: 250 },
  },
  units: [],
  buildings: [],
  resources: [],
  projectiles: [],
  selectedIds: new Set(),
  selectionBox: null,
  mouse: { x: 0, y: 0 },
  enemyAiTimer: 0,
  enemySpawnTimer: 0,
};

const net = {
  conn: null,
  connected: false,
  authoritative: false,
  subscriptionReady: false,
};

function loadStdbPrefs() {
  try {
    const raw = localStorage.getItem(STDB_PREFS_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveStdbPrefs(host, dbName) {
  localStorage.setItem(STDB_PREFS_KEY, JSON.stringify({ host, dbName }));
}

function isStdbMode() {
  return net.connected && net.authoritative;
}

function readAny(row, keys, fallback = null) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) {
      return row[key];
    }
  }
  return fallback;
}

function tableRowsByCandidates(candidates) {
  if (!net.conn || !net.conn.db) {
    return [];
  }
  for (const name of candidates) {
    const table = net.conn.db[name];
    if (table && typeof table.iter === "function") {
      return [...table.iter()];
    }
  }
  return [];
}

function detectAuthoritativeTables() {
  if (!net.conn || !net.conn.db) {
    return false;
  }
  const names = ["player", "players", "unit", "units", "building", "buildings", "resource", "resources"];
  return names.some((name) => net.conn.db[name] && typeof net.conn.db[name].iter === "function");
}

function applySnapshotFromSpacetimeDb() {
  const playerRows = tableRowsByCandidates(["player", "players"]);
  const unitRows = tableRowsByCandidates(["unit", "units"]);
  const buildingRows = tableRowsByCandidates(["building", "buildings"]);
  const resourceRows = tableRowsByCandidates(["resource", "resources", "resource_node", "resourceNode"]);
  const projectileRows = tableRowsByCandidates(["projectile", "projectiles"]);

  if (playerRows.length > 0) {
    const players = {};
    for (const row of playerRows) {
      const playerId = Number(readAny(row, ["id", "player_id", "playerId"], 0));
      if (!playerId) {
        continue;
      }
      players[playerId] = {
        id: playerId,
        name: String(readAny(row, ["name", "display_name", "displayName"], playerId === 1 ? "You" : `Player ${playerId}`)),
        color: String(readAny(row, ["color"], playerId === 1 ? "#4ade80" : "#f87171")),
        resources: Number(readAny(row, ["resources", "resource_count", "resourceCount"], 0)),
      };
    }
    if (Object.keys(players).length > 0) {
      state.players = players;
    }
  }

  if (unitRows.length > 0 || buildingRows.length > 0 || resourceRows.length > 0) {
    state.units = unitRows.map((row) => {
      const type = String(readAny(row, ["type", "unit_type", "unitType"], "worker"));
      const stats = UNIT_STATS[type] || UNIT_STATS.worker;
      return {
        id: Number(readAny(row, ["id", "unit_id", "unitId"], 0)),
        ownerId: Number(readAny(row, ["owner_id", "ownerId", "player_id", "playerId"], 0)),
        type,
        x: Number(readAny(row, ["x", "pos_x", "posX"], 0)),
        y: Number(readAny(row, ["y", "pos_y", "posY"], 0)),
        hp: Number(readAny(row, ["hp", "health"], stats.hp)),
        maxHp: Number(readAny(row, ["max_hp", "maxHp"], stats.hp)),
        speed: Number(readAny(row, ["speed"], stats.speed)),
        range: Number(readAny(row, ["range"], stats.range)),
        damage: Number(readAny(row, ["damage"], stats.damage)),
        cooldown: Number(readAny(row, ["cooldown"], stats.cooldown)),
        radius: Number(readAny(row, ["radius"], stats.radius)),
        attackTimer: 0,
        order: { type: "idle" },
        pending: null,
        cargo: Number(readAny(row, ["cargo"], 0)),
        cargoMax: Number(readAny(row, ["cargo_max", "cargoMax"], 25)),
      };
    });

    state.buildings = buildingRows.map((row) => ({
      id: Number(readAny(row, ["id", "building_id", "buildingId"], 0)),
      type: String(readAny(row, ["type", "building_type", "buildingType"], "hq")),
      ownerId: Number(readAny(row, ["owner_id", "ownerId", "player_id", "playerId"], 0)),
      x: Number(readAny(row, ["x", "pos_x", "posX"], 0)),
      y: Number(readAny(row, ["y", "pos_y", "posY"], 0)),
      hp: Number(readAny(row, ["hp", "health"], BUILDING_STATS.hq.hp)),
      maxHp: Number(readAny(row, ["max_hp", "maxHp"], BUILDING_STATS.hq.hp)),
      size: Number(readAny(row, ["size"], BUILDING_STATS.hq.size)),
      trainQueue: [],
    }));

    state.resources = resourceRows.map((row) => ({
      id: Number(readAny(row, ["id", "resource_id", "resourceId"], 0)),
      x: Number(readAny(row, ["x", "pos_x", "posX"], 0)),
      y: Number(readAny(row, ["y", "pos_y", "posY"], 0)),
      amount: Number(readAny(row, ["amount"], 0)),
      radius: Number(readAny(row, ["radius"], 20)),
    }));

    state.projectiles = projectileRows.map((row) => ({
      id: Number(readAny(row, ["id", "projectile_id", "projectileId"], 0)),
      ownerId: Number(readAny(row, ["owner_id", "ownerId", "player_id", "playerId"], 0)),
      x: Number(readAny(row, ["x", "pos_x", "posX"], 0)),
      y: Number(readAny(row, ["y", "pos_y", "posY"], 0)),
      targetKind: String(readAny(row, ["target_kind", "targetKind"], "unit")),
      targetId: Number(readAny(row, ["target_id", "targetId"], 0)),
      damage: Number(readAny(row, ["damage"], 0)),
      speed: Number(readAny(row, ["speed"], PROJECTILE_STATS.speed)),
      radius: Number(readAny(row, ["radius"], PROJECTILE_STATS.radius)),
      ttl: Number(readAny(row, ["ttl"], PROJECTILE_STATS.ttl)),
    }));

    state.selectedIds = new Set([...state.selectedIds].filter((unitId) => state.units.some((u) => u.id === unitId)));
  }
}

function invokeReducer(reducerName, args) {
  const reducer = net.conn?.reducers?.[reducerName];
  if (typeof reducer !== "function") {
    return false;
  }
  try {
    reducer(args);
    return true;
  } catch (error) {
    console.error(`Reducer ${reducerName} failed`, error);
    ui.status.textContent = `Status: reducer ${reducerName} failed`;
    return false;
  }
}

function configureRealtimeCallbacks() {
  if (!net.conn || !net.conn.db) {
    return;
  }
  const watchedTableNames = ["player", "players", "unit", "units", "building", "buildings", "resource", "resources", "resource_node", "resourceNode", "projectile", "projectiles"];
  for (const name of watchedTableNames) {
    const table = net.conn.db[name];
    if (!table) {
      continue;
    }
    if (typeof table.onInsert === "function") {
      table.onInsert(() => applySnapshotFromSpacetimeDb());
    }
    if (typeof table.onUpdate === "function") {
      table.onUpdate(() => applySnapshotFromSpacetimeDb());
    }
    if (typeof table.onDelete === "function") {
      table.onDelete(() => applySnapshotFromSpacetimeDb());
    }
  }
}

function connectSpacetimeDb() {
  const DbConnection = globalThis.DbConnection;
  const tables = globalThis.tables;

  if (!DbConnection || !tables) {
    ui.status.textContent = "Status: SpacetimeDB bindings missing (load dist/bindings.iife.js)";
    return;
  }

  const host = ui.stdbHost.value.trim();
  const dbName = ui.stdbDb.value.trim();
  if (!host || !dbName) {
    ui.status.textContent = "Status: Enter host and database name";
    return;
  }

  saveStdbPrefs(host, dbName);

  const tokenKey = `${host}/${dbName}/auth_token`;
  ui.status.textContent = "Status: Connecting to SpacetimeDB...";

  net.conn = DbConnection.builder()
    .withUri(host)
    .withDatabaseName(dbName)
    .withToken(localStorage.getItem(tokenKey))
    .onConnect((_conn, _identity, token) => {
      localStorage.setItem(tokenKey, token);
      net.connected = true;
      net.authoritative = detectAuthoritativeTables();
      ui.status.textContent = net.authoritative
        ? "Status: Connected (SpacetimeDB authoritative)"
        : "Status: Connected (waiting for RTS tables)";

      net.conn
        .subscriptionBuilder()
        .onApplied(() => {
          net.subscriptionReady = true;
          net.authoritative = detectAuthoritativeTables();
          applySnapshotFromSpacetimeDb();
          ui.status.textContent = net.authoritative
            ? "Status: Connected + subscribed"
            : "Status: Subscribed (RTS tables not detected)";
        })
        .subscribeToAllTables();

      configureRealtimeCallbacks();
    })
    .onDisconnect(() => {
      net.connected = false;
      net.authoritative = false;
      net.subscriptionReady = false;
      ui.status.textContent = "Status: Disconnected from SpacetimeDB";
    })
    .onConnectError((_ctx, err) => {
      net.connected = false;
      net.authoritative = false;
      net.subscriptionReady = false;
      ui.status.textContent = `Status: SpacetimeDB connect error: ${err?.message || err || "unknown"}`;
    })
    .build();
}

function id() {
  return state.nextId++;
}

function spawnHQ(ownerId, x, y) {
  const hq = {
    id: id(),
    type: "hq",
    ownerId,
    x,
    y,
    hp: BUILDING_STATS.hq.hp,
    maxHp: BUILDING_STATS.hq.hp,
    size: BUILDING_STATS.hq.size,
    trainQueue: [],
  };
  state.buildings.push(hq);
  return hq;
}

function spawnUnit(ownerId, type, x, y) {
  const stats = UNIT_STATS[type];
  const unit = {
    id: id(),
    ownerId,
    type,
    x,
    y,
    hp: stats.hp,
    maxHp: stats.hp,
    speed: stats.speed,
    range: stats.range,
    damage: stats.damage,
    cooldown: stats.cooldown,
    radius: stats.radius,
    attackTimer: 0,
    order: { type: "idle" },
    pending: null,
    cargo: 0,
    cargoMax: 25,
  };
  state.units.push(unit);
  return unit;
}

function setupMatch() {
  spawnHQ(1, 160, 350);
  spawnHQ(2, 1040, 350);

  spawnUnit(1, "worker", 220, 320);
  spawnUnit(1, "worker", 220, 380);
  spawnUnit(1, "soldier", 250, 350);

  spawnUnit(2, "worker", 980, 320);
  spawnUnit(2, "worker", 980, 380);
  spawnUnit(2, "soldier", 950, 350);

  state.resources.push(
    { id: id(), x: 600, y: 180, amount: 900, radius: 20 },
    { id: id(), x: 620, y: 520, amount: 900, radius: 20 },
    { id: id(), x: 500, y: 350, amount: 700, radius: 20 },
    { id: id(), x: 740, y: 350, amount: 700, radius: 20 }
  );
}

function getPlayerHQ(playerId) {
  return state.buildings.find((b) => b.ownerId === playerId && b.type === "hq");
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function moveTowards(unit, targetX, targetY, dt) {
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    return true;
  }
  const dx = targetX - unit.x;
  const dy = targetY - unit.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) {
    return true;
  }
  const step = unit.speed * dt;
  if (step >= len) {
    unit.x = targetX;
    unit.y = targetY;
    return true;
  }
  unit.x += (dx / len) * step;
  unit.y += (dy / len) * step;
  return false;
}

function issueCommand(units, commandFactory) {
  if (state.gameOver) {
    return;
  }

  if (isStdbMode()) {
    for (const unit of units) {
      const command = commandFactory(unit);
      if (command.type === "move") {
        invokeReducer("issue_move", {
          unit_id: unit.id,
          x: command.x,
          y: command.y,
          delay_seconds: COMMAND_DELAY,
        });
      } else if (command.type === "attack") {
        invokeReducer("issue_attack", {
          unit_id: unit.id,
          target_kind: command.targetKind,
          target_id: command.targetId,
          delay_seconds: COMMAND_DELAY,
        });
      } else if (command.type === "gather") {
        invokeReducer("issue_gather", {
          unit_id: unit.id,
          resource_id: command.resourceId,
          delay_seconds: COMMAND_DELAY,
        });
      }
    }
    return;
  }

  for (const unit of units) {
    unit.pending = {
      ...commandFactory(unit),
      executeAt: state.time + COMMAND_DELAY,
    };
  }
}

function commandMove(units, x, y) {
  issueCommand(units, (unit) => ({ type: "move", x, y, forUnit: unit.id }));
}

function commandAttack(units, targetKind, targetId) {
  issueCommand(units, () => ({ type: "attack", targetKind, targetId }));
}

function commandGather(units, resourceId) {
  issueCommand(units, (unit) => {
    if (unit.type !== "worker") {
      return { type: "idle" };
    }
    return { type: "gather", resourceId, phase: "toResource" };
  });
}

function applyPending(unit) {
  if (!unit.pending || state.time < unit.pending.executeAt) {
    return;
  }
  const pending = unit.pending;
  unit.pending = null;

  if (pending.type === "move") {
    unit.order = { type: "move", x: pending.x, y: pending.y };
  } else if (pending.type === "attack") {
    unit.order = {
      type: "attack",
      targetKind: pending.targetKind,
      targetId: pending.targetId,
    };
  } else if (pending.type === "gather") {
    unit.order = { type: "gather", resourceId: pending.resourceId, phase: "toResource", gatherClock: 0 };
  } else {
    unit.order = { type: "idle" };
  }
}

function getUnitById(unitId) {
  return state.units.find((u) => u.id === unitId);
}

function getBuildingById(buildingId) {
  return state.buildings.find((b) => b.id === buildingId);
}

function getResourceById(resourceId) {
  return state.resources.find((r) => r.id === resourceId);
}

function targetStillValid(targetKind, targetId, ownerId) {
  if (targetKind === "unit") {
    const unit = getUnitById(targetId);
    return unit && unit.ownerId !== ownerId ? unit : null;
  }
  if (targetKind === "building") {
    const building = getBuildingById(targetId);
    return building && building.ownerId !== ownerId ? building : null;
  }
  return null;
}

function nearestEnemyForUnit(unit, maxDistance) {
  let nearest = null;
  let nearestDist = maxDistance;

  for (const enemyUnit of state.units) {
    if (enemyUnit.ownerId === unit.ownerId || enemyUnit.id === unit.id) {
      continue;
    }
    const d = dist(unit, enemyUnit);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = { kind: "unit", id: enemyUnit.id };
    }
  }

  for (const enemyBuilding of state.buildings) {
    if (enemyBuilding.ownerId === unit.ownerId) {
      continue;
    }
    const d = dist(unit, enemyBuilding);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = { kind: "building", id: enemyBuilding.id };
    }
  }

  return nearest;
}

function tryAcquireAutoAttackTarget(unit) {
  if (unit.type !== "soldier") {
    return false;
  }
  const autoAggroRange = 170;
  const target = nearestEnemyForUnit(unit, autoAggroRange);
  if (!target) {
    return false;
  }

  unit.order = {
    type: "attack",
    targetKind: target.kind,
    targetId: target.id,
  };
  return true;
}

function damageTarget(targetKind, targetId, damage) {
  if (targetKind === "unit") {
    const unit = getUnitById(targetId);
    if (unit) {
      unit.hp -= damage;
    }
    return;
  }
  if (targetKind === "building") {
    const building = getBuildingById(targetId);
    if (building) {
      building.hp -= damage;
    }
  }
}

function spawnProjectile(shooter, targetKind, targetId) {
  state.projectiles.push({
    id: id(),
    ownerId: shooter.ownerId,
    x: shooter.x,
    y: shooter.y,
    targetKind,
    targetId,
    damage: shooter.damage,
    speed: PROJECTILE_STATS.speed,
    radius: PROJECTILE_STATS.radius,
    ttl: PROJECTILE_STATS.ttl,
  });
}

function updateProjectiles(dt) {
  const alive = [];
  for (const projectile of state.projectiles) {
    projectile.ttl -= dt;
    if (projectile.ttl <= 0) {
      continue;
    }

    const target = targetStillValid(projectile.targetKind, projectile.targetId, projectile.ownerId);
    if (!target) {
      continue;
    }

    const targetRadius = target.radius || (target.size ? target.size * 0.5 : 8);
    const dx = target.x - projectile.x;
    const dy = target.y - projectile.y;
    const distance = Math.hypot(dx, dy);
    const hitDistance = projectile.radius + targetRadius;
    const step = projectile.speed * dt;

    if (distance <= hitDistance || step >= distance) {
      damageTarget(projectile.targetKind, projectile.targetId, projectile.damage);
      continue;
    }

    projectile.x += (dx / distance) * step;
    projectile.y += (dy / distance) * step;
    alive.push(projectile);
  }
  state.projectiles = alive;
}

function unitUpdate(unit, dt) {
  applyPending(unit);
  unit.attackTimer = Math.max(0, unit.attackTimer - dt);

  if (unit.order.type === "move") {
    if (tryAcquireAutoAttackTarget(unit)) {
      return;
    }
    const done = moveTowards(unit, unit.order.x, unit.order.y, dt);
    if (done) {
      unit.order = { type: "idle" };
    }
    return;
  }

  if (unit.order.type === "attack") {
    const target = targetStillValid(unit.order.targetKind, unit.order.targetId, unit.ownerId);
    if (!target) {
      unit.order = { type: "idle" };
      return;
    }

    const targetPos = { x: target.x, y: target.y };
    const range = unit.range + (target.radius || target.size || 0) * 0.5;
    const inRange = dist(unit, targetPos) <= range;

    if (!inRange) {
      moveTowards(unit, targetPos.x, targetPos.y, dt);
      return;
    }

    if (unit.attackTimer <= 0) {
      if (unit.type === "soldier") {
        spawnProjectile(unit, unit.order.targetKind, unit.order.targetId);
      } else {
        damageTarget(unit.order.targetKind, unit.order.targetId, unit.damage);
      }
      unit.attackTimer = unit.cooldown;
    }
    return;
  }

  if (unit.order.type === "gather") {
    const resourceNode = getResourceById(unit.order.resourceId);
    const ownHQ = getPlayerHQ(unit.ownerId);
    if (!resourceNode || !ownHQ || resourceNode.amount <= 0) {
      unit.order = { type: "idle" };
      return;
    }

    if (unit.order.phase === "toResource") {
      const arrived = moveTowards(unit, resourceNode.x, resourceNode.y, dt);
      if (arrived) {
        unit.order.phase = "gathering";
        unit.order.gatherClock = 0;
      }
      return;
    }

    if (unit.order.phase === "gathering") {
      unit.order.gatherClock += dt;
      if (unit.order.gatherClock >= 0.35) {
        unit.order.gatherClock = 0;
        if (resourceNode.amount > 0 && unit.cargo < unit.cargoMax) {
          resourceNode.amount -= 5;
          unit.cargo += 5;
        }
      }
      if (unit.cargo >= unit.cargoMax || resourceNode.amount <= 0) {
        unit.order.phase = "toHQ";
      }
      return;
    }

    if (unit.order.phase === "toHQ") {
      const arrived = moveTowards(unit, ownHQ.x, ownHQ.y, dt);
      if (arrived) {
        state.players[unit.ownerId].resources += unit.cargo;
        unit.cargo = 0;
        if (resourceNode.amount > 0) {
          unit.order.phase = "toResource";
        } else {
          unit.order = { type: "idle" };
        }
      }
    }
  }

  if (unit.order.type === "idle") {
    tryAcquireAutoAttackTarget(unit);
  }
}

function cleanupDead() {
  state.units = state.units.filter((u) => u.hp > 0);
  state.buildings = state.buildings.filter((b) => b.hp > 0);
  state.resources = state.resources.filter((r) => r.amount > 0);

  state.selectedIds = new Set([...state.selectedIds].filter((unitId) => !!getUnitById(unitId)));

  const playerHQ = getPlayerHQ(1);
  const enemyHQ = getPlayerHQ(2);
  if (!playerHQ || !enemyHQ) {
    state.gameOver = true;
    state.winner = playerHQ ? "You" : "Enemy";
    ui.status.textContent = `Status: Game Over (${state.winner} wins)`;
  }
}

function updateHQTraining(dt) {
  for (const building of state.buildings) {
    if (building.type !== "hq") {
      continue;
    }
    if (building.trainQueue.length === 0) {
      continue;
    }

    building.trainQueue[0].remaining -= dt;
    if (building.trainQueue[0].remaining <= 0) {
      const entry = building.trainQueue.shift();
      const angle = Math.random() * Math.PI * 2;
      const radius = 64;
      spawnUnit(
        building.ownerId,
        entry.type,
        building.x + Math.cos(angle) * radius,
        building.y + Math.sin(angle) * radius
      );
    }
  }
}

function queueTrain(playerId, type) {
  if (state.gameOver) {
    return;
  }

  if (isStdbMode()) {
    invokeReducer("train_unit", {
      player_id: playerId,
      unit_type: type,
      delay_seconds: 0,
    });
    return;
  }

  const stats = UNIT_STATS[type];
  const player = state.players[playerId];
  const hq = getPlayerHQ(playerId);
  if (!stats || !player || !hq) {
    return;
  }
  if (player.resources < stats.cost) {
    return;
  }
  player.resources -= stats.cost;
  hq.trainQueue.push({ type, remaining: type === "worker" ? 2.2 : 3.2 });
}

function nearestEnemyTargetFor(playerId) {
  const enemyUnit = state.units.find((u) => u.ownerId !== playerId);
  if (enemyUnit) {
    return { kind: "unit", id: enemyUnit.id };
  }
  const enemyHQ = state.buildings.find((b) => b.ownerId !== playerId);
  if (enemyHQ) {
    return { kind: "building", id: enemyHQ.id };
  }
  return null;
}

function enemyAI(dt) {
  if (state.gameOver) {
    return;
  }
  state.players[2].resources += dt * 14;

  state.enemySpawnTimer += dt;
  if (state.enemySpawnTimer >= 5.5) {
    state.enemySpawnTimer = 0;
    if (state.players[2].resources >= UNIT_STATS.soldier.cost) {
      queueTrain(2, "soldier");
    }
  }

  state.enemyAiTimer += dt;
  if (state.enemyAiTimer >= 4.5) {
    state.enemyAiTimer = 0;
    const target = nearestEnemyTargetFor(2);
    if (!target) {
      return;
    }
    const army = state.units.filter((u) => u.ownerId === 2 && u.type === "soldier");
    issueCommand(army, () => ({ type: "attack", targetKind: target.kind, targetId: target.id }));
  }

  for (const worker of state.units.filter((u) => u.ownerId === 2 && u.type === "worker")) {
    if (worker.order.type !== "idle" || worker.pending) {
      continue;
    }
    const node = state.resources[0];
    if (node) {
      worker.order = { type: "gather", resourceId: node.id, phase: "toResource", gatherClock: 0 };
    }
  }
}

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

function drawHealthBar(x, y, width, hp, maxHp) {
  const pct = Math.max(0, Math.min(1, hp / maxHp));
  ctx.fillStyle = "#111827";
  ctx.fillRect(x - width / 2, y, width, 5);
  ctx.fillStyle = pct > 0.35 ? "#22c55e" : "#ef4444";
  ctx.fillRect(x - width / 2, y, width * pct, 5);
}

function drawWorld() {
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  drawGrid();

  for (const node of state.resources) {
    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#082f49";
    ctx.fillText(Math.max(0, Math.floor(node.amount)).toString(), node.x - 12, node.y + 4);
  }

  for (const building of state.buildings) {
    const color = state.players[building.ownerId].color;
    ctx.fillStyle = color;
    ctx.fillRect(building.x - building.size / 2, building.y - building.size / 2, building.size, building.size);
    drawHealthBar(building.x, building.y - building.size / 2 - 10, 50, building.hp, building.maxHp);

    if (building.trainQueue.length > 0) {
      ctx.fillStyle = "#facc15";
      ctx.fillText(`Q:${building.trainQueue.length}`, building.x - 12, building.y + 4);
    }
  }

  for (const unit of state.units) {
    const color = state.players[unit.ownerId].color;
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

    if (unit.pending) {
      const remaining = Math.max(0, unit.pending.executeAt - state.time);
      const pct = remaining / COMMAND_DELAY;
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(unit.x, unit.y, unit.radius + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - pct));
      ctx.stroke();
    }

    drawHealthBar(unit.x, unit.y - unit.radius - 10, 26, unit.hp, unit.maxHp);
  }

  for (const projectile of state.projectiles) {
    const owner = state.players[projectile.ownerId];
    if (!owner) {
      continue;
    }
    ctx.fillStyle = owner.color;
    ctx.beginPath();
    ctx.arc(projectile.x, projectile.y, projectile.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (state.selectionBox) {
    const { x1, y1, x2, y2 } = state.selectionBox;
    ctx.strokeStyle = "#f8fafc";
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.setLineDash([]);
  }
}

function worldPosFromMouse(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function selectInBox(x1, y1, x2, y2) {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  state.selectedIds.clear();
  for (const unit of state.units) {
    if (unit.ownerId !== 1) {
      continue;
    }
    if (unit.x >= minX && unit.x <= maxX && unit.y >= minY && unit.y <= maxY) {
      state.selectedIds.add(unit.id);
    }
  }
}

function selectSingle(x, y) {
  const unit = state.units.find((u) => u.ownerId === 1 && Math.hypot(u.x - x, u.y - y) <= u.radius + 4);
  state.selectedIds.clear();
  if (unit) {
    state.selectedIds.add(unit.id);
  }
}

function hitEnemyAt(x, y) {
  const unit = state.units.find((u) => u.ownerId !== 1 && Math.hypot(u.x - x, u.y - y) <= u.radius + 4);
  if (unit) {
    return { kind: "unit", id: unit.id };
  }
  const building = state.buildings.find(
    (b) =>
      b.ownerId !== 1 &&
      x >= b.x - b.size / 2 &&
      x <= b.x + b.size / 2 &&
      y >= b.y - b.size / 2 &&
      y <= b.y + b.size / 2
  );
  if (building) {
    return { kind: "building", id: building.id };
  }
  return null;
}

function hitResourceAt(x, y) {
  return state.resources.find((r) => Math.hypot(r.x - x, r.y - y) <= r.radius + 4);
}

function getSelectedOwnedUnits() {
  return state.units.filter((u) => u.ownerId === 1 && state.selectedIds.has(u.id));
}

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (state.gameOver) {
    return;
  }

  const pos = worldPosFromMouse(e);
  const selected = getSelectedOwnedUnits();
  if (selected.length === 0) {
    return;
  }

  const enemy = hitEnemyAt(pos.x, pos.y);
  if (enemy) {
    commandAttack(selected, enemy.kind, enemy.id);
    return;
  }

  const resourceNode = hitResourceAt(pos.x, pos.y);
  if (resourceNode) {
    commandGather(selected, resourceNode.id);
    return;
  }

  commandMove(selected, pos.x, pos.y);
});

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) {
    return;
  }
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
  if (e.button !== 0 || !state.selectionBox) {
    return;
  }
  const { x1, y1, x2, y2 } = state.selectionBox;
  const tiny = Math.abs(x2 - x1) < 5 && Math.abs(y2 - y1) < 5;
  if (tiny) {
    selectSingle(x2, y2);
  } else {
    selectInBox(x1, y1, x2, y2);
  }
  state.selectionBox = null;
});

ui.trainWorker.addEventListener("click", () => queueTrain(1, "worker"));
ui.trainSoldier.addEventListener("click", () => queueTrain(1, "soldier"));
ui.stdbConnect.addEventListener("click", () => connectSpacetimeDb());

function updateUI() {
  const player = state.players[1];
  ui.resources.textContent = Math.floor(player?.resources || 0).toString();
  ui.selectedCount.textContent = getSelectedOwnedUnits().length.toString();
  const hq = getPlayerHQ(1);
  const enemyHq = getPlayerHQ(2);
  ui.hqHp.textContent = hq ? Math.max(0, Math.floor(hq.hp)).toString() : "0";
  ui.enemyHqHp.textContent = enemyHq ? Math.max(0, Math.floor(enemyHq.hp)).toString() : "0";
}

let last = performance.now();
function loop(now) {
  const frameDt = Math.min(0.05, (now - last) / 1000);
  last = now;
  state.accumulator += frameDt;

  while (state.accumulator >= SIM_TICK) {
    state.time += SIM_TICK;

    if (!state.gameOver && !isStdbMode()) {
      for (const unit of state.units) {
        unitUpdate(unit, SIM_TICK);
      }
      updateProjectiles(SIM_TICK);
      enemyAI(SIM_TICK);
      updateHQTraining(SIM_TICK);
      cleanupDead();
    }

    state.accumulator -= SIM_TICK;
  }

  drawWorld();
  updateUI();
  requestAnimationFrame(loop);
}

setupMatch();
const prefs = loadStdbPrefs();
if (prefs?.host) {
  ui.stdbHost.value = prefs.host;
}
if (prefs?.dbName) {
  ui.stdbDb.value = prefs.dbName;
}
ui.status.textContent = "Status: Running (local simulation)";
requestAnimationFrame(loop);