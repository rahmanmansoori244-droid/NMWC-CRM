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
 *    really are different shops, releases the row with a typed reason (as a
 *    shared phone is released; audited as FORCE_OVERRIDE). A row whose code is
 *    exactly the code of one of the customer's shops is never held back.
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
export type SiblingShop = { row: number | string; code: string; released?: boolean };

/** `caseOnly`: the two codes differ only in capital and small letters, not in zeros. */
export type ShopLookalike =
  | { kind: 'shop'; sheetCode: string; other: string; caseOnly: boolean }
  | { kind: 'row'; sheetCode: string; other: string; row: number | string; caseOnly: boolean };

/**
 * Whether a row's branch_code looks like, but is not, one of its customer's
 * shops (`shops`: the codes stored in the CRM) or another of its rows in the
 * sheet (`siblings`). A blank code, or one that IS one of the customer's shops,
 * is never a lookalike. A sibling the Steward released as a different shop is
 * not compared.
 */
export function shopLookalike(
  custCode: string,
  sheetCode: string | null | undefined,
  shops: readonly string[],
  siblings: readonly SiblingShop[]
): ShopLookalike | null {
  const written = (sheetCode ?? '').trim();
  if (!written || !custCode) return null;
  const mine = rowShopCode(custCode, written);
  if (shops.includes(mine)) return null;
  const key = shopCodeKey(mine);
  const shop = shops.find((s) => shopCodeKey(s) === key);
  if (shop) return { kind: 'shop', sheetCode: written, other: shop, caseOnly: shop.toUpperCase() === mine.toUpperCase() };
  for (const s of siblings) {
    if (s.released) continue;
    const theirs = (s.code ?? '').trim();
    if (!theirs) continue;
    const composed = rowShopCode(custCode, theirs);
    if (composed !== mine && shopCodeKey(composed) === key) {
      return {
        kind: 'row',
        sheetCode: written,
        other: theirs,
        row: s.row,
        caseOnly: composed.toUpperCase() === mine.toUpperCase(),
      };
    }
  }
  return null;
}

/** The start of every lookalike reason: lib/import-row-fix.ts canReleaseShopCode reads it. */
export const SHOP_LOOKALIKE = /^Shop code ".*" looks like /;

/** Why the row is held back, in the app's words; the field is 'branch_code'. */
export function shopLookalikeMessage(hit: ShopLookalike): string {
  const why = hit.caseOnly ? 'only capital and small letters differ' : 'Excel may have dropped a zero';
  const like =
    hit.kind === 'shop'
      ? `this customer's existing shop "${hit.other}"`
      : `shop code "${hit.other}" on row ${hit.row} of the same customer in this sheet`;
  return `Shop code "${hit.sheetCode}" looks like ${like} (${why}). Correct the code if it is the same shop; if it is a different shop, release the row with a reason.`;
}

/**
 * The first row of a customer's rows whose branch_code looks like one of its
 * shops or of its other rows, for the promote and the "Before you promote"
 * summary (a batch staged before this check, or a shop added since the upload).
 * Rows the Steward released as a different shop are skipped.
 */
export function groupShopLookalike(
  custCode: string,
  rows: ReadonlyArray<{ branchCode: string | null; shopCodeReleased?: boolean; rowNumber: number | string }>,
  shops: readonly string[]
): ShopLookalike | null {
  for (const [i, r] of rows.entries()) {
    if (r.shopCodeReleased === true) continue;
    const siblings: SiblingShop[] = rows
      .filter((_, j) => j !== i)
      .map((o) => ({ row: o.rowNumber, code: o.branchCode ?? '', released: o.shopCodeReleased === true }));
    const hit = shopLookalike(custCode, r.branchCode, shops, siblings);
    if (hit) return hit;
  }
  return null;
}
