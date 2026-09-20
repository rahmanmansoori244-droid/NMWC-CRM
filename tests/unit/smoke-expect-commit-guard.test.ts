// @vitest-environment node
/**
 * `npm run smoke -- --expect-commit <sha>` must never report a pass it did not earn.
 *
 * The commit is only readable from /api/health with the monitor bearer, so without
 * HEALTH_BEARER the assertion cannot run at all. It used to be declared INSIDE the
 * `if (MONITOR)` block, which meant the flag was silently dropped and the run still
 * printed "all 14 checks passed".
 *
 * That was found while verifying a production merge on 2026-09-20: the deploy was
 * believed to have been asserted against its commit, and had not been. It is the
 * same shape as the incident the check itself exists for — production served a
 * four-month-old build for weeks while nothing reported a failure. A check that
 * does not run must not look like a check that passed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = 'scripts/ops/smoke.ts';
const raw = readFileSync(SRC, 'utf8');
/**
 * Strip comments before asserting. The guard's own explanation quotes the strings
 * being matched, and a comment must never be the thing that makes an assertion
 * pass — that is a guard failing open while looking green.
 */
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('smoke refuses an --expect-commit it cannot honour', () => {
  it('still parses the flag being guarded', () => {
    // If the flag is renamed, everything below would pass vacuously.
    expect(code).toMatch(/--expect-commit/);
    expect(code).toMatch(/EXPECT_COMMIT/);
  });

  it('keeps the flag separate from its value', () => {
    // The defect this replaced: EXPECT_COMMIT collapsed "flag not passed" and
    // "flag passed with no sha" into the same empty string, so
    // `npm run smoke -- --expect-commit $SHA` with SHA unset skipped the
    // assertion and printed a pass. The flag's PRESENCE has to survive.
    expect(code).toMatch(/EXPECT_GIVEN\s*=\s*expectIdx\s*>=\s*0/);
  });

  it('refuses a flag that carries no usable sha', () => {
    expect(code).toMatch(/EXPECT_GIVEN\s*&&\s*!\/\^\[0-9a-f\]/);
  });

  it('guards the flag against a missing bearer', () => {
    // On EXPECT_GIVEN, not EXPECT_COMMIT — asserting the latter is what let the
    // empty-value case through, and the old version of this test asserted
    // exactly the expression that had the hole.
    expect(code).toMatch(/EXPECT_GIVEN\s*&&\s*!MONITOR/);
    expect(code).not.toMatch(/if\s*\(EXPECT_COMMIT\s*&&\s*!MONITOR\)/);
  });

  it('exits non-zero rather than carrying on', () => {
    const guard = code.slice(code.indexOf('EXPECT_GIVEN && !MONITOR'));
    expect(guard.slice(0, 800)).toMatch(/process\.exit\([1-9]/);
  });

  it('guards BEFORE the monitor-only checks, not inside them', () => {
    // Inside `if (MONITOR)` the guard is unreachable in precisely the case it
    // exists for. That inversion is how the original defect worked, so pin the
    // order rather than merely the presence.
    const iGuard = code.indexOf('EXPECT_GIVEN && !MONITOR');
    const iMonitorBlock = code.indexOf('if (MONITOR) {');
    expect(iGuard, 'the guard must exist').toBeGreaterThan(-1);
    expect(iMonitorBlock, 'the monitor block must exist').toBeGreaterThan(-1);
    expect(iGuard).toBeLessThan(iMonitorBlock);
  });

  it('the commit assertion itself is still the monitor-gated one', () => {
    // Documents WHY the guard is needed: the assertion genuinely cannot run
    // without the bearer. If someone makes the commit readable anonymously, this
    // goes red and the guard can be relaxed deliberately rather than by accident.
    const monitorBlock = code.slice(code.indexOf('if (MONITOR) {'));
    expect(monitorBlock).toMatch(/production is running the commit you think it is/);
  });
});
