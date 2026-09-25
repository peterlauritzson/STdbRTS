import { Session, setFactionOn } from "./network";
import { chooseOrders } from "../scripts/bot-policy";
import { currencyOf, factionForSlot, factionOf, FACTIONS, isLabour, PRACTICE_SLOT, type FactionName } from "./catalog";

/**
 * The bot keeps its army at home for this long (20 ticks a second) before the
 * first push. Without it the practice bot's first push, led by units that
 * out-range the defenders, killed every faction's HQ at 90-115s, before a new
 * player had seen the opponent's army. Experimental.
 */
export const PRACTICE_FIRST_PUSH_TICK = 180n * 20n;

/** The opponent the practice picker offers: one faction, or any of the three. */
export type PracticeOpponent = FactionName | "random";
export const pickOpponent = (opponent: PracticeOpponent, roll = Math.random()): FactionName =>
  opponent === "random" ? FACTIONS[Math.min(FACTIONS.length - 1, Math.floor(roll * FACTIONS.length))] : opponent;

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

  /**
   * One click from the lobby to a running match. `faction` is the only thing
   * the human chooses on the way, and it defaults to the faction the practice
   * slot deals, so a player who does not care still clicks exactly once and
   * gets what they got before. The bot keeps slot 0 and plays `opponent`,
   * which it sets in the lobby exactly as the human sets theirs: a mirror is a
   * legitimate matchup, so no choice is refused here.
   */
  async start(host: string, database: string, callsign: string, faction: FactionName = factionForSlot(PRACTICE_SLOT), opponent: PracticeOpponent = factionForSlot(0)): Promise<void> {
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
        await setFactionOn(connection, pickOpponent(opponent));
        await connection.reducers.setReady({ ready: true });
      });
      if (!created) throw new Error("Could not create practice operation");
      await waitUntil(() => this.bot.snapshot.room?.state === "lobby");
      const matchId = this.bot.snapshot.room!.id;
      const joined = await this.human.act(async connection => {
        await connection.reducers.setName({ name: callsign.trim() || "Commander" });
        await connection.reducers.joinRoom({ matchId });
        // Between joining and readying, while the room is still a lobby: the
        // server freezes the faction at deployment, so this is the last moment
        // it can move, and it costs the player no extra step.
        await setFactionOn(connection, faction);
        await connection.reducers.setReady({ ready: true });
      });
      if (!joined) throw new Error("Could not join practice operation");
      await waitUntil(() => this.bot.snapshot.players.filter(player => player.matchId === matchId && player.ready).length === 2);
      if (!await this.bot.act(connection => connection.reducers.startMatch({}))) throw new Error("Could not deploy practice operation");
      await waitUntil(() => this.human.matchReady && this.human.snapshot.room?.state === "playing");
      // The opening gather goes to whatever labour this slot was dealt. Looking
      // for "worker" left a Network or Organic player's opening units standing
      // idle at the hub with no way to know why.
      for (const worker of this.human.snapshot.units.filter(unit => unit.owner === this.human.snapshot.me?.slot && isLabour(unit.kind))) {
        // The opening goes to material: catalyst deposits sit in contested
        // ground and are a decision the player makes, not a default.
        const reachable = this.human.snapshot.nodes.filter(node => node.amount > 0 && currencyOf(node.kind) === "material");
        const node = [...(reachable.length ? reachable : this.human.snapshot.nodes)].sort((left, right) => Math.hypot(left.x - worker.x, left.y - worker.y) - Math.hypot(right.x - worker.x, right.y - worker.y))[0];
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
        for (const decision of chooseOrders(me.slot, factionOf(me.faction), { material: me.material, catalyst: me.catalyst }, units, nodes, busy, room.tick < PRACTICE_FIRST_PUSH_TICK)) await this.bot.order(decision.units, decision.order);
      };
      if (navigator.locks) await navigator.locks.request(`practice-ai:${this.activeKey}`, { ifAvailable: true }, async lock => { if (lock) await decide(); });
      else await decide();
    } finally { this.thinking = false; }
  }
}