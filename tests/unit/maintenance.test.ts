// @vitest-environment node
/**
 * REL-02: the closed sign has to work when nothing else does.
 *
 * Node environment on purpose: this imports next/server, and the jsdom default
 * risks resolving a browser build of it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { maintenanceResponse, MAINTENANCE_BYPASS_COOKIE } from '@/lib/maintenance';

function req(pathname: string, cookie?: string): NextRequest {
  return {
    nextUrl: { pathname },
    cookies: { get: (n: string) => (cookie && n === MAINTENANCE_BYPASS_COOKIE ? { value: cookie } : undefined) },
  } as unknown as NextRequest;
}

afterEach(() => {
  delete process.env.MAINTENANCE_MODE;
  delete process.env.MAINTENANCE_BYPASS_TOKEN;
});

describe('maintenanceResponse', () => {
  it('does nothing on a normal day', () => {
    expect(maintenanceResponse(req('/customers'))).toBeNull();
    process.env.MAINTENANCE_MODE = 'off';
    expect(maintenanceResponse(req('/customers'))).toBeNull();
  });

  it('closes the app with a 503 that says when to come back', async () => {
    process.env.MAINTENANCE_MODE = 'on';
    const res = maintenanceResponse(req('/customers'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    expect(res!.headers.get('retry-after')).toBe('900');
    // A cached closed page outlives the maintenance and is worse than the outage.
    expect(res!.headers.get('cache-control')).toMatch(/no-store/);
    const body = await res!.text();
    // Both languages, because the people who see this are field staff.
    expect(body).toMatch(/temporarily closed/i);
    expect(body).toContain('مغلق');
    // It must not depend on anything the app serves.
    expect(body).not.toMatch(/<script|stylesheet|fonts\.googleapis/i);
  });

  it('keeps the endpoints an incident depends on open', () => {
    process.env.MAINTENANCE_MODE = 'on';
    for (const p of [
      '/api/health',
      '/api/cron/keep-warm',
      '/api/cron/sla-escalate',
      '/api/ops/backup-report',
      '/api/auth/signin',
      '/_next/static/chunk.js',
    ]) {
      expect(maintenanceResponse(req(p)), p).toBeNull();
    }
  });

  it('lets an operator through with the bypass cookie, and nobody else', () => {
    process.env.MAINTENANCE_MODE = 'on';
    process.env.MAINTENANCE_BYPASS_TOKEN = 'let-me-in-please-2026';
    expect(maintenanceResponse(req('/customers', 'let-me-in-please-2026'))).toBeNull();
    expect(maintenanceResponse(req('/customers', 'wrong'))).not.toBeNull();
    expect(maintenanceResponse(req('/customers'))).not.toBeNull();
  });

  it('rejects a wrong token of the identical length', () => {
    // The case a length check alone would pass, so this is what proves the
    // comparison itself runs. Green before and after the constant-time change;
    // it exists to kill a botched XOR loop, not to prove the change happened.
    process.env.MAINTENANCE_MODE = 'on';
    process.env.MAINTENANCE_BYPASS_TOKEN = 'let-me-in-please-2026';
    expect(maintenanceResponse(req('/customers', 'let-me-in-please-2027'))).not.toBeNull();
    expect(maintenanceResponse(req('/customers', 'Let-me-in-please-2026'))).not.toBeNull();
  });

  it('compares the bypass token in constant time, not with ===', () => {
    // SEC-14c: this cookie was compared with `===` — the same non-constant-time
    // secret comparison the assessment flagged on the health route, on a
    // different secret, unlisted. The behavioural test above stays green if
    // someone deletes tokenMatches and restores the equality, so this is the one
    // that would not. Same shape as tests/unit/cron-auth.test.ts.
    //
    // It is a hand-rolled compare rather than timingSafeEqual because this module
    // is pulled into the EDGE bundle by middleware.ts, where a node:crypto import
    // fails the build.
    const src = readFileSync('lib/maintenance.ts', 'utf8');
    expect(src).toMatch(/tokenMatches\s*\(/);
    expect(src).not.toMatch(/MAINTENANCE_BYPASS_COOKIE\)\?\.value\s*===/);
  });

  it('ignores the cookie when no bypass token is configured', () => {
    // Otherwise an empty token would make any cookie value a skeleton key.
    process.env.MAINTENANCE_MODE = 'on';
    expect(maintenanceResponse(req('/customers', ''))).not.toBeNull();
    expect(maintenanceResponse(req('/customers', 'anything'))).not.toBeNull();
  });
});
