/**
 * A6: the cookie side of the 8-hour sign-in limit, for the server actions that
 * sign someone in (loginAction in app/actions/auth.ts, renewOwnSession in
 * services/password.ts) and for logoutAction. lib/sign-in-limit.ts has the rule.
 *
 * Auth.js gives a new session cookie an expiry of "now + 8 hours", worked out a
 * few milliseconds AFTER it stamped the sign-in, so the cookie would outlive the
 * limit by those milliseconds. limitSignInCookie() sets it again with an expiry
 * no later than `startedAt` + 8 hours, `startedAt` being read before the sign-in
 * began (so before the stamp), and sets the sign-in page's hint
 * (SIGN_IN_ENDS_COOKIE) to that same moment.
 *
 * Never throws: the sign-in itself has already happened, and the limit is also
 * enforced on the token (lib/auth.ts, auth.config.ts), so a cookie that could not
 * be set again here still stops working at the limit.
 */
import { cookies } from 'next/headers';
import { authConfig } from '../auth.config';
import {
  SIGN_IN_ENDS_COOKIE,
  SIGN_IN_ENDS_COOKIE_EXTRA_MS,
  SIGN_IN_LIMIT_MS,
  sessionCookieMaxAge,
} from './sign-in-limit';

/** The session cookie's name, and the chunk names Auth.js uses for a large token. */
function sessionCookieNames(): string[] {
  const name = authConfig.cookies.sessionToken.name;
  return [name, ...Array.from({ length: 10 }, (_, i) => `${name}.${i}`)];
}

type JarCookie = { name: string; value: string; expires?: Date | number; maxAge?: number; [k: string]: unknown };

export async function limitSignInCookie(startedAt: number): Promise<void> {
  const endsAt = startedAt + SIGN_IN_LIMIT_MS;
  try {
    const jar = await cookies();
    let signedIn = false;
    for (const name of sessionCookieNames()) {
      const c = jar.get(name) as JarCookie | undefined;
      if (!c || !c.value) continue;
      signedIn = true;
      const own = c.expires === undefined ? Number.POSITIVE_INFINITY : new Date(c.expires).getTime();
      // Whole seconds, rounded down: Set-Cookie's Expires has no milliseconds.
      const at = Math.floor(Math.min(own, endsAt) / 1000) * 1000;
      // Review of A6: Max-Age as well, counted from now, so a phone whose clock
      // runs fast does not drop the cookie early (lib/sign-in-limit.ts capLine).
      jar.set({ ...c, name: c.name, value: c.value, expires: new Date(at), maxAge: sessionCookieMaxAge(at) });
    }
    if (!signedIn) return;
    jar.set({
      name: SIGN_IN_ENDS_COOKIE,
      value: String(endsAt),
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: authConfig.cookies.sessionToken.options.secure,
      expires: new Date(endsAt + SIGN_IN_ENDS_COOKIE_EXTRA_MS),
    });
  } catch {
    /* outside a request, or headers already sent: the token itself still ends at the limit */
  }
}

/** Sign out: the hint goes too, so a person who signed out is never told the limit did it. */
export async function forgetSignInEnds(): Promise<void> {
  try {
    const jar = await cookies();
    if (jar.get(SIGN_IN_ENDS_COOKIE)) jar.delete(SIGN_IN_ENDS_COOKIE);
  } catch {
    /* outside a request: nothing to forget */
  }
}
