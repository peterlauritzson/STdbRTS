import type { Snapshot } from "./network";
import { CATALOG, isBuilding } from "./catalog";

export class Feedback {
  enabled = localStorage.getItem("stdbrts:sound") !== "off";
  private audio: AudioContext | undefined;
  private previous: Snapshot | undefined;
  private lastAlert = 0;

  constructor(private notice: (message: string) => void) {
    document.addEventListener("pointerdown", () => {
      if (this.enabled) {
        this.audio ??= new AudioContext();
        void this.audio.resume();
      }
    });
  }

  toggle(): void { this.enabled = !this.enabled; localStorage.setItem("stdbrts:sound", this.enabled ? "on" : "off"); }

  update(snapshot: Snapshot): void {
    const previous = this.previous;
    this.previous = snapshot;
    if (!snapshot.room || snapshot.room.id !== previous?.room?.id || !snapshot.me) return;
    if (snapshot.room.state === "finished" && previous.room.state !== "finished") {
      this.play(snapshot.room.winner === snapshot.me.slot ? [440, 660, 880] : [330, 220, 165]);
      return;
    }
    for (const unit of snapshot.units.filter(unit => unit.owner === snapshot.me!.slot)) {
      const old = previous.units.find(old => old.id === unit.id);
      if (old && old.constructionRemaining > 0n && unit.constructionRemaining === 0n) {
        this.notice(`${CATALOG[unit.kind].label} complete`); this.play([660, 880]);
      }
      if (old && unit.hp < old.hp && isBuilding(unit.kind) && performance.now() - this.lastAlert > 8000) {
        this.lastAlert = performance.now(); this.notice(`${CATALOG[unit.kind].label} under attack`); this.play([180, 110]);
      }
    }
  }

  private play(notes: number[]): void {
    const audio = this.audio;
    if (!this.enabled || !audio || audio.state !== "running") return;
    for (const [index, frequency] of notes.entries()) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const start = audio.currentTime + index * 0.13;
      oscillator.type = "triangle"; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.035, start + 0.01); gain.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
      oscillator.connect(gain); gain.connect(audio.destination);
      oscillator.start(start); oscillator.stop(start + 0.16);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
  }
}