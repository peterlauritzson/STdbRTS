import "../styles.css";
import { createIcons, Crosshair, Radio, Plus, Play, LogOut, House, Maximize2, ZoomIn, ZoomOut, MousePointer2, Move, Square, CornerDownLeft, Swords, Hammer, Shield, Wrench, Flag, FlagOff, X, Radar, Tent, Factory, Warehouse, FlaskConical, HardHat, Trash2, Bot, Volume2, Boxes, Gem, Sprout, SatelliteDish, Zap, Sparkles, ShieldHalf, Wind, Bug, Droplets } from "lucide";
import { Battlefield } from "./battlefield";
import { Session } from "./network";
import { COLORS, countdown, VISUALS } from "./presentation";
import { addCost, isCompletedHub, ARMY, armyFaction, CATALOG, costOf, CURRENCIES, CURRENCY_LABEL, currencyOf, formatCost, RESEARCH_COST, RESEARCH_SECONDS, shortfall, shortfallReason, TECHNOLOGIES, fights, isBuilding, takesSupply, carriesCargo, factionForSlot, factionOf, FACTION_ECONOMY, FACTION_LABEL, FACTIONS, gathersInPlace, HUB_STOCK_CAP, isHub, isLabour, LABOUR, MAP_HASH, mapIdentity, MAX_UNITS, parseFaction, PRACTICE_SLOT, STOCK_REASON, type Cost, type FactionName } from "./catalog";
import { Practice, type PracticeOpponent } from "./practice";
import { Feedback } from "./feedback";
import { ScoreScreen, type ScorePlayer } from "./scorescreen";
import { BUILDING_FACTION, powered, type Field } from "./zones";
import { scheduledTraining, trainingSite } from "./production";

function element<Type extends HTMLElement = HTMLElement>(id: string): Type {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing UI element: ${id}`);
  return value as Type;
}

function text(tag: string, content: string, className = ""): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = content;
  node.className = className;
  return node;
}

/**
 * The price line under a button caption. Each currency is its own span so it
 * can be coloured and marked as the missing one, and the separators are real
 * text nodes so the rendered label — and therefore the button's accessible
 * name — is exactly "150 material + 50 catalyst / 8s".
 */
function costLine(cost: Cost, seconds: number): HTMLElement {
  const line = text("small", "", "cost-line");
  const parts = CURRENCIES.filter(currency => cost[currency] > 0);
  if (!parts.length) line.append(text("span", "free", "cost-part"));
  for (const [index, currency] of parts.entries()) {
    if (index) line.append(document.createTextNode(" + "));
    line.append(text("span", `${cost[currency]} ${currency}`, `cost-part ${currency}`));
  }
  line.append(document.createTextNode(` / ${seconds}s`));
  return line;
}

function catalogButton(id: string, label: string, cost: Cost, seconds: number, icon: string, title: string): HTMLButtonElement {
  const button = text("button", "") as HTMLButtonElement;
  button.id = id; button.title = title;
  const symbol = document.createElement("i"); symbol.dataset.lucide = icon;
  const caption = text("span", label); caption.append(costLine(cost, seconds));
  button.append(symbol, caption);
  return button;
}

/**
 * Disables a purchase button and says which currency is missing: the price
 * span for the short currency is marked, and the tooltip carries the same
 * refusal the server would return if the order were sent anyway.
 */
function affordability(button: HTMLButtonElement, cost: Cost, balance: Cost, blocked: boolean, title: string): void {
  const missing = shortfall(balance, cost);
  button.disabled = blocked || !!missing;
  for (const currency of CURRENCIES) button.querySelector(`.cost-part.${currency}`)?.classList.toggle("short", missing === currency);
  if (missing) button.dataset.shortfall = missing; else delete button.dataset.shortfall;
  button.title = missing ? `${title} / ${shortfallReason(balance, cost)}` : title;
}

/**
 * Every labour unit has a button, but a player only ever sees their own: the
 * other two are hidden outright rather than shown disabled, because no order
 * could ever make them buildable and the server refuses them by name.
 */
const LABOUR_KINDS = ["worker", "drifter", "harvester"];
/** Each faction's labour and army; a player only ever sees their own. */
const TRAINABLE = [...LABOUR_KINDS, ...FACTIONS.flatMap(faction => ARMY[faction])];
for (const kind of TRAINABLE) {
  const definition = CATALOG[kind];
  const button = catalogButton(`train-${kind}`, definition.label, definition.cost, definition.seconds, definition.icon, definition.role);
  button.hidden = true;
  element("training-buttons").append(button);
}
/**
 * Every building has a button. A faction building — the Industrial sensor, the
 * Network relay — is hidden from the other factions outright, as another
 * faction's labour is: the server refuses it by name, so a disabled button
 * would only be noise.
 */
const BUILDABLE = ["barracks", "outpost", "turret", "factory", "lab", "sensor", "relay"];
for (const kind of BUILDABLE) {
  const definition = CATALOG[kind];
  const button = catalogButton(`build-${kind}`, definition.label, definition.cost, definition.seconds, definition.icon, definition.role);
  if (BUILDING_FACTION[kind]) button.hidden = true;
  element("building-buttons").append(button);
}
for (const [kind, definition] of Object.entries(TECHNOLOGIES)) element("research-buttons").append(catalogButton(`research-${kind}`, definition.label, RESEARCH_COST, RESEARCH_SECONDS, definition.icon, definition.description));
createIcons({ icons: { Crosshair, Radio, Plus, Play, LogOut, House, Maximize2, ZoomIn, ZoomOut, MousePointer2, Move, Square, CornerDownLeft, Swords, Hammer, Shield, Wrench, Flag, FlagOff, X, Radar, Tent, Factory, Warehouse, FlaskConical, HardHat, Trash2, Bot, Volume2, Boxes, Gem, Sprout, SatelliteDish, Zap, Sparkles, ShieldHalf, Wind, Bug, Droplets } });
const session = new Session();
const practice = new Practice(session);
const feedback = new Feedback(message => session.onNotice(message));
element("sound").setAttribute("aria-pressed", String(feedback.enabled));
element("sound").title = feedback.enabled ? "Sound on" : "Sound off";
const battlefield = new Battlefield(element<HTMLCanvasElement>("battlefield"), element<HTMLCanvasElement>("minimap"), session);
const host = element<HTMLInputElement>("host");
const database = element<HTMLInputElement>("database");
const callsign = element<HTMLInputElement>("callsign");
const query = new URLSearchParams(location.search);
host.value = import.meta.env.VITE_STDB_HOST ?? localStorage.getItem("stdbrts:v2:host") ?? "ws://127.0.0.1:3000";
database.value = query.get("database") ?? import.meta.env.VITE_STDB_DATABASE ?? localStorage.getItem("stdbrts:v3:database") ?? "stdbrts-playtest";
callsign.value = localStorage.getItem("stdbrts:v2:callsign") ?? "Commander";
const factionPicker = element<HTMLSelectElement>("faction");
const practiceFaction = element<HTMLSelectElement>("practice-faction");
const practiceOpponent = element<HTMLSelectElement>("practice-opponent");
/**
 * Both pickers offer the same three options, each naming what the faction
 * actually does rather than only what it is called: the economy line is the
 * one the lobby brief and the match readout already use, so a player never
 * reads two descriptions of the same faction.
 */
for (const select of [factionPicker, practiceFaction, practiceOpponent]) {
  for (const faction of FACTIONS) {
    const option = document.createElement("option");
    option.value = faction;
    option.textContent = `${FACTION_LABEL[faction]} / ${FACTION_ECONOMY[faction]}`;
    select.append(option);
  }
}
/** What a picker is showing, refusing anything that is not one of the three. */
function chosen(select: HTMLSelectElement, fallback: FactionName): FactionName {
  return parseFaction(select.value) ?? fallback;
}
function paint(select: HTMLSelectElement, faction: FactionName): void {
  select.value = faction;
  select.className = `faction-select ${faction}`;
}
// Practice seats the human in slot 1, so the picker opens on the faction that
// slot deals: clicking Practice vs AI without touching it plays exactly what it
// played before. A choice is remembered so the next run starts where you left.
const PRACTICE_FACTION_KEY = "stdbrts:v1:practice-faction";
paint(practiceFaction, parseFaction(localStorage.getItem(PRACTICE_FACTION_KEY)) ?? factionForSlot(PRACTICE_SLOT));
practiceFaction.addEventListener("change", () => {
  const faction = chosen(practiceFaction, factionForSlot(PRACTICE_SLOT));
  paint(practiceFaction, faction);
  localStorage.setItem(PRACTICE_FACTION_KEY, faction);
});
// The bot plays whatever faction is picked here, so practice can meet all
// three armies. Random is the default and, like the player's pick, is kept.
const PRACTICE_OPPONENT_KEY = "stdbrts:v1:practice-opponent";
const opponentChoice = (value: string | null): PracticeOpponent => value === "random" ? "random" : parseFaction(value) ?? "random";
const paintOpponent = (opponent: PracticeOpponent) => { practiceOpponent.value = opponent; practiceOpponent.className = `faction-select ${opponent === "random" ? "" : opponent}`.trim(); };
paintOpponent(opponentChoice(localStorage.getItem(PRACTICE_OPPONENT_KEY)));
practiceOpponent.addEventListener("change", () => {
  const opponent = opponentChoice(practiceOpponent.value);
  paintOpponent(opponent);
  localStorage.setItem(PRACTICE_OPPONENT_KEY, opponent);
});
factionPicker.addEventListener("change", () => {
  // The server is the only authority: the picker repaints from the row it
  // writes back, so a refusal leaves the control showing the truth.
  void session.setFaction(chosen(factionPicker, myFaction()));
});
let noticeTimer: ReturnType<typeof setTimeout>;
let lobbySignature = "";
let rosterSignature = "";
let producerSignature = "";
/**
 * Who was in this match, remembered as it was played.
 *
 * A commander who concedes leaves the room, and `leave_room` clears their
 * `match_id` the moment it has written their final totals. The samples still
 * carry their slot for the whole match, so without this the score screen would
 * graph a line belonging to "Slot 0" with no name and no faction against it.
 */
const seenPlayers = new Map<number, ScorePlayer>();
let seenMatch = 0n;
const score = new ScoreScreen();
score.onShown = () => element<HTMLButtonElement>("return-lobby").focus({ preventScroll: true });

/**
 * The faction this player is actually playing: the one the slot dealt unless
 * `set_faction` was used in the lobby to depart from it. Always read from the
 * server row, never from the picker, so the command card can only ever follow
 * what the simulation will do. Industrial is the fallback for a snapshot with
 * no player yet, which matches `World::faction` for an unknown slot.
 */
function myFaction(): FactionName {
  const me = session.snapshot.me;
  return me ? factionOf(me.faction) : "industrial";
}

/** Buildings that produce something: every hub trains labour, and the rest their army or research. */
const PRODUCER_KINDS = ["hq", "outpost", "barracks", "factory", "lab"];

/**
 * A building that can produce something for this faction right now. Network
 * adds every finished structure standing in its own power field, because a
 * drifter can be trained at any of them.
 */
function isProducer(unit: { kind: string; owner: number; x: number; y: number; constructionRemaining: bigint }, faction: FactionName, fields: readonly Field[]): boolean {
  if (!isBuilding(unit.kind) || unit.constructionRemaining !== 0n) return false;
  return PRODUCER_KINDS.includes(unit.kind) || (faction === "network" && powered(unit.owner, unit.x, unit.y, fields));
}

/** Where a unit bought from the command card will train, or nothing if no building can take it now. */
function siteFor(kind: string) {
  const me = session.snapshot.me;
  if (!me) return undefined;
  const owned = session.snapshot.units.filter(unit => unit.owner === me.slot);
  return trainingSite(kind, myFaction(), owned, battlefield.selected, scheduledTraining(session.snapshot.commands, me.slot), battlefield.fields());
}

function productionBuilding() {
  const faction = myFaction();
  const fields = battlefield.fields();
  const owned = battlefield.ownedSelection().find(unit => isProducer(unit, faction, fields));
  return owned ?? battlefield.issuer();
}

let warnedMapRoom: bigint | undefined;
session.onNotice = message => {
  element("notice").textContent = message;
  element("notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { element("notice").hidden = true; }, 6000);
};

function connect(): void {
  const uri = host.value.trim();
  const name = database.value.trim();
  try {
    const url = new URL(uri);
    if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol) || !/^[a-z0-9-]+$/.test(name)) throw new Error("Enter a valid server URL and database name");
  } catch { session.onNotice("Enter a valid server URL and database name"); return; }
  localStorage.setItem("stdbrts:v2:host", uri);
  localStorage.setItem("stdbrts:v3:database", name);
  session.connect(uri, name);
  practice.restore(uri, name);
}

element("connection-form").addEventListener("submit", event => { event.preventDefault(); connect(); element<HTMLDetailsElement>("connection-settings").open = false; });
element("practice").addEventListener("click", () => { void practice.start(host.value.trim(), database.value.trim(), callsign.value, chosen(practiceFaction, factionForSlot(PRACTICE_SLOT)), opponentChoice(practiceOpponent.value)); });
element("name-form").addEventListener("submit", event => {
  event.preventDefault();
  localStorage.setItem("stdbrts:v2:callsign", callsign.value.trim());
  void session.act(connection => connection.reducers.setName({ name: callsign.value.trim() }));
});
element("create-form").addEventListener("submit", async event => {
  event.preventDefault();
  await session.act(async connection => {
    await connection.reducers.setName({ name: callsign.value.trim() });
    await connection.reducers.createRoom({ name: element<HTMLInputElement>("room-name").value.trim(), capacity: Number(element<HTMLSelectElement>("capacity").value) });
  });
});
element<HTMLInputElement>("ready").addEventListener("change", event => {
  void session.act(connection => connection.reducers.setReady({ ready: (event.target as HTMLInputElement).checked }));
});
element("start-match").addEventListener("click", () => { void session.act(connection => connection.reducers.startMatch({})); });
element("leave-lobby").addEventListener("click", () => { void session.act(connection => connection.reducers.leaveRoom({})); });
const leaveDialog = element<HTMLDialogElement>("leave-dialog");
element("leave-match").addEventListener("click", () => {
  if (session.snapshot.room?.state === "finished") void session.act(connection => connection.reducers.leaveRoom({}));
  else leaveDialog.showModal();
});
leaveDialog.addEventListener("close", () => { if (leaveDialog.returnValue === "leave") void session.act(connection => connection.reducers.leaveRoom({})); });
element("camera-home").addEventListener("click", () => battlefield.home());
element("sound").addEventListener("click", () => { feedback.toggle(); element("sound").setAttribute("aria-pressed", String(feedback.enabled)); element("sound").title = feedback.enabled ? "Sound on" : "Sound off"; });
element("return-lobby").addEventListener("click", () => { void session.act(connection => connection.reducers.leaveRoom({})); });
element("camera-fit").addEventListener("click", () => battlefield.fit());
element("zoom-in").addEventListener("click", () => battlefield.zoom(1.25));
element("zoom-out").addEventListener("click", () => battlefield.zoom(0.8));
element("stop").addEventListener("click", () => battlefield.issue("stop"));
element("return").addEventListener("click", () => battlefield.issue("return"));
element("hold").addEventListener("click", () => battlefield.issue("hold"));
element("attack-move").addEventListener("click", () => battlefield.arm("attack_move"));
element("repair").addEventListener("click", () => battlefield.arm("repair"));
element("teleport").addEventListener("click", () => battlefield.arm("teleport"));
element("set-rally").addEventListener("click", () => battlefield.arm("rally"));
for (const [id, kind] of [["clear-rally", "clear_rally"], ["cancel-production", "cancel_production"]]) element(id).addEventListener("click", () => {
  const hq = productionBuilding();
  if (hq) void session.order([hq.id], { kind, x: 0, y: 0, target: 0 });
});
element("select-army").addEventListener("click", () => { battlefield.selectArmy(); });
element("idle-worker").addEventListener("click", () => battlefield.selectIdleWorker());
element<HTMLSelectElement>("producer-select").addEventListener("change", event => {
  battlefield.selected = new Set([Number((event.target as HTMLSelectElement).value)]); renderMatch();
});
for (const name of ["production", "build", "research"]) element(`tab-${name}`).addEventListener("click", () => {
  for (const other of ["production", "build", "research"]) {
    element(`tab-${other}`).setAttribute("aria-selected", String(name === other));
    element(`${other}-pane`).hidden = name !== other;
  }
});
for (const kind of BUILDABLE) element(`build-${kind}`).addEventListener("click", () => battlefield.arm(`build_${kind}`));
for (const kind of Object.keys(TECHNOLOGIES)) element(`research-${kind}`).addEventListener("click", () => {
  const lab = battlefield.ownedSelection().find(unit => unit.kind === "lab" && unit.constructionRemaining === 0n) ?? session.snapshot.units.find(unit => unit.owner === session.snapshot.me?.slot && unit.kind === "lab" && unit.constructionRemaining === 0n);
  if (lab) void session.order([lab.id], { kind: `research_${kind}`, x: 0, y: 0, target: 0 });
});
document.querySelectorAll<HTMLInputElement>("input[name=mode]").forEach(input => input.addEventListener("change", () => {
  if (input.value === "select" || input.value === "order" || input.value === "pan") battlefield.mode = input.value;
}));
// C&C style: a train button needs no building selected. The site is picked
// per click (see `trainingSite`), so repeated clicks spread over every
// barracks instead of stacking on one.
for (const kind of TRAINABLE) element(`train-${kind}`).addEventListener("click", () => {
  const site = siteFor(kind);
  if (site) void session.order([site.id], { kind: `train_${kind}`, x: 0, y: 0, target: 0 });
});

function renderLobby(): void {
  const { rooms, players, me, room } = session.snapshot;
  element("room-browser").hidden = !!room;
  element("waiting-room").hidden = !room;
  element<HTMLButtonElement>("create-room").disabled = !session.ready || !!room;
  element<HTMLButtonElement>("practice").disabled = !session.ready || !!room || practice.starting;
  element<HTMLButtonElement>("save-name").disabled = !session.ready;
  const open = rooms.filter(room => room.state === "lobby");
  const signature = JSON.stringify([session.ready, open.map(room => [String(room.id), room.name, room.capacity]), players.map(player => [player.identity.toHexString(), String(player.matchId), player.name, player.online, player.ready, player.faction.tag])]);
  if (signature !== lobbySignature) {
    lobbySignature = signature;
    const list = element("room-list");
    list.replaceChildren();
    element("room-count").textContent = String(open.length).padStart(2, "0");
    if (!open.length) list.append(text("p", session.ready ? "No open operations" : "Awaiting server connection", "empty-state"));
    for (const room of open) {
      const row = text("div", "", "room-row");
      const count = players.filter(player => player.matchId === room.id).length;
      row.append(text("strong", room.name), text("span", `${count} / ${room.capacity}`, "mono"));
      const join = text("button", "Join") as HTMLButtonElement;
      join.disabled = !session.ready || count >= room.capacity;
      join.addEventListener("click", () => { void session.act(async connection => { await connection.reducers.setName({ name: callsign.value.trim() }); await connection.reducers.joinRoom({ matchId: room.id }); }); });
      row.append(join); list.append(row);
    }
  }
  if (!room) return;
  const members = players.filter(player => player.matchId === room.id).sort((left, right) => left.slot - right.slot);
  element("waiting-name").textContent = room.name;
  element("room-code").textContent = `#${room.id}`;
  element<HTMLInputElement>("ready").checked = me?.ready ?? false;
  element<HTMLInputElement>("ready").disabled = !session.ready;
  const canStart = members.length >= 2 && members.every(player => player.ready && player.online);
  element<HTMLButtonElement>("start-match").disabled = !session.ready || !canStart || !room.host.isEqual(me!.identity);
  element("waiting-status").textContent = members.length < 2 ? "Waiting for another commander" : !canStart ? "Waiting for all commanders to be ready" : room.host.isEqual(me!.identity) ? "All commanders ready" : "Waiting for host to deploy";
  const roster = element("roster");
  roster.replaceChildren(...members.map(player => {
    const row = text("div", "", "roster-row");
    const name = text("div", "", "player-name");
    const swatch = text("span", "", "swatch"); swatch.style.background = COLORS[player.slot];
    name.append(swatch, text("strong", `${player.name}${room.host.isEqual(player.identity) ? " / host" : ""}`));
    // Every player's faction, their own choice or the one their slot dealt, is
    // public in the lobby: you pick yours below, and you can see what you are
    // about to play against before anyone readies.
    const faction = factionOf(player.faction);
    const tag = text("span", FACTION_LABEL[faction], `mono faction-tag ${faction}`);
    tag.title = FACTION_ECONOMY[faction];
    row.append(name, tag, text("span", player.online ? "Online" : "Offline", "mono"), text("span", player.ready ? "Ready" : "Not ready", "mono"));
    return row;
  }));
  const mine = me ? factionOf(me.faction) : "industrial";
  element("faction-brief").textContent = `You are ${FACTION_LABEL[mine]} / ${FACTION_ECONOMY[mine]} / slot ${me?.slot ?? 0}`;
  element("faction-brief").className = `mono faction-brief ${mine}`;
  // The picker follows the row rather than the click: an accepted change
  // arrives as a snapshot, and a refused one never moves the control at all.
  paint(factionPicker, mine);
  factionPicker.disabled = !session.ready;
}

function renderMatch(): void {
  const { room, me, units, players } = session.snapshot;
  if (!room || !me) return;
  const owned = units.filter(unit => unit.owner === me.slot);
  // Primary-hub victory: a player acts while any completed hub survives.
  const alive = owned.some(isCompletedHub);
  const producer = productionBuilding();
  const buildings = owned.filter(unit => isBuilding(unit.kind));
  const mobile = owned.filter(unit => takesSupply(unit.kind));
  const pending = owned.reduce((count, unit) => count + unit.production.filter(item => !item.kind.startsWith("research_")).length, 0);
  const canOrder = session.ready && session.matchReady && room.state === "playing" && alive;
  const balance: Cost = { material: me.material, catalyst: me.catalyst };
  const faction = myFaction();
  const labour = LABOUR[faction];
  const fields = battlefield.fields();
  element("match-name").textContent = room.name;
  element("material").textContent = String(balance.material);
  element("catalyst").textContent = String(balance.catalyst);
  element("catalyst-readout").classList.toggle("empty", balance.catalyst === 0);
  element("unit-count").textContent = `${mobile.length} / ${MAX_UNITS}`;
  // The server owns the map; this client only draws its bundled copy. If they
  // differ (a stale bundle after a republish), say so once per match rather
  // than silently drawing walls that are not there.
  if (room.mapHash !== MAP_HASH && warnedMapRoom !== room.id) {
    warnedMapRoom = room.id;
    session.onNotice(`This client's map (${mapIdentity.id} v${mapIdentity.version}) differs from the server's (${room.mapId} v${room.mapVersion}). Reload to update; terrain shown may be wrong.`);
  }
  element("faction-name").textContent = FACTION_LABEL[faction].toUpperCase();
  element("faction-readout").className = `readout faction ${faction}`;
  element("faction-readout").title = `You are playing ${FACTION_LABEL[faction]} / ${FACTION_ECONOMY[faction]}`;
  // Harvester stock is a real balance: free labour gated on an invisible
  // counter would be unreadable, so it reads next to material and catalyst,
  // and only for Organic, where it means anything. Training picks its own hub
  // now, so the readout is every finished hub's stock together, unless one
  // hub is selected, in which case it is that hub's.
  const selectedHub = producer && isHub(producer.kind) && battlefield.selected.has(producer.id) ? producer : undefined;
  const stockHubs = selectedHub ? [selectedHub] : owned.filter(isCompletedHub);
  const stock = stockHubs.reduce((total, hub) => total + hub.stock, 0);
  element("stock-readout").hidden = faction !== "organic";
  element("stock").textContent = `${stock} / ${HUB_STOCK_CAP * Math.max(1, stockHubs.length)}`;
  element("stock-readout").classList.toggle("empty", stock === 0);
  element("stock-readout").title = selectedHub
    ? `Harvester stock at ${CATALOG[selectedHub.kind].label} #${selectedHub.id} / ${STOCK_REASON.slice(STOCK_REASON.indexOf("it regenerates"))}`
    : `Harvester stock across ${stockHubs.length} hub${stockHubs.length === 1 ? "" : "s"} / ${STOCK_REASON.slice(STOCK_REASON.indexOf("it regenerates"))}`;
  for (const kind of TRAINABLE) {
    const definition = CATALOG[kind];
    const button = element<HTMLButtonElement>(`train-${kind}`);
    // A faction never sees another faction's labour or army. There is no order
    // that would make it buildable, so a disabled button would only be noise.
    button.hidden = LABOUR_KINDS.includes(kind) ? kind !== labour : armyFaction(kind) !== faction;
    if (button.hidden) continue;
    // A harvester is bought with hub stock and no currency at all, so its only
    // possible refusal is the stock one — quoted exactly as the server gives it.
    const stockless = kind === "harvester" && stock === 0;
    const site = siteFor(kind);
    const blocked = stockless || !canOrder || !site || mobile.length + pending >= MAX_UNITS;
    const where = site ? ` / Trains at ${CATALOG[site.kind].label} #${site.id}` : "";
    affordability(button, definition.cost, balance, blocked, stockless ? `${definition.role} / ${STOCK_REASON}` : `${definition.role}${where}`);
  }
  const producers = buildings.filter(unit => isProducer(unit, faction, fields));
  const nextSignature = producers.map(unit => `${unit.id}:${unit.kind}`).join(",");
  if (nextSignature !== producerSignature) {
    producerSignature = nextSignature;
    element("producer-select").replaceChildren(...producers.map(unit => { const option = text("option", `${CATALOG[unit.kind].label} #${unit.id}`) as HTMLOptionElement; option.value = String(unit.id); return option; }));
  }
  element<HTMLSelectElement>("producer-select").value = String(producer?.id ?? 0);
  for (const kind of BUILDABLE) {
    const definition = CATALOG[kind];
    const owner = BUILDING_FACTION[kind];
    const button = element<HTMLButtonElement>(`build-${kind}`);
    if (owner) button.hidden = owner !== faction;
    if (button.hidden) continue;
    // Construction is driven by any labour unit now, not only by a worker:
    // gating this on "worker" left Network and Organic unable to build at all.
    const blocked = !canOrder || !battlefield.issuer() || buildings.length >= 16 || (kind === "factory" && !buildings.some(unit => unit.kind === "barracks" && unit.constructionRemaining === 0n));
    affordability(element<HTMLButtonElement>(`build-${kind}`), definition.cost, balance, blocked, definition.role);
    element(`build-${kind}`).setAttribute("aria-pressed", String(battlefield.targeting === `build_${kind}`));
  }
  element("building-count").textContent = `${buildings.length} / 16 structures`;
  for (const [kind, definition] of Object.entries(TECHNOLOGIES)) {
    const researched = me.research.includes(`research_${kind}`);
    const queued = owned.some(unit => unit.production.some(item => item.kind === `research_${kind}`));
    const button = element<HTMLButtonElement>(`research-${kind}`);
    const blocked = !canOrder || !!researched || queued || !buildings.some(unit => unit.kind === "lab" && unit.constructionRemaining === 0n && unit.production.length < 8);
    // A technology already bought or queued is never short of anything, so it
    // is priced at nothing and reads as complete rather than unaffordable.
    const cost = researched || queued ? { material: 0, catalyst: 0 } : RESEARCH_COST;
    affordability(button, cost, balance, blocked, `${definition.description}${researched ? " / Complete" : queued ? " / Researching" : " / Requires laboratory"}`);
    button.classList.toggle("completed", !!researched);
  }
  element("research-status").textContent = me.research.length ? me.research.map(kind => kind.slice(9)).join(" / ") : "No upgrades";
  const selection = units.filter(unit => battlefield.selected.has(unit.id));
  element("selection-title").textContent = selection.length === 1 ? VISUALS[selection[0].kind]?.label ?? selection[0].kind : selection.length ? `${selection.length} units` : "No selection";
  // Cargo is reported by the currency each carrier is actually carrying, since
  // one load is one currency and the two are not interchangeable. A drifter is
  // deliberately excluded: it holds nothing, ever, so a "0 cargo" line would be
  // a lie about a unit that has no cargo model at all.
  const carriers = selection.filter(unit => carriesCargo(unit.kind));
  const carried = carriers.reduce((total, unit) => addCost(total, { material: 0, catalyst: 0, [currencyOf(unit.cargoKind)]: unit.cargo }), { material: 0, catalyst: 0 });
  const cargoLabel = CURRENCIES.filter(currency => carried[currency] > 0).map(currency => `${carried[currency]} ${currency}`).join(" + ") || "0";
  const drifting = selection.some(unit => gathersInPlace(unit.kind));
  const hubs = selection.filter(unit => isHub(unit.kind) && unit.owner === me.slot);
  element("selection-details").textContent = selection.length
    ? `${selection.reduce((sum, unit) => sum + unit.hp, 0)} HP`
      + (selection.some(unit => unit.maxShields > 0) ? ` / ${selection.reduce((sum, unit) => sum + unit.shields, 0)} shields` : "")
      + (carriers.length ? ` / ${cargoLabel} cargo` : "")
      + (drifting ? " / credits in place" : "")
      + (faction === "organic" && hubs.length ? ` / ${hubs.reduce((sum, unit) => sum + unit.stock, 0)} / ${hubs.length * HUB_STOCK_CAP} stock` : "")
    : "";
  element<HTMLButtonElement>("stop").disabled = !canOrder || !battlefield.ownedSelection().some(unit => !isBuilding(unit.kind));
  // Only a carrier can be told to take a load home. A drifter has no load.
  element<HTMLButtonElement>("return").disabled = !canOrder || !battlefield.ownedSelection().some(unit => carriesCargo(unit.kind));
  // A harvester gathers only: the server refuses it hold and attack-move by name.
  for (const id of ["hold", "attack-move"]) element<HTMLButtonElement>(id).disabled = !canOrder || !battlefield.ownedSelection().some(unit => fights(unit.kind));
  element<HTMLButtonElement>("repair").disabled = !canOrder || !battlefield.ownedSelection().some(unit => isLabour(unit.kind));
  // Teleport is Network's alone, and only for units already inside the field.
  element("teleport").hidden = faction !== "network";
  element<HTMLButtonElement>("teleport").disabled = !canOrder || !battlefield.teleporters().length;
  element<HTMLButtonElement>("set-rally").disabled = !canOrder;
  element<HTMLButtonElement>("clear-rally").disabled = !canOrder || !producer?.order.kind.startsWith("rally_");
  // An Organic outpost queues harvesters but is not a production *control*:
  // the server takes rally and cancellation only at an HQ, barracks, factory or
  // lab, so the button is disabled there rather than sending a refused order.
  const controllable = !!producer && isBuilding(producer.kind);
  element<HTMLButtonElement>("cancel-production").disabled = !canOrder || !producer?.production.length || !controllable;
  element<HTMLButtonElement>("idle-worker").disabled = !canOrder || !owned.some(unit => isLabour(unit.kind) && unit.order.kind === "stop");
  element("idle-worker").title = `Select idle ${CATALOG[labour].label.toLowerCase()}`;
  element("idle-worker").setAttribute("aria-label", element("idle-worker").title);
  const refund = (producer?.production ?? []).reduce((total, item) => addCost(total, costOf(item.kind)), { material: 0, catalyst: 0 });
  // A cancelled harvester costs nothing to refund in currency and everything in
  // stock, so the refund is quoted in both rather than reading as "nothing".
  const stocked = (producer?.production ?? []).filter(item => item.kind === "harvester").length;
  const refundParts = [formatCost(refund) === "nothing" ? "" : formatCost(refund), stocked ? `${stocked} hub stock` : ""].filter(Boolean);
  element("cancel-production").title = controllable
    ? `Cancel all unfinished production / refund ${refundParts.join(" + ") || "nothing"}`
    : "Select a building with a production queue";
  const rallyNode = producer?.order.kind === "rally_gather" ? session.snapshot.nodes.find(node => node.id === producer.order.target) : undefined;
  element("rally-status").textContent = producer?.order.kind === "rally_move" ? `Rally ${Math.round(producer.order.x)}, ${Math.round(producer.order.y)}`
    : producer?.order.kind === "rally_gather" ? `${rallyNode ? CURRENCY_LABEL[currencyOf(rallyNode.kind)] : "Deposit"} rally #${producer.order.target}` : "Rally unset";
  element("selection-order").textContent = selection.length === 1 ? selection[0].constructionRemaining > 0n ? `Constructing / ${(Number(selection[0].constructionRemaining) / 20).toFixed(1)}s left` : selection[0].order.kind.split("_").join(" ") : "";
  const targetLabel = battlefield.targeting?.startsWith("build_") ? `Place ${CATALOG[battlefield.targeting.slice(6)].label}` : battlefield.targeting === "attack_move" ? "Attack-move target" : battlefield.targeting === "repair" ? "Repair target" : battlefield.targeting === "teleport" ? "Teleport destination / inside your power field" : "Rally target";
  element("targeting-state").hidden = !battlefield.targeting;
  element("targeting-state").textContent = targetLabel;
  for (const [id, kind] of [["attack-move", "attack_move"], ["repair", "repair"], ["set-rally", "rally"], ["teleport", "teleport"]]) element(id).setAttribute("aria-pressed", String(battlefield.targeting === kind));
  const result = room.state === "finished" ? room.winner === -1 ? "Draw" : room.winner === me.slot ? "Victory" : "Defeat" : session.matchReady && !alive ? "Eliminated" : "";
  element("result").hidden = !result;
  element("result-title").textContent = result;
  const members = players.filter(player => player.matchId === room.id).sort((left, right) => left.slot - right.slot);
  if (seenMatch !== room.id) { seenMatch = room.id; seenPlayers.clear(); }
  for (const player of members) {
    seenPlayers.set(player.slot, {
      slot: player.slot, name: player.name, faction: factionOf(player.faction),
      // Last-hit attribution, kept from the row the server wrote: it is final
      // by the time a player can leave, and it is the only place it lives.
      killed: { material: player.killedMaterial, catalyst: player.killedCatalyst },
    });
  }
  // The score screen only ever replaces a *finished* match. "Eliminated"
  // arrives while the room is still playing and stays the small banner it was,
  // because there is still a match under it to look at.
  const finished = room.state === "finished";
  element("result").classList.toggle("final", finished);
  if (finished) {
    score.render({
      matchId: room.id, winner: room.winner, mySlot: me.slot,
      samples: session.snapshot.samples,
      players: [...seenPlayers.values()].sort((left, right) => left.slot - right.slot),
    });
  } else score.hide();
  const signature = JSON.stringify(members.map(player => [player.name, player.slot, player.online, player.faction.tag]));
  if (signature !== rosterSignature) {
    rosterSignature = signature;
    element("battle-players").replaceChildren(...members.map(player => {
      const row = text("div", "", `battle-player${player.online ? "" : " offline"}`);
      // Which economy each opponent is playing is public and decides how the
      // match reads: a drifter line is not a worker line under attack.
      row.append(text("span", `${player.name}${player.slot === me.slot ? " / you" : ""}${player.online ? "" : " / offline"}`, "battle-player-name"),
        text("span", FACTION_LABEL[factionOf(player.faction)], `faction-tag ${factionOf(player.faction)}`));
      row.style.borderColor = COLORS[player.slot]; return row;
    }));
  }
}

function renderTimers(): void {
  const { room, me, commands } = session.snapshot;
  if (!room || !me || room.state === "lobby") return;
  const seconds = Number(room.tick / 20n);
  element("match-clock").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const hq = productionBuilding();
  // A selected building shows its own queue; otherwise everything in
  // production, soonest first, because training no longer needs a selection.
  const selectedProducer = hq && battlefield.selected.has(hq.id) ? hq : undefined;
  const queued = selectedProducer ? selectedProducer.production : session.snapshot.units.filter(unit => unit.owner === me.slot).flatMap(unit => unit.production).filter(item => !item.kind.startsWith("research_")).sort((left, right) => Number(left.finishTick - right.finishTick));
  element("production-queue").replaceChildren(...queued.map(item => text("span", `${item.kind} ${Math.max(0, Number(item.finishTick - room.tick) / 20).toFixed(1)}s`, "production-item")));
  const technology = me.research.map(kind => kind.slice(9));
  const research = session.snapshot.units.filter(unit => unit.owner === me.slot).flatMap(unit => unit.production).filter(item => item.kind.startsWith("research_")).map(item => `${item.kind.slice(9)} ${Math.max(0, Number(item.finishTick - room.tick) / 20).toFixed(1)}s`);
  element("research-status").textContent = [...technology, ...research].join(" / ") || "No upgrades";
  const ours = commands.filter(command => command.owner === me.slot).sort((left, right) => left.id > right.id ? -1 : 1);
  element("pending-count").textContent = String(ours.filter(command => command.status === "scheduled").length + session.pending.size);
  const rows = [...session.pending.values()].map(pending => {
    const row = text("div", "", "command-row"); row.append(text("span", pending.order.kind, "command-label"), text("span", "Sending", "command-status")); return row;
  });
  for (const command of ours.slice(0, 8)) {
    const row = text("div", "", `command-row ${command.status}`);
    const label = command.order.kind.split("_").join(" ");
    row.append(text("span", `${label} / ${command.units.length}`, "command-label"), text("span", command.status === "scheduled" ? `${countdown(command.executeTick, room.tick, performance.now() - session.tickReceivedAt).toFixed(1)}s` : command.status, "command-status"));
    row.title = command.reason;
    if (command.status === "rejected" && command.reason) {
      // A refusal that names a currency is tinted with that currency, so the
      // inline reason says which balance was short at a glance as well as in
      // words. The text itself is the server's, unaltered.
      const currency = CURRENCIES.find(currency => command.reason.includes(`Insufficient ${currency}`));
      row.append(text("span", command.reason, `command-reason${currency ? ` ${currency}` : ""}`));
    }
    rows.push(row);
  }
  element("command-list").replaceChildren(...rows);
  const age = Math.round(performance.now() - session.tickReceivedAt);
  element("telemetry").textContent = `TICK ${room.tick} / ACK ${session.ackMs}ms${room.state === "playing" && age > 1000 ? ` / STALE ${Math.floor(age / 1000)}s` : ""}`;
}

function render(): void {
  feedback.update(session.snapshot);
  const playing = !!session.snapshot.room && session.snapshot.room.state !== "lobby";
  element("lobby").hidden = playing;
  element("match").hidden = !playing;
  element("status").textContent = session.status;
  element("connection-dot").classList.toggle("online", session.ready);
  battlefield.sync();
  if (playing) { renderMatch(); renderTimers(); } else renderLobby();
}

battlefield.onSelection = renderMatch;
practice.onChange = render;
session.onChange = render;
setInterval(renderTimers, 100);
connect();