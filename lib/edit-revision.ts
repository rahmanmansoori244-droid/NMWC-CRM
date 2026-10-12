/**
 * Gap 12 (data audit 2026-10-10, lossless paths): what one round of a
 * new-customer request contained when it was sent.
 *
 * A request sent back for correction is re-sent on the same CustomerEdit row,
 * which overwrites its drafts, terms, credit figures and chain. EditRevision keeps
 * every round, written by the submit transaction (services/creates.ts), so "what
 * did the Finance Manager approve in round one" stays answerable.
 *
 * Non-personal values are kept as they are: channel, sub-channel, terms, credit
 * figures, the chain, and per shop its route, region, visit day, counts and photo
 * ids, and the documents by kind. Personal values — the name, CR number, phones,
 * contact, e-mail, notes, a shop's name, address, area, hours and GPS point — are
 * kept as fingerprints (lib/fingerprint.ts) only: enough to say a value changed
 * between rounds, never the value.
 *
 * PURE: tested on its own (tests/unit/edit-revision.test.ts).
 */
import { canonicalJson, fingerprint, sha256Hex } from './fingerprint';

export const REVISION_PAYLOAD_VERSION = 1;

export type RevisionCustomer = {
  legalName: string;
  paymentTerms: string;
  crNumber: string | null;
  channelId: string | null;
  subChannelId: string | null;
  primaryPhone: string | null;
  altPhone: string | null;
  contactPerson: string | null;
  contactRole: string | null;
  email: string | null;
  notes: string | null;
  crPhotoAttachmentId: string | null;
};

export type RevisionBranch = {
  id: string;
  branchName: string;
  routeId: string;
  regionId: string;
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
  shopPhotoAttachmentId: string | null;
  signboardPhotoAttachmentId: string | null;
  extraPhotoAttachmentIds: unknown;
};

export type RevisionDocument = { id: string; kind: string };

/** The fingerprinted personal fields of the customer draft. */
const CUSTOMER_FINGERPRINTED = [
  'legalName',
  'crNumber',
  'primaryPhone',
  'altPhone',
  'contactPerson',
  'contactRole',
  'email',
  'notes',
] as const;

/** The fingerprinted personal fields of a shop draft. */
const BRANCH_FINGERPRINTED = [
  'branchName',
  'address',
  'areaDescription',
  'openingHours',
  'deliveryWindow',
] as const;

function stringIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function revisionPayload(input: {
  customer: RevisionCustomer;
  branches: readonly RevisionBranch[];
  documents: readonly RevisionDocument[];
}): Record<string, unknown> {
  const c = input.customer;
  return {
    v: REVISION_PAYLOAD_VERSION,
    customer: {
      paymentTerms: c.paymentTerms,
      channelId: c.channelId,
      subChannelId: c.subChannelId,
      crPhotoAttachmentId: c.crPhotoAttachmentId,
      fingerprints: Object.fromEntries(
        CUSTOMER_FINGERPRINTED.map((f) => [f, fingerprint(`customer.${f}`, c[f])])
      ),
    },
    // In draft id order: the order finalize numbers the shops in (lib/create-finalize.ts).
    branches: [...input.branches]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((b) => ({
        draftId: b.id,
        routeId: b.routeId,
        regionId: b.regionId,
        dayOfVisit: b.dayOfVisit,
        coolersCount: b.coolersCount,
        standsCount: b.standsCount,
        emptyBottlesCount: b.emptyBottlesCount,
        hasGps: b.gpsLat != null && b.gpsLng != null,
        shopPhotoAttachmentId: b.shopPhotoAttachmentId,
        signboardPhotoAttachmentId: b.signboardPhotoAttachmentId,
        extraPhotoAttachmentIds: stringIds(b.extraPhotoAttachmentIds),
        fingerprints: {
          ...Object.fromEntries(BRANCH_FINGERPRINTED.map((f) => [f, fingerprint(`branch.${f}`, b[f])])),
          gps:
            b.gpsLat != null && b.gpsLng != null ? fingerprint('branch.gps', `${b.gpsLat},${b.gpsLng}`) : null,
        },
      })),
    // Every photo and document the round referenced, by kind (ids only).
    documents: [...input.documents]
      .map((d) => ({ id: d.id, kind: d.kind }))
      .sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : a.kind + a.id > b.kind + b.id ? 1 : 0)),
  };
}

/** SHA-256 of the payload's canonical JSON: two rounds that sent the same thing hash the same. */
export function revisionPayloadSha256(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}
