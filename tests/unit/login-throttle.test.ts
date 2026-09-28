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
 * The sign-in runs through the REAL Auth.js core — @auth/core's Auth(), with the
 * provider, callbacks and config lib/auth.ts builds — so the claim that a thrown
 * CredentialsSignin reaches loginAction with its code intact is Auth.js's own
 * behaviour here, not a mock's. Only next-auth's thin Next.js wrapper is
 * replaced: its entry imports `next/server` in a form vitest's node resolver
 * refuses, so its signIn() is reproduced below from next-auth/lib/actions.js. The
 * limiter is the real one, on its in-memory backend.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
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
  };
  return { prisma, directPrisma: prisma };
});
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/rate-limit')>();
  return { ...real, checkLimit: vi.fn(real.checkLimit) };
});

import { checkLimit, LOGIN_LIMIT } from '@/lib/rate-limit';
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

beforeEach(() => {
  process.env.RATE_LIMIT_BACKEND = 'memory';
  h.pgDown = false;
  h.lookups = [];
  vi.mocked(checkLimit).mockClear();
});

describe('a form login charges each login bucket exactly once', () => {
  it('one sign-in = one debit of login:user:<name> and one of login:ip:<ip>', async () => {
    const { username, password } = freshUser();
    expect(await login(username, password)).toBe('redirect:/home');
    expect(vi.mocked(checkLimit).mock.calls).toEqual([
      [`login:user:${username}`, LOGIN_LIMIT],
      [`login:ip:${h.ip}`, LOGIN_LIMIT],
    ]);
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
});

describe('a throttled attempt is told so, not "Invalid username or password"', () => {
  it('the sixth rapid attempt on one account says the account is locked — even with the right password', async () => {
    const { username, password } = freshUser();
    for (let i = 0; i < 5; i += 1) expect(await login(username, `typo-${i}`)).toBe(INVALID);
    h.lookups = [];
    expect(await login(username, password)).toBe(LOCKED);
    // Refused before the account is even looked up (the buckets come first).
    expect(h.lookups).not.toContain(username);
  });

  it('the sixth sign-in from one network says "too many attempts from your network", with the wait', async () => {
    const first = freshUser();
    const ip = h.ip;
    const others = [first, ...Array.from({ length: 5 }, () => freshUser())];
    const answers: string[] = [];
    for (const c of others) {
      h.ip = ip;
      answers.push(await login(c.username, c.password));
    }
    expect(answers.slice(0, 5)).toEqual(Array(5).fill('redirect:/home'));
    const wait = Number(answers[5]!.match(NETWORK)?.[1]);
    // One token refills in 60/5 = 12 s.
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(12);
  });

  it('an unreachable limiter still fails closed, now with the throttle message', async () => {
    const { username, password } = freshUser();
    delete process.env.RATE_LIMIT_BACKEND;
    process.env.DATABASE_URL = 'postgresql://unit:unit@localhost:5432/unit';
    h.pgDown = true;
    expect(await login(username, password)).toBe(LOCKED);
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
    const real = freshUser();
    for (let i = 0; i < 5; i += 1) await callback(real.username, `typo-${i}`);
    const realRefused = await callback(real.username, real.password);
    expect(realRefused.pathname).toBe('/login');
    expect(realRefused.searchParams.get('error')).toBe('CredentialsSignin');
    expect(realRefused.searchParams.get('code')).toBe('locked_user');

    // Nobody by this name: the per-user bucket is keyed on what was typed.
    const ghost = `ghost.${Date.now().toString(36)}`;
    h.ip = '10.254.254.254';
    for (let i = 0; i < 5; i += 1) await callback(ghost, `typo-${i}`);
    const ghostRefused = await callback(ghost, 'anything');
    expect(ghostRefused.searchParams.get('code')).toBe('locked_user');
  });

  it('a wrong password there is still the plain CredentialsSignin code', async () => {
    const { username } = freshUser();
    const refused = await callback(username, 'typo');
    expect(refused.searchParams.get('code')).toBe('credentials');
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
