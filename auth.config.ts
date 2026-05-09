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
      return !!auth;
    },
  },
} satisfies NextAuthConfig;
