import assert from "node:assert/strict";
import test from "node:test";
import type { DbConnection } from "../src/bindings";
import { connectClient, me, order, until } from "../scripts/client";

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