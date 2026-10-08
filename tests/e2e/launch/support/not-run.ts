/**
 * Tests the ENVIRONMENT kept from running — said out loud, never a quiet skip.
 *
 * Some tests cannot run on every database: R2 is not configured, real UAT
 * customers sit in the Temix queue (Generate would take them), another live
 * import holds the promote lease. A plain test.skip for such a reason reads as
 * "nothing failed", and a flipped test (a fix the launch build must prove) would
 * go unverified with a green run. notRunHere() skips with a reason that starts
 * with NOT_RUN_ON_UAT; the launch-not-run reporter (not-run-reporter.ts) lists
 * every such test, its project and its reason in test-results/launch-not-run.json
 * (one entry per step) and at the end of the run. Under LAUNCH_FINAL=1 — the
 * final verification run of the launch build — it always prints that list, an
 * empty one included, so the final report can say exactly which tests could not
 * run here and why. Nothing here creates data to make a test runnable.
 */
import { test } from '@playwright/test';

/** Starts the reason of every skip the launch-not-run reporter lists. */
export const NOT_RUN_ON_UAT = 'NOT RUN ON UAT: ';

/** LAUNCH_FINAL=1: the final verification run of the launch build. */
export const LAUNCH_FINAL = process.env.LAUNCH_FINAL === '1';

/**
 * test.skip(condition, why) for a skip the environment forces. Use it where
 * test.skip goes: in a describe body (every test of it), in a hook or in a test.
 */
export function notRunHere(condition: boolean, why: string): void {
  test.skip(condition, `${NOT_RUN_ON_UAT}${why}`);
}
