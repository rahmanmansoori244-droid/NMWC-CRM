/**
 * Auditor recheck 2026-09-27, phase 2 (F06, F20, F21): what the enrichment form
 * sends, built from what it loaded and what is in its boxes now.
 *
 * The form used to send every field it had loaded, and an empty box meant
 * "leave it". So a salesman who changed only the notes put back a contact
 * person that a Manager or an import had changed since (F06), and nothing
 * could ever be emptied (F20). Now the form sends patch v2
 * (lib/validation/edit.ts):
 *   - only the fields that differ from what the page LOADED, each with that
 *     loaded value as its base — never the phone draft's values, which the
 *     server never saw;
 *   - an emptied box as null, which clears a clearable field and draws the
 *     server's "cannot be removed" on any other;
 *   - the location only when its coordinates moved (a capture time alone is no
 *     change), always with its capture time and accuracy;
 *   - a new channel with the sub-channel it leaves (null unless one was picked);
 *   - "counted at the shop" (F21) when it was ticked, or when a count moved.
 *
 * After a STALE_FIELDS answer nothing is rebased by itself (ruling 1): the
 * person chooses per field. "Keep mine" moves that field's loaded value to the
 * one found live and names it in the patch's overrides, so the next submit
 * replaces it knowingly and the approver is told; "Use this value" takes the
 * live value into the box, so the field is no longer sent.
 *
 * Pure and client-safe: no zod, no Prisma runtime import.
 */
import type { CustomerStatus, DayOfWeek, Role } from '@prisma/client';
import type { SubmitEditInput } from './validation/edit';
import {
  fieldSlotKey,
  parseFieldPath,
  sameEditValue,
  toBaseValue,
  type BaseValue,
  type BranchEditField,
  type CustomerEditField,
} from './edit-values';
import { normalizePhone } from './phone';

/** A branch as the edit page loads it (the fields the form edits). */
export type LoadedBranch = {
  id: string;
  address: string;
  areaDescription: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  gpsAccuracy: number | null;
  gpsCapturedAt: Date | string | null;
  dayOfVisit: DayOfWeek | null;
  openingHours: string | null;
  deliveryWindow: string | null;
  coolersCount: number;
  standsCount: number;
  emptyBottlesCount: number;
  equipmentConfirmed: boolean;
};

/** The server values the form started from: the page's customer, rebased only by a person's choice. */
export type LoadedCustomer = {
  legalName: string;
  crNumber: string | null;
  channelId: string | null;
  subChannelId: string | null;
  primaryPhone: string | null;
  altPhone: string | null;
  contactPerson: string | null;
  contactRole: string | null;
  status: CustomerStatus;
  notes: string | null;
  branches: LoadedBranch[];
};

/** A point as the GPS button holds it. A draft restored from the phone carries its time as an ISO string. */
export type FormGps = {
  lat: number;
  lng: number;
  accuracy?: number | null;
  capturedAt: Date | string;
  isManual?: boolean;
  manualReason?: string;
};

/** One branch's boxes. */
export type FormBranch = {
  address: string;
  areaDescription: string;
  gps: FormGps | null;
  dayOfVisit: DayOfWeek | '';
  openingHours: string;
  deliveryWindow: string;
  coolers: number;
  stands: number;
  bottles: number;
  /** F21: "Counted at the shop". Absent in a draft saved before it existed — then the loaded value. */
  confirmed?: boolean;
};

/** The customer's boxes. */
export type FormCustomer = {
  legalName: string;
  crNumber: string;
  channelId: string;
  subChannelId: string;
  primaryPhone: string;
  altPhone: string;
  contactPerson: string;
  contactRole: string;
  status: CustomerStatus;
  notes: string;
};

export type FormState = { customer: FormCustomer; branches: Readonly<Record<string, FormBranch>> };

/** Fields the person chose "Keep mine" for (ruling 1). */
export type KeptFields = {
  customer: readonly CustomerEditField[];
  branches: Readonly<Record<string, readonly BranchEditField[]>>;
};
export const NO_KEPT_FIELDS: KeptFields = { customer: [], branches: {} };

export type EnrichmentPatch = Pick<
  SubmitEditInput,
  'customer' | 'customerBase' | 'customerOverrides' | 'branches'
>;

/** Who is editing: what the form may send at all. */
export type PatchOptions = { role: Role; lockName: boolean; lockCr: boolean };

/** A loaded row's field by its edit-field name (the rows carry only the fields the form edits). */
const valueOf = (row: object, f: string): unknown => (row as Record<string, unknown>)[f];

/** The boxes as the page loaded them. */
export function loadedFormState(loaded: LoadedCustomer): FormState {
  const customer: FormCustomer = {
    legalName: loaded.legalName,
    crNumber: loaded.crNumber ?? '',
    channelId: loaded.channelId ?? '',
    subChannelId: loaded.subChannelId ?? '',
    primaryPhone: loaded.primaryPhone ?? '',
    altPhone: loaded.altPhone ?? '',
    contactPerson: loaded.contactPerson ?? '',
    contactRole: loaded.contactRole ?? '',
    status: loaded.status,
    notes: loaded.notes ?? '',
  };
  const branches: Record<string, FormBranch> = {};
  for (const b of loaded.branches) branches[b.id] = loadedBranchState(b);
  return { customer, branches };
}

function loadedBranchState(b: LoadedBranch): FormBranch {
  return {
    address: b.address,
    areaDescription: b.areaDescription ?? '',
    gps: pointOf(b.gpsLat, b.gpsLng, b.gpsAccuracy, b.gpsCapturedAt),
    dayOfVisit: b.dayOfVisit ?? '',
    openingHours: b.openingHours ?? '',
    deliveryWindow: b.deliveryWindow ?? '',
    coolers: b.coolersCount,
    stands: b.standsCount,
    bottles: b.emptyBottlesCount,
    confirmed: b.equipmentConfirmed,
  };
}

function pointOf(
  lat: unknown,
  lng: unknown,
  accuracy: unknown,
  capturedAt: unknown
): FormGps | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return {
    lat,
    lng,
    accuracy: typeof accuracy === 'number' ? accuracy : undefined,
    // A point on file with no capture time: the GPS chip needs one to show.
    capturedAt: isoOf(capturedAt) ?? new Date(),
  };
}

/** A box's text as sent: trimmed, and nothing at all is null (a clear). */
function orNull(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim() : '';
  return t === '' ? null : t;
}

/** A phone as compared: the same number typed another way ('9123 4567') is no change. */
function phoneKey(v: string | null): string | null {
  return v === null ? null : (normalizePhone(v) ?? v);
}

function isoOf(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return v;
  return null;
}

const countOf = (v: unknown, loaded: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : loaded;

/** Whether a branch's counts differ from what the page loaded — entering a count is counting (F21). */
export function countsMoved(loaded: LoadedBranch, s: FormBranch): boolean {
  return (
    countOf(s.coolers, loaded.coolersCount) !== loaded.coolersCount ||
    countOf(s.stands, loaded.standsCount) !== loaded.standsCount ||
    countOf(s.bottles, loaded.emptyBottlesCount) !== loaded.emptyBottlesCount
  );
}

/** "Counted at the shop" as the box shows it: ticked, or implied by a count that moved. */
export function countedNow(loaded: LoadedBranch, s: FormBranch): boolean {
  return (
    countsMoved(loaded, s) ||
    (typeof s.confirmed === 'boolean' ? s.confirmed : loaded.equipmentConfirmed)
  );
}

/**
 * The patch for the fields touched since the page loaded (see the file header).
 * `loaded` is loadedRef.current — the page's values, moved only by "Keep mine" /
 * "Use this value" — never the phone draft. Branches the page does not show
 * are never sent, whatever the state holds.
 */
export function buildEnrichmentPatch(
  loaded: LoadedCustomer,
  state: FormState,
  opts: PatchOptions & { kept?: KeptFields }
): EnrichmentPatch {
  const kept = opts.kept ?? NO_KEPT_FIELDS;
  const s = state.customer;
  const customer: Record<string, BaseValue> = {};
  const customerBase: Record<string, BaseValue> = {};
  const put = (f: CustomerEditField, value: BaseValue) => {
    customer[f] = value;
    customerBase[f] = toBaseValue(valueOf(loaded, f));
  };
  const text = (f: 'legalName' | 'crNumber' | 'contactPerson' | 'contactRole' | 'notes') => {
    const now = orNull(s[f]);
    if (now !== orNull(loaded[f])) put(f, now);
  };
  const phone = (f: 'primaryPhone' | 'altPhone') => {
    const now = orNull(s[f]);
    if (phoneKey(now) !== phoneKey(orNull(loaded[f]))) put(f, now);
  };

  if (!opts.lockName) text('legalName');
  if (!opts.lockCr) text('crNumber');
  const channel = orNull(s.channelId);
  const channelMoved = channel !== orNull(loaded.channelId);
  if (channelMoved) put('channelId', channel);
  // A new channel carries the sub-channel it leaves: the one picked for it, or
  // none — the select empties when the channel changes.
  const subChannel = orNull(s.subChannelId);
  if (channelMoved || subChannel !== orNull(loaded.subChannelId)) put('subChannelId', subChannel);
  phone('primaryPhone');
  phone('altPhone');
  text('contactPerson');
  text('contactRole');
  // EL-01: a salesman's form never sends a status; its flips have their own lanes.
  if (opts.role !== 'SALESMAN' && s.status !== loaded.status) put('status', s.status);
  text('notes');

  const branches: EnrichmentPatch['branches'] = [];
  for (const lb of loaded.branches) {
    const b = state.branches[lb.id];
    if (!b) continue;
    const patch: Record<string, unknown> = {};
    const base: Partial<Record<BranchEditField, BaseValue>> = {};
    const putB = (f: BranchEditField, value: unknown) => {
      patch[f] = value;
      base[f] = toBaseValue(valueOf(lb, f));
    };
    const textB = (f: 'address' | 'areaDescription' | 'openingHours' | 'deliveryWindow') => {
      const now = orNull(b[f]);
      if (now !== orNull(lb[f])) putB(f, now);
    };

    textB('address');
    textB('areaDescription');
    // The location moves only with its coordinates. A new capture time alone —
    // a re-captured point on the same spot — is no change.
    const g = b.gps;
    if (
      g &&
      typeof g.lat === 'number' &&
      typeof g.lng === 'number' &&
      (g.lat !== lb.gpsLat || g.lng !== lb.gpsLng)
    ) {
      putB('gpsLat', g.lat);
      putB('gpsLng', g.lng);
      // Companions: no base, never compared with the live value (lib/edit-values.ts).
      patch.gpsAccuracy = typeof g.accuracy === 'number' ? g.accuracy : null;
      patch.gpsCapturedAt = isoOf(g.capturedAt) ?? new Date().toISOString();
      // Item 41: a typed-in point says so, with the reason the salesman gave.
      if (g.isManual && typeof g.manualReason === 'string') patch.gpsManualReason = g.manualReason;
    }
    const day = orNull(b.dayOfVisit);
    if (day !== orNull(lb.dayOfVisit)) putB('dayOfVisit', day);
    textB('openingHours');
    textB('deliveryWindow');
    const counts = [
      ['coolersCount', countOf(b.coolers, lb.coolersCount)],
      ['standsCount', countOf(b.stands, lb.standsCount)],
      ['emptyBottlesCount', countOf(b.bottles, lb.emptyBottlesCount)],
    ] as const;
    for (const [f, n] of counts) if (n !== lb[f]) putB(f, n);
    // F21, owner decision 3: anyone marks it counted; only a Steward or a
    // Manager takes that back.
    const counted = countedNow(lb, b);
    if (counted && !lb.equipmentConfirmed) putB('equipmentConfirmed', true);
    else if (!counted && lb.equipmentConfirmed && opts.role !== 'SALESMAN')
      putB('equipmentConfirmed', false);

    if (Object.keys(patch).length === 0) continue;
    const overrides = (kept.branches[lb.id] ?? []).filter((f) => f in base);
    // The schema is the check on these shapes: tests/unit/enrichment-patch.test.ts
    // parses what this builds with submitEditSchema.
    branches.push({
      branchId: lb.id,
      ...patch,
      base,
      ...(overrides.length > 0 ? { overrides } : {}),
    } as unknown as EnrichmentPatch['branches'][number]);
  }

  const customerOverrides = kept.customer.filter((f) => f in customerBase);
  return {
    customer: customer as EnrichmentPatch['customer'],
    customerBase,
    ...(customerOverrides.length > 0 ? { customerOverrides } : {}),
    branches,
  };
}

/** Every path a patch sends ('customer.notes', 'branch.<id>.gpsLat'), companions included. */
export function sentPaths(patch: EnrichmentPatch): string[] {
  const out = Object.keys(patch.customer).map((f) => `customer.${f}`);
  for (const b of patch.branches) {
    for (const k of Object.keys(b)) {
      if (k === 'branchId' || k === 'base' || k === 'overrides') continue;
      out.push(`branch.${b.branchId}.${k}`);
    }
  }
  return out;
}

/** A STALE_FIELDS answer's live values, by the form slot they belong to (lib/edit-values.ts fieldSlotKey). */
export type Conflicts = Readonly<Record<string, Readonly<Record<string, BaseValue>>>>;

/** STALE_FIELDS → one conflict per slot the server named, holding the live values it sent for that slot. */
export function conflictsFrom(
  fields: Readonly<Record<string, string>>,
  current: Readonly<Record<string, BaseValue>>
): Record<string, Record<string, BaseValue>> {
  const out: Record<string, Record<string, BaseValue>> = {};
  for (const [path, value] of Object.entries(current)) {
    const slot = fieldSlotKey(path);
    if (!(slot in fields)) continue;
    (out[slot] ??= {})[path] = value;
  }
  return out;
}

/** The conflicts the next submit would still meet: a slot whose fields are no longer sent is moot. */
export function openConflicts(conflicts: Conflicts, patch: EnrichmentPatch): string[] {
  const sent = new Set(sentPaths(patch).map(fieldSlotKey));
  return Object.keys(conflicts).filter((slot) => sent.has(slot));
}

/** The form's key for a branch field ('coolersCount' → 'coolers'); the location is one box. */
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

/** A live value as its box holds it. */
function boxValue(field: CustomerEditField | BranchEditField, live: BaseValue): unknown {
  if (field === 'coolersCount' || field === 'standsCount' || field === 'emptyBottlesCount') {
    return typeof live === 'number' ? live : 0;
  }
  if (field === 'equipmentConfirmed') return live === true;
  if (field === 'status') return live;
  return live === null ? '' : String(live);
}

/**
 * Ruling 1: the person's answer to one conflict (a slot of a STALE_FIELDS answer).
 *   - 'mine' ("Keep mine"): each field of the slot that he changed keeps his
 *     value in its box and gets the live value as its loaded value. It is named
 *     in `kept` — so the next submit replaces it knowingly and the stored change
 *     says so (overrodeLive) — only when that live value differs from the one it
 *     had loaded. A field he changed that nobody else did (a count beside the
 *     stale one: the server hands back the whole block) stays an ordinary change
 *     of his, and the approver is not told it replaces anything. A field of the
 *     slot he did not change takes the live value into its box too — it was
 *     never his.
 *   - 'theirs' ("Use this value"): every field of the slot takes the live value,
 *     loaded and in its box, so it is no longer sent. On the channel the
 *     sub-channel follows: the live one when the answer carries it (the form
 *     passes the sub-channel found live in the same STALE_FIELDS answer), else
 *     none — the one the page loaded belongs to the channel being replaced.
 * Returns new objects; the form puts them in its ref and state.
 */
export function resolveConflict(
  choice: 'mine' | 'theirs',
  live: Readonly<Record<string, BaseValue>>,
  loaded: LoadedCustomer,
  state: FormState,
  kept: KeptFields,
  opts: PatchOptions
): { loaded: LoadedCustomer; state: FormState; kept: KeptFields } {
  const nextLoaded: LoadedCustomer = {
    ...loaded,
    branches: loaded.branches.map((b) => ({ ...b })),
  };
  const nextCustomer: FormCustomer = { ...state.customer };
  const nextBranches: Record<string, FormBranch> = { ...state.branches };
  const keptCustomer = new Set(kept.customer);
  const keptBranches = new Map(
    Object.entries(kept.branches).map(([id, fs]) => [id, new Set(fs)] as const)
  );
  const keepBranch = (id: string, f: BranchEditField, on: boolean) => {
    const set = keptBranches.get(id) ?? new Set<BranchEditField>();
    if (on) set.add(f);
    else set.delete(f);
    keptBranches.set(id, set);
  };
  // What he changed, against what the form loaded before this choice.
  const changed = new Set(sentPaths(buildEnrichmentPatch(loaded, state, opts)));

  const points = new Map<string, boolean>();
  for (const [path, value] of Object.entries(live)) {
    const p = parseFieldPath(path);
    if (!p) continue;
    // His: a field he changed, which "Keep mine" leaves in his box. Kept (named
    // in the overrides) only when the live value moved from the one it loaded.
    const his = choice === 'mine' && changed.has(path);
    if (p.scope === 'customer') {
      const moved = !sameEditValue(p.field, valueOf(nextLoaded, p.field), value);
      (nextLoaded as Record<string, unknown>)[p.field] = value;
      if (his) {
        if (moved) keptCustomer.add(p.field);
        continue;
      }
      keptCustomer.delete(p.field);
      if (p.field !== 'paymentTerms') {
        (nextCustomer as Record<string, unknown>)[p.field] = boxValue(p.field, value);
      }
      // The channel's live value takes its sub-channel with it: the live one
      // when this answer carries it, else none — never the one the page loaded,
      // which belongs to another channel (a channel is stale only when the one
      // loaded is not the live one). Put back, it read "— Pick a sub-channel —"
      // yet passed the FULL gate (review finding 6). An empty box is sent as
      // null against the base loaded: converged when the live one is empty too,
      // else a new conflict that shows it.
      if (p.field === 'channelId') {
        const sub = live['customer.subChannelId'];
        nextCustomer.subChannelId = sub === undefined ? '' : String(boxValue('subChannelId', sub));
      }
      continue;
    }
    const lb = nextLoaded.branches.find((b) => b.id === p.branchId);
    if (!lb || !nextBranches[p.branchId]) continue;
    const was = valueOf(lb, p.field);
    (lb as Record<string, unknown>)[p.field] = value;
    if (
      p.field === 'gpsLat' ||
      p.field === 'gpsLng' ||
      p.field === 'gpsAccuracy' ||
      p.field === 'gpsCapturedAt'
    ) {
      // The point is one box: his if he moved it, else the live one.
      points.set(p.branchId, choice === 'mine' && changed.has(`branch.${p.branchId}.gpsLat`));
      continue;
    }
    // A keep made in an earlier round stays when this one finds the value unmoved.
    if (!his) keepBranch(p.branchId, p.field, false);
    else if (!sameEditValue(p.field, was, value)) keepBranch(p.branchId, p.field, true);
    const key = BRANCH_BOX[p.field];
    if (!his && key) {
      nextBranches[p.branchId] = { ...nextBranches[p.branchId]!, [key]: boxValue(p.field, value) };
    }
  }
  // The location, once every column of the slot is in nextLoaded.
  for (const [id, keepPoint] of points) {
    keepBranch(id, 'gpsLat', keepPoint);
    keepBranch(id, 'gpsLng', keepPoint);
    if (keepPoint) continue;
    const lb = nextLoaded.branches.find((b) => b.id === id)!;
    nextBranches[id] = {
      ...nextBranches[id]!,
      gps: pointOf(lb.gpsLat, lb.gpsLng, lb.gpsAccuracy, lb.gpsCapturedAt),
    };
  }

  const branchesKept: Record<string, BranchEditField[]> = {};
  for (const [id, set] of keptBranches) if (set.size > 0) branchesKept[id] = [...set];
  return {
    loaded: nextLoaded,
    state: { customer: nextCustomer, branches: nextBranches },
    kept: { customer: [...keptCustomer], branches: branchesKept },
  };
}

/** A branch as the phone draft keeps it: its boxes, and the "counted" value loaded when it was written. */
export type DraftBranch = FormBranch & { confirmedLoaded?: boolean };

/**
 * The branch boxes as the autosave writes them to the phone. Each carries
 * `confirmedLoaded`, the "counted" value the form had loaded (loadedRef: the
 * page's, moved only by a conflict choice) when it was written, because the
 * draft's starting values (enrichmentBase) leave "counted" out and must stay as
 * they are. Without it a restore cannot tell a tick or an untick the person
 * made from the loaded value the autosave merely carried along
 * (restoreBranchStates).
 */
export function draftBranchStates(
  states: Readonly<Record<string, FormBranch>>,
  loaded: LoadedCustomer
): Record<string, DraftBranch> {
  const out: Record<string, DraftBranch> = {};
  for (const [id, s] of Object.entries(states)) {
    const lb = loaded.branches.find((b) => b.id === id);
    out[id] = lb ? { ...s, confirmedLoaded: lb.equipmentConfirmed } : { ...s };
  }
  return out;
}

/**
 * The branch boxes a phone draft restores (lib/enrichment-draft.ts decides
 * whether it may). Only branches the page shows — one handed to another route
 * since is ignored, where it used to be sent and refused ("You can only edit
 * branches on your route."). Only values of the right type; a key the draft
 * does not have keeps what the page loaded.
 *
 * "Counted" is outside the draft's starting values, so a draft can outlive a
 * change to it: its saved value comes back only when the value loaded then
 * (`confirmedLoaded`, draftBranchStates) is the value loaded now. So:
 *   - a tick made against a loaded false comes back while it is still false;
 *   - a Steward's or Manager's untick made against a loaded true comes back
 *     while it is still true (the tab reloading before submit lost it);
 *   - an untouched true the autosave carried along does not come back over an
 *     untick made since — it would be sent as his tick, re-counting a branch a
 *     Steward or Manager had just taken back (review findings 1 and 4);
 *   - an untouched false does not take back a tick made since.
 * A draft without `confirmedLoaded` (before it existed) keeps what the page loaded.
 */
export function restoreBranchStates(
  prev: Readonly<Record<string, FormBranch>>,
  saved: unknown,
  shown: ReadonlyArray<{ id: string }>
): Record<string, FormBranch> {
  const next: Record<string, FormBranch> = { ...prev };
  if (!saved || typeof saved !== 'object') return next;
  for (const { id } of shown) {
    const d = (saved as Record<string, unknown>)[id];
    const was = prev[id];
    if (!was || !d || typeof d !== 'object') continue;
    const r = d as Record<string, unknown>;
    const str = (k: 'address' | 'areaDescription' | 'openingHours' | 'deliveryWindow') =>
      typeof r[k] === 'string' ? (r[k] as string) : was[k];
    const num = (k: 'coolers' | 'stands' | 'bottles') =>
      typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : was[k];
    const g = r.gps as Record<string, unknown> | null | undefined;
    const gps =
      g && typeof g === 'object' && typeof g.lat === 'number' && typeof g.lng === 'number'
        ? ({
            lat: g.lat,
            lng: g.lng,
            accuracy: typeof g.accuracy === 'number' ? g.accuracy : undefined,
            capturedAt: isoOf(g.capturedAt) ?? new Date(),
            ...(g.isManual === true ? { isManual: true } : {}),
            ...(typeof g.manualReason === 'string' ? { manualReason: g.manualReason } : {}),
          } satisfies FormGps)
        : was.gps;
    next[id] = {
      address: str('address'),
      areaDescription: str('areaDescription'),
      gps,
      dayOfVisit:
        typeof r.dayOfVisit === 'string'
          ? (r.dayOfVisit as FormBranch['dayOfVisit'])
          : was.dayOfVisit,
      openingHours: str('openingHours'),
      deliveryWindow: str('deliveryWindow'),
      coolers: num('coolers'),
      stands: num('stands'),
      bottles: num('bottles'),
      confirmed:
        typeof r.confirmed === 'boolean' &&
        typeof r.confirmedLoaded === 'boolean' &&
        r.confirmedLoaded === was.confirmed
          ? r.confirmed
          : was.confirmed,
    };
  }
  return next;
}

/** "Keep mine" choices saved with a draft: only fields and shown branches this build knows. */
export function restoreKept(saved: unknown, shown: ReadonlyArray<{ id: string }>): KeptFields {
  if (!saved || typeof saved !== 'object') return NO_KEPT_FIELDS;
  const s = saved as { customer?: unknown; branches?: unknown };
  const customer = Array.isArray(s.customer)
    ? s.customer.filter(
        (f): f is CustomerEditField =>
          typeof f === 'string' && parseFieldPath(`customer.${f}`) !== null
      )
    : [];
  const branches: Record<string, BranchEditField[]> = {};
  if (s.branches && typeof s.branches === 'object') {
    for (const { id } of shown) {
      const fs = (s.branches as Record<string, unknown>)[id];
      if (!Array.isArray(fs)) continue;
      const known = fs.filter(
        (f): f is BranchEditField =>
          typeof f === 'string' && parseFieldPath(`branch.${id}.${f}`) !== null
      );
      if (known.length > 0) branches[id] = known;
    }
  }
  return { customer, branches };
}
