/**
 * The pairing half of the duplicate detector (services/duplicates.ts): given the
 * live customers and the Steward's dismissals, which pairs go on /duplicates.
 *
 * It is pure so it can be tested without a database (benchmark item 16: until
 * then nothing tested duplicate detection at all). It cannot live beside the
 * queries, because a 'use server' module may export only async functions.
 *
 * The two rules are P1.4's (2026-05-10), unchanged here:
 *   1. CR — the same normalized CR number, in any region.
 *   2. EXACT_TRIPLE — the same legal name (case and outer spaces ignored), the
 *      same normalized phone, and the same region of the customer's first live
 *      branch.
 * A phone alone is not a signal (one owner often runs many shops on one phone),
 * and fuzzy names were dropped as too noisy.
 */

export type DupSummary = {
  id: string;
  nmwcCode: string;
  legalName: string;
  primaryPhone: string | null;
  crNumber: string | null;
  completenessScore: number;
  branchCount: number;
};

export type DuplicateCandidate = {
  reason: 'CR' | 'EXACT_TRIPLE';
  similarity: number; // 0–1; both rules are exact, so always 1
  a: DupSummary;
  b: DupSummary;
};

/** One live customer as the detector reads it. */
export type DupRow = DupSummary & {
  primaryPhoneNorm: string | null;
  crNumberNorm: string | null;
  /** Region of the customer's first live branch by branch code; null with no live branch. */
  firstRegionId: string | null;
};

export type DuplicateScan = {
  /** At most `limit` pairs, CR pairs first. */
  pairs: DuplicateCandidate[];
  /** Every pair the rules find that is not dismissed — what the page count must say. */
  total: number;
};

/** One key per unordered pair, so a pair and its reverse are the same pair. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function crKey(row: DupRow): string | null {
  return row.crNumberNorm || null;
}

export function tripleKey(row: DupRow): string | null {
  if (!row.legalName || !row.primaryPhoneNorm || !row.firstRegionId) return null;
  return `${row.legalName.toLowerCase().trim()}|${row.primaryPhoneNorm}|${row.firstRegionId}`;
}

/**
 * The Steward's "Mark distinct" rows (AuditLog entityType 'CustomerPair',
 * entityId "aId|bId"), as pair keys. A dismissal hides the pair in both orders.
 * Anything that is not exactly two non-empty ids is ignored: customer ids never
 * contain "|", so such a row can only be malformed, and reading its first two
 * segments would hide a pair nobody dismissed.
 */
export function parseDismissed(entityIds: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of entityIds) {
    const parts = id.split('|');
    if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0] === parts[1]) continue;
    out.add(pairKey(parts[0], parts[1]));
  }
  return out;
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

/**
 * The pairs to show, CR pairs first, and how many there are in all. A pair that
 * matches both rules is listed once, as CR. Within a rule, pairs follow the
 * order of `rows` — the caller sorts them so the page does not reshuffle
 * between loads.
 *
 * `total` is counted, not enumerated: a placeholder CR shared by a thousand
 * customers is half a million pairs, and listing them to count them would cost
 * more than the page is worth.
 */
export function pairCandidates(
  rows: DupRow[],
  dismissed: ReadonlySet<string>,
  limit: number
): DuplicateScan {
  const byCr = groupBy(rows, crKey);
  const byTriple = groupBy(rows, tripleKey);

  const pairs: DuplicateCandidate[] = [];
  const seen = new Set<string>();
  const emit = (reason: DuplicateCandidate['reason'], group: DupRow[]) => {
    for (let i = 0; i < group.length && pairs.length < limit; i++) {
      for (let j = i + 1; j < group.length && pairs.length < limit; j++) {
        const key = pairKey(group[i].id, group[j].id);
        if (dismissed.has(key) || seen.has(key)) continue;
        seen.add(key);
        pairs.push({ reason, similarity: 1, a: summary(group[i]), b: summary(group[j]) });
      }
    }
  };
  for (const group of byCr.values()) emit('CR', group);
  for (const group of byTriple.values()) emit('EXACT_TRIPLE', group);

  // The count. A pair sharing a CR is a CR pair even when it also matches the
  // triple, so each triple group gives up the pairs inside it that share a CR.
  let total = 0;
  for (const group of byCr.values()) total += choose2(group.length);
  for (const group of byTriple.values()) {
    total += choose2(group.length);
    for (const sameCr of groupBy(group, crKey).values()) total -= choose2(sameCr.length);
  }
  // Each dismissed pair still made of two live customers was counted exactly once
  // above, under CR if it shares one, else under the triple if it shares that.
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const key of dismissed) {
    const [x, y] = key.split('|');
    const a = byId.get(x);
    const b = byId.get(y);
    if (!a || !b) continue;
    const cr = crKey(a);
    const triple = tripleKey(a);
    if ((cr && cr === crKey(b)) || (triple && triple === tripleKey(b))) total -= 1;
  }

  return { pairs, total };
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
