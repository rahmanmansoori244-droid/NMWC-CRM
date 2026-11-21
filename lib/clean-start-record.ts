/**
 * The go-live clean start's own record (scripts/ops/clean-start/reset.sql): ONE
 * AuditLog row, written in the reset's transaction by the owner login,
 *
 *   id 'cleanstart-<run>', action DELETE, entityType 'System',
 *   entityId 'clean-start', source 'script:clean-start:<run>' (stamped by the
 *   auditlog_stamp_context trigger), at = the reset's moment,
 *   after = { runId, …, removed: { <table>: n }, kept: { <table>: n } }
 *
 * `removed` counts the rows each emptied table held, and for the two tables the
 * reset deletes from in part (CodeSequence, CronRun) the rows it deleted; `kept`
 * counts the kept tables and what is left of those two. Both objects are built
 * with jsonb_object_agg over the tables as they were just before the reset.
 *
 * Two readers, both from the row itself and nothing else:
 *   - the Audit page lists the counts under that row (cleanStartCounts);
 *   - the dashboard reads the moment (readCleanStartAt): a comparison whose
 *     earlier period starts before it compares with days the reset emptied, so it
 *     is not drawn (lib/insights/compare.ts).
 *
 * Pure apart from readCleanStartAt, which takes the client it reads with.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

/** How reset.sql writes the row; tests/unit/clean-start-record.test.ts holds this to the SQL text. */
export const CLEAN_START_RECORD = {
  idPrefix: 'cleanstart-',
  action: 'DELETE',
  entityType: 'System',
  entityId: 'clean-start',
  sourcePrefix: 'script:clean-start:',
} as const;

type RecordLike = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  source?: string | null;
};

/** Whether an AuditLog row is the clean start's own record (every mark reset.sql gives it). */
export function isCleanStartRecord(row: RecordLike): boolean {
  return (
    row.id.startsWith(CLEAN_START_RECORD.idPrefix) &&
    row.action === CLEAN_START_RECORD.action &&
    row.entityType === CLEAN_START_RECORD.entityType &&
    row.entityId === CLEAN_START_RECORD.entityId &&
    typeof row.source === 'string' &&
    row.source.startsWith(CLEAN_START_RECORD.sourcePrefix)
  );
}

/**
 * Plain words for each table the record counts, in the order the Audit page lists
 * them. A table not named here (one added after this list) is listed by its own
 * name, after these.
 */
export const CLEAN_START_KIND_LABELS: Readonly<Record<string, string>> = {
  Customer: 'Customers',
  Branch: 'Branches (shops)',
  Attachment: 'Photos and documents',
  CustomerEdit: 'Requests',
  EditCustomerDraft: 'New-customer request drafts (customer)',
  EditBranchDraft: 'New-customer request drafts (shops)',
  EditRevision: 'Request revisions',
  EditApproval: 'Approval decisions',
  Notification: 'Notifications',
  ImportBatch: 'Import batches',
  ImportRow: 'Import rows',
  TemixSyncBatch: 'Temix file uploads',
  TemixDailyFile: 'Daily Temix files',
  TemixDailyRow: 'Daily Temix file rows',
  TemixChange: 'Daily Temix changes and notices',
  TemixChangeReview: 'Daily Temix review marks',
  TemixNoticeSeen: 'Daily Temix notices already listed',
  TemixRouteMap: 'Daily Temix route map entries',
  ExportJob: 'Exports',
  SavedView: 'Saved filters',
  AuditLog: 'Audit log entries',
  AuthEvent: 'Sign-in records',
  CustomerHistory: 'Customer history entries',
  BranchHistory: 'Shop history entries',
  AttachmentHistory: 'Photo history entries',
  UserHistory: 'Account history entries',
  RouteHistory: 'Route history entries',
  RouteOwnerHistory: 'Route holder history entries',
  RegionHistory: 'Region history entries',
  IntegrityCheckResult: 'Integrity check results',
  SealRecord: 'Nightly seals',
  PurgeSummary: 'Clean-up summaries',
  JobRunDay: 'Job run days',
  CronRun: 'Scheduled job runs',
  RateLimit: 'Sign-in throttle counters',
  CodeSequence: 'Customer code counters',
  User: 'Accounts',
  PasswordHistory: 'Past passwords (stored scrambled)',
  Region: 'Regions',
  Route: 'Routes',
  _ManagerRegions: 'Manager–region links',
  Channel: 'Channels',
  SubChannel: 'Sub-channels',
  CronHeartbeat: 'Scheduled job heartbeats',
};

export type CleanStartCount = {
  /** The table, as the record names it. */
  kind: string;
  /** Plain words for it (CLEAN_START_KIND_LABELS), or the table's own name. */
  label: string;
  /** Rows removed, or null when the record holds no figure for this kind. */
  removed: number | null;
  /** Rows kept, or null when the record holds no figure for this kind. */
  kept: number | null;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A count as the record holds it: a whole number, not negative. Anything else is no figure. */
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

/**
 * The removed and kept counts per kind, read from the record's `after` only.
 * Null when the record holds neither list. A kind appears when either list names
 * it; a figure the record does not hold stays null, never 0.
 */
export function cleanStartCounts(after: unknown): CleanStartCount[] | null {
  if (!isObject(after)) return null;
  const removed = isObject(after.removed) ? after.removed : null;
  const kept = isObject(after.kept) ? after.kept : null;
  if (!removed && !kept) return null;
  const kinds = new Set([...Object.keys(removed ?? {}), ...Object.keys(kept ?? {})]);
  const order = Object.keys(CLEAN_START_KIND_LABELS);
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return [...kinds]
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((kind) => ({
      kind,
      label: Object.prototype.hasOwnProperty.call(CLEAN_START_KIND_LABELS, kind) ? CLEAN_START_KIND_LABELS[kind]! : kind,
      removed: removed && Object.prototype.hasOwnProperty.call(removed, kind) ? count(removed[kind]) : null,
      kept: kept && Object.prototype.hasOwnProperty.call(kept, kind) ? count(kept[kind]) : null,
    }));
}

/**
 * The moment of the latest clean start, read from its own record, or null on a
 * database that never had one. One indexed read (AuditLog entityType, entityId,
 * at DESC).
 */
export async function readCleanStartAt(db: PrismaClient | Prisma.TransactionClient): Promise<Date | null> {
  const row = await db.auditLog.findFirst({
    // Literal values (tests/unit/photo-view-visibility.test.ts reads the entity type
    // from the query); `satisfies` keeps them equal to CLEAN_START_RECORD.
    where: {
      entityType: 'System' satisfies typeof CLEAN_START_RECORD.entityType,
      entityId: 'clean-start' satisfies typeof CLEAN_START_RECORD.entityId,
      action: 'DELETE' satisfies typeof CLEAN_START_RECORD.action,
      id: { startsWith: CLEAN_START_RECORD.idPrefix },
      source: { startsWith: CLEAN_START_RECORD.sourcePrefix },
    },
    orderBy: { at: 'desc' },
    select: { at: true },
  });
  return row?.at ?? null;
}
