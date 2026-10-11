// @vitest-environment node
/**
 * scripts/ops/restore-load.sh never loads into production (owner decisions
 * 2026-10-11).
 *
 * It is a shell script, so it cannot call the TypeScript guard
 * (scripts/lib/assert-not-production.ts). It refuses on its own a
 * RESTORE_TARGET_URL with the production marker anywhere in it — the host or any
 * other part, in any case, as written or percent-decoded — and a PGHOST or
 * PGHOSTADDR with it, before psql or pg_restore starts.
 *
 * The script is EXECUTED, as tests/unit/restore-drill-guard.test.ts executes it:
 * psql, pg_restore, gunzip, node and age are exported bash functions that only
 * record that they were called, so a broken refusal could reach nothing, and the
 * test sees whether the load would have started. The fake URLs never resolve.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { PRODUCTION_HOST_PREFIX } from '../../scripts/lib/assert-not-production';
import { runStep, STEP_TEST_TIMEOUT_MS } from '../support/workflow-step';

const LOAD_SCRIPT = resolve('scripts/ops/restore-load.sh').replace(/\\/g, '/');

// Builtins only: on Windows every process Git Bash starts costs up to seconds.
const STUBS = String.raw`
psql() { echo psql >> "$STUB_DIR/calls"; local line; while IFS= read -r line; do :; done; return 0; }
pg_restore() { echo pg_restore >> "$STUB_DIR/calls"; return 0; }
gunzip() { echo gunzip >> "$STUB_DIR/calls"; return 0; }
node() { echo node >> "$STUB_DIR/calls"; return 0; }
age() { echo age >> "$STUB_DIR/calls"; return 0; }
export -f psql pg_restore gunzip node age
`;

const HARNESS = String.raw`
CODE=0
bash "$LOAD_SCRIPT" > load.out 2>&1 || CODE=$?
cat load.out
echo "CODE=$CODE"
`;

// Built from pieces so no connection-string-shaped literal sits in the source. All fake.
const PASSWORD = 'synthetic-pw-zq81';
const USER = 'synthetic_owner_zq';
const PROD_ENDPOINT = `${PRODUCTION_HOST_PREFIX}-fake9q7`;
const urlFor = (host: string, rest = '/neondb') => ['postgresql://', USER, ':', PASSWORD, '@', host, rest].join('');

function load(env: Record<string, string>) {
  const o = runStep(HARNESS, STUBS, {
    LOAD_SCRIPT,
    RESTORE_DUMP: 'dump.sql.gz',
    BACKUP_AGE_RECIPIENTS: '',
    PGHOST: '',
    PGHOSTADDR: '',
    ...env,
  });
  return {
    code: /^CODE=(\d+)$/m.exec(o.output)?.[1],
    output: o.output,
    calls: o.calls,
  };
}

function expectNoSecrets(printed: string) {
  expect(printed).not.toContain(PASSWORD);
  expect(printed).not.toContain(USER);
  expect(printed).not.toContain(PROD_ENDPOINT);
  expect(printed).not.toMatch(/postgres(ql)?:\/\//);
}

describe('restore-load.sh refuses production before psql (owner decisions 2026-10-11)', () => {
  it.each([
    ['the production host', { RESTORE_TARGET_URL: urlFor(`${PROD_ENDPOINT}.us-east-1.aws.neon.invalid`) }],
    ['the pooled production host', { RESTORE_TARGET_URL: urlFor(`${PROD_ENDPOINT}-pooler.us-east-1.aws.neon.invalid`) }],
    ['the host in upper case', { RESTORE_TARGET_URL: urlFor(`${PROD_ENDPOINT.toUpperCase()}.NEON.INVALID`) }],
    ['a host query parameter', { RESTORE_TARGET_URL: urlFor('localhost:5432', `/db?host=${PROD_ENDPOINT}.neon.invalid`) }],
    ['a percent-escaped host parameter', { RESTORE_TARGET_URL: urlFor('localhost:5432', '/db?host=ep%2Dsweet%2Dhaze-fake9q7.neon.invalid') }],
    ['an escaped letter, in upper case', { RESTORE_TARGET_URL: urlFor('localhost:5432', '/db?host=%45P%2DSWEET-HAZE-fake.neon.invalid') }],
    // printf %b would stop at `\c` and hide what follows: the decoder must not.
    ['an escape after a backslash-c', { RESTORE_TARGET_URL: urlFor('localhost:5432', '/db?x=\\c&host=ep%2Dsweet%2Dhaze-x.invalid') }],
    ['the marker in another part of the URL', { RESTORE_TARGET_URL: urlFor('localhost:5432', `/${PRODUCTION_HOST_PREFIX}-copy`) }],
    ['a keyword/value connection string', { RESTORE_TARGET_URL: `host=${PROD_ENDPOINT}.neon.invalid dbname=neondb` }],
    ['PGHOST, with a URL that names no host', { RESTORE_TARGET_URL: 'postgresql:///neondb', PGHOST: `${PROD_ENDPOINT}.neon.invalid` }],
    ['PGHOSTADDR', { RESTORE_TARGET_URL: 'postgresql:///neondb', PGHOSTADDR: `${PROD_ENDPOINT}.neon.invalid` }],
  ])(
    'refuses %s: exits 2, and neither psql nor gunzip ever starts',
    (_label, env) => {
      const r = load(env);
      expect(r.code).toBe('2');
      expect(r.calls).toEqual([]);
      expect(r.output).toMatch(/::error::refusing: RESTORE_TARGET_URL \(or PGHOST\) points at PRODUCTION/);
      expectNoSecrets(r.output);
    },
    STEP_TEST_TIMEOUT_MS
  );

  it(
    'not vacuous: an empty, non-production target does reach psql',
    () => {
      const r = load({ RESTORE_TARGET_URL: urlFor('ep-uat-restore-drill.us-east-1.aws.neon.invalid') });
      expect(r.calls).toContain('psql');
      expect(r.calls).toContain('gunzip');
      expect(r.output).not.toMatch(/refusing/);
      expect(r.code).toBe('0');
    },
    STEP_TEST_TIMEOUT_MS
  );
});
