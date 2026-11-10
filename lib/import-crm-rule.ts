/**
 * The field-ownership rule of a customer import (code review 2026-11-10,
 * finding 1; owner's rule: the CRM is master for a customer's name, phone, CR
 * number, contact person, channel, a shop's name, address and visit day, and for
 * open/closed status; Temix is master for route, cash/credit, credit limit,
 * credit days and the Temix code).
 *
 * For a customer or shop that ALREADY EXISTS, an import may FILL a blank
 * CRM-owned field and never replaces a value on record; it never changes an
 * existing customer's or shop's open/closed status. The per-batch option
 * "Overwrite CRM fields from this sheet" (Steward only, off by default) restores
 * the old behaviour, in which a non-blank cell always won.
 *
 * It works by NARROWING what the sheet row gives: a value that must not be
 * written is taken out of the row before the importer's own write code sees it
 * (services/imports.ts), so that code — the differing-cells comparison, the
 * audit rows, the version bump — stays exactly as it is. A new customer or shop
 * (nothing stored) passes through untouched.
 *
 * Pure: no database. The same functions drive the "Before you promote" summary
 * (lib/import-plan.ts), so the summary and the promote cannot disagree on a field.
 */
import { normalizeCR } from '@/lib/cr';

/** What the rule did, as field labels (never values). */
export type CrmOutcome = {
  /** The sheet differs from a value on record, and the record was kept. */
  kept: string[];
  /** The record was blank and the sheet's value fills it. */
  filled: string[];
  /** The sheet differs from a value on record and replaces it (the option is on). */
  replaced: string[];
};

/** The address the import itself gives a new shop whose row has none. Counts as blank. */
export const ADDRESS_PLACEHOLDER = 'Address pending';

/** The name of the per-batch option, as every screen and note words it. */
export const OVERWRITE_OPTION = 'Overwrite CRM fields from this sheet';

const isBlank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const sameText = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '').trim() === (b ?? '').trim();

export type SheetCustomerCrm = {
  /** undefined: the row gives no name to write. */
  custName: string | undefined;
  /** Normalised, as the check parses it. */
  phone: string | null;
  contactPerson: string | null;
  crNumber: string | null;
  /** The row's channel, resolved to its id. */
  channelId: string | null;
};

export type StoredCustomerCrm = {
  legalName?: string | null;
  primaryPhone?: string | null;
  primaryPhoneNorm?: string | null;
  contactPerson?: string | null;
  crNumber?: string | null;
  crNumberNorm?: string | null;
  channelId?: string | null;
};

type FieldState = 'none' | 'same' | 'fill' | 'differs';

function customerFieldStates(sheet: SheetCustomerCrm, stored: StoredCustomerCrm): Record<string, FieldState> {
  const name: FieldState = isBlank(sheet.custName)
    ? 'none'
    : isBlank(stored.legalName)
      ? 'fill'
      : sameText(sheet.custName, stored.legalName)
        ? 'same'
        : 'differs';
  // The phone is compared as it is stored for matching: normalised.
  const phone: FieldState = isBlank(sheet.phone)
    ? 'none'
    : isBlank(stored.primaryPhoneNorm) && isBlank(stored.primaryPhone)
      ? 'fill'
      : sheet.phone === stored.primaryPhoneNorm
        ? 'same'
        : 'differs';
  const contact: FieldState = isBlank(sheet.contactPerson)
    ? 'none'
    : isBlank(stored.contactPerson)
      ? 'fill'
      : sameText(sheet.contactPerson, stored.contactPerson)
        ? 'same'
        : 'differs';
  // The CR number too: spaces, capitals and digit scripts aside.
  const sheetCr = normalizeCR(sheet.crNumber);
  const storedCr = stored.crNumberNorm ?? normalizeCR(stored.crNumber);
  const cr: FieldState = isBlank(sheet.crNumber)
    ? 'none'
    : isBlank(stored.crNumberNorm) && isBlank(stored.crNumber)
      ? 'fill'
      : (sheetCr !== null && sheetCr === storedCr) || sameText(sheet.crNumber, stored.crNumber)
        ? 'same'
        : 'differs';
  const channel: FieldState = isBlank(sheet.channelId)
    ? 'none'
    : isBlank(stored.channelId)
      ? 'fill'
      : sheet.channelId === stored.channelId
        ? 'same'
        : 'differs';
  return { name, phone, 'contact person': contact, 'CR number': cr, channel };
}

/**
 * The customer half. `stored` null: a new customer, the row passes through.
 *
 * Fill-only (overwrite off): a field the row does not give, or gives as it is on
 * record, is taken out (nothing to write); one the record lacks stays and is
 * `filled`; one that differs from a value on record is taken out and `kept`.
 * Overwrite on: the row passes through, and what it will replace is `replaced`.
 */
export function customerCrmRule(
  overwrite: boolean,
  sheet: SheetCustomerCrm,
  stored: StoredCustomerCrm | null
): { sheet: SheetCustomerCrm } & CrmOutcome {
  if (!stored) return { sheet, kept: [], filled: [], replaced: [] };
  const states = customerFieldStates(sheet, stored);
  const labels = (s: FieldState) =>
    Object.entries(states)
      .filter(([, v]) => v === s)
      .map(([k]) => k);
  if (overwrite) return { sheet, kept: [], filled: labels('fill'), replaced: labels('differs') };
  const keep = (label: string) => states[label] === 'fill';
  return {
    sheet: {
      custName: keep('name') ? sheet.custName : undefined,
      phone: keep('phone') ? sheet.phone : null,
      contactPerson: keep('contact person') ? sheet.contactPerson : null,
      crNumber: keep('CR number') ? sheet.crNumber : null,
      channelId: keep('channel') ? sheet.channelId : null,
    },
    kept: labels('differs'),
    filled: labels('fill'),
    replaced: [],
  };
}

export type SheetBranchCrm = {
  /** The row gave a shop name (not the importer's "Main" fallback). */
  nameGiven: boolean;
  branchName: string;
  /** The address the row gave, usable as the database stores it, or null. */
  sheetAddress: string | null;
  dayOfVisit: string | null;
  status: string | null;
};

export type StoredBranchCrm = {
  branchName: string;
  address: string;
  dayOfVisit: string | null;
  status: string;
};

/**
 * The shop half. `stored` null: a new shop, the row passes through.
 *
 * Fill-only: a shop name, address or visit day that differs from a value on
 * record is taken out of the row and `kept`; a blank one on record is `filled`
 * (the importer's own "Address pending" placeholder counts as blank; "Main"
 * does not: it is a name people chose to keep). The status is never passed
 * through: a status that differs from the record is taken out and `kept`, so an
 * import neither closes an open shop nor reopens one an approved request closed.
 * The route is Temix's and is not this rule's business.
 *
 * `statusChange`: what the row's status would do (or, with the option on, does).
 */
export function branchCrmRule<T extends SheetBranchCrm>(
  overwrite: boolean,
  row: T,
  stored: StoredBranchCrm | null
): { row: T; statusChange: { from: string; to: string } | null } & CrmOutcome {
  if (!stored) return { row, statusChange: null, kept: [], filled: [], replaced: [] };
  const name: FieldState = !row.nameGiven
    ? 'none'
    : isBlank(stored.branchName)
      ? 'fill'
      : row.branchName === stored.branchName
        ? 'same'
        : 'differs';
  const address: FieldState = !row.sheetAddress
    ? 'none'
    : isBlank(stored.address) || stored.address.trim() === ADDRESS_PLACEHOLDER
      ? row.sheetAddress === stored.address
        ? 'same'
        : 'fill'
      : row.sheetAddress === stored.address
        ? 'same'
        : 'differs';
  const day: FieldState = !row.dayOfVisit
    ? 'none'
    : isBlank(stored.dayOfVisit)
      ? 'fill'
      : row.dayOfVisit === stored.dayOfVisit
        ? 'same'
        : 'differs';
  const statusDiffers = !!row.status && row.status !== stored.status;
  const states: Record<string, FieldState> = { 'shop name': name, address, 'visit day': day };
  const labels = (s: FieldState) =>
    Object.entries(states)
      .filter(([, v]) => v === s)
      .map(([k]) => k);
  const statusChange = statusDiffers ? { from: stored.status, to: row.status as string } : null;
  if (overwrite) {
    return {
      row,
      statusChange,
      kept: [],
      filled: labels('fill'),
      replaced: [...labels('differs'), ...(statusDiffers ? ['status'] : [])],
    };
  }
  const narrowed: T = {
    ...row,
    nameGiven: name === 'differs' ? false : row.nameGiven,
    sheetAddress: address === 'differs' ? null : row.sheetAddress,
    dayOfVisit: day === 'differs' ? null : row.dayOfVisit,
    // Never from a sheet: the status of a shop that exists.
    status: null,
  };
  return {
    row: narrowed,
    statusChange,
    kept: [...labels('differs'), ...(statusDiffers ? ['status'] : [])],
    filled: labels('fill'),
    replaced: [],
  };
}

const listOf = (labels: readonly string[]) =>
  labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;

type Who = 'customer' | { shop: string };
const whoOf = (who: Who) => (who === 'customer' ? 'customer' : `shop ${who.shop}`);

/**
 * The row's note for values the import kept: labels only, never the values.
 * Null when there is nothing to say.
 */
export function keptNote(who: Who, labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  const one = labels.length === 1;
  const status = labels.includes('status')
    ? `, and does not open or close a ${who === 'customer' ? 'customer' : 'shop'}`
    : '';
  return `${whoOf(who)}: the ${listOf(labels)} in this row ${one ? 'differs' : 'differ'} from the record and ${one ? 'was' : 'were'} kept — an import fills blank CRM fields only${status}`;
}

