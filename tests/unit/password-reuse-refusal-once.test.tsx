/**
 * Launch browser suite (2026-10-07): a reset refused for a reused password said
 * so twice on /users — "You cannot reuse one of your last 5 passwords. You
 * cannot reuse one of your last 5 passwords."
 *
 * What was wrong: lib/password-policy.ts assertPasswordNotReused names the
 * sentence on `password` (the admin reset's box) and on `newPassword` (the
 * change-password form's), so each form can show it beside its own field; and
 * UserRowActions joined every field's words, so it got the sentence once per key.
 *
 * Driven end to end in jsdom: the REAL assertPasswordNotReused (database and
 * bcrypt mocked) refuses, runAction turns that into what the server action
 * returns, and the real forms show it — the /users row once, the change-password
 * form once, beside the new password.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({
  compare: vi.fn(),
  history: vi.fn(),
  reset: vi.fn(),
  change: vi.fn(),
}));
vi.mock('bcryptjs', () => ({ default: { compare: h.compare } }));
vi.mock('@/lib/db', () => ({ prisma: { passwordHistory: { findMany: h.history } } }));
vi.mock('@/services/users', () => ({
  resetPasswordAction: h.reset,
  toggleUserActiveAction: vi.fn(),
  updateUserEmailAction: vi.fn(),
}));
vi.mock('@/services/password', () => ({ changeOwnPasswordAction: h.change }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/navigate', () => ({ hardReplace: vi.fn() }));

import { assertPasswordNotReused } from '@/lib/password-policy';
import { runAction } from '@/lib/errors';
import { UserRowActions } from '@/app/(app)/users/UserRowActions';
import { ChangePasswordForm } from '@/app/(app)/profile/change-password/ChangePasswordForm';

const SENTENCE = 'You cannot reuse one of your last 5 passwords.';
const PASSWORD = 'His-current-password-1';
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

/** What the server action returns when the policy refuses `which` hash. */
async function refusal(which: 'current' | 'history') {
  h.compare.mockImplementation(async (_plain: string, hash: string) => hash === which);
  h.history.mockResolvedValue([{ hash: 'older' }, { hash: 'history' }]);
  const res = await runAction(() => assertPasswordNotReused('u-target', 'current', PASSWORD));
  expect(res.ok).toBe(false);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe('a reused password is refused in one sentence', () => {
  it.each(['current', 'history'] as const)(
    'Reset password on /users (the %s password): the refusal reads once',
    async (which) => {
      h.reset.mockResolvedValue(await refusal(which));
      render(<UserRowActions userId="u-target" username="someone" isActive />);
      fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
      type(screen.getByPlaceholderText('New password (12+ chars)'), PASSWORD);
      type(screen.getByPlaceholderText('Confirm new password'), PASSWORD);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(SENTENCE);
      expect(alert.className).toContain('text-red-600');
    }
  );

  it('the change-password form shows it once, under the new password and nowhere else', async () => {
    h.change.mockResolvedValue(await refusal('history'));
    render(<ChangePasswordForm />);
    type(screen.getByLabelText('Current password'), 'The-temporary-one-1');
    type(screen.getByLabelText('New password (min 12 chars)'), PASSWORD);
    type(screen.getByLabelText('Confirm new password'), PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    const shown = await screen.findAllByText(SENTENCE);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.textContent).toBe(SENTENCE);
    // Beside the New password box: the error under its own field.
    expect(shown[0]!.parentElement?.querySelector('input[name="newPassword"]')).not.toBeNull();
  });
});
