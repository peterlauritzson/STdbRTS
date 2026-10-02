import type { EntityCold, EntityMotion, EntityVitals } from "./bindings/types";

/**
 * A unit as the client sees it: the server keeps one simulation entity but
 * stores and broadcasts it as three public rows keyed by the same id, so a unit
 * that merely walks rewrites only its tiny position row.
 *
 *   `unit`        (cold)   owner, kind, orders, production, energy, ...
 *   `unit_motion` (hot)    x, y
 *   `unit_vitals`          hp, shields, last shot, passive timer
 *
 * The server-only bookkeeping lives in a private table that is never sent.
 */
export type Entity = EntityCold & EntityMotion & EntityVitals;

interface Keyed<T> { id: bigint; matchId: bigint; data: T }
interface Table<T> { iter(): Iterable<Keyed<T>>; id: { find(id: bigint): Keyed<T> | null | undefined } }
/** The three tables, structurally, so connections, tests and bots can all be merged. */
export interface UnitTables {
  unit: Table<EntityCold>;
  unit_motion: Table<EntityMotion>;
  unit_vitals: Table<EntityVitals>;
}

interface Merged { cold: EntityCold; motion: EntityMotion; vitals: EntityVitals; entity: Entity }

/**
 * Joins the three rows of each unit by id into one object. A merged object is
 * reused while none of its three rows were replaced, so identity still means
 * "unchanged" (the battlefield compares the previous object to the new one).
 * A unit is omitted until all three rows have arrived, in whichever order, and
 * disappears as soon as any of them is deleted.
 */
export class UnitMerger {
  private cache = new Map<bigint, Merged>();

  private join(id: bigint, cold: EntityCold, motion: EntityMotion, vitals: EntityVitals, next: Map<bigint, Merged>): Entity {
    const hit = this.cache.get(id);
    const merged = hit && hit.cold === cold && hit.motion === motion && hit.vitals === vitals
      ? hit
      : { cold, motion, vitals, entity: { ...cold, ...motion, ...vitals } };
    next.set(id, merged);
    return merged.entity;
  }

  /** Every complete unit of `matchId`. */
  collect(db: UnitTables, matchId: bigint): Entity[] {
    const motions = new Map<bigint, EntityMotion>();
    for (const row of db.unit_motion.iter()) if (row.matchId === matchId) motions.set(row.id, row.data);
    const vitals = new Map<bigint, EntityVitals>();
    for (const row of db.unit_vitals.iter()) if (row.matchId === matchId) vitals.set(row.id, row.data);
    const next = new Map<bigint, Merged>();
    const out: Entity[] = [];
    for (const row of db.unit.iter()) {
      if (row.matchId !== matchId) continue;
      const motion = motions.get(row.id);
      const vital = vitals.get(row.id);
      if (motion && vital) out.push(this.join(row.id, row.data, motion, vital, next));
    }
    this.cache = next;
    return out;
  }

  /** One unit by its table key, `(matchId << 32) | id`. */
  find(db: UnitTables, key: bigint): Entity | undefined {
    const cold = db.unit.id.find(key);
    const motion = db.unit_motion.id.find(key);
    const vitals = db.unit_vitals.id.find(key);
    if (!cold || !motion || !vitals) return undefined;
    return { ...cold.data, ...motion.data, ...vitals.data };
  }
}
