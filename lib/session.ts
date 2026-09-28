/**
 * Session helpers used in server components and server actions.
 *
 * F15 / X-AUTH-1: every server action and API route handler that acts for a
 * signed-in user goes through checkActor()/requireActor(), never a bare auth().
 * A session that still carries mustChangePassword (AUTH-09) is refused there,
 * so the forced password change no longer rests on the Edge middleware's path
 * check alone: that check lets /profile/change-password through, and Next runs
 * any server action the page's worker holds when it is POSTed to that path.
 * The only callers allowed through with the flag set are the password change
 * itself (services/password.ts) and logoutAction, which reads auth() directly
 * because it must work signed out too. tests/unit/actor-guard.test.ts pins both.
 *
 * Pages are not guarded here: the middleware redirects a flagged session to
 * /profile/change-password before any other page renders, and a page that
 * refused it too would loop with that redirect.
 */
import { redirect } from 'next/navigation';
import type { Session } from 'next-auth';
import { auth } from '@/lib/auth';
import { Role } from '@prisma/client';
import type { SessionUser } from '@/lib/permissions';
import { ForbiddenError, PasswordChangeRequiredError } from '@/lib/errors';

/** For a page: the signed-in user, or a redirect to /login. Not for actions. */
export async function requireSession(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user) redirect('/login');
  return {
    id: session.user.id,
    role: session.user.role,
    username: session.user.username,
  };
}

export type Actor = Session['user'];

export type ActorCheck =
  | { ok: true; user: Actor }
  | { ok: false; status: 401; code: 'SIGNED_OUT'; message: string }
  | { ok: false; status: 403; code: 'PASSWORD_CHANGE_REQUIRED'; message: string };

type ActorOptions = {
  /** Only the password change itself may pass this (services/password.ts). */
  allowPasswordChange?: boolean;
};

/**
 * The acting user, or why not — for a route handler, which answers with a status.
 * `mustChangePassword` is refreshed from the database at every JWT freshness
 * re-read (lib/auth.ts), so it is as current as the session's role.
 */
export async function checkActor(opts: ActorOptions = {}): Promise<ActorCheck> {
  const session = await auth();
  if (!session?.user) {
    return { ok: false, status: 401, code: 'SIGNED_OUT', message: 'Not signed in.' };
  }
  if (session.user.mustChangePassword === true && !opts.allowPasswordChange) {
    const refused = new PasswordChangeRequiredError();
    return { ok: false, status: 403, code: refused.code, message: refused.message };
  }
  return { ok: true, user: session.user };
}

/** The acting user, for a server action: throws what runAction turns into `{ ok: false }`. */
export async function requireActor(opts: ActorOptions = {}): Promise<Actor> {
  const who = await checkActor(opts);
  if (who.ok) return who.user;
  if (who.code === 'SIGNED_OUT') throw new ForbiddenError('Not signed in.');
  throw new PasswordChangeRequiredError();
}

export async function requireRole(allowed: Role[]): Promise<SessionUser> {
  const user = await requireActor();
  if (!allowed.includes(user.role)) {
    throw new ForbiddenError(`Role ${user.role} not allowed.`);
  }
  return { id: user.id, role: user.role, username: user.username };
}
