/**
 * Gap 24 (data audit 2026-10-10): every database write says who made it and why.
 *
 * The dated history (prisma/migrations/20261013100100_history_foundation) is
 * written by the DATABASE, from triggers on Customer, Branch, User, Route,
 * Region and _ManagerRegions, so no code path can skip it. What a trigger cannot
 * know is the cause: which request, import row, script run or job made the
 * change, and for whom. The writer tells it, once per transaction, through three
 * transaction-local settings:
 *
 *   nmwc.actor           the signed-in person (a User id), or '' for a job
 *   nmwc.source          what caused it, built with `src.*` below
 *   nmwc.effective_from  when it takes effect, if not now (the daily Temix file
 *                        passes its load day); '' = the transaction's own time
 *
 * set_config(..., true) is SET LOCAL: the value dies with the transaction, so it
 * is safe behind Neon's transaction pooler and cannot leak to the next user of a
 * pooled connection. Setting it again inside the same transaction replaces it,
 * which is how one import transaction names each of its rows.
 *
 * A write made with no context is still recorded, under source 'sql', and shows
 * on /status (lib/history-report.ts): an application path missing its context
 * is a bug, and tests/unit/change-context-guard.test.ts fails on one.
 *
 * PURE: no next/* and no @/lib/db import, so operator scripts (which build their
 * own owner client) use the same builders and the same statement.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

export type EffectiveFrom = Date | string | null | undefined;

export type ChangeContext = {
  /** The signed-in person who caused the change; null for a scheduled job or an unattended script. */
  actorId: string | null;
  /** What caused it, built with `src.*` (must match SOURCE_RE). */
  source: string;
  /**
   * When the change takes effect, if not when it is recorded: an instant, or an
   * Oman calendar day 'YYYY-MM-DD' (its start, Asia/Muscat). Never in the future.
   * Left out, the history uses the transaction's own time.
   */
  effectiveFrom?: EffectiveFrom;
};

/**
 * `<kind>[:<part>]{0,4}`. The kind is what the 'sql' report and the history's
 * sourceKind column group by; the parts name the thing (an edit id, a batch and
 * a row, a run id). No spaces, no quotes: a source is an identifier, never text a
 * person typed.
 */
export const SOURCE_RE = /^[a-z][a-z0-9-]{1,30}(:[A-Za-z0-9._!@/-]{1,80}){0,4}$/;

/** The database keeps at most this much of a source (nmwc_change_ctx). */
export const SOURCE_MAX = 200;

/** A calendar day, read as the start of that day in Oman. */
export const EFFECTIVE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The database refuses an effective time further ahead than this (clock skew allowance). */
export const EFFECTIVE_FUTURE_SLACK_MS = 5 * 60 * 1000;

/** One part of a source: characters outside the allowed set become '-', cut to 80. */
function part(value: string | number): string {
  const s = String(value)
    .replace(/[^A-Za-z0-9._!@/-]/g, '-')
    .slice(0, 80);
  return s.length > 0 ? s : '-';
}

/** A kind: lower-case letters, digits and '-', starting with a letter. */
function kind(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 31);
  return /^[a-z]/.test(s) && s.length >= 2 ? s : `x-${s}`.slice(0, 31);
}

function join(k: string, ...parts: Array<string | number>): string {
  return [kind(k), ...parts.map(part)].join(':');
}

/** The lanes a customer-master import row is written by (services/imports.ts). */
export type ImportLane = 'full' | 'refresh' | 'fixed' | 'backup';

/**
 * Source builders. Every application write names one of these; the history and
 * the AuditLog rows of the same transaction carry it (AuditLog.source, txId).
 */
export const src = {
  /** A request (CustomerEdit): submit, draft, approval step, final apply, reject, close, reactivation. */
  edit: (editId: string) => join('edit', editId),
  /**
   * A customer-master import row, by lane. `row` is the sheet row number. Without
   * a lane: the row's group before its lane is decided (reads only).
   */
  import: (batchId: string, row: number | string, lane?: ImportLane) =>
    lane ? join('import', batchId, row, lane) : join('import', batchId, row),
  /** An import's own set-up writes (the UNASSIGNED region and route). */
  importSetup: (batchId: string) => join('import', batchId, 'setup'),
  /** An import's closing write: the batch's counts and issue rows. */
  importSummary: (batchId: string) => join('import', batchId, 'summary'),
  /** An account-master import row: 'import:<batch>:Users!14'. */
  importAccount: (batchId: string, sheet: string, row: number | string) =>
    join('import', batchId, `${part(sheet)}!${part(row)}`),
  /** A Steward's correction of a quarantined import row. */
  importFix: (batchId: string, row: number | string) => join('import-fix', batchId, row),
  /** A duplicate merge: the winner keeps, the loser is folded in. */
  merge: (winnerId: string, loserId: string) => join('merge', winnerId, loserId),
  /** A customer archived (soft-deleted) from its page. */
  archive: (customerId: string) => join('archive', customerId),
  /** A photo attached, replaced or removed. */
  photo: (attachmentId: string) => join('photo', attachmentId),
  /** A printout recorded. */
  print: (id: string) => join('print', id),
  /** User administration: create, toggle, reset, role, account, bulk-reset, email. */
  users: (action: string, targetId: string) => join('users', action, targetId),
  /** Region and route administration. */
  routes: (action: string, id: string) => join('routes', action, id),
  /** The Temix upload queue: generate, loaded, requeue. */
  temix: (action: string, batchId: string) => join('temix', action, batchId),
  /** Sign-in and sign-out. */
  auth: (event: string) => join('auth', event),
  /** A person changing their own password. */
  password: (event: string) => join('password', event),
  /** A scheduled job. */
  cron: (job: string) => join('cron', job),
  /** An operator script run: its name and the run id it prints. */
  script: (name: string, runId: string) => join('script', name, runId),
  /** A migration's own writes (the history baseline). */
  migration: (name: string) => join('migration', name),
  /** A development or pilot seed. */
  seed: (name: string) => join('seed', name),
  /** The launch e2e harness, per run. */
  e2e: (runId: string) => join('e2e', runId),
  /** An integration suite's fixtures. */
  test: (suite: string) => join('test', suite),
  /** A verification probe that rolls back (app-role verify, restore-verify). */
  verify: (name: string) => join('verify', name),
  /**
   * Reserved for item D, the daily Temix file: one source per file row, written
   * with effectiveFrom = the load day ('YYYY-MM-DD').
   */
  temixDaily: (fileId: string, row: number | string) => join('temix-daily', fileId, row),
} as const;

/** The three values set_config receives. Throws on a malformed context, before any transaction opens. */
export function changeContextParams(
  ctx: ChangeContext,
  now: Date = new Date()
): { actor: string; source: string; effective: string } {
  const source = ctx.source;
  if (typeof source !== 'string' || source.length > SOURCE_MAX || !SOURCE_RE.test(source)) {
    throw new Error(
      `change context: malformed source ${JSON.stringify(String(source).slice(0, 60))}`
    );
  }
  const actor = ctx.actorId ?? '';
  if (typeof actor !== 'string' || actor.length > 64)
    throw new Error('change context: malformed actor id');
  return { actor, source, effective: effectiveParam(ctx.effectiveFrom, now) };
}

function effectiveParam(value: EffectiveFrom, now: Date): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('change context: invalid effective time');
    if (value.getTime() > now.getTime() + EFFECTIVE_FUTURE_SLACK_MS) {
      throw new Error('change context: an effective time may not be in the future');
    }
    return value.toISOString();
  }
  if (typeof value !== 'string') throw new Error('change context: invalid effective time');
  if (EFFECTIVE_DAY_RE.test(value)) {
    const start = omanDayStart(value);
    if (start === null) throw new Error(`change context: invalid effective day ${value}`);
    if (start.getTime() > now.getTime() + EFFECTIVE_FUTURE_SLACK_MS) {
      throw new Error('change context: an effective day may not be in the future');
    }
    return value;
  }
  // An instant with an explicit offset; anything else is ambiguous about its zone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(
      'change context: an effective time needs a date or an ISO instant with its offset'
    );
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error('change context: invalid effective time');
  if (at.getTime() > now.getTime() + EFFECTIVE_FUTURE_SLACK_MS) {
    throw new Error('change context: an effective time may not be in the future');
  }
  return value;
}

const OMAN_OFFSET_MS = 4 * 60 * 60 * 1000;

/** The UTC instant an Oman calendar day starts (Asia/Muscat is UTC+4, no DST); null for a non-date. */
export function omanDayStart(day: string): Date | null {
  if (!EFFECTIVE_DAY_RE.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d)
    return null;
  return new Date(utc - OMAN_OFFSET_MS);
}

/**
 * The as-of convention (docs/HISTORY.md): "on day D" means the state at the END
 * of that Oman day, so a change made at any time on D counts for D. The same
 * bound the database's nmwc_day_end(d) computes.
 */
export function omanDayEnd(day: string): Date | null {
  const start = omanDayStart(day);
  return start ? new Date(start.getTime() + 24 * 60 * 60 * 1000) : null;
}

type RawRunner = Pick<Prisma.TransactionClient, '$executeRaw'>;

/**
 * Name the cause of every write in the current transaction. One statement, and
 * it may be called again in the same transaction to name the next row's cause.
 * Outside a transaction it would be lost at once, so it is only ever called on a
 * transaction client (withChangeContext, or a script's own $transaction).
 */
export async function setChangeContext(tx: RawRunner, ctx: ChangeContext): Promise<void> {
  const { actor, source, effective } = changeContextParams(ctx);
  await tx.$executeRaw`SELECT set_config('nmwc.actor', ${actor}, true), set_config('nmwc.source', ${source}, true), set_config('nmwc.effective_from', ${effective}, true)`;
}

/**
 * The same statement as a batch item, for a script's array transaction:
 * `client.$transaction([changeContextStatement(client, ctx), client.x.update(...)])`.
 */
export function changeContextStatement(
  client: Pick<PrismaClient, '$executeRaw'>,
  ctx: ChangeContext
) {
  const { actor, source, effective } = changeContextParams(ctx);
  return client.$executeRaw`SELECT set_config('nmwc.actor', ${actor}, true), set_config('nmwc.source', ${source}, true), set_config('nmwc.effective_from', ${effective}, true)`;
}

/**
 * A client whose every model call runs in its own short transaction under `ctx`
 * (Prisma's documented set_config extension). For seeds and fixture builders
 * that make many plain calls, where threading a transaction client through every
 * helper would rewrite the file. Not for request code: one extra round trip per
 * call, reads included, and it must not be used inside an interactive transaction.
 */
export function contextClient<C extends PrismaClient>(client: C, ctx: ChangeContext) {
  changeContextParams(ctx);
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await client.$transaction([
            changeContextStatement(client, ctx),
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

export type ChangeTxOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

type TxClient = Pick<PrismaClient, '$transaction'>;

/**
 * An interactive transaction whose writes name their cause. The context is
 * checked before the transaction opens, so a malformed source costs no round
 * trip and holds no lock.
 *
 * Every write transaction in app/, lib/ and services/ goes through here
 * (tests/unit/change-context-guard.test.ts); the client is passed in, rather than
 * imported, so this module stays free of the pooled request client.
 */
export function withChangeContext<T>(
  client: TxClient,
  ctx: ChangeContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: ChangeTxOptions
): Promise<T> {
  changeContextParams(ctx);
  return client.$transaction(async (tx) => {
    await setChangeContext(tx, ctx);
    return fn(tx);
  }, opts);
}
