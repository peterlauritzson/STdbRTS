import type { ChatMessage } from "./bindings/types";
import { ownerColor } from "./presentation";

/** Longest line the server accepts (`lobby::CHAT_MAX_CHARS`). */
export const CHAT_MAX_CHARS = 200;
/** How long a new line stays on the battlefield while the chat is closed. */
export const CHAT_FADE_MS = 10_000;

/**
 * One room's chat, drawn into `root`. The lobby panel is always open; the match
 * panel is an overlay that SC2-style shows only new lines, briefly, until Enter
 * (or its button) opens it with the whole history and an input.
 *
 * Lines are only ever appended, never rebuilt per render: the snapshot is
 * redrawn every tick in a match, and the log must keep its scroll position.
 */
export class ChatPanel {
  readonly input: HTMLInputElement;
  private log: HTMLElement;
  private form: HTMLFormElement;
  private shown = new Map<bigint, HTMLElement>();
  private loaded = false;
  private fades = new Set<ReturnType<typeof setTimeout>>();

  constructor(private root: HTMLElement, private overlay: boolean, private send: (text: string) => Promise<boolean>) {
    root.classList.add("chat");
    root.classList.toggle("open", !overlay);
    this.log = document.createElement("div");
    this.log.className = "chat-log";
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-live", "polite");
    this.log.setAttribute("aria-label", "Room chat");
    this.form = document.createElement("form");
    this.form.className = "chat-form";
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.maxLength = CHAT_MAX_CHARS;
    this.input.autocomplete = "off";
    this.input.enterKeyHint = "send";
    this.input.placeholder = overlay ? "Say to all (Enter sends, Esc closes)" : "Say to the room";
    this.input.setAttribute("aria-label", "Chat message");
    this.form.append(this.input);
    root.append(this.log, this.form);
    this.form.addEventListener("submit", event => { event.preventDefault(); void this.submit(); });
    this.input.addEventListener("keydown", event => {
      if (event.key === "Escape" && this.overlay) { event.preventDefault(); event.stopPropagation(); this.close(); }
    });
  }

  get isOpen(): boolean { return this.root.classList.contains("open"); }

  open(): void {
    this.root.classList.add("open");
    this.log.scrollTop = this.log.scrollHeight;
    this.input.focus();
  }

  close(): void {
    if (!this.overlay || !this.isOpen) return;
    this.root.classList.remove("open");
    this.input.blur();
    this.onClose();
  }

  /** Where focus goes when the overlay closes: back to the battlefield. */
  onClose: () => void = () => {};

  toggle(): void { if (this.isOpen) this.close(); else this.open(); }

  /** Clear everything: a new room starts with an empty log. */
  reset(): void {
    this.shown.clear();
    this.log.replaceChildren();
    this.loaded = false;
    for (const fade of this.fades) clearTimeout(fade);
    this.fades.clear();
  }

  render(lines: readonly ChatMessage[], mySlot: number | undefined, ready: boolean): void {
    this.input.disabled = !ready;
    const live = new Set(lines.map(line => line.id));
    for (const [id, node] of this.shown) if (!live.has(id)) { node.remove(); this.shown.delete(id); }
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 24;
    let added = false;
    for (const line of lines) {
      if (this.shown.has(line.id)) continue;
      const node = document.createElement("p");
      node.className = "chat-line";
      const name = document.createElement("strong");
      name.textContent = `${line.name}:`;
      name.style.color = ownerColor(line.slot, mySlot);
      const body = document.createElement("span");
      body.textContent = ` ${line.text}`;
      node.append(name, body);
      node.title = new Date(Number(line.sentMicros / 1000n)).toLocaleTimeString();
      // History that was already there when the room loaded is not news: it
      // waits in the log for the overlay to open instead of flashing past.
      if (this.loaded) {
        node.classList.add("fresh");
        const fade = setTimeout(() => { node.classList.remove("fresh"); this.fades.delete(fade); }, CHAT_FADE_MS);
        this.fades.add(fade);
      }
      this.log.append(node);
      this.shown.set(line.id, node);
      added = true;
    }
    // `ready` includes the room's subscription, so the first ready render holds its history.
    if (ready) this.loaded = true;
    if (added && (atBottom || !this.isOpen)) this.log.scrollTop = this.log.scrollHeight;
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (!text) { this.close(); return; }
    this.input.value = "";
    if (await this.send(text)) this.close();
    else this.input.value = text;
  }
}
