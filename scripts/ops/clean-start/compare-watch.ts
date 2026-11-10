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

/** Night 1 of the expected table, with the foreign-seal exception when PLAN found foreign keys. */
export function compareFirstRun(
  rows: ReadonlyArray<ReadBack>,
  foreignKeys: readonly string[],
  expected: ExpectedWatch = loadExpected()
): RehearsalResult {
  const table = { ...expected.night1 };
  const sigs = new Set(foreignKeys.filter((k) => k.startsWith('seals/')).map(foreignSignature));
  if (sigs.size > 0) Object.assign(table, expected.withForeignSeals.night1);
  const mismatches: Mismatch[] = compareNight(1, rows, table);
  if (sigs.size > 0) {
    const copies = rows.find((r) => r.checkId === 'seal-offsite-copies');
    const open = new Set(copies?.sigs ?? []);
    const same = open.size === sigs.size && [...sigs].every((s) => open.has(s));
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
  const [tsv, foreignFile] = argv;
  if (!tsv) {
    console.error('usage: compare-watch.ts <results.tsv> [<foreign keys file>]');
    return 2;
  }
  let rows: ReadBack[];
  let foreign: string[] = [];
  try {
    rows = parseReadBack(readFileSync(tsv, 'utf8'));
    if (foreignFile)
      foreign = readFileSync(foreignFile, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
  } catch {
    console.error('compare-watch: the input could not be read');
    return 2;
  }
  if (rows.length === 0) {
    console.log('first integrity checks as expected: no');
    return 1;
  }
  const r = compareFirstRun(rows, foreign);
  for (const line of reportLines(r)) console.log(line);
  return r.ok ? 0 : 1;
}

if (/compare-watch\.ts$/.test(process.argv[1] ?? '')) {
  process.exitCode = main(process.argv.slice(2));
}
