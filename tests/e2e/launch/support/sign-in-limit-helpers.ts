/**
 * The 8-hour sign-in limit (owner's answer of 2026-11-11, A6) for the launch
 * specs: a session run out in the browser, the sign-in page's hint, and the
 * app's own words. Additive only: nothing here changes another support file.
 *
 * A sign-in is refused once 8 hours have passed since it was made (lib/auth.ts,
 * auth.config.ts, lib/sign-in-limit.ts). In the field the browser itself drops
 * the session cookie at that moment (its Max-Age). `runOutSignIn` instead SENDS
 * a cookie whose sign-in is past the limit — as a phone whose clock is behind
 * still sends it, or a request already on its way — so the server's own refusal
 * is what the page meets; `dropSignIn` is the browser having dropped it.
 */
import type { BrowserContext, Cookie, Page } from '@playwright/test';
import { SESSION_COOKIE } from './env';
import { mintSessionCookie, signInViaUi } from './sessions';
import type { FixtureUser } from './types';
import { SIGN_IN_ENDS_COOKIE, SIGN_IN_LIMIT_MS } from '../../../../lib/sign-in-limit';

export {
  SIGN_IN_CLOCK_SKEW_MS,
  SIGN_IN_ENDS_COOKIE,
  SIGN_IN_LIMIT_MESSAGE,
  SIGN_IN_LIMIT_MS,
  SIGN_IN_LIMIT_SECONDS,
} from '../../../../lib/sign-in-limit';
export { SIGNED_OUT_MESSAGE } from '../../../../lib/submission';
export { UPLOAD_SIGNED_OUT } from './photo-slot-words';

/**
 * PhotoCaptureSlot's ATTACH_SIGNED_OUT (components/nmwc/PhotoCaptureSlot.tsx),
 * copied as photo-slot-words.ts copies the others: the attach answered 401.
 */
export const ATTACH_SIGNED_OUT =
  'You need to sign in again, so the photo is not attached yet. Keep this page open, sign in in another tab, then tap Retry upload.';

/** What a server action answers a signed-out caller (lib/session.ts requireActor). */
export const NOT_SIGNED_IN = 'Not signed in.';

/** Past the limit by two minutes: beyond the 60 s the server allows for clocks. */
export const PAST_LIMIT_MS = SIGN_IN_LIMIT_MS + 2 * 60_000;

/**
 * The sign-in page's hint, as a sign-in leaves it (lib/sign-in-limit.ts
 * signInEndsCookieLine): the moment that sign-in ends, HttpOnly, for a day more.
 */
export function hintCookie(endsAt: number): Cookie {
  return {
    name: SIGN_IN_ENDS_COOKIE,
    value: String(Math.floor(endsAt)),
    domain: 'localhost',
    path: '/',
    expires: Math.floor((endsAt + 24 * 60 * 60 * 1000) / 1000),
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  };
}

/**
 * Replaces the context's session with `u`'s sign-in made `agoMs` ago (default:
 * just past the limit), a cookie the browser still sends for an hour. With
 * `hint` (default) the sign-in page's hint is set as that sign-in left it.
 * Returns when that sign-in ended.
 */
export async function runOutSignIn(
  ctx: BrowserContext,
  u: FixtureUser,
  o: { hint?: boolean; agoMs?: number } = {}
): Promise<{ signedInAt: number; endsAt: number }> {
  const signedInAt = Date.now() - (o.agoMs ?? PAST_LIMIT_MS);
  const cookie = await mintSessionCookie(u, { signedInAt });
  cookie.expires = Math.floor(Date.now() / 1000) + 3600;
  await ctx.clearCookies({ name: SESSION_COOKIE });
  await ctx.addCookies([
    cookie,
    ...(o.hint === false ? [] : [hintCookie(signedInAt + SIGN_IN_LIMIT_MS)]),
  ]);
  return { signedInAt, endsAt: signedInAt + SIGN_IN_LIMIT_MS };
}

/** The browser has dropped the session cookie at the limit (its Max-Age); the hint stays. */
export async function dropSignIn(ctx: BrowserContext, endsAt = Date.now() - 60_000): Promise<void> {
  await ctx.clearCookies({ name: SESSION_COOKIE });
  await ctx.addCookies([hintCookie(endsAt)]);
}

/** The session cookies the context holds (the cookie and any chunk of it). */
export async function sessionCookies(ctx: BrowserContext): Promise<Cookie[]> {
  return (await ctx.cookies()).filter(
    (c) => c.name === SESSION_COOKIE || c.name.startsWith(`${SESSION_COOKIE}.`)
  );
}

/** The sign-in page's hint the context holds, or undefined. */
export async function hintOf(ctx: BrowserContext): Promise<Cookie | undefined> {
  return (await ctx.cookies()).find((c) => c.name === SIGN_IN_ENDS_COOKIE);
}

/** The sentence the sign-in form shows above its fields (LoginForm `notice`, role=status). */
export function loginNotice(page: Page) {
  return page.locator('form p[role="status"]');
}

/**
 * "Keep this page open, sign in in another tab": a new tab of the same context
 * opens the sign-in page, which says why, and signs in there. Returns what the
 * sign-in page said before the sign-in ('' when nothing).
 */
export async function signInInAnotherTab(
  ctx: BrowserContext,
  u: FixtureUser,
  ip: string
): Promise<string> {
  const tab = await ctx.newPage();
  try {
    await tab.goto('/login');
    await tab.locator('form[data-hydrated="1"]').waitFor({ timeout: 60_000 });
    const said =
      (await loginNotice(tab).count()) > 0
        ? ((await loginNotice(tab).textContent()) ?? '').trim()
        : '';
    // signInViaUi returns on the first role=alert too, and Next's route announcer is one:
    // wait for the sign-in itself to land before the tab is closed.
    await signInViaUi(tab, u.username, u.password, { ip });
    await tab.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
    return said;
  } finally {
    await tab.close();
  }
}
