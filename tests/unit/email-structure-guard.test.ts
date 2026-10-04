// @vitest-environment node
/**
 * F1 (2026-10-05): the shape that keeps e-mail out of request paths and
 * transactions, and customer data out of e-mail — pinned on the source, because
 * each failure it guards is "someone called it from the wrong place" and no
 * behavioural test sees a call that should not exist (CLAUDE.md, Tests).
 *
 *   - nodemailer is imported by lib/email/transport.ts and nothing else;
 *   - lib/email/* is imported by the drain cron route and by lib/email/* itself,
 *     and nothing else — so no server action, page, service or transaction can
 *     send an e-mail;
 *   - the e-mail settings are read in lib/email/config.ts only (the Sentry
 *     scrubber also reads the app password, to redact it);
 *   - no lib/email module touches a notification's title or body, or a
 *     request's decisionReason;
 *   - the schedule in vercel.json, the heartbeat's expectation and the policy
 *     module agree, and the heartbeat is warning-tier.
 * Comments are stripped first: a comment that quotes an import is not one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';
import { HEARTBEAT_EXPECTATIONS } from '@/lib/heartbeat';
import { EMAIL_DELIVERY } from '@/lib/notify-policy';

const ROOT_FILES = ['middleware.ts', 'auth.config.ts', 'instrumentation.ts', 'instrumentation-client.ts', 'next.config.ts'];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}
const SOURCES = [...['app', 'lib', 'services', 'components', 'scripts', 'prisma'].flatMap(files), ...ROOT_FILES.filter(existsSync)];
const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f.replace(/\.(mjs|cjs|js)$/, '.ts'));
const code = new Map(SOURCES.map((f) => [f, src(f)] as const));

const importsOf = (s: string) =>
  [...s.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)].map((m) => m[1]!);

describe('where e-mail can come from', () => {
  it('nodemailer is imported by lib/email/transport.ts and nothing else', () => {
    const importers = [...code].filter(([, s]) => importsOf(s).some((m) => m === 'nodemailer' || m.startsWith('nodemailer/'))).map(([f]) => f);
    expect(importers).toEqual(['lib/email/transport.ts']);
  });

  it('lib/email is reached only from the drain cron route', () => {
    const importers = [...code]
      .filter(([f]) => !f.startsWith('lib/email/'))
      .filter(([f, s]) =>
        importsOf(s).some(
          (m) => m.startsWith('@/lib/email') || /(^|\/)lib\/email(\/|$)/.test(m) || (f.startsWith('lib/') && m.startsWith('./email'))
        )
      )
      .map(([f]) => f);
    expect(importers).toEqual(['app/api/cron/email-drain/route.ts']);
  });

  it('the drain route is a bearer cron route with a heartbeat that reads both error counts', () => {
    const s = code.get('app/api/cron/email-drain/route.ts')!;
    expect(s).toMatch(/export const runtime = 'nodejs'/);
    expect(s.indexOf('cronAuthorized(')).toBeGreaterThan(-1);
    expect(s.indexOf('cronAuthorized(')).toBeLessThan(s.indexOf('readEmailConfig('));
    expect(s).toMatch(/withHeartbeat\(\s*'email-drain'/);
    expect(s).not.toMatch(/\$transaction/);
  });

  it('nothing in lib/email opens a transaction', () => {
    for (const f of files('lib/email')) expect(code.get(f), f).not.toMatch(/\$transaction/);
  });
});

describe('what an e-mail can contain', () => {
  it('no lib/email module reads a notification’s title or body, or a request’s free-text reason', () => {
    for (const f of files('lib/email')) {
      const s = code.get(f)!;
      expect(s, f).not.toMatch(/\btitle\b/);
      expect(s, f).not.toMatch(/\bbody\b/);
      expect(s, f).not.toMatch(/decisionReason/);
      expect(s, f).not.toMatch(/legalName|nmwcCode|fullName|branchName/);
    }
  });

  it('the claim selects ids, kind and times, and nothing else', () => {
    const s = code.get('lib/email/outbox-store.ts')!;
    const returning = s.slice(s.indexOf('RETURNING'), s.indexOf('`', s.indexOf('RETURNING')));
    expect(returning.replace(/\s+/g, ' ').trim()).toBe(
      'RETURNING n.id, n."userId", n.kind::text AS kind, n."editId", n."createdAt", n."readAt"'
    );
  });

  it('plain text only: no HTML body and no HTML-to-text regex', () => {
    for (const f of files('lib/email')) {
      expect(code.get(f), f).not.toMatch(/\bhtml\s*:/);
      expect(code.get(f), f).not.toContain('<[^>]+>');
    }
  });
});

describe('who reads the e-mail settings', () => {
  const NAMES = ['NOTIFY_EMAIL_ENABLED', 'GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD', 'EMAIL_REDIRECT_TO', 'EMAIL_LINK_ORIGIN'];
  it.each(NAMES)('%s is read in lib/email/config.ts (and the app password also in the Sentry scrubber)', (name) => {
    const readers = [...code].filter(([, s]) => new RegExp(`process\\.env\\??\\.${name}\\b|process\\.env\\[['"]${name}['"]\\]`).test(s)).map(([f]) => f);
    expect(readers.sort()).toEqual(name === 'GMAIL_APP_PASSWORD' ? ['lib/email/config.ts', 'lib/sentry-scrub.ts'] : ['lib/email/config.ts']);
  });

  it('the transport is configured with an object, never a URL that carries the password', () => {
    const s = code.get('lib/email/transport.ts')!;
    expect(s).not.toMatch(/smtps?:\/\//);
    expect(s).toMatch(/logger:\s*false/);
    expect(s).toMatch(/debug:\s*false/);
    expect(s).not.toMatch(/\.message\b/);
  });
});

describe('the schedule, the heartbeat and the policy agree', () => {
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: Array<{ path: string; schedule: string }> };

  it('vercel.json runs the drain on the policy’s schedule, inside the other jobs’ window', () => {
    const entry = vercel.crons.find((c) => c.path === '/api/cron/email-drain');
    expect(entry?.schedule).toBe(EMAIL_DELIVERY.schedule);
    expect(EMAIL_DELIVERY.schedule).toBe('*/10 3-14 * * *');
  });

  it('the heartbeat expects that schedule, at warning tier', () => {
    expect(HEARTBEAT_EXPECTATIONS['email-drain']).toEqual({
      label: 'Notification e-mail drain',
      severity: 'warning',
      everyMinutes: 10,
      activeHoursUtc: [3, 15],
    });
  });

  it('the claim lease outlives the function limit, and sends stop well inside it', () => {
    const fn = JSON.parse(readFileSync('vercel.json', 'utf8')) as { functions: Record<string, { maxDuration: number }> };
    const limitMs = Math.min(...Object.values(fn.functions).map((f) => f.maxDuration)) * 1000;
    expect(EMAIL_DELIVERY.leaseMs).toBeGreaterThan(limitMs);
    expect(EMAIL_DELIVERY.sendBudgetMs).toBeLessThan(EMAIL_DELIVERY.hardStopMs);
    expect(EMAIL_DELIVERY.hardStopMs).toBeLessThanOrEqual(limitMs - 10_000);
    expect(EMAIL_DELIVERY.dailyCap).toBeLessThan(500);
  });
});
