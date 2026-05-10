import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

/**
 * Auth.js v5 middleware (Edge runtime). Auth gating + AUTH-09 force-change
 * redirect live in `auth.config.ts:authorized`.
 *
 * B-13 (Senior-audit 2026-05-10) was originally implemented here as a
 * per-request nonce + nonce'd CSP, but Next.js's automatic inline RSC
 * bootstrap `<script>(self.__next_f=...)` doesn't carry the nonce attribute
 * unless `app/layout.tsx` reads `headers().get('x-nonce')` and stamps it.
 * Without that plumbing, the strict CSP blocks bootstrap and the page
 * renders blank. Reverted here to keep production stable; the static CSP in
 * `next.config.ts` keeps `'unsafe-inline'` for now. Tracked as a follow-up:
 * plumb the nonce through layout.tsx and re-enable strict CSP without
 * 'unsafe-inline'.
 */
export const { auth: middleware } = NextAuth(authConfig);
export default middleware;

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
