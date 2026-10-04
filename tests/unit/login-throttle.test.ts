// @vitest-environment node
/**
 * F22 — a form login is charged ONCE against each login rate-limit bucket, and a
 * throttled attempt is told it was throttled.
 *
 * What was wrong: loginAction debited `login:user:<name>` and `login:ip:<ip>`,
 * then called signIn(), whose authorize() debited the same two keys again. With
 * a capacity of 5 that halved the burst: a user who mistyped twice was told
 * "Invalid username or password" for the CORRECT password on the third try, and
 * the fourth office colleague behind one IP got the same. authorize() refused by
 * returning null, which reads to the form exactly like a wrong password.
 *
 * What changed: only authorize() charges the buckets (it is the one step the
 * public /api/auth/callback/credentials route shares with the form), and it
 * throws a CredentialsSignin subclass whose code names the bucket. The form maps
 * that code to the "locked" / "too many attempts" message (AUTH-19).
 *
 * X-AUTH-2 — the per-network bucket counts failed sign-ins only. It used to be
 * charged on every attempt, second, after the per-user bucket: an office behind
 * one address, where everyone signs in and again after the forced password
 * change, ran it dry on successes alone, and an attempt it refused had already
 * cost some account's per-user bucket a token. Now authorize() charges the
 * network bucket FIRST and refunds it when the sign-in succeeds; the per-user
 * bucket is charged on every attempt, as before.
 *
 * The sign-in runs through the REAL Auth.js core — @auth/core's Auth(), with the
 * provider, callbacks and config lib/auth.ts builds — so the claim that a thrown
 * CredentialsSignin reaches loginAction with its code intact is Auth.js's own
 * behaviour here, not a mock's. Only next-auth's thin Next.js wrapper is
 * replaced: its entry imports `next/server` in a form vitest's node resolver
 * refuses, so its signIn() is reproduced below from next-auth/lib/actions.js. The
 * limiter is the real one, on its in-memory backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';

type StoredUser = {
  id: string;
  username: string;
  passwordHash: string;
  isActive: boolean;
  mustChangePassword: boolean;
  fullName: string;
  email: string | null;
  role: string;
};

const h = vi.hoisted(() => ({
  config: null as null | Record<string, unknown>,
  ip: '10.0.0.1',
  users: new Map<string, StoredUser>(),
  lookups: [] as string[],
  pgDown: false,
  /** The durable limiter's refund statement fails (X-AUTH-2: it must not fail the sign-in). */
  refundDown: false,
  /** A throw-away signing secret for the JWT Auth.js issues on success, made at run time. */
  secret: `${globalThis.crypto.randomUUID()}${globalThis.crypto.randomUUID()}`,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': h.ip }),
  cookies: async () => ({ set: () => {}, get: () => undefined }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;`, url });
  },
}));
vi.mock('next-auth', async () => {
  const errors = await import('@auth/core/errors');
  const core = await import('@auth/core');
  return {
    AuthError: errors.AuthError,
    CredentialsSignin: errors.CredentialsSignin,
    default: (config: Record<string, unknown>) => {
      h.config = {
        ...config,
        secret: h.secret,
        basePath: '/api/auth',
        trustHost: true,
        // Auth.js logs every refused sign-in with a stack; the assertions say what matters.
        logger: { error: () => {}, warn: () => {}, debug: () => {} },
      };
      /** next-auth/lib/actions.js signIn(), credentials branch: POST the callback in raw mode. */
      const signIn = async (provider: string, options: Record<string, unknown>) => {
        const { redirect: _redirect, redirectTo, ...rest } = options;
        void _redirect;
        const req = new Request(`http://localhost:3000/api/auth/callback/${provider}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': h.ip },
          body: new URLSearchParams({ ...(rest as Record<string, string>), callbackUrl: String(redirectTo ?? '/') }),
        });
        const res = await core.Auth(req, { ...h.config, raw: core.raw, skipCSRFCheck: core.skipCSRFCheck } as never);
        return (res as { redirect?: string }).redirect;
      };
      return { handlers: {}, auth: async () => null, signIn, signOut: async () => {} };
    },
  };
});
vi.mock('bcryptjs', () => {
  const compare = async (plain: string, hash: string) => hash === `hash:${plain}`;
  const hash = async (plain: string) => `hash:${plain}`;
  return { default: { compare, hash }, compare, hash };
});
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: async () => {},
}));
vi.mock('@/lib/db', () => {
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { username?: string; id?: string } }) => {
        h.lookups.push(where.username ?? where.id ?? '');
        const u = where.username ? h.users.get(where.username) : undefined;
        return u ?? null;
      },
      update: async () => ({}),
    },
    // The durable limiter's statement: only reached when the backend is not memory.
    $queryRaw: async () => {
      if (h.pgDown) throw new Error('connect ECONNREFUSED');
      return [{ tokens: 4, granted: true }];
    },
    // ...and its refund (X-AUTH-2).
    $executeRaw: async () => {
      if (h.refundDown) throw new Error('connect ECONNREFUSED');
      return 1;
    },
  };
  return { prisma, directPrisma: prisma };
});
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/rate-limit')>();
  return { ...real, checkLimit: vi.fn(real.checkLimit), refundLimit: vi.fn(real.refundLimit) };
});

import { checkLimit, LOGIN_LIMIT, refundLimit } from '@/lib/rate-limit';
import { loginAction } from '@/app/actions/auth';
import { LoginThrottledError, loginFailureMessage } from '@/lib/login-throttle';
import { AuthError, CredentialsSignin } from '@auth/core/errors';

const SAVED = { backend: process.env.RATE_LIMIT_BACKEND, db: process.env.DATABASE_URL };
afterAll(() => {
  if (SAVED.backend === undefined) delete process.env.RATE_LIMIT_BACKEND;
  else process.env.RATE_LIMIT_BACKEND = SAVED.backend;
  if (SAVED.db === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = SAVED.db;
});

const INVALID = 'Invalid username or password.';
const LOCKED = 'Account temporarily locked due to repeated attempts. Try again in a minute.';
const NETWORK = /^Too many attempts from your network\. Try again in (\d+)s\.$/;

let n = 0;
/** A fresh account and a fresh network per test: the in-memory buckets outlive a test. */
function freshUser(password = 'Correct-horse-1') {
  n += 1;
  const username = `user${n}.${Date.now().toString(36)}`;
  h.users.set(username, {
    id: `id-${username}`,
    username,
    passwordHash: `hash:${password}`,
    isActive: true,
    mustChangePassword: false,
    fullName: 'Test User',
    email: null,
    role: 'SALESMAN',
  });
  h.ip = `10.${n % 250}.${Math.floor(n / 250)}.${(Date.now() % 250) + 1}`;
  return { username, password };
}

async function login(username: string, password: string): Promise<string> {
  const fd = new FormData();
  fd.set('username', username);
  fd.set('password', password);
  try {
    const res = await loginAction(fd);
    return res ? res.error : 'returned without redirect';
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (url) return `redirect:${url}`;
    throw e;
  }
}

/** A different network per attempt — an attacker rotating addresses, or a phone changing networks. */
let net = 0;
function anotherNetwork() {
  net += 1;
  h.ip = `172.16.${net % 250}.${(Math.floor(net / 250) % 250) + 1}`;
}

beforeEach(() => {
  process.env.RATE_LIMIT_BACKEND = 'memory';
  h.pgDown = false;
  h.refundDown = false;
  h.lookups = [];
  vi.mocked(checkLimit).mockClear();
  vi.mocked(refundLimit).mockClear();
});

describe('a form login charges each login bucket exactly once', () => {
  it('one sign-in = one debit of login:ip:<ip>, then one of login:user:<name>, and the ip one comes back', async () => {
    const { username, password } = freshUser();
    expect(await login(username, password)).toBe('redirect:/home');
    expect(vi.mocked(checkLimit).mock.calls).toEqual([
      [`login:ip:${h.ip}`, LOGIN_LIMIT],
      [`login:user:${username}`, LOGIN_LIMIT],
    ]);
    // X-AUTH-2: the sign-in succeeded, so its network token is refunded.
    expect(vi.mocked(refundLimit).mock.calls).toEqual([[`login:ip:${h.ip}`, LOGIN_LIMIT]]);
  });

  it('two typos and then the right password signs in (it was told "Invalid" on the third try)', async () => {
    const { username, password } = freshUser();
    expect(await login(username, 'typo-1')).toBe(INVALID);
    expect(await login(username, 'typo-2')).toBe(INVALID);
    expect(await login(username, password)).toBe('redirect:/home');
  });

  it('five quick sign-ins by five colleagues behind one office IP all succeed', async () => {
    const office = freshUser();
    const ip = h.ip;
    const colleagues = [office, ...Array.from({ length: 4 }, () => freshUser())];
    for (const c of colleagues) {
      h.ip = ip;
      expect(await login(c.username, c.password)).toBe('redirect:/home');
    }
  });

  it('X-AUTH-2: sixty colleagues behind one office IP each sign in twice, and nobody is throttled', async () => {
    // Twice: the first sign-in, and the one after the forced password change.
    // Before, the sixth success from the address ran the bucket dry.
    const office = Array.from({ length: 60 }, () => freshUser());
    const ip = h.ip;
    for (const round of [1, 2]) {
      for (const c of office) {
        h.ip = ip;
        expect(await login(c.username, c.password), `round ${round}`).toBe('redirect:/home');
      }
    }
  });
});

describe('a throttled attempt is told so, not "Invalid username or password"', () => {
  it('the sixth rapid attempt on one account says the account is locked — even with the right password', async () => {
    // From a different network each time, so the per-user bucket is the one that
    // runs dry: it is the brute-force control however many addresses are used.
    const { username, password } = freshUser();
    for (let i = 0; i < 5; i += 1) {
      anotherNetwork();
      expect(await login(username, `typo-${i}`)).toBe(INVALID);
    }
    anotherNetwork();
    h.lookups = [];
    expect(await login(username, password)).toBe(LOCKED);
    // Refused before the account is even looked up (the buckets come first).
    expect(h.lookups).not.toContain(username);
  });

  it('the sixth FAILED sign-in from one network says "too many attempts from your network", with the wait', async () => {
    // X-AUTH-2: five wrong passwords on five accounts spend the network's five
    // tokens; the sixth person is refused even with the right password.
    const first = freshUser();
    const ip = h.ip;
    const others = [first, ...Array.from({ length: 5 }, () => freshUser())];
    const answers: string[] = [];
    for (const [i, c] of others.entries()) {
      h.ip = ip;
      answers.push(await login(c.username, i < 5 ? `typo-${i}` : c.password));
    }
    expect(answers.slice(0, 5)).toEqual(Array(5).fill(INVALID));
    const wait = Number(answers[5]!.match(NETWORK)?.[1]);
    // One token refills in 60/5 = 12 s.
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(12);
  });

  it('a lone user who mistypes five times from one network is told about the network: it is checked first', async () => {
    const { username, password } = freshUser();
    for (let i = 0; i < 5; i += 1) expect(await login(username, `typo-${i}`)).toBe(INVALID);
    expect(await login(username, password)).toMatch(NETWORK);
  });

  it('an unreachable limiter still fails closed, now with the throttle message', async () => {
    const { username, password } = freshUser();
    delete process.env.RATE_LIMIT_BACKEND;
    process.env.DATABASE_URL = 'postgresql://unit:unit@localhost:5432/unit';
    h.pgDown = true;
    // The network bucket is consulted first (X-AUTH-2), and checkLimit's
    // fail-closed answer for a login: key waits 30 s.
    expect(await login(username, password)).toBe('Too many attempts from your network. Try again in 30s.');
    expect(h.lookups).not.toContain(username);
    process.env.RATE_LIMIT_BACKEND = 'memory';
  });
});

describe('the direct Auth.js callback route, which skips the form', () => {
  /** A POST straight to /api/auth/callback/credentials, as a script would send it. */
  async function callback(username: string, password: string): Promise<URL> {
    const core = await import('@auth/core');
    const res = (await core.Auth(
      new Request('http://localhost:3000/api/auth/callback/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': h.ip },
        body: new URLSearchParams({ username, password, callbackUrl: '/' }),
      }),
      { ...h.config, skipCSRFCheck: core.skipCSRFCheck } as never
    )) as Response;
    return new URL(res.headers.get('location') ?? 'http://none/');
  }

  it('is throttled by the same buckets, and the code is the same for a real and a made-up username', async () => {
    // A different network per attempt, so the per-user bucket is the one that
    // refuses (from one network the network bucket, checked first, would).
    const real = freshUser();
    for (let i = 0; i < 5; i += 1) {
      anotherNetwork();
      await callback(real.username, `typo-${i}`);
    }
    anotherNetwork();
    const realRefused = await callback(real.username, real.password);
    expect(realRefused.pathname).toBe('/login');
    expect(realRefused.searchParams.get('error')).toBe('CredentialsSignin');
    expect(realRefused.searchParams.get('code')).toBe('locked_user');

    // Nobody by this name: the per-user bucket is keyed on what was typed.
    const ghost = `ghost.${Date.now().toString(36)}`;
    for (let i = 0; i < 5; i += 1) {
      anotherNetwork();
      await callback(ghost, `typo-${i}`);
    }
    anotherNetwork();
    const ghostRefused = await callback(ghost, 'anything');
    expect(ghostRefused.searchParams.get('code')).toBe('locked_user');
  });

  it('a wrong password there is still the plain CredentialsSignin code', async () => {
    const { username } = freshUser();
    const refused = await callback(username, 'typo');
    expect(refused.searchParams.get('code')).toBe('credentials');
  });
});

describe('X-AUTH-2 at authorize(): the network bucket counts failed sign-ins only', () => {
  type Authorize = (creds: Record<string, unknown>) => Promise<{ username: string } | null>;
  /** The Credentials provider's own authorize(), as lib/auth.ts configured it. */
  function authorize(): Authorize {
    const providers = (h.config as { providers?: Array<{ options?: { authorize?: unknown } }> } | null)?.providers;
    const fn = providers?.[0]?.options?.authorize;
    if (typeof fn !== 'function') throw new Error('the Credentials provider has no authorize()');
    return fn as Authorize;
  }
  /** How many attempts a login bucket grants at this instant. Drains it, so call it last. */
  async function tokensLeft(key: string): Promise<number> {
    let left = 0;
    while ((await checkLimit(key, LOGIN_LIMIT)).ok) {
      left += 1;
      if (left > LOGIN_LIMIT.capacity) throw new Error(`${key} granted more than its capacity`);
    }
    return left;
  }
  const FULL = LOGIN_LIMIT.capacity;

  // The in-memory buckets read Date.now(); with the clock frozen nothing refills
  // between an attempt and the count, so every count below is exact.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2020, 0, 1)));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a successful sign-in leaves the network bucket where it was; the per-user bucket still pays', async () => {
    const { username, password } = freshUser();
    expect((await authorize()({ username, password }))?.username).toBe(username);
    expect(await tokensLeft(`login:ip:${h.ip}`)).toBe(FULL);
    expect(await tokensLeft(`login:user:${username}`)).toBe(FULL - 1);
  });

  it('a failed sign-in costs the network bucket one token, and is not refunded', async () => {
    const { username } = freshUser();
    expect(await authorize()({ username, password: 'typo' })).toBeNull();
    expect(refundLimit).not.toHaveBeenCalled();
    expect(await tokensLeft(`login:ip:${h.ip}`)).toBe(FULL - 1);
    expect(await tokensLeft(`login:user:${username}`)).toBe(FULL - 1);
  });

  it('so does a username nobody has', async () => {
    freshUser();
    expect(await authorize()({ username: `ghost.${n}`, password: 'anything' })).toBeNull();
    expect(refundLimit).not.toHaveBeenCalled();
    expect(await tokensLeft(`login:ip:${h.ip}`)).toBe(FULL - 1);
  });

  it('the network bucket is charged first, then the per-user bucket, and refunded after both', async () => {
    const { username, password } = freshUser();
    await authorize()({ username, password });
    const charges = vi.mocked(checkLimit).mock;
    expect(charges.calls.map(([key]) => key)).toEqual([`login:ip:${h.ip}`, `login:user:${username}`]);
    const refund = vi.mocked(refundLimit).mock;
    expect(refund.calls).toEqual([[`login:ip:${h.ip}`, LOGIN_LIMIT]]);
    expect(refund.invocationCallOrder[0]).toBeGreaterThan(Math.max(...charges.invocationCallOrder));
  });

  it('an attempt the network bucket refuses does not touch the per-user bucket', async () => {
    const { username, password } = freshUser();
    const ipKey = `login:ip:${h.ip}`;
    for (let i = 0; i < FULL; i += 1) expect((await checkLimit(ipKey, LOGIN_LIMIT)).ok).toBe(true);
    vi.mocked(checkLimit).mockClear();
    await expect(authorize()({ username, password })).rejects.toMatchObject({ code: 'throttled_ip' });
    expect(vi.mocked(checkLimit).mock.calls.map(([key]) => key)).toEqual([ipKey]);
    expect(refundLimit).not.toHaveBeenCalled();
    expect(await tokensLeft(`login:user:${username}`)).toBe(FULL);
  });

  it('one network cycling through many usernames cannot drain the accounts it is refused for', async () => {
    // Charged second, the network bucket used to refuse each of these only after
    // the account's own bucket had paid — one address could keep many locked.
    const victims = Array.from({ length: 20 }, () => freshUser());
    anotherNetwork();
    const attacker = h.ip;
    let refused = 0;
    for (const v of victims) {
      h.ip = attacker;
      await authorize()({ username: v.username, password: 'guess' }).catch(() => {
        refused += 1;
      });
    }
    expect(refused).toBe(victims.length - FULL);
    for (const v of victims.slice(FULL)) expect(await tokensLeft(`login:user:${v.username}`)).toBe(FULL);
  });

  it('a refund that cannot be written does not fail a sign-in that succeeded', async () => {
    const { username, password } = freshUser();
    delete process.env.RATE_LIMIT_BACKEND;
    process.env.DATABASE_URL = 'postgresql://unit:unit@localhost:5432/unit';
    h.refundDown = true;
    try {
      expect((await authorize()({ username, password }))?.username).toBe(username);
      expect(refundLimit).toHaveBeenCalledTimes(1);
    } finally {
      process.env.RATE_LIMIT_BACKEND = 'memory';
    }
  });
});

describe('loginFailureMessage', () => {
  it('maps the two throttle codes and nothing else', () => {
    expect(loginFailureMessage(new LoginThrottledError('user', 40))).toBe(LOCKED);
    expect(loginFailureMessage(new LoginThrottledError('ip', 7))).toBe(
      'Too many attempts from your network. Try again in 7s.'
    );
    expect(loginFailureMessage(new CredentialsSignin())).toBe(INVALID);
    expect(loginFailureMessage(new AuthError('boom'))).toBe(INVALID);
  });

  it('a throttle error is a CredentialsSignin, so Auth.js passes it through instead of wrapping it', () => {
    const e = new LoginThrottledError('ip', 3);
    expect(e).toBeInstanceOf(CredentialsSignin);
    expect(e.code).toBe('throttled_ip');
    expect(new LoginThrottledError('user', 3).code).toBe('locked_user');
  });
});

describe('structure: the login buckets are charged in one place', () => {
  const src = (p: string) => stripComments(readFileSync(p, 'utf8'), p);

  it('the login form action charges no bucket itself', () => {
    const s = src('app/actions/auth.ts');
    expect(s).not.toMatch(/\bcheckLimit\b/);
    expect(s).not.toMatch(/\bLOGIN_LIMIT\b/);
    expect(s).not.toMatch(/login:(user|ip):/);
  });

  it('authorize() in lib/auth.ts is the only user of LOGIN_LIMIT, and throws rather than returning null on a throttle', () => {
    const s = src('lib/auth.ts');
    expect(s.match(/\bcheckLimit\s*\(/g)).toHaveLength(1);
    const authorize = s.slice(s.indexOf('async authorize('));
    const throttle = authorize.slice(authorize.indexOf('if (!lim.ok)'), authorize.indexOf('const user = await prisma.user.findUnique'));
    expect(throttle).toMatch(/throw new LoginThrottledError\(bucket, lim\.retryAfterSec\)/);
    expect(throttle).not.toMatch(/return null/);
    for (const f of ['app/actions/auth.ts', 'services/users.ts', 'services/password.ts', 'lib/session.ts']) {
      expect(src(f), f).not.toMatch(/\bLOGIN_LIMIT\b/);
    }
  });
});
