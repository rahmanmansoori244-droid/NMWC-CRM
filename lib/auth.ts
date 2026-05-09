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

// QA-023: assert AUTH_SECRET is present and strong in production.
function assertAuthSecret() {
  if (process.env.NODE_ENV !== 'production') return;
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'AUTH_SECRET is missing or too short (<32 chars). Refusing to start in production.'
    );
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
    } & DefaultSession['user'];
  }
  interface User {
    role: Role;
    username: string;
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    role: Role;
    username: string;
    userId: string;
    lastCheck?: number;
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
    async jwt({ token, user }) {
      // Fresh login: copy claims from the authorize() result and stamp the
      // freshness clock so we don't immediately re-query the DB.
      if (user) {
        token.userId = user.id!;
        token.role = (user as { role: Role }).role;
        token.username = (user as { username: string }).username;
        token.lastCheck = Date.now();
        return token;
      }
      // PROD-002/003: periodically reconcile the in-flight JWT with the User
      // row so disabling a user or changing their role takes effect within
      // ~5 minutes instead of the full 8h JWT TTL.
      const lastCheck = token.lastCheck ?? 0;
      if (Date.now() - lastCheck < JWT_FRESHNESS_MS) return token;
      try {
        const fresh = await prisma.user.findUnique({
          where: { id: String(token.userId) },
          select: { id: true, role: true, isActive: true, username: true },
        });
        if (!fresh || !fresh.isActive) {
          // Returning null invalidates the session; the next auth() call
          // resolves to no user and the protected route redirects to /login.
          logger.warn(
            { userId: token.userId, reason: !fresh ? 'missing' : 'inactive' },
            'session.revoked'
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
        const { username, password } = parsed.data;

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
        };
      },
    }),
  ],
});
