/**
 * The "Before you promote" review (code review 2026-11-10, finding 1):
 * app/(app)/import/[batchId]/PromoteButton.tsx and PromoteReviewDialog.tsx, in
 * jsdom with the three server actions mocked to the shapes they return.
 *
 * What was wrong: a fresh Promote asked one native question — "This creates
 * customer + branch records" — and then loaded the sheet over whatever was on
 * record. Nothing said how many customers already in the CRM the sheet touched,
 * or that their names, phones and addresses would be replaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({
  promote: vi.fn(),
  summarise: vi.fn(),
  setOverwrite: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@/services/imports', () => ({ promoteCustomerBatchAction: h.promote }));
vi.mock('@/services/import-review', () => ({ summariseCustomerBatchAction: h.summarise }));
vi.mock('@/services/import-fixes', () => ({ setImportOverwriteAction: h.setOverwrite }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }) }));

import { PromoteButton } from '@/app/(app)/import/[batchId]/PromoteButton';

const KEPT =
  'CRM fields kept: on 2 customer(s) and 1 shop(s) the sheet differs from the record. Their values stay as they are on record (name 2, address 1).';
const REPLACED =
  "CRM fields REPLACED: on 2 customer(s) and 1 shop(s) the values on record will be replaced by this sheet's (name 2, address 1).";
const review = (overwrite: boolean) => ({
  ok: true as const,
  data: {
    summary: {},
    overwrite,
    lines: [
      { tone: 'plain', text: 'Checked 3 clean rows for 3 customers against the CRM as it is now.' },
      overwrite ? { tone: 'danger', text: REPLACED } : { tone: 'warn', text: KEPT },
      { tone: 'plain', text: 'This is a check, not a lock: Promote works from the CRM as it is at that moment.' },
    ],
  },
});
const done = (notes?: { kept: number; replaced: number; creditNotApplied: number }) => ({
  ok: true as const,
  data: { promoted: 3, failed: 0, deferred: 0, remaining: 0, done: true, ...(notes ? { notes } : {}) },
});
const fields = (fd: FormData) => Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));

let confirmSpy: { mockRestore: () => void };
beforeEach(() => {
  vi.clearAllMocks();
  h.summarise.mockResolvedValue(review(false));
  h.promote.mockResolvedValue(done());
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  confirmSpy.mockRestore();
});

async function openReview(props: Partial<Parameters<typeof PromoteButton>[0]> = {}) {
  render(<PromoteButton batchId="b1" remainingCount={3} canSetOverwrite {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Promote 3 clean rows' }));
  return screen.findByRole('dialog', { name: 'Before you promote' });
}

describe('a fresh promote is reviewed first', () => {
  it('opens the review instead of the native question, and promotes nothing yet', async () => {
    const dialog = await openReview();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(h.promote).not.toHaveBeenCalled();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await within(dialog).findByText(KEPT);
    expect(h.summarise).toHaveBeenCalledTimes(1);
    expect(fields(h.summarise.mock.calls[0]![0])).toEqual({ batchId: 'b1' });
    expect(within(dialog).getByText('Checked 3 clean rows for 3 customers against the CRM as it is now.')).toBeTruthy();
  });

  it('Promote waits for the check: disabled while it runs, enabled once the summary is on screen', async () => {
    let answer!: (v: unknown) => void;
    h.summarise.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const dialog = await openReview();
    expect(within(dialog).getByText('Checking what this sheet will change…')).toBeTruthy();
    const go = within(dialog).getByRole('button', { name: 'Promote 3 clean rows now' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    answer(review(false));
    await within(dialog).findByText(KEPT);
    expect(go.disabled).toBe(false);
    expect(within(dialog).queryByText('Checking what this sheet will change…')).toBeNull();
  });

  it('"Promote … now" closes the review and runs the load; rows that kept a CRM value or dropped a credit cell are counted in the result', async () => {
    h.promote.mockResolvedValue(done({ kept: 2, replaced: 0, creditNotApplied: 1 }));
    const dialog = await openReview();
    await within(dialog).findByText(KEPT);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote 3 clean rows now' }));
    await waitFor(() => expect(h.promote).toHaveBeenCalledTimes(1));
    expect(fields(h.promote.mock.calls[0]![0])).toEqual({ batchId: 'b1' });
    expect(
      await screen.findByText(
        '✓ Done — 3 rows promoted in this run. 2 row(s) kept the CRM value where the sheet differed; 1 row(s) carried credit cells that were not applied — see "Loaded with a warning".'
      )
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a load with nothing to note ends with the sentence it always had', async () => {
    h.promote.mockResolvedValue(done({ kept: 0, replaced: 0, creditNotApplied: 0 }));
    const dialog = await openReview();
    await within(dialog).findByText(KEPT);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote 3 clean rows now' }));
    expect(await screen.findByText('✓ Done — 3 rows promoted in this run.')).toBeTruthy();
  });

  it('Cancel, or Escape, closes it and promotes nothing', async () => {
    const dialog = await openReview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Promote 3 clean rows' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('a check that cannot be run says so, and does not block the load', async () => {
    h.summarise.mockResolvedValue({ ok: false, code: 'RATE_LIMITED', message: 'Wait 5s before checking this batch again.' });
    const dialog = await openReview();
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('The check could not be run: Wait 5s before checking this batch again.');
    expect((within(dialog).getByRole('button', { name: 'Promote 3 clean rows now' }) as HTMLButtonElement).disabled).toBe(false);
    // The option cannot be judged without the check, so it is not offered.
    expect(within(dialog).queryByRole('button', { name: 'Switch on overwrite' })).toBeNull();
  });
});

describe('the batch’s option: Overwrite CRM fields from this sheet', () => {
  it('is off, explained, and needs a reason of 10+ characters before it can be switched on', async () => {
    const dialog = await openReview();
    await within(dialog).findByText(KEPT);
    expect(within(dialog).getByText('Overwrite CRM fields from this sheet:').textContent).toBe(
      'Overwrite CRM fields from this sheet: off'
    );
    expect(dialog.textContent).toContain(
      'Off: customers and shops already in the CRM keep their name, phone, CR number, contact person, channel, address, visit day and open/closed status; this sheet only fills blanks.'
    );
    expect(dialog.textContent).toContain(
      "Rows that carry the customer's own Temix code never change CRM fields, on or off."
    );
    const on = within(dialog).getByRole('button', { name: 'Switch on overwrite' }) as HTMLButtonElement;
    const reason = within(dialog).getByLabelText('Why is this sheet correcting CRM fields? (10+ characters)');
    expect(on.disabled).toBe(true);
    fireEvent.change(reason, { target: { value: 'too short' } });
    expect(on.disabled).toBe(true);
    fireEvent.change(reason, { target: { value: '   spaces do not count   ' } });
    expect(on.disabled).toBe(false);
    expect(h.setOverwrite).not.toHaveBeenCalled();
  });

  it('switched on: the action gets the reason, the summary is checked again, and the lines turn from kept to REPLACED', async () => {
    h.setOverwrite.mockResolvedValue({ ok: true, data: { on: true } });
    const dialog = await openReview();
    await within(dialog).findByText(KEPT);
    h.summarise.mockResolvedValue(review(true));
    fireEvent.change(within(dialog).getByLabelText('Why is this sheet correcting CRM fields? (10+ characters)'), {
      target: { value: ' Agreed bulk correction of addresses ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch on overwrite' }));
    await within(dialog).findByText(REPLACED);
    expect(fields(h.setOverwrite.mock.calls[0]![0])).toEqual({
      batchId: 'b1',
      on: 'on',
      reason: 'Agreed bulk correction of addresses',
    });
    expect(h.summarise).toHaveBeenCalledTimes(2);
    expect(within(dialog).queryByText(KEPT)).toBeNull();
    expect(within(dialog).getByText(REPLACED).className).toContain('text-red-700');
    expect(within(dialog).getByText('Overwrite CRM fields from this sheet:').textContent).toBe(
      'Overwrite CRM fields from this sheet: ON'
    );
    // The page's banner follows the batch.
    expect(h.refresh).toHaveBeenCalled();
    // Nothing was promoted by switching it on.
    expect(h.promote).not.toHaveBeenCalled();
    // And it can be switched off again, with no reason asked.
    h.setOverwrite.mockResolvedValue({ ok: true, data: { on: false } });
    h.summarise.mockResolvedValue(review(false));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch overwrite off' }));
    await within(dialog).findByText(KEPT);
    expect(fields(h.setOverwrite.mock.calls[1]![0])).toEqual({ batchId: 'b1', on: 'off' });
  });

  it('a refusal from the server is shown, and the option stays as it was', async () => {
    h.setOverwrite.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { _form: 'Only a batch that is ready to promote can change this option.' },
    });
    const dialog = await openReview();
    await within(dialog).findByText(KEPT);
    fireEvent.change(within(dialog).getByLabelText('Why is this sheet correcting CRM fields? (10+ characters)'), {
      target: { value: 'Agreed bulk correction' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch on overwrite' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Only a batch that is ready to promote can change this option.'
    );
    expect(h.summarise).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByText(KEPT)).toBeTruthy();
  });

  it('is shown but cannot be changed when the batch is not ready to promote', async () => {
    const dialog = await openReview({ canSetOverwrite: false });
    await within(dialog).findByText(KEPT);
    expect(within(dialog).queryByRole('button', { name: 'Switch on overwrite' })).toBeNull();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(dialog.textContent).toContain(
      'The option can be changed only while the batch is ready to promote and nobody is promoting it.'
    );
  });
});

describe('a resumed promote goes straight on', () => {
  it('Resume does not open the review, and asks nothing', async () => {
    render(<PromoteButton batchId="b1" remainingCount={3} resume />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume promote (3 rows left)' }));
    await waitFor(() => expect(h.promote).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.summarise).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('Finish promote (nothing left) too', async () => {
    render(<PromoteButton batchId="b1" remainingCount={0} resume />);
    fireEvent.click(screen.getByRole('button', { name: 'Finish promote' }));
    await waitFor(() => expect(h.promote).toHaveBeenCalledTimes(1));
    expect(h.summarise).not.toHaveBeenCalled();
  });
});
