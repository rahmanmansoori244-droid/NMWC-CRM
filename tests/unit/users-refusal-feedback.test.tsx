/**
 * Launch fix (2026-10-07): a refusal on /users reads as an error.
 *
 * What was wrong: every refusal from Disable/Enable and Reset password — one's
 * own account, the last active Manager, a reused password, an account outside a
 * Manager's regions — was put in the row's message and rendered in the same
 * green as "Password updated.", so a refused day-one helpdesk reset looked done.
 * The viewer's own row also offered Disable and Reset, which always refuse
 * (lib/permissions.ts canMutateUser).
 *
 * Driven through the real component (jsdom) with the server actions mocked to
 * the shapes runAction returns (lib/errors.ts): a refusal is red, role="alert",
 * and carries the reason; a success stays green; the own row offers the
 * self-service password change instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({ toggle: vi.fn(), reset: vi.fn() }));
vi.mock('@/services/users', () => ({
  toggleUserActiveAction: h.toggle,
  resetPasswordAction: h.reset,
  updateUserEmailAction: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import { UserRowActions, UsersFeedback } from '@/app/(app)/users/UserRowActions';

// The full unit suite runs ~290 files in parallel on Windows; the default 1 s waits
// flaked under that load (2026-10-09). The UI under test is unchanged.
const SLOW = { timeout: 10_000 };
vi.setConfig({ testTimeout: 30_000 });

const PASSWORD = 'A-long-password-1';
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

function resetWith() {
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
  type(screen.getByPlaceholderText('New password (12+ chars)'), PASSWORD);
  type(screen.getByPlaceholderText('Confirm new password'), PASSWORD);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('UserRowActions — refusals read as errors', () => {
  it.each([
    [
      'a reused password (field error)',
      { ok: false, code: 'VALIDATION_FAILED', message: 'Validation failed', fields: { password: 'You used this password recently.' } },
      'You used this password recently.',
    ],
    [
      'an account outside the Manager’s regions (forbidden)',
      { ok: false, code: 'FORBIDDEN', message: 'That account is outside the regions you manage.' },
      'That account is outside the regions you manage.',
    ],
  ])('Reset password refused: %s', async (_name, result, reason) => {
    h.reset.mockResolvedValue(result);
    render(<UserRowActions userId="u-target" username="someone" isActive />);
    resetWith();
    const alert = await screen.findByRole('alert', {}, SLOW);
    expect(alert.textContent).toBe(reason);
    expect(alert.className).toContain('text-red-600');
    expect(alert.className).not.toContain('emerald');
    expect(screen.queryByText('Password updated.')).toBeNull();
  });

  it('Disable refused for the last active Manager: red, with the reason', async () => {
    h.toggle.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { _form: 'Cannot disable the only active Manager. Promote another user to Manager first.' },
    });
    render(<UserRowActions userId="u-mgr" username="the.manager" isActive />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    const alert = await screen.findByRole('alert', {}, SLOW);
    expect(alert.textContent).toBe('Cannot disable the only active Manager. Promote another user to Manager first.');
    expect(alert.className).toContain('text-red-600');
  });

  it('a Disable that works after a refusal clears the red refusal (the row stays on the All tab)', async () => {
    h.toggle.mockResolvedValueOnce({ ok: false, code: 'FORBIDDEN', message: 'That account is outside the regions you manage.' });
    h.toggle.mockResolvedValueOnce({ ok: true, data: undefined });
    render(
      <UsersFeedback>
        <UserRowActions userId="u-target" username="someone" isActive />
      </UsersFeedback>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await screen.findByRole('alert', {}, SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await screen.findByText(/^Disabled "someone"/, {}, SLOW);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('That account is outside the regions you manage.')).toBeNull();
  });

  it('a thrown failure is red too', async () => {
    h.reset.mockRejectedValue(new Error('Network down'));
    render(<UserRowActions userId="u-target" username="someone" isActive />);
    resetWith();
    const alert = await screen.findByRole('alert', {}, SLOW);
    expect(alert.textContent).toBe('Network down');
    expect(alert.className).toContain('text-red-600');
  });

  it('a success stays green and is not an alert', async () => {
    h.reset.mockResolvedValue({ ok: true, data: undefined });
    render(<UserRowActions userId="u-target" username="someone" isActive />);
    resetWith();
    const done = await screen.findByText('Password updated.', {}, SLOW);
    expect(done.className).toContain('text-emerald-600');
    expect(done.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a refusal after a success replaces the green message with a red one', async () => {
    h.reset.mockResolvedValueOnce({ ok: true, data: undefined });
    h.reset.mockResolvedValueOnce({ ok: false, code: 'FORBIDDEN', message: 'Use /profile to change your own account.' });
    render(<UserRowActions userId="u-target" username="someone" isActive />);
    resetWith();
    await screen.findByText('Password updated.', {}, SLOW);
    // The form closes itself after a success; open it again.
    await waitFor(() => expect(screen.queryByPlaceholderText('Confirm new password')).toBeNull(), SLOW);
    resetWith();
    const alert = await screen.findByRole('alert', {}, SLOW);
    expect(alert.textContent).toBe('Use /profile to change your own account.');
    expect(screen.queryByText('Password updated.')).toBeNull();
  });
});

describe('UserRowActions — the viewer’s own row', () => {
  it('offers no Disable and no Reset password, which always refuse; it links the self-service change', () => {
    render(<UserRowActions userId="me" username="me" isActive isSelf />);
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset password' })).toBeNull();
    expect(screen.getByText('Change my password').closest('a')?.getAttribute('href')).toBe('/profile/change-password');
  });

  it('every other row keeps both actions', () => {
    render(<UserRowActions userId="u-target" username="someone" isActive />);
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeTruthy();
    expect(screen.queryByText('Change my password')).toBeNull();
  });
});
