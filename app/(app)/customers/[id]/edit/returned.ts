/**
 * Launch fix: a sent-back update opens on the edit form with what the salesman
 * sent filled in. The form loaded only the customer as it is, and his phone
 * draft was deleted when he submitted, so he typed everything again from memory.
 *
 * Each stored change (CustomerEdit.fieldChanges) goes back into its box when the
 * customer still holds the value it was sent against (`before`) — the rule an
 * approval judges a stored change by (lib/edit-values.ts classifyAgainstLive).
 * The form then sends it as an ordinary change from the value it loaded, so a
 * value someone changed meanwhile is never put back without his choosing. One
 * already live needs nothing. One changed since is left as it is now, and named,
 * so he can decide. A branch no longer shown to him (handed to another route) is
 * named the same way.
 *
 * Pure: the page computes it and hands the boxes to the client form.
 */
import {
  loadedFormState,
  type FormBranch,
  type FormCustomer,
  type FormGps,
  type FormState,
  type LoadedCustomer,
} from '@/lib/enrichment-patch';
import {
  BRANCH_FIELD_LABEL,
  CUSTOMER_FIELD_LABEL,
  classifyAgainstLive,
  classifyPointAgainstLive,
  parseFieldPath,
  type BranchEditField,
  type CustomerEditField,
} from '@/lib/edit-values';
import { GPS_SOURCE_MANUAL } from '@/lib/gps-manual';

export type ReturnedPrefill = {
  /** The boxes: the customer as loaded, with each change he sent that still applies. */
  state: FormState;
  /** What he sent that was not filled in: changed on the customer since, or on a branch not shown. */
  notFilled: string[];
};

/** The text boxes on the customer (paymentTerms and status are not his to send). */
const CUSTOMER_TEXT: ReadonlySet<CustomerEditField> = new Set<CustomerEditField>([
  'legalName',
  'crNumber',
  'channelId',
  'subChannelId',
  'primaryPhone',
  'altPhone',
  'contactPerson',
  'contactRole',
  'notes',
]);

/** A branch field's box (the location is handled as one point). */
const BRANCH_BOX: Partial<Record<BranchEditField, keyof FormBranch>> = {
  address: 'address',
  areaDescription: 'areaDescription',
  dayOfVisit: 'dayOfVisit',
  openingHours: 'openingHours',
  deliveryWindow: 'deliveryWindow',
  coolersCount: 'coolers',
  standsCount: 'stands',
  emptyBottlesCount: 'bottles',
  equipmentConfirmed: 'confirmed',
};

type Stored = {
  field: string;
  before?: unknown;
  after?: unknown;
  gpsSource?: unknown;
  gpsManualReason?: unknown;
};

const GPS_FIELDS = new Set(['gpsLat', 'gpsLng', 'gpsAccuracy', 'gpsCapturedAt']);

function boxValue(box: keyof FormBranch | keyof FormCustomer, v: unknown): unknown {
  if (box === 'coolers' || box === 'stands' || box === 'bottles') return typeof v === 'number' ? v : 0;
  if (box === 'confirmed') return v === true;
  return v === null || v === undefined ? '' : String(v);
}

function isoOf(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return v;
  return null;
}

export function returnedPrefill(
  loaded: LoadedCustomer,
  changes: unknown,
  opts: { lockName: boolean; lockCr: boolean }
): ReturnedPrefill {
  const base = loadedFormState(loaded);
  const customer: FormCustomer = { ...base.customer };
  const branches: Record<string, FormBranch> = {};
  for (const [id, b] of Object.entries(base.branches)) branches[id] = { ...b };
  const notFilled = new Set<string>();
  const live = loaded as unknown as Record<string, unknown>;
  const branchTag = (id: string) => `Branch ${loaded.branches.findIndex((b) => b.id === id) + 1}`;

  const entries: Stored[] = Array.isArray(changes)
    ? changes.filter(
        (c): c is Stored =>
          typeof c === 'object' && c !== null && typeof (c as { field?: unknown }).field === 'string'
      )
    : [];
  const gpsByBranch = new Map<string, Map<string, Stored>>();
  let hiddenBranch = false;

  for (const c of entries) {
    const p = parseFieldPath(c.field);
    if (!p) continue;
    if (p.scope === 'customer') {
      if (!CUSTOMER_TEXT.has(p.field)) continue;
      // Locked for him: never in his request, and the box is read-only.
      if ((p.field === 'legalName' && opts.lockName) || (p.field === 'crNumber' && opts.lockCr)) continue;
      const verdict = classifyAgainstLive(c.field, c.before, c.after, live[p.field]);
      if (verdict === 'CONVERGED') continue;
      if (verdict === 'STALE') {
        notFilled.add(CUSTOMER_FIELD_LABEL[p.field]);
        continue;
      }
      (customer as Record<string, unknown>)[p.field] = boxValue(p.field as keyof FormCustomer, c.after);
      continue;
    }
    const lb = loaded.branches.find((b) => b.id === p.branchId);
    if (!lb || !branches[p.branchId]) {
      hiddenBranch = true;
      continue;
    }
    if (GPS_FIELDS.has(p.field)) {
      const m = gpsByBranch.get(p.branchId) ?? new Map<string, Stored>();
      m.set(p.field, c);
      gpsByBranch.set(p.branchId, m);
      continue;
    }
    const box = BRANCH_BOX[p.field];
    if (!box) continue;
    const verdict = classifyAgainstLive(c.field, c.before, c.after, (lb as Record<string, unknown>)[p.field]);
    if (verdict === 'CONVERGED') continue;
    if (verdict === 'STALE') {
      notFilled.add(`${branchTag(p.branchId)}: ${BRANCH_FIELD_LABEL[p.field]}`);
      continue;
    }
    branches[p.branchId] = { ...branches[p.branchId]!, [box]: boxValue(box, c.after) };
  }

  // The point is one value: judged as a pair, as the approval judges it.
  for (const [branchId, m] of gpsByBranch) {
    const lb = loaded.branches.find((b) => b.id === branchId)!;
    const lat = m.get('gpsLat');
    const lng = m.get('gpsLng');
    if (!lat && !lng) continue;
    const coord = (c: Stored | undefined, key: 'before' | 'after', liveV: number | null) =>
      c ? c[key] : liveV;
    const target = { gpsLat: coord(lat, 'after', lb.gpsLat), gpsLng: coord(lng, 'after', lb.gpsLng) };
    if (typeof target.gpsLat !== 'number' || typeof target.gpsLng !== 'number') continue;
    const verdict = classifyPointAgainstLive(
      { gpsLat: coord(lat, 'before', lb.gpsLat), gpsLng: coord(lng, 'before', lb.gpsLng) },
      target,
      { gpsLat: lb.gpsLat, gpsLng: lb.gpsLng }
    );
    if (verdict === 'CONVERGED') continue;
    if (verdict === 'STALE') {
      notFilled.add(`${branchTag(branchId)}: ${BRANCH_FIELD_LABEL.gpsLat}`);
      continue;
    }
    // Accuracy and capture time are recorded only when they changed; absent,
    // the point kept the ones on file.
    const acc = m.get('gpsAccuracy');
    const at = m.get('gpsCapturedAt');
    const marked = [lat, lng].find((c) => c?.gpsSource === GPS_SOURCE_MANUAL);
    const accuracy = acc ? acc.after : lb.gpsAccuracy;
    const gps: FormGps = {
      lat: target.gpsLat,
      lng: target.gpsLng,
      accuracy: typeof accuracy === 'number' ? accuracy : null,
      capturedAt: isoOf(at ? at.after : lb.gpsCapturedAt) ?? new Date().toISOString(),
      // Item 41: a typed-in point goes back with its reason, so a resubmit keeps it.
      ...(marked && typeof marked.gpsManualReason === 'string'
        ? { isManual: true, manualReason: marked.gpsManualReason }
        : {}),
    };
    branches[branchId] = { ...branches[branchId]!, gps };
  }

  const out = [...notFilled];
  if (hiddenBranch) out.push('a branch that is no longer on your route');
  return { state: { customer, branches }, notFilled: out };
}
