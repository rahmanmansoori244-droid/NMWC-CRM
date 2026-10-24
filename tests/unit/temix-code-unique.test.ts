// @vitest-environment node
/**
 * Owner decision 2026-10-25: Temix codes are unique, and the database enforces
 * it — one live customer per code, compared upper case with the ends trimmed
 * (migration 20261025120000_temix_code_unique).
 *
 *  - The migration: one partial unique index on the expression, live rows with a
 *    code only, a pre-check that refuses in counts first, nothing dropped.
 *  - Prisma cannot describe it: it is not in schema.prisma, and CI's drift gate
 *    allows it by name.
 *  - lib/db-errors.ts temixCodeIndexViolated reads the refusal wherever the
 *    driver put it (the shapes seen on Postgres 17 with Prisma 6.19); no other
 *    unique violation is taken for it.
 *  - lib/temix-code.ts temixCodeRefusal names the live customer holding the code
 *    (temixCodeHolder's wording), reads nothing for any other error, and never
 *    throws; runAction answers any path that did not translate it with the rule.
 *  - The paths that write a Temix code translate it: the approval's finalize
 *    (services/edits.ts) and the customer import's lanes (services/imports.ts).
 *
 * The database half runs on Postgres in tests/integration/temix-code-unique.test.ts.
 * Structural parts read the source with comments stripped (CLAUDE.md).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';
import { TEMIX_CODE_UNIQUE_INDEX, temixCodeIndexViolated } from '@/lib/db-errors';
import {
  TEMIX_CODE_UNIQUE_MESSAGE,
  temixCodeIndexMessage,
  temixCodeRefusal,
  temixCodeTakenMessage,
} from '@/lib/temix-code';
import { runAction } from '@/lib/errors';
import { temixCodeTakenError } from '@/lib/create-finalize';

const MIGRATION = 'prisma/migrations/20261025120000_temix_code_unique/migration.sql';
const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);
const stripSql = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\r\n/g, '\n');

/** The three shapes Postgres 17 and Prisma 6.19 gave on 2026-10-25. */
const MODEL_WRITE = err('Unique constraint failed on the fields: (`upper(btrim(temixCode))`)', {
  code: 'P2002',
  meta: { modelName: 'Customer', target: ['upper(btrim(temixCode))'] },
});
const RAW_WRITE = err('Raw query failed. Code: `23505`. Message: `Key (upper(btrim("temixCode")))=(CAA0367) already exists.`', {
  code: 'P2010',
  meta: { code: '23505', message: 'Key (upper(btrim("temixCode")))=(CAA0367) already exists.' },
});
const ENGINE = err('duplicate key value violates unique constraint "Customer_temixCode_live_unique"');

describe('the migration', () => {
  const sql = stripSql(readFileSync(MIGRATION, 'utf8'));

  it('creates one partial unique index on the code upper-cased and trimmed, for live customers with a code', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "Customer_temixCode_live_unique"\s+ON "Customer" \(upper\(btrim\("temixCode"\)\)\)\s+WHERE "deletedAt" IS NULL AND "temixCode" IS NOT NULL;/
    );
    expect(sql.match(/CREATE (UNIQUE )?INDEX/g)).toHaveLength(1);
    expect(TEMIX_CODE_UNIQUE_INDEX).toBe('Customer_temixCode_live_unique');
  });

  it('says first, in counts only, when live customers already share a code, and is additive', () => {
    expect(sql).toMatch(/GROUP BY 1\s+HAVING count\(\*\) > 1/);
    expect(sql).toMatch(/RAISE EXCEPTION 'Customer_temixCode_live_unique: % Temix code\(s\)/);
    // The pre-check counts codes; it never prints one.
    expect(sql).not.toMatch(/RAISE[^;]*"temixCode"/);
    expect(sql).not.toMatch(/\b(DROP|DELETE FROM|UPDATE "|TRUNCATE|ALTER TABLE)\b/);
    expect(sql).toContain("SET lock_timeout = '10s';");
  });

  it('is not in schema.prisma (Prisma cannot describe it), and the drift gate allows it by name', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8').replace(/\/\/[^\n]*/g, '');
    const customer = schema.slice(schema.indexOf('model Customer {'), schema.indexOf('model Branch {'));
    expect(customer).toMatch(/temixCode\s+String\?\s*\n/);
    expect(customer).not.toMatch(/@@unique\(\[temixCode/);
    expect(customer).toContain('@@index([temixCode])');
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const allowed = /ALLOWED='([^']+)'/.exec(ci)?.[1]?.split('|') ?? [];
    expect(allowed).toContain(TEMIX_CODE_UNIQUE_INDEX);
    expect(allowed).toEqual(expect.arrayContaining(['Customer_legalName_trgm_idx', 'Customer_nmwcCode_trgm_idx']));
  });
});

describe('temixCodeIndexViolated', () => {
  it('a model write (P2002, the key in meta.target), a raw write (P2010, 23505) and an unmapped engine error', () => {
    expect(temixCodeIndexViolated(MODEL_WRITE)).toBe(true);
    expect(temixCodeIndexViolated(RAW_WRITE)).toBe(true);
    expect(temixCodeIndexViolated(ENGINE)).toBe(true);
    // A target given as a string, or the key with Postgres's cast.
    expect(temixCodeIndexViolated({ code: 'P2002', message: 'x', meta: { target: 'upper(btrim(temixCode))' } })).toBe(true);
    expect(temixCodeIndexViolated({ code: 'P2002', message: 'x', meta: { target: ['upper(btrim("temixCode"::text))'] } })).toBe(true);
    // Or the index named, by a driver that names it.
    expect(temixCodeIndexViolated({ code: 'P2002', message: 'x', meta: { target: 'Customer_temixCode_live_unique' } })).toBe(true);
  });

  it('no other unique violation, rule or error is taken for it', () => {
    expect(temixCodeIndexViolated({ code: 'P2002', message: 'x', meta: { target: ['nmwcCode'] } })).toBe(false);
    expect(temixCodeIndexViolated({ code: 'P2002', message: 'x', meta: { target: ['temixCode'] } })).toBe(false);
    expect(temixCodeIndexViolated({ code: 'P2002', message: 'x', meta: { target: 'Customer_temixCode_live_unique_old' } })).toBe(false);
    expect(temixCodeIndexViolated(err('duplicate key value violates unique constraint "Customer_nmwcCode_key"'))).toBe(false);
    // The key quoted in an error that is not a unique violation.
    expect(temixCodeIndexViolated({ code: 'P2004', message: 'upper(btrim(temixCode))' })).toBe(false);
    expect(temixCodeIndexViolated({ code: 'P2010', message: 'Code: `23514` upper(btrim("temixCode"))', meta: { code: '23514' } })).toBe(false);
    expect(temixCodeIndexViolated(new TypeError('x'))).toBe(false);
    expect(temixCodeIndexViolated(null)).toBe(false);
    expect(temixCodeIndexViolated('P2002')).toBe(false);
  });
});

describe('temixCodeRefusal: the live customer holding the code, by name', () => {
  const db = (answer: () => Promise<unknown>) => {
    const queryRaw = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => answer());
    return { db: { $queryRaw: queryRaw } as never, queryRaw };
  };

  it('names the holder in temixCodeHolder’s words, asking by the code as stored and the index compares it', async () => {
    const { db: d, queryRaw } = db(async () => [{ nmwcCode: 'NMWC-2026-000123' }]);
    const message = await temixCodeRefusal(d, MODEL_WRITE, ' caa0367 ', 'cust-1');
    expect(message).toBe(temixCodeTakenMessage('CAA0367', 'NMWC-2026-000123'));
    expect(message).toBe('Temix code CAA0367 already belongs to customer NMWC-2026-000123. Check the code in Temix: every customer has its own.');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = queryRaw.mock.calls[0]!;
    const text = strings.join('?');
    expect(text).toContain('upper(btrim(c."temixCode")) = upper(btrim(?))');
    expect(text).toContain('c."deletedAt" IS NULL');
    expect(values).toEqual(['CAA0367', 'cust-1', 'cust-1']);
  });

  it('any other error: null, and nothing is read', async () => {
    const { db: d, queryRaw } = db(async () => [{ nmwcCode: 'X' }]);
    expect(await temixCodeRefusal(d, { code: 'P2002', meta: { target: ['nmwcCode'] } }, 'CAA0367')).toBeNull();
    expect(await temixCodeRefusal(d, new Error('boom'), 'CAA0367')).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('the holder gone since: the code was taken at the same moment; unreadable: the rule, with the code; no code: the rule', async () => {
    expect(await temixCodeRefusal(db(async () => []).db, RAW_WRITE, 'CAA0367')).toBe(temixCodeIndexMessage('CAA0367', null));
    expect(temixCodeIndexMessage('CAA0367', null)).toContain('at the same moment, so nothing was saved');
    const failing = db(async () => {
      throw new Error('connection closed');
    });
    const unread = await temixCodeRefusal(failing.db, ENGINE, 'CAA0367');
    expect(unread).toBe(temixCodeIndexMessage('CAA0367', undefined));
    expect(unread).toContain('Temix code CAA0367 already belongs to another live customer');
    const none = db(async () => [{ nmwcCode: 'X' }]);
    expect(await temixCodeRefusal(none.db, MODEL_WRITE, null)).toBe(TEMIX_CODE_UNIQUE_MESSAGE);
    expect(await temixCodeRefusal(none.db, MODEL_WRITE, '   ')).toBe(TEMIX_CODE_UNIQUE_MESSAGE);
    expect(none.queryRaw).not.toHaveBeenCalled();
  });

  it('finalize’s refusal is shown in the code box', () => {
    const e = temixCodeTakenError('Temix code CAA0367 already belongs to customer NMWC-2026-000123.');
    expect(e).toMatchObject({ code: 'TEMIX_CODE_TAKEN', httpStatus: 409, fields: { temixCode: e.message } });
  });
});

describe('runAction: a path that did not translate the refusal is told the rule', () => {
  it('TEMIX_CODE_TAKEN with the rule’s words for the index, in every shape; any other unique violation as before', async () => {
    for (const e of [MODEL_WRITE, RAW_WRITE, ENGINE]) {
      await expect(runAction(async () => Promise.reject(e))).resolves.toEqual({
        ok: false,
        code: 'TEMIX_CODE_TAKEN',
        message: TEMIX_CODE_UNIQUE_MESSAGE,
      });
    }
    const other = await runAction(async () => Promise.reject(err('x', { code: 'P2002', meta: { target: ['nmwcCode'] } })));
    expect(other).toMatchObject({ ok: false, code: 'UNIQUE_CONSTRAINT' });
    // The words name the rule, never a value.
    expect(TEMIX_CODE_UNIQUE_MESSAGE).not.toMatch(/CAA0367/);
  });
});

describe('the paths that write a Temix code translate the refusal (structural)', () => {
  const read = (f: string) => stripComments(readFileSync(f, 'utf8'), f.split('/').pop());

  it('the approval’s finalize: after the transaction, naming the holder, in the code box', () => {
    const edits = read('services/edits.ts');
    expect(edits).toMatch(/\.catch\(async \(err: unknown\) => \{\s*const refusal = await temixCodeRefusal\(prisma, err, temixCode\);\s*throw refusal \? temixCodeTakenError\(refusal\) : err;/);
    const finalize = read('lib/create-finalize.ts');
    expect(finalize).toContain('if (holder) throw temixCodeTakenError(temixCodeHolderMessage(temixCode, holder));');
  });

  it('the customer import: every lane’s refusal becomes the row’s reason, never a deferral', () => {
    const imports = read('services/imports.ts');
    expect(imports).toContain('temixWrite = lead.temixCode ? { code: lead.temixCode, customerId: existing?.id ?? null } : null;');
    expect(imports).toContain(': await temixCodeRefusal(prisma, err, temixWrite?.code, temixWrite?.customerId ?? null);');
    // The refusal is read before the transient check, which skips a crosswalk reason.
    expect(imports.indexOf('await temixCodeRefusal(prisma, err')).toBeLessThan(imports.indexOf('if (!crosswalk && isTransientDbError(err, code))'));
    // Declared outside the group's try, so its catch can read it.
    expect(imports.indexOf('let temixWrite = null')).toBeLessThan(imports.indexOf('let refreshedRow = false;'));
  });
});
