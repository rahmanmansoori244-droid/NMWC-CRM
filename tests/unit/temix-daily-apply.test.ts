/**
 * The daily Temix import, stage 5: the apply's rules (lib/temix-daily-apply.ts),
 * on the synthetic file of tests/support/temix-daily-check-fixture.ts planned
 * by the real Check. What each row becomes, the reversal rule, the start's
 * refusals (state, the 90-day rule, the pilot rule, the order rule, the
 * figures seen, the ticks), Discard's, the end's counts and the stalled-load
 * query /work and /status share. No figure here is a threshold: the owner has
 * given none.
 */
import { describe, expect, it } from 'vitest';
import { checkDailyFile, type RowPlan } from '@/lib/temix-daily-check';
import {
  APPLY_FAILED,
  APPLY_FIELDS,
  APPLY_GROUP_MAX_FAILURES,
  APPLY_HOLD_LABEL,
  APPLY_SLICE_MAX_GROUPS,
  FOLDED_DIGITS,
  REVERSAL_NOT_ACKED,
  applyFigures,
  codeDigits,
  customerHasCode,
  decideRow,
  discardRefusal,
  finalCounts,
  isReversal,
  latestMoveByBranch,
  reversalsOf,
  seenFigures,
  sliceMaxGroups,
  splitStalledDailyLoads,
  stalledDailyLoadItem,
  stalledDailyLoadWhere,
  startRefusal,
  storedReasons,
  type StartInput,
} from '@/lib/temix-daily-apply';
import { checkInput } from '../support/temix-daily-check-fixture';
import { normalizeTemixCode } from '@/lib/temix-code';

const plan = checkDailyFile(checkInput());
const row = new Map<number, RowPlan>(plan.rows.map((p) => [p.rowNumber, p]));
const decide = (n: number, o: Partial<Parameters<typeof decideRow>[1]> = {}) =>
  decideRow(row.get(n)!, { reversalAcked: false, last: undefined, fileId: 'f1', ...o });

describe('what each row of the synthetic file becomes', () => {
  it('a move by exact code is APPLIED, a shop already on its route is NO_CHANGE', () => {
    expect(decide(3)).toEqual({
      outcome: 'APPLIED',
      move: { branchId: 'bA2', fromRouteId: 'rt-c11', toRouteId: 'rt-c10', fromRegionId: 'rg-1', toRegionId: 'rg-1', via: 'EXACT' },
      via: 'EXACT',
      routeMapEntryId: null,
    });
    expect(decide(7)).toMatchObject({ outcome: 'APPLIED', move: { branchId: 'bB1', toRouteId: 'rt-d20', fromRegionId: 'rg-1', toRegionId: 'rg-2' } });
    expect(decide(2)).toEqual({ outcome: 'NO_CHANGE' });
  });

  it('a route not matched, switched off or missing changes nothing, with its reason; the shop keeps its route', () => {
    // Review 2026-11-15, finding 2: the Check counts these under "no change"
    // (the plan: not a hold of the whole row), so the apply stores them so.
    expect(decide(14)).toEqual({ outcome: 'NO_CHANGE', routeHold: 'ROUTE_NOT_MATCHED' });
    expect(decide(15)).toEqual({ outcome: 'NO_CHANGE', routeHold: 'ROUTE_SWITCHED_OFF' });
    expect(decide(16)).toEqual({ outcome: 'NO_CHANGE', routeHold: 'ROUTE_MISSING' });
    expect(storedReasons([], decide(14))).toEqual(['ROUTE_NOT_MATCHED']);
    expect(storedReasons(['CODE_LOWERCASE'], decide(15))).toEqual(['CODE_LOWERCASE', 'ROUTE_SWITCHED_OFF']);
  });

  it('a row the Check holds stays held, for the Check\'s reasons', () => {
    expect(decide(4)).toEqual({ outcome: 'HELD', holds: ['SHOP_ARCHIVED'] });
    expect(decide(9)).toEqual({ outcome: 'HELD', holds: ['SHOP_NOT_LINKED'] });
    expect(decide(12)).toEqual({ outcome: 'HELD', holds: ['CUSTOMER_UNKNOWN'] });
    expect(decide(8)).toEqual({ outcome: 'HELD', holds: ['BRANCH_CODE_BLANK'] });
  });

  it('every row of the file becomes what the Check counted: the held figure confirmed is the HELD count', () => {
    const outcomes = plan.rows.map((p) => decideRow(p, { reversalAcked: false, last: undefined, fileId: 'f1' }).outcome);
    const count = (o: string) => outcomes.filter((x) => x === o).length;
    expect([count('APPLIED'), count('NO_CHANGE'), count('HELD')]).toEqual([2, 4, 13]);
    expect(plan.counts).toMatchObject({ wouldMove: 2, noChange: 4, held: 13 });
    // The Steward ticks "N rows are held" from applyFigures; the load ends with as many HELD.
    expect(applyFigures(plan, 0).held).toBe(count('HELD'));
    expect(finalCounts({ APPLIED: count('APPLIED'), NO_CHANGE: count('NO_CHANGE'), HELD: count('HELD') }, 0)).toMatchObject({
      heldRows: applyFigures(plan, 0).held,
      noChangeRows: plan.counts.noChange,
    });
  });

  it('a move through a route-map entry names the entry', () => {
    const viaMap = checkDailyFile(checkInput([{ id: '9', temixRouteCode: 'C10MA', routeId: 'rt-c10' }]));
    const p = viaMap.rows.find((x) => x.rowNumber === 14)!;
    expect(decideRow(p, { reversalAcked: false, last: undefined, fileId: 'f1' })).toMatchObject({ outcome: 'APPLIED', via: 'MAP', routeMapEntryId: '9' });
  });

  it('stored reasons: the upload notes kept, the holds added, sorted, once each', () => {
    expect(storedReasons(['CODE_LOWERCASE'], { outcome: 'HELD', holds: ['SHOP_ARCHIVED'] })).toEqual(['CODE_LOWERCASE', 'SHOP_ARCHIVED']);
    expect(storedReasons(['DUPLICATE_ROW'], { outcome: 'HELD', holds: ['DUPLICATE_ROW'] })).toEqual(['DUPLICATE_ROW']);
    expect(storedReasons(['CODE_LOWERCASE'], { outcome: 'NO_CHANGE' })).toEqual(['CODE_LOWERCASE']);
    for (const h of Object.keys(APPLY_HOLD_LABEL)) expect(h).toMatch(/^[A-Z][A-Z0-9_]{0,59}$/); // TemixDailyRow_hold_reasons_check
    expect(APPLY_HOLD_LABEL[APPLY_FAILED]).toMatch(new RegExp(`failed ${APPLY_GROUP_MAX_FAILURES} times; nothing of it was written`));
  });
});

describe('which customers a code names (review 2026-11-15, finding 1)', () => {
  const ZWSP = String.fromCharCode(0x200b);
  const ARABIC_ONE = String.fromCharCode(0x0661);
  const PERSIAN_ONE = String.fromCharCode(0x06f1);
  const ARABIC_367 = String.fromCharCode(0x0663, 0x0666, 0x0667);

  it('compares as the Check does: Arabic and Persian digits, invisible characters, ends and capitals folded', () => {
    expect(customerHasCode({ nmwcCode: `CA${ARABIC_ONE}`, temixCode: null }, 'CA1')).toBe(true);
    expect(customerHasCode({ nmwcCode: `CA1${ZWSP}`, temixCode: null }, 'CA1')).toBe(true);
    expect(customerHasCode({ nmwcCode: 'NMWC-2026-000009', temixCode: ` ca${PERSIAN_ONE} ` }, 'CA1')).toBe(true);
    expect(customerHasCode({ nmwcCode: 'CA10', temixCode: 'CA01' }, 'CA1')).toBe(false);
    expect(customerHasCode({ nmwcCode: 'CB1', temixCode: null }, 'CA1')).toBe(false);
  });

  it('the SQL pre-filter (the digits) is never narrower than that comparison', () => {
    const codes = ['CA1', `CA${ARABIC_ONE}`, `ca1${ZWSP}`, ` CA${PERSIAN_ONE}\t`, `C${ZWSP}A1`, 'CAA0367', `CAA0${ARABIC_367}`, 'ABC', `a${ZWSP}bc`];
    let pairs = 0;
    for (const a of codes)
      for (const b of codes)
        if (a !== b && normalizeTemixCode(a) === normalizeTemixCode(b)) {
          pairs++;
          expect(codeDigits(a), `${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(codeDigits(b));
        }
    expect(pairs).toBeGreaterThan(10);
    expect(codeDigits(`CA${ARABIC_ONE}`)).toBe('1');
    expect(codeDigits('NMWC-2026-000009')).toBe('2026000009');
    expect(codeDigits('ABC')).toBe('');
  });

  it('the digits SQL folds are the ones codeDigits folds, in order', () => {
    expect(FOLDED_DIGITS.from).toHaveLength(20);
    expect(FOLDED_DIGITS.to).toHaveLength(20);
    for (let i = 0; i < 20; i++) expect(codeDigits(FOLDED_DIGITS.from[i]!)).toBe(FOLDED_DIGITS.to[i]);
  });
});

describe('the reversal warning', () => {
  const move = row.get(3)!.move!; // bA2: C11 -> C10
  const earlier = { branchId: 'bA2', fileId: 'f0', fromRouteId: 'rt-c10', toRouteId: 'rt-c11' };

  it('a move putting a shop back where an earlier file moved it from is a reversal', () => {
    expect(isReversal(move, earlier, 'f1')).toBe(true);
    expect(isReversal(move, undefined, 'f1')).toBe(false);
    // Moved by this same file (a resumed load): not a reversal.
    expect(isReversal(move, { ...earlier, fileId: 'f1' }, 'f1')).toBe(false);
    // The earlier move went elsewhere: not one.
    expect(isReversal(move, { ...earlier, fromRouteId: 'rt-d20' }, 'f1')).toBe(false);
    expect(reversalsOf(plan.rows, new Map([['bA2', earlier]]), 'f1').map((p) => p.rowNumber)).toEqual([3]);
  });

  it('unticked, the move is held REVERSAL_NOT_ACKED; ticked, it is applied', () => {
    expect(decide(3, { last: earlier })).toEqual({ outcome: 'HELD', holds: [REVERSAL_NOT_ACKED] });
    expect(decide(3, { last: earlier, reversalAcked: true })).toMatchObject({ outcome: 'APPLIED' });
  });

  it('the newest ledger move per shop wins', () => {
    const m = latestMoveByBranch([
      { branchId: 'b1', fileId: 'f3', fromValue: 'r2', toValue: 'r3' },
      { branchId: 'b1', fileId: 'f2', fromValue: 'r1', toValue: 'r2' },
      { branchId: null, fileId: 'f2', fromValue: 'r1', toValue: 'r2' },
    ]);
    expect([...m.values()]).toEqual([{ branchId: 'b1', fileId: 'f3', fromRouteId: 'r2', toRouteId: 'r3' }]);
  });
});

describe('the start', () => {
  const figures = applyFigures(plan, 0);
  const ok: StartInput = {
    state: 'STAGED',
    emptiedRows: 0,
    pilotWaiting: 0,
    waitsFor: null,
    overtakenBy: null,
    sameBytes: false,
    figures,
    form: { confirmed: true, reversalTick: false, sameBytesTick: false, seen: { moves: 2, crossRegion: 1, reversals: 0 } },
  };

  it('the figures: moves, into another region, reversals, held, missing (counts only)', () => {
    expect(figures).toEqual({ moves: 2, crossRegion: 1, reversals: 0, held: 13, missing: 3 });
  });

  it('starts when everything holds', () => {
    expect(startRefusal(ok)).toBeNull();
    expect(startRefusal({ ...ok, state: 'CHECKED' })).toBeNull();
  });

  it('refuses a file already applying, loaded or discarded', () => {
    expect(startRefusal({ ...ok, state: 'APPLYING' })).toMatch(/already being applied\. Use Resume/);
    expect(startRefusal({ ...ok, state: 'FINALIZING' })).toMatch(/Use Resume/);
    expect(startRefusal({ ...ok, state: 'LOADED' })).toMatch(/already loaded/);
    expect(startRefusal({ ...ok, state: 'DISCARDED' })).toMatch(/discarded/);
  });

  it('refuses rows emptied by the 90-day rule, the pilot rule, and the order rule', () => {
    expect(startRefusal({ ...ok, emptiedRows: 3 })).toMatch(/3 rows of this file were cleared by the 90-day rule/);
    expect(startRefusal({ ...ok, pilotWaiting: 1 })).toMatch(/The pilot rule: 1 new-customer request waits at the Accountant/);
    expect(startRefusal({ ...ok, pilotWaiting: 2 })).toMatch(/2 new-customer requests wait/);
    expect(startRefusal({ ...ok, waitsFor: { loadDay: '2026-11-12', filename: 'mon.xlsx' } })).toMatch(/2026-11-12 \("mon\.xlsx"\) must be applied or discarded first/);
    expect(startRefusal({ ...ok, overtakenBy: { loadDay: '2026-11-13' } })).toMatch(/can never be applied: the file of 2026-11-13 is already applied/);
  });

  it('refuses when the figures changed since the page, or were not confirmed', () => {
    expect(startRefusal({ ...ok, form: { ...ok.form, seen: null } })).toMatch(/has changed since the page was opened/);
    expect(startRefusal({ ...ok, form: { ...ok.form, seen: { moves: 1, crossRegion: 1, reversals: 0 } } })).toMatch(/now 2 moves, 1 into another region, 0 setting back/);
    expect(startRefusal({ ...ok, form: { ...ok.form, confirmed: false } })).toMatch(/Tick that you have checked the figures/);
  });

  it('asks for the reversal tick when a move sets back an earlier file, and for the same-bytes tick', () => {
    const rev = { ...ok, figures: { ...figures, reversals: 1 }, form: { ...ok.form, seen: { moves: 2, crossRegion: 1, reversals: 1 } } };
    expect(startRefusal(rev)).toMatch(/1 move would set shops back.*Tick the warning/);
    expect(startRefusal({ ...rev, form: { ...rev.form, reversalTick: true } })).toBeNull();
    expect(startRefusal({ ...ok, sameBytes: true })).toMatch(/exactly the same file as an earlier day/);
    expect(startRefusal({ ...ok, sameBytes: true, form: { ...ok.form, sameBytesTick: true } })).toBeNull();
  });

  it('reads the figures the form says were seen; anything else is "not seen"', () => {
    const form = (o: Record<string, string>) => (k: string) => o[k] ?? null;
    expect(seenFigures(form({ [APPLY_FIELDS.moves]: '2', [APPLY_FIELDS.crossRegion]: '1', [APPLY_FIELDS.reversals]: '0' }))).toEqual({ moves: 2, crossRegion: 1, reversals: 0 });
    expect(seenFigures(form({ [APPLY_FIELDS.moves]: '2', [APPLY_FIELDS.crossRegion]: '1' }))).toBeNull();
    expect(seenFigures(form({ [APPLY_FIELDS.moves]: '-1', [APPLY_FIELDS.crossRegion]: '1', [APPLY_FIELDS.reversals]: '0' }))).toBeNull();
  });
});

describe('discard, the end, the slices and the stalled load', () => {
  it('discards only a file nothing was applied from, with a reason', () => {
    expect(discardRefusal('STAGED', 'Wrong file, uploaded by mistake')).toBeNull();
    expect(discardRefusal('CHECKED', 'Old export')).toBeNull();
    expect(discardRefusal('STAGED', ' ')).toMatch(/Give a reason/);
    expect(discardRefusal('APPLYING', 'x y z')).toMatch(/part-applied\. Resume it/);
    expect(discardRefusal('FINALIZING', 'x y z')).toMatch(/part-applied/);
    expect(discardRefusal('LOADED', 'x y z')).toMatch(/Correct them in Temix/);
    expect(discardRefusal('DISCARDED', 'x y z')).toMatch(/already discarded/);
  });

  it('the end\'s counters', () => {
    expect(finalCounts({ APPLIED: 2, NO_CHANGE: 5, HELD: 3 }, 0)).toEqual({ appliedRows: 2, noChangeRows: 5, heldRows: 3, rejectedRows: 0, noticeRows: 0 });
    expect(finalCounts({ PARTLY_APPLIED: 1, REJECTED: 1 }, 4)).toMatchObject({ appliedRows: 1, rejectedRows: 1, noticeRows: 4 });
  });

  it('customers per slice: the cap unless a smaller whole number is set', () => {
    expect(sliceMaxGroups(undefined)).toBe(APPLY_SLICE_MAX_GROUPS);
    expect(sliceMaxGroups('1')).toBe(1);
    expect(sliceMaxGroups('100000')).toBe(APPLY_SLICE_MAX_GROUPS);
    expect(sliceMaxGroups('0')).toBe(APPLY_SLICE_MAX_GROUPS);
    expect(sliceMaxGroups('2.5')).toBe(APPLY_SLICE_MAX_GROUPS);
  });

  it('while the pilot rule holds, a stalled load is held by it, not stuck (review 2026-11-15, finding 3)', () => {
    expect(splitStalledDailyLoads(2, 0)).toEqual({ stuck: 2, heldByPilot: 0 });
    expect(splitStalledDailyLoads(2, 1)).toEqual({ stuck: 0, heldByPilot: 2 });
    expect(splitStalledDailyLoads(0, 3)).toEqual({ stuck: 0, heldByPilot: 0 });
    expect(stalledDailyLoadItem({ totalRows: 1200, pendingRows: 200 }, 0)).toEqual({
      category: 'Temix daily load to resume',
      subtitle: 'Load interrupted: 1,000 of 1,200 rows done. Open it and Resume.',
    });
    const held = stalledDailyLoadItem({ totalRows: 10, pendingRows: 4 }, 1);
    expect(held.category).toBe('Temix daily load held by the pilot rule');
    expect(held.subtitle).toBe('Waits for the Accountant (pilot rule): 1 new-customer request waits. 6 of 10 rows done. Resume once it is decided.');
    expect(held.subtitle).not.toMatch(/interrupted/);
    expect(stalledDailyLoadItem({ totalRows: 10, pendingRows: 4 }, 2).subtitle).toMatch(/2 new-customer requests wait\. .* once they are decided/);
  });

  it('a stalled load: applying or finishing with no lease or one older than the given time', () => {
    const at = new Date('2026-11-14T10:00:00Z');
    expect(stalledDailyLoadWhere(at)).toEqual({
      state: { in: ['APPLYING', 'FINALIZING'] },
      OR: [{ applyLeaseUntil: null }, { applyLeaseUntil: { lt: at } }],
    });
  });
});
