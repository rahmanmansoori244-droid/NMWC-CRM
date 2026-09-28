// @vitest-environment node
/**
 * N08 (auditor recheck, 2026-09-27): a failed restore must not publish customer
 * rows in this PUBLIC repository's Actions logs or artifacts.
 *
 * The drill printed `tail -40 restore.log` and up to twenty raw ERROR lines, and
 * uploaded restore.log as a 90-day artifact; CI's restore chain did the same. A
 * failed COPY, CHECK or unique-index build quotes the row it failed on. The fix
 * is one load script both workflows run — summary only, full log sealed with
 * age, plaintext shredded — and this file pins it three ways:
 *
 *   1. the workflows, parsed: no step loads a dump or touches the plaintext log
 *      except through the script, and no artifact lists it;
 *   2. the script, read with its comments stripped: psql's output goes to the
 *      log file and nowhere else, and only the sanitiser and age read it;
 *   3. the script, EXECUTED under bash with psql and age stubbed and the real
 *      sanitiser: a failure that quotes a row prints none of it, leaves no
 *      plaintext, and keeps the row only inside the sealed copy.
 *
 * And restore-verify.ts, whose output and --json file go to the same public
 * places, prints no database error's message.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { runStep, STEP_TEST_TIMEOUT_MS } from '../support/workflow-step';
import { stripComments } from '../support/strip-comments';
import { describeError } from '../../scripts/ops/describe-error';

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Workflow = { env?: Record<string, unknown>; jobs?: Record<string, { env?: Record<string, unknown>; steps?: Step[] }> };

const DRILL = load(readFileSync('.github/workflows/restore-drill.yml', 'utf8')) as Workflow;
const CI = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as Workflow;
const LOAD_SCRIPT = 'scripts/ops/restore-load.sh';

/** A run: block's lines, shell comments dropped (bash would not run them). */
function commandLines(run: unknown): string[] {
  return String(run ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

const drillSteps = DRILL.jobs?.drill?.steps ?? [];
const chainSteps = CI.jobs?.['restore-chain']?.steps ?? [];
const allCiSteps = Object.values(CI.jobs ?? {}).flatMap((j) => j.steps ?? []);

/** A path to the PLAINTEXT restore log: `restore.log`, not `restore.log.age`. */
const PLAINTEXT_LOG = /restore\.log(?![.\w])/;

describe('the workflows never read, print or upload the plaintext restore log', () => {
  it('finds the steps it checks at all', () => {
    expect(drillSteps.length).toBeGreaterThan(5);
    expect(chainSteps.length).toBeGreaterThan(5);
  });

  it.each([
    ['restore-drill.yml', drillSteps],
    ['ci.yml', allCiSteps],
  ] as const)('%s loads a dump only through the load script', (_file, steps) => {
    for (const s of steps) {
      for (const line of commandLines(s.run)) {
        // --echo-errors is how the load script runs psql; anywhere else it is a
        // second load path whose log nothing sanitises.
        expect(line, `${s.name}: ${line}`).not.toMatch(/--echo-errors/);
        expect(line, `${s.name}: ${line}`).not.toMatch(/gunzip[^|]*\|\s*psql/);
      }
    }
  });

  it.each([
    ['restore-drill.yml', drillSteps],
    ['ci.yml', allCiSteps],
  ] as const)('%s mentions the plaintext log only to assert it is gone', (_file, steps) => {
    for (const s of steps) {
      for (const line of commandLines(s.run)) {
        if (!PLAINTEXT_LOG.test(line)) continue;
        // `tail`, `cat`, `grep`, `head` or an upload of it was the defect.
        expect(line, `${s.name}: ${line}`).toMatch(/^\[ ! -e \S*restore\.log \] \|\| \{ echo "::error::[^"]*"; exit 1; \}$/);
      }
    }
  });

  it('the drill and the CI chain both restore through the load script, un-softened', () => {
    const runsIt = (steps: Step[]) =>
      steps.flatMap((s) => commandLines(s.run)).filter((l) => /(^|\s)bash (\.\.\/)?scripts\/ops\/restore-load\.sh$/.test(l));
    for (const steps of [drillSteps, chainSteps]) {
      const lines = runsIt(steps);
      expect(lines.length).toBeGreaterThan(0);
      // No `|| true`, no `;`, no background: the script's exit status is the step's.
      for (const l of lines) expect(l).not.toMatch(/\|\||;|&(?!&)/);
    }
    const drillRestore = drillSteps.find((s) => s.name === 'Restore');
    expect(commandLines(drillRestore?.run).some((l) => l.endsWith('bash scripts/ops/restore-load.sh'))).toBe(true);
  });

  it('the drill seals the log to BACKUP_AGE_RECIPIENTS', () => {
    expect(DRILL.jobs?.drill?.env?.BACKUP_AGE_RECIPIENTS).toBe('${{ vars.BACKUP_AGE_RECIPIENTS }}');
  });

  it('every artifact of both restore jobs is a closed list with no plaintext log and no glob', () => {
    const uploads = (steps: Step[]) =>
      steps
        .filter((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'))
        .map((s) => String(s.with?.path ?? '').split('\n').map((p) => p.trim()).filter(Boolean));
    expect(uploads(drillSteps)).toEqual([['restore.log.age', 'restore-verify.json', 'manifest.json']]);
    expect(uploads(chainSteps)).toEqual([['manifest.json', 'restore-verify.json']]);
  });

  it('CI proves a real failed restore publishes nothing of its row', () => {
    const proof = chainSteps.find((s) => s.name === 'A failed restore publishes nothing of the row it failed on');
    const lines = commandLines(proof?.run);
    expect(lines.some((l) => l.includes('bash ../scripts/ops/restore-load.sh'))).toBe(true);
    // The marker must be absent from the output and present in the sealed log,
    // or the step proves nothing.
    expect(lines.some((l) => /^if grep -q "\$MARK" broken\/out\.txt broken\/summary\.md; then .*exit 1; fi$/.test(l))).toBe(true);
    expect(lines.some((l) => /age -d -i broken\.key broken\/restore\.log\.age \| grep -c "\$MARK"/.test(l))).toBe(true);
    // And it runs before the upload, so a failure here is not skipped by it.
    const names = chainSteps.map((s) => s.name);
    expect(names.indexOf(proof?.name)).toBeLessThan(names.indexOf('Upload evidence'));
  });
});

describe('the load script, read', () => {
  // Shell comments dropped: every line of the script that bash would run.
  const code = readFileSync(LOAD_SCRIPT, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  it('sends everything psql says to the log file and nowhere else', () => {
    const psql = code.filter((l) => /(^|\|\s*)psql\s/.test(l));
    expect(psql).toHaveLength(1);
    expect(psql[0]).toMatch(/-v ON_ERROR_STOP=1 -v VERBOSITY=verbose --echo-errors > "\$LOG" 2>&1 \|\| LOAD_EXIT=\$\?$/);
  });

  it('lets only the sanitiser and age read the log, and shreds it on every exit', () => {
    const readers = code.filter((l) => l.includes('"$LOG"') && !/--echo-errors > "\$LOG"/.test(l));
    for (const l of readers) {
      expect(l, l).toMatch(/^(SUMMARY_ARGS=\("\$LOG" |if \[ "\$\{#AGE_ARGS\[@\]\}" -gt 0 \] && age "\$\{AGE_ARGS\[@\]\}" -o "\$SEALED" "\$LOG"; then$|if \[ -e "\$LOG" \]; then shred -u "\$LOG"|rm -f "\$LOG" "\$SEALED"$)/);
    }
    expect(code).toContain('trap discard_plaintext EXIT');
    expect(code.some((l) => /node --import tsx scripts\/ops\/restore-log-summary\.ts "\$\{SUMMARY_ARGS\[@\]\}"/.test(l))).toBe(true);
  });
});

/**
 * The script EXECUTED. psql and age are stubbed as exported bash functions, which
 * the script's own bash inherits; the sanitiser is the real one, through tsx.
 * The stub age is rot13, so the test can tell the sealed copy holds the row
 * without the row appearing in it as plain text.
 */
const STUBS = String.raw`
# Builtins only: on Windows every process Git Bash starts costs up to seconds.
psql() { printf '%s' "$PSQL_OUT"; return "$PSQL_RC"; }
gunzip() { printf 'COPY public."Customer" (id) FROM stdin;\n'; }
age() {
  local out='' in=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -r) shift 2 ;;
      -o) out="$2"; shift 2 ;;
      *) in="$1"; shift ;;
    esac
  done
  if [ -n "$AGE_FAIL" ]; then return 1; fi
  tr 'A-Za-z' 'N-ZA-Mn-za-m' < "$in" > "$out"
}
export -f psql gunzip age
`;

/** Runs the load script, then reports on what it left behind — never the log itself. */
const HARNESS = String.raw`
CODE=0
GITHUB_STEP_SUMMARY="$STUB_DIR/summary.md" bash "$LOAD_SCRIPT" > load.out 2>&1 || CODE=$?
echo "==LOAD=="
cat load.out
echo "==END=="
echo "CODE=$CODE"
if [ -e restore.log ]; then echo "PLAINTEXT=left"; else echo "PLAINTEXT=gone"; fi
if [ -e restore.log.age ]; then
  echo "SEALED=yes"
  echo "SEALED_ROWS=$(tr 'A-Za-z' 'N-ZA-Mn-za-m' < restore.log.age | grep -c 'ZQXSHOPNAME' || true)"
else
  echo "SEALED=no"
fi
echo "==SUMMARY=="
if [ -e summary.md ]; then cat summary.md; fi
echo "==SUMMARY_END=="
`;

const FAILED_LOAD = [
  'SET',
  'CREATE TABLE',
  'COPY 40',
  'psql:<stdin>:4127: ERROR:  23514: new row for relation "Customer" violates check constraint "Customer_gps_range"',
  'DETAIL:  Failing row contains (cmf0zqx0001, ZQXSHOPNAME Trading LLC, +968 9123 4567, Way 1234 Al Khuwair, $2b$10$ZQXHASHabcdef).',
  'CONTEXT:  COPY Customer, line 812: "cmf0zqx0001\tZQXSHOPNAME Trading LLC\t+968 9123 4567\tWay 1234 Al Khuwair\t$2b$10$ZQXHASHabcdef"',
  'LOCATION:  ExecConstraints, execMain.c:2019',
  'psql:<stdin>:4127: STATEMENT:  COPY public."Customer" (id, "legalName") FROM stdin;',
  '',
].join('\n');

const CLEAN_LOAD = ['SET', 'CREATE TABLE', 'COPY 40', 'CREATE INDEX', ''].join('\n');

function load_(psqlOut: string, env: Record<string, string>) {
  const o = runStep(HARNESS, STUBS, {
    LOAD_SCRIPT: resolve(LOAD_SCRIPT).replace(/\\/g, '/'),
    RESTORE_TARGET_URL: 'postgresql://stub:stub@localhost:5432/stub',
    RESTORE_DUMP: 'dump.sql.gz',
    PSQL_RC: '0',
    // Always set: the stub runs inside the script's `set -u`, and a template
    // literal cannot spell the shell's default-value expansion.
    AGE_FAIL: '',
    BACKUP_AGE_RECIPIENTS: 'age1stubrecipientaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ...env,
    PSQL_OUT: psqlOut,
  });
  const section = (from: string, to: string) => o.output.split(from)[1]?.split(to)[0] ?? '';
  const field = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(o.output)?.[1]?.trim();
  return {
    status: o.status,
    printed: section('==LOAD==', '==END=='),
    summary: section('==SUMMARY==', '==SUMMARY_END=='),
    code: field('CODE'),
    plaintext: field('PLAINTEXT'),
    sealed: field('SEALED'),
    sealedRows: field('SEALED_ROWS'),
  };
}

const ROW_BITS = ['ZQX', 'Trading', '+968', '9123 4567', 'Khuwair', '$2b$', 'Failing row', 'violates'];

describe('the load script, executed', () => {
  it(
    'a load that fails on a row prints its line, SQLSTATE and table, none of the row, and keeps the row only sealed',
    () => {
      const r = load_(FAILED_LOAD, { PSQL_RC: '3' });
      expect(r.status).toBe(0);
      expect(r.code).toBe('1');
      expect(ROW_BITS.filter((b) => r.printed.includes(b))).toEqual([]);
      expect(ROW_BITS.filter((b) => r.summary.includes(b))).toEqual([]);
      expect(r.printed).toContain('ERROR  dump line 4127  SQLSTATE 23514  phase data  COPY  public.Customer');
      expect(r.printed).toContain('restore finished with 1 error line(s)');
      expect(r.summary).toContain('| ERROR | 4127 | 23514 | data | COPY | public.Customer | 812 |');
      expect(r.plaintext).toBe('gone');
      // Not vacuous: the full log WAS kept, and it does quote the row.
      expect(r.sealed).toBe('yes');
      expect(Number(r.sealedRows)).toBeGreaterThan(0);
    },
    STEP_TEST_TIMEOUT_MS
  );

  it(
    'a clean load exits 0 with the line the runbook looks for, and still leaves no plaintext',
    () => {
      const r = load_(CLEAN_LOAD, {});
      expect(r.code).toBe('0');
      expect(r.printed).toContain('restore finished with 0 error line(s)');
      expect(r.plaintext).toBe('gone');
      expect(r.sealed).toBe('yes');
    },
    STEP_TEST_TIMEOUT_MS
  );

  it(
    'without recipients the log is discarded, not kept in the clear, and the run says so',
    () => {
      const r = load_(FAILED_LOAD, { PSQL_RC: '3', BACKUP_AGE_RECIPIENTS: '' });
      expect(r.code).toBe('1');
      expect(r.plaintext).toBe('gone');
      expect(r.sealed).toBe('no');
      expect(r.printed).toContain('::warning::BACKUP_AGE_RECIPIENTS is not set');
      expect(r.printed).toContain('the full log was not kept');
      expect(ROW_BITS.filter((b) => r.printed.includes(b))).toEqual([]);
    },
    STEP_TEST_TIMEOUT_MS
  );

  it(
    'a log that cannot be sealed fails the run even when the load was clean, and is not left behind',
    () => {
      const r = load_(CLEAN_LOAD, { AGE_FAIL: '1' });
      expect(r.code).toBe('1');
      expect(r.plaintext).toBe('gone');
      expect(r.sealed).toBe('no');
      expect(r.printed).toContain('::error::the restore log could not be encrypted');
    },
    STEP_TEST_TIMEOUT_MS
  );
});

describe('restore-verify prints no database message', () => {
  it('describes a database error by its name and codes only', () => {
    const prismaRaw = Object.assign(
      new Error(
        'Invalid `tx.$executeRawUnsafe()` invocation:\n\nRaw query failed. Code: `23514`. Message: `ERROR: new row violates check constraint\nDETAIL: Failing row contains (c1, ZQXSHOPNAME, +968 9123 4567)`'
      ),
      { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: '23514', message: 'Failing row contains (ZQXSHOPNAME)' } }
    );
    expect(describeError(prismaRaw)).toBe('PrismaClientKnownRequestError P2010 23514');
    const bare = new Error('duplicate key value violates unique constraint "x"\nDETAIL: Key (phone)=(+968 9123 4567) already exists. Code: `23505`');
    expect(describeError(bare)).toBe('Error 23505');
    // A field that is not the shape it claims is left out, not printed.
    expect(describeError({ name: 'ZQX SHOP +968', code: 'ZQX shop name' })).toBe('Error');
    expect(describeError('ZQXSHOPNAME')).toBe('Error');
    expect(describeError(null)).toBe('Error');
  });

  it('never puts an error message into a result or onto the console', () => {
    const src = stripComments(readFileSync('scripts/ops/restore-verify.ts', 'utf8'), 'restore-verify.ts');
    // `.message` is read only to CLASSIFY an error (a regex test), or printed only
    // for the script's own VerifyError, whose text it wrote.
    const reads = [...src.matchAll(/[\w)\]]+\.message\b/g)].map((m) => {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      return src.slice(lineStart, src.indexOf('\n', m.index)).trim();
    });
    for (const line of reads) {
      expect(line, line).toMatch(/^const msg = \(err as Error\)\.message;$|err instanceof VerifyError \? err\.message : describeError\(err\)/);
    }
    // And `msg` itself is never interpolated into a detail or a log line.
    expect(src).not.toMatch(/\$\{msg/);
    expect(src).not.toMatch(/console\.\w+\([^)]*\bmsg\b/);
  });
});
