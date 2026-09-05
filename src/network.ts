import { DbConnection, tables, type SubscriptionHandle } from "./bindings";
import type { Command, Entity, Node, Order, Player, Room } from "./bindings/types";

export interface Snapshot {
  rooms: Room[];
  players: Player[];
  me: Player | undefined;
  room: Room | undefined;
  units: Entity[];
  nodes: Node[];
  commands: Command[];
}

export interface PendingOrder {
  requestId: string;
  units: number[];
  order: Order;
  queued: boolean;
}

export class Session {
  connection: DbConnection | undefined;
  status = "Disconnected";
  ready = false;
  matchReady = false;
  ackMs = 0;
  tickReceivedAt = performance.now();
  pending = new Map<string, PendingOrder>();
  snapshot: Snapshot = { rooms: [], players: [], me: undefined, room: undefined, units: [], nodes: [], commands: [] };
  onChange: () => void = () => {};
  onNotice: (message: string) => void = () => {};
  private epoch = 0;
  private matchId = 0n;
  private matchSubscription: SubscriptionHandle | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryCount = 0;
  private refreshQueued = false;

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
    this.snapshot = { rooms: [], players: [], me: undefined, room: undefined, units: [], nodes: [], commands: [] };
    this.status = "Connecting";
    this.onChange();
    const key = `stdbrts:v2:identity:${host}:${database}`;
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
      connection.db.resource_node.onInsert(refresh);
      connection.db.resource_node.onUpdate(refresh);
      connection.db.resource_node.onDelete(refresh);
      connection.db.command.onInsert((_context, command) => {
        this.pending.delete(command.requestId);
        refresh();
      });
      connection.db.command.onUpdate((_context, previous, command) => {
        if (command.issuer.isEqual(connection.identity!) && command.status !== previous.status && command.status === "rejected") this.onNotice(command.reason);
        refresh();
      });
      connection.db.command.onDelete(refresh);
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
            tables.resource_node.where(row => row.matchId.eq(nextMatch)),
            tables.command.where(row => row.matchId.eq(nextMatch)),
          ]);
      }
    }
    this.snapshot = {
      rooms, players, me, room,
      units: [...connection.db.unit.iter()].filter(row => row.matchId === nextMatch).map(row => row.data),
      nodes: [...connection.db.resource_node.iter()].filter(row => row.matchId === nextMatch).map(row => row.data),
      commands: [...connection.db.command.iter()].filter(row => row.matchId === nextMatch),
    };
    this.onChange();
  }

  async act(action: (connection: DbConnection) => Promise<void>): Promise<boolean> {
    if (!this.ready || !this.connection) { this.onNotice("Not connected"); return false; }
    try { await action(this.connection); return true; }
    catch (error) { this.onNotice(error instanceof Error ? error.message : String(error)); return false; }
  }

  async order(units: number[], order: Order, queued = false): Promise<void> {
    if (!this.matchReady || !this.ready || this.snapshot.room?.state !== "playing") return;
    const requestId = crypto.randomUUID();
    this.pending.set(requestId, { requestId, units, order, queued });
    this.onChange();
    const started = performance.now();
    const accepted = await this.act(connection => connection.reducers.issueOrder({ requestId, units, ...order, queued }));
    this.ackMs = Math.round(performance.now() - started);
    if (!accepted) this.pending.delete(requestId);
    this.onChange();
  }
}