// @vitest-environment node
/**
 * Code review 2026-11-10, finding 22, on Postgres with real bcrypt and the
 * durable limiter: a password change whose answer was lost.
 *
 *   • the first try commits (new hash, flag cleared, one PasswordHistory row,
 *     one audit row); the retry, which sends the OLD password as "current", is
 *     answered as changed and renews the session — with no second PasswordHistory
 *     row, no second audit row and the hash untouched;
 *   • the form's guesses are limited on the durable backend: five wrong attempts,
 *     then the sixth is refused with the wait, before the password is read.
 *
 *   RUN_PASSWORD_CHANGE_RETRY=1 DATABASE_URL=… DIRECT_URL=… npx vitest run tests/integration/password-change-retry.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { purgeAuditLog } from '../support/audit';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_PASSWORD_CHANGE_RETRY === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string; mustChangePassword: boolean } | null;
let current: MockUser = null;
const signIn = vi.fn(async () => '/');
const signOut = vi.fn(async () => undefined);
vi.mock('@/lib/auth', () => ({
  auth: async () => (current ? { user: current } : null),
  signIn: (...a: unknown[]) => signIn(...(a as [])),
  signOut: (...a: unknown[]) => signOut(...(a as [])),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const sfx = `pcr${Date.now().toString(36)}`;
const INITIAL = 'Initial-pass-1';
const CHOSEN = 'Chosen-password-2026';

describe.skipIf(!ENABLED)('finding 22: a password change whose answer was lost, on Postgres', () => {
  let prisma: typeof import('@/lib/db').prisma;
  let password: typeof import('@/services/password');
  const ids = { lost: '', guess: '' };
  let savedBackend: string | undefined;
  const attempt = (currentPassword: string, newPassword: string) => {
    const fd = new FormData();
    fd.set('currentPassword', currentPassword);
    fd.set('newPassword', newPassword);
    fd.set('confirmNewPassword', newPassword);
    return password.changeOwnPasswordAction(fd);
  };

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    savedBackend = process.env.RATE_LIMIT_BACKEND;
    delete process.env.RATE_LIMIT_BACKEND; // the durable limiter, as in production
    ({ prisma } = await import('@/lib/db'));
    password = await import('@/services/password');
    const hash = await bcrypt.hash(INITIAL, 10);
    const lost = await prisma.user.create({
      data: { username: `lost.${sfx}`, fullName: 'Lost Reply', role: 'SALESMAN', passwordHash: hash, mustChangePassword: true },
    });
    const guess = await prisma.user.create({
      data: { username: `guess.${sfx}`, fullName: 'Guessed', role: 'SUPERVISOR', passwordHash: hash },
    });
    Object.assign(ids, { lost: lost.id, guess: guess.id });
  });

  afterAll(async () => {
    if (savedBackend === undefined) delete process.env.RATE_LIMIT_BACKEND;
    else process.env.RATE_LIMIT_BACKEND = savedBackend;
    if (!prisma) return;
    const all = [ids.lost, ids.guess].filter(Boolean);
    await purgeAuditLog(prisma, { where: { OR: [{ actorId: { in: all } }, { entityId: { in: all } }] } });
    await prisma.passwordHistory.deleteMany({ where: { userId: { in: all } } });
    await prisma.rateLimit.deleteMany({ where: { key: { in: all.map((id) => `pwchange:user:${id}`) } } });
    await prisma.rateLimit.deleteMany({ where: { key: { contains: sfx } } });
    await prisma.user.deleteMany({ where: { id: { in: all } } });
    await prisma.$disconnect();
  });

  it('the first try commits; the retry with the old password is answered as changed and writes nothing again', async () => {
    current = { id: ids.lost, role: 'SALESMAN', username: `lost.${sfx}`, mustChangePassword: true };
    expect(await attempt(INITIAL, CHOSEN)).toEqual({ ok: true, data: { renewed: true } });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: ids.lost } });
    expect(after.mustChangePassword).toBe(false);
    expect(await bcrypt.compare(CHOSEN, after.passwordHash)).toBe(true);
    const history = await prisma.passwordHistory.count({ where: { userId: ids.lost } });
    const audits = await prisma.auditLog.count({ where: { entityId: ids.lost, reason: 'self_password_change' } });
    expect([history, audits]).toEqual([1, 1]);

    // The answer never reached the phone: it still holds the old, flagged cookie.
    signIn.mockClear();
    expect(await attempt(INITIAL, CHOSEN)).toEqual({ ok: true, data: { renewed: true } });
    expect(signIn).toHaveBeenCalledWith('credentials', expect.objectContaining({ password: CHOSEN, redirect: false }));
    const again = await prisma.user.findUniqueOrThrow({ where: { id: ids.lost } });
    expect(again.passwordHash).toBe(after.passwordHash);
    expect(again.sessionsRevokedAt?.getTime()).toBe(after.sessionsRevokedAt?.getTime());
    expect(await prisma.passwordHistory.count({ where: { userId: ids.lost } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: ids.lost, reason: 'self_password_change' } })).toBe(1);
  });

  it('a wrong old password with a wrong new one is still refused', async () => {
    current = { id: ids.lost, role: 'SALESMAN', username: `lost.${sfx}`, mustChangePassword: false };
    expect(await attempt('Not-the-password-1', 'Another-password-2026')).toMatchObject({
      ok: false,
      fields: { currentPassword: 'Current password incorrect.' },
    });
  });

  it('on the durable limiter: five wrong attempts, then the sixth is refused with the wait, even with the right password', async () => {
    current = { id: ids.guess, role: 'SUPERVISOR', username: `guess.${sfx}`, mustChangePassword: false };
    for (let i = 0; i < 5; i += 1) {
      expect(await attempt(`Wrong-guess-${i}-x`, `Next-guess-${i}-yyyy`)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    }
    const refused = await attempt(INITIAL, CHOSEN);
    expect(refused).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    if (!refused.ok) expect(refused.message).toMatch(/^Too many attempts\. Try again in \d+s\.$/);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: ids.guess } });
    expect(await bcrypt.compare(INITIAL, row.passwordHash)).toBe(true);
  });
});
