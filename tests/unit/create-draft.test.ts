// @vitest-environment node
/**
 * lib/create-draft.ts — the new-customer form's copy on the phone (code review
 * 2026-11-10, finding 4): the whole form now, not only its typed text. What is
 * pinned here: a copy the form writes comes back exactly; a copy the old form
 * wrote is still read (text only); nothing that is not an id is ever read as a
 * photo id (it goes into a photo URL); and what "differs from what is saved"
 * means.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_DRAFT_BRANCHES,
  comparableCreateForm,
  createCopyHoldsWork,
  createFormSummary,
  emptyCreateBranch,
  emptyCreateForm,
  parseCreateCopy,
  parseSignedPagesCopy,
  serializeCreateCopy,
  typedAnything,
  type CreateDraftForm,
} from '@/lib/create-draft';
import { MAX_PAGES_PER_DOCUMENT, MAX_SIGNED_FORM_PAGES } from '@/lib/credit-documents';

const SID = '3f1c1d2e-7a4b-4c5d-9e8f-0a1b2c3d4e5f';
const SID2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/** A credit request, two shops, every kind of thing the form holds. */
const full = (): CreateDraftForm => ({
  legalName: 'Blue Sea Cafe',
  paymentTerms: 'CREDIT',
  crNumber: '7654321',
  channelId: 'ch1',
  subChannelId: 'sc1',
  primaryPhone: '9123 4567',
  altPhone: '',
  contactPerson: 'Said',
  contactRole: 'Owner',
  notes: 'Closed Fridays',
  creditLimit: '500',
  termDays: '30',
  email: 'accounts@bluesea.om',
  crPhotoId: 'att-cr',
  guaranteeIds: ['att-g1'],
  creditDocs: { ID_CARD: ['att-id1', 'att-id2'], MEMBERSHIP_CERT: [], VAT_CERT: ['att-vat'], TAX_CARD: [] },
  branches: [
    {
      branchName: 'Main',
      address: 'Way 1, Ruwi',
      areaDescription: 'Opposite the bakery',
      gps: { lat: 23.5881, lng: 58.3829, accuracy: 9, capturedAt: '2026-11-10T06:00:00.000Z' },
      dayOfVisit: 'SUN',
      openingHours: '08:00 – 22:00',
      deliveryWindow: '',
      coolers: 2,
      stands: 0,
      bottles: 40,
      shopPhotoId: 'att-shop',
      signboardPhotoId: 'att-sign',
      extraPhotoIds: [null, 'att-extra'],
    },
    {
      branchName: 'Seeb',
      address: 'Way 2, Seeb',
      areaDescription: '',
      gps: {
        lat: 23.67,
        lng: 58.19,
        capturedAt: '2026-11-10T06:30:00.000Z',
        isManual: true,
        manualReason: 'No fix inside the mall',
      },
      dayOfVisit: '',
      openingHours: '',
      deliveryWindow: '',
      coolers: 0,
      stands: 1,
      bottles: 0,
      shopPhotoId: null,
      signboardPhotoId: null,
      extraPhotoIds: [null, null],
    },
  ],
});
const stored = (over: Record<string, unknown> = {}, form = full()) =>
  JSON.stringify({ ...serializeCreateCopy({ form, savedAt: 1_700_000_000_000, unanswered: [] }), ...over });

describe('a copy the form writes comes back exactly', () => {
  it('the boxes, each shop with its point, and every photo id — nothing lost, nothing added', () => {
    const copy = parseCreateCopy(stored())!;
    expect(copy.version).toBe(2);
    expect(copy.form).toEqual(full());
    expect(copy.savedAt).toBe(1_700_000_000_000);
    expect(copy).toMatchObject({ unanswered: [], base: null, sent: [], lastSent: null });
  });

  it('with the send ids, the draft version it grew on and the last send', () => {
    const raw = JSON.stringify(
      serializeCreateCopy({
        form: full(),
        savedAt: 5,
        unanswered: [SID],
        base: SID2,
        sent: [SID],
        lastSent: { id: SID, form: comparableCreateForm(full()) },
      })
    );
    expect(parseCreateCopy(raw)).toMatchObject({
      unanswered: [SID],
      base: SID2,
      sent: [SID],
      lastSent: { id: SID, form: comparableCreateForm(full()) },
    });
  });

  it('is flat, with the text keys where the old form wrote them', () => {
    const flat = serializeCreateCopy({ form: full(), savedAt: 5, unanswered: [SID] });
    expect(flat).toMatchObject({ v: 2, legalName: 'Blue Sea Cafe', paymentTerms: 'CREDIT', email: 'accounts@bluesea.om', savedAt: 5, unanswered: [SID] });
    // Nothing about a saved draft on a never-saved form's copy.
    expect(Object.keys(flat)).not.toContain('base');
    expect(Object.keys(flat)).not.toContain('sent');
    expect(Object.keys(flat)).not.toContain('lastSent');
  });

  it('a blank form comes back blank', () => {
    const copy = parseCreateCopy(JSON.stringify(serializeCreateCopy({ form: emptyCreateForm(), savedAt: 1, unanswered: [SID] })))!;
    expect(copy.form).toEqual(emptyCreateForm());
    expect(copy.unanswered).toEqual([SID]);
  });
});

describe('a copy the old form wrote (text only) is still read', () => {
  it('its text over an otherwise blank form, as version 1', () => {
    const copy = parseCreateCopy(JSON.stringify({ legalName: 'Blue Sea Cafe', crNumber: '7654321', paymentTerms: 'CREDIT', savedAt: 3, unanswered: [SID] }))!;
    expect(copy.version).toBe(1);
    expect(copy.form).toEqual({ ...emptyCreateForm(), legalName: 'Blue Sea Cafe', crNumber: '7654321', paymentTerms: 'CREDIT' });
    expect(copy.unanswered).toEqual([SID]);
  });

  it('whether it holds anything typed', () => {
    expect(typedAnything({ legalName: '  ', notes: '', paymentTerms: 'CASH' })).toBe(false);
    expect(typedAnything({ legalName: 'Blue Sea Cafe' })).toBe(true);
    expect(typedAnything({ email: 'a@b.om' })).toBe(true);
    expect(typedAnything({ paymentTerms: 'CREDIT' })).toBe(true);
    expect(typedAnything({ legalName: 7, branches: [] })).toBe(false);
  });
});

describe('nothing that is not a copy is read as one', () => {
  it.each([null, undefined, '', '{oops', '"text"', '7', '[]', 'null'])('%s → no copy', (raw) => {
    expect(parseCreateCopy(raw as string | null)).toBeNull();
  });

  it('an empty object is an empty text-only copy', () => {
    expect(parseCreateCopy('{}')).toMatchObject({ version: 1, form: emptyCreateForm(), unanswered: [] });
  });
});

describe('a damaged or tampered copy is read defensively', () => {
  it('a photo id that is not an id is dropped: it goes into a photo URL', () => {
    const bad = ['../../admin', 'a/b', 'x?y=1', 'has space', '', 'a'.repeat(65), 7, null, { id: 'x' }, 'att%2F1', '<img>'];
    for (const id of bad) {
      const copy = parseCreateCopy(
        stored({
          crPhotoId: id,
          guaranteeIds: [id, 'att-ok'],
          creditDocs: { ID_CARD: [id, 'att-ok'], MEMBERSHIP_CERT: id, VAT_CERT: [], TAX_CARD: [] },
          branches: [{ ...full().branches[0]!, shopPhotoId: id, signboardPhotoId: id, extraPhotoIds: [id, 'att-ok'] }],
        })
      )!;
      const label = JSON.stringify(id);
      expect(copy.form.crPhotoId, label).toBeNull();
      expect(copy.form.guaranteeIds, label).toEqual(['att-ok']);
      expect(copy.form.creditDocs.ID_CARD, label).toEqual(['att-ok']);
      expect(copy.form.creditDocs.MEMBERSHIP_CERT, label).toEqual([]);
      expect(copy.form.branches[0]!.shopPhotoId, label).toBeNull();
      expect(copy.form.branches[0]!.signboardPhotoId, label).toBeNull();
      // By slot position: the bad one leaves an empty slot, the good one stays where it was.
      expect(copy.form.branches[0]!.extraPhotoIds, label).toEqual([null, 'att-ok']);
    }
    // What the app mints (a cuid) and what the tests use are ids.
    for (const id of ['cmh2x9k3b0001l508abcdwxyz', 'att-1', 'A_b-9']) {
      expect(parseCreateCopy(stored({ crPhotoId: id }))!.form.crPhotoId).toBe(id);
    }
  });

  it('a page is never twice on a document, and no list is read past the form\'s own limits', () => {
    const many = Array.from({ length: 40 }, (_, i) => `att-${i}`);
    const copy = parseCreateCopy(
      stored({
        guaranteeIds: ['att-g', 'att-g', ...many],
        creditDocs: { ID_CARD: ['att-a', 'att-a', ...many], MEMBERSHIP_CERT: [], VAT_CERT: [], TAX_CARD: [] },
        branches: Array.from({ length: 25 }, () => ({ ...emptyCreateBranch(), extraPhotoIds: many })),
        unanswered: [SID, SID, SID2, 'not-an-id', 7, ...Array.from({ length: 5 }, (_, i) => `${i}f1c1d2e-7a4b-4c5d-9e8f-0a1b2c3d4e5f`)],
      })
    )!;
    expect(copy.form.guaranteeIds).toHaveLength(10);
    expect(copy.form.guaranteeIds.filter((x) => x === 'att-g')).toHaveLength(1);
    expect(copy.form.creditDocs.ID_CARD).toEqual(['att-a', 'att-0', 'att-1', 'att-2']);
    expect(copy.form.creditDocs.ID_CARD).toHaveLength(MAX_PAGES_PER_DOCUMENT);
    expect(copy.form.branches).toHaveLength(MAX_DRAFT_BRANCHES);
    expect(copy.form.branches[0]!.extraPhotoIds).toHaveLength(10);
    // The last three sends, each once, and only real ids.
    expect(copy.unanswered).toHaveLength(3);
    expect(copy.unanswered.every((x) => /^[0-9a-f-]{36}$/.test(x))).toBe(true);
  });

  it('a point needs both coordinates and a readable capture time, or it is no point', () => {
    const point = (gps: unknown) =>
      parseCreateCopy(stored({ branches: [{ ...full().branches[0]!, gps }] }))!.form.branches[0]!.gps;
    expect(point({ lat: 23.5, lng: 58.3, capturedAt: '2026-11-10T06:00:00.000Z' })).toEqual({
      lat: 23.5,
      lng: 58.3,
      capturedAt: '2026-11-10T06:00:00.000Z',
    });
    for (const bad of [
      null,
      'here',
      { lat: 23.5 },
      { lat: '23.5', lng: 58.3, capturedAt: '2026-11-10T06:00:00.000Z' },
      { lat: 23.5, lng: null, capturedAt: '2026-11-10T06:00:00.000Z' },
      { lat: 23.5, lng: 58.3 },
      { lat: 23.5, lng: 58.3, capturedAt: 'yesterday' },
      { lat: 23.5, lng: 58.3, capturedAt: 1_700_000_000_000 },
    ]) {
      expect(point(bad), JSON.stringify(bad)).toBeNull();
    }
    // The accuracy only when it is a number; the reason only on a typed-in point.
    expect(point({ lat: 1, lng: 2, accuracy: 'good', capturedAt: '2026-11-10T06:00:00.000Z', manualReason: 'x' })).toEqual({
      lat: 1,
      lng: 2,
      capturedAt: '2026-11-10T06:00:00.000Z',
    });
    expect(point({ lat: 1, lng: 2, capturedAt: '2026-11-10T06:00:00.000Z', isManual: true, manualReason: 'No fix' })).toEqual({
      lat: 1,
      lng: 2,
      capturedAt: '2026-11-10T06:00:00.000Z',
      isManual: true,
      manualReason: 'No fix',
    });
  });

  it('boxes of the wrong type keep the blank form\'s value; a count is a whole number, never negative', () => {
    const copy = parseCreateCopy(
      stored({
        legalName: 7,
        paymentTerms: 'BARTER',
        notes: null,
        branches: [
          { branchName: 9, address: ['x'], dayOfVisit: 'SOMEDAY', coolers: -3, stands: 2.9, bottles: 'many', extraPhotoIds: 'none' },
          'not a shop',
          null,
        ],
      })
    )!;
    expect(copy.form.legalName).toBe('');
    expect(copy.form.paymentTerms).toBe('CASH');
    expect(copy.form.notes).toBe('');
    expect(copy.form.branches).toEqual([{ ...emptyCreateBranch(), stands: 2 }]);
  });

  it('a copy with no shop left in it still has one, as the form always does', () => {
    expect(parseCreateCopy(stored({ branches: [] }))!.form.branches).toEqual([emptyCreateBranch()]);
    expect(parseCreateCopy(stored({ branches: ['junk'] }))!.form.branches).toEqual([emptyCreateBranch()]);
  });

  it('the draft version and the last send are read only in their own shape', () => {
    expect(parseCreateCopy(stored({ base: 7 }))!.base).toBeNull();
    expect(parseCreateCopy(stored({ base: '' }))!.base).toBeNull();
    expect(parseCreateCopy(stored({ base: 'x'.repeat(101) }))!.base).toBeNull();
    expect(parseCreateCopy(stored({ base: 'at:1700000000000' }))!.base).toBe('at:1700000000000');
    expect(parseCreateCopy(stored({ sent: [SID, 'junk', 3] }))!.sent).toEqual([SID]);
    expect(parseCreateCopy(stored({ lastSent: { id: 'junk', form: 'x' } }))!.lastSent).toBeNull();
    expect(parseCreateCopy(stored({ lastSent: { id: SID, form: 9 } }))!.lastSent).toBeNull();
    expect(parseCreateCopy(stored({ lastSent: 'x' }))!.lastSent).toBeNull();
  });
});

describe('comparableCreateForm — what "differs from what is saved" means', () => {
  const same = (change: (f: CreateDraftForm) => void) => {
    const f = full();
    change(f);
    return comparableCreateForm(f) === comparableCreateForm(full());
  };

  it('a space at either end of a box is no change', () => {
    expect(same((f) => (f.legalName = '  Blue Sea Cafe '))).toBe(true);
    expect(same((f) => (f.branches[0]!.address = 'Way 1, Ruwi  '))).toBe(true);
    expect(same((f) => (f.notes = 'Closed Fridays\n'))).toBe(true);
  });

  it('an empty extra-photo slot is no change, wherever it sits', () => {
    expect(same((f) => (f.branches[0]!.extraPhotoIds = ['att-extra']))).toBe(true);
    expect(same((f) => (f.branches[1]!.extraPhotoIds = []))).toBe(true);
  });

  it('every box, point, count and photo is', () => {
    const changes: Array<(f: CreateDraftForm) => void> = [
      (f) => (f.legalName = 'Blue Sea Cafe LLC'),
      (f) => (f.paymentTerms = 'CASH'),
      (f) => (f.email = ''),
      (f) => (f.creditLimit = '600'),
      (f) => (f.crPhotoId = null),
      (f) => (f.crPhotoId = 'att-cr2'),
      (f) => f.guaranteeIds.push('att-g2'),
      (f) => f.creditDocs.TAX_CARD.push('att-tax'),
      (f) => f.creditDocs.ID_CARD.reverse(),
      (f) => (f.branches[0]!.branchName = 'Ruwi'),
      (f) => (f.branches[0]!.dayOfVisit = 'MON'),
      (f) => (f.branches[0]!.coolers = 3),
      (f) => (f.branches[0]!.gps = null),
      (f) => (f.branches[0]!.gps = { ...f.branches[0]!.gps!, lat: 23.6 }),
      (f) => (f.branches[0]!.gps = { ...f.branches[0]!.gps!, capturedAt: '2026-11-10T07:00:00.000Z' }),
      (f) => (f.branches[1]!.gps = { ...f.branches[1]!.gps!, manualReason: 'Another reason' }),
      (f) => (f.branches[0]!.shopPhotoId = 'att-shop2'),
      (f) => (f.branches[0]!.signboardPhotoId = null),
      (f) => (f.branches[0]!.extraPhotoIds = ['att-extra', 'att-extra2']),
      (f) => f.branches.push(emptyCreateBranch()),
      (f) => f.branches.pop(),
      (f) => f.branches.reverse(),
    ];
    changes.forEach((change, i) => expect(same(change), `change ${i}`).toBe(false));
  });
});

describe('createFormSummary — what a copy carries, for the line that names it', () => {
  it('the shop\'s name, its shops, points and photos', () => {
    // CR 1 + guarantee 1 + documents 3 + shop, signboard and one extra = 8.
    expect(createFormSummary(full())).toEqual({ name: 'Blue Sea Cafe', shops: 2, gpsPoints: 2, photos: 8 });
    expect(createFormSummary(emptyCreateForm())).toEqual({ name: '', shops: 1, gpsPoints: 0, photos: 0 });
  });
});

describe('createCopyHoldsWork — which new-customer copies Sign out counts', () => {
  const blank = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ ...serializeCreateCopy({ form: emptyCreateForm(), savedAt: 1, unanswered: [] }), ...over });

  it('a never-saved form: something typed or photographed, or a send still to be asked about', () => {
    expect(createCopyHoldsWork('new', stored())).toBe(true);
    expect(createCopyHoldsWork('new', blank())).toBe(false);
    expect(createCopyHoldsWork('new', blank({ crPhotoId: 'att-cr' }))).toBe(true);
    expect(createCopyHoldsWork('new', blank({ branches: [{ ...emptyCreateBranch(), coolers: 1 }] }))).toBe(true);
    expect(createCopyHoldsWork('new', blank({ unanswered: [SID] }))).toBe(true);
    // The old form's copies.
    expect(createCopyHoldsWork('new', JSON.stringify({ legalName: 'Blue Sea Cafe' }))).toBe(true);
    expect(createCopyHoldsWork('new', JSON.stringify({ legalName: ' ', savedAt: 1 }))).toBe(false);
  });

  it('a copy laid over a saved draft, and the signed-application pages, always: they exist only while they differ', () => {
    expect(createCopyHoldsWork('edit-7', blank())).toBe(true);
    expect(createCopyHoldsWork('signed:edit-7', '{"v":1,"ids":["p1"]}')).toBe(true);
  });

  it('an unreadable one counts: asking once too often is the safe side', () => {
    expect(createCopyHoldsWork('new', '{oops')).toBe(true);
    expect(createCopyHoldsWork('new', null)).toBe(true);
  });
});

describe('parseSignedPagesCopy — the signed-application pages kept on the phone', () => {
  const copy = (over: Record<string, unknown> = {}) => JSON.stringify({ v: 1, savedAt: 9, token: '{"v":2}', ids: ['p1', 'p2'], ...over });

  it('reads the token it was written under, the pages and the save time', () => {
    expect(parseSignedPagesCopy(copy(), MAX_SIGNED_FORM_PAGES)).toEqual({ savedAt: 9, token: '{"v":2}', ids: ['p1', 'p2'] });
  });

  it('only ids, none twice, no more than the step takes', () => {
    const ids = ['p1', 'p1', '../x', 7, null, 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    expect(parseSignedPagesCopy(copy({ ids }), MAX_SIGNED_FORM_PAGES)!.ids).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    expect(parseSignedPagesCopy(copy({ ids: 'p1' }), MAX_SIGNED_FORM_PAGES)!.ids).toEqual([]);
  });

  it.each([null, '', '{oops', '[]', '"x"', JSON.stringify({ ids: ['p1'] }), JSON.stringify({ token: 7, ids: ['p1'] })])(
    '%s → no copy (a list with no token says nothing about which visit of the step it belongs to)',
    (raw) => {
      expect(parseSignedPagesCopy(raw, MAX_SIGNED_FORM_PAGES)).toBeNull();
    }
  );
});
