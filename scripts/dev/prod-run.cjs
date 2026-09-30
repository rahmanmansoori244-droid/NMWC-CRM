/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS script run with plain node */
// Run a script against PRODUCTION with the owner connection, without the connection
// string ever reaching the terminal, a log or a chat (docs/HANDOVER.md §5).
//
//   NMWC_PROD_ENV_FILE=<path to the .env holding the production DIRECT_URL> \
//     node scripts/dev/prod-run.cjs <script path> [args...]
//
// - DIRECT_URL is read from that file (default: .env in the current directory) and
//   passed to the script in its environment only. DATABASE_URL is set to an address
//   that cannot connect, so a script that ignores DIRECT_URL fails instead of silently
//   using some other database. Build the client with
//   `new PrismaClient({ datasourceUrl: process.env.DIRECT_URL })`.
// - It refuses a DIRECT_URL whose HOST is not production (`ep-sweet-haze…`), so
//   pointing it at a UAT .env runs nothing.
// - Everything the script prints is masked: the URL, its password (raw and decoded),
//   user and host, and anything shaped like a postgres connection string. Output is
//   shown when the script ends.
// - The script runs through tsx with no shell, so an argument is only ever an argument.
// The script decides what it does: read-only questions open SET TRANSACTION READ ONLY
// and print counts only; writes go through a scripts/ops/ operator script with a dry
// run, --expect-host and --apply. Run `npm run smoke` before and after a write.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.log('usage: node scripts/dev/prod-run.cjs <script> [args]');
  process.exit(2);
}
const envFile = path.resolve(process.env.NMWC_PROD_ENV_FILE || '.env');
if (!fs.existsSync(envFile)) {
  console.log(`no env file at ${envFile} (set NMWC_PROD_ENV_FILE)`);
  process.exit(2);
}
let url = '';
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^\s*DIRECT_URL\s*=\s*(.*)\s*$/.exec(line);
  if (m) url = m[1].replace(/^(['"])(.*)\1$/, '$2');
}
if (!url) {
  console.log('DIRECT_URL not found in the env file');
  process.exit(2);
}
let parsed;
try {
  parsed = new URL(url);
} catch {
  console.log('DIRECT_URL in the env file is not a URL — refusing');
  process.exit(2);
}
if (!parsed.hostname.startsWith('ep-sweet-haze')) {
  console.log('that env file does not point at production — refusing');
  process.exit(2);
}

let decodedPassword = parsed.password;
try {
  decodedPassword = decodeURIComponent(parsed.password);
} catch {
  /* keep the raw form */
}
// The endpoint ID (the host's first label, with and without "-pooler") appears on its
// own in some Neon errors.
const endpoint = parsed.hostname.split('.')[0];
const secrets = [
  url,
  parsed.password,
  decodedPassword,
  parsed.username,
  parsed.host,
  parsed.hostname,
  endpoint,
  endpoint.replace(/-pooler$/, ''),
]
  .filter((s) => s && s.length >= 4)
  .sort((a, b) => b.length - a.length);
const mask = (s) => {
  let out = s || '';
  for (const secret of secrets) out = out.split(secret).join('<masked>');
  return out.replace(/postgres(ql)?:\/\/[^\s'"]+/g, '<a connection string>');
};

const env = {
  ...process.env,
  DIRECT_URL: url,
  DATABASE_URL: 'postgresql://prod-run-disabled@invalid.invalid:5432/none',
};
const res = spawnSync(process.execPath, [require.resolve('tsx/cli'), script, ...args], {
  cwd: process.cwd(),
  env,
  encoding: 'utf8',
  shell: false,
  maxBuffer: 256 * 1024 * 1024,
  timeout: 1_500_000,
});
process.stdout.write(mask(res.stdout));
process.stdout.write(mask(res.stderr));
if (res.error) console.log(`\n[prod-run] could not finish: ${res.error.code || res.error.name}`);
if (res.signal) console.log(`\n[prod-run] stopped by ${res.signal}`);
console.log(`\n[prod-run] exit ${res.status}`);
process.exit(res.status ?? 1);
