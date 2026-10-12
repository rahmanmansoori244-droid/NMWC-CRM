/**
 * Gap 24 (data audit 2026-10-10): the changes the dated history recorded with no
 * cause, and whether the history is still being written at all.
 *
 * Every write path names its cause (lib/change-context.ts); the database records a
 * write that did not as source 'sql' (prisma/migrations/20261013100100). Zero is
 * expected. Who wrote such a row tells what it was:
 *   - the runtime role (nmwc_app): an application path missing its change
 *     context — a bug, and a /api/health warning;
 *   - any other login (the owner): SQL typed by hand, or a script that does not
 *     name its run.
 *
 * Read by the Steward's card on /status and by the bearer /api/health probe, and
 * printed by scripts/ops/history-report.ts. Not a server action. Counts, tables,
 * days and history row ids only: no customer and no person is named.
 *
 * The client is passed in (the pooled one from the app, the owner's from the
 * script), so this module opens no connection of its own when imported.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { HISTORY_TRIGGERS } from './history-tables';

/** The least-privilege runtime role (scripts/ops/app-role.ts). */
export const RUNTIME_ROLE = 'nmwc_app';

/** The /status card's window. */
export const UNATTRIBUTED_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type UnattributedRow = {
  table: string;
  /** The Oman calendar day the rows were recorded, YYYY-MM-DD. */
  day: string;
  dbUser: string;
  n: number;
  /** Up to five history row ids, to look the rows up. */
  sampleIds: string[];
};

export type HistoryReport = {
  since: Date;
  rows: UnattributedRow[];
  /** Rows written by the runtime role: an application path missing its context. */
  fromApp: number;
  /** Rows written by any other login: hand-typed SQL or an unnamed script. */
  fromOther: number;
};

type Reader = Pick<PrismaClient, '$queryRaw'>;

/** Split and total the report's rows. Pure: tested without a database. */
export function summarize(since: Date, rows: UnattributedRow[]): HistoryReport {
  let fromApp = 0;
  let fromOther = 0;
  for (const r of rows) {
    if (r.dbUser === RUNTIME_ROLE) fromApp += r.n;
    else fromOther += r.n;
  }
  return { since, rows, fromApp, fromOther };
}

/** The rows recorded with no cause since `since` (nmwc_history_unattributed). */
export async function loadUnattributed(client: Reader, since: Date): Promise<UnattributedRow[]> {
  const raw = await client.$queryRaw<
    Array<{
      table_name: string;
      /** The Oman day as text: a date, never cut from an instant here. */
      day: string;
      db_user: string;
      n: bigint | number;
      sample_ids: Array<bigint | number> | null;
    }>
  >(
    Prisma.sql`SELECT table_name, day::text AS day, db_user, n, sample_ids FROM nmwc_history_unattributed(${utcTimestamp(since)}::timestamp)`
  );
  return raw.map((r) => ({
    table: r.table_name,
    day: r.day,
    dbUser: r.db_user,
    n: Number(r.n),
    sampleIds: (r.sample_ids ?? []).map((id) => String(id)),
  }));
}

/** The Steward's /status card: the last 30 days. Null when it could not be read. */
export async function loadHistoryReport(
  client: Reader,
  now: Date = new Date()
): Promise<HistoryReport | null> {
  const since = new Date(now.getTime() - UNATTRIBUTED_WINDOW_DAYS * DAY_MS);
  try {
    return summarize(since, await loadUnattributed(client, since));
  } catch {
    return null;
  }
}

/** What the bearer health probe says about the history. Pure. */
export function historyWarnings(input: {
  /** Rows the runtime role wrote with no cause in the last 24 hours. */
  appUnattributedLastDay: number;
  /** History triggers present but disabled. */
  disabledTriggers: string[];
  /** History triggers absent. */
  missingTriggers: string[];
}): string[] {
  const out: string[] = [];
  if (input.appUnattributedLastDay > 0) out.push('history:unattributed');
  if (input.disabledTriggers.length > 0) out.push('history:triggers-disabled');
  if (input.missingTriggers.length > 0) out.push('history:triggers-missing');
  return out;
}

/**
 * The /api/health warnings for the history. Warnings never page: an unattributed
 * write is a bug to fix, not an outage, and the history is still written. A
 * disabled or missing capture trigger means changes are going unrecorded.
 * One that cannot be read says so instead of passing quietly.
 */
export async function loadHistoryHealth(client: Reader, now: Date = new Date()): Promise<string[]> {
  try {
    const since = new Date(now.getTime() - DAY_MS);
    const [rows, triggers] = await Promise.all([
      loadUnattributed(client, since),
      client.$queryRaw<Array<{ tgname: string; tgenabled: string }>>(
        Prisma.sql`SELECT t.tgname, t.tgenabled::text AS tgenabled FROM pg_catalog.pg_trigger t
                    WHERE NOT t.tgisinternal AND t.tgname IN (${Prisma.join([...HISTORY_TRIGGERS])})`
      ),
    ]);
    const present = new Map(triggers.map((t) => [t.tgname, t.tgenabled]));
    return historyWarnings({
      appUnattributedLastDay: summarize(since, rows).fromApp,
      disabledTriggers: [...present].filter(([, e]) => e === 'D').map(([n]) => n),
      missingTriggers: HISTORY_TRIGGERS.filter((t) => !present.has(t)),
    });
  } catch {
    return ['history:unreadable'];
  }
}

/** A Date as the UTC wall-clock text the TIMESTAMP columns hold. */
function utcTimestamp(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
