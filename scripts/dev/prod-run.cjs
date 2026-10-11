/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS script run with plain node */
// Run a script against PRODUCTION with the owner connection, without the connection
// string ever reaching the terminal, a log or a chat (docs/HANDOVER.md §5).
//
//   NMWC_PROD_ENV_FILE=<path to the .env holding the production DIRECT_URL> \
//     node scripts/dev/prod-run.cjs <script path> --expect-host ep-sweet-haze [the script's own args]
//
// - `--expect-host ep-sweet-haze` is REQUIRED on every run, read-only or not (owner
//   decisions 2026-10-11). It is one of the SCRIPT's arguments, anywhere after the
//   script path: the runner reads it there and FORWARDS every argument to the script
//   unchanged, so the script's own guard (scripts/lib/assert-not-production.ts, or
//   requireExpectedHost in the ops scripts) checks the very same flag. Typed once,
//   checked twice. The runner refuses, before it reads the env file, when the flag
//   is missing, has no value, or its value does not start with ep-sweet-haze (the
//   two-word form only: `--expect-host=…` is not read); and after reading it, when
//   the value is not part of the env file's host. A throw-away read-only script
//   (`*.tmp.ts`) is handed the flag too and may simply ignore it.
// - DIRECT_URL is read from that file (default: .env in the current directory) and
//   passed to the script in its environment only. DATABASE_URL is set to an address
//   that cannot connect, so a script that ignores DIRECT_URL fails instead of silently
//   using some other database. Build the client with
//   `new PrismaClient({ datasourceUrl: process.env.DIRECT_URL })`.
// - It refuses a DIRECT_URL whose HOST is not production (`ep-sweet-haze…`), so
//   pointing it at a UAT .env runs nothing.
// - Everything the script prints is masked: the URL, its password (raw and decoded),
//   user and host, and anything shaped like a postgres connection string. Output is
//   shown when the script ends. The runner's own refusals print no value from the
//   env file or from --expect-host.
// - The script runs through tsx with no shell, so an argument is only ever an argument.
// The script decides what it does: read-only questions open SET TRANSACTION READ ONLY
// and print counts only; writes go through a scripts/ops/ operator script with a dry
// run and --apply. Run `npm run smoke` before and after a write.
// tests/unit/prod-run.test.ts runs it with a fake production env file.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PRODUCTION = 'ep-sweet-haze';
const USAGE = `usage: node scripts/dev/prod-run.cjs <script> --expect-host ${PRODUCTION} [the script's own args]`;

const [script, ...args] = process.argv.slice(2);
if (!script || script.startsWith('-')) {
  console.log(USAGE);
  process.exit(2);
}
// Owner decisions 2026-10-11: every run names production. Read from the script's own
// arguments, which are passed on unchanged below; its value is never printed (it may
// be the full endpoint id, which the output masking hides everywhere else).
const flagAt = args.indexOf('--expect-host');
const expectHost = flagAt < 0 ? '' : (args[flagAt + 1] ?? '');
if (!expectHost || expectHost.startsWith('--') || !expectHost.toLowerCase().startsWith(PRODUCTION)) {
  console.log(
    `[prod-run] refusing: every run needs --expect-host ${PRODUCTION} among the script's arguments,\n` +
      '  as two words, read-only or not (owner decisions 2026-10-11). It is passed on to the\n' +
      "  script unchanged, so the script's own guard checks it too. Nothing was read or run."
  );
  console.log(USAGE);
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
const hostname = parsed.hostname.toLowerCase();
if (!hostname.startsWith(PRODUCTION)) {
  console.log('that env file does not point at production — refusing');
  process.exit(2);
}
if (!hostname.includes(expectHost.toLowerCase())) {
  console.log(
    "[prod-run] refusing: the --expect-host value is not part of the env file's production host.\n" +
      `  Pass --expect-host ${PRODUCTION}, or the host's own endpoint id. Nothing was run.`
  );
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
