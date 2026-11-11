/**
 * A6: the sign-in page says, in one plain sentence, that the 8-hour limit signed
 * the person out — only when it did (the last sign-in's hint names a moment that
 * has passed), never as an error, and promising nothing about unsent work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ hint: undefined as string | undefined }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'nmwc-signin-ends' && h.hint !== undefined ? { name, value: h.hint } : undefined),
  }),
}));
vi.mock('@/app/actions/auth', () => ({ loginAction: vi.fn() }));

import LoginPage from '@/app/(auth)/login/page';
import { SIGN_IN_ENDS_COOKIE, SIGN_IN_LIMIT_MESSAGE } from '@/lib/sign-in-limit';

const T0 = Date.UTC(2026, 10, 24, 3, 30);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  h.hint = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

async function show() {
  render(await LoginPage());
}

describe('the sign-in page after the 8-hour limit', () => {
  it('the hint cookie is the one lib/sign-in-limit.ts names', () => {
    expect(SIGN_IN_ENDS_COOKIE).toBe('nmwc-signin-ends');
  });

  it('says why, as information, when the last sign-in has reached its limit', async () => {
    h.hint = String(T0 - 1000);
    await show();
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent(SIGN_IN_LIMIT_MESSAGE);
    expect(SIGN_IN_LIMIT_MESSAGE).toBe(
      'You were signed out because a sign-in lasts at most 8 hours. Please sign in again.'
    );
    expect(note.textContent).not.toMatch(/error/i);
    // The form is still there to sign in again.
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says nothing when there is no hint, or the sign-in it names is still good', async () => {
    await show();
    expect(screen.queryByRole('status')).toBeNull();
    document.body.innerHTML = '';
    h.hint = String(T0 + 60_000);
    await show();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
