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
 * digits: Temix's customer number is the base code, `CAA0367`
 * (scripts/golive/build-masters.ts writes it upper-cased as temix_code; a
 * RoutePro alternate code such as `AQA0549-C1` is a BRANCH of the base code
 * AQA0549, not a Temix code), and a migrated customer's code IS its customer
 * code (nmwcCode == temixCode, prisma/schema.prisma). So a typed code is
 * folded the way lib/cr.ts folds a CR number: Arabic-Indic and Persian digits
 * become ASCII, the invisible characters copied Arabic text carries are removed,
 * the ends are trimmed, letters are upper-cased. Nothing inside is removed: a
 * space inside is refused, not squeezed out, because "CAA 0367" may be two codes.
 * The customer import folds a sheet's temix_code the same way
 * (lib/import-row-check.ts), so both sides compare the same spelling.
 *
 * Permissive but safe: letters and digits, with `-`, `_`, `.` or `/` only
 * between them, 3 to 30 characters. It starts with a letter or digit, so a
 * spreadsheet never reads it as a formula (`=`, `+`, `-`, `@`). A code of this
 * CRM (NMWC-YYYY-…, a customer's or one of its branches') is refused outright:
 * it is never Temix's, and one not allocated yet would pass every other check.
 *
 * No runtime imports but lib/digits.ts and the pure lib/db-errors.ts: the
 * approval page imports the same rules to check the box before it asks to
 * confirm. The server is the authority (services/edits.ts).
 *
 * Owner decision 2026-10-25: Temix codes are unique, and the database now says
 * so too. A partial unique index (migration 20261025120000_temix_code_unique,
 * lib/db-errors.ts TEMIX_CODE_UNIQUE_INDEX) refuses a second LIVE customer with
 * a code, compared upper case with the ends trimmed. The checks below still run
 * first and still name the holder, archived customers and branch codes included,
 * which the index does not cover; a save the index refuses all the same is
 * answered by temixCodeRefusal, naming the live customer that holds the code.
 */
import type { Prisma } from '@prisma/client';
import { INVISIBLE_FORMAT, asciiDigits } from './digits';
import { temixCodeIndexViolated } from './db-errors';

export const TEMIX_CODE_MIN = 3;
export const TEMIX_CODE_MAX = 30;

const TEMIX_CODE_PATTERN = /^[A-Z0-9](?:[A-Z0-9._/-]*[A-Z0-9])?$/;
/** A code this CRM mints: a customer's (lib/codes.ts formatCustomerCode) or one of its branches'. */
const CRM_CODE = /^NMWC-\d{4}-\d/;

export const TEMIX_CODE_REQUIRED_MESSAGE =
  'Enter the Temix code: create the customer in Temix first, then type the code Temix gave it.';
export const TEMIX_CODE_SPACES_MESSAGE = 'A Temix code has no spaces.';
export const TEMIX_CODE_LENGTH_MESSAGE = `A Temix code is ${TEMIX_CODE_MIN} to ${TEMIX_CODE_MAX} characters long.`;
export const TEMIX_CODE_SHAPE_MESSAGE =
  'A Temix code is letters and digits, with - _ . or / only between them (for example CAA0367).';
export const TEMIX_CODE_CRM_MESSAGE =
  'That is a code of this CRM (NMWC-…), not a Temix code: type the code Temix gave the customer.';

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
  if (CRM_CODE.test(code)) return TEMIX_CODE_CRM_MESSAGE;
  return null;
}

/** The refusal of a code a live customer already has, naming that customer. */
export function temixCodeTakenMessage(code: string, nmwcCode: string): string {
  return `Temix code ${code} already belongs to customer ${nmwcCode}. Check the code in Temix: every customer has its own.`;
}

/**
 * Who already has a code (temixCodeHolder): a customer, live or archived, or a
 * live branch (`branchCode` set, `nmwcCode` its customer's).
 */
export type TemixCodeHolder = { nmwcCode: string; archived: boolean; branchCode: string | null };

/** The refusal of a code `holder` has, naming it, for the box on the approval page. */
export function temixCodeHolderMessage(code: string, holder: TemixCodeHolder): string {
  if (holder.branchCode) {
    return `${code} is the code of branch ${holder.branchCode} of customer ${holder.nmwcCode}, not a Temix customer code. Check the code in Temix.`;
  }
  if (holder.archived) {
    return `Temix code ${code} belongs to archived customer ${holder.nmwcCode}, and its Temix deactivation is sent under that code. Check the code in Temix, and ask the Data Steward before using it again.`;
  }
  return temixCodeTakenMessage(code, holder.nmwcCode);
}

/**
 * Serialize everything that gives a customer `code` inside the surrounding
 * transaction (a transaction-scoped advisory lock, released at commit or
 * rollback, as lib/create-guards.ts does for CR numbers). Two Accountants typing
 * the same code into two requests, or a finalize and an inbound refresh or an
 * import creating a customer with it, would otherwise both pass
 * temixCodeHolder. The database's unique index (2026-10-25) would then refuse
 * the second write, but it knows live customers only; the check under this lock
 * covers archived customers and branch codes too, and says which one it is.
 */
export async function lockTemixCode(tx: Prisma.TransactionClient, code: string): Promise<void> {
  // $executeRaw: pg_advisory_xact_lock returns void, which $queryRaw cannot read (P2010).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'nmwc:temix:' + normalizeTemixCode(code)}, 42))`;
}

/**
 * Who, other than the customer `exceptId`, already has `code`; null when no one
 * does. Asked under lockTemixCode. In this order:
 *  - a LIVE customer whose Temix code OR customer code it is. The customer code
 *    counts too: migrated customers carry nmwcCode == temixCode, the ~3,300
 *    pilot-seeded customers carry no Temix code at all while their customer code
 *    is the one Temix holds (lib/temix.ts deactivationCode).
 *  - an ARCHIVED customer that the customer import's crosswalk guard would name
 *    (services/imports.ts, codeOwner): one whose Temix code it is, and one with
 *    no Temix code whose deactivation goes out, or went out, keyed on it as its
 *    customer code (lib/temix.ts archivedUncodedDeactivationWhere). Given to a new
 *    customer, every inbound refresh of that customer would then be rejected for
 *    it, and Generate would hold the archived one's deactivation back on every
 *    batch (F11). Reusing an archived customer's code is not something the app
 *    can do safely: the Data Steward decides.
 *  - a LIVE branch whose branch code it is (a RoutePro alternate code such as
 *    AQA0549-C1, or CAA0367-01): a branch account, not a Temix customer code.
 * Compared without regard to case: an older row may hold the code as its sheet
 * spelled it. Raw SQL, not Prisma's `mode: 'insensitive'`, which compiles to
 * ILIKE and reads a `_` in a code as a wildcard.
 */
export async function temixCodeHolder(
  tx: Prisma.TransactionClient,
  code: string,
  exceptId: string | null = null
): Promise<TemixCodeHolder | null> {
  const norm = normalizeTemixCode(code);
  const rows = await tx.$queryRaw<TemixCodeHolder[]>`
    SELECT "nmwcCode", "archived", "branchCode" FROM (
      SELECT c."nmwcCode", c."deletedAt" IS NOT NULL AS "archived", NULL::text AS "branchCode"
        FROM "Customer" c
       WHERE (${exceptId}::text IS NULL OR c."id" <> ${exceptId})
         AND (UPPER(c."temixCode") = ${norm}
              OR (c."deletedAt" IS NULL AND UPPER(c."nmwcCode") = ${norm})
              OR (c."deletedAt" IS NOT NULL AND c."temixCode" IS NULL AND UPPER(c."nmwcCode") = ${norm}
                  AND (c."temixSyncState" IN ('DEACTIVATE_PENDING', 'UPLOADED') OR c."lastTemixUploadAt" IS NOT NULL)))
      UNION ALL
      SELECT c."nmwcCode", false, b."branchCode"
        FROM "Branch" b JOIN "Customer" c ON c."id" = b."customerId"
       WHERE b."deletedAt" IS NULL AND c."deletedAt" IS NULL
         AND (${exceptId}::text IS NULL OR c."id" <> ${exceptId})
         AND UPPER(b."branchCode") = ${norm}
    ) AS "holder"
    ORDER BY ("branchCode" IS NOT NULL), "archived", "nmwcCode"
    LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * The words for a save the database's unique index refused (lib/db-errors.ts
 * temixCodeIndexViolated) when the code is not known, as in lib/errors.ts
 * runAction for a path that does not translate the refusal itself: the rule, in
 * its own words, never a value.
 */
export const TEMIX_CODE_UNIQUE_MESSAGE =
  'That Temix code already belongs to another live customer, and the database allows each code once. Check the code in Temix.';

/**
 * The refusal naming the live customer that holds `code` (temixCodeHolder's
 * wording for a live holder, temixCodeTakenMessage). `holder` null: none holds
 * it any more, so it was archived or merged after the refusal and the save can
 * be tried again. `holder` undefined: who holds it could not be read.
 */
export function temixCodeIndexMessage(code: string, holder: string | null | undefined): string {
  if (holder) return temixCodeTakenMessage(code, holder);
  if (holder === null) {
    return `Temix code ${code} was given to another customer at the same moment, so nothing was saved. Check the code in Temix, then try again.`;
  }
  return `Temix code ${code} already belongs to another live customer, and the database allows each code once. Check the code in Temix.`;
}

/**
 * The live customer, other than `exceptId`, that holds `code` the way the index
 * compares it (upper case, the ends trimmed): its customer code, or null.
 */
export async function temixCodeIndexHolder(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  code: string,
  exceptId: string | null = null
): Promise<string | null> {
  const rows = await db.$queryRaw<Array<{ nmwcCode: string }>>`
    SELECT c."nmwcCode" FROM "Customer" c
     WHERE c."deletedAt" IS NULL AND c."temixCode" IS NOT NULL
       AND upper(btrim(c."temixCode")) = upper(btrim(${code}))
       AND (${exceptId}::text IS NULL OR c."id" <> ${exceptId})
     ORDER BY c."nmwcCode"
     LIMIT 1`;
  return rows[0]?.nmwcCode ?? null;
}

/**
 * What to tell the person when `err` is the database's unique index refusing
 * `code`, or null for any other error (asked first, so nothing is read then).
 *
 * Asked AFTER the refused transaction has rolled back, with a client outside it:
 * Postgres reads nothing more in an aborted transaction, and the holder has
 * committed (the index waits for an uncommitted holder, and lets the write
 * through if it rolls back). Never throws: when the holder cannot be read, the
 * refusal is still given, without the name. Every path that writes a Temix code
 * answers through this (the approval's finalize, services/edits.ts; the customer
 * import's lanes, services/imports.ts); any other is answered by runAction with
 * TEMIX_CODE_UNIQUE_MESSAGE.
 */
export async function temixCodeRefusal(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  err: unknown,
  code: string | null | undefined,
  exceptId: string | null = null
): Promise<string | null> {
  if (!temixCodeIndexViolated(err)) return null;
  const shown = normalizeTemixCode(code ?? '');
  if (!shown) return TEMIX_CODE_UNIQUE_MESSAGE;
  let holder: string | null | undefined;
  try {
    holder = await temixCodeIndexHolder(db, shown, exceptId);
  } catch {
    holder = undefined;
  }
  return temixCodeIndexMessage(shown, holder);
}
