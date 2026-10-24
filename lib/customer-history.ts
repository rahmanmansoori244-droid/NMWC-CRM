/**
 * The customer's History page (app/(app)/customers/[id]/history), assembled from
 * the dated history (docs/HISTORY.md): which routes served the customer and which
 * salesman held each route then, its terms over time, every change with who, when
 * and why, and how it came to be. The owner's goal (2026-10-11): "this route
 * served it, then that route; the date it was created; who changed what and when".
 *
 * PURE: no next/* runtime, no @/lib/db. lib/customer-history-load.ts reads the
 * rows; everything here is unit-tested without a database
 * (tests/unit/customer-history.test.ts).
 *
 * No personal value from the history reaches the page (PDPL-ASSESSMENT Q4). The
 * history stores a name, phone, CR number, contact, e-mail, note, address or GPS
 * point by FIELD NAME only, and AuditLog — whose before/after and typed reasons
 * can hold them — is never read. A field shows a value only when it is on its
 * table's VALUE_FIELDS list, and the value is read from the history row's own
 * column ("to" from this row, "from" from the same record's previous row). Every
 * other field, including one this code does not know yet, reads "<label>:
 * changed": the rule fails closed. So does a cause that fails SOURCE_RE
 * (parseSource): its text is not shown.
 *
 * Labels come from today's live rows, as on the customer page: the customer's
 * legal name (page header), today's shop names (shop picker), and account full
 * names (who). The PII register classes these as name data; the Data Steward
 * sees the same on the customer page.
 */
import type {
  AttachmentKind,
  CustomerStatus,
  DayOfWeek,
  HistoryChange,
  PaymentTerms,
  Role,
} from '@prisma/client';
import type { Route } from 'next';
import { ROLE_LABELS } from './account-edit';
import { SOURCE_RE } from './change-context';
import { CREDIT_DOCUMENT_LABELS, isDecisionBoundKind } from './credit-documents';
import { omanDate, omanDateTime } from './tz';

// ── Constants ─────────────────────────────────────────────

/** Entries per page of the timeline. */
export const PAGE_SIZE = 25;
/** Rows read per history table; past it the page says the older ones are in the audit log. */
export const READ_CAP = 5000;
/** A change whose writing came this long after it took effect also says when it was recorded. */
export const RECORDED_APART_MS = 60_000;

/** CustomerHistory columns that keep their value (docs/HISTORY.md §2). */
export const CUSTOMER_VALUE_FIELDS = [
  'nmwcCode',
  'paymentTerms',
  'creditLimit',
  'paymentTermDays',
  'temixCode',
  'status',
  'channelId',
  'subChannelId',
  'crPhotoId',
  'deletedAt',
  'mergedIntoId',
] as const;

/** BranchHistory columns that keep their value. hasGps is not one: a GPS change is the name 'gps' only. */
export const BRANCH_VALUE_FIELDS = [
  'branchCode',
  'customerId',
  'routeId',
  'regionId',
  'dayOfVisit',
  'status',
  'deletedAt',
  'coolersCount',
  'standsCount',
  'emptyBottlesCount',
  'equipmentConfirmed',
  'shopPhotoId',
  'signboardPhotoId',
] as const;

export type CustomerValueField = (typeof CUSTOMER_VALUE_FIELDS)[number];
export type BranchValueField = (typeof BRANCH_VALUE_FIELDS)[number];
export type HistoryTable = 'customer' | 'shop';

const VALUE_FIELDS: Record<HistoryTable, ReadonlySet<string>> = {
  customer: new Set(CUSTOMER_VALUE_FIELDS),
  shop: new Set(BRANCH_VALUE_FIELDS),
};

/** The fields the history records by name only (the capture triggers' "personal values" lists). */
export const NAME_ONLY_LABELS: Record<HistoryTable, Readonly<Record<string, string>>> = {
  customer: {
    legalName: 'Legal name',
    crNumber: 'CR number',
    primaryPhone: 'Primary phone',
    altPhone: 'Alt phone',
    contactPerson: 'Contact person',
    contactRole: 'Contact role',
    email: 'E-mail',
    notes: 'Notes',
  },
  shop: {
    branchName: 'Shop name',
    address: 'Address',
    areaDescription: 'Area description',
    gps: 'GPS point',
    openingHours: 'Opening hours',
    deliveryWindow: 'Delivery window',
  },
};

export const FIELD_LABELS: Record<CustomerValueField | BranchValueField, string> = {
  nmwcCode: 'NMWC code',
  paymentTerms: 'Payment terms',
  creditLimit: 'Credit limit',
  paymentTermDays: 'Credit days',
  temixCode: 'Temix code',
  status: 'Status',
  channelId: 'Channel',
  subChannelId: 'Sub-channel',
  crPhotoId: 'CR document',
  deletedAt: 'Record',
  mergedIntoId: 'Merged into',
  branchCode: 'Shop code',
  customerId: 'Customer',
  routeId: 'Route',
  regionId: 'Region',
  dayOfVisit: 'Day of visit',
  coolersCount: 'Coolers',
  standsCount: 'Stands',
  emptyBottlesCount: 'Empty bottles',
  equipmentConfirmed: 'Equipment confirmed',
  shopPhotoId: 'Shop photo',
  signboardPhotoId: 'Signboard photo',
};

// Own copies: lib/print-load.ts's import the pooled client.
export const STATUS_LABEL: Record<CustomerStatus, string> = {
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  SUSPENDED: 'Suspended',
};
export const DAY_LABEL: Record<DayOfWeek, string> = {
  SAT: 'Saturday',
  SUN: 'Sunday',
  MON: 'Monday',
  TUE: 'Tuesday',
  WED: 'Wednesday',
  THU: 'Thursday',
  FRI: 'Friday',
};
const TERMS_LABEL: Record<PaymentTerms, string> = { CASH: 'Cash', CREDIT: 'Credit' };

const PHOTO_FIELDS: ReadonlySet<string> = new Set(['crPhotoId', 'shopPhotoId', 'signboardPhotoId']);

// ── Rows, as the loader reads them ────────────────────────

/** A decimal as Prisma returns it (Prisma.Decimal), or a number or string. */
export type DecimalLike = { toFixed(dp: number): string } | number | string;

/** The columns every history table has (docs/HISTORY.md §2), less dbUser. */
export type HistoryMeta = {
  id: bigint;
  changeKind: HistoryChange;
  changedFields: string[];
  validFrom: Date;
  recordedAt: Date;
  effectiveRequested: Date | null;
  actorId: string | null;
  source: string;
  sourceKind: string;
  txId: bigint;
};

export type CustomerHistoryRow = HistoryMeta & {
  nmwcCode: string;
  paymentTerms: PaymentTerms;
  creditLimit: DecimalLike | null;
  paymentTermDays: number | null;
  temixCode: string | null;
  status: CustomerStatus;
  channelId: string | null;
  subChannelId: string | null;
  crPhotoId: string | null;
  deletedAt: Date | null;
  mergedIntoId: string | null;
};

export type BranchHistoryRow = HistoryMeta & {
  branchId: string;
  branchCode: string;
  customerId: string;
  routeId: string;
  regionId: string;
  dayOfVisit: DayOfWeek | null;
  status: CustomerStatus;
  deletedAt: Date | null;
  coolersCount: number;
  standsCount: number;
  emptyBottlesCount: number;
  equipmentConfirmed: boolean;
  shopPhotoId: string | null;
  signboardPhotoId: string | null;
};

/** A credit document or guarantee of the customer (AttachmentHistory). */
export type DocumentHistoryRow = HistoryMeta & {
  attachmentId: string;
  kind: AttachmentKind;
  deletedAt: Date | null;
};

/** One row of nmwc_customer_route_intervals (20261014100000_lossless_paths). */
export type RouteIntervalRow = {
  branch_id: string | null;
  branch_code: string | null;
  route_id: string | null;
  route_code: string | null;
  salesman_id: string | null;
  salesman_username: string | null;
  valid_from: Date;
  valid_to: Date | null;
  from_inferred: boolean;
  merged_into_id: string | null;
  note: string | null;
};

// ── Lookups (labels for ids) ──────────────────────────────

export type EditLookup = {
  process: 'CREATE' | 'UPDATE';
  target: 'CUSTOMER' | 'BRANCH';
  isReactivation: boolean;
  submitter: string | null;
  /** A Manager's or Steward's own write: approved by himself in the same transaction. */
  direct: boolean;
  customerId: string | null;
};

export type HistoryLookups = {
  users: ReadonlyMap<string, { fullName: string; role: Role }>;
  /** Each actor's account history, oldest first: his role and username at a time. */
  userHistory: ReadonlyMap<string, ReadonlyArray<{ validFrom: Date; role: Role; username: string }>>;
  routes: ReadonlyMap<string, { code: string; name: string | null }>;
  regions: ReadonlyMap<string, { code: string; name: string | null }>;
  channels: ReadonlyMap<string, string>;
  subChannels: ReadonlyMap<string, string>;
  /** Customer id → NMWC code (this one, and every other one a row names). */
  customers: ReadonlyMap<string, string>;
  batches: ReadonlyMap<string, { filename: string; kind: string }>;
  edits: ReadonlyMap<string, EditLookup>;
};

export type LookupRows = {
  users?: ReadonlyArray<{ id: string; fullName: string; role: Role }>;
  userHistory?: ReadonlyArray<{ userId: string; validFrom: Date; role: Role; username: string }>;
  routes?: ReadonlyArray<{ id: string; code: string; name: string | null }>;
  regions?: ReadonlyArray<{ id: string; code: string; name: string | null }>;
  channels?: ReadonlyArray<{ id: string; label: string }>;
  subChannels?: ReadonlyArray<{ id: string; label: string }>;
  customers?: ReadonlyArray<{ id: string; nmwcCode: string }>;
  batches?: ReadonlyArray<{ id: string; filename: string; kind: string }>;
  edits?: ReadonlyArray<{
    id: string;
    process: 'CREATE' | 'UPDATE';
    target: 'CUSTOMER' | 'BRANCH';
    isReactivation: boolean;
    state: string;
    submittedById: string;
    reviewedById: string | null;
    customerId: string | null;
    /** The customer the request was first about (a merge repoints customerId, never this). */
    originalCustomerId?: string | null;
    submittedBy: { fullName: string } | null;
  }>;
};

export function buildLookups(rows: LookupRows): HistoryLookups {
  const userHistory = new Map<string, Array<{ validFrom: Date; role: Role; username: string }>>();
  for (const h of rows.userHistory ?? []) {
    const list = userHistory.get(h.userId) ?? [];
    list.push({ validFrom: h.validFrom, role: h.role, username: h.username });
    userHistory.set(h.userId, list);
  }
  // Stable: rows that share a validFrom keep the order they were read in (id asc).
  for (const list of userHistory.values()) list.sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
  return {
    users: new Map((rows.users ?? []).map((u) => [u.id, { fullName: u.fullName, role: u.role }])),
    userHistory,
    routes: new Map((rows.routes ?? []).map((r) => [r.id, { code: r.code, name: r.name }])),
    regions: new Map((rows.regions ?? []).map((r) => [r.id, { code: r.code, name: r.name }])),
    channels: new Map((rows.channels ?? []).map((c) => [c.id, c.label])),
    subChannels: new Map((rows.subChannels ?? []).map((c) => [c.id, c.label])),
    customers: new Map((rows.customers ?? []).map((c) => [c.id, c.nmwcCode])),
    batches: new Map((rows.batches ?? []).map((b) => [b.id, { filename: b.filename, kind: b.kind }])),
    edits: new Map(
      (rows.edits ?? []).map((e) => [
        e.id,
        {
          process: e.process,
          target: e.target,
          isReactivation: e.isReactivation,
          submitter: e.submittedBy?.fullName ?? null,
          // services/edits.ts isDirectWrite: a Manager's or Steward's submit is
          // applied at once, approved by himself. No one else approves his own
          // request, so this shape is a direct write; its ledger row is the
          // customer's UPDATE ('direct-write: …'), not a CustomerEdit row.
          direct: e.state === 'APPROVED' && e.reviewedById === e.submittedById,
          // Its audit row is keyed by the customer it was written on, which a
          // later merge does not move.
          customerId: e.originalCustomerId ?? e.customerId,
        },
      ])
    ),
  };
}

export const EMPTY_LOOKUPS: HistoryLookups = buildLookups({});

export type LookupIds = {
  userIds: string[];
  actorIds: string[];
  routeIds: string[];
  regionIds: string[];
  channelIds: string[];
  subChannelIds: string[];
  customerIds: string[];
  batchIds: string[];
  editIds: string[];
};

/** Every id the rows name, for the label lookups (round 3 of the loader). */
export function collectLookupIds(input: {
  customer: { id: string; mergedIntoId: string | null; importBatchId: string | null; createdById: string | null };
  customerRows: ReadonlyArray<CustomerHistoryRow>;
  birth: CustomerHistoryRow | null;
  branchRows: ReadonlyArray<BranchHistoryRow>;
  docRows: ReadonlyArray<DocumentHistoryRow>;
  intervals: ReadonlyArray<RouteIntervalRow>;
}): LookupIds {
  const actors = new Set<string>();
  const users = new Set<string>();
  const routes = new Set<string>();
  const regions = new Set<string>();
  const channels = new Set<string>();
  const subChannels = new Set<string>();
  const customers = new Set<string>([input.customer.id]);
  const batches = new Set<string>();
  const edits = new Set<string>();
  const add = (s: Set<string>, v: string | null | undefined) => {
    if (v) s.add(v);
  };
  const metas: HistoryMeta[] = [
    ...input.customerRows,
    ...(input.birth ? [input.birth] : []),
    ...input.branchRows,
    ...input.docRows,
  ];
  for (const m of metas) {
    add(actors, m.actorId);
    const p = parseSource(m.source);
    if (p.kind === 'edit') add(edits, p.editId);
    if (p.kind === 'import' || p.kind === 'import-fix') add(batches, p.batchId);
    if (p.kind === 'merge') {
      add(customers, p.winnerId);
      add(customers, p.loserId);
    }
  }
  for (const r of [...input.customerRows, ...(input.birth ? [input.birth] : [])]) {
    add(channels, r.channelId);
    add(subChannels, r.subChannelId);
    add(customers, r.mergedIntoId);
  }
  for (const b of input.branchRows) {
    add(routes, b.routeId);
    add(regions, b.regionId);
    add(customers, b.customerId);
  }
  for (const i of input.intervals) {
    add(routes, i.route_id);
    add(users, i.salesman_id);
    add(customers, i.merged_into_id);
  }
  add(customers, input.customer.mergedIntoId);
  add(batches, input.customer.importBatchId);
  add(users, input.customer.createdById);
  for (const a of actors) users.add(a);
  return {
    userIds: [...users],
    actorIds: [...actors],
    routeIds: [...routes],
    regionIds: [...regions],
    channelIds: [...channels],
    subChannelIds: [...subChannels],
    customerIds: [...customers],
    batchIds: [...batches],
    editIds: [...edits],
  };
}

// ── Sources: what caused a change ─────────────────────────

export type ParsedSource =
  | { kind: 'edit'; editId: string }
  | { kind: 'import'; batchId: string; row: string; lane: string | null }
  | { kind: 'import-fix'; batchId: string; row: string }
  | { kind: 'merge'; winnerId: string; loserId: string }
  | { kind: 'archive'; customerId: string }
  | { kind: 'photo'; attachmentId: string | null }
  | { kind: 'users'; action: string; id: string }
  | { kind: 'routes'; action: string; id: string }
  | { kind: 'temix'; action: string; batchId: string }
  | { kind: 'temix-daily'; fileId: string; row: string }
  | { kind: 'cron'; job: string }
  | { kind: 'script'; name: string; runId: string }
  | { kind: 'migration'; name: string }
  | { kind: 'harness'; source: string }
  | { kind: 'sql' }
  | { kind: 'unknown'; source: string }
  | { kind: 'malformed' };

/**
 * A source (lib/change-context.ts src.*) read back into its parts. The app only
 * writes sources that match SOURCE_RE: identifiers, never text a person typed.
 * The database does not check that (nmwc_change_ctx keeps any nmwc.source text up
 * to 200 characters, one typed in psql say, which could hold a name or a phone),
 * so a source that fails SOURCE_RE is 'malformed' and its text goes no further:
 * the rule fails closed, as for a personal field. A source that matches SOURCE_RE
 * but whose kind (or shape) this code does not know yet is 'unknown' and shown as
 * it is.
 */
export function parseSource(source: string): ParsedSource {
  if (source === 'sql') return { kind: 'sql' };
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) return { kind: 'malformed' };
  const [k, ...p] = source.split(':');
  switch (k) {
    case 'edit':
      if (p.length === 1) return { kind: 'edit', editId: p[0] };
      break;
    case 'import':
      if (p.length === 2 || p.length === 3) return { kind: 'import', batchId: p[0], row: p[1], lane: p[2] ?? null };
      break;
    case 'import-fix':
      if (p.length === 2) return { kind: 'import-fix', batchId: p[0], row: p[1] };
      break;
    case 'merge':
      if (p.length === 2) return { kind: 'merge', winnerId: p[0], loserId: p[1] };
      break;
    case 'archive':
      if (p.length === 1) return { kind: 'archive', customerId: p[0] };
      break;
    case 'photo':
      if (p.length === 1) return { kind: 'photo', attachmentId: p[0] === 'upload' ? null : p[0] };
      break;
    case 'users':
      if (p.length === 2) return { kind: 'users', action: p[0], id: p[1] };
      break;
    case 'routes':
      if (p.length === 2) return { kind: 'routes', action: p[0], id: p[1] };
      break;
    case 'temix':
      if (p.length === 2) return { kind: 'temix', action: p[0], batchId: p[1] };
      break;
    case 'temix-daily':
      if (p.length === 2) return { kind: 'temix-daily', fileId: p[0], row: p[1] };
      break;
    case 'cron':
      if (p.length === 1) return { kind: 'cron', job: p[0] };
      break;
    case 'script':
      if (p.length === 2) return { kind: 'script', name: p[0], runId: p[1] };
      break;
    case 'migration':
      if (p.length >= 1) return { kind: 'migration', name: p.join(':') };
      break;
    case 'seed':
    case 'e2e':
    case 'test':
    case 'verify':
      return { kind: 'harness', source };
  }
  return { kind: 'unknown', source };
}

/**
 * Where this page links. Every target is one the Data Steward can open: the audit
 * log (filtered), an import batch, the routes and Temix pages, a customer.
 */
export type HistoryHref = Route<`/import/${string}` | `/customers/${string}`>;

export type SourceView = {
  label: string;
  href: HistoryHref | null;
  /** The raw source, shown in monospace: a SOURCE_RE-valid kind this code does not know. */
  raw: boolean;
};

/** The label of a source that fails SOURCE_RE; its own text is never shown. */
export const MALFORMED_SOURCE_LABEL = "A cause not in the app's list (its text is not shown)";

/** The record a change is about, for a cause whose audit rows are keyed by it (a photo). */
export type SourceAbout = { entityType: 'Customer' | 'Branch' | 'Attachment'; entityId: string };

const enc = encodeURIComponent;

function rowPart(row: string): string {
  if (/^\d+$/.test(row)) return `, row ${row}`;
  const sheet = /^([A-Za-z0-9._-]+)!(\d+)$/.exec(row);
  if (sheet) return `, ${sheet[1]} sheet row ${sheet[2]}`;
  if (row === 'setup') return ' (set-up)';
  if (row === 'summary') return ' (closing write)';
  return `, row ${row}`;
}

const LANE_LABEL: Record<string, string> = {
  refresh: ' (Temix code on record)',
  backup: ' (first Temix code)',
  fixed: ' (corrected in the app)',
};

function requestName(e: EditLookup | undefined): string {
  if (!e) return 'Request';
  if (e.process === 'CREATE') return 'New-customer request';
  if (e.target === 'BRANCH') return e.isReactivation ? 'Reactivation request' : 'Close-shop request';
  return 'Update request';
}

export function describeSource(source: string, L: HistoryLookups, about?: SourceAbout): SourceView {
  const p = parseSource(source);
  const v = (label: string, href: HistoryHref | null = null): SourceView => ({ label, href, raw: false });
  switch (p.kind) {
    case 'edit': {
      const e = L.edits.get(p.editId);
      if (!e) return v(`Request ${p.editId}`);
      if (e.direct) {
        // Its ledger row is the customer's UPDATE (services/edits.ts), keyed by the customer.
        const c = e.customerId ?? (about?.entityType === 'Customer' ? about.entityId : null);
        return v(
          `Direct change by ${e.submitter ?? 'an account no longer on record'}, no approval step`,
          c ? `/audit?entityType=Customer&q=${enc(c)}` : null
        );
      }
      return v(
        `${requestName(e)}${e.submitter ? ` sent by ${e.submitter}` : ''}`,
        `/audit?entityType=CustomerEdit&q=${enc(p.editId)}`
      );
    }
    case 'import': {
      const b = L.batches.get(p.batchId);
      const lane = p.lane ? (LANE_LABEL[p.lane] ?? '') : '';
      return v(`Import ${b?.filename ?? p.batchId}${rowPart(p.row)}${lane}`, `/import/${enc(p.batchId)}`);
    }
    case 'import-fix': {
      const b = L.batches.get(p.batchId);
      return v(`Correction of a held-back row of import ${b?.filename ?? p.batchId}`, `/import/${enc(p.batchId)}`);
    }
    case 'merge': {
      const w = L.customers.get(p.winnerId);
      const l = L.customers.get(p.loserId);
      const detail = w && l ? ` (${l} folded into ${w})` : '';
      return v(`Duplicate merge${detail}`, `/audit?action=MERGE&q=${enc(p.winnerId)}`);
    }
    case 'archive':
      return v('Archived from the customer page', `/audit?entityType=Customer&q=${enc(p.customerId)}`);
    case 'photo':
      if (!p.attachmentId) return v('Photo upload');
      // A photo attach's ledger row is keyed by the customer or shop it went on;
      // a removal's by the photo.
      return v(
        'Photo or document attached, replaced or removed',
        about
          ? `/audit?entityType=${about.entityType}&q=${enc(about.entityId)}`
          : `/audit?entityType=Attachment&q=${enc(p.attachmentId)}`
      );
    case 'users':
      return v(
        `Account administration (${p.action})`,
        // 'create' names the new username, not an id the audit rows are keyed by.
        p.action === 'create' ? null : `/audit?entityType=User&q=${enc(p.id)}`
      );
    case 'routes':
      return v(`Route administration (${p.action})`, '/routes');
    case 'temix':
      return v(`Temix upload queue (${p.action})`, '/temix');
    case 'temix-daily':
      return v(`Daily Temix file ${p.fileId}${rowPart(p.row)}`);
    case 'cron':
      return v(`Scheduled job ${p.job}`);
    case 'script':
      return v(`Operator script ${p.name} (run ${p.runId})`);
    case 'migration':
      return v('History start');
    case 'harness':
      return v(`Test or seed data (${p.source})`);
    case 'sql':
      return v('No recorded cause (changed directly in the database)');
    case 'unknown':
      return { label: p.source, href: null, raw: true };
    case 'malformed':
      // Not an identifier the app writes: its text could be anything, so none of it is shown.
      return v(MALFORMED_SOURCE_LABEL);
  }
}

// ── Who ───────────────────────────────────────────────────

/** His role at that moment: the latest account row from before it, else his first, else today's. */
export function roleAt(userId: string, at: Date, L: HistoryLookups): Role | null {
  const rows = L.userHistory.get(userId) ?? [];
  let found: Role | null = null;
  for (const r of rows) if (r.validFrom.getTime() <= at.getTime()) found = r.role;
  return found ?? rows[0]?.role ?? L.users.get(userId)?.role ?? null;
}

function usernameAt(userId: string, at: Date, L: HistoryLookups): string | null {
  const rows = L.userHistory.get(userId) ?? [];
  let found: string | null = null;
  for (const r of rows) if (r.validFrom.getTime() <= at.getTime()) found = r.username;
  return found ?? rows[0]?.username ?? null;
}

const NO_ACTOR: Record<string, string> = {
  cron: 'Scheduled job',
  script: 'Operator script',
  migration: 'System (history start)',
  'temix-daily': 'Daily Temix file',
  seed: 'Test harness',
  e2e: 'Test harness',
  test: 'Test harness',
  verify: 'Test harness',
};

/** "<name> (<role then>)", "Account <username then>" for an account no longer on record, or the job that ran. */
export function describeActor(actorId: string | null, at: Date, sourceKind: string, L: HistoryLookups): string {
  if (actorId) {
    const u = L.users.get(actorId);
    const role = roleAt(actorId, at, L);
    if (u) return role ? `${u.fullName} (${ROLE_LABELS[role]})` : u.fullName;
    const name = usernameAt(actorId, at, L);
    return name ? `Account ${name}` : 'An account no longer on record';
  }
  return NO_ACTOR[sourceKind] ?? 'Nobody recorded';
}

// ── Values ────────────────────────────────────────────────

/** The database's own rule (docs/HISTORY.md §3): a migration's row is an inference for any time before it was written. */
export function isInferred(row: Pick<HistoryMeta, 'changeKind' | 'sourceKind' | 'validFrom' | 'recordedAt'>): boolean {
  return (
    (row.changeKind === 'BASELINE' || row.sourceKind === 'migration') &&
    row.validFrom.getTime() < row.recordedAt.getTime()
  );
}

function decimalText(v: DecimalLike): string {
  return typeof v === 'object' ? v.toFixed(3) : Number(v).toFixed(3);
}

export function omrText(v: DecimalLike | null | undefined): string {
  return v === null || v === undefined ? '—' : `OMR ${decimalText(v)}`;
}

export function daysText(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n === 1 ? '1 day' : `${n} days`;
}

function valueText(field: string, v: unknown, L: HistoryLookups): string {
  if (v === null || v === undefined) return '—';
  switch (field) {
    case 'paymentTerms':
      return TERMS_LABEL[v as PaymentTerms] ?? String(v);
    case 'creditLimit':
      return omrText(v as DecimalLike);
    case 'paymentTermDays':
      return daysText(v as number);
    case 'status':
      return STATUS_LABEL[v as CustomerStatus] ?? String(v);
    case 'dayOfVisit':
      return DAY_LABEL[v as DayOfWeek] ?? String(v);
    case 'routeId':
      return L.routes.get(v as string)?.code ?? 'a route no longer on record';
    case 'regionId':
      return L.regions.get(v as string)?.code ?? 'a region no longer on record';
    case 'customerId':
    case 'mergedIntoId':
      return L.customers.get(v as string) ?? 'a customer no longer on record';
    case 'channelId':
      return L.channels.get(v as string) ?? 'a channel no longer on record';
    case 'subChannelId':
      return L.subChannels.get(v as string) ?? 'a sub-channel no longer on record';
    case 'equipmentConfirmed':
      return v ? 'yes' : 'no';
    default:
      return String(v);
  }
}

/** One line of a change: "<label>: <from> → <to>", "<label>: <to>", or "<label>: changed". */
export type FieldChange =
  | { kind: 'value'; label: string; from: string; to: string; href?: HistoryHref }
  | { kind: 'set'; label: string; to: string; href?: HistoryHref }
  | { kind: 'changed'; label: string };

const has = (o: Readonly<Record<string, string>>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * What one changed field says. A value only for a VALUE_FIELDS column, read from
 * the history rows; anything else — a personal field, 'gps', a field name this
 * code does not know — is "changed", labelled by its raw name when unknown.
 */
export function fieldChange(
  table: HistoryTable,
  field: string,
  row: object,
  prev: object | null,
  L: HistoryLookups
): FieldChange {
  if (!VALUE_FIELDS[table].has(field)) {
    const names = NAME_ONLY_LABELS[table];
    return { kind: 'changed', label: has(names, field) ? names[field] : field };
  }
  const label = FIELD_LABELS[field as CustomerValueField | BranchValueField];
  const to = (row as Record<string, unknown>)[field];
  const from = prev ? (prev as Record<string, unknown>)[field] : null;
  if (PHOTO_FIELDS.has(field)) {
    // Never the id: which photo is on file is the photo page's business.
    return { kind: 'set', label, to: to == null ? 'removed' : from != null ? 'replaced' : 'added' };
  }
  if (field === 'deletedAt') return { kind: 'set', label, to: to == null ? 'restored' : 'archived' };
  if (field === 'mergedIntoId') {
    return to == null
      ? { kind: 'set', label, to: '—' }
      : { kind: 'set', label, to: valueText(field, to, L), href: `/customers/${enc(String(to))}` };
  }
  // The record's previous row is not among those read (past the read cap): the new value only.
  if (!prev) return { kind: 'set', label, to: valueText(field, to, L) };
  return { kind: 'value', label, from: valueText(field, from, L), to: valueText(field, to, L) };
}

/** The text of a line, as the page shows it. */
export function changeText(c: FieldChange): string {
  if (c.kind === 'changed') return `${c.label}: changed`;
  if (c.kind === 'set') return `${c.label}: ${c.to}`;
  return `${c.label}: ${c.from} → ${c.to}`;
}

function set(label: string, to: string, href?: HistoryHref): FieldChange {
  return href ? { kind: 'set', label, to, href } : { kind: 'set', label, to };
}

/** A customer's terms, status and channel when it was created or found at history start. */
function customerInitial(r: CustomerHistoryRow, L: HistoryLookups): FieldChange[] {
  const out: FieldChange[] = [set('Payment terms', valueText('paymentTerms', r.paymentTerms, L))];
  if (r.creditLimit != null) out.push(set('Credit limit', omrText(r.creditLimit)));
  if (r.paymentTermDays != null) out.push(set('Credit days', daysText(r.paymentTermDays)));
  if (r.temixCode) out.push(set('Temix code', r.temixCode));
  out.push(set('Status', valueText('status', r.status, L)));
  if (r.channelId) out.push(set('Channel', valueText('channelId', r.channelId, L)));
  if (r.subChannelId) out.push(set('Sub-channel', valueText('subChannelId', r.subChannelId, L)));
  if (r.deletedAt) out.push(set('Record', 'archived'));
  if (r.mergedIntoId) out.push(set('Merged into', valueText('mergedIntoId', r.mergedIntoId, L), `/customers/${enc(r.mergedIntoId)}`));
  return out;
}

/** A shop's route, region, day, status and counts when it was created or found at history start. */
function shopInitial(r: BranchHistoryRow, L: HistoryLookups): FieldChange[] {
  const out: FieldChange[] = [
    set('Route', valueText('routeId', r.routeId, L)),
    set('Region', valueText('regionId', r.regionId, L)),
  ];
  if (r.dayOfVisit) out.push(set('Day of visit', valueText('dayOfVisit', r.dayOfVisit, L)));
  out.push(set('Status', valueText('status', r.status, L)));
  out.push(set('Coolers', String(r.coolersCount)));
  out.push(set('Stands', String(r.standsCount)));
  out.push(set('Empty bottles', String(r.emptyBottlesCount)));
  if (r.deletedAt) out.push(set('Record', 'archived'));
  return out;
}

// ── Ordering helpers ──────────────────────────────────────

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Oldest first: validFrom, then id (the interval functions' order). */
export function byValidFromAsc<T extends Pick<HistoryMeta, 'validFrom' | 'id'>>(rows: ReadonlyArray<T>): T[] {
  return [...rows].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime() || cmpBig(a.id, b.id));
}

// ── Routes that served the customer ───────────────────────

export type RouteHolder =
  | { kind: 'person'; name: string; usernameThen: string | null; accountGone: boolean }
  | { kind: 'nobody' }
  | { kind: 'unrecorded' };

export type RoutePeriod = {
  routeId: string | null;
  routeCode: string;
  routeName: string | null;
  holder: RouteHolder;
  from: Date;
  /** The last instant of the stretch (valid_to − 1 ms), so a date shown is its last day; null = now. */
  until: Date | null;
  inferred: boolean;
};

export type ShopRoutes = { branchId: string; branchCode: string; periods: RoutePeriod[] };

export type RouteNote =
  | { kind: 'merged'; from: Date; until: Date | null; mergedIntoId: string | null; mergedIntoCode: string | null; inferred: boolean }
  | { kind: 'no-shop-recorded'; from: Date; to: Date | null; inferred: boolean };

const lastInstant = (to: Date | null) => (to ? new Date(to.getTime() - 1) : null);

/** The holder text: "<name>", "Nobody held the route", "Salesman not recorded". */
export function holderText(h: RouteHolder): string {
  if (h.kind === 'nobody') return 'Nobody held the route';
  if (h.kind === 'unrecorded') return 'Salesman not recorded';
  return h.name;
}

/**
 * nmwc_customer_route_intervals, per shop: shops in the order they first served
 * the customer, each one's stretches oldest first. Rows with no shop are notes
 * about the customer (merged; not on record before history start), left out of
 * a single shop's view.
 */
export function routePeriods(
  intervals: ReadonlyArray<RouteIntervalRow>,
  L: HistoryLookups,
  shopId?: string | null
): { shops: ShopRoutes[]; notes: RouteNote[] } {
  const shops = new Map<string, { branchId: string; codes: Array<[number, string]>; periods: RoutePeriod[] }>();
  const notes: RouteNote[] = [];
  for (const r of intervals) {
    if (!r.branch_id) {
      if (shopId) continue;
      if (r.note === 'merged') {
        notes.push({
          kind: 'merged',
          from: r.valid_from,
          until: lastInstant(r.valid_to),
          mergedIntoId: r.merged_into_id,
          mergedIntoCode: r.merged_into_id ? (L.customers.get(r.merged_into_id) ?? null) : null,
          inferred: r.from_inferred,
        });
      } else if (r.note === 'no-shop-recorded') {
        notes.push({ kind: 'no-shop-recorded', from: r.valid_from, to: r.valid_to, inferred: r.from_inferred });
      }
      continue;
    }
    if (shopId && r.branch_id !== shopId) continue;
    let holder: RouteHolder;
    if (r.note === 'holder-unrecorded') holder = { kind: 'unrecorded' };
    else if (!r.salesman_id) holder = { kind: 'nobody' };
    else {
      const u = L.users.get(r.salesman_id);
      holder = {
        kind: 'person',
        name: u?.fullName ?? `Account ${r.salesman_username ?? 'no longer on record'}`,
        usernameThen: r.salesman_username,
        accountGone: !u,
      };
    }
    const route = r.route_id ? L.routes.get(r.route_id) : undefined;
    const s = shops.get(r.branch_id) ?? { branchId: r.branch_id, codes: [], periods: [] };
    s.periods.push({
      routeId: r.route_id,
      routeCode: r.route_code ?? route?.code ?? 'a route no longer on record',
      routeName: route?.name ?? null,
      holder,
      from: r.valid_from,
      until: lastInstant(r.valid_to),
      inferred: r.from_inferred,
    });
    if (r.branch_code) s.codes.push([r.valid_from.getTime(), r.branch_code]);
    shops.set(r.branch_id, s);
  }
  const out = [...shops.values()].map((s) => {
    s.periods.sort((a, b) => a.from.getTime() - b.from.getTime());
    s.codes.sort((a, b) => a[0] - b[0]);
    return { branchId: s.branchId, branchCode: s.codes.at(-1)?.[1] ?? s.branchId, periods: s.periods };
  });
  out.sort(
    (a, b) =>
      a.periods[0].from.getTime() - b.periods[0].from.getTime() || a.branchCode.localeCompare(b.branchCode, 'en')
  );
  notes.sort((a, b) => a.from.getTime() - b.from.getTime());
  return { shops: out, notes };
}

// ── Terms over time ───────────────────────────────────────

export type TermsPeriod = {
  from: Date;
  until: Date | null;
  cashCredit: string;
  limit: string;
  days: string;
  temixCode: string;
  status: string;
  channel: string;
  record: string;
  mergedIntoId: string | null;
  setBy: { who: string; cause: SourceView };
  inferred: boolean;
};

function termsKey(r: CustomerHistoryRow): string {
  return JSON.stringify([
    r.paymentTerms,
    r.creditLimit == null ? null : decimalText(r.creditLimit),
    r.paymentTermDays,
    r.temixCode,
    r.status,
    r.channelId,
    r.subChannelId,
    r.deletedAt != null,
    r.mergedIntoId,
  ]);
}

/**
 * The customer's cash/credit, limit, days, Temix code, status and channel, one
 * period per stretch in which none of them moved, oldest first. A row superseded
 * at the same instant is skipped; consecutive rows with the same terms are one
 * period (a change of a name, a phone or a photo does not split one).
 */
export function termsPeriods(rows: ReadonlyArray<CustomerHistoryRow>, customerId: string, L: HistoryLookups): TermsPeriod[] {
  const asc = byValidFromAsc(rows);
  const out: TermsPeriod[] = [];
  let open: TermsPeriod | null = null;
  let openKey: string | null = null;
  for (let i = 0; i < asc.length; i++) {
    const r = asc[i];
    if (r.changeKind === 'DELETE') {
      open = null;
      openKey = null;
      continue;
    }
    const to = asc[i + 1]?.validFrom ?? null;
    if (to && to.getTime() <= r.validFrom.getTime()) continue;
    const key = termsKey(r);
    if (open && openKey === key) {
      open.until = lastInstant(to);
      continue;
    }
    const channel = r.channelId ? valueText('channelId', r.channelId, L) : '—';
    const sub = r.subChannelId ? ` / ${valueText('subChannelId', r.subChannelId, L)}` : '';
    openKey = key;
    open = {
      from: r.validFrom,
      until: lastInstant(to),
      cashCredit: TERMS_LABEL[r.paymentTerms],
      limit: omrText(r.creditLimit),
      days: daysText(r.paymentTermDays),
      temixCode: r.temixCode ?? '—',
      status: STATUS_LABEL[r.status],
      channel: `${channel}${sub}`,
      record: r.mergedIntoId
        ? `Merged into ${valueText('mergedIntoId', r.mergedIntoId, L)}`
        : r.deletedAt
          ? 'Archived'
          : 'Live',
      mergedIntoId: r.mergedIntoId,
      setBy: {
        who: describeActor(r.actorId, r.recordedAt, r.sourceKind, L),
        cause: describeSource(r.source, L, { entityType: 'Customer', entityId: customerId }),
      },
      inferred: isInferred(r),
    };
    out.push(open);
  }
  return out;
}

// ── Every change ──────────────────────────────────────────

export type RecordKind = 'created' | 'baseline' | 'changed' | 'moved-in' | 'moved-out' | 'deleted' | 'document';

export type ChangeRecord = {
  /** 'Customer', 'Shop <code>', or a document's name. */
  subject: string;
  kind: RecordKind;
  title: string;
  changes: FieldChange[];
};

export type ChangeEntry = {
  key: string;
  effective: Date;
  recorded: Date;
  /** Say when it was recorded too: an effective date was asked for, or it was written a minute or more apart. */
  showRecorded: boolean;
  inferred: boolean;
  who: string;
  cause: SourceView;
  records: ChangeRecord[];
};

const TITLE: Record<Exclude<RecordKind, 'document'>, string> = {
  created: 'Created',
  baseline: 'On record at history start',
  changed: 'Changed',
  'moved-in': 'Moved to this customer',
  'moved-out': 'Moved to another customer',
  deleted: 'Deleted from the database',
};

type Item = {
  group: string;
  meta: HistoryMeta;
  /** Customer 0, shops 1, documents 2; then the subject. */
  order: number;
  subject: string;
  recordKey: string;
  record: ChangeRecord;
  /** The last row of the record in this group, for a CREATE folded with its UPDATEs. */
  initial?: () => FieldChange[];
  about: SourceAbout;
};

const groupKey = (m: HistoryMeta) => `${m.txId}|${m.source}|${m.validFrom.getTime()}`;

export function documentLabel(kind: AttachmentKind | string): string {
  if (isDecisionBoundKind(kind)) return CREDIT_DOCUMENT_LABELS[kind];
  if (kind === 'CR') return 'CR document';
  if (kind === 'FREE') return 'Extra photo';
  if (kind === 'SHOP') return 'Shop photo';
  if (kind === 'SIGNBOARD') return 'Signboard photo';
  return kind;
}

/** Merge the lines of one record written more than once in the same transaction: first "from", last "to". */
function mergeChanges(lists: FieldChange[][]): FieldChange[] {
  const byLabel = new Map<string, FieldChange>();
  for (const list of lists) {
    for (const c of list) {
      const was = byLabel.get(c.label);
      if (was && was.kind === 'value' && c.kind === 'value') byLabel.set(c.label, { ...c, from: was.from });
      else {
        byLabel.delete(c.label);
        byLabel.set(c.label, c);
      }
    }
  }
  return [...byLabel.values()];
}

/** The items of one entry, folded per record: a CREATE and its UPDATEs read as "Created" with the final values. */
function foldRecords(items: Item[]): ChangeRecord[] {
  const byRecord = new Map<string, Item[]>();
  for (const it of items) {
    const list = byRecord.get(it.recordKey) ?? [];
    list.push(it);
    byRecord.set(it.recordKey, list);
  }
  const folded: Array<{ order: number; subject: string; record: ChangeRecord }> = [];
  for (const list of byRecord.values()) {
    const last = list[list.length - 1];
    const kinds = new Set(list.map((i) => i.record.kind));
    let record: ChangeRecord;
    if (list.length === 1) record = last.record;
    else if (kinds.has('deleted')) record = { ...last.record, kind: 'deleted', title: TITLE.deleted, changes: [] };
    else if (kinds.has('created')) {
      record = { subject: last.record.subject, kind: 'created', title: TITLE.created, changes: last.initial ? last.initial() : [] };
    } else if (kinds.has('moved-out')) record = list.find((i) => i.record.kind === 'moved-out')!.record;
    else if (kinds.has('document')) record = last.record;
    else {
      const kind: RecordKind = kinds.has('moved-in') ? 'moved-in' : kinds.has('baseline') ? 'baseline' : 'changed';
      record = {
        subject: last.record.subject,
        kind,
        title: TITLE[kind as Exclude<RecordKind, 'document'>],
        changes: mergeChanges(list.map((i) => i.record.changes)),
      };
    }
    folded.push({ order: last.order, subject: last.subject, record });
  }
  folded.sort((a, b) => a.order - b.order || a.subject.localeCompare(b.subject, 'en'));
  return folded.map((f) => f.record);
}

/**
 * The timeline: one entry per cause and transaction (txId, source, effective
 * time), newest first. A shop's row is the customer's when the shop was this
 * customer's, or when the shop's previous row was (the move out); its rows from
 * while it was another customer's are never shown.
 */
export function changeEntries(
  input: {
    customerId: string;
    customerRows: ReadonlyArray<CustomerHistoryRow>;
    branchRows: ReadonlyArray<BranchHistoryRow>;
    docRows: ReadonlyArray<DocumentHistoryRow>;
  },
  L: HistoryLookups,
  shopId?: string | null
): ChangeEntry[] {
  const X = input.customerId;
  const items: Item[] = [];
  const aboutCustomer: SourceAbout = { entityType: 'Customer', entityId: X };

  if (!shopId) {
    const asc = byValidFromAsc(input.customerRows);
    asc.forEach((r, i) => {
      const prev = i > 0 ? asc[i - 1] : null;
      let record: ChangeRecord;
      if (r.changeKind === 'BASELINE') record = { subject: 'Customer', kind: 'baseline', title: TITLE.baseline, changes: customerInitial(r, L) };
      else if (r.changeKind === 'CREATE') record = { subject: 'Customer', kind: 'created', title: TITLE.created, changes: customerInitial(r, L) };
      else if (r.changeKind === 'DELETE') record = { subject: 'Customer', kind: 'deleted', title: TITLE.deleted, changes: [] };
      else {
        record = {
          subject: 'Customer',
          kind: 'changed',
          title: TITLE.changed,
          changes: r.changedFields.map((f) => fieldChange('customer', f, r, prev, L)),
        };
      }
      items.push({
        group: groupKey(r),
        meta: r,
        order: 0,
        subject: 'Customer',
        recordKey: 'customer',
        record,
        initial: () => customerInitial(r, L),
        about: aboutCustomer,
      });
    });
  }

  const shops = new Map<string, BranchHistoryRow[]>();
  for (const b of input.branchRows) {
    if (shopId && b.branchId !== shopId) continue;
    const list = shops.get(b.branchId) ?? [];
    list.push(b);
    shops.set(b.branchId, list);
  }
  for (const rows of shops.values()) {
    const asc = byValidFromAsc(rows);
    asc.forEach((r, i) => {
      const prev = i > 0 ? asc[i - 1] : null;
      const mine = r.customerId === X;
      const wasMine = prev?.customerId === X;
      if (!mine && !wasMine) return;
      const subject = `Shop ${r.branchCode}`;
      let record: ChangeRecord;
      if (r.changeKind === 'BASELINE') record = { subject, kind: 'baseline', title: TITLE.baseline, changes: shopInitial(r, L) };
      else if (r.changeKind === 'CREATE') record = { subject, kind: 'created', title: TITLE.created, changes: shopInitial(r, L) };
      else if (r.changeKind === 'DELETE') record = { subject, kind: 'deleted', title: TITLE.deleted, changes: [] };
      else if (wasMine && !mine) {
        // The move out: what it became is the other customer's.
        record = { subject, kind: 'moved-out', title: TITLE['moved-out'], changes: [fieldChange('shop', 'customerId', r, prev, L)] };
      } else if (prev && !wasMine && mine) {
        record = {
          subject,
          kind: 'moved-in',
          title: TITLE['moved-in'],
          changes: r.changedFields.map((f) => fieldChange('shop', f, r, prev, L)),
        };
      } else {
        record = {
          subject,
          kind: 'changed',
          title: TITLE.changed,
          changes: r.changedFields.map((f) => fieldChange('shop', f, r, prev, L)),
        };
      }
      items.push({
        group: groupKey(r),
        meta: r,
        order: 1,
        subject: r.branchCode,
        recordKey: `shop:${r.branchId}`,
        record,
        initial: () => shopInitial(r, L),
        about: { entityType: 'Branch', entityId: r.branchId },
      });
    });
  }

  if (!shopId) {
    const docs = new Map<string, DocumentHistoryRow[]>();
    for (const d of input.docRows) {
      const list = docs.get(d.attachmentId) ?? [];
      list.push(d);
      docs.set(d.attachmentId, list);
    }
    for (const rows of docs.values()) {
      const asc = byValidFromAsc(rows);
      asc.forEach((r, i) => {
        const prev = i > 0 ? asc[i - 1] : null;
        // A document on file when history began is not a change.
        if (r.changeKind === 'BASELINE') return;
        const title =
          r.changeKind === 'DELETE'
            ? 'purged'
            : !prev
              ? 'attached'
              : prev.deletedAt == null && r.deletedAt != null
                ? 'removed'
                : prev.deletedAt != null && r.deletedAt == null
                  ? 'restored'
                  : 'updated';
        const subject = documentLabel(r.kind);
        items.push({
          group: groupKey(r),
          meta: r,
          order: 2,
          subject,
          recordKey: `doc:${r.attachmentId}`,
          record: { subject, kind: 'document', title, changes: [] },
          about: { entityType: 'Attachment', entityId: r.attachmentId },
        });
      });
    }
  }

  const groups = new Map<string, Item[]>();
  for (const it of items) {
    const list = groups.get(it.group) ?? [];
    list.push(it);
    groups.set(it.group, list);
  }
  const entries: ChangeEntry[] = [];
  const maxIds = new Map<string, bigint>();
  for (const [key, list] of groups) {
    // Within the entry: the customer first, then shops by code, then documents.
    list.sort((a, b) => a.order - b.order || a.subject.localeCompare(b.subject, 'en') || cmpBig(a.meta.id, b.meta.id));
    const first = list[0];
    const effective = first.meta.validFrom;
    const recorded = new Date(Math.min(...list.map((i) => i.meta.recordedAt.getTime())));
    entries.push({
      key,
      effective,
      recorded,
      showRecorded:
        list.some((i) => i.meta.effectiveRequested != null) ||
        Math.abs(recorded.getTime() - effective.getTime()) >= RECORDED_APART_MS,
      inferred: list.some((i) => isInferred(i.meta)),
      who: describeActor(first.meta.actorId, first.meta.recordedAt, first.meta.sourceKind, L),
      cause: describeSource(first.meta.source, L, first.about),
      records: foldRecords(list),
    });
    maxIds.set(key, list.reduce((m, i) => (i.meta.id > m ? i.meta.id : m), first.meta.id));
  }
  entries.sort(
    (a, b) =>
      b.effective.getTime() - a.effective.getTime() ||
      b.recorded.getTime() - a.recorded.getTime() ||
      cmpBig(maxIds.get(b.key)!, maxIds.get(a.key)!)
  );
  return entries;
}

// ── How it came to be ─────────────────────────────────────

export type CreationView = {
  kind: 'created' | 'baseline' | 'moved-in' | 'first-row' | 'none';
  /** The one-paragraph summary. */
  text: string;
  at: Date | null;
  cause: SourceView | null;
  /** "Lineage on file: …" for a customer found at history start. */
  lineage: string | null;
  inferred: boolean;
};

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** "<Created | Shop X created> <when> by <cause>, approved by <who>." */
function createdSentence(lead: string, row: HistoryMeta, L: HistoryLookups, about: SourceAbout): { text: string; cause: SourceView } {
  const cause = describeSource(row.source, L, about);
  const who = describeActor(row.actorId, row.recordedAt, row.sourceKind, L);
  const at = omanDateTime(row.validFrom);
  const p = parseSource(row.source);
  if (p.kind === 'sql') return { text: `${lead} ${at}; no cause was recorded (changed directly in the database).`, cause };
  let by = '';
  if (p.kind === 'edit' && L.edits.get(p.editId)?.process === 'CREATE') by = `, approved by ${who}`;
  else if (p.kind === 'import') by = `, promoted by ${who}`;
  else if (row.actorId) by = `, ${who}`;
  return { text: `${lead} ${at} by ${lowerFirst(cause.label)}${by}.`, cause };
}

/** "<On record | Shop X on record> at history start (<day>). In the CRM since <day>; …" */
function baselineSentence(lead: string, row: HistoryMeta): string {
  return (
    `${lead} at history start (${omanDate(row.recordedAt)}). ` +
    `In the CRM since ${omanDate(row.validFrom)}; how it was created was not recorded before history began.`
  );
}

/**
 * The customer's first history row, said in words: created by a request (and
 * approved by whom), by an import row, or by something else; or, for a customer
 * that existed when history began, on record from then, with the lineage the
 * live row still carries.
 */
export function creationEntry(
  birth: CustomerHistoryRow | null,
  L: HistoryLookups,
  live: { id: string; importBatchId: string | null; createdById: string | null }
): CreationView {
  if (!birth) {
    return { kind: 'none', text: 'No history is on record for this customer.', at: null, cause: null, lineage: null, inferred: false };
  }
  const about: SourceAbout = { entityType: 'Customer', entityId: live.id };
  if (birth.changeKind === 'BASELINE') {
    const parts: string[] = [];
    if (live.importBatchId) parts.push(`import ${L.batches.get(live.importBatchId)?.filename ?? live.importBatchId}`);
    if (live.createdById) parts.push(`created by ${L.users.get(live.createdById)?.fullName ?? 'an account no longer on record'}`);
    return {
      kind: 'baseline',
      text: baselineSentence('On record', birth),
      at: birth.validFrom,
      cause: null,
      lineage: parts.length > 0 ? `Lineage on file: ${parts.join(' / ')}` : null,
      inferred: isInferred(birth),
    };
  }
  if (birth.changeKind === 'CREATE') {
    const { text, cause } = createdSentence('Created', birth, L, about);
    return {
      kind: 'created',
      text,
      at: birth.validFrom,
      cause,
      lineage: null,
      inferred: isInferred(birth),
    };
  }
  const cause = describeSource(birth.source, L, about);
  return {
    kind: 'first-row',
    text: `First on record ${omanDateTime(birth.validFrom)}: ${lowerFirst(cause.label)}.`,
    at: birth.validFrom,
    cause,
    lineage: null,
    inferred: isInferred(birth),
  };
}

/** A shop's first row on this customer: created, on record at history start, or moved in from another customer. */
export function shopCreationEntry(
  rows: ReadonlyArray<BranchHistoryRow>,
  customerId: string,
  shopId: string,
  L: HistoryLookups
): CreationView {
  const asc = byValidFromAsc(rows.filter((r) => r.branchId === shopId));
  const i = asc.findIndex((r) => r.customerId === customerId);
  if (i < 0) {
    return { kind: 'none', text: 'No history is on record for this shop.', at: null, cause: null, lineage: null, inferred: false };
  }
  const r = asc[i];
  const subject = `Shop ${r.branchCode}`;
  const about: SourceAbout = { entityType: 'Branch', entityId: r.branchId };
  if (r.changeKind === 'BASELINE') {
    return { kind: 'baseline', text: baselineSentence(`${subject} on record`, r), at: r.validFrom, cause: null, lineage: null, inferred: isInferred(r) };
  }
  if (r.changeKind === 'CREATE') {
    const { text, cause } = createdSentence(`${subject} created`, r, L, about);
    return { kind: 'created', text, at: r.validFrom, cause, lineage: null, inferred: isInferred(r) };
  }
  const cause = describeSource(r.source, L, about);
  const prev = i > 0 ? asc[i - 1] : null;
  if (prev) {
    const from = valueText('customerId', prev.customerId, L);
    return {
      kind: 'moved-in',
      text: `${subject} moved to this customer from ${from} ${omanDateTime(r.validFrom)} by ${lowerFirst(cause.label)}.`,
      at: r.validFrom,
      cause,
      lineage: null,
      inferred: isInferred(r),
    };
  }
  return {
    kind: 'first-row',
    text: `${subject} first on record ${omanDateTime(r.validFrom)}: ${lowerFirst(cause.label)}.`,
    at: r.validFrom,
    cause,
    lineage: null,
    inferred: isInferred(r),
  };
}

// ── Pages ─────────────────────────────────────────────────

export type Paged<T> = { items: T[]; page: number; pages: number; total: number };

/** One page of a list; the page is clamped to 1 … the last page. */
export function paginate<T>(list: ReadonlyArray<T>, page: number, size: number = PAGE_SIZE): Paged<T> {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const p = Math.min(pages, Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1));
  return { items: list.slice((p - 1) * size, p * size), page: p, pages, total: list.length };
}

// ── The whole page ────────────────────────────────────────

/**
 * A shop of the picker. `standing`: still this customer's and live, archived
 * (still this customer's), moved to another customer since, or no longer in the
 * database. Its current name only while it is this customer's and live.
 */
export type ShopChoice = {
  id: string;
  code: string;
  name: string | null;
  current: boolean;
  standing: 'current' | 'archived' | 'moved' | 'gone';
};

export type RawCustomerHistory = {
  customer: {
    id: string;
    nmwcCode: string;
    legalName: string;
    deletedAt: Date | null;
    mergedIntoId: string | null;
    importBatchId: string | null;
    createdById: string | null;
  };
  /** Newest first, as read (at most READ_CAP + 1). */
  customerRows: ReadonlyArray<CustomerHistoryRow>;
  /** The customer's first row, read on its own so it survives the cap. */
  birth: CustomerHistoryRow | null;
  intervals: ReadonlyArray<RouteIntervalRow>;
  /** Every shop that was ever this customer's. */
  shopIds: ReadonlyArray<string>;
  /** Every row of those shops (in a shop's view, of that shop), newest first (at most READ_CAP + 1). */
  branchRows: ReadonlyArray<BranchHistoryRow>;
  /** Newest first (at most READ_CAP + 1); empty in a shop's view. */
  docRows: ReadonlyArray<DocumentHistoryRow>;
  liveShops: ReadonlyArray<{ id: string; customerId: string; branchCode: string; branchName: string; deletedAt: Date | null }>;
  lookups: HistoryLookups;
};

export type CustomerHistoryView = {
  customer: {
    id: string;
    nmwcCode: string;
    legalName: string;
    live: boolean;
    archivedAt: Date | null;
    mergedInto: { id: string; code: string } | null;
  };
  /** When history began for this customer: its first row was found, not recorded (a baseline). */
  historyStart: Date | null;
  shops: ShopChoice[];
  shop: ShopChoice | null;
  created: CreationView;
  routes: { shops: ShopRoutes[]; notes: RouteNote[] };
  /** Customer-level: null in a shop's view. */
  terms: TermsPeriod[] | null;
  timeline: Paged<ChangeEntry>;
  truncated: boolean;
};

/** Null when ?shop= names a shop that was never this customer's. */
export function assembleCustomerHistory(
  raw: RawCustomerHistory,
  opts: { shopId: string | null; page: number }
): CustomerHistoryView | null {
  const X = raw.customer.id;
  const L = raw.lookups;
  if (opts.shopId && !raw.shopIds.includes(opts.shopId)) return null;
  // Only the lists this view lists: a shop's view shows none of the customer's own rows.
  const shown = opts.shopId ? [raw.branchRows] : [raw.customerRows, raw.branchRows, raw.docRows];
  const truncated = shown.some((l) => l.length > READ_CAP);
  const customerRows = raw.customerRows.slice(0, READ_CAP);
  const branchRows = raw.branchRows.slice(0, READ_CAP);
  const docRows = raw.docRows.slice(0, READ_CAP);

  const live = new Map(raw.liveShops.map((s) => [s.id, s]));
  const shops: ShopChoice[] = raw.shopIds.map((id) => {
    const own = byValidFromAsc(branchRows.filter((b) => b.branchId === id && b.customerId === X));
    const any = own.length > 0 ? own : byValidFromAsc(branchRows.filter((b) => b.branchId === id));
    const fromIntervals = raw.intervals.find((i) => i.branch_id === id && i.branch_code)?.branch_code ?? null;
    const l = live.get(id);
    const standing: ShopChoice['standing'] = !l ? 'gone' : l.customerId !== X ? 'moved' : l.deletedAt ? 'archived' : 'current';
    const current = standing === 'current';
    // Its code while it was this customer's; in a shop's view only that shop's rows are read.
    const code = any.at(-1)?.branchCode ?? fromIntervals ?? l?.branchCode ?? id;
    return { id, code, name: current && l ? l.branchName : null, current, standing };
  });
  shops.sort((a, b) => a.code.localeCompare(b.code, 'en'));
  const shop = opts.shopId ? (shops.find((s) => s.id === opts.shopId) ?? null) : null;

  const mergedIntoId = raw.customer.mergedIntoId;
  const birthInferred = raw.birth ? isInferred(raw.birth) : false;
  return {
    customer: {
      id: X,
      nmwcCode: raw.customer.nmwcCode,
      legalName: raw.customer.legalName,
      live: raw.customer.deletedAt === null,
      archivedAt: mergedIntoId ? null : raw.customer.deletedAt,
      mergedInto: mergedIntoId ? { id: mergedIntoId, code: L.customers.get(mergedIntoId) ?? mergedIntoId } : null,
    },
    historyStart: raw.birth && birthInferred ? raw.birth.recordedAt : null,
    shops,
    shop,
    created: opts.shopId
      ? shopCreationEntry(branchRows, X, opts.shopId, L)
      : creationEntry(raw.birth, L, { id: X, importBatchId: raw.customer.importBatchId, createdById: raw.customer.createdById }),
    routes: routePeriods(raw.intervals, L, opts.shopId),
    terms: opts.shopId ? null : termsPeriods(customerRows, X, L),
    timeline: paginate(
      changeEntries({ customerId: X, customerRows, branchRows, docRows: opts.shopId ? [] : docRows }, L, opts.shopId),
      opts.page
    ),
    truncated,
  };
}
