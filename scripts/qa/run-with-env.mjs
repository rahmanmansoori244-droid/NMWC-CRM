/**
 * Loads .env into process.env (values may contain & = ? which break shell
 * `export`/`source`), then execs the given command so secrets never touch the
 * command line. Usage: node scripts/qa/run-with-env.mjs vitest run <path>
 *
 * It refuses production. Everything it is documented for — the integration
 * suites, playwright, next build, the UAT rehearsal of an operator script — runs
 * on UAT or CI, but it runs any command with whatever .env holds, and the .env in
 * the owner's main checkout is production. Several integration suites have no
 * production check of their own, and none of the commands it starts can be seen
 * by the scripts' guard test (data audit 2026-10-10, gap 3; review of d02cb27).
 * The check is the one scripts/lib/assert-not-production.ts makes, through the
 * same shared list (scripts/lib/production-hosts.cjs reading
 * config/production-hosts.txt; code review 2026-11-10, finding 14): a production
 * marker anywhere in DATABASE_URL, DIRECT_URL or any other connection string set
 * here, percent-escaped or not. A list that cannot be read refuses. Production
 * operator scripts run through scripts/dev/prod-run.cjs instead (docs/OPERATIONS.md §5j).
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import productionHosts from '../lib/production-hosts.cjs';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

// After the merge, so a value set in the shell (which wins over .env) is checked too.
let HOSTS;
try {
  HOSTS = productionHosts.loadProductionHosts();
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const production = Object.entries(process.env)
  .filter(
    ([key, value]) =>
      value && (key === 'DATABASE_URL' || key === 'DIRECT_URL' || /^\s*['"]?postgres(ql)?:\/\//i.test(value))
  )
  .map(([key, value]) => [key, productionHosts.productionMarkerIn(value, HOSTS)])
  .filter(([, marker]) => marker !== null);
if (production.length > 0) {
  // Names only: never the value, which carries the password.
  console.error(
    `[run-with-env] refusing: ${production.map(([key]) => key).join(', ')} ${production.length > 1 ? 'point' : 'points'} at PRODUCTION (${production[0][1]}…).\n` +
      '  This runner is for UAT and CI. Check which .env this folder holds (node scripts/dev/env-check.cjs)\n' +
      '  and any connection string set in this shell. Production operator scripts run through\n' +
      '  scripts/dev/prod-run.cjs (docs/OPERATIONS.md §5j). Nothing was run.'
  );
  process.exit(2);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('usage: run-with-env.mjs <cmd> [args...]'); process.exit(2); }
const r = spawnSync('npx', [cmd, ...args], { stdio: 'inherit', env: process.env, shell: true });
process.exit(r.status ?? 1);
