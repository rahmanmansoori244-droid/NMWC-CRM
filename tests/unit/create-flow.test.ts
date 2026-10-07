/**
 * Phase 1 creation flow: schema, mandatory gate, cycle bump, attachment
 * collection, and notification-audience unit tests.
 */
import { describe, it, expect } from 'vitest';
import { PaymentTerms, Role } from '@prisma/client';
import {
  submitCreateSchema,
  collectMissingForCreate,
  collectAttachmentIds,
  resolveCycleOnSubmit,
  type ParsedSubmitCreate,
} from '@/lib/validation/create';
import { resolveStepAudience } from '@/lib/notifications';
import { INVALID_PHONE_MESSAGE } from '@/lib/phone';

const CUID = 'ckzzzzzzzz0000zzzzzzzzzzzz';
const CUID2 = 'ckzzzzzzzz0001zzzzzzzzzzzz';
const CUID3 = 'ckzzzzzzzz0002zzzzzzzzzzzz';

function completeCashInput(over: Partial<Record<string, unknown>> = {}) {
  return {
    isDraft: false,
    customer: {
      legalName: 'Al Noor Trading',
      paymentTerms: 'CASH',
      crNumber: '1234567',
      channelId: CUID,
      subChannelId: CUID2,
      primaryPhone: '+968 9123 4567',
      contactPerson: 'Said',
      crPhotoAttachmentId: CUID3,
    },
    branches: [
      {
        branchName: 'Main',
        address: 'Way 123, Al Khuwair',
        gpsLat: 23.6,
        gpsLng: 58.5,
        dayOfVisit: 'MON',
        shopPhotoAttachmentId: CUID,
        signboardPhotoAttachmentId: CUID2,
      },
    ],
    ...over,
  };
}

describe('submitCreateSchema', () => {
  it('parses a complete CASH payload', () => {
    const r = submitCreateSchema.safeParse(completeCashInput());
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.customer.paymentTerms).toBe(PaymentTerms.CASH);
      expect(r.data.branches).toHaveLength(1);
      expect(r.data.guaranteeAttachmentIds).toEqual([]);
    }
  });

  it('requires legalName and paymentTerms even for drafts', () => {
    const r = submitCreateSchema.safeParse({
      isDraft: true,
      customer: { legalName: 'x' }, // too short + missing paymentTerms
      branches: [{ branchName: 'Main' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects GPS outside the Oman envelope', () => {
    const bad = completeCashInput();
    (bad.branches[0] as Record<string, unknown>).gpsLat = 33.3; // Baghdad, not Oman
    const r = submitCreateSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it('caps branches at 10 and requires at least 1', () => {
    const none = submitCreateSchema.safeParse(completeCashInput({ branches: [] }));
    expect(none.success).toBe(false);
    const eleven = submitCreateSchema.safeParse(
      completeCashInput({
        branches: Array.from({ length: 11 }, () => ({ branchName: 'B', address: 'xyz' })),
      })
    );
    expect(eleven.success).toBe(false);
  });

  it('rounds the requested credit limit to 3 decimal places (OMR baisa)', () => {
    const r = submitCreateSchema.safeParse(
      completeCashInput({
        customer: { ...completeCashInput().customer, paymentTerms: 'CREDIT' },
        credit: { requestedCreditLimit: 500.12349, requestedPaymentTermDays: 30 },
      })
    );
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.credit?.requestedCreditLimit).toBe(500.123);
  });

  it('rejects zero / negative credit limits and out-of-range term days', () => {
    const zero = submitCreateSchema.safeParse(
      completeCashInput({ credit: { requestedCreditLimit: 0 } })
    );
    expect(zero.success).toBe(false);
    const days = submitCreateSchema.safeParse(
      completeCashInput({ credit: { requestedPaymentTermDays: 400 } })
    );
    expect(days.success).toBe(false);
  });

  it('enforces name lengths AFTER stripping HTML (adversarial-review fix)', () => {
    // '<Shop>' is 6 raw chars but empty after stripHtml — must NOT pass.
    const empty = submitCreateSchema.safeParse(
      completeCashInput({ customer: { ...completeCashInput().customer, legalName: '<Shop>' } })
    );
    expect(empty.success).toBe(false);
    // Legit markup-wrapped name survives, stripped.
    const ok = submitCreateSchema.safeParse(
      completeCashInput({
        customer: { ...completeCashInput().customer, legalName: 'Ahmed <b>Trading</b> LLC' },
      })
    );
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.customer.legalName).toBe('Ahmed Trading LLC');
  });

  it('accepts Arabic-Indic digit phone input (UXI-006 — normalized server-side)', () => {
    const r = submitCreateSchema.safeParse(
      completeCashInput({
        customer: { ...completeCashInput().customer, primaryPhone: '٩١٢٣٤٥٦٧' },
      })
    );
    expect(r.success).toBe(true);
  });

  // F19: the schema applies lib/phone.ts's own rule instead of a regex of its own,
  // which refused Persian digits and let through strings nothing could normalize.
  const withPhone = (primaryPhone: string, altPhone?: string) =>
    submitCreateSchema.safeParse(
      completeCashInput({ customer: { ...completeCashInput().customer, primaryPhone, altPhone } })
    );

  it('accepts Persian digits, and keeps the value as typed (services/creates.ts normalizes it)', () => {
    const r = withPhone('۹۱۲۳۴۵۶۷', '٩١٢٣ ۴۵۶۷');
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.customer.primaryPhone).toBe('۹۱۲۳۴۵۶۷');
      expect(r.data.customer.altPhone).toBe('٩١٢٣ ۴۵۶۷');
    }
  });

  it("still reads '' as 'not given'", () => {
    const r = withPhone('', '');
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.customer.primaryPhone).toBeUndefined();
      expect(r.data.customer.altPhone).toBeUndefined();
    }
  });

  it('refuses a number that is not an Oman phone, with the words the service used', () => {
    for (const bad of ['1234567', '12345678901234', 'call 91234567']) {
      const r = withPhone(bad);
      expect(r.success, bad).toBe(false);
      if (!r.success) {
        expect(r.error.issues.find((i) => i.path.join('.') === 'customer.primaryPhone')?.message).toBe(
          INVALID_PHONE_MESSAGE
        );
      }
    }
    const alt = withPhone('91234567', '123');
    expect(alt.success).toBe(false);
  });

  it("still refuses '<shop>' as a legal name — the strip helper moved, the rule did not", () => {
    const r = submitCreateSchema.safeParse(
      completeCashInput({ customer: { ...completeCashInput().customer, legalName: '<shop>' } })
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toBe('Legal name must be at least 2 characters.');
    }
  });
});

// Review of phase 2 (N02's claim, made true): CREATE's optional text fields
// checked the raw length and stripped after, so '<b></b>' was stored as '' and a
// long note wrapped in a tag was refused. They now strip, then validate.
describe('submitCreateSchema — optional text strips, then validates', () => {
  const withCustomer = (field: string, value: unknown) =>
    submitCreateSchema.safeParse(
      completeCashInput({ customer: { ...completeCashInput().customer, [field]: value } })
    );
  const withBranch = (field: string, value: unknown) =>
    submitCreateSchema.safeParse(
      completeCashInput({ branches: [{ ...completeCashInput().branches[0], [field]: value }] })
    );
  const CUSTOMER_TEXT = [
    ['contactRole', 200],
    ['notes', 5000],
  ] as const;
  const BRANCH_TEXT = [
    ['address', 500],
    ['areaDescription', 500],
    ['openingHours', 100],
    ['deliveryWindow', 100],
  ] as const;

  it.each(CUSTOMER_TEXT)(
    "customer.%s: tag-only and whitespace-only are 'not given', not ''",
    (field) => {
      for (const blank of ['<b></b>', '   ', '<p> </p>', '']) {
        const r = withCustomer(field, blank);
        expect(r.success, JSON.stringify(blank)).toBe(true);
        if (r.success) expect(r.data.customer[field], JSON.stringify(blank)).toBeUndefined();
      }
    }
  );

  it.each(BRANCH_TEXT)(
    "branch.%s: tag-only and whitespace-only are 'not given', not ''",
    (field) => {
      for (const blank of ['<b></b>', '   ', '<p> </p>', '']) {
        const r = withBranch(field, blank);
        expect(r.success, JSON.stringify(blank)).toBe(true);
        if (r.success) expect(r.data.branches[0][field], JSON.stringify(blank)).toBeUndefined();
      }
    }
  );

  it.each([...CUSTOMER_TEXT, ...BRANCH_TEXT])(
    '%s: the length is judged on what is stored, not on the markup',
    (field, max) => {
      const parse = CUSTOMER_TEXT.some(([f]) => f === field) ? withCustomer : withBranch;
      const pick = (r: ReturnType<typeof parse>) =>
        r.success
          ? ((r.data.customer as Record<string, unknown>)[field] ??
            (r.data.branches[0] as Record<string, unknown>)[field])
          : undefined;
      // max characters wrapped in a tag fit, stripped.
      const wrapped = parse(field, `<p>${'x'.repeat(max)}</p>`);
      expect(wrapped.success).toBe(true);
      expect(pick(wrapped)).toBe('x'.repeat(max));
      // One more than max, once stripped, is refused — on the field's own key.
      const over = parse(field, `<p>${'x'.repeat(max + 1)}</p>`);
      expect(over.success).toBe(false);
      if (!over.success) expect(over.error.issues[0]?.path.at(-1)).toBe(field);
      // Ordinary text is kept, stripped and trimmed.
      expect(pick(parse(field, '  Owner <i>Ali</i> '))).toBe('Owner Ali');
    }
  );

  it('a tag-only address is simply missing, and the submit gate asks for it', () => {
    const r = withBranch('address', '<b></b>');
    expect(r.success).toBe(true);
    if (r.success) {
      expect(collectMissingForCreate(r.data)['branch.0.address']).toBe(
        'Branch 1: address is required.'
      );
    }
  });
});

describe('collectMissingForCreate', () => {
  const parse = (input: unknown): ParsedSubmitCreate => {
    const r = submitCreateSchema.safeParse(input);
    if (!r.success) throw new Error('fixture must parse: ' + r.error.message);
    return r.data;
  };

  it('passes a complete CASH payload', () => {
    expect(collectMissingForCreate(parse(completeCashInput()))).toEqual({});
  });

  it('flags every missing customer-level mandatory field (CR required for CASH too)', () => {
    const missing = collectMissingForCreate(
      parse({
        isDraft: false,
        customer: { legalName: 'Al Noor Trading', paymentTerms: 'CASH' },
        branches: [{ branchName: 'Main' }],
      })
    );
    expect(Object.keys(missing)).toEqual(
      expect.arrayContaining([
        'customer.channelId',
        'customer.subChannelId',
        'customer.primaryPhone',
        'customer.contactPerson',
        'customer.crNumber',
        'customer.crPhoto',
        'branch.0.address',
        'branch.0.gps',
        'branch.0.dayOfVisit',
        'branch.0.shopPhoto',
        'branch.0.signboardPhoto',
      ])
    );
  });

  it('CREDIT additionally requires limit, term days and >=1 guarantee doc', () => {
    const missing = collectMissingForCreate(
      parse(
        completeCashInput({
          customer: { ...completeCashInput().customer, paymentTerms: 'CREDIT' },
        })
      )
    );
    expect(Object.keys(missing)).toEqual(
      expect.arrayContaining([
        'credit.requestedCreditLimit',
        'credit.requestedPaymentTermDays',
        'guarantee',
      ])
    );
  });

  it('CREDIT with full credit block passes', () => {
    const missing = collectMissingForCreate(
      parse(
        completeCashInput({
          customer: { ...completeCashInput().customer, paymentTerms: 'CREDIT' },
          credit: { requestedCreditLimit: 500, requestedPaymentTermDays: 30 },
          guaranteeAttachmentIds: [CUID3],
        })
      )
    );
    expect(missing).toEqual({});
  });

  it('keys branch errors by array index', () => {
    const two = completeCashInput();
    (two.branches as unknown[]).push({ branchName: 'Second' }); // empty second branch
    const missing = collectMissingForCreate(parse(two));
    expect(missing['branch.1.address']).toContain('Branch 2');
    expect(missing['branch.0.address']).toBeUndefined();
  });
});

describe('resolveCycleOnSubmit (cycle invariant)', () => {
  it('a never-submitted draft keeps its cycle on first submit', () => {
    expect(resolveCycleOnSubmit({ cycle: 1, submittedAt: null }, false)).toBe(1);
  });
  it('a resubmit after NEEDS_CORRECTION bumps the cycle', () => {
    expect(resolveCycleOnSubmit({ cycle: 1, submittedAt: new Date() }, false)).toBe(2);
    expect(resolveCycleOnSubmit({ cycle: 3, submittedAt: new Date() }, false)).toBe(4);
  });
  it('the NEEDS_CORRECTION -> save-DRAFT detour cannot dodge the bump', () => {
    // Saving as draft never bumps…
    expect(resolveCycleOnSubmit({ cycle: 2, submittedAt: new Date() }, true)).toBe(2);
    // …but the eventual submit still does, because submittedAt survives.
    expect(resolveCycleOnSubmit({ cycle: 2, submittedAt: new Date() }, false)).toBe(3);
  });
});

describe('collectAttachmentIds', () => {
  it('collects each referenced id with its expected kind', () => {
    const parsed = submitCreateSchema.safeParse(
      completeCashInput({
        customer: { ...completeCashInput().customer, paymentTerms: 'CREDIT' },
        credit: { requestedCreditLimit: 100, requestedPaymentTermDays: 14 },
        guaranteeAttachmentIds: ['ckaaaaaaaa0000aaaaaaaaaaaa'],
        branches: [
          {
            branchName: 'Main',
            address: 'Way 123',
            gpsLat: 23.6,
            gpsLng: 58.5,
            dayOfVisit: 'MON',
            shopPhotoAttachmentId: 'ckbbbbbbbb0000bbbbbbbbbbbb',
            signboardPhotoAttachmentId: 'ckcccccccc0000cccccccccccc',
            extraPhotoAttachmentIds: ['ckdddddddd0000dddddddddddd'],
          },
        ],
      })
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const { all, byKind } = collectAttachmentIds(parsed.data);
    expect(all).toHaveLength(5); // cr + guarantee + shop + signboard + extra
    expect(byKind).toEqual(
      expect.arrayContaining([
        { id: CUID3, expect: 'CR' },
        { id: 'ckaaaaaaaa0000aaaaaaaaaaaa', expect: 'GUARANTEE' },
        { id: 'ckbbbbbbbb0000bbbbbbbbbbbb', expect: 'SHOP' },
        { id: 'ckcccccccc0000cccccccccccc', expect: 'SIGNBOARD' },
        { id: 'ckdddddddd0000dddddddddddd', expect: 'FREE' },
      ])
    );
  });
});

describe('resolveStepAudience', () => {
  // Minimal tx mock — only user.findMany is consulted.
  const txWith = (users: Array<{ id: string }>) =>
    ({
      user: {
        findMany: async () => users,
      },
    }) as unknown as Parameters<typeof resolveStepAudience>[0];

  // Launch fix (2026-10-07): the stored supervisorId was told as it stood — a
  // disabled account, a Manager of another region — and a null one told nobody.
  // Now he is told only when he can act; otherwise the request's region Managers.
  const org = [
    { id: 'sup1', role: Role.SUPERVISOR, isActive: true, regions: [] as string[] },
    { id: 'sup-off', role: Role.SUPERVISOR, isActive: false, regions: [] as string[] },
    { id: 'mgr-r1', role: Role.MANAGER, isActive: true, regions: ['r1'] },
    { id: 'mgr-r1b', role: Role.MANAGER, isActive: true, regions: ['r1'] },
    { id: 'mgr-r2', role: Role.MANAGER, isActive: true, regions: ['r2'] },
    { id: 'mgr-off', role: Role.MANAGER, isActive: false, regions: ['r1'] },
    { id: 'acc-r1', role: Role.ACCOUNTANT, isActive: true, regions: ['r1'] },
  ];
  const orgTx = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const u = org.find((x) => x.id === where.id);
        return u ? { ...u, managedRegions: u.regions.map((id) => ({ id })) } : null;
      },
      findMany: async ({
        where,
      }: {
        where: { role: Role; isActive: boolean; managedRegions: { some: { id: { in: string[] } } } };
      }) =>
        org
          .filter(
            (u) =>
              u.role === where.role &&
              u.isActive === where.isActive &&
              u.regions.some((r) => where.managedRegions.some.id.in.includes(r))
          )
          .map((u) => ({ id: u.id })),
    },
  } as unknown as Parameters<typeof resolveStepAudience>[0];

  it('SUPERVISOR_OF_SUBMITTER → the submitter’s supervisor when he can act on the request', async () => {
    const step = { role: Role.SUPERVISOR, scope: 'SUPERVISOR_OF_SUBMITTER' as const };
    expect(await resolveStepAudience(orgTx, step, { supervisorId: 'sup1' }, ['r1'])).toEqual(['sup1']);
    expect(await resolveStepAudience(orgTx, step, { supervisorId: 'mgr-r2' }, ['r1', 'r2'])).toEqual(['mgr-r2']);
  });

  it('SUPERVISOR_OF_SUBMITTER → the region’s active Managers when he cannot (none, disabled, wrong role, other region)', async () => {
    const step = { role: Role.SUPERVISOR, scope: 'SUPERVISOR_OF_SUBMITTER' as const };
    for (const supervisorId of [null, 'sup-off', 'mgr-off', 'acc-r1', 'mgr-r2', 'ghost']) {
      expect(await resolveStepAudience(orgTx, step, { supervisorId }, ['r1']), String(supervisorId)).toEqual([
        'mgr-r1',
        'mgr-r1b',
      ]);
    }
    // Fail-closed like canActOnStep: no region, no fallback.
    expect(await resolveStepAudience(orgTx, step, { supervisorId: null }, [])).toEqual([]);
  });

  it('REGION_OVERLAP → fail-closed on empty regions', async () => {
    const step = { role: Role.ACCOUNTANT, scope: 'REGION_OVERLAP' as const };
    expect(
      await resolveStepAudience(txWith([{ id: 'acc1' }]), step, { supervisorId: null }, [])
    ).toEqual([]);
    expect(
      await resolveStepAudience(txWith([{ id: 'acc1' }]), step, { supervisorId: null }, ['r1'])
    ).toEqual(['acc1']);
  });

  it('GLOBAL → every active holder of the role', async () => {
    const step = { role: Role.GM, scope: 'GLOBAL' as const };
    expect(
      await resolveStepAudience(txWith([{ id: 'gm1' }, { id: 'gm2' }]), step, { supervisorId: null }, [])
    ).toEqual(['gm1', 'gm2']);
  });
});

describe('owner decision 2026-10-05: the ±100 m GPS standard on a new customer', () => {
  const parse = (input: unknown): ParsedSubmitCreate => {
    const r = submitCreateSchema.safeParse(input);
    if (!r.success) throw new Error('fixture must parse: ' + r.error.message);
    return r.data;
  };
  const withBranch = (extra: Record<string, unknown>) =>
    completeCashInput({
      branches: [
        {
          branchName: 'Main',
          address: 'Way 123, Al Khuwair',
          gpsLat: 23.6,
          gpsLng: 58.5,
          dayOfVisit: 'MON',
          shopPhotoAttachmentId: CUID,
          signboardPhotoAttachmentId: CUID2,
          ...extra,
        },
      ],
    });

  it('a captured point worse than ±100 m holds the submit, in the branch’s location slot', () => {
    const missing = collectMissingForCreate(parse(withBranch({ gpsAccuracy: 150 })));
    expect(Object.keys(missing)).toEqual(['branch.0.gps']);
    expect(missing['branch.0.gps']).toMatch(/^Branch 1: the GPS reading is ±150 m, over the 100 m limit/);
  });

  it('±100 m, no accuracy at all, or a point typed in with a reason all pass', () => {
    expect(collectMissingForCreate(parse(withBranch({ gpsAccuracy: 100 })))).toEqual({});
    expect(collectMissingForCreate(parse(withBranch({})))).toEqual({});
    expect(
      collectMissingForCreate(parse(withBranch({ gpsAccuracy: 150, gpsManualReason: 'GPS not working at all' })))
    ).toEqual({});
  });
});
