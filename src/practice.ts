import { Session } from "./network";
import { chooseOrders } from "../scripts/bot-policy";

async function waitUntil(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > 15000) { clearInterval(timer); reject(new Error("Practice connection timed out")); }
    }, 50);
  });
}

export class Practice {
  starting = false;
  onChange: () => void = () => {};
  private bot = new Session("practice-identity");
  private activeKey = "";
  private thinking = false;

  constructor(private human: Session) {
    setInterval(() => { void this.tick(); }, 1200);
  }

  restore(host: string, database: string): void {
    this.bot.disconnect();
    this.activeKey = `stdbrts:practice:${host}:${database}`;
    if (localStorage.getItem(this.activeKey)) this.bot.connect(host, database);
  }

  async start(host: string, database: string, callsign: string): Promise<void> {
    if (this.starting || this.human.snapshot.room || !this.human.ready) return;
    this.starting = true; this.onChange();
    this.activeKey = `stdbrts:practice:${host}:${database}`;
    localStorage.setItem(this.activeKey, "active");
    this.bot.connect(host, database);
    try {
      await waitUntil(() => this.bot.ready && !!this.bot.snapshot.me);
      const created = await this.bot.act(async connection => {
        if (this.bot.snapshot.me?.matchId !== 0n) await connection.reducers.leaveRoom({});
        await connection.reducers.setName({ name: "Automaton" });
        await connection.reducers.createRoom({ name: "Practice / Verdant Basin", capacity: 2 });
        await connection.reducers.setReady({ ready: true });
      });
      if (!created) throw new Error("Could not create practice operation");
      await waitUntil(() => this.bot.snapshot.room?.state === "lobby");
      const matchId = this.bot.snapshot.room!.id;
      const joined = await this.human.act(async connection => {
        await connection.reducers.setName({ name: callsign.trim() || "Commander" });
        await connection.reducers.joinRoom({ matchId });
        await connection.reducers.setReady({ ready: true });
      });
      if (!joined) throw new Error("Could not join practice operation");
      await waitUntil(() => this.bot.snapshot.players.filter(player => player.matchId === matchId && player.ready).length === 2);
      if (!await this.bot.act(connection => connection.reducers.startMatch({}))) throw new Error("Could not deploy practice operation");
      await waitUntil(() => this.human.matchReady && this.human.snapshot.room?.state === "playing");
      for (const worker of this.human.snapshot.units.filter(unit => unit.owner === this.human.snapshot.me?.slot && unit.kind === "worker")) {
        const node = [...this.human.snapshot.nodes].sort((left, right) => Math.hypot(left.x - worker.x, left.y - worker.y) - Math.hypot(right.x - worker.x, right.y - worker.y))[0];
        if (node) await this.human.order([worker.id], { kind: "gather", x: 0, y: 0, target: node.id });
      }
    } catch (error) {
      this.human.onNotice(error instanceof Error ? error.message : String(error));
      await this.bot.act(connection => connection.reducers.leaveRoom({}));
      localStorage.removeItem(this.activeKey);
      this.bot.disconnect();
    } finally { this.starting = false; this.onChange(); }
  }

  private async tick(): Promise<void> {
    if (this.starting || this.thinking || !this.bot.ready || !this.bot.matchReady) return;
    this.thinking = true;
    try {
      const { room, me, units, nodes, commands } = this.bot.snapshot;
      if (!room || !me) return;
      if (this.human.ready && this.human.snapshot.me && this.human.snapshot.room?.id !== room.id) {
        await this.bot.act(connection => connection.reducers.leaveRoom({}));
        localStorage.removeItem(this.activeKey);
        this.bot.disconnect();
        return;
      }
      if (room.state !== "playing") return;
      const decide = async () => {
        const busy = new Set(commands.filter(command => command.owner === me.slot && command.status === "scheduled").flatMap(command => command.units));
        for (const pending of this.bot.pending.values()) for (const id of pending.units) busy.add(id);
        for (const decision of chooseOrders(me.slot, me.resources, units, nodes, busy)) await this.bot.order(decision.units, decision.order);
      };
      if (navigator.locks) await navigator.locks.request(`practice-ai:${this.activeKey}`, { ifAvailable: true }, async lock => { if (lock) await decide(); });
      else await decide();
    } finally { this.thinking = false; }
  }
}