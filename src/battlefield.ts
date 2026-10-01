import type { CreepPatch, Entity, Order } from "./bindings/types";
import { Session } from "./network";
import { clamp, clampToMap, COLORS, countdown, VISUALS, WORLD_SIZE } from "./presentation";
import { cargoCapacity, carriesCargo, currencyOf, factionOf, fights, isArmy, isBuilding, isCompletedHub, RALLIES, isLabour, isTemporary, mapIdentity, placementError, starts, terrain, type FactionName } from "./catalog";
import { DOUBLE_TAP_MS, edgeDirection, groupAction, UNIT_KEYS } from "./hotkeys";
import { creepGoneTick, lifetimeFraction, offCreep } from "./creep";
import { ABILITIES, abilityOf, castingHub, maxEnergy, onCreep, recallable, scheduledCasts, type AbilityKind } from "./abilities";
import { arriving, canTeleport, channelFraction, fieldsOf, powered, POWER_FIELD_RADIUS, recharging, SENSOR_FIELD_RADIUS, shieldsRegenerating, type Field } from "./zones";

interface Point { x: number; y: number }
interface Motion { from: Point; to: Point; at: number }
type InputMode = "select" | "order" | "pan";
type TargetMode = "attack_move" | "repair" | "rally" | "teleport" | AbilityKind | `build_${string}`;

/** How long a click ping, a target flash and a death burst last, in ms. */
const PING_MS = 520;
const FLASH_MS = 700;
const DEATH_MS = 650;
const HIT_MS = 140;
const OWN_RING = "#7cf0b0";
const ENEMY_RING = "#ff7a86";

/**
 * One colour per intent, as in SC2: green goes, red fights, gold works, cyan
 * builds, violet casts. Used for the click ping, the intent line and the
 * order line, so the same order reads the same way at every stage.
 */
export function orderColor(kind: string): string {
  if (kind === "attack" || kind === "attack_move") return "#ff6b6b";
  if (["gather", "rally_gather", "return", "repair"].includes(kind)) return "#f3d570";
  if (kind.startsWith("build_")) return "#8fd8ff";
  if (kind === "recall" || kind === "bloom") return "#c9b2ff";
  return "#6ee7a8";
}

export class Battlefield {
  selected = new Set<number>();
  mode: InputMode = "select";
  targeting: TargetMode | undefined;
  private pointer: Point | undefined;
  onSelection: () => void = () => {};
  private context: CanvasRenderingContext2D;
  private miniContext: CanvasRenderingContext2D;
  private camera = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, zoom: 1 };
  private width = 1;
  private height = 1;
  private motions = new Map<number, Motion>();
  private roomId = 0n;
  private drag: { start: Point; end: Point; pan: boolean; pointer: number } | undefined;
  private keys = new Set<string>();
  private groups = new Map<string, Set<number>>();
  private lastGroupTap: { group: string; at: number } | undefined;
  /** The pointer in window coordinates, for edge scrolling; undefined once it leaves the window. */
  private screenPointer: Point | undefined;
  private minimapDrag: number | undefined;
  /** Last seen health per unit, to notice your own units being hurt. */
  private health = new Map<number, number>();
  /** Where your units were recently hurt, pinged on the minimap for a few seconds. */
  private alerts: { x: number; y: number; at: number }[] = [];
  /**
   * Local acknowledgement, drawn on the next frame after the click and before
   * the server has even seen the order: the one-second delay is honest, but a
   * click that answers nothing for a second reads as a dropped click.
   */
  private pings: { x: number; y: number; color: string; at: number }[] = [];
  /** Units and deposits (keyed -id - 1) just named as a target, blinking in the order's colour. */
  private flashes = new Map<number, { color: string; at: number }>();
  /** Units that were just removed, drawn as a short burst where they stood. */
  private deaths: { x: number; y: number; radius: number; color: string; building: boolean; at: number }[] = [];
  /** When each unit last lost health, for a brief hit flash. */
  private hurtAt = new Map<number, number>();
  /** The previous update's units, to know the kind and owner of one that just vanished. */
  private lastSeen = new Map<number, Entity>();
  /** Units the box being dragged would select, highlighted before release. */
  private boxPreview: Set<number> | undefined;
  /** Measured milliseconds per server tick, so motion spans the real gap between updates. */
  private tickInterval = 50;
  private lastTick: { tick: bigint; at: number } | undefined;
  /** The targeting mode was kept armed by Shift; releasing Shift disarms it. */
  private stickyTarget = false;
  /** Called once per order this battlefield sends, for the acknowledgement sound. */
  onOrder: (kind: string) => void = () => {};
  /** The unit under the pointer, drawn with a hover ring and its bars. */
  hovered: number | undefined;
  /**
   * Offered every key before the battlefield's own bindings, so the command
   * card (train, build) can claim its keys. Returns true when it used the key.
   */
  onKey: (event: KeyboardEvent) => boolean = () => false;
  private terrain = document.createElement("canvas");
  private lastFrame = performance.now();

  constructor(private canvas: HTMLCanvasElement, private minimap: HTMLCanvasElement, private session: Session) {
    this.context = canvas.getContext("2d")!;
    this.miniContext = minimap.getContext("2d")!;
    this.paintTerrain();
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener("contextmenu", event => event.preventDefault());
    canvas.addEventListener("pointerdown", event => this.pointerDown(event));
    canvas.addEventListener("pointermove", event => this.pointerMove(event));
    canvas.addEventListener("pointerup", event => this.pointerUp(event));
    canvas.addEventListener("pointercancel", () => { this.drag = undefined; });
    canvas.addEventListener("dblclick", event => {
      const point = this.world(this.local(event));
      const hit = this.session.snapshot.units.find(unit => unit.owner === this.session.snapshot.me?.slot && Math.hypot(unit.x - point.x, unit.y - point.y) < VISUALS[unit.kind].radius + 8);
      if (hit) this.selectKindOnScreen(hit);
    });
    canvas.addEventListener("wheel", event => {
      event.preventDefault();
      const point = this.local(event);
      const before = this.world(point);
      this.camera.zoom = clamp(this.camera.zoom * Math.exp(-event.deltaY * 0.001), 0.18, 2.2);
      const after = this.world(point);
      this.camera.x += before.x - after.x;
      this.camera.y += before.y - after.y;
      this.boundCamera();
    }, { passive: false });
    // The minimap is a second battlefield: left drags the camera, right
    // issues the same context order a right-click on the ground would.
    minimap.addEventListener("contextmenu", event => event.preventDefault());
    minimap.addEventListener("pointerdown", event => {
      if (event.button === 2 && this.targeting) { this.disarm(); return; }
      if (event.button === 2 || (event.button === 0 && this.targeting)) {
        if (this.session.matchReady) this.contextOrder(this.minimapPoint(event), event.shiftKey);
        return;
      }
      if (event.button !== 0) return;
      minimap.setPointerCapture(event.pointerId);
      this.minimapDrag = event.pointerId;
      this.centreOn(this.minimapPoint(event));
    });
    minimap.addEventListener("pointermove", event => { if (this.minimapDrag === event.pointerId) this.centreOn(this.minimapPoint(event)); });
    const endMinimapDrag = (event: PointerEvent) => { if (this.minimapDrag === event.pointerId) this.minimapDrag = undefined; };
    minimap.addEventListener("pointerup", endMinimapDrag);
    minimap.addEventListener("pointercancel", endMinimapDrag);
    window.addEventListener("pointermove", event => { this.screenPointer = event.pointerType === "mouse" ? { x: event.clientX, y: event.clientY } : undefined; });
    document.documentElement.addEventListener("pointerleave", () => { this.screenPointer = undefined; });
    window.addEventListener("keydown", event => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || document.querySelector("dialog[open]")) return;
      if (!this.session.snapshot.room || this.session.snapshot.room.state === "lobby") return;
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Backspace", "F1", "F2"].includes(event.key)) event.preventDefault();
      this.keys.add(event.key);
      if (event.repeat) return;
      const group = groupAction(event);
      if (group) { event.preventDefault(); this.controlGroup(group.kind, group.group); return; }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (this.onKey(event)) { event.preventDefault(); return; }
      const key = event.key.toLowerCase();
      if (event.key === "Backspace" || event.key === "Home") this.home();
      else if (key === UNIT_KEYS.stop) this.issue("stop");
      else if (key === UNIT_KEYS.attackMove) this.arm("attack_move");
      else if (key === UNIT_KEYS.repair) this.arm("repair");
      else if (key === UNIT_KEYS.hold) this.issue("hold");
      else if (key === UNIT_KEYS.returnCargo) this.issue("return");
      else if (key === UNIT_KEYS.teleport) this.arm("teleport");
      else if (key === UNIT_KEYS.rally) this.arm("rally");
      else if (key === UNIT_KEYS.ability) { const rule = abilityOf(this.factionAt(this.session.snapshot.me?.slot ?? -1)); if (rule) this.arm(rule.kind); }
      else if (event.key === "." || event.key === "F1") this.selectIdleWorker();
      else if (event.key === "F2") this.selectArmy();
      else if (event.key === "Escape") {
        if (this.targeting) this.targeting = undefined;
        else this.selected.clear();
        this.onSelection();
      }
    });
    window.addEventListener("keyup", event => {
      this.keys.delete(event.key);
      // SC2's shift-queue: a mode kept armed by Shift ends when Shift is let go.
      if (event.key === "Shift" && this.stickyTarget) { this.stickyTarget = false; this.targeting = undefined; this.onSelection(); }
    });
    window.addEventListener("blur", () => { this.keys.clear(); this.drag = undefined; });
    requestAnimationFrame(now => this.frame(now));
  }

  sync(): void {
    const { room, units } = this.session.snapshot;
    if ((room?.id ?? 0n) !== this.roomId) {
      this.roomId = room?.id ?? 0n;
      this.selected.clear();
      this.targeting = undefined;
      this.groups.clear();
      this.motions.clear();
      this.health.clear();
      this.alerts = [];
      this.pings = [];
      this.flashes.clear();
      this.deaths = [];
      this.hurtAt.clear();
      this.lastTick = undefined;
    }
    const now = performance.now();
    // Updates arrive at whatever cadence the host and the network deliver, not
    // exactly every 50ms. Motion is spread over the measured gap per tick, so
    // units glide instead of moving in 50ms bursts and standing still between.
    const tick = room?.tick;
    if (tick !== undefined && tick !== this.lastTick?.tick) {
      if (this.lastTick && tick > this.lastTick.tick) {
        const perTick = (now - this.lastTick.at) / Number(tick - this.lastTick.tick);
        this.tickInterval = clamp(this.tickInterval * 0.8 + perTick * 0.2, 40, 120);
      }
      this.lastTick = { tick, at: now };
    }
    this.noticeDamage(units);
    const initial = this.motions.size === 0 && units.length > 0;
    const alive = new Map(units.map(unit => [unit.id, unit]));
    for (const unit of units) {
      const old = this.motions.get(unit.id);
      if (!old || old.to.x !== unit.x || old.to.y !== unit.y) {
        this.motions.set(unit.id, { from: old ? this.position(unit, now) : unit, to: { x: unit.x, y: unit.y }, at: now });
      }
    }
    for (const [id, motion] of this.motions) {
      if (alive.has(id)) continue;
      this.motions.delete(id);
      const last = this.lastSeen.get(id);
      // A snapshot that empties at once is a reconnect or a reset, not a battle.
      if (last && units.length) this.deaths.push({ x: motion.to.x, y: motion.to.y, radius: VISUALS[last.kind]?.radius ?? 12, color: COLORS[last.owner] ?? "#ffffff", building: isBuilding(last.kind), at: now });
    }
    this.lastSeen = alive;
    this.pruneSelection();
    if (initial) this.home();
  }

  /**
   * Records an alert where one of your units lost health. One alert covers a
   * 300-unit area for 4 seconds, so a long fight pings once, not every tick,
   * and a fight in view of the camera pings nothing: you are already looking.
   */
  private noticeDamage(units: readonly Entity[]): void {
    const me = this.session.snapshot.me?.slot;
    const now = performance.now();
    this.alerts = this.alerts.filter(alert => now - alert.at < 4000);
    const halfWidth = this.width / this.camera.zoom / 2;
    const halfHeight = this.height / this.camera.zoom / 2;
    for (const unit of units) {
      const before = this.health.get(unit.id);
      this.health.set(unit.id, unit.hp + unit.shields);
      if (before !== undefined && unit.hp + unit.shields < before) this.hurtAt.set(unit.id, now);
      if (unit.owner !== me || before === undefined || unit.hp + unit.shields >= before) continue;
      if (Math.abs(unit.x - this.camera.x) <= halfWidth && Math.abs(unit.y - this.camera.y) <= halfHeight) continue;
      if (this.alerts.some(alert => Math.hypot(alert.x - unit.x, alert.y - unit.y) < 300)) continue;
      this.alerts.push({ x: unit.x, y: unit.y, at: now });
    }
    if (this.health.size > units.length * 2) {
      const alive = new Set(units.map(unit => unit.id));
      for (const id of this.health.keys()) if (!alive.has(id)) this.health.delete(id);
    }
    for (const [id, at] of this.hurtAt) if (now - at > HIT_MS) this.hurtAt.delete(id);
  }

  /**
   * Every power and sensor field on the map, derived from the unit rows exactly
   * as the server derives them each tick. A slot's faction comes from its
   * player row; a slot with no row projects no power field.
   */
  fields(): Field[] {
    return fieldsOf(this.session.snapshot.units, slot => this.factionAt(slot));
  }

  /** The faction a slot in this match plays, from its player row. */
  factionAt(slot: number): FactionName | undefined {
    const { players, room } = this.session.snapshot;
    const player = players.find(player => player.matchId === room?.id && player.slot === slot);
    return player ? factionOf(player.faction) : undefined;
  }

  /** The hub that would cast `kind` for you right now, C&C style: see `castingHub`. */
  caster(kind: AbilityKind): Entity | undefined {
    const { units, commands, room, me } = this.session.snapshot;
    if (!me || this.factionAt(me.slot) !== ABILITIES[kind].faction) return undefined;
    return castingHub(units, me.slot, ABILITIES[kind], room?.tick ?? 0n, this.selected, scheduledCasts(commands, me.slot));
  }

  /** Selected units that could start a teleport right now: mobile, powered, not arriving or recharging. */
  teleporters(): Entity[] {
    const fields = this.fields();
    const tick = this.session.snapshot.room?.tick ?? 0n;
    return this.ownedSelection().filter(unit => canTeleport(unit.kind) && !arriving(unit, tick) && !recharging(unit, tick) && powered(unit.owner, unit.x, unit.y, fields));
  }

  /** The unit a construction order is issued in the name of: your HQ, or a surviving completed hub once it has fallen. */
  issuer(): Entity | undefined {
    const owned = this.session.snapshot.units.filter(unit => unit.owner === this.session.snapshot.me?.slot);
    return owned.find(unit => unit.kind === "hq") ?? owned.find(isCompletedHub);
  }

  ownedSelection(): Entity[] {
    return this.session.snapshot.units.filter(unit => this.selected.has(unit.id) && unit.owner === this.session.snapshot.me?.slot);
  }

  /** Every owned unit of `unit`'s kind currently on screen, SC2's double-click. */
  selectKindOnScreen(unit: Entity, add = false): void {
    const { units, me } = this.session.snapshot;
    if (unit.owner !== me?.slot) { this.selected = new Set([unit.id]); this.onSelection(); return; }
    const halfWidth = this.width / this.camera.zoom / 2;
    const halfHeight = this.height / this.camera.zoom / 2;
    const onScreen = units.filter(other => other.owner === unit.owner && other.kind === unit.kind
      && Math.abs(other.x - this.camera.x) <= halfWidth && Math.abs(other.y - this.camera.y) <= halfHeight);
    this.selected = new Set([...(add ? this.selected : []), ...onScreen.map(other => other.id)]);
    this.onSelection();
  }

  /** Units a control group holds that still exist. */
  group(key: string): Entity[] {
    const ids = this.groups.get(key);
    return ids ? this.session.snapshot.units.filter(unit => ids.has(unit.id)) : [];
  }

  /** Every control group that holds a living unit, in key order. */
  groupKeys(): string[] {
    return [..."1234567890"].filter(key => this.group(key).length);
  }

  controlGroup(kind: "set" | "add" | "recall", key: string): void {
    const owned = this.ownedSelection().map(unit => unit.id);
    if (kind === "set") { this.groups.set(key, new Set(owned)); this.onSelection(); return; }
    if (kind === "add") { this.groups.set(key, new Set([...(this.groups.get(key) ?? []), ...owned])); this.onSelection(); return; }
    const members = this.group(key);
    const now = performance.now();
    // A second press inside the window jumps the camera to the group, as in SC2.
    if (members.length && this.lastGroupTap?.group === key && now - this.lastGroupTap.at < DOUBLE_TAP_MS) {
      this.centreOn({ x: members.reduce((sum, unit) => sum + unit.x, 0) / members.length, y: members.reduce((sum, unit) => sum + unit.y, 0) / members.length });
    }
    this.lastGroupTap = { group: key, at: now };
    this.selected = new Set(members.map(unit => unit.id));
    this.onSelection();
  }

  centreOn(point: Point): void {
    this.camera.x = point.x; this.camera.y = point.y; this.boundCamera();
  }

  selectArmy(): void {
    this.selected = new Set(this.session.snapshot.units.filter(unit => unit.owner === this.session.snapshot.me?.slot && isArmy(unit.kind)).map(unit => unit.id));
    this.onSelection();
  }

  /** Idle labour of whatever faction this player is — worker, drifter or harvester. */
  selectIdleWorker(): void {
    const workers = this.session.snapshot.units.filter(unit => unit.owner === this.session.snapshot.me?.slot && isLabour(unit.kind) && unit.order.kind === "stop");
    const worker = workers.find(unit => !this.selected.has(unit.id)) ?? workers[0];
    if (worker) { this.selected = new Set([worker.id]); this.camera.x = worker.x; this.camera.y = worker.y; this.boundCamera(); this.onSelection(); }
  }

  home(): void {
    const hq = this.issuer();
    if (hq) { this.camera.zoom = Math.max(this.camera.zoom, 1); this.camera.x = hq.x; this.camera.y = hq.y; this.boundCamera(); }
  }

  fit(): void {
    this.camera = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, zoom: Math.min(this.width, this.height) / WORLD_SIZE * 0.97 };
  }

  zoom(amount: number): void { this.camera.zoom = clamp(this.camera.zoom * amount, 0.18, 2.2); this.boundCamera(); }

  arm(kind: TargetMode): void {
    const allowed = kind === "rally"
      ? this.session.snapshot.units.some(unit => RALLIES.includes(unit.kind) && unit.owner === this.session.snapshot.me?.slot)
      : kind.startsWith("build_") ? !!this.issuer()
      : kind === "teleport" ? this.teleporters().length > 0
      : kind in ABILITIES ? !!this.caster(kind as AbilityKind)
      : this.ownedSelection().some(unit => kind === "repair" ? isLabour(unit.kind) : fights(unit.kind));
    if (!allowed) return;
    this.targeting = this.targeting === kind ? undefined : kind;
    this.onSelection();
  }

  issue(kind: "stop" | "return" | "hold"): void {
    this.targeting = undefined;
    // Only a carrier can be told to bring a load home; a drifter has no load.
    const units = this.ownedSelection().filter(unit => kind === "return" ? carriesCargo(unit.kind) : kind === "hold" ? fights(unit.kind) : !isBuilding(unit.kind));
    if (units.length) { void this.session.order(units.map(unit => unit.id), { kind, x: 0, y: 0, target: 0 }); this.onOrder(kind); }
    this.onSelection();
  }

  private pruneSelection(): void {
    for (const id of this.selected) if (!this.session.snapshot.units.some(unit => unit.id === id)) this.selected.delete(id);
  }

  private position(unit: Entity, now: number): Point {
    const motion = this.motions.get(unit.id);
    if (!motion) return unit;
    const fraction = clamp((now - motion.at) / this.tickInterval, 0, 1);
    return { x: motion.from.x + (motion.to.x - motion.from.x) * fraction, y: motion.from.y + (motion.to.y - motion.from.y) * fraction };
  }

  private resize(): void {
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(this.width * ratio));
    this.canvas.height = Math.max(1, Math.round(this.height * ratio));
    this.boundCamera();
  }

  private boundCamera(): void {
    const halfWidth = this.width / this.camera.zoom / 2;
    const halfHeight = this.height / this.camera.zoom / 2;
    this.camera.x = halfWidth >= WORLD_SIZE / 2 ? WORLD_SIZE / 2 : clamp(this.camera.x, halfWidth, WORLD_SIZE - halfWidth);
    this.camera.y = halfHeight >= WORLD_SIZE / 2 ? WORLD_SIZE / 2 : clamp(this.camera.y, halfHeight, WORLD_SIZE - halfHeight);
  }

  private local(event: MouseEvent): Point {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  private minimapPoint(event: MouseEvent): Point {
    const bounds = this.minimap.getBoundingClientRect();
    return { x: clampToMap((event.clientX - bounds.left) / bounds.width * WORLD_SIZE), y: clampToMap((event.clientY - bounds.top) / bounds.height * WORLD_SIZE) };
  }

  /** The topmost unit under a world point, with the same slop a click gets. */
  private unitAt(point: Point): Entity | undefined {
    return [...this.session.snapshot.units].reverse().find(unit => Math.hypot(unit.x - point.x, unit.y - point.y) <= (VISUALS[unit.kind]?.radius ?? 12) + 6 / this.camera.zoom);
  }

  /**
   * The cursor says what a right-click would do before it is pressed: attack
   * over an enemy with fighters selected, gather over a deposit with labour.
   */
  private updateCursor(): void {
    const { units, nodes, me } = this.session.snapshot;
    const hovered = units.find(unit => unit.id === this.hovered);
    const owned = this.ownedSelection();
    let cursor = "default";
    if (this.targeting || this.mode === "order") cursor = "crosshair";
    else if (this.drag?.pan || this.mode === "pan") cursor = "grab";
    else if (hovered && hovered.owner !== me?.slot && owned.some(unit => fights(unit.kind))) cursor = "crosshair";
    else if (hovered) cursor = "pointer";
    else if (this.pointer && owned.some(unit => isLabour(unit.kind)) && nodes.some(node => node.amount > 0 && Math.hypot(this.pointer!.x - node.x, this.pointer!.y - node.y) < 35)) cursor = "cell";
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
  }

  private world(point: Point): Point {
    return { x: (point.x - this.width / 2) / this.camera.zoom + this.camera.x, y: (point.y - this.height / 2) / this.camera.zoom + this.camera.y };
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.session.matchReady) return;
    this.canvas.focus();
    const point = this.local(event);
    // As in SC2, the right button backs out of an armed mode instead of firing it.
    if (event.button === 2 && this.targeting) { this.disarm(); return; }
    if (event.button === 2 || (event.button === 0 && (this.mode === "order" || this.targeting))) { this.contextOrder(this.world(point), event.shiftKey); return; }
    this.canvas.setPointerCapture(event.pointerId);
    this.drag = { start: point, end: point, pan: event.button === 1 || this.keys.has(" ") || this.mode === "pan", pointer: event.pointerId };
  }

  private pointerMove(event: PointerEvent): void {
    this.pointer = this.world(this.local(event));
    this.hovered = this.unitAt(this.pointer)?.id;
    if (!this.drag || this.drag.pointer !== event.pointerId) return;
    const point = this.local(event);
    if (this.drag.pan) {
      this.camera.x -= (point.x - this.drag.end.x) / this.camera.zoom;
      this.camera.y -= (point.y - this.drag.end.y) / this.camera.zoom;
      this.boundCamera();
    }
    this.drag.end = point;
  }

  private pointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    this.drag = undefined;
    if (drag.pan) return;
    const start = this.world(drag.start);
    const end = this.world(this.local(event));
    if (!event.shiftKey) this.selected.clear();
    if (Math.hypot(drag.start.x - drag.end.x, drag.start.y - drag.end.y) < 6) {
      const hit = this.unitAt(end);
      // Ctrl+click is double-click: every unit of that kind on screen.
      if (hit && event.ctrlKey) { this.selectKindOnScreen(hit, event.shiftKey); return; }
      if (hit) {
        if (event.shiftKey && this.selected.has(hit.id)) this.selected.delete(hit.id);
        else this.selected.add(hit.id);
      }
    } else {
      // A box takes your mobile units; only a box with none in it takes your
      // buildings, as in SC2, so sweeping over a base still selects its army.
      const boxed = this.boxed(start, end);
      for (const unit of boxed.some(unit => !isBuilding(unit.kind)) ? boxed.filter(unit => !isBuilding(unit.kind)) : boxed) this.selected.add(unit.id);
    }
    this.onSelection();
  }

  /** Your units inside a world-space box, buildings included. */
  private boxed(start: Point, end: Point): Entity[] {
    const me = this.session.snapshot.me?.slot;
    const [left, right, top, bottom] = [Math.min(start.x, end.x), Math.max(start.x, end.x), Math.min(start.y, end.y), Math.max(start.y, end.y)];
    return this.session.snapshot.units.filter(unit => unit.owner === me && unit.x >= left && unit.x <= right && unit.y >= top && unit.y <= bottom);
  }

  /** Leaves an armed targeting mode without sending anything. */
  private disarm(): void {
    this.targeting = undefined;
    this.stickyTarget = false;
    this.onSelection();
  }

  /**
   * Ends a targeted order the way SC2 does: with Shift held the mode stays
   * armed for the next click (queue several attack-moves, place several
   * buildings), otherwise it is spent.
   */
  private spend(queued: boolean): void {
    if (queued && this.targeting) this.stickyTarget = true;
    else { this.targeting = undefined; this.stickyTarget = false; }
    this.onSelection();
  }

  /** The immediate answer to an order: a ping where it was aimed, a flash on its target, a sound. */
  private acknowledge(kind: string, point: Point, target?: { id: number; node: boolean }): void {
    const now = performance.now();
    const color = orderColor(kind);
    this.pings.push({ x: point.x, y: point.y, color, at: now });
    if (this.pings.length > 12) this.pings.shift();
    if (target) this.flashes.set(target.node ? -target.id - 1 : target.id, { color, at: now });
    this.onOrder(kind);
  }

  private contextOrder(point: Point, queued: boolean): void {
    const { units, nodes, me } = this.session.snapshot;
    const node = nodes.find(node => node.amount > 0 && Math.hypot(point.x - node.x, point.y - node.y) < 35);
    const owned = this.ownedSelection();
    if (this.targeting?.startsWith("build_") && me) {
      const kind = this.targeting.slice(6);
      const error = placementError(kind, point.x, point.y, me.slot, units, nodes);
      if (error) { this.session.onNotice(error); return; }
      // Command-card construction: the site raises itself, so no labour is
      // sent and the selection is left alone. The HQ is named only because a
      // command must name one of your units.
      const issuer = this.issuer();
      if (issuer) {
        void this.session.order([issuer.id], { kind: this.targeting, x: point.x, y: point.y, target: 0 });
        this.acknowledge(this.targeting, point);
        this.spend(queued);
      }
      return;
    }
    if (this.targeting === "teleport" && me) {
      // Both ends must be in your own field; the server checks both again when
      // the order executes and again when the channel completes.
      if (!powered(me.slot, point.x, point.y, this.fields())) { this.session.onNotice("Teleport destination must be inside your power field"); return; }
      const movers = this.teleporters();
      if (!movers.length) { this.session.onNotice("Select units standing inside your power field"); return; }
      void this.session.order(movers.map(unit => unit.id), { kind: "teleport", x: clampToMap(point.x), y: clampToMap(point.y), target: 0 });
      this.acknowledge("teleport", point);
      this.spend(false);
      return;
    }
    if ((this.targeting === "recall" || this.targeting === "bloom") && me) {
      const kind = this.targeting;
      const refusal = kind === "bloom"
        ? onCreep(me.slot, point.x, point.y, this.session.snapshot.creep) ? undefined : "Bloom must be placed on your own creep"
        : recallable(units, me.slot, point.x, point.y, canTeleport) ? undefined : "None of your units are near that point to recall";
      if (refusal) { this.session.onNotice(refusal); return; }
      const hub = this.caster(kind);
      if (!hub) { this.session.onNotice(`No hub can cast ${ABILITIES[kind].label} right now`); return; }
      void this.session.order([hub.id], { kind, x: clampToMap(point.x), y: clampToMap(point.y), target: 0 });
      this.acknowledge(kind, point);
      this.spend(false);
      return;
    }
    const headquarters = owned.find(unit => RALLIES.includes(unit.kind)) ?? units.find(unit => unit.kind === "hq" && unit.owner === me?.slot);
    if (headquarters && (this.targeting === "rally" || (!this.targeting && owned.length === 1 && ["hq", "outpost", "barracks", "factory"].includes(owned[0].kind)))) {
      void this.session.order([headquarters.id], { kind: node ? "rally_gather" : "rally_move", x: clampToMap(point.x), y: clampToMap(point.y), target: node?.id ?? 0 });
      this.acknowledge(node ? "rally_gather" : "rally_move", node ?? point, node && { id: node.id, node: true });
      this.spend(false);
      return;
    }
    let selected = this.ownedSelection().filter(unit => !isBuilding(unit.kind));
    if (!selected.length) return;
    const enemy = units.find(unit => unit.owner !== me?.slot && Math.hypot(point.x - unit.x, point.y - unit.y) < (VISUALS[unit.kind]?.radius ?? 12) + 8);
    const friendly = units.find(unit => unit.owner === me?.slot && Math.hypot(point.x - unit.x, point.y - unit.y) < (VISUALS[unit.kind]?.radius ?? 12) + 8);
    const hq = units.find(unit => unit.owner === me?.slot && ["hq", "outpost"].includes(unit.kind) && unit.constructionRemaining === 0n && Math.hypot(point.x - unit.x, point.y - unit.y) < 40);
    const order: Order = { kind: "move", x: clampToMap(point.x), y: clampToMap(point.y), target: 0 };
    if (this.targeting === "attack_move") { order.kind = "attack_move"; selected = selected.filter(unit => fights(unit.kind)); }
    else if (this.targeting === "repair") {
      if (!friendly || friendly.hp >= friendly.maxHp) { this.session.onNotice("Choose a damaged friendly unit or HQ"); return; }
      if (friendly.constructionRemaining > 0n) { this.session.onNotice("Still under construction; it finishes on its own"); return; }
      order.kind = "repair"; order.target = friendly.id; selected = selected.filter(unit => isLabour(unit.kind) && unit.id !== friendly.id);
    }
    else if (enemy) { order.kind = "attack"; order.target = enemy.id; selected = selected.filter(unit => fights(unit.kind)); }
    else if (node) { order.kind = "gather"; order.target = node.id; selected = selected.filter(unit => isLabour(unit.kind)); }
    // Dropping a load at a hub is a carrier's order. A drifter told to return is
    // refused by name on the server, so it is never included here.
    else if (hq) { order.kind = "return"; selected = selected.filter(unit => carriesCargo(unit.kind)); }
    else if (friendly && friendly.hp < friendly.maxHp) { order.kind = "repair"; order.target = friendly.id; selected = selected.filter(unit => isLabour(unit.kind) && unit.id !== friendly.id); }
    if (selected.length) {
      void this.session.order(selected.map(unit => unit.id), order, queued);
      const target = order.kind === "attack" ? enemy : order.kind === "repair" ? friendly : order.kind === "return" ? hq : undefined;
      if (order.kind === "gather" && node) this.acknowledge("gather", node, { id: node.id, node: true });
      else this.acknowledge(order.kind, target ?? point, target && { id: target.id, node: false });
      this.spend(queued);
    }
    else this.session.onNotice(enemy ? "Select fighting units to attack" : "Select labour units for this order");
  }

  /**
   * The ground, painted once for the whole map. Everything here comes from the
   * map definition: the start pads sit on the map's own starts, and the tiles
   * cover its full extent. This used to paint the 1600 map's four pads and
   * only its quarter of tiles, so crossfire's ground looked empty and wrong.
   */
  private paintTerrain(): void {
    this.terrain.width = WORLD_SIZE;
    this.terrain.height = WORLD_SIZE;
    const context = this.terrain.getContext("2d")!;
    context.fillStyle = "#283c37";
    context.fillRect(0, 0, WORLD_SIZE, WORLD_SIZE);
    const cells = Math.ceil(WORLD_SIZE / 40);
    for (let row = 0; row < cells; row++) for (let column = 0; column < cells; column++) {
      const seed = ((row * 73856093) ^ (column * 19349663)) >>> 0;
      context.fillStyle = ["#2c403a", "#293e38", "#30433c", "#263b36"][seed % 4];
      context.fillRect(column * 40, row * 40, 40, 40);
      context.strokeStyle = "#3e5045";
      context.beginPath();
      context.moveTo(column * 40 + seed % 25, row * 40 + seed % 29);
      context.lineTo(column * 40 + seed % 25 + 3, row * 40 + seed % 29 - 5);
      context.stroke();
    }
    context.strokeStyle = "#ffffff08";
    for (let line = 0; line <= WORLD_SIZE; line += 80) {
      context.beginPath(); context.moveTo(line, 0); context.lineTo(line, WORLD_SIZE); context.stroke();
      context.beginPath(); context.moveTo(0, line); context.lineTo(WORLD_SIZE, line); context.stroke();
    }
    for (const [x, y] of starts) {
      context.fillStyle = "#43524b"; context.fillRect(x - 65, y - 65, 130, 130);
      context.strokeStyle = "#87928366"; context.strokeRect(x - 75, y - 75, 150, 150);
      context.setLineDash([8, 8]); context.strokeRect(x - 94, y - 94, 188, 188); context.setLineDash([]);
    }
    context.strokeStyle = "#82968044";
    context.lineWidth = 2;
    const mid = WORLD_SIZE / 2;
    context.beginPath(); context.moveTo(mid, mid - 100); context.lineTo(mid + 100, mid); context.lineTo(mid, mid + 100); context.lineTo(mid - 100, mid); context.closePath(); context.stroke();
    context.font = "18px 'IBM Plex Mono'"; context.textAlign = "center"; context.fillStyle = "#a8b8a877";
    context.fillText(mapIdentity.id.toUpperCase(), mid, mid + 7);
    for (const [x, y, width, height] of terrain) {
      context.fillStyle = "#122b2c"; context.fillRect(x + 8, y + 10, width, height);
      context.fillStyle = "#748480"; context.fillRect(x, y, width, height);
      context.fillStyle = "#98aaa1"; context.fillRect(x + 3, y + 3, width - 6, 7);
      context.strokeStyle = "#485a59"; context.lineWidth = 3;
      for (let offset = 20; offset < width; offset += 32) { context.beginPath(); context.moveTo(x + offset, y + 8); context.lineTo(x + offset - 7, y + height - 5); context.stroke(); }
      context.fillStyle = "#c1c9ab";
      for (let offset = 12; offset < width; offset += 24) context.fillRect(x + offset, y - 2, 7, 3);
    }
  }

  private frame(now: number): void {
    const elapsed = Math.min(now - this.lastFrame, 50);
    this.lastFrame = now;
    if (this.canvas.clientWidth && this.canvas.clientHeight) {
      const speed = elapsed * 0.6 / this.camera.zoom;
      if (this.keys.has("ArrowLeft")) this.camera.x -= speed;
      if (this.keys.has("ArrowRight")) this.camera.x += speed;
      if (this.keys.has("ArrowUp")) this.camera.y -= speed;
      if (this.keys.has("ArrowDown")) this.camera.y += speed;
      // Edge scrolling, only while the match is live and this window has focus,
      // so a pointer parked on the taskbar does not drift the camera.
      if (this.session.snapshot.room && this.session.snapshot.room.state !== "lobby" && document.hasFocus() && this.drag?.pan !== true) {
        // The edges are the battlefield's, not the window's: its top sits under
        // the match bar and its bottom on the command deck, and the pointer is
        // there, not at the window edge, when a player pushes the view.
        const bounds = this.canvas.getBoundingClientRect();
        const local = this.screenPointer && { x: this.screenPointer.x - bounds.left, y: this.screenPointer.y - bounds.top };
        const edge = edgeDirection(local, bounds.width, bounds.height);
        this.camera.x += edge.x * speed * 1.4;
        this.camera.y += edge.y * speed * 1.4;
      }
      this.boundCamera();
      this.updateCursor();
      this.draw(now);
      this.drawMinimap();
    }
    requestAnimationFrame(time => this.frame(time));
  }

  private draw(now: number): void {
    const context = this.context;
    const ratio = this.canvas.width / this.width;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = "#172521"; context.fillRect(0, 0, this.width, this.height);
    context.save();
    context.translate(this.width / 2, this.height / 2);
    context.scale(this.camera.zoom, this.camera.zoom);
    context.translate(-this.camera.x, -this.camera.y);
    context.drawImage(this.terrain, 0, 0);
    const { units, nodes, commands, room } = this.session.snapshot;
    const fields = this.fields();
    this.drawFields(fields, now);
    this.drawCreep(now);
    for (const node of nodes) {
      if (node.amount === 0) continue;
      const currency = currencyOf(node.kind);
      context.save(); context.translate(node.x, node.y);
      if (currency === "catalyst") {
        // Catalyst deposits are three tall violet spires inside a halo: a
        // different silhouette, a different count and a different colour from
        // the low material chunks, so shape alone still tells them apart.
        context.strokeStyle = "#7e5cc0"; context.lineWidth = 1.5;
        context.beginPath(); context.arc(0, 0, 30, 0, Math.PI * 2); context.stroke();
        for (let index = 0; index < 3; index++) {
          const x = (index - 1) * 14;
          const height = index === 1 ? 30 : 22;
          context.fillStyle = index === 1 ? "#d3a6ff" : "#a878ea";
          context.strokeStyle = "#3c2c5c"; context.lineWidth = 2;
          context.beginPath(); context.moveTo(x, -height); context.lineTo(x + 8, -4); context.lineTo(x, 16); context.lineTo(x - 8, -4); context.closePath(); context.fill(); context.stroke();
        }
      } else {
        for (let index = 0; index < 5; index++) {
          const x = (index % 3 - 1) * 15;
          const y = Math.floor(index / 3) * 15 - 8;
          context.fillStyle = index % 2 ? "#ecd58a" : "#b4cfa4";
          context.strokeStyle = "#5b795a"; context.lineWidth = 2;
          context.beginPath(); context.moveTo(x, y - 16); context.lineTo(x + 9, y - 2); context.lineTo(x + 6, y + 13); context.lineTo(x - 8, y + 8); context.closePath(); context.fill(); context.stroke();
        }
      }
      // The amount is written out when it is asked for: zoomed in, or under the
      // pointer. At every other zoom 150 labels are only noise; the shape and
      // colour already say which currency a deposit holds.
      const flash = this.flashes.get(-node.id - 1);
      if (flash && now - flash.at < FLASH_MS && Math.floor((now - flash.at) / 110) % 2 === 0) {
        context.strokeStyle = flash.color; context.lineWidth = 2.5 / this.camera.zoom;
        context.beginPath(); context.arc(0, 0, 36, 0, Math.PI * 2); context.stroke();
      }
      const hovered = this.pointer && Math.hypot(this.pointer.x - node.x, this.pointer.y - node.y) < 35;
      if (hovered || this.camera.zoom >= 1.4) {
        context.font = "11px 'IBM Plex Mono'"; context.textAlign = "center";
        context.fillStyle = currency === "catalyst" ? "#e0c9ff" : "#f3e8bd";
        context.fillText(`${node.amount} ${currency === "catalyst" ? "CAT" : "MAT"}`, 0, 42);
      }
      context.restore();
    }
    const mySlot = this.session.snapshot.me?.slot;
    // Order lines, SC2's shift-queue view: each leg in its order's colour with
    // a waypoint dot, for selected units (and your HQ's rally, always).
    for (const unit of units) {
      if (this.selected.has(unit.id) || (unit.kind === "hq" && unit.owner === mySlot)) {
        let point: Point = this.position(unit, now);
        for (const order of [unit.order, ...unit.queue]) {
          const target = this.orderTarget(order);
          if (!target) continue;
          const color = orderColor(order.kind);
          context.strokeStyle = `${color}90`; context.lineWidth = 1.5 / this.camera.zoom; context.setLineDash([5 / this.camera.zoom, 5 / this.camera.zoom]);
          context.beginPath(); context.moveTo(point.x, point.y); context.lineTo(target.x, target.y); context.stroke(); context.setLineDash([]);
          context.fillStyle = color; context.beginPath(); context.arc(target.x, target.y, 3.5 / this.camera.zoom, 0, Math.PI * 2); context.fill();
          if (order.kind.startsWith("rally_")) this.marker(target, COLORS[unit.owner], "RALLY");
          point = target;
        }
      }
    }
    // Your orders still inside the delay: a line from every unit that will
    // carry it out to where it is aimed, and a ring at the aim that closes as
    // the delay runs out. The units have visibly "heard" the order at once;
    // the ring says when they will act. An opponent's reads as before. An
    // order still in flight is stamped with its tick, so its ring starts
    // filling at the click rather than when the server answers.
    const delay = Math.max(1, Number(room?.commandDelay ?? 20n));
    const since = now - this.session.tickReceivedAt;
    const left = (executeTick: bigint) => countdown(executeTick, room?.tick ?? 0n, since);
    for (const command of commands.filter(command => command.status === "scheduled")) {
      const target = this.orderTarget(command.order);
      if (!target) continue;
      if (command.owner === mySlot) this.intent(command.units, command.order.kind, target, 1 - left(command.executeTick) * 20 / delay, now);
      else this.marker(target, COLORS[command.owner], `${left(command.executeTick).toFixed(1)}s`);
    }
    for (const pending of this.session.pending.values()) {
      const target = this.orderTarget(pending.order);
      if (target) this.intent(pending.units, pending.order.kind, target, 1 - left(pending.executeTick) * 20 / delay, now);
    }
    if (this.targeting?.startsWith("build_") && this.session.snapshot.me) this.drawPlacementZones(this.session.snapshot.me.slot);
    this.boxPreview = this.drag && !this.drag.pan && Math.hypot(this.drag.start.x - this.drag.end.x, this.drag.start.y - this.drag.end.y) >= 6
      ? new Set((boxed => boxed.some(unit => !isBuilding(unit.kind)) ? boxed.filter(unit => !isBuilding(unit.kind)) : boxed)(this.boxed(this.world(this.drag.start), this.world(this.drag.end))).map(unit => unit.id))
      : undefined;
    for (const unit of [...units].sort((left, right) => left.y - right.y)) this.drawUnit(unit, now);
    this.drawDeaths(now);
    this.drawPings(now);
    this.drawCreepCountdowns(now);
    if (this.targeting?.startsWith("build_") && this.pointer && this.session.snapshot.me) {
      const kind = this.targeting.slice(6);
      const error = placementError(kind, this.pointer.x, this.pointer.y, this.session.snapshot.me.slot, units, nodes);
      context.fillStyle = error ? "#ed7c8b55" : "#66dfba55";
      context.strokeStyle = error ? "#ed7c8b" : "#66dfba"; context.lineWidth = 2;
      context.fillRect(this.pointer.x - 35, this.pointer.y - 35, 70, 70); context.strokeRect(this.pointer.x - 35, this.pointer.y - 35, 70, 70);
      if (kind === "turret") { context.beginPath(); context.arc(this.pointer.x, this.pointer.y, 210, 0, Math.PI * 2); context.stroke(); }
      // A zone projector previews the ground it will cover.
      const reach = kind === "relay" ? POWER_FIELD_RADIUS : kind === "sensor" ? SENSOR_FIELD_RADIUS : 0;
      if (reach) { context.setLineDash([8, 8]); context.beginPath(); context.arc(this.pointer.x, this.pointer.y, reach, 0, Math.PI * 2); context.stroke(); context.setLineDash([]); }
      context.fillStyle = "#efffea"; context.textAlign = "center"; context.font = "13px 'IBM Plex Mono'";
      context.fillText(error ?? VISUALS[kind].label, this.pointer.x, this.pointer.y - 48);
    }
    if (this.targeting === "teleport" && this.pointer && this.session.snapshot.me) {
      const ok = powered(this.session.snapshot.me.slot, this.pointer.x, this.pointer.y, fields);
      context.strokeStyle = ok ? "#8fd8ff" : "#ed7c8b"; context.lineWidth = 2 / this.camera.zoom;
      context.setLineDash([4 / this.camera.zoom, 4 / this.camera.zoom]);
      context.beginPath(); context.arc(this.pointer.x, this.pointer.y, 22, 0, Math.PI * 2); context.stroke(); context.setLineDash([]);
      context.fillStyle = ok ? "#cfefff" : "#ed7c8b"; context.textAlign = "center"; context.font = `${12 / this.camera.zoom}px 'IBM Plex Mono'`;
      context.fillText(ok ? "TELEPORT HERE" : "OUTSIDE YOUR FIELD", this.pointer.x, this.pointer.y - 30);
    }
    if ((this.targeting === "recall" || this.targeting === "bloom") && this.pointer && this.session.snapshot.me) {
      const slot = this.session.snapshot.me.slot;
      const { x, y } = this.pointer;
      const count = recallable(units, slot, x, y, canTeleport);
      const ok = this.targeting === "bloom" ? onCreep(slot, x, y, this.session.snapshot.creep) : count > 0;
      const label = this.targeting === "bloom" ? ok ? "BLOOM HERE" : "NOT ON YOUR CREEP" : ok ? `RECALL ${count}` : "NOTHING TO RECALL";
      context.strokeStyle = ok ? "#c9b2ff" : "#ed7c8b"; context.lineWidth = 2 / this.camera.zoom;
      context.setLineDash([8 / this.camera.zoom, 6 / this.camera.zoom]);
      context.beginPath(); context.arc(x, y, ABILITIES[this.targeting].radius, 0, Math.PI * 2); context.stroke(); context.setLineDash([]);
      context.fillStyle = ok ? "#e6d9ff" : "#ed7c8b"; context.textAlign = "center"; context.font = `${12 / this.camera.zoom}px 'IBM Plex Mono'`;
      context.fillText(label, x, y - 12 / this.camera.zoom);
    }
    // A recall channelling, for everyone to see: the area that is about to
    // leave, closing in as the channel completes, and a line to the hub it
    // lands at. The opponent sees exactly what the caster does.
    const castTick = room?.tick ?? 0n;
    for (const hub of units) {
      if (!hub.cast) continue;
      const left = Math.max(0, Number(hub.cast.completeTick - castTick) - (now - this.session.tickReceivedAt) / 50);
      const progress = 1 - Math.min(1, left / Number(ABILITIES.recall.channelTicks));
      context.strokeStyle = COLORS[hub.owner]; context.lineWidth = 2.5 / this.camera.zoom;
      context.beginPath(); context.arc(hub.cast.x, hub.cast.y, ABILITIES.recall.radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress); context.stroke();
      context.setLineDash([6 / this.camera.zoom, 6 / this.camera.zoom]); context.lineWidth = 1.5 / this.camera.zoom;
      context.beginPath(); context.arc(hub.cast.x, hub.cast.y, ABILITIES.recall.radius, 0, Math.PI * 2); context.stroke();
      context.beginPath(); context.moveTo(hub.cast.x, hub.cast.y); context.lineTo(hub.x, hub.y); context.stroke(); context.setLineDash([]);
      context.fillStyle = "#e6d9ff"; context.textAlign = "center"; context.font = `${13 / this.camera.zoom}px 'IBM Plex Mono'`;
      context.fillText(`RECALL ${(left / 20).toFixed(1)}s`, hub.cast.x, hub.cast.y - ABILITIES.recall.radius - 8 / this.camera.zoom);
    }
    context.restore();
    if (this.drag && !this.drag.pan) {
      context.strokeStyle = "#b3f7dc"; context.fillStyle = "#9cedd321"; context.lineWidth = 1;
      const { start, end } = this.drag;
      context.fillRect(start.x, start.y, end.x - start.x, end.y - start.y); context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
    }
    // Nothing is predicted, so a quiet server simply freezes the picture;
    // say so rather than leave the player wondering whether a click took.
    if (this.session.stalled(now)) {
      const label = `WAITING FOR SERVER ${((now - this.session.tickReceivedAt) / 1000).toFixed(1)}s`;
      context.font = "600 14px 'IBM Plex Mono'"; context.textAlign = "center";
      const width = context.measureText(label).width + 28;
      context.fillStyle = "#101c19e0"; context.fillRect(this.width / 2 - width / 2, 16, width, 32);
      context.strokeStyle = "#edce6d"; context.lineWidth = 1; context.strokeRect(this.width / 2 - width / 2 + 0.5, 16.5, width - 1, 31);
      context.fillStyle = "#edce6d"; context.fillText(label, this.width / 2, 37);
    }
  }

  /**
   * Network power fields and Industrial sensor fields, under creep and units.
   * The two are told apart by pattern as well as colour: a power field is a
   * filled owner-tinted disc with a dotted edge that drifts slowly, a sensor
   * field is an unfilled ring with long dashes. Overlapping discs of one owner
   * are drawn once each; the fill is faint enough that overlaps stay legible.
   */
  private drawFields(fields: readonly Field[], now: number): void {
    const context = this.context;
    for (const field of fields) {
      const color = COLORS[field.owner] ?? "#9fb39f";
      context.lineWidth = 1.5 / this.camera.zoom;
      if (field.kind === "power") {
        context.fillStyle = `${color}14`;
        context.beginPath(); context.arc(field.x, field.y, field.radius, 0, Math.PI * 2); context.fill();
        context.strokeStyle = `${color}90`;
        context.setLineDash([2 / this.camera.zoom, 7 / this.camera.zoom]);
        context.lineDashOffset = -now / 120 / this.camera.zoom;
      } else {
        context.strokeStyle = `${color}70`;
        context.setLineDash([14 / this.camera.zoom, 10 / this.camera.zoom]);
      }
      context.beginPath(); context.arc(field.x, field.y, field.radius, 0, Math.PI * 2); context.stroke();
      context.setLineDash([]); context.lineDashOffset = 0;
    }
  }

  /**
   * Organic creep, drawn from the `creep_patch` rows rather than from units: a
   * patch outlives the hub that grew it. Owner-tinted and faint, under
   * everything but terrain. A patch whose source is gone gets a dashed,
   * pulsing edge and a countdown to the tick it is removed -- the window an
   * opponent has to act on it, or its owner to rebuild -- so the recession is
   * read, not discovered.
   */
  private drawCreep(now: number): void {
    const { creep } = this.session.snapshot;
    if (!creep.length) return;
    const context = this.context;
    for (const patch of creep) {
      const color = COLORS[patch.owner] ?? "#9fb39f";
      context.fillStyle = `${color}16`;
      context.beginPath(); context.arc(patch.x, patch.y, patch.radius, 0, Math.PI * 2); context.fill();
      // A second, smaller wash gives the disc a denser core, so it reads as
      // growth outward from the hub rather than as a flat range circle.
      context.fillStyle = `${color}0e`;
      context.beginPath(); context.arc(patch.x, patch.y, patch.radius * 0.6, 0, Math.PI * 2); context.fill();
    }
    for (const patch of creep) {
      const color = COLORS[patch.owner] ?? "#9fb39f";
      const lost = patch.lostTick !== 0n;
      context.lineWidth = (lost ? 2.5 : 1.5) / this.camera.zoom;
      if (lost) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 180);
        context.strokeStyle = color; context.globalAlpha = 0.45 + 0.45 * pulse;
        context.setLineDash([10 / this.camera.zoom, 8 / this.camera.zoom]);
        context.lineDashOffset = -now / 60 / this.camera.zoom;
      } else {
        context.strokeStyle = `${color}40`;
      }
      context.beginPath(); context.arc(patch.x, patch.y, patch.radius, 0, Math.PI * 2); context.stroke();
      context.setLineDash([]); context.lineDashOffset = 0; context.globalAlpha = 1;
    }
  }

  /** The recession countdowns, drawn after units so a building never covers one. */
  private drawCreepCountdowns(now: number): void {
    const { creep, room } = this.session.snapshot;
    const context = this.context;
    const tick = room?.tick ?? 0n;
    const since = now - this.session.tickReceivedAt;
    for (const patch of creep) {
      const gone = creepGoneTick(patch, tick);
      if (gone !== undefined) {
        const color = COLORS[patch.owner] ?? "#9fb39f";
        const seconds = countdown(gone, tick, since);
        context.font = `${12 / this.camera.zoom}px 'IBM Plex Mono'`; context.textAlign = "center";
        context.fillStyle = "#101c19b0";
        const label = `CREEP GONE IN ${seconds.toFixed(1)}s`;
        const width = context.measureText(label).width + 10 / this.camera.zoom;
        const y = patch.y - patch.radius - 8 / this.camera.zoom;
        context.fillRect(patch.x - width / 2, y - 13 / this.camera.zoom, width, 17 / this.camera.zoom);
        context.fillStyle = color; context.fillText(label, patch.x, y);
      }
    }
  }

  /**
   * An order you gave that has not executed yet: faint lines from the units
   * that will carry it out, and a ring at the aim that fills as the delay
   * elapses (`progress` 0 to 1). At most 40 lines, so a whole army's order
   * stays a hint rather than a hatching.
   */
  private intent(unitIds: readonly number[], kind: string, target: Point, progress: number, now: number): void {
    const context = this.context;
    const color = orderColor(kind);
    const zoom = this.camera.zoom;
    const ids = new Set(unitIds.slice(0, 40));
    context.strokeStyle = `${color}55`; context.lineWidth = 1.25 / zoom;
    context.beginPath();
    for (const unit of this.session.snapshot.units) {
      if (!ids.has(unit.id) || isBuilding(unit.kind)) continue;
      const from = this.position(unit, now);
      context.moveTo(from.x, from.y); context.lineTo(target.x, target.y);
    }
    context.stroke();
    const radius = 11 / zoom;
    context.lineWidth = 2 / zoom;
    context.strokeStyle = `${color}40`;
    context.beginPath(); context.arc(target.x, target.y, radius, 0, Math.PI * 2); context.stroke();
    context.strokeStyle = color;
    context.beginPath(); context.arc(target.x, target.y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(progress, 0.02, 1)); context.stroke();
  }

  /** Click pings: two rings and four ticks closing on the spot, fading out. */
  private drawPings(now: number): void {
    const context = this.context;
    const zoom = this.camera.zoom;
    this.pings = this.pings.filter(ping => now - ping.at < PING_MS);
    for (const [key, flash] of this.flashes) if (now - flash.at > FLASH_MS) this.flashes.delete(key);
    for (const ping of this.pings) {
      const age = (now - ping.at) / PING_MS;
      const radius = (7 + 20 * (1 - age) ** 2) / zoom;
      context.globalAlpha = 1 - age * age;
      context.strokeStyle = ping.color; context.lineWidth = 2.5 / zoom;
      context.beginPath(); context.arc(ping.x, ping.y, radius, 0, Math.PI * 2); context.stroke();
      context.lineWidth = 1.5 / zoom;
      context.beginPath(); context.arc(ping.x, ping.y, radius * 0.45, 0, Math.PI * 2); context.stroke();
      context.lineWidth = 2.5 / zoom;
      context.beginPath();
      for (let index = 0; index < 4; index++) {
        const angle = Math.PI / 4 + index * Math.PI / 2;
        context.moveTo(ping.x + Math.cos(angle) * (radius + 9 / zoom), ping.y + Math.sin(angle) * (radius + 9 / zoom));
        context.lineTo(ping.x + Math.cos(angle) * (radius + 2 / zoom), ping.y + Math.sin(angle) * (radius + 2 / zoom));
      }
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  /** A unit that just vanished: a ring in its owner's colour and debris flying out. */
  private drawDeaths(now: number): void {
    const context = this.context;
    this.deaths = this.deaths.filter(death => now - death.at < DEATH_MS);
    for (const death of this.deaths) {
      const age = (now - death.at) / DEATH_MS;
      const reach = death.radius * (death.building ? 1.6 : 1.3);
      context.globalAlpha = (1 - age) * 0.9;
      context.fillStyle = "#ffd98a";
      context.beginPath(); context.arc(death.x, death.y, reach * (0.5 + age) * (1 - age * 0.6), 0, Math.PI * 2); context.fill();
      context.strokeStyle = death.color; context.lineWidth = 2.5;
      context.beginPath(); context.arc(death.x, death.y, reach * (0.8 + age * 1.4), 0, Math.PI * 2); context.stroke();
      context.fillStyle = "#3a403a";
      const pieces = death.building ? 10 : 6;
      for (let index = 0; index < pieces; index++) {
        const angle = index / pieces * Math.PI * 2 + death.x % 1.7;
        const distance = reach * (0.4 + age * (1.6 + (index % 3) * 0.4));
        context.fillRect(death.x + Math.cos(angle) * distance - 2, death.y + Math.sin(angle) * distance - 2, 4, 4);
      }
    }
    context.globalAlpha = 1;
  }

  /**
   * While a building is being placed: the ground your buildings reach, and
   * the halos where a site is refused (around terrain, deposits, buildings
   * and nearby units), mirroring `placementError`. Placement near the HQ was
   * often refused with no way to see why before the click.
   */
  private drawPlacementZones(slot: number): void {
    const context = this.context;
    const { units, nodes } = this.session.snapshot;
    context.fillStyle = "#8fd8ff12";
    context.beginPath();
    for (const unit of units) {
      if (unit.owner !== slot || !isBuilding(unit.kind) || unit.constructionRemaining !== 0n) continue;
      context.moveTo(unit.x + 500, unit.y); context.arc(unit.x, unit.y, 500, 0, Math.PI * 2);
    }
    context.fill();
    context.fillStyle = "#ed7c8b1c";
    context.beginPath();
    for (const [left, top, width, height] of terrain) context.rect(left - 50, top - 50, width + 100, height + 100);
    for (const node of nodes) { context.moveTo(node.x + 75, node.y); context.arc(node.x, node.y, 75, 0, Math.PI * 2); }
    for (const unit of units) {
      const building = isBuilding(unit.kind);
      if (!building && (!this.pointer || Math.hypot(unit.x - this.pointer.x, unit.y - this.pointer.y) > 300)) continue;
      const reach = building ? 110 : 55;
      context.moveTo(unit.x + reach, unit.y); context.arc(unit.x, unit.y, reach, 0, Math.PI * 2);
    }
    context.fill();
  }

  private orderTarget(order: Order): Point | undefined {
    if (order.kind.startsWith("build_")) return order;
    if (["move", "attack_move", "rally_move", "teleport", "recall", "bloom"].includes(order.kind)) return order;
    if (["gather", "rally_gather"].includes(order.kind)) return this.session.snapshot.nodes.find(node => node.id === order.target);
    if (["attack", "repair"].includes(order.kind)) return this.session.snapshot.units.find(unit => unit.id === order.target);
    return undefined;
  }

  private marker(point: Point, color: string, label: string): void {
    const context = this.context;
    context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 2 / this.camera.zoom;
    context.beginPath(); context.arc(point.x, point.y, 18, 0, Math.PI * 2); context.stroke();
    context.beginPath(); context.moveTo(point.x - 7, point.y); context.lineTo(point.x + 7, point.y); context.moveTo(point.x, point.y - 7); context.lineTo(point.x, point.y + 7); context.stroke();
    context.font = `${12 / this.camera.zoom}px 'IBM Plex Mono'`; context.textAlign = "center"; context.fillText(label, point.x, point.y - 26);
  }

  /**
   * The load bar, for carriers only. A drifter never reaches this: it holds
   * nothing at any moment, so drawing it an empty bar would claim a cargo model
   * it does not have. The bar is scaled by that unit's own capacity, since a
   * harvester's full load is 10 and a worker's is 25.
   */
  private drawLoad(unit: Entity): void {
    if (!carriesCargo(unit.kind) || !unit.cargo) return;
    const context = this.context;
    // A load over the base capacity can only mean research_logistics is in.
    const capacity = cargoCapacity(unit.kind, unit.cargo > cargoCapacity(unit.kind, false));
    const width = unit.kind === "harvester" ? 10 : 14;
    // The load bar takes the colour of what is actually being carried, and a
    // catalyst load also gets a marker above it so the two are not told apart
    // by colour alone at this size.
    const catalyst = currencyOf(unit.cargoKind) === "catalyst";
    context.fillStyle = catalyst ? "#c79bff" : "#f3d570";
    context.fillRect(-width / 2, 11, width * Math.min(unit.cargo / capacity, 1), 4);
    if (catalyst) {
      context.beginPath(); context.moveTo(0, 6); context.lineTo(4, 10); context.lineTo(0, 14); context.lineTo(-4, 10); context.closePath();
      context.fillStyle = "#efe0ff"; context.fill();
    }
  }

  private drawUnit(unit: Entity, now: number): void {
    const context = this.context;
    const point = this.position(unit, now);
    const radius = VISUALS[unit.kind]?.radius ?? 12;
    const color = COLORS[unit.owner];
    context.save(); context.translate(point.x, point.y);
    if (unit.constructionRemaining > 0n) context.globalAlpha = 0.6;
    context.fillStyle = "#101c1980"; context.beginPath(); context.ellipse(3, radius * 0.6, radius * 1.2, radius * 0.55, 0, 0, Math.PI * 2); context.fill();
    const selected = this.selected.has(unit.id);
    const previewed = this.boxPreview?.has(unit.id) ?? false;
    const hovered = this.hovered === unit.id || previewed;
    const own = unit.owner === this.session.snapshot.me?.slot;
    // SC2's selection: an ellipse at the unit's feet, green for yours and red
    // for anyone else's. A hover, or a box still being dragged, shows it faint.
    if (selected || hovered) {
      const building = isBuilding(unit.kind);
      context.strokeStyle = own ? selected ? OWN_RING : `${OWN_RING}80` : selected ? ENEMY_RING : `${ENEMY_RING}80`;
      context.lineWidth = (selected ? 2 : 1.5) / this.camera.zoom;
      context.beginPath();
      if (building) context.ellipse(0, 4, radius + 10, (radius + 10) * 0.8, 0, 0, Math.PI * 2);
      else context.ellipse(0, radius * 0.45, radius + 5, (radius + 5) * 0.6, 0, 0, Math.PI * 2);
      context.stroke();
    }
    context.fillStyle = color; context.strokeStyle = "#172a26"; context.lineWidth = 2.5;
    if (unit.kind === "hq") {
      context.fillStyle = "#162a29"; context.fillRect(-36, -30, 72, 60);
      context.fillStyle = color; context.fillRect(-32, -28, 64, 8); context.fillRect(-32, 20, 64, 8);
      context.fillStyle = "#647970"; context.fillRect(-24, -18, 48, 36);
      context.fillStyle = "#b9cec1"; context.beginPath(); context.moveTo(0, -32); context.lineTo(26, -12); context.lineTo(26, 11); context.lineTo(0, 23); context.lineTo(-26, 11); context.lineTo(-26, -12); context.closePath(); context.fill(); context.stroke();
      context.fillStyle = color; context.fillRect(-10, -9, 20, 20);
      context.strokeStyle = "#d7eee1"; context.beginPath(); context.moveTo(0, -32); context.lineTo(0, -49); context.stroke();
    } else if (isBuilding(unit.kind)) {
      context.fillStyle = "#243832"; context.fillRect(-34, -29, 68, 58);
      context.fillStyle = "#91a49b"; context.fillRect(-29, -24, 58, 43);
      context.fillStyle = color; context.fillRect(-29, 20, 58, 7);
      context.strokeStyle = "#243832"; context.lineWidth = 4;
      if (unit.kind === "turret") {
        context.fillStyle = color; context.beginPath(); context.arc(0, 0, 19, 0, Math.PI * 2); context.fill(); context.stroke();
        context.rotate(Math.atan2(unit.shotY - unit.y, unit.shotX - unit.x));
        context.fillStyle = "#d7e2d4"; context.fillRect(0, -6, 38, 12); context.strokeRect(0, -6, 38, 12);
        context.rotate(-Math.atan2(unit.shotY - unit.y, unit.shotX - unit.x));
      } else if (unit.kind === "lab") {
        context.fillStyle = "#b5e4e5"; context.beginPath(); context.arc(0, -2, 21, Math.PI, 0); context.fill(); context.stroke();
        context.fillStyle = "#294547"; context.fillRect(-21, -2, 42, 13);
      } else if (unit.kind === "factory") {
        context.fillStyle = "#364747"; context.fillRect(-20, -18, 38, 30);
        context.fillStyle = "#d4b967"; context.fillRect(-15, 0, 28, 6);
        context.fillStyle = "#e0e6d5"; context.fillRect(18, -40, 10, 31);
      } else if (unit.kind === "relay") {
        // Network: a crystal pylon over a ring, the shape that says "power".
        context.fillStyle = "#1d3035"; context.beginPath(); context.arc(0, 4, 20, 0, Math.PI * 2); context.fill();
        context.strokeStyle = color; context.lineWidth = 2; context.stroke();
        context.fillStyle = "#bfe9ff"; context.strokeStyle = "#243832"; context.lineWidth = 2;
        context.beginPath(); context.moveTo(0, -30); context.lineTo(10, -2); context.lineTo(0, 14); context.lineTo(-10, -2); context.closePath(); context.fill(); context.stroke();
        context.fillStyle = color; context.fillRect(-3, -12, 6, 12);
      } else if (unit.kind === "sensor") {
        // Industrial: a dish on a lattice mast.
        context.strokeStyle = "#d7e2d4"; context.lineWidth = 3;
        context.beginPath(); context.moveTo(-10, 16); context.lineTo(0, -8); context.lineTo(10, 16); context.stroke();
        context.fillStyle = color; context.strokeStyle = "#243832"; context.lineWidth = 2;
        context.beginPath(); context.ellipse(0, -14, 16, 8, -0.4, 0, Math.PI * 2); context.fill(); context.stroke();
      } else if (unit.kind === "outpost") {
        context.fillStyle = "#dac16b"; context.fillRect(-18, -13, 15, 22); context.fillRect(3, -13, 15, 22);
        context.strokeRect(-18, -13, 36, 22);
      } else {
        context.fillStyle = "#334941"; context.fillRect(-20, -14, 14, 25); context.fillRect(6, -14, 14, 25);
        context.fillStyle = color; context.fillRect(-17, -10, 8, 8); context.fillRect(9, -10, 8, 8);
      }
    } else if (unit.kind === "worker") {
      // Industrial: a squat hauler with a load bar. The only labour unit that
      // both fills up and walks the load home.
      context.beginPath(); context.moveTo(0, -12); context.lineTo(11, 5); context.lineTo(5, 11); context.lineTo(-9, 8); context.lineTo(-11, -3); context.closePath(); context.fill(); context.stroke();
      context.fillStyle = "#e7eddf"; context.fillRect(-4, -4, 8, 6);
      this.drawLoad(unit);
    } else if (unit.kind === "drifter") {
      // Network: a hollow relay ring on a mast, parked at a deposit for the
      // whole match. Open where the worker is solid, and taller than wide, so
      // the two read apart at a glance and never by colour alone. It has no
      // load bar at all, because it never holds a load.
      context.lineWidth = 3;
      context.beginPath(); context.moveTo(0, -16); context.lineTo(0, 10); context.strokeStyle = "#cdd9cb"; context.stroke();
      context.strokeStyle = color;
      context.beginPath(); context.arc(0, -3, 9, 0, Math.PI * 2); context.stroke();
      context.beginPath(); context.arc(0, -3, 4.5, 0, Math.PI * 2); context.fillStyle = color; context.fill();
      context.strokeStyle = "#172a26"; context.lineWidth = 2;
      context.beginPath(); context.moveTo(-8, 11); context.lineTo(8, 11); context.stroke();
      // Crediting in place: a rising tick above the ring while it works a
      // deposit, which is what a drifter does instead of a return trip.
      if (unit.order.kind === "gather") {
        const phase = (Number(this.session.snapshot.room?.tick ?? 0n) % 20) / 20;
        context.globalAlpha *= 1 - phase;
        // Coloured by the deposit it is working, not by `cargoKind`: a drifter
        // never carries, so its cargo kind stays at the default forever and
        // would have painted a catalyst drifter gold.
        const worked = this.session.snapshot.nodes.find(node => node.id === unit.order.target);
        context.fillStyle = worked && currencyOf(worked.kind) === "catalyst" ? "#c79bff" : "#f3d570";
        context.fillRect(-2, -20 - phase * 8, 4, 5);
        context.globalAlpha = unit.constructionRemaining > 0n ? 0.6 : 1;
      }
    } else if (unit.kind === "harvester") {
      // Organic: smaller and flimsier than either, a soft teardrop with a thin
      // outline and a short load bar — it carries 10 where a worker carries 25.
      context.lineWidth = 1.5;
      context.beginPath(); context.moveTo(0, -11); context.bezierCurveTo(7, -6, 8, 5, 0, 9); context.bezierCurveTo(-8, 5, -7, -6, 0, -11); context.closePath();
      context.fill(); context.stroke();
      context.fillStyle = "#dff0d2"; context.beginPath(); context.ellipse(0, -1, 2.5, 4, 0, 0, Math.PI * 2); context.fill();
      this.drawLoad(unit);
    } else if (unit.kind === "brood") {
      // Temporary: a small many-legged mite. Round and leggy where every
      // trained unit is angular, so it never reads as a soldier.
      context.strokeStyle = color; context.lineWidth = 1.5;
      for (const side of [-1, 1]) for (const offset of [-4, 0, 4]) {
        context.beginPath(); context.moveTo(side * 4, offset * 0.8); context.lineTo(side * 9, offset * 1.5 - 1); context.stroke();
      }
      context.fillStyle = "#2a1f33"; context.strokeStyle = color; context.lineWidth = 2;
      context.beginPath(); context.ellipse(0, 0, 5, 6.5, 0, 0, Math.PI * 2); context.fill(); context.stroke();
      context.fillStyle = color; context.beginPath(); context.arc(0, -5, 2.5, 0, Math.PI * 2); context.fill();
    } else if (unit.kind === "brute") {
      // Temporary: a hunched carapace with two mandibles. Dark-bodied and
      // owner-edged like the brood, so the pair read as one family.
      context.fillStyle = "#2a1f33"; context.strokeStyle = color; context.lineWidth = 2.5;
      context.beginPath(); context.moveTo(-11, 7); context.bezierCurveTo(-13, -6, -6, -12, 0, -12); context.bezierCurveTo(6, -12, 13, -6, 11, 7); context.closePath(); context.fill(); context.stroke();
      context.strokeStyle = "#e6d9f2"; context.lineWidth = 2;
      context.beginPath(); context.moveTo(-5, -11); context.lineTo(-8, -18); context.moveTo(5, -11); context.lineTo(8, -18); context.stroke();
      context.strokeStyle = color; context.lineWidth = 1.5;
      for (const offset of [-5, 0, 5]) { context.beginPath(); context.moveTo(offset - 3, -5); context.lineTo(offset + 3, -5); context.stroke(); }
    } else if (unit.kind === "sentinel") {
      // Network fighter: a tall kite with a pale core, the angular family of
      // the soldier but narrower and taller, so "fewer, stronger" reads.
      context.beginPath(); context.moveTo(0, -17); context.lineTo(11, -2); context.lineTo(6, 13); context.lineTo(-6, 13); context.lineTo(-11, -2); context.closePath(); context.fill(); context.stroke();
      context.fillStyle = "#cfefff"; context.beginPath(); context.moveTo(0, -9); context.lineTo(4, -1); context.lineTo(0, 6); context.lineTo(-4, -1); context.closePath(); context.fill();
    } else if (unit.kind === "skimmer") {
      // Network raider: a flat swept wing.
      context.beginPath(); context.moveTo(0, -8); context.lineTo(14, 8); context.lineTo(0, 3); context.lineTo(-14, 8); context.closePath(); context.fill(); context.stroke();
      context.fillStyle = "#cfefff"; context.fillRect(-2, -4, 4, 6);
    } else if (unit.kind === "lancer") {
      // Network artillery: a ring on a long lance.
      context.fillStyle = "#132622"; context.beginPath(); context.arc(0, 4, 12, 0, Math.PI * 2); context.fill();
      context.strokeStyle = color; context.lineWidth = 3; context.stroke();
      context.fillStyle = "#cfefff"; context.strokeStyle = "#172a26"; context.lineWidth = 2;
      context.fillRect(-3, -26, 6, 28); context.strokeRect(-3, -26, 6, 28);
    } else if (unit.kind === "swarmer") {
      // Organic fighter: a low hooked crescent, smaller than any trained unit.
      context.beginPath(); context.moveTo(-9, 5); context.quadraticCurveTo(0, -16, 9, 5); context.quadraticCurveTo(0, -3, -9, 5); context.closePath(); context.fill(); context.stroke();
      context.fillStyle = "#e6d9f2"; context.beginPath(); context.arc(0, -4, 2, 0, Math.PI * 2); context.fill();
    } else if (unit.kind === "spitter") {
      // Organic support: a bulb with a raised spout.
      context.beginPath(); context.ellipse(0, 3, 9, 8, 0, 0, Math.PI * 2); context.fill(); context.stroke();
      context.fillStyle = "#e6d9f2"; context.strokeStyle = "#172a26"; context.lineWidth = 2;
      context.beginPath(); context.moveTo(-3, -3); context.lineTo(0, -16); context.lineTo(3, -3); context.closePath(); context.fill(); context.stroke();
    } else if (unit.kind === "crusher") {
      // Organic heavy: a broad plated shell with two tusks.
      context.beginPath(); context.moveTo(-17, 9); context.bezierCurveTo(-19, -9, -8, -16, 0, -16); context.bezierCurveTo(8, -16, 19, -9, 17, 9); context.closePath(); context.fill(); context.stroke();
      context.strokeStyle = "#e6d9f2"; context.lineWidth = 3;
      context.beginPath(); context.moveTo(-7, -14); context.lineTo(-11, -23); context.moveTo(7, -14); context.lineTo(11, -23); context.stroke();
      context.strokeStyle = "#172a26"; context.lineWidth = 2;
      for (const offset of [-7, 0, 7]) { context.beginPath(); context.moveTo(offset, -10); context.lineTo(offset, 6); context.stroke(); }
    } else if (unit.kind === "scout") {
      context.beginPath(); context.moveTo(0, -18); context.lineTo(10, 12); context.lineTo(0, 6); context.lineTo(-10, 12); context.closePath(); context.fill(); context.stroke();
      context.fillStyle = "#e9eee0"; context.fillRect(-3, -6, 6, 9);
    } else if (unit.kind === "siege") {
      context.fillStyle = "#132622"; context.fillRect(-20, -16, 10, 32); context.fillRect(10, -16, 10, 32);
      context.fillStyle = color; context.fillRect(-13, -13, 26, 27); context.strokeRect(-13, -13, 26, 27);
      context.fillStyle = "#e9e2bf"; context.fillRect(-5, -24, 10, 28); context.strokeRect(-5, -24, 10, 28);
    } else {
      context.beginPath(); context.moveTo(0, -14); context.lineTo(12, -5); context.lineTo(9, 11); context.lineTo(-9, 11); context.lineTo(-12, -5); context.closePath(); context.fill(); context.stroke();
      context.fillStyle = "#e8ece1"; context.fillRect(-5, -6, 10, 5); context.fillStyle = "#172a26"; context.fillRect(7, -13, 5, 15);
    }
    // A hit: the body flashes pale for a moment, so who is taking fire reads
    // in a crowd before any bar moves.
    const hurt = this.hurtAt.get(unit.id);
    if (hurt !== undefined && now - hurt < HIT_MS) {
      const alpha = context.globalAlpha;
      context.globalAlpha = alpha * 0.55 * (1 - (now - hurt) / HIT_MS);
      context.fillStyle = "#fff4e0";
      context.beginPath(); context.arc(0, 0, radius * 0.9, 0, Math.PI * 2); context.fill();
      context.globalAlpha = alpha;
    }
    // Named as the target of an order you just gave: it blinks in that order's colour.
    const flash = this.flashes.get(unit.id);
    if (flash && now - flash.at < FLASH_MS && Math.floor((now - flash.at) / 110) % 2 === 0) {
      context.strokeStyle = flash.color; context.lineWidth = 2.5 / this.camera.zoom;
      context.beginPath(); context.arc(0, 0, radius + 9, 0, Math.PI * 2); context.stroke();
    }
    const tick = this.session.snapshot.room?.tick ?? 0n;
    const health = unit.hp / Math.max(1, unit.maxHp);
    // Bars only where they say something, as in SC2: hurt, selected, hovered
    // or still being raised. A full-health army of 60 drawing 60 full bars is
    // clutter that hides the one bar that matters.
    const bars = selected || hovered || unit.hp < unit.maxHp || unit.shields < unit.maxShields || unit.constructionRemaining > 0n;
    if (bars) {
      context.fillStyle = "#12201f"; context.fillRect(-radius, -radius - 15, radius * 2, 4);
      context.fillStyle = health > 0.3 ? color : "#ff8178";
      context.fillRect(-radius, -radius - 15, radius * 2 * clamp(health, 0, 1), 4);
    }
    // Shields: a second, pale-blue bar directly above health, for Network only.
    // It brightens while regenerating so "coming back" reads without numbers.
    if (bars && unit.maxShields > 0) {
      const regenerating = shieldsRegenerating(unit, tick);
      context.fillStyle = "#12201f"; context.fillRect(-radius, -radius - 20, radius * 2, 4);
      context.fillStyle = regenerating ? "#c8f0ff" : "#6fc3ef";
      context.fillRect(-radius, -radius - 20, radius * 2 * clamp(unit.shields / unit.maxShields, 0, 1), 4);
    }
    // Teleport: a ring closing in while channelling, a faded ring while arriving.
    const channel = channelFraction(unit, tick);
    if (channel !== undefined) {
      context.strokeStyle = "#8fd8ff"; context.lineWidth = 2;
      context.beginPath(); context.arc(0, 0, radius + 14 - channel * 10, 0, Math.PI * 2 * Math.max(0.05, channel)); context.stroke();
    } else if (arriving(unit, tick)) {
      context.strokeStyle = "#8fd8ff"; context.lineWidth = 1.5; context.globalAlpha = 0.4 + 0.3 * Math.sin(now / 90);
      context.setLineDash([3, 3]); context.beginPath(); context.arc(0, 0, radius + 6, 0, Math.PI * 2); context.stroke(); context.setLineDash([]);
      context.globalAlpha = 1;
    }
    // Energy: a violet bar where a temporary unit's lifetime would go, on the
    // hubs of a faction with an ability. Hubs are never temporary.
    const energyCap = maxEnergy(unit.kind, this.factionAt(unit.owner));
    if (energyCap > 0 && unit.constructionRemaining === 0n) {
      context.fillStyle = "#12201f"; context.fillRect(-radius, -radius - 10, radius * 2, 3);
      context.fillStyle = "#b98cff"; context.fillRect(-radius, -radius - 10, radius * 2 * clamp(unit.energy / energyCap, 0, 1), 3);
    }
    // A temporary unit also shows how long it has left, in its own colour,
    // directly under its health: it expires whether or not it is hurt.
    const life = isTemporary(unit.kind) ? lifetimeFraction(unit, this.session.snapshot.room?.tick ?? 0n) : undefined;
    if (life !== undefined) {
      context.fillStyle = "#12201f"; context.fillRect(-radius, -radius - 10, radius * 2, 3);
      context.fillStyle = "#c9b2ff"; context.fillRect(-radius, -radius - 10, radius * 2 * life, 3);
    }
    // One of your own harvesters off your creep moves at 0.6x. A small amber
    // double down-chevron beside it says so; never drawn for anyone else's.
    if (unit.owner === this.session.snapshot.me?.slot && offCreep(unit, this.session.snapshot.creep)) {
      context.strokeStyle = "#f0b85a"; context.lineWidth = 1.5;
      context.beginPath(); context.moveTo(radius + 2, -3); context.lineTo(radius + 5, 1); context.lineTo(radius + 8, -3);
      context.moveTo(radius + 2, 1); context.lineTo(radius + 5, 5); context.lineTo(radius + 8, 1); context.stroke();
    }
    if (isBuilding(unit.kind)) {
      context.globalAlpha = 1; context.fillStyle = "#edf3dc"; context.font = "10px 'IBM Plex Mono'"; context.textAlign = "center";
      context.fillText(VISUALS[unit.kind].label, 0, radius + 17);
      if (unit.constructionRemaining > 0n) {
        context.fillStyle = "#ebce70"; context.fillRect(-32, radius + 22, 64 * (1 - Number(unit.constructionRemaining) / (VISUALS[unit.kind].seconds * 20)), 4);
      }
    }
    context.restore();
    if (unit.order.kind === "repair") {
      const target = this.orderTarget(unit.order);
      if (target && Math.hypot(target.x - unit.x, target.y - unit.y) <= 61) {
        context.strokeStyle = "#b9f29a"; context.lineWidth = 1.5;
        context.setLineDash([3, 4]); context.beginPath(); context.moveTo(point.x, point.y); context.lineTo(target.x, target.y); context.stroke(); context.setLineDash([]);
      }
    }
    if (unit.shotTick > 0n && tick - unit.shotTick < 3n && now - this.session.tickReceivedAt < 200) {
      context.strokeStyle = "#fff6b1"; context.lineWidth = 2;
      context.beginPath(); context.moveTo(point.x, point.y); context.lineTo(unit.shotX, unit.shotY); context.stroke();
    }
  }

  private drawMiniCreep(creep: CreepPatch[], scale: number): void {
    const context = this.miniContext;
    for (const patch of creep) {
      const color = COLORS[patch.owner] ?? "#9fb39f";
      context.fillStyle = `${color}${patch.lostTick === 0n ? "30" : "18"}`;
      context.beginPath(); context.arc(patch.x * scale, patch.y * scale, patch.radius * scale, 0, Math.PI * 2); context.fill();
      if (patch.lostTick !== 0n) {
        context.strokeStyle = color; context.lineWidth = 1; context.setLineDash([2, 2]);
        context.beginPath(); context.arc(patch.x * scale, patch.y * scale, patch.radius * scale, 0, Math.PI * 2); context.stroke();
        context.setLineDash([]);
      }
    }
  }

  private drawMinimap(): void {
    const context = this.miniContext;
    const size = this.minimap.width;
    context.clearRect(0, 0, size, size); context.drawImage(this.terrain, 0, 0, size, size);
    const scale = size / WORLD_SIZE;
    for (const field of this.fields()) {
      if (field.kind !== "power") continue;
      context.strokeStyle = `${COLORS[field.owner] ?? "#9fb39f"}a0`; context.lineWidth = 1; context.setLineDash([1, 2]);
      context.beginPath(); context.arc(field.x * scale, field.y * scale, field.radius * scale, 0, Math.PI * 2); context.stroke();
      context.setLineDash([]);
    }
    this.drawMiniCreep(this.session.snapshot.creep, scale);
    for (const node of this.session.snapshot.nodes) {
      if (!node.amount) continue;
      if (currencyOf(node.kind) === "catalyst") {
        // A larger rotated diamond, so catalyst is findable on the minimap by
        // shape and size even before its colour registers.
        context.save(); context.translate(node.x * scale, node.y * scale); context.rotate(Math.PI / 4);
        context.fillStyle = "#c79bff"; context.fillRect(-3, -3, 6, 6);
        context.strokeStyle = "#f0e4ff"; context.lineWidth = 1; context.strokeRect(-3, -3, 6, 6);
        context.restore();
      } else {
        context.fillStyle = "#ecd58a"; context.fillRect(node.x * scale - 2, node.y * scale - 2, 4, 4);
      }
    }
    for (const unit of this.session.snapshot.units) {
      context.fillStyle = COLORS[unit.owner];
      const radius = isBuilding(unit.kind) ? 4 : 2;
      context.fillRect(unit.x * scale - radius, unit.y * scale - radius, radius * 2, radius * 2);
    }
    // Attack pings: a red ring that shrinks onto the spot, three pulses.
    const now = performance.now();
    for (const alert of this.alerts) {
      const age = (now - alert.at) / 1000;
      const pulse = (age % 1.3) / 1.3;
      context.strokeStyle = `rgba(255, 110, 110, ${1 - age / 4})`; context.lineWidth = 2;
      context.beginPath(); context.arc(alert.x * scale, alert.y * scale, 4 + 14 * (1 - pulse), 0, Math.PI * 2); context.stroke();
    }
    context.strokeStyle = "#eff8ec"; context.lineWidth = 1;
    context.strokeRect((this.camera.x - this.width / this.camera.zoom / 2) * scale, (this.camera.y - this.height / this.camera.zoom / 2) * scale, this.width / this.camera.zoom * scale, this.height / this.camera.zoom * scale);
  }
}