/**
 * The Content-Security-Policy, in one place.
 *
 * There are two emitters and there have always been two: `middleware.ts` builds
 * the real, per-request policy with a nonce, and `next.config.ts` carries a
 * stricter static fallback that Next applies before middleware runs. Until now
 * both strings were written out by hand, and they had already drifted — neither
 * declared `base-uri`, `form-action` or `object-src`, and no test asserted either
 * string even though the security-remediation record asked for one precisely
 * because the policies were duplicated.
 *
 * SEC-14b — why those three:
 *   - `form-action 'self'`. Does NOT fall back to `default-src`, so its absence
 *     meant every page in this app could submit a form to any host on the
 *     internet. That is the directive that blunts SEC-14e: the photo route used
 *     to serve attacker-chosen HTML from this origin, and a fake "your session
 *     expired" form on such a page could post an approver's credentials anywhere.
 *   - `base-uri 'none'`. Also no fallback. It is the one real bypass left against
 *     a nonce + `strict-dynamic` policy: an injected `<base href>` re-roots Next's
 *     relative chunk `<script src>` tags off-origin, and the nonce authorises the
 *     load. There is no HTML-injection sink in the tree today, so this closes a
 *     route rather than an exposure.
 *   - `object-src 'none'`. This one was already covered by `default-src 'self'`,
 *     so it is a tightening from 'self' to 'none', NOT a bypass being closed.
 *
 * THREE THINGS NOT TO DO TO THIS FILE:
 *
 * 1. Do not place any directive whose name begins with `script-src` ahead of
 *    `script-src` itself. Next extracts the nonce with
 *    `directives.find(d => d.startsWith('script-src'))` over the `;`-split request
 *    header. A `script-src-elem` sitting first returns the wrong directive, the
 *    nonce comes back undefined, `app/layout.tsx` receives a null `x-nonce`, Next
 *    stops stamping its inline bootstrap, and production renders blank. That is
 *    the failure recorded in docs/CHANGELOG.md, where a strict CSP had to be
 *    reverted to 'unsafe-inline' as an emergency hotfix.
 *
 * 2. Do not touch `script-src`, `style-src` or the nonce plumbing while adding a
 *    directive. Same reason. `style-src 'unsafe-inline'` stays because Tailwind's
 *    runtime injects inline <style> blocks; removing it is separate work.
 *
 * 3. Do not add a policy to the maintenance 503. `lib/maintenance.ts` is a fixed
 *    string with one inline <style>, no script, no form and no user input, and it
 *    is the page that has to render when everything else is down.
 *
 * WHAT REAL RESPONSES CARRY, measured against production at commit a84a646 on
 * 2026-09-15 rather than reasoned about:
 *   - a document (`GET /login`): exactly ONE Content-Security-Policy header, the
 *     nonce'd one, and Next stamped 17 nonce'd script tags into the page — which
 *     is the check that matters, because a nonce the framework cannot find is how
 *     production renders blank;
 *   - a redirect (`GET /customers` while signed out, 307): one header, also the
 *     nonce'd policy. Middleware runs on it;
 *   - a 404: one header.
 *
 * TWO RESPONSES STILL RETURN BEFORE THE WRAPPER and could not be measured without
 * a session or a maintenance window: the AUTH-09 forced-password-change redirect,
 * which `auth.config.ts` returns as a Response that next-auth takes before the
 * middleware body runs, and the maintenance 503. Both are bodyless or script-free,
 * so nothing is exposed either way. Do not upgrade this to a claim about which
 * policy they carry until someone has actually read those two responses' headers.
 */

/**
 * @param nonce when given, the per-request policy: `'nonce-…' 'strict-dynamic'`,
 *              plus `'unsafe-eval'` outside production. When omitted, the static
 *              fallback, whose `script-src` is exactly `'self'`.
 *
 * Both environment reads are inside the body so a test can flip `NODE_ENV`; in
 * the Edge bundle `NODE_ENV` is inlined at build time either way.
 */
export function buildCsp(nonce?: string): string {
  const r2AccountId = process.env.R2_ACCOUNT_ID ?? '*';

  // `next dev` serves a webpack runtime that evaluates source-mapped modules via
  // eval(); without 'unsafe-eval' the browser throws EvalError in main-app.js and
  // NOTHING hydrates — every client component (login, enrichment form, photo
  // slots) is dead in local development, which is how the go-live browser walk
  // found it. Production bundles need no eval, so the directive is dev-only.
  const devScriptSrc = process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'";

  const scriptSrc = nonce ? `'self' 'nonce-${nonce}' 'strict-dynamic'${devScriptSrc}` : `'self'`;

  return (
    `default-src 'self'; ` +
    `base-uri 'none'; ` +
    `object-src 'none'; ` +
    `form-action 'self'; ` +
    `frame-ancestors 'none'; ` +
    `img-src 'self' blob: data:; ` +
    `script-src ${scriptSrc}; ` +
    `style-src 'self' 'unsafe-inline'; ` +
    `font-src 'self' data:; ` +
    `connect-src 'self' https://${r2AccountId}.r2.cloudflarestorage.com https://*.ingest.sentry.io https://*.ingest.de.sentry.io;`
  );
}
