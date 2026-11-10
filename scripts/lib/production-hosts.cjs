/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS, so plain node scripts (prod-run, env-check, run-with-env) can use it too */
/**
 * The production host markers, read from config/production-hosts.txt — the ONE
 * place they live (code review 2026-11-10, finding 14).
 *
 * WHY. Production used to be recognised by one fixed host name written into
 * about a hundred files. Every disaster-recovery runbook ends with production on
 * a NEW host, after which every guard (seeds, test suites, clean-up scripts,
 * prod-run, the backup) was blind to the real production. Now there is one list,
 * which accepts several hosts (the new production first, the old one kept so it
 * stays protected), and every guard reads it through this file or its shell twin
 * scripts/ops/production-hosts.sh.
 *
 * FAIL-CLOSED. A guard must never become weaker: a missing or unreadable file,
 * an empty list, or any line that is not a valid marker throws, so a guard that
 * cannot tell what production is refuses to run anything. There is deliberately
 * no environment variable or argument that replaces the list.
 *
 * Plain CommonJS, no dependencies: required by .cjs scripts, imported by the .mjs
 * runner and by TypeScript (types in production-hosts.d.cts). Pinned by
 * tests/unit/production-hosts.test.ts and tests/unit/scripts-production-guard.test.ts.
 */
const fs = require('fs');
const path = require('path');

/** The list's file, at the repository root's config/ folder. */
const PRODUCTION_HOSTS_FILE = path.join(__dirname, '..', '..', 'config', 'production-hosts.txt');

/**
 * What a marker may look like: the start of a host name, lower-case, 6 to 63
 * characters of letters, digits, dots and dashes, starting with a letter or
 * digit. Long enough that a slip ("ep", "-") cannot make every database look
 * like production or none; nothing a shell `case` pattern could read as a glob.
 */
const MARKER_SHAPE = /^[a-z0-9][a-z0-9.-]{5,62}$/;

class ProductionHostsError extends Error {
  constructor(reason) {
    super(
      `[production-hosts] refusing: ${reason}. The guards cannot tell which database is production, ` +
        'so nothing runs until config/production-hosts.txt is fixed (docs/OPERATIONS.md, Runbook A, ' +
        '"Point the guards and the backup at the new host"). Nothing was read or written.'
    );
    this.name = 'ProductionHostsError';
  }
}

/** The markers in a list's text: one per line, `#` starts a note, blank lines ignored. Throws when none or one is malformed. */
function parseProductionHosts(text) {
  if (typeof text !== 'string') throw new ProductionHostsError('the production host list could not be read');
  const hosts = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/#.*$/, '').trim().toLowerCase();
    if (line === '') continue;
    if (!MARKER_SHAPE.test(line)) {
      // The line number only: a malformed line may be a pasted connection string.
      throw new ProductionHostsError(`line ${i + 1} of the production host list is not a host marker`);
    }
    if (!hosts.includes(line)) hosts.push(line);
  }
  if (hosts.length === 0) throw new ProductionHostsError('the production host list is empty');
  return hosts;
}

/** The markers in config/production-hosts.txt (or `file`, for the tests). Throws when it cannot be read or is not a valid list. */
function loadProductionHosts(file = PRODUCTION_HOSTS_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ProductionHostsError('config/production-hosts.txt could not be read');
  }
  return parseProductionHosts(text);
}

/** A non-empty list of valid markers, or a throw: what every check below starts with. */
function checkedHosts(hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) throw new ProductionHostsError('the production host list is empty');
  for (const h of hosts) {
    if (typeof h !== 'string' || !MARKER_SHAPE.test(h)) throw new ProductionHostsError('a marker in the production host list is malformed');
  }
  return hosts;
}

/** The marker a host name starts with (in any case), or null. */
function hostMarker(hostname, hosts) {
  const h = String(hostname || '').toLowerCase();
  return checkedHosts(hosts).find((m) => h.startsWith(m)) || null;
}

/** Only well-formed %XX escapes, as libpq decodes them; a stray `%` cannot throw. */
function percentDecoded(value) {
  return value.replace(/%[0-9a-f]{2}/gi, (e) => String.fromCharCode(parseInt(e.slice(1), 16)));
}

/**
 * The marker found ANYWHERE in a value — a connection string's host, a `host`
 * query parameter (libpq lets it override the host), a path — in any case,
 * percent-escaped or not; null when none. The strict reading every guard uses.
 */
function productionMarkerIn(value, hosts) {
  const raw = String(value || '').toLowerCase();
  const decoded = percentDecoded(raw).toLowerCase();
  return checkedHosts(hosts).find((m) => raw.includes(m) || decoded.includes(m)) || null;
}

/** Whether `--expect-host`'s value names production: it starts with one of the markers. */
function namesProduction(expectHost, hosts) {
  const v = String(expectHost || '').toLowerCase();
  return checkedHosts(hosts).some((m) => v.startsWith(m));
}

module.exports = {
  PRODUCTION_HOSTS_FILE,
  MARKER_SHAPE,
  ProductionHostsError,
  parseProductionHosts,
  loadProductionHosts,
  checkedHosts,
  hostMarker,
  productionMarkerIn,
  namesProduction,
};
