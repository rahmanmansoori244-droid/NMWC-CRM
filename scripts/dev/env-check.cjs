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

const envFile = path.resolve(process.argv[2] || '.env');
const fromFile = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(DATABASE_URL|DIRECT_URL)\s*=\s*(.*)\s*$/.exec(line);
    if (m) fromFile[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const isProduction = (value) => {
  try {
    return new URL(value).hostname.startsWith('ep-sweet-haze');
  } catch {
    return String(value).includes('ep-sweet-haze');
  }
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
