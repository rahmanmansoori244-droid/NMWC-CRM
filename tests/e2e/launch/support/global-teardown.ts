/**
 * Launch e2e global teardown: re-runs cleanup for every world of this run whose
 * registry is not marked clean (a worker that crashed, an afterAll that threw),
 * then for every dirty world of runs that are over. Fails the run when anything
 * is still left, naming the registry file to sweep (see the README).
 */
import { sweepRun, sweepStale } from './cleanup';
import { disconnectDb, launchEnabled, RUN_ID } from './env';

export default async function globalTeardown(): Promise<void> {
  if (!launchEnabled()) return;
  try {
    const own = await sweepRun(RUN_ID);
    const stale = await sweepStale(RUN_ID);
    console.log(
      `[launch teardown] run ${RUN_ID}: re-swept ${own.swept} unclean world(s) (${own.clean} now clean); ` +
        `earlier runs: ${stale.swept} swept, ${stale.clean} clean`
    );
    // Why each was not clean before this sweep (its afterAll threw, left a row, or never ran).
    for (const f of [...own.found, ...stale.found]) {
      console.log(`[launch teardown]   ${f.file}: had ${JSON.stringify(f.leftovers ?? {})}${f.error ? ` · ${f.error.slice(0, 300)}` : ''}`);
    }
    const dirty = [...own.dirty, ...stale.dirty];
    if (dirty.length > 0) {
      for (const d of dirty) console.error(`[launch teardown] STILL DIRTY ${d.file}: ${JSON.stringify(d.leftovers ?? d.error)}`);
      throw new Error(
        `[launch teardown] ${dirty.length} world(s) left rows or objects behind — run the sweep again (tests/e2e/launch/README.md)`
      );
    }
  } finally {
    await disconnectDb();
  }
}
