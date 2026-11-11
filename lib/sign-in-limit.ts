/**
 * The longest a sign-in lasts: 8 hours from the moment of signing in, for every
 * role, however active the person has been (owner's answer, 2026-11-11: "A
 * sign-in has no upper time limit is 8 hours" — read back to him as "at most 8
 * hours from signing in").
 *
 * Before this, auth.config.ts had `maxAge: 8 h` and every request re-issued the
 * session cookie for another 8 hours, so the 8 hours slid: a phone used at least
 * once every 8 hours stayed signed in for weeks, even if lost.
 *
 * Now:
 *   - lib/auth.ts stamps `signedInAt` (epoch ms) in the token at sign-in;
 *   - the Edge middleware (auth.config.ts) and the Node jwt callback (lib/auth.ts)
 *     refuse a token once `signInExpired()` says so, and the exported auth()
 *     refuses such a session again, so pages, server actions and API routes all
 *     see "signed out" exactly as they do today;
 *   - no response ever re-issues the session cookie with a later expiry: the
 *     middleware and the /api/auth routes drop Auth.js's sliding refresh, and a
 *     sign-in's cookie is cut to end no later than the stamp plus 8 hours
 *     (lib/sign-in-cookies.ts, middleware.ts, lib/auth-handlers.ts).
 *
 * A token with no stamp (issued before this release), a stamp that is not a
 * number, or a stamp in the future is refused: the person signs in again.
 *
 * Edge-safe and pure: no Prisma, no Node modules, no next/headers. The Edge
 * middleware imports it through auth.config.ts.
 */

/** THE limit. Every other place reads it from here. */
export const SIGN_IN_LIMIT_MS = 8 * 60 * 60 * 1000;
/** The same limit in seconds, for Auth.js's `session.maxAge` and cookie expiries. */
export const SIGN_IN_LIMIT_SECONDS = SIGN_IN_LIMIT_MS / 1000;

/**
 * How far ahead of this server's clock a stamp may be and still be believed.
 * The stamp is written by whichever server handled the sign-in and read by
 * another (the Edge middleware, another lambda); their clocks agree to well under
 * a second, but not to the millisecond. Without this, a sign-in could be refused
 * on its very next request. Anything further ahead is not a clock difference.
 */
export const SIGN_IN_CLOCK_SKEW_MS = 60_000;

/**
 * Set by a sign-in, read by the sign-in page: the moment that sign-in reaches its
 * limit (epoch ms). It holds nothing secret — only a time — and lets the sign-in
 * page say WHY the person is there, which it cannot otherwise know: once the
 * limit has passed the browser has dropped the session cookie itself.
 */
export const SIGN_IN_ENDS_COOKIE = 'nmwc-signin-ends';
/** The hint outlives the sign-in by a day, so the page can still explain it the next morning. */
export const SIGN_IN_ENDS_COOKIE_EXTRA_MS = 24 * 60 * 60 * 1000;

/** What the sign-in page says to someone the limit signed out. Promises nothing about unsent work. */
export const SIGN_IN_LIMIT_MESSAGE =
  'You were signed out because a sign-in lasts at most 8 hours. Please sign in again.';

/** The stamp, when it is one this server can believe; otherwise null. */
export function readSignedInAt(signedInAt: unknown, now: number = Date.now()): number | null {
  if (typeof signedInAt !== 'number' || !Number.isFinite(signedInAt)) return null;
  if (signedInAt > now + SIGN_IN_CLOCK_SKEW_MS) return null;
  return signedInAt;
}

/** When a sign-in stamped `signedInAt` ends (epoch ms), or null for a stamp that is not believed. */
export function signInEndsAt(signedInAt: unknown, now: number = Date.now()): number | null {
  const at = readSignedInAt(signedInAt, now);
  return at === null ? null : at + SIGN_IN_LIMIT_MS;
}

/**
 * Whether a token (or a session's user) must be refused: its stamp is missing,
 * not a number, in the future, or 8 hours or more in the past.
 */
export function signInExpired(
  t: { signedInAt?: unknown } | null | undefined,
  now: number = Date.now()
): boolean {
  const ends = signInEndsAt(t?.signedInAt, now);
  return ends === null || now >= ends;
}

/** Whether a Set-Cookie line sets (or clears) the session cookie `name`, or one of its chunks. */
function sessionCookieOf(line: string, name: string): { value: string } | null {
  const eq = line.indexOf('=');
  if (eq <= 0) return null;
  const cookieName = line.slice(0, eq).trim();
  if (cookieName !== name && !new RegExp(`^${escapeRe(name)}\\.\\d+$`).test(cookieName)) return null;
  const semi = line.indexOf(';', eq);
  return { value: line.slice(eq + 1, semi === -1 ? undefined : semi).trim() };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes every Set-Cookie that RE-ISSUES the session cookie `name` (a non-empty
 * value): Auth.js re-issues it on every session read with a fresh 8 hours, which
 * is what made the 8 hours slide. A Set-Cookie that CLEARS it (an empty value: a
 * refused or broken session, a sign-out) is kept, as is every other cookie.
 *
 * Nothing is lost by dropping the refresh: the cookie the browser already holds
 * came from the sign-in and stays good until the limit, and the Edge middleware
 * re-encodes the very claims it read (it has no jwt callback that changes them).
 * Returns how many were dropped.
 */
export function dropSessionRefreshes(headers: Headers, name: string): number {
  const lines = headers.getSetCookie();
  const kept = lines.filter((l) => {
    const c = sessionCookieOf(l, name);
    return c === null || c.value === '';
  });
  if (kept.length === lines.length) return 0;
  headers.delete('set-cookie');
  for (const l of kept) headers.append('set-cookie', l);
  return lines.length - kept.length;
}

/**
 * For a response that SIGNS SOMEONE IN (the /api/auth/callback route): every
 * Set-Cookie that sets the session cookie `name` gets an expiry no later than
 * `endsAt`, replacing the one Auth.js gave it (now + 8 hours, a few milliseconds
 * after the stamp). Returns how many were capped.
 */
export function capSessionCookies(headers: Headers, name: string, endsAt: number): number {
  const lines = headers.getSetCookie();
  let capped = 0;
  const out = lines.map((l) => {
    const c = sessionCookieOf(l, name);
    if (c === null || c.value === '') return l;
    capped += 1;
    return capLine(l, endsAt);
  });
  if (capped === 0) return 0;
  headers.delete('set-cookie');
  for (const l of out) headers.append('set-cookie', l);
  return capped;
}

/** One Set-Cookie line with Expires = min(its own, endsAt) and no Max-Age (which would win over Expires). */
function capLine(line: string, endsAt: number): string {
  const parts = line.split(';').map((p) => p.trim());
  let expires = endsAt;
  const rest: string[] = [];
  for (const p of parts.slice(1)) {
    const lower = p.toLowerCase();
    if (lower.startsWith('expires=')) {
      const t = Date.parse(p.slice('expires='.length));
      if (Number.isFinite(t)) expires = Math.min(expires, t);
      continue;
    }
    if (lower.startsWith('max-age=')) {
      const s = Number(p.slice('max-age='.length));
      if (Number.isFinite(s)) expires = Math.min(expires, Date.now() + s * 1000);
      continue;
    }
    rest.push(p);
  }
  // Expires is whole seconds: round DOWN, so the cookie never outlives endsAt.
  const at = new Date(Math.floor(expires / 1000) * 1000);
  return [parts[0], ...rest, `Expires=${at.toUTCString()}`].join('; ');
}

/** The sign-in page's hint cookie as a Set-Cookie line (see SIGN_IN_ENDS_COOKIE). */
export function signInEndsCookieLine(endsAt: number, secure: boolean): string {
  const until = new Date(endsAt + SIGN_IN_ENDS_COOKIE_EXTRA_MS);
  return [
    `${SIGN_IN_ENDS_COOKIE}=${Math.floor(endsAt)}`,
    'Path=/',
    `Expires=${until.toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/**
 * Whether the sign-in page should say the 8-hour limit signed this person out:
 * the hint cookie names a moment that has passed. A hint that is not a number,
 * or still in the future (a sign-in that is still good), says nothing.
 */
export function signedOutByLimit(hint: string | undefined | null, now: number = Date.now()): boolean {
  if (!hint || !/^\d{1,16}$/.test(hint)) return false;
  return now >= Number(hint);
}
