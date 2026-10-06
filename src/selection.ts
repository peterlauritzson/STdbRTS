/**
 * Subgroups of a mixed selection, SC2's Tab: the selection stays whole, but
 * one kind in it is "active" and is what kind-specific commands (train here,
 * cast, set rally) are read from.
 */

/** The distinct kinds in a selection, in the order the selection grid lists them (alphabetical). */
export function subgroupKinds(units: readonly { kind: string }[]): string[] {
  return [...new Set(units.map(unit => unit.kind))].sort((left, right) => left.localeCompare(right));
}

/**
 * The kind after `current` when Tab is pressed (before it with Shift+Tab),
 * wrapping around. With no active kind yet, Tab starts at the first and
 * Shift+Tab at the last. A selection of one kind has nothing to cycle.
 */
export function cycleSubgroup(kinds: readonly string[], current: string | undefined, backwards = false): string | undefined {
  if (kinds.length < 2) return undefined;
  const index = current === undefined ? -1 : kinds.indexOf(current);
  if (index < 0) return backwards ? kinds[kinds.length - 1] : kinds[0];
  return kinds[(index + (backwards ? kinds.length - 1 : 1)) % kinds.length];
}

/** `current` if it is still in the selection, otherwise nothing: a subgroup does not outlive its units. */
export const validSubgroup = (kinds: readonly string[], current: string | undefined): string | undefined =>
  current !== undefined && kinds.includes(current) ? current : undefined;
