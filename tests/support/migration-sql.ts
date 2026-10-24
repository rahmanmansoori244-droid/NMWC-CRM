/**
 * Read the migrations' own SQL for what the database should hold: each
 * trigger's table and function (its LAST CREATE), and each function's body,
 * definer rights and search_path (its LAST CREATE OR REPLACE). The nightly
 * integrity check compares the live catalog with constants
 * (lib/integrity/expected.ts); tests/unit/protection-functions-guard.test.ts
 * holds those constants to what this reads, so neither can drift.
 *
 * Bodies are taken exactly as Postgres stores them in pg_proc.prosrc: the text
 * between the dollar quotes, line endings normalised to LF (.gitattributes keeps
 * the files LF; this guards a checkout that did not).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

export function migrationsInOrder(dir = 'prisma/migrations'): Array<{ name: string; sql: string }> {
  return readdirSync(dir)
    .filter((d) => /^\d{14}_/.test(d))
    .sort()
    .map((name) => ({ name, sql: readFileSync(`${dir}/${name}/migration.sql`, 'utf8').replace(/\r\n/g, '\n') }));
}

/** SQL with `--` comments removed, outside dollar-quoted bodies only. */
function stripLineComments(sql: string): string {
  let out = '';
  let i = 0;
  let inBody = false;
  while (i < sql.length) {
    if (sql.startsWith('$$', i)) {
      inBody = !inBody;
      out += '$$';
      i += 2;
      continue;
    }
    if (!inBody && sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

export type TriggerBinding = { table: string; fn: string };

/** Every trigger's table and function, by its last CREATE across the migrations. */
export function triggerBindings(migrations = migrationsInOrder()): Record<string, TriggerBinding> {
  const out: Record<string, TriggerBinding> = {};
  const re = /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+([a-z0-9_]+)\b([\s\S]*?)EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([a-z0-9_]+)\s*\(/gi;
  for (const m of migrations) {
    const sql = stripLineComments(m.sql);
    for (const t of sql.matchAll(re)) {
      const table = /\bON\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(t[2]!)?.[1];
      if (!table) continue;
      out[t[1]!] = { table, fn: t[3]! };
    }
  }
  return out;
}

export type FunctionShape = { md5: string; securityDefiner: boolean; searchPath: string | null };

/** A function's body, rights and search_path, by its last CREATE OR REPLACE across the migrations. */
export function functionShapes(names: string[], migrations = migrationsInOrder()): Record<string, FunctionShape> {
  const out: Record<string, FunctionShape> = {};
  for (const m of migrations) {
    const sql = m.sql;
    for (const name of names) {
      const re = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(`, 'g');
      for (const hit of sql.matchAll(re)) {
        // Skip a definition that sits inside a comment line.
        const lineStart = sql.lastIndexOf('\n', hit.index!) + 1;
        if (sql.slice(lineStart, hit.index!).includes('--')) continue;
        const open = sql.indexOf('$$', hit.index!);
        const close = sql.indexOf('$$', open + 2);
        const end = sql.indexOf(';', close);
        const head = sql.slice(hit.index!, open);
        const tail = sql.slice(close + 2, end);
        const attrs = `${head}\n${tail}`;
        const body = sql.slice(open + 2, close);
        const path = /SET\s+search_path\s*(?:=|TO)\s*([^\n;]+?)\s*(?:\n|$|AS\s|LANGUAGE)/i.exec(attrs)?.[1]?.trim() ?? null;
        out[name] = {
          md5: createHash('md5').update(body, 'utf8').digest('hex'),
          securityDefiner: /\bSECURITY\s+DEFINER\b/i.test(attrs),
          searchPath: path,
        };
      }
    }
  }
  return out;
}
