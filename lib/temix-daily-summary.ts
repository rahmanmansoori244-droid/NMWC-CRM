/**
 * The daily Temix import, stage 2: the Data Steward's one daily summary
 * (NotificationKind TEMIX_DAILY_SUMMARY), written by finalize (stage 6).
 *
 * SWITCHED OFF: while lib/temix-daily-policy.ts TEMIX_DAILY_SUMMARY_ENABLED is
 * false this writes nothing and reads nothing (the two-step rollout of a new
 * notification kind; see that file). Stage 6's finalize calls it once per
 * loaded file (services/temix-daily-apply.ts), with the load day's counts
 * (lib/temix-daily-finalize.ts summaryCountsOf); switched off, the call
 * returns 0 before it touches the database. The same words are shown on the
 * day's drill-down page (/temix-daily/day/<day>), whether the switch is on or not.
 *
 * When on (the plan's finalize and alerts): ONE summary per active, non-test
 * Data Steward per Oman day, whatever number of files are loaded that day; a
 * second file the same day sends no second alert. Counts only, by kind: the
 * title and body never carry a customer's name, code, phone or any value from
 * a file, and the e-mail (if the Steward were ever an e-mailed role) carries
 * only the kind. It links to the daily file list (lib/notification-links.ts).
 * The per-Steward advisory lock and the "already today" read are the nightly
 * data check's pattern (lib/integrity/run.ts).
 */
import { NotificationKind, Role, type Prisma } from '@prisma/client';
import { notifyUsers } from './notifications';
import { omanDayStart } from './change-context';
import { TEMIX_DAILY_SUMMARY_ENABLED } from './temix-daily-policy';
import type { TemixChangeKind } from './temix-daily-tables';

type Tx = Prisma.TransactionClient;

/**
 * What a summary may count: ledger kinds (for a spell kind, the spells that
 * started), the spells that ended, and rows held back. Never a value.
 */
export type SummaryKey =
  | TemixChangeKind
  | 'MISSING_FROM_FILE_ENDED'
  | 'ACCOUNTANT_CODE_SEEN'
  | 'ROUTE_INACTIVE_ENDED'
  | 'HELD_ROWS';
export type SummaryCounts = Partial<Record<SummaryKey, number>>;

const LABEL: Record<SummaryKey, string> = {
  ROUTE_MOVE: 'shops moved to another route',
  TERMS_CHANGED: 'payment terms changed',
  CREDIT_LIMIT_CHANGED: 'credit limits changed',
  CREDIT_DAYS_CHANGED: 'credit days changed',
  CUSTOMER_CREATED: 'customers created',
  SHOP_CREATED: 'shops created',
  TEMIX_CODE_CONFIRMED: 'Temix codes confirmed',
  STATUS_DIFFERS: 'status differences',
  NAME_DIFFERS: 'name differences',
  ROUTE_NOT_MATCHED: 'route codes not matched',
  ROUTE_INACTIVE: 'switched-off routes still holding shops',
  ROUTE_INACTIVE_ENDED: 'switched-off routes no longer holding shops',
  SHOP_CODE_LOOKALIKE: 'look-alike shop codes',
  SHOP_NOT_LINKED: 'shops not linked',
  DUPLICATE_SUSPECT: 'possible duplicates',
  CODE_HELD_BY_OTHER: 'codes held by another customer',
  MISSING_FROM_FILE: 'customers newly missing from the file',
  MISSING_FROM_FILE_ENDED: 'customers no longer missing from the file',
  ACCOUNTANT_CODE_NOT_SEEN: "Accountant's Temix codes not in the file",
  ACCOUNTANT_CODE_SEEN: "Accountant's Temix codes now in the file",
  DAUGHTER_TERMS_IGNORED: 'shop credit figures ignored',
  HELD_ROWS: 'rows held back',
};

/** The same words for a count of one. */
const LABEL_ONE: Record<SummaryKey, string> = {
  ROUTE_MOVE: 'shop moved to another route',
  TERMS_CHANGED: 'payment terms changed',
  CREDIT_LIMIT_CHANGED: 'credit limit changed',
  CREDIT_DAYS_CHANGED: 'credit days changed',
  CUSTOMER_CREATED: 'customer created',
  SHOP_CREATED: 'shop created',
  TEMIX_CODE_CONFIRMED: 'Temix code confirmed',
  STATUS_DIFFERS: 'status difference',
  NAME_DIFFERS: 'name difference',
  ROUTE_NOT_MATCHED: 'route code not matched',
  ROUTE_INACTIVE: 'switched-off route still holding shops',
  ROUTE_INACTIVE_ENDED: 'switched-off route no longer holding shops',
  SHOP_CODE_LOOKALIKE: 'look-alike shop code',
  SHOP_NOT_LINKED: 'shop not linked',
  DUPLICATE_SUSPECT: 'possible duplicate',
  CODE_HELD_BY_OTHER: 'code held by another customer',
  MISSING_FROM_FILE: 'customer newly missing from the file',
  MISSING_FROM_FILE_ENDED: 'customer no longer missing from the file',
  ACCOUNTANT_CODE_NOT_SEEN: "Accountant's Temix code not in the file",
  ACCOUNTANT_CODE_SEEN: "Accountant's Temix code now in the file",
  DAUGHTER_TERMS_IGNORED: 'shop credit figure ignored',
  HELD_ROWS: 'row held back',
};

/**
 * The summary's words: counts by kind, in the ledger's order; nothing else.
 * Re-checked in stage 6 against what finalize really counts
 * (summaryCountsOf): a spell kind counts the spells that STARTED that day,
 * the *_ENDED keys those that ended; ROUTE_INACTIVE is a switched-off route
 * still holding shops (not a row). Kinds nothing writes yet (credit and terms,
 * created customers and shops, status) keep their words for the stages that
 * wait for the owner.
 */
export function summaryText(loadDay: string, counts: SummaryCounts): { title: string; body: string } {
  const parts = (Object.keys(LABEL) as Array<keyof typeof LABEL>)
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => {
      const n = counts[k] ?? 0;
      return `${n.toLocaleString('en-US')} ${n === 1 ? LABEL_ONE[k] : LABEL[k]}`;
    });
  return {
    title: `Temix daily file for ${loadDay}: loaded`,
    body: parts.length > 0 ? `${parts.join('; ')}. Open the Temix daily file page for the details.` : 'No changes. Open the Temix daily file page for the details.',
  };
}

/** The Stewards the summary goes to: active, not test accounts. */
export async function summaryAudience(tx: Tx): Promise<string[]> {
  const rows = await tx.user.findMany({ where: { role: Role.STEWARD, isActive: true, isTest: false }, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * Leave the day's summary for each Steward who has none yet today (Oman day
 * `today`, 'YYYY-MM-DD'). Returns how many were written: always 0 while the
 * switch is off.
 */
export async function notifyTemixDailySummary(
  tx: Tx,
  args: { today: string; loadDay: string; counts: SummaryCounts }
): Promise<number> {
  if (!TEMIX_DAILY_SUMMARY_ENABLED) return 0;
  const dayStart = omanDayStart(args.today);
  if (!dayStart) throw new Error(`temix daily summary: invalid day ${args.today}`);
  const { title, body } = summaryText(args.loadDay, args.counts);
  let n = 0;
  for (const userId of await summaryAudience(tx)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`nmwc:temix-daily-summary:${userId}`}, 42))`;
    const already = await tx.notification.findFirst({
      where: { userId, kind: NotificationKind.TEMIX_DAILY_SUMMARY, createdAt: { gte: dayStart } },
      select: { id: true },
    });
    if (already) continue;
    await notifyUsers(tx, [userId], { kind: NotificationKind.TEMIX_DAILY_SUMMARY, title, body });
    n += 1;
  }
  return n;
}
