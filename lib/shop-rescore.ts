/**
 * Code review 2026-11-10, finding 27: after an approved change (or a direct
 * write, or a reactivation) the customer's scores are brought back in line by
 * lib/rescore.ts — only the scores that changed, in raw SQL, with no shop's
 * "last edited" date moved — and a database rule that refuses a shop's save
 * names the shop.
 *
 * Before, services/edits.ts and services/reactivations.ts re-saved the score of
 * EVERY live shop of the customer through Prisma, changed or not. Each save
 * moved that shop's updatedAt, which the master export prints as
 * last_edited_at, so every sister shop read as edited that day. And because a
 * rule added NOT VALID is re-checked on every write of a row (lib/db-rules.ts),
 * one older shop that breaks a rule (a stored location outside Oman, say) made
 * the whole approval fail, for a change to another shop, with a refusal that
 * named no shop. The import was fixed for exactly this (lib/rescore.ts); these
 * paths now use the same plan and the same write.
 *
 * What is still written: a sister shop whose stored score is wrong anyway (the
 * rescore corrects it, and leaves its updatedAt alone), and the customer's score
 * when it moves. A rule can still refuse such a shop — the database checks the
 * row whatever column changes — and then the refusal says which shop
 * (shopRuleRefusal), so the Data Steward can correct that record
 * (docs/OPERATIONS.md 5l). Each branch score is its own statement for that
 * reason: there is rarely more than one, and a refused statement then names
 * its shop.
 *
 * The caller holds the customer's row lock (lib/locks.ts), as lib/rescore.ts
 * requires: services/edits.ts (approve and direct write) and
 * services/reactivations.ts both take it before they write.
 */
import type { Prisma } from '@prisma/client';
import { RESCORE_CUSTOMER_SELECT, planRescore, writeRescore, type RescorePlan } from './rescore';
import { dbRuleViolated } from './db-errors';
import { ConflictError } from './errors';

/** The words every Branch rule's refusal starts with (lib/db-rules.ts STORED_SHOP). */
const THIS_SHOP = 'This shop’s';
const THIS_SHOP_ASCII = "This shop's";

/**
 * A refused save of a shop, answered with the rule's words and the shop's code
 * ("Shop B-0042's stored record breaks a data rule (a location outside Oman).
 * Ask the Data Steward to correct it."), or null when the error is not a rule
 * about a shop's stored record — then the caller rethrows it and runAction
 * answers it as before.
 */
export function shopRuleRefusal(err: unknown, branchCode: string | null | undefined): ConflictError | null {
  const rule = dbRuleViolated(err);
  if (!rule || rule.table !== 'Branch' || !branchCode) return null;
  const prefix = rule.refusal.startsWith(THIS_SHOP)
    ? THIS_SHOP
    : rule.refusal.startsWith(THIS_SHOP_ASCII)
      ? THIS_SHOP_ASCII
      : null;
  if (!prefix) return null;
  return new ConflictError('DATA_RULE', `Shop ${branchCode}'s${rule.refusal.slice(prefix.length)}`);
}

/** Runs one write of a shop and names the shop if a rule refuses it. */
export async function namingShop<T>(branchCode: string | null | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    throw shopRuleRefusal(err, branchCode) ?? err;
  }
}

/** The rescore's read, with each shop's code for a refusal. */
const SELECT = {
  ...RESCORE_CUSTOMER_SELECT,
  branches: {
    ...RESCORE_CUSTOMER_SELECT.branches,
    select: { ...RESCORE_CUSTOMER_SELECT.branches.select, branchCode: true },
  },
} satisfies Prisma.CustomerSelect;

/**
 * Rescores one customer and its live shops after a change, inside the caller's
 * transaction (which holds the customer's row lock). Writes only the scores
 * that differ; moves no updatedAt and no version. Returns what it planned and
 * how many rows it wrote.
 */
export async function rescoreAfterChangeTx(
  tx: Prisma.TransactionClient,
  customerId: string
): Promise<{ plan: RescorePlan; written: { customers: number; branches: number } }> {
  const rows = await tx.customer.findMany({ where: { id: customerId }, select: SELECT });
  const plan = planRescore(rows);
  const codeOf = new Map(rows.flatMap((c) => c.branches.map((b) => [b.id, b.branchCode] as const)));
  let branches = 0;
  for (const move of plan.branches) {
    const w = await namingShop(codeOf.get(move.id), () => writeRescore(tx, { customers: [], branches: [move] }));
    branches += w.branches;
  }
  const { customers } = await writeRescore(tx, { customers: plan.customers, branches: [] });
  return { plan, written: { customers, branches } };
}
