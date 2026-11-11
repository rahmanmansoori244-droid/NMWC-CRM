/**
 * Go-live clean start, APPLY step h (and mode finish): the FIRST run of the
 * real integrity watch on production after the reset, read back from
 * IntegrityCheckResult by the workflow (one line per check:
 * `checkId<TAB>status<TAB>open signatures, comma separated`), compared with
 * expected-watch.json night 1 — the same table and the same foreign-seal
 * exception rehearse-watch.ts applies to the rehearsals:
 *
 *   node --import tsx scripts/ops/clean-start/compare-watch.ts <results.tsv> [<foreign keys file>]
 *
 * The foreign keys are the objects under seals/ that PLAN found and that are
 * not production's chain; with any, seal-offsite-copies must FAIL on this run,
 * and its open findings must be exactly those keys' signatures, nothing else.
 *
 * Opens no database (the workflow reads the rows). Prints check ids, statuses
 * and one yes/no line, in rehearse-watch.ts's format; exit 0 = as expected,
 * 1 = not, 2 = the input could not be read.
 */
import { readFileSync } from 'node:fs';
import {
  compareNight,
  foreignSignature,
  loadExpected,
  reportLines,
  type ExpectedWatch,
  type Mismatch,
  type RehearsalResult,
  type Status,
} from './rehearse-watch';

export type ReadBack = { checkId: string; status: string; sigs: string[] };

/** The workflow's read-back: one check per line, tab separated. */
export function parseReadBack(text: string): ReadBack[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [checkId = '', status = '', sigs = ''] = l.split('\t');
      return { checkId, status, sigs: sigs.split(',').filter(Boolean) };
    });
}

/**
 * Night 1 of the expected table, with the foreign-seal exception.
 *
 *   foreignKeys  objects under seals/ that MUST be reported (APPLY: PLAN's list,
 *                made minutes before the first run): seal-offsite-copies must
 *                fail and its open findings must be exactly these.
 *   mayKeys      objects that MAY be reported (mode FINISH: everything under
 *                seals/ that is not production's new chain, listed now; the first
 *                run may have been a scheduled one made before the old seal files
 *                were removed, or one made just now after it). Every open finding
 *                must then be one of foreignKeys + mayKeys; with none open the
 *                check must pass; with some it must fail.
 * A finding outside both lists is a mismatch either way.
 */
export function compareFirstRun(
  rows: ReadonlyArray<ReadBack>,
  foreignKeys: readonly string[],
  expected: ExpectedWatch = loadExpected(),
  mayKeys: readonly string[] = []
): RehearsalResult {
  const table = { ...expected.night1 };
  const sigsOf = (keys: readonly string[]) => new Set(keys.filter((k) => k.startsWith('seals/')).map(foreignSignature));
  const sigs = sigsOf(foreignKeys);
  const may = sigsOf(mayKeys);
  const copies = rows.find((r) => r.checkId === 'seal-offsite-copies');
  const open = new Set(copies?.sigs ?? []);
  if (sigs.size > 0 || (may.size > 0 && open.size > 0)) Object.assign(table, expected.withForeignSeals.night1);
  const mismatches: Mismatch[] = compareNight(1, rows, table);
  if (sigs.size > 0 || may.size > 0) {
    const mustAll = [...sigs].every((s) => open.has(s));
    const onlyKnown = [...open].every((s) => sigs.has(s) || may.has(s));
    const same = mustAll && onlyKnown;
    if (!same)
      mismatches.push({
        night: 1,
        checkId: 'seal-offsite-copies',
        got: (copies?.status ?? 'missing') as Status,
        expected: ['fail'],
      });
  }
  return {
    ok: mismatches.length === 0,
    nights: [
      {
        night: 1,
        at: '',
        statuses: Object.fromEntries(rows.map((r) => [r.checkId, r.status as Status])),
        notAsserted: [],
      },
    ],
    mismatches,
  };
}

function main(argv: string[]): number {
  const [tsv, foreignFile, mayFile] = argv;
  if (!tsv) {
    console.error('usage: compare-watch.ts <results.tsv> [<foreign keys file> [<may keys file>]]');
    return 2;
  }
  let rows: ReadBack[];
  let foreign: string[] = [];
  let may: string[] = [];
  const keys = (f: string) =>
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  try {
    rows = parseReadBack(readFileSync(tsv, 'utf8'));
    if (foreignFile) foreign = keys(foreignFile);
    if (mayFile) may = keys(mayFile);
  } catch {
    console.error('compare-watch: the input could not be read');
    return 2;
  }
  if (rows.length === 0) {
    console.log('first integrity checks as expected: no');
    return 1;
  }
  const r = compareFirstRun(rows, foreign, loadExpected(), may);
  for (const line of reportLines(r)) console.log(line);
  return r.ok ? 0 : 1;
}

if (/compare-watch\.ts$/.test(process.argv[1] ?? '')) {
  process.exitCode = main(process.argv.slice(2));
}
