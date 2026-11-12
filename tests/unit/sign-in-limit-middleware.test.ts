// @vitest-environment node
/**
 * A6: the Edge middleware, end to end on a fake clock, with Auth.js's real
 * session handling (@auth/core Auth(), real encrypted tokens) and the real
 * middleware.ts and auth.config.ts.
 *
 * next-auth's own wrapper cannot be loaded under vitest (its entry imports
 * `next/server` in a form Node's resolver refuses), so NextAuth() is replaced by
 * a copy of what next-auth 5's handleAuth does for a wrapped middleware: read the
 * session through Auth()'s session action with the config, call `authorized`,
 * run the inner middleware with req.auth, and append the session action's
 * Set-Cookie lines to the response. Only that plumbing is a copy; the token, the
 * callbacks and middleware.ts are real.
 *
 * Pinned:
 *   - a person active every few minutes is signed in until 8 hours after he
 *     signed in, and refused (cookie cleared) from then on;
 *   - no response re-issues the session cookie (the sliding refresh is gone);
 *   - a person idle for 8 hours is refused, as before;
 *   - a fresh sign-in starts a fresh 8 hours;
 *   - a token with no stamp, a future stamp or a stamp that is not a number is
 *     refused.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const SECRET = 'words that make up a made up secret for this test only';

const h = vi.hoisted(() => ({ lastAuth: undefined as unknown }));

vi.mock('next-auth', async () => {
  const { Auth } = await import('@auth/core');
  type Cfg = {
    callbacks: {
      session?: (...a: never[]) => unknown;
      authorized: (p: { request: Request; auth: unknown }) => unknown;
    };
  } & Record<string, unknown>;
  return {
    default: (config: Cfg) => ({
      auth:
        (inner: (req: Request & { auth?: unknown }, ev: unknown) => Promise<Response>) =>
        async (req: Request & { auth?: unknown; nextUrl: URL }, ev: unknown) => {
          const url = new URL('/api/auth/session', req.url);
          const sessionRes = (await Auth(
            new Request(url, { headers: { cookie: req.headers.get('cookie') ?? '' } }),
            {
              ...(config as object),
              secret: SECRET,
              basePath: '/api/auth',
              callbacks: {
                ...config.callbacks,
                async session(...args: never[]) {
                  const s = (await config.callbacks.session?.(...args)) as Record<string, unknown>;
                  return { user: (args[0] as { token: unknown }).token, ...s };
                },
              },
            } as never
          )) as Response;
          const auth = sessionRes.ok ? await sessionRes.json() : null;
          h.lastAuth = auth;
          const authorized = await config.callbacks.authorized({ request: req, auth });
          let response: Response;
          if (authorized instanceof Response) response = authorized;
          else {
            req.auth = auth;
            response = await inner(req, ev);
          }
          const final = new Response(response.body, response);
          for (const c of sessionRes.headers.getSetCookie()) final.headers.append('set-cookie', c);
          return final;
        },
    }),
  };
});

import { encode } from '@auth/core/jwt';
import { NextRequest } from 'next/server';
import middleware from '@/middleware';
import { authConfig } from '@/auth.config';
import { SIGN_IN_LIMIT_SECONDS } from '@/lib/sign-in-limit';

const NAME = authConfig.cookies.sessionToken.name;
const T0 = Date.UTC(2026, 10, 24, 3, 30);
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  h.lastAuth = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

/** The cookie a sign-in at the fake clock's now gives (as lib/auth.ts's jwt callback stamps it). */
async function signedInCookie(over: Record<string, unknown> = {}, drop: string[] = []): Promise<string> {
  const now = Date.now();
  const token: Record<string, unknown> = {
    sub: 'u1',
    name: 'Test Salesman',
    userId: 'u1',
    role: 'SALESMAN',
    username: 'c4',
    iatMs: now,
    signedInAt: now,
    lastCheck: now,
    mustChangePassword: false,
    ...over,
  };
  for (const k of drop) delete token[k];
  const value = await encode({ token, secret: SECRET, salt: NAME, maxAge: SIGN_IN_LIMIT_SECONDS });
  return `${NAME}=${value}`;
}

async function visit(cookie: string, path = '/today') {
  const req = new NextRequest(new URL(path, 'http://localhost:3000'), { headers: { cookie } });
  const res = (await middleware(req, {} as never)) as Response;
  const session = res.headers.getSetCookie().filter((l) => l.startsWith(`${NAME}=`) || l.startsWith(`${NAME}.`));
  return {
    signedIn: !!(h.lastAuth as { user?: unknown } | null)?.user,
    reissued: session.filter((l) => !/^[^=]+=;/.test(l)),
    cleared: session.filter((l) => /^[^=]+=;/.test(l)),
  };
}

describe('the middleware: a sign-in lasts at most 8 hours', () => {
  it('a person active every few minutes is signed in, never re-issued a cookie, and signed out at 8 hours', async () => {
    const cookie = await signedInCookie();
    for (let at = T0; at < T0 + 8 * HOUR; at += 13 * MIN) {
      vi.setSystemTime(at);
      const r = await visit(cookie);
      expect(r.signedIn, `signed in at +${(at - T0) / MIN} min`).toBe(true);
      expect(r.reissued, 'no sliding refresh of the cookie').toEqual([]);
      expect(r.cleared).toEqual([]);
    }
    vi.setSystemTime(T0 + 8 * HOUR - 1000);
    expect((await visit(cookie)).signedIn).toBe(true);
    vi.setSystemTime(T0 + 8 * HOUR);
    const r = await visit(cookie);
    expect(r.signedIn).toBe(false);
    expect(r.cleared.length).toBeGreaterThan(0);
    expect(r.reissued).toEqual([]);
  });

  it('a server action POST past the limit goes on to the action (which answers "signed out"), with the cookie cleared', async () => {
    const cookie = await signedInCookie();
    vi.setSystemTime(T0 + 9 * HOUR);
    const req = new NextRequest(new URL('/customers/new', 'http://localhost:3000'), {
      method: 'POST',
      headers: { cookie, 'next-action': 'abc123' },
    });
    const res = (await middleware(req, {} as never)) as Response;
    // Not a redirect: a redirected action POST breaks the form (auth.config.ts).
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(h.lastAuth).toBeNull();
  });

  it('a person idle for 8 hours is signed out, as before', async () => {
    const cookie = await signedInCookie();
    vi.setSystemTime(T0 + 8 * HOUR + 5 * MIN);
    const r = await visit(cookie);
    expect(r.signedIn).toBe(false);
    expect(r.cleared.length).toBeGreaterThan(0);
  });

  it('a fresh sign-in starts a fresh 8 hours', async () => {
    vi.setSystemTime(T0 + 8 * HOUR + 2 * MIN);
    const fresh = await signedInCookie();
    vi.setSystemTime(T0 + 16 * HOUR);
    expect((await visit(fresh)).signedIn).toBe(true);
    vi.setSystemTime(T0 + 16 * HOUR + 2 * MIN);
    expect((await visit(fresh)).signedIn).toBe(false);
  });

  it.each([
    ['missing (issued before this release)', null],
    ['in the future', T0 + 4 * HOUR],
    ['not a number', 'today'],
  ])('a token whose stamp is %s is refused and cleared', async (_label, signedInAt) => {
    const cookie = signedInAt === null ? await signedInCookie({}, ['signedInAt']) : await signedInCookie({ signedInAt });
    const r = await visit(cookie);
    expect(r.signedIn).toBe(false);
    expect(r.cleared.length).toBeGreaterThan(0);
  });

  it('the sign-in page itself stays open past the limit', async () => {
    const cookie = await signedInCookie();
    vi.setSystemTime(T0 + 10 * HOUR);
    const req = new NextRequest(new URL('/login', 'http://localhost:3000'), { headers: { cookie } });
    const res = (await middleware(req, {} as never)) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});
