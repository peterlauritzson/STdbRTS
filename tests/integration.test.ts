import assert from "node:assert/strict";
import test from "node:test";
import { tables, type DbConnection } from "../src/bindings";
import { connectClient, me, order, until } from "../scripts/client";
import { UnitMerger } from "../src/units";

const merger = new UnitMerger();

// Mirrors the base income in rts_core (DECISIONS.md, 2026-09-22, made permanent
// in step 27): 200 material per minute for 90s, then 100 per minute for good,
// accumulated in whole ticks at 20 TPS. It is duplicated here so the balance
// assertions below can stay exact rather than being loosened into
// inequalities. If the Rust constants move, this must move with them.
const STIPEND_FIRST_END = 1800n;
function stipendTotal(tick: bigint): bigint {
  const first = tick < STIPEND_FIRST_END ? tick : STIPEND_FIRST_END;
  const second = tick <= STIPEND_FIRST_END ? 0n : tick - STIPEND_FIRST_END;
  return first / 6n + second / 12n;
}

// Three currencies, one purpose each: the lab and research are material, the
// army is catalyst (extracted by a refinery on a deposit, never by labour) and
// the turret is terrazine (a by-product of material mined).
test("laboratory construction, a refinery and logistics research use mined resources", { timeout: 240000 }, async () => {
  const builder = (await connectClient()).connection;
  const opponent = (await connectClient()).connection;
  try {
    await builder.reducers.createRoom({ name: "Research integration", capacity: 2, commandDelay: 20n });
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
    const units = () => merger.collect(builder.db, matchId);
    assert.deepEqual(units().filter(unit => unit.owner === 0 && unit.kind === "worker").map(unit => unit.id), [2, 3]);
    assert.deepEqual(units().filter(unit => unit.owner === 1 && unit.kind === "drifter").map(unit => unit.id), [6, 7]);
    // Coordinates are on the expanse main, HQ at (850, 850): the same layout as
    // crossfire's main shifted by (+250, +250), mineral arc to the north-west.
    await assert.rejects(order(builder, [2], "build_factory", { x: 930, y: 970 }), /barracks/);
    // Placement is checked before cost, so a blocked site reports the ground:
    // the west wall of the main's ramp, rect [860, 1540, 40, 320].
    await assert.rejects(order(builder, [2], "build_lab", { x: 880, y: 1600 }), /terrain/);
    // A lab (like a factory) now needs a completed barracks first, and that is
    // checked ahead of cost too — so the catalyst rejection below can only be
    // observed once the prerequisite is met. (650, 1050) sits off the mineral
    // arc: clear of terrain, more than 75 from every deposit, at least 110 from
    // both the hub and the (930, 970) lab site used later, and within 500 of
    // the hub. Worker 2 builds it.
    await order(builder, [2], "build_barracks", { x: 650, y: 1050 });
    await until(() => units().some(unit => unit.kind === "barracks"), "barracks site created");
    const barracksId = units().find(unit => unit.kind === "barracks")!.id;
    // Worker 3 starts the material line while the barracks goes up, so the 150
    // material it cost has time to be earned back.
    await order(builder, [3], "gather", { target: 2 });
    await until(() => units().find(unit => unit.id === barracksId)?.constructionRemaining === 0n, "barracks completed", 20000);
    // Labour never mines catalyst: the order is refused and says what to build.
    await assert.rejects(order(builder, [2], "gather", { target: 1 }), /refinery/);
    // A refinery has to stand on a catalyst deposit.
    await assert.rejects(order(builder, [2], "build_refinery", { x: 1300, y: 1300 }), /catalyst deposit/);
    // Aimed near deposit 10, it snaps onto it, costs 75 material, and then
    // extracts on its own with nobody working it.
    const catalystBefore = me(builder).catalyst;
    await order(builder, [2], "build_refinery", { x: 1020, y: 730 });
    await until(() => units().some(unit => unit.kind === "refinery"), "refinery site created");
    const refinery = units().find(unit => unit.kind === "refinery")!;
    const deposit = [...builder.db.resource_node.iter()].find(row => row.matchId === matchId && row.data.id === 10)!.data;
    assert.deepEqual([refinery.x, refinery.y], [deposit.x, deposit.y], "snapped onto the deposit");
    await until(() => units().find(unit => unit.id === refinery.id)?.constructionRemaining === 0n, "refinery raised itself", 20000);
    await until(() => me(builder).catalyst >= catalystBefore + 8, "the refinery extracts catalyst without workers", 20000);
    assert.ok(me(builder).collectedCatalyst > 0, "extraction is mined income");
    // One refinery to a deposit.
    await assert.rejects(order(builder, [2], "build_refinery", { x: 1026, y: 727 }), /already has a refinery/);
    // A turret is bought with terrazine, which only mining earns: refused now.
    await assert.rejects(order(builder, [2], "build_turret", { x: 930, y: 970 }), /terrazine/);
    await until(() => me(builder).material >= 200, "mine the laboratory price in material", 90000);
    assert.ok(me(builder).terrazine > 0, "mining paid a terrazine by-product");
    await order(builder, [2], "build_lab", { x: 930, y: 970 });
    assert.ok(!units().some(unit => unit.kind === "lab"));
    await until(() => units().some(unit => unit.kind === "lab"), "lab site created");
    const labId = units().find(unit => unit.kind === "lab")!.id;
    // Nothing constructs any more: the old worker order is gone, and a placed
    // site can be neither worked on nor cancelled.
    await assert.rejects(order(opponent, [6], "construct", { target: labId }), /Unknown order/);
    await assert.rejects(order(builder, [labId], "cancel_construction"), /construction/);
    // A drifter has no return trip at all, and is refused one by name.
    await assert.rejects(order(opponent, [6], "return"), /Drifters never carry a load/);
    await until(() => units().find(unit => unit.id === labId)?.constructionRemaining === 0n, "lab raised itself", 20000);
    // Research is instant, needs no lab and is ordered in the name of any own
    // unit (the client names the HQ). It costs 150 material.
    const hqId = units().find(unit => unit.owner === 0 && unit.kind === "hq")!.id;
    await until(() => me(builder).material >= 150, "mine the research budget in material", 90000);
    await order(builder, [hqId], "research_logistics");
    assert.ok(!units().some(unit => unit.production.length), "nothing queues anywhere");
    await until(() => me(builder).research.includes("research_logistics"), "research is bought at once", 5000);
    await assert.rejects(order(builder, [hqId], "research_logistics"), /Already researched/);
    await until(() => units().some(unit => unit.owner === 0 && unit.kind === "worker" && unit.cargo > 25), "upgraded worker cargo", 15000);
    assert.ok(units().filter(unit => unit.kind === "worker").every(unit => unit.cargo <= 40));
    // Tiers: in order, 300 material, and the units wait for them.
    await assert.rejects(order(builder, [hqId], "tier_2"), /Requires Tier 1 first/);
    await assert.rejects(order(builder, [barracksId], "train_marksman"), /Requires Tier 1/);
    await until(() => me(builder).material >= 300, "mine the tier 1 price in material", 120000);
    await order(builder, [hqId], "tier_1");
    await until(() => me(builder).research.includes("tier_1"), "tier 1 is bought at once", 5000);
    await assert.rejects(order(builder, [hqId], "tier_1"), /Already researched/);
    await assert.rejects(order(builder, [hqId], "tier_2"), /factory/);
    await assert.rejects(order(builder, [barracksId], "train_bulwark"), /Production requires|Requires Tier 2/);
    // Logistics raises a carrier's load. It cannot raise a drifter's, because a
    // drifter has no load: every one of them still holds exactly nothing.
    assert.ok(units().filter(unit => unit.kind === "drifter").every(unit => unit.cargo === 0));
  } finally {
    for (const client of [builder, opponent]) {
      try { await client.reducers.leaveRoom({}); } catch {}
      client.disconnect();
    }
  }
});

test("workers repair real combat damage through delayed reducers", { timeout: 240000 }, async () => {
  const defender = (await connectClient()).connection;
  const attacker = (await connectClient()).connection;
  try {
    await defender.reducers.createRoom({ name: "Repair integration", capacity: 2, commandDelay: 20n });
    await until(() => me(defender).matchId !== 0n, "repair room");
    const matchId = me(defender).matchId;
    await attacker.reducers.joinRoom({ matchId });
    await defender.reducers.setReady({ ready: true });
    await attacker.reducers.setReady({ ready: true });
    await defender.reducers.startMatch({});
    const unit = (id: number) => merger.find(defender.db, (matchId << 32n) | BigInt(id))!;
    // Labour opens already mining. A delivery landing inside the measured
    // window would credit a whole load and break the material arithmetic
    // below, so the defender's workers are stilled first — exactly what the
    // Rust tests' `idle_labour` does. It used to pass by timing luck.
    await order(defender, [2, 3], "stop");
    // The defender's fighter is parked in the far corner of its main, out of
    // range of wherever the attacker comes in.
    await order(defender, [4], "move", { x: 300, y: 300 });
    await order(attacker, [8], "attack", { target: 1 });
    // Cross-spawn on expanse is 7900 units in a straight line, more around the
    // walls of both mains: about a minute and a half of walking.
    await until(() => unit(1).hp < 1200, "enemy damages HQ", 180000);
    // Out through the main's ramp to the south.
    await order(attacker, [8], "move", { x: 1050, y: 2000 });
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
      await host.reducers.createRoom({ name: "Integration squad", capacity: 4, commandDelay: 20n });
      await until(() => me(host).matchId !== 0n, "host membership");
      matchId = me(host).matchId;
      await assert.rejects(host.reducers.startMatch({}), /two players|ready/);
      for (const client of [second, third, fourth]) await client.reducers.joinRoom({ matchId });
      await assert.rejects(outsider.reducers.joinRoom({ matchId }), /full/);
      await assert.rejects(second.reducers.createRoom({ name: "Duplicate", capacity: 2, commandDelay: 20n }), /Leave/);
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
        () => merger.find(host.db, (matchId << 32n) | 2n)?.order.kind === "stop"
          && merger.find(host.db, (matchId << 32n) | 3n)?.order.kind === "stop",
        "host labour stands down before balance-sensitive subtests",
      );
      await new Promise(resolve => setTimeout(resolve, 1500));
    });

    await context.test("invalid commands never mutate authoritative state", async () => {
      const balanceTick = host.db.room.id.find(matchId)!.tick;
      const balances = me(host).material;
      await assert.rejects(order(host, [6], "move"), /another player/);
      await assert.rejects(order(host, [2], "summon"), /Unknown/);
      // Teleport is a real order now, and an Industrial unit has no field to use it in.
      await assert.rejects(order(host, [2], "teleport"), /power field/);
      await assert.rejects(order(host, [2], "move", { x: -10 }), /outside/);
      await assert.rejects(order(host, [2], "move", { x: Number.NaN }), /coordinates/);
      await assert.rejects(order(host, [1], "move"), /HQ/);
      await assert.rejects(order(host, [2], "attack", { target: 5 }), /fighting units/);
      await assert.rejects(order(host, [2], "train_soldier"), /HQ/);
      await assert.rejects(order(host, [1], "train_hq"), /Unknown/);
      await assert.rejects(order(host, [2, 2], "move"), /Duplicate/);
      await assert.rejects(order(host, [2], "hold"), /fighting units/);
      await assert.rejects(order(host, [2], "attack_move"), /fighting units/);
      await assert.rejects(order(host, [2], "rally_move"), /HQ/);
      await assert.rejects(order(host, [1], "rally_move", { x: -10 }), /outside/);
      await assert.rejects(order(host, [1], "rally_gather", { target: 999 }), /depleted/);
      await assert.rejects(order(host, [1], "cancel_production"), /empty/);
      await assert.rejects(order(host, [2], "gather", { target: 1 }), /refinery/);
      await assert.rejects(order(host, [1], "rally_gather", { target: 1 }), /refinery/);
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
      const before = merger.find(host.db, unitKey)!;
      await order(host, [2], "move", { requestId });
      await order(host, [2], "move", { requestId });
      await until(() => [...second.db.command.iter()].some(command => command.requestId === requestId), "peer command acknowledgement");
      const scheduled = [...host.db.command.iter()].filter(command => command.requestId === requestId);
      assert.equal(scheduled.length, 1);
      const command = scheduled[0];
      assert.equal(command.executeTick - command.issuedTick, 20n);
      assert.equal(second.db.command.id.find(command.id)!.executeTick, command.executeTick);
      assert.equal(merger.find(host.db, unitKey)!.x, before.x);
      await until(() => host.db.command.id.find(command.id)?.status === "executed", "command execution");
      assert.notEqual(merger.find(host.db, unitKey)!.x, before.x);
      await until(() => second.db.command.id.find(command.id)?.status === "executed", "peer execution");
      await order(host, [2], "stop");
    });

    await context.test("a stamped order runs on its stamp; a stamp that skips the delay is clamped", async () => {
      const find = (requestId: string) => [...host.db.command.iter()].find(command => command.requestId === requestId);
      // Stamped the way the client does: the newest tick seen plus the delay.
      const onTime = crypto.randomUUID();
      await order(host, [2], "stop", { requestId: onTime, requestedTick: host.db.room.id.find(matchId)!.tick + 20n });
      await until(() => find(onTime) !== undefined, "stamped command row");
      const stamped = find(onTime)!;
      assert.equal(stamped.executeTick, stamped.requestedTick, "a local round trip is well inside the allowance");
      // A modified client asking for the next tick gains the allowance, no more.
      const early = crypto.randomUUID();
      await order(host, [2], "stop", { requestId: early, requestedTick: 1n });
      await until(() => find(early) !== undefined, "clamped command row");
      assert.equal(find(early)!.executeTick - find(early)!.issuedTick, 14n);
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
      const hq = merger.find(host.db, (matchId << 32n) | 1n)!;
      assert.equal(hq.production.length, 1);
      await until(() => [...host.db.unit.iter()].filter(unit => unit.matchId === matchId && unit.data.owner === 0).length === 5, "worker trained");
      assert.equal(net(), start - 50, "a worker is charged exactly once");
    });

    await context.test("delayed tactical orders, rally inheritance and production refunds", async () => {
      const unit = (id: number) => merger.find(host.db, (matchId << 32n) | BigInt(id))!;
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
      // A soldier is catalyst only, so the refund is read in catalyst: no
      // stipend or delivery can move it.
      const paid = me(host).catalyst;
      await order(host, [barracksId], "cancel_production");
      assert.equal(me(host).catalyst, paid, "a delayed cancellation has not refunded yet");
      await until(() => me(host).catalyst === paid + 100, "full refund");
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
      await outsider.reducers.createRoom({ name: "Isolated squad", capacity: 2, commandDelay: 20n });
      await until(() => me(outsider).matchId !== 0n, "second room");
      otherMatchId = me(outsider).matchId;
      await outsiderPeer.reducers.joinRoom({ matchId: otherMatchId });
      await outsider.reducers.setReady({ ready: true });
      await outsiderPeer.reducers.setReady({ ready: true });
      await outsider.reducers.startMatch({});
      const firstKey = (matchId << 32n) | 2n;
      await until(() => merger.find(host.db, firstKey)?.order.kind === "stop", "first match stopped");
      const before = merger.find(host.db, firstKey)!.x;
      const requestId = crypto.randomUUID();
      await order(outsider, [2], "move", { requestId });
      await until(() => [...outsider.db.command.iter()].some(command => command.requestId === requestId && command.status === "executed"), "second match command");
      assert.equal(merger.find(host.db, firstKey)!.x, before);
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
      const all = () => merger.collect(host.db, matchId);
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
        .filter(row => row.matchId === matchId && row.data.amount > 0 && row.data.kind.tag === "Material")
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
      // (`returning` is server-only now; cargo 0 and the order staying "gather" cover the same ground.)
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
      assert.equal(me(third).catalyst, 100, "and no catalyst either: the opening 100 is untouched");
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