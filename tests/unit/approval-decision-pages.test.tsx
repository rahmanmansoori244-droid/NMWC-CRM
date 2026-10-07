/**
 * N01 / X-APPR-1 / X-APPR-2 (auditor recheck, 2026-09-27): the two approval
 * pages hand their client components a decision token made from the very row
 * they render, the credit figures the queue card shows, and the words for what
 * approving the current step does.
 *
 * The pages are rendered with their database and session mocked. The queue's
 * mocked query honours the page's `select`, so a token field the page forgot
 * to select arrives as undefined here exactly as it would from Prisma.
 *
 * A new-customer request's token also binds the live guarantee documents the
 * page listed; the mocked attachment table answers the guarantee queries the
 * way Postgres would — live GUARANTEE rows of the requests asked about.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { EditProcess, PaymentTerms, Prisma } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';
import { decisionView, guaranteeDigest, parseDecisionToken, type DecisionRow } from '@/lib/decision-token';

type Att = { id: string; editId: string; kind: string; deletedAt: Date | null };
const h = vi.hoisted(() => ({
  role: 'FINANCE_MANAGER',
  edit: null as unknown,
  queueRows: [] as Array<Record<string, unknown>>,
  /** Each read of the queue, with the arguments it was given, in order. */
  queueReads: [] as Array<{ op: 'findMany' | 'count'; args: { where: unknown; orderBy?: unknown } }>,
  actionProps: [] as Array<Record<string, unknown>>,
  queueItems: [] as Array<Record<string, unknown>>,
  attachments: [] as Array<{ id: string; editId: string; kind: string; deletedAt: Date | null }>,
  /** Phase 2: the live customer and the submitter as the stale-field check reads them. */
  live: null as unknown,
  submitter: null as unknown,
}));

/** The attachment table, for a `where` of { editId | editId.in, kind, deletedAt: null }. */
function attachmentsFor(where: { editId?: string | { in: string[] }; kind?: string; deletedAt?: null }): Att[] {
  if (where.editId === undefined) return [];
  const ids = typeof where.editId === 'string' ? [where.editId] : where.editId.in;
  return h.attachments.filter(
    (a) =>
      ids.includes(a.editId) &&
      (where.kind === undefined || a.kind === where.kind) &&
      (where.deletedAt !== null || a.deletedAt === null)
  );
}

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
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u-viewer', role: h.role, username: 'viewer.x' } }) }));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ managedRegionIds: ['g1'] }),
  filterBranchesByScope: (_u: unknown, branches: unknown[]) => branches,
}));

/** Prisma's `select`, applied: only the selected keys come back. */
function project(row: Record<string, unknown>, select: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k];
    else if (v && typeof v === 'object' && 'select' in v) {
      const nested = row[k] as Record<string, unknown> | null | undefined;
      out[k] = nested == null ? nested : project(nested, (v as { select: Record<string, unknown> }).select);
    }
  }
  return out;
}
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: {
      findUnique: async () => h.edit,
      // The queue's rows match its `where` by construction, so `take` is all the
      // list applies and `count` is all of them — as Postgres would answer.
      findMany: async (args: { where: unknown; select: Record<string, unknown>; take?: number }) => {
        h.queueReads.push({ op: 'findMany', args });
        return h.queueRows.slice(0, args.take ?? h.queueRows.length).map((r) => project(r, args.select));
      },
      count: async (args: { where: unknown }) => {
        h.queueReads.push({ op: 'count', args });
        return h.queueRows.length;
      },
    },
    attachment: {
      findMany: async (args: { where: Parameters<typeof attachmentsFor>[0] }) =>
        attachmentsFor(args.where).map(({ id, editId }) => ({ id, editId })),
    },
    branch: { findMany: async () => [] },
    channel: { findMany: async () => [] },
    subChannel: { findMany: async () => [] },
    customer: { findUnique: async () => h.live },
    user: { findUnique: async () => h.submitter },
  },
}));
vi.mock('@/app/(app)/approvals/[id]/ApproveRejectActions', () => ({
  ApproveRejectActions: (props: Record<string, unknown>) => {
    h.actionProps.push(props);
    return <div data-testid="actions" />;
  },
}));
vi.mock('@/app/(app)/approvals/BulkApprovalQueue', () => ({
  BulkApprovalQueue: ({ items }: { items: Array<Record<string, unknown>> }) => {
    h.queueItems = items;
    return <div data-testid="queue" />;
  },
}));

beforeEach(() => {
  h.role = 'FINANCE_MANAGER';
  h.actionProps = [];
  h.queueItems = [];
  h.queueReads = [];
  h.attachments = [];
  h.live = null;
  h.submitter = null;
});

const guarantee = (id: string, editId = 'e1', deletedAt: Date | null = null): Att => ({
  id,
  editId,
  kind: 'GUARANTEE',
  deletedAt,
});
afterEach(cleanup);

const STAGE = new Date('2026-09-23T09:15:00.789Z');

function createRow(paymentTerms: 'CASH' | 'CREDIT', currentStepIndex: number, over: Record<string, unknown> = {}) {
  const credit = paymentTerms === 'CREDIT';
  return {
    id: 'e1',
    process: 'CREATE',
    state: 'SUBMITTED',
    customerId: null,
    customer: null,
    approvalChain: resolveChain(EditProcess.CREATE, credit ? PaymentTerms.CREDIT : PaymentTerms.CASH),
    currentStepIndex,
    cycle: 2,
    stageEnteredAt: STAGE,
    slaDueAt: new Date(STAGE.getTime() + 8 * 3600_000),
    escalationLevel: 0,
    submittedAt: new Date('2026-09-22T07:00:00.000Z'),
    requestedCreditLimit: credit ? new Prisma.Decimal('10000') : null,
    requestedPaymentTermDays: credit ? 90 : null,
    fieldChanges: [],
    decisionReason: null,
    reviewedAt: null,
    reviewedBy: null,
    submittedBy: { id: 's1', fullName: 'Salesman One', username: 'salesman.one', supervisorId: 'sup1' },
    steps: [],
    customerDraft: {
      legalName: 'Al Noor Trading',
      crNumber: '1234567',
      paymentTerms,
      channel: { label: 'Retail' },
      subChannel: null,
      primaryPhone: null,
      altPhone: null,
      contactPerson: 'Ali',
      contactRole: null,
      notes: null,
      crPhotoAttachmentId: null,
    },
    branchDrafts: [],
    ...over,
  };
}

async function renderDetail(edit: unknown) {
  h.edit = edit;
  const { default: Page } = await import('@/app/(app)/approvals/[id]/page');
  render(await Page({ params: Promise.resolve({ id: 'e1' }) }));
  expect(h.actionProps).toHaveLength(1);
  return h.actionProps[0]!;
}

describe('the review page', () => {
  it('N01: the token it hands the buttons is the row it rendered', async () => {
    const row = createRow('CREDIT', 1);
    const props = await renderDetail(row);
    expect(props.editId).toBe('e1');
    expect(parseDecisionToken(props.decisionToken)).toEqual(decisionView(row as unknown as DecisionRow, []));
    // X-APPR-1: the figures bound are the figures printed.
    expect(screen.getByText('OMR 10000.000')).toBeTruthy();
    expect(screen.getByText('90 days')).toBeTruthy();
  });

  describe('the reject form is told where a rejection sends the request (lib/approval-chains.ts)', () => {
    /** An EditApproval row as the page loads it. */
    const decided = (stepIndex: number, cycle: number, decision: 'APPROVED' | 'REJECTED', i = 0) => ({
      id: `s-${stepIndex}-${cycle}-${decision}-${i}`,
      stepIndex,
      cycle,
      decision,
      role: 'SUPERVISOR',
      reason: decision === 'REJECTED' ? 'Please re-check.' : null,
      at: new Date('2026-09-22T08:00:00.000Z'),
      actor: { fullName: 'Someone' },
    });
    const rejectOutcomeOf = async (row: unknown) => {
      cleanup();
      h.actionProps = [];
      return (await renderDetail(row)).rejectOutcome;
    };

    it('a later step, the first time this round: one step back, to the previous role', async () => {
      expect(await rejectOutcomeOf(createRow('CREDIT', 1))).toEqual({ kind: 'STEP_BACK', toRole: 'SUPERVISOR' });
      expect(await rejectOutcomeOf(createRow('CREDIT', 2))).toEqual({ kind: 'STEP_BACK', toRole: 'FINANCE_MANAGER' });
      expect(await rejectOutcomeOf(createRow('CREDIT', 3))).toEqual({ kind: 'STEP_BACK', toRole: 'GM' });
      expect(await rejectOutcomeOf(createRow('CASH', 1))).toEqual({ kind: 'STEP_BACK', toRole: 'SUPERVISOR' });
    });

    it('the first step: to the salesman', async () => {
      expect(await rejectOutcomeOf(createRow('CREDIT', 0))).toEqual({ kind: 'TO_SALESMAN' });
    });

    it('a step that already rejected it this round: to the salesman; an earlier round or another step does not count', async () => {
      expect(
        await rejectOutcomeOf(createRow('CREDIT', 1, { steps: [decided(1, 2, 'REJECTED'), decided(0, 2, 'APPROVED')] }))
      ).toEqual({ kind: 'TO_SALESMAN' });
      expect(
        await rejectOutcomeOf(
          createRow('CREDIT', 1, { steps: [decided(1, 1, 'REJECTED'), decided(2, 2, 'REJECTED'), decided(1, 2, 'APPROVED')] })
        )
      ).toEqual({ kind: 'STEP_BACK', toRole: 'SUPERVISOR' });
    });
  });

  it('N01: a credit application binds exactly the guarantee documents it lists — live ones, of this request', async () => {
    h.attachments = [
      guarantee('g-b'),
      guarantee('g-a'),
      guarantee('g-removed', 'e1', new Date()),
      guarantee('g-other', 'e9'),
      { id: 'cr-1', editId: 'e1', kind: 'CR', deletedAt: null },
    ];
    const props = await renderDetail(createRow('CREDIT', 1));
    // What the page shows under "Guarantee documents".
    const row = screen.getByText('Guarantee documents (2)').parentElement!;
    const shown = within(row)
      .getAllByRole('img')
      .map((i) => i.getAttribute('src')!.replace('/api/photos/', ''));
    expect(shown.sort()).toEqual(['g-a', 'g-b']);
    expect(parseDecisionToken(props.decisionToken)!.guarantees).toBe(guaranteeDigest(shown));
  });

  it('N01: an edit of a live customer binds no guarantees', async () => {
    h.role = 'GM';
    h.attachments = [guarantee('g-a')];
    const update = createRow('CASH', 0, {
      process: 'UPDATE',
      customerId: 'c1',
      customer: { id: 'c1', legalName: 'Muscat Pearl', nmwcCode: 'NMWC-000123', crPhotoId: null, branches: [] },
      approvalChain: resolveChain(EditProcess.UPDATE, PaymentTerms.CASH),
      customerDraft: null,
    });
    expect(parseDecisionToken((await renderDetail(update)).decisionToken)!.guarantees).toBeNull();
  });

  it('X-APPR-2: a mid-chain step sends it on to the next role', async () => {
    expect((await renderDetail(createRow('CREDIT', 1))).outcome).toEqual({ kind: 'ADVANCE', nextRole: 'GM' });
    cleanup();
    h.actionProps = [];
    expect((await renderDetail(createRow('CASH', 0))).outcome).toEqual({ kind: 'ADVANCE', nextRole: 'ACCOUNTANT' });
  });

  it('X-APPR-2: the final step of a new-customer request creates it', async () => {
    // Viewed by an org-wide role: the words follow the step, not the viewer.
    expect((await renderDetail(createRow('CREDIT', 3))).outcome).toEqual({ kind: 'CREATE' });
    cleanup();
    h.actionProps = [];
    expect((await renderDetail(createRow('CASH', 1))).outcome).toEqual({ kind: 'CREATE' });
  });

  it('X-APPR-2: an edit of a live customer changes it', async () => {
    h.role = 'GM';
    const update = createRow('CASH', 0, {
      process: 'UPDATE',
      customerId: 'c1',
      customer: { id: 'c1', legalName: 'Muscat Pearl', nmwcCode: 'NMWC-000123', crPhotoId: null, branches: [] },
      approvalChain: resolveChain(EditProcess.UPDATE, PaymentTerms.CASH),
      customerDraft: null,
      stageEnteredAt: null,
    });
    const props = await renderDetail(update);
    expect(props.outcome).toEqual({ kind: 'APPLY' });
    // A single-step edit: a rejection always goes to the salesman.
    expect(props.rejectOutcome).toEqual({ kind: 'TO_SALESMAN' });
    // A row older than the stage columns: the token carries its null stage.
    expect(parseDecisionToken(props.decisionToken)).toMatchObject({ cycle: 2, stepIndex: 0, stageEnteredAt: null, creditLimit: null });
  });

  // Launch fix (2026-10-07): a refused close keeps the salesman's reason for
  // asking in decisionReason (the reviewer's is on the decision row), so the
  // decision box must not present it as the reviewer's words.
  it('a decided close request names its kept reason as the salesman’s; a sent-back update does not', async () => {
    const { default: Page } = await import('@/app/(app)/approvals/[id]/page');
    const decided = (target: 'BRANCH' | 'CUSTOMER', state: string, decisionReason: string) =>
      createRow('CASH', 0, {
        process: 'UPDATE',
        target,
        state,
        customerId: 'c1',
        customer: { id: 'c1', legalName: 'Muscat Pearl', nmwcCode: 'NMWC-000123', crPhotoId: null, branches: [] },
        approvalChain: resolveChain(EditProcess.UPDATE, PaymentTerms.CASH),
        customerDraft: null,
        decisionReason,
        reviewedBy: { fullName: 'Manager B' },
        reviewedAt: new Date('2026-10-07T06:00:00.000Z'),
      });
    h.role = 'GM';
    h.edit = decided('BRANCH', 'REJECTED', 'Shop shut, seen today.');
    render(await Page({ params: Promise.resolve({ id: 'e1' }) }));
    expect(screen.getByText(/Salesman.s reason:/).parentElement!.textContent).toContain('Shop shut, seen today.');
    cleanup();
    h.edit = decided('CUSTOMER', 'NEEDS_CORRECTION', 'Phone number is wrong.');
    render(await Page({ params: Promise.resolve({ id: 'e1' }) }));
    expect(screen.getByText(/Phone number is wrong\./)).toBeTruthy();
    expect(screen.queryByText(/Salesman.s reason:/)).toBeNull();
  });
});

describe('the review page of a customer update — phase 2 (F06, F20, F21, rulings 1, 2 and 8)', () => {
  const liveCustomer = (over: Record<string, unknown> = {}) => ({
    legalName: 'Muscat Pearl',
    paymentTerms: 'CASH',
    crNumber: '1234567',
    channelId: null,
    subChannelId: null,
    primaryPhone: '+96891234567',
    altPhone: null,
    contactPerson: 'Omar',
    contactRole: null,
    status: 'ACTIVE',
    notes: 'old note',
    deletedAt: null,
    branches: [{ id: 'b1', equipmentConfirmed: false, address: 'Ruwi', status: 'ACTIVE' }],
    ...over,
  });
  const update = (over: Record<string, unknown> = {}) =>
    createRow('CASH', 0, {
      process: 'UPDATE',
      target: 'CUSTOMER',
      isReactivation: false,
      customerId: 'c1',
      submittedById: 's1',
      submitGate: { v: 1, branchIds: ['b1'] },
      customer: { id: 'c1', legalName: 'Muscat Pearl', nmwcCode: 'NMWC-000123', crPhotoId: null, branches: [] },
      approvalChain: resolveChain(EditProcess.UPDATE, PaymentTerms.CASH),
      customerDraft: null,
      submittedBy: { id: 's1', fullName: 'Salesman One', username: 'salesman.one', supervisorId: 'sup1', role: 'SALESMAN' },
      ...over,
    });
  const STALE_BANNER = /^Changed on the customer since this request was sent:/;

  beforeEach(() => {
    h.role = 'GM';
    h.submitter = { role: 'SALESMAN' };
  });

  it('ruling 8: a stored change whose field moved since is named in one banner — labels only, and Approve stays on', async () => {
    h.live = liveCustomer();
    const props = await renderDetail(
      update({
        fieldChanges: [
          { field: 'customer.contactPerson', before: 'Said', after: 'Ali' },
          { field: 'customer.notes', before: 'old note', after: 'new note' },
        ],
      })
    );
    const banner = screen.getByText(STALE_BANNER);
    expect(banner.textContent).toBe('Changed on the customer since this request was sent: Contact person.');
    // The value it holds now is not on the page (the approver may not see every branch).
    expect(banner.parentElement!.textContent).not.toMatch(/Omar/);
    expect(banner.parentElement!.textContent).toMatch(/it will be refused — reject it/);
    expect(Object.keys(props).sort()).toEqual(['decisionToken', 'editId', 'outcome', 'rejectOutcome']);
  });

  it('ruling 8: judged after the QA-013 re-check, as the approval judges it — a CR number it would drop does not warn', async () => {
    h.live = liveCustomer({ paymentTerms: 'CREDIT', crNumber: 'CR-NOW' });
    await renderDetail(update({ fieldChanges: [{ field: 'customer.crNumber', before: 'CR-THEN', after: 'CR-MINE' }] }));
    expect(screen.queryByText(STALE_BANNER)).toBeNull();
    // A Manager's request keeps the field, so the same change warns.
    cleanup();
    h.actionProps = [];
    h.submitter = { role: 'MANAGER' };
    await renderDetail(update({ fieldChanges: [{ field: 'customer.crNumber', before: 'CR-THEN', after: 'CR-MINE' }] }));
    expect(screen.getByText(STALE_BANNER).textContent).toMatch(/CR number\.$/);
  });

  it('ruling 8: nothing moved since, no banner', async () => {
    h.live = liveCustomer({ contactPerson: 'Said' });
    await renderDetail(update({ fieldChanges: [{ field: 'customer.contactPerson', before: 'Said', after: 'Ali' }] }));
    expect(screen.queryByText(STALE_BANNER)).toBeNull();
  });

  it("ruling 2: a salesman's pending request stored with no gated branches came from the previous form, and says so", async () => {
    h.live = liveCustomer({ contactPerson: 'Said' });
    const OLD = /^Sent by the previous version of the form, which sent every field/;
    const changes = [{ field: 'customer.contactPerson', before: 'Said', after: 'Ali' }];
    await renderDetail(update({ submitGate: null, fieldChanges: changes }));
    expect(screen.getByText(OLD)).toBeTruthy();
    for (const over of [
      { submitGate: { v: 1, branchIds: ['b1'] } },
      { submitGate: null, submittedBy: { id: 's1', fullName: 'Manager One', supervisorId: null, role: 'MANAGER' } },
      { submitGate: null, state: 'APPROVED' },
    ]) {
      cleanup();
      h.actionProps = [];
      h.edit = update({ fieldChanges: changes, ...over });
      const { default: Page } = await import('@/app/(app)/approvals/[id]/page');
      render(await Page({ params: Promise.resolve({ id: 'e1' }) }));
      expect(screen.queryByText(OLD), JSON.stringify(over)).toBeNull();
    }
  });

  it('the rows: a clear reads "Cleared", Counted reads Yes / No, and a "Keep mine" says what it replaces', async () => {
    h.live = liveCustomer({ notes: 'old note', contactPerson: 'Omar' });
    await renderDetail(
      update({
        fieldChanges: [
          { field: 'customer.notes', before: 'old note', after: null },
          { field: 'customer.altPhone', before: null, after: '+96899887766' },
          { field: 'customer.contactPerson', before: 'Omar', after: 'Ali', overrodeLive: 'Omar' },
          { field: 'branch.b1.equipmentConfirmed', before: false, after: true },
        ],
      })
    );
    const row = (label: string) => screen.getByText(label, { selector: 'div' }).parentElement!;
    expect(within(row('notes')).getByText('Cleared').tagName).toBe('EM');
    // An empty before is not a clear: "—" still means it was empty.
    expect(within(row('altPhone')).queryByText('Cleared')).toBeNull();
    expect(within(row('altPhone')).getByText('—')).toBeTruthy();
    expect(within(row('equipmentConfirmed')).getByText('No')).toBeTruthy();
    expect(within(row('equipmentConfirmed')).getByText('Yes')).toBeTruthy();
    expect(within(row('contactPerson')).getByText('Replaces a value changed after the form was opened.')).toBeTruthy();
    expect(screen.getAllByText('Replaces a value changed after the form was opened.')).toHaveLength(1);
  });

  it('finding 2: the unmoved coordinate a point change records is no row, but still places the map link', async () => {
    const b1 = { id: 'b1', status: 'ACTIVE', gpsLat: 23.6, gpsLng: 58.4 };
    h.live = liveCustomer({ branches: [b1] });
    await renderDetail(
      update({
        fieldChanges: [
          { field: 'branch.b1.gpsLat', before: 23.6, after: 23.7 },
          { field: 'branch.b1.gpsLng', before: 58.4, after: 58.4 },
        ],
      })
    );
    expect(screen.getByText('gpsLat', { selector: 'div' })).toBeTruthy();
    expect(screen.queryByText('gpsLng', { selector: 'div' })).toBeNull();
    expect(screen.getByText('View proposed location on map')).toBeTruthy();
  });

  it("launch fix: times read in Oman time on a UTC server — the submit time and a moved point's capture time", async () => {
    // Vercel runs in UTC. 21:30 UTC on 7 October is 01:30 on the 8th in Oman; the
    // page printed "07/10/2026, 21:30:05", and the capture time as a raw UTC ISO string.
    vi.stubEnv('TZ', 'UTC');
    try {
      h.live = liveCustomer({ branches: [{ id: 'b1', status: 'ACTIVE', gpsLat: 23.6, gpsLng: 58.4 }] });
      await renderDetail(
        update({
          submittedAt: new Date('2026-10-07T21:30:05.000Z'),
          fieldChanges: [
            { field: 'branch.b1.gpsLat', before: 23.6, after: 23.7 },
            { field: 'branch.b1.gpsCapturedAt', before: '2026-09-01T06:00:00.000Z', after: '2026-10-07T21:30:00.000Z' },
          ],
        })
      );
      expect(screen.getByText(/submitted by Salesman One/).textContent).toMatch(/ · 08\/10\/2026, 01:30:05$/);
      const row = screen.getByText('gpsCapturedAt', { selector: 'div' }).parentElement!;
      expect(within(row).getByText('01/09/2026, 10:00:00')).toBeTruthy();
      expect(within(row).getByText('08/10/2026, 01:30:00')).toBeTruthy();
      expect(row.textContent).not.toMatch(/Z/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the approval queue', () => {
  async function renderQueue(rows: Array<Record<string, unknown>>) {
    h.queueRows = rows;
    const { default: Page } = await import('@/app/(app)/approvals/page');
    render(await Page());
    expect(screen.getByTestId('queue')).toBeTruthy();
    return h.queueItems;
  }

  it("N01 + X-APPR-1: every card's token is its row, and a credit card carries the same figures", async () => {
    const credit = createRow('CREDIT', 1);
    const cash = { ...createRow('CASH', 0), id: 'e2', stageEnteredAt: null };
    const [c, k] = await renderQueue([credit, cash]);
    expect(c!.id).toBe('e1');
    expect(parseDecisionToken(c!.decisionToken)).toEqual(decisionView(credit as unknown as DecisionRow, []));
    expect(c!.credit).toEqual({ limit: '10000.000', termDays: 90 });
    const bound = parseDecisionToken(c!.decisionToken)!;
    expect([bound.creditLimit, bound.paymentTermDays]).toEqual([
      (c!.credit as { limit: string }).limit,
      (c!.credit as { termDays: number }).termDays,
    ]);

    expect(k!.id).toBe('e2');
    expect(k!.credit).toBeNull();
    expect(parseDecisionToken(k!.decisionToken)).toEqual({
      cycle: 2,
      stepIndex: 0,
      stageEnteredAt: null,
      creditLimit: null,
      paymentTermDays: null,
      // A new-customer request with no guarantee document: bound as none.
      guarantees: guaranteeDigest([]),
    });
  });

  it("N01: each new-customer card binds its own request's live guarantees, read once for the page", async () => {
    h.attachments = [
      guarantee('g-a', 'e1'),
      guarantee('g-b', 'e1'),
      guarantee('g-gone', 'e1', new Date()),
      guarantee('g-c', 'e3'),
    ];
    const credit = createRow('CREDIT', 1);
    const other = { ...createRow('CREDIT', 1), id: 'e3' };
    const update = {
      ...createRow('CASH', 0),
      id: 'u1',
      process: 'UPDATE',
      customerId: 'c1',
      customer: { id: 'c1', legalName: 'Muscat Pearl', nmwcCode: 'NMWC-000123', completenessScore: 50, paymentTerms: 'CASH' },
      customerDraft: null,
    };
    const cards = await renderQueue([credit, other, update]);
    const bound = (id: string) => parseDecisionToken(cards.find((c) => c.id === id)!.decisionToken)!.guarantees;
    expect(bound('e1')).toBe(guaranteeDigest(['g-a', 'g-b']));
    expect(bound('e3')).toBe(guaranteeDigest(['g-c']));
    expect(bound('u1')).toBeNull();
  });

  describe('the header counts the queue, not the page', () => {
    // It printed the number of cards, so a queue of 600 read "200 pending".
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...createRow('CASH', 0), id: `q${String(i).padStart(3, '0')}` }));
    const subtitle = () => screen.getByText(/ pending/).textContent;

    it('600 waiting: all 600 counted, and it says which 200 are on screen — the most overdue, in queue order', async () => {
      const all = rows(600);
      const cards = await renderQueue(all);
      expect(subtitle()).toBe('600 pending · showing the 200 most overdue');
      expect(cards.map((c) => c.id)).toEqual(all.slice(0, 200).map((r) => r.id));
      const list = h.queueReads.find((r) => r.op === 'findMany')!;
      expect(list.args.orderBy).toEqual([{ slaDueAt: 'asc' }, { submittedAt: 'asc' }]);
    });

    it.each([
      [3, '3 pending'],
      [200, '200 pending'],
      [201, '201 pending · showing the 200 most overdue'],
    ])('%i waiting reads "%s"', async (n, text) => {
      await renderQueue(rows(n));
      expect(subtitle()).toBe(text);
    });

    it("the count reads the list's own `where` — the same object, for every approver role", async () => {
      for (const role of ['SUPERVISOR', 'MANAGER', 'ACCOUNTANT', 'FINANCE_MANAGER', 'GM']) {
        cleanup();
        h.queueReads = [];
        h.role = role;
        await renderQueue(rows(2));
        const list = h.queueReads.filter((r) => r.op === 'findMany');
        const count = h.queueReads.filter((r) => r.op === 'count');
        expect([list.length, count.length], role).toEqual([1, 1]);
        // Not an equal copy: a second derivation of the scope could drift from
        // the list's and count requests this approver cannot open.
        expect(count[0]!.args.where, role).toBe(list[0]!.args.where);
        // Nothing else narrows the count — no take, no skip.
        expect(Object.keys(count[0]!.args), role).toEqual(['where']);
      }
    });
  });
});

describe('F1: the review page says when its viewer cannot decide the request (lib/decision-lane.ts)', () => {
  const liveBranch = {
    id: 'b1',
    branchName: 'Main',
    branchCode: 'B-1',
    address: 'Synthetic address',
    gpsLat: null,
    gpsLng: null,
    gpsAccuracy: null,
    gpsCapturedAt: null,
    shopPhotoId: null,
    signboardPhotoId: null,
    routeId: 'r1',
    regionId: 'g1',
    deletedAt: null,
    route: { code: 'R1' },
  };
  const update = (over: Record<string, unknown> = {}) =>
    createRow('CASH', 0, {
      process: 'UPDATE',
      customerId: 'c1',
      customer: { id: 'c1', legalName: 'Muscat Pearl', nmwcCode: 'NMWC-000123', crPhotoId: null, branches: [liveBranch] },
      approvalChain: resolveChain(EditProcess.UPDATE, PaymentTerms.CASH),
      customerDraft: null,
      ...over,
    });

  it('an Accountant told for information while the request is at the Supervisor step reads it under a banner', async () => {
    h.role = 'ACCOUNTANT';
    await renderDetail(update());
    const note = screen.getByRole('note');
    expect(note.textContent).toMatch(/For your information/);
    expect(note.textContent).toContain('SUPERVISOR');
  });

  it('the approver of the current step sees no banner', async () => {
    h.role = 'MANAGER';
    await renderDetail(update());
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('a reactivation says where it is decided; only a Manager gets the link', async () => {
    h.role = 'GM';
    await renderDetail(update({ isReactivation: true, approvalChain: null }));
    expect(screen.getByRole('note').textContent).toMatch(/decided on the Reactivations page/);
    expect(screen.queryByRole('link', { name: 'Open Reactivations' })).toBeNull();

    cleanup();
    h.actionProps = [];
    h.role = 'MANAGER';
    await renderDetail(update({ isReactivation: true, approvalChain: null }));
    expect(screen.getByRole('link', { name: 'Open Reactivations' }).getAttribute('href')).toBe('/reactivations');
  });
});
