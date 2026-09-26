/**
 * Every keyboard binding in one place, so the command card can print the key
 * on the button it presses and the two can never disagree. SC2-style where a
 * convention exists (A attack, S stop, H hold, Backspace base camera, F1 idle
 * worker, F2 army), C&C-style for training: the production row is Q W E R
 * whatever is selected, because train buttons need no building selected.
 */
export const UNIT_KEYS = {
  attackMove: "a",
  stop: "s",
  hold: "h",
  repair: "f",
  returnCargo: "g",
  teleport: "t",
  ability: "c",
  rally: "y",
} as const;

/** The production row: labour, then the faction's fighter, raider and heavy. */
export const TRAIN_KEYS = ["q", "w", "e", "r"] as const;
/** Pressed after B, in the order the build buttons are shown. */
export const BUILD_KEYS = ["q", "w", "e", "r", "t", "y", "u"] as const;
export const BUILD_MENU_KEY = "b";

/** Two presses of a control group key within this window centre the camera on it. */
export const DOUBLE_TAP_MS = 350;
/** Pointer this close to a battlefield edge scrolls the camera, in CSS pixels. */
export const EDGE_SCROLL_PX = 12;

/** Keys in a control-group chord: set with Ctrl or Alt (Chrome keeps Ctrl+1..9 for tabs), add with Shift. */
export type GroupAction = { kind: "set" | "add" | "recall"; group: string };

export function groupAction(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): GroupAction | undefined {
  // `code` rather than `key`: Shift+1 is "!" on most layouts.
  const match = /^Digit([0-9])$/.exec(event.code);
  if (!match) return undefined;
  const group = match[1];
  if (event.ctrlKey || event.altKey || event.metaKey) return { kind: "set", group };
  if (event.shiftKey) return { kind: "add", group };
  return { kind: "recall", group };
}

/**
 * The camera velocity from the pointer's distance to the battlefield's edges,
 * in screen directions (-1, 0 or 1 per axis), with the pointer given relative
 * to the battlefield. A pointer outside it (over the match bar or the command
 * deck), or one not seen yet, scrolls nothing.
 */
export function edgeDirection(pointer: { x: number; y: number } | undefined, width: number, height: number, margin = EDGE_SCROLL_PX): { x: number; y: number } {
  if (!pointer || pointer.x < 0 || pointer.y < 0 || pointer.x > width || pointer.y > height) return { x: 0, y: 0 };
  return {
    x: pointer.x <= margin ? -1 : pointer.x >= width - 1 - margin ? 1 : 0,
    y: pointer.y <= margin ? -1 : pointer.y >= height - 1 - margin ? 1 : 0,
  };
}

/** A key badge's label: letters upper-case, everything else as written. */
export function keyLabel(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}
