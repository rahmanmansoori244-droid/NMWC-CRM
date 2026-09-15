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

// F-UAT-3: the Edge middleware builds its own Auth.js instance from this config, so
// the production AUTH_URL has to be dropped here too — otherwise a Preview
// deployment reports nmwc-cm.vercel.app as its sign-in/callback URL and every
// sign-in bounces to production. VERCEL_ENV is set by Vercel on every deployment;
// on anything but production the request host (trustHost) is the URL.
if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
  delete process.env.AUTH_URL;
  delete process.env.NEXTAUTH_URL;
}

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
  // AUTH-13 / SEC-14c: cookie hardening, with the mechanism stated correctly.
  //
  // The previous comment here said the `__Secure-` prefix "forces secure+HTTPS".
  // It does not force anything on the server: `secure: true` below sets the
  // attribute, and the PREFIX is a browser-enforced assertion — the browser
  // refuses to store a `__Secure-` cookie that arrives without Secure. Likewise
  // httpOnly blocks script READS of the cookie; it does not block XSS.
  //
  // The prefix is now `__Host-`, which additionally refuses any cookie carrying a
  // Domain attribute. That closes nothing today: vercel.app is on the Public
  // Suffix List, so no sibling deployment can set `Domain=vercel.app`, and this
  // config sets no domain, so the cookie is already host-only. It is done now
  // because it is free now. The moment this CRM moves to a custom domain — which
  // docs/OPERATIONS.md defers to post-pilot — the parent becomes a registrable
  // domain, and any other host under it (a marketing site, a supplier portal, a
  // stale staging box with an XSS or a subdomain takeover) could set this exact
  // cookie name with a Domain attribute and have it delivered alongside the real
  // one, with no way for the server to tell them apart. That is session fixation,
  // and the hole opens automatically at the DNS cutover rather than being
  // introduced by anybody.
  //
  // Worth knowing: Auth.js already gives the CSRF token the strict `__Host-`
  // prefix. Overriding only the session token left the actual bearer credential
  // weaker than a less sensitive sibling.
  //
  // DO NOT add a `domain` option below. It voids the `__Host-` prefix, the
  // browser drops every Set-Cookie, and NOBODY can sign in.
  //
  // One standing footgun, neither created nor fixed here: this picks the prefix
  // from NODE_ENV, while @auth/core derives useSecureCookies from
  // `config.useSecureCookies ?? url.protocol === 'https:'`. Run a production-mode
  // server over plain http://localhost — which qa/evidence/uat-live-run.md records
  // the team doing — and the app emits a prefixed, Secure cookie the browser then
  // drops, so login silently fails to persist. `__Host-` has the identical Secure
  // requirement, so this is no worse than before.
  cookies: {
    sessionToken: {
      name:
        process.env.NODE_ENV === 'production'
          ? '__Host-authjs.session-token'
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
        // Bearer-authenticated machine endpoints: they carry CRON_SECRET and
        // check it themselves, and no session exists on a scheduler's request.
        pathname.startsWith('/api/cron') ||
        pathname.startsWith('/api/ops') ||
        pathname.startsWith('/_next') ||
        pathname === '/favicon.ico';
      if (isPublic) return true;
      // DO NOT "fix" this into a redirect without reading the whole comment.
      //
      // This boolean is DISCARDED. In next-auth 5.0.0-beta.31, handleAuth
      // checks `authorized instanceof Response`, then `userMiddlewareOrRoute`,
      // then `!authorized` — and middleware.ts wraps a function (the CSP-nonce
      // middleware), so the second branch always wins and the third is
      // unreachable. The Response.redirect below, for mustChangePassword, DOES
      // fire, which is why one half of this callback works and this half does
      // not.
      //
      // Nothing is exposed by that: app/(app)/layout.tsx calls auth() and
      // redirects, every page and route handler re-checks, and server actions
      // call requireSession(). This line is defence in depth that is not
      // currently in depth.
      //
      // The obvious repair — return Response.redirect('/login') — would also
      // redirect RSC fetches and Server Action POSTs. That is precisely the
      // failure recorded in docs/SESSION-MASTER-RECORD.md §143(d): a middleware
      // redirect on a Server Action POST gave users "An unexpected response was
      // received from the server" and they could not sign in. If you make this
      // return a Response, exclude RSC and action requests and prove it with a
      // real browser pass, not a unit test.
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
