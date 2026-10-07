/**
 * Launch fix: a client component is rendered twice, on the server (Vercel: UTC,
 * Node's default locale) and again in the browser (a phone in Oman, in the
 * user's own locale). When the two print different text, React reports a
 * hydration error (#418 in production) and throws the server HTML away.
 *
 * Each test here does both renders for real: renderToString with the process in
 * UTC, then hydrateRoot with the process switched to Asia/Muscat (and, for
 * numbers, a browser whose default locale is Arabic, Oman), and fails on any
 * recoverable error React reports.
 *   - /notifications printed createdAt with toLocaleString('en-GB') and no time
 *     zone: "07 Oct, 21:30" on the server, "08 Oct, 01:30" on the phone.
 *   - The Promote button printed counts with toLocaleString() and no locale:
 *     "1,234" on the server, "١٬٢٣٤" in an ar-OM browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/services/notifications-actions', () => ({
  markNotificationReadAction: vi.fn(),
  markAllNotificationsReadAction: vi.fn(),
  markInformationReadAction: vi.fn(),
}));
vi.mock('@/services/imports', () => ({ promoteCustomerBatchAction: vi.fn() }));

import { NotificationRow } from '@/app/(app)/notifications/NotificationList';
import { PromoteButton } from '@/app/(app)/import/[batchId]/PromoteButton';

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Server render in UTC, then hydrate as the phone; the recoverable errors React reported. */
async function serverThenPhone(el: ReactElement, phone: () => void): Promise<{ html: string; errors: unknown[]; text: string }> {
  vi.stubEnv('TZ', 'UTC');
  expect(new Date('2026-10-07T21:30:00.000Z').getHours()).toBe(21); // the server really is in UTC
  const html = renderToString(el);
  phone();
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  const errors: unknown[] = [];
  // React also logs the mismatch; keep the output clean, the errors array is the assertion.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await act(async () => {
    root = hydrateRoot(container, el, { onRecoverableError: (e) => errors.push(e) });
  });
  return { html, errors, text: container.textContent ?? '' };
}

const inOman = () => vi.stubEnv('TZ', 'Asia/Muscat');

describe('/notifications — the time on a row', () => {
  it('is the same Oman time on the server and on the phone: no hydration error', async () => {
    const { html, errors, text } = await serverThenPhone(
      <NotificationRow
        id="n1"
        title="Review: Muscat Pearl"
        body="Salesman One sent an update."
        kind="EDIT_SUBMITTED"
        createdAt="2026-10-07T21:30:00.000Z"
        unread
      />,
      inOman
    );
    expect(errors).toEqual([]);
    expect(html).toContain('08 Oct, 01:30');
    expect(text).toContain('08 Oct, 01:30');
  });
});

describe('/import/<batch> — the Promote button', () => {
  it('prints counts the same way in an Arabic-locale browser: no hydration error, Western digits', async () => {
    const { errors, text } = await serverThenPhone(<PromoteButton batchId="b1" remainingCount={12345} />, () => {
      inOman();
      // A browser whose default locale is ar-OM: a call with no locale formats in Arabic.
      const real = Number.prototype.toLocaleString;
      vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (
        this: number,
        locales?: Intl.LocalesArgument,
        options?: Intl.NumberFormatOptions
      ) {
        return real.call(this, locales ?? 'ar-OM', options);
      });
      expect((1234).toLocaleString()).not.toBe('1,234'); // the stand-in really is Arabic
    });
    expect(errors).toEqual([]);
    expect(text).toContain('Promote 12,345 clean rows');
  });

  it('prints the resume count the same way in a German-locale browser', async () => {
    const { errors, text } = await serverThenPhone(
      <PromoteButton batchId="b1" remainingCount={2500} resume />,
      () => {
        const real = Number.prototype.toLocaleString;
        vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (
          this: number,
          locales?: Intl.LocalesArgument,
          options?: Intl.NumberFormatOptions
        ) {
          return real.call(this, locales ?? 'de-DE', options);
        });
      }
    );
    expect(errors).toEqual([]);
    expect(text).toContain('Resume promote (2,500 rows left)');
  });
});
