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
