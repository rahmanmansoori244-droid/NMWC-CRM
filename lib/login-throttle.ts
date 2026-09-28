/**
 * F22: how a throttled sign-in is told apart from a wrong password.
 *
 * The login buckets (`login:user:<name>`, `login:ip:<ip>`) are charged in ONE
 * place, authorize() in lib/auth.ts, because that is the only step every sign-in
 * passes through: /api/auth/callback/credentials is public and reaches it without
 * the login form. The form's action used to charge both buckets as well, before
 * calling signIn(), so every form login cost two tokens per bucket and a correct
 * password on the third quick try was told "Invalid username or password".
 *
 * authorize() now THROWS one of these instead of returning null. It is a
 * CredentialsSignin, so Auth.js passes it through unchanged — to loginAction's
 * catch (server-side signIn runs Auth.js in raw mode and rethrows AuthErrors), and
 * on the direct callback route into the redirect as `?error=CredentialsSignin&code=…`.
 * The code names only which bucket ran dry. Both are keyed on the string typed,
 * not on an account, so it says nothing about whether the username exists.
 */
import { AuthError, CredentialsSignin } from 'next-auth';

export const LOGIN_LOCKED_USER = 'locked_user';
export const LOGIN_THROTTLED_IP = 'throttled_ip';

export class LoginThrottledError extends CredentialsSignin {
  readonly retryAfterSec: number;
  constructor(bucket: 'user' | 'ip', retryAfterSec: number) {
    super();
    this.code = bucket === 'user' ? LOGIN_LOCKED_USER : LOGIN_THROTTLED_IP;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * The login form's message for a failed signIn(). AUTH-19: a per-user lockout
 * and a per-network throttle read differently — the owner of an account being
 * hammered from elsewhere should see "account locked", not "too many attempts"
 * they never made. Everything else is the one opaque "Invalid" message.
 */
export function loginFailureMessage(error: AuthError): string {
  if (error instanceof CredentialsSignin) {
    if (error.code === LOGIN_LOCKED_USER) {
      return 'Account temporarily locked due to repeated attempts. Try again in a minute.';
    }
    if (error.code === LOGIN_THROTTLED_IP) {
      const wait = error instanceof LoginThrottledError ? error.retryAfterSec : 60;
      return `Too many attempts from your network. Try again in ${wait}s.`;
    }
  }
  return 'Invalid username or password.';
}
