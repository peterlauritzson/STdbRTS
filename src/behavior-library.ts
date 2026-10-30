import { MAX_CUSTOM, parsePolicy, type ParseResult } from "./policies";

/**
 * The player's own collection of behaviors, kept in this browser's
 * localStorage so the standalone editor (behaviors.html) and the game share it.
 * The policy text is the source of truth; `layout` (one [x, y] per state, in
 * state order) is editor-only. Nothing here throws: a missing, corrupt or
 * blocked store reads as an empty library.
 */
export const LIBRARY_KEY = "stdbrts:v1:behavior-library";

export type Position = [number, number];
export interface Entry { id: string; text: string; layout?: Position[]; updated: number }
export interface Library { version: 1; entries: Entry[]; /** Entry id (or null) for each of the four slots. */ loadout: (string | null)[]; autoInstall: boolean }

export const emptyLibrary = (): Library => ({ version: 1, entries: [], loadout: Array.from({ length: MAX_CUSTOM }, () => null), autoInstall: true });

const isPosition = (value: unknown): value is Position => Array.isArray(value) && value.length === 2 && value.every(part => typeof part === "number" && Number.isFinite(part));

/** Keeps what is usable of one stored entry; undefined if it has no text. */
function cleanEntry(raw: unknown, fallbackId: string): Entry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { id, text, layout, updated } = raw as Record<string, unknown>;
  if (typeof text !== "string") return undefined;
  const entry: Entry = { id: typeof id === "string" && id ? id : fallbackId, text, updated: typeof updated === "number" && Number.isFinite(updated) ? updated : 0 };
  if (Array.isArray(layout) && layout.every(isPosition)) entry.layout = layout.map(([x, y]) => [x, y] as Position);
  return entry;
}

/** Sanitises parsed JSON into a library, never throwing. */
export function normalizeLibrary(raw: unknown): Library {
  const library = emptyLibrary();
  if (!raw || typeof raw !== "object") return library;
  const { entries, loadout, autoInstall } = raw as Record<string, unknown>;
  const seen = new Set<string>();
  if (Array.isArray(entries)) entries.forEach((item, at) => {
    const entry = cleanEntry(item, newId(`lost${at}`));
    if (!entry) return;
    if (seen.has(entry.id)) entry.id = newId();
    seen.add(entry.id);
    library.entries.push(entry);
  });
  if (Array.isArray(loadout)) for (let slot = 0; slot < MAX_CUSTOM; slot++) {
    const id = loadout[slot];
    if (typeof id === "string" && seen.has(id) && !library.loadout.includes(id)) library.loadout[slot] = id;
  }
  if (typeof autoInstall === "boolean") library.autoInstall = autoInstall;
  return library;
}

function store(): Storage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

export function loadLibrary(storage: Pick<Storage, "getItem"> | undefined = store()): Library {
  try {
    const raw = storage?.getItem(LIBRARY_KEY);
    return raw ? normalizeLibrary(JSON.parse(raw)) : emptyLibrary();
  } catch { return emptyLibrary(); }
}

/** True if written; false when storage is blocked or full. */
export function saveLibrary(library: Library, storage: Pick<Storage, "setItem"> | undefined = store()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(LIBRARY_KEY, JSON.stringify(library));
    return true;
  } catch { return false; }
}

let counter = 0;
export function newId(hint = ""): string {
  counter += 1;
  return `${hint}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${counter.toString(36)}`;
}

/** Whether the entry's text still parses; broken ones stay in the library so they can be fixed or removed. */
export const entryStatus = (entry: Entry): ParseResult => parsePolicy(entry.text);
export const entryName = (entry: Entry): string => {
  const parsed = parsePolicy(entry.text);
  return parsed.ok ? parsed.policy.label : entry.text.split("|")[0]?.trim() || "Broken behavior";
};
export const stateCount = (entry: Entry): number => { const parsed = parsePolicy(entry.text); return parsed.ok ? parsed.policy.states.length : 0; };

export const findEntry = (library: Library, id: string | null | undefined): Entry | undefined => id ? library.entries.find(entry => entry.id === id) : undefined;
/** The loadout slot (1 to 4) an entry sits in, or undefined. */
export const slotOf = (library: Library, id: string): number | undefined => { const at = library.loadout.indexOf(id); return at < 0 ? undefined : at + 1; };
/** The loadout as slot number and valid entry, skipping empty and broken slots. */
export function loadoutTexts(library: Library): { number: number; text: string }[] {
  const result: { number: number; text: string }[] = [];
  library.loadout.forEach((id, at) => {
    const entry = findEntry(library, id);
    if (entry && entryStatus(entry).ok) result.push({ number: at + 1, text: entry.text });
  });
  return result;
}

export function createEntry(text: string, layout?: Position[], now = Date.now()): Entry {
  return layout ? { id: newId(), text, layout: layout.map(([x, y]) => [x, y] as Position), updated: now } : { id: newId(), text, updated: now };
}

export const addEntry = (library: Library, entry: Entry): Library => ({ ...library, entries: [...library.entries, entry] });

/** Replaces the text (and layout, if given) of one entry and stamps it. */
export function updateEntry(library: Library, id: string, change: { text?: string; layout?: Position[] }, now = Date.now()): Library {
  return { ...library, entries: library.entries.map(entry => entry.id === id ? { ...entry, ...(change.text !== undefined ? { text: change.text } : {}), ...(change.layout ? { layout: change.layout } : {}), updated: now } : entry) };
}

/** A copy placed after the original, its name suffixed when that still fits. */
export function duplicateEntry(library: Library, id: string, now = Date.now()): { library: Library; entry?: Entry } {
  const at = library.entries.findIndex(entry => entry.id === id);
  if (at < 0) return { library };
  const source = library.entries[at];
  let text = source.text;
  const parsed = parsePolicy(source.text);
  if (parsed.ok) {
    const label = `${parsed.policy.label} copy`;
    if (label.length <= 20) text = `${label}${source.text.slice(source.text.indexOf("|"))}`;
  }
  const entry = createEntry(text, source.layout, now);
  const entries = [...library.entries];
  entries.splice(at + 1, 0, entry);
  return { library: { ...library, entries }, entry };
}

/** Removes an entry and empties its loadout slot. */
export function deleteEntry(library: Library, id: string): Library {
  return { ...library, entries: library.entries.filter(entry => entry.id !== id), loadout: library.loadout.map(slot => slot === id ? null : slot) };
}

/** Puts an entry in slot `number` (1 to 4), or empties the slot with null. An entry holds at most one slot, so assigning moves it. */
export function assignSlot(library: Library, number: number, id: string | null): Library {
  if (!Number.isInteger(number) || number < 1 || number > MAX_CUSTOM) return library;
  if (id !== null && !findEntry(library, id)) return library;
  const loadout = library.loadout.map(slot => id !== null && slot === id ? null : slot);
  loadout[number - 1] = id;
  return { ...library, loadout };
}

export interface Imported { entries: Entry[]; errors: string[] }

/** Reads the exported library JSON, or one policy per line of text (blank lines ignored). */
export function importText(raw: string, now = Date.now()): Imported {
  const entries: Entry[] = [];
  const errors: string[] = [];
  const body = raw.trim();
  if (!body) return { entries, errors: ["Nothing to import"] };
  if (body.startsWith("{") || body.startsWith("[")) {
    let data: unknown;
    try { data = JSON.parse(body); } catch { return { entries, errors: ["That looks like JSON but does not parse"] }; }
    const list = Array.isArray(data) ? data : (data as { entries?: unknown })?.entries;
    if (!Array.isArray(list)) return { entries, errors: ["No behaviors found in that JSON"] };
    list.forEach((item, at) => {
      const entry = cleanEntry(typeof item === "string" ? { text: item } : item, "");
      if (!entry) { errors.push(`Item ${at + 1}: no behavior text`); return; }
      const parsed = parsePolicy(entry.text);
      if (!parsed.ok) { errors.push(`Item ${at + 1}: ${parsed.error}`); return; }
      const layout = entry.layout && entry.layout.length === parsed.policy.states.length ? entry.layout : undefined;
      entries.push(createEntry(entry.text, layout, now));
    });
    return { entries, errors };
  }
  body.split(/\r?\n/).forEach((line, at) => {
    const textLine = line.trim();
    if (!textLine) return;
    const parsed = parsePolicy(textLine);
    if (parsed.ok) entries.push(createEntry(textLine, undefined, now));
    else errors.push(`Line ${at + 1}: ${parsed.error}`);
  });
  return { entries, errors };
}

export const exportJson = (library: Library): string => JSON.stringify(library, null, 2);

/** Layout after state `index` is removed: that position goes, later ones shift down with their states. */
export const removeLayoutAt = (layout: Position[], index: number): Position[] => layout.filter((_, at) => at !== index).map(([x, y]) => [x, y] as Position);
/** Layout after a state is appended: its position goes last. */
export const appendLayout = (layout: Position[], position: Position): Position[] => [...layout.map(([x, y]) => [x, y] as Position), [position[0], position[1]]];
