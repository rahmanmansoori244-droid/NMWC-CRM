// @vitest-environment node
/**
 * F1 (2026-10-05): when this deployment may send notification e-mail
 * (lib/email/config.ts). Off unless switched on; never during maintenance; never
 * off production unless every message is redirected to one test inbox; links on
 * an https origin that is never production's on a preview.
 *
 * Synthetic values only. The "password" is zero-entropy, as gitleaks expects of
 * a fixture (tests/unit/cron-scheduler.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_PRODUCTION_LINK_ORIGIN, GMAIL_SMTP, isEmailAddress, readEmailConfig } from '@/lib/email/config';

const NAMES = [
  'NOTIFY_EMAIL_ENABLED',
  'MAINTENANCE_MODE',
  'GMAIL_ADDRESS',
  'GMAIL_APP_PASSWORD',
  'EMAIL_REDIRECT_TO',
  'EMAIL_LINK_ORIGIN',
  'VERCEL_ENV',
  'VERCEL_URL',
] as const;
const saved: Record<string, string | undefined> = {};
const PASS = 'x'.repeat(16);

function set(env: Partial<Record<(typeof NAMES)[number], string>>) {
  for (const n of NAMES) delete process.env[n];
  Object.assign(process.env, env);
}
const PROD = {
  NOTIFY_EMAIL_ENABLED: 'on',
  GMAIL_ADDRESS: 'sender@example.test',
  GMAIL_APP_PASSWORD: PASS,
  VERCEL_ENV: 'production',
};

beforeEach(() => {
  for (const n of NAMES) saved[n] = process.env[n];
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe('readEmailConfig', () => {
  it('is off unless the switch says exactly "on"', () => {
    for (const v of [undefined, '', 'true', '1', 'ON', 'yes']) {
      set({ ...PROD, NOTIFY_EMAIL_ENABLED: v as string });
      expect(readEmailConfig(), String(v)).toEqual({ send: false, reason: 'disabled' });
    }
  });

  it('sends nothing during maintenance', () => {
    set({ ...PROD, MAINTENANCE_MODE: 'on' });
    expect(readEmailConfig()).toEqual({ send: false, reason: 'maintenance' });
  });

  it('needs both Gmail settings, and an address that is one', () => {
    set({ ...PROD, GMAIL_APP_PASSWORD: '' });
    expect(readEmailConfig()).toEqual({ send: false, reason: 'unconfigured' });
    set({ ...PROD, GMAIL_ADDRESS: '' });
    expect(readEmailConfig()).toEqual({ send: false, reason: 'unconfigured' });
    set({ ...PROD, GMAIL_ADDRESS: 'sender at example' });
    expect(readEmailConfig()).toEqual({ send: false, reason: 'unconfigured' });
  });

  it('production: Gmail over implicit TLS, links on the production alias, no subject mark', () => {
    set(PROD);
    const c = readEmailConfig();
    expect(c).toMatchObject({
      send: true,
      user: 'sender@example.test',
      from: 'NMWC CRM <sender@example.test>',
      linkOrigin: DEFAULT_PRODUCTION_LINK_ORIGIN,
      redirectTo: null,
      subjectPrefix: '',
      production: true,
    });
    expect(GMAIL_SMTP).toEqual({ host: 'smtp.gmail.com', port: 465, secure: true });
  });

  it('off production it sends nothing unless every message is redirected', () => {
    for (const VERCEL_ENV of ['preview', 'development', '']) {
      set({ ...PROD, VERCEL_ENV, VERCEL_URL: 'nmwc-uat-abc.vercel.app' });
      expect(readEmailConfig(), VERCEL_ENV).toEqual({ send: false, reason: 'not-production' });
    }
    // No VERCEL_ENV at all (a laptop, CI): not the production deployment either.
    const { VERCEL_ENV: _omit, ...local } = PROD;
    set(local);
    expect(process.env.VERCEL_ENV).toBeUndefined();
    expect(readEmailConfig()).toEqual({ send: false, reason: 'not-production' });
  });

  it('a preview with a redirect: one inbox, [UAT] on the subject, links on the preview itself', () => {
    set({ ...PROD, VERCEL_ENV: 'preview', VERCEL_URL: 'nmwc-uat-abc.vercel.app', EMAIL_REDIRECT_TO: ' tester@example.test ' });
    expect(readEmailConfig()).toMatchObject({
      send: true,
      redirectTo: 'tester@example.test',
      subjectPrefix: '[UAT] ',
      linkOrigin: 'https://nmwc-uat-abc.vercel.app',
      production: false,
    });
  });

  it('a redirect on production is honoured and marked, so a dry run never reaches staff', () => {
    set({ ...PROD, EMAIL_REDIRECT_TO: 'tester@example.test' });
    expect(readEmailConfig()).toMatchObject({ send: true, redirectTo: 'tester@example.test', subjectPrefix: '[REDIRECTED] ' });
  });

  it('refuses a redirect that is not an address rather than sending to staff', () => {
    set({ ...PROD, EMAIL_REDIRECT_TO: 'tester@example.test\r\nBcc: x@example.test' });
    expect(readEmailConfig()).toEqual({ send: false, reason: 'bad-redirect' });
  });

  it('EMAIL_LINK_ORIGIN: an https origin only; with neither it nor VERCEL_URL a preview cannot send', () => {
    set({ ...PROD, EMAIL_LINK_ORIGIN: 'https://crm.example.test/' });
    expect(readEmailConfig()).toMatchObject({ linkOrigin: 'https://crm.example.test' });
    for (const bad of ['http://crm.example.test', 'https://crm.example.test/approvals', 'https://crm.example.test/?x=1', 'not a url', 'https://u:p@crm.example.test']) {
      set({ ...PROD, EMAIL_LINK_ORIGIN: bad });
      expect(readEmailConfig(), bad).toEqual({ send: false, reason: 'bad-link-origin' });
    }
    set({ ...PROD, VERCEL_ENV: 'preview', EMAIL_REDIRECT_TO: 'tester@example.test' });
    expect(readEmailConfig()).toEqual({ send: false, reason: 'bad-link-origin' });
  });

  it('the password is passed on as stored and appears in no other field', () => {
    set({ ...PROD, GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' });
    const c = readEmailConfig();
    if (!c.send) throw new Error('expected send');
    expect(c.pass).toBe('abcd efgh ijkl mnop');
    const { pass: _pass, ...rest } = c;
    expect(JSON.stringify(rest)).not.toContain('abcd');
  });
});

describe('isEmailAddress', () => {
  it('accepts an address and nothing that could end a header line or add a recipient', () => {
    expect(isEmailAddress('a.b@example.test')).toBe(true);
    for (const v of ['', 'a@b', 'a b@example.test', 'a@example.test\r\n', 'a@example.test,b@example.test', '<a@example.test>', null, undefined]) {
      expect(isEmailAddress(v as string), String(v)).toBe(false);
    }
  });
});
