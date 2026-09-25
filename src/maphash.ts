/**
 * The client's copy of `MapDefinition::content_hash` (server/src/maps.rs):
 * FNV-1a over the same canonical encoding, byte for byte. The server is the
 * authority on the map, but the client draws terrain and previews placement
 * from its own bundled copy, so a stale bundle would show walls that are not
 * there. Comparing this with the room's `map_hash` catches that.
 */
export interface HashableMap {
  id: string;
  version: number;
  size: number;
  starts: readonly (readonly number[])[];
  deposits: readonly { id: number; x: number; y: number; amount: number; kind: string }[];
  terrain: readonly (readonly number[])[];
}

const OFFSET_BASIS = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function mapContentHash(map: HashableMap): bigint {
  let hash = OFFSET_BASIS;
  const bytes = (values: Uint8Array) => {
    for (const byte of values) hash = ((hash ^ BigInt(byte)) * PRIME) & MASK;
  };
  const u32 = (value: number) => { const view = new DataView(new ArrayBuffer(4)); view.setUint32(0, value, true); bytes(new Uint8Array(view.buffer)); };
  const u64 = (value: number) => { const view = new DataView(new ArrayBuffer(8)); view.setBigUint64(0, BigInt(value), true); bytes(new Uint8Array(view.buffer)); };
  // The exact f32 bit pattern, as `f32::to_bits` gives it.
  const f32 = (value: number) => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); bytes(new Uint8Array(view.buffer)); };
  const text = (value: string) => { const encoded = new TextEncoder().encode(value); u64(encoded.length); bytes(encoded); };
  text("rts-map-v2");
  text(map.id);
  u32(map.version);
  f32(map.size);
  u64(map.starts.length);
  for (const [x, y] of map.starts) { f32(x); f32(y); }
  u64(map.deposits.length);
  for (const deposit of map.deposits) { u32(deposit.id); f32(deposit.x); f32(deposit.y); u32(deposit.amount); text(deposit.kind); }
  u64(map.terrain.length);
  for (const rect of map.terrain) for (const value of rect) f32(value);
  return hash;
}
