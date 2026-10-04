// @vitest-environment node
/**
 * F1 (2026-10-05): the e-mail drain cron route (app/api/cron/email-drain).
 * Bearer first; with the switch off (or in maintenance) a healthy run that
 * touches nothing; switched on but unusable, a FAILED run so the operator hears
 * of it; switched on and usable, one drain over the Prisma outbox with the Gmail
 * transport, answering counts only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  key: '' as string,
  okFrom: null as null | ((body: Record<string, unknown> | null, status: number) => boolean),
  drain: vi.fn(),
  transport: vi.fn(),
  store: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { tag: 'pooled-client' } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/heartbeat', () => ({
  withHeartbeat: (key: string, handle: unknown, okFrom: typeof h.okFrom) => {
    h.key = key;
    h.okFrom = okFrom;
    return handle;
  },
}));
vi.mock('@/lib/email/drain', () => ({ runEmailDrain: h.drain }));
vi.mock('@/lib/email/transport', () => ({ createGmailTransport: h.transport }));
vi.mock('@/lib/email/outbox-store', () => ({ prismaOutboxStore: h.store }));

import { GET } from '@/app/api/cron/email-drain/route';

const NAMES = ['CRON_SECRET', 'NOTIFY_EMAIL_ENABLED', 'GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD', 'VERCEL_ENV', 'EMAIL_REDIRECT_TO', 'EMAIL_LINK_ORIGIN', 'MAINTENANCE_MODE', 'VERCEL_URL'];
const saved: Record<string, string | undefined> = {};
const SECRET = 's'.repeat(32);
const call = (auth: string | null = `Bearer ${SECRET}`) =>
  GET(new NextRequest('https://example.test/api/cron/email-drain', { headers: auth ? { authorization: auth } : {} }));
const ON = {
  CRON_SECRET: SECRET,
  NOTIFY_EMAIL_ENABLED: 'on',
  GMAIL_ADDRESS: 'sender@example.test',
  GMAIL_APP_PASSWORD: 'p'.repeat(16),
  VERCEL_ENV: 'production',
};
function env(vars: Record<string, string>) {
  for (const n of NAMES) delete process.env[n];
  Object.assign(process.env, vars);
}

beforeEach(() => {
  for (const n of NAMES) saved[n] = process.env[n];
  h.drain.mockReset().mockResolvedValue({
    claimed: 2, sent: 1, skipped: 1, skippedBy: { SKIPPED_ROLE: 1 }, failed: 0, deferred: 0, capped: false,
    staleMarked: 0, exhaustedMarked: 0, budgetStopped: false, sendErrors: 0, authErrors: 0, accountErrors: 0, errorLabels: {},
  });
  h.transport.mockReset().mockReturnValue({ send: vi.fn(), close: vi.fn() });
  h.store.mockReset().mockReturnValue({ tag: 'store' });
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe('/api/cron/email-drain', () => {
  it('reports through the email-drain heartbeat', () => {
    expect(h.key).toBe('email-drain');
  });

  it('refuses without the bearer, before reading anything', async () => {
    env(ON);
    expect((await call(null)).status).toBe(401);
    expect((await call('Bearer wrong')).status).toBe(401);
    expect(h.drain).not.toHaveBeenCalled();
  });

  it('switch off: a healthy run that touches nothing', async () => {
    env({ ...ON, NOTIFY_EMAIL_ENABLED: '' });
    const res = await call();
    const body = await res.json();
    expect(body).toEqual({ enabled: false, reason: 'disabled', configErrors: 0 });
    expect(h.okFrom!(body, res.status)).toBe(true);
    expect(h.drain).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('maintenance: nothing sent, still healthy', async () => {
    env({ ...ON, MAINTENANCE_MODE: 'on' });
    const body = await (await call()).json();
    expect(body).toMatchObject({ enabled: false, reason: 'maintenance', configErrors: 0 });
    expect(h.okFrom!(body, 200)).toBe(true);
  });

  it('switched on but unusable: nothing sent, and the run is a failure the operator hears of', async () => {
    env({ ...ON, GMAIL_APP_PASSWORD: '' });
    const body = await (await call()).json();
    expect(body).toEqual({ enabled: false, reason: 'unconfigured', configErrors: 1 });
    expect(h.okFrom!(body, 200)).toBe(false);
    expect(h.drain).not.toHaveBeenCalled();
  });

  it('switched on: one drain over the pooled client, counts only in the answer', async () => {
    env(ON);
    const res = await call();
    const body = await res.json();
    expect(h.store).toHaveBeenCalledWith({ tag: 'pooled-client' });
    expect(h.transport).toHaveBeenCalledWith(expect.objectContaining({ user: 'sender@example.test', from: 'NMWC CRM <sender@example.test>' }));
    expect(h.drain).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ enabled: true, redirected: false, sent: 1, skipped: 1, sendErrors: 0, authErrors: 0, accountErrors: 0 });
    // Nothing in the answer can carry the password or an address.
    expect(JSON.stringify(body)).not.toMatch(/p{16}|@/);
    expect(h.okFrom!(body, res.status)).toBe(true);
    expect(h.okFrom!({ ...body, sendErrors: 1 }, 200)).toBe(false);
    expect(h.okFrom!({ ...body, authErrors: 1 }, 200)).toBe(false);
    // Gmail refused the sending account itself (a used-up daily limit): the
    // operator must hear of it, though nothing was marked FAILED.
    expect(h.okFrom!({ ...body, accountErrors: 1 }, 200)).toBe(false);
  });
});
