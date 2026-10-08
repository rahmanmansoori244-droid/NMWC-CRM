/**
 * The close-shop / reactivation form (components/nmwc/BranchStatusActions.tsx),
 * launch review:
 *
 *  - the reason is counted trimmed, as services/reactivations.ts counts it:
 *    five spaces enabled "Submit closure", and the server then refused it;
 *  - the evidence photo is uploaded on no slot. The form asked the slot to
 *    attach it to the live branch, as an extra photo, the moment it was up, so
 *    a Cancel or a refused submit left it there. The service now puts it on the
 *    branch inside the request's own transaction (wireEvidence; the DB half is
 *    tests/integration/close-shop-imported.test.ts).
 *
 * The photo slot is mocked: it reports one uploaded photo and records the props
 * the form gave it. submit-forms.test.tsx covers the retry and receipt paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';

const h = vi.hoisted(() => ({
  slotProps: [] as Array<Record<string, unknown>>,
  sent: [] as Array<{ url: string; body: Record<string, unknown> }>,
  replies: [] as unknown[],
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({
  PhotoCaptureSlot: (props: { onChange?: (p: { attachmentId: string }) => void } & Record<string, unknown>) => {
    h.slotProps.push(props);
    useEffect(() => {
      props.onChange?.({ attachmentId: 'att-evidence' });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <span>photo</span>;
  },
}));

import { BranchStatusActions } from '@/components/nmwc/BranchStatusActions';

beforeEach(() => {
  h.slotProps = [];
  h.sent = [];
  h.replies = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    h.sent.push({ url, body: init.body ? JSON.parse(String(init.body)) : {} });
    const reply = h.replies.shift() ?? { ok: true, data: { editId: 'e1', state: 'SUBMITTED', submittedAt: null, replayed: false } };
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reasonBox = () => screen.getByRole('textbox');
const type = (value: string) => fireEvent.change(reasonBox(), { target: { value } });

describe('the reason is counted trimmed', () => {
  it('five spaces, or a short word padded out to five, do not enable Submit closure', () => {
    render(<BranchStatusActions branchId="b1" status="ACTIVE" />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark closed' }));
    const submit = screen.getByRole('button', { name: 'Submit closure' });
    type('     ');
    expect(submit).toBeDisabled();
    type('  ab   ');
    expect(submit).toBeDisabled();
    type('  Shut. ');
    expect(submit).not.toBeDisabled();
  });

  it('is sent trimmed', async () => {
    render(<BranchStatusActions branchId="b1" status="ACTIVE" />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark closed' }));
    type('   Shop shut for good.  ');
    fireEvent.click(screen.getByRole('button', { name: 'Submit closure' }));
    await waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.body).toMatchObject({ reason: 'Shop shut for good.', attachmentId: 'att-evidence' });
  });
});

describe('the evidence photo is on no slot until the request is accepted', () => {
  it.each([
    ['ACTIVE', 'Mark closed'],
    ['CLOSED', 'Request reactivation'],
  ] as const)('%s branch: the slot is not asked to attach it to the branch', (status, open) => {
    render(<BranchStatusActions branchId="b1" status={status} />);
    fireEvent.click(screen.getByRole('button', { name: open }));
    expect(h.slotProps.length).toBeGreaterThan(0);
    for (const p of h.slotProps) expect(p.attachTo).toBeUndefined();
  });

  it('a refused submit, then Cancel, sent nothing but the request itself', async () => {
    h.replies.push({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { attachmentId: 'Photo is older than 24 hours — capture a fresh one.' },
    });
    render(<BranchStatusActions branchId="b1" status="ACTIVE" />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark closed' }));
    type('Shop shut for good.');
    fireEvent.click(screen.getByRole('button', { name: 'Submit closure' }));
    expect(await screen.findByText('Photo is older than 24 hours — capture a fresh one.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Mark closed' })).toBeTruthy();
    expect(h.sent.map((s) => s.url)).toEqual(['/api/forms/branch-close']);
  });
});

describe('launch browser suite — the form names its fields, and a refusal is read out', () => {
  it.each([
    ['ACTIVE', 'Mark closed'],
    ['CLOSED', 'Request reactivation'],
  ] as const)('%s branch: the reason is found by its label, and the photo slot is in a named group', (status, open) => {
    // Both captions were bare <label>s: the reason box had no name, and the
    // photo's caption named nothing.
    render(<BranchStatusActions branchId="b1" status={status} />);
    fireEvent.click(screen.getByRole('button', { name: open }));
    expect(screen.getByLabelText('Reason (5+ chars)')).toBe(reasonBox());
    const group = screen.getByRole('group', { name: 'Photo evidence (must be fresh — captured today)' });
    expect(within(group).getByText('photo')).toBeTruthy();
  });

  it('what the server refused is an alert, beside the notice that says it was not sent', async () => {
    h.replies.push({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { attachmentId: 'Photo is older than 24 hours — capture a fresh one.' },
    });
    render(<BranchStatusActions branchId="b1" status="ACTIVE" />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark closed' }));
    type('Shop shut for good.');
    fireEvent.click(screen.getByRole('button', { name: 'Submit closure' }));
    await screen.findByText('Photo is older than 24 hours — capture a fresh one.');
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toContain(
      'Photo is older than 24 hours — capture a fresh one.'
    );
  });
});
