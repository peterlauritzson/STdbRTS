import "../styles.css";
import { createIcons, Crosshair, Radio, Plus, Play, LogOut, House, Maximize2, ZoomIn, ZoomOut, MousePointer2, Move, Square, CornerDownLeft, Swords, Hammer } from "lucide";
import { Battlefield } from "./battlefield";
import { Session } from "./network";
import { COLORS, countdown, VISUALS } from "./presentation";

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

createIcons({ icons: { Crosshair, Radio, Plus, Play, LogOut, House, Maximize2, ZoomIn, ZoomOut, MousePointer2, Move, Square, CornerDownLeft, Swords, Hammer } });
const session = new Session();
const battlefield = new Battlefield(element<HTMLCanvasElement>("battlefield"), element<HTMLCanvasElement>("minimap"), session);
const host = element<HTMLInputElement>("host");
const database = element<HTMLInputElement>("database");
const callsign = element<HTMLInputElement>("callsign");
const query = new URLSearchParams(location.search);
host.value = import.meta.env.VITE_STDB_HOST ?? localStorage.getItem("stdbrts:v2:host") ?? "ws://127.0.0.1:3000";
database.value = query.get("database") ?? import.meta.env.VITE_STDB_DATABASE ?? localStorage.getItem("stdbrts:v2:database") ?? "stdbrts-v2-dev";
callsign.value = localStorage.getItem("stdbrts:v2:callsign") ?? "Commander";
let noticeTimer: ReturnType<typeof setTimeout>;
let lobbySignature = "";
let rosterSignature = "";

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
  localStorage.setItem("stdbrts:v2:database", name);
  session.connect(uri, name);
}

element("connection-form").addEventListener("submit", event => { event.preventDefault(); connect(); element<HTMLDetailsElement>("connection-settings").open = false; });
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
element("camera-fit").addEventListener("click", () => battlefield.fit());
element("zoom-in").addEventListener("click", () => battlefield.zoom(1.25));
element("zoom-out").addEventListener("click", () => battlefield.zoom(0.8));
element("stop").addEventListener("click", () => battlefield.issue("stop"));
element("return").addEventListener("click", () => battlefield.issue("return"));
element("select-army").addEventListener("click", () => { battlefield.selectArmy(); });
document.querySelectorAll<HTMLInputElement>("input[name=mode]").forEach(input => input.addEventListener("change", () => {
  if (input.value === "select" || input.value === "order" || input.value === "pan") battlefield.mode = input.value;
}));
for (const kind of ["worker", "soldier"]) element(`train-${kind}`).addEventListener("click", () => {
  const hq = session.snapshot.units.find(unit => unit.owner === session.snapshot.me?.slot && unit.kind === "hq");
  if (hq) void session.order([hq.id], { kind: `train_${kind}`, x: 0, y: 0, target: 0 });
});

function renderLobby(): void {
  const { rooms, players, me, room } = session.snapshot;
  element("room-browser").hidden = !!room;
  element("waiting-room").hidden = !room;
  element<HTMLButtonElement>("create-room").disabled = !session.ready || !!room;
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
  const canOrder = session.ready && session.matchReady && room.state === "playing" && !!hq;
  element("match-name").textContent = room.name;
  element("resources").textContent = String(me.resources);
  element("unit-count").textContent = `${owned.filter(unit => unit.kind !== "hq").length} / 60`;
  for (const [kind, cost] of [["worker", 50], ["soldier", 100]] as const) element<HTMLButtonElement>(`train-${kind}`).disabled = !canOrder || me.resources < cost || (hq?.production.length ?? 0) >= 8 || owned.length - 1 + (hq?.production.length ?? 0) >= 60;
  const selection = units.filter(unit => battlefield.selected.has(unit.id));
  element("selection-title").textContent = selection.length === 1 ? VISUALS[selection[0].kind]?.label ?? selection[0].kind : selection.length ? `${selection.length} units` : "No selection";
  element("selection-details").textContent = selection.length ? `${selection.reduce((sum, unit) => sum + unit.hp, 0)} HP${selection.some(unit => unit.kind === "worker") ? ` / ${selection.reduce((sum, unit) => sum + unit.cargo, 0)} cargo` : ""}` : "";
  element<HTMLButtonElement>("stop").disabled = !canOrder || !battlefield.ownedSelection().some(unit => unit.kind !== "hq");
  element<HTMLButtonElement>("return").disabled = !canOrder || !battlefield.ownedSelection().some(unit => unit.kind === "worker");
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
  const { room, me, units, commands } = session.snapshot;
  if (!room || !me || room.state === "lobby") return;
  const seconds = Number(room.tick / 20n);
  element("match-clock").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const hq = units.find(unit => unit.owner === me.slot && unit.kind === "hq");
  element("production-queue").replaceChildren(...(hq?.production ?? []).map(item => text("span", `${item.kind} ${Math.max(0, Number(item.finishTick - room.tick) / 20).toFixed(1)}s`, "production-item")));
  const ours = commands.filter(command => command.owner === me.slot).sort((left, right) => left.id > right.id ? -1 : 1);
  element("pending-count").textContent = String(ours.filter(command => command.status === "scheduled").length + session.pending.size);
  const rows = [...session.pending.values()].map(pending => {
    const row = text("div", "", "command-row"); row.append(text("span", pending.order.kind), text("span", "Sending")); return row;
  });
  for (const command of ours.slice(0, 8)) {
    const row = text("div", "", `command-row ${command.status}`);
    const label = command.order.kind.replace("train_", "train ");
    row.append(text("span", `${label} / ${command.units.length}`), text("span", command.status === "scheduled" ? `${countdown(command.executeTick, room.tick, performance.now() - session.tickReceivedAt).toFixed(1)}s` : command.status));
    row.title = command.reason; rows.push(row);
  }
  element("command-list").replaceChildren(...rows);
  const age = Math.round(performance.now() - session.tickReceivedAt);
  element("telemetry").textContent = `TICK ${room.tick} / ACK ${session.ackMs}ms${room.state === "playing" && age > 1000 ? ` / STALE ${Math.floor(age / 1000)}s` : ""}`;
}

function render(): void {
  const playing = !!session.snapshot.room && session.snapshot.room.state !== "lobby";
  element("lobby").hidden = playing;
  element("match").hidden = !playing;
  element("status").textContent = session.status;
  element("connection-dot").classList.toggle("online", session.ready);
  battlefield.sync();
  if (playing) { renderMatch(); renderTimers(); } else renderLobby();
}

battlefield.onSelection = renderMatch;
session.onChange = render;
setInterval(renderTimers, 100);
connect();