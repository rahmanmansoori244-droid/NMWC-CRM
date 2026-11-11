// @vitest-environment node
/**
 * A6: the /api/auth routes (lib/auth-handlers.ts) never hand out a session
 * cookie that outlives the 8-hour sign-in limit. Auth.js's handlers are replaced
 * by fakes that answer as Auth.js does: a sign-in callback and a session read
 * both set the cookie with "now + 8 hours"; a sign-out clears it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ answer: (_req: Request): Response => new Response(null) }));

vi.mock('@/lib/auth', () => ({
  handlers: {
    GET: async (req: Request) => h.answer(req),
    POST: async (req: Request) => h.answer(req),
  },
}));

import { GET, POST } from '@/lib/auth-handlers';
import { authConfig } from '@/auth.config';
import { SIGN_IN_ENDS_COOKIE, SIGN_IN_LIMIT_MS } from '@/lib/sign-in-limit';

const NAME = authConfig.cookies.sessionToken.name;
const T0 = Date.UTC(2026, 10, 24, 3, 30);

/** Auth.js's answer: the session cookie set for now + 8 hours (a little later than the request began). */
function authJsSets(): void {
  h.answer = () => {
    vi.setSystemTime(Date.now() + 400);
    const res = new Response(null, { status: 302, headers: { location: '/home' } });
    res.headers.append(
      'set-cookie',
      `${NAME}=tok; Path=/; Expires=${new Date(Date.now() + SIGN_IN_LIMIT_MS).toUTCString()}; HttpOnly; SameSite=Lax`
    );
    res.headers.append('set-cookie', 'authjs.csrf-token=x; Path=/; HttpOnly');
    return res;
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('lib/auth-handlers.ts', () => {
  it('a sign-in through /api/auth/callback gets a cookie ending no later than the limit, and the hint', async () => {
    authJsSets();
    const res = await POST(new Request('http://localhost/api/auth/callback/credentials', { method: 'POST' }));
    const lines = res.headers.getSetCookie();
    const session = lines.find((l) => l.startsWith(`${NAME}=`))!;
    const exp = Date.parse(/Expires=([^;]+)/.exec(session)![1]);
    expect(exp).toBeLessThanOrEqual(T0 + SIGN_IN_LIMIT_MS);
    expect(session).toMatch(/HttpOnly/);
    expect(lines).toContain('authjs.csrf-token=x; Path=/; HttpOnly');
    expect(lines.some((l) => l.startsWith(`${SIGN_IN_ENDS_COOKIE}=${T0 + SIGN_IN_LIMIT_MS};`))).toBe(true);
    expect(res.status).toBe(302);
  });

  it('a session read re-issues no cookie (no sliding 8 hours)', async () => {
    authJsSets();
    const res = await GET(new Request('http://localhost/api/auth/session'));
    expect(res.headers.getSetCookie()).toEqual(['authjs.csrf-token=x; Path=/; HttpOnly']);
  });

  it('a sign-out still clears the cookie', async () => {
    h.answer = () => {
      const res = new Response(null, { status: 302, headers: { location: '/login' } });
      res.headers.append('set-cookie', `${NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`);
      return res;
    };
    const res = await POST(new Request('http://localhost/api/auth/signout', { method: 'POST' }));
    expect(res.headers.getSetCookie()).toEqual([
      `${NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`,
    ]);
  });

  it('a refused sign-in (no session cookie) gets no hint', async () => {
    h.answer = () => new Response(null, { status: 302, headers: { location: '/login?error=CredentialsSignin' } });
    const res = await POST(new Request('http://localhost/api/auth/callback/credentials', { method: 'POST' }));
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
