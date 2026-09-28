/**
 * The account-master import's row rules and messages (services/imports.ts,
 * uploadAccountMasterCore).
 *
 * They live here, not in the service, because a 'use server' module may export
 * only async actions, and each rule is proved on its own in
 * tests/unit/account-import-rules.test.ts. Nothing here reads the database.
 */
import type { Role } from '@prisma/client';
import { isTransientDbError, mayHaveCommitted } from './db-errors';
import { scrubAndTruncate } from './scrub';

/** Roles an import may neither mint nor change; the Users UI owns them. */
const ADMIN_ROLES: readonly Role[] = ['MANAGER', 'STEWARD'];

/**
 * F08: a row for an existing account whose `role` differs from the stored role,
 * with change_role not set to yes. Null when the row may go ahead.
 *
 * The row is held back rather than applied under the stored role, because its
 * route_code and region_codes were written for the role it names. Applied anyway,
 * a stored SALESMAN on a VIEWER row lost his route while staying SALESMAN, and a
 * stored VIEWER on a SALESMAN row took the route from the real salesman without
 * becoming one — each reported as a clean row.
 */
export function roleMismatchIssue(p: {
  username: string;
  storedRole: Role;
  incomingRole: Role;
  wantsRoleChange: boolean;
}): string | null {
  if (p.wantsRoleChange || p.storedRole === p.incomingRole) return null;
  const how =
    ADMIN_ROLES.includes(p.storedRole) || ADMIN_ROLES.includes(p.incomingRole)
      ? 'Correct the role cell: a MANAGER or STEWARD role is changed only in the Users UI.'
      : 'Correct the role cell, or set change_role to yes to change the role.';
  return `"${p.username}" is ${p.storedRole} in the CRM but ${p.incomingRole} in this row. Nothing was written. ${how}`;
}

/**
 * X-IMPORTS-2: a row that would hand a route to a deactivated account. Null when
 * the row may go ahead — including when the account already owns that route,
 * because then nothing changes hands (deactivation keeps the route).
 *
 * Applied, the route was taken from its active salesman and parked on an account
 * that cannot sign in, and the row reported clean.
 */
export function inactiveRouteIssue(p: {
  username: string;
  isActive: boolean;
  currentRouteId: string | null;
  incomingRouteId: string | null;
  routeCode: string | null;
}): string | null {
  if (p.isActive || !p.incomingRouteId || p.incomingRouteId === p.currentRouteId) return null;
  return `"${p.username}" is deactivated, so route ${p.routeCode} is not handed to it. Nothing was written. Reactivate the account in Users first, or remove this row.`;
}

/**
 * What the import compares about an account, before and after a row. Never the
 * password or its hash; below, only some of it is copied into the ledger.
 */
export type AccountState = {
  fullName: string;
  role: Role;
  /** The supervisor's username. */
  supervisor: string | null;
  /** The owned route's code. */
  route: string | null;
  /** Managed region codes, sorted. */
  regions: string[];
  mustChangePassword: boolean;
  email: string | null;
  phone: string | null;
};

/**
 * Written into the ledger as values: what the account may see and do. The role
 * is not here: a role change keeps its own row (reason role_change_via_import),
 * as the Users UI's does.
 */
const VALUE_FIELDS = ['supervisor', 'route', 'regions', 'mustChangePassword'] as const;
/**
 * Named in the ledger, never copied into it. AuditLog is append-only, so a value
 * written there cannot be erased (docs/compliance/PDPL-ASSESSMENT.md, Q4), and
 * none of these decides what the account can reach; the row says THAT the field
 * changed, and the account itself says to what. The Users UI's CREATE row
 * carries no name or contact value either.
 */
const PERSONAL_FIELDS = ['fullName', 'email', 'phone'] as const;
/** Of those, the ones a new account may be created without. */
const CONTACT_FIELDS = ['email', 'phone'] as const;

type Json = Record<string, string | number | boolean | string[] | null>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** X-IMPORTS-1: the `after` of the CREATE row for an account the import creates. */
export function accountCreateAudit(username: string, s: AccountState, batchId: string): Json {
  const after: Json = { username, role: s.role, batchId };
  for (const f of VALUE_FIELDS) after[f] = s[f];
  after.contactGiven = CONTACT_FIELDS.filter((f) => s[f] !== null);
  return after;
}

/**
 * X-IMPORTS-1: the before/after of the UPDATE row for an existing account, with
 * only the fields that changed — or null when nothing did, so a routine re-import
 * of an unchanged sheet does not flood the ledger.
 */
export function accountUpdateAudit(
  username: string,
  before: AccountState,
  after: AccountState,
  batchId: string
): { before: Json; after: Json } | null {
  const b: Json = {};
  const a: Json = {};
  for (const f of VALUE_FIELDS) {
    if (same(before[f], after[f])) continue;
    b[f] = before[f];
    a[f] = after[f];
  }
  const namedChanged = PERSONAL_FIELDS.filter((f) => before[f] !== after[f]);
  if (Object.keys(a).length === 0 && namedChanged.length === 0) return null;
  if (namedChanged.length > 0) a.changed = namedChanged;
  return { before: b, after: { username, ...a, batchId } };
}

/**
 * X-IMPORTS-3: after this many rows in a row fail because the database did not
 * answer, the import stops and records every remaining row as not processed.
 * Carrying on row by row through an outage only turns each remaining row into its
 * own pool timeout, and runs into the request's time limit with nothing recorded.
 */
export const ACCOUNT_IMPORT_STOP_AFTER_DB_FAILURES = 3;

export type RowFailure = {
  message: string;
  /** The database, not the row, was the problem. */
  transient: boolean;
  /** The connection died where the commit may already have landed. */
  mayHaveCommitted: boolean;
};

/**
 * F07 / X-IMPORTS-3: the issue for a Regions, Routes or Users row whose write, or
 * whose reads, threw.
 *
 * Each row's writes and audit rows share one transaction, so a failure means
 * nothing was written — except when the connection died where the commit may
 * already have landed, which is said instead. The raw database message is never
 * used: it can carry the value that broke a constraint (an e-mail, for this
 * table). The Prisma code, the unique field or the constraint name are schema
 * identifiers and safe to show.
 */
export function accountRowFailure(err: unknown, subject: string): RowFailure {
  const rawCode = (err as { code?: unknown } | null)?.code;
  const code = typeof rawCode === 'string' ? rawCode : '';
  if (isTransientDbError(err, code)) {
    return mayHaveCommitted(err, code)
      ? {
          transient: true,
          mayHaveCommitted: true,
          message: `the connection to the database dropped while ${subject} was being saved, so it may or may not have been written. Check it in the CRM before importing this row again.`,
        }
      : {
          transient: true,
          mayHaveCommitted: false,
          message: `the database did not answer${code ? ` (${code})` : ''}, so nothing was written for ${subject}. Import this row again.`,
        };
  }
  const refused = (why: string): RowFailure => ({
    transient: false,
    mayHaveCommitted: false,
    message: `nothing was written for ${subject}: ${why}`,
  });
  if (code === 'P2002') {
    const target = (err as { meta?: { target?: unknown } }).meta?.target;
    const fields = Array.isArray(target)
      ? target.map(String).join(', ')
      : typeof target === 'string'
        ? target
        : 'a value';
    return refused(`its ${fields} is already used by another record.`);
  }
  const constraint = /constraint "([A-Za-z0-9_]+)"/.exec(
    err instanceof Error ? err.message : ''
  )?.[1];
  if (constraint) return refused(`the database refused it (${constraint}).`);
  const name = err instanceof Error ? err.name : 'unknown error';
  return refused(`it could not be saved (${code || name}).`);
}

/**
 * The error's name and what its message says, for the log line and the Sentry
 * report of a row (or a batch report) that failed. The issue text above never
 * carries the message, so without this an unexpected fault left nothing behind
 * but "could not be saved (TypeError)".
 *
 * Not the whole message: a Prisma validation error prints the call's arguments
 * between its first line (which call) and its last (why) — for this table that
 * includes the password hash — and a Postgres error's detail quotes the failing
 * row or key. So the first and last lines only, with any detail cut off, then
 * scrubbed of phone numbers and e-mail addresses before it is shortened.
 */
export function errorLogFields(err: unknown): { errName: string; err: string } {
  const errName = err instanceof Error ? err.name : typeof err;
  const raw = err instanceof Error ? err.message : String(err);
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const text = (lines.length > 1 ? `${lines[0]} … ${lines[lines.length - 1]}` : (lines[0] ?? ''))
    .replace(/\s*(?:\bdetail\b|Failing row contains|\bKey \().*$/i, ' [detail cut]');
  return { errName, err: scrubAndTruncate(text, 300) };
}

/**
 * The error sent to Sentry for a failure that was not the database going away:
 * the original's name and stack frames, with errorLogFields' text for its
 * message, because the SDK sends an exception's message as it stands.
 */
export function reportableError(err: unknown): Error {
  const { errName, err: message } = errorLogFields(err);
  const out = new Error(message);
  out.name = errName;
  const frames =
    err instanceof Error && typeof err.stack === 'string'
      ? err.stack.split('\n').filter((l) => /^ {4}at /.test(l))
      : [];
  out.stack = [`${errName}: ${message}`, ...frames].join('\n');
  return out;
}

/** X-IMPORTS-3: the issue for a row the import never reached because it stopped. */
export const ACCOUNT_ROW_NOT_PROCESSED =
  'not processed: the import stopped because the database stopped answering. Nothing was written for this row. Import it again.';

/**
 * X-IMPORTS-3: what the Steward is told when an upload did not run to a normal
 * end — the database stopped answering part-way, or the batch record itself
 * could not be saved. By then every row counted as applied has committed, so the
 * generic "Nothing was saved" answer would tell them the opposite of what
 * happened.
 */
export function accountImportInterruptedMessage(p: {
  applied: number;
  uncertain: number;
  notApplied: number;
  recorded: boolean;
  /**
   * When the report could not be saved for a reason other than the database not
   * answering (isTransientDbError false): the Prisma code or the error's name.
   * Without it, an unrecorded report is put down to the database.
   */
  reportFault?: string;
}): string {
  const applied = `${p.applied} row(s) were applied and are saved`;
  const uncertain =
    p.uncertain > 0
      ? `; ${p.uncertain} may or may not have been, because the connection dropped while they were being saved`
      : '';
  const again =
    'A row that was already applied changes nothing the second time, except that a row with reset_password set to yes issues its password again, so take those rows out first.';
  const rerun = `Upload the same file again once the CRM responds. ${again}`;
  if (p.recorded) {
    return `The database stopped answering, so the import stopped part-way. ${applied}${uncertain}. The ${p.notApplied} row(s) that were not applied are listed on this upload's batch page. ${rerun}`;
  }
  if (p.reportFault) {
    return `${applied}${uncertain}, but this upload's report could not be saved (${p.reportFault}), so the ${p.notApplied} row(s) that were not applied are not listed anywhere. The fault is in the CRM, not in the file, and it has been reported. If the file is uploaded again: ${again}`;
  }
  return `${applied}${uncertain}, but the database stopped answering before this upload's report could be saved, so the ${p.notApplied} row(s) that were not applied are not listed anywhere. ${rerun}`;
}
