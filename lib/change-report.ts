/**
 * Field-update report (go-live, 2026-09-10).
 *
 * The owner's question after the field force has been enriching customers is
 * "what did they edit, and what did they NOT edit?". This report answers it in
 * one workbook:
 *
 *   Sheet "Customers"   — the customer master in the import shape (one row per
 *                         branch, every customer code + name in scope). Every
 *                         cell changed by an APPROVED enrichment edit inside the
 *                         window is filled YELLOW (with a note "was → now, by,
 *                         when"); a cell with a PENDING (submitted, undecided)
 *                         proposal is filled ORANGE (the cell still shows the
 *                         current value — the proposal is in sheet 2); a photo
 *                         slot filled inside the window is YELLOW too.
 *   Sheet "Changes"     — one row per field change: before → after, who
 *                         submitted, who approved, when. Photos added appear as
 *                         rows as well.
 *   Sheet "By salesman" — per-salesman totals (customers updated, fields
 *                         changed, photos added, GPS captured, pending).
 *   Sheet "Legend"      — window, scope, colours.
 *
 * Source of truth for "changed" is CustomerEdit.fieldChanges (the frozen diff
 * the approver saw) — NOT Customer.updatedAt, which also moves on imports,
 * photo wiring and completeness rescoring.
 *
 * Role scope is the export scope (lib/export-scope.ts): Supervisor = team
 * routes, Manager = managed regions, Steward/Viewer = org-wide.
 */
import { EditState, EditProcess, type Prisma, type Role } from '@prisma/client';
import { prisma } from './db';
import { openStreamedWorkbook, escapeFormulaCell } from './excel';
import { resolveExportScope, scopedBranchWhere } from './export-scope';
import { ForbiddenError } from './errors';
import { logger } from './logger';
import { mapPinHref } from './contact-links';
import { keysetPages } from './keyset';

export type ChangeReportFilters = {
  /** Window start (inclusive). Defaults to the beginning of time. */
  since?: Date;
  /** Window end (inclusive). Defaults to now. */
  until?: Date;
  regionIds?: string[];
  routeIds?: string[];
  /** Drop rows without any highlight (default: keep every customer in scope). */
  onlyChanged?: boolean;
  /** Also mark SUBMITTED (undecided) proposals in orange (default: true). */
  includePending?: boolean;
};

/**
 * Item 28: the largest report one file may hold. It was 25,000 with the master at
 * 20,596, because the whole styled workbook lived in memory. The writer now
 * streams. What was measured (2026-09-25): the streaming writer on the platform,
 * 60,000 export-shaped rows in 13 s at 637 MB; and this report's own workbook
 * shape (42 columns, fills, notes, links) benchmarked locally at 60,000 rows,
 * 19.8 s and 896 MB — about 30 s on the platform by the same calibration. With the
 * paged reads, an ESTIMATED 35-40 s: inside the 60 s budget, with less margin than
 * the export has. Re-measure before raising it.
 */
export const CHANGE_REPORT_ROW_CEILING = 60_000;
/** Branch rows per database page. */
const REPORT_PAGE_SIZE = 2000;

const FILL_APPROVED = 'FFFFFF00'; // yellow — approved & applied
const FILL_PENDING = 'FFFFC000'; // orange — submitted, awaiting decision
const FILL_HEADER = 'FFD9E1F2';

type ApprovalRow = { cust_code: string; branch_code: string; decision: string; decided_by: string };
type ApprovalIndex = Map<string, { branch_code: string; decided_by: string }[]>;

/**
 * "approved_by" is per edit, not per cell — read off the change rows. Indexed by
 * customer once (item 28): scanning every change row for every branch row was
 * rows × changes, which grows with the org AND with time.
 */
export function approvalIndex(changeRows: readonly ApprovalRow[]): ApprovalIndex {
  const index: ApprovalIndex = new Map();
  for (const r of changeRows) {
    if (r.decision !== 'APPROVED' || !r.decided_by) continue;
    const list = index.get(r.cust_code) ?? [];
    list.push({ branch_code: r.branch_code, decided_by: r.decided_by });
    index.set(r.cust_code, list);
  }
  return index;
}

/** Who approved changes on this row: the customer-level ones and this branch's own, first-seen order. */
export function approvedByFor(index: ApprovalIndex, custCode: string, branchCode: string): string {
  const who = (index.get(custCode) ?? [])
    .filter((r) => r.branch_code === '' || r.branch_code === branchCode)
    .map((r) => r.decided_by);
  return [...new Set(who)].join(', ');
}

type Col = { key: string; header: string; width: number };
const COLUMNS: Col[] = [
  { key: 'cust_code', header: 'cust_code', width: 14 },
  { key: 'cust_name', header: 'cust_name', width: 32 },
  { key: 'branch_code', header: 'branch_code', width: 16 },
  { key: 'branch_name', header: 'branch_name', width: 28 },
  { key: 'sales_region', header: 'sales_region', width: 14 },
  { key: 'route', header: 'route', width: 10 },
  { key: 'salesman', header: 'salesman', width: 12 },
  { key: 'payment_terms', header: 'payment_terms', width: 12 },
  { key: 'customer_status', header: 'customer_status', width: 14 },
  { key: 'branch_status', header: 'branch_status', width: 13 },
  { key: 'channel', header: 'channel', width: 18 },
  { key: 'sub_channel', header: 'sub_channel', width: 18 },
  { key: 'phone', header: 'phone', width: 14 },
  { key: 'alt_phone', header: 'alt_phone', width: 14 },
  { key: 'contact_person', header: 'contact_person', width: 22 },
  { key: 'contact_role', header: 'contact_role', width: 14 },
  { key: 'cr_no', header: 'cr_no', width: 14 },
  { key: 'cr_photo', header: 'cr_photo', width: 9 },
  { key: 'address', header: 'address', width: 36 },
  { key: 'area_description', header: 'area_description', width: 24 },
  { key: 'gps_lat', header: 'gps_lat', width: 11 },
  { key: 'gps_lng', header: 'gps_lng', width: 11 },
  { key: 'gps_accuracy_m', header: 'gps_accuracy_m', width: 10 },
  { key: 'gps_captured_at', header: 'gps_captured_at', width: 18 },
  { key: 'gps_map', header: 'gps_map', width: 8 },
  { key: 'day_of_visit', header: 'day_of_visit', width: 11 },
  { key: 'opening_hours', header: 'opening_hours', width: 14 },
  { key: 'delivery_window', header: 'delivery_window', width: 14 },
  { key: 'coolers', header: 'coolers', width: 8 },
  { key: 'stands', header: 'stands', width: 8 },
  { key: 'empty_bottles', header: 'empty_bottles', width: 10 },
  { key: 'shop_photo', header: 'shop_photo', width: 10 },
  { key: 'signboard_photo', header: 'signboard_photo', width: 12 },
  { key: 'other_photos', header: 'other_photos', width: 10 },
  { key: 'notes', header: 'notes', width: 30 },
  { key: 'completeness_pct', header: 'completeness_pct', width: 12 },
  // Change summary (per row)
  { key: 'changed_fields', header: 'changed_fields', width: 36 },
  { key: 'changed_by', header: 'changed_by', width: 14 },
  { key: 'changed_at', header: 'changed_at', width: 18 },
  { key: 'approved_by', header: 'approved_by', width: 14 },
  { key: 'pending_fields', header: 'pending_fields', width: 30 },
  { key: 'pending_by', header: 'pending_by', width: 14 },
];

/** CustomerEdit.fieldChanges field name → report column (customer-level). */
const CUSTOMER_FIELD_COL: Record<string, string> = {
  legalName: 'cust_name',
  paymentTerms: 'payment_terms',
  crNumber: 'cr_no',
  channelId: 'channel',
  subChannelId: 'sub_channel',
  primaryPhone: 'phone',
  altPhone: 'alt_phone',
  contactPerson: 'contact_person',
  contactRole: 'contact_role',
  status: 'customer_status',
  notes: 'notes',
};
/** … → report column (branch-level). */
const BRANCH_FIELD_COL: Record<string, string> = {
  branchName: 'branch_name',
  address: 'address',
  areaDescription: 'area_description',
  gpsLat: 'gps_lat',
  gpsLng: 'gps_lng',
  gpsAccuracy: 'gps_accuracy_m',
  gpsCapturedAt: 'gps_captured_at',
  dayOfVisit: 'day_of_visit',
  openingHours: 'opening_hours',
  deliveryWindow: 'delivery_window',
  coolersCount: 'coolers',
  standsCount: 'stands',
  emptyBottlesCount: 'empty_bottles',
  status: 'branch_status',
};

type FieldChange = { field: string; before: unknown; after: unknown };

type Mark = {
  state: 'APPROVED' | 'PENDING';
  by: string;
  at: Date | null;
  before: unknown;
  after: unknown;
};

/** Oman wall-clock, unambiguous in a spreadsheet: "2026-09-13 14:05". */
// One formatter for the whole report: building an Intl.DateTimeFormat per call cost
// about 2.7 s over a 60,000-row report (item 28 benchmark).
const OMAN_STAMP = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Muscat',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function omanStamp(d: Date | null | undefined): string {
  if (!d) return '';
  const parts = OMAN_STAMP.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function inWindow(d: Date | null | undefined, since: Date, until: Date): boolean {
  return !!d && d.getTime() >= since.getTime() && d.getTime() <= until.getTime();
}

function fmt(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return omanStamp(v);
  if (typeof v === 'string') {
    // gpsCapturedAt arrives as an ISO string in the frozen diff.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v))) {
      return omanStamp(new Date(v));
    }
    return v;
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6);
  return JSON.stringify(v);
}

export async function buildChangeReport(
  me: { id: string; role: Role; username: string },
  filters: ChangeReportFilters,
  // Rows per database page; smaller only in tests, to cross page boundaries on a small fixture.
  { pageSize = REPORT_PAGE_SIZE }: { pageSize?: number } = {}
) {
  const scope = await resolveExportScope(me);
  const branchWhere = scopedBranchWhere(scope, filters);
  const since = filters.since ?? new Date(0);
  const until = filters.until ?? new Date();
  const includePending = filters.includePending !== false;

  const total = await prisma.branch.count({
    where: { ...branchWhere, customer: { deletedAt: null } },
  });
  if (total > CHANGE_REPORT_ROW_CEILING) {
    throw new ForbiddenError(
      `Report too large: ${total} rows. One report holds up to ${CHANGE_REPORT_ROW_CEILING.toLocaleString('en-US')} rows — narrow by region or route.`
    );
  }

  // ── Reference data (small tables) ────────────────────────────────────────
  const [channels, subChannels, salesmen] = await Promise.all([
    prisma.channel.findMany({ select: { id: true, label: true } }),
    prisma.subChannel.findMany({ select: { id: true, label: true } }),
    prisma.user.findMany({
      where: { ownedRouteId: { not: null } },
      select: { ownedRouteId: true, username: true, fullName: true, isActive: true },
    }),
  ]);
  const refLabel = new Map<string, string>([
    ...channels.map((c) => [c.id, c.label] as const),
    ...subChannels.map((s) => [s.id, s.label] as const),
  ]);
  const salesmanByRoute = new Map<string, { username: string; fullName: string }>();
  for (const s of salesmen) {
    if (!s.ownedRouteId) continue;
    // Prefer the active owner if a route was handed over.
    if (!salesmanByRoute.has(s.ownedRouteId) || s.isActive) {
      salesmanByRoute.set(s.ownedRouteId, { username: s.username, fullName: s.fullName });
    }
  }
  const labelOf = (field: string, v: unknown): string =>
    (field.endsWith('channelId') || field.endsWith('subChannelId')) &&
    typeof v === 'string' &&
    refLabel.has(v)
      ? refLabel.get(v)!
      : fmt(v);

  // ── The master rows (one per live branch in scope) ────────────────────────
  // Item 28: read a page at a time by branch code (strictly after the last one
  // read — lib/keyset.ts), so no query's relation lookups become IN-lists of every
  // customer id in the org; then order as the report always has, by route code
  // then branch code. One pass over one key: a branch re-routed mid-read cannot
  // appear twice or vanish, as it could when routes were read one by one.
  const include = {
    customer: {
      include: {
        channel: { select: { label: true } },
        subChannel: { select: { label: true } },
        crPhoto: { select: { id: true, createdAt: true, capturedById: true } },
      },
    },
    region: { select: { name: true, code: true } },
    route: { select: { id: true, code: true } },
    shopPhoto: { select: { id: true, createdAt: true, capturedById: true } },
    signboardPhoto: { select: { id: true, createdAt: true, capturedById: true } },
  } satisfies Prisma.BranchInclude;
  const pageOf = (last: { branchCode: string } | undefined) =>
    prisma.branch.findMany({
      where: {
        AND: [branchWhere, ...(last ? [{ branchCode: { gt: last.branchCode } }] : [])],
        customer: { deletedAt: null },
      },
      orderBy: { branchCode: 'asc' },
      take: pageSize,
      include,
    });
  const branches: Awaited<ReturnType<typeof pageOf>> = [];
  for await (const page of keysetPages(pageOf, pageSize)) branches.push(...page);
  // Stable: within a route, the database's branch-code order is kept.
  branches.sort((a, b) => (a.route.code < b.route.code ? -1 : a.route.code > b.route.code ? 1 : 0));
  const customerIds = new Set(branches.map((b) => b.customerId));
  const branchById = new Map(branches.map((b) => [b.id, b] as const));

  // Extra ("other") photos are few org-wide; filter in memory rather than
  // shipping 20k ids in an IN list.
  const extras = await prisma.attachment.findMany({
    where: { branchExtraId: { not: null }, deletedAt: null },
    select: { branchExtraId: true, createdAt: true, capturedById: true },
  });
  const extrasByBranch = new Map<string, { createdAt: Date; capturedById: string }[]>();
  for (const a of extras) {
    if (!a.branchExtraId || !branchById.has(a.branchExtraId)) continue;
    const list = extrasByBranch.get(a.branchExtraId) ?? [];
    list.push({ createdAt: a.createdAt, capturedById: a.capturedById });
    extrasByBranch.set(a.branchExtraId, list);
  }

  // ── The edits that define "changed" ──────────────────────────────────────
  const edits = await prisma.customerEdit.findMany({
    where: {
      process: EditProcess.UPDATE,
      customerId: { not: null },
      OR: [
        { state: EditState.APPROVED, reviewedAt: { gte: since, lte: until } },
        ...(includePending ? [{ state: EditState.SUBMITTED }] : []),
      ],
    },
    select: {
      id: true,
      customerId: true,
      state: true,
      fieldChanges: true,
      submittedAt: true,
      reviewedAt: true,
      submittedBy: { select: { id: true, username: true, fullName: true } },
      reviewedBy: { select: { username: true, fullName: true } },
    },
    orderBy: [{ reviewedAt: 'asc' }, { submittedAt: 'asc' }],
  });
  const scopedEdits = edits.filter((e) => e.customerId && customerIds.has(e.customerId));

  // Photo captors → usernames (for "by" on photo highlights).
  const captorIds = new Set<string>();
  for (const b of branches) {
    for (const p of [b.shopPhoto, b.signboardPhoto, b.customer.crPhoto]) {
      if (p && inWindow(p.createdAt, since, until)) captorIds.add(p.capturedById);
    }
    for (const x of extrasByBranch.get(b.id) ?? []) {
      if (inWindow(x.createdAt, since, until)) captorIds.add(x.capturedById);
    }
  }
  const captors = captorIds.size
    ? await prisma.user.findMany({
        where: { id: { in: [...captorIds] } },
        select: { id: true, username: true, fullName: true },
      })
    : [];
  const captorById = new Map(captors.map((u) => [u.id, u] as const));

  // ── Resolve marks per branch row ──────────────────────────────────────────
  // customer-level marks apply to every branch row of that customer.
  const customerMarks = new Map<string, Map<string, Mark>>();
  const branchMarks = new Map<string, Map<string, Mark>>();
  const setMark = (bucket: Map<string, Map<string, Mark>>, id: string, col: string, m: Mark) => {
    const marks = bucket.get(id) ?? new Map<string, Mark>();
    const prev = marks.get(col);
    // A pending proposal on top of an approved change wins the colour (the
    // reviewer still has to act); the note keeps both facts.
    if (!prev || m.state === 'PENDING' || prev.state !== 'PENDING') marks.set(col, m);
    bucket.set(id, marks);
  };

  type ChangeRow = {
    cust_code: string;
    cust_name: string;
    branch_code: string;
    field: string;
    before: string;
    after: string;
    decision: string;
    submitted_by: string;
    submitted_at: string;
    decided_by: string;
    decided_at: string;
  };
  const changeRows: ChangeRow[] = [];
  const customerNameById = new Map<string, { code: string; name: string }>();
  for (const b of branches) {
    customerNameById.set(b.customerId, { code: b.customer.nmwcCode, name: b.customer.legalName });
  }

  // Per-salesman tallies.
  type Tally = {
    username: string;
    fullName: string;
    customers: Set<string>;
    approvedEdits: number;
    pendingEdits: number;
    fieldsChanged: number;
    gpsCaptured: number;
    photosAdded: number;
  };
  const tally = new Map<string, Tally>();
  const tallyFor = (u: { id: string; username: string; fullName: string }) => {
    let t = tally.get(u.id);
    if (!t) {
      t = {
        username: u.username,
        fullName: u.fullName,
        customers: new Set(),
        approvedEdits: 0,
        pendingEdits: 0,
        fieldsChanged: 0,
        gpsCaptured: 0,
        photosAdded: 0,
      };
      tally.set(u.id, t);
    }
    return t;
  };

  for (const e of scopedEdits) {
    const changes = (Array.isArray(e.fieldChanges) ? e.fieldChanges : []) as FieldChange[];
    const state: Mark['state'] = e.state === EditState.APPROVED ? 'APPROVED' : 'PENDING';
    const by = e.submittedBy.username;
    const at = state === 'APPROVED' ? e.reviewedAt : e.submittedAt;
    const t = tallyFor(e.submittedBy);
    if (state === 'APPROVED') {
      t.approvedEdits += 1;
      t.customers.add(e.customerId!);
    } else {
      t.pendingEdits += 1;
    }
    const cust = customerNameById.get(e.customerId!) ?? { code: '', name: '' };
    for (const c of changes) {
      let col: string | undefined;
      let branchCode = '';
      let fieldLabel = c.field;
      if (c.field.startsWith('customer.')) {
        const f = c.field.slice('customer.'.length);
        col = CUSTOMER_FIELD_COL[f];
        fieldLabel = col ?? f;
        if (col) setMark(customerMarks, e.customerId!, col, { state, by, at, before: c.before, after: c.after });
      } else if (c.field.startsWith('branch.')) {
        const rest = c.field.slice('branch.'.length);
        const dot = rest.indexOf('.');
        if (dot < 0) continue;
        const branchId = rest.slice(0, dot);
        const f = rest.slice(dot + 1);
        col = BRANCH_FIELD_COL[f];
        fieldLabel = col ?? f;
        branchCode = branchById.get(branchId)?.branchCode ?? '(branch no longer in scope)';
        if (col) {
          setMark(branchMarks, branchId, col, { state, by, at, before: c.before, after: c.after });
          if (col === 'gps_lat' || col === 'gps_lng') {
            setMark(branchMarks, branchId, 'gps_map', { state, by, at, before: c.before, after: c.after });
          }
        }
        if (state === 'APPROVED' && f === 'gpsLat') t.gpsCaptured += 1;
      }
      if (state === 'APPROVED') t.fieldsChanged += 1;
      changeRows.push({
        cust_code: cust.code,
        cust_name: cust.name,
        branch_code: branchCode,
        field: fieldLabel,
        before: labelOf(c.field, c.before),
        after: labelOf(c.field, c.after),
        decision: state === 'APPROVED' ? 'APPROVED' : 'PENDING',
        submitted_by: by,
        submitted_at: omanStamp(e.submittedAt),
        decided_by: state === 'APPROVED' ? (e.reviewedBy?.username ?? '') : '',
        decided_at: state === 'APPROVED' ? omanStamp(e.reviewedAt) : '',
      });
    }
  }

  // Photos added inside the window (wired at capture time, outside the edit).
  const photoMark = (
    bucket: Map<string, Map<string, Mark>>,
    id: string,
    col: string,
    p: { createdAt: Date; capturedById: string } | null | undefined,
    cust: { code: string; name: string },
    branchCode: string
  ) => {
    if (!p || !inWindow(p.createdAt, since, until)) return;
    const u = captorById.get(p.capturedById);
    const by = u?.username ?? p.capturedById;
    setMark(bucket, id, col, { state: 'APPROVED', by, at: p.createdAt, before: '', after: 'yes' });
    if (u) {
      const t = tallyFor(u);
      t.photosAdded += 1;
    }
    changeRows.push({
      cust_code: cust.code,
      cust_name: cust.name,
      branch_code: branchCode,
      field: col,
      before: '',
      after: 'photo added',
      decision: 'ADDED',
      submitted_by: by,
      submitted_at: omanStamp(p.createdAt),
      decided_by: '',
      decided_at: '',
    });
  };
  const crPhotoSeen = new Set<string>();
  for (const b of branches) {
    const cust = { code: b.customer.nmwcCode, name: b.customer.legalName };
    if (!crPhotoSeen.has(b.customerId)) {
      crPhotoSeen.add(b.customerId);
      photoMark(customerMarks, b.customerId, 'cr_photo', b.customer.crPhoto, cust, '');
    }
    photoMark(branchMarks, b.id, 'shop_photo', b.shopPhoto, cust, b.branchCode);
    photoMark(branchMarks, b.id, 'signboard_photo', b.signboardPhoto, cust, b.branchCode);
    const xs = (extrasByBranch.get(b.id) ?? []).filter((x) => inWindow(x.createdAt, since, until));
    if (xs.length > 0) {
      // One mark for the column; count all of them.
      photoMark(branchMarks, b.id, 'other_photos', xs[0], cust, b.branchCode);
      for (const x of xs.slice(1)) {
        const u = captorById.get(x.capturedById);
        if (u) tallyFor(u).photosAdded += 1;
      }
    }
  }

  // ── Workbook ─────────────────────────────────────────────────────────────
  // Item 28: the streaming writer — each row is serialised as it is committed, so
  // memory does not hold a styled cell model of every row until the end.
  const { wb, finish } = await openStreamedWorkbook();
  wb.creator = 'NMWC Customer Master';
  wb.created = new Date();

  const ws = wb.addWorksheet('Customers', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_HEADER } };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  let changedRows = 0;
  let writtenRows = 0;
  const s = (v: unknown) => escapeFormulaCell(v == null ? '' : v);

  const approvals = approvalIndex(changeRows);


  for (const b of branches) {
    const c = b.customer;
    const marks = new Map<string, Mark>();
    for (const [col, m] of customerMarks.get(b.customerId) ?? []) marks.set(col, m);
    for (const [col, m] of branchMarks.get(b.id) ?? []) marks.set(col, m);
    const hasMarks = marks.size > 0;
    if (filters.onlyChanged && !hasMarks) continue;
    if (hasMarks) changedRows += 1;

    const approved = [...marks.entries()].filter(([, m]) => m.state === 'APPROVED');
    const pending = [...marks.entries()].filter(([, m]) => m.state === 'PENDING');
    const latestApproved = approved
      .map(([, m]) => m.at)
      .filter((d): d is Date => !!d)
      .sort((x, y) => y.getTime() - x.getTime())[0];
    const uniq = (xs: string[]) => [...new Set(xs)].join(', ');
    const approvedBy = approvedByFor(approvals, c.nmwcCode, b.branchCode);
    const salesman = salesmanByRoute.get(b.routeId);
    const extraCount = (extrasByBranch.get(b.id) ?? []).length;
    const pin = mapPinHref(b.gpsLat, b.gpsLng);

    const values: Record<string, unknown> = {
      cust_code: s(c.nmwcCode),
      cust_name: s(c.legalName),
      branch_code: s(b.branchCode),
      branch_name: s(b.branchName),
      sales_region: s(b.region.name),
      route: s(b.route.code),
      salesman: s(salesman?.username ?? ''),
      payment_terms: c.paymentTerms,
      customer_status: c.status,
      branch_status: b.status,
      channel: s(c.channel?.label ?? ''),
      sub_channel: s(c.subChannel?.label ?? ''),
      phone: s(c.primaryPhone ?? ''),
      alt_phone: s(c.altPhone ?? ''),
      contact_person: s(c.contactPerson ?? ''),
      contact_role: s(c.contactRole ?? ''),
      cr_no: s(c.crNumber ?? ''),
      cr_photo: c.crPhotoId ? 'yes' : '',
      address: s(b.address),
      area_description: s(b.areaDescription ?? ''),
      gps_lat: b.gpsLat ?? '',
      gps_lng: b.gpsLng ?? '',
      gps_accuracy_m: b.gpsAccuracy != null ? Math.round(b.gpsAccuracy) : '',
      gps_captured_at: omanStamp(b.gpsCapturedAt),
      gps_map: pin ? { text: 'map', hyperlink: pin } : '',
      day_of_visit: b.dayOfVisit ?? '',
      opening_hours: s(b.openingHours ?? ''),
      delivery_window: s(b.deliveryWindow ?? ''),
      coolers: b.coolersCount,
      stands: b.standsCount,
      empty_bottles: b.emptyBottlesCount,
      shop_photo: b.shopPhotoId ? 'yes' : '',
      signboard_photo: b.signboardPhotoId ? 'yes' : '',
      other_photos: extraCount > 0 ? extraCount : '',
      notes: s(c.notes ?? ''),
      completeness_pct: c.completenessScore,
      changed_fields: approved.map(([col]) => col).join(', '),
      changed_by: uniq(approved.map(([, m]) => m.by)),
      changed_at: omanStamp(latestApproved),
      approved_by: approvedBy,
      pending_fields: pending.map(([col]) => col).join(', '),
      pending_by: uniq(pending.map(([, m]) => m.by)),
    };
    const row = ws.addRow(values);
    writtenRows += 1;
    for (const [col, m] of marks) {
      const cell = row.getCell(col);
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: m.state === 'APPROVED' ? FILL_APPROVED : FILL_PENDING },
      };
      const when = omanStamp(m.at);
      cell.note =
        m.state === 'APPROVED'
          ? `was: ${labelOf(col, m.before) || '—'} → now: ${labelOf(col, m.after) || '—'}\nby ${m.by}${when ? ` on ${when}` : ''}`
          : `PENDING proposal: ${labelOf(col, m.before) || '—'} → ${labelOf(col, m.after) || '—'}\nby ${m.by}${when ? ` on ${when}` : ''} — not yet approved`;
    }
    if (hasMarks) {
      row.getCell('cust_code').font = { bold: true };
    }
    row.commit();
  }
  ws.commit();

  // Sheet 2 — Changes
  const wc = wb.addWorksheet('Changes', { views: [{ state: 'frozen', ySplit: 1 }] });
  wc.columns = [
    { header: 'cust_code', key: 'cust_code', width: 14 },
    { header: 'cust_name', key: 'cust_name', width: 32 },
    { header: 'branch_code', key: 'branch_code', width: 16 },
    { header: 'field', key: 'field', width: 18 },
    { header: 'before', key: 'before', width: 28 },
    { header: 'after', key: 'after', width: 28 },
    { header: 'decision', key: 'decision', width: 10 },
    { header: 'submitted_by', key: 'submitted_by', width: 13 },
    { header: 'submitted_at', key: 'submitted_at', width: 17 },
    { header: 'decided_by', key: 'decided_by', width: 12 },
    { header: 'decided_at', key: 'decided_at', width: 17 },
  ];
  wc.getRow(1).font = { bold: true };
  wc.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_HEADER } };
  wc.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 11 } };
  changeRows.sort((a, b) =>
    (a.decided_at || a.submitted_at).localeCompare(b.decided_at || b.submitted_at)
  );
  for (const r of changeRows) {
    const row = wc.addRow({
      ...r,
      cust_name: s(r.cust_name),
      before: s(r.before),
      after: s(r.after),
    });
    row.getCell('decision').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: r.decision === 'PENDING' ? FILL_PENDING : FILL_APPROVED },
    };
    row.commit();
  }
  wc.commit();

  // Sheet 3 — By salesman
  const wt = wb.addWorksheet('By salesman');
  wt.columns = [
    { header: 'salesman', key: 'username', width: 14 },
    { header: 'full_name', key: 'fullName', width: 26 },
    { header: 'customers_updated', key: 'customers', width: 16 },
    { header: 'edits_approved', key: 'approvedEdits', width: 14 },
    { header: 'fields_changed', key: 'fieldsChanged', width: 14 },
    { header: 'gps_captured', key: 'gpsCaptured', width: 12 },
    { header: 'photos_added', key: 'photosAdded', width: 12 },
    { header: 'edits_pending', key: 'pendingEdits', width: 13 },
  ];
  wt.getRow(1).font = { bold: true };
  wt.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL_HEADER } };
  for (const t of [...tally.values()].sort((a, b) => a.username.localeCompare(b.username))) {
    const row = wt.addRow({
      username: t.username,
      fullName: s(t.fullName),
      customers: t.customers.size,
      approvedEdits: t.approvedEdits,
      fieldsChanged: t.fieldsChanged,
      gpsCaptured: t.gpsCaptured,
      photosAdded: t.photosAdded,
      pendingEdits: t.pendingEdits,
    });
    row.commit();
  }
  wt.commit();

  // Sheet 4 — Legend
  const wl = wb.addWorksheet('Legend');
  wl.columns = [
    { header: 'item', key: 'k', width: 22 },
    { header: 'value', key: 'v', width: 90 },
  ];
  wl.getRow(1).font = { bold: true };
  const legend: Array<[string, string, string?]> = [
    ['Report', 'Field-update report — which customer fields the field force changed, and which they did not.'],
    ['Window', `${filters.since ? omanStamp(since) : 'beginning'} → ${omanStamp(until)} (Oman time)`],
    ['Generated', `${omanStamp(new Date())} by ${me.username} (${me.role})`],
    [
      'Scope',
      `${writtenRows} branch rows (${changedRows} with changes)${filters.onlyChanged ? ' — rows without changes omitted' : ''}; ${scopedEdits.filter((e) => e.state === EditState.APPROVED).length} approved edits, ${scopedEdits.filter((e) => e.state === EditState.SUBMITTED).length} pending`,
    ],
    ['Yellow cell', 'Changed by an APPROVED edit inside the window (hover the cell note for was → now, by, when). Photo columns: photo added inside the window.', FILL_APPROVED],
    ['Orange cell', 'A PENDING (submitted, not yet decided) proposal exists for this field. The cell shows the CURRENT value; the proposed value is on the Changes sheet.', FILL_PENDING],
    ['Bold cust_code', 'Row has at least one highlighted cell.'],
    ['changed_fields', 'Columns changed by approved edits on this row; changed_by / approved_by / changed_at summarise them.'],
    ['pending_fields', 'Columns with an undecided proposal; pending_by = who submitted it.'],
    ['Not highlighted', 'Nothing was changed on this field inside the window (values come from the import or an earlier period).'],
    ['Sheet "Changes"', 'One row per field change (before → after) and per photo added — filter by salesman, decision or customer.'],
    ['Sheet "By salesman"', 'Totals per salesman for the window.'],
  ];
  for (const [k, v, fill] of legend) {
    const row = wl.addRow({ k, v });
    if (fill) row.getCell('k').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    row.commit();
  }
  wl.commit();

  const bytes = await finish();
  const stamp = new Date().toISOString().slice(0, 10);
  logger.info(
    { rows: writtenRows, changed: changedRows, edits: scopedEdits.length, by: me.id },
    'export.change_report'
  );
  return {
    bytes,
    filename: `nmwc-field-updates-${stamp}.xlsx`,
    rowCount: writtenRows,
    changedRows,
    changeCount: changeRows.length,
  };
}
