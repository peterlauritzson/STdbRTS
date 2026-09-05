import { DbConnection, tables } from "../src/bindings";

export const HOST = process.env.STDB_HOST ?? "ws://127.0.0.1:3000";
export const DATABASE = process.env.STDB_DATABASE ?? "stdbrts-v2-dev";

export async function until(predicate: () => boolean, message: string, timeout = 10000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        if (predicate()) { clearInterval(timer); resolve(); }
        else if (Date.now() - started >= timeout) { clearInterval(timer); reject(new Error(`Timed out: ${message}`)); }
      } catch (error) { clearInterval(timer); reject(error); }
    }, 20);
  });
}

export function connectClient(token?: string): Promise<{ connection: DbConnection; token: string }> {
  return new Promise((resolve, reject) => {
    let connection: DbConnection;
    const timeout = setTimeout(() => { connection?.disconnect(); reject(new Error("Connection timed out")); }, 10000);
    connection = DbConnection.builder().withUri(HOST).withDatabaseName(DATABASE).withToken(token)
      .onConnect((connection, _identity, token) => {
        connection.subscriptionBuilder()
          .onApplied(() => { clearTimeout(timeout); resolve({ connection, token }); })
          .onError(context => { clearTimeout(timeout); connection.disconnect(); reject(context.event ?? new Error("Subscription failed")); })
          .subscribe([tables.player, tables.room, tables.unit, tables.resource_node, tables.command]);
      })
      .onConnectError((_context, error) => { clearTimeout(timeout); reject(error); })
      .build();
  });
}

export function me(connection: DbConnection) {
  const player = connection.db.player.identity.find(connection.identity!);
  if (!player) throw new Error("Player not subscribed");
  return player;
}

export function order(connection: DbConnection, units: number[], kind: string, overrides: { x?: number; y?: number; target?: number; queued?: boolean; requestId?: string } = {}) {
  return connection.reducers.issueOrder({ requestId: crypto.randomUUID(), units, kind, x: 700, y: 500, target: 0, queued: false, ...overrides });
}