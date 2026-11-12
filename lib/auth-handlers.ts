import { handlers } from '@/lib/auth';
import { authConfig } from '../auth.config';
import {
  SIGN_IN_LIMIT_MS,
  capSessionCookies,
  dropSessionRefreshes,
  signInEndsCookieLine,
} from '@/lib/sign-in-limit';

type Handler = (req: Request) => Promise<Response>;

/**
 * A6: the /api/auth routes never hand out a session cookie that outlives the
 * 8-hour sign-in limit (lib/sign-in-limit.ts).
 *
 *   /api/auth/callback/…  signs someone in: the new cookie's expiry is cut to
 *                         the moment the request began plus 8 hours (no later
 *                         than the stamp plus 8 hours), and the sign-in page's
 *                         hint is set to that moment, as the sign-in form does
 *                         (lib/sign-in-cookies.ts).
 *   any other route       (/session read or update, …) re-issues the cookie with
 *                         a fresh 8 hours: dropped, as the middleware drops it.
 *
 * A Set-Cookie that clears the session (sign-out, a refused session) goes out.
 */
export function limitSignIns(handler: Handler): Handler {
  return async (req: Request) => {
    const startedAt = Date.now();
    const res = await handler(req);
    const name = authConfig.cookies.sessionToken.name;
    let pathname = '';
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      /* a request with no readable URL is treated as not a sign-in */
    }
    try {
      if (pathname.includes('/api/auth/callback/')) {
        const endsAt = startedAt + SIGN_IN_LIMIT_MS;
        if (capSessionCookies(res.headers, name, endsAt) > 0) {
          res.headers.append(
            'set-cookie',
            signInEndsCookieLine(endsAt, authConfig.cookies.sessionToken.options.secure)
          );
        }
      } else {
        dropSessionRefreshes(res.headers, name);
      }
    } catch {
      // A response whose headers cannot be changed: the token itself still ends
      // at the limit (the jwt callbacks refuse it), so it is sent as it is.
    }
    return res;
  };
}

export const GET = limitSignIns(handlers.GET as unknown as Handler);
export const POST = limitSignIns(handlers.POST as unknown as Handler);
