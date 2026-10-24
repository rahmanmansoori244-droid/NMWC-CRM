// @vitest-environment node
/**
 * Gap 28 (data audit 2026-10-10): the seal covers every ledger, every column of
 * it, by a key that only grows (lib/seal/canon.ts).
 *
 *  - Every append-only ledger is sealed (SealRecord, the chain itself, apart).
 *  - Every stored column of a sealed model is in the current format version's
 *    list or deliberately left out (SEAL_UNSEALED_COLUMNS, with a reason). A
 *    column added to a ledger fails here until that is decided — and an old
 *    seal keeps verifying with its own version's list.
 *  - The key is the seq for the three cuid-keyed ledgers and the BIGSERIAL id
 *    for the others; seq is @ignore (never in the client) and created as a
 *    BIGSERIAL with a unique index by the seal migration.
 *  - No sealed column is a float (its JSON text is not canonical).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePrismaSchema, storedFields } from '@/lib/compliance/prisma-schema';
import { SEALED_TABLES, SEAL_FORMAT_VERSION, SEAL_UNSEALED_COLUMNS, rangeDigestSql, sealedTables } from '@/lib/seal/canon';
import { APPEND_ONLY_APP_TABLES, HISTORY_TABLES } from '@/lib/history-tables';

const schemaText = readFileSync('prisma/schema.prisma', 'utf8');
const schema = parsePrismaSchema(schemaText);
const fields = (model: string) => storedFields(schema).filter((f) => f.model === model);
const current = sealedTables(SEAL_FORMAT_VERSION);
const SEQ_KEYED = ['AuditLog', 'EditApproval', 'ExportJob'];

describe('what the seal covers', () => {
  it('every ledger, apart from the chain itself', () => {
    const ledgers = ['AuditLog', 'EditApproval', ...HISTORY_TABLES, ...APPEND_ONLY_APP_TABLES].filter((t) => t !== 'SealRecord');
    expect(current.map((t) => t.table).sort()).toEqual([...new Set(ledgers)].sort());
    expect(current.map((t) => t.table)).not.toContain('SealRecord');
  });

  it.each(current.map((t) => [t.table, t] as const))('%s: every stored column is sealed or deliberately not', (table, t) => {
    const cols = fields(table).map((f) => f.name);
    const unsealed = Object.keys(SEAL_UNSEALED_COLUMNS[table] ?? {});
    expect(cols.filter((c) => !t.columns.includes(c) && !unsealed.includes(c)), `decide each new ${table} column`).toEqual([]);
    expect(t.columns.filter((c) => !cols.includes(c)), 'columns that no longer exist').toEqual([]);
    expect(new Set(t.columns).size).toBe(t.columns.length);
    for (const reason of Object.values(SEAL_UNSEALED_COLUMNS[table] ?? {})) expect(reason.length).toBeGreaterThan(10);
  });

  it.each(current.map((t) => [t.table, t] as const))('%s: keyed by a strictly increasing integer, and no float is sealed', (table, t) => {
    expect(t.key).toBe(SEQ_KEYED.includes(table) ? 'seq' : 'id');
    const key = fields(table).find((f) => f.name === t.key)!;
    expect(key.type).toBe('BigInt');
    for (const c of t.columns) {
      expect(fields(table).find((f) => f.name === c)!.type, `${table}.${c}`).not.toBe('Float');
    }
  });

  it('every format version still exists, so an old seal can be verified with its own lists', () => {
    for (let v = 1; v <= SEAL_FORMAT_VERSION; v++) expect(SEALED_TABLES[v], `version ${v}`).toBeDefined();
  });
});

describe('the seq key', () => {
  const sql = readFileSync('prisma/migrations/20261024120200_ledger_seals/migration.sql', 'utf8');
  it.each(SEQ_KEYED)('%s: @ignore in the client, a BIGSERIAL with a unique index in the database', (model) => {
    const block = schemaText.slice(schemaText.indexOf(`model ${model} {`), schemaText.indexOf('\n}', schemaText.indexOf(`model ${model} {`)));
    expect(block).toMatch(/\n\s+seq\s+BigInt\s+@unique @default\(autoincrement\(\)\) @ignore/);
    expect(sql).toContain(`ALTER TABLE "${model}" ADD COLUMN     "seq" BIGSERIAL NOT NULL;`);
    expect(sql).toContain(`CREATE UNIQUE INDEX "${model}_seq_key" ON "${model}"("seq");`);
    // The runtime role may draw from it but never set it.
    expect(sql).toMatch(new RegExp(`GRANT USAGE, SELECT ON SEQUENCE [^;]*"${model}_seq_seq"`));
    expect(sql).toMatch(new RegExp(`REVOKE UPDATE ON SEQUENCE [^;]*"${model}_seq_seq"[^;]* FROM nmwc_app`));
  });
});

describe('the digest SQL', () => {
  it('names only whitelisted identifiers and binds the bounds', () => {
    const q = rangeDigestSql(1, 'AuditLog', 10n, 20n);
    expect(q.values).toEqual(['10', '20']);
    expect(q.sql).toContain('FROM "AuditLog" t');
    expect(q.sql).toContain(`'' ORDER BY t."seq"`);
    expect(q.sql).toContain('json_build_array(t."seq", t."id", t."actorId"');
    expect(() => rangeDigestSql(1, 'User', 0n, 1n)).toThrow(/not sealed/);
    expect(() => rangeDigestSql(9, 'AuditLog', 0n, 1n)).toThrow(/unknown seal format/);
  });
});
