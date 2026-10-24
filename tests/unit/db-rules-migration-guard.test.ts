// @vitest-environment node
/**
 * Gap 31: the migrations that add the database rules hold to lib/db-rules.ts,
 * and schema.prisma holds the same foreign keys (CI's drift gate compares them
 * by name, columns and actions; Prisma ignores CHECK constraints).
 *
 *  - every ADD CONSTRAINT ends NOT VALID, so nothing is scanned and the
 *    production migration cannot fail on old data;
 *  - the constraints added are exactly DB_RULES, the two request links re-added
 *    as RESTRICT, and (gap 18) the route a request was sent from;
 *  - gap 18's migration adds its two columns, its route link NOT VALID, and the
 *    evidence guard as it last was with exactly two more frozen columns;
 *  - each CHECK expression is rule.sql, each foreign key's columns, table and
 *    actions are the rule's;
 *  - no VALIDATE, no data change, nothing dropped but the two request keys —
 *    each dropped and re-added in the same statement;
 *  - lock_timeout is set and reset;
 *  - every foreign-key rule has its @relation in schema.prisma.
 *
 * Structural, per CLAUDE.md: SQL comments are stripped first.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DB_RULES, NOT_VALID_LINKS_NO_OLDER_ROW_BREAKS, type DbFkRule } from '@/lib/db-rules';

const MIGRATION_A = '20261025090000_db_rules_not_valid';
const MIGRATION_B = '20261025090100_request_scope_at_submit';
const MIGRATIONS = [MIGRATION_A, MIGRATION_B];
/** Foreign keys the migrations add NOT VALID that the nightly count leaves out. */
const OTHER_FKS: readonly DbFkRule[] = NOT_VALID_LINKS_NO_OLDER_ROW_BREAKS;

const read = (name: string) => readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8').replace(/\r\n/g, '\n');
/** `--` comments removed (outside quotes: a CHECK's regex holds no `--`, but be exact). */
function stripSqlComments(sql: string): string {
  let out = '';
  let inQuote = false;
  let inBody = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (!inQuote && ch === '$' && sql[i + 1] === '$') inBody = !inBody;
    if (!inBody && ch === "'") inQuote = !inQuote;
    if (!inQuote && !inBody && ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl - 1;
      continue;
    }
    out += ch;
  }
  return out;
}
const ws = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Split on `sep` at paren depth 0 and outside single quotes. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let inBody = false;
  let cur = '';
  let prev = '';
  for (const ch of s) {
    if (!inQuote && ch === '$' && prev === '$') inBody = !inBody;
    prev = ch;
    if (!inBody && ch === "'") inQuote = !inQuote;
    if (!inQuote && !inBody) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === sep && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

type Added =
  | { name: string; table: string; kind: 'check'; expr: string; def: string }
  | { name: string; table: string; kind: 'fk'; columns: string[]; refTable: string; refColumns: string[]; onDelete: string; onUpdate: string; def: string };

const cols = (s: string) => s.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));

function parse(sql: string) {
  const statements = splitTop(stripSqlComments(sql), ';').map(ws).filter(Boolean);
  const added: Added[] = [];
  const dropped: Array<{ table: string; name: string; statement: number }> = [];
  const readds: Array<{ table: string; name: string; statement: number }> = [];
  statements.forEach((st, si) => {
    const m = /^ALTER TABLE "(\w+)" (.*)$/s.exec(st);
    if (!m) return;
    const table = m[1]!;
    for (const raw of splitTop(m[2]!, ',')) {
      const part = ws(raw);
      const drop = /^DROP CONSTRAINT "(\w+)"$/.exec(part);
      if (drop) {
        dropped.push({ table, name: drop[1]!, statement: si });
        continue;
      }
      const add = /^ADD CONSTRAINT "(\w+)" (.*)$/s.exec(part);
      if (!add) continue;
      const [, name, def] = add as unknown as [string, string, string];
      readds.push({ table, name, statement: si });
      const check = /^CHECK \((.*)\) NOT VALID$/s.exec(def);
      if (check) {
        added.push({ name, table, kind: 'check', expr: ws(check[1]!), def });
        continue;
      }
      const fk = /^FOREIGN KEY \(([^)]*)\) REFERENCES "(\w+)"\(([^)]*)\) ON DELETE (SET NULL|RESTRICT|NO ACTION|CASCADE) ON UPDATE (CASCADE|NO ACTION|RESTRICT) NOT VALID$/.exec(def);
      if (fk) {
        added.push({ name, table, kind: 'fk', columns: cols(fk[1]!), refTable: fk[2]!, refColumns: cols(fk[3]!), onDelete: fk[4]!, onUpdate: fk[5]!, def });
        continue;
      }
      added.push({ name, table, kind: 'check', expr: '<unparsed>', def });
    }
  });
  return { statements, added, dropped, readds };
}

const parsed = MIGRATIONS.map((n) => ({ name: n, sql: read(n), ...parse(read(n)) }));
const allAdded = parsed.flatMap((p) => p.added);

describe('the gap-31 migrations', () => {
  it.each(parsed.map((p) => [p.name, p] as const))('%s: every ADD CONSTRAINT ends NOT VALID', (_n, p) => {
    const adds = stripSqlComments(p.sql).match(/ADD CONSTRAINT[\s\S]*?(?=,\s*\n\s*(ADD|DROP) |;)/g) ?? [];
    expect(adds.length).toBeGreaterThan(0);
    for (const a of adds) expect(ws(a), a).toMatch(/NOT VALID$/);
    expect(p.added.length).toBe(adds.length);
  });

  it('adds exactly the rules of lib/db-rules.ts and the other NOT VALID links', () => {
    const want = [...DB_RULES, ...OTHER_FKS].map((r) => r.name).sort();
    expect(allAdded.map((a) => a.name).sort()).toEqual(want);
    expect(new Set(want).size).toBe(want.length);
  });

  it.each(DB_RULES.filter((r) => r.kind === 'check').map((r) => [r.name, r] as const))(
    '%s: the CHECK is rule.sql, on its table',
    (name, rule) => {
      const a = allAdded.find((x) => x.name === name)!;
      expect(a.kind).toBe('check');
      expect(a.table).toBe(rule.table);
      if (a.kind === 'check' && rule.kind === 'check') expect(a.expr).toBe(ws(rule.sql));
    }
  );

  it.each([...DB_RULES, ...OTHER_FKS].filter((r): r is DbFkRule => r.kind === 'fk').map((r) => [r.name, r] as const))(
    '%s: columns, table and actions are the rule’s',
    (name, rule) => {
      const a = allAdded.find((x) => x.name === name)!;
      expect(a.kind).toBe('fk');
      if (a.kind !== 'fk') return;
      expect(a.table).toBe(rule.table);
      expect(a.columns).toEqual([...rule.columns]);
      expect(a.refTable).toBe(rule.refTable);
      expect(a.refColumns).toEqual([...rule.refColumns]);
      expect(a.onDelete).toBe(rule.onDelete);
      expect(a.onUpdate).toBe(rule.onUpdate);
    }
  );

  it.each(parsed.map((p) => [p.name, p] as const))('%s: no VALIDATE, no data change, nothing dropped but the request keys', (_n, p) => {
    const sql = stripSqlComments(p.sql);
    expect(sql).not.toMatch(/\bVALIDATE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+(COLUMN|TABLE|INDEX|TRIGGER|FUNCTION)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    for (const d of p.dropped) {
      expect(['CustomerEdit_customerId_fkey', 'CustomerEdit_branchId_fkey']).toContain(d.name);
      // Re-added in the same statement, so the table is never without it.
      expect(p.readds.some((r) => r.name === d.name && r.table === d.table && r.statement === d.statement)).toBe(true);
    }
  });

  it('migration A drops and re-adds exactly the two request keys as RESTRICT', () => {
    const a = parsed.find((p) => p.name === MIGRATION_A)!;
    expect(a.dropped.map((d) => d.name).sort()).toEqual(['CustomerEdit_branchId_fkey', 'CustomerEdit_customerId_fkey']);
    for (const name of ['CustomerEdit_customerId_fkey', 'CustomerEdit_branchId_fkey']) {
      const x = a.added.find((y) => y.name === name)!;
      expect(x.kind === 'fk' && x.onDelete).toBe('RESTRICT');
    }
    // The pair key the composite foreign keys need, created before them.
    const idx = a.statements.findIndex((s) => s === 'CREATE UNIQUE INDEX "SubChannel_id_channelId_key" ON "SubChannel"("id", "channelId")');
    const firstFk = a.statements.findIndex((s) => s.includes('_subChannelId_channelId_fkey'));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(firstFk);
  });

  it.each(parsed.map((p) => [p.name, p] as const))('%s: one ALTER TABLE per table, under lock_timeout', (_n, p) => {
    const tables = p.statements.map((s) => /^ALTER TABLE "(\w+)"/.exec(s)?.[1]).filter(Boolean);
    expect(new Set(tables).size).toBe(tables.length);
    expect(p.statements[0]).toBe("SET lock_timeout = '10s'");
    expect(p.statements.at(-1)).toBe('RESET lock_timeout');
  });

  it('corrects the stale comment about a CR index in its header, not in the old migration', () => {
    const a = parsed.find((p) => p.name === MIGRATION_A)!;
    expect(a.sql).toMatch(/20260510160000_p1_drop_phone_unique says a crNumberNorm partial-unique\n-- index exists\. There is none/);
    // The old migration is never edited once applied.
    expect(read('20260510160000_p1_drop_phone_unique')).toMatch(/The crNumberNorm partial-unique index is NOT touched/);
  });
});

describe('gap 18: the request-scope migration', () => {
  const b = parsed.find((p) => p.name === MIGRATION_B)!;

  it('adds the two columns as Prisma writes them, and the route link NOT VALID', () => {
    const alter = b.statements.find((st) => st.startsWith('ALTER TABLE "CustomerEdit"'))!;
    expect(alter).toContain('ADD COLUMN "regionIdsAtSubmit" TEXT[]');
    expect(alter).toContain('ADD COLUMN "routeIdAtSubmit" TEXT,');
    expect(b.added.map((a) => a.name)).toEqual(['CustomerEdit_routeIdAtSubmit_fkey']);
    expect(b.dropped).toEqual([]);
  });

  it('the evidence guard is its last definition with exactly the two columns frozen too', () => {
    const body = (sql: string) => {
      const start = sql.lastIndexOf('CREATE OR REPLACE FUNCTION nmwc_customeredit_evidence_guard()');
      const open = sql.indexOf('$$', start);
      return sql.slice(open + 2, sql.indexOf('$$', open + 2));
    };
    const before = body(read('20261014100000_lossless_paths'));
    const after = body(b.sql);
    const added = [
      `    IF NEW."routeIdAtSubmit" IS DISTINCT FROM OLD."routeIdAtSubmit" THEN changed := changed || 'routeIdAtSubmit'::text; END IF;\n`,
      `    IF NEW."regionIdsAtSubmit" IS DISTINCT FROM OLD."regionIdsAtSubmit" THEN changed := changed || 'regionIdsAtSubmit'::text; END IF;\n`,
    ];
    for (const line of added) expect(after).toContain(line);
    expect(added.reduce((x, line) => x.replace(line, ''), after)).toBe(before);
    expect(b.sql).toMatch(/REVOKE EXECUTE ON FUNCTION nmwc_customeredit_evidence_guard\(\) FROM PUBLIC;/);
    expect(b.sql).toContain('SET search_path = pg_catalog, public, pg_temp');
  });
});

describe('schema.prisma holds the same foreign keys', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8').replace(/\r\n/g, '\n');
  const model = (name: string) => {
    const m = new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
    expect(m, name).not.toBeNull();
    return m![1]!.split('\n').filter((l) => !l.trim().startsWith('//'));
  };
  const ACTION: Record<string, string> = { 'SET NULL': 'SetNull', RESTRICT: 'Restrict', 'NO ACTION': 'NoAction', CASCADE: 'Cascade' };

  it.each([...DB_RULES, ...OTHER_FKS].filter((r): r is DbFkRule => r.kind === 'fk').map((r) => [r.name, r] as const))(
    '%s has its @relation',
    (_name, rule) => {
      const fields = `fields: [${rule.columns.join(', ')}]`;
      const refs = `references: [${rule.refColumns.join(', ')}]`;
      const line = model(rule.table).find((l) => l.includes(fields) && l.includes(refs) && new RegExp(`\\s${rule.refTable}\\?\\s`).test(l));
      expect(line, `${rule.table} → ${rule.refTable} (${rule.columns.join(', ')})`).toBeDefined();
      expect(line).toContain(`onDelete: ${ACTION[rule.onDelete]}`);
      if (rule.onUpdate === 'NO ACTION') expect(line).toContain('onUpdate: NoAction');
      else expect(line).not.toMatch(/onUpdate: (?!Cascade)/);
    }
  );

  it('SubChannel carries the pair key the composite foreign keys point at', () => {
    expect(model('SubChannel').some((l) => l.trim() === '@@unique([id, channelId])')).toBe(true);
  });
});
