/**
 * Large-customer photos, part B: the approval detail's photos.
 *
 * The page counts the photos of all ten PhotoRow call sites (a new-customer
 * request: CR document, guarantees, credit documents, signed application,
 * each branch draft; an update: the evidence, the CR document on file and each
 * live branch's shop, signboard and other photos). More than 40: every photo
 * is a placeholder. 40 or fewer: the <img> tags the page always had.
 *
 * Rendered with the database and session mocked, as approval-decision-pages
 * and approval-evidence-row do.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ReactNode } from 'react';
import { EditProcess, PaymentTerms } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';

type Att = { id: string; editId: string; kind: string; deletedAt: Date | null };
const h = vi.hoisted(() => ({
  edit: null as unknown,
  attachments: [] as Array<{ id: string; editId: string; kind: string; deletedAt: Date | null }>,
  extras: [] as Array<{ id: string; branchExtraId: string }>,
  evidenceRows: [] as Array<Record<string, unknown>>,
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
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u-viewer', role: 'GM', username: 'viewer.x' } }) }));
vi.mock('@/lib/access', () => ({
  canSeeCustomer: () => true,
  loadScope: async () => ({ managedRegionIds: ['g1'], teamRouteIds: [], ownedRouteId: null }),
  filterBranchesByScope: (_u: unknown, branches: unknown[]) => branches,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: { findUnique: async () => h.edit, findMany: async () => [], count: async () => 0 },
    attachment: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        // The live branches' other photos are asked for by branch.
        if (w.branchExtraId) return h.extras;
        // The evidence is asked for by id alone.
        if (w.id && !w.editId) return h.evidenceRows;
        if (w.editId === undefined) return [];
        const kinds = (w.kind as { in?: string[] } | string | undefined) ?? null;
        const ks = kinds === null ? null : typeof kinds === 'string' ? [kinds] : kinds.in ?? null;
        return h.attachments
          .filter((a: Att) => a.editId === w.editId && (ks === null || ks.includes(a.kind)) && a.deletedAt === null)
          .map(({ id, editId, kind }) => ({ id, editId, kind }));
      },
    },
    branch: { findMany: async () => [] },
    channel: { findMany: async () => [] },
    subChannel: { findMany: async () => [] },
    customer: { findUnique: async () => null, findMany: async () => [] },
    user: { findUnique: async () => null },
  },
}));
vi.mock('@/app/(app)/approvals/[id]/ApproveRejectActions', () => ({
  ApproveRejectActions: () => <div data-testid="actions" />,
}));
vi.mock('@/app/(app)/reactivations/ReactivationDecisionForm', () => ({
  ReactivationDecisionForm: () => <div data-testid="decide" />,
}));

beforeEach(() => {
  h.attachments = [];
  h.extras = [];
  h.evidenceRows = [];
});
afterEach(() => {
  h.edit = null;
});

const pid = (k: string, i: number) => `0000${k}00-0000-4000-8000-${String(i).padStart(12, '0')}`;
const imgTags = (s: string) => s.match(/<img [^>]*>/g) ?? [];
const waiting = (s: string) => (s.match(/data-photo-state="waiting"/g) ?? []).length;
const THUMB = 'h-20 w-20 rounded-md object-cover ring-1 ring-slate-200';

async function html(edit: unknown): Promise<string> {
  h.edit = edit;
  const { default: Page } = await import('@/app/(app)/approvals/[id]/page');
  return renderToString(await Page({ params: Promise.resolve({ id: 'e1' }) }));
}

/** A new-customer request: n branch drafts with a shop and a signboard photo each, and a CR document. */
function createEdit(n: number, over: { credit?: boolean; extras?: number } = {}) {
  const credit = !!over.credit;
  const ids: string[] = [pid('cc', 0)];
  const branchDrafts = Array.from({ length: n }, (_, i) => {
    const extra = i === 0 ? Array.from({ length: over.extras ?? 0 }, (_, j) => pid('ee', j)) : [];
    ids.push(pid('aa', i), pid('bb', i), ...extra);
    return {
      id: `bd${i}`,
      branchName: `Shop ${i}`,
      region: { name: 'Muscat' },
      route: { code: 'MCT-01', regionId: 'g1', region: { name: 'Muscat' } },
      address: 'Way 1',
      areaDescription: null,
      gpsLat: null,
      gpsLng: null,
      gpsAccuracy: null,
      dayOfVisit: 'SUN',
      openingHours: null,
      deliveryWindow: null,
      coolersCount: 0,
      standsCount: 0,
      emptyBottlesCount: 0,
      shopPhotoAttachmentId: pid('aa', i),
      signboardPhotoAttachmentId: pid('bb', i),
      extraPhotoAttachmentIds: extra,
    };
  });
  h.attachments.push(...ids.map((id) => ({ id, editId: 'e1', kind: 'SHOP', deletedAt: null })));
  return {
    id: 'e1',
    process: 'CREATE',
    state: 'SUBMITTED',
    customerId: null,
    customer: null,
    approvalChain: resolveChain(EditProcess.CREATE, credit ? PaymentTerms.CREDIT : PaymentTerms.CASH),
    currentStepIndex: 0,
    cycle: 1,
    stageEnteredAt: new Date('2026-09-23T09:15:00.000Z'),
    slaDueAt: null,
    escalationLevel: 0,
    submittedAt: new Date('2026-09-22T07:00:00.000Z'),
    requestedCreditLimit: null,
    requestedPaymentTermDays: null,
    fieldChanges: [],
    attachmentChanges: [],
    decisionReason: null,
    reviewedAt: null,
    reviewedBy: null,
    submittedById: 's1',
    submittedBy: { id: 's1', fullName: 'Salesman One', username: 'salesman.one', supervisorId: 'sup1' },
    steps: [],
    customerDraft: {
      legalName: 'Load Chain',
      crNumber: '1234567',
      paymentTerms: credit ? 'CREDIT' : 'CASH',
      channel: { label: 'Retail' },
      subChannel: null,
      primaryPhone: null,
      primaryPhoneNorm: null,
      altPhone: null,
      contactPerson: 'Ali',
      contactRole: null,
      notes: null,
      email: null,
      crPhotoAttachmentId: pid('cc', 0),
    },
    branchDrafts,
  };
}

/** An update request on a live customer with n branches (shop + signboard each) and a CR document. */
function updateEdit(n: number, over: { evidence?: string[] } = {}) {
  const evidence = over.evidence ?? [];
  return {
    id: 'e1',
    process: 'UPDATE',
    target: 'BRANCH',
    state: 'SUBMITTED',
    customerId: 'c1',
    branchId: 'b0',
    submittedById: 's1',
    currentStepIndex: 0,
    approvalChain: null,
    decisionReason: null,
    reviewedAt: null,
    reviewedBy: null,
    submittedAt: null,
    submittedBy: { id: 's1', fullName: 'Salesman One', supervisorId: null },
    customerDraft: null,
    branchDrafts: [],
    requestedCreditLimit: null,
    requestedPaymentTermDays: null,
    steps: [],
    customer: {
      id: 'c1',
      legalName: 'Load Chain',
      nmwcCode: 'NMWC-000123',
      crPhotoId: pid('cc', 0),
      branches: Array.from({ length: n }, (_, i) => ({
        id: `b${i}`,
        branchName: `Shop ${i}`,
        branchCode: `B-${i}`,
        address: 'Ruwi',
        gpsLat: null,
        gpsLng: null,
        gpsAccuracy: null,
        gpsCapturedAt: null,
        shopPhotoId: pid('aa', i),
        signboardPhotoId: pid('bb', i),
        routeId: 'r1',
        regionId: 'g1',
        deletedAt: null,
        route: { code: 'C4' },
      })),
    },
    fieldChanges: [{ field: 'branch.b0.status', before: 'ACTIVE', after: 'CLOSED' }],
    attachmentChanges: evidence.map((attachmentId) => ({ kind: 'FREE', attachmentId, action: 'EVIDENCE' })),
  };
}

describe('approval detail photos: a new-customer request', () => {
  it("19 branch drafts and a CR document (39): today's thumbnails, string for string", async () => {
    const s = await html(createEdit(19));
    const tags = imgTags(s);
    expect(tags).toHaveLength(39);
    expect(tags[0]).toBe(`<img src="/api/photos/${pid('cc', 0)}" alt="CR document" class="${THUMB}"/>`);
    expect(tags[1]).toBe(`<img src="/api/photos/${pid('aa', 0)}" alt="Photos" class="${THUMB}"/>`);
    expect(s).not.toContain('data-photo-state');
  });

  it('20 branch drafts and a CR document (41): placeholders, no <img>', async () => {
    const s = await html(createEdit(20));
    expect(imgTags(s)).toEqual([]);
    expect(waiting(s)).toBe(41);
  });

  it("a branch draft's other photos count: 19 drafts, a CR document and 2 extras (41) are queued", async () => {
    const s = await html(createEdit(19, { extras: 2 }));
    expect(imgTags(s)).toEqual([]);
    expect(waiting(s)).toBe(41);
  });

  it('the credit documents count: 19 drafts, a CR document and 2 credit documents (41) are queued', async () => {
    const edit = createEdit(19, { credit: true });
    h.attachments.push(
      { id: pid('d1', 0), editId: 'e1', kind: 'ID_CARD', deletedAt: null },
      { id: pid('d2', 0), editId: 'e1', kind: 'VAT_CERT', deletedAt: null }
    );
    const s = await html(edit);
    expect(imgTags(s)).toEqual([]);
    expect(waiting(s)).toBe(41);
  });
});

describe('approval detail photos: an update request', () => {
  it("19 live branches and a CR document (39): today's thumbnails", async () => {
    const s = await html(updateEdit(19));
    const tags = imgTags(s);
    expect(tags).toHaveLength(39);
    expect(tags[0]).toBe(`<img src="/api/photos/${pid('cc', 0)}" alt="CR document" class="${THUMB}"/>`);
    expect(tags[1]).toBe(`<img src="/api/photos/${pid('aa', 0)}" alt="Shop front" class="${THUMB}"/>`);
    expect(tags[2]).toBe(`<img src="/api/photos/${pid('bb', 0)}" alt="Signboard" class="${THUMB}"/>`);
    expect(s).not.toContain('data-photo-state');
  });

  it('20 live branches and a CR document (41): placeholders', async () => {
    const s = await html(updateEdit(20));
    expect(imgTags(s)).toEqual([]);
    expect(waiting(s)).toBe(41);
  });

  it("the live branches' other photos count (39 + 2 = 41: queued)", async () => {
    h.extras = [
      { id: pid('ee', 0), branchExtraId: 'b0' },
      { id: pid('ee', 1), branchExtraId: 'b1' },
    ];
    const s = await html(updateEdit(19));
    expect(imgTags(s)).toEqual([]);
    expect(waiting(s)).toBe(41);
  });

  it('the evidence counts (39 + 2 = 41: queued)', async () => {
    const ev = [pid('ff', 0), pid('ff', 1)];
    h.evidenceRows = ev.map((id) => ({ id, deletedAt: null, capturedById: 's1', branchId: 'b0', branchExtraId: 'b0' }));
    const s = await html(updateEdit(19, { evidence: ev }));
    expect(imgTags(s)).toEqual([]);
    expect(waiting(s)).toBe(41);
  });
});
