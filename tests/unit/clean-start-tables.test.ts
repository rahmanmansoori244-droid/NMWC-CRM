// @vitest-environment node
/**
 * Go-live clean start: scripts/ops/clean-start/tables.json names what happens
 * to EVERY table (design section 1). A table added by a later migration and not
 * classified here would be neither emptied nor proven kept; a kept table that
 * points into an emptied one would make the TRUNCATE refuse (or, with CASCADE,
 * empty it too). So the list is pinned to prisma/schema.prisma and the
 * migrations, and these rules are proven to fail on a wrong list at the end.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  implicitJoinTables,
  parsePrismaSchema,
  type ParsedSchema,
} from '@/lib/compliance/prisma-schema';
import { HISTORY_TABLES } from '@/lib/history-tables';
import { migrationsInOrder } from '../support/migration-sql';

type Tables = {
  EMPTY: string[];
  PARTIAL: Record<string, string>;
  KEEP: string[];
  ignored: string[];
  baseline: string[];
  notInFingerprint: string[];
};

const TABLES = JSON.parse(readFileSync('scripts/ops/clean-start/tables.json', 'utf8')) as Tables;
const SCHEMA = parsePrismaSchema(readFileSync('prisma/schema.prisma', 'utf8'));

/** Every table the schema makes: its models and the implicit many-to-many join tables. */
function schemaTables(schema: ParsedSchema): string[] {
  return [...schema.models, ...implicitJoinTables(schema)].sort();
}

/** The tables that hold a BEFORE TRUNCATE trigger, by the migrations' own SQL. */
function truncateGuarded(): string[] {
  const out = new Set<string>();
  const re =
    /CREATE\s+TRIGGER\s+[a-z0-9_]+\s+BEFORE\s+TRUNCATE\s+ON\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  for (const m of migrationsInOrder()) for (const t of m.sql.matchAll(re)) out.add(t[1]!);
  return [...out].sort();
}

/**
 * Every foreign key the migrations' own SQL creates, as [migration, from, to]:
 * ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES and inline
 * REFERENCES in CREATE TABLE. Dollar-quoted bodies and comments are left out.
 * Dropped keys are not subtracted, so the rule below can only be stricter than
 * the live catalog (which guards.sql CS003 checks on the night).
 */
function migrationForeignKeys(
  migrations = migrationsInOrder()
): Array<{ migration: string; from: string; to: string }> {
  const out: Array<{ migration: string; from: string; to: string }> = [];
  for (const m of migrations) {
    const sql = m.sql
      .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
      .replace(/--[^\n]*/g, '');
    for (const st of sql.split(';')) {
      const head =
        /^\s*(?:ALTER\s+TABLE(?:\s+ONLY)?|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(
          st
        );
      if (!head) continue;
      for (const r of st.matchAll(/REFERENCES\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi))
        out.push({ migration: m.name, from: head[1]!, to: r[1]! });
    }
  }
  return out;
}

/** The same rule as the schema's, read from the migrations: no kept table points into an emptied one. */
function migrationFkRules(t: Tables, fks = migrationForeignKeys()): string[] {
  const emptied = new Set(t.EMPTY);
  const known = new Set([...t.EMPTY, ...Object.keys(t.PARTIAL), ...t.KEEP]);
  const problems: string[] = [];
  for (const k of fks) {
    for (const side of [k.from, k.to])
      if (!known.has(side)) problems.push(`${k.migration}: ${side} has a foreign key but is not classified`);
    if (!emptied.has(k.from) && emptied.has(k.to))
      problems.push(`${k.migration}: ${k.from} (kept) points into ${k.to} (emptied)`);
  }
  return problems;
}

/**
 * The newest migration this inventory was checked against, by hand, table by
 * table, with its triggers, foreign keys, sequences and enums (the 2026-11-11
 * merge of 85c026e: 42 migrations, the last adding four ImportBatch columns and
 * ImportBatch_shopNotChangedAckById_fkey into User - an emptied table pointing
 * into a kept one, which TRUNCATE ... RESTRICT allows and which leaves User
 * untouched). A later migration fails the pin below on purpose: re-check
 * tables.json, guards.sql and the fingerprint against it, then move the pin.
 */
const REVIEWED_THROUGH = { count: 42, last: '20261111120000_import_shop_notice_ack' };

/** The rules; each returns what is wrong (empty = right). */
function tableRules(t: Tables, schema: ParsedSchema): string[] {
  const problems: string[] = [];
  const classified = [...t.EMPTY, ...Object.keys(t.PARTIAL), ...t.KEEP];
  const seen = new Set<string>();
  for (const name of classified) {
    if (seen.has(name)) problems.push(`${name} is classified twice`);
    seen.add(name);
  }
  const want = schemaTables(schema);
  for (const name of want) if (!seen.has(name)) problems.push(`${name} (schema) is not classified`);
  for (const name of seen)
    if (!want.includes(name)) problems.push(`${name} is classified but is not in the schema`);
  if (JSON.stringify(t.ignored) !== JSON.stringify(['_prisma_migrations']))
    problems.push('only _prisma_migrations is ignored');

  // No kept or partly kept table points into an emptied one (the owning side of a relation holds the column).
  const emptied = new Set(t.EMPTY);
  for (const f of schema.fields) {
    if (!f.relation || emptied.has(f.model)) continue;
    if (!/@relation\([^)]*fields:/.test(f.attributes)) continue;
    if (emptied.has(f.type))
      problems.push(`${f.model}.${f.name} (kept) points into ${f.type} (emptied)`);
  }
  // Implicit join tables point at both sides.
  for (const j of implicitJoinTables(schema)) {
    if (emptied.has(j)) continue;
    const rel = j.slice(1);
    for (const f of schema.fields) {
      if (f.list && f.attributes.includes(`@relation("${rel}"`) && emptied.has(f.model))
        problems.push(`${j} (kept) points into ${f.model} (emptied)`);
    }
  }

  // Every ledger with a TRUNCATE guard is emptied, by the sanctioned window (design section 1).
  for (const g of truncateGuarded())
    if (!emptied.has(g)) problems.push(`${g} has a TRUNCATE guard but is not emptied`);
  // The history is emptied; four of its tables get the baselines.
  for (const h of HISTORY_TABLES)
    if (!emptied.has(h)) problems.push(`${h} (history) is not emptied`);
  const baseline = ['RegionHistory', 'RouteHistory', 'UserHistory', 'RouteOwnerHistory'];
  if (JSON.stringify([...t.baseline].sort()) !== JSON.stringify([...baseline].sort()))
    problems.push('the baseline tables are not the four of history_foundation');
  for (const b of t.baseline) if (!emptied.has(b)) problems.push(`${b} (baseline) is not emptied`);
  // The accounts, routes, regions and their links are kept (the owner's decision).
  for (const k of [
    'User',
    'PasswordHistory',
    'Region',
    'Route',
    '_ManagerRegions',
    'Channel',
    'SubChannel',
    'CronHeartbeat',
  ]) {
    if (!t.KEEP.includes(k)) problems.push(`${k} must be kept`);
  }
  if (JSON.stringify(Object.keys(t.PARTIAL).sort()) !== JSON.stringify(['CodeSequence', 'CronRun']))
    problems.push('only CodeSequence and CronRun are partly kept');
  if (
    JSON.stringify([...t.notInFingerprint].sort()) !==
    JSON.stringify(['CronHeartbeat', 'CronRun', 'RateLimit'])
  ) {
    problems.push('only CronRun, CronHeartbeat and RateLimit are left out of the fingerprint');
  }
  return problems;
}

describe('clean start: tables.json classifies every table', () => {
  it('the schema has the 37 models and one implicit join table the design names', () => {
    expect(SCHEMA.models).toHaveLength(37);
    expect(implicitJoinTables(SCHEMA)).toEqual(['_ManagerRegions']);
  });

  it('every table is EMPTY, PARTIAL or KEEP, once; no kept table points into an emptied one', () => {
    expect(tableRules(TABLES, SCHEMA)).toEqual([]);
    expect(TABLES.EMPTY).toHaveLength(28);
    expect(TABLES.KEEP).toHaveLength(8);
  });

  it('every ledger the migrations guard against TRUNCATE is in the list (17 of them)', () => {
    expect(truncateGuarded()).toHaveLength(17);
  });

  it('no foreign key in any migration points from a kept table into an emptied one', () => {
    const fks = migrationForeignKeys();
    expect(fks.length).toBeGreaterThan(50);
    expect(migrationFkRules(TABLES, fks)).toEqual([]);
    // The 42nd migration's key: emptied ImportBatch into kept User (allowed).
    expect(fks).toContainEqual({
      migration: '20261111120000_import_shop_notice_ack',
      from: 'ImportBatch',
      to: 'User',
    });
  });

  it('the inventory was checked against every migration there is', () => {
    const all = migrationsInOrder();
    expect({ count: all.length, last: all[all.length - 1]!.name }).toEqual(REVIEWED_THROUGH);
  });
});

describe('clean start: the table rules fail on a wrong list', () => {
  const clone = (): Tables => JSON.parse(JSON.stringify(TABLES)) as Tables;

  it('a table left out', () => {
    const t = clone();
    t.EMPTY = t.EMPTY.filter((x) => x !== 'SavedView');
    expect(tableRules(t, SCHEMA).join('\n')).toMatch(/SavedView \(schema\) is not classified/);
  });
  it('a table classified twice', () => {
    const t = clone();
    t.KEEP.push('Customer');
    expect(tableRules(t, SCHEMA).join('\n')).toMatch(/Customer is classified twice/);
  });
  it('a table that does not exist', () => {
    const t = clone();
    t.EMPTY.push('Ghost');
    expect(tableRules(t, SCHEMA).join('\n')).toMatch(
      /Ghost is classified but is not in the schema/
    );
  });
  it('a kept table that points into an emptied one', () => {
    const t = clone();
    t.EMPTY = t.EMPTY.filter((x) => x !== 'Branch');
    t.KEEP.push('Branch');
    expect(tableRules(t, SCHEMA).join('\n')).toMatch(
      /Branch\.\w+ \(kept\) points into (Customer|Attachment)/
    );
  });
  it('a guarded ledger kept', () => {
    const t = clone();
    t.EMPTY = t.EMPTY.filter((x) => x !== 'AuditLog');
    t.KEEP.push('AuditLog');
    expect(tableRules(t, SCHEMA).join('\n')).toMatch(
      /AuditLog has a TRUNCATE guard but is not emptied/
    );
  });
  it('accounts emptied', () => {
    const t = clone();
    t.KEEP = t.KEEP.filter((x) => x !== 'User');
    t.EMPTY.push('User');
    expect(tableRules(t, SCHEMA).join('\n')).toMatch(/User must be kept/);
  });
  it('a new model the list does not know', () => {
    const extra = parsePrismaSchema(
      `${readFileSync('prisma/schema.prisma', 'utf8')}\nmodel Brandnew {\n  id String @id\n}\n`
    );
    expect(tableRules(TABLES, extra).join('\n')).toMatch(/Brandnew \(schema\) is not classified/);
  });
  it('a migration whose foreign key points from a kept table into an emptied one', () => {
    const extra = [
      ...migrationsInOrder(),
      {
        name: '29991231000000_zz_wrong',
        sql: 'ALTER TABLE "Region" ADD CONSTRAINT "Region_x_fkey" FOREIGN KEY ("x") REFERENCES "ImportBatch"("id") ON DELETE SET NULL;',
      },
    ];
    expect(migrationFkRules(TABLES, migrationForeignKeys(extra)).join('\n')).toMatch(
      /29991231000000_zz_wrong: Region \(kept\) points into ImportBatch \(emptied\)/
    );
  });
  it('a migration whose foreign key names a table the list does not know', () => {
    const extra = [
      ...migrationsInOrder(),
      {
        name: '29991231000000_zz_new',
        sql: 'CREATE TABLE "Brandnew" ("id" TEXT NOT NULL, "u" TEXT REFERENCES "User"("id"));',
      },
    ];
    expect(migrationFkRules(TABLES, migrationForeignKeys(extra)).join('\n')).toMatch(
      /Brandnew has a foreign key but is not classified/
    );
  });
  it('the pin fails when a migration is added after the inventory was checked', () => {
    const all = [...migrationsInOrder().map((m) => m.name), '29991231000000_zz_later'];
    expect({ count: all.length, last: all[all.length - 1] }).not.toEqual(REVIEWED_THROUGH);
  });
});
