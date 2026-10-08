/**
 * The two places a password is set by hand ask for it twice and can show it.
 *
 * The forced first-sign-in change (ChangePasswordForm) and a Manager's or
 * Steward's Reset password (UserRowActions) each took the new password once,
 * masked. A typo on a phone keyboard was saved as typed: the first locks the
 * user out behind a session the change itself revoked, the second hands a
 * salesman a password nobody knows. Driven through the real forms (jsdom): a
 * mismatch never reaches the server action and says so, a match calls it once
 * with the password typed, and Show switches both new-password boxes between
 * masked and plain text. services/password.ts refuses the same mismatch on its
 * own; password-change-required.test.ts pins that half.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  change: vi.fn(),
  reset: vi.fn(),
  replace: vi.fn(),
  hardReplace: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: h.replace }) }));
vi.mock('@/lib/navigate', () => ({ hardReplace: h.hardReplace }));
vi.mock('@/services/password', () => ({ changeOwnPasswordAction: h.change }));
vi.mock('@/services/users', () => ({
  resetPasswordAction: h.reset,
  toggleUserActiveAction: vi.fn(),
}));

import { ChangePasswordForm } from '@/app/(app)/profile/change-password/ChangePasswordForm';
import { UserRowActions } from '@/app/(app)/users/UserRowActions';

const MISMATCH = 'The two new passwords do not match.';
const TYPED = 'Typed-on-a-phone-1';
const TYPO = 'Typed-on-a-phnoe-1';

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (el: HTMLInputElement, value: string) => fireEvent.change(el, { target: { value } });
const sent = (fn: typeof h.change, field: string) => (fn.mock.calls[0]![0] as FormData).get(field);

beforeEach(() => {
  vi.clearAllMocks();
  h.change.mockResolvedValue({ ok: true, data: { renewed: true } });
  h.reset.mockResolvedValue({ ok: true, data: undefined });
});
afterEach(() => {
  cleanup();
});

describe('ChangePasswordForm — the new password twice', () => {
  function fill(newPassword: string, confirm: string) {
    render(<ChangePasswordForm />);
    type(input('Current password'), 'The-temporary-one-1');
    type(input('New password (min 12 chars)'), newPassword);
    type(input('Confirm new password'), confirm);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  }

  it('a mismatch never calls the action, says so, and keeps what was typed', () => {
    fill(TYPED, TYPO);
    expect(h.change).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(MISMATCH);
    // Refused before React's form action runs, so the fields are not reset:
    // the user can press Show and see which box holds the typo.
    expect(input('Current password').value).toBe('The-temporary-one-1');
    expect(input('New password (min 12 chars)').value).toBe(TYPED);
    expect(input('Confirm new password').value).toBe(TYPO);
  });

  it('a match calls the action once with the new password, and the mismatch message goes', async () => {
    render(<ChangePasswordForm />);
    type(input('Current password'), 'The-temporary-one-1');
    type(input('New password (min 12 chars)'), TYPED);
    type(input('Confirm new password'), TYPO);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByRole('alert').textContent).toBe(MISMATCH);

    type(input('Confirm new password'), TYPED);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(h.change).toHaveBeenCalledTimes(1));
    expect(sent(h.change, 'currentPassword')).toBe('The-temporary-one-1');
    expect(sent(h.change, 'newPassword')).toBe(TYPED);
    expect(sent(h.change, 'confirmNewPassword')).toBe(TYPED);
    await waitFor(() => expect(screen.getByText(/Password changed/)).toBeTruthy());
    expect(screen.queryByText(MISMATCH)).toBeNull();
  });

  it('after the change, a document load of the role home — the session is already renewed, no second sign-in', async () => {
    // services/password.ts renewOwnSession replaced the cookie. It went to
    // /login before, through the router, and the old flagged cookie sent the
    // user's next tap back to the forced page.
    vi.useFakeTimers();
    try {
      render(<ChangePasswordForm />);
      type(input('Current password'), 'The-temporary-one-1');
      type(input('New password (min 12 chars)'), TYPED);
      type(input('Confirm new password'), TYPED);
      fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
      await vi.waitFor(() => expect(screen.getByText(/Password changed/)).toBeTruthy());
      expect(screen.getByText('Password changed. Taking you to your home page…')).toBeTruthy();
      expect(h.hardReplace).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.hardReplace).toHaveBeenCalledTimes(1);
      expect(h.hardReplace).toHaveBeenCalledWith('/');
      expect(h.replace).not.toHaveBeenCalledWith('/login');
    } finally {
      vi.useRealTimers();
    }
  });

  it('when this browser could not be renewed, it says to sign in again and goes to the sign-in page', async () => {
    // The renewal sign-in was refused (a spent login bucket, say) and the action
    // signed this browser out. "Taking you to your home page" then landed on
    // /login with nothing said.
    h.change.mockResolvedValue({ ok: true, data: { renewed: false } });
    vi.useFakeTimers();
    try {
      render(<ChangePasswordForm />);
      type(input('Current password'), 'The-temporary-one-1');
      type(input('New password (min 12 chars)'), TYPED);
      type(input('Confirm new password'), TYPED);
      fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
      await vi.waitFor(() => expect(screen.getByText(/Password changed/)).toBeTruthy());
      expect(screen.getByText(/Please sign in again with your new password/)).toBeTruthy();
      expect(screen.queryByText(/home page/)).toBeNull();
      // Time to read it: not gone at the renewed page's 1.5 s.
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.hardReplace).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2500);
      expect(h.hardReplace).toHaveBeenCalledTimes(1);
      expect(h.hardReplace).toHaveBeenCalledWith('/login');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a refused change stays on the form and goes nowhere', async () => {
    h.change.mockResolvedValue({ ok: false, code: 'VALIDATION_FAILED', message: 'x', fields: { currentPassword: 'Current password incorrect.' } });
    vi.useFakeTimers();
    try {
      render(<ChangePasswordForm />);
      type(input('Current password'), 'wrong');
      type(input('New password (min 12 chars)'), TYPED);
      type(input('Confirm new password'), TYPED);
      fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
      await vi.waitFor(() => expect(screen.getByText('Current password incorrect.')).toBeTruthy());
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.hardReplace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Show switches both new-password boxes between masked and text, and never the current one', () => {
    render(<ChangePasswordForm />);
    const show = screen.getByRole('button', { name: 'Show new password' });
    expect(show.getAttribute('type')).toBe('button');
    expect(show.getAttribute('aria-pressed')).toBe('false');
    expect(input('New password (min 12 chars)').type).toBe('password');
    expect(input('Confirm new password').type).toBe('password');

    fireEvent.click(show);
    expect(show.getAttribute('aria-pressed')).toBe('true');
    expect(input('New password (min 12 chars)').type).toBe('text');
    expect(input('Confirm new password').type).toBe('text');
    expect(input('Current password').type).toBe('password');
    // Shown as text, the keyboard must not "correct" the password as it is typed.
    for (const el of [input('New password (min 12 chars)'), input('Confirm new password')]) {
      expect(el.getAttribute('autocapitalize')).toBe('none');
      expect(el.getAttribute('autocorrect')).toBe('off');
      expect(el.getAttribute('spellcheck')).toBe('false');
      expect(el.getAttribute('autocomplete')).toBe('new-password');
    }

    fireEvent.click(show);
    expect(show.getAttribute('aria-pressed')).toBe('false');
    expect(input('New password (min 12 chars)').type).toBe('password');
    expect(input('Confirm new password').type).toBe('password');
    expect(h.change).not.toHaveBeenCalled();
  });
});

describe('launch browser suite — every change-password error is read out, and tied to its field', () => {
  // Only the mismatch was an alert. "Current password incorrect." and the form's
  // own refusal were plain text: a screen reader said nothing after Change password.
  function submit() {
    render(<ChangePasswordForm />);
    type(input('Current password'), 'wrong');
    type(input('New password (min 12 chars)'), TYPED);
    type(input('Confirm new password'), TYPED);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  }

  it.each([
    ['currentPassword', 'Current password', 'Current password incorrect.'],
    ['newPassword', 'New password (min 12 chars)', 'You cannot reuse one of your last 5 passwords.'],
  ])('a %s refusal is an alert, and its box points at it', async (field, label, message) => {
    h.change.mockResolvedValue({ ok: false, code: 'VALIDATION_FAILED', message: 'x', fields: { [field]: message } });
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(input(label)).toHaveAttribute('aria-invalid', 'true');
    expect(input(label)).toHaveAccessibleDescription(message);
    for (const other of ['Current password', 'New password (min 12 chars)', 'Confirm new password'].filter((l) => l !== label)) {
      expect(input(other), other).not.toHaveAttribute('aria-invalid');
      expect(input(other), other).toHaveAccessibleDescription('');
    }
  });

  it('the mismatch is tied to the confirm box', () => {
    render(<ChangePasswordForm />);
    type(input('Current password'), 'The-temporary-one-1');
    type(input('New password (min 12 chars)'), TYPED);
    type(input('Confirm new password'), TYPO);
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(input('Confirm new password')).toHaveAttribute('aria-invalid', 'true');
    expect(input('Confirm new password')).toHaveAccessibleDescription(MISMATCH);
  });

  it('a refusal of the whole change is an alert', async () => {
    h.change.mockResolvedValue({ ok: false, code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a minute.' });
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe('Too many attempts. Try again in a minute.');
  });

  it('the change itself is said in a status', async () => {
    vi.useFakeTimers();
    try {
      submit();
      await vi.waitFor(() => expect(screen.getByRole('status').textContent).toBe('Password changed. Taking you to your home page…'));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('UserRowActions — Reset password twice', () => {
  const box = (placeholder: string) => screen.getByPlaceholderText(placeholder) as HTMLInputElement;

  function open() {
    render(<UserRowActions userId="u-target" username="someone" isActive />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
  }

  it('launch browser suite follow-up: both boxes are named for the account, as the e-mail box is', () => {
    // They had a placeholder and no name: once typed in, a screen reader read
    // two unnamed password boxes on a row of the users table.
    open();
    expect(screen.getByLabelText('New password for someone')).toBe(box('New password (12+ chars)'));
    expect(screen.getByLabelText('Confirm new password for someone')).toBe(box('Confirm new password'));
  });

  it('a mismatch never calls the action, says so, and keeps what was typed', () => {
    open();
    type(box('New password (12+ chars)'), TYPED);
    type(box('Confirm new password'), TYPO);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(h.reset).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(MISMATCH);
    expect(box('New password (12+ chars)').value).toBe(TYPED);
    expect(box('Confirm new password').value).toBe(TYPO);
  });

  it('a match calls the action once with the password and the row it is for', async () => {
    open();
    type(box('New password (12+ chars)'), TYPED);
    type(box('Confirm new password'), TYPED);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.reset).toHaveBeenCalledTimes(1));
    expect(sent(h.reset, 'password')).toBe(TYPED);
    expect(sent(h.reset, 'userId')).toBe('u-target');
    await waitFor(() => expect(screen.getByText('Password updated.')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Show switches both boxes between masked and text', () => {
    open();
    const show = screen.getByRole('button', { name: 'Show new password' });
    expect(show.getAttribute('type')).toBe('button');
    expect(show.getAttribute('aria-pressed')).toBe('false');
    expect(box('New password (12+ chars)').type).toBe('password');
    expect(box('Confirm new password').type).toBe('password');

    fireEvent.click(show);
    expect(show.getAttribute('aria-pressed')).toBe('true');
    expect(box('New password (12+ chars)').type).toBe('text');
    expect(box('Confirm new password').type).toBe('text');
    for (const el of [box('New password (12+ chars)'), box('Confirm new password')]) {
      expect(el.getAttribute('autocapitalize')).toBe('none');
      expect(el.getAttribute('autocorrect')).toBe('off');
      expect(el.getAttribute('spellcheck')).toBe('false');
      expect(el.getAttribute('autocomplete')).toBe('new-password');
    }

    fireEvent.click(show);
    expect(show.getAttribute('aria-pressed')).toBe('false');
    expect(box('New password (12+ chars)').type).toBe('password');
    expect(h.reset).not.toHaveBeenCalled();
  });

  it('reopened, the box is masked again and the last mismatch is gone', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Show new password' }));
    type(box('New password (12+ chars)'), TYPED);
    type(box('Confirm new password'), TYPO);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe(MISMATCH);

    fireEvent.click(screen.getByRole('button', { name: 'Reset password' })); // close
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' })); // open again
    expect(screen.queryByRole('alert')).toBeNull();
    const show = screen.getByRole('button', { name: 'Show new password' });
    expect(show.getAttribute('aria-pressed')).toBe('false');
    expect(box('New password (12+ chars)').type).toBe('password');
  });
});
