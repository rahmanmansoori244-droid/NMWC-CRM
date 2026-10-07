/**
 * X-STATUS-2 (and the review side of F10): the photo a close or reactivation
 * request was sent with, as the reviewer sees it.
 *
 * The close request's approval page never read the request's own evidence: the
 * photo sat among the branch's "Other photos", beside older ones that may
 * predate the closure, and once removed it silently vanished. The reactivation
 * queue showed it, but a removed one rendered as a broken image. Both pages now
 * show the evidence as such, and say "removed" for a photo the approval will
 * refuse — decided by the same predicate the approval uses
 * (lib/status-evidence.ts standsAsEvidence).
 *
 * Rendered with the database and session mocked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const SALES = 'u-sales';
const B1 = 'b1';
const PHOTO = 'p1';
const EVIDENCE = [{ kind: 'FREE', attachmentId: PHOTO, action: 'EVIDENCE' }];

const h = vi.hoisted(() => ({
  role: 'GM',
  edit: null as unknown,
  items: [] as unknown[],
  /** Branches the reviewer's scope keeps (null = all of them). */
  inScope: null as string[] | null,
  /** Evidence rows the attachment table holds, by id. */
  rows: [] as Array<Record<string, unknown>>,
  attachmentQueries: [] as unknown[],
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u-rev', role: h.role, username: 'rev' } }),
}));
vi.mock('@/lib/access', () => ({
  // Launch fix: the review page names a live customer sharing a new request's phone only if the viewer can open it.
  canSeeCustomer: (_u: unknown, c: { canSee?: boolean }) => c.canSee !== false,
  loadScope: async () => ({ managedRegionIds: ['g1'], teamRouteIds: ['r1'], ownedRouteId: null }),
  filterBranchesByScope: (_u: unknown, branches: Array<{ id: string }>) =>
    h.inScope ? branches.filter((b) => h.inScope!.includes(b.id)) : branches,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: {
      findUnique: async () => h.edit,
      findMany: async () => h.items,
    },
    branch: { findMany: async () => [{ id: B1, branchName: 'Main', route: { code: 'C4' } }] },
    attachment: {
      findMany: async (args: { where: { id?: { in: string[] } } }) => {
        h.attachmentQueries.push(args);
        // The extra-photos query asks by branch; the evidence query by id.
        if (!args.where.id) return [];
        return h.rows.filter((r) => args.where.id!.in.includes(r.id as string));
      },
    },
    channel: { findMany: async () => [] },
    subChannel: { findMany: async () => [] },
    // Phase 2, ruling 8: the page's stale-field check reads the live customer
    // and the submitter's role; none here, so no banner.
    customer: { findUnique: async () => null },
    user: { findUnique: async () => null },
  },
}));
vi.mock('@/app/(app)/approvals/[id]/ApproveRejectActions', () => ({
  ApproveRejectActions: () => <div data-testid="actions">actions</div>,
}));
vi.mock('@/app/(app)/reactivations/ReactivationDecisionForm', () => ({
  ReactivationDecisionForm: () => <div data-testid="decide">decide</div>,
}));

afterEach(() => {
  cleanup();
  h.role = 'GM';
  h.inScope = null;
  h.rows = [];
  h.attachmentQueries = [];
});

const photo = (over: Record<string, unknown> = {}) => ({
  id: PHOTO,
  deletedAt: null,
  capturedById: SALES,
  branchId: B1,
  branchExtraId: B1,
  ...over,
});

function closeEdit(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    process: 'UPDATE',
    target: 'BRANCH',
    state: 'SUBMITTED',
    customerId: 'c1',
    branchId: B1,
    submittedById: SALES,
    currentStepIndex: 0,
    approvalChain: null,
    decisionReason: 'Shop shut permanently.',
    reviewedAt: null,
    reviewedBy: null,
    submittedAt: null,
    submittedBy: { id: SALES, fullName: 'Salesman One', supervisorId: null },
    customerDraft: null,
    branchDrafts: [],
    requestedCreditLimit: null,
    requestedPaymentTermDays: null,
    steps: [],
    customer: {
      id: 'c1',
      legalName: 'Al Noor Trading',
      nmwcCode: 'NMWC-000123',
      crPhotoId: null,
      branches: [
        {
          id: B1,
          branchName: 'Main',
          branchCode: 'B-01',
          address: 'Ruwi',
          gpsLat: null,
          gpsLng: null,
          gpsAccuracy: null,
          gpsCapturedAt: null,
          shopPhotoId: null,
          signboardPhotoId: null,
          routeId: 'r1',
          regionId: 'g1',
          deletedAt: null,
          route: { code: 'C4' },
        },
      ],
    },
    fieldChanges: [{ field: `branch.${B1}.status`, before: 'ACTIVE', after: 'CLOSED' }],
    attachmentChanges: EVIDENCE,
    ...over,
  };
}

async function renderApproval(edit: unknown) {
  h.edit = edit;
  const { default: Page } = await import('@/app/(app)/approvals/[id]/page');
  return render(await Page({ params: Promise.resolve({ id: 'e1' }) }));
}

const evidenceSection = () =>
  screen.queryByRole('heading', { name: 'Evidence sent with this request' })?.closest('section') ?? null;

describe('the approval page shows the evidence a close request was sent with', () => {
  it('a close request: its own row, with that photo', async () => {
    h.rows = [photo()];
    await renderApproval(closeEdit());
    const section = evidenceSection();
    expect(section, 'the evidence row').not.toBeNull();
    const imgs = within(section as HTMLElement).getAllByRole('img');
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([`/api/photos/${PHOTO}`]);
    expect(section!.textContent).not.toMatch(/Removed/);
  });

  it.each([
    ['removed', [photo({ deletedAt: new Date() })]],
    ['gone altogether', []],
    ['captured by someone else', [photo({ capturedById: 'someone-else' })]],
    ['moved off the branch', [photo({ branchId: 'b2', branchExtraId: 'b2' })]],
  ])('evidence %s: said as removed, and no image of it', async (_n, rows) => {
    h.rows = rows;
    await renderApproval(closeEdit());
    const section = evidenceSection()!;
    expect(section.textContent).toContain(
      'Removed since the request was sent — it cannot be approved; reject this request.'
    );
    expect(within(section).queryAllByRole('img')).toEqual([]);
  });

  it('a decided request keeps the row, without the call to reject', async () => {
    h.rows = [photo({ deletedAt: new Date() })];
    await renderApproval(closeEdit({ state: 'APPROVED' }));
    const section = evidenceSection()!;
    expect(section.textContent).toContain('Removed since the request was sent.');
    expect(section.textContent).not.toMatch(/reject/);
  });

  it('a pending status-only request sent with no evidence says so', async () => {
    await renderApproval(closeEdit({ attachmentChanges: [] }));
    expect(evidenceSection()!.textContent).toContain('No photo was sent with this request. It cannot be approved — reject it.');
  });

  it('an enrichment edit has no evidence row', async () => {
    await renderApproval(
      closeEdit({
        target: 'CUSTOMER',
        branchId: null,
        fieldChanges: [{ field: 'customer.notes', before: null, after: 'Opens at 7' }],
        attachmentChanges: [],
      })
    );
    expect(evidenceSection()).toBeNull();
    expect(h.attachmentQueries.some((q) => (q as { where: { id?: unknown } }).where.id)).toBe(false);
  });

  it('a branch outside the reviewer’s scope: nothing shown, and the photo is not even read', async () => {
    h.inScope = [];
    h.rows = [photo()];
    await renderApproval(closeEdit());
    const section = evidenceSection()!;
    expect(section.textContent).toContain('Not shown: the branch is outside your scope.');
    expect(within(section).queryAllByRole('img')).toEqual([]);
    expect(h.attachmentQueries.some((q) => (q as { where: { id?: unknown } }).where.id)).toBe(false);
  });
});

function reactivation(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    branchId: B1,
    submittedById: SALES,
    decisionReason: 'Open again.',
    attachmentChanges: [{ kind: 'FREE', attachmentId: `${id}-photo`, action: 'EVIDENCE' }],
    submittedBy: { fullName: 'Salesman One' },
    customer: { id: 'c1', legalName: `Shop ${id}`, nmwcCode: 'NMWC-1' },
    branch: { id: B1, branchName: 'Main', shopPhotoId: null, signboardPhotoId: null, route: { code: 'C4' } },
    ...over,
  };
}

describe('the reactivation queue says when the evidence is gone', () => {
  it('intact evidence shows; removed evidence is said as removed, not a broken image — in one read', async () => {
    h.role = 'MANAGER';
    h.items = [reactivation('ok'), reactivation('gone')];
    h.rows = [photo({ id: 'ok-photo' }), photo({ id: 'gone-photo', deletedAt: new Date() })];
    const { default: Page } = await import('@/app/(app)/reactivations/page');
    render(await Page());
    const [ok, gone] = screen.getAllByRole('listitem');
    expect(within(ok!).getAllByRole('img').map((i) => i.getAttribute('src'))).toEqual(['/api/photos/ok-photo']);
    expect(ok!.textContent).not.toMatch(/removed/);
    expect(within(gone!).queryAllByRole('img')).toEqual([]);
    // This queue's reject button is "Keep closed"; the warning names it.
    expect(gone!.textContent).toMatch(
      /Evidence photo removed since the request was sent — it cannot be\s+approved; use Keep closed to reject it\./
    );
    expect(h.attachmentQueries).toHaveLength(1);
  });
});
