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
};

export type RowCheckOptions = {
  /**
   * The Steward released this row's shared phone (item 20, audited as
   * FORCE_OVERRIDE): the phone is on another customer in the master, and that
   * is legitimate here — one owner often runs several shops on one number.
   */
  phoneReleased?: boolean;
};

/**
 * F-05 / QA-029 — strip HTML tags before persisting any user-supplied text
 * field. Mirrors the same helper used on the edit form (lib/validation/edit).
 * Without this, an import row carrying `legalName="<script>…</script>"` lands
 * in the master verbatim, then propagates back through Excel exports and JSON
 * audit-log views.
 */
export function stripHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .trim();
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

export function rowCustCode(row: SheetRow): string {
  return stripHtml(row.cust_code ?? row.custcode ?? row.CUSTCODE ?? row.code ?? row.Code).trim();
}

/** The branch_code cell as the check reads it, or null when blank. */
export function rowBranchCode(row: SheetRow): string | null {
  return stripHtml(row.branch_code ?? row['CUST BRANCH']) || null;
}

export function rowPhoneNorm(row: SheetRow): string | null {
  return normalizePhone(
    String(row.phone ?? row.PHONE ?? row['Primary Phone'] ?? '').trim() || null
  );
}

export function rowCrNorm(row: SheetRow): string | null {
  return normalizeCR(String(row.cr_no ?? row['CR NO'] ?? '').trim() || null);
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
  const custName = stripHtml(row.cust_name ?? row['CUST NAME'] ?? row.name);
  // Read the SAME header fallbacks as normalizePhone below — otherwise a phone
  // supplied in the 'PHONE' or 'Primary Phone' column skipped the format check
  // entirely (an invalid number in those columns was silently accepted).
  const phoneRaw = String(row.phone ?? row.PHONE ?? row['Primary Phone'] ?? '').trim();
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
  const ptRaw = String(row.payment_terms ?? row['PAYMENT TERMS'] ?? '')
    .trim()
    .toUpperCase();
  let paymentTerms = 'CASH';
  const paymentTermsPresent = ptRaw === 'CASH' || ptRaw === 'CREDIT';
  if (ptRaw && !paymentTermsPresent) {
    issues.push({ field: 'payment_terms', message: `expected CASH or CREDIT, got "${ptRaw}"` });
  } else if (ptRaw === 'CREDIT') {
    paymentTerms = 'CREDIT';
  }
  // F-05: refuse formula payloads in any text field.
  for (const field of ['cust_name', 'address', 'contact_person', 'notes']) {
    if (isFormulaPayload(row[field])) {
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
  const temixCode =
    stripHtml(row.temix_code ?? row.temixcode ?? row['TEMIX CODE'] ?? row['Temix Code']).trim() ||
    null;
  let creditLimit: number | null = null;
  const creditRaw = String(row.credit_limit ?? row['CREDIT LIMIT'] ?? '').trim();
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
  const termRaw = String(row.payment_term_days ?? row['PAYMENT TERM DAYS'] ?? '').trim();
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
  const channelRaw = uc(row.channel ?? row.CHANNEL ?? '');
  let channelKey: string | null = null;
  if (channelRaw) {
    if (ctx.channelKeys.has(channelRaw)) channelKey = channelRaw;
    else issues.push({ field: 'channel', message: `unknown channel "${channelRaw}"` });
  }
  const dayRaw = uc(row.day_of_visit ?? row['DAY OF VISIT'] ?? '');
  let dayOfVisit: string | null = null;
  if (dayRaw) {
    if (DAY_CODES.has(dayRaw)) dayOfVisit = dayRaw;
    else
      issues.push({
        field: 'day_of_visit',
        message: `expected SAT/SUN/MON/TUE/WED/THU/FRI, got "${dayRaw}"`,
      });
  }
  const statusRaw = uc(row.customer_status ?? row['CUSTOMER STATUS'] ?? '');
  let customerStatus: string | null = null;
  if (statusRaw) {
    if (STATUS_CODES.has(statusRaw)) customerStatus = statusRaw;
    else
      issues.push({
        field: 'customer_status',
        message: `expected ACTIVE/CLOSED/SUSPENDED, got "${statusRaw}"`,
      });
  }

  const parsed: ParsedCustomerRow = {
    custCode,
    custName,
    channelKey,
    dayOfVisit,
    customerStatus,
    branchCode: rowBranchCode(row),
    branchName: stripHtml(row.branch_name ?? row['CUST BRANCH'] ?? row.branch) || null,
    regionCode: stripHtml(row.sales_region ?? row['SALES REGION'] ?? row.region) || null,
    routeCode: stripHtml(row.route ?? row['ROUTE']) || null,
    address: stripHtml(row.address ?? row.ADDRSS ?? row.ADDRESS) || null,
    phone,
    contactPerson: stripHtml(row.contact_person ?? row['CONTACT PERSON']) || null,
    crNumber: stripHtml(row.cr_no ?? row['CR NO']) || null,
    paymentTerms,
    paymentTermsPresent,
    temixCode,
    creditLimit,
    paymentTermDays,
  };
  return { parsed, issues };
}
