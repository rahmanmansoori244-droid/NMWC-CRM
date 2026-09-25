/**
 * The pairing half of the duplicate detector (services/duplicates.ts): given the
 * live customers and the Steward's "Mark distinct" history, which pairs go on
 * /duplicates, how many there are in all, and which pairs a dismissal is hiding.
 *
 * It is pure so it can be tested without a database (benchmark item 16: until
 * then nothing tested duplicate detection at all). It cannot live beside the
 * queries, because a 'use server' module may export only async functions. It
 * imports node:crypto, so it is for the server only; the page's client
 * components import nothing from it but types.
 *
 * The two rules, as the owner decided them on 2026-09-25:
 *   1. CR — the same normalized CR number (lib/cr.ts), in any region.
 *   2. EXACT_TRIPLE — the same legal name (lib/name-key.ts: whitespace runs
 *      collapsed, ends trimmed, case folded), the same normalized phone, and at
 *      least one region in common among the two customers' live branches. That
 *      is the rule the new-customer block in lib/create-guards.ts applies, so a
 *      shop it refuses at create time is a shop this detector pairs. Until this
 *      change only the region of each customer's FIRST live branch counted, so a
 *      multi-branch twin whose shared region was its second branch was never
 *      found.
 * A phone alone is not a signal (one owner often runs many shops on one phone),
 * and fuzzy names were dropped as too noisy.
 *
 * Dismissals lapse (owner decision 2026-09-25). "Mark distinct" stores the
 * signals the pair matched on at that moment — a hash of the shared CR and/or a
 * hash of the shared name key + phone — and the dismissal hides the pair only
 * while every signal it matches on NOW is among them. A new shared CR, a name or
 * phone changed into another shared one, or a rule that newly matches brings the
 * pair back. Region is not part of a signal: the triple signal is present when
 * the triple rule matches, but its value is the name and phone alone, so a
 * branch moving between two regions the pair shares does not undo a Steward's
 * decision. Rows written before signals were stored hide the pair whatever it
 * matches, as they always did. An undo row un-dismisses; the latest row wins.
 */
import { createHash } from 'node:crypto';
import { nameKey } from './name-key';

export type DupSummary = {
  id: string;
  nmwcCode: string;
  legalName: string;
  primaryPhone: string | null;
  crNumber: string | null;
  completenessScore: number;
  branchCount: number;
};

/** When a pair was marked distinct, and by whom (a display name). */
export type DismissalStamp = { at: Date | null; by: string | null };

export type DuplicateCandidate = {
  reason: 'CR' | 'EXACT_TRIPLE';
  similarity: number; // 0–1; both rules are exact, so always 1
  a: DupSummary;
  b: DupSummary;
  /**
   * Set when the Steward marked this pair distinct before and the match has
   * changed since, so that dismissal no longer holds — the page says so, rather
   * than showing a pair the Steward remembers dismissing as if it were new.
   */
  markedDistinctBefore?: DismissalStamp;
};

/** One live customer as the detector reads it. */
export type DupRow = DupSummary & {
  primaryPhoneNorm: string | null;
  crNumberNorm: string | null;
  /** The regions of every live branch; empty with no live branch. */
  regionIds: readonly string[];
};

/** The fields a pair's match signals are computed from. */
export type SignalRow = Pick<DupRow, 'legalName' | 'primaryPhoneNorm' | 'crNumberNorm' | 'regionIds'>;

export type Dismissal = DismissalStamp & {
  /**
   * The pair's signals when it was marked distinct. null for a row written
   * before signals were stored: it hides the pair whatever the pair matches.
   */
  signals: ReadonlySet<string> | null;
};

/** One AuditLog row of entityType 'CustomerPair', as the reader needs it. */
export type PairLogRow = {
  entityId: string;
  after?: unknown;
  at?: Date | null;
  by?: string | null;
};

/** A pair a dismissal is hiding right now: both customers live, still matching a rule. */
export type MarkedDistinctPair = DismissalStamp & { a: DupSummary; b: DupSummary };

export type DuplicateScan = {
  /** At most `limit` pairs, CR pairs first. */
  pairs: DuplicateCandidate[];
  /** Every pair the rules find that no dismissal hides — what the page count must say. */
  total: number;
  /** Every pair a dismissal hides now, most recently marked first. */
  markedDistinct: MarkedDistinctPair[];
};

/** One key per unordered pair, so a pair and its reverse are the same pair. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function crKey(row: Pick<DupRow, 'crNumberNorm'>): string | null {
  return row.crNumberNorm || null;
}

/** Name key + normalized phone: the triple without its region. */
export function namePhoneKey(row: Pick<DupRow, 'legalName' | 'primaryPhoneNorm'>): string | null {
  if (!row.primaryPhoneNorm) return null;
  const name = nameKey(row.legalName ?? '');
  if (!name) return null;
  return `${name}|${row.primaryPhoneNorm}`;
}

/** Whether two customers have a live branch in at least one common region. */
export function sharesRegion(a: Pick<DupRow, 'regionIds'>, b: Pick<DupRow, 'regionIds'>): boolean {
  return a.regionIds.some((r) => b.regionIds.includes(r));
}

/**
 * A short one-way digest of a matched value. The audit ledger is append-only,
 * so a CR number or a phone stored there in the clear would be personal data
 * kept forever; the digest lets a later scan tell "the same value" from "a new
 * one" without holding the value. It is not anonymisation: a seven-digit CR can
 * be recovered from it by trying every number.
 */
export function signalHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/**
 * What the pair matches on now, as signals: 'cr:<digest>' when it shares a CR,
 * 'triple:<digest of name key + phone>' when the name + phone + region rule
 * matches. Empty when the pair is not a suspected duplicate at all.
 */
export function matchSignals(a: SignalRow, b: SignalRow): string[] {
  const out: string[] = [];
  const cr = crKey(a);
  if (cr && cr === crKey(b)) out.push(`cr:${signalHash(cr)}`);
  const np = namePhoneKey(a);
  if (np && np === namePhoneKey(b) && sharesRegion(a, b)) out.push(`triple:${signalHash(np)}`);
  return out;
}

const SIGNAL = /^(cr|triple):[0-9a-f]{16}$/;

/** A pair id as "aId|bId": exactly two different, non-empty ids. */
function pairIds(entityId: string): [string, string] | null {
  const parts = entityId.split('|');
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0] === parts[1]) return null;
  return [parts[0], parts[1]];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The Steward's "Mark distinct" history (AuditLog entityType 'CustomerPair',
 * entityId "aId|bId"), reduced to the dismissal in force per pair. `rows` must
 * be in the order they were written (`at`, then id): the latest row for a pair
 * wins, so an undo after a dismissal removes it and a dismissal after an undo
 * restores it. Either order of the ids names the same pair.
 *
 * A row counts only if it is well formed; anything else is ignored, so it
 * neither hides a pair nor undoes a dismissal:
 *   - the entityId must be exactly two different non-empty ids (customer ids
 *     never contain "|", so "a|b|c" can only be malformed, and reading its first
 *     two segments would hide a pair nobody dismissed);
 *   - `after` absent or null is a dismissal written before signals were stored;
 *   - `after` { signals: [...] } is a dismissal, when every signal is
 *     "cr:" or "triple:" and sixteen hex digits, and there is at least one;
 *   - `after` { undo: true } is an undo;
 *   - any other `after` (both at once, an empty list, a raw value) is malformed.
 */
export function parseDismissals(rows: Iterable<PairLogRow>): Map<string, Dismissal> {
  const out = new Map<string, Dismissal>();
  for (const row of rows) {
    const ids = pairIds(row.entityId);
    if (!ids) continue;
    const key = pairKey(ids[0], ids[1]);
    const stamp: DismissalStamp = { at: row.at ?? null, by: row.by ?? null };
    const after = row.after;
    if (after === undefined || after === null) {
      out.delete(key);
      out.set(key, { ...stamp, signals: null });
      continue;
    }
    if (!isPlainObject(after)) continue;
    const hasSignals = 'signals' in after;
    if (after.undo === true && !hasSignals) {
      out.delete(key);
      continue;
    }
    if ('undo' in after || !hasSignals) continue;
    const signals = after.signals;
    if (!Array.isArray(signals) || signals.length === 0) continue;
    if (!signals.every((s) => typeof s === 'string' && SIGNAL.test(s))) continue;
    // Deleted first so the map's order is the order dismissals took effect.
    out.delete(key);
    out.set(key, { ...stamp, signals: new Set(signals as string[]) });
  }
  return out;
}

/**
 * Whether a dismissal hides a pair whose current signals are `signals`: the pair
 * must match something, and every signal it matches on must have been there
 * when it was marked distinct. A dismissal from before signals were stored hides
 * whatever the pair matches.
 */
export function dismissalHides(d: Dismissal | undefined, signals: readonly string[]): boolean {
  if (!d || signals.length === 0) return false;
  if (d.signals === null) return true;
  const stored = d.signals;
  return signals.every((s) => stored.has(s));
}

function groupBy(rows: DupRow[], key: (r: DupRow) => string | null): Map<string, DupRow[]> {
  const groups = new Map<string, DupRow[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return groups;
}

const choose2 = (n: number) => (n * (n - 1)) / 2;

function summary(r: DupRow): DupSummary {
  return {
    id: r.id,
    nmwcCode: r.nmwcCode,
    legalName: r.legalName,
    primaryPhone: r.primaryPhone,
    crNumber: r.crNumber,
    completenessScore: r.completenessScore,
    branchCount: r.branchCount,
  };
}

const stampOf = (d: Dismissal): DismissalStamp => ({ at: d.at, by: d.by });

/**
 * The pairs to show, CR pairs first, and how many there are in all. A pair that
 * matches both rules is listed once, as CR. Within a rule, pairs follow the
 * order of `rows` — the caller sorts them so the page does not reshuffle
 * between loads.
 *
 * CR pairs are counted, not enumerated: a placeholder CR shared by a thousand
 * customers is half a million pairs, and listing them to count them would cost
 * more than the page is worth. The triple is grouped by name key + phone first,
 * and only inside those groups — a handful of customers each, in practice — are
 * pairs enumerated to test for a shared region and a shared CR.
 */
export function pairCandidates(
  rows: DupRow[],
  dismissals: ReadonlyMap<string, Dismissal>,
  limit: number
): DuplicateScan {
  const byCr = groupBy(rows, crKey);
  const byNamePhone = groupBy(rows, namePhoneKey);

  const pairs: DuplicateCandidate[] = [];
  // Only a pair somebody dismissed pays for a hash; every other pair is a map miss.
  const consider = (reason: DuplicateCandidate['reason'], a: DupRow, b: DupRow) => {
    const d = dismissals.get(pairKey(a.id, b.id));
    if (d && dismissalHides(d, matchSignals(a, b))) return;
    const candidate: DuplicateCandidate = { reason, similarity: 1, a: summary(a), b: summary(b) };
    if (d) candidate.markedDistinctBefore = stampOf(d);
    pairs.push(candidate);
  };

  let total = 0;
  for (const group of byCr.values()) {
    total += choose2(group.length);
    for (let i = 0; i < group.length && pairs.length < limit; i++) {
      for (let j = i + 1; j < group.length && pairs.length < limit; j++) {
        consider('CR', group[i], group[j]);
      }
    }
  }
  // A pair sharing a CR is a CR pair even when it also matches the triple, so it
  // was counted, and listed, above.
  for (const group of byNamePhone.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]];
        if (!sharesRegion(a, b)) continue;
        const cr = crKey(a);
        if (cr && cr === crKey(b)) continue;
        total += 1;
        if (pairs.length < limit) consider('EXACT_TRIPLE', a, b);
      }
    }
  }

  // Each pair a dismissal hides matches a rule, so it was counted exactly once
  // above; take it back off, and list it for the "Marked distinct" section.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const markedDistinct: MarkedDistinctPair[] = [];
  for (const [key, d] of dismissals) {
    const [x, y] = key.split('|');
    const a = byId.get(x);
    const b = byId.get(y);
    if (!a || !b) continue;
    if (!dismissalHides(d, matchSignals(a, b))) continue;
    total -= 1;
    markedDistinct.push({ ...stampOf(d), a: summary(a), b: summary(b) });
  }
  // The map is in the order dismissals took effect; the page wants the latest first.
  markedDistinct.reverse();

  return { pairs, total, markedDistinct };
}

/**
 * The /duplicates subtitle. It used to print how many pairs were on the page
 * and call that the count, so 5,000 suspected pairs read "50 suspected pairs".
 */
export function duplicatesSubtitle(shown: number, total: number): string {
  if (total === 0) return 'No suspected pairs';
  const count = `${total.toLocaleString('en-US')} suspected pair${total === 1 ? '' : 's'}`;
  return shown < total ? `${count} · showing the first ${shown}` : count;
}
