// @vitest-environment node
/**
 * Owner decisions 2026-10-11, part C — recording a print (services/prints.ts):
 *   - the row goes through writeAudit (CLAUDE.md: never a raw AuditLog write),
 *     action PRINT, on the request or the customer, with ids only;
 *   - a salesman, an id out of the printer's scope and a credit application
 *     outside its window are refused, and nothing is written;
 *   - the printer's own "Credit application to print" alert is marked read on
 *     the same transaction as the row; nobody else's.
 * The loaders are mocked here: their scope rules are tests/unit/print-pages.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CreditApplicationLoad, CustomerFormPrint } from '@/lib/print-load';

const EDIT = 'ckedit00000000000000000001';
const CUSTOMER = 'ckcust00000000000000000001';

const h = vi.hoisted(() => ({
  user: { id: 'm1', role: 'MANAGER', username: 'manager.x', mustChangePassword: false } as Record<string, unknown>,
  credit: null as unknown,
  customer: null as unknown,
  limitOk: true,
  loaderCalls: [] as Array<[string, unknown, string]>,
  writes: [] as Array<{ tx: unknown; env: unknown; row: Record<string, unknown> }>,
  alertsRead: [] as unknown[],
  inTx: false,
  failAudit: false,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/rate-limit', () => ({
  checkLimit: async (key: string) => {
    h.loaderCalls.push(['limit', null, key]);
    return { ok: h.limitOk, retryAfterSec: 30 };
  },
  PRINT_LIMIT: { capacity: 120, refillPerSec: 1 },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: '198.18.0.1', userAgent: 'test' }),
  writeAudit: async (tx: unknown, env: unknown, row: Record<string, unknown>) => {
    if (h.failAudit) throw new Error('audit insert failed');
    h.writes.push({ tx: h.inTx ? 'tx' : tx, env, row });
  },
}));
vi.mock('@/lib/print-load', () => ({
  loadCreditApplicationPrint: async (user: unknown, id: string) => {
    h.loaderCalls.push(['credit', user, id]);
    return h.credit;
  },
  loadCustomerFormPrint: async (user: unknown, id: string) => {
    h.loaderCalls.push(['customer', user, id]);
    return h.customer;
  },
}));
const tx = {
  // Gap 24: the change context each transaction sets first (lib/change-context.ts).
  $executeRaw: async () => 1,
  notification: {
    updateMany: async (args: unknown) => {
      h.alertsRead.push(args);
      return { count: 1 };
    },
  },
};
vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => {
      h.inTx = true;
      try {
        return await cb(tx);
      } finally {
        h.inTx = false;
      }
    },
  },
}));

import { recordPrintAction } from '@/services/prints';

const okCredit: CreditApplicationLoad = {
  kind: 'ok',
  print: {
    editId: EDIT,
    legalName: 'Al Noor Trading',
    submittedBy: 'Salesman One',
    submittedAt: null,
    dueAt: null,
    customer: [{ label: 'Customer name', value: 'Al Noor Trading' }],
    credit: [{ label: 'Requested credit limit', value: 'OMR 500.000' }],
    branches: [],
    figures: [{ id: 'p1', caption: "Owner's ID card", document: true }],
    cycle: 2,
    stepIndex: 2,
  },
};
const okCustomer = {
  customerId: CUSTOMER,
  nmwcCode: 'NMWC-2026-000123',
  temixCode: 'CAA0367',
  legalName: 'Al Noor Trading',
  status: 'ACTIVE',
  paymentTerms: 'CREDIT',
  customer: [{ label: 'Primary phone', value: '+96891234567' }],
  credit: null,
  branches: [],
  figures: [],
  trail: { kind: 'none' },
  signatures: [],
  requestId: 'ckreq000000000000000000001',
  branchIds: ['b1', 'b2'],
} as unknown as CustomerFormPrint;

beforeEach(() => {
  h.user = { id: 'm1', role: 'MANAGER', username: 'manager.x', mustChangePassword: false };
  h.credit = okCredit;
  h.customer = okCustomer;
  h.limitOk = true;
  h.loaderCalls = [];
  h.writes = [];
  h.alertsRead = [];
  h.failAudit = false;
});

describe('a print is recorded through writeAudit, with ids only', () => {
  it('the credit application: a PRINT row on the request, inside the transaction that reads the alert', async () => {
    const res = await recordPrintAction({ printout: 'CREDIT_APPLICATION', id: EDIT });
    expect(res).toEqual({ ok: true, data: { printout: 'CREDIT_APPLICATION', id: EDIT } });
    expect(h.writes).toHaveLength(1);
    const w = h.writes[0]!;
    expect(w.tx).toBe('tx');
    expect(w.env).toEqual({ actorId: 'm1', ip: '198.18.0.1', userAgent: 'test' });
    expect(w.row).toEqual({
      action: 'PRINT',
      entityType: 'CustomerEdit',
      entityId: EDIT,
      reason: 'credit application printed',
      after: { printout: 'CREDIT_APPLICATION', cycle: 2, stepIndex: 2 },
    });
    // The loader decided, for this very user and id.
    expect(h.loaderCalls.find((c) => c[0] === 'credit')).toEqual([
      'credit',
      { id: 'm1', role: 'MANAGER', username: 'manager.x' },
      EDIT,
    ]);
  });

  it('marks only the printer’s own unread "Credit application to print" alert of this request read', async () => {
    await recordPrintAction({ printout: 'CREDIT_APPLICATION', id: EDIT });
    expect(h.alertsRead).toHaveLength(1);
    expect(h.alertsRead[0]).toMatchObject({
      where: { userId: 'm1', editId: EDIT, readAt: null, kind: 'EDIT_STAGE_ADVANCED', title: 'Credit application to print' },
    });
  });

  it('the customer form: a PRINT row on the customer naming the onboarding request and the branches printed', async () => {
    const res = await recordPrintAction({ printout: 'CUSTOMER_FORM', id: CUSTOMER });
    expect(res.ok).toBe(true);
    expect(h.writes.map((w) => w.row)).toEqual([
      {
        action: 'PRINT',
        entityType: 'Customer',
        entityId: CUSTOMER,
        reason: 'customer form printed',
        after: { printout: 'CUSTOMER_FORM', requestId: 'ckreq000000000000000000001', branchIds: ['b1', 'b2'] },
      },
    ]);
    expect(h.alertsRead).toHaveLength(0);
  });

  it('no name, phone, code or figure from the printout reaches the row', async () => {
    await recordPrintAction({ printout: 'CREDIT_APPLICATION', id: EDIT });
    await recordPrintAction({ printout: 'CUSTOMER_FORM', id: CUSTOMER });
    const text = JSON.stringify(h.writes.map((w) => w.row));
    for (const pii of ['Al Noor', '+96891234567', 'NMWC-2026', 'CAA0367', 'OMR', 'Salesman One']) {
      expect(text, pii).not.toContain(pii);
    }
  });
});

describe('refusals write nothing', () => {
  it('a salesman may not print', async () => {
    h.user = { id: 's1', role: 'SALESMAN', username: 'mct-01', mustChangePassword: false };
    const res = await recordPrintAction({ printout: 'CREDIT_APPLICATION', id: EDIT });
    expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(h.loaderCalls).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('a session that must change its password is refused (F15)', async () => {
    h.user = { ...h.user, mustChangePassword: true };
    const res = await recordPrintAction({ printout: 'CUSTOMER_FORM', id: CUSTOMER });
    expect(res.ok).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it('out of scope: NOT_FOUND, never "you may not"', async () => {
    h.credit = null;
    h.customer = null;
    expect(await recordPrintAction({ printout: 'CREDIT_APPLICATION', id: EDIT })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await recordPrintAction({ printout: 'CUSTOMER_FORM', id: CUSTOMER })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(h.writes).toEqual([]);
  });

  it('a credit application outside its window: refused with where the request is', async () => {
    h.credit = {
      kind: 'unavailable',
      legalName: 'Al Noor Trading',
      message: 'The signed application has been uploaded. The request is now at the Finance Manager step.',
      customerId: null,
    };
    const res = await recordPrintAction({ printout: 'CREDIT_APPLICATION', id: EDIT });
    expect(res).toMatchObject({
      ok: false,
      code: 'PRINT_UNAVAILABLE',
      message: 'Not available now — The signed application has been uploaded. The request is now at the Finance Manager step.',
    });
    expect(h.writes).toEqual([]);
    expect(h.alertsRead).toEqual([]);
  });

  it('a malformed printout or id is refused before any read', async () => {
    for (const input of [
      { printout: 'RECEIPT', id: EDIT },
      { printout: 'CUSTOMER_FORM', id: 'not-a-cuid' },
      { printout: 'CUSTOMER_FORM' },
    ]) {
      const res = await recordPrintAction(input as never);
      expect(res, JSON.stringify(input)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    }
    expect(h.loaderCalls.filter((c) => c[0] !== 'limit')).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('rate limited per printer, in its own bucket', async () => {
    h.limitOk = false;
    const res = await recordPrintAction({ printout: 'CUSTOMER_FORM', id: CUSTOMER });
    expect(res).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(h.loaderCalls).toEqual([['limit', null, 'print:m1']]);
    expect(h.writes).toEqual([]);
  });

  it('a row that cannot be written is not an ok: the page does not start the print', async () => {
    h.failAudit = true;
    await expect(recordPrintAction({ printout: 'CUSTOMER_FORM', id: CUSTOMER })).rejects.toThrow('audit insert failed');
  });
});

describe('every role but the salesman records a print', () => {
  it.each(['SUPERVISOR', 'ACCOUNTANT', 'FINANCE_MANAGER', 'GM', 'SALES_DIRECTOR', 'MANAGER', 'STEWARD', 'VIEWER'])('%s', async (role) => {
    h.user = { id: 'u1', role, username: 'x', mustChangePassword: false };
    expect((await recordPrintAction({ printout: 'CUSTOMER_FORM', id: CUSTOMER })).ok).toBe(true);
  });
});
