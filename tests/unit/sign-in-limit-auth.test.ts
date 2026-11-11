// @vitest-environment node
/**
 * A6, the Node half of the 8-hour sign-in limit, on a fake clock:
 *   - lib/auth.ts's jwt callback stamps the sign-in and refuses the token at the
 *     limit, however active the person has been, before any database read;
 *   - every existing way a session ends still ends it (Disable, the revocation
 *     marker set by sign-out / password change or reset / role change);
 *   - the exported auth() — what pages, server actions and API routes read,
 *     lib/session.ts included — refuses a session past the limit once more;
 *   - the sign-in form's cookie never outlives the stamp plus 8 hours, and
 *     leaves the sign-in page its hint; sign-out removes the hint.
 *
 * next-auth's wrapper is replaced so the config lib/auth.ts builds can be read;
 * the callbacks themselves are the real ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResponseCookies } from 'next/dist/compiled/@edge-runtime/cookies';

const h = vi.hoisted(() => ({
  config: null as null | {
    callbacks: {
      jwt: (p: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      session: (p: Record<string, unknown>) => { user: Record<string, unknown> };
    };
  },
  session: null as null | { user: Record<string, unknown>; expires: string },
  user: null as null | {
    id: string;
    role: string;
    isActive: boolean;
    username: string;
    mustChangePassword: boolean;
    sessionsRevokedAt: Date | null;
  },
  reads: 0,
  jar: null as unknown as InstanceType<typeof ResponseCookies>,
  /** What signIn() does to the cookie jar: what Auth.js does, expiry included. */
  signIn: vi.fn(async (..._a: unknown[]) => undefined as unknown),
  signOut: vi.fn(async (..._a: unknown[]) => undefined as unknown),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '10.9.9.9' }),
  cookies: async () => h.jar,
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
}));
vi.mock('next-auth', async () => {
  const errors = await import('@auth/core/errors');
  return {
    AuthError: errors.AuthError,
    CredentialsSignin: errors.CredentialsSignin,
    default: (config: typeof h.config) => {
      h.config = config;
      return { handlers: {}, auth: async () => h.session, signIn: h.signIn, signOut: h.signOut };
    },
  };
});
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: async () => {},
}));
vi.mock('@/lib/db', () => {
  const prisma = {
    user: {
      findUnique: async ({ select }: { select?: Record<string, boolean> }) => {
        h.reads += 1;
        if (select && 'sessionsRevokedAt' in select) return h.user;
        return h.user ? { mustChangePassword: h.user.mustChangePassword } : null;
      },
      update: async () => ({}),
    },
  };
  return { prisma, directPrisma: prisma };
});
vi.mock('@/lib/change-context', () => ({
  src: { auth: (s: string) => `auth:${s}` },
  withChangeContext: async (_p: unknown, _c: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ user: { update: async () => ({}) } }),
}));

import { auth } from '@/lib/auth';
import { loginAction, logoutAction } from '@/app/actions/auth';
import { authConfig } from '@/auth.config';
import { SIGN_IN_ENDS_COOKIE, SIGN_IN_LIMIT_MS } from '@/lib/sign-in-limit';

const T0 = Date.UTC(2026, 10, 24, 3, 30);
const MIN = 60_000;
const HOUR = 60 * MIN;
const NAME = authConfig.cookies.sessionToken.name;

let uid = 0;
function freshUser() {
  uid += 1;
  h.user = {
    id: `u-limit-${uid}`,
    role: 'SALESMAN',
    isActive: true,
    username: `c${uid}`,
    mustChangePassword: false,
    sessionsRevokedAt: null,
  };
  return h.user;
}

const jwt = (p: Record<string, unknown>) => h.config!.callbacks.jwt(p);

/** A real sign-in through the jwt callback, at the fake clock's now. */
async function signInToken(): Promise<Record<string, unknown>> {
  const u = h.user!;
  const t = await jwt({ token: { sub: u.id }, user: { id: u.id, role: u.role, username: u.username } });
  return t!;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  h.reads = 0;
  h.session = null;
  h.jar = new ResponseCookies(new Headers());
  h.signIn.mockReset();
  h.signOut.mockReset();
  freshUser();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('lib/auth.ts jwt callback: a sign-in lasts at most 8 hours', () => {
  it('stamps the moment of sign-in', async () => {
    const t = await signInToken();
    expect(t.signedInAt).toBe(T0);
    expect(t.iatMs).toBe(T0);
  });

  it('a person active every few minutes is still signed out at 8 hours', async () => {
    let t: Record<string, unknown> | null = await signInToken();
    for (let at = T0 + 4 * MIN; at < T0 + 8 * HOUR; at += 4 * MIN) {
      vi.setSystemTime(at);
      t = await jwt({ token: t });
      expect(t, `still signed in at +${(at - T0) / MIN} min`).not.toBeNull();
    }
    // Active the whole day, and the freshness re-read ran all along.
    expect(h.reads).toBeGreaterThan(10);
    vi.setSystemTime(T0 + 8 * HOUR);
    const reads = h.reads;
    expect(await jwt({ token: t })).toBeNull();
    // Refused before the database is asked.
    expect(h.reads).toBe(reads);
  });

  it('a person idle for 8 hours is signed out, as before', async () => {
    const t = await signInToken();
    vi.setSystemTime(T0 + 8 * HOUR + MIN);
    expect(await jwt({ token: t })).toBeNull();
  });

  it('a fresh sign-in starts a fresh 8 hours', async () => {
    const first = await signInToken();
    vi.setSystemTime(T0 + 8 * HOUR + 10 * MIN);
    expect(await jwt({ token: first })).toBeNull();
    const second = await signInToken();
    expect(second.signedInAt).toBe(T0 + 8 * HOUR + 10 * MIN);
    vi.setSystemTime(T0 + 15 * HOUR);
    expect(await jwt({ token: second })).not.toBeNull();
    vi.setSystemTime(T0 + 16 * HOUR + 10 * MIN);
    expect(await jwt({ token: second })).toBeNull();
  });

  it.each([
    ['missing (a token from before this release)', undefined],
    ['in the future', T0 + 5 * HOUR],
    ['not a number', String(T0)],
  ])('a token whose stamp is %s is refused', async (_label, signedInAt) => {
    const t = { ...(await signInToken()), signedInAt, lastCheck: 0 };
    if (signedInAt === undefined) delete (t as Record<string, unknown>).signedInAt;
    expect(await jwt({ token: t })).toBeNull();
  });

  it('the existing ways a session ends still end it within the 8 hours', async () => {
    // Disable.
    let t = await signInToken();
    vi.setSystemTime(T0 + HOUR);
    h.user!.isActive = false;
    expect(await jwt({ token: { ...t, lastCheck: 0 } })).toBeNull();
    // Sign-out, password change or reset, role change: the revocation marker.
    freshUser();
    vi.setSystemTime(T0 + 2 * HOUR);
    t = await signInToken();
    vi.setSystemTime(T0 + 3 * HOUR);
    h.user!.sessionsRevokedAt = new Date(T0 + 2 * HOUR + MIN);
    expect(await jwt({ token: { ...t, lastCheck: 0 } })).toBeNull();
  });

  it('the session carries the stamp', () => {
    const s = h.config!.callbacks.session({
      session: { user: {}, expires: '' },
      token: { userId: 'u', role: 'SALESMAN', username: 'c1', signedInAt: T0 },
    });
    expect(s.user.signedInAt).toBe(T0);
  });
});

describe('auth(): pages, server actions and API routes never see a session past the limit', () => {
  const session = (signedInAt: unknown) => ({
    user: { id: 'u1', role: 'SALESMAN', username: 'c1', signedInAt },
    expires: new Date(T0 + 8 * HOUR).toISOString(),
  });

  it('a session within the 8 hours is the session', async () => {
    h.session = session(T0);
    vi.setSystemTime(T0 + 8 * HOUR - 1);
    expect(await auth()).toEqual(h.session);
  });

  it('a session at the limit, without a stamp, or with a future stamp reads as signed out', async () => {
    vi.setSystemTime(T0 + 8 * HOUR);
    h.session = session(T0);
    expect(await auth()).toBeNull();
    vi.setSystemTime(T0);
    h.session = session(undefined);
    expect(await auth()).toBeNull();
    h.session = session(T0 + 2 * HOUR);
    expect(await auth()).toBeNull();
  });

  it('checkActor answers a person past the limit exactly as it answers a signed-out one', async () => {
    const { checkActor, requireActor } = await import('@/lib/session');
    vi.setSystemTime(T0 + 9 * HOUR);
    h.session = session(T0);
    const pastLimit = await checkActor();
    h.session = null;
    const signedOut = await checkActor();
    expect(pastLimit).toEqual(signedOut);
    expect(pastLimit).toEqual({ ok: false, status: 401, code: 'SIGNED_OUT', message: 'Not signed in.' });
    h.session = session(T0);
    await expect(requireActor()).rejects.toThrow('Not signed in.');
  });
});

/** What Auth.js's signIn() leaves in the jar: the cookie, expiring now + 8 hours (a little after its stamp). */
function authJsSetsCookie() {
  h.signIn.mockImplementation(async () => {
    vi.setSystemTime(Date.now() + 300); // the password check
    h.jar.set({
      name: NAME,
      value: 'encrypted-token',
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      expires: new Date(Date.now() + 5 + SIGN_IN_LIMIT_MS),
    });
    return undefined;
  });
}

async function submitLogin(): Promise<string> {
  const fd = new FormData();
  fd.set('username', h.user!.username);
  fd.set('password', 'a made up password');
  try {
    const r = await loginAction(fd);
    return r ? r.error : 'no redirect';
  } catch (e) {
    return `redirect:${(e as { url?: string }).url}`;
  }
}

describe('the sign-in form: the cookie ends no later than the limit', () => {
  it('cuts the session cookie to the moment the sign-in began plus 8 hours, and leaves the hint', async () => {
    authJsSetsCookie();
    expect(await submitLogin()).toBe('redirect:/home');
    const c = h.jar.get(NAME)!;
    expect(c.value).toBe('encrypted-token');
    const exp = new Date(c.expires as Date).getTime();
    // The stamp is taken during signIn(), so after T0: T0 + 8 h is no later than stamp + 8 h.
    expect(exp).toBeLessThanOrEqual(T0 + SIGN_IN_LIMIT_MS);
    expect(T0 + SIGN_IN_LIMIT_MS - exp).toBeLessThan(1000);
    expect(c.httpOnly).toBe(true);
    expect(h.jar.get(SIGN_IN_ENDS_COOKIE)?.value).toBe(String(T0 + SIGN_IN_LIMIT_MS));
  });

  it('a refused sign-in sets neither', async () => {
    const { CredentialsSignin } = await import('@auth/core/errors');
    h.signIn.mockImplementation(async () => {
      throw new CredentialsSignin();
    });
    expect(await submitLogin()).toBe('Invalid username or password.');
    expect(h.jar.get(NAME)).toBeUndefined();
    expect(h.jar.get(SIGN_IN_ENDS_COOKIE)).toBeUndefined();
  });

  it('sign-out removes the hint, so the page never blames the limit for it', async () => {
    h.jar.set({ name: SIGN_IN_ENDS_COOKIE, value: String(T0 - HOUR), path: '/' });
    h.session = null;
    await logoutAction();
    expect(h.signOut).toHaveBeenCalledWith({ redirectTo: '/login' });
    expect(h.jar.get(SIGN_IN_ENDS_COOKIE)?.value ?? '').toBe('');
  });
});
