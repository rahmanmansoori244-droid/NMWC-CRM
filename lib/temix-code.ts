/**
 * The Temix code the Accountant types at the last approval of a new customer.
 *
 * Owner decision 2026-10-08: when a new-customer request reaches the Accountant
 * (CASH: Supervisor → Accountant; CREDIT: Supervisor → Finance Manager → GM →
 * Accountant), he creates the customer in Temix himself, types the code Temix
 * gave it into the CRM and approves; the salesman is then told both codes. The
 * customer is created with that code (lib/create-finalize.ts), so the next Temix
 * workbook carries it as an UPSERT of the record he made (lib/temix.ts) and the
 * inbound refresh recognises it (services/imports.ts).
 *
 * How the code is stored. Temix codes in the master are upper case letters and
 * digits — the base code `CAA0367`, a branch account `AQA0549-C1`
 * (scripts/golive/build-masters.ts upper-cases both, and keeps only A-Z, 0-9,
 * `_` and `-` in the branch part) — and a migrated customer's code IS its
 * customer code (nmwcCode == temixCode, prisma/schema.prisma). So a typed code is
 * folded the way lib/cr.ts folds a CR number: Arabic-Indic and Persian digits
 * become ASCII, the invisible characters copied Arabic text carries are removed,
 * the ends are trimmed, letters are upper-cased. Nothing inside is removed: a
 * space inside is refused, not squeezed out, because "CAA 0367" may be two codes.
 *
 * Permissive but safe: letters and digits, with `-`, `_`, `.` or `/` only
 * between them, 3 to 30 characters. It starts with a letter or digit, so a
 * spreadsheet never reads it as a formula (`=`, `+`, `-`, `@`).
 *
 * No runtime imports: the approval page imports the same rules to check the box
 * before it asks to confirm. The server is the authority (services/edits.ts).
 */
import type { Prisma } from '@prisma/client';
import { asciiDigits } from './digits';

export const TEMIX_CODE_MIN = 3;
export const TEMIX_CODE_MAX = 30;

// Escapes, as in lib/cr.ts: invisible characters are easier to review as code points.
const INVISIBLE_FORMAT =
  /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;
const TEMIX_CODE_PATTERN = /^[A-Z0-9](?:[A-Z0-9._/-]*[A-Z0-9])?$/;

export const TEMIX_CODE_REQUIRED_MESSAGE =
  'Enter the Temix code: create the customer in Temix first, then type the code Temix gave it.';
export const TEMIX_CODE_SPACES_MESSAGE = 'A Temix code has no spaces.';
export const TEMIX_CODE_LENGTH_MESSAGE = `A Temix code is ${TEMIX_CODE_MIN} to ${TEMIX_CODE_MAX} characters long.`;
export const TEMIX_CODE_SHAPE_MESSAGE =
  'A Temix code is letters and digits, with - _ . or / only between them (for example CAA0367 or AQA0549-C1).';

/** The code as it is compared and stored (above). Anything but a string is ''. */
export function normalizeTemixCode(input: unknown): string {
  if (typeof input !== 'string') return '';
  return asciiDigits(input).replace(INVISIBLE_FORMAT, '').trim().toUpperCase();
}

/** What is wrong with a NORMALIZED code, or null when it may be used. */
export function temixCodeProblem(code: string): string | null {
  if (!code) return TEMIX_CODE_REQUIRED_MESSAGE;
  if (/\s/.test(code)) return TEMIX_CODE_SPACES_MESSAGE;
  if (code.length < TEMIX_CODE_MIN || code.length > TEMIX_CODE_MAX) {
    return TEMIX_CODE_LENGTH_MESSAGE;
  }
  if (!TEMIX_CODE_PATTERN.test(code)) return TEMIX_CODE_SHAPE_MESSAGE;
  return null;
}

/** The refusal of a code a live customer already has, naming that customer. */
export function temixCodeTakenMessage(code: string, nmwcCode: string): string {
  return `Temix code ${code} already belongs to customer ${nmwcCode}. Check the code in Temix: every customer has its own.`;
}

/**
 * Serialize everything that gives a customer `code` inside the surrounding
 * transaction (a transaction-scoped advisory lock, released at commit or
 * rollback, as lib/create-guards.ts does for CR numbers). Two Accountants typing
 * the same code into two requests, or a finalize and an inbound refresh, would
 * otherwise both pass liveTemixCodeHolder and both write it: Customer.temixCode
 * has no unique index (H-01).
 */
export async function lockTemixCode(tx: Prisma.TransactionClient, code: string): Promise<void> {
  // $executeRaw: pg_advisory_xact_lock returns void, which $queryRaw cannot read (P2010).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'nmwc:temix:' + normalizeTemixCode(code)}, 42))`;
}

/**
 * The customer code of a LIVE customer (not archived), other than `exceptId`,
 * whose Temix code OR customer code is `code`; null when there is none. The
 * customer code counts too: migrated customers carry nmwcCode == temixCode, the
 * ~3,300 pilot-seeded customers carry no Temix code at all while their customer
 * code is the one Temix holds (lib/temix.ts deactivationCode), and another
 * customer's NMWC code typed by mistake is no Temix code. Compared without
 * regard to case: an older row may hold the code as its sheet spelled it. Raw
 * SQL, not Prisma's `mode: 'insensitive'`, which compiles to ILIKE and reads a
 * `_` in a code as a wildcard.
 */
export async function liveTemixCodeHolder(
  tx: Prisma.TransactionClient,
  code: string,
  exceptId: string | null = null
): Promise<string | null> {
  const norm = normalizeTemixCode(code);
  const rows = await tx.$queryRaw<Array<{ nmwcCode: string }>>`
    SELECT "nmwcCode" FROM "Customer"
    WHERE "deletedAt" IS NULL
      AND (${exceptId}::text IS NULL OR "id" <> ${exceptId})
      AND (UPPER("temixCode") = ${norm} OR UPPER("nmwcCode") = ${norm})
    ORDER BY "nmwcCode"
    LIMIT 1`;
  return rows[0]?.nmwcCode ?? null;
}
