// @vitest-environment node
/**
 * Gap 23 (data audit 2026-10-10), on Postgres: sign-in events AuditLog cannot
 * hold, kept for ever in AuthEvent.
 *
 *   - every session cut-off is written by the database, with the cause its
 *     writer named and what moved with it: a disable and a password reset by an
 *     administrator (the real services), a role change, a sign-out and an
 *     account-import row (their writers' change contexts), and one with no
 *     context at all (source 'sql');
 *   - a failed sign-in with a name no account has, a refusal by a throttle and a
 *     failure on a retired route sign-in name each leave one row — with the
 *     name's keyed fingerprint, never the name;
 *   - a throttle refusal is kept once per bucket per five minutes, across
 *     instances;
 *   - the rows cannot be changed or deleted.
 *
 *   RUN_ACCOUNTABILITY=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/auth-events.test.ts
 *
 * Synthetic rows only, removed again in the owner's maintenance window.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { src, withChangeContext } from '@/lib/change-context';
import { fingerprintKey, usernameFingerprint } from '@/lib/sign-in-events';
import { purgeAuthEvents } from '../support/audit';
import { assertNotProductionEnv, buildWorld, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
const ENABLED = process.env.RUN_ACCOUNTABILITY === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('gap 23: sign-in events and session cut-offs', () => {
  let prisma: PrismaClient;
  let users: typeof import('@/services/users');
  let events: typeof import('@/lib/auth-events');
  let w: World;
  /** Typed names this suite tried that no account holds: their rows are purged by fingerprint. */
  const typed: string[] = [];

  const revokes = (userId: string) =>
    prisma.authEvent.findMany({ where: { kind: 'SESSION_REVOKE', userId }, orderBy: { id: 'asc' } });
  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };

  beforeAll(async () => {
    assertNotProductionEnv();
    if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) throw new Error('AUTH_SECRET is needed for the fingerprint');
    ({ prisma } = await import('@/lib/db'));
    users = await import('@/services/users');
    events = await import('@/lib/auth-events');
    w = await buildWorld(prisma, 'authev');
  });

  afterAll(async () => {
    if (!prisma) return;
    const k = fingerprintKey();
    if (k && typed.length) {
      await purgeAuthEvents(prisma, { where: { usernameHmac: { in: typed.map((t) => usernameFingerprint(t, k)) } } });
    }
    if (w) await tearDownWorld(prisma, w);
    await prisma.$disconnect();
  });

  it('a disable by the Steward: one cut-off, under users:toggle, by him, "deactivated"', async () => {
    current = { id: w.steward, role: 'STEWARD', username: w.steward };
    const res = await users.toggleUserActiveAction(fd({ userId: w.sup }));
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    const rows = await revokes(w.sup);
    expect(rows.map((r) => [r.source, r.actorId, r.reason])).toEqual([[`users:toggle:${w.sup}`, w.steward, 'deactivated']]);
    expect(rows[0]!.txId).not.toBeNull();
    // The audit row of the same change shares its transaction: ip and device are there.
    const audit = await prisma.auditLog.findFirst({ where: { txId: rows[0]!.txId!, entityId: w.sup } });
    expect(audit).not.toBeNull();
  });

  it('a password reset by the Steward: one cut-off under users:reset, "password"', async () => {
    current = { id: w.steward, role: 'STEWARD', username: w.steward };
    const res = await users.resetPasswordAction(fd({ userId: w.salesman, password: `Zz-${w.sfx}-Reset-2026!` }));
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    const rows = await revokes(w.salesman);
    expect(rows.map((r) => [r.source, r.actorId])).toEqual([[`users:reset:${w.salesman}`, w.steward]]);
    expect(rows[0]!.reason).toContain('password');
  });

  it('a role change, a sign-out and an account-import row: each recorded under its writer’s cause', async () => {
    await withChangeContext(prisma, { actorId: w.steward, source: src.users('role', w.manager) }, (tx) =>
      tx.user.update({ where: { id: w.manager }, data: { role: 'SUPERVISOR', sessionsRevokedAt: new Date() } })
    );
    await withChangeContext(prisma, { actorId: w.manager, source: src.auth('logout') }, (tx) =>
      tx.user.update({ where: { id: w.manager }, data: { sessionsRevokedAt: new Date() } })
    );
    await withChangeContext(prisma, { actorId: w.steward, source: src.importAccount('zz-batch', 'Users', 14) }, (tx) =>
      tx.user.update({ where: { id: w.manager }, data: { role: 'MANAGER', sessionsRevokedAt: new Date() } })
    );
    const rows = await revokes(w.manager);
    expect(rows.map((r) => [r.source, r.actorId, r.reason])).toEqual([
      [`users:role:${w.manager}`, w.steward, 'role'],
      ['auth:logout', w.manager, null],
      ['import:zz-batch:Users!14', w.steward, 'role'],
    ]);
  });

  it('a cut-off with no context is still recorded, as sql; a write that does not move it records nothing', async () => {
    await prisma.user.update({ where: { id: w.steward }, data: { sessionsRevokedAt: new Date() } });
    await withChangeContext(prisma, { actorId: null, source: src.test('auth-events') }, (tx) =>
      tx.user.update({ where: { id: w.steward }, data: { fullName: 'ZZ Steward renamed' } })
    );
    const rows = await revokes(w.steward);
    expect(rows.map((r) => [r.source, r.actorId])).toEqual([['sql', null]]);
  });

  it('a name no account has: one LOGIN_FAIL_UNKNOWN row with its fingerprint, never the name', async () => {
    const name = `${w.sfx}.nobody`;
    typed.push(name);
    await events.recordUnknownNameFailure(name, 'not_found', { ip: '198.18.7.7', userAgent: 'IntegrationTest' });
    const k = fingerprintKey()!;
    const rows = await prisma.authEvent.findMany({ where: { usernameHmac: usernameFingerprint(name, k) } });
    expect(rows.map((r) => [r.kind, r.reason, r.keyId, r.ip, r.source])).toEqual([
      ['LOGIN_FAIL_UNKNOWN', 'not_found', k.keyId, '198.18.7.7', 'auth:login-fail'],
    ]);
    expect(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(name);
  });

  it('a retired route sign-in name: retired_username, on the unknown name and on its new holder', async () => {
    const old = `${w.sfx}.route9`;
    typed.push(old);
    // The salesman held the name, then was renamed; a new account takes it.
    await withChangeContext(prisma, { actorId: w.steward, source: src.users('account', w.salesman) }, async (tx) => {
      await tx.user.update({ where: { id: w.salesman }, data: { username: old } });
      await tx.user.update({ where: { id: w.salesman }, data: { username: `${w.sfx}.s2` } });
    });
    await events.recordUnknownNameFailure(old, 'not_found', { ip: null, userAgent: null });
    const k = fingerprintKey()!;
    expect((await prisma.authEvent.findMany({ where: { usernameHmac: usernameFingerprint(old, k) } })).map((r) => r.reason)).toEqual([
      'retired_username',
    ]);
    const holder = await withChangeContext(prisma, { actorId: w.steward, source: src.users('create', 'new') }, (tx) =>
      tx.user.create({ data: { username: old, fullName: 'ZZ Successor', role: 'SALESMAN', passwordHash: 'x' } })
    );
    w.users.push(holder.id);
    await events.recordReusedNameFailure({ id: holder.id, username: old }, { ip: null, userAgent: null });
    expect((await prisma.authEvent.findMany({ where: { userId: holder.id } })).map((r) => [r.kind, r.reason])).toEqual([
      ['LOGIN_FAIL_REUSED_NAME', 'retired_username'],
    ]);
  });

  it('a throttle refusal is kept once per bucket in five minutes, even from another instance', async () => {
    const name = `${w.sfx}.locked`;
    typed.push(name);
    const seen = { ip: '198.18.7.8', userAgent: 'IntegrationTest' };
    await events.recordRateLimited('user', name, seen);
    events.__resetRateLimitedMemory(); // as a second server instance would be
    await events.recordRateLimited('user', name, seen);
    const k = fingerprintKey()!;
    const rows = await prisma.authEvent.findMany({ where: { kind: 'LOGIN_RATE_LIMITED', usernameHmac: usernameFingerprint(name, k) } });
    expect(rows.map((r) => [r.reason, r.source])).toEqual([['user', 'auth:rate-limited']]);
  });

  it('the rows cannot be changed or deleted outside the owner’s maintenance window', async () => {
    const one = await prisma.authEvent.findFirstOrThrow({ where: { userId: w.sup } });
    await expect(prisma.authEvent.update({ where: { id: one.id }, data: { reason: 'tampered' } })).rejects.toThrow(/append-only|permission denied/i);
    await expect(prisma.authEvent.delete({ where: { id: one.id } })).rejects.toThrow(/append-only|permission denied/i);
  });
});
