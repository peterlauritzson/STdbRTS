import { connectClient, me, order } from "./client";
import { chooseOrders } from "./bot-policy";
import { factionOf } from "../src/catalog";
import { UnitMerger } from "../src/units";

const roomArgument = process.argv.find(argument => /^--room=/.test(argument))?.split("=")[1];
const durationArgument = process.argv.find(argument => /^--duration=/.test(argument))?.split("=")[1];
const duration = durationArgument ? Number(durationArgument) : undefined;
if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) throw new Error("Duration must be positive seconds");
const { connection } = await connectClient();
const merger = new UnitMerger();
let stopped = false;
let busy = false;
const started = Date.now();

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  try { await connection.reducers.leaveRoom({}); }
  finally { connection.disconnect(); }
}

await connection.reducers.setName({ name: "Basin Automaton" });
if (roomArgument) await connection.reducers.joinRoom({ matchId: BigInt(roomArgument) });
else await connection.reducers.createRoom({ name: "Practice / Automaton", capacity: 2, commandDelay: 20n });
await connection.reducers.setReady({ ready: true });
console.log("Practice bot ready. Join its room and mark Ready, or deploy if you are the host.");

const timer = setInterval(async () => {
  if (busy || stopped) return;
  busy = true;
  try {
    if (duration !== undefined && Date.now() - started >= duration * 1000) { await shutdown(); return; }
    const player = me(connection);
    const room = connection.db.room.id.find(player.matchId);
    if (!room || room.state === "finished") { await shutdown(); return; }
    if (room.state === "lobby") {
      const members = [...connection.db.player.iter()].filter(member => member.matchId === room.id);
      if (room.host.isEqual(player.identity) && members.length >= 2 && members.every(member => member.ready && member.online)) await connection.reducers.startMatch({});
      return;
    }
    const units = merger.collect(connection.db, room.id);
    const nodes = [...connection.db.resource_node.iter()].filter(node => node.matchId === room.id).map(node => node.data);
    const creep = [...connection.db.creep_patch.iter()].filter(patch => patch.matchId === room.id).map(patch => patch.data);
    const pending = new Set([...connection.db.command.iter()].filter(command => command.matchId === room.id && command.owner === player.slot && command.status === "scheduled").flatMap(command => command.units));
    // The faction is read from the bot's own Player row — the server dealt it by
    // slot, and the bot has no more say in it than a human client does.
    for (const decision of chooseOrders(player.slot, factionOf(player.faction), { material: player.material, catalyst: player.catalyst, terrazine: player.terrazine, research: player.research }, units, nodes, pending, false, { tick: room.tick, creep })) {
      try { await order(connection, decision.units, decision.order.kind, decision.order); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await shutdown();
    process.exitCode = 1;
  } finally { busy = false; }
}, 1500);

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });