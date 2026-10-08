// @vitest-environment node
/**
 * Owner decision 2026-10-08: the Accountant creates a new customer in Temix and
 * types its Temix code at the last approval (lib/temix-code.ts). The code is
 * folded the way the master stores Temix codes — upper case, ASCII digits, no
 * invisible characters, trimmed — and must look like one: letters and digits,
 * `-` `_` `.` `/` only between them, 3 to 30 characters, no spaces.
 *
 * The database half: the lock key and the live-holder read, with the
 * transaction mocked. The same read against Postgres is in
 * tests/integration/credit-chain-e2e.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  TEMIX_CODE_LENGTH_MESSAGE,
  TEMIX_CODE_REQUIRED_MESSAGE,
  TEMIX_CODE_SHAPE_MESSAGE,
  TEMIX_CODE_SPACES_MESSAGE,
  liveTemixCodeHolder,
  lockTemixCode,
  normalizeTemixCode,
  temixCodeProblem,
  temixCodeTakenMessage,
} from '@/lib/temix-code';

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
});

describe('temixCodeProblem: permissive but safe', () => {
  it.each(['CAA0367', 'AQA0549-C1', '71120701', '1083', 'AB_12', 'CAA.0367', 'CAA/0367', 'A1B', 'X'.repeat(30)])(
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
  ])('%j is refused: %s', (code, message) => {
    expect(temixCodeProblem(code)).toBe(message);
  });

  it('the refusal of a taken code names the customer that has it', () => {
    expect(temixCodeTakenMessage('CAA0367', 'NMWC-2026-000012')).toBe(
      'Temix code CAA0367 already belongs to customer NMWC-2026-000012. Check the code in Temix: every customer has its own.'
    );
  });
});

/** A transaction that records its raw statements as Prisma builds them. */
function recordingTx(rows: Array<{ nmwcCode: string }> = []) {
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

  it('liveTemixCodeHolder: a live customer whose Temix code or customer code it is, in any case, but not the one excepted', async () => {
    const { tx, sql } = recordingTx([{ nmwcCode: 'NMWC-2026-000012' }]);
    expect(await liveTemixCodeHolder(tx, 'caa0367', 'cust-1')).toBe('NMWC-2026-000012');
    const q = sql[0]!.text.replace(/\s+/g, ' ').trim();
    expect(q).toBe(
      'SELECT "nmwcCode" FROM "Customer" WHERE "deletedAt" IS NULL AND ($1::text IS NULL OR "id" <> $2) AND (UPPER("temixCode") = $3 OR UPPER("nmwcCode") = $4) ORDER BY "nmwcCode" LIMIT 1'
    );
    expect(sql[0]!.values).toEqual(['cust-1', 'cust-1', 'CAA0367', 'CAA0367']);
    // Not ILIKE: an `_` in a code is a character, not a wildcard.
    expect(q).not.toMatch(/LIKE/i);
  });

  it('liveTemixCodeHolder: none, and no customer excepted', async () => {
    const { tx, sql } = recordingTx([]);
    expect(await liveTemixCodeHolder(tx, 'AB_12')).toBeNull();
    expect(sql[0]!.values).toEqual([null, null, 'AB_12', 'AB_12']);
  });
});
