// @vitest-environment node
/**
 * The dead man has to be readable, and it has to be honest about being unreadable.
 *
 * Two ways it could report green while the system was not:
 *
 *   1. A caller that presented a credential the route did not recognise fell
 *      through to the ANONYMOUS answer, which is `200 {"status":"ok"}` whenever
 *      the database replies. The monitor is configured to alert on a non-200, so
 *      a mistyped or rotated HEALTH_BEARER — or an unset one — made it green
 *      forever while every heartbeat could read `never`, `stale` or `failed`.
 *      Nothing in the response said "you were treated as anonymous".
 *   2. When the heartbeat query itself threw, the result was an EMPTY alarm list,
 *      which is indistinguishable from "no alarms". The probe answered ok while
 *      nothing was being evaluated at all.
 *
 * Structural, because exercising the handler means standing up Prisma, R2 and the
 * heartbeat reader, and what actually broke here is a control-flow decision that
 * reads clearly in the source. The end-to-end spec covers the live responses.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const ROUTE = 'app/api/health/route.ts';
const raw = readFileSync(ROUTE, 'utf8');
// Comments stripped: this file's comments quote the very strings asserted below.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('a credential that is not recognised is rejected, not downgraded', () => {
  it('answers 401 rather than falling through to the anonymous body', () => {
    expect(src).toMatch(/bearer\s*!==\s*null/);
    expect(src).toMatch(/UNAUTHORIZED/);
    expect(src).toMatch(/status:\s*401/);
  });

  it('also refuses a credentialled caller when the monitor token is unusable', () => {
    // An unset or too-short HEALTH_BEARER must fail loud rather than serve green.
    expect(src).toMatch(/MONITOR_NOT_CONFIGURED/);
  });

  it('still serves the anonymous answer to a caller with no credential', () => {
    // The unauthenticated liveness check is deliberately public and must stay so;
    // the end-to-end spec asserts its body is exactly { status }.
    expect(src).toMatch(/if \(!isMonitor\) \{/);
    expect(src).toMatch(/status: ok \? 'ok' : 'degraded'/);
  });
});

describe('an unreadable dead man is a failure, not an empty alarm list', () => {
  it('reports whether the heartbeats were read at all', () => {
    expect(src).toMatch(/heartbeats:\s*'pending'/);
    expect(src).toMatch(/checks\.heartbeats\s*=\s*'ok'/);
    expect(src).toMatch(/checks\.heartbeats\s*=\s*'fail'/);
  });

  it('folds that into the aggregate, so a failed read cannot answer 200', () => {
    // allOk treats 'pending' as acceptable — which is correct, because heartbeats
    // stay 'pending' only when the database is already down and reported failed.
    expect(src).toMatch(/Object\.values\(checks\)\.every/);
    expect(src).toMatch(/cronAlarms\.length === 0/);
  });

  it('the failure is logged as well as reported', () => {
    expect(src).toMatch(/health\.heartbeats\.fail/);
  });
});
