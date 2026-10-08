/**
 * Numbers typed on an Arabic keyboard (launch review, Arabic input end to end).
 *
 * lib/phone.ts and lib/cr.ts fold Arabic-Indic digits in phones and CR numbers
 * (UXI-006, item 16, F19), but every other number a salesman types went through
 * Number() or parseFloat() as typed, and both read '٥٠٠' as NaN. So a credit
 * limit or a payment term typed in Arabic digits was "missing" at Submit and
 * sent as null (the server then said "greater than zero"), and a latitude or
 * longitude typed in by hand was "not a valid number".
 *
 * numberText() turns such a number into the ASCII one Number() reads:
 *   - Arabic-Indic (U+0660–U+0669) and Extended Arabic-Indic / Persian
 *     (U+06F0–U+06F9) digits become ASCII, as in lib/phone.ts and lib/cr.ts;
 *   - the Arabic decimal separator '٫' (U+066B) becomes '.', and the Arabic
 *     thousands separator '٬' (U+066C) is dropped;
 *   - the invisible bidi and format characters that Arabic text carries when it
 *     is copied are removed (the lib/cr.ts set), and the ends are trimmed.
 * The Latin comma is NOT touched: '1,500' is a thousands group to one person and
 * a decimal to another, so each caller keeps the rule it had (the typed GPS
 * point reads it as a decimal, typedDecimal below; a credit limit refuses it).
 *
 * Each range is written as escapes, as in lib/cr.ts: look-alike digits and
 * invisible characters are easier to review as code points than as glyphs.
 */
const ARABIC_INDIC_DIGIT = /[\u0660-\u0669]/g;
const PERSIAN_DIGIT = /[\u06F0-\u06F9]/g;
const ARABIC_DECIMAL_SEPARATOR = /\u066B/g;
const ARABIC_THOUSANDS_SEPARATOR = /\u066C/g;
/** The invisible bidi and format characters copied Arabic text carries (lib/cr.ts's set). */
export const INVISIBLE_FORMAT =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/** Arabic-Indic and Persian digits as ASCII; nothing else changes. */
export function asciiDigits(s: string): string {
  return s
    .replace(ARABIC_INDIC_DIGIT, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGIT, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** A typed number as the ASCII text Number() and parseFloat() read (above). */
export function numberText(s: string): string {
  return asciiDigits(s)
    .replace(ARABIC_DECIMAL_SEPARATOR, '.')
    .replace(ARABIC_THOUSANDS_SEPARATOR, '')
    .replace(INVISIBLE_FORMAT, '')
    .trim();
}

/**
 * The number typed into a box, or NaN when it is blank or not a number. Blank
 * is NaN, not Number('')'s 0, so a "must be more than zero" check and a
 * "was anything typed" check cannot disagree.
 */
export function typedNumber(s: string): number {
  const t = numberText(s);
  return t ? Number(t) : NaN;
}

const COMMA_AS_DECIMAL = /[,\u060C]/g;
const PLAIN_DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/**
 * A typed number where a comma is the decimal mark (the typed GPS point), or
 * NaN. The Latin ',' and the Arabic comma '،' (U+060C, the comma key on an
 * Arabic layout) read as '.', and then the whole text must be one plain
 * decimal number. parseFloat read up to the first character it did not know
 * and dropped the rest, so '٢٣،٥٨٧' or '٢٣ ٥٨٧' became 23, still inside Oman
 * and saved with no warning (launch review): refused now, as a typo should be.
 */
export function typedDecimal(s: string): number {
  const t = numberText(s).replace(COMMA_AS_DECIMAL, '.');
  return PLAIN_DECIMAL.test(t) ? Number(t) : NaN;
}

/**
 * For a zod schema that coerces (z.preprocess): a string is folded as above
 * before it is read as a number; anything else passes as it came.
 */
export function foldNumberInput(v: unknown): unknown {
  return typeof v === 'string' ? numberText(v) : v;
}
