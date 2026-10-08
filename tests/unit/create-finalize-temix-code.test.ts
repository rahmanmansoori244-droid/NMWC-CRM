// @vitest-environment node
/**
 * Owner decision 2026-10-08 (lib/create-finalize.ts): when a new-customer
 * request reaches the Accountant, he creates the customer in Temix himself and
 * types its Temix code before he approves. Finalize creates the customer WITH
 * that code — it used to create it with none, waiting for an inbound refresh
 * that could never give it one — and:
 *   - refuses a code another customer already holds — a live one, or an archived
 *     one the customer import would also name (every inbound refresh of the new
 *     customer would otherwise be rejected) — or a live branch's code, naming it,
 *     under an advisory lock taken before the check, and creates nothing;
 *   - keeps the customer PENDING_UPLOAD, so the next Temix batch carries the full
 *     record as an UPSERT keyed by that code;
 *   - records the code on the FINALIZE row (the approval's) and the CREATE row.
 * The same against Postgres: tests/integration/credit-chain-e2e.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EditBranchDraft, EditCustomerDraft } from '@prisma/client';

const h = vi.hoisted(() => ({ writeAudit: vi.fn() }));
vi.mock('@/lib/create-guards', () => ({
  lockCreateIdentity: vi.fn(async () => {}),
  assertNoExactCreateDuplicate: vi.fn(async () => {}),
}));
vi.mock('@/lib/audit', () => ({ writeAudit: h.writeAudit }));

import { finalizeCreateInTx, type FinalizableEdit } from '@/lib/create-finalize';

const env = { actorId: 'u-acc', ip: null, userAgent: null } as never;
const AT = new Date('2026-10-08T06:00:00.000Z');

const edit: FinalizableEdit = {
  id: 'e1',
  submittedById: 'u-sales',
  cycle: 1,
  requestedCreditLimit: null,
  requestedPaymentTermDays: null,
  customerDraft: {
    legalName: 'Al Noor Trading',
    paymentTerms: 'CASH',
    crNumberNorm: '1234567',
    primaryPhoneNorm: null,
    crPhotoAttachmentId: 'p-cr',
  } as unknown as EditCustomerDraft,
  branchDrafts: [
    {
      routeId: 'r1',
      branchName: 'Main',
      shopPhotoAttachmentId: 'p-shop',
      signboardPhotoAttachmentId: null,
      extraPhotoAttachmentIds: [],
    } as unknown as EditBranchDraft,
  ],
};

let calls: string[];
let holder: { nmwcCode: string; archived: boolean; branchCode: string | null } | null;
let tx: Record<string, Record<string, ReturnType<typeof vi.fn>> | ReturnType<typeof vi.fn>>;

beforeEach(() => {
  calls = [];
  holder = null;
  h.writeAudit.mockReset().mockResolvedValue(undefined);
  const step = (name: string, value: unknown = {}) =>
    vi.fn(async () => {
      calls.push(name);
      return value;
    });
  tx = {
    route: { findMany: step('route.read', [{ id: 'r1', regionId: 'g1' }]) },
    attachment: {
      findMany: vi.fn(async (a: { where: { kind?: string } }) => {
        calls.push('photos.read');
        return a.where.kind === 'GUARANTEE' ? [] : [{ id: 'p-cr' }, { id: 'p-shop' }];
      }),
      updateMany: step('photo.bind', { count: 1 }),
    },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      calls.push(/pg_advisory_xact_lock/.test(strings.join('?')) ? 'temix.lock' : 'execute');
      return 1;
    }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const q = strings.join('?');
      if (/FROM "Customer"/.test(q) && /UPPER\(c\."temixCode"\)/.test(q)) {
        calls.push('temix.holder');
        return holder ? [holder] : [];
      }
      if (/INSERT INTO "CodeSequence"/.test(q)) {
        calls.push('code.allocate');
        return [{ next: 124 }];
      }
      throw new Error(`unexpected query: ${q}`);
    }),
    customer: {
      findUnique: step('code.taken?', null),
      create: step('customer.create', { id: 'c-new' }),
      update: step('customer.update'),
    },
    branch: { create: step('branch.create', { id: 'b-new' }), update: step('branch.update') },
    customerEdit: { update: step('edit.link') },
  };
});

const finalize = () => finalizeCreateInTx(tx as never, edit, env, AT, 'CAA0367');

describe('owner decision 2026-10-08: the Temix code the Accountant typed', () => {
  it('the customer is created with it, still queued for the next Temix batch', async () => {
    const out = await finalize();
    expect(out).toEqual({
      customerId: 'c-new',
      nmwcCode: 'NMWC-2026-000123',
      legalName: 'Al Noor Trading',
      temixCode: 'CAA0367',
    });
    const created = (tx.customer as Record<string, ReturnType<typeof vi.fn>>).create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(created.data).toMatchObject({
      nmwcCode: 'NMWC-2026-000123',
      temixCode: 'CAA0367',
      temixSyncState: 'PENDING_UPLOAD',
      temixSyncPendingSince: AT,
    });
  });

  it('the approval audit row and the customer CREATE row both record it', async () => {
    await finalize();
    const rows = h.writeAudit.mock.calls.map(([, , row]) => row as { action: string; after: Record<string, unknown> });
    expect(rows.map((r) => r.action)).toEqual(['FINALIZE', 'CREATE']);
    expect(rows[0]!.after).toMatchObject({ customerId: 'c-new', nmwcCode: 'NMWC-2026-000123', temixCode: 'CAA0367' });
    expect(rows[1]!.after).toMatchObject({ nmwcCode: 'NMWC-2026-000123', temixCode: 'CAA0367' });
  });

  it('checked under its lock, after the photo checks and before a customer code is spent', async () => {
    await finalize();
    const at = (name: string) => calls.indexOf(name);
    expect(at('temix.lock')).toBeGreaterThan(calls.lastIndexOf('photos.read'));
    expect(at('temix.holder')).toBe(at('temix.lock') + 1);
    expect(at('code.allocate')).toBeGreaterThan(at('temix.holder'));
  });

  it('a code a live customer holds is refused, naming it, beside the box; nothing is created', async () => {
    holder = { nmwcCode: 'NMWC-2026-000012', archived: false, branchCode: null };
    const err = await finalize().catch((e) => e);
    expect(err).toMatchObject({
      code: 'TEMIX_CODE_TAKEN',
      httpStatus: 409,
      message:
        'Temix code CAA0367 already belongs to customer NMWC-2026-000012. Check the code in Temix: every customer has its own.',
      fields: {
        temixCode:
          'Temix code CAA0367 already belongs to customer NMWC-2026-000012. Check the code in Temix: every customer has its own.',
      },
    });
    expect(calls).not.toContain('code.allocate');
    expect(calls).not.toContain('customer.create');
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  // Review of the branch: the import's crosswalk guard names an archived customer
  // holding the code, so a new customer given it would have every inbound refresh
  // rejected, and an archived one still DEACTIVATE_PENDING would be held back from
  // every batch (F11). Finalize refuses what the import refuses.
  it.each([
    [
      'an archived customer (its Temix code, or the customer code its deactivation goes out under)',
      { nmwcCode: 'CAA0367', archived: true, branchCode: null },
      'Temix code CAA0367 belongs to archived customer CAA0367, and its Temix deactivation is sent under that code. Check the code in Temix, and ask the Data Steward before using it again.',
    ],
    [
      'a live branch (a branch account, not a Temix customer code)',
      { nmwcCode: 'CAA0300', archived: false, branchCode: 'CAA0367' },
      'CAA0367 is the code of branch CAA0367 of customer CAA0300, not a Temix customer code. Check the code in Temix.',
    ],
  ])('a code %s holds is refused, naming it; nothing is created', async (_label, found, message) => {
    holder = found;
    const err = await finalize().catch((e) => e);
    expect(err).toMatchObject({ code: 'TEMIX_CODE_TAKEN', httpStatus: 409, message, fields: { temixCode: message } });
    expect(calls).not.toContain('code.allocate');
    expect(calls).not.toContain('customer.create');
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});
