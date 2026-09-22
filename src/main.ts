import "../styles.css";
import { createIcons, Crosshair, Radio, Plus, Play, LogOut, House, Maximize2, ZoomIn, ZoomOut, MousePointer2, Move, Square, CornerDownLeft, Swords, Hammer, Shield, Wrench, Flag, FlagOff, X, Radar, Tent, Factory, Warehouse, FlaskConical, HardHat, Trash2, Bot, Volume2 } from "lucide";
import { Battlefield } from "./battlefield";
import { Session } from "./network";
import { COLORS, countdown, VISUALS } from "./presentation";
import { CATALOG, TECHNOLOGIES, canProduce, isArmy, isBuilding } from "./catalog";
import { Practice } from "./practice";
import { Feedback } from "./feedback";

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

function catalogButton(id: string, label: string, detail: string, icon: string, title: string): HTMLButtonElement {
  const button = text("button", "") as HTMLButtonElement;
  button.id = id; button.title = title;
  const symbol = document.createElement("i"); symbol.dataset.lucide = icon;
  const caption = text("span", label); caption.append(text("small", detail));
  button.append(symbol, caption);
  return button;
}
for (const kind of ["worker", "soldier", "scout", "siege"]) {
  const definition = CATALOG[kind];
  element("training-buttons").append(catalogButton(`train-${kind}`, definition.label, `${definition.cost} ore / ${definition.seconds}s`, definition.icon, definition.role));
}
for (const kind of ["barracks", "outpost", "turret", "factory", "lab"]) {
  const definition = CATALOG[kind];
  element("building-buttons").append(catalogButton(`build-${kind}`, definition.label, `${definition.cost} ore / ${definition.seconds}s`, definition.icon, definition.role));
}
for (const [kind, definition] of Object.entries(TECHNOLOGIES)) element("research-buttons").append(catalogButton(`research-${kind}`, definition.label, "150 ore / 15s", definition.icon, definition.description));
createIcons({ icons: { Crosshair, Radio, Plus, Play, LogOut, House, Maximize2, ZoomIn, ZoomOut, MousePointer2, Move, Square, CornerDownLeft, Swords, Hammer, Shield, Wrench, Flag, FlagOff, X, Radar, Tent, Factory, Warehouse, FlaskConical, HardHat, Trash2, Bot, Volume2 } });
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
let noticeTimer: ReturnType<typeof setTimeout>;
let lobbySignature = "";
let rosterSignature = "";
let producerSignature = "";

function productionBuilding() {
  const owned = battlefield.ownedSelection().find(unit => ["hq", "barracks", "factory", "lab"].includes(unit.kind) && unit.constructionRemaining === 0n);
  return owned ?? session.snapshot.units.find(unit => unit.owner === session.snapshot.me?.slot && unit.kind === "hq");
}

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
element("practice").addEventListener("click", () => { void practice.start(host.value.trim(), database.value.trim(), callsign.value); });
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
element("set-rally").addEventListener("click", () => battlefield.arm("rally"));
for (const [id, kind] of [["clear-rally", "clear_rally"], ["cancel-production", "cancel_production"]]) element(id).addEventListener("click", () => {
  const hq = productionBuilding();
  if (hq) void session.order([hq.id], { kind, x: 0, y: 0, target: 0 });
});
element("select-army").addEventListener("click", () => { battlefield.selectArmy(); });
element("idle-worker").addEventListener("click", () => battlefield.selectIdleWorker());
element("cancel-construction").addEventListener("click", () => {
  const site = battlefield.ownedSelection().find(unit => unit.constructionRemaining > 0n);
  if (site) void session.order([site.id], { kind: "cancel_construction", x: 0, y: 0, target: 0 });
});
element<HTMLSelectElement>("producer-select").addEventListener("change", event => {
  battlefield.selected = new Set([Number((event.target as HTMLSelectElement).value)]); renderMatch();
});
for (const name of ["production", "build", "research"]) element(`tab-${name}`).addEventListener("click", () => {
  for (const other of ["production", "build", "research"]) {
    element(`tab-${other}`).setAttribute("aria-selected", String(name === other));
    element(`${other}-pane`).hidden = name !== other;
  }
});
for (const kind of ["barracks", "outpost", "turret", "factory", "lab"]) element(`build-${kind}`).addEventListener("click", () => battlefield.arm(`build_${kind}`));
for (const kind of Object.keys(TECHNOLOGIES)) element(`research-${kind}`).addEventListener("click", () => {
  const lab = battlefield.ownedSelection().find(unit => unit.kind === "lab" && unit.constructionRemaining === 0n) ?? session.snapshot.units.find(unit => unit.owner === session.snapshot.me?.slot && unit.kind === "lab" && unit.constructionRemaining === 0n);
  if (lab) void session.order([lab.id], { kind: `research_${kind}`, x: 0, y: 0, target: 0 });
});
document.querySelectorAll<HTMLInputElement>("input[name=mode]").forEach(input => input.addEventListener("change", () => {
  if (input.value === "select" || input.value === "order" || input.value === "pan") battlefield.mode = input.value;
}));
for (const kind of ["worker", "soldier", "scout", "siege"]) element(`train-${kind}`).addEventListener("click", () => {
  const hq = productionBuilding();
  if (hq) void session.order([hq.id], { kind: `train_${kind}`, x: 0, y: 0, target: 0 });
});

function renderLobby(): void {
  const { rooms, players, me, room } = session.snapshot;
  element("room-browser").hidden = !!room;
  element("waiting-room").hidden = !room;
  element<HTMLButtonElement>("create-room").disabled = !session.ready || !!room;
  element<HTMLButtonElement>("practice").disabled = !session.ready || !!room || practice.starting;
  element<HTMLButtonElement>("save-name").disabled = !session.ready;
  const open = rooms.filter(room => room.state === "lobby");
  const signature = JSON.stringify([session.ready, open.map(room => [String(room.id), room.name, room.capacity]), players.map(player => [player.identity.toHexString(), String(player.matchId), player.name, player.online, player.ready])]);
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
    row.append(name, text("span", player.online ? "Online" : "Offline", "mono"), text("span", player.ready ? "Ready" : "Not ready", "mono"));
    return row;
  }));
}

function renderMatch(): void {
  const { room, me, units, players } = session.snapshot;
  if (!room || !me) return;
  const owned = units.filter(unit => unit.owner === me.slot);
  const hq = owned.find(unit => unit.kind === "hq");
  const producer = productionBuilding();
  const buildings = owned.filter(unit => isBuilding(unit.kind));
  const mobile = owned.filter(unit => !isBuilding(unit.kind));
  const pending = owned.reduce((count, unit) => count + unit.production.filter(item => !item.kind.startsWith("research_")).length, 0);
  const canOrder = session.ready && session.matchReady && room.state === "playing" && !!hq;
  element("match-name").textContent = room.name;
  element("resources").textContent = String(me.resources);
  element("unit-count").textContent = `${mobile.length} / 60`;
  for (const kind of ["worker", "soldier", "scout", "siege"]) element<HTMLButtonElement>(`train-${kind}`).disabled = !canOrder || !producer || !canProduce(kind, producer.kind) || me.resources < CATALOG[kind].cost || producer.production.length >= 8 || mobile.length + pending >= 60;
  const producers = buildings.filter(unit => ["hq", "barracks", "factory", "lab"].includes(unit.kind) && unit.constructionRemaining === 0n);
  const nextSignature = producers.map(unit => `${unit.id}:${unit.kind}`).join(",");
  if (nextSignature !== producerSignature) {
    producerSignature = nextSignature;
    element("producer-select").replaceChildren(...producers.map(unit => { const option = text("option", `${CATALOG[unit.kind].label} #${unit.id}`) as HTMLOptionElement; option.value = String(unit.id); return option; }));
  }
  element<HTMLSelectElement>("producer-select").value = String(producer?.id ?? 0);
  for (const kind of ["barracks", "outpost", "turret", "factory", "lab"]) {
    element<HTMLButtonElement>(`build-${kind}`).disabled = !canOrder || !owned.some(unit => unit.kind === "worker") || me.resources < CATALOG[kind].cost || buildings.length >= 16 || (kind === "factory" && !buildings.some(unit => unit.kind === "barracks" && unit.constructionRemaining === 0n));
    element(`build-${kind}`).setAttribute("aria-pressed", String(battlefield.targeting === `build_${kind}`));
  }
  element("building-count").textContent = `${buildings.length} / 16 structures`;
  for (const [kind, definition] of Object.entries(TECHNOLOGIES)) {
    const researched = hq?.research.includes(`research_${kind}`);
    const queued = owned.some(unit => unit.production.some(item => item.kind === `research_${kind}`));
    const button = element<HTMLButtonElement>(`research-${kind}`);
    button.disabled = !canOrder || researched || queued || me.resources < 150 || !buildings.some(unit => unit.kind === "lab" && unit.constructionRemaining === 0n && unit.production.length < 8);
    button.title = `${definition.description}${researched ? " / Complete" : queued ? " / Researching" : " / Requires laboratory"}`;
    button.classList.toggle("completed", !!researched);
  }
  element("research-status").textContent = hq?.research.length ? hq.research.map(kind => kind.slice(9)).join(" / ") : "No upgrades";
  const selection = units.filter(unit => battlefield.selected.has(unit.id));
  element("selection-title").textContent = selection.length === 1 ? VISUALS[selection[0].kind]?.label ?? selection[0].kind : selection.length ? `${selection.length} units` : "No selection";
  element("selection-details").textContent = selection.length ? `${selection.reduce((sum, unit) => sum + unit.hp, 0)} HP${selection.some(unit => unit.kind === "worker") ? ` / ${selection.reduce((sum, unit) => sum + unit.cargo, 0)} cargo` : ""}` : "";
  element<HTMLButtonElement>("stop").disabled = !canOrder || !battlefield.ownedSelection().some(unit => !isBuilding(unit.kind));
  element<HTMLButtonElement>("return").disabled = !canOrder || !battlefield.ownedSelection().some(unit => unit.kind === "worker");
  for (const id of ["hold", "attack-move"]) element<HTMLButtonElement>(id).disabled = !canOrder || !battlefield.ownedSelection().some(unit => isArmy(unit.kind));
  element<HTMLButtonElement>("repair").disabled = !canOrder || !battlefield.ownedSelection().some(unit => unit.kind === "worker");
  element<HTMLButtonElement>("set-rally").disabled = !canOrder;
  element<HTMLButtonElement>("clear-rally").disabled = !canOrder || !producer?.order.kind.startsWith("rally_");
  element<HTMLButtonElement>("cancel-production").disabled = !canOrder || !producer?.production.length;
  element<HTMLButtonElement>("cancel-construction").disabled = !canOrder || !battlefield.ownedSelection().some(unit => unit.constructionRemaining > 0n);
  element<HTMLButtonElement>("idle-worker").disabled = !canOrder || !owned.some(unit => unit.kind === "worker" && unit.order.kind === "stop");
  element("cancel-production").title = `Cancel all unfinished production / refund ${producer?.production.reduce((total, item) => total + (CATALOG[item.kind]?.cost ?? 150), 0) ?? 0} ore`;
  element("rally-status").textContent = producer?.order.kind === "rally_move" ? `Rally ${Math.round(producer.order.x)}, ${Math.round(producer.order.y)}` : producer?.order.kind === "rally_gather" ? `Ore rally #${producer.order.target}` : "Rally unset";
  element("selection-order").textContent = selection.length === 1 ? selection[0].constructionRemaining > 0n ? `Construction / ${(Number(selection[0].constructionRemaining) / 20).toFixed(1)}s work` : selection[0].order.kind.split("_").join(" ") : "";
  const targetLabel = battlefield.targeting?.startsWith("build_") ? `Place ${CATALOG[battlefield.targeting.slice(6)].label}` : battlefield.targeting === "attack_move" ? "Attack-move target" : battlefield.targeting === "repair" ? "Repair target" : "Rally target";
  element("targeting-state").hidden = !battlefield.targeting;
  element("targeting-state").textContent = targetLabel;
  for (const [id, kind] of [["attack-move", "attack_move"], ["repair", "repair"], ["set-rally", "rally"]]) element(id).setAttribute("aria-pressed", String(battlefield.targeting === kind));
  const result = room.state === "finished" ? room.winner === -1 ? "Draw" : room.winner === me.slot ? "Victory" : "Defeat" : session.matchReady && !hq ? "HQ destroyed" : "";
  element("result").hidden = !result;
  element("result-title").textContent = result;
  const members = players.filter(player => player.matchId === room.id).sort((left, right) => left.slot - right.slot);
  const signature = JSON.stringify(members.map(player => [player.name, player.slot, player.online]));
  if (signature !== rosterSignature) {
    rosterSignature = signature;
    element("battle-players").replaceChildren(...members.map(player => {
      const row = text("div", `${player.name}${player.slot === me.slot ? " / you" : ""}${player.online ? "" : " / offline"}`, `battle-player${player.online ? "" : " offline"}`);
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
  element("production-queue").replaceChildren(...(hq?.production ?? []).map(item => text("span", `${item.kind} ${Math.max(0, Number(item.finishTick - room.tick) / 20).toFixed(1)}s`, "production-item")));
  const technology = session.snapshot.units.find(unit => unit.owner === me.slot && unit.kind === "hq")?.research.map(kind => kind.slice(9)) ?? [];
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
    if (command.status === "rejected" && command.reason) row.append(text("span", command.reason, "command-reason"));
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