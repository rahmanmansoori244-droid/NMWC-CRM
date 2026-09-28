// @vitest-environment node
/**
 * N08 (auditor recheck, 2026-09-27): what a failed restore may print in a PUBLIC
 * repository's Actions log.
 *
 * Each log below is shaped the way psql writes it under `-f - -v VERBOSITY=verbose
 * --echo-errors` (the dump on stdin, read as a script, which is what makes psql
 * write the `psql:<stdin>:N:` locus): the server's message with its SQLSTATE,
 * then DETAIL / CONTEXT / LOCATION lines, then psql's echo of the failed
 * statement. The rows in them carry a shop's name, +968 phones, an address and a
 * bcrypt-shaped hash — what PostgreSQL really quotes when a COPY, a CHECK or a
 * unique index fails on a customer row. None of it may reach the summary; the
 * dump line, the SQLSTATE and the table must.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  formatMarkdown,
  formatSummary,
  knownTablesFromSchema,
  summariseRestoreLog,
} from '../../scripts/ops/restore-log-summary';

const KNOWN = knownTablesFromSchema(readFileSync('prisma/schema.prisma', 'utf8'));

/** Anything from a row, a message or a credential. None may appear in any output. */
const FORBIDDEN = [
  'ZQX',
  'Trading',
  '9123',
  '4567',
  '968',
  'Khuwair',
  'Way 1234',
  '$2b$',
  'Failing row',
  'DETAIL',
  'CONTEXT',
  'Key (',
  'violates',
  'duplicated',
  'password',
  'neon.tech',
  'execMain',
];

function leaks(text: string): string[] {
  return FORBIDDEN.filter((f) => text.includes(f));
}

function both(log: string, psqlExit = 0): { text: string; md: string } {
  const s = summariseRestoreLog(log, KNOWN);
  return { text: formatSummary(s, psqlExit), md: formatMarkdown(s, psqlExit) };
}

const ROW = 'cmf0zqx0001\tZQXSHOPNAME Trading LLC\t+968 9123 4567\tWay 1234, Al Khuwair\t$2b$10$ZQXHASHabcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

const COPY_CHECK_FAILURE = [
  'SET',
  'SET',
  ' set_config ',
  '------------',
  ' ',
  '(1 row)',
  '',
  'CREATE TABLE',
  'ALTER TABLE',
  'COPY 2',
  'COPY 40',
  'psql:<stdin>:4127: ERROR:  23514: new row for relation "Customer" violates check constraint "Customer_gps_range"',
  `DETAIL:  Failing row contains (${ROW.split('\t').join(', ')}).`,
  `CONTEXT:  COPY Customer, line 812: "${ROW}"`,
  'LOCATION:  ExecConstraints, execMain.c:2019',
  'psql:<stdin>:4127: STATEMENT:  COPY public."Customer" (id, "legalName", "primaryPhone", address, "passwordHash") FROM stdin;',
  '',
].join('\n');

describe('a COPY that fails on a customer row', () => {
  const s = summariseRestoreLog(COPY_CHECK_FAILURE, KNOWN);

  it('keeps the dump line, the SQLSTATE, the phase, the statement, the table and the row number', () => {
    expect(s.entries).toEqual([
      { severity: 'ERROR', sqlstate: '23514', dumpLine: 4127, phase: 'data', statement: 'COPY', table: 'public.Customer', copyRow: 812 },
    ]);
    expect(s.errors).toBe(1);
    expect(s.copyBlocks).toBe(2);
    expect(s.copyRows).toBe(42);
  });

  it('prints none of the row, the message or the constraint', () => {
    const { text, md } = both(COPY_CHECK_FAILURE, 3);
    expect(leaks(text)).toEqual([]);
    expect(leaks(md)).toEqual([]);
    // Not vacuous: the input really quotes the row, in DETAIL and in the COPY context.
    for (const f of ['ZQX', 'Trading', '+968 9123 4567', 'Khuwair', '$2b$', 'Failing row', 'CONTEXT:  COPY', 'violates']) {
      expect(COPY_CHECK_FAILURE).toContain(f);
    }
    expect(text).toContain('ERROR  dump line 4127  SQLSTATE 23514  phase data  COPY  public.Customer  (row 812 of that COPY block)');
    expect(text).toContain('restore finished with 1 error line(s)');
    expect(md).toContain('| ERROR | 4127 | 23514 | data | COPY | public.Customer | 812 |');
  });
});

describe('a unique index that cannot be built after the data', () => {
  const log = [
    'COPY 18703',
    'ALTER TABLE',
    'psql:<stdin>:90210: ERROR:  23505: could not create unique index "Customer_crNorm_key"',
    'DETAIL:  Key ("crNorm")=(ZQXCR+968 9123 4567) is duplicated.',
    'LOCATION:  comparetup_index_btree_tiebreak, tuplesortvariants.c:1488',
    'psql:<stdin>:90210: STATEMENT:  CREATE UNIQUE INDEX "Customer_crNorm_key" ON public."Customer" USING btree ("crNorm");',
  ].join('\n');

  it('is placed after the data, on the table the index is for, with nothing of the duplicated value', () => {
    const s = summariseRestoreLog(log, KNOWN);
    expect(s.entries).toEqual([
      { severity: 'ERROR', sqlstate: '23505', dumpLine: 90210, phase: 'post-data', statement: 'CREATE INDEX', table: 'public.Customer', copyRow: null },
    ]);
    const { text, md } = both(log, 3);
    expect(leaks(text)).toEqual([]);
    expect(leaks(md)).toEqual([]);
  });
});

describe('a connection that is refused', () => {
  const log =
    'psql: error: connection to server at "ep-zqx-1234.us-east-1.aws.neon.tech" (10.9.68.1), port 5432 failed: FATAL:  password authentication failed for user "ZQXUSER"\n';

  it('says a client error at connect, and nothing of the host, the address or the user', () => {
    const s = summariseRestoreLog(log, KNOWN);
    expect(s.entries).toEqual([
      { severity: 'CLIENT', sqlstate: null, dumpLine: null, phase: 'connect', statement: null, table: null, copyRow: null },
    ]);
    const { text } = both(log, 2);
    expect(leaks(text)).toEqual([]);
    expect(text).toContain('psql client error  dump line ?  SQLSTATE ?  phase connect');
  });
});

describe('a stored value with a line break in it', () => {
  // PostgreSQL prints a value as it is stored. A value carrying a newline continues
  // on a line of its own, and nothing stops that line from LOOKING like one psql
  // wrote. Only the first failure is read: everything after it is its own text.
  const log = [
    'COPY 7',
    'psql:<stdin>:4127: ERROR:  23514: new row for relation "Customer" violates check constraint "Customer_gps_range"',
    'DETAIL:  Failing row contains (c1, ZQXSHOPNAME',
    'psql:<stdin>:91234567: ERROR:  23968: forged by the row',
    'ERROR:  22456: forged again',
    'psql: error: forged client error',
    'psql:<stdin>:96891234: STATEMENT:  COPY public."ZQXNotATable" (id) FROM stdin;',
    ').',
    'CONTEXT:  COPY Customer, line 3: "c1\tZQXSHOPNAME',
    'psql:<stdin>:91234567: FATAL:  57P01: forged',
    '"',
    'psql:<stdin>:4127: STATEMENT:  COPY public."Customer" (id, "legalName") FROM stdin;',
  ].join('\n');

  it('itemises the real failure only, and counts the lines that look like more', () => {
    const s = summariseRestoreLog(log, KNOWN);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ dumpLine: 4127, sqlstate: '23514', table: 'public.Customer', copyRow: 3 });
    expect(s.laterFailureLines).toBe(4);
    expect(s.errors).toBe(5);
  });

  it('prints none of the digits the row carried', () => {
    const { text, md } = both(log, 3);
    for (const out of [text, md]) {
      expect(leaks(out)).toEqual([]);
      for (const d of ['91234567', '96891234', '23968', '22456', '57P01']) expect(out).not.toContain(d);
    }
    expect(text).toContain('4 failure-shaped line(s) after the first');
  });
});

describe('names and codes are only printed from their lists', () => {
  it('a table the schema does not declare, or in another schema, is not named', () => {
    const log = [
      'psql:<stdin>:20: ERROR:  42P01: relation "ZQXSecret" does not exist',
      'CONTEXT:  COPY ZQXSecret, line 1: "x"',
      'psql:<stdin>:20: STATEMENT:  COPY zqx."Customer" (id) FROM stdin;',
    ].join('\n');
    const s = summariseRestoreLog(log, KNOWN);
    expect(s.entries[0]).toMatchObject({ table: null, statement: 'COPY', sqlstate: '42P01' });
    expect(leaks(both(log, 3).text)).toEqual([]);
  });

  it('a five-character code whose class PostgreSQL does not define is not a SQLSTATE', () => {
    const s = summariseRestoreLog('psql:<stdin>:20: ERROR:  ZQ968: nonsense\n', KNOWN);
    expect(s.entries[0]?.sqlstate).toBeNull();
  });

  it('a statement the list does not know is not named, and its text is not kept', () => {
    const log = [
      'psql:<stdin>:31: ERROR:  42601: syntax error at or near "ZQXSHOPNAME"',
      'LINE 1: ZQXSHOPNAME +968 9123 4567',
      '        ^',
      'psql:<stdin>:31: STATEMENT:  ZQXSHOPNAME +968 9123 4567 Way 1234, Al Khuwair',
    ].join('\n');
    const s = summariseRestoreLog(log, KNOWN);
    expect(s.entries[0]).toMatchObject({ statement: null, table: null, dumpLine: 31, phase: 'pre-data' });
    expect(leaks(both(log, 3).text)).toEqual([]);
  });
});

describe('a clean restore', () => {
  it('reports zero errors, the COPY blocks and rows, and lists its warnings without their text', () => {
    const log = [
      'SET',
      'CREATE EXTENSION',
      'psql:<stdin>:14: NOTICE:  00000: extension "pg_trgm" already exists, skipping',
      'CREATE TABLE',
      'psql:<stdin>:60: WARNING:  01000: ZQXSHOPNAME +968 9123 4567',
      'COPY 18703',
      'COPY 0',
      'CREATE INDEX',
      'CREATE TRIGGER',
      '',
    ].join('\r\n');
    const s = summariseRestoreLog(log, KNOWN);
    expect(s.errors).toBe(0);
    expect(s.warnings).toBe(1);
    expect(s.notices).toBe(1);
    expect(s.copyBlocks).toBe(2);
    expect(s.copyRows).toBe(18703);
    const { text } = both(log, 0);
    expect(leaks(text)).toEqual([]);
    expect(text).toContain('WARNING  dump line 60  SQLSTATE 01000  phase pre-data');
    // The line the drill's runbook (OPERATIONS.md §6.12) tells the owner to look for.
    expect(text.split('\n').at(-1)).toBe('restore finished with 0 error line(s)');
  });

  it('says FAILED, not the runbook line, when psql failed without a server error', () => {
    const { text, md } = both('SET\n', 2);
    expect(text).toContain('psql exited 2 without a server error in the log');
    expect(text.split('\n').at(-1)).toBe('restore FAILED (psql exit 2)');
    expect(text).not.toContain('restore finished with 0 error line(s)');
    expect(md).toContain('**restore FAILED (psql exit 2)**');
  });
});

describe('a failure psql raises itself, not the server', () => {
  // pg_dump 17.6+ writes `\restrict <key>` at the top of a plain dump, and a psql
  // older than 17.6 / 16.10 refuses it. Read through `-f -`, psql says where.
  it('is itemised as a client error at its dump line', () => {
    const log = ['SET', 'psql:<stdin>:2: error: invalid command \\restrict', ''].join('\n');
    const s = summariseRestoreLog(log, KNOWN);
    expect(s.entries).toEqual([
      { severity: 'CLIENT', sqlstate: null, dumpLine: 2, phase: 'pre-data', statement: null, table: null, copyRow: null },
    ]);
    const { text, md } = both(log, 3);
    expect(text).toContain('psql client error  dump line 2  SQLSTATE ?  phase pre-data');
    expect(text.split('\n').at(-1)).toBe('restore finished with 1 error line(s)');
    expect(md).toContain('| psql client error | 2 | ? | pre-data |');
  });

  it('fed a bare pipe (no locus, terse) it cannot be itemised, and the summary still says FAILED', () => {
    // What psql writes WITHOUT `-f -`: nothing names it as psql's, so it is not
    // listed. The exit status is what keeps it from reading as a good restore.
    const { text } = both(['SET', 'invalid command \\restrict', ''].join('\n'), 3);
    expect(text).not.toContain('restore finished with 0 error line(s)');
    expect(text.split('\n').at(-1)).toBe('restore FAILED (psql exit 3)');
  });
});
