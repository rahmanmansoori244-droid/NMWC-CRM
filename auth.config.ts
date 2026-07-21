/**
 * Lightweight Auth.js config used by the Edge middleware.
 *
 * IMPORTANT: This file MUST NOT import anything that pulls in Prisma, bcrypt,
 * or other Node-only modules. Heavy auth logic lives in lib/auth.ts which
 * imports this config and adds DB-dependent providers/callbacks.
 *
 * See: https://authjs.dev/guides/edge-compatibility
 */
import type { NextAuthConfig } from 'next-auth';

export const authConfig = {
  pages: { signIn: '/login' },
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
  // F-UAT-3 / perf follow-up: derive the base URL from the REQUEST host when no
  // AUTH_URL env is set, so a Preview deployment's post-login redirect stays on
  // the preview domain instead of bouncing to production (where the session
  // cookie doesn't even apply). NOTE for the owner: also scope the
  // AUTH_URL / NEXTAUTH_URL Vercel env var to Production ONLY — an env var
  // pointing at nmwc-cm.vercel.app overrides this on previews.
  trustHost: true,
  providers: [], // Real providers are added in lib/auth.ts
  // AUTH-13: explicit cookie hardening — `__Secure-` prefix in production
  // forces secure+HTTPS; httpOnly + sameSite=lax block XSS reads and
  // most CSRF (combined with Next.js's Origin check on Server Actions).
  cookies: {
    sessionToken: {
      name:
        process.env.NODE_ENV === 'production'
          ? '__Secure-authjs.session-token'
          : 'authjs.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      },
    },
  },
  callbacks: {
    /**
     * Edge-safe session callback. Bubbles simple JWT fields (id, role,
     * username, mustChangePassword) into `session.user` so the Edge
     * middleware can read them via `auth.user.*`. Heavy DB-touching
     * logic lives in `lib/auth.ts` which spreads + overrides this.
     *
     * Without this, the Edge middleware sees only the DefaultSession
     * user (name/email/image) and custom fields like
     * `mustChangePassword` come through as undefined — silently
     * disabling the AUTH-09 forced-change redirect.
     */
    session({ session, token }) {
      const t = token as {
        userId?: string;
        role?: string;
        username?: string;
        mustChangePassword?: boolean;
      };
      if (session?.user) {
        const u = session.user as unknown as Record<string, unknown>;
        if (t.userId) u.id = t.userId;
        if (t.role) u.role = t.role;
        if (t.username) u.username = t.username;
        u.mustChangePassword = t.mustChangePassword === true;
      }
      return session;
    },
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      const isPublic =
        pathname === '/login' ||
        pathname.startsWith('/api/auth') ||
        pathname.startsWith('/api/health') ||
        pathname.startsWith('/_next') ||
        pathname === '/favicon.ico';
      if (isPublic) return true;
      if (!auth) return false;
      // AUTH-09: a user with mustChangePassword=true can only reach
      // /profile/change-password and the auth APIs. Force-redirect to that
      // page from anywhere else so a temp password can't be used as a
      // permanent one.
      const mustChange =
        (auth.user as { mustChangePassword?: boolean } | undefined)?.mustChangePassword === true;
      if (
        mustChange &&
        pathname !== '/profile/change-password' &&
        !pathname.startsWith('/api/auth')
      ) {
        const url = new URL('/profile/change-password', request.nextUrl);
        return Response.redirect(url);
      }
      return true;
    },
  },
} satisfies NextAuthConfig;
