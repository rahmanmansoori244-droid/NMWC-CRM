/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS script run with plain node */
// Does anything that loads .env here point at PRODUCTION? Prints only "production" /
// "not production" / "not set" per variable — never a value — and exits 1 if either
// DATABASE_URL or DIRECT_URL is production. Run it before tests, Prisma, or
// scripts/qa/run-with-env.mjs (AGENTS.md "Before you start" 4).
//   node scripts/dev/env-check.cjs [env file]        (default: .env in the current directory)
// It checks both the file and the process environment, because run-with-env.mjs lets a
// variable already set in the environment win over the file.
const fs = require('fs');
const path = require('path');
const { loadProductionHosts, hostMarker, productionMarkerIn } = require('../lib/production-hosts.cjs');

// Production is what config/production-hosts.txt lists (code review 2026-11-10,
// finding 14); a list that cannot be read stops the check, it does not pass it.
let HOSTS;
try {
  HOSTS = loadProductionHosts();
} catch (e) {
  console.log(e.message);
  console.log('STOP: cannot tell whether anything here points at production.');
  process.exit(1);
}

const envFile = path.resolve(process.argv[2] || '.env');
const fromFile = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(DATABASE_URL|DIRECT_URL)\s*=\s*(.*)\s*$/.exec(line);
    if (m) fromFile[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
// The host's own marker, or the marker anywhere in the value (a `host` parameter,
// percent-escaped or not), as every guard reads it.
const isProduction = (value) => {
  let host = '';
  try {
    host = new URL(value).hostname;
  } catch {
    /* read as text below */
  }
  return !!hostMarker(host, HOSTS) || !!productionMarkerIn(value, HOSTS);
};

let production = false;
console.log(`env file: ${fs.existsSync(envFile) ? envFile : `${envFile} (missing)`}`);
for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
  for (const [where, value] of [
    ['file', fromFile[name]],
    ['environment', process.env[name]],
  ]) {
    const verdict = !value ? 'not set' : isProduction(value) ? 'PRODUCTION' : 'not production';
    if (value && isProduction(value)) production = true;
    console.log(`  ${name} (${where}): ${verdict}`);
  }
}
console.log(production ? 'STOP: something here points at production.' : 'ok: nothing here points at production.');
process.exitCode = production ? 1 : 0;
