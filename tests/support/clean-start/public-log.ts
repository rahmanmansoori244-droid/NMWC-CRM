/**
 * The clean-start PUBLIC LOG RULE (design section 8), as a test can hold a log
 * to it: every line is one of
 *
 *   - a step name                      "STEP plan: preflight"
 *   - a yes/no line                    "<label>: yes" / "<label>: no", and the few fixed
 *                                      outcomes run.sh prints ("ok", "refused, rolled back", …)
 *   - a SQLSTATE code                  "<label>: SQLSTATE CS013"
 *   - a check id with its status       "history-open-interval: pass", "night 2:", MISMATCH lines
 *   - a duration                       "<label> took 3 s"
 *   - a hash                           "plan id: <12 hex>", "list_sha256 for the photo step: <64 hex>"
 *   - the reset's start time and run id the owner's runbook asks for
 *   - a refusal: "::error::" and one fixed sentence;
 *
 * AND no line carries anything on the forbidden list the caller passes (the
 * world's names, keys, secrets), a connection string, an e-mail address or a
 * storage key. `::add-mask::` lines are GitHub's own and never shown.
 */
const LABEL = String.raw`[A-Za-z][A-Za-z0-9 ,'()/._:-]*?`;
const OUTCOME = [
  'yes',
  'no',
  'ok',
  'failed',
  'refused, rolled back',
  String.raw`no connection \(the outcome is unknown\)`,
  String.raw`no \(nothing changed\)`,
  String.raw`unknown \(no connection\); run mode finish with this run id`,
  String.raw`no \(no read-only UAT connection set\)`,
  'yes; set MIN_DUMP_BYTES to (?:80000|40000|20000)',
  'yes; even 20000 bytes is too high, ask before the reset',
].join('|');

const ALLOWED: RegExp[] = [
  /^STEP [a-z0-9 :.-]+$/,
  new RegExp(`^${LABEL}: (?:${OUTCOME})$`),
  new RegExp(`^${LABEL}: SQLSTATE [0-9A-Z]{5}$`),
  new RegExp(`^${LABEL}: (?:[0-9a-f]{12}|[0-9a-f]{64})$`),
  new RegExp(`^${LABEL} took \\d+ s$`),
  /^reset started at \(UTC\): \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  /^run_id for the photo step: \d{1,20}$/,
  /^night [12]:$/,
  /^ *[a-z0-9-]+: (?:pass|fail|info|error)(?: \(not asserted\))?$/,
  /^ *MISMATCH night [12] [a-z0-9-]+: [a-z]+, expected [a-z|]+(?: listed)?$/,
  /^::error::[A-Za-z][A-Za-z0-9 ,;'()/._:=-]*$/,
];

/** What no line may hold, whatever the caller forgot to list. */
const NEVER: RegExp[] = [
  /:\/\//, // a URL (a connection string, an endpoint)
  /@/, // credentials in a URL, an e-mail address
  /\bseals\/v1\//, // a seal object key
  /\b\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9]+\//, // a photo key
  /\bdb\/\d{4}-/, // a dump key
  /\bcleanstart\/\d+\//, // a report key
  /AGE-SECRET-KEY|age1[0-9a-z]{20,}/,
];

export type Violation = { line: string; why: string };

export function publicLogViolations(lines: readonly string[], forbidden: readonly string[] = []): Violation[] {
  const out: Violation[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('::add-mask::')) continue;
    if (!ALLOWED.some((re) => re.test(line))) out.push({ line, why: 'not an allowed line shape' });
    for (const re of NEVER) if (re.test(line)) out.push({ line, why: `matches ${re}` });
    for (const f of forbidden) if (f && f.length >= 4 && line.includes(f)) out.push({ line, why: 'carries a forbidden value' });
  }
  return out;
}
