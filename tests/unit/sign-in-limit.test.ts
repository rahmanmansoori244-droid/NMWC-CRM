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
  it('cuts Expires to the limit (whole seconds, rounded down) and removes Max-Age', () => {
    const ends = T0 + 8 * HOUR - 250; // the stamp came a little after the request started
    const h = headersWith([
      `${NAME}=tok; Path=/; Expires=${new Date(T0 + 8 * HOUR + 40).toUTCString()}; Max-Age=28800; HttpOnly; SameSite=Lax`,
      'other=1; Path=/',
    ]);
    expect(capSessionCookies(h, NAME, ends)).toBe(1);
    const [line, other] = h.getSetCookie();
    expect(other).toBe('other=1; Path=/');
    expect(line).not.toMatch(/max-age/i);
    expect(line).toMatch(/HttpOnly/);
    const exp = Date.parse(/Expires=([^;]+)/.exec(line)![1]);
    expect(exp).toBeLessThanOrEqual(ends);
    expect(ends - exp).toBeLessThan(1000);
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

  it('says "signed out by the limit" only once its moment has passed', () => {
    const ends = String(T0 + 8 * HOUR);
    expect(signedOutByLimit(ends)).toBe(false);
    vi.setSystemTime(T0 + 8 * HOUR);
    expect(signedOutByLimit(ends)).toBe(true);
    expect(signedOutByLimit(undefined)).toBe(false);
    expect(signedOutByLimit('')).toBe(false);
    expect(signedOutByLimit('soon')).toBe(false);
    expect(signedOutByLimit('-5')).toBe(false);
  });
});
