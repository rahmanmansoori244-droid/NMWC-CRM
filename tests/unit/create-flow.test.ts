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

  it('SUPERVISOR_OF_SUBMITTER → exactly the submitter’s supervisor (empty when unassigned)', async () => {
    const step = { role: Role.SUPERVISOR, scope: 'SUPERVISOR_OF_SUBMITTER' as const };
    expect(
      await resolveStepAudience(txWith([{ id: 'nope' }]), step, { supervisorId: 'sup1' }, [])
    ).toEqual(['sup1']);
    expect(
      await resolveStepAudience(txWith([{ id: 'nope' }]), step, { supervisorId: null }, [])
    ).toEqual([]);
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
