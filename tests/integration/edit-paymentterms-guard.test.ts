// @vitest-environment node
/**
 * EDIT-PAYMENTTERMS-GUARD (final-hunt #3) — a CASH↔CREDIT flip must NOT be possible
 * through the ordinary customer edit. The UPDATE chain is a single Supervisor step
 * resolved from the customer's CURRENT terms, so a paymentTerms change on an edit
 * would grant CREDIT status (limit/terms + outbound Temix credit push) with NO
 * finance approval — bypassing the owner-locked SUP→FM→GM→ACC credit chain.
 *
 *   RUN_EDIT_GUARD=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/edit-paymentterms-guard.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_EDIT_GUARD === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('customer edit cannot flip CASH↔CREDIT (final-hunt #3)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let edits: typeof import('@/services/edits');
  const tag = randomUUID().slice(0, 8);
  const stewardId = `ZZPT-stew-${tag}`;
  let cashId = '';
  let creditId = '';

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    edits = await import('@/services/edits');
    await prisma.user.create({ data: { id: stewardId, username: stewardId, passwordHash: 'x', fullName: 'ZZ PT Steward', role: 'STEWARD' } });
    cashId = (await prisma.customer.create({ data: { nmwcCode: `ZZPT-CASH-${tag}`, legalName: 'ZZ PT Cash', paymentTerms: 'CASH' } })).id;
    creditId = (await prisma.customer.create({ data: { nmwcCode: `ZZPT-CR-${tag}`, legalName: 'ZZ PT Credit', paymentTerms: 'CREDIT', creditLimit: 1000, paymentTermDays: 30 } })).id;
    current = { id: stewardId, role: 'STEWARD', username: stewardId };
  });

  afterAll(async () => {
    if (!prisma) return;
    const eds = await prisma.customerEdit.findMany({ where: { customerId: { in: [cashId, creditId] } }, select: { id: true } });
    if (eds.length) {
      await prisma.editApproval.deleteMany({ where: { editId: { in: eds.map((e) => e.id) } } });
      await prisma.customerEdit.deleteMany({ where: { id: { in: eds.map((e) => e.id) } } });
    }
    await prisma.auditLog.deleteMany({ where: { actorId: stewardId } });
    await prisma.customer.deleteMany({ where: { id: { in: [cashId, creditId] } } });
    await prisma.user.deleteMany({ where: { id: stewardId } });
    await prisma.$disconnect();
  });

  it('rejects CASH → CREDIT via the edit; customer stays CASH', async () => {
    const res = await edits.submitEditAction({ customerId: cashId, isDraft: false, customer: { paymentTerms: 'CREDIT' }, branches: [] });
    expect(res.ok).toBe(false);
    expect((res as { ok: false; fields?: Record<string, string> }).fields?.['customer.paymentTerms']).toBeTruthy();
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: cashId } });
    expect(after.paymentTerms).toBe('CASH');
  });

  it('rejects CREDIT → CASH via the edit; customer stays CREDIT', async () => {
    const res = await edits.submitEditAction({ customerId: creditId, isDraft: false, customer: { paymentTerms: 'CASH' }, branches: [] });
    expect(res.ok).toBe(false);
    expect((res as { ok: false; fields?: Record<string, string> }).fields?.['customer.paymentTerms']).toBeTruthy();
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: creditId } });
    expect(after.paymentTerms).toBe('CREDIT');
  });

  it('allows an ordinary non-terms edit on the same customer (guard is narrow)', async () => {
    const res = await edits.submitEditAction({ customerId: cashId, isDraft: false, customer: { contactPerson: 'ZZ New Contact' }, branches: [] });
    // A contact-only edit is a legitimate enrichment — must NOT be blocked by the
    // paymentTerms guard (it may still route through the normal chain).
    if (!res.ok) {
      expect((res as { ok: false; fields?: Record<string, string> }).fields?.['customer.paymentTerms']).toBeFalsy();
    } else {
      expect(res.ok).toBe(true);
    }
  });
});
