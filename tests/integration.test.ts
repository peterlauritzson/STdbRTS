import assert from "node:assert/strict";
import test from "node:test";
import type { DbConnection } from "../src/bindings";
import { connectClient, me, order, until } from "../scripts/client";

test("laboratory construction and logistics research use mined resources", { timeout: 90000 }, async () => {
  const builder = (await connectClient()).connection;
  const opponent = (await connectClient()).connection;
  try {
    await builder.reducers.createRoom({ name: "Research integration", capacity: 2 });
    await until(() => me(builder).matchId !== 0n, "research room");
    const matchId = me(builder).matchId;
    await opponent.reducers.joinRoom({ matchId });
    await builder.reducers.setReady({ ready: true });
    await opponent.reducers.setReady({ ready: true });
    await builder.reducers.startMatch({});
    const units = () => [...builder.db.unit.iter()].filter(row => row.matchId === matchId).map(row => row.data);
    await assert.rejects(order(builder, [2], "build_factory", { x: 440, y: 220 }), /barracks/);
    await assert.rejects(order(builder, [2], "build_lab", { x: 220, y: 220 }), /obstructed/);
    await order(builder, [3], "gather", { target: 1 });
    await order(builder, [2], "build_lab", { x: 440, y: 220 });
    assert.ok(!units().some(unit => unit.kind === "lab"));
    await until(() => units().some(unit => unit.kind === "lab"), "lab site created");
    const labId = units().find(unit => unit.kind === "lab")!.id;
    await assert.rejects(order(builder, [labId], "research_logistics"), /construction/);
    await assert.rejects(order(opponent, [6], "construct", { target: labId }), /friendly/);
    await until(() => units().find(unit => unit.id === labId)?.constructionRemaining === 0n, "lab completed by worker", 20000);
    await order(builder, [2], "gather", { target: 1 });
    await until(() => me(builder).resources >= 150, "mine research budget", 25000);
    await order(builder, [labId], "research_logistics");
    assert.ok(!units().find(unit => unit.kind === "hq" && unit.owner === 0)!.research.length);
    await until(() => units().find(unit => unit.id === labId)!.production.length === 1, "research activated");
    await assert.rejects(order(builder, [labId], "research_logistics"), /already/);
    await until(() => units().find(unit => unit.kind === "hq" && unit.owner === 0)!.research.includes("research_logistics"), "research completed", 25000);
    await until(() => units().some(unit => unit.owner === 0 && unit.kind === "worker" && unit.cargo > 25), "upgraded worker cargo", 15000);
    assert.equal(units().find(unit => unit.id === labId)!.production.length, 0);
    assert.ok(units().filter(unit => unit.kind === "worker").every(unit => unit.cargo <= 40));
  } finally {
    for (const client of [builder, opponent]) {
      try { await client.reducers.leaveRoom({}); } catch {}
      client.disconnect();
    }
  }
});

test("workers repair real combat damage through delayed reducers", { timeout: 60000 }, async () => {
  const defender = (await connectClient()).connection;
  const attacker = (await connectClient()).connection;
  try {
    await defender.reducers.createRoom({ name: "Repair integration", capacity: 2 });
    await until(() => me(defender).matchId !== 0n, "repair room");
    const matchId = me(defender).matchId;
    await attacker.reducers.joinRoom({ matchId });
    await defender.reducers.setReady({ ready: true });
    await attacker.reducers.setReady({ ready: true });
    await defender.reducers.startMatch({});
    const unit = (id: number) => defender.db.unit.id.find((matchId << 32n) | BigInt(id))!.data;
    await order(defender, [4], "move", { x: 900, y: 220 });
    await order(attacker, [8], "attack", { target: 1 });
    await until(() => unit(1).hp < 1200, "enemy damages HQ", 30000);
    await order(attacker, [8], "move", { x: 1500, y: 1500 });
    await until(() => Math.hypot(unit(8).x - unit(1).x, unit(8).y - unit(1).y) > 180, "enemy leaves firing range");
    await order(attacker, [8], "stop");
    const damaged = unit(1).hp;
    const resources = me(defender).resources;
    const requestId = crypto.randomUUID();
    await order(defender, [2], "repair", { target: 1, requestId });
    assert.equal(unit(1).hp, damaged);
    assert.equal(me(defender).resources, resources);
    await until(() => unit(1).hp > damaged, "paid repair restores health");
    const command = [...defender.db.command.iter()].find(command => command.requestId === requestId)!;
    assert.equal(command.status, "executed");
    assert.equal(command.executeTick - command.issuedTick, 20n);
    assert.equal(unit(1).hp - damaged, (resources - me(defender).resources) * 5);
    await order(defender, [2], "stop");
    await until(() => unit(2).order.kind === "stop", "repair interrupted by stop");
    const stopped = unit(1).hp;
    await order(defender, [1], "rally_move");
    await until(() => unit(1).order.kind === "rally_move", "later tick after stopped repair");
    assert.equal(unit(1).hp, stopped);
  } finally {
    for (const client of [defender, attacker]) {
      try { await client.reducers.leaveRoom({}); } catch {}
      client.disconnect();
    }
  }
});

test("authoritative multiplayer lifecycle", { timeout: 60000 }, async context => {
  const clients: DbConnection[] = [];
  const first = await connectClient();
  clients.push(first.connection);
  for (let index = 1; index < 6; index++) clients.push((await connectClient()).connection);
  let host = clients[0];
  const [second, third, fourth, outsider, outsiderPeer] = clients.slice(1);
  let matchId = 0n;
  let otherMatchId = 0n;
  try {
    await context.test("capacity, membership, readiness and host authorization", async () => {
      await host.reducers.createRoom({ name: "Integration squad", capacity: 4 });
      await until(() => me(host).matchId !== 0n, "host membership");
      matchId = me(host).matchId;
      await assert.rejects(host.reducers.startMatch({}), /two players|ready/);
      for (const client of [second, third, fourth]) await client.reducers.joinRoom({ matchId });
      await assert.rejects(outsider.reducers.joinRoom({ matchId }), /full/);
      await assert.rejects(second.reducers.createRoom({ name: "Duplicate", capacity: 2 }), /Leave/);
      await assert.rejects(second.reducers.startMatch({}), /host/);
      for (const client of [host, second, third, fourth]) await client.reducers.setReady({ ready: true });
      await host.reducers.startMatch({});
      await until(() => host.db.room.id.find(matchId)?.state === "playing", "match start");
      assert.equal([...host.db.unit.iter()].filter(unit => unit.matchId === matchId).length, 16);
      await assert.rejects(outsider.reducers.joinRoom({ matchId }), /started/);
      await assert.rejects(host.reducers.setReady({ ready: false }), /started/);
    });

    await context.test("invalid commands never mutate authoritative state", async () => {
      const balances = me(host).resources;
      await assert.rejects(order(host, [6], "move"), /another player/);
      await assert.rejects(order(host, [2], "teleport"), /Unknown/);
      await assert.rejects(order(host, [2], "move", { x: -10 }), /outside/);
      await assert.rejects(order(host, [2], "move", { x: Number.NaN }), /coordinates/);
      await assert.rejects(order(host, [1], "move"), /HQ/);
      await assert.rejects(order(host, [2], "attack", { target: 5 }), /soldiers/);
      await assert.rejects(order(host, [2], "train_soldier"), /HQ/);
      await assert.rejects(order(host, [1], "train_hq"), /Unknown/);
      await assert.rejects(order(host, [2, 2], "move"), /Duplicate/);
      await assert.rejects(order(host, [2], "hold"), /soldiers/);
      await assert.rejects(order(host, [2], "attack_move"), /soldiers/);
      await assert.rejects(order(host, [2], "rally_move"), /HQ/);
      await assert.rejects(order(host, [1], "rally_move", { x: -10 }), /outside/);
      await assert.rejects(order(host, [1], "rally_gather", { target: 999 }), /depleted/);
      await assert.rejects(order(host, [1], "cancel_production"), /empty/);
      await assert.rejects(order(host, [2], "repair", { target: 5 }), /friendly/);
      await assert.rejects(order(host, [2], "repair", { target: 1 }), /fully/);
      assert.equal(me(host).resources, balances);
    });

    await context.test("same execute tick across clients, no early movement, request deduplication", async () => {
      const requestId = crypto.randomUUID();
      const unitKey = (matchId << 32n) | 2n;
      const before = host.db.unit.id.find(unitKey)!.data;
      await order(host, [2], "move", { requestId });
      await order(host, [2], "move", { requestId });
      await until(() => [...second.db.command.iter()].some(command => command.requestId === requestId), "peer command acknowledgement");
      const scheduled = [...host.db.command.iter()].filter(command => command.requestId === requestId);
      assert.equal(scheduled.length, 1);
      const command = scheduled[0];
      assert.equal(command.executeTick - command.issuedTick, 20n);
      assert.equal(second.db.command.id.find(command.id)!.executeTick, command.executeTick);
      assert.equal(host.db.unit.id.find(unitKey)!.data.x, before.x);
      await until(() => host.db.command.id.find(command.id)?.status === "executed", "command execution");
      assert.notEqual(host.db.unit.id.find(unitKey)!.data.x, before.x);
      await until(() => second.db.command.id.find(command.id)?.status === "executed", "peer execution");
      await order(host, [2], "stop");
    });

    await context.test("production is delayed, charged once, and serialized", async () => {
      const start = me(host).resources;
      await order(host, [1], "train_worker");
      assert.equal(me(host).resources, start);
      await until(() => me(host).resources === start - 50, "production charge");
      const hq = host.db.unit.id.find((matchId << 32n) | 1n)!.data;
      assert.equal(hq.production.length, 1);
      await until(() => [...host.db.unit.iter()].filter(unit => unit.matchId === matchId && unit.data.owner === 0).length === 5, "worker trained");
      assert.equal(me(host).resources, start - 50);
    });

    await context.test("delayed tactical orders, rally inheritance and production refunds", async () => {
      const unit = (id: number) => host.db.unit.id.find((matchId << 32n) | BigInt(id))!.data;
      await order(host, [4], "attack_move", { x: 400, y: 350 });
      assert.equal(unit(4).order.kind, "stop");
      await until(() => unit(4).order.kind === "attack_move", "attack-move activation");
      await order(host, [4], "hold");
      await until(() => unit(4).order.kind === "hold", "hold activation");
      const held = { x: unit(4).x, y: unit(4).y };
      await order(host, [1], "rally_move", { x: 550, y: 400 });
      await until(() => unit(1).order.kind === "rally_move", "rally activation");
      assert.equal(unit(4).x, held.x);
      assert.equal(unit(4).y, held.y);
      await order(host, [1], "train_soldier");
      await until(() => unit(1).production.length === 1, "queued soldier");
      const paid = me(host).resources;
      await order(host, [1], "cancel_production");
      assert.equal(me(host).resources, paid);
      await until(() => me(host).resources === paid + 100, "full refund");
      assert.equal(unit(1).production.length, 0);
      assert.equal(unit(1).order.kind, "rally_move");
      await assert.rejects(order(host, [1], "cancel_production"), /empty/);
      await order(host, [1], "train_worker");
      await until(() => [...host.db.unit.iter()].some(row => row.matchId === matchId && row.data.owner === 0 && row.data.id > 17), "rallied worker birth");
      const born = [...host.db.unit.iter()].find(row => row.matchId === matchId && row.data.owner === 0 && row.data.id > 17)!.data;
      assert.equal(born.order.kind, "move");
      assert.equal(born.order.x, 550);
      await order(host, [1], "clear_rally");
      await until(() => unit(1).order.kind === "stop", "rally clear");
    });

    await context.test("independent matches cannot control each other's units", async () => {
      await outsider.reducers.createRoom({ name: "Isolated squad", capacity: 2 });
      await until(() => me(outsider).matchId !== 0n, "second room");
      otherMatchId = me(outsider).matchId;
      await outsiderPeer.reducers.joinRoom({ matchId: otherMatchId });
      await outsider.reducers.setReady({ ready: true });
      await outsiderPeer.reducers.setReady({ ready: true });
      await outsider.reducers.startMatch({});
      const firstKey = (matchId << 32n) | 2n;
      await until(() => host.db.unit.id.find(firstKey)?.data.order.kind === "stop", "first match stopped");
      const before = host.db.unit.id.find(firstKey)!.data.x;
      const requestId = crypto.randomUUID();
      await order(outsider, [2], "move", { requestId });
      await until(() => [...outsider.db.command.iter()].some(command => command.requestId === requestId && command.status === "executed"), "second match command");
      assert.equal(host.db.unit.id.find(firstKey)!.data.x, before);
      assert.notEqual(matchId, otherMatchId);
    });

    await context.test("multiple tabs and reconnect retain identity, membership and units", async () => {
      const shared = await connectClient(first.token);
      clients.push(shared.connection);
      shared.connection.disconnect();
      assert.equal(me(host).online, true);
      const identity = host.identity!;
      const count = [...host.db.unit.iter()].filter(unit => unit.matchId === matchId).length;
      host.disconnect();
      await until(() => second.db.player.identity.find(identity)?.online === false, "offline state");
      assert.equal(second.db.room.id.find(matchId)?.state, "playing");
      assert.equal([...second.db.unit.iter()].filter(unit => unit.matchId === matchId).length, count);
      const resumed = await connectClient(first.token);
      host = resumed.connection;
      clients.push(host);
      assert.ok(host.identity!.isEqual(identity));
      assert.equal(me(host).matchId, matchId);
      assert.equal([...host.db.unit.iter()].filter(unit => unit.matchId === matchId).length, count);
    });

    await context.test("elimination, victory and explicit leave preserve other matches", async () => {
      await second.reducers.leaveRoom({});
      await until(() => [...host.db.unit.iter()].filter(unit => unit.matchId === matchId && unit.data.owner === 1).length === 0, "surrender removal");
      assert.equal(host.db.room.id.find(matchId)?.state, "playing");
      await third.reducers.leaveRoom({});
      await fourth.reducers.leaveRoom({});
      await until(() => host.db.room.id.find(matchId)?.state === "finished", "victory");
      assert.equal(host.db.room.id.find(matchId)?.winner, 0);
      await assert.rejects(order(host, [2], "move"), /not running/);
      assert.equal(outsider.db.room.id.find(otherMatchId)?.state, "playing");
      await host.reducers.leaveRoom({});
      await until(() => !host.db.room.id.find(matchId), "empty room cleanup");
      assert.equal([...host.db.unit.iter()].filter(unit => unit.matchId === matchId).length, 0);
    });
  } finally {
    for (const client of clients) {
      if (client.isActive) {
        try { await client.reducers.leaveRoom({}); } catch {}
        client.disconnect();
      }
    }
  }
});