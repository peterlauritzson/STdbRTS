import type { CreepPatch, Entity, Order } from "./bindings/types";
import { Session } from "./network";
import { clamp, clampToMap, COLORS, countdown, VISUALS, WORLD_SIZE } from "./presentation";
import { cargoCapacity, carriesCargo, currencyOf, fights, isArmy, isBuilding, isLabour, isTemporary, placementError, terrain } from "./catalog";
import { creepGoneTick, lifetimeFraction, offCreep } from "./creep";

interface Point { x: number; y: number }
interface Motion { from: Point; to: Point; at: number }
type InputMode = "select" | "order" | "pan";
type TargetMode = "attack_move" | "repair" | "rally" | `build_${string}`;

export class Battlefield {
  selected = new Set<number>();
  mode: InputMode = "select";
  targeting: TargetMode | undefined;
  private pointer: Point | undefined;
  onSelection: () => void = () => {};
  private context: CanvasRenderingContext2D;
  private miniContext: CanvasRenderingContext2D;
  private camera = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, zoom: 0.8 };
  private width = 1;
  private height = 1;
  private motions = new Map<number, Motion>();
  private roomId = 0n;
  private drag: { start: Point; end: Point; pan: boolean; pointer: number } | undefined;
  private keys = new Set<string>();
  private groups = new Map<string, Set<number>>();
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
      if (hit) { this.selected = new Set(this.session.snapshot.units.filter(unit => unit.owner === hit.owner && unit.kind === hit.kind).map(unit => unit.id)); this.onSelection(); }
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
    minimap.addEventListener("pointerdown", event => {
      const bounds = minimap.getBoundingClientRect();
      this.camera.x = (event.clientX - bounds.left) / bounds.width * WORLD_SIZE;
      this.camera.y = (event.clientY - bounds.top) / bounds.height * WORLD_SIZE;
      this.boundCamera();
    });
    window.addEventListener("keydown", event => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || !this.session.snapshot.room || this.session.snapshot.room.state === "lobby") return;
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
      this.keys.add(event.key);
      if (event.repeat) return;
      if (event.key.toLowerCase() === "h") this.home();
      if (event.key.toLowerCase() === "s") this.issue("stop");
      if (event.key.toLowerCase() === "a") this.arm("attack_move");
      if (event.key.toLowerCase() === "r") this.arm("repair");
      if (event.key.toLowerCase() === "d") this.issue("hold");
      if (event.key === ".") this.selectIdleWorker();
      if (event.key === "Escape") {
        if (this.targeting) this.targeting = undefined;
        else this.selected.clear();
        this.onSelection();
      }
      if (/^[1-5]$/.test(event.key)) {
        event.preventDefault();
        if (event.ctrlKey) this.groups.set(event.key, new Set(this.selected));
        else { this.selected = new Set(this.groups.get(event.key) ?? []); this.pruneSelection(); this.onSelection(); }
      }
    });
    window.addEventListener("keyup", event => this.keys.delete(event.key));
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
    }
    const initial = this.motions.size === 0 && units.length > 0;
    const now = performance.now();
    for (const unit of units) {
      const old = this.motions.get(unit.id);
      if (!old || old.to.x !== unit.x || old.to.y !== unit.y) {
        this.motions.set(unit.id, { from: old ? this.position(unit, now) : unit, to: { x: unit.x, y: unit.y }, at: now });
      }
    }
    for (const id of this.motions.keys()) if (!units.some(unit => unit.id === id)) this.motions.delete(id);
    this.pruneSelection();
    if (initial) this.home();
  }

  ownedSelection(): Entity[] {
    return this.session.snapshot.units.filter(unit => this.selected.has(unit.id) && unit.owner === this.session.snapshot.me?.slot);
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
    const hq = this.session.snapshot.units.find(unit => unit.owner === this.session.snapshot.me?.slot && unit.kind === "hq");
    if (hq) { this.camera.zoom = Math.max(this.camera.zoom, 0.8); this.camera.x = hq.x; this.camera.y = hq.y; this.boundCamera(); }
  }

  fit(): void {
    this.camera = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, zoom: Math.min(this.width, this.height) / WORLD_SIZE * 0.97 };
  }

  zoom(amount: number): void { this.camera.zoom = clamp(this.camera.zoom * amount, 0.18, 2.2); this.boundCamera(); }

  arm(kind: TargetMode): void {
    const allowed = kind === "rally"
      ? this.session.snapshot.units.some(unit => unit.kind === "hq" && unit.owner === this.session.snapshot.me?.slot)
      : kind.startsWith("build_") ? this.session.snapshot.units.some(unit => unit.owner === this.session.snapshot.me?.slot && isLabour(unit.kind))
      : this.ownedSelection().some(unit => kind === "repair" ? isLabour(unit.kind) : fights(unit.kind));
    if (!allowed) return;
    this.targeting = this.targeting === kind ? undefined : kind;
    this.onSelection();
  }

  issue(kind: "stop" | "return" | "hold"): void {
    this.targeting = undefined;
    // Only a carrier can be told to bring a load home; a drifter has no load.
    const units = this.ownedSelection().filter(unit => kind === "return" ? carriesCargo(unit.kind) : kind === "hold" ? fights(unit.kind) : !isBuilding(unit.kind));
    if (units.length) void this.session.order(units.map(unit => unit.id), { kind, x: 0, y: 0, target: 0 });
    this.onSelection();
  }

  private pruneSelection(): void {
    for (const id of this.selected) if (!this.session.snapshot.units.some(unit => unit.id === id)) this.selected.delete(id);
  }

  private position(unit: Entity, now: number): Point {
    const motion = this.motions.get(unit.id);
    if (!motion) return unit;
    const fraction = clamp((now - motion.at) / 50, 0, 1);
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

  private world(point: Point): Point {
    return { x: (point.x - this.width / 2) / this.camera.zoom + this.camera.x, y: (point.y - this.height / 2) / this.camera.zoom + this.camera.y };
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.session.matchReady) return;
    this.canvas.focus();
    const point = this.local(event);
    if (event.button === 2 || (event.button === 0 && (this.mode === "order" || this.targeting))) { this.contextOrder(this.world(point), event.shiftKey); return; }
    this.canvas.setPointerCapture(event.pointerId);
    this.drag = { start: point, end: point, pan: event.button === 1 || this.keys.has(" ") || this.mode === "pan", pointer: event.pointerId };
  }

  private pointerMove(event: PointerEvent): void {
    this.pointer = this.world(this.local(event));
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
    const units = this.session.snapshot.units;
    if (!event.shiftKey) this.selected.clear();
    if (Math.hypot(drag.start.x - drag.end.x, drag.start.y - drag.end.y) < 6) {
      const hit = [...units].reverse().find(unit => Math.hypot(unit.x - end.x, unit.y - end.y) <= (VISUALS[unit.kind]?.radius ?? 12) + 6 / this.camera.zoom);
      if (hit) {
        if (event.shiftKey && this.selected.has(hit.id)) this.selected.delete(hit.id);
        else this.selected.add(hit.id);
      }
    } else {
      for (const unit of units) {
        if (unit.owner === this.session.snapshot.me?.slot && !isBuilding(unit.kind) && unit.x >= Math.min(start.x, end.x) && unit.x <= Math.max(start.x, end.x) && unit.y >= Math.min(start.y, end.y) && unit.y <= Math.max(start.y, end.y)) this.selected.add(unit.id);
      }
    }
    this.onSelection();
  }

  private contextOrder(point: Point, queued: boolean): void {
    const { units, nodes, me } = this.session.snapshot;
    const node = nodes.find(node => node.amount > 0 && Math.hypot(point.x - node.x, point.y - node.y) < 35);
    const owned = this.ownedSelection();
    if (this.targeting?.startsWith("build_") && me) {
      const kind = this.targeting.slice(6);
      const error = placementError(kind, point.x, point.y, me.slot, units, nodes);
      if (error) { this.session.onNotice(error); return; }
      const worker = owned.find(unit => isLabour(unit.kind)) ?? units.filter(unit => unit.owner === me.slot && isLabour(unit.kind)).sort((left, right) => Number(left.order.kind === "construct") - Number(right.order.kind === "construct") || Math.hypot(left.x - point.x, left.y - point.y) - Math.hypot(right.x - point.x, right.y - point.y))[0];
      if (worker) {
        void this.session.order([worker.id], { kind: this.targeting, x: point.x, y: point.y, target: 0 });
        this.targeting = undefined; this.selected = new Set([worker.id]); this.onSelection();
      }
      return;
    }
    const headquarters = owned.find(unit => ["hq", "barracks", "factory", "lab"].includes(unit.kind)) ?? units.find(unit => unit.kind === "hq" && unit.owner === me?.slot);
    if (headquarters && (this.targeting === "rally" || (!this.targeting && owned.length === 1 && ["hq", "barracks", "factory"].includes(owned[0].kind)))) {
      void this.session.order([headquarters.id], { kind: node ? "rally_gather" : "rally_move", x: clampToMap(point.x), y: clampToMap(point.y), target: node?.id ?? 0 });
      this.targeting = undefined;
      this.onSelection();
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
      if (!friendly || friendly.hp >= VISUALS[friendly.kind].hp) { this.session.onNotice("Choose a damaged friendly unit or HQ"); return; }
      order.kind = friendly.constructionRemaining > 0n ? "construct" : "repair"; order.target = friendly.id; selected = selected.filter(unit => isLabour(unit.kind) && unit.id !== friendly.id);
    }
    else if (enemy) { order.kind = "attack"; order.target = enemy.id; selected = selected.filter(unit => fights(unit.kind)); }
    else if (friendly && friendly.constructionRemaining > 0n) { order.kind = "construct"; order.target = friendly.id; selected = selected.filter(unit => isLabour(unit.kind)); }
    else if (node) { order.kind = "gather"; order.target = node.id; selected = selected.filter(unit => isLabour(unit.kind)); }
    // Dropping a load at a hub is a carrier's order. A drifter told to return is
    // refused by name on the server, so it is never included here.
    else if (hq) { order.kind = "return"; selected = selected.filter(unit => carriesCargo(unit.kind)); }
    else if (friendly && friendly.hp < VISUALS[friendly.kind].hp) { order.kind = "repair"; order.target = friendly.id; selected = selected.filter(unit => isLabour(unit.kind) && unit.id !== friendly.id); }
    if (selected.length) {
      void this.session.order(selected.map(unit => unit.id), order, queued);
      this.targeting = undefined;
      this.onSelection();
    }
    else this.session.onNotice(enemy ? "Select fighting units to attack" : "Select labour units for this order");
  }

  private paintTerrain(): void {
    this.terrain.width = WORLD_SIZE;
    this.terrain.height = WORLD_SIZE;
    const context = this.terrain.getContext("2d")!;
    context.fillStyle = "#283c37";
    context.fillRect(0, 0, WORLD_SIZE, WORLD_SIZE);
    for (let row = 0; row < 40; row++) for (let column = 0; column < 40; column++) {
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
    for (const [x, y] of [[220, 220], [1380, 1380], [1380, 220], [220, 1380]]) {
      context.fillStyle = "#43524b"; context.fillRect(x - 65, y - 65, 130, 130);
      context.strokeStyle = "#87928366"; context.strokeRect(x - 75, y - 75, 150, 150);
      context.setLineDash([8, 8]); context.strokeRect(x - 94, y - 94, 188, 188); context.setLineDash([]);
    }
    context.strokeStyle = "#82968044";
    context.lineWidth = 2;
    const mid = WORLD_SIZE / 2;
    context.beginPath(); context.moveTo(mid, mid - 100); context.lineTo(mid + 100, mid); context.lineTo(mid, mid + 100); context.lineTo(mid - 100, mid); context.closePath(); context.stroke();
    context.font = "18px 'IBM Plex Mono'"; context.textAlign = "center"; context.fillStyle = "#a8b8a877";
    context.fillText("BASIN / 07", mid, mid + 7);
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
      this.boundCamera();
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
      // The kind is written out as well as drawn: colour is never the only cue.
      context.font = "11px 'IBM Plex Mono'"; context.textAlign = "center";
      context.fillStyle = currency === "catalyst" ? "#e0c9ff" : "#f3e8bd";
      context.fillText(`${node.amount} ${currency === "catalyst" ? "CAT" : "MAT"}`, 0, 42); context.restore();
    }
    for (const unit of units) {
      if (this.selected.has(unit.id) || (unit.kind === "hq" && unit.owner === this.session.snapshot.me?.slot)) {
        let point: Point = this.position(unit, now);
        for (const order of [unit.order, ...unit.queue]) {
          const target = this.orderTarget(order);
          if (!target) continue;
          context.strokeStyle = "#c4ddd17f"; context.lineWidth = 1.5 / this.camera.zoom; context.setLineDash([5, 5]);
          context.beginPath(); context.moveTo(point.x, point.y); context.lineTo(target.x, target.y); context.stroke(); context.setLineDash([]);
          if (order.kind.startsWith("rally_")) this.marker(target, COLORS[unit.owner], "RALLY");
          point = target;
        }
      }
    }
    for (const command of commands.filter(command => command.status === "scheduled")) {
      const target = this.orderTarget(command.order);
      if (target) this.marker(target, COLORS[command.owner], `${countdown(command.executeTick, room?.tick ?? 0n, now - this.session.tickReceivedAt).toFixed(1)}s`);
    }
    for (const pending of this.session.pending.values()) {
      const target = this.orderTarget(pending.order);
      if (target) this.marker(target, "#ffffff", "...");
    }
    for (const unit of [...units].sort((left, right) => left.y - right.y)) this.drawUnit(unit, now);
    this.drawCreepCountdowns(now);
    if (this.targeting?.startsWith("build_") && this.pointer && this.session.snapshot.me) {
      const kind = this.targeting.slice(6);
      const error = placementError(kind, this.pointer.x, this.pointer.y, this.session.snapshot.me.slot, units, nodes);
      context.fillStyle = error ? "#ed7c8b55" : "#66dfba55";
      context.strokeStyle = error ? "#ed7c8b" : "#66dfba"; context.lineWidth = 2;
      context.fillRect(this.pointer.x - 35, this.pointer.y - 35, 70, 70); context.strokeRect(this.pointer.x - 35, this.pointer.y - 35, 70, 70);
      if (kind === "turret") { context.beginPath(); context.arc(this.pointer.x, this.pointer.y, 210, 0, Math.PI * 2); context.stroke(); }
      context.fillStyle = "#efffea"; context.textAlign = "center"; context.font = "13px 'IBM Plex Mono'";
      context.fillText(error ?? VISUALS[kind].label, this.pointer.x, this.pointer.y - 48);
    }
    context.restore();
    if (this.drag && !this.drag.pan) {
      context.strokeStyle = "#b3f7dc"; context.fillStyle = "#9cedd321"; context.lineWidth = 1;
      const { start, end } = this.drag;
      context.fillRect(start.x, start.y, end.x - start.x, end.y - start.y); context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
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

  private orderTarget(order: Order): Point | undefined {
    if (order.kind.startsWith("build_")) return order;
    if (["move", "attack_move", "rally_move"].includes(order.kind)) return order;
    if (["gather", "rally_gather"].includes(order.kind)) return this.session.snapshot.nodes.find(node => node.id === order.target);
    if (["attack", "repair", "construct"].includes(order.kind)) return this.session.snapshot.units.find(unit => unit.id === order.target);
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
    if (this.selected.has(unit.id)) {
      context.strokeStyle = "#efffea"; context.lineWidth = 2 / this.camera.zoom;
      context.beginPath(); context.arc(0, 0, radius + 7, 0, Math.PI * 2); context.stroke();
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
    context.fillStyle = "#12201f"; context.fillRect(-radius, -radius - 15, radius * 2, 4);
    context.fillStyle = unit.hp / (VISUALS[unit.kind]?.hp ?? 1) > 0.3 ? color : "#ff8178";
    context.fillRect(-radius, -radius - 15, radius * 2 * clamp(unit.hp / (VISUALS[unit.kind]?.hp ?? 1), 0, 1), 4);
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
    const tick = this.session.snapshot.room?.tick ?? 0n;
    if (["repair", "construct"].includes(unit.order.kind)) {
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
    context.strokeStyle = "#eff8ec"; context.lineWidth = 1;
    context.strokeRect((this.camera.x - this.width / this.camera.zoom / 2) * scale, (this.camera.y - this.height / this.camera.zoom / 2) * scale, this.width / this.camera.zoom * scale, this.height / this.camera.zoom * scale);
  }
}