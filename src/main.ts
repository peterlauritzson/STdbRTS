import "../styles.css";
import { createElement, createIcons, BookOpen, Keyboard, Crosshair, Radio, RadioTower, Plus, Play, LogOut, House, Maximize2, ZoomIn, ZoomOut, MousePointer2, Move, Square, CornerDownLeft, Swords, Hammer, Shield, Wrench, Flag, FlagOff, X, Radar, Tent, Factory, Warehouse, FlaskConical, HardHat, Trash2, Bot, Volume2, Boxes, Gem, Hexagon, Fuel, Sprout, SatelliteDish, Zap, Sparkles, ShieldHalf, Wind, Bug, Droplets, Undo2, Flower, Target, HeartPulse, BrickWall, Waypoints, Ghost, Eye, Footprints, Flame, Skull, Castle, Triangle, Repeat, Rabbit, ShieldCheck, MessageSquare, type IconNode } from "lucide";
import { ABILITIES, castRefusal, scheduledCasts, type AbilityKind } from "./abilities";
import { Battlefield } from "./battlefield";
import { Session } from "./network";
import { countdown, ownerColor, TICK_MS, VISUALS } from "./presentation";
import { ALERT_BANNER_MS, alertText } from "./alerts";
import { availableAfter, pendingLabel, pendingSpend, refusedCurrency } from "./spend";
import { addCost, NO_COST, buildTierError, LEVELED_RESEARCH, MAX_RESEARCH_LEVEL, researchLevel, researchSummary, isCompletedHub, ROSTER, armyBuilding, armyFaction, describe, passiveLine, veteranStacks, isVeteran, CATALOG, costOf, CURRENCIES, currencyOf, formatCost, RESEARCH_COST, TIERS, TIER_UPGRADES, tierOrder, tierOf, requiredTier, researchReason, shortfall, shortfallReason, TECHNOLOGIES, STANCES, DOCTRINE_DEFAULT_WEIGHT, DOCTRINE_MAX_WEIGHT, DOCTRINE_RESERVE_STEP, DOCTRINE_MAX_RESERVE, DOCTRINE_SWITCH, DOCTRINE_RESERVE_ORDER, DOCTRINE_PRESETS, doctrineWeightOrder, presetWeights, defaultStance, stanceOrder, type StanceName, fights, isBuilding, takesSupply, carriesCargo, factionForSlot, factionOf, FACTION_ECONOMY, FACTION_LABEL, FACTIONS, gathersInPlace, HUB_STOCK_CAP, isHub, isLabour, LABOUR, MAP_HASH, mapIdentity, MAX_BUILDINGS, MAX_UNITS, parseFaction, PRACTICE_SLOT, STOCK_REASON, worldSize, type Cost, type FactionName } from "./catalog";
import { Practice, type PracticeOpponent } from "./practice";
import { Feedback } from "./feedback";
import { ScoreScreen, type ScorePlayer } from "./scorescreen";
import { BUILDING_FACTION, powered, type Field } from "./zones";
import { queueView, rallyText, scheduledTraining, trainingSite } from "./production";
import { BUILD_KEYS, BUILD_MENU_KEY, keyLabel, OPERATION_KEYS, TRAIN_KEYS, UNIT_KEYS } from "./hotkeys";
import { Operations } from "./operations";
import { Missions, MAX_SIZE, PERCENT_STEP, TACTICS, TACTIC_IDS, gatherRadius, memberActivities, missionGoals, missionLabel, type Mission, type Tactic } from "./missions";
import type { Entity } from "./units";
import { armyRoster, visibleRows, type RosterRow } from "./roster";
import { behaviorLine } from "./behaviors";
import { ChatPanel } from "./chat";

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
function costLine(cost: Cost, seconds: number | string): HTMLElement {
  const line = text("small", "", "cost-line");
  const parts = CURRENCIES.filter(currency => cost[currency] > 0);
  if (!parts.length) line.append(text("span", "free", "cost-part"));
  for (const [index, currency] of parts.entries()) {
    if (index) line.append(document.createTextNode(" + "));
    line.append(text("span", `${cost[currency]} ${currency}`, `cost-part ${currency}`));
  }
  line.append(document.createTextNode(typeof seconds === "number" ? ` / ${seconds}s` : ` / ${seconds}`));
  return line;
}

function catalogButton(id: string, label: string, cost: Cost, seconds: number | string, icon: string, title: string): HTMLButtonElement {
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
/** Rewrites a button's caption in place (label, then the price line, or "max" with no price). Skipped when nothing changed. */
function recaption(button: HTMLButtonElement, label: string, cost: Cost | undefined, seconds: number | string): void {
  const signature = `${label}|${cost ? formatCost(cost) : "max"}`;
  if (button.dataset.caption === signature) return;
  button.dataset.caption = signature;
  button.querySelector(":scope > span")?.replaceChildren(document.createTextNode(label), cost ? costLine(cost, seconds) : text("small", "max", "cost-line"));
}

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
const TRAINABLE = [...LABOUR_KINDS, ...FACTIONS.flatMap(faction => ROSTER[faction])];
for (const kind of TRAINABLE) {
  const definition = CATALOG[kind];
  const button = catalogButton(`train-${kind}`, definition.label, definition.cost, definition.seconds, definition.icon, describe(kind));
  button.hidden = true;
  // Second- and third-tier units say which tier they wait for while locked.
  if (requiredTier(kind)) { const tag = text("em", `Tier ${requiredTier(kind)}`, "tier-tag"); tag.hidden = true; button.append(tag); }
  element("training-buttons").append(button);
}
/**
 * Every building has a button. A faction building — the Industrial sensor, the
 * Network relay, the Organic tumor — is hidden from the other factions outright, as another
 * faction's labour is: the server refuses it by name, so a disabled button
 * would only be noise.
 */
// The order is the build card's hotkey order (Q W E R T Y U I over the visible
// buttons): faction buildings that are hidden leave no gap, and the refinery
// lands on U for every faction because each has exactly one building before it
// (sensor, relay or tumor) and the bunker, bastion or spine after it; the
// synthesizer is last, on P.
const BUILDABLE = ["barracks", "outpost", "turret", "factory", "lab", "sensor", "relay", "tumor", "refinery", "bunker", "bastion", "spine", "synthesizer"];
for (const kind of BUILDABLE) {
  const definition = CATALOG[kind];
  const button = catalogButton(`build-${kind}`, definition.label, definition.cost, definition.seconds, definition.icon, describe(kind));
  if (BUILDING_FACTION[kind]) button.hidden = true;
  element("building-buttons").append(button);
}
/**
 * The Research tab: the three technologies, then the three tiers. Both are
 * instant, so the cost line says so instead of giving a duration. Order kinds
 * are `research_<id>` and `tier_<n>`; the button ids are `research-<id>` and
 * `research-tier_<n>`.
 */
const RESEARCH_BUTTONS: readonly { id: string; order: string; label: string; icon: string; cost: Cost; description: string; tier: number }[] = [
  ...Object.entries(TECHNOLOGIES).map(([id, definition]) => ({ id, order: `research_${id}`, label: definition.label, icon: definition.icon, cost: RESEARCH_COST, description: definition.description, tier: 0 })),
  ...([1, 2, 3] as const).map(tier => ({ id: `tier_${tier}`, order: tierOrder(tier), label: TIERS[tier].label, icon: ["tent", "factory", "flask-conical"][tier - 1], cost: TIERS[tier].cost, description: `Unlocks ${TIERS[tier].unlocks}`, tier })),
];
for (const research of RESEARCH_BUTTONS) {
  const button = catalogButton(`research-${research.id}`, research.label, research.cost, "instant", research.icon, research.description);
  // Weapons and armour have levels; a locked level names the tier it waits for.
  if (LEVELED_RESEARCH.includes(research.order)) { const tag = text("em", "", "tier-tag"); tag.hidden = true; button.append(tag); }
  element("research-buttons").append(button);
}
createIcons({ icons: { Crosshair, Radio, RadioTower, Plus, Play, LogOut, House, Maximize2, ZoomIn, ZoomOut, MousePointer2, Move, Square, CornerDownLeft, Swords, Hammer, Shield, Wrench, Flag, FlagOff, X, Radar, Tent, Factory, Warehouse, FlaskConical, HardHat, Trash2, Bot, Volume2, Boxes, Gem, Hexagon, Fuel, Sprout, SatelliteDish, Zap, Sparkles, ShieldHalf, Wind, Bug, Droplets, Undo2, Flower, BookOpen, Keyboard, Target, HeartPulse, BrickWall, Waypoints, Ghost, Eye, Footprints, Flame, Skull, Castle, Triangle, Repeat, Rabbit, ShieldCheck, MessageSquare } });
/** Catalogue icon names to icon nodes, for portraits built after `createIcons` has run. */
const ICON_NODES: Record<string, IconNode> = {
  house: House, hammer: Hammer, radio: Radio, sprout: Sprout, swords: Swords, radar: Radar, crosshair: Crosshair,
  "shield-half": ShieldHalf, wind: Wind, zap: Zap, bug: Bug, droplets: Droplets, tent: Tent, factory: Factory,
  shield: Shield, warehouse: Warehouse, "flask-conical": FlaskConical, "satellite-dish": SatelliteDish, fuel: Fuel,
  target: Target, "heart-pulse": HeartPulse, "brick-wall": BrickWall, waypoints: Waypoints, ghost: Ghost, eye: Eye,
  footprints: Footprints, flame: Flame, skull: Skull, castle: Castle, triangle: Triangle, repeat: Repeat,
};
function icon(name: string): SVGElement {
  return createElement(ICON_NODES[name] ?? Square);
}

/**
 * Prints a key on a button, in the corner, hidden from the accessibility tree
 * so the button's name stays exactly what it was ("Drifter 40 material / 2.5s").
 * An empty key removes the badge.
 */
function badge(button: HTMLElement, key: string | undefined): void {
  let node = button.querySelector<HTMLElement>(":scope > kbd.key");
  if (!key) { node?.remove(); return; }
  if (!node) { node = document.createElement("kbd"); node.className = "key"; node.setAttribute("aria-hidden", "true"); button.append(node); }
  const label = keyLabel(key);
  if (node.textContent !== label) node.textContent = label;
}
for (const [id, key] of [["stop", UNIT_KEYS.stop], ["attack-move", UNIT_KEYS.attackMove], ["hold", UNIT_KEYS.hold], ["mission-harass", UNIT_KEYS.harass], ["mission-guard", UNIT_KEYS.guard], ["mission-raid", UNIT_KEYS.raid], ["mission-rush", UNIT_KEYS.rush], ["mission-gather", UNIT_KEYS.gather], ["repair", UNIT_KEYS.repair], ["return", UNIT_KEYS.returnCargo], ["teleport", UNIT_KEYS.teleport], ["recall", UNIT_KEYS.ability], ["bloom", UNIT_KEYS.ability], ["set-rally", UNIT_KEYS.rally], ["expand", OPERATION_KEYS.expand], ["territory", OPERATION_KEYS.territory], ["auto-labour", OPERATION_KEYS.autoLabour], ["idle-worker", "F1"], ["select-army", "F2"]] as const) {
  const button = element(id);
  badge(button, key);
  button.title = `${button.title} (${keyLabel(key)})`;
}
// Select / Order / Pan exists for touch, where there is no right button.
document.body.classList.toggle("no-touch", navigator.maxTouchPoints === 0);
element("map-size").textContent = `${worldSize} x ${worldSize}`;
element("map-coordinate").textContent = `N / ${worldSize}`;
element("unit-capacity").textContent = `${MAX_UNITS} / player`;
const session = new Session();
const practice = new Practice(session);
const feedback = new Feedback(message => session.onNotice(message));
element("sound").setAttribute("aria-pressed", String(feedback.enabled));
element("sound").title = feedback.enabled ? "Sound on" : "Sound off";
const battlefield = new Battlefield(element<HTMLCanvasElement>("battlefield"), element<HTMLCanvasElement>("minimap"), session);
const operations = new Operations(session, () => battlefield.issuer());
const missions = new Missions(session, () => battlefield.issuer());
battlefield.onMission = (tactic, point, selected) => missions.add(tactic, point, selected);
battlefield.onMissionRally = (id, point) => missions.setRally(id, point);
battlefield.missions = () => missions.list.map(mission => ({ id: mission.id, x: mission.x, y: mission.y, label: missionLabel(mission, gatheredCount(mission)), color: TACTICS[mission.tactic].color, leash: mission.tactic === "guard", goals: missionGoals(mission), ...(mission.tactic === "gather" ? { rally: mission.rally } : {}) }));
battlefield.missionAt = point => missions.at(point)?.id;
battlefield.onAssign = (id, selected) => missions.assign(id, selected);
battlefield.onExpand = point => operations.begin(point);
battlefield.onTerritory = point => operations.beginTerritory(point);
battlefield.overlays = () => operations.paths();
battlefield.expandPreview = point => operations.preview(point);
battlefield.territoryPreview = point => operations.previewTerritory(point);
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
// The order delay is frozen into the room at creation; the practice pick is kept like the others.
const practiceDelay = element<HTMLSelectElement>("practice-delay");
const PRACTICE_DELAY_KEY = "stdbrts:v1:practice-delay";
const delayChoice = (value: string | null): number => value === "10" || value === "30" ? Number(value) : 20;
practiceDelay.value = String(delayChoice(localStorage.getItem(PRACTICE_DELAY_KEY)));
practiceDelay.addEventListener("change", () => localStorage.setItem(PRACTICE_DELAY_KEY, String(delayChoice(practiceDelay.value))));
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
  // Tab's active subgroup narrows "train here" to those buildings.
  const active = new Set(battlefield.activeSelection().map(unit => unit.id));
  return trainingSite(kind, myFaction(), owned, active, scheduledTraining(session.snapshot.commands, me.slot), battlefield.fields());
}

function productionBuilding() {
  const faction = myFaction();
  const fields = battlefield.fields();
  const owned = battlefield.activeSelection().find(unit => isProducer(unit, faction, fields));
  return owned ?? battlefield.issuer();
}

/** How long a notice stays before it clears itself: long enough to read, short enough not to go stale. */
const sendChat = (text: string) => session.act(connection => connection.reducers.sendChat({ text }));
const lobbyChat = new ChatPanel(element("lobby-chat"), false, sendChat);
const matchChat = new ChatPanel(element("match-chat"), true, sendChat);
let chatRoom: bigint | undefined;
function syncChatToggle(): void { element("chat-toggle").setAttribute("aria-expanded", String(matchChat.isOpen)); }
matchChat.onClose = () => { syncChatToggle(); element("battlefield").focus({ preventScroll: true }); };
element("chat-toggle").addEventListener("click", () => { matchChat.toggle(); syncChatToggle(); });
// Enter opens the match chat from anywhere on the battlefield, as in SC2. Typing
// is safe: the battlefield ignores keys aimed at an input.
window.addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement || document.querySelector("dialog[open]")) return;
  if (element("match").hidden) return;
  event.preventDefault();
  matchChat.open();
  syncChatToggle();
});
function renderChat(): void {
  const { room, me, chat } = session.snapshot;
  if (room?.id !== chatRoom) { chatRoom = room?.id; lobbyChat.reset(); matchChat.reset(); matchChat.close(); }
  const ready = session.ready && session.matchReady;
  lobbyChat.render(chat, me?.slot, ready);
  matchChat.render(chat, me?.slot, ready);
}
const NOTICE_MS = 4000;
let warnedMapRoom: bigint | undefined;
session.onNotice = message => {
  clearTimeout(noticeTimer);
  // An empty message withdraws the notice: a refusal that has since been
  // answered (a placement that failed and then succeeded) must not linger.
  if (!message) { element("notice").hidden = true; return; }
  element("notice").textContent = message;
  element("notice").hidden = false;
  noticeTimer = setTimeout(() => { element("notice").hidden = true; }, NOTICE_MS);
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
element("practice").addEventListener("click", () => { void practice.start(host.value.trim(), database.value.trim(), callsign.value, chosen(practiceFaction, factionForSlot(PRACTICE_SLOT)), opponentChoice(practiceOpponent.value), delayChoice(practiceDelay.value)); });
element("name-form").addEventListener("submit", event => {
  event.preventDefault();
  localStorage.setItem("stdbrts:v2:callsign", callsign.value.trim());
  void session.act(connection => connection.reducers.setName({ name: callsign.value.trim() }));
});
element("create-form").addEventListener("submit", async event => {
  event.preventDefault();
  await session.act(async connection => {
    await connection.reducers.setName({ name: callsign.value.trim() });
    await connection.reducers.createRoom({ name: element<HTMLInputElement>("room-name").value.trim(), capacity: Number(element<HTMLSelectElement>("capacity").value), commandDelay: BigInt(delayChoice(element<HTMLSelectElement>("command-delay").value)) });
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
/** The Strategy panel's mission buttons: arm placement; the next map or minimap click puts the mission there. */
for (const kind of TACTIC_IDS) {
  const button = element(`mission-${kind}`);
  button.title = `${TACTICS[kind].hint}. Click, then click the map: a standing mission the server keeps staffed with idle and new army units, with any selected army joining it`;
  button.querySelector<HTMLElement>(".swatch")!.style.background = TACTICS[kind].color;
  button.addEventListener("click", () => battlefield.arm(`mission_${kind}`));
}
/**
 * The Strategy window: missions, stances, production doctrine and the order
 * log at a readable size, over the right of the battlefield. Not modal, so the
 * map stays live beside it and a mission can be placed straight from it. F3
 * toggles it; Esc closes it once nothing is being aimed. The deck's Strategy
 * section keeps the launch buttons and a one-line-per-mission summary.
 */
type StrategyTab = "missions" | "stances" | "production" | "orders";
const STRATEGY_TABS: readonly StrategyTab[] = ["missions", "stances", "production", "orders"];
const STRATEGY_TAB_KEY = "strategy-tab";
let strategyTab: StrategyTab = "missions";
try { const saved = localStorage.getItem(STRATEGY_TAB_KEY); if (STRATEGY_TABS.includes(saved as StrategyTab)) strategyTab = saved as StrategyTab; } catch { /* storage blocked: start on Missions */ }
function showStrategyTab(tab: StrategyTab): void {
  strategyTab = tab;
  try { localStorage.setItem(STRATEGY_TAB_KEY, tab); } catch { /* storage blocked: the tab is just not remembered */ }
  for (const id of STRATEGY_TABS) {
    element(`sw-tab-${id}`).setAttribute("aria-selected", String(id === tab));
    element(`sw-${id}`).hidden = id !== tab;
  }
}
const strategyOpen = (): boolean => !element("strategy-window").hidden;
function openStrategy(tab?: StrategyTab): void {
  if (tab) showStrategyTab(tab);
  element("strategy-window").hidden = false;
  element("strategy-open").setAttribute("aria-expanded", "true");
  // Help sits in the same corner: one panel at a time.
  element("help").hidden = true;
  element("help-toggle").setAttribute("aria-expanded", "false");
}
function closeStrategy(): void {
  element("strategy-window").hidden = true;
  element("strategy-open").setAttribute("aria-expanded", "false");
}
function toggleStrategy(): void { if (strategyOpen()) closeStrategy(); else openStrategy(); }
showStrategyTab(strategyTab);
element("strategy-open").addEventListener("click", toggleStrategy);
element("strategy-close").addEventListener("click", () => { closeStrategy(); element("battlefield").focus({ preventScroll: true }); });
// Tabs switch in place; the deck's links open the window on their tab, or close it if it already shows that tab.
for (const button of document.querySelectorAll<HTMLElement>("[data-strategy-tab]")) button.addEventListener("click", () => {
  const tab = button.dataset.strategyTab as StrategyTab;
  if (button.getAttribute("role") === "tab") showStrategyTab(tab);
  else if (strategyOpen() && strategyTab === tab) closeStrategy();
  else openStrategy(tab);
});
// The window's launch cards press the deck button of the same name, so both share one handler and one state.
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-launch]")) {
  button.querySelector<HTMLElement>(".swatch")?.style.setProperty("background", TACTICS[button.dataset.launch!.replace("mission-", "") as Tactic]?.color ?? "");
  button.addEventListener("click", () => element<HTMLButtonElement>(button.dataset.launch!).click());
}
element("repair").addEventListener("click", () => battlefield.arm("repair"));
element("teleport").addEventListener("click", () => battlefield.arm("teleport"));
for (const kind of ["recall", "bloom"] as const) element(kind).addEventListener("click", () => battlefield.arm(kind));
element("set-rally").addEventListener("click", () => battlefield.arm("rally"));
element("expand").addEventListener("click", () => { battlefield.arm("expand"); });
element("territory").addEventListener("click", () => { battlefield.arm("territory"); });
element("auto-labour").addEventListener("click", () => { operations.toggleAutoLabour(); });
for (const [id, kind] of [["clear-rally", "clear_rally"], ["cancel-production", "cancel_production"]]) element(id).addEventListener("click", () => {
  const hq = productionBuilding();
  if (hq) void session.order([hq.id], { kind, x: 0, y: 0, target: 0 });
});
element("select-army").addEventListener("click", () => { battlefield.selectArmy(); });
element("idle-worker").addEventListener("click", () => battlefield.selectIdleWorker());
element<HTMLSelectElement>("producer-select").addEventListener("change", event => {
  battlefield.selected = new Set([Number((event.target as HTMLSelectElement).value)]); renderMatch();
});
type CardTab = "production" | "build" | "research";
const CARD_TABS: readonly CardTab[] = ["production", "build", "research"];
function showTab(name: CardTab): void {
  for (const other of CARD_TABS) {
    element(`tab-${other}`).setAttribute("aria-selected", String(name === other));
    element(`${other}-pane`).hidden = name !== other;
  }
}
function visibleTab(): CardTab {
  return CARD_TABS.find(name => !element(`${name}-pane`).hidden) ?? "production";
}
/** The buttons a tab's keys press, in key order: only those a player can see. */
function cardButtons(tab: CardTab): HTMLButtonElement[] {
  const pane = tab === "production" ? "training-buttons" : tab === "build" ? "building-buttons" : "research-buttons";
  return [...element(pane).querySelectorAll<HTMLButtonElement>(":scope > button")].filter(button => !button.hidden);
}
for (const name of CARD_TABS) element(`tab-${name}`).addEventListener("click", () => showTab(name));

/**
 * The command card's keys: the visible tab's buttons take Q W E R (and on,
 * for buildings), B opens and closes the build card, Escape backs out of it.
 * A disabled button answers with its own reason rather than doing nothing.
 */
battlefield.onKey = event => {
  const key = event.key.toLowerCase();
  if (event.key === "?") { toggleHelp(); return true; }
  if (event.key === "F3") { toggleStrategy(); return true; }
  if (event.key === "Escape" && !battlefield.targeting && strategyOpen()) { closeStrategy(); return true; }
  if (key === BUILD_MENU_KEY) { showTab(visibleTab() === "build" ? "production" : "build"); return true; }
  const tab = visibleTab();
  // Operations live in the Strategy panel: V arms Expand and L toggles Saturate workers, from anywhere.
  if (key === OPERATION_KEYS.expand) { element<HTMLButtonElement>("expand").click(); return true; }
  if (key === OPERATION_KEYS.territory) { element<HTMLButtonElement>("territory").click(); return true; }
  if (key === OPERATION_KEYS.autoLabour) { element<HTMLButtonElement>("auto-labour").click(); return true; }
  if (event.key === "Escape" && tab !== "production" && !battlefield.targeting) { showTab("production"); return true; }
  const keys: readonly string[] = tab === "build" ? BUILD_KEYS : TRAIN_KEYS;
  const button = cardButtons(tab)[keys.indexOf(key)];
  if (!button) return false;
  if (button.disabled) { session.onNotice(button.title); return true; }
  button.click();
  // Placement is armed; the card goes back to production, as SC2's does.
  if (tab === "build") showTab("production");
  return true;
};

function toggleHelp(): void {
  const help = element("help");
  help.hidden = !help.hidden;
  if (!help.hidden) closeStrategy();
  element("help-toggle").setAttribute("aria-expanded", String(!help.hidden));
}
element("help-toggle").addEventListener("click", toggleHelp);
// The guide is a second page of the same app; it opens beside the match, never over it.
element("guide-open").addEventListener("click", () => window.open("guide.html", "_blank", "noopener"));
for (const kind of BUILDABLE) element(`build-${kind}`).addEventListener("click", () => battlefield.arm(`build_${kind}`));
// Research needs no building and no selection: it is ordered in the name of
// the HQ, like construction (the server needs one own unit to issue it).
for (const research of RESEARCH_BUTTONS) element(`research-${research.id}`).addEventListener("click", () => {
  const issuer = battlefield.issuer();
  if (issuer) void session.order([issuer.id], { kind: research.order, x: 0, y: 0, target: 0 });
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
    const swatch = text("span", "", "swatch"); swatch.style.background = ownerColor(player.slot, me?.slot);
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
  renderStances();
  renderDoctrine();
  renderStrategy();
  const owned = units.filter(unit => unit.owner === me.slot);
  // Primary-hub victory: a player acts while any completed hub survives.
  const alive = owned.some(isCompletedHub);
  const producer = productionBuilding();
  const buildings = owned.filter(unit => isBuilding(unit.kind));
  const mobile = owned.filter(unit => takesSupply(unit.kind));
  const pending = owned.reduce((count, unit) => count + unit.production.filter(item => !item.kind.startsWith("research_")).length, 0);
  const canOrder = session.ready && session.matchReady && room.state === "playing" && alive;
  const balance: Cost = { material: me.material, catalyst: me.catalyst, terrazine: me.terrazine };
  // Orders sent but not yet executed have not been charged, yet the money is
  // spoken for: buttons and readouts work from what is actually left.
  const committed = pendingSpend(session.snapshot.commands, session.pending.values(), me.slot, me.research);
  const free = availableAfter(balance, committed);
  for (const currency of CURRENCIES) {
    const label = pendingLabel(committed, currency);
    const node = element(`${currency}-pending`);
    if (node.textContent !== label) node.textContent = label;
    node.hidden = !label;
  }
  const faction = myFaction();
  const labour = LABOUR[faction];
  const tier = tierOf(me.research);
  const fields = battlefield.fields();
  element("match-name").textContent = room.name;
  element("material").textContent = String(balance.material);
  element("catalyst").textContent = String(balance.catalyst);
  element("catalyst-readout").classList.toggle("empty", balance.catalyst === 0);
  element("terrazine").textContent = String(balance.terrazine);
  element("terrazine-readout").classList.toggle("empty", balance.terrazine === 0);
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
    // A second- or third-tier unit is locked until its tier is bought.
    const tierNeeded = requiredTier(kind);
    const locked = tierNeeded > tier;
    const blocked = stockless || locked || !canOrder || !site || mobile.length + pending >= MAX_UNITS;
    // The tooltip, and the notice a hotkey shows, says why a button is off:
    // the first refusal that applies, in the order a player can fix them.
    const needs = LABOUR_KINDS.includes(kind) ? "a finished hub" : armyBuilding(kind) === "factory" ? "a finished factory" : "a finished barracks";
    const why = !canOrder ? "Orders are closed" : locked ? `Requires Tier ${tierNeeded}` : !site ? `Needs ${needs}` : mobile.length + pending >= MAX_UNITS ? `Unit cap ${MAX_UNITS} reached` : `Trains at ${CATALOG[site.kind].label} #${site.id}`;
    affordability(button, definition.cost, free, blocked, stockless ? `${describe(kind)} / ${STOCK_REASON}` : `${describe(kind)} / ${why}`);
    const tag = button.querySelector<HTMLElement>(":scope > .tier-tag");
    if (tag) tag.hidden = !locked;
    button.classList.toggle("locked", locked);
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
    const tierNeeded = buildTierError(kind, me.research);
    const blocked = !canOrder || !battlefield.issuer() || buildings.length >= MAX_BUILDINGS || !!tierNeeded || ((kind === "factory" || kind === "lab") && !buildings.some(unit => unit.kind === "barracks" && unit.constructionRemaining === 0n));
    affordability(element<HTMLButtonElement>(`build-${kind}`), definition.cost, free, blocked, tierNeeded ? `${describe(kind)} / ${tierNeeded}` : describe(kind));
    element(`build-${kind}`).classList.toggle("locked", !!tierNeeded);
    element(`build-${kind}`).setAttribute("aria-pressed", String(battlefield.targeting === `build_${kind}`));
  }
  element("building-count").textContent = `${buildings.length} / ${MAX_BUILDINGS} structures`;
  for (const research of RESEARCH_BUTTONS) {
    const leveled = LEVELED_RESEARCH.includes(research.order);
    const level = leveled ? researchLevel(me.research, research.order) : 0;
    const bought = leveled ? level >= MAX_RESEARCH_LEVEL : me.research.includes(research.order);
    const button = element<HTMLButtonElement>(`research-${research.id}`);
    const reason = researchReason(research.order, me.research, owned, me.slot);
    // The next level's name and price ("Weapons 2", 400 material), or "max" once all three are in.
    const cost = leveled ? costOf(research.order, me.research) : research.cost;
    if (leveled) {
      recaption(button, bought ? `${research.label} ${MAX_RESEARCH_LEVEL}` : `${research.label} ${level + 1}`, bought ? undefined : cost, "instant");
      const tag = button.querySelector<HTMLElement>(":scope > .tier-tag");
      if (tag) { tag.hidden = !reason?.startsWith("Requires Tier"); tag.textContent = reason?.replace("Requires ", "") ?? ""; }
      button.classList.toggle("locked", !!reason?.startsWith("Requires Tier"));
    }
    // Tiers carry the faction's own upgrade in their tooltip.
    const detail = research.tier ? `${TIER_UPGRADES[faction][research.tier - 1].name}: ${TIER_UPGRADES[faction][research.tier - 1].text} / ${research.description}` : research.description;
    // Bought research is never short of anything, so it is priced at nothing
    // and reads as complete rather than unaffordable.
    affordability(button, bought ? NO_COST : cost, free, !canOrder || !battlefield.issuer() || !!reason, `${detail} / ${bought ? (leveled ? "Max level" : "Complete") : reason ?? "Instant"}`);
    button.classList.toggle("completed", bought);
  }
  element("research-status").textContent = me.research.length ? researchSummary(me.research).join(" / ") : "No upgrades";
  for (const tab of CARD_TABS) {
    const keys: readonly string[] = tab === "build" ? BUILD_KEYS : TRAIN_KEYS;
    cardButtons(tab).forEach((button, index) => badge(button, keys[index]));
  }
  renderSelectionGrid();
  renderGroupBar();
  const selection = units.filter(unit => battlefield.selected.has(unit.id));
  element("selection-title").textContent = selection.length === 1 ? VISUALS[selection[0].kind]?.label ?? selection[0].kind : selection.length ? `${selection.length} units${battlefield.activeKind ? ` / ${CATALOG[battlefield.activeKind]?.label ?? battlefield.activeKind} active` : ""}` : "No selection";
  // Cargo is reported by the currency each carrier is actually carrying, since
  // one load is one currency and the two are not interchangeable. A drifter is
  // deliberately excluded: it holds nothing, ever, so a "0 cargo" line would be
  // a lie about a unit that has no cargo model at all.
  const carriers = selection.filter(unit => carriesCargo(unit.kind));
  const carried = carriers.reduce((total, unit) => addCost(total, { ...NO_COST, [currencyOf(unit.cargoKind)]: unit.cargo }), NO_COST);
  const cargoLabel = CURRENCIES.filter(currency => carried[currency] > 0).map(currency => `${carried[currency]} ${currency}`).join(" + ") || "0";
  const drifting = selection.some(unit => gathersInPlace(unit.kind));
  const hubs = selection.filter(unit => isHub(unit.kind) && unit.owner === me.slot);
  element("selection-details").textContent = selection.length
    ? `${selection.reduce((sum, unit) => sum + unit.hp, 0)} HP`
      + (selection.some(unit => unit.maxShields > 0) ? ` / ${selection.reduce((sum, unit) => sum + unit.shields, 0)} shields` : "")
      + (carriers.length ? ` / ${cargoLabel} cargo` : "")
      + (drifting ? " / credits in place" : "")
      + (selection.length === 1 && isVeteran(selection[0].kind) ? ` / ${veteranStacks(selection[0].kills)} / 15 stacks` : "")
      + (selection.length === 1 && passiveLine(selection[0].kind) ? ` / ${passiveLine(selection[0].kind)}` : "")
      + (faction === "organic" && hubs.length ? ` / ${hubs.reduce((sum, unit) => sum + unit.stock, 0)} / ${hubs.length * HUB_STOCK_CAP} stock` : "")
    : "";
  // A command that cannot apply to the selection is hidden; `disabled` is left for orders being closed.
  const mine = battlefield.ownedSelection();
  const show = (id: string, relevant: boolean): void => { const button = element<HTMLButtonElement>(id); button.hidden = !relevant; button.disabled = !canOrder; };
  show("stop", mine.some(unit => !isBuilding(unit.kind)));
  // Only a carrier can be told to take a load home. A drifter has no load.
  show("return", mine.some(unit => carriesCargo(unit.kind)));
  // A harvester gathers only: the server refuses it hold and attack-move by name.
  for (const id of ["hold", "attack-move"]) show(id, mine.some(unit => fights(unit.kind)));
  // Missions are about places, not selections: always available while orders are open.
  for (const kind of TACTIC_IDS) {
    element<HTMLButtonElement>(`mission-${kind}`).disabled = !canOrder;
    element(`mission-${kind}`).setAttribute("aria-pressed", String(battlefield.targeting === `mission_${kind}`));
  }
  element("selection-behavior").textContent = behaviorLine(selection);
  show("repair", mine.some(unit => isLabour(unit.kind)));
  // Teleport is Network's alone, and only for units already inside the field.
  element("teleport").hidden = faction !== "network";
  element<HTMLButtonElement>("teleport").disabled = !canOrder || !battlefield.teleporters().length;
  // Hub abilities, C&C style: no hub needs to be selected. The tooltip names
  // the hub that will cast, or the best hub's reason it cannot.
  for (const kind of ["recall", "bloom"] as AbilityKind[]) {
    const rule = ABILITIES[kind];
    const button = element<HTMLButtonElement>(kind);
    button.hidden = faction !== rule.faction;
    if (button.hidden) continue;
    const hub = battlefield.caster(kind);
    const hubs = owned.filter(unit => unit.kind === "hq" || unit.kind === "outpost").sort((left, right) => right.energy - left.energy || left.id - right.id);
    const reason = hubs.length ? castRefusal(hubs[0], rule, room.tick, scheduledCasts(session.snapshot.commands, me.slot)) : "No hub to cast from";
    const summary = kind === "recall"
      ? `Recall (C) / ${rule.energy} energy, ${Number(rule.channelTicks) / 20}s channel, ${Number(rule.cooldownTicks) / 20}s cooldown / your units within ${rule.radius} return to the hub, shields spent`
      : `Bloom (C) / ${rule.energy} energy, ${Number(rule.cooldownTicks) / 20}s cooldown / grows creep of ${rule.radius} on your own creep for 60s`;
    button.disabled = !canOrder || !hub;
    button.title = `${summary} / ${hub ? `Casts from ${CATALOG[hub.kind].label} #${hub.id} (${hub.energy} energy)` : reason ?? "Not ready"}`;
  }
  element<HTMLButtonElement>("set-rally").disabled = !canOrder;
  element<HTMLButtonElement>("expand").disabled = !canOrder || !battlefield.issuer();
  element("expand").setAttribute("aria-pressed", String(battlefield.targeting === "expand"));
  element<HTMLButtonElement>("territory").disabled = !canOrder || !battlefield.issuer();
  element("territory").setAttribute("aria-pressed", String(battlefield.targeting === "territory"));
  const linkWord = { industrial: "sensor towers", network: "relays", organic: "creep tumors" }[factionOf(me.faction)];
  element("territory").title = `Extend your territory toward a point with ${linkWord}: click the map or minimap (${keyLabel(OPERATION_KEYS.territory)})`;
  element("auto-labour").setAttribute("aria-pressed", String(operations.autoLabour));
  element<HTMLButtonElement>("auto-labour").disabled = !canOrder;
  for (const launch of document.querySelectorAll<HTMLButtonElement>("[data-launch]")) {
    const source = element<HTMLButtonElement>(launch.dataset.launch!);
    launch.disabled = source.disabled;
    launch.setAttribute("aria-pressed", source.getAttribute("aria-pressed") ?? "false");
  }
  element<HTMLButtonElement>("clear-rally").disabled = !canOrder || !producer?.order.kind.startsWith("rally_");
  // An Organic outpost queues harvesters but is not a production *control*:
  // the server takes rally and cancellation only at an HQ, barracks, factory or
  // lab, so the button is disabled there rather than sending a refused order.
  const controllable = !!producer && isBuilding(producer.kind);
  element<HTMLButtonElement>("cancel-production").disabled = !canOrder || !producer?.production.length || !controllable;
  element<HTMLButtonElement>("idle-worker").disabled = !canOrder || !owned.some(unit => isLabour(unit.kind) && unit.order.kind === "stop");
  const idleCount = owned.filter(unit => isLabour(unit.kind) && unit.order.kind === "stop").length;
  element("idle-count").hidden = idleCount === 0;
  element("idle-count").textContent = String(idleCount);
  renderArmyRoster(owned, me.slot);
  element("idle-worker").title = `Select idle ${CATALOG[labour].label.toLowerCase()}`;
  element("idle-worker").setAttribute("aria-label", element("idle-worker").title);
  const refund = (producer?.production ?? []).reduce((total, item) => addCost(total, costOf(item.kind)), NO_COST);
  // A cancelled harvester costs nothing to refund in currency and everything in
  // stock, so the refund is quoted in both rather than reading as "nothing".
  const stocked = (producer?.production ?? []).filter(item => item.kind === "harvester").length;
  const refundParts = [formatCost(refund) === "nothing" ? "" : formatCost(refund), stocked ? `${stocked} hub stock` : ""].filter(Boolean);
  element("cancel-production").title = controllable
    ? `Cancel all unfinished production / refund ${refundParts.join(" + ") || "nothing"}`
    : "Select a building with a production queue";
  const rallyNode = producer?.order.kind === "rally_gather" ? session.snapshot.nodes.find(node => node.id === producer.order.target) : undefined;
  // Where a move rally points, in words: the building it sits on, if any.
  const rallyLandmark = producer?.order.kind === "rally_move" ? units.find(unit => isBuilding(unit.kind) && Math.hypot(unit.x - producer.order.x, unit.y - producer.order.y) <= CATALOG[unit.kind].radius + 15) : undefined;
  element("rally-status").textContent = producer ? rallyText(producer, rallyNode, rallyLandmark && { label: CATALOG[rallyLandmark.kind].label }) : "Rally unset";
  // Mission members: the mission leads (their order is whatever the mission is running), else a lone unit's order.
  const missionTags = [...new Set(memberActivities(missions.list, selection).values())];
  const inMission = selection.length > 0 && selection.every(unit => missions.list.some(mission => mission.members.has(unit.id)));
  element("selection-order").textContent = inMission && missionTags.length ? `Mission: ${missionTags.join(", ")}` : selection.length === 1 ? selection[0].constructionRemaining > 0n ? `Constructing / ${(Number(selection[0].constructionRemaining) / 20).toFixed(1)}s left` : selection[0].order.kind.split("_").join(" ") : "";
  const targetLabel = battlefield.targeting?.startsWith("build_") ? `Place ${CATALOG[battlefield.targeting.slice(6)].label}` : battlefield.targeting === "attack_move" ? "Attack-move target" : battlefield.targeting === "repair" ? "Repair target" : battlefield.targeting === "teleport" ? "Teleport destination / inside your power field" : battlefield.targeting === "recall" ? "Recall area / your units near it return home" : battlefield.targeting === "bloom" ? "Bloom site / on your own creep" : battlefield.targeting === "rally" ? "Rally target" : battlefield.targeting === "expand" ? "Expand toward / click the map or minimap" : battlefield.targeting === "territory" ? "Extend territory toward / click the map or minimap" : battlefield.targeting === "set_mission_rally" ? "Gather point / click the map or minimap" : battlefield.targeting?.startsWith("mission_") ? `${TACTICS[battlefield.targeting.slice(8) as Tactic].label} mission / click the map or minimap (selected army joins it)` : "";
  element("targeting-state").hidden = !battlefield.targeting;
  element("targeting-state").textContent = targetLabel;
  for (const [id, kind] of [["attack-move", "attack_move"], ["repair", "repair"], ["set-rally", "rally"], ["teleport", "teleport"], ["recall", "recall"], ["bloom", "bloom"]]) element(id).setAttribute("aria-pressed", String(battlefield.targeting === kind));
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
      killed: { material: player.killedMaterial, catalyst: player.killedCatalyst, terrazine: player.killedTerrazine },
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
      // The swatch is the colour this player is drawn in on the map; yours is
      // marked as such, so "which side am I" never needs guessing.
      const swatch = text("span", "", "swatch"); swatch.style.background = ownerColor(player.slot, me.slot);
      row.append(swatch, text("span", `${player.name}${player.slot === me.slot ? " / you" : ""}${player.online ? "" : " / offline"}`, player.slot === me.slot ? "battle-player-name you" : "battle-player-name"),
        text("span", FACTION_LABEL[factionOf(player.faction)], `faction-tag ${factionOf(player.faction)}`));
      row.style.borderColor = ownerColor(player.slot, me.slot); return row;
    }));
  }
}

let armySignature = "";
let armyCollapsed = false;
try { armyCollapsed = localStorage.getItem("army-roster-collapsed") === "1"; } catch { /* storage unavailable */ }
/**
 * The Army roster over the battlefield: what each cluster of army units is
 * doing, one clickable row each. Click selects exactly those units and centres
 * the camera; Shift+click adds them without moving it. The DOM is only rebuilt
 * when the rows' text changes, so a click is never lost to a per-frame rebuild.
 */
function renderArmyRoster(owned: Entity[], slot: number): void {
  const panel = element("army-roster");
  const rows = armyRoster(owned, slot, owned, memberActivities(missions.list, owned));
  const { shown, more } = visibleRows(rows);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const signature = JSON.stringify([armyCollapsed, total, more, shown.map(row => [row.activity, row.ids, row.composition, row.location])]);
  panel.hidden = rows.length === 0;
  if (signature === armySignature) return;
  armySignature = signature;
  const head = text("button", "", "army-head") as HTMLButtonElement;
  head.append(text("span", `ARMY ${total}`), text("span", armyCollapsed ? "+" : "−"));
  head.setAttribute("aria-expanded", String(!armyCollapsed));
  head.title = "Collapse or expand the army roster";
  head.addEventListener("click", () => {
    armyCollapsed = !armyCollapsed;
    try { localStorage.setItem("army-roster-collapsed", armyCollapsed ? "1" : "0"); } catch { /* storage unavailable */ }
    armySignature = ""; renderMatch();
  });
  const children: HTMLElement[] = [head];
  if (!armyCollapsed) {
    for (const row of shown) children.push(armyRow(row));
    if (more > 0) children.push(text("div", `+${more} more`, "army-more"));
  }
  panel.replaceChildren(...children);
}

function armyRow(row: RosterRow): HTMLElement {
  const button = text("button", "", `army-row${row.forgotten ? " forgotten" : ""}`) as HTMLButtonElement;
  button.append(text("span", row.activity, "army-act"), text("span", String(row.count), "army-count"), text("span", row.location === "base" ? "at base" : "field", "army-where"), text("span", row.composition, "army-comp"));
  button.title = `Select ${row.count} unit${row.count === 1 ? "" : "s"} / Shift adds to the selection`;
  button.addEventListener("click", event => {
    if (event.shiftKey) battlefield.selected = new Set([...battlefield.selected, ...row.ids]);
    else {
      // Rows are only rebuilt when membership changes, so find where the group is *now*.
      const members = session.snapshot.units.filter(unit => row.ids.includes(unit.id));
      battlefield.selected = new Set(row.ids);
      if (members.length) battlefield.centreOn({ x: members.reduce((sum, unit) => sum + unit.x, 0) / members.length, y: members.reduce((sum, unit) => sum + unit.y, 0) / members.length });
    }
    renderMatch();
  });
  return button;
}

/** Members of a gather mission within the gathered radius of its rally (what the strike waits on); undefined for the other tactics. */
function gatheredCount(mission: Mission): number | undefined {
  if (mission.tactic !== "gather" || mission.state !== "gather") return undefined;
  const radius = gatherRadius(mission.members.size);
  return session.snapshot.units.filter(unit => mission.members.has(unit.id) && Math.hypot(unit.x - mission.rally.x, unit.y - mission.rally.y) <= radius).length;
}

let strategySignature = "";
/**
 * The Strategy panel's list: every standing mission (size, members, cancel) and
 * every running operation (step, note, cancel), one row each. Rebuilt only when
 * missions or operations change, so a click never lands on a replaced button.
 */
function renderStrategy(): void {
  const mine = missions.list;
  // Rebuilt only when something shown changed, so a click never lands on a replaced button.
  const signature = JSON.stringify([
    mine.map(mission => [mission.id, gatheredCount(mission), mission.tactic, mission.size, mission.state, mission.x, mission.y, mission.rally.x, mission.rally.y, mission.gatherPercent, mission.fallbackPercent, mission.members.size]),
    operations.list.map(operation => [operation.id, operation.done, operation.total, operation.note]), operations.autoLabour,
  ]);
  if (signature === strategySignature) return;
  strategySignature = signature;
  const rows: HTMLElement[] = [];
  const tool = (label: string, title: string, action: () => void, pressed?: boolean): HTMLButtonElement => {
    const button = text("button", label, "strategy-tool") as HTMLButtonElement;
    button.title = title; button.setAttribute("aria-label", title);
    if (pressed !== undefined) button.setAttribute("aria-pressed", String(pressed));
    button.addEventListener("click", action);
    return button;
  };
  const goTo = (mission: Mission): void => {
    const members = session.snapshot.units.filter(unit => mission.members.has(unit.id));
    battlefield.selected = new Set(members.map(unit => unit.id));
    battlefield.centreOn(members.length ? { x: members.reduce((sum, unit) => sum + unit.x, 0) / members.length, y: members.reduce((sum, unit) => sum + unit.y, 0) / members.length } : mission);
    renderMatch();
  };
  for (const mission of mine) {
    const info = TACTICS[mission.tactic];
    const row = text("div", "", "strategy-row mission-row");
    row.dataset.mission = String(mission.id);
    const swatch = text("span", "", "swatch"); swatch.style.background = info.color;
    const name = text("button", missionLabel(mission, gatheredCount(mission)), "strategy-name-btn") as HTMLButtonElement;
    name.title = "Select its units and centre the camera on them"; name.addEventListener("click", () => goTo(mission));
    const picker = document.createElement("select");
    picker.className = "mission-tactic"; picker.title = "Change this mission's tactic"; picker.setAttribute("aria-label", "Mission tactic");
    for (const id of TACTIC_IDS) picker.append(new Option(TACTICS[id].label, id, false, id === mission.tactic));
    picker.addEventListener("change", () => missions.setTactic(mission.id, picker.value as Tactic));
    const rest = mission.size === "rest";
    const numeric = typeof mission.size === "number" ? mission.size : mission.members.size;
    const bigger = tool("+", `Larger ${info.label} mission`, () => missions.setSize(mission.id, Math.min(MAX_SIZE, numeric + 1)));
    bigger.disabled = rest;
    row.append(swatch, name, picker,
      tool("\u2212", `Smaller ${info.label} mission`, () => missions.setSize(mission.id, Math.max(1, numeric - 1))),
      bigger,
      tool("All", rest ? "Take a fixed number of units" : "Take every army unit not needed elsewhere", () => missions.setSize(mission.id, rest ? Math.max(1, mission.members.size) : "rest"), rest),
      tool("\u00d7", `Cancel ${info.label} mission`, () => missions.remove(mission.id)));
    row.append(text("span", rest ? `${info.hint}. Takes every army unit not needed elsewhere.` : `${info.hint}. Up to ${mission.size} units.`, "mission-hint"));
    rows.push(row);
    if (mission.tactic === "gather") {
      const knobs = text("div", "", "strategy-row mission-knobs");
      knobs.dataset.missionKnobs = String(mission.id);
      knobs.append(
        text("span", "strike at", "mono"),
        tool("\u2212", "Strike with a smaller share gathered", () => missions.setGather(mission.id, mission.gatherPercent - PERCENT_STEP)),
        text("span", `${mission.gatherPercent}%`, "mono"),
        tool("+", "Strike with a larger share gathered", () => missions.setGather(mission.id, mission.gatherPercent + PERCENT_STEP)),
        text("span", "fall back", "mono"),
        tool("\u2212", "Fall back at a lower share of the strike strength", () => missions.setFallback(mission.id, mission.fallbackPercent - PERCENT_STEP)),
        text("span", `${mission.fallbackPercent}%`, "mono"),
        tool("+", "Fall back at a higher share of the strike strength", () => missions.setFallback(mission.id, mission.fallbackPercent + PERCENT_STEP)),
        tool("Rally", "Move the rally point: click, then click the map or minimap", () => battlefield.armMissionRally(mission.id)));
      rows.push(knobs);
    }
  }
  for (const operation of operations.list) {
    const row = text("div", "", "strategy-row operation-row");
    const swatch = text("span", "", "swatch"); swatch.style.background = "#8fd8ff";
    row.append(swatch, text("strong", operation.label, "strategy-label"), text("span", `${operation.done}/${operation.total}`, "operation-step mono"), text("span", operation.note, "operation-note"),
      tool("\u00d7", `Cancel ${operation.label}`, () => operations.cancel(operation.id)));
    rows.push(row);
  }
  if (operations.autoLabour) {
    const row = text("div", "", "strategy-row operation-row");
    const swatch = text("span", "", "swatch"); swatch.style.background = "#8fd8ff";
    row.append(swatch, text("strong", "Saturate workers", "strategy-label"), text("span", "on", "operation-step mono"), text("span", "Trains labour at idle hubs", "operation-note"),
      tool("\u00d7", "Turn off Saturate workers", () => operations.toggleAutoLabour()));
    rows.push(row);
  }
  if (!rows.length) rows.push(text("p", "No missions. Pick a tactic, then click the map: idle army units fill it.", "strategy-empty"));
  element("strategy-list").replaceChildren(...rows);
  // The deck's summary: one line each, a click on the name goes there; everything else is in the window.
  const summary: HTMLElement[] = mine.map(mission => {
    const row = text("div", "", "summary-row");
    const swatch = text("span", "", "swatch"); swatch.style.background = TACTICS[mission.tactic].color;
    const name = text("button", missionLabel(mission, gatheredCount(mission)), "strategy-name-btn") as HTMLButtonElement;
    name.title = "Select its units and centre the camera on them"; name.addEventListener("click", () => goTo(mission));
    row.append(swatch, name, text("span", TACTICS[mission.tactic].label, "summary-note"));
    return row;
  });
  for (const operation of operations.list) {
    const row = text("div", "", "summary-row");
    const swatch = text("span", "", "swatch"); swatch.style.background = "#8fd8ff";
    row.append(swatch, text("strong", `${operation.label} ${operation.done}/${operation.total}`, "summary-label"), text("span", operation.note, "summary-note"));
    summary.push(row);
  }
  if (operations.autoLabour) {
    const row = text("div", "", "summary-row");
    const swatch = text("span", "", "swatch"); swatch.style.background = "#8fd8ff";
    row.append(swatch, text("strong", "Saturate workers", "summary-label"), text("span", "on", "summary-note"));
    summary.push(row);
  }
  if (!summary.length) summary.push(text("p", "No missions yet. Pick one above, then click the map.", "strategy-empty"));
  element("strategy-summary").replaceChildren(...summary);
}
/**
 * The Strategy panel's Stances section: one row per army kind of the player's
 * faction with a four-way picker. A kind with no `stance` row shows its default.
 * Rebuilt only when the faction or a choice changes.
 */
let stanceSignature = "";
function renderStances(): void {
  const { me, stances } = session.snapshot;
  if (!me) return;
  const faction = myFaction();
  const picked = new Map(stances.filter(row => row.slot === me.slot).map(row => [row.kind, row.stance as StanceName]));
  const current = (kind: string): StanceName => picked.get(kind) ?? defaultStance(kind);
  const signature = `${faction}|${ROSTER[faction].map(current).join(",")}`;
  if (signature === stanceSignature) return;
  stanceSignature = signature;
  const head = text("div", "", "stance-head");
  head.append(text("span", "Unit", "stance-kind"), ...STANCES.map(stance => text("span", stance.label)));
  const legend = element("stance-legend");
  if (!legend.childElementCount) legend.append(...STANCES.flatMap(stance => [text("dt", stance.label), text("dd", stance.hint)]));
  element("stance-list").replaceChildren(head, ...ROSTER[faction].map(kind => {
    const row = text("div", "", "stance-row");
    row.append(text("span", CATALOG[kind].label, "stance-kind"));
    for (const stance of STANCES) {
      const button = text("button", stance.label, "strategy-tool stance-tool") as HTMLButtonElement;
      button.title = `${CATALOG[kind].label}: ${stance.hint}`;
      button.setAttribute("aria-pressed", String(current(kind) === stance.id));
      button.addEventListener("click", () => {
        const issuer = battlefield.issuer();
        if (issuer) void session.order([issuer.id], { kind: stanceOrder(kind, stance.id), x: 0, y: 0, target: 0 });
      });
      row.append(button);
    }
    return row;
  }));
}
/**
 * The Strategy panel's Production section: this player's production doctrine,
 * which the server carries out. Switches, a weight stepper per army kind of the
 * faction (greyed with its tier while locked), the catalyst reserve and three
 * presets. Every control only sends a `doctrine_*` order; the state comes back
 * through the subscription. Rebuilt only when what it shows changes.
 */
let doctrineSignature = "";
function renderDoctrine(): void {
  const { me, doctrines, doctrineWeights } = session.snapshot;
  if (!me) return;
  const faction = myFaction();
  const mine = doctrines.find(row => row.slot === me.slot);
  const weights = new Map(doctrineWeights.filter(row => row.slot === me.slot).map(row => [row.kind, row.weight]));
  const weightOf = (kind: string): number => weights.get(kind) ?? DOCTRINE_DEFAULT_WEIGHT;
  const tier = tierOf(me.research);
  const state = { train: !!mine?.enabled, tier: !!mine?.autoTier, research: !!mine?.autoResearch, build: !!mine?.autoBuild, reserve: mine?.catalystReserve ?? 0 };
  const signature = `${faction}|${tier}|${JSON.stringify(state)}|${ROSTER[faction].map(weightOf).join(",")}`;
  if (signature === doctrineSignature) return;
  doctrineSignature = signature;
  const send = (kind: string, x: number): void => {
    const issuer = battlefield.issuer();
    if (issuer) void session.order([issuer.id], { kind, x, y: 0, target: 0 });
  };
  const toggle = (label: string, hint: string, on: boolean, kind: string): HTMLElement => {
    const row = text("div", "", "doctrine-switch-row");
    const button = text("button", label, "doctrine-switch") as HTMLButtonElement;
    button.title = hint;
    button.setAttribute("aria-pressed", String(on));
    button.addEventListener("click", () => send(kind, on ? 0 : 1));
    row.append(button, text("span", hint, "doctrine-hint"));
    return row;
  };
  const stepper = (name: string, value: number, min: number, max: number, step: number, kind: string): HTMLElement[] => {
    const minus = text("button", "−", "strategy-tool") as HTMLButtonElement;
    minus.setAttribute("aria-label", `Lower ${name}`);
    minus.disabled = value <= min;
    minus.addEventListener("click", () => send(kind, Math.max(min, value - step)));
    const plus = text("button", "+", "strategy-tool") as HTMLButtonElement;
    plus.setAttribute("aria-label", `Raise ${name}`);
    plus.disabled = value >= max;
    plus.addEventListener("click", () => send(kind, Math.min(max, value + step)));
    return [minus, text("span", String(value), "weight-value mono"), plus];
  };
  const group = (title: string, ...children: HTMLElement[]): HTMLElement => {
    const box = text("div", "", "doctrine-group");
    box.append(text("h3", title, "sw-subhead"), ...children);
    return box;
  };
  const switches = [state.train, state.tier, state.research, state.build].filter(Boolean).length;
  element("doctrine-state").textContent = switches ? `${switches} on` : "off";
  const automation = group("Automation",
    toggle("Auto-train", "Idle barracks and factories train toward the army mix below while catalyst allows", state.train, DOCTRINE_SWITCH.train),
    toggle("Auto-tier", "Buy the next tier as soon as it is allowed and affordable", state.tier, DOCTRINE_SWITCH.tier),
    toggle("Auto-research", "Buy weapons, armour and logistics when affordable", state.research, DOCTRINE_SWITCH.research),
    toggle("Auto-build", "Refineries on free catalyst, the next tier's building, barracks/factories when catalyst piles up (above reserve + 400), synthesizers at tier 2 when material does (above 1500)", state.build, DOCTRINE_SWITCH.build));
  const presets = text("div", "", "doctrine-row");
  presets.append(text("span", "Presets", "stance-kind"));
  for (const preset of DOCTRINE_PRESETS) {
    const button = text("button", preset.label, "strategy-tool") as HTMLButtonElement;
    button.title = preset.hint;
    button.addEventListener("click", () => {
      for (const [kind, weight] of Object.entries(presetWeights(faction, preset.id))) if (weightOf(kind) !== weight) send(doctrineWeightOrder(kind), weight);
    });
    presets.append(button);
  }
  // Each kind's share of what Auto-train buys now: locked kinds do not count until their tier.
  const total = ROSTER[faction].filter(kind => tier >= requiredTier(kind)).reduce((sum, kind) => sum + weightOf(kind), 0);
  const weightRows = ROSTER[faction].map(kind => {
    const needed = requiredTier(kind);
    const locked = tier < needed;
    const share = locked || !total ? 0 : Math.round(100 * weightOf(kind) / total);
    const row = text("div", "", locked ? "doctrine-row weight-row locked" : "doctrine-row weight-row");
    const bar = text("span", "", "share-bar"); bar.style.setProperty("--share", `${share}%`);
    row.append(text("span", CATALOG[kind].label, "stance-kind"),
      ...stepper(`${CATALOG[kind].label} weight`, weightOf(kind), 0, DOCTRINE_MAX_WEIGHT, 1, doctrineWeightOrder(kind)),
      bar, text("span", locked ? `Tier ${needed}` : `${share}%`, locked ? "tier-lock mono share-text" : "mono share-text"));
    return row;
  });
  const mix = group("Army mix", presets, ...weightRows);
  const reserve = text("div", "", "doctrine-row");
  reserve.append(text("span", "Catalyst", "stance-kind"), ...stepper("catalyst reserve", state.reserve, 0, DOCTRINE_MAX_RESERVE, DOCTRINE_RESERVE_STEP, DOCTRINE_RESERVE_ORDER), text("span", "Auto-train and Auto-build keep this much unspent", "doctrine-hint"));
  element("doctrine-body").replaceChildren(automation, mix, group("Reserve", reserve));
}
operations.onChange = () => { renderStrategy(); if (session.snapshot.room) renderMatch(); };

let selectionSignature = "";
/**
 * One tile per selected unit, SC2's wireframe panel: its icon, owner edge and
 * health. Click keeps only that unit, Shift+click drops it, Ctrl+click keeps
 * every selected unit of its kind. A single unit is described by the title
 * and details lines instead, so the grid is only shown for two or more.
 */
function renderSelectionGrid(): void {
  const grid = element("selection-grid");
  const selection = session.snapshot.units.filter(unit => battlefield.selected.has(unit.id))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id - right.id);
  const shown = selection.length > 1 ? selection.slice(0, 32) : [];
  const signature = `${battlefield.activeKind ?? ""}|` + shown.map(unit => `${unit.id}:${Math.ceil(unit.hp / Math.max(1, unit.maxHp) * 10)}:${Math.ceil(unit.shields / Math.max(1, unit.maxShields) * 10)}`).join(",") + `/${selection.length}`;
  if (signature === selectionSignature) return;
  selectionSignature = signature;
  grid.hidden = !shown.length;
  grid.replaceChildren(...shown.map(unit => {
    const tile = text("button", "", "unit-tile") as HTMLButtonElement;
    const health = unit.hp / Math.max(1, unit.maxHp);
    tile.title = `${CATALOG[unit.kind]?.label ?? unit.kind} #${unit.id} / ${unit.hp} of ${unit.maxHp} HP`;
    tile.setAttribute("aria-label", tile.title);
    tile.style.borderColor = battlefield.colorOf(unit.owner);
    tile.classList.toggle("active", unit.kind === battlefield.activeKind);
    tile.classList.toggle("dim", battlefield.activeKind !== undefined && unit.kind !== battlefield.activeKind);
    tile.append(icon(CATALOG[unit.kind]?.icon ?? ""));
    const bar = text("span", "", "unit-tile-health");
    bar.style.width = `${Math.round(health * 100)}%`;
    bar.classList.toggle("low", health <= 0.3);
    tile.append(bar);
    tile.addEventListener("click", event => {
      if (event.shiftKey) battlefield.selected.delete(unit.id);
      else if (event.ctrlKey) battlefield.selected = new Set(selection.filter(other => other.kind === unit.kind).map(other => other.id));
      else battlefield.selected = new Set([unit.id]);
      renderMatch();
    });
    return tile;
  }));
  if (selection.length > shown.length && shown.length) grid.append(text("span", `+${selection.length - shown.length}`, "unit-tile-more mono"));
}

let groupSignature = "";
/** The control groups in use, over the battlefield: key, size and main kind. Click selects, double-click centres. */
function renderGroupBar(): void {
  const keys = battlefield.groupKeys();
  const groups = keys.map(key => {
    const members = battlefield.group(key);
    const counts = new Map<string, number>();
    for (const unit of members) counts.set(unit.kind, (counts.get(unit.kind) ?? 0) + 1);
    const main = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "";
    const active = members.length > 0 && members.every(unit => battlefield.selected.has(unit.id));
    return { key, count: members.length, main, active };
  });
  const signature = JSON.stringify(groups);
  if (signature === groupSignature) return;
  groupSignature = signature;
  element("group-bar").replaceChildren(...groups.map(group => {
    const button = text("button", "", `group-chip${group.active ? " active" : ""}`) as HTMLButtonElement;
    button.title = `Control group ${group.key} / ${group.count} unit${group.count === 1 ? "" : "s"} / press ${group.key} twice to centre`;
    button.setAttribute("aria-label", button.title);
    button.append(text("b", group.key), icon(CATALOG[group.main]?.icon ?? ""), text("span", String(group.count)));
    button.addEventListener("click", () => battlefield.controlGroup("recall", group.key));
    button.addEventListener("dblclick", () => battlefield.controlGroup("recall", group.key));
    return button;
  }));
}

/**
 * The production queue of every selected building that is making something,
 * or of the whole base when none is, one card per item with its own progress
 * bar. This used to follow only the one "production building" the dropdown
 * picked (the HQ by default), so a barracks full of trains showed an empty
 * queue. Orders still inside the one-second delay are listed too, dimmed.
 */
function renderQueue(): void {
  const { room, me, units, commands } = session.snapshot;
  if (!room || !me) return;
  const tick = Number(room.tick) + Math.min(1, (performance.now() - session.tickReceivedAt) / TICK_MS);
  const view = queueView(units, commands, me.slot, new Set(battlefield.activeSelection().map(unit => unit.id)), tick, kind => (CATALOG[kind]?.seconds ?? 0) * 20);
  const shown = view.rows.slice(0, 12);
  const cards = shown.map(row => {
    const card = text("span", "", `production-item${row.scheduled ? " scheduled" : ""}`);
    card.title = `${CATALOG[row.kind]?.label ?? row.kind} #${row.building}${row.scheduled ? " / sent, starts in under a second" : ""}`;
    const bar = text("i", "", "queue-bar"); bar.style.setProperty("--progress", `${Math.round(row.progress * 100)}%`);
    card.append(text("span", `${CATALOG[row.kind]?.label ?? row.kind} ${row.scheduled ? "sent" : `${row.seconds.toFixed(1)}s`}`), bar);
    return card;
  });
  // Empty stays truly empty (CSS prints "Queue empty" for it).
  if (!view.rows.length) { element("production-queue").replaceChildren(); return; }
  const scope = text("span", view.scope === "selected" ? "Selected" : "All buildings", "queue-scope");
  const more = view.rows.length > shown.length ? [text("span", `+${view.rows.length - shown.length}`, "queue-scope")] : [];
  element("production-queue").replaceChildren(scope, ...cards, ...more);
}

function renderTimers(): void {
  const { room, me, commands } = session.snapshot;
  if (!room || !me || room.state === "lobby") return;
  const seconds = Number(room.tick / 20n);
  element("match-clock").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  renderQueue();
  element("research-status").textContent = researchSummary(me.research).join(" / ") || "No upgrades";
  const ours = commands.filter(command => command.owner === me.slot).sort((left, right) => left.id > right.id ? -1 : 1);
  element("pending-count").textContent = String(ours.filter(command => command.status === "scheduled").length + session.pending.size);
  const rows = [...session.pending.values()].map(pending => {
    const row = text("div", "", "command-row"); row.append(text("span", pending.order.kind.split("_").join(" "), "command-label"), text("span", `${countdown(pending.executeTick, room.tick, performance.now() - session.tickReceivedAt).toFixed(1)}s`, "command-status")); return row;
  });
  for (const command of ours.slice(0, strategyOpen() && strategyTab === "orders" ? 40 : 8)) {
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
  // The newest refusal from the last 20 seconds stays on the panel, tinted when it names a currency.
  const refused = ours.find(command => command.status === "rejected" && command.reason);
  const showRefused = !!refused && room.tick - refused.executeTick < 400n;
  const line = element("last-reject");
  line.hidden = !showRefused;
  if (showRefused) {
    const currency = CURRENCIES.find(currency => refused.reason.includes(`Insufficient ${currency}`));
    line.className = `last-reject mono${currency ? ` ${currency}` : ""}`;
    const summary = `${refused.order.kind.split("_").join(" ")}: ${refused.reason}`;
    if (line.textContent !== summary) line.textContent = summary;
    line.title = summary;
  }
  const age = Math.round(performance.now() - session.tickReceivedAt);
  // LATE: your newest order reached the server after its stamp, so it ran
  // that much later than the delay promised: the round trip is over budget.
  const late = session.lateTicks > 0n ? ` / LATE +${Number(session.lateTicks) * TICK_MS}ms` : "";
  element("telemetry").textContent = `TICK ${room.tick} / ACK ${session.ackMs}ms${late}${session.stalled() ? ` / STALL ${(age / 1000).toFixed(1)}s` : ""}`;
}

function render(): void {
  feedback.update(session.snapshot);
  const playing = !!session.snapshot.room && session.snapshot.room.state !== "lobby";
  element("lobby").hidden = playing;
  element("match").hidden = !playing;
  // In a match the site masthead goes: every pixel of height is battlefield.
  document.body.classList.toggle("in-match", playing);
  element("status").textContent = session.status;
  element("connection-dot").classList.toggle("online", session.ready);
  battlefield.sync();
  renderChat();
  if (playing) { renderMatch(); renderTimers(); } else renderLobby();
}

battlefield.onSelection = renderMatch;
battlefield.onOrder = kind => feedback.ack(kind);
let alertTimer: ReturnType<typeof setTimeout>;
/** Your units or base are being hit: a banner at the top of the battlefield and a sound; Space jumps there. */
battlefield.onAlert = kind => {
  const banner = element("alert-banner");
  banner.textContent = `${alertText(kind)} (Space: jump there)`;
  banner.dataset.kind = kind;
  banner.hidden = false;
  // Restart the flash even when the banner is already up from another area.
  banner.classList.remove("flash"); void banner.offsetWidth; banner.classList.add("flash");
  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => { banner.hidden = true; }, ALERT_BANNER_MS);
  feedback.alert(kind);
};
/** A refused purchase blinks the readout of the currency it was short of, beside the reason in the notice line. */
session.onReject = reason => {
  const currency = refusedCurrency(reason);
  if (!currency) return;
  const readout = element(`${currency}-readout`);
  readout.classList.remove("refused"); void readout.offsetWidth; readout.classList.add("refused");
  setTimeout(() => readout.classList.remove("refused"), 1500);
};
practice.onChange = render;
session.onChange = render;
setInterval(renderTimers, 100);
// Dev-only handle for the browser tests and for poking the client from the console.
if (import.meta.env.DEV) (window as unknown as { __rts: unknown }).__rts = { battlefield, session, practice, missions, operations };
connect();