/**
 * Crash sweep, outside Playwright. Deletes what crashed launch runs left on UAT
 * (rows and the R2 objects under fixture users' folders), using the registry
 * files in .e2e-launch/registry/.
 *
 *   node scripts/qa/run-with-env.mjs tsx tests/e2e/launch/support/sweep-cli.ts           # every finished run
 *   node scripts/qa/run-with-env.mjs tsx tests/e2e/launch/support/sweep-cli.ts --list    # show, delete nothing
 *   node scripts/qa/run-with-env.mjs tsx tests/e2e/launch/support/sweep-cli.ts --run <id>
 *   node scripts/qa/run-with-env.mjs tsx tests/e2e/launch/support/sweep-cli.ts --check [--run <id>]
 *       # read-only: recount every world (by id AND by suffix, every table, the
 *       # R2 folders of its users, and the foreign rows pointing at it) and exit 1
 *       # if anything is left
 *   node scripts/qa/run-with-env.mjs tsx tests/e2e/launch/support/sweep-cli.ts --scan
 *       # read-only: scan every launch report, test-results folder and server log
 *       # for secrets (secret-scan.ts) and exit 1 on a hit — names files, never values
 *
 * A run whose runner's heartbeat is still fresh on this machine is left alone.
 */
import { residue, sweepRun, sweepStale, totalOf } from './cleanup';
import { assertNotProduction, disconnectDb, redact } from './env';
import { listRegistryFiles, Registry } from './registry';
import { describeHit, launchArtifactRoots, scanForSecrets } from './secret-scan';

async function main(): Promise<number> {
  assertNotProduction();
  const args = process.argv.slice(2);
  if (args.includes('--scan')) {
    const res = scanForSecrets(launchArtifactRoots());
    for (const h of res.hits) console.log(`SECRET  ${describeHit(h)}`);
    for (const u of res.unreadable) console.log(`UNREADABLE  ${u}`);
    console.log(`scanned ${res.files} file(s), ${res.entries} part(s): ${res.hits.length === 0 ? 'no secrets' : `${res.hits.length} hit(s)`}`);
    return res.hits.length === 0 ? 0 : 1;
  }
  if (args.includes('--list')) {
    const files = listRegistryFiles();
    if (files.length === 0) console.log('no registry files');
    for (const f of files) {
      const r = Registry.load(f).data;
      console.log(`${r.clean ? 'clean' : 'DIRTY'}  run ${r.runId}  world ${r.name}  created ${r.createdAt}  cleanup passes ${r.attempts?.length ?? 0}  ${r.leftovers ? JSON.stringify(r.leftovers) : ''}`);
    }
    return 0;
  }
  const i = args.indexOf('--run');
  if (args.includes('--check')) {
    const runId = i >= 0 ? args[i + 1] : undefined;
    const files = listRegistryFiles().filter((f) => !runId || Registry.load(f).data.runId === runId);
    let left = 0;
    for (const f of files) {
      const r = Registry.load(f).data;
      const counts = await residue(r);
      const nonZero = Object.fromEntries(Object.entries(counts).filter(([, n]) => n !== 0));
      left += totalOf(counts);
      console.log(`${totalOf(counts) === 0 ? 'zero' : 'LEFT'}  run ${r.runId}  world ${r.name}  tables ${Object.keys(counts).length}  ${JSON.stringify(nonZero)}`);
    }
    console.log(`checked ${files.length} world(s): ${left === 0 ? 'nothing left' : `${left} row(s)/object(s) left`}`);
    return left === 0 ? 0 : 1;
  }
  const report = i >= 0 && args[i + 1] ? await sweepRun(args[i + 1]!) : await sweepStale('');
  for (const f of report.found) console.log(`  found ${f.file}: ${JSON.stringify(f.leftovers ?? {})}${f.error ? ` · ${f.error.slice(0, 300)}` : ''}`);
  console.log(`swept ${report.swept} world(s): ${report.clean} clean, ${report.dirty.length} dirty`);
  for (const d of report.dirty) console.log(`  DIRTY ${d.file}: ${JSON.stringify(d.leftovers ?? d.error)}`);
  return report.dirty.length === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    await disconnectDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(redact(String((err as Error)?.message ?? err)));
    await disconnectDb();
    process.exit(1);
  });
