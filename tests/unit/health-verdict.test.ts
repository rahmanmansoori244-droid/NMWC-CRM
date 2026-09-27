// @vitest-environment node
/**
 * Items 11 and 12 (re-benchmark, 2026-09-24), by behaviour.
 *
 *   11 — "health goes red for minor things": a keep-warm ping that failed once
 *        answered 503 and paged exactly like a dead SLA sweep.
 *   12 — "R2 unconfigured reads healthy": with no R2 credentials the check stayed
 *        `pending`, and `pending` counted as fine.
 */
import { describe, it, expect } from 'vitest';
import { evaluateHealth, isProductionDeployment, r2Configured, type CheckState } from '@/lib/health';
import { HEARTBEAT_EXPECTATIONS, heartbeatReport, type HeartbeatKey } from '@/lib/heartbeat';

const allOk: Record<string, CheckState> = { app: 'ok', db: 'ok', r2: 'ok', heartbeats: 'ok' };
const job = (key: string, severity: 'critical' | 'warning', state = 'stale') => ({
  key,
  state,
  alarm: state === 'never' || state === 'failed' || state === 'stale',
  severity,
});

describe('what pages and what is only reported', () => {
  it('everything fine: ok, 200, nothing listed', () => {
    const v = evaluateHealth({ checks: allOk, jobs: [job('keep-warm', 'warning', 'ok')], production: true });
    expect(v).toEqual({ status: 'ok', httpStatus: 200, failedChecks: [], criticalJobs: [], warnings: [] });
  });

  it('a warning-tier job that alarms stays 200, as warn, and is named with its state', () => {
    const v = evaluateHealth({ checks: allOk, jobs: [job('keep-warm', 'warning', 'failed')], production: true });
    expect(v.httpStatus).toBe(200);
    expect(v.status).toBe('warn');
    expect(v.warnings).toEqual(['keep-warm:failed']);
    expect(v.criticalJobs).toEqual([]);
  });

  it('a critical job that alarms answers 503 and is listed as an alarm', () => {
    const v = evaluateHealth({
      checks: allOk,
      jobs: [job('keep-warm', 'warning', 'failed'), job('sla-escalate', 'critical', 'stale')],
      production: true,
    });
    expect(v.httpStatus).toBe(503);
    expect(v.status).toBe('degraded');
    expect(v.criticalJobs).toEqual(['sla-escalate']);
    // The warning is still reported beside it, not swallowed by the red.
    expect(v.warnings).toEqual(['keep-warm:failed']);
  });

  it('any failed check answers 503 — heartbeats that could not be read included', () => {
    for (const name of ['db', 'r2', 'heartbeats']) {
      const v = evaluateHealth({ checks: { ...allOk, [name]: 'fail' }, jobs: [], production: true });
      expect(v.httpStatus, name).toBe(503);
      expect(v.failedChecks, name).toEqual([name]);
    }
  });

  it('pending is neutral: it is left only when the database is down, which already failed', () => {
    const v = evaluateHealth({
      checks: { app: 'ok', db: 'fail', r2: 'ok', heartbeats: 'pending' },
      jobs: null,
      production: true,
    });
    expect(v.failedChecks).toEqual(['db']);
  });

  it('a job that is not alarming is not listed whatever its tier', () => {
    const v = evaluateHealth({
      checks: allOk,
      jobs: [job('sla-escalate', 'critical', 'outside-window'), job('photo-gc', 'warning', 'ok')],
      production: true,
    });
    expect(v.status).toBe('ok');
  });
});

describe('item 12: R2 with no credentials', () => {
  const noR2 = { ...allOk, r2: 'unconfigured' as const };

  it('is a failure on production, where every change request carries photographs', () => {
    const v = evaluateHealth({ checks: noR2, jobs: [], production: true });
    expect(v.httpStatus).toBe(503);
    expect(v.failedChecks).toEqual(['r2']);
  });

  it('is a warning anywhere else — never silently ok', () => {
    const v = evaluateHealth({ checks: noR2, jobs: [], production: false });
    expect(v.httpStatus).toBe(200);
    expect(v.status).toBe('warn');
    expect(v.warnings).toEqual(['r2:unconfigured']);
  });

  it('needs all three credentials lib/r2.ts reads, not the two the old test looked at', () => {
    const full = { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c' } as unknown as NodeJS.ProcessEnv;
    expect(r2Configured(full)).toBe(true);
    for (const missing of Object.keys(full)) {
      expect(r2Configured({ ...full, [missing]: '' }), missing).toBe(false);
    }
  });

  it('production means the Vercel production deployment, not NODE_ENV', () => {
    expect(isProductionDeployment({ VERCEL_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionDeployment({ VERCEL_ENV: 'preview', NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isProductionDeployment({ NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('item 11: the tiers themselves', () => {
  it('pages for the jobs whose silence stops a business process or the backup, and only those', () => {
    const critical = (Object.keys(HEARTBEAT_EXPECTATIONS) as HeartbeatKey[])
      .filter((k) => HEARTBEAT_EXPECTATIONS[k].severity === 'critical')
      .sort();
    expect(critical).toEqual(['db-backup', 'sla-escalate']);
  });

  it('the heartbeat report carries each job’s tier, so the verdict can read it', () => {
    const report = heartbeatReport([], new Date('2026-09-27T08:00:00Z'));
    for (const r of report) expect(r.severity).toBe(HEARTBEAT_EXPECTATIONS[r.key].severity);
  });

  it('end to end: with no runs recorded at all, only the critical jobs turn it red', () => {
    // Every job reads `never` — the state of a fresh database.
    const report = heartbeatReport([], new Date('2026-09-27T08:00:00Z'));
    const v = evaluateHealth({ checks: allOk, jobs: report, production: true });
    expect(v.httpStatus).toBe(503);
    expect([...v.criticalJobs].sort()).toEqual(['db-backup', 'sla-escalate']);
    expect([...v.warnings].sort()).toEqual(['keep-warm:never', 'photo-gc:never', 'retention-sweep:never']);
  });
});
