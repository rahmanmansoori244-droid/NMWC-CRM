/**
 * F1 (2026-10-05): whether this deployment may send notification e-mail, and
 * with what. The ONLY reader of the e-mail environment variables
 * (tests/unit/email-structure-guard.test.ts), read on every call so a test can
 * set them; Vercel reads them at instance start, so a change needs a redeploy.
 *
 *   NOTIFY_EMAIL_ENABLED  the kill switch: sends only when exactly 'on'. Unset,
 *                         the drain does nothing at all — not even read the
 *                         outbox. It stays off until the owner turns it on.
 *   GMAIL_ADDRESS         the sending mailbox (the owner's Gmail, his decision):
 *                         SMTP user and From address. smtp.gmail.com:465, TLS.
 *   GMAIL_APP_PASSWORD    that mailbox's app password. SECRET: it opens the whole
 *                         mailbox. Never logged or echoed; lib/sentry-scrub.ts
 *                         redacts its exact value; lib/email/transport.ts reports
 *                         only a constrained error label, never err.message.
 *   EMAIL_REDIRECT_TO     every message goes to this one inbox instead, its
 *                         subject marked [UAT] (or [REDIRECTED] on production).
 *                         Off production nothing is sent WITHOUT it: UAT is a copy
 *                         of production and holds real staff addresses.
 *   EMAIL_LINK_ORIGIN     the origin links are built on (https, no path). Named so
 *                         it collides with neither the GitHub variable
 *                         APP_BASE_URL (lib/ops/required-secrets.ts lists exactly
 *                         what workflows read, and a runtime-only variable of that
 *                         name would read as one of them) nor NMWC_APP_URL (the
 *                         nmwc_app database URL in CI). Unset, production uses
 *                         https://nmwc-cm.vercel.app — the production alias the
 *                         workflows already fall back to and AUDITOR-BRIEF names —
 *                         and a preview uses its own VERCEL_URL, so a test e-mail
 *                         never links to production. AUTH_URL cannot serve: it is
 *                         deleted off production (lib/auth.ts).
 *
 * Sending also needs: not MAINTENANCE_MODE (the cron routes stay open during
 * maintenance, lib/maintenance.ts, and a restore may roll back the rows), and
 * either the production deployment or EMAIL_REDIRECT_TO.
 */
import { isProductionDeployment } from '../health';
import { isEmailAddress } from '../notify-address';

// The address rule is shared with /users and the readiness check (lib/notify-address.ts).
export { isEmailAddress };

/** The production alias (see the header). */
export const DEFAULT_PRODUCTION_LINK_ORIGIN = 'https://nmwc-cm.vercel.app';

export const GMAIL_SMTP = { host: 'smtp.gmail.com', port: 465, secure: true } as const;

export type EmailOffReason =
  | 'disabled'
  | 'maintenance'
  | 'unconfigured'
  | 'not-production'
  | 'bad-redirect'
  | 'bad-link-origin';

export type SendConfig = {
  send: true;
  user: string;
  pass: string;
  /** "NMWC CRM <address>" */
  from: string;
  linkOrigin: string;
  /** Every message goes here instead, when set. */
  redirectTo: string | null;
  /** '' in production without a redirect; '[UAT] ' / '[REDIRECTED] ' otherwise. */
  subjectPrefix: string;
  production: boolean;
};

export type EmailConfig = { send: false; reason: EmailOffReason } | SendConfig;

/** The origin of an https URL with nothing after it, or null. */
function originOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function readEmailConfig(): EmailConfig {
  if (process.env.NOTIFY_EMAIL_ENABLED !== 'on') return { send: false, reason: 'disabled' };
  if (process.env.MAINTENANCE_MODE === 'on') return { send: false, reason: 'maintenance' };

  const user = (process.env.GMAIL_ADDRESS ?? '').trim();
  // The app password is used exactly as stored: Google shows it in four groups of
  // four and accepts it with or without the spaces.
  const pass = process.env.GMAIL_APP_PASSWORD ?? '';
  if (!isEmailAddress(user) || pass.trim() === '') return { send: false, reason: 'unconfigured' };

  const production = isProductionDeployment();
  const redirectRaw = (process.env.EMAIL_REDIRECT_TO ?? '').trim();
  const redirectTo = redirectRaw === '' ? null : redirectRaw;
  if (redirectTo !== null && !isEmailAddress(redirectTo)) return { send: false, reason: 'bad-redirect' };
  if (!production && redirectTo === null) return { send: false, reason: 'not-production' };

  const originRaw = (process.env.EMAIL_LINK_ORIGIN ?? '').trim();
  let linkOrigin: string | null;
  if (originRaw !== '') linkOrigin = originOf(originRaw);
  else if (production) linkOrigin = DEFAULT_PRODUCTION_LINK_ORIGIN;
  else linkOrigin = process.env.VERCEL_URL ? originOf(`https://${process.env.VERCEL_URL}`) : null;
  if (!linkOrigin) return { send: false, reason: 'bad-link-origin' };

  return {
    send: true,
    user,
    pass,
    from: `NMWC CRM <${user}>`,
    linkOrigin,
    redirectTo,
    subjectPrefix: redirectTo === null ? '' : production ? '[REDIRECTED] ' : '[UAT] ',
    production,
  };
}
