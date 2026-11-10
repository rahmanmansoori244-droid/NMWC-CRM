/**
 * When the enrichment form may restore the draft it keeps on the phone
 * (benchmark item 22, owner decision 2026-09-25: Save draft matches the guide —
 * the draft "stays on your phone").
 *
 * The old rule restored a draft only if it was saved after Customer.updatedAt.
 * But attaching a photo bumps updatedAt, and the draft is not re-saved on a
 * photo — so the usual order in a shop (type, then photograph) made every
 * draft "older than the latest server changes", and a reload threw it away.
 * It also compared the phone's clock with the server's.
 *
 * Now the draft records the server values the form started from (`base`). A
 * draft is stale only when those values have changed on the server since — an
 * approved edit, an import — which is the case the old warning was written for.
 * Photos are not in the base: a photo is saved the moment it is taken.
 *
 * The draft holds the form's boxes: the customer's text fields, `branchStates`
 * by branch id (since phase 2 with an optional `confirmed`, and the value it
 * was loaded as, `confirmedLoaded` — lib/enrichment-patch.ts
 * restoreBranchStates), `savedAt`, `base` and, after a "Keep mine" (phase 2,
 * ruling 1), `kept`.
 *
 * Code review 2026-11-10, finding 5: the form wrote this copy half a second
 * after it opened, changed or not, so most copies on a phone held no change at
 * all. The form now writes one only while its boxes differ from what the page
 * loaded; `draftChangedPaths` says what a copy changes from the values it
 * started from, for the copies already on phones and for the Sign out count.
 */
import type { CustomerStatus, DayOfWeek, Role } from '@prisma/client';
import {
  buildEnrichmentPatch,
  loadedFormState,
  restoreBranchStates,
  restoreCustomerBoxes,
  sentPaths,
  type LoadedCustomer,
} from './enrichment-patch';

type BranchValues = {
  id: string;
  address: string;
  areaDescription: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  dayOfVisit: string | null;
  openingHours: string | null;
  deliveryWindow: string | null;
  coolersCount: number;
  standsCount: number;
  emptyBottlesCount: number;
};

type CustomerValues = {
  legalName: string;
  crNumber: string | null;
  channelId: string | null;
  subChannelId: string | null;
  primaryPhone: string | null;
  altPhone: string | null;
  contactPerson: string | null;
  contactRole: string | null;
  status: string;
  notes: string | null;
  branches: BranchValues[];
};

/** The server values the form edits, as one comparable string. */
export function enrichmentBase(c: CustomerValues): string {
  return JSON.stringify([
    c.legalName,
    c.crNumber,
    c.channelId,
    c.subChannelId,
    c.primaryPhone,
    c.altPhone,
    c.contactPerson,
    c.contactRole,
    c.status,
    c.notes,
    [...c.branches]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((b) => [
        b.id,
        b.address,
        b.areaDescription,
        b.gpsLat,
        b.gpsLng,
        b.dayOfVisit,
        b.openingHours,
        b.deliveryWindow,
        b.coolersCount,
        b.standsCount,
        b.emptyBottlesCount,
      ]),
  ]);
}

/**
 * Restore the draft, or drop it as stale. `base` is the server values when the
 * draft was written.
 *
 * Phase 2 (F06): a draft with no base — saved before item 22, so days old by
 * now — is dropped. It used to be kept by the old clock rule; but the form now
 * sends every value that differs from what the page loaded as a deliberate
 * change, and without a base nothing says which of the draft's values were
 * typed and which were merely what the page showed then. Restored, an untouched
 * old value would be sent over a newer one.
 *
 * Nothing but the base decides, so enrichmentBase's output must never change
 * for the same values: a new field in it would drop every draft on every phone
 * (tests/unit/enrichment-draft.test.ts pins it). "Counted" (F21) and the GPS
 * capture time and accuracy are left out of it for that reason.
 */
export function draftIsStale(draft: Readonly<Record<string, unknown>>, currentBase: string): boolean {
  return typeof draft.base !== 'string' || draft.base !== currentBase;
}

const textOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const numberOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isFinite(v));
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The values a `base` was written from: the strict inverse of enrichmentBase.
 * Null for anything that is not exactly its output — no base at all (a copy
 * saved before item 22), a damaged one, or one from a build that wrote another
 * shape. Then nothing says what the copy started from.
 */
export function valuesOfBase(base: unknown): CustomerValues | null {
  if (typeof base !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(base);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 11) return null;
  const [
    legalName,
    crNumber,
    channelId,
    subChannelId,
    primaryPhone,
    altPhone,
    contactPerson,
    contactRole,
    status,
    notes,
    rows,
  ] = parsed as unknown[];
  if (typeof legalName !== 'string' || typeof status !== 'string' || !Array.isArray(rows)) return null;
  if (
    !textOrNull(crNumber) ||
    !textOrNull(channelId) ||
    !textOrNull(subChannelId) ||
    !textOrNull(primaryPhone) ||
    !textOrNull(altPhone) ||
    !textOrNull(contactPerson) ||
    !textOrNull(contactRole) ||
    !textOrNull(notes)
  ) {
    return null;
  }
  const branches: BranchValues[] = [];
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row) || row.length !== 11) return null;
    const [
      id,
      address,
      areaDescription,
      gpsLat,
      gpsLng,
      dayOfVisit,
      openingHours,
      deliveryWindow,
      coolersCount,
      standsCount,
      emptyBottlesCount,
    ] = row as unknown[];
    if (
      typeof id !== 'string' ||
      typeof address !== 'string' ||
      !textOrNull(areaDescription) ||
      !numberOrNull(gpsLat) ||
      !numberOrNull(gpsLng) ||
      !textOrNull(dayOfVisit) ||
      !textOrNull(openingHours) ||
      !textOrNull(deliveryWindow) ||
      !count(coolersCount) ||
      !count(standsCount) ||
      !count(emptyBottlesCount)
    ) {
      return null;
    }
    branches.push({
      id,
      address,
      areaDescription,
      gpsLat,
      gpsLng,
      dayOfVisit,
      openingHours,
      deliveryWindow,
      coolersCount,
      standsCount,
      emptyBottlesCount,
    });
  }
  return {
    legalName,
    crNumber,
    channelId,
    subChannelId,
    primaryPhone,
    altPhone,
    contactPerson,
    contactRole,
    status,
    notes,
    branches,
  };
}

/**
 * What a phone copy changes from the values it started from, as the paths the
 * form would send ('customer.notes', 'branch.<id>.gpsLat'). Empty for a copy
 * that only mirrors those values — what the old form wrote on every visit. Null
 * when the copy has no readable base: then nothing says what was typed.
 *
 * It rebuilds what the page had loaded from the copy's own `base` ("counted"
 * from each branch's `confirmedLoaded`, which the base leaves out), puts the
 * copy's boxes over it by the form's own restore rules, and asks the form's own
 * patch builder what differs. `role` decides the status and the untick of
 * "counted", which only a Manager or the Steward sends; when not given it is
 * read from the copy, which holds a `status` only for those two.
 */
export function draftChangedPaths(
  draft: Readonly<Record<string, unknown>>,
  role?: Role
): string[] | null {
  const base = valuesOfBase(draft.base);
  if (!base) return null;
  const saved =
    draft.branchStates && typeof draft.branchStates === 'object'
      ? (draft.branchStates as Record<string, unknown>)
      : {};
  const loaded: LoadedCustomer = {
    ...base,
    status: base.status as CustomerStatus,
    branches: base.branches.map((b) => {
      const s = saved[b.id] as { confirmedLoaded?: unknown } | null | undefined;
      return {
        ...b,
        dayOfVisit: b.dayOfVisit as DayOfWeek | null,
        gpsAccuracy: null,
        gpsCapturedAt: null,
        equipmentConfirmed: !!s && typeof s === 'object' && s.confirmedLoaded === true,
      };
    }),
  };
  const who: Role = role ?? ('status' in draft ? 'MANAGER' : 'SALESMAN');
  const opening = loadedFormState(loaded);
  const state = {
    customer: restoreCustomerBoxes(opening.customer, draft, who),
    branches: restoreBranchStates(opening.branches, draft.branchStates, loaded.branches),
  };
  return sentPaths(buildEnrichmentPatch(loaded, state, { role: who, lockName: false, lockCr: false }));
}
