import assert from "node:assert/strict";
import test from "node:test";
import { tables, type DbConnection } from "../src/bindings";
import { connectClient, me, order, until } from "../scripts/client";

// Mirrors the opening stipend in rts_core (DECISIONS.md, 2026-09-22): 200
// material per minute for 90s, then 100 per minute for 90s, then nothing,
// accumulated in whole ticks at 20 TPS. It is duplicated here so the balance
// assertions below can stay exact rather than being loosened into
// inequalities. If the Rust constants move, this must move with them.
const STIPEND_FIRST_END = 1800n;
const STIPEND_SECOND_END = 3600n;
function stipendTotal(tick: bigint): bigint {
  const first = tick < STIPEND_FIRST_END ? tick : STIPEND_FIRST_END;
  const second = tick <= STIPEND_FIRST_END ? 0n : (tick < STIPEND_SECOND_END ? tick : STIPEND_SECOND_END) - STIPEND_FIRST_END;
  return first / 6n + second / 12n;
}

// Catalyst is per-base now, like gas: deposit 1 sits in the main mineral line,
// so tech is paid for at home rather than by walking to the middle of the map.
test("laboratory construction and logistics research use mined resources", { timeout: 240000 }, async () => {
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
    // Faction follows the slot: the host is Industrial and mines with workers 2
    // and 3, and the peer is Network and holds drifters 6 and 7. Every unit id
    // used below is read against that, not against a shared roster.
    assert.equal(me(builder).faction.tag, "Industrial");
    assert.equal(me(opponent).faction.tag, "Network");
    const units = () => [...builder.db.unit.iter()].filter(row => row.matchId === matchId).map(row => row.data);
    assert.deepEqual(units().filter(unit => unit.owner === 0 && unit.kind === "worker").map(unit => unit.id), [2, 3]);
    assert.deepEqual(units().filter(unit => unit.owner === 1 && unit.kind === "drifter").map(unit => unit.id), [6, 7]);
    await assert.rejects(order(builder, [2], "build_factory", { x: 680, y: 720 }), /barracks/);
    // Placement is checked before cost, so a blocked site reports the ground.
    await assert.rejects(order(builder, [2], "build_lab", { x: 870, y: 700 }), /terrain/);
    // A lab (like a factory) now needs a completed barracks first, and that is
    // checked ahead of cost too — so the catalyst rejection below can only be
    // observed once the prerequisite is met. (400, 800) sits off the mineral
    // arc: clear of terrain, more than 75 from every deposit, at least 110 from
    // both the hub and the (680, 720) lab site used later, and within 500 of
    // the hub. Worker 2 builds it.
    await order(builder, [2], "build_barracks", { x: 400, y: 800 });
    await until(() => units().some(unit => unit.kind === "barracks"), "barracks site created");
    const barracksId = units().find(unit => unit.kind === "barracks")!.id;
    // Worker 3 starts the material line while the barracks goes up, so the 150
    // material it cost has time to be earned back before the isolation check
    // below runs.
    await order(builder, [3], "gather", { target: 2 });
    await until(() => units().find(unit => unit.id === barracksId)?.constructionRemaining === 0n, "barracks completed", 20000);
    await until(() => me(builder).material >= 150, "recover material spent on the barracks", 60000);
    // ...and a clear but unaffordable site reports the money: catalyst starts at
    // zero, and a laboratory costs 50 of it.
    await assert.rejects(order(builder, [2], "build_lab", { x: 680, y: 720 }), /catalyst/);
    // A laboratory costs 150 material AND 50 catalyst, and catalyst exists only
    // at the two central deposits — so tech cannot be opened from the starting
    // balance at all, the middle of the map has to be worked first. Worker 3
    // already holds the material line while worker 2, free again, walks to the
    // nearest catalyst.
    await order(builder, [2], "gather", { target: 1 });
    await assert.rejects(order(builder, [2], "build_lab", { x: 440, y: 220 }), /catalyst/);
    await until(
      () => me(builder).material >= 150 && me(builder).catalyst >= 50,
      "mine the laboratory down payment in both currencies",
      90000,
    );
    await order(builder, [2], "build_lab", { x: 680, y: 720 });
    assert.ok(!units().some(unit => unit.kind === "lab"));
    await until(() => units().some(unit => unit.kind === "lab"), "lab site created");
    const labId = units().find(unit => unit.kind === "lab")!.id;
    await assert.rejects(order(builder, [labId], "research_logistics"), /construction/);
    // Unit 6 is the peer's drifter. It is labour, so it could construct — what
    // stops it is that the site belongs to somebody else, and the refusal says
    // exactly that rather than complaining about the unit.
    await assert.rejects(order(opponent, [6], "construct", { target: labId }), /labour unit and an unfinished friendly building/);
    // A drifter has no return trip at all, and is refused one by name.
    await assert.rejects(order(opponent, [6], "return"), /Drifters never carry a load/);
    await until(() => units().find(unit => unit.id === labId)?.constructionRemaining === 0n, "lab completed by worker", 20000);
    // Research costs another 100 material and 50 catalyst, so the centre has to
    // be worked a second time.
    await order(builder, [2], "gather", { target: 1 });
    await until(
      () => me(builder).material >= 100 && me(builder).catalyst >= 50,
      "mine research budget in both currencies",
      90000,
    );
    await order(builder, [labId], "research_logistics");
    assert.ok(!units().find(unit => unit.kind === "hq" && unit.owner === 0)!.research.length);
    await until(() => units().find(unit => unit.id === labId)!.production.length === 1, "research activated");
    await assert.rejects(order(builder, [labId], "research_logistics"), /already/);
    await until(() => units().find(unit => unit.kind === "hq" && unit.owner === 0)!.research.includes("research_logistics"), "research completed", 25000);
    await until(() => units().some(unit => unit.owner === 0 && unit.kind === "worker" && unit.cargo > 25), "upgraded worker cargo", 15000);
    assert.equal(units().find(unit => unit.id === labId)!.production.length, 0);
    assert.ok(units().filter(unit => unit.kind === "worker").every(unit => unit.cargo <= 40));
    // Logistics raises a carrier's load. It cannot raise a drifter's, because a
    // drifter has no load: every one of them still holds exactly nothing.
    assert.ok(units().filter(unit => unit.kind === "drifter").every(unit => unit.cargo === 0 && !unit.returning));
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
    await order(defender, [4], "move", { x: 1100, y: 600 });
    await order(attacker, [8], "attack", { target: 1 });
    // Cross-spawn on this map is 2000 units, about 18 seconds of walking.
    await until(() => unit(1).hp < 1200, "enemy damages HQ", 60000);
    await order(attacker, [8], "move", { x: 1500, y: 1500 });
    await until(() => Math.hypot(unit(8).x - unit(1).x, unit(8).y - unit(1).y) > 180, "enemy leaves firing range");
    await order(attacker, [8], "stop");
    const damaged = unit(1).hp;
    const tickAtSample = defender.db.room.id.find(matchId)!.tick;
    const resources = me(defender).material;
    // The stipend credits material while this runs, so every balance below is
    // compared net of what the stipend paid since the sample above.
    const credited = () => Number(stipendTotal(defender.db.room.id.find(matchId)!.tick) - stipendTotal(tickAtSample));
    const requestId = crypto.randomUUID();
    await order(defender, [2], "repair", { target: 1, requestId });
    assert.equal(unit(1).hp, damaged);
    assert.equal(me(defender).material - credited(), resources, "a delayed repair has not charged yet");
    await until(() => unit(1).hp > damaged, "paid repair restores health");
    const command = [...defender.db.command.iter()].find(command => command.requestId === requestId)!;
    assert.equal(command.status, "executed");
    assert.equal(command.executeTick - command.issuedTick, 20n);
    const spent = resources + credited() - me(defender).material;
    assert.equal(unit(1).hp - damaged, spent * 5, "repair heals five hit points per material spent");
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

// A four-player room covers the whole faction rotation in one match — slots 0
// and 3 Industrial, 1 Network, 2 Organic — so the three mining models are
// exercised against each other rather than one at a time. The extra subtest
// walks a drifter to a deposit and lets an Organic hub accrue stock, which is
// why the budget is larger than it was.
test("authoritative multiplayer lifecycle", { timeout: 120000 }, async context => {
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
      // Labour auto-gathers from tick 0. Several subtests below measure the
      // host's material against nothing but the stipend, so its own workers
      // (2 and 3) are stood down here, once, before any of those run — a
      // delivery landing inside one of those windows would otherwise credit
      // material the stipend math doesn't know about and fail the assertion
      // by exactly a cargo load.
      await order(host, [2], "stop");
      await order(host, [3], "stop");
      await until(
        () => host.db.unit.id.find((matchId << 32n) | 2n)?.data.order.kind === "stop"
          && host.db.unit.id.find((matchId << 32n) | 3n)?.data.order.kind === "stop",
        "host labour stands down before balance-sensitive subtests",
      );
      await new Promise(resolve => setTimeout(resolve, 1500));
    });

    await context.test("invalid commands never mutate authoritative state", async () => {
      const balanceTick = host.db.room.id.find(matchId)!.tick;
      const balances = me(host).material;
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
      // Net of the stipend: rejected commands must not move the balance at all.
      const stipendSince = Number(stipendTotal(host.db.room.id.find(matchId)!.tick) - stipendTotal(balanceTick));
      assert.equal(me(host).material - stipendSince, balances);
    });

    await context.test("same execute tick across clients, no early movement, request deduplication", async () => {
      const requestId = crypto.randomUUID();
      const unitKey = (matchId << 32n) | 2n;
      // Unit 2's labour was stood down back in the first subtest, so this is a
      // stable baseline rather than a snapshot of an in-flight gather order.
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
      const startTick = host.db.room.id.find(matchId)!.tick;
      const start = me(host).material;
      const net = () => me(host).material - Number(stipendTotal(host.db.room.id.find(matchId)!.tick) - stipendTotal(startTick));
      await order(host, [1], "train_worker");
      // The room and player tables arrive as separate subscription updates, so
      // a snapshot taken the instant the reducer call resolves can catch the
      // tick one message ahead of the material it credits. A short settle
      // avoids that false read without loosening the exact check below.
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(net(), start);
      await until(() => net() === start - 50, "production charge");
      const hq = host.db.unit.id.find((matchId << 32n) | 1n)!.data;
      assert.equal(hq.production.length, 1);
      await until(() => [...host.db.unit.iter()].filter(unit => unit.matchId === matchId && unit.data.owner === 0).length === 5, "worker trained");
      assert.equal(net(), start - 50, "a worker is charged exactly once");
    });

    await context.test("delayed tactical orders, rally inheritance and production refunds", async () => {
      const unit = (id: number) => host.db.unit.id.find((matchId << 32n) | BigInt(id))!.data;
      await order(host, [4], "attack_move", { x: 400, y: 350 });
      assert.equal(unit(4).order.kind, "stop");
      await until(() => unit(4).order.kind === "attack_move", "attack-move activation");
      await order(host, [4], "hold");
      await until(() => unit(4).order.kind === "hold", "hold activation");
      const held = { x: unit(4).x, y: unit(4).y };
      // Soldiers are trained at a barracks now, not the HQ, so one has to exist
      // and finish building before it can be targeted. (400, 800) is the same
      // clear, off-arc site used in the laboratory test: >=110 from the hub
      // and every other building, >=75 from every deposit, and within 500 of
      // the hub.
      await order(host, [3], "build_barracks", { x: 400, y: 800 });
      await until(
        () => [...host.db.unit.iter()].some(row => row.matchId === matchId && row.data.owner === 0 && row.data.kind === "barracks"),
        "barracks site created",
      );
      const barracksId = [...host.db.unit.iter()].find(row => row.matchId === matchId && row.data.owner === 0 && row.data.kind === "barracks")!.data.id;
      await until(() => unit(barracksId).constructionRemaining === 0n, "barracks completed", 20000);
      await order(host, [1], "rally_move", { x: 550, y: 400 });
      await until(() => unit(1).order.kind === "rally_move", "rally activation");
      assert.equal(unit(4).x, held.x);
      assert.equal(unit(4).y, held.y);
      // The rally belongs to whatever produces, and soldiers come from the
      // barracks now, so the rally under test for the soldier lives there too.
      await order(host, [barracksId], "rally_move", { x: 550, y: 400 });
      await until(() => unit(barracksId).order.kind === "rally_move", "barracks rally activation");
      await order(host, [barracksId], "train_soldier");
      await until(() => unit(barracksId).production.length === 1, "queued soldier");
      const paidTick = host.db.room.id.find(matchId)!.tick;
      const paid = me(host).material;
      const netPaid = () => me(host).material - Number(stipendTotal(host.db.room.id.find(matchId)!.tick) - stipendTotal(paidTick));
      await order(host, [barracksId], "cancel_production");
      assert.equal(netPaid(), paid, "a delayed cancellation has not refunded yet");
      await until(() => netPaid() === paid + 100, "full refund");
      assert.equal(unit(barracksId).production.length, 0);
      assert.equal(unit(barracksId).order.kind, "rally_move");
      await assert.rejects(order(host, [barracksId], "cancel_production"), /empty/);
      await order(host, [1], "train_worker");
      // A newly spawned unit and its inherited rally order can arrive as
      // separate subscription updates, so wait for the order to have caught
      // up too, not just for the unit row to exist.
      await until(
        () => [...host.db.unit.iter()].some(row => row.matchId === matchId && row.data.owner === 0 && row.data.kind === "worker" && row.data.id > barracksId && row.data.order.kind === "move"),
        "rallied worker birth",
      );
      const born = [...host.db.unit.iter()].find(row => row.matchId === matchId && row.data.owner === 0 && row.data.kind === "worker" && row.data.id > barracksId)!.data;
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

    await context.test("factions are dealt by slot and each labour unit mines by its own model", async () => {
      // rules::faction_for_slot, which is deterministic and total: the same
      // slot always yields the same faction, whatever order people joined in.
      assert.equal(me(host).faction.tag, "Industrial");
      assert.equal(me(second).faction.tag, "Network");
      assert.equal(me(third).faction.tag, "Organic");
      assert.equal(me(fourth).faction.tag, "Industrial");
      const all = () => [...host.db.unit.iter()].filter(row => row.matchId === matchId).map(row => row.data);
      const find = (id: number) => all().find(unit => unit.id === id)!;
      // Every slot bootstrapped with two of its own labour, not two workers.
      const labourOf = (owner: number) => all().filter(unit => unit.owner === owner && ["worker", "drifter", "harvester"].includes(unit.kind)).map(unit => unit.kind);
      assert.deepEqual(labourOf(1), ["drifter", "drifter"]);
      assert.deepEqual(labourOf(2), ["harvester", "harvester"]);
      assert.deepEqual(labourOf(3), ["worker", "worker"]);

      // No faction may train another's labour, and the refusal names both.
      await assert.rejects(order(host, [1], "train_harvester"), /organic faction can train a harvester; you are playing industrial/);
      await assert.rejects(order(third, [9], "train_worker"), /industrial faction can train a worker; you are playing organic/);
      await assert.rejects(order(second, [5], "train_harvester"), /organic faction/);
      // A harvester is labour and nothing else: it is refused a fight by name.
      await assert.rejects(order(third, [10], "attack_move", { x: 700, y: 500 }), /Harvesters cannot fight/);

      // Network: the drifter credits where it stands. It is walked to whichever
      // deposit is nearest rather than to a pinned id, so this survives the map.
      const drifter = find(6);
      const nearest = [...second.db.resource_node.iter()]
        .filter(row => row.matchId === matchId && row.data.amount > 0)
        .map(row => row.data)
        .sort((left, right) => Math.hypot(left.x - drifter.x, left.y - drifter.y) - Math.hypot(right.x - drifter.x, right.y - drifter.y))[0];
      const driftTick = host.db.room.id.find(matchId)!.tick;
      const driftStart = me(second).material;
      const driftStipend = () => Number(stipendTotal(host.db.room.id.find(matchId)!.tick) - stipendTotal(driftTick));
      await order(second, [6], "gather", { target: nearest.id });
      // Five material is twenty-five ticks of drifting: well clear of a rounding
      // edge in the stipend, and impossible to reach by stipend alone.
      await until(() => me(second).material - driftStipend() >= driftStart + 5, "the drifter credits in place", 40000);
      // ...and it did it without ever holding or hauling anything.
      assert.equal(find(6).cargo, 0, "a drifter never holds a load");
      assert.equal(find(6).returning, false, "a drifter never makes a return trip");
      assert.equal(find(6).order.kind, "gather", "and it stays on the deposit");

      // Organic creep persists as its own table, keyed like a unit row. The
      // shared test client does not subscribe to it, so the host adds it here;
      // the last subtest relies on this subscription to see room cleanup.
      await new Promise<void>((resolve, reject) => {
        host.subscriptionBuilder()
          .onApplied(() => resolve())
          .onError(context => reject(context.event ?? new Error("creep subscription failed")))
          .subscribe([tables.creep_patch]);
      });
      const patches = () => [...host.db.creep_patch.iter()].filter(row => row.matchId === matchId).map(row => row.data);
      // Only the Organic HQ (unit 9) opens on creep, already at its full 360
      // radius (rules::creep_max_radius("hq")), with a live source.
      const hqPatch = host.db.creep_patch.id.find((matchId << 32n) | 9n)?.data;
      assert.ok(hqPatch, "the organic HQ has a creep patch from the start");
      assert.equal(hqPatch.owner, 2);
      assert.equal(hqPatch.radius, 360);
      assert.equal(hqPatch.maxRadius, 360);
      assert.equal(hqPatch.lostTick, 0n);
      assert.deepEqual(patches().map(patch => patch.source), [9], "no other faction spreads creep");

      // Organic: labour is free of currency and limited by hub stock, which
      // regenerates on its own and stops at the cap.
      await until(() => find(9).stock > 0, "the organic hub accrues stock", 20000);
      assert.ok(find(9).stock <= 7, "hub stock never passes the cap");
      // An Industrial hub accrues none of it, ever.
      assert.equal(find(1).stock, 0, "only organic hubs hold stock");
      // Labour now opens already mining, so this player's own harvesters would
      // be delivering into the balance while it is measured. Still them first,
      // and let the stop orders activate, so the only movement left in the
      // number is the stipend — which is accounted for exactly.
      await order(third, [10], "stop");
      await order(third, [11], "stop");
      await until(() => find(10).order.kind === "stop" && find(11).order.kind === "stop", "organic labour stands down");
      await new Promise(resolve => setTimeout(resolve, 1500));
      const stockTick = host.db.room.id.find(matchId)!.tick;
      const organicStart = me(third).material;
      await order(third, [9], "train_harvester");
      await until(() => find(9).production.length === 1, "harvester queued");
      const organicStipend = Number(stipendTotal(host.db.room.id.find(matchId)!.tick) - stipendTotal(stockTick));
      assert.equal(me(third).material - organicStipend, organicStart, "a harvester costs no material at all");
      assert.equal(me(third).catalyst, 0, "and no catalyst either");
      await until(() => all().some(unit => unit.owner === 2 && unit.kind === "harvester" && unit.id > 16), "harvester born", 20000);
      assert.equal(labourOf(2).length, 3);
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
      assert.equal([...host.db.creep_patch.iter()].filter(row => row.matchId === matchId).length, 0, "creep is dropped with the room");
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