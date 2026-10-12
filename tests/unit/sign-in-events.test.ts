// @vitest-environment node
/**
 * Gap 23 (data audit 2026-10-10): failed sign-ins on names no account has, and
 * refusals by the sign-in throttles, are kept in AuthEvent — with a keyed
 * fingerprint of the typed name, never the name (lib/sign-in-events.ts), so a
 * password typed into the name field cannot be read back.
 *
 * What this pins:
 *   - the fingerprint: HMAC-SHA256 under an HKDF key from AUTH_SECRET, the
 *     typed name trimmed and lower-cased first, a keyId that changes with the
 *     secret, and the name nowhere in the output;
 *   - the writers (lib/auth-events.ts), on a mocked database: an unknown name is
 *     a LOGIN_FAIL_UNKNOWN row with the fingerprint, retired_username when an
 *     account used to hold the name; a failure on a name another account held
 *     before is LOGIN_FAIL_REUSED_NAME; a throttle refusal is written at most
 *     once per bucket per five minutes; and none of them ever throws;
 *   - lib/auth.ts calls them, and no longer logs or audits a typed name.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  AUTH_EVENT_KINDS,
  FINGERPRINT_LABEL,
  RATE_LIMITED_EVERY_MS,
  fingerprintKey,
  normaliseTypedName,
  usernameFingerprint,
} from '@/lib/sign-in-events';
import { stripComments } from '../support/strip-comments';

const h = vi.hoisted(() => ({
  history: [] as Array<{ userId: string; username: string }>,
  events: [] as Array<Record<string, unknown>>,
  users: new Map<string, string>(),
  txCalls: 0,
  fail: false,
}));

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/db', () => {
  const authEvent = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (h.fail) throw new Error('database down');
      h.events.push(data);
      return data;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      h.events.find(
        (e) =>
          e.kind === where.kind &&
          e.reason === where.reason &&
          ('ip' in where ? e.ip === where.ip : e.usernameHmac === where.usernameHmac)
      ) ?? null,
  };
  const prisma = {
    userHistory: {
      findFirst: async ({ where }: { where: { username: string; userId?: { not: string } } }) =>
        h.history.find((r) => r.username === where.username && (!where.userId || r.userId !== where.userId.not)) ?? null,
    },
    authEvent,
    user: { findUnique: async ({ where }: { where: { username: string } }) => (h.users.has(where.username) ? { id: h.users.get(where.username)! } : null) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      h.txCalls++;
      return fn({ $executeRaw: async () => 0, authEvent, user: prisma.user });
    },
  };
  return { prisma };
});

import {
  __resetRateLimitedMemory,
  recordRateLimited,
  recordReusedNameFailure,
  recordUnknownNameFailure,
} from '@/lib/auth-events';

const SECRET = 'unit-test-secret-not-a-real-one-0123456789abcdef';

beforeEach(() => {
  h.history = [];
  h.events = [];
  h.users = new Map();
  h.txCalls = 0;
  h.fail = false;
  process.env.AUTH_SECRET = SECRET;
  __resetRateLimitedMemory();
});

describe('the fingerprint of a typed name', () => {
  it('is HMAC-SHA256 of the trimmed, lower-cased name under the HKDF key of AUTH_SECRET', () => {
    const k = fingerprintKey(SECRET)!;
    const key = Buffer.from(hkdfSync('sha256', SECRET, Buffer.alloc(0), FINGERPRINT_LABEL, 32));
    expect(k.key.equals(key)).toBe(true);
    expect(k.keyId).toBe(createHash('sha256').update(key).digest('hex').slice(0, 8));
    expect(k.keyId).toMatch(/^[0-9a-f]{8}$/);
    const want = createHmac('sha256', key).update('mct-01').digest('hex');
    expect(usernameFingerprint('  MCT-01 ', k)).toBe(want);
    expect(usernameFingerprint('mct-01', k)).toBe(want);
    expect(normaliseTypedName('  Ab C ')).toBe('ab c');
  });

  it('is not the name, not a bare hash of it, and changes with the secret', () => {
    const k1 = fingerprintKey(SECRET)!;
    const k2 = fingerprintKey(`${SECRET}-rotated`)!;
    const typed = 'MyPassw0rd!';
    const f1 = usernameFingerprint(typed, k1);
    expect(f1).not.toContain(typed.toLowerCase());
    expect(f1).not.toBe(createHash('sha256').update(typed.toLowerCase()).digest('hex'));
    expect(usernameFingerprint(typed, k2)).not.toBe(f1);
    expect(k2.keyId).not.toBe(k1.keyId);
    expect(fingerprintKey('')).toBeNull();
  });

  it('names the four kinds the database accepts', () => {
    expect([...AUTH_EVENT_KINDS].sort()).toEqual(
      ['LOGIN_FAIL_REUSED_NAME', 'LOGIN_FAIL_UNKNOWN', 'LOGIN_RATE_LIMITED', 'SESSION_REVOKE'].sort()
    );
  });
});

describe('the sign-in event writers', () => {
  const seen = { ip: '198.18.0.9', userAgent: 'UnitTest/1.0' };

  it('an unknown name: one LOGIN_FAIL_UNKNOWN row, the fingerprint and never the name', async () => {
    await recordUnknownNameFailure('Nobody.Here', 'not_found', seen);
    expect(h.events).toHaveLength(1);
    const e = h.events[0]!;
    const k = fingerprintKey(SECRET)!;
    expect(e).toMatchObject({
      kind: 'LOGIN_FAIL_UNKNOWN',
      usernameHmac: usernameFingerprint('nobody.here', k),
      keyId: k.keyId,
      reason: 'not_found',
      ip: seen.ip,
      userAgent: seen.userAgent,
      source: 'auth:login-fail',
    });
    expect(JSON.stringify(e).toLowerCase()).not.toContain('nobody.here');
  });

  it('a name an account used to have: retired_username', async () => {
    h.history = [{ userId: 'u-old', username: 'mct-07' }];
    await recordUnknownNameFailure('MCT-07', 'not_found', seen);
    expect(h.events[0]).toMatchObject({ kind: 'LOGIN_FAIL_UNKNOWN', reason: 'retired_username' });
  });

  it('a failure on a name another account held before: LOGIN_FAIL_REUSED_NAME on the holder; none when only he held it', async () => {
    h.history = [{ userId: 'u-new', username: 'mct-07' }];
    await recordReusedNameFailure({ id: 'u-new', username: 'mct-07' }, seen);
    expect(h.events).toEqual([]);
    h.history.push({ userId: 'u-old', username: 'mct-07' });
    await recordReusedNameFailure({ id: 'u-new', username: 'mct-07' }, seen);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ kind: 'LOGIN_FAIL_REUSED_NAME', userId: 'u-new', reason: 'retired_username' });
  });

  it('a throttle refusal: one row per bucket per five minutes, the account named when it exists', async () => {
    h.users.set('mct-01', 'u-1');
    const t0 = new Date('2026-10-12T05:00:00Z');
    await recordRateLimited('user', 'MCT-01', seen, t0);
    await recordRateLimited('user', 'mct-01', seen, new Date(t0.getTime() + 60_000));
    await recordRateLimited('ip', 'mct-01', seen, new Date(t0.getTime() + 60_000));
    expect(h.events.map((e) => [e.kind, e.reason, e.userId ?? null])).toEqual([
      ['LOGIN_RATE_LIMITED', 'user', 'u-1'],
      ['LOGIN_RATE_LIMITED', 'ip', null],
    ]);
    // The repeat inside the window never reached the database.
    expect(h.txCalls).toBe(2);
    // Another instance (memory empty) is stopped by the database's own check.
    __resetRateLimitedMemory();
    await recordRateLimited('user', 'mct-01', seen, new Date(t0.getTime() + 120_000));
    expect(h.events).toHaveLength(2);
    // Another name is another bucket: its own row at once.
    await recordRateLimited('user', 'mct-02', seen, new Date(t0.getTime() + 180_000));
    expect(h.events).toHaveLength(3);
    // The same bucket after the window passes this instance's memory again.
    const before = h.txCalls;
    await recordRateLimited('ip', 'mct-01', seen, new Date(t0.getTime() + 60_000 + RATE_LIMITED_EVERY_MS + 1));
    expect(h.txCalls).toBe(before + 1);
  });

  it('never throws: a database that fails costs the row, never the sign-in', async () => {
    h.fail = true;
    await expect(recordUnknownNameFailure('x', 'not_found', seen)).resolves.toBeUndefined();
    await expect(recordReusedNameFailure({ id: 'u', username: 'x' }, seen)).resolves.toBeUndefined();
    await expect(recordRateLimited('ip', 'x', seen)).resolves.toBeUndefined();
  });
});

describe('lib/auth.ts records them, and keeps no typed name', () => {
  const src = stripComments(readFileSync('lib/auth.ts', 'utf8'), 'auth.ts');

  it('calls each writer on its path', () => {
    expect(src).toMatch(/await recordRateLimited\(bucket, username, await signInSeen\(ip\)\)/);
    expect(src).toMatch(/await recordUnknownNameFailure\(username, 'not_found', seen\)/);
    expect(src).toMatch(/await recordUnknownNameFailure\(username, 'demo_disabled', await signInSeen\(ip\)\)/);
    expect(src).toMatch(/await recordReusedNameFailure\(user, seen\)/);
  });

  it('no sentinel audit id and no typed name in a log line', () => {
    expect(src).not.toContain('unknown:');
    expect(src).not.toMatch(/logger\.\w+\(\s*\{\s*username\b/);
  });
});
