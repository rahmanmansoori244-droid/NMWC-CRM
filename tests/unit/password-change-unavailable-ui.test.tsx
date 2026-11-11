/**
 * Code review 2026-11-10, finding 22, third round: the change-password form, the
 * real server action and the real limiter together, with the limiter's store
 * down.
 *
 * The second round's form test mocked the action to return the new message, and
 * the form has always shown res.message, so it passed on the old code too. Here
 * nothing between the button and the database is a stand-in except the database
 * itself, which cannot be reached: the limiter fails closed (lib/rate-limit.ts
 * checkLimit, `unavailable`), services/password.ts says so as DB_UNAVAILABLE, and
 * the form shows it. On the old code the same click read "Too many attempts".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  /** Database calls other than the limiter's raw statement. */
  calls: [] as string[],
  replace: vi.fn(),
  hardReplace: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: h.replace, refresh: vi.fn() }) }));
vi.mock('@/lib/navigate', () => ({ hardReplace: h.hardReplace }));
vi.mock('@/lib/auth', () => ({ auth: async () => h.session, signIn: h.signIn, signOut: h.signOut }));
vi.mock('next-auth', async () => {
  const errors = await import('@auth/core/errors');
  return { AuthError: errors.AuthError, CredentialsSignin: errors.CredentialsSignin };
});
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  systemAuditEnvelope: (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: async () => {
    h.calls.push('auditLog.create');
  },
}));
// A database that cannot be reached: the limiter's statement throws as a refused
// connection does; anything else that is called is recorded (none should be).
vi.mock('@/lib/db', () => {
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        if (prop === '$queryRaw' || prop === '$executeRaw') {
          return async () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
          };
        }
        return new Proxy(
          {},
          {
            get: (_m, method) => async () => {
              h.calls.push(`${String(prop)}.${String(method)}`);
              return null;
            },
          }
        );
      },
    }
  );
  return { prisma, directPrisma: prisma };
});

import { ChangePasswordForm } from '@/app/(app)/profile/change-password/ChangePasswordForm';
import { PASSWORD_CHANGE_CHECK_UNAVAILABLE } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const SAVED = { backend: process.env.RATE_LIMIT_BACKEND, db: process.env.DATABASE_URL };

beforeEach(() => {
  h.calls = [];
  h.session = { user: { id: 'u-unavailable', role: 'SALESMAN', username: 'c9', mustChangePassword: true } };
  // The durable limiter, as in production: not the in-memory one.
  delete process.env.RATE_LIMIT_BACKEND;
  process.env.DATABASE_URL = 'postgresql://unit:unit@localhost:5432/unit';
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (SAVED.backend === undefined) delete process.env.RATE_LIMIT_BACKEND;
  else process.env.RATE_LIMIT_BACKEND = SAVED.backend;
  if (SAVED.db === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = SAVED.db;
});

describe('the change-password form when the guess limit cannot be checked (real action, real limiter)', () => {
  it('says the password could not be checked, not "Too many attempts", and nothing is read or written', async () => {
    render(<ChangePasswordForm />);
    const type = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    // Words with spaces, on purpose: the repository's secrets scan (gitleaks) reads
    // "password', '<ten or more unbroken characters>'" as a real key and stops CI.
    type('Current password', 'the old one');
    type('New password (min 12 chars)', 'A-new-password-2026');
    type('Confirm new password', 'A-new-password-2026');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(PASSWORD_CHANGE_CHECK_UNAVAILABLE);
    expect(alert.textContent).not.toMatch(/too many/i);
    expect(h.calls).toEqual([]);
    expect(h.signIn).not.toHaveBeenCalled();
    expect(h.hardReplace).not.toHaveBeenCalled();
  });
});
