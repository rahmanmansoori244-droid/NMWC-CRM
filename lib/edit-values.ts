/**
 * Auditor recheck 2026-09-27, phase 2 (F06, F20, F21): which fields a customer
 * edit carries, which of them may be emptied, and when two values of a field are
 * "the same" — defined once.
 *
 * F06: the edit form sent EVERY field, loaded when the page opened, so a
 * salesman who changed only the notes silently put back a contact person a
 * Manager or an import had changed since, and his approver saw an ordinary edit.
 * The form now sends only what was touched, each with the value it loaded (its
 * "base"), and a change is judged against the value the master holds NOW:
 *
 *   the live value already equals the new one  → CONVERGED (nothing to write)
 *   the live value still equals the base        → CHANGE
 *   anything else                               → STALE (changed after the
 *                                                  form was opened; refused)
 *
 * The same rule runs on a stored request at approval, where the base is the
 * `before` recorded at submit. Values, not versions: photo attach and
 * reactivation never bump `version`, the import bumps it on every promote, and
 * a version conflict cannot say which field moved.
 *
 * Pure and client-safe — no zod, no Prisma runtime import. The form's patch
 * builder, the UPDATE schema, the submit and direct write, the approval and the
 * approval page all compare through sameEditValue, so a value cannot be
 * "changed" in one of them and "the same" in another.
 */
import type { FieldChange } from './gps-manual';

export const CUSTOMER_EDIT_FIELDS = [
  'legalName',
  'paymentTerms',
  'crNumber',
  'channelId',
  'subChannelId',
  'primaryPhone',
  'altPhone',
  'contactPerson',
  'contactRole',
  'status',
  'notes',
] as const;

export const BRANCH_EDIT_FIELDS = [
  'branchName',
  'address',
  'areaDescription',
  'gpsLat',
  'gpsLng',
  'gpsAccuracy',
  'gpsCapturedAt',
  'dayOfVisit',
  'openingHours',
  'deliveryWindow',
  'coolersCount',
  'standsCount',
  'emptyBottlesCount',
  // F21: the counts were confirmed at the shop, so a zero is a real zero.
  'equipmentConfirmed',
  'status',
] as const;

export type CustomerEditField = (typeof CUSTOMER_EDIT_FIELDS)[number];
export type BranchEditField = (typeof BRANCH_EDIT_FIELDS)[number];

/**
 * The patch format this build's form sends as `v` (lib/validation/edit.ts). A body
 * without it came from a page opened before the app changed, and is refused
 * with FORM_OUTDATED rather than read field by field.
 */
export const EDIT_PAYLOAD_VERSION = 2 as const;

function selectOf<F extends string>(fields: readonly F[]) {
  return Object.fromEntries(fields.map((f) => [f, true])) as { readonly [K in F]: true };
}
/** Prisma `select` for exactly the edit fields: a live snapshot that compares like the patch. */
export const CUSTOMER_EDIT_SELECT = selectOf(CUSTOMER_EDIT_FIELDS);
export const BRANCH_EDIT_SELECT = selectOf(BRANCH_EDIT_FIELDS);

/** A value as the form loaded it, or as fieldChanges stores it: a Date is its ISO string, absent is null. */
export type BaseValue = string | number | boolean | null;

/**
 * F20: null (= clear) is accepted ONLY for these, for every role — including the
 * Steward/Manager direct write, which no mandatory gate covers. Every other field
 * keeps a value once it has one. Owner decisions 2026-09-29: the CR number is
 * clearable (under the FULL gate a salesman's clear is then refused as missing);
 * the day of visit is not.
 */
export const CLEARABLE_CUSTOMER_FIELDS: ReadonlySet<CustomerEditField> = new Set<CustomerEditField>(
  ['crNumber', 'subChannelId', 'altPhone', 'contactRole', 'notes']
);
export const CLEARABLE_BRANCH_FIELDS: ReadonlySet<BranchEditField> = new Set<BranchEditField>([
  'areaDescription',
  'openingHours',
  'deliveryWindow',
  // Only as a GPS companion: a point with no reported accuracy (a typed one).
  'gpsAccuracy',
]);

/** The point itself. Sent together or not at all. */
export const GPS_POINT_FIELDS: ReadonlySet<BranchEditField> = new Set<BranchEditField>([
  'gpsLat',
  'gpsLng',
]);

/**
 * They describe the point, so they follow it (ruling 7): sent only with gpsLat
 * and gpsLng, they carry no base, are never STALE, and are written only when the
 * point itself is — never beside coordinates another writer put there.
 */
export const GPS_COMPANIONS: ReadonlySet<BranchEditField> = new Set<BranchEditField>([
  'gpsAccuracy',
  'gpsCapturedAt',
]);

/** One block on the form, one error slot (`branch.<id>.equipment`). */
export const EQUIPMENT_FIELDS: ReadonlySet<BranchEditField> = new Set<BranchEditField>([
  'coolersCount',
  'standsCount',
  'emptyBottlesCount',
  'equipmentConfirmed',
]);

export const CUSTOMER_FIELD_LABEL: Readonly<Record<CustomerEditField, string>> = {
  legalName: 'Legal name',
  paymentTerms: 'Payment terms',
  crNumber: 'CR number',
  channelId: 'Channel',
  subChannelId: 'Sub-channel',
  primaryPhone: 'Primary phone',
  altPhone: 'Alt phone',
  contactPerson: 'Contact person',
  contactRole: 'Contact role',
  status: 'Status',
  notes: 'Notes',
};

export const BRANCH_FIELD_LABEL: Readonly<Record<BranchEditField, string>> = {
  branchName: 'Branch name',
  address: 'Address',
  areaDescription: 'Landmark / area',
  gpsLat: 'Location',
  gpsLng: 'Location',
  gpsAccuracy: 'Location',
  gpsCapturedAt: 'Location',
  dayOfVisit: 'Day of visit',
  openingHours: 'Opening hours',
  deliveryWindow: 'Delivery window',
  coolersCount: 'Coolers',
  standsCount: 'Stands',
  emptyBottlesCount: 'Empty bottles',
  equipmentConfirmed: 'Equipment counted',
  status: 'Branch status',
};

const CUSTOMER_SET: ReadonlySet<string> = new Set(CUSTOMER_EDIT_FIELDS);
const BRANCH_SET: ReadonlySet<string> = new Set(BRANCH_EDIT_FIELDS);

export function isCustomerEditField(f: string): f is CustomerEditField {
  return CUSTOMER_SET.has(f);
}
export function isBranchEditField(f: string): f is BranchEditField {
  return BRANCH_SET.has(f);
}

export const customerPath = (field: CustomerEditField) => `customer.${field}`;
export const branchPath = (branchId: string, field: BranchEditField) =>
  `branch.${branchId}.${field}`;

export type FieldPath =
  | { scope: 'customer'; field: CustomerEditField }
  | { scope: 'branch'; branchId: string; field: BranchEditField };

/**
 * `customer.<field>` or `branch.<id>.<field>` — the keys fieldChanges stores.
 * Null for anything else: a CREATE marker (`draft.<n>.gps`), a malformed entry, or
 * a field this build does not edit. Branch ids are cuids, so they hold no dot.
 */
export function parseFieldPath(path: string): FieldPath | null {
  if (path.startsWith('customer.')) {
    const field = path.slice('customer.'.length);
    return isCustomerEditField(field) ? { scope: 'customer', field } : null;
  }
  if (path.startsWith('branch.')) {
    const rest = path.slice('branch.'.length);
    const dot = rest.indexOf('.');
    if (dot <= 0) return null;
    const branchId = rest.slice(0, dot);
    const field = rest.slice(dot + 1);
    return isBranchEditField(field) ? { scope: 'branch', branchId, field } : null;
  }
  return null;
}

/** The label a person reads for a stored path; the raw path when it names no edit field. */
export function fieldLabel(path: string): string {
  const p = parseFieldPath(path);
  if (!p) return path;
  return p.scope === 'customer' ? CUSTOMER_FIELD_LABEL[p.field] : BRANCH_FIELD_LABEL[p.field];
}

/** A value in the shape a base or a stored before/after has once it has been through JSON. */
export function toBaseValue(v: unknown): BaseValue {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

const isBlank = (v: unknown) => v === undefined || v === null || v === '';

function epochMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return Date.parse(v);
  if (typeof v === 'number') return v;
  return Number.NaN;
}

function lastSegment(field: string): string {
  const dot = field.lastIndexOf('.');
  return dot < 0 ? field : field.slice(dot + 1);
}

/**
 * Whether two values of `field` (a bare name or a stored path) are the same value.
 *   - '' ≡ null ≡ undefined: an empty text box, a cleared column and a key the
 *     database never had are one state, so emptying an empty field is no change;
 *   - gpsCapturedAt, or any Date on either side, compares by instant: a Date
 *     read from the database against its ISO string from the form or from
 *     fieldChanges JSON;
 *   - everything else is strict equality. Numbers survive JSON exactly (a
 *     double's shortest round-trip form), and phones and CR numbers compare as
 *     stored, because the form's base is the raw value the page loaded.
 */
export function sameEditValue(field: string, a: unknown, b: unknown): boolean {
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
  if (lastSegment(field) === 'gpsCapturedAt' || a instanceof Date || b instanceof Date) {
    const x = epochMs(a);
    const y = epochMs(b);
    return Number.isFinite(x) && x === y;
  }
  return a === b;
}

export function isGpsCompanion(field: string): boolean {
  return GPS_COMPANIONS.has(lastSegment(field) as BranchEditField);
}

export type LiveVerdict = 'CHANGE' | 'CONVERGED' | 'STALE';

/**
 * One field against the master as it is now. `expected` is what the change was
 * made against (the form's base at submit, the stored `before` at approval),
 * `target` is the new value.
 *   - the live value already equals the target → CONVERGED;
 *   - a GPS companion, or the live value still equals `expected` → CHANGE;
 *   - otherwise the field changed after the change was made → STALE.
 * A companion is never STALE on its own; whether it is written at all is the
 * point's decision (classifyChanges).
 */
export function classifyAgainstLive(
  field: string,
  expected: unknown,
  target: unknown,
  live: unknown
): LiveVerdict {
  if (sameEditValue(field, target, live)) return 'CONVERGED';
  if (isGpsCompanion(field) || sameEditValue(field, expected, live)) return 'CHANGE';
  return 'STALE';
}

const GPS_SLOT_FIELDS = new Set([
  'gpsLat',
  'gpsLng',
  'gpsAccuracy',
  'gpsCapturedAt',
  'gpsManualReason',
]);

/**
 * The form slot an error on `path` renders in. The location is one control and
 * so is the equipment block, so each of their fields answers to one key:
 *   branch.<id>.gps{Lat,Lng,Accuracy,CapturedAt,ManualReason} → branch.<id>.gps
 *   branch.<id>.{coolers,stands,emptyBottles}Count, .equipmentConfirmed → branch.<id>.equipment
 * Every other path is its own slot.
 */
export function fieldSlotKey(path: string): string {
  if (!path.startsWith('branch.')) return path;
  const rest = path.slice('branch.'.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return path;
  const branchId = rest.slice(0, dot);
  const field = rest.slice(dot + 1);
  if (GPS_SLOT_FIELDS.has(field)) return `branch.${branchId}.gps`;
  if (EQUIPMENT_FIELDS.has(field as BranchEditField)) return `branch.${branchId}.equipment`;
  return path;
}

/**
 * The master as it is now: the customer's columns, and its LIVE branches by id
 * (deletedAt null, this customer only). Read under the customer's row lock by
 * every writer that decides with it.
 */
export type LiveSnapshot = {
  customer: Readonly<Record<string, unknown>>;
  branches: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
};

/**
 * The live value at a stored path. Null when the path names no edit field, or a
 * branch that is not live on this customer (archived, or moved to another one).
 */
export function liveValueAt(path: string, live: LiveSnapshot): { value: unknown } | null {
  const p = parseFieldPath(path);
  if (!p) return null;
  if (p.scope === 'customer') return { value: live.customer[p.field] };
  const branch = live.branches.get(p.branchId);
  return branch ? { value: branch[p.field] } : null;
}

type Change = Pick<FieldChange, 'field' | 'before' | 'after'>;

export type ClassifiedChanges<C extends Change> = {
  /** To write, as given (item 41's marker and any other key kept). */
  apply: C[];
  /** Paths whose live value already equals the new one — nothing to write. */
  converged: string[];
  /** Paths changed after the request was made, with the value now live. */
  stale: Array<{ field: string; live: BaseValue }>;
  /** Branches named by the request that are no longer live on this customer. */
  droppedBranchIds: string[];
};

/**
 * Stored (or planned) changes against a live snapshot — the approval, the
 * direct write and the approval page all decide with this.
 *
 * Each `customer.*` / `branch.<id>.*` entry is classified with
 * classifyAgainstLive(before, after, live); an entry on a branch that is not live
 * drops (the branch is reported once); an entry that names no edit field is
 * ignored, as the apply step always ignored it.
 *
 * GPS companions follow the point (ruling 7): gpsAccuracy and gpsCapturedAt are
 * applied only when that branch's gpsLat or gpsLng is applied, and are otherwise
 * CONVERGED. A point another writer set is never given this request's accuracy
 * and capture time.
 */
export function classifyChanges<C extends Change>(
  changes: readonly C[],
  live: LiveSnapshot
): ClassifiedChanges<C> {
  type Decided =
    | { c: C; kind: 'skip' }
    | { c: C; kind: 'companion'; branchId: string; liveValue: unknown }
    | { c: C; kind: LiveVerdict; liveValue: unknown };
  const dropped = new Set<string>();
  const pointApplied = new Set<string>();

  // First pass: every entry but the companions, which wait for their point.
  const decided = changes.map((c): Decided => {
    const p = parseFieldPath(c.field);
    if (!p) return { c, kind: 'skip' };
    if (p.scope === 'customer') {
      const liveValue = live.customer[p.field];
      return { c, kind: classifyAgainstLive(c.field, c.before, c.after, liveValue), liveValue };
    }
    const branch = live.branches.get(p.branchId);
    if (!branch) {
      dropped.add(p.branchId);
      return { c, kind: 'skip' };
    }
    const liveValue = branch[p.field];
    if (GPS_COMPANIONS.has(p.field))
      return { c, kind: 'companion', branchId: p.branchId, liveValue };
    const kind = classifyAgainstLive(c.field, c.before, c.after, liveValue);
    if (kind === 'CHANGE' && GPS_POINT_FIELDS.has(p.field)) pointApplied.add(p.branchId);
    return { c, kind, liveValue };
  });

  // Second pass, in the request's own order.
  const apply: C[] = [];
  const converged: string[] = [];
  const stale: Array<{ field: string; live: BaseValue }> = [];
  for (const d of decided) {
    if (d.kind === 'skip') continue;
    const verdict: LiveVerdict =
      d.kind !== 'companion'
        ? d.kind
        : pointApplied.has(d.branchId) && !sameEditValue(d.c.field, d.c.after, d.liveValue)
          ? 'CHANGE'
          : 'CONVERGED';
    if (verdict === 'CHANGE') apply.push(d.c);
    else if (verdict === 'CONVERGED') converged.push(d.c.field);
    else stale.push({ field: d.c.field, live: toBaseValue(d.liveValue) });
  }

  return { apply, converged, stale, droppedBranchIds: [...dropped] };
}
