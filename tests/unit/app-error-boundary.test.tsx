/**
 * UAT-15 — the error boundary for the signed-in app.
 *
 * Structural rather than behavioural, and for a specific reason: what makes this
 * file work is its LOCATION. Next loads `error.tsx` as the error component for
 * the LayoutRouter rendered inside the sibling layout, so a file that renders
 * perfectly but sits one directory up keeps the chrome for nobody. Rendering it
 * in jsdom would prove the markup and prove nothing about the thing that was
 * actually broken.
 *
 * The contract it must not break is that the raw error message never reaches the
 * screen. A Prisma error carries the conflicting value, so a unique-constraint
 * failure on a phone number would print that phone number in front of whoever is
 * standing next to the user. Only the digest.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const APP_BOUNDARY = 'app/(app)/error.tsx';
const ROOT_BOUNDARY = 'app/error.tsx';

describe('the signed-in app has its own error boundary', () => {
  it('sits beside the (app) layout, which is what keeps the navigation mounted', () => {
    // If this file moves, every throw in the group takes the whole shell down
    // again and nothing else notices.
    expect(existsSync(APP_BOUNDARY), `${APP_BOUNDARY} must exist`).toBe(true);
    expect(existsSync('app/(app)/layout.tsx')).toBe(true);
    // The two it does not replace.
    expect(existsSync(ROOT_BOUNDARY)).toBe(true);
    expect(existsSync('app/global-error.tsx')).toBe(true);
  });

  // Comments stripped before any structural match. This file's comments quote the
  // very things being asserted against — "reset() only clears…", "not a <Link>" —
  // so a raw search finds the explanation rather than the code, and passes or
  // fails for the wrong reason. Same lesson as tests/unit/audit-envelope.ts.
  const raw = existsSync(APP_BOUNDARY) ? readFileSync(APP_BOUNDARY, 'utf8') : '';
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('is a Client Component, or Next cannot use it as a boundary at all', () => {
    expect(src.trimStart().startsWith("'use client'")).toBe(true);
  });

  it('takes the error and reset props Next passes it', () => {
    expect(src).toMatch(/error\s*,/);
    expect(src).toMatch(/reset\s*,/);
    expect(src).toMatch(/reset\(\)/);
  });

  it('refreshes before resetting, or Try again cannot recover a server error', () => {
    // reset() only clears the boundary's own state. Almost everything that lands
    // here was thrown rendering a Server Component, and re-rendering the same
    // cached payload throws again — so without the refresh the card comes back
    // forever, even after the database recovers.
    expect(src).toMatch(/router\.refresh\(\)/);
    expect(src.indexOf('router.refresh()')).toBeLessThan(src.indexOf('reset()'));
  });

  it('escapes with a full document load, not a soft navigation', () => {
    // /home redirects each role to its own landing page, and for a SUPERVISOR
    // that is /approvals — so a soft link after an approvals failure goes
    // straight back to the route that threw, with the failed payload cached.
    expect(src).toMatch(/<a\s+href="\/home"/);
    expect(src).not.toMatch(/<Link/);
  });

  it('reports, so a failure a user sees is a failure someone hears about', () => {
    expect(src).toMatch(/Sentry\.captureException\(/);
    expect(src).toMatch(/logger\.error\(/);
  });

  it('never renders the raw error message, only the digest', () => {
    // The contract the root boundary states and this one inherits.
    expect(src).toMatch(/error\.digest/);
    expect(src).not.toMatch(/\{error\.message\}/);
    expect(src).not.toMatch(/String\(error\)/);
  });

  it('offers a way out that is not the login screen', () => {
    // The layout validated the session before this rendered, so the session is
    // intact; sending a working user to sign in again would be a regression in
    // disguise. It must still offer somewhere to go, or the user is stranded on
    // a dead page with only the browser back button.
    expect(src).toMatch(/href="\/home"/);
    expect(src).not.toMatch(/href="\/login"/);
  });

  it('is sized for the content column, not the viewport', () => {
    // min-h-screen here would push the still-mounted chrome off the top of a
    // phone screen, which defeats the point of keeping it.
    expect(src).not.toMatch(/min-h-screen/);
  });
});

describe('the root boundary is still the one for everything above the app', () => {
  it('keeps its own full-viewport treatment and its sign-in escape', () => {
    // There the chrome is genuinely gone and the session may be the problem.
    const root = readFileSync(ROOT_BOUNDARY, 'utf8');
    expect(root).toMatch(/min-h-screen/);
    expect(root).toMatch(/\/login/);
  });
});
