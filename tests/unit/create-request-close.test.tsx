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
  formProps: [] as Array<Record<string, unknown>>,
}));
const nav = vi.hoisted(() => ({ hardReplace: vi.fn() }));
vi.mock('@/lib/navigate', () => nav);
vi.mock('@/services/creates', () => ({ withdrawCreateAction: h.withdraw }));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({ PhotoCaptureSlot: () => <span>photo</span> }));

import { CreateCustomerForm, type CreateFormInitial } from '@/app/(app)/customers/new/CreateCustomerForm';
import { WithdrawRequest } from '@/app/(app)/customers/new/WithdrawRequest';

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
  },
  credit: { requestedCreditLimit: null, requestedPaymentTermDays: null },
  guaranteeAttachmentIds: [],
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

  it('a draft reads "Discard"; a refusal is shown and nothing moves', async () => {
    h.withdraw.mockResolvedValue({ ok: false, code: 'EDIT_LOCKED', message: 'This request is in review, so it cannot be withdrawn now.' });
    render(<WithdrawRequest editId="e1" isDraft />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
    confirm();
    expect(await screen.findByText('This request is in review, so it cannot be withdrawn now.')).toBeTruthy();
    expect(nav.hardReplace).not.toHaveBeenCalled();
  });
});

describe('the page offers Withdraw on his draft or sent-back request only', () => {
  beforeEach(() => {
    vi.resetModules();
    h.withdrawProps = [];
    h.formProps = [];
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
        customerEdit: { findUnique: async () => h.edit },
        attachment: { findMany: async () => [] },
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
  });
  afterEach(() => {
    vi.doUnmock('@/lib/auth');
    vi.doUnmock('next/navigation');
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/app/(app)/customers/new/CreateCustomerForm');
    vi.doUnmock('@/app/(app)/customers/new/WithdrawRequest');
  });

  it.each([
    ['DRAFT', [{ editId: 'e1', isDraft: true }]],
    ['NEEDS_CORRECTION', [{ editId: 'e1', isDraft: false }]],
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
});
