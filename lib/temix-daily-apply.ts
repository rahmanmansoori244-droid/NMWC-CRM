/**
 * The daily Temix import, stage 5: the rules of the apply (route moves of
 * shops the CRM already has), as pure functions. The writes are in
 * services/temix-daily-apply.ts; the one route writer is lib/temix-daily-move.ts.
 *
 * WHAT A ROW BECOMES. Each staged row is planned again by the Check
 * (lib/temix-daily-check.ts checkDailyFile), one customer at a time, under that
 * customer's lock, inside the transaction that writes it, and then:
 *
 *  - held by the Check (unknown or archived customer, shop not found, not
 *    linked, look-alike, blank or customer-coded shop, a note found at upload)
 *    -> HELD, with the Check's reasons. Nothing is written but the row.
 *  - a shop found whose route is not applied (no route in the file, a code not
 *    matched, a code two CRM routes share, a switched-off route)
 *    -> NO_CHANGE, with that reason kept in its reasons (ROUTE_NOT_MATCHED,
 *    ...). The shop keeps its route. The plan: an unmatched route on a shop
 *    that exists "is not a hold of the whole row; the rest of the row still
 *    applies", and the Check counts such a row under "no change", the figure
 *    the Steward confirms (review 2026-11-15, finding 2: such rows were stored
 *    HELD, so a load ended with more held rows than were confirmed). In this
 *    stage the move is all a row can change, so such a row changes nothing;
 *    once credit and terms are applied (stage 8, after the owner's answer) it
 *    would be PARTLY_APPLIED.
 *  - a move that would set back the last move the daily file made on that shop
 *    (to the route it came from) on a file whose reversal warning was not ticked
 *    -> HELD, REVERSAL_NOT_ACKED. The start asks for the tick whenever its
 *    preview finds one; this catches one that appears after the start.
 *  - a move -> APPLIED, through moveShopToRoute.
 *  - anything else (the shop is already on the route) -> NO_CHANGE. Nothing is
 *    written but the row: the same file twice changes nothing the second time.
 *  - a customer whose transaction fails APPLY_GROUP_MAX_FAILURES times for a
 *    reason that is not a conflict (review 2026-11-15) -> HELD, APPLY_FAILED,
 *    nothing of it written, so the file can still finish and the order rule
 *    does not stop every later file behind it. The next file brings the rows
 *    again.
 *
 * WHAT IS NOT DECIDED HERE (waits for the owner): credit and terms (mainRowOf
 * stays undecided, nothing reads them), the A/I status, creating customers or
 * shops, route-code variants (only the Steward's route-map entries), shop codes
 * of CRM-made customers, any threshold (the start shows the counts and asks the
 * Steward to confirm them, with no figure of its own), and when the pilot rule
 * ends (it is asked before the start and before every slice).
 *
 * PURE: no database.
 */
import type { RouteHold, RowPlan } from './temix-daily-check';
import { asciiDigits } from './digits';
import { normalizeTemixCode } from './temix-code';

// ── Timing (the customer import's figures, services/imports.ts) ───────────

/** The lease while a slice runs. Longer than a slice can take (budget + one transaction). */
export const APPLY_LEASE_MS = 90_000;
/** The lease between two slices of one run, so the load reads "in progress", not "interrupted". */
export const APPLY_HANDOFF_GRACE_MS = 20_000;
/** A slice stops taking new customers after this long. */
export const APPLY_SLICE_BUDGET_MS = 15_000;
/** At most this many customers per slice. */
export const APPLY_SLICE_MAX_GROUPS = 100;

/** The customers per slice, from TEMIX_DAILY_SLICE_MAX_GROUPS when set (1 to the cap; for tests and tuning). */
export function sliceMaxGroups(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return APPLY_SLICE_MAX_GROUPS;
  return Math.min(n, APPLY_SLICE_MAX_GROUPS);
}

// ── Holds the apply adds to the Check's ───────────────────────────────────

/** The hold of a move that would set back the previous file's move, without the tick. */
export const REVERSAL_NOT_ACKED = 'REVERSAL_NOT_ACKED';
/** The hold of a customer whose transaction kept failing (not a conflict). */
export const APPLY_FAILED = 'APPLY_FAILED';
/** A customer's transaction is tried this many times (one per slice) before its rows are held APPLY_FAILED. */
export const APPLY_GROUP_MAX_FAILURES = 3;

export const APPLY_HOLD_LABEL: Record<RouteHold | typeof REVERSAL_NOT_ACKED | typeof APPLY_FAILED, string> = {
  ROUTE_MISSING: 'no route in the file; the shop keeps its route',
  ROUTE_NOT_MATCHED: 'the route code is not a CRM route and has no route-map entry; the shop keeps its route',
  ROUTE_AMBIGUOUS: 'two CRM routes have this code once capitals and spaces are set aside; the shop keeps its route',
  ROUTE_SWITCHED_OFF: 'the CRM route it names is switched off; the shop keeps its route',
  REVERSAL_NOT_ACKED: 'the move would set back the previous file’s move and the reversal warning was not ticked',
  APPLY_FAILED: `applying this customer failed ${APPLY_GROUP_MAX_FAILURES} times; nothing of it was written (the next file brings the rows again)`,
};

// ── Which customers a code names ──────────────────────────────────────────

/**
 * A code's digits, Arabic-Indic and Persian ones as ASCII, everything else
 * dropped. normalizeTemixCode changes no digit (it folds those digits to
 * ASCII, removes invisible characters, trims and capitalises), so two codes it
 * makes equal have the same digits. The apply's SQL pre-filter compares these,
 * which is never narrower than the Check's own comparison; the Check's
 * comparison (customerHasCode) then decides (review 2026-11-15, finding 1: an
 * upper(btrim()) filter missed a customer whose stored code carried an Arabic
 * digit or an invisible character, so a DUPLICATE_SUSPECT the preview held
 * became a match in the apply).
 */
export function codeDigits(code: string): string {
  return asciiDigits(code).replace(/[^0-9]/g, '');
}

/** The Arabic-Indic then Persian digits, and the ASCII digit each folds to (codeDigits as SQL translate()). */
export const FOLDED_DIGITS = {
  from:
    Array.from({ length: 10 }, (_, i) => String.fromCharCode(0x0660 + i)).join('') +
    Array.from({ length: 10 }, (_, i) => String.fromCharCode(0x06f0 + i)).join(''),
  to: '01234567890123456789',
} as const;

/** Whether the customer has `custCodeKey` as its NMWC or Temix code, compared exactly as the Check compares them. */
export function customerHasCode(c: { nmwcCode: string; temixCode: string | null }, custCodeKey: string): boolean {
  return normalizeTemixCode(c.nmwcCode) === custCodeKey || (!!c.temixCode && normalizeTemixCode(c.temixCode) === custCodeKey);
}

// ── Reversals ─────────────────────────────────────────────────────────────

/** The last route move the daily file applied to a shop (TemixChange ROUTE_MOVE). */
export type LastMove = { branchId: string; fileId: string; fromRouteId: string; toRouteId: string };

/** The newest move per shop, from ledger rows given newest first. */
export function latestMoveByBranch(newestFirst: ReadonlyArray<{ branchId: string | null; fileId: string; fromValue: string | null; toValue: string | null }>): Map<string, LastMove> {
  const out = new Map<string, LastMove>();
  for (const r of newestFirst) {
    if (!r.branchId || !r.fromValue || !r.toValue || out.has(r.branchId)) continue;
    out.set(r.branchId, { branchId: r.branchId, fileId: r.fileId, fromRouteId: r.fromValue, toRouteId: r.toValue });
  }
  return out;
}

/**
 * A move that puts a shop back where an EARLIER file's last move took it from:
 * the warning "this file sets values back to what the previous file changed
 * them from". A move by the same file is never one (a resumed load).
 */
export function isReversal(move: NonNullable<RowPlan['move']>, last: LastMove | undefined, fileId: string): boolean {
  return !!last && last.fileId !== fileId && last.toRouteId === move.fromRouteId && last.fromRouteId === move.toRouteId;
}

/** The planned moves that are reversals. */
export function reversalsOf(plans: readonly RowPlan[], last: ReadonlyMap<string, LastMove>, fileId: string): RowPlan[] {
  return plans.filter((p) => p.move && isReversal(p.move, last.get(p.move.branchId), fileId));
}

// ── One row ───────────────────────────────────────────────────────────────

export type RowDecision =
  | { outcome: 'HELD'; holds: string[] }
  /** routeHold: the shop was found and keeps its route; the reason is stored with the row. */
  | { outcome: 'NO_CHANGE'; routeHold?: RouteHold }
  | { outcome: 'APPLIED'; move: NonNullable<RowPlan['move']>; via: 'EXACT' | 'MAP'; routeMapEntryId: string | null };

/** What the apply does with one planned row. */
export function decideRow(p: RowPlan, opts: { reversalAcked: boolean; last: LastMove | undefined; fileId: string }): RowDecision {
  if (p.holds.length > 0) return { outcome: 'HELD', holds: [...p.holds] };
  if (p.routeHold) return { outcome: 'NO_CHANGE', routeHold: p.routeHold };
  if (p.move) {
    if (!opts.reversalAcked && isReversal(p.move, opts.last, opts.fileId)) return { outcome: 'HELD', holds: [REVERSAL_NOT_ACKED] };
    return { outcome: 'APPLIED', move: p.move, via: p.move.via, routeMapEntryId: p.route.kind === 'MAP' ? p.route.entryId : null };
  }
  return { outcome: 'NO_CHANGE' };
}

/** The row's stored reasons: its notes from the upload, and the holds (or route reason) of its decision, sorted, once each. */
export function storedReasons(notes: readonly string[], d: RowDecision): string[] {
  const own = d.outcome === 'HELD' ? d.holds : d.outcome === 'NO_CHANGE' && d.routeHold ? [d.routeHold] : [];
  return [...new Set([...notes, ...own])].sort();
}

// ── The start ─────────────────────────────────────────────────────────────

/** The figures the Steward confirms before the start (no threshold: the owner has given none). */
export type ApplyFigures = { moves: number; crossRegion: number; reversals: number; held: number; missing: number };

export function applyFigures(plan: { counts: { moves: { shops: number; crossRegion: number }; held: number; missing: { customers: number } } }, reversals: number): ApplyFigures {
  return {
    moves: plan.counts.moves.shops,
    crossRegion: plan.counts.moves.crossRegion,
    reversals,
    held: plan.counts.held,
    missing: plan.counts.missing.customers,
  };
}

export type StartInput = {
  state: 'STAGED' | 'CHECKED' | 'APPLYING' | 'FINALIZING' | 'LOADED' | 'DISCARDED';
  /** Rows whose payload the 90-day rule emptied. */
  emptiedRows: number;
  pilotWaiting: number;
  waitsFor: { loadDay: string; filename: string } | null;
  overtakenBy: { loadDay: string } | null;
  sameBytes: boolean;
  figures: ApplyFigures;
  /** What the Steward saw and ticked. */
  form: {
    confirmed: boolean;
    reversalTick: boolean;
    sameBytesTick: boolean;
    seen: Pick<ApplyFigures, 'moves' | 'crossRegion' | 'reversals'> | null;
  };
};

/** Why the apply may not start, or null. Each refusal writes nothing. */
export function startRefusal(i: StartInput): string | null {
  if (i.state === 'APPLYING' || i.state === 'FINALIZING') return 'This file is already being applied. Use Resume.';
  if (i.state === 'LOADED') return 'This file is already loaded.';
  if (i.state === 'DISCARDED') return 'This file was discarded. It is never applied.';
  if (i.emptiedRows > 0) return `The contents of ${i.emptiedRows} rows of this file were cleared by the 90-day rule. It cannot be applied: upload a new file.`;
  if (i.pilotWaiting > 0)
    return `The pilot rule: ${i.pilotWaiting} new-customer request${i.pilotWaiting === 1 ? ' waits' : 's wait'} at the Accountant. No Temix file is applied until ${i.pilotWaiting === 1 ? 'it is' : 'they are'} decided.`;
  if (i.overtakenBy) return `This file can never be applied: the file of ${i.overtakenBy.loadDay} is already applied. Discard it.`;
  if (i.waitsFor) return `The file of ${i.waitsFor.loadDay} ("${i.waitsFor.filename}") must be applied or discarded first.`;
  const seen = i.form.seen;
  const f = i.figures;
  if (!seen || seen.moves !== f.moves || seen.crossRegion !== f.crossRegion || seen.reversals !== f.reversals) {
    return `What this file would do has changed since the page was opened (now ${f.moves} moves, ${f.crossRegion} into another region, ${f.reversals} setting back the previous file). Open the page again and check the figures.`;
  }
  if (!i.form.confirmed) return 'Tick that you have checked the figures before applying.';
  if (f.reversals > 0 && !i.form.reversalTick)
    return `${f.reversals} move${f.reversals === 1 ? '' : 's'} would set shops back to the route the previous file moved them from. Tick the warning to apply them.`;
  if (i.sameBytes && !i.form.sameBytesTick) return 'This is exactly the same file as an earlier day’s. Tick the warning to apply it.';
  return null;
}

/** The start's form fields (the page's apply form sends them; the start reads them). */
export const APPLY_FIELDS = {
  fileId: 'fileId',
  confirmed: 'confirmFigures',
  reversalTick: 'confirmReversal',
  sameBytesTick: 'confirmSameBytes',
  moves: 'seenMoves',
  crossRegion: 'seenCrossRegion',
  reversals: 'seenReversals',
  leaseToken: 'leaseToken',
  reason: 'reason',
} as const;

/** The figures the form says the Steward saw, or null when any is missing. */
export function seenFigures(get: (k: string) => string | null): StartInput['form']['seen'] {
  const n = (k: string) => {
    const v = get(k);
    return v !== null && /^\d{1,9}$/.test(v) ? Number(v) : null;
  };
  const moves = n(APPLY_FIELDS.moves);
  const crossRegion = n(APPLY_FIELDS.crossRegion);
  const reversals = n(APPLY_FIELDS.reversals);
  return moves === null || crossRegion === null || reversals === null ? null : { moves, crossRegion, reversals };
}

// ── Discard ───────────────────────────────────────────────────────────────

/** Why a file may not be discarded, or null. Only a file nothing was applied from. */
export function discardRefusal(state: StartInput['state'], reason: string): string | null {
  if (state === 'DISCARDED') return 'This file is already discarded.';
  if (state === 'LOADED') return 'A loaded file is not discarded: its changes are in the CRM. Correct them in Temix; the next file brings them.';
  if (state === 'APPLYING' || state === 'FINALIZING') return 'This file is part-applied. Resume it to the end; a part-applied file is not discarded.';
  if (reason.trim().length < 3) return 'Give a reason for discarding the file.';
  if (reason.trim().length > 500) return 'Keep the reason under 500 characters.';
  return null;
}

// ── The end ───────────────────────────────────────────────────────────────

export type OutcomeCounts = Partial<Record<'PENDING' | 'NO_CHANGE' | 'APPLIED' | 'PARTLY_APPLIED' | 'HELD' | 'REJECTED', number>>;

/** The file's counters once every row is done (PARTLY_APPLIED counts as applied). */
export function finalCounts(c: OutcomeCounts, notices: number) {
  return {
    appliedRows: (c.APPLIED ?? 0) + (c.PARTLY_APPLIED ?? 0),
    noChangeRows: c.NO_CHANGE ?? 0,
    heldRows: c.HELD ?? 0,
    rejectedRows: c.REJECTED ?? 0,
    noticeRows: notices,
  };
}

/**
 * A daily load that needs the Steward: APPLYING or FINALIZING with no lease
 * (released after a stop: the pilot rule, an error) or a lease that has run
 * out (the tab was closed). The Work list asks it with `staleBefore` = now;
 * /status with the hour the customer import is given (PROMOTE_STUCK_AFTER_MIN),
 * so a load paused for a minute between slices is not reported as stuck there.
 */
export function stalledDailyLoadWhere(staleBefore: Date) {
  return {
    state: { in: ['APPLYING', 'FINALIZING'] as Array<'APPLYING' | 'FINALIZING'> },
    OR: [{ applyLeaseUntil: null }, { applyLeaseUntil: { lt: staleBefore } }],
  };
}

/**
 * Review 2026-11-15, finding 3: while the pilot rule holds (a new-customer
 * request waits at the Accountant) every slice of a stalled load stops again,
 * so Resume can do nothing. Such loads are "held by the pilot rule", not
 * stuck: /status does not count them as a breach, and Work items says what
 * they wait for. Once the request is decided they are stuck again (Resume).
 */
export function splitStalledDailyLoads(stalled: number, pilotWaiting: number): { stuck: number; heldByPilot: number } {
  return pilotWaiting > 0 ? { stuck: 0, heldByPilot: stalled } : { stuck: stalled, heldByPilot: 0 };
}

/** The Work item of a stalled daily load. */
export function stalledDailyLoadItem(
  f: { totalRows: number; pendingRows: number },
  pilotWaiting: number
): { category: string; subtitle: string } {
  const done = `${(f.totalRows - f.pendingRows).toLocaleString('en-US')} of ${f.totalRows.toLocaleString('en-US')} rows done`;
  if (pilotWaiting > 0) {
    const one = pilotWaiting === 1;
    return {
      category: 'Temix daily load held by the pilot rule',
      subtitle: `Waits for the Accountant (pilot rule): ${pilotWaiting} new-customer request${one ? ' waits' : 's wait'}. ${done}. Resume once ${one ? 'it is' : 'they are'} decided.`,
    };
  }
  return { category: 'Temix daily load to resume', subtitle: `Load interrupted: ${done}. Open it and Resume.` };
}
