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
 */
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
 * draft was written; a draft from before item 22 has none, and keeps the old
 * clock rule rather than being restored over newer server values.
 */
export function draftIsStale(
  draft: { base?: unknown; savedAt?: unknown },
  currentBase: string,
  customerUpdatedAtMs: number
): boolean {
  if (typeof draft.base === 'string') return draft.base !== currentBase;
  return typeof draft.savedAt === 'number' && draft.savedAt < customerUpdatedAtMs;
}
