/**
 * Launch fix (2026-10-07): an upload where every row was held back reads as a
 * failure, and every accepted upload links its batch.
 *
 * What was wrong: app/(app)/import/forms.tsx showed any upload the server
 * accepted in green — "Uploaded — 0 clean · 7 issues" — with no link to the
 * batch, so a Steward could believe the accounts or customers existed when
 * every row had been held back. Driven through the real forms (jsdom) with the
 * two upload actions mocked to the shapes they return.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({ account: vi.fn(), customer: vi.fn() }));
vi.mock('@/services/imports', () => ({
  uploadAccountMasterAction: h.account,
  uploadCustomerMasterAction: h.customer,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import { UploadAccountForm, UploadCustomerForm } from '@/app/(app)/import/forms';

function submit(button: string) {
  fireEvent.submit(screen.getByRole('button', { name: button }).closest('form')!);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('account master upload result', () => {
  it('every row held back: a failure, red, with a link to the batch', async () => {
    h.account.mockResolvedValue({ ok: true, data: { batchId: 'b-acc', clean: 0, issues: 7 } });
    render(<UploadAccountForm />);
    submit('Upload account master');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Nothing was loaded: every row was held back (0 clean · 7 issues)');
    expect(alert.className).toContain('text-red-600');
    expect(alert.className).not.toContain('emerald');
    expect(screen.getByRole('link', { name: 'Open the batch' }).getAttribute('href')).toBe('/import/b-acc');
  });

  it('a file with nothing the import reads is a failure too', async () => {
    h.account.mockResolvedValue({ ok: true, data: { batchId: 'b-empty', clean: 0, issues: 0 } });
    render(<UploadAccountForm />);
    submit('Upload account master');
    expect((await screen.findByRole('alert')).textContent).toContain('Nothing was loaded: the file had no rows this import reads');
  });

  it('some rows held back: a warning, amber, with the link', async () => {
    h.account.mockResolvedValue({ ok: true, data: { batchId: 'b-some', clean: 5, issues: 2 } });
    render(<UploadAccountForm />);
    submit('Upload account master');
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Uploaded — 5 clean · 2 issues. Some rows were held back');
    expect(status.className).toContain('text-amber-700');
    expect(screen.getByRole('link', { name: 'Open the batch' }).getAttribute('href')).toBe('/import/b-some');
  });

  it('everything loaded: green, and the batch is still one click away', async () => {
    h.account.mockResolvedValue({ ok: true, data: { batchId: 'b-all', clean: 5, issues: 0 } });
    render(<UploadAccountForm />);
    submit('Upload account master');
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Uploaded — 5 clean · 0 issues');
    expect(status.className).toContain('text-emerald-700');
    expect(screen.getByRole('link', { name: 'Open the batch' }).getAttribute('href')).toBe('/import/b-all');
  });

  it('a refused upload stays red, with no batch to open', async () => {
    h.account.mockResolvedValue({ ok: false, code: 'VALIDATION_FAILED', message: 'Validation failed', fields: { file: 'Workbook is empty.' } });
    render(<UploadAccountForm />);
    submit('Upload account master');
    expect((await screen.findByRole('alert')).textContent).toBe('Workbook is empty.');
    expect(screen.queryByRole('link', { name: 'Open the batch' })).toBeNull();
  });
});

describe('customer master upload result', () => {
  it('every row quarantined: a failure with the link', async () => {
    h.customer.mockResolvedValue({ ok: true, data: { batchId: 'b-cust', clean: 0, quarantined: 12 } });
    render(<UploadCustomerForm />);
    submit('Upload customer master');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Nothing was loaded: every row was held back (0 clean · 12 quarantined)');
    expect(screen.getByRole('link', { name: 'Open the batch' }).getAttribute('href')).toBe('/import/b-cust');
  });

  it('some rows quarantined: a warning', async () => {
    h.customer.mockResolvedValue({ ok: true, data: { batchId: 'b-c2', clean: 30, quarantined: 2 } });
    render(<UploadCustomerForm />);
    submit('Upload customer master');
    expect((await screen.findByRole('status')).className).toContain('text-amber-700');
  });
});
