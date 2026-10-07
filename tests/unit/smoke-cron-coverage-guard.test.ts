// @vitest-environment node
/**
 * Launch fix (2026-10-07): the smoke run checks EVERY cron route refuses an
 * unauthenticated call.
 *
 * The list in scripts/ops/smoke.ts is written by hand, and the e-mail outbox's
 * route (app/api/cron/email-drain, F1) was added beside the others without being
 * added to it, so a regressed bearer check there would have stayed invisible. A
 * structural guard, because the defect is "nobody listed it": every directory
 * under app/api/cron must be named in the check's list. Comments are stripped
 * first: a comment naming a route is not a check of it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';

const SMOKE = 'scripts/ops/smoke.ts';
const code = stripComments(readFileSync(SMOKE, 'utf8'), SMOKE);

function smokeCronRoutes(): string[] {
  const start = code.indexOf("name: 'cron routes refuse an unauthenticated call'");
  expect(start, 'the cron check').toBeGreaterThan(-1);
  const list = /const routes = \[([^\]]*)\]/.exec(code.slice(start));
  expect(list, 'the cron check lists its routes').not.toBeNull();
  return [...list![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('smoke: every cron route is checked', () => {
  const cronDir = 'app/api/cron';
  const routes = readdirSync(cronDir).filter((name) => statSync(join(cronDir, name)).isDirectory());

  it('finds the routes it guards', () => {
    // If the directory moves, everything below would pass vacuously.
    expect(routes).toContain('sla-escalate');
    expect(routes).toContain('email-drain');
  });

  it.each(routes)('%s is in the unauthenticated-call check', (route) => {
    expect(smokeCronRoutes()).toContain(route);
  });

  it('the check wants a 401 from each, not merely an answer', () => {
    const start = code.indexOf("name: 'cron routes refuse an unauthenticated call'");
    expect(code.slice(start, start + 800)).toMatch(/every\(\(g\) => g\.endsWith\('=401'\)\)/);
  });
});
