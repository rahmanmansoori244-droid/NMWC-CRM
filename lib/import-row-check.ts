/**
 * The per-row check of a customer-master upload: what a sheet row parses to,
 * and why it is held back (QUARANTINED) if it is.
 *
 * It lives here, and not inside services/imports.ts, because two callers must
 * apply exactly the same rules (benchmark item 20): the upload, and the Data
 * Steward's in-app fix of a held-back row, which re-runs the check over the row
 * as uploaded plus the cells the Steward corrected. A second copy of these
 * rules would drift, and a row the upload holds back would pass the fix (or
 * the other way round). Pure: every database lookup is done by the caller and
 * passed in as `RowCheckContext`.
 */
import { normalizePhone, isValidPhoneFormat } from '@/lib/phone';
import { normalizeCR } from '@/lib/cr';
import { normalizeTemixCode } from '@/lib/temix-code';
import { stripHtml as stripTags } from '@/lib/validation/fields';
import { readCell, readLooseCell } from '@/lib/import-headings';
import {
  capitalCode,
  shopLookalike,
  shopLookalikeMessage,
  type Capitalised,
  type SiblingShop,
} from '@/lib/import-shop-code';

export type SheetRow = Record<string, unknown>;
export type RowIssue = { field: string; message: string };
export type FileDup = { row: number; code: string };

export type ParsedCustomerRow = {
  custCode: string;
  custName: string;
  channelKey: string | null;
  dayOfVisit: string | null;
  customerStatus: string | null;
  branchCode: string | null;
  branchName: string | null;
  regionCode: string | null;
  routeCode: string | null;
  address: string | null;
  phone: string | null;
  contactPerson: string | null;
  crNumber: string | null;
  paymentTerms: string;
  paymentTermsPresent: boolean;
  temixCode: string | null;
  creditLimit: number | null;
  paymentTermDays: number | null;
  /**
   * Owner's answer 2026-11-11 (A5): the codes the import changed to capital
   * letters, as the sheet had them. Present only when one was changed.
   */
  capitalised?: Capitalised[];
  /** The Steward released this row's lookalike shop code as a different shop (A5). */
  shopCodeReleased?: true;
};

export type RowCheckContext = {
  /** Accepted `channel` codes — the Channel table's keys, uppercased. */
  channelKeys: ReadonlySet<string>;
  /** Normalized phone → every row in the file carrying it, with its cust_code. */
  phonesInFile: ReadonlyMap<string, FileDup[]>;
  crsInFile: ReadonlyMap<string, FileDup[]>;
  /** Normalized phone → the nmwcCodes of live master customers carrying it. */
  masterPhones: ReadonlyMap<string, string[]>;
  masterCrs: ReadonlyMap<string, string[]>;
  /**
   * Owner's answer 2026-11-11 (A5): customer code (capitals) -> the codes of
   * that customer's shops in the CRM, archived ones too (lib/import-master-lookup.ts
   * masterShopCodes). Absent: no shop is compared.
   */
  masterShops?: ReadonlyMap<string, readonly string[]>;
  /** Customer code (capitals) -> every row of it in the file, with its branch_code as written. */
  shopsInFile?: ReadonlyMap<string, readonly SiblingShop[]>;
};

export type RowCheckOptions = {
  /**
   * The Steward released this row's shared phone (item 20, audited as
   * FORCE_OVERRIDE): the phone is on another customer in the master, and that
   * is legitimate here — one owner often runs several shops on one number.
   */
  phoneReleased?: boolean;
  /**
   * Owner's answer 2026-11-11 (A5): the Steward released this row's shop code,
   * which only looks like one of the customer's shops or rows, as a DIFFERENT
   * shop (audited as FORCE_OVERRIDE).
   */
  shopCodeReleased?: boolean;
};

/**
 * F-05 / QA-029 — strip HTML tags before persisting any user-supplied text
 * field. Mirrors the helper the edit and create payloads use (lib/validation/fields.ts).
 * Without this, an import row carrying `legalName="<script>…</script>"` lands
 * in the master verbatim, then propagates back through Excel exports and JSON
 * audit-log views.
 *
 * The strip itself is lib/validation/fields.ts's: this copy of its regex ran in
 * quadratic time on a run of '<' with no '>' after it, and a spreadsheet cell
 * holds 32,767 characters (adversarial pass after phase 2, finding 4).
 */
export function stripHtml(s: unknown): string {
  return stripTags(String(s ?? ''));
}

/**
 * F-05 — refuse cells whose value starts with a spreadsheet formula trigger
 * (`=`, `+`, `-`, `@`, tab, CR). Matches the export-side escape but applied
 * on the way IN so the data in the master is never hostile to begin with.
 */
export function isFormulaPayload(s: unknown): boolean {
  const v = String(s ?? '').trim();
  return v.length > 0 && /^[=+\-@\t\r]/.test(v);
}

function uc(v: unknown): string {
  return String(v ?? '')
    .trim()
    .toUpperCase();
}

// Accepted codes for the go-live enrichment columns.
export const DAY_CODES = new Set(['SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI']);
export const STATUS_CODES = new Set(['ACTIVE', 'CLOSED', 'SUSPENDED']);

/** "customer X", or "customers X, Y, Z and 4 more" — never an unbounded list in a row's issues. */
export function heldBackBy(codes: string[]): string {
  const unique = [...new Set(codes)];
  if (unique.length === 1) return `customer ${unique[0]}`;
  const shown = unique.slice(0, 3).join(', ');
  return unique.length > 3
    ? `customers ${shown} and ${unique.length - 3} more`
    : `customers ${shown}`;
}

/**
 * The cust_code cell as every lane reads it: trimmed, and in capital letters
 * (owner's answer 2026-11-11, A5: cct0005 is the customer CCT0005). Only a-z
 * are changed (lib/import-shop-code.ts capitalCode).
 */
export function rowCustCode(row: SheetRow): string {
  return capitalCode(rowCustCodeAsWritten(row));
}

/** The cust_code cell as the sheet wrote it (trimmed). */
function rowCustCodeAsWritten(row: SheetRow): string {
  return stripHtml(readCell(row, 'cust_code')).trim();
}

/** The branch_code cell as the check reads it, or null when blank. */
export function rowBranchCode(row: SheetRow): string | null {
  return stripHtml(readCell(row, 'branch_code')) || null;
}

export function rowPhoneNorm(row: SheetRow): string | null {
  return normalizePhone(String(readCell(row, 'phone') ?? '').trim() || null);
}

export function rowCrNorm(row: SheetRow): string | null {
  return normalizeCR(String(readCell(row, 'cr_no') ?? '').trim() || null);
}

/**
 * F-04: collision maps inside the file, so the parse step queues duplicates
 * for review instead of silently P2002-failing on promote.
 *
 * Each occurrence carries its owning cust_code so a legitimate MULTI-BRANCH
 * customer — whose branch rows repeat the SAME phone/CR (exactly how promote
 * groups branch rows by cust_code into one customer) — is not flagged against
 * ITSELF. Only a value shared across DIFFERENT cust_codes is an in-file
 * duplicate, mirroring the master cross-check's `code !== custCode` exclusion.
 * Before this, importing a real master quarantined every multi-branch customer
 * (F-UAT-7: the medium synthetic master lost 324/499 rows this way).
 */
export function fileCollisions(rows: Array<{ row: SheetRow; rowNumber: number }>): {
  phonesInFile: Map<string, FileDup[]>;
  crsInFile: Map<string, FileDup[]>;
} {
  const phonesInFile = new Map<string, FileDup[]>();
  const crsInFile = new Map<string, FileDup[]>();
  for (const { row, rowNumber } of rows) {
    const code = rowCustCode(row);
    const phoneNorm = rowPhoneNorm(row);
    if (phoneNorm) {
      const a = phonesInFile.get(phoneNorm) ?? [];
      a.push({ row: rowNumber, code });
      phonesInFile.set(phoneNorm, a);
    }
    const crNorm = rowCrNorm(row);
    if (crNorm) {
      const a = crsInFile.get(crNorm) ?? [];
      a.push({ row: rowNumber, code });
      crsInFile.set(crNorm, a);
    }
  }
  return { phonesInFile, crsInFile };
}

/**
 * Owner's answer 2026-11-11 (A5): every row of each customer in the file with
 * its branch_code as written, so a row whose shop code only looks like that of
 * another row of the same customer is held back.
 */
export function fileShopCodes(
  rows: Array<{ row: SheetRow; rowNumber: number }>
): Map<string, SiblingShop[]> {
  const out = new Map<string, SiblingShop[]>();
  for (const { row, rowNumber } of rows) {
    const code = rowCustCode(row);
    const branch = rowBranchCode(row);
    if (!code || !branch) continue;
    const a = out.get(code) ?? [];
    a.push({ row: rowNumber, code: branch });
    out.set(code, a);
  }
  return out;
}

/** What one sheet row parses to, and every reason it is held back (none = CLEAN). */
export function checkCustomerRow(
  row: SheetRow,
  ctx: RowCheckContext,
  opts: RowCheckOptions = {}
): { parsed: ParsedCustomerRow; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  // F-05: stripHtml on every text field at parse time so nothing hostile
  // reaches the master. Then re-screen for spreadsheet formula prefixes.
  const custCode = rowCustCode(row);
  const custName = stripHtml(readCell(row, 'cust_name'));
  // Read as rowPhoneNorm reads it (lib/import-headings.ts readCell) — otherwise a
  // phone supplied in the 'PHONE' or 'Primary Phone' column skipped the format
  // check entirely (an invalid number in those columns was silently accepted).
  const phoneRaw = String(readCell(row, 'phone') ?? '').trim();
  const phone = rowPhoneNorm(row);
  const crNorm = rowCrNorm(row);

  if (!custCode) issues.push({ field: 'cust_code', message: 'required' });
  if (!custName) issues.push({ field: 'cust_name', message: 'required' });
  if (phoneRaw && !isValidPhoneFormat(phoneRaw)) {
    issues.push({ field: 'phone', message: 'invalid format' });
  }
  // In-file dup only when the SAME phone/CR appears under a DIFFERENT
  // cust_code — a multi-branch customer sharing one phone/CR across its own
  // branch rows is legitimate and must NOT self-quarantine (F-UAT-7).
  const phoneOtherRows = phone
    ? (ctx.phonesInFile.get(phone) ?? []).filter((e) => e.code !== custCode).map((e) => e.row)
    : [];
  if (phoneOtherRows.length > 0) {
    issues.push({
      field: 'phone',
      message: `duplicate phone in this file (also rows ${phoneOtherRows.join(', ')})`,
    });
  }
  // These two used to end "review in /duplicates". That screen cannot help: it
  // pairs customers already in the master, never a held-back row, and it does
  // not treat a shared phone as a signal at all. Name the customer instead, so
  // the Steward can open it.
  const phoneOwners = phone
    ? (ctx.masterPhones.get(phone) ?? []).filter((code) => code !== custCode)
    : [];
  if (phoneOwners.length > 0 && !opts.phoneReleased) {
    issues.push({
      field: 'phone',
      message: `phone already exists in master on ${heldBackBy(phoneOwners)}`,
    });
  }
  const crOtherRows = crNorm
    ? (ctx.crsInFile.get(crNorm) ?? []).filter((e) => e.code !== custCode).map((e) => e.row)
    : [];
  if (crOtherRows.length > 0) {
    issues.push({
      field: 'cr_no',
      message: `duplicate CR in this file (also rows ${crOtherRows.join(', ')})`,
    });
  }
  const crOwners = crNorm
    ? (ctx.masterCrs.get(crNorm) ?? []).filter((code) => code !== custCode)
    : [];
  if (crOwners.length > 0) {
    issues.push({
      field: 'cr_no',
      message: `CR already exists in master on ${heldBackBy(crOwners)}`,
    });
  }
  // F-12: strict whitelist on payment terms — silently defaulting `Crdit`
  // to CASH ate the field-lock semantics for credit customers.
  // `paymentTermsPresent` records whether the sheet EXPLICITLY stated a
  // value: the Temix-refresh lane must distinguish "column absent — keep
  // the customer's current terms" from "Temix says CASH" (an absent column
  // silently flipping CREDIT customers to CASH was an adversarial-review
  // CONFIRMED finding). Legacy create/full-upsert paths keep the CASH
  // default unchanged.
  const ptRaw = String(readCell(row, 'payment_terms') ?? '')
    .trim()
    .toUpperCase();
  let paymentTerms = 'CASH';
  const paymentTermsPresent = ptRaw === 'CASH' || ptRaw === 'CREDIT';
  if (ptRaw && !paymentTermsPresent) {
    issues.push({ field: 'payment_terms', message: `expected CASH or CREDIT, got "${ptRaw}"` });
  } else if (ptRaw === 'CREDIT') {
    paymentTerms = 'CREDIT';
  }
  // F-05: refuse formula payloads in any text field. Read as the fields
  // themselves are read (lib/import-headings.ts), so a formula under `CUST NAME`
  // or `Address` is held back as one under `cust_name` or `address` always was
  // (code review 2026-11-10, finding 1: this screen read the exact template
  // spelling only). `notes` is not a column the import loads; it is screened
  // because the Steward may keep one in the sheet.
  for (const field of ['cust_name', 'address', 'contact_person', 'notes'] as const) {
    const cell = field === 'notes' ? readLooseCell(row, 'notes') : readCell(row, field);
    if (isFormulaPayload(cell)) {
      issues.push({
        field,
        message: 'cell starts with a spreadsheet formula trigger; remove it',
      });
    }
  }

  // Phase 1 Temix refresh columns (all optional — a plain master sheet
  // without them behaves exactly as before):
  //  - temix_code: the ERP's code for this customer. Presence marks the row
  //    as a REFRESH row at promote time (crosswalk backfill + narrow update).
  //  - credit_limit / payment_term_days: authoritatively FROM Temix
  //    (owner-locked) for existing CREDIT customers.
  // temix_code is folded as the Accountant's typed code is (lib/temix-code.ts:
  // upper case, ASCII digits, no invisible characters), so the promote's
  // comparisons with recorded codes, and the F11 hold-back's, read one spelling.
  const temixWritten = stripHtml(readCell(row, 'temix_code')).trim();
  const temixCode = normalizeTemixCode(temixWritten) || null;
  let creditLimit: number | null = null;
  const creditRaw = String(readCell(row, 'credit_limit') ?? '').trim();
  if (creditRaw) {
    const n = Number(creditRaw);
    if (!Number.isFinite(n) || n < 0 || n > 99_999_999_999) {
      issues.push({
        field: 'credit_limit',
        message: `expected a non-negative number, got "${creditRaw}"`,
      });
    } else {
      creditLimit = Math.round(n * 1000) / 1000;
    }
  }
  let paymentTermDays: number | null = null;
  const termRaw = String(readCell(row, 'payment_term_days') ?? '').trim();
  if (termRaw) {
    const n = Number(termRaw);
    if (!Number.isInteger(n) || n < 0 || n > 365) {
      issues.push({
        field: 'payment_term_days',
        message: `expected whole days 0-365, got "${termRaw}"`,
      });
    } else {
      paymentTermDays = n;
    }
  }

  // Go-live enrichment columns. All optional; a value that is present but not
  // one of the accepted codes holds the row for review rather than being
  // silently dropped, since each of them changes how the field team works
  // the customer (which day it is visited, whether it is closed).
  const channelRaw = uc(readCell(row, 'channel') ?? '');
  let channelKey: string | null = null;
  if (channelRaw) {
    if (ctx.channelKeys.has(channelRaw)) channelKey = channelRaw;
    else issues.push({ field: 'channel', message: `unknown channel "${channelRaw}"` });
  }
  const dayRaw = uc(readCell(row, 'day_of_visit') ?? '');
  let dayOfVisit: string | null = null;
  if (dayRaw) {
    if (DAY_CODES.has(dayRaw)) dayOfVisit = dayRaw;
    else
      issues.push({
        field: 'day_of_visit',
        message: `expected SAT/SUN/MON/TUE/WED/THU/FRI, got "${dayRaw}"`,
      });
  }
  const statusRaw = uc(readCell(row, 'customer_status') ?? '');
  let customerStatus: string | null = null;
  if (statusRaw) {
    if (STATUS_CODES.has(statusRaw)) customerStatus = statusRaw;
    else
      issues.push({
        field: 'customer_status',
        message: `expected ACTIVE/CLOSED/SUSPENDED, got "${statusRaw}"`,
      });
  }

  // Owner's answer 2026-11-11 (A5), shop codes: held back, never matched,
  // when the code only LOOKS like one of the customer's shops or rows.
  const branchCode = rowBranchCode(row);
  // A row the Steward released as a different shop is still held back for a
  // code that differs ONLY in capital letters: that one would load as the same shop.
  if (custCode && branchCode) {
    const hit = shopLookalike(
      custCode,
      branchCode,
      ctx.masterShops?.get(custCode) ?? [],
      ctx.shopsInFile?.get(custCode) ?? [],
      !!opts.shopCodeReleased
    );
    if (hit) issues.push({ field: 'branch_code', message: shopLookalikeMessage(hit) });
  }

  // Owner's answer 2026-11-11 (A5): which codes were read in capital letters.
  const capitalised: Capitalised[] = [];
  const custWritten = rowCustCodeAsWritten(row);
  if (custWritten && custWritten !== custCode) {
    capitalised.push({ cell: 'cust_code', from: custWritten, to: custCode });
  }
  if (temixCode && temixWritten.toUpperCase() !== temixWritten) {
    capitalised.push({ cell: 'temix_code', from: temixWritten, to: temixCode });
  }

  const parsed: ParsedCustomerRow = {
    custCode,
    custName,
    channelKey,
    dayOfVisit,
    customerStatus,
    branchCode,
    branchName: stripHtml(readCell(row, 'branch_name')) || null,
    regionCode: stripHtml(readCell(row, 'sales_region')) || null,
    routeCode: stripHtml(readCell(row, 'route')) || null,
    address: stripHtml(readCell(row, 'address')) || null,
    phone,
    contactPerson: stripHtml(readCell(row, 'contact_person')) || null,
    crNumber: stripHtml(readCell(row, 'cr_no')) || null,
    paymentTerms,
    paymentTermsPresent,
    temixCode,
    creditLimit,
    paymentTermDays,
    ...(capitalised.length > 0 ? { capitalised } : {}),
    ...(opts.shopCodeReleased ? { shopCodeReleased: true as const } : {}),
  };
  return { parsed, issues };
}
