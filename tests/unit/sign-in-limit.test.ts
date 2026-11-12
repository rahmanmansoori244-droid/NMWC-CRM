// @vitest-environment node
/**
 * A6 (owner's answer, 2026-11-11): a sign-in lasts AT MOST 8 hours from the
 * moment of signing in, for every role, however active the person has been.
 *
 * This file pins the rule itself (lib/sign-in-limit.ts) and the Edge half of it
 * (auth.config.ts, which the middleware runs), on a fake clock. The Node half
 * (lib/auth.ts), the middleware round trip, the /api/auth routes and the sign-in
 * page have their own files: sign-in-limit-*.test.ts(x).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  SIGN_IN_CLOCK_SKEW_MS,
  SIGN_IN_ENDS_COOKIE,
  SIGN_IN_LIMIT_MS,
  SIGN_IN_LIMIT_SECONDS,
  capSessionCookies,
  dropSessionRefreshes,
  signInEndsAt,
  signInEndsCookieLine,
  signInExpired,
  signedOutByLimit,
  sessionCookieMaxAge,
} from '@/lib/sign-in-limit';
import { authConfig } from '@/auth.config';

const T0 = Date.UTC(2026, 10, 24, 3, 30); // 07:30 in Oman
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the limit is one constant: 8 hours', () => {
  it('is 8 hours, in ms and in seconds', () => {
    expect(SIGN_IN_LIMIT_MS).toBe(8 * HOUR);
    expect(SIGN_IN_LIMIT_SECONDS).toBe(8 * 60 * 60);
  });

  it("Auth.js's session maxAge is that constant", () => {
    expect(authConfig.session?.maxAge).toBe(SIGN_IN_LIMIT_SECONDS);
  });
});

describe('signInExpired: on a fake clock', () => {
  it('a sign-in is good until 8 hours after it, and refused from then on', () => {
    const t = { signedInAt: T0 };
    expect(signInExpired(t)).toBe(false);
    vi.setSystemTime(T0 + 8 * HOUR - 1);
    expect(signInExpired(t)).toBe(false);
    vi.setSystemTime(T0 + 8 * HOUR);
    expect(signInExpired(t)).toBe(true);
    vi.setSystemTime(T0 + 30 * 24 * HOUR);
    expect(signInExpired(t)).toBe(true);
  });

  it('a token without a stamp (issued before this release) is refused', () => {
    expect(signInExpired({})).toBe(true);
    expect(signInExpired(null)).toBe(true);
    expect(signInExpired(undefined)).toBe(true);
    expect(signInExpired({ signedInAt: undefined })).toBe(true);
  });

  it.each([
    ['a string', String(T0)],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['an object', { at: T0 }],
    ['a boolean', true],
  ])('a stamp that is not a number (%s) is refused', (_label, value) => {
    expect(signInExpired({ signedInAt: value })).toBe(true);
  });

  it('a stamp in the future is refused; one within the servers’ clock difference is not', () => {
    expect(signInExpired({ signedInAt: T0 + SIGN_IN_CLOCK_SKEW_MS + 1 })).toBe(true);
    expect(signInExpired({ signedInAt: T0 + 24 * HOUR })).toBe(true);
    expect(signInExpired({ signedInAt: T0 + 500 })).toBe(false);
    expect(signInExpired({ signedInAt: T0 + SIGN_IN_CLOCK_SKEW_MS })).toBe(false);
  });

  it('signInEndsAt is the stamp plus 8 hours, or null for a stamp that is not believed', () => {
    expect(signInEndsAt(T0)).toBe(T0 + 8 * HOUR);
    expect(signInEndsAt('x')).toBeNull();
    expect(signInEndsAt(T0 + 2 * HOUR)).toBeNull();
  });
});

type EdgeJwt = (p: { token: Record<string, unknown> }) => unknown;
const edgeJwt = authConfig.callbacks.jwt as unknown as EdgeJwt;

describe('the Edge middleware (auth.config.ts jwt callback)', () => {
  const token = () => ({ userId: 'u1', role: 'SALESMAN', username: 'c4', signedInAt: T0, lastCheck: T0 });

  it('a person active every few minutes is still signed out at 8 hours', () => {
    const t = token();
    for (let at = T0; at < T0 + 8 * HOUR; at += 7 * MIN) {
      vi.setSystemTime(at);
      expect(edgeJwt({ token: t })).toBe(t);
    }
    vi.setSystemTime(T0 + 8 * HOUR);
    expect(edgeJwt({ token: t })).toBeNull();
  });

  it('a person idle for 8 hours is signed out', () => {
    vi.setSystemTime(T0 + 8 * HOUR + 5 * MIN);
    expect(edgeJwt({ token: token() })).toBeNull();
  });

  it('a fresh sign-in starts a fresh 8 hours', () => {
    vi.setSystemTime(T0 + 8 * HOUR + 1);
    const fresh = { ...token(), signedInAt: Date.now() };
    expect(edgeJwt({ token: fresh })).toBe(fresh);
    vi.setSystemTime(T0 + 16 * HOUR);
    expect(edgeJwt({ token: fresh })).toBe(fresh);
    vi.setSystemTime(T0 + 16 * HOUR + 1);
    expect(edgeJwt({ token: fresh })).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['in the future', T0 + 3 * HOUR],
    ['not a number', 'yesterday'],
  ])('a token whose stamp is %s is refused', (_label, signedInAt) => {
    expect(edgeJwt({ token: { ...token(), signedInAt } })).toBeNull();
  });

  it('the Edge session callback hands the stamp on, so auth() can check it again', () => {
    const session = { user: {}, expires: '' } as never;
    const out = (authConfig.callbacks.session as unknown as (p: unknown) => { user: Record<string, unknown> })({
      session,
      token: token(),
    });
    expect(out.user.signedInAt).toBe(T0);
  });
});

const NAME = 'authjs.session-token';

function headersWith(lines: string[]): Headers {
  const h = new Headers();
  for (const l of lines) h.append('set-cookie', l);
  return h;
}

describe("dropSessionRefreshes: Auth.js's sliding refresh never reaches the browser", () => {
  it('drops a re-issued session cookie and its chunks; keeps a clearing one and every other cookie', () => {
    const h = headersWith([
      `${NAME}=eyJhbGciOi.abc; Path=/; Expires=${new Date(T0 + 8 * HOUR).toUTCString()}; HttpOnly; SameSite=Lax`,
      `${NAME}.0=part0; Path=/; HttpOnly`,
      `${NAME}.1=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`,
      `${NAME}x=other; Path=/`,
      'authjs.csrf-token=abc; Path=/',
    ]);
    expect(dropSessionRefreshes(h, NAME)).toBe(2);
    expect(h.getSetCookie()).toEqual([
      `${NAME}.1=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`,
      `${NAME}x=other; Path=/`,
      'authjs.csrf-token=abc; Path=/',
    ]);
  });

  it('leaves the headers alone when there is nothing to drop', () => {
    const h = headersWith(['a=1; Path=/']);
    expect(dropSessionRefreshes(h, NAME)).toBe(0);
    expect(h.getSetCookie()).toEqual(['a=1; Path=/']);
  });
});

describe('capSessionCookies: a sign-in cookie never outlives the stamp plus 8 hours', () => {
  // Review of A6 (2026-11-11): Expires alone is read on the DEVICE's clock, so a
  // tablet whose clock ran fast dropped the cookie before the limit. The Max-Age
  // Auth.js gave (8 hours from now) is replaced by one that ends at the limit.
  it('cuts Expires to the limit (whole seconds, rounded down) and gives a Max-Age that ends there too', () => {
    const ends = T0 + 8 * HOUR - 250; // the stamp came a little after the request started
    const h = headersWith([
      `${NAME}=tok; Path=/; Expires=${new Date(T0 + 8 * HOUR + 40).toUTCString()}; Max-Age=28800; HttpOnly; SameSite=Lax`,
      'other=1; Path=/',
    ]);
    expect(capSessionCookies(h, NAME, ends)).toBe(1);
    const [line, other] = h.getSetCookie();
    expect(other).toBe('other=1; Path=/');
    expect(line).not.toMatch(/max-age=28800/i);
    expect(line.match(/max-age=/gi)).toHaveLength(1);
    expect(line).toMatch(/HttpOnly/);
    const exp = Date.parse(/Expires=([^;]+)/.exec(line)![1]);
    expect(exp).toBeLessThanOrEqual(ends);
    expect(ends - exp).toBeLessThan(1000);
    const maxAge = Number(/Max-Age=(\d+)/.exec(line)![1]);
    expect(maxAge).toBe(Math.floor((exp - Date.now()) / 1000));
    expect(Date.now() + maxAge * 1000).toBeLessThanOrEqual(ends);
  });

  it('a device clock that runs ahead does not shorten the sign-in: Max-Age counts from receipt', () => {
    // The browser keeps a cookie with Max-Age for that many seconds from when it
    // got it, whatever its own clock says; Expires is only the fallback.
    vi.setSystemTime(T0 + 2 * HOUR);
    const h = headersWith([`${NAME}=tok; Path=/; Expires=${new Date(T0 + 10 * HOUR).toUTCString()}`]);
    capSessionCookies(h, NAME, T0 + 8 * HOUR);
    expect(h.getSetCookie()[0]).toMatch(/; Max-Age=21600$/);
    expect(sessionCookieMaxAge(T0 + 8 * HOUR)).toBe(6 * 3600);
    expect(sessionCookieMaxAge(T0)).toBe(0);
  });

  it('keeps an earlier expiry, and leaves a clearing cookie alone', () => {
    const early = new Date(T0 + HOUR).toUTCString();
    const h = headersWith([`${NAME}=tok; Path=/; Expires=${early}`, `${NAME}.0=; Path=/; Max-Age=0`]);
    expect(capSessionCookies(h, NAME, T0 + 8 * HOUR)).toBe(1);
    expect(h.getSetCookie()[0]).toContain(`Expires=${early}`);
    expect(h.getSetCookie()[1]).toBe(`${NAME}.0=; Path=/; Max-Age=0`);
  });
});

describe('the sign-in page hint', () => {
  it('is a time only, HttpOnly, and outlives the sign-in by a day', () => {
    const line = signInEndsCookieLine(T0 + 8 * HOUR, true);
    expect(line.startsWith(`${SIGN_IN_ENDS_COOKIE}=${T0 + 8 * HOUR};`)).toBe(true);
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/Secure/);
    expect(line).toContain(`Expires=${new Date(T0 + 32 * HOUR).toUTCString()}`);
    expect(signInEndsCookieLine(T0, false)).not.toMatch(/Secure/);
  });

  it('says "signed out by the limit" only once its moment has passed (or is under a minute away)', () => {
    const ends = String(T0 + 8 * HOUR);
    expect(signedOutByLimit(ends)).toBe(false);
    // Review of A6: Max-Age is whole seconds from receipt, so the browser drops
    // the cookie a moment before the limit; that person is told why too.
    vi.setSystemTime(T0 + 8 * HOUR - 2 * 60_000);
    expect(signedOutByLimit(ends)).toBe(false);
    vi.setSystemTime(T0 + 8 * HOUR - 2_000);
    expect(signedOutByLimit(ends)).toBe(true);
    vi.setSystemTime(T0 + 8 * HOUR);
    expect(signedOutByLimit(ends)).toBe(true);
    expect(signedOutByLimit(undefined)).toBe(false);
    expect(signedOutByLimit('')).toBe(false);
    expect(signedOutByLimit('soon')).toBe(false);
    expect(signedOutByLimit('-5')).toBe(false);
  });
});

// Review of A6 (2026-11-11): a promote slice refused at the limit is followed by
// router.refresh(), and the refreshed batch page sends a signed-out Steward to the
// sign-in page, so he never reads "Not signed in." on the Promote button. The
// Steward guide and the support table must say what he actually sees.
describe('what the Steward is told about a promote the limit stops', () => {
  it('matches the Promote button: a failed slice refreshes the page, which goes to the sign-in page', async () => {
    const { readFileSync } = await import('node:fs');
    const button = readFileSync('app/(app)/import/[batchId]/PromoteButton.tsx', 'utf8');
    expect(button).toMatch(/if \(!res\.ok\) \{\s*say\([^;]*\);\s*router\.refresh\(\);\s*return;/);
    for (const f of ['scripts/build-role-guides.ts', 'docs/OPERATIONS.md']) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/promote stopped by (it )?\(?"Not signed in\."/i);
      expect(text, f).toMatch(/promote the limit stops (sends you|takes the Steward) to the sign-in page/i);
    }
  });
});

// Final check of the review (2026-11-11): the 8-hour limit, and how to keep a
// form that is half done, was in the English guides only. The Arabic Salesman,
// Supervisor and Manager guides carry their own "Common situations" tables and
// say it too, in the source and in the regenerated HTML.
describe('the Arabic guides tell people about the 8-hour sign-in', () => {
  it('each Arabic guide that has an English row about it has one too', async () => {
    const { readFileSync } = await import('node:fs');
    for (const role of ['Salesman', 'Supervisor', 'Manager']) {
      const en = readFileSync(`docs/guide/NMWC-${role}-Guide-EN.html`, 'utf8');
      const ar = readFileSync(`docs/guide/NMWC-${role}-Guide-AR.html`, 'utf8');
      expect(en, role).toMatch(/at most 8 hours/);
      expect(ar, role).toMatch(/تسجيل الدخول[^<]*8 ساعات/);
      expect(ar, role).toMatch(/سجّل الدخول (مرة أخرى )?في علامة تبويب أخرى/);
    }
  });
});
