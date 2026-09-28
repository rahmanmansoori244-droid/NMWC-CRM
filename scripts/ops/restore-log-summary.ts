/**
 * N08 (auditor recheck, 2026-09-27): turn a psql restore log into something that
 * may be printed in a PUBLIC repository's Actions log.
 *
 * The restore drill loads the decrypted production dump with `psql --echo-errors`
 * and, on a failure, printed `tail -40 restore.log` and up to twenty raw ERROR
 * lines into the job log, then uploaded the whole log as a 90-day artifact. The
 * dump is plain COPY, and when a COPY or a constraint fails PostgreSQL quotes the
 * row it failed on: `DETAIL: Failing row contains (…)`, `CONTEXT: COPY Customer,
 * line 812: "<the whole row>"`, `Key (col)=(value) is duplicated` from a unique
 * index build. The repository is public, so anyone can read its Actions logs and
 * any signed-in GitHub user can download its artifacts. A failed drill would have
 * published customer rows.
 *
 * So this is an ALLOWLIST, not a filter. The output is built only from:
 *   - the severity, from a fixed list;
 *   - the SQLSTATE: five characters of [0-9A-Z] whose first two are a class
 *     PostgreSQL defines (psql is run with `-v VERBOSITY=verbose` so every
 *     server message carries one);
 *   - the dump line psql was reading (`psql:<stdin>:N`) and the row number inside
 *     a failing COPY — both integers. psql writes that locus only when it reads
 *     the dump as a script (`-f -`, which restore-load.sh passes); a bare pipe
 *     gets `ERROR:` with no line and a client error with no `psql:` at all;
 *   - the kind of statement (a fixed list) and the table it named, printed ONLY
 *     when that name is one of the tables prisma/schema.prisma declares.
 * No message text, DETAIL, CONTEXT, HINT, LINE or data line is ever copied, so no
 * pattern has to recognise a name or a phone number.
 *
 * The one place row text can sit in the log is the message of the error that
 * stopped the load: its DETAIL and CONTEXT quote the row, and a stored value with
 * a line break in it continues onto lines of its own. psql runs with
 * ON_ERROR_STOP, so that first error is the last thing it reports; every line
 * after it is that error's own text. So only the FIRST failure is itemised, and
 * a severity-shaped line after it is counted and nothing is taken from it — a
 * stored value reading "\nERROR:  12345:" or "psql:x:91234567: ERROR:" cannot
 * put its digits into the output. What remains, stated rather than hidden: a
 * value containing a line break followed by exactly `CONTEXT:  COPY <a schema
 * table>, line <digits>` could set the COPY row number that is printed.
 *
 * The full log is still kept, encrypted with age to BACKUP_AGE_RECIPIENTS, by
 * scripts/ops/restore-load.sh. This summary is what an operator reads first.
 *
 *   npx tsx scripts/ops/restore-log-summary.ts <restore.log> [--psql-exit N] [--markdown <file>] [--schema <path>]
 *
 * Exit status: 0 the log shows a clean restore; 1 it shows an error (or psql
 * exited non-zero); 2 the log could not be read.
 */
import { appendFileSync, readFileSync } from 'fs';
import { implicitJoinTables, parsePrismaSchema } from '../../lib/compliance/prisma-schema';

const SEVERITIES = ['PANIC', 'FATAL', 'ERROR', 'WARNING', 'NOTICE', 'INFO', 'LOG', 'DEBUG'] as const;
type Severity = (typeof SEVERITIES)[number] | 'CLIENT';
const FAILING: ReadonlySet<Severity> = new Set<Severity>(['PANIC', 'FATAL', 'ERROR', 'CLIENT']);

/** Where in pg_dump's plain output the statement sat. */
export type Phase = 'connect' | 'pre-data' | 'data' | 'post-data';

/** Statement kinds, a fixed list: the verb is never copied from the log. */
const KINDS: Array<[RegExp, string]> = [
  [/^COPY\b/i, 'COPY'],
  [/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i, 'CREATE INDEX'],
  [/^CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b/i, 'CREATE TRIGGER'],
  [/^CREATE\s+(?:UNLOGGED\s+)?TABLE\b/i, 'CREATE TABLE'],
  [/^ALTER\s+TABLE\b/i, 'ALTER TABLE'],
  [/^INSERT\s+INTO\b/i, 'INSERT'],
  [/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i, 'CREATE FUNCTION'],
  [/^CREATE\s+TYPE\b/i, 'CREATE TYPE'],
  [/^CREATE\s+EXTENSION\b/i, 'CREATE EXTENSION'],
  [/^CREATE\s+SEQUENCE\b/i, 'CREATE SEQUENCE'],
  [/^CREATE\s+SCHEMA\b/i, 'CREATE SCHEMA'],
  [/^SELECT\s+pg_catalog\.setval\b/i, 'SETVAL'],
  [/^SET\b/i, 'SET'],
  [/^COMMENT\b/i, 'COMMENT'],
];

const IDENT = String.raw`(?:"[^"]{1,63}"|[A-Za-z_][A-Za-z0-9_$]{0,62})`;
const QUALIFIED = String.raw`(${IDENT}(?:\.${IDENT})?)`;
/** Where each kind names its table. Anything else names none. */
const TABLE_OF: Record<string, RegExp> = {
  COPY: new RegExp(String.raw`^COPY\s+(?:ONLY\s+)?${QUALIFIED}`, 'i'),
  'CREATE TABLE': new RegExp(String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}`, 'i'),
  'ALTER TABLE': new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}`, 'i'),
  INSERT: new RegExp(String.raw`^INSERT\s+INTO\s+${QUALIFIED}`, 'i'),
  'CREATE INDEX': new RegExp(String.raw`\sON\s+(?:ONLY\s+)?${QUALIFIED}`, 'i'),
  'CREATE TRIGGER': new RegExp(String.raw`\sON\s+${QUALIFIED}`, 'i'),
};

export type RestoreLogEntry = {
  severity: Severity;
  /** Five characters of [0-9A-Z], or null when the log did not carry one. */
  sqlstate: string | null;
  /** The input line psql was on — a line of the dump. */
  dumpLine: number | null;
  phase: Phase;
  /** From the fixed KINDS list, or null. */
  statement: string | null;
  /** A table the schema declares, or null. Never free text from the log. */
  table: string | null;
  /** The row inside the failing COPY block, when the server said. */
  copyRow: number | null;
};

export type RestoreLogSummary = {
  entries: RestoreLogEntry[];
  /** `COPY n` command tags: blocks that loaded completely, and their rows. */
  copyBlocks: number;
  copyRows: number;
  errors: number;
  warnings: number;
  notices: number;
  /** Failure-shaped lines after the first failure: counted, never read (see the header). */
  laterFailureLines: number;
};

/** SQLSTATE classes PostgreSQL defines (Appendix A). Anything else is not a SQLSTATE. */
const SQLSTATE_CLASSES = new Set(
  '00 01 02 03 08 09 0A 0B 0F 0L 0P 0Z 20 21 22 23 24 25 26 27 28 2B 2D 2F 34 38 39 3B 3D 3F 40 42 44 53 54 55 57 58 72 F0 HV P0 XX'.split(' ')
);

/** The tables a restore can legitimately name: the schema's models, join tables and the ledger. */
export function knownTablesFromSchema(schemaSource: string): Set<string> {
  const schema = parsePrismaSchema(schemaSource);
  return new Set([...schema.models, ...implicitJoinTables(schema), '_prisma_migrations']);
}

/** `public."Customer"` → `public.Customer` when Customer is a known table, else null. */
function knownTable(raw: string | undefined, known: ReadonlySet<string>): string | null {
  if (!raw) return null;
  const parts = raw.match(new RegExp(IDENT, 'g')) ?? [];
  const bare = parts.map((p) => (p.startsWith('"') ? p.slice(1, -1) : p));
  const name = bare[bare.length - 1];
  if (!name || !known.has(name)) return null;
  const schema = bare.length > 1 ? bare[0] : null;
  if (schema !== null && schema !== 'public') return null;
  return `public.${name}`;
}

function kindOf(statement: string): string | null {
  for (const [re, kind] of KINDS) if (re.test(statement)) return kind;
  return null;
}

// `psql:<file>:<line>: ` — the locus psql puts in front of what it reports while
// reading a script. The file part is never kept.
const LOCUS = String.raw`psql:[^\n]*?:(\d+): `;
const SERVER_MSG = new RegExp(String.raw`^(?:${LOCUS})?(${SEVERITIES.join('|')}):\s+(?:([0-9A-Z]{5}):)?`);
const STATEMENT_LINE = new RegExp(String.raw`^(?:${LOCUS})?STATEMENT:\s+(.*)$`);
const CLIENT_ERROR = new RegExp(String.raw`^(?:${LOCUS}|psql: )(?:error: |invalid command )`);
const COPY_CONTEXT = new RegExp(String.raw`^CONTEXT:\s+COPY\s+(${IDENT}),\s+line\s+(\d+)`);
const COPY_TAG = /^COPY (\d+)$/;

/** Pure: read a psql log, return only what may be printed. */
export function summariseRestoreLog(log: string, knownTables: ReadonlySet<string>): RestoreLogSummary {
  const lines = log.replace(/\r\n/g, '\n').split('\n');
  const entries: RestoreLogEntry[] = [];
  let copyBlocks = 0;
  let copyRows = 0;
  let current: RestoreLogEntry | null = null;
  let firstFailure: RestoreLogEntry | null = null;
  let laterFailureLines = 0;
  let sawAnyStatement = false;

  // Where the load had got to WHEN the line was written: before any statement
  // ran (connect), before any COPY finished (pre-data), or after one (post-data,
  // unless the entry turns out to be about data — settled once it is complete).
  const phaseNow = (dumpLine: number | null, severity: Severity): Phase => {
    if (dumpLine === null && !sawAnyStatement && severity !== 'NOTICE') return 'connect';
    return copyBlocks > 0 ? 'post-data' : 'pre-data';
  };

  for (const line of lines) {
    const msg = SERVER_MSG.exec(line);
    const client = !msg && CLIENT_ERROR.test(line);
    if (firstFailure) {
      // Everything after the error that stopped the load is that error's own
      // text, row values included. Count what looks like another failure; take
      // nothing from it, and let only the real STATEMENT/CONTEXT lines below
      // describe the first one.
      if (client || (msg && FAILING.has(msg[2] as Severity))) {
        laterFailureLines += 1;
        continue;
      }
      if (msg) continue;
    } else {
      const tag = COPY_TAG.exec(line);
      if (tag) {
        copyBlocks += 1;
        copyRows += Number(tag[1]);
        sawAnyStatement = true;
        current = null;
        continue;
      }
      if (/^[A-Z][A-Z ]+$/.test(line)) {
        // A bare command tag (`SET`, `CREATE TABLE`, `ALTER TABLE`…): a statement ran.
        sawAnyStatement = true;
        continue;
      }
      if (msg) {
        const code = msg[3] && SQLSTATE_CLASSES.has(msg[3].slice(0, 2)) ? msg[3] : null;
        current = {
          severity: msg[2] as Severity,
          sqlstate: code,
          dumpLine: msg[1] ? Number(msg[1]) : null,
          phase: phaseNow(msg[1] ? Number(msg[1]) : null, msg[2] as Severity),
          statement: null,
          table: null,
          copyRow: null,
        };
        entries.push(current);
        if (FAILING.has(current.severity)) firstFailure = current;
        continue;
      }
      if (client) {
        const at = new RegExp(`^${LOCUS}`).exec(line);
        current = {
          severity: 'CLIENT',
          sqlstate: null,
          dumpLine: at ? Number(at[1]) : null,
          phase: phaseNow(at ? Number(at[1]) : null, 'CLIENT'),
          statement: null,
          table: null,
          copyRow: null,
        };
        entries.push(current);
        firstFailure = current;
        continue;
      }
    }
    if (!current) continue;
    const ctx = COPY_CONTEXT.exec(line);
    if (ctx) {
      current.statement = current.statement ?? 'COPY';
      current.table = current.table ?? knownTable(ctx[1], knownTables);
      current.copyRow = Number(ctx[2]);
      continue;
    }
    const st = STATEMENT_LINE.exec(line);
    if (st) {
      const kind = kindOf(st[2] ?? '');
      current.statement = kind;
      const re = kind ? TABLE_OF[kind] : undefined;
      if (re) current.table = knownTable(re.exec(st[2] ?? '')?.[1], knownTables) ?? current.table;
      // The dump line comes from the message line only. psql prefixes both or
      // neither, and a STATEMENT-shaped line can be row text continuing a DETAIL.
    }
    // Every other line — the message, DETAIL, CONTEXT, HINT, LINE, LOCATION, data
    // — is dropped here by not being read.
  }
  // Table data is the COPY blocks and the sequence values pg_dump writes beside them.
  for (const e of entries) if (e.statement === 'COPY' || e.statement === 'SETVAL' || e.copyRow !== null) e.phase = 'data';
  return {
    entries,
    copyBlocks,
    copyRows,
    errors: entries.filter((e) => FAILING.has(e.severity)).length + laterFailureLines,
    warnings: entries.filter((e) => e.severity === 'WARNING').length,
    notices: entries.filter((e) => e.severity === 'NOTICE' || e.severity === 'INFO').length,
    laterFailureLines,
  };
}

function describe(e: RestoreLogEntry): string {
  const parts = [
    e.severity === 'CLIENT' ? 'psql client error' : e.severity,
    `dump line ${e.dumpLine ?? '?'}`,
    `SQLSTATE ${e.sqlstate ?? '?'}`,
    `phase ${e.phase}`,
  ];
  if (e.statement) parts.push(e.statement);
  if (e.table) parts.push(e.table);
  if (e.copyRow !== null) parts.push(`(row ${e.copyRow} of that COPY block)`);
  return parts.join('  ');
}

/** psql failed, and the log holds no failure line this could read. */
function failedUnread(s: RestoreLogSummary, psqlExit: number): boolean {
  return psqlExit !== 0 && s.errors === 0;
}

/** The lines printed into the job log. Built from the summary's fields only. */
export function formatSummary(s: RestoreLogSummary, psqlExit = 0): string {
  const out = [
    `restore log: ${s.copyBlocks} COPY block(s) loaded completely (${s.copyRows} rows), ${s.warnings} warning(s), ${s.notices} notice(s)`,
  ];
  // Only the failures are listed one by one; notices are counted.
  const shown = s.entries.filter((e) => FAILING.has(e.severity) || e.severity === 'WARNING').slice(0, 20);
  for (const e of shown) out.push(`  ${describe(e)}`);
  if (s.laterFailureLines > 0) {
    out.push(`  ${s.laterFailureLines} failure-shaped line(s) after the first: part of its own message, not itemised`);
  }
  if (failedUnread(s, psqlExit)) {
    // Never the runbook's "0 error line(s)": psql failing on something this could
    // not read is still a failed restore.
    out.push(`  psql exited ${psqlExit} without a server error in the log`);
    out.push(`restore FAILED (psql exit ${psqlExit})`);
  } else {
    out.push(`restore finished with ${s.errors} error line(s)`);
  }
  return out.join('\n');
}

export function formatMarkdown(s: RestoreLogSummary, psqlExit = 0): string {
  const rows = s.entries
    .filter((e) => FAILING.has(e.severity) || e.severity === 'WARNING')
    .slice(0, 20)
    .map(
      (e) =>
        `| ${e.severity === 'CLIENT' ? 'psql client error' : e.severity} | ${e.dumpLine ?? '?'} | ${e.sqlstate ?? '?'} | ${e.phase} | ${e.statement ?? ''} | ${e.table ?? ''} | ${e.copyRow ?? ''} |`
    );
  return [
    '### Restore log (sanitised)',
    '',
    ...(failedUnread(s, psqlExit) ? [`**restore FAILED (psql exit ${psqlExit})**, with no error line in the log this summary could read.`, ''] : []),
    `${s.copyBlocks} COPY block(s) loaded completely (${s.copyRows} rows); ${s.errors} error(s), ${s.warnings} warning(s); psql exit ${psqlExit}.`,
    '',
    ...(rows.length
      ? ['| Severity | Dump line | SQLSTATE | Phase | Statement | Table | COPY row |', '|---|---|---|---|---|---|---|', ...rows, '']
      : []),
    'The full log is never printed: it can quote customer rows. `scripts/ops/restore-load.sh` keeps it only as `restore.log.age`, encrypted to `BACKUP_AGE_RECIPIENTS`, and discards it when that is not set.',
    '',
  ].join('\n');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): number {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('usage: restore-log-summary.ts <restore.log> [--psql-exit N] [--markdown <file>] [--schema <path>]');
    return 2;
  }
  let log: string;
  let known: Set<string>;
  try {
    log = readFileSync(file, 'utf8');
    known = knownTablesFromSchema(readFileSync(arg('schema') ?? 'prisma/schema.prisma', 'utf8'));
  } catch (err) {
    // The code only: a read error's message names the path, never the contents,
    // but the rule for this file is that nothing but the allowlist is printed.
    console.error(`restore-log-summary: could not read the log or the schema (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    return 2;
  }
  const psqlExit = Number(arg('psql-exit') ?? 0) || 0;
  const s = summariseRestoreLog(log, known);
  console.log(formatSummary(s, psqlExit));
  const md = arg('markdown');
  if (md) appendFileSync(md, formatMarkdown(s, psqlExit));
  return s.errors > 0 || psqlExit !== 0 ? 1 : 0;
}

/** Run only as a command: the unit test imports the pure functions above. */
if (/restore-log-summary\.ts$/.test(process.argv[1] ?? '')) {
  process.exit(main());
}
