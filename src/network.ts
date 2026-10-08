import { BinaryWriter, ProductType, reducerSchema } from "spacetimedb";
import { DbConnection, tables, type SubscriptionHandle } from "./bindings";
import { Faction, type ChatMessage, type Command, type CreepPatch, type MatchSample, type Node, type Order, type Player, type Room } from "./bindings/types";
import { UnitMerger, type Entity } from "./units";
import { factionValue, type FactionName } from "./catalog";

/**
 * `set_faction` called without a generated handle.
 *
 * The bindings under `src/bindings` are produced by `spacetime generate` and
 * are not edited by hand, so a reducer added to the module has no typed
 * accessor until they are regenerated. The call itself needs nothing more than
 * the module already provides: the argument type is built from the same
 * generated `Faction` schema the rows are decoded with, serialized exactly as
 * the generated accessors serialize theirs, and sent by name. Once the bindings
 * are regenerated this collapses to `connection.reducers.setFaction({ faction })`
 * with no change in behaviour on either side.
 */
const SET_FACTION = reducerSchema("set_faction", { faction: Faction });
const serializeFaction = ProductType.makeSerializer(SET_FACTION.paramsSpacetimeType);

export function setFactionOn(connection: DbConnection, faction: FactionName): Promise<void> {
  const args = { faction: factionValue(faction) };
  const writer = new BinaryWriter(64);
  serializeFaction(writer, args);
  return connection.callReducer(SET_FACTION.reducerName, writer.getBuffer(), args);
}

export interface Snapshot {
  rooms: Room[];
  players: Player[];
  me: Player | undefined;
  room: Room | undefined;
  units: Entity[];
  nodes: Node[];
  commands: Command[];
  /**
   * The match's history, one row per player every hundred ticks plus a final
   * row the instant it ends. Subscribed for the whole match rather than
   * fetched at the end, so the score screen has the series in hand the moment
   * the room turns `finished` and never has to race a subscription.
   */
  samples: MatchSample[];
  /**
   * Organic creep, one disc per source. Drawn from the table rather than from
   * units: a patch outlives the hub that grew it and recedes on its own.
   */
  creep: CreepPatch[];
  /** This room's chat, oldest first: the lobby, the match and its score screen share it. */
  chat: ChatMessage[];
}

export interface PendingOrder {
  requestId: string;
  units: number[];
  order: Order;
  queued: boolean;
  /** The tick this order was stamped to run on, known from the click. */
  executeTick: bigint;
}

/** No new tick for this long in a running match reads as a stall, not jitter. */
export const STALL_MS = 500;

export class Session {
  constructor(private identityScope = "identity") {}
  connection: DbConnection | undefined;
  status = "Disconnected";
  ready = false;
  matchReady = false;
  ackMs = 0;
  tickReceivedAt = performance.now();
  pending = new Map<string, PendingOrder>();
  /** Ticks your newest order ran after its stamp: 0 means it was on time. */
  lateTicks = 0n;
  snapshot: Snapshot = { rooms: [], players: [], me: undefined, room: undefined, units: [], nodes: [], commands: [], samples: [], creep: [], chat: [] };
  onChange: () => void = () => {};
  onNotice: (message: string) => void = () => {};
  /** Called with the server's reason when one of your own commands is refused. */
  onReject: (reason: string) => void = () => {};
  /** Called once for each chat line that arrives after the room's history has loaded. */
  onChat: (message: ChatMessage) => void = () => {};
  private epoch = 0;
  private matchId = 0n;
  private matchSubscription: SubscriptionHandle | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryCount = 0;
  private refreshQueued = false;
  private merger = new UnitMerger();

  connect(host: string, database: string): void {
    const epoch = ++this.epoch;
    clearTimeout(this.retry);
    const old = this.connection;
    this.connection = undefined;
    old?.disconnect();
    this.ready = false;
    this.matchReady = false;
    this.matchId = 0n;
    this.matchSubscription = undefined;
    this.pending.clear();
    this.snapshot = { rooms: [], players: [], me: undefined, room: undefined, units: [], nodes: [], commands: [], samples: [], creep: [], chat: [] };
    this.status = "Connecting";
    this.onChange();
    const key = `stdbrts:v2:${this.identityScope}:${host}:${database}`;
    const lost = (message: string) => {
      if (epoch !== this.epoch) return;
      this.ready = false;
      this.matchReady = false;
      this.pending.clear();
      this.status = "Reconnecting";
      this.onNotice(message);
      this.onChange();
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.connect(host, database), Math.min(1000 * 2 ** this.retryCount++, 15000));
    };
    try {
      const connection = DbConnection.builder()
        .withUri(host)
        .withDatabaseName(database)
        .withToken(localStorage.getItem(key) ?? undefined)
        .onConnect((connection, _identity, token) => {
          if (epoch !== this.epoch) { connection.disconnect(); return; }
          localStorage.setItem(key, token);
          this.status = "Synchronizing";
          connection.subscriptionBuilder()
            .onApplied(() => {
              if (epoch !== this.epoch) return;
              this.ready = true;
              this.retryCount = 0;
              this.status = "Connected";
              refresh();
            })
            .onError(context => lost(`Subscription failed: ${context.event?.message ?? "Unknown subscription error"}`))
            .subscribe([tables.room, tables.player]);
        })
        .onConnectError((_context, error) => lost(`Connection failed: ${error.message}`))
        .onDisconnect((_context, error) => lost(error?.message ?? "Connection closed"))
        .build();
      this.connection = connection;
      const refresh = () => {
        if (epoch !== this.epoch || this.refreshQueued) return;
        this.refreshQueued = true;
        queueMicrotask(() => {
          this.refreshQueued = false;
          if (epoch === this.epoch) this.refresh(connection);
        });
      };
      connection.db.player.onInsert(refresh);
      connection.db.player.onUpdate(refresh);
      connection.db.player.onDelete(refresh);
      connection.db.room.onInsert(refresh);
      connection.db.room.onUpdate((_context, previous, room) => {
        if (room.id === this.matchId && room.tick !== previous.tick) this.tickReceivedAt = performance.now();
        refresh();
      });
      connection.db.room.onDelete(refresh);
      connection.db.unit.onInsert(refresh);
      connection.db.unit.onUpdate(refresh);
      connection.db.unit.onDelete(refresh);
      connection.db.unit_motion.onInsert(refresh);
      connection.db.unit_motion.onUpdate(refresh);
      connection.db.unit_motion.onDelete(refresh);
      connection.db.unit_vitals.onInsert(refresh);
      connection.db.unit_vitals.onUpdate(refresh);
      connection.db.unit_vitals.onDelete(refresh);
      connection.db.resource_node.onInsert(refresh);
      connection.db.resource_node.onUpdate(refresh);
      connection.db.resource_node.onDelete(refresh);
      connection.db.command.onInsert((_context, command) => {
        if (this.pending.delete(command.requestId) && command.requestedTick > 0n) this.lateTicks = command.executeTick - command.requestedTick;
        refresh();
      });
      connection.db.command.onUpdate((_context, previous, command) => {
        if (command.issuer.isEqual(connection.identity!) && command.status !== previous.status && command.status === "rejected") { this.onNotice(command.reason); this.onReject(command.reason); }
        refresh();
      });
      connection.db.command.onDelete(refresh);
      connection.db.match_sample.onInsert(refresh);
      connection.db.match_sample.onDelete(refresh);
      connection.db.creep_patch.onInsert(refresh);
      connection.db.creep_patch.onUpdate(refresh);
      connection.db.creep_patch.onDelete(refresh);
      connection.db.chat_message.onInsert((_context, message) => {
        if (this.matchReady && message.matchId === this.matchId) this.onChat(message);
        refresh();
      });
      connection.db.chat_message.onDelete(refresh);
    } catch (error) { lost(error instanceof Error ? error.message : String(error)); }
  }

  private refresh(connection: DbConnection): void {
    const players = [...connection.db.player.iter()];
    const me = players.find(player => connection.identity?.isEqual(player.identity));
    const rooms = [...connection.db.room.iter()];
    const room = rooms.find(room => room.id === me?.matchId);
    const nextMatch = room?.id ?? 0n;
    if (nextMatch !== this.matchId) {
      this.matchId = nextMatch;
      this.matchReady = false;
      this.pending.clear();
      const previous = this.matchSubscription;
      if (nextMatch === 0n) {
        if (previous && !previous.isEnded()) previous.unsubscribe();
        this.matchSubscription = undefined;
      } else {
        this.matchSubscription = connection.subscriptionBuilder()
          .onApplied(() => {
            if (previous && !previous.isEnded()) previous.unsubscribe();
            if (this.connection === connection && this.matchId === nextMatch) {
              this.matchReady = true;
              this.refresh(connection);
            }
          })
          .onError(context => { this.matchReady = false; this.onNotice(context.event?.message ?? "Match subscription failed"); this.onChange(); })
          .subscribe([
            tables.unit.where(row => row.matchId.eq(nextMatch)),
            tables.unit_motion.where(row => row.matchId.eq(nextMatch)),
            tables.unit_vitals.where(row => row.matchId.eq(nextMatch)),
            tables.resource_node.where(row => row.matchId.eq(nextMatch)),
            tables.command.where(row => row.matchId.eq(nextMatch)),
            tables.match_sample.where(row => row.matchId.eq(nextMatch)),
            tables.creep_patch.where(row => row.matchId.eq(nextMatch)),
            tables.chat_message.where(row => row.matchId.eq(nextMatch)),
          ]);
      }
    }
    this.snapshot = {
      rooms, players, me, room,
      units: this.merger.collect(connection.db, nextMatch),
      nodes: [...connection.db.resource_node.iter()].filter(row => row.matchId === nextMatch).map(row => row.data),
      commands: [...connection.db.command.iter()].filter(row => row.matchId === nextMatch),
      samples: [...connection.db.match_sample.iter()].filter(row => row.matchId === nextMatch),
      creep: [...connection.db.creep_patch.iter()].filter(row => row.matchId === nextMatch).map(row => row.data),
      chat: [...connection.db.chat_message.iter()].filter(row => row.matchId === nextMatch).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    };
    this.onChange();
  }

  disconnect(): void {
    this.epoch++;
    clearTimeout(this.retry);
    this.ready = false;
    this.matchReady = false;
    const connection = this.connection;
    this.connection = undefined;
    connection?.disconnect();
  }

  async act(action: (connection: DbConnection) => Promise<void>): Promise<boolean> {
    if (!this.ready || !this.connection) { this.onNotice("Not connected"); return false; }
    try { await action(this.connection); return true; }
    catch (error) { this.onNotice(error instanceof Error ? error.message : String(error)); return false; }
  }

  /**
   * Choose the faction this player will deploy with. The server refuses it
   * once the room is playing, and that refusal surfaces as a notice like any
   * other, so the client never has to guess whether the change landed: the
   * roster and the brief redraw from the row the server wrote.
   */
  async setFaction(faction: FactionName): Promise<boolean> {
    return this.act(connection => setFactionOn(connection, faction));
  }

  /** Whether a running match has gone quiet for longer than `STALL_MS`. */
  stalled(now = performance.now()): boolean {
    return this.matchReady && this.snapshot.room?.state === "playing" && now - this.tickReceivedAt > STALL_MS;
  }

  /**
   * Sends an order stamped to run one command delay after the newest tick
   * this client has seen, which is the state the player was looking at when
   * they clicked. The server honours the stamp while the order arrives
   * within its lateness allowance, so the network's jitter never changes when
   * an order runs, and the client knows that tick before the server answers.
   */
  async order(units: number[], order: Order, queued = false): Promise<void> {
    const room = this.snapshot.room;
    if (!this.matchReady || !this.ready || room?.state !== "playing") return;
    const requestId = crypto.randomUUID();
    const executeTick = room.tick + room.commandDelay;
    this.pending.set(requestId, { requestId, units, order, queued, executeTick });
    this.onChange();
    const started = performance.now();
    const accepted = await this.act(connection => connection.reducers.issueOrder({ requestId, units, ...order, queued, requestedTick: executeTick }));
    this.ackMs = Math.round(performance.now() - started);
    if (!accepted) this.pending.delete(requestId);
    this.onChange();
  }
}