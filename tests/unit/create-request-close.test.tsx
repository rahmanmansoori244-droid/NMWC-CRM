/**
 * Launch fixes on the new-customer request page:
 *
 *   - A request in review is read-only, its location included: "Recapture GPS"
 *     and "Enter coordinates manually" still changed the chip on a request
 *     nothing on the page could save.
 *   - The salesman can withdraw his own draft, or a request sent back to him,
 *     so it stops blocking its CR and shop for everyone
 *     (services/creates.ts withdrawCreateAction). Not one in review. A
 *     withdrawn request opens read-only, saying it is closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  withdraw: vi.fn(),
  edit: null as unknown,
  withdrawProps: [] as Array<Record<string, unknown>>,
  findUniqueArgs: [] as Array<{ include?: Record<string, unknown> }>,
  formProps: [] as Array<Record<string, unknown>>,
  signedFormProps: [] as Array<Record<string, unknown>>,
  /**
   * The decision-bound documents, and the request's decisions as the page reads
   * them — with the request, through its one trail (finding 18: it used to read
   * only "the latest decision row", in a query of its own).
   */
  bound: [] as Array<{ id: string; kind: string }>,
  steps: [] as Array<Record<string, unknown>>,
}));
const nav = vi.hoisted(() => ({ hardReplace: vi.fn() }));
vi.mock('@/lib/navigate', () => nav);
vi.mock('@/services/creates', () => ({ withdrawCreateAction: h.withdraw }));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({ PhotoCaptureSlot: () => <span>photo</span> }));

import { CreateCustomerForm, type CreateFormInitial } from '@/app/(app)/customers/new/CreateCustomerForm';
import { WithdrawRequest } from '@/app/(app)/customers/new/WithdrawRequest';
import { onRequestClosed } from '@/lib/device-drafts';

const initial = (state: CreateFormInitial['state']): CreateFormInitial => ({
  editId: 'e1',
  state,
  decisionReason: null,
  pendingRole: state === 'SUBMITTED' ? 'SUPERVISOR' : null,
  customer: {
    legalName: 'Al Noor Shop',
    paymentTerms: 'CASH',
    crNumber: '1234567',
    channelId: '',
    subChannelId: '',
    primaryPhone: '',
    altPhone: '',
    contactPerson: '',
    contactRole: '',
    notes: '',
    crPhotoAttachmentId: null,
    email: '',
  },
  credit: { requestedCreditLimit: null, requestedPaymentTermDays: null },
  guaranteeAttachmentIds: [],
  creditDocuments: { ID_CARD: [], MEMBERSHIP_CERT: [], VAT_CERT: [], TAX_CARD: [] },
  branches: [
    {
      branchName: 'Main',
      address: 'Way 1',
      areaDescription: '',
      gpsLat: 23.6,
      gpsLng: 58.4,
      gpsAccuracy: 8,
      gpsCapturedAt: '2026-10-01T06:00:00.000Z',
      gpsManualReason: null,
      dayOfVisit: 'SUN',
      openingHours: '',
      deliveryWindow: '',
      coolersCount: 0,
      standsCount: 0,
      emptyBottlesCount: 0,
      shopPhotoAttachmentId: null,
      signboardPhotoAttachmentId: null,
      extraPhotoAttachmentIds: [],
    },
  ],
});

beforeEach(() => {
  h.withdraw.mockReset().mockResolvedValue({ ok: true, data: { editId: 'e1' } });
  nav.hardReplace.mockReset();
  window.localStorage.clear();
});
afterEach(cleanup);

describe('the location on a request that is not his to change now', () => {
  it.each(['SUBMITTED', 'REJECTED'] as const)('%s: neither GPS control can be used', (state) => {
    render(<CreateCustomerForm channels={[]} initial={initial(state)} sessionUserId="u1" />);
    expect(screen.getByRole('button', { name: 'Recapture GPS' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Enter coordinates manually/ })).toBeDisabled();
  });

  it('on a draft both still work', () => {
    render(<CreateCustomerForm channels={[]} initial={initial('DRAFT')} sessionUserId="u1" />);
    expect(screen.getByRole('button', { name: 'Recapture GPS' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Enter coordinates manually/ })).toBeEnabled();
  });

  it('a withdrawn request says it is closed, and offers no Submit or Save draft', () => {
    render(<CreateCustomerForm channels={[]} initial={initial('REJECTED')} sessionUserId="u1" />);
    expect(screen.getByText(/This request was withdrawn and is closed\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Submit for approval/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByText(/This request is in review/)).toBeNull();
  });
});

// Security review follow-up: services/creates.ts refuses to save or send a
// request started on a route he no longer works. The full form with Save draft
// and Submit still rendered, so he could correct it field by field before the
// refusal; it is read-only now, under the page's banner, above its Withdraw.
describe('a request started on a route he no longer works', () => {
  it.each(['NEEDS_CORRECTION', 'DRAFT'] as const)(
    '%s: read-only, with no Submit or Save draft, and the reason it was sent back still shown',
    (state) => {
      render(
        <CreateCustomerForm
          channels={[]}
          initial={{ ...initial(state), decisionReason: 'The CR photo is unreadable.' }}
          sessionUserId="u1"
          startedOnOtherRoute
        />
      );
      expect(screen.queryByRole('button', { name: /Submit for approval/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
      expect(screen.queryByRole('button', { name: /Add another branch/ })).toBeNull();
      expect(screen.getByDisplayValue('Al Noor Shop')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Recapture GPS' })).toBeDisabled();
      expect(screen.getByText('The CR photo is unreadable.')).toBeTruthy();
      // Not in review, and not closed: neither banner.
      expect(screen.queryByText(/This request is in review/)).toBeNull();
      expect(screen.queryByText(/withdrawn and is closed/)).toBeNull();
    }
  );

  it('the same request on his own route can still be changed and sent', () => {
    render(<CreateCustomerForm channels={[]} initial={initial('NEEDS_CORRECTION')} sessionUserId="u1" />);
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeTruthy();
    expect(screen.getByDisplayValue('Al Noor Shop')).toBeEnabled();
  });
});

describe('the reason it was sent back', () => {
  it('stays in view after he saves it as a draft — only a submit clears it', () => {
    for (const state of ['NEEDS_CORRECTION', 'DRAFT'] as const) {
      render(
        <CreateCustomerForm
          channels={[]}
          initial={{ ...initial(state), decisionReason: 'The CR photo is unreadable.' }}
          sessionUserId="u1"
        />
      );
      expect(screen.getByText('The CR photo is unreadable.')).toBeTruthy();
      cleanup();
    }
    // A draft never sent back has no reason, and shows none.
    render(<CreateCustomerForm channels={[]} initial={initial('DRAFT')} sessionUserId="u1" />);
    expect(screen.queryByText(/Returned for correction/)).toBeNull();
  });
});

describe('Withdraw', () => {
  const confirm = () => {
    const dialog = screen.getByRole('dialog');
    const buttons = within(dialog).getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]!);
  };

  it('asks first, then withdraws this request and goes to Work by a document load', async () => {
    render(<WithdrawRequest editId="e1" isDraft={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw this request' }));
    expect(h.withdraw).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').textContent).toMatch(/closed for good/);
    confirm();
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledWith('/work'));
    expect(h.withdraw).toHaveBeenCalledWith({ editId: 'e1' });
  });

  it('owner decisions 2026-10-11: at the signed-application step it says the customer may not sign', async () => {
    render(<WithdrawRequest editId="e1" isDraft={false} atSignedForm />);
    expect(screen.getByText(/If the customer will not sign the credit application/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw this request' }));
    expect(screen.getByRole('dialog').textContent).toContain('The customer will not sign? The request is closed for good');
    confirm();
    await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledWith('/work'));
  });

  it('a draft reads "Discard"; a refusal is shown and nothing moves', async () => {
    h.withdraw.mockResolvedValue({ ok: false, code: 'EDIT_LOCKED', message: 'This request is in review, so it cannot be withdrawn now.' });
    render(<WithdrawRequest editId="e1" isDraft />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
    confirm();
    expect(await screen.findByText('This request is in review, so it cannot be withdrawn now.')).toBeTruthy();
    expect(nav.hardReplace).not.toHaveBeenCalled();
  });

  // Code review 2026-11-10, finding 4: the forms on the page keep a copy of the
  // request on the phone. A withdrawn request has no use for it.
  it('a withdraw that went through tells the forms on the page, before Work loads; a refused one does not', async () => {
    const order: string[] = [];
    const heard = vi.fn(() => order.push('closed'));
    const other = vi.fn();
    const off = [onRequestClosed('e1', heard), onRequestClosed('e2', other)];
    nav.hardReplace.mockImplementation(() => order.push('work'));
    try {
      h.withdraw.mockResolvedValueOnce({ ok: false, code: 'EDIT_LOCKED', message: 'In review.' });
      render(<WithdrawRequest editId="e1" isDraft />);
      fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
      confirm();
      expect(await screen.findByText('In review.')).toBeTruthy();
      expect(heard).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
      confirm();
      await waitFor(() => expect(nav.hardReplace).toHaveBeenCalledWith('/work'));
      expect(order).toEqual(['closed', 'work']);
      expect(other, 'another request is not told').not.toHaveBeenCalled();
    } finally {
      off.forEach((f) => f());
    }
  });
});

describe('the page offers Withdraw on his draft or sent-back request only', () => {
  beforeEach(() => {
    vi.resetModules();
    h.withdrawProps = [];
    h.findUniqueArgs = [];
    h.formProps = [];
    h.signedFormProps = [];
    h.bound = [];
    h.steps = [];
    vi.doMock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u1', role: 'SALESMAN', username: 'mct01' } }) }));
    vi.doMock('next/navigation', () => ({
      notFound: () => {
        throw new Error('notFound');
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
    }));
    vi.doMock('@/lib/db', () => ({
      prisma: {
        user: {
          findUniqueOrThrow: async () => ({
            id: 'u1',
            ownedRoute: { id: 'r1', code: 'MCT-01', isActive: true, region: { name: 'Muscat' } },
          }),
        },
        customerEdit: {
          // The decisions come back with the row, as `include: { steps }` returns them.
          findUnique: async (args: { include?: Record<string, unknown> }) => {
            h.findUniqueArgs.push(args);
            return h.edit ? { ...(h.edit as object), steps: h.steps } : null;
          },
        },
        attachment: {
          findMany: async (args: { where: { kind?: unknown } }) =>
            typeof args.where.kind === 'object' ? h.bound : [],
        },
        // No editApproval here: a second read of the decisions would throw.
        channel: { findMany: async () => [] },
      },
    }));
    vi.doMock('@/app/(app)/customers/new/SignedFormUpload', () => ({
      SignedFormUpload: (p: Record<string, unknown>): ReactNode => {
        h.signedFormProps.push(p);
        return <div />;
      },
    }));
    vi.doMock('@/app/(app)/customers/new/CreateCustomerForm', () => ({
      CreateCustomerForm: (p: Record<string, unknown>) => {
        h.formProps.push(p);
        return <div />;
      },
    }));
    vi.doMock('@/app/(app)/customers/new/WithdrawRequest', () => ({
      WithdrawRequest: (p: Record<string, unknown>): ReactNode => {
        h.withdrawProps.push(p);
        return <div />;
      },
    }));
  });
  afterEach(() => {
    vi.doUnmock('@/lib/auth');
    vi.doUnmock('next/navigation');
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/app/(app)/customers/new/CreateCustomerForm');
    vi.doUnmock('@/app/(app)/customers/new/WithdrawRequest');
    vi.doUnmock('@/app/(app)/customers/new/SignedFormUpload');
  });

  it.each([
    ['DRAFT', [{ editId: 'e1', isDraft: true, atSignedForm: false }]],
    ['NEEDS_CORRECTION', [{ editId: 'e1', isDraft: false, atSignedForm: false }]],
    ['SUBMITTED', []],
    ['REJECTED', []],
  ] as const)('%s', async (state, expected) => {
    h.edit = {
      id: 'e1',
      process: 'CREATE',
      state,
      submittedById: 'u1',
      customerId: null,
      decisionReason: null,
      pendingRole: null,
      requestedCreditLimit: null,
      requestedPaymentTermDays: null,
      fieldChanges: [],
      customerDraft: null,
      branchDrafts: [],
    };
    const { default: Page } = await import('@/app/(app)/customers/new/page');
    render(await Page({ searchParams: Promise.resolve({ edit: 'e1' }) }));
    expect(h.formProps).toHaveLength(1);
    expect(h.withdrawProps).toEqual(expected);
  });

  // Security review: one started on a route he has since left cannot be saved or
  // sent again (services/creates.ts). The page says so, and Withdraw stays.
  it('one started on a route he no longer works says why, and still offers Withdraw', async () => {
    const onRoute = (routeId: string, code: string) => ({
      id: 'e1',
      process: 'CREATE',
      state: 'NEEDS_CORRECTION',
      submittedById: 'u1',
      customerId: null,
      decisionReason: 'The CR photo is unreadable.',
      pendingRole: null,
      requestedCreditLimit: null,
      requestedPaymentTermDays: null,
      fieldChanges: [],
      customerDraft: null,
      branchDrafts: [
        {
          id: 'b1',
          routeId,
          route: { code },
          branchName: 'Main',
          address: 'Way 1',
          areaDescription: null,
          gpsLat: null,
          gpsLng: null,
          gpsAccuracy: null,
          gpsCapturedAt: null,
          dayOfVisit: null,
          openingHours: null,
          deliveryWindow: null,
          coolersCount: 0,
          standsCount: 0,
          emptyBottlesCount: 0,
          shopPhotoAttachmentId: null,
          signboardPhotoAttachmentId: null,
          extraPhotoAttachmentIds: [],
        },
      ],
    });
    const { default: Page } = await import('@/app/(app)/customers/new/page');
    h.edit = onRoute('r0', 'MCT-02');
    render(await Page({ searchParams: Promise.resolve({ edit: 'e1' }) }));
    const said = screen.getByText(/This request was started on route MCT-02/).textContent ?? '';
    expect(said).toMatch(/You now work route MCT-01, so it cannot be saved or sent again\./);
    expect(said).toMatch(/Withdraw it .* and the salesman of route MCT-02 adds the shop afresh/);
    expect(h.withdrawProps).toEqual([{ editId: 'e1', isDraft: false, atSignedForm: false }]);
    // Shown read-only: he cannot spend time correcting what cannot be sent.
    expect(h.formProps[0]).toMatchObject({ startedOnOtherRoute: true });
    cleanup();

    // One on his own route says nothing of the kind.
    h.edit = onRoute('r1', 'MCT-01');
    render(await Page({ searchParams: Promise.resolve({ edit: 'e1' }) }));
    expect(screen.queryByText(/This request was started on route/)).toBeNull();
    expect(h.formProps[1]).toMatchObject({ startedOnOtherRoute: false });
  });

  // Code review 2026-11-10, finding 18: the salesman read only the LAST approver's
  // words (the request's one reason line) and cannot open the approver's page.
  // This page now says who sent it back, at which step and when, and lists the
  // round's earlier reasons — all read from the request's decisions.
  describe('finding 18: why it came back, from the decisions', () => {
    const at = (min: number) => new Date(Date.UTC(2026, 10, 9, 6, min, 0)); // 10:mm in Oman
    const d = (stepIndex: number, role: string, what: string, min: number, reason: string | null, by: string, cycle = 1) => ({
      id: `d-${stepIndex}-${what}-${min}`,
      cycle,
      stepIndex,
      role,
      decision: what,
      reason,
      at: at(min),
      actor: { fullName: by },
    });
    const request = (state: string, over: Record<string, unknown> = {}) => ({
      id: 'e1',
      process: 'CREATE',
      target: 'CUSTOMER',
      state,
      cycle: 1,
      submittedById: 'u1',
      customerId: null,
      decisionReason: null,
      decisionCategory: null,
      reviewedAt: null,
      reviewedBy: null,
      pendingRole: null,
      requestedCreditLimit: null,
      requestedPaymentTermDays: null,
      fieldChanges: [],
      customerDraft: null,
      branchDrafts: [],
      ...over,
    });
    const RELAY = [
      d(0, 'SUPERVISOR', 'APPROVED', 10, null, 'Manager Muna'),
      d(1, 'ACCOUNTANT', 'REJECTED', 20, 'CR number does not match the photo', 'Accountant Aisha'),
      d(0, 'SUPERVISOR', 'REJECTED', 30, 'Please re-verify and resubmit', 'Manager Muna'),
    ];
    const open = async () => {
      const { default: Page } = await import('@/app/(app)/customers/new/page');
      render(await Page({ searchParams: Promise.resolve({ edit: 'e1' }) }));
    };
    const panel = () => screen.queryByText('Returned for correction:')?.closest('div') ?? null;

    it('reads the decisions with the request, in one query, oldest first', async () => {
      h.edit = request('NEEDS_CORRECTION');
      await open();
      expect(h.findUniqueArgs).toHaveLength(1);
      expect(h.findUniqueArgs[0]!.include!.steps).toMatchObject({ orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    });

    it.each(['NEEDS_CORRECTION', 'DRAFT'] as const)(
      '%s after a relayed send-back: the latest reason, who sent it back at which step and when, then the earlier one',
      async (state) => {
        h.edit = request(state, { decisionReason: 'Please re-verify and resubmit', reviewedAt: at(30), reviewedBy: { fullName: 'Manager Muna' } });
        h.steps = RELAY;
        await open();
        const box = panel()!;
        // The label and the reason share one parent, as they did on the form's banner.
        const label = screen.getByText('Returned for correction:');
        expect(label.tagName).toBe('STRONG');
        expect(label.parentElement!.textContent).toBe('Returned for correction: Please re-verify and resubmit');
        expect(within(box).getByText('Sent back by Manager Muna at the Supervisor step, 09/11/2026, 10:30:00.')).toBeTruthy();
        expect(within(box).getByText('Earlier in this round:')).toBeTruthy();
        expect(within(box).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
          'Accountant step — Accountant Aisha, 09/11/2026, 10:20:00: CR number does not match the photo',
        ]);
        // Above the form, and the form's own one-line banner is never fed.
        expect((h.formProps[0]!.initial as { decisionReason: unknown }).decisionReason).toBeNull();
      }
    );

    it('one send-back in the round: no "Earlier" list', async () => {
      h.edit = request('NEEDS_CORRECTION', { decisionReason: 'Phone number format is incorrect' });
      h.steps = [d(0, 'SUPERVISOR', 'REJECTED', 30, 'Phone number format is incorrect', 'Manager Muna')];
      await open();
      expect(panel()!.textContent).toContain('Returned for correction: Phone number format is incorrect');
      expect(screen.queryByText('Earlier in this round:')).toBeNull();
      expect(screen.queryAllByRole('listitem')).toEqual([]);
    });

    it('a second round shows this round’s reasons only', async () => {
      h.edit = request('NEEDS_CORRECTION', { cycle: 2, decisionReason: 'Second-round reason' });
      h.steps = [...RELAY, d(0, 'SUPERVISOR', 'REJECTED', 50, 'Second-round reason', 'Manager Muna', 2)];
      await open();
      expect(panel()!.textContent).toContain('Returned for correction: Second-round reason');
      expect(screen.queryByText('Earlier in this round:')).toBeNull();
      expect(panel()!.textContent).not.toContain('CR number does not match the photo');
    });

    it('a request sent back before decisions were recorded: the reason and who, from the request itself', async () => {
      h.edit = request('NEEDS_CORRECTION', {
        decisionReason: 'The CR photo is unreadable.',
        reviewedAt: at(30),
        reviewedBy: { fullName: 'Manager Muna' },
      });
      await open();
      expect(panel()!.textContent).toContain('Returned for correction: The CR photo is unreadable.');
      expect(within(panel()!).getByText('Sent back by Manager Muna, 09/11/2026, 10:30:00.')).toBeTruthy();
      // And with no reviewer on it, only when.
      cleanup();
      h.edit = request('DRAFT', { decisionReason: 'The CR photo is unreadable.', reviewedAt: at(30) });
      await open();
      expect(within(panel()!).getByText('Sent back 09/11/2026, 10:30:00.')).toBeTruthy();
    });

    it('nothing is shown on a fresh draft, a request in review, or one he withdrew — whatever decisionReason holds', async () => {
      for (const row of [
        request('DRAFT'),
        // In review again: a step-back's reason an older build left on the row is not current.
        request('SUBMITTED', { cycle: 2, decisionReason: 'An old reason from round 1.' }),
        request('REJECTED', { decisionReason: 'Withdrawn by the salesman who sent it.', decisionCategory: 'withdrawn' }),
      ]) {
        cleanup();
        h.formProps = [];
        h.edit = row;
        h.steps = (row.state === 'DRAFT' ? [] : RELAY) as never;
        await open();
        expect(panel(), String(row.state)).toBeNull();
        expect(screen.queryByText(/Sent back by/)).toBeNull();
        expect((h.formProps[0]!.initial as { decisionReason: unknown }).decisionReason).toBeNull();
      }
    });
  });
});

describe('owner decisions 2026-10-11: his credit request at the signed-application step', () => {
  beforeEach(() => {
    vi.resetModules();
    h.withdrawProps = [];
    h.findUniqueArgs = [];
    h.formProps = [];
    h.signedFormProps = [];
    h.bound = [];
    h.steps = [];
    vi.doMock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u1', role: 'SALESMAN', username: 'mct01' } }) }));
    vi.doMock('next/navigation', () => ({
      notFound: () => {
        throw new Error('notFound');
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
    }));
    vi.doMock('@/lib/db', () => ({
      prisma: {
        user: {
          findUniqueOrThrow: async () => ({
            id: 'u1',
            ownedRoute: { id: 'r1', code: 'MCT-01', isActive: true, region: { name: 'Muscat' } },
          }),
        },
        customerEdit: {
          // The decisions come back with the row, as `include: { steps }` returns them.
          findUnique: async (args: { include?: Record<string, unknown> }) => {
            h.findUniqueArgs.push(args);
            return h.edit ? { ...(h.edit as object), steps: h.steps } : null;
          },
        },
        attachment: {
          findMany: async (args: { where: { kind?: unknown } }) =>
            typeof args.where.kind === 'object' ? h.bound : [],
        },
        // No editApproval here: a second read of the decisions would throw.
        channel: { findMany: async () => [] },
      },
    }));
    vi.doMock('@/app/(app)/customers/new/CreateCustomerForm', () => ({
      CreateCustomerForm: (p: Record<string, unknown>) => {
        h.formProps.push(p);
        return <div />;
      },
    }));
    vi.doMock('@/app/(app)/customers/new/WithdrawRequest', () => ({
      WithdrawRequest: (p: Record<string, unknown>): ReactNode => {
        h.withdrawProps.push(p);
        return <div />;
      },
    }));
    vi.doMock('@/app/(app)/customers/new/SignedFormUpload', () => ({
      SignedFormUpload: (p: Record<string, unknown>): ReactNode => {
        h.signedFormProps.push(p);
        return <div />;
      },
    }));
  });
  afterEach(() => {
    for (const m of [
      '@/lib/auth',
      'next/navigation',
      '@/lib/db',
      '@/app/(app)/customers/new/CreateCustomerForm',
      '@/app/(app)/customers/new/WithdrawRequest',
      '@/app/(app)/customers/new/SignedFormUpload',
    ]) {
      vi.doUnmock(m);
    }
  });

  const STAGE = new Date('2026-10-11T06:00:00.000Z');
  /** One EditApproval row of the request, as the page's trail selects it. */
  const decision = (stepIndex: number, role: string, what: string, min: number, reason: string | null, cycle = 2) => ({
    id: `d-${stepIndex}-${what}-${min}`,
    cycle,
    stepIndex,
    role,
    decision: what,
    reason,
    at: new Date(Date.UTC(2026, 9, 11, 5, min, 0)),
    actor: { fullName: `${role} person` },
  });
  const atStep = async (stepIndex: number, over: Record<string, unknown> = {}) => {
    const { resolveChain } = await import('@/lib/approval-chains');
    return {
      id: 'e1',
      process: 'CREATE',
      state: 'SUBMITTED',
      submittedById: 'u1',
      customerId: null,
      decisionReason: 'An old reason from round 1.',
      pendingRole: stepIndex === 2 ? 'SALESMAN' : 'SALES_DIRECTOR',
      approvalChain: resolveChain('CREATE', 'CREDIT'),
      currentStepIndex: stepIndex,
      cycle: 2,
      stageEnteredAt: STAGE,
      slaDueAt: new Date('2026-10-14T12:00:00.000Z'),
      requestedCreditLimit: null,
      requestedPaymentTermDays: null,
      fieldChanges: [],
      customerDraft: null,
      branchDrafts: [],
      ...over,
    };
  };

  it('shows the upload with his kept pages, the due time and the token, offers Withdraw, and names the step in words', async () => {
    h.edit = await atStep(2);
    h.bound = [
      { id: 'doc-id', kind: 'ID_CARD' },
      { id: 'kept-1', kind: 'CREDIT_FORM' },
    ];
    // The Finance Manager's send-back of this round: the latest decision, of the step after his.
    h.steps = [
      decision(1, 'SALES_DIRECTOR', 'APPROVED', 10, null),
      decision(2, 'SALESMAN', 'FORM_UPLOADED', 20, null),
      decision(3, 'FINANCE_MANAGER', 'REJECTED', 30, 'The stamp is not readable.'),
      // A later decision of ANOTHER round is not this round's latest.
      decision(0, 'SUPERVISOR', 'REJECTED', 40, 'from round 1', 1),
    ];
    const { default: Page } = await import('@/app/(app)/customers/new/page');
    render(await Page({ searchParams: Promise.resolve({ edit: 'e1' }) }));
    expect(h.signedFormProps).toHaveLength(1);
    const p = h.signedFormProps[0]!;
    expect(p).toMatchObject({
      editId: 'e1',
      keptPageIds: ['kept-1'],
      dueText: '14/10/2026, 16:00:00',
      sentBackReason: 'The stamp is not readable.',
    });
    const { parseDecisionToken, guaranteeDigest } = await import('@/lib/decision-token');
    expect(parseDecisionToken(p.decisionToken)).toMatchObject({
      cycle: 2,
      stepIndex: 2,
      stageEnteredAt: STAGE,
      guarantees: guaranteeDigest(['doc-id', 'kept-1']),
    });
    expect(h.withdrawProps).toEqual([{ editId: 'e1', isDraft: false, atSignedForm: true }]);
    expect((h.formProps[0]!.initial as { pendingRole: string }).pendingRole).toBe('Signed application');
    // Code review 2026-11-10, finding 4: the pages he adds are kept on the phone
    // under his own user id, and the request's form leaves that copy alone.
    expect(p.sessionUserId).toBe('u1');
    expect(h.formProps[0]).toMatchObject({ sessionUserId: 'u1', signedFormOpen: true });
  });

  it('finding 4: the form is told which save of the request it shows — the id of its last save, else its last-updated time', async () => {
    const { default: Page } = await import('@/app/(app)/customers/new/page');
    const versionOf = async (over: Record<string, unknown>) => {
      h.formProps = [];
      h.edit = await atStep(1, over);
      cleanup();
      render(await Page({ searchParams: Promise.resolve({ edit: 'e1' }) }));
      return (h.formProps[0]!.initial as CreateFormInitial).version;
    };
    const sid = '3f1c1d2e-7a4b-4c5d-9e8f-0a1b2c3d4e5f';
    const updatedAt = new Date('2026-11-10T06:00:00.000Z');
    expect(await versionOf({ submissionId: sid, updatedAt })).toBe(sid);
    expect(await versionOf({ submissionId: null, updatedAt })).toBe(`at:${updatedAt.getTime()}`);
    expect(await versionOf({})).toBeNull();
    // At another step the signed-application copy is not kept open.
    expect(h.formProps[0]).toMatchObject({ signedFormOpen: false });
  });

  it("part B: the e-mail and each credit document's pages on file reach the form; a guarantee too; the signed pages are not a form document", async () => {
    h.edit = await atStep(1, {
      customerDraft: { legalName: 'Al Noor Shop', paymentTerms: 'CREDIT', email: 'accounts@alnoor.om' },
    });
    h.bound = [
      { id: 'g1', kind: 'GUARANTEE' },
      { id: 'id-1', kind: 'ID_CARD' },
      { id: 'id-2', kind: 'ID_CARD' },
      { id: 'tax-1', kind: 'TAX_CARD' },
      { id: 'form-1', kind: 'CREDIT_FORM' },
    ];
    const { default: Page } = await import('@/app/(app)/customers/new/page');
    render(await Page({ searchParams: Promise.resolve({ edit: 'e1' }) }));
    const init = h.formProps[0]!.initial as CreateFormInitial;
    expect(init.customer.email).toBe('accounts@alnoor.om');
    expect(init.guaranteeAttachmentIds).toEqual(['g1']);
    expect(init.creditDocuments).toEqual({ ID_CARD: ['id-1', 'id-2'], MEMBERSHIP_CERT: [], VAT_CERT: [], TAX_CARD: ['tax-1'] });
  });

  it('a reason is shown only when the latest decision of this round is the Finance Manager’s send-back', async () => {
    h.edit = await atStep(2);
    // The Sales Director's approval was the latest: no send-back to show (decisionReason is stale).
    h.steps = [
      decision(1, 'SALES_DIRECTOR', 'REJECTED', 5, 'An old reason from this round.'),
      decision(0, 'SUPERVISOR', 'APPROVED', 10, null),
      decision(1, 'SALES_DIRECTOR', 'APPROVED', 20, null),
    ];
    const { default: Page } = await import('@/app/(app)/customers/new/page');
    render(await Page({ searchParams: Promise.resolve({ edit: 'e1' }) }));
    expect(h.signedFormProps[0]).toMatchObject({ sentBackReason: null });
  });

  it('finding 18: a Finance Manager relaying the GM — his reason on the card, the GM’s listed above it', async () => {
    h.edit = await atStep(2);
    h.steps = [
      decision(2, 'SALESMAN', 'FORM_UPLOADED', 10, null),
      decision(3, 'FINANCE_MANAGER', 'APPROVED', 20, null),
      decision(4, 'GM', 'REJECTED', 30, 'Limit too high for a new shop.'),
      decision(3, 'FINANCE_MANAGER', 'REJECTED', 40, 'Have the customer sign for OMR 300.'),
    ];
    const { default: Page } = await import('@/app/(app)/customers/new/page');
    render(await Page({ searchParams: Promise.resolve({ edit: 'e1' }) }));
    expect(h.signedFormProps[0]).toMatchObject({ sentBackReason: 'Have the customer sign for OMR 300.' });
    expect(screen.getByText('Before that, in this round:')).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'GM step — GM person, 11/10/2026, 09:30:00: Limit too high for a new shop.',
    ]);
    // It is not "returned for correction": only the signed form is redone.
    expect(screen.queryByText('Returned for correction:')).toBeNull();
  });

  it('finding 18: his own send-back alone, or none: no "Before that" list', async () => {
    h.edit = await atStep(2);
    h.steps = [decision(3, 'FINANCE_MANAGER', 'REJECTED', 30, 'The stamp is not readable.')];
    const { default: Page } = await import('@/app/(app)/customers/new/page');
    render(await Page({ searchParams: Promise.resolve({ edit: 'e1' }) }));
    expect(h.signedFormProps[0]).toMatchObject({ sentBackReason: 'The stamp is not readable.' });
    expect(screen.queryByText('Before that, in this round:')).toBeNull();
    cleanup();
    h.signedFormProps = [];
    // First time at the step: the Sales Director's approval is the latest decision.
    h.steps = [decision(4, 'GM', 'REJECTED', 5, 'from an earlier pass'), decision(1, 'SALES_DIRECTOR', 'APPROVED', 30, null)];
    render(await Page({ searchParams: Promise.resolve({ edit: 'e1' }) }));
    expect(h.signedFormProps[0]).toMatchObject({ sentBackReason: null });
    expect(screen.queryByText('Before that, in this round:')).toBeNull();
  });

  it('at another step in review: no upload, no Withdraw', async () => {
    h.edit = await atStep(1);
    const { default: Page } = await import('@/app/(app)/customers/new/page');
    render(await Page({ searchParams: Promise.resolve({ edit: 'e1' }) }));
    expect(h.signedFormProps).toEqual([]);
    expect(h.withdrawProps).toEqual([]);
    expect((h.formProps[0]!.initial as { pendingRole: string }).pendingRole).toBe('Sales Director');
  });
});
