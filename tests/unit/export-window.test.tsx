/**
 * The /export page's field-update report opens on "the last 7 days". Those are
 * Oman days, as the report reads them (app/api/exports/changes/route.ts): the
 * window was built from the UTC date, so between 00:00 and 03:59 Oman "Changes
 * until" was yesterday and a download missed the night's approvals.
 *
 * The process runs in UTC, as on Vercel; 21:30 UTC on 7 October is 01:30 on the
 * 8th in Oman.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExportFiltersForm } from '@/app/(app)/export/ExportFiltersForm';

beforeEach(() => {
  vi.stubEnv('TZ', 'UTC');
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('/export default field-update window', () => {
  it('ends on the Oman day and starts 7 Oman days before it', async () => {
    vi.setSystemTime(new Date('2026-10-07T21:30:00.000Z'));
    render(<ExportFiltersForm regions={[]} routes={[]} />);
    expect((screen.getByLabelText('Changes until') as HTMLInputElement).value).toBe('2026-10-08');
    expect((screen.getByLabelText('Changes from') as HTMLInputElement).value).toBe('2026-10-01');
    // And the download asks for exactly that window. The download is fetched in
    // the browser (so a refusal stays on the page), so read the URL it fetches.
    const fetchSpy = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchSpy);
    fireEvent.click(screen.getByRole('button', { name: 'Download field-update report' }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const href = String((fetchSpy.mock.calls[0] as unknown[])[0]);
    const sp = new URL(href, 'https://nmwc.example').searchParams;
    expect([sp.get('since'), sp.get('until')]).toEqual(['2026-10-01', '2026-10-08']);
    vi.unstubAllGlobals();
  });

  it('is unchanged in the Oman afternoon, when both calendars agree', () => {
    vi.setSystemTime(new Date('2026-10-07T10:00:00.000Z'));
    render(<ExportFiltersForm regions={[]} routes={[]} />);
    expect((screen.getByLabelText('Changes until') as HTMLInputElement).value).toBe('2026-10-07');
    expect((screen.getByLabelText('Changes from') as HTMLInputElement).value).toBe('2026-09-30');
  });
});
