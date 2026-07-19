/**
 * Loads .env into process.env (values may contain & = ? which break shell
 * `export`/`source`), then execs the given command so secrets never touch the
 * command line. Usage: node scripts/qa/run-with-env.mjs vitest run <path>
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('usage: run-with-env.mjs <cmd> [args...]'); process.exit(2); }
const r = spawnSync('npx', [cmd, ...args], { stdio: 'inherit', env: process.env, shell: true });
process.exit(r.status ?? 1);
