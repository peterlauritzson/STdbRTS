import { CATALOG, costOf, CURRENCIES, NO_COST, addCost, spend, type Cost, type Currency } from "./catalog";

/**
 * Money that is already promised. An order is stamped one command delay ahead
 * and only charges when it executes, so for a second after a click the balance
 * on screen still includes it. Clicking train five times then queues five
 * orders against one balance and the later ones are refused when they run.
 * Subtracting what is committed locally makes the buttons, and the readouts,
 * tell the truth about what is left to spend.
 */

interface Spending { owner?: number; status?: string; order: { kind: string } }

/** What one order costs when it executes: a train, a build or a research. Anything else is free. */
export function orderCost(kind: string): Cost {
  if (kind.startsWith("train_")) return CATALOG[kind.slice(6)]?.cost ?? NO_COST;
  if (kind.startsWith("build_")) return CATALOG[kind.slice(6)]?.cost ?? NO_COST;
  if (kind.startsWith("research_") || kind.startsWith("tier_")) return costOf(kind);
  return NO_COST;
}

/**
 * The cost of this player's commands that are sent but not yet executed:
 * `scheduled` rows in the command table plus orders still on their way to the
 * server (`inflight`). An executed or rejected command has already charged, or
 * never will, and is not counted.
 */
export function pendingSpend(commands: readonly (Spending & { owner: number })[], inflight: Iterable<{ order: { kind: string } }>, owner: number): Cost {
  let total = NO_COST;
  for (const command of commands) if (command.owner === owner && command.status === "scheduled") total = addCost(total, orderCost(command.order.kind));
  for (const order of inflight) total = addCost(total, orderCost(order.order.kind));
  return total;
}

/** The balance still free to spend: never negative. */
export const availableAfter = (balance: Cost, pending: Cost): Cost => spend(balance, pending);

/** "(−150)" for a currency with something committed, or an empty string. */
export function pendingLabel(pending: Cost, currency: Currency): string {
  return pending[currency] > 0 ? `(−${pending[currency]})` : "";
}

/** The currency a server refusal is about, from its "Insufficient material: ..." text. */
export function refusedCurrency(reason: string): Currency | undefined {
  return CURRENCIES.find(currency => reason.includes(`Insufficient ${currency}`));
}
