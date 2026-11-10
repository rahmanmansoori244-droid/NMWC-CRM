// @vitest-environment node
/**
 * Go-live clean start: the SHAPE of the SQL that changes production
 * (design final.build_plan 8 and 9). reset.sql and every file it includes may
 * do exactly what the design says and nothing else:
 *
 *   - exactly one TRUNCATE, of exactly the EMPTY tables of tables.json, with
 *     CONTINUE IDENTITY RESTRICT;
 *   - no CASCADE, RESTART, ALTER, DISABLE, session_replication_role, setval,
 *     DROP (but the temporary tables' ON COMMIT DROP) or UPDATE, and no other
 *     statement that changes a definition, a privilege or a setting outside the
 *     transaction;
 *   - DELETE only on CodeSequence and CronRun, each with tables.json's WHERE;
 *   - INSERT only into AuditLog (once) and the four baseline tables (once each),
 *     and the baselines are history_foundation lines 295-335 after exactly the
 *     three substitutions (actorId, source, sourceKind);
 *   - one transaction, in the design's order: window, change context, SHARE
 *     locks on the right tables, guards and fingerprint under the locks, the
 *     TRUNCATE, the DELETEs, the reset row, the baselines, the self-check, COMMIT;
 *   - plan.sql and verify.sql only read.
 * And the lists inside the SQL are tables.json's, and the self-check compares
 * the columns the integrity check compares (lib/integrity/checks.ts CAPTURED).
 *
 * The rules are functions of the files' text, so the last block proves each one
 * fails on a wrong file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAPTURED } from '@/lib/integrity/checks';

const DIR = 'scripts/ops/clean-start';
const read = (f: string) => readFileSync(`${DIR}/${f}`, 'utf8').replace(/\r\n/g, '\n');

type Tables = {
  EMPTY: string[];
  PARTIAL: Record<string, string>;
  KEEP: string[];
  baseline: string[];
  notInFingerprint: string[];
};
const TABLES = JSON.parse(read('tables.json')) as Tables;

type Files = Record<'reset' | 'guards' | 'fingerprint' | 'selfcheck' | 'plan' | 'verify', string>;
const FILES: Files = {
  reset: read('reset.sql'),
  guards: read('guards.sql'),
  fingerprint: read('fingerprint.sql'),
  selfcheck: read('selfcheck.sql'),
  plan: read('plan.sql'),
  verify: read('verify.sql'),
};

const BASELINE_FROM = "NULL, NULL, 'migration:20261013100100_history_foundation', 'migration',";
const BASELINE_TO =
  "NULL, current_setting('nmwc.actor'), current_setting('nmwc.source'), 'script',";

/** history_foundation lines 295-335 (1-based, inclusive). */
function migrationBaseline(): string {
  return readFileSync('prisma/migrations/20261013100100_history_foundation/migration.sql', 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(294, 335)
    .join('\n');
}

// ── a small SQL reader: comments out, strings and dollar bodies kept ─────────

/** `--` comments removed outside strings and dollar-quoted bodies. */
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  let dollar: string | null = null;
  let quote = false;
  while (i < sql.length) {
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        out += dollar;
        i += dollar.length;
        dollar = null;
      } else out += sql[i++];
      continue;
    }
    if (quote) {
      out += sql[i];
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        quote = false;
      }
      i += 1;
      continue;
    }
    const d = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (d) {
      dollar = d[0];
      out += dollar;
      i += dollar.length;
      continue;
    }
    if (sql[i] === "'") {
      quote = true;
      out += sql[i++];
      continue;
    }
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl;
      continue;
    }
    out += sql[i++];
  }
  return out;
}

type Stmt = { text: string; kind: 'sql' | 'meta' };

/**
 * The file as a sequence of SQL statements and psql meta-commands, in order.
 * A `\gset` ends the statement before it, as psql reads it.
 */
function statements(src: string): Stmt[] {
  const sql = stripComments(src);
  const out: Stmt[] = [];
  let buf = '';
  let i = 0;
  let dollar: string | null = null;
  let quote = false;
  const flush = () => {
    const t = buf.replace(/\s+/g, ' ').trim();
    if (t) out.push({ text: t, kind: 'sql' });
    buf = '';
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        buf += dollar;
        i += dollar.length;
        dollar = null;
      } else buf += sql[i++];
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === "'") quote = sql[i + 1] === "'" ? ((buf += "'"), i++, true) : false;
      i += 1;
      continue;
    }
    const d = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (d) {
      dollar = d[0];
      buf += dollar;
      i += dollar.length;
      continue;
    }
    if (ch === "'") {
      quote = true;
      buf += ch;
      i += 1;
      continue;
    }
    // A psql meta-command: a backslash at the start of a line.
    if (ch === '\\' && (i === 0 || sql[i - 1] === '\n')) {
      const nl = sql.indexOf('\n', i);
      const line = sql.slice(i, nl < 0 ? sql.length : nl).trim();
      if (/^\\g(set)?\b/.test(line)) flush();
      else if (buf.trim()) throw new Error(`a meta-command inside a statement: ${line}`);
      out.push({ text: line, kind: 'meta' });
      i = nl < 0 ? sql.length : nl;
      continue;
    }
    if (ch === ';') {
      flush();
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

/** reset.sql with its \ir files in place, in the order psql runs them. */
function expanded(files: Files, which: 'reset' | 'plan' = 'reset'): Stmt[] {
  const out: Stmt[] = [];
  const walk = (src: string) => {
    for (const s of statements(src)) {
      const inc = /^\\ir\s+(\S+)\.sql$/.exec(s.text);
      if (inc) {
        out.push(s);
        walk(files[inc[1] as keyof Files]);
      } else out.push(s);
    }
  };
  walk(files[which]);
  return out;
}

const tableName = (q: string) =>
  q
    .trim()
    .replace(/^public\./, '')
    .replace(/^"|"$/g, '');
const words = (s: string) => s.replace(/\s+/g, ' ').trim();
/** A statement's text with its string literals and dollar bodies blanked. */
const code = (s: string) =>
  s.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').replace(/'(?:[^']|'')*'/g, "''");

const BANNED = [
  /\bCASCADE\b/i,
  /\bRESTART\b/i,
  /\bALTER\b/i,
  /\bDISABLE\b/i,
  /session_replication_role/i,
  /\bsetval\b/i,
  /\bUPDATE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bVACUUM\b/i,
  /\bREINDEX\b/i,
  /\bCOPY\b/i,
  /\bSET\s+(SESSION\s+)?(ROLE|SESSION\s+AUTHORIZATION)\b/i,
  /\bSECURITY\s+DEFINER\b/i,
  /\bpg_terminate_backend\b/i,
  /\bpg_cancel_backend\b/i,
  /\bnextval\b/i,
];

/** The rules over reset.sql and its includes; each returns what is wrong. */
function resetRules(files: Files): string[] {
  const p: string[] = [];
  const all = expanded(files, 'reset');
  const sql = all.filter((s) => s.kind === 'sql').map((s) => s.text);

  // Banned words anywhere (comments aside), strings and DO bodies included.
  for (const s of sql) {
    for (const re of BANNED) if (re.test(s)) p.push(`banned ${re.source}: ${s.slice(0, 80)}`);
    const drops = s.match(/\bDROP\b/gi)?.length ?? 0;
    const onCommit = s.match(/\bON COMMIT DROP\b/gi)?.length ?? 0;
    if (drops !== onCommit) p.push(`DROP outside ON COMMIT DROP: ${s.slice(0, 80)}`);
  }

  // TRUNCATE: exactly one, of exactly the EMPTY tables, CONTINUE IDENTITY RESTRICT.
  const truncs = sql.filter((s) => /\bTRUNCATE\b/i.test(code(s)));
  if (truncs.length !== 1) p.push(`TRUNCATE statements: ${truncs.length}, want 1`);
  for (const t of truncs) {
    const m = /^TRUNCATE TABLE (.+) CONTINUE IDENTITY RESTRICT$/.exec(t);
    if (!m) {
      p.push(
        `TRUNCATE is not "TRUNCATE TABLE <list> CONTINUE IDENTITY RESTRICT": ${t.slice(0, 120)}`
      );
      continue;
    }
    const list = m[1]!.split(',').map(tableName);
    if (new Set(list).size !== list.length) p.push('TRUNCATE names a table twice');
    if (JSON.stringify([...list].sort()) !== JSON.stringify([...TABLES.EMPTY].sort()))
      p.push('TRUNCATE list is not tables.json EMPTY');
  }

  // DELETE: only CodeSequence and CronRun, each once, each with tables.json's WHERE.
  const deletes = sql.filter((s) => /\bDELETE\b/i.test(code(s)));
  const seen: string[] = [];
  for (const d of deletes) {
    const m = /^DELETE FROM (\S+) WHERE (.+)$/.exec(d);
    if (!m) {
      p.push(`DELETE without its WHERE or not a plain DELETE: ${d.slice(0, 100)}`);
      continue;
    }
    const t = tableName(m[1]!);
    seen.push(t);
    const want = TABLES.PARTIAL[t];
    if (want === undefined) p.push(`DELETE on ${t}, which is not PARTIAL`);
    else if (words(m[2]!) !== words(want)) p.push(`DELETE on ${t} has another WHERE`);
  }
  if (JSON.stringify(seen.sort()) !== JSON.stringify(Object.keys(TABLES.PARTIAL).sort()))
    p.push(`DELETEs on ${seen.join(',')}, want one each on CodeSequence and CronRun`);

  // INSERT: AuditLog once, each baseline table once, nothing else.
  const inserts = sql.filter((s) => /\bINSERT\b/i.test(code(s)));
  const into = inserts.map((s) => {
    const m = /^INSERT INTO (\S+) \(/.exec(s);
    return m ? tableName(m[1]!) : `?${s.slice(0, 40)}`;
  });
  const wantInto = ['AuditLog', ...TABLES.baseline].sort();
  if (JSON.stringify([...into].sort()) !== JSON.stringify(wantInto))
    p.push(`INSERTs into ${into.join(',')}, want ${wantInto.join(',')}`);

  // CREATE: only temporary tables dropped at commit.
  for (const s of sql.filter((x) => /\bCREATE\b/i.test(code(x)))) {
    if (!/^CREATE TEMP TABLE \w+ ON COMMIT DROP AS SELECT /.test(s))
      p.push(`CREATE other than a temporary table: ${s.slice(0, 80)}`);
  }

  // DO blocks only read and raise; dynamic SQL only SELECTs.
  for (const s of sql.filter((x) => /^DO \$/.test(x))) {
    // Its own string literals blanked: a 'DELETE' compared with changeKind is not a statement.
    const body = s.replace(/'(?:[^']|'')*'/g, "''");
    if (/\b(INSERT|DELETE|TRUNCATE|CREATE|DROP|PERFORM|COMMIT|ROLLBACK)\b/i.test(body))
      p.push(`a DO block writes: ${s.slice(0, 80)}`);
    for (const e of s.matchAll(/\bEXECUTE\s+format\('([^']*)/gi))
      if (!/^SELECT /.test(e[1]!)) p.push('a DO block executes something other than a SELECT');
    if (!/RAISE EXCEPTION '(?:[^']|'')*' USING ERRCODE = 'CS\d{3}'/.test(s))
      p.push(`a DO block does not raise its own CS code: ${s.slice(0, 80)}`);
  }
  for (const f of sql.join('\n').matchAll(/query_to_xml\(format\(\s*'([^']{0,12})/g))
    if (!/^SELECT /.test(f[1]!)) p.push('a dynamic query is not a SELECT');

  // One transaction, in order.
  const at = (re: RegExp) => all.findIndex((s) => re.test(s.text));
  const order: Array<[string, RegExp]> = [
    ['ON_ERROR_STOP', /^\\set ON_ERROR_STOP on$/],
    ['VERBOSITY sqlstate', /^\\set VERBOSITY sqlstate$/],
    ['BEGIN', /^BEGIN$/],
    ['the window', /^SET LOCAL nmwc\.audit_maintenance = 'on'$/],
    [
      'the change context',
      /^SELECT set_config\('nmwc\.actor',.*set_config\('nmwc\.source', 'script:clean-start:' \|\| :'run_id', true\)/,
    ],
    ['LOCK', /^LOCK TABLE /],
    ['guards', /^\\ir guards\.sql$/],
    ['fingerprint', /^\\ir fingerprint\.sql$/],
    ['the plan check', /ERRCODE = 'CS013'/],
    ['TRUNCATE', /^TRUNCATE /],
    ['DELETE CodeSequence', /^DELETE FROM public\."CodeSequence"/],
    ['DELETE CronRun', /^DELETE FROM public\."CronRun"/],
    ['the reset row', /^INSERT INTO public\."AuditLog"/],
    ['the baselines', /^INSERT INTO "RegionHistory"/],
    ['selfcheck', /^\\ir selfcheck\.sql$/],
    ['COMMIT', /^COMMIT$/],
  ];
  let last = -1;
  for (const [name, re] of order) {
    const i = at(re);
    if (i < 0) p.push(`missing: ${name}`);
    else if (i < last) p.push(`out of order: ${name}`);
    else last = i;
  }
  const count = (re: RegExp) => all.filter((s) => re.test(s.text)).length;
  if (count(/^BEGIN\b/) !== 1 || count(/^COMMIT$/) !== 1)
    p.push('not exactly one BEGIN and one COMMIT');
  if (all.some((s) => /^(ROLLBACK|SAVEPOINT|END|ABORT)\b/i.test(s.text)))
    p.push('a ROLLBACK, SAVEPOINT, END or ABORT');
  for (const s of [
    'lock_timeout',
    'statement_timeout',
    'idle_in_transaction_session_timeout',
    'TimeZone',
  ]) {
    if (count(new RegExp(`^SET LOCAL ${s} = `)) !== 1) p.push(`missing SET LOCAL ${s}`);
  }
  if (all.some((s) => s.kind === 'sql' && /^SET (?!LOCAL )/i.test(s.text)))
    p.push('a SET that outlives the transaction');

  // The SHARE locks: every EMPTY, PARTIAL and KEEP table but CronHeartbeat.
  const lock = all.find((s) => /^LOCK TABLE /.test(s.text))?.text ?? '';
  const lm = /^LOCK TABLE (.+) IN SHARE MODE$/.exec(lock);
  if (!lm) p.push('the LOCK is not "LOCK TABLE <list> IN SHARE MODE"');
  else {
    const want = [
      ...TABLES.EMPTY,
      ...Object.keys(TABLES.PARTIAL),
      ...TABLES.KEEP.filter((t) => t !== 'CronHeartbeat'),
    ].sort();
    const got = lm[1]!.split(',').map(tableName).sort();
    if (JSON.stringify(got) !== JSON.stringify(want))
      p.push('the LOCK list is not EMPTY + PARTIAL + KEEP but CronHeartbeat');
  }
  return p;
}

/** The baselines in reset.sql are history_foundation 295-335 after the three substitutions. */
function baselineRule(reset: string, migration = migrationBaseline()): string[] {
  const p: string[] = [];
  const m = /-- BEGIN BASELINE[^\n]*\n(?:--[^\n]*\n)*([\s\S]*?)\n-- END BASELINE/.exec(reset);
  if (!m) return ['no BEGIN BASELINE / END BASELINE block'];
  const n = migration.split(BASELINE_FROM).length - 1;
  if (n !== 4) p.push(`the migration's baseline has ${n} substitution points, want 4`);
  if (m[1] !== migration.split(BASELINE_FROM).join(BASELINE_TO))
    p.push('the baseline block is not the migration after the three substitutions');
  return p;
}

/** The lists inside the SQL are tables.json's. */
function listRules(files: Files): string[] {
  const p: string[] = [];
  const arr = (s: string) => [...s.matchAll(/'([A-Za-z_]+)'/g)].map((x) => x[1]!).sort();
  const eq = (a: string[], b: string[]) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const keepFp =
    /keep_tables\(t, ord\) AS \(\s*VALUES([\s\S]*?)\n\),/.exec(files.fingerprint)?.[1] ?? '';
  const keepNames = [...keepFp.matchAll(/\('([A-Za-z_]+)',/g)].map((x) => x[1]!);
  if (
    !eq(
      keepNames,
      TABLES.KEEP.filter((t) => !TABLES.notInFingerprint.includes(t))
    )
  )
    p.push('fingerprint keep_tables is not KEEP minus the unfingerprinted');
  const emptyFp =
    /empty_tables\(t\) AS \(\s*VALUES([\s\S]*?)\n\),/.exec(files.fingerprint)?.[1] ?? '';
  if (
    !eq(
      arr(emptyFp),
      TABLES.EMPTY.filter((t) => !TABLES.notInFingerprint.includes(t))
    )
  )
    p.push('fingerprint empty_tables is not EMPTY minus the unfingerprinted');
  const cs001 =
    /-- CS001[\s\S]*?expected text\[\] := ARRAY\[([\s\S]*?)\];/.exec(files.guards)?.[1] ?? '';
  if (
    !eq(arr(stripComments(cs001)), [
      ...TABLES.EMPTY,
      ...Object.keys(TABLES.PARTIAL),
      ...TABLES.KEEP,
      '_prisma_migrations',
    ])
  )
    p.push('guards CS001 is not every table');
  for (const [file, label] of [
    [files.guards, 'CS003'],
    [files.guards, 'CS005'],
    [files.selfcheck, 'CS101'],
  ] as const) {
    const body =
      new RegExp(`-- ${label}[\\s\\S]*?emptied text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`).exec(
        file
      )?.[1] ?? '';
    if (!eq(arr(body), TABLES.EMPTY)) p.push(`${label}'s emptied list is not EMPTY`);
  }
  return p;
}

/** The self-check compares the columns the nightly check compares. */
function capturedRule(selfcheck: string, verify: string): string[] {
  const p: string[] = [];
  for (const master of ['User', 'Route', 'Region'] as const) {
    const want = CAPTURED.find((c) => c.master === master)!.compare.map(([, h]) => h);
    const line =
      new RegExp(`^-- captured ${master}: (.+)$`, 'm').exec(selfcheck)?.[1]?.split(' ') ?? [];
    if (JSON.stringify(line) !== JSON.stringify(want))
      p.push(`selfcheck's captured ${master} is not CAPTURED's`);
    const historyRow = `ROW(${want.map((c) => `l."${c}"`).join(', ')})`;
    for (const [name, src] of [
      ['selfcheck', selfcheck],
      ['verify', verify],
    ] as const) {
      if (!words(src).includes(historyRow))
        p.push(`${name} does not compare ${master} on ${historyRow}`);
    }
  }
  return p;
}

/** plan.sql and verify.sql only read. */
function readOnlyRules(files: Files): string[] {
  const p: string[] = [];
  for (const which of ['plan', 'verify'] as const) {
    const all = which === 'plan' ? expanded(files, 'plan') : statements(files.verify);
    const sql = all.filter((s) => s.kind === 'sql').map((s) => code(s.text));
    if (!all.some((s) => s.text === 'BEGIN READ ONLY'))
      p.push(`${which} is not one READ ONLY transaction`);
    for (const s of sql) {
      if (
        /\b(INSERT|DELETE|TRUNCATE|CREATE|DROP|LOCK|ALTER|GRANT|REVOKE|COPY)\b/i.test(s) ||
        BANNED.some((re) => re.test(s))
      ) {
        p.push(`${which} writes: ${s.slice(0, 80)}`);
      }
    }
    if (
      !all.some((s) => s.text === '\\set ON_ERROR_STOP on') ||
      !all.some((s) => s.text === '\\set VERBOSITY sqlstate')
    )
      p.push(`${which} lacks ON_ERROR_STOP or VERBOSITY sqlstate`);
  }
  return p;
}

/** Every refusal has its own SQLSTATE. */
function codeRule(files: Files): string[] {
  const codes = Object.values(files).flatMap((f) =>
    [...f.matchAll(/ERRCODE = '(CS\d{3})'/g)].map((m) => m[1]!)
  );
  const dup = codes.filter((c, i) => codes.indexOf(c) !== i);
  return dup.length ? [`codes raised in two places: ${[...new Set(dup)].join(',')}`] : [];
}

describe('clean start: reset.sql does exactly what the design says', () => {
  it('statement rules: one TRUNCATE of EMPTY, the two DELETEs, the five INSERTs, nothing banned, in order', () => {
    expect(resetRules(FILES)).toEqual([]);
  });
  it('baseline rule: the four inserts are history_foundation lines 295-335 after the three substitutions', () => {
    expect(baselineRule(FILES.reset)).toEqual([]);
  });
  it('the lists inside the SQL are tables.json', () => {
    expect(listRules(FILES)).toEqual([]);
  });
  it('the self-check and verify compare the columns of lib/integrity/checks.ts CAPTURED', () => {
    expect(capturedRule(FILES.selfcheck, FILES.verify)).toEqual([]);
  });
  it('plan.sql and verify.sql only read', () => {
    expect(readOnlyRules(FILES)).toEqual([]);
  });
  it('each refusal has its own SQLSTATE', () => {
    expect(codeRule(FILES)).toEqual([]);
  });
});

describe('clean start: the SQL rules fail on a wrong file', () => {
  const withReset = (f: (s: string) => string): Files => ({ ...FILES, reset: f(FILES.reset) });
  const truncate = /TRUNCATE TABLE[\s\S]*?CONTINUE IDENTITY RESTRICT;/;
  const cases: Array<[string, Files, RegExp]> = [
    [
      'CASCADE',
      withReset((s) => s.replace('CONTINUE IDENTITY RESTRICT;', 'CONTINUE IDENTITY CASCADE;')),
      /CASCADE|not "TRUNCATE TABLE/,
    ],
    [
      'RESTART IDENTITY',
      withReset((s) => s.replace('CONTINUE IDENTITY RESTRICT;', 'RESTART IDENTITY RESTRICT;')),
      /RESTART/,
    ],
    [
      'a second TRUNCATE',
      withReset((s) =>
        s.replace(
          'DELETE FROM public."CodeSequence"',
          'TRUNCATE TABLE public."CronRun" CONTINUE IDENTITY RESTRICT;\nDELETE FROM public."CodeSequence"'
        )
      ),
      /TRUNCATE statements: 2/,
    ],
    [
      'a table missing from the TRUNCATE',
      withReset((s) => s.replace(truncate, (t) => t.replace('public."SavedView", ', ''))),
      /TRUNCATE list is not tables.json EMPTY/,
    ],
    [
      'a kept table truncated',
      withReset((s) =>
        s.replace(truncate, (t) =>
          t.replace('public."RegionHistory"', 'public."RegionHistory", public."User"')
        )
      ),
      /TRUNCATE list/,
    ],
    [
      'a DELETE without WHERE',
      withReset((s) =>
        s.replace(/DELETE FROM public\."CronRun" WHERE [^;]+;/, 'DELETE FROM public."CronRun";')
      ),
      /DELETE without its WHERE/,
    ],
    [
      'a DELETE with another WHERE',
      withReset((s) => s.replace("'^CUSTOMER-[0-9]{4}$'", "'^CUSTOMER-'")),
      /another WHERE/,
    ],
    [
      'a DELETE on a kept table',
      withReset((s) =>
        s.replace(
          'DELETE FROM public."CodeSequence"',
          'DELETE FROM public."User" WHERE "isTest";\nDELETE FROM public."CodeSequence"'
        )
      ),
      /not PARTIAL/,
    ],
    [
      'an UPDATE',
      withReset((s) =>
        s.replace('COMMIT;', 'UPDATE public."User" SET "isActive" = true WHERE false;\nCOMMIT;')
      ),
      /UPDATE/,
    ],
    [
      'ALTER TABLE ... DISABLE TRIGGER',
      withReset((s) =>
        s.replace('COMMIT;', 'ALTER TABLE public."AuditLog" DISABLE TRIGGER ALL;\nCOMMIT;')
      ),
      /ALTER/,
    ],
    [
      'session_replication_role',
      withReset((s) =>
        s.replace(
          "SET LOCAL TimeZone = 'UTC';",
          "SET LOCAL TimeZone = 'UTC';\nSET LOCAL session_replication_role = replica;"
        )
      ),
      /session_replication_role/,
    ],
    [
      'setval',
      withReset((s) => s.replace('COMMIT;', 'SELECT setval(\'"AuditLog_seq_seq"\', 1);\nCOMMIT;')),
      /setval/,
    ],
    [
      'a DROP',
      withReset((s) => s.replace('COMMIT;', 'DROP TABLE cs_before;\nCOMMIT;')),
      /DROP outside/,
    ],
    [
      'an INSERT elsewhere',
      withReset((s) =>
        s.replace('COMMIT;', `INSERT INTO public."CronRun" ("id") VALUES ('x');\nCOMMIT;`)
      ),
      /INSERTs into/,
    ],
    [
      'the reset row missing',
      withReset((s) => s.replace(/INSERT INTO public\."AuditLog"[\s\S]*?\n        \)\);\n/, '')),
      /INSERTs into|missing: the reset row/,
    ],
    [
      'no maintenance window',
      withReset((s) => s.replace("SET LOCAL nmwc.audit_maintenance = 'on';\n", '')),
      /missing: the window/,
    ],
    [
      'the guards after the TRUNCATE',
      withReset((s) =>
        s
          .replace('\\ir guards.sql\n', '')
          .replace('\\ir selfcheck.sql', '\\ir guards.sql\n\\ir selfcheck.sql')
      ),
      /out of order/,
    ],
    [
      'no self-check',
      withReset((s) => s.replace('\\ir selfcheck.sql\n', '')),
      /missing: selfcheck/,
    ],
    [
      'a lock in another mode',
      withReset((s) => s.replace('IN SHARE MODE;', 'IN ACCESS SHARE MODE;')),
      /LOCK is not/,
    ],
    [
      'a table not locked',
      withReset((s) =>
        s.replace(
          'public."Channel", public."SubChannel"\n  IN SHARE MODE',
          'public."Channel"\n  IN SHARE MODE'
        )
      ),
      /LOCK list/,
    ],
    [
      'a plain SET',
      withReset((s) => s.replace("SET LOCAL TimeZone = 'UTC';", "SET TimeZone = 'UTC';")),
      /outlives|missing SET LOCAL TimeZone/,
    ],
    [
      'a second COMMIT',
      withReset((s) => s.replace('\\ir selfcheck.sql', 'COMMIT;\nBEGIN;\n\\ir selfcheck.sql')),
      /exactly one BEGIN and one COMMIT/,
    ],
    [
      'ON_ERROR_STOP off',
      withReset((s) => s.replace('\\set ON_ERROR_STOP on', '\\set ON_ERROR_STOP off')),
      /missing: ON_ERROR_STOP/,
    ],
    [
      'a DO block that writes',
      {
        ...FILES,
        guards: FILES.guards.replace(
          "RAISE EXCEPTION 'clean-start guard: a trigger is not enabled'",
          'DELETE FROM public."CronRun"; RAISE EXCEPTION \'clean-start guard: a trigger is not enabled\''
        ),
      },
      /a DO block writes|DELETE/,
    ],
    [
      'a guard without its own code',
      { ...FILES, guards: FILES.guards.replace("USING ERRCODE = 'CS004'", '') },
      /does not raise its own CS code/,
    ],
  ];
  for (const [name, files, want] of cases) {
    it(name, () => {
      expect(resetRules(files).join('\n')).toMatch(want);
    });
  }

  it('the baseline rule catches a changed baseline', () => {
    expect(
      baselineRule(FILES.reset.replace('ORDER BY u."createdAt", u."id";', 'ORDER BY u."id";'))
    ).not.toEqual([]);
    expect(
      baselineRule(
        FILES.reset.replace(
          "current_setting('nmwc.source'), 'script'",
          "current_setting('nmwc.source'), 'sql'"
        )
      )
    ).not.toEqual([]);
    expect(
      baselineRule(
        FILES.reset.replace(
          'WHERE o."createdAt" > r."createdAt"',
          'WHERE o."createdAt" >= r."createdAt"'
        )
      )
    ).not.toEqual([]);
  });
  it('the list rules catch a list that drifted from tables.json', () => {
    expect(
      listRules({
        ...FILES,
        fingerprint: FILES.fingerprint.replace(
          '(\'SubChannel\', \'x."id" COLLATE "C"\')',
          '(\'Channel\', \'x."id" COLLATE "C"\')'
        ),
      }).join('\n')
    ).toMatch(/keep_tables/);
    expect(
      listRules({ ...FILES, fingerprint: FILES.fingerprint.replace("('SavedView'),", '') }).join(
        '\n'
      )
    ).toMatch(/empty_tables/);
    expect(
      listRules({ ...FILES, guards: FILES.guards.replace("'CronHeartbeat',\n", '') }).join('\n')
    ).toMatch(/CS001/);
    expect(
      listRules({ ...FILES, selfcheck: FILES.selfcheck.replace("'RateLimit', ", '') }).join('\n')
    ).toMatch(/CS101/);
  });
  it('the captured rule catches a column left out', () => {
    expect(
      capturedRule(
        FILES.selfcheck.replace(
          '-- captured Route: code name regionId isActive',
          '-- captured Route: code name isActive'
        ),
        FILES.verify
      )
    ).not.toEqual([]);
    expect(
      capturedRule(
        FILES.selfcheck,
        FILES.verify.replace(
          'ROW(l."code", l."name", l."regionId", l."isActive")',
          'ROW(l."code", l."name", l."isActive")'
        )
      )
    ).not.toEqual([]);
  });
  it('the read-only rules catch a write in plan.sql or verify.sql', () => {
    expect(
      readOnlyRules({
        ...FILES,
        plan: FILES.plan.replace('COMMIT;', `DELETE FROM public."CronRun" WHERE true;\nCOMMIT;`),
      })
    ).not.toEqual([]);
    expect(
      readOnlyRules({ ...FILES, verify: FILES.verify.replace('BEGIN READ ONLY;', 'BEGIN;') })
    ).not.toEqual([]);
  });
  it('the code rule catches a reused SQLSTATE', () => {
    expect(
      codeRule({ ...FILES, verify: FILES.verify.replace("ERRCODE = 'CS305'", "ERRCODE = 'CS004'") })
    ).not.toEqual([]);
  });
});
