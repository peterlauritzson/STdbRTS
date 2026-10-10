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
  // Behaviors (src/behaviors.ts): clear of every unit, train and build key.
  harass: "j",
  guard: "k",
  raid: "n",
  // Rush and Gather then strike: M is the last letter no unit, train or build key uses, so Gather takes the comma.
  rush: "m",
  gather: ",",
} as const;

/**
 * The production row: labour, then the faction's six army units in card order.
 * Q W E R then D Z X, clear of every unit command (A S H F G T Y C) and of B.
 */
export const TRAIN_KEYS = ["q", "w", "e", "r", "d", "z", "x"] as const;
/** Pressed after B, in the order the build buttons are shown. */
export const BUILD_KEYS = ["q", "w", "e", "r", "t", "y", "u", "i", "p"] as const;
export const BUILD_MENU_KEY = "b";
/**
 * Operations (src/operations.ts), both buttons of the Strategy panel and live from anywhere:
 * V arms Expand and O arms Territory (clear of every train and unit key; U/I are build keys, so O avoids them); L toggles Saturate workers.
 */
export const OPERATION_KEYS = { expand: "v", territory: "o", autoLabour: "l" } as const;

/** Two presses of a control group key within this window centre the camera on it. */
export const DOUBLE_TAP_MS = 350;
/** Pointer this close to an edge scrolls the camera, in CSS pixels. */
export const EDGE_SCROLL_PX = 12;
/** The window-edge band used in play: thin, so the deck's bottom row stays clear of it. */
export const EDGE_SCROLL_WINDOW_PX = 6;
/** How long the pointer must rest at an edge before the camera moves. */
export const EDGE_SCROLL_DWELL_MS = 150;

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
 * The camera velocity from the pointer's distance to the edges of an area
 * (the browser window, in play), in screen directions (-1, 0 or 1 per axis),
 * with the pointer given relative to that area. A pointer outside it, or one
 * not seen yet, scrolls nothing.
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
