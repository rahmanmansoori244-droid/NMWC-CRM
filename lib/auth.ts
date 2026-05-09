import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { Role } from '@prisma/client';
import { authConfig } from '../auth.config';
import { checkLimit, LOGIN_LIMIT } from '@/lib/rate-limit';

// QA-023 / AUTH-17: assert AUTH_SECRET is present, of sufficient length, AND
// not trivially low-entropy. Length alone (≥32) is a poor proxy — `aaaa…`
// would otherwise pass.
function assertAuthSecret() {
  if (process.env.NODE_ENV !== 'production') return;
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'AUTH_SECRET is missing or too short (<32 chars). Refusing to start in production.'
    );
  }
  // Reject obvious low-entropy values: all same character, all lowercase
  // letters, or all digits. Real `openssl rand -base64 32` output mixes
  // case + digits + symbols.
  if (/^(.)\1+$/.test(s) || /^[a-z]+$/.test(s) || /^[0-9]+$/.test(s)) {
    throw new Error('AUTH_SECRET appears low-entropy. Use `openssl rand -base64 32`.');
  }
}
assertAuthSecret();

// QA-024: pre-computed dummy bcrypt hash. Used to equalize timing when the
// queried username doesn't exist, so attackers cannot distinguish "no such user"
// from "wrong password" by latency.
//
// Generated once via: bcrypt.hashSync('not-a-real-password', 12)
const DUMMY_BCRYPT_HASH =
  '$2b$12$Y8HEku/bk858NwrptFSON.JoO5GZCKFOj2vays4.6KnHQ8.M8thOO';

const credentialsSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(1).max(200),
});

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: Role;
      username: string;
      mustChangePassword?: boolean;
    } & DefaultSession['user'];
  }
  interface User {
    role: Role;
    username: string;
    mustChangePassword?: boolean;
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    role: Role;
    username: string;
    userId: string;
    lastCheck?: number;
    // AUTH-12: epoch ms at which this JWT was issued. Compared on every
    // freshness re-read against User.sessionsRevokedAt so any session that
    // pre-dates a logout / disable / role-change / password-reset is killed.
    iatMs?: number;
    // AUTH-09: cleared by the change-password flow. Middleware uses this to
    // force every authenticated route to /profile/change-password until set.
    mustChangePassword?: boolean;
  }
}

// PROD-002/003: how often the JWT callback re-reads the User row to honour
// disable / role-change. Five minutes is short enough that an incident
// responder can revoke a session without waiting on the 8h JWT TTL, but long
// enough that we don't hit the DB on every request.
const JWT_FRESHNESS_MS = 5 * 60 * 1000;

async function clientIpHash(): Promise<string> {
  try {
    const h = await headers();
    const ip =
      h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? 'unknown';
    return ip;
  } catch {
    return 'unknown';
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  // QA-027: explicit same-origin redirect allowlist.
  callbacks: {
    ...authConfig.callbacks,
    redirect({ url, baseUrl }) {
      // Relative URLs OK
      if (url.startsWith('/')) return `${baseUrl}${url}`;
      // Same-origin OK
      try {
        const u = new URL(url);
        if (u.origin === baseUrl) return url;
      } catch {
        /* ignore */
      }
      return baseUrl;
    },
    async jwt({ token, user, trigger }) {
      // Fresh login: copy claims from the authorize() result and stamp the
      // freshness clock so we don't immediately re-query the DB.
      if (user) {
        token.userId = user.id!;
        token.role = (user as { role: Role }).role;
        token.username = (user as { username: string }).username;
        token.lastCheck = Date.now();
        token.iatMs = Date.now();
        token.mustChangePassword = (user as { mustChangePassword?: boolean }).mustChangePassword === true;
        return token;
      }
      // PROD-002/003 + AUTH-12: periodically reconcile the in-flight JWT with
      // the User row so disable / role-change / password-reset / explicit
      // logout takes effect within ~5 minutes instead of the full 8h JWT TTL.
      // Force re-check on `update` triggers regardless of freshness window so
      // changeOwnPasswordAction sees its own write reflected immediately.
      const lastCheck = token.lastCheck ?? 0;
      if (trigger !== 'update' && Date.now() - lastCheck < JWT_FRESHNESS_MS) return token;
      try {
        const fresh = await prisma.user.findUnique({
          where: { id: String(token.userId) },
          select: {
            id: true,
            role: true,
            isActive: true,
            username: true,
            mustChangePassword: true,
            sessionsRevokedAt: true,
          },
        });
        if (!fresh || !fresh.isActive) {
          logger.warn(
            { userId: token.userId, reason: !fresh ? 'missing' : 'inactive' },
            'session.revoked'
          );
          return null;
        }
        // AUTH-12: hard-revoke any session whose iat is older than the user's
        // sessionsRevokedAt marker. Bumped on logout / disable / role-change /
        // password-reset so a stolen cookie or a peer-resetted account dies
        // at the very next freshness check.
        if (
          fresh.sessionsRevokedAt &&
          (token.iatMs ?? 0) < fresh.sessionsRevokedAt.getTime()
        ) {
          logger.warn(
            { userId: token.userId, iatMs: token.iatMs, revokedAt: fresh.sessionsRevokedAt },
            'session.revoked_via_marker'
          );
          return null;
        }
        if (fresh.role !== token.role) {
          logger.info(
            { userId: token.userId, oldRole: token.role, newRole: fresh.role },
            'session.role_refreshed'
          );
          token.role = fresh.role;
        }
        token.username = fresh.username;
        token.mustChangePassword = fresh.mustChangePassword === true;
        token.lastCheck = Date.now();
        return token;
      } catch (err) {
        // DB hiccup: don't kill the session, just defer the next check by a
        // short grace window so we retry soon rather than every request.
        logger.warn({ err: String(err) }, 'session.refresh_failed');
        token.lastCheck = Date.now() - JWT_FRESHNESS_MS + 30_000;
        return token;
      }
    },
    session({ session, token }) {
      session.user.id = String(token.userId);
      session.user.role = token.role as Role;
      session.user.username = String(token.username);
      // AUTH-09: bubble mustChangePassword to the session so middleware can
      // gate every protected route on it.
      (session.user as { mustChangePassword?: boolean }).mustChangePassword =
        token.mustChangePassword === true;
      return session;
    },
  },
  providers: [
    Credentials({
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(creds) {
        const parsed = credentialsSchema.safeParse(creds);
        if (!parsed.success) return null;
        // AUTH-11: rate-limit + DB lookup must use a canonical lower-case
        // username. Previous code used the raw input, so an attacker could
        // burn through the per-user bucket once and continue against the
        // same account by varying case (`admin`, `Admin`, `ADMIN`, …).
        const username = parsed.data.username.toLowerCase();
        const password = parsed.data.password;

        // QA-006: rate limit BOTH the Server Action path (already wrapped) and
        // the Auth.js direct callback path, by gating the authorize() callback.
        const ip = await clientIpHash();
        for (const key of [`login:user:${username}`, `login:ip:${ip}`]) {
          const lim = await checkLimit(key, LOGIN_LIMIT);
          if (!lim.ok) {
            logger.warn(
              { key, retryAfterSec: lim.retryAfterSec },
              'rate-limit.login.authorize'
            );
            // Returning null forces the same UX as a wrong password.
            // We deliberately do NOT throw or include retry-after here, to
            // avoid leaking which usernames are real.
            // Still pay equalized bcrypt cost so timing doesn't out the limit.
            await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
            return null;
          }
        }

        const user = await prisma.user.findUnique({ where: { username } });

        // QA-022: in production, refuse "demo" usernames once
        // DEMO_ACCOUNTS_DISABLED is set. Lets the team toggle off the seed
        // accounts without deleting their rows from the DB.
        const isDemo =
          /^(salesman\.|supervisor\.|manager\.[ab]$|steward$|viewer$)/.test(username) ||
          username === 'admin';
        if (isDemo && process.env.DEMO_ACCOUNTS_DISABLED === 'true') {
          await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
          logger.warn({ username }, 'login.demo_disabled');
          return null;
        }

        // QA-024: always run a bcrypt compare so timing is constant whether
        // or not the user exists.
        const hashToCheck = user?.isActive ? user.passwordHash : DUMMY_BCRYPT_HASH;
        const ok = await bcrypt.compare(password, hashToCheck);
        if (!user || !user.isActive || !ok) return null;

        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        logger.info({ userId: user.id, username: user.username }, 'login.success');

        return {
          id: user.id,
          name: user.fullName,
          email: user.email ?? undefined,
          username: user.username,
          role: user.role,
          mustChangePassword: user.mustChangePassword,
        };
      },
    }),
  ],
});
