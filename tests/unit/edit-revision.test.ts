// @vitest-environment node
/**
 * Gap 12 (data audit 2026-10-10, lossless paths): what one round of a
 * new-customer request contained (lib/edit-revision.ts), and the fingerprints it
 * keeps instead of personal values (lib/fingerprint.ts).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { canonicalJson, fingerprint, sha256Hex } from '@/lib/fingerprint';
import { revisionPayload, revisionPayloadSha256, type RevisionBranch, type RevisionCustomer } from '@/lib/edit-revision';

const customer: RevisionCustomer = {
  legalName: 'Al Noor Trading',
  paymentTerms: 'CREDIT',
  crNumber: '1234567',
  channelId: 'ch1',
  subChannelId: 'sub1',
  primaryPhone: '+96891111111',
  altPhone: null,
  contactPerson: 'Said',
  contactRole: 'Owner',
  email: 'accounts@alnoor.om',
  notes: 'Back door',
  crPhotoAttachmentId: 'att-cr',
};
const branch = (id: string, over: Partial<RevisionBranch> = {}): RevisionBranch => ({
  id,
  branchName: 'Main shop',
  routeId: 'r1',
  regionId: 'g1',
  address: 'Way 12, Muscat',
  areaDescription: null,
  gpsLat: 23.588,
  gpsLng: 58.3829,
  dayOfVisit: 'SUN',
  openingHours: '08:00-22:00',
  deliveryWindow: null,
  coolersCount: 2,
  standsCount: 1,
  emptyBottlesCount: 0,
  shopPhotoAttachmentId: `shop-${id}`,
  signboardPhotoAttachmentId: null,
  extraPhotoAttachmentIds: ['x1', 7, null],
  ...over,
});

describe('fingerprint', () => {
  it('is the SHA-256 of the scheme, the field and the value; none for no value', () => {
    expect(fingerprint('customer.legalName', 'Al Noor')).toBe(
      createHash('sha256').update('nmwc-fp-v1\u0000customer.legalName\u0000Al Noor').digest('hex')
    );
    expect(fingerprint('customer.email', null)).toBeNull();
    expect(fingerprint('customer.email', undefined)).toBeNull();
  });

  it('the same text in two fields gives two fingerprints', () => {
    expect(fingerprint('customer.primaryPhone', '+96891111111')).not.toBe(fingerprint('customer.altPhone', '+96891111111'));
  });

  it('canonical JSON sorts keys at every depth and writes decimals and dates as JSON does', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null }, u: undefined })).toBe(
      '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}'
    );
    expect(canonicalJson({ v: new Prisma.Decimal('1.50'), at: new Date('2026-01-01T00:00:00Z') })).toBe(
      '{"at":"2026-01-01T00:00:00.000Z","v":"1.5"}'
    );
    expect(sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });
});

describe('revisionPayload', () => {
  const payload = revisionPayload({
    customer,
    branches: [branch('d2', { gpsLat: null, gpsLng: null }), branch('d1')],
    documents: [
      { id: 'p-tax', kind: 'TAX_CARD' },
      { id: 'att-cr', kind: 'CR' },
    ],
  });
  const text = JSON.stringify(payload);

  it('holds no personal value: the name, CR number, phones, contact, e-mail, notes and shop details are fingerprints', () => {
    for (const value of ['Al Noor', '1234567', '91111111', 'Said', 'accounts@', 'Back door', 'Way 12', 'Main shop', '08:00', '23.588', '58.38']) {
      expect(text, value).not.toContain(value);
    }
    expect(payload.customer).toMatchObject({
      paymentTerms: 'CREDIT',
      channelId: 'ch1',
      subChannelId: 'sub1',
      crPhotoAttachmentId: 'att-cr',
      fingerprints: {
        legalName: fingerprint('customer.legalName', 'Al Noor Trading'),
        crNumber: fingerprint('customer.crNumber', '1234567'),
        primaryPhone: fingerprint('customer.primaryPhone', '+96891111111'),
        altPhone: null,
        email: fingerprint('customer.email', 'accounts@alnoor.om'),
      },
    });
  });

  it('keeps each shop’s non-personal values, in draft id order (the order finalize numbers them in)', () => {
    const shops = payload.branches as Array<Record<string, unknown>>;
    expect(shops.map((b) => b.draftId)).toEqual(['d1', 'd2']);
    expect(shops[0]).toMatchObject({
      routeId: 'r1',
      regionId: 'g1',
      dayOfVisit: 'SUN',
      coolersCount: 2,
      standsCount: 1,
      emptyBottlesCount: 0,
      hasGps: true,
      shopPhotoAttachmentId: 'shop-d1',
      extraPhotoAttachmentIds: ['x1'],
    });
    expect(shops[1]).toMatchObject({ hasGps: false, fingerprints: { gps: null } });
    expect((shops[0]!.fingerprints as Record<string, unknown>).gps).toBe(fingerprint('branch.gps', '23.588,58.3829'));
  });

  it('lists the documents by kind', () => {
    expect(payload.documents).toEqual([
      { id: 'att-cr', kind: 'CR' },
      { id: 'p-tax', kind: 'TAX_CARD' },
    ]);
  });

  it('two rounds that sent the same thing hash the same; a changed limit-free detail changes the hash', () => {
    const again = revisionPayload({
      customer: { ...customer },
      branches: [branch('d1'), branch('d2', { gpsLat: null, gpsLng: null })],
      documents: [
        { id: 'att-cr', kind: 'CR' },
        { id: 'p-tax', kind: 'TAX_CARD' },
      ],
    });
    expect(revisionPayloadSha256(again)).toBe(revisionPayloadSha256(payload));
    const moved = revisionPayload({ customer, branches: [branch('d1', { routeId: 'r9' })], documents: [] });
    expect(revisionPayloadSha256(moved)).not.toBe(revisionPayloadSha256(payload));
    expect(revisionPayloadSha256(payload)).toMatch(/^[0-9a-f]{64}$/);
  });
});
