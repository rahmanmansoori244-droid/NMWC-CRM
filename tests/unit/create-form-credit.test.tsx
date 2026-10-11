/**
 * Owner decisions 2026-10-11 — the new-customer form for a CREDIT customer:
 *   - the chain it states, in words (Supervisor → Sales Director → signed
 *     application → Finance Manager → GM → Accountant);
 *   - the customer's e-mail, asked for credit only: shown, in the missing list,
 *     on the phone copy, sent; never for cash;
 *   - the four credit documents, each its own group, in the missing list until a
 *     page is on file; the guarantee no longer asked for;
 *   - a refusal of something with no slot is still said, at the top;
 *   - a request in review shows its documents and offers no new page.
 *
 * The real form; the photo slot and GPS capture are mocked (they talk to the
 * camera, R2 and geolocation), and the form route answers through fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';

vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({
  PhotoCaptureSlot: ({ kind, initial }: { kind: string; initial?: { attachmentId: string } | null }) => (
    <span data-kind={kind}>{initial ? `${kind} page ${initial.attachmentId}` : `${kind} empty slot`}</span>
  ),
}));
vi.mock('@/components/nmwc/GpsCaptureButton', () => ({
  GpsCaptureButton: () => <button type="button">Capture GPS</button>,
}));
vi.mock('@/lib/navigate', () => ({ hardReplace: vi.fn() }));

import { CreateCustomerForm, CREDIT_CHAIN_NOTE, type CreateFormInitial } from '@/app/(app)/customers/new/CreateCustomerForm';

/** What the form posts to the field-form route, as these tests read it. */
type SentBody = {
  isDraft?: boolean;
  customer: { email?: string };
  guaranteeAttachmentIds: string[];
  creditDocuments: Record<string, string[]>;
  branches: Array<{ extraPhotoAttachmentIds: string[] }>;
};
let bodies: SentBody[] = [];
let replies: unknown[] = [];
beforeEach(() => {
  bodies = [];
  replies = [];
  window.localStorage.clear();
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const next = replies.shift() ?? {
      ok: true,
      data: { editId: 'd7', state: body.isDraft ? 'DRAFT' : 'SUBMITTED', submittedAt: null, replayed: false },
    };
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const channels = [{ id: 'ch1', key: 'retail', label: 'Retail', subChannels: [{ id: 'sc1', key: 'grocery', label: 'Grocery' }] }];
const NO_DOCS = { ID_CARD: [], MEMBERSHIP_CERT: [], VAT_CERT: [], TAX_CARD: [] };
function initial(over: Partial<CreateFormInitial> = {}, customer: Partial<CreateFormInitial['customer']> = {}): CreateFormInitial {
  return {
    editId: 'd7',
    state: 'DRAFT',
    decisionReason: null,
    pendingRole: null,
    customer: {
      legalName: 'Blue Sea Cafe',
      paymentTerms: 'CREDIT',
      crNumber: '7654321',
      channelId: 'ch1',
      subChannelId: 'sc1',
      primaryPhone: '+96891234567',
      altPhone: '',
      contactPerson: 'Said',
      contactRole: '',
      notes: '',
      crPhotoAttachmentId: 'att-cr',
      email: '',
      ...customer,
    },
    credit: { requestedCreditLimit: 500, requestedPaymentTermDays: 30 },
    guaranteeAttachmentIds: [],
    creditDocuments: NO_DOCS,
    branches: [
      {
        branchName: 'Main',
        address: 'Way 1, Ruwi',
        areaDescription: '',
        gpsLat: 23.5,
        gpsLng: 58.3,
        gpsAccuracy: 5,
        gpsCapturedAt: '2026-09-24T08:00:00.000Z',
        gpsManualReason: null,
        dayOfVisit: 'SUN',
        openingHours: '',
        deliveryWindow: '',
        coolersCount: 0,
        standsCount: 0,
        emptyBottlesCount: 0,
        shopPhotoAttachmentId: 'att-shop',
        signboardPhotoAttachmentId: 'att-sign',
        extraPhotoAttachmentIds: [],
      },
    ],
    ...over,
  };
}
const submitBtn = () => screen.getByRole('button', { name: 'Submit for approval ▶' });
const missing = () => submitBtn().getAttribute('title') ?? '';
const section = (title: string) => screen.queryByText(title, { selector: 'h3' })?.closest('details') ?? null;

describe('the credit choice', () => {
  it('states the chain with the Sales Director and the signed application; cash keeps its two steps', () => {
    render(<CreateCustomerForm channels={channels} initial={initial()} sessionUserId="u1" />);
    expect(screen.getByText(CREDIT_CHAIN_NOTE)).toBeTruthy();
    expect(CREDIT_CHAIN_NOTE).toBe(
      "Credit: approval chain is Supervisor → Sales Director → signed application → Finance Manager → GM → Accountant. The customer's e-mail and the four credit documents below are required."
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Cash' }));
    expect(screen.getByText('Cash: approval chain is Supervisor → Accountant.')).toBeTruthy();
  });
});

describe("the customer's e-mail", () => {
  it('is asked for credit only', () => {
    render(<CreateCustomerForm channels={channels} initial={initial()} sessionUserId="u1" />);
    expect(screen.getByRole('textbox', { name: 'E-mail *' })).toBeTruthy();
    expect(within(section('Contact')!).getByRole('textbox', { name: 'E-mail *' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Cash' }));
    expect(screen.queryByRole('textbox', { name: 'E-mail *' })).toBeNull();
  });

  it('is missing until typed, then sent trimmed', async () => {
    const docs = { ID_CARD: ['i1'], MEMBERSHIP_CERT: ['m1'], VAT_CERT: ['v1'], TAX_CARD: ['t1'] };
    render(<CreateCustomerForm channels={channels} initial={initial({ creditDocuments: docs })} sessionUserId="u1" />);
    await waitFor(() => expect(missing()).toBe('Missing: E-mail'));
    fireEvent.change(screen.getByRole('textbox', { name: 'E-mail *' }), { target: { value: ' accounts@bluesea.om ' } });
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    fireEvent.click(submitBtn());
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.customer.email).toBe('accounts@bluesea.om');
    expect(bodies[0]!.creditDocuments).toEqual(docs);
  });

  it('is kept in the phone copy of a form never saved, and restored', async () => {
    render(<CreateCustomerForm channels={channels} initial={null} sessionUserId="u1" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Credit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'E-mail *' }), { target: { value: 'accounts@bluesea.om' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(JSON.parse(window.localStorage.getItem('nmwc:create:u1:new')!)).toMatchObject({
      paymentTerms: 'CREDIT',
      email: 'accounts@bluesea.om',
    });
    cleanup();
    render(<CreateCustomerForm channels={channels} initial={null} sessionUserId="u1" />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'E-mail *' })).toHaveValue('accounts@bluesea.om'));
  });
});

describe('the four credit documents', () => {
  it('each is its own group, with an empty slot; each is missing until a page is on file; no guarantee is asked for', async () => {
    render(<CreateCustomerForm channels={channels} initial={initial({}, { email: 'accounts@bluesea.om' })} sessionUserId="u1" />);
    const docs = section('Credit documents')!;
    expect(docs).toBeTruthy();
    for (const [name, kind] of [
      ["Owner's ID card *", 'ID_CARD'],
      ['Membership certificate *', 'MEMBERSHIP_CERT'],
      ['VAT registration certificate *', 'VAT_CERT'],
      ['Tax card *', 'TAX_CARD'],
    ] as const) {
      expect(within(within(docs).getByRole('group', { name })).getByText(`${kind} empty slot`), name).toBeTruthy();
    }
    await waitFor(() =>
      expect(missing()).toBe("Missing: Owner's ID card, Membership certificate, VAT registration certificate, Tax card")
    );
    expect(missing()).not.toMatch(/Guarantee/);
    expect(within(docs).queryByText(/GUARANTEE/)).toBeNull();
  });

  it('none of it is shown or sent for cash', async () => {
    render(<CreateCustomerForm channels={channels} initial={initial({}, { paymentTerms: 'CASH' })} sessionUserId="u1" />);
    expect(section('Credit documents')).toBeNull();
    await waitFor(() => expect(submitBtn()).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ creditDocuments: {}, guaranteeAttachmentIds: [] });
    expect(bodies[0]!.customer.email).toBeUndefined();
  });

  it('a request in review shows its pages, and no slot for a new one', () => {
    const docs = { ID_CARD: ['i1', 'i2'], MEMBERSHIP_CERT: ['m1'], VAT_CERT: ['v1'], TAX_CARD: ['t1'] };
    render(
      <CreateCustomerForm
        channels={channels}
        initial={initial({ state: 'SUBMITTED', pendingRole: 'Supervisor', creditDocuments: docs, guaranteeAttachmentIds: ['g1'] })}
        sessionUserId="u1"
      />
    );
    expect(screen.getByText('ID_CARD page i2')).toBeTruthy();
    expect(screen.getByText('GUARANTEE page g1')).toBeTruthy();
    expect(within(section('Credit documents')!).queryAllByText(/empty slot/)).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'E-mail *' })).toBeDisabled();
  });
});

describe('a refusal', () => {
  it('of a document is said beside it; of something with no slot, at the top', async () => {
    const docs = { ID_CARD: ['i1'], MEMBERSHIP_CERT: ['m1'], VAT_CERT: ['v1'], TAX_CARD: ['t1'] };
    render(<CreateCustomerForm channels={channels} initial={initial({ creditDocuments: docs }, { email: 'a@b.om' })} sessionUserId="u1" />);
    replies.push({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'x',
      fields: { 'creditDoc.VAT_CERT': 'The VAT certificate photo was removed. Take it again.', creditDocuments: 'Expected object, received string' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('The VAT certificate photo was removed. Take it again.')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'VAT registration certificate *' })).toHaveAccessibleDescription(
      'The VAT certificate photo was removed. Take it again.'
    );
    expect(screen.getByText('Expected object, received string')).toBeTruthy();
  });
});
