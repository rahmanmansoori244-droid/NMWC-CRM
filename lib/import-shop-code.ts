/**
 * How the customer import spells the codes a sheet row carries (owner's answers
 * of 2026-11-11, item A5). PURE and import-free: the upload's row check, the
 * Steward's in-app fix, the promote, the "Before you promote" summary and the
 * batch page all read these same rules.
 *
 * 1. CUSTOMER CODE. "Change to capitals": a cust_code typed in small letters
 *    (cct0005) is read in capital letters (CCT0005), so it is the customer the
 *    CRM already knows by CCT0005, and a new customer is stored in capitals.
 *    Only the letters a-z are changed. Any other letter (Arabic, an accented
 *    letter) is left exactly as it is: the import does not guess what it should
 *    be. The cell as uploaded stays as it was in ImportRow.raw; the row carries
 *    a note (ImportRow.parsed.capitalised, then a '_capitals' note on the row
 *    when it loads) and the "Before you promote" summary counts such rows.
 *    The temix_code cell has always been read in capital letters
 *    (lib/temix-code.ts normalizeTemixCode); a row whose Temix code was typed in
 *    small letters now carries the same note.
 *
 * 2. SHOP CODE. "Hold the row back": nothing is matched or rewritten. A row's
 *    branch_code is compared with the codes of the shops the SAME customer
 *    already has in the CRM, and with the branch_code of the customer's other
 *    rows in the same sheet, through a comparison key: capital letters, and the
 *    leading zeros of every run of digits removed (01 and 1 give the same key;
 *    Ab and AB too). When the keys are equal but the codes are not the same,
 *    the row is held back with a reason that names both codes. The Steward
 *    corrects the branch_code cell (the existing fix flow), or, when the two
 *    really are different shops and their codes differ in their zeros,
 *    releases the row with a typed reason (as a shared phone is released;
 *    audited as FORCE_OVERRIDE). Codes that differ only in capital and small
 *    letters are never released: the CRM keeps shop codes in capitals, so
 *    they would load as the same shop. A row whose code is exactly the code of
 *    one of the customer's shops is never held back.
 */

/** The cells whose small letters the import changes to capitals. */
export type CapitalisedCell = 'cust_code' | 'temix_code';
export type Capitalised = { cell: CapitalisedCell; from: string; to: string };

/** A customer code as the import reads it: trimmed, the letters a-z in capitals, nothing else changed. */
export function capitalCode(value: string): string {
  return value.trim().replace(/[a-z]+/g, (s) => s.toUpperCase());
}

const CELL_NAME: Record<CapitalisedCell, string> = {
  cust_code: 'customer code',
  temix_code: 'Temix code',
};

/** The row's note when a code was changed to capital letters. */
export function capitalisedNote(list: readonly Capitalised[]): string | null {
  if (list.length === 0) return null;
  const parts = list.map((c) => `${CELL_NAME[c.cell]} "${c.from}" was read as "${c.to}"`);
  return `Small letters changed to capitals: ${parts.join('; ')}. The sheet is not changed.`;
}

/** The capitalised list a staged row carries, or [] (older rows have none). */
export function capitalisedOf(parsed: unknown): Capitalised[] {
  const v = (parsed as { capitalised?: unknown } | null)?.capitalised;
  if (!Array.isArray(v)) return [];
  return v.filter(
    (c): c is Capitalised =>
      !!c &&
      typeof c === 'object' &&
      ((c as Capitalised).cell === 'cust_code' || (c as Capitalised).cell === 'temix_code') &&
      typeof (c as Capitalised).from === 'string' &&
      typeof (c as Capitalised).to === 'string'
  );
}

/**
 * The comparison key of a shop code: capital letters, and the leading zeros of
 * each run of digits removed ("CCT0005-01" and "cct5-1" both give "CCT5-1").
 * Never stored and never used to match a shop: only to notice two codes that
 * look alike.
 */
export function shopCodeKey(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ''));
}

/**
 * The shop code a row names, composed under its customer as the promote composes
 * it (lib/import-row-fix.ts composeBranchCode), but with the row's own letters
 * KEPT: "ab" stays "CCT0005-ab", so it is not the same code as "CCT0005-AB".
 */
export function rowShopCode(custCode: string, sheetCode: string): string {
  const cc = custCode.trim().toUpperCase();
  const raw = sheetCode.trim();
  const up = raw.toUpperCase();
  if (up === cc) return cc;
  if (up.startsWith(`${cc}-`)) return cc + raw.slice(cc.length);
  return `${cc}-${raw}`;
}

/** Another row of the same customer in the same sheet, with its branch_code as written. */
export type SiblingShop = { row: number | string; code: string; released?: boolean; numbered?: boolean };

/**
 * `caseOnly`: the two codes differ only in capital and small letters, not in zeros.
 * `numbered` / `otherNumbered`: that code is not in the sheet — it is the number
 * the promote gives a NEW customer's row whose branch_code is blank.
 */
export type ShopLookalike =
  | { kind: 'shop'; sheetCode: string; other: string; caseOnly: boolean; numbered?: boolean }
  | {
      kind: 'row';
      sheetCode: string;
      other: string;
      row: number | string;
      caseOnly: boolean;
      numbered?: boolean;
      otherNumbered?: boolean;
      /**
       * The row whose code was compared (groupShopLookalike). The promote writes
       * one reason to every row of the customer, so a reason about a blank
       * (numbered) code names its rows by number, never "this row".
       */
      selfRow?: number | string;
    };

/**
 * Whether a row's branch_code looks like, but is not, one of its customer's
 * shops (`shops`: the codes stored in the CRM) or another of its rows in the
 * sheet (`siblings`). A blank code, or one that IS one of the customer's shops,
 * is never a lookalike. Codes that differ in their zeros are not compared with
 * a row the Steward released as a different shop, nor, with `released`, for
 * the row itself; codes that differ ONLY in capital and small letters always
 * are, because the CRM keeps shop codes in capitals and they would load as one
 * shop (SHOP_LOOKALIKE_RELEASABLE).
 */
export function shopLookalike(
  custCode: string,
  sheetCode: string | null | undefined,
  shops: readonly string[],
  siblings: readonly SiblingShop[],
  released = false
): ShopLookalike | null {
  const written = (sheetCode ?? '').trim();
  if (!written || !custCode) return null;
  const mine = rowShopCode(custCode, written);
  if (shops.includes(mine)) return null;
  const key = shopCodeKey(mine);
  const caseOnly = (code: string) => code.toUpperCase() === mine.toUpperCase();
  for (const shop of shops) {
    if (shopCodeKey(shop) !== key) continue;
    if (released && !caseOnly(shop)) continue;
    return { kind: 'shop', sheetCode: written, other: shop, caseOnly: caseOnly(shop) };
  }
  for (const s of siblings) {
    const theirs = (s.code ?? '').trim();
    if (!theirs) continue;
    const composed = rowShopCode(custCode, theirs);
    if (composed === mine || shopCodeKey(composed) !== key) continue;
    if ((released || s.released) && !caseOnly(composed)) continue;
    return {
      kind: 'row',
      sheetCode: written,
      other: theirs,
      row: s.row,
      caseOnly: caseOnly(composed),
      ...(s.numbered ? { otherNumbered: true } : {}),
    };
  }
  return null;
}

/** The start of every lookalike reason. */
export const SHOP_LOOKALIKE = /^Shop code ".*" looks like /;

/**
 * A lookalike the Steward may release as a different shop: the codes differ in
 * their zeros. Two codes that differ ONLY in capital and small letters cannot be
 * two shops: the promote stores and finds a shop code in capital letters, so
 * "ab" loads as the shop "AB". Such a row is corrected, never released.
 */
export const SHOP_LOOKALIKE_RELEASABLE = /^Shop code ".*" looks like .*\(Excel may have dropped a zero\)/;

/** Why the row is held back, in the app's words; the field is 'branch_code'. */
export function shopLookalikeMessage(hit: ShopLookalike): string {
  // Review of A5 (2026-11-11): a NEW customer's blank branch_code, numbered by its
  // place. There is no code in the sheet to release, only one to give, so these
  // words never match SHOP_LOOKALIKE_RELEASABLE.
  // Final check of the review (2026-11-11): the promote writes this reason to
  // EVERY row of the customer, so it names the rows by number: on the coded
  // row, "this row's branch_code is blank" was false.
  if (hit.kind === 'row' && hit.numbered) {
    const self = hit.selfRow !== undefined ? `row ${hit.selfRow}` : 'this row';
    const other = hit.otherNumbered
      ? `the number "${hit.other}" given to the blank branch_code on row ${hit.row}`
      : `shop code "${hit.other}" on row ${hit.row}`;
    return `The branch_code on ${self} is blank, so it would be numbered "${hit.sheetCode}", which looks like ${other} of the same customer in this sheet (only the zeros differ). Give ${self} a branch_code: the same code if it is the same shop, a different one if it is a different shop.`;
  }
  if (hit.kind === 'row' && hit.otherNumbered) {
    const fix =
      hit.selfRow !== undefined ? `correct the code "${hit.sheetCode}" on row ${hit.selfRow}` : 'correct this one';
    return `Shop code "${hit.sheetCode}" looks like "${hit.other}", the number the blank branch_code on row ${hit.row} of the same customer in this sheet would be given (only the zeros differ). Give row ${hit.row} a branch_code, or ${fix}: the same code if it is the same shop, a different one if it is a different shop.`;
  }
  const like =
    hit.kind === 'shop'
      ? `this customer's existing shop "${hit.other}"`
      : `shop code "${hit.other}" on row ${hit.row} of the same customer in this sheet`;
  return hit.caseOnly
    ? `Shop code "${hit.sheetCode}" looks like ${like} (only capital and small letters differ). Correct the code: shop codes are kept in capital letters, so if it is the same shop write it as that shop's code, and if it is a different shop give it a different code.`
    : `Shop code "${hit.sheetCode}" looks like ${like} (Excel may have dropped a zero). Correct the code if it is the same shop; if it is a different shop, release the row with a reason.`;
}

/**
 * The first row of a customer's rows whose branch_code looks like one of its
 * shops or of its other rows, for the promote and the "Before you promote"
 * summary (a batch staged before this check, or a shop added since the upload).
 * A row the Steward released as a different shop is compared only for codes
 * that differ in capital letters alone (shopLookalike).
 */
export function groupShopLookalike(
  custCode: string,
  rows: ReadonlyArray<{
    branchCode: string | null;
    shopCodeReleased?: boolean;
    rowNumber: number | string;
    /**
     * Review of A5 (2026-11-11): for a NEW customer, the code the promote gives
     * this row when its branch_code is blank (formatBranchCode by position), so
     * a blank row numbered "X-01" beside a row coded "1" is held, not loaded as
     * two shops X-01 and X-1.
     */
    numberedAs?: string | null;
  }>,
  shops: readonly string[]
): ShopLookalike | null {
  const codeOf = (r: (typeof rows)[number]) => {
    const given = (r.branchCode ?? '').trim();
    return given ? { code: given, numbered: false } : { code: r.numberedAs ?? '', numbered: !!r.numberedAs };
  };
  for (const [i, r] of rows.entries()) {
    const siblings: SiblingShop[] = rows
      .filter((_, j) => j !== i)
      .map((o) => {
        const c = codeOf(o);
        return { row: o.rowNumber, code: c.code, released: o.shopCodeReleased === true, numbered: c.numbered };
      });
    const mine = codeOf(r);
    const hit = shopLookalike(custCode, mine.code, shops, siblings, r.shopCodeReleased === true);
    if (!hit) continue;
    const withRow =
      hit.kind === 'row' && (mine.numbered || hit.otherNumbered) ? { ...hit, selfRow: r.rowNumber } : hit;
    return mine.numbered ? { ...withRow, numbered: true } : withRow;
  }
  return null;
}
