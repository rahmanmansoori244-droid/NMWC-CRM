// @vitest-environment node
/**
 * Owner decision 2026-10-08: the Accountant creates a new customer in Temix and
 * types its Temix code at the last approval (lib/temix-code.ts). The code is
 * folded the way the master stores Temix codes — upper case, ASCII digits, no
 * invisible characters, trimmed — and must look like one: letters and digits,
 * `-` `_` `.` `/` only between them, 3 to 30 characters, no spaces, and not a
 * code of this CRM (NMWC-…).
 *
 * The database half: the lock key and the holder read — a live customer, an
 * archived one the customer import would also name, a live branch — with the
 * transaction mocked. The same read against Postgres is in
 * tests/integration/credit-chain-e2e.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  TEMIX_CODE_CRM_MESSAGE,
  TEMIX_CODE_LENGTH_MESSAGE,
  TEMIX_CODE_REQUIRED_MESSAGE,
  TEMIX_CODE_SHAPE_MESSAGE,
  TEMIX_CODE_SPACES_MESSAGE,
  lockTemixCode,
  normalizeTemixCode,
  temixCodeHolder,
  temixCodeHolderMessage,
  temixCodeProblem,
  temixCodeTakenMessage,
} from '@/lib/temix-code';
import { INVISIBLE_FORMAT } from '@/lib/digits';

describe('normalizeTemixCode: the code as the master stores Temix codes', () => {
  it.each([
    ['CAA0367', 'CAA0367'],
    ['  caa0367 ', 'CAA0367'],
    ['aqa0549-c1', 'AQA0549-C1'],
    // Typed on an Arabic keyboard: Arabic-Indic and Persian digits.
    ['CAA٠٣٦٧', 'CAA0367'],
    ['CAA۰۳۶۷', 'CAA0367'],
    // Pasted from Arabic text: a right-to-left mark and a zero-width space.
    ['‏CAA0367​', 'CAA0367'],
    // A space inside is kept, to be refused: it may be two codes.
    ['CAA 0367', 'CAA 0367'],
  ])('%j → %j', (typed, stored) => {
    expect(normalizeTemixCode(typed)).toBe(stored);
  });

  it('anything but a string is empty', () => {
    for (const v of [null, undefined, 42, {}, new File([], 'x')]) expect(normalizeTemixCode(v)).toBe('');
  });

  it('the rules are written with escapes: no invisible character in the source (review hazard)', () => {
    const source = readFileSync('lib/temix-code.ts', 'utf8');
    expect(source.match(INVISIBLE_FORMAT)).toBeNull();
  });
});

describe('temixCodeProblem: permissive but safe', () => {
  it.each(['CAA0367', 'AQA0549-C1', '71120701', '1083', 'AB_12', 'CAA.0367', 'CAA/0367', 'A1B', 'NMWC1', 'X'.repeat(30)])(
    '%s may be used',
    (code) => {
      expect(temixCodeProblem(code)).toBeNull();
    }
  );

  it.each([
    ['', TEMIX_CODE_REQUIRED_MESSAGE],
    ['CAA 0367', TEMIX_CODE_SPACES_MESSAGE],
    ['CAA\t0367', TEMIX_CODE_SPACES_MESSAGE],
    ['AB', TEMIX_CODE_LENGTH_MESSAGE],
    ['X'.repeat(31), TEMIX_CODE_LENGTH_MESSAGE],
    // A spreadsheet reads these as formulas.
    ['=1+2', TEMIX_CODE_SHAPE_MESSAGE],
    ['+CAA0367', TEMIX_CODE_SHAPE_MESSAGE],
    ['-CAA0367', TEMIX_CODE_SHAPE_MESSAGE],
    ['@CAA0367', TEMIX_CODE_SHAPE_MESSAGE],
    ['CAA0367-', TEMIX_CODE_SHAPE_MESSAGE],
    ['CAA,0367', TEMIX_CODE_SHAPE_MESSAGE],
    ["CAA'0367", TEMIX_CODE_SHAPE_MESSAGE],
    ['CAAé367', TEMIX_CODE_SHAPE_MESSAGE],
    // A code of this CRM, allocated or not yet: never Temix's.
    ['NMWC-2026-000123', TEMIX_CODE_CRM_MESSAGE],
    ['NMWC-2027-999999', TEMIX_CODE_CRM_MESSAGE],
    ['NMWC-2026-000123-01', TEMIX_CODE_CRM_MESSAGE],
  ])('%j is refused: %s', (code, message) => {
    expect(temixCodeProblem(code)).toBe(message);
  });

  it('the shape message gives a Temix customer number as its example, not a branch account', () => {
    expect(TEMIX_CODE_SHAPE_MESSAGE).toContain('CAA0367');
    expect(TEMIX_CODE_SHAPE_MESSAGE).not.toContain('AQA0549-C1');
  });

  it('the refusal of a taken code names the customer that has it', () => {
    expect(temixCodeTakenMessage('CAA0367', 'NMWC-2026-000012')).toBe(
      'Temix code CAA0367 already belongs to customer NMWC-2026-000012. Check the code in Temix: every customer has its own.'
    );
  });

  it('temixCodeHolderMessage: a live customer, an archived one, a live branch', () => {
    expect(temixCodeHolderMessage('CAA0367', { nmwcCode: 'NMWC-2026-000012', archived: false, branchCode: null })).toBe(
      temixCodeTakenMessage('CAA0367', 'NMWC-2026-000012')
    );
    expect(temixCodeHolderMessage('CAA0367', { nmwcCode: 'CAA0367', archived: true, branchCode: null })).toBe(
      'Temix code CAA0367 belongs to archived customer CAA0367, and its Temix deactivation is sent under that code. Check the code in Temix, and ask the Data Steward before using it again.'
    );
    expect(temixCodeHolderMessage('AQA0549-C1', { nmwcCode: 'AQA0549', archived: false, branchCode: 'AQA0549-C1' })).toBe(
      'AQA0549-C1 is the code of branch AQA0549-C1 of customer AQA0549, not a Temix customer code. Check the code in Temix.'
    );
  });
});

/** A transaction that records its raw statements as Prisma builds them. */
function recordingTx(rows: unknown[] = []) {
  const sql: Prisma.Sql[] = [];
  const keep = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sql.push(Prisma.sql(strings, ...values));
  };
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      keep(strings, ...values);
      return 1;
    }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      keep(strings, ...values);
      return rows;
    }),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, sql };
}

describe('the database half', () => {
  it('lockTemixCode: one transaction-scoped advisory lock, keyed on the code as it is stored', async () => {
    const { tx, sql } = recordingTx();
    await lockTemixCode(tx, ' caa٠367 ');
    expect(sql).toHaveLength(1);
    expect(sql[0]!.text).toMatch(/^SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 42\)\)$/);
    expect(sql[0]!.values).toEqual(['nmwc:temix:CAA0367']);
  });

  it('temixCodeHolder: one read, in any case, but not the customer excepted', async () => {
    const found = { nmwcCode: 'NMWC-2026-000012', archived: false, branchCode: null };
    const { tx, sql } = recordingTx([found]);
    expect(await temixCodeHolder(tx, 'caa0367', 'cust-1')).toEqual(found);
    expect(sql).toHaveLength(1);
    const q = sql[0]!.text.replace(/\s+/g, ' ').trim();
    expect(sql[0]!.values).toEqual(['cust-1', 'cust-1', 'CAA0367', 'CAA0367', 'CAA0367', 'cust-1', 'cust-1', 'CAA0367']);
    // Not ILIKE: an `_` in a code is a character, not a wildcard.
    expect(q).not.toMatch(/LIKE/i);
    // A customer, live or archived, whose Temix code it is.
    expect(q).toContain('UPPER(c."temixCode") = $3');
    // A LIVE customer whose customer code it is (migrated and seeded customers).
    expect(q).toContain('(c."deletedAt" IS NULL AND UPPER(c."nmwcCode") = $4)');
    // An archived customer with no Temix code whose deactivation goes out under
    // it: the import's guard (lib/temix.ts archivedUncodedDeactivationWhere).
    expect(q).toContain(
      `(c."deletedAt" IS NOT NULL AND c."temixCode" IS NULL AND UPPER(c."nmwcCode") = $5 AND (c."temixSyncState" IN ('DEACTIVATE_PENDING', 'UPLOADED') OR c."lastTemixUploadAt" IS NOT NULL))`
    );
    // A live branch of a live customer whose branch code it is.
    expect(q).toContain(
      'FROM "Branch" b JOIN "Customer" c ON c."id" = b."customerId" WHERE b."deletedAt" IS NULL AND c."deletedAt" IS NULL AND ($6::text IS NULL OR c."id" <> $7) AND UPPER(b."branchCode") = $8'
    );
    // A live customer first, then an archived one, then a branch.
    expect(q).toMatch(/ORDER BY \("branchCode" IS NOT NULL\), "archived", "nmwcCode" LIMIT 1$/);
  });

  it('temixCodeHolder: none, and no customer excepted', async () => {
    const { tx, sql } = recordingTx([]);
    expect(await temixCodeHolder(tx, 'AB_12')).toBeNull();
    expect(sql[0]!.values).toEqual([null, null, 'AB_12', 'AB_12', 'AB_12', null, null, 'AB_12']);
  });
});
