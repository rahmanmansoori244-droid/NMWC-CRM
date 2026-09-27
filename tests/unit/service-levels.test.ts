// @vitest-environment node
/**
 * Item 9: the arithmetic behind the Service status page, by behaviour.
 *
 * Every function takes `now`; no test reads the real clock (CLAUDE.md: a fixture
 * that reads the real clock must never be asserted against a literal).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SLOS,
  AT_RISK_BUDGET_LEFT,
  MIN_PEOPLE_FOR_TIER_DETAIL,
  PARSING_LOOKBACK_HOURS,
  PARSING_STUCK_AFTER_MIN,
  PROMOTE_STUCK_AFTER_MIN,
  TEMIX_BACKLOG_MAX_DAYS,
  approvalsResult,
  availabilityResult,
  backupResult,
  formatAge,
  formatBudget,
  formatPct,
  importsStatus,
  ratioVerdict,
  slaSweepResult,
  slotAttainment,
  slotStarts,
  temixBacklogStatus,
  tiersForViewer,
  windowStart,
  type TierDecisions,
} from '@/lib/service-levels';
import { holdersByStep, percentile, sinceFor } from '@/lib/service-status';
import { stageSnapshot, workingMinutesBetween } from '@/lib/working-hours';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (iso: string) => new Date(iso);

describe('ratio verdicts and the error budget', () => {
  it('no events is "not measured", never "met"', () => {
    expect(ratioVerdict(0, 0, 0.99).status).toBe('no-data');
    expect(ratioVerdict(0, 0, 0.99).ratio).toBeNull();
  });

  it('below the target is missed', () => {
    const v = ratioVerdict(98, 100, 0.99);
    expect(v.status).toBe('breached');
    expect(v.budgetLeft).toBeLessThan(0);
  });

  it('on target with little budget left is at risk; with plenty it is met', () => {
    // target 0.9 on 100 events: 10 bad allowed.
    expect(ratioVerdict(90, 100, 0.9).status).toBe('at-risk'); // 0% left
    expect(ratioVerdict(92, 100, 0.9).status).toBe('at-risk'); // 20% left
    expect(ratioVerdict(97, 100, 0.9).status).toBe('met'); // 70% left
    expect(ratioVerdict(97, 100, 0.9).budgetLeft).toBeCloseTo(0.7);
    expect(AT_RISK_BUDGET_LEFT).toBe(0.25);
  });

  it('while the window is still filling, a miss is judged against the WHOLE window’s allowance', () => {
    // "At most one missed night in 30": one miss in the first 10 days is on budget.
    expect(ratioVerdict(9, 10, 29 / 30, 30).status).toBe('at-risk');
    expect(ratioVerdict(8, 10, 29 / 30, 30).status).toBe('breached');
    // Without the full-window count the same record read "Missed" for weeks.
    expect(ratioVerdict(9, 10, 29 / 30).status).toBe('breached');
  });

  it('exactly the allowance is on budget, one more is not — despite float error', () => {
    // 0.005 × 5400 = 26.999…: 27 bad slots is the allowance.
    expect(ratioVerdict(5400 - 27, 5400, 0.995, 5400).status).toBe('at-risk');
    expect(ratioVerdict(5400 - 28, 5400, 0.995, 5400).status).toBe('breached');
  });
});

describe('windows start at the first measurement, never before', () => {
  const now = at('2026-10-30T10:00:00Z');
  it('clips to the first stored run when the table is younger than the window', () => {
    const first = at('2026-10-20T08:00:00Z');
    expect(windowStart(now, 30, first)).toEqual(first);
  });
  it('uses the full window once the history is long enough', () => {
    expect(windowStart(now, 30, at('2026-01-01T00:00:00Z'))).toEqual(new Date(now.getTime() - 30 * DAY));
  });
  it('nothing stored: no window', () => {
    expect(windowStart(now, 30, null)).toBeNull();
  });
  it('"Measuring since" is shown only while the window is still filling', () => {
    const nominal = new Date(now.getTime() - 30 * DAY);
    expect(sinceFor(at('2026-10-20T08:00:00Z'), nominal)).toEqual(at('2026-10-20T08:00:00Z'));
    expect(sinceFor(at('2026-09-01T00:00:00Z'), nominal)).toBeNull();
    expect(sinceFor(null, nominal)).toBeNull();
  });
});

describe('slots', () => {
  it('keep-warm slots are 4 minutes, on the hour grid, 03:00–14:59 UTC only', () => {
    const slots = slotStarts(at('2026-10-01T02:50:00Z'), at('2026-10-01T03:19:59Z'), 4, [3, 15]);
    expect(slots.map((t) => new Date(t).toISOString().slice(11, 16))).toEqual(['03:00', '03:04', '03:08', '03:12']);
  });

  it('a slot counts once it has ended; the slot in progress is left out', () => {
    // [03:16, 03:20) has ended at 03:20 exactly.
    expect(slotStarts(at('2026-10-01T03:00:00Z'), at('2026-10-01T03:20:00Z'), 4, [3, 15])).toHaveLength(5);
    const slots = slotStarts(at('2026-10-01T03:00:00Z'), at('2026-10-01T03:07:59Z'), 4, [3, 15]);
    expect(slots.map((t) => new Date(t).toISOString().slice(11, 16))).toEqual(['03:00']);
  });

  it('a full day has 180 keep-warm slots and 24 sweep slots', () => {
    const from = at('2026-10-01T00:00:00Z');
    const now = at('2026-10-02T00:00:00Z');
    expect(slotStarts(from, now, 4, [3, 15])).toHaveLength(180);
    const sweep = slotStarts(from, now, 30, [3, 15], 15);
    expect(sweep).toHaveLength(24);
    expect(new Date(sweep[0]!).toISOString().slice(11, 16)).toBe('03:15');
    expect(new Date(sweep.at(-1)!).toISOString().slice(11, 16)).toBe('14:45');
  });
});

describe('slot attainment: an outage looks like silence, and silence counts', () => {
  const slots = slotStarts(at('2026-10-01T03:00:00Z'), at('2026-10-01T03:19:59Z'), 4, [3, 15]);
  // 03:00 03:04 03:08 03:12

  it('a slot is good when any run started in it succeeded; duplicates count once', () => {
    const runs = [
      { at: at('2026-10-01T03:00:05Z'), ok: true },
      { at: at('2026-10-01T03:00:40Z'), ok: true }, // a second scheduler, same slot
      { at: at('2026-10-01T03:04:10Z'), ok: false },
      { at: at('2026-10-01T03:05:00Z'), ok: true }, // retry inside the slot wins it back
      { at: at('2026-10-01T03:08:01Z'), ok: false },
    ];
    const r = slotAttainment(runs, slots, 4, 0.5);
    expect(r.okSlots).toBe(2);
    expect(r.failedSlots).toBe(1);
    expect(r.silentSlots).toBe(1); // 03:12: no run at all
    expect(r.total).toBe(4);
    expect(r.good).toBe(2);
  });

  it('runs outside the window or before the first slot are ignored', () => {
    const r = slotAttainment([{ at: at('2026-10-01T02:59:00Z'), ok: true }], slots, 4, 0.5);
    expect(r.okSlots).toBe(0);
    expect(r.silentSlots).toBe(4);
  });

  const dayWithSilentHours = (hours: number[]) => {
    const from = at('2026-10-01T03:00:00Z');
    const now = at('2026-10-02T00:00:00Z');
    const runs = slotStarts(from, now, 4, [3, 15])
      .filter((t) => !hours.includes(new Date(t).getUTCHours()))
      .map((t) => ({ at: new Date(t + 30_000), ok: true }));
    return availabilityResult(runs, from, now);
  };

  it('one silent hour on the first day spends part of the 30-day budget, not all of it', () => {
    // 15 silent slots of the 27 a full 30-day window allows.
    const r = dayWithSilentHours([9]);
    expect(r.total).toBe(180);
    expect(r.silentSlots).toBe(15);
    expect(r.status).toBe('met');
    expect(r.budgetLeft).toBeCloseTo(1 - 15 / 27);
  });

  it('two silent hours are more than 30 days allow: missed', () => {
    const r = dayWithSilentHours([9, 10]);
    expect(r.silentSlots).toBe(30);
    expect(r.status).toBe('breached');
  });

  it('with nothing stored the SLOs are not measured', () => {
    const now = at('2026-10-02T00:00:00Z');
    expect(availabilityResult([], null, now).status).toBe('no-data');
    expect(slaSweepResult([], null, now).status).toBe('no-data');
    expect(backupResult([], null, now).status).toBe('no-data');
  });

  it('the sweep slot is the half hour starting at :15 or :45', () => {
    const from = at('2026-10-01T03:00:00Z');
    const now = at('2026-10-01T04:30:00Z');
    // slots 03:15, 03:45 (04:15 still in progress)
    const r = slaSweepResult([{ at: at('2026-10-01T03:44:59Z'), ok: true }], from, now);
    expect(r.total).toBe(2);
    expect(r.okSlots).toBe(1); // 03:44:59 belongs to the 03:15 slot
  });
});

describe('backups are judged per UTC day, and today is not judged yet', () => {
  it('counts the days with a successful dump', () => {
    const from = at('2026-10-01T05:00:00Z');
    const now = at('2026-10-04T01:00:00Z'); // days 1, 2, 3 are complete
    const r = backupResult(
      [
        { at: at('2026-10-01T06:10:00Z'), ok: true },
        { at: at('2026-10-02T02:05:00Z'), ok: false },
        { at: at('2026-10-03T12:59:00Z'), ok: true },
      ],
      from,
      now
    );
    expect(r.total).toBe(3);
    expect(r.good).toBe(2);
    expect(r.missedDays).toBe(1);
    // One missed night is what 30 days allow — at risk, not missed.
    expect(r.status).toBe('at-risk');
  });

  it('a second missed night is missed', () => {
    const from = at('2026-10-01T05:00:00Z');
    const now = at('2026-10-05T01:00:00Z');
    const r = backupResult(
      [
        { at: at('2026-10-01T06:10:00Z'), ok: true },
        { at: at('2026-10-04T06:10:00Z'), ok: true },
      ],
      from,
      now
    );
    expect(r.missedDays).toBe(2);
    expect(r.status).toBe('breached');
  });
});

describe('approvals', () => {
  const tier = (role: string, over: Partial<TierDecisions> = {}): TierDecisions => ({
    role, decided: 10, tracked: 10, within: 9, p50Minutes: 60, p90Minutes: 400, people: 5, ...over,
  });

  it('judges only the decisions that carry the snapshot, and says how many do not', () => {
    const r = approvalsResult([
      tier('SUPERVISOR', { decided: 50, tracked: 40, within: 38 }),
      tier('ACCOUNTANT', { decided: 10, tracked: 10, within: 8 }),
    ]);
    expect(r.total).toBe(50);
    expect(r.good).toBe(46);
    expect(r.untracked).toBe(10);
    expect(r.ratio).toBeCloseTo(0.92);
  });

  it('percentile is percentile_cont: linear between ranks', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3); // 2.5 rounds to 3
    expect(percentile([0, 100], 0.9)).toBe(90);
  });

  it('the stage snapshot records entry, due and the working minutes it took', () => {
    // Sunday 2026-10-04 08:00 Oman = 04:00 UTC; decided the same day 10:30 Oman.
    const entered = at('2026-10-04T04:00:00Z');
    const decided = at('2026-10-04T06:30:00Z');
    const due = at('2026-10-04T12:00:00Z');
    const snap = stageSnapshot({ stageEnteredAt: entered, slaDueAt: due, submittedAt: null }, decided);
    expect(snap).toEqual({ stageEnteredAt: entered, slaDueAt: due, workingMinutes: 150 });
    expect(snap.workingMinutes).toBe(workingMinutesBetween(entered, decided));
  });

  it('falls back to the submit time, and records nothing it cannot know', () => {
    const sub = at('2026-10-04T04:00:00Z');
    expect(stageSnapshot({ stageEnteredAt: null, slaDueAt: null, submittedAt: sub }, sub).stageEnteredAt).toEqual(sub);
    expect(stageSnapshot({ stageEnteredAt: null, slaDueAt: null, submittedAt: null }, sub)).toEqual({
      stageEnteredAt: null,
      slaDueAt: null,
      workingMinutes: null,
    });
  });
});

describe('a Manager is never shown one colleague’s decision speed', () => {
  const t = (role: string, people: number): TierDecisions => ({
    role, decided: 5, tracked: 5, within: 4, p50Minutes: 30, p90Minutes: 90, people,
  });
  const fold = (hidden: TierDecisions[]): TierDecisions => t('OTHER', hidden.reduce((n, x) => n + x.people, 0));

  it('the Data Steward sees every tier', () => {
    const tiers = [t('SUPERVISOR', 12), t('GM', 1), t('FINANCE_MANAGER', 1)];
    expect(tiersForViewer(tiers, (x) => x.people, 'STEWARD', fold).map((x) => x.role)).toEqual([
      'SUPERVISOR', 'GM', 'FINANCE_MANAGER',
    ]);
  });

  it('a Manager: single-holder tiers are left out when even together they are too few people', () => {
    const tiers = [t('SUPERVISOR', 12), t('GM', 1), t('FINANCE_MANAGER', 1)];
    expect(tiersForViewer(tiers, (x) => x.people, 'MANAGER', fold).map((x) => x.role)).toEqual(['SUPERVISOR']);
  });

  it('a Manager: small tiers are shown folded together once enough people stand behind them', () => {
    const tiers = [t('SUPERVISOR', 12), t('GM', 1), t('ACCOUNTANT', 2)];
    expect(tiersForViewer(tiers, (x) => x.people, 'MANAGER', fold).map((x) => x.role)).toEqual(['SUPERVISOR', 'OTHER']);
    expect(MIN_PEOPLE_FOR_TIER_DETAIL).toBe(3);
  });

  it('a Supervisor step is held by the Supervisors and the Managers (the region fallback)', () => {
    const holders = holdersByStep(new Map([['SUPERVISOR', 0], ['MANAGER', 11], ['GM', 1]]));
    expect(holders('SUPERVISOR')).toBe(11);
    expect(holders('GM')).toBe(1);
    expect(holders('FINANCE_MANAGER')).toBe(0);
  });
});

describe('current-state objectives', () => {
  const now = at('2026-10-10T08:00:00Z');
  it('the ERP hand-off is missed once anything has waited more than 7 days', () => {
    expect(temixBacklogStatus(null, now)).toBe('met');
    expect(temixBacklogStatus(new Date(now.getTime() - 6 * DAY), now)).toBe('met');
    expect(temixBacklogStatus(new Date(now.getTime() - 8 * DAY), now)).toBe('breached');
  });
  it('any stuck import misses', () => {
    expect(importsStatus(0, 0)).toBe('met');
    expect(importsStatus(1, 0)).toBe('breached');
    expect(importsStatus(0, 2)).toBe('breached');
  });
  it('ages read as people read them', () => {
    expect(formatAge(45 * MIN)).toBe('45 m');
    expect(formatAge(200 * MIN)).toBe('3 h 20 m');
    expect(formatAge(52 * 60 * MIN)).toBe('2 d 4 h');
  });
});

describe('figures never read better than they are', () => {
  it('a share is truncated, so a miss never prints as the target', () => {
    expect(formatPct(0.994987, 2)).toBe('99.49%');
    expect(formatPct(0.89952)).toBe('89.9%');
    expect(formatPct(0.995, 2)).toBe('99.50%'); // an exact hit is not floored below itself
    expect(formatPct(1)).toBe('100.0%');
    expect(formatPct(null)).toBe('—');
  });
  it('the budget line follows the sign: a sliver over budget is "spent", not "0% left"', () => {
    expect(formatBudget(-0.003)).toBe('Error budget spent');
    expect(formatBudget(-Infinity)).toBe('Error budget spent');
    expect(formatBudget(0)).toBe('0% of the error budget left');
    expect(formatBudget(0.449)).toBe('44% of the error budget left');
    expect(formatBudget(null)).toBeNull();
  });
});

describe('the written targets and the measured ones cannot drift', () => {
  const doc = readFileSync('docs/SERVICE-LEVELS.md', 'utf8');

  it.each(SLOS.map((s) => [s.id, s] as const))('%s is in docs/SERVICE-LEVELS.md with its target', (_id, s) => {
    expect(doc).toContain(s.title);
    expect(doc).toContain(s.targetLabel);
  });

  it('the numbers the verdicts use are these, and the labels say them', () => {
    // Changing a target is a deliberate edit here, in the doc and in the label.
    const byId = Object.fromEntries(SLOS.map((s) => [s.id, s]));
    expect(byId.availability!.target).toBe(0.995);
    expect(byId.approvals!.target).toBe(0.9);
    expect(byId['sla-sweep']!.target).toBe(0.95);
    expect(byId.backup!.target).toBe(29 / 30);
    for (const s of SLOS.filter((x) => x.kind === 'ratio')) {
      expect(s.windowDays, s.id).toBe(30);
      if (s.id === 'backup') {
        expect(s.targetLabel).toContain('29 of every 30');
      } else {
        expect(s.targetLabel, s.id).toContain(`${+(s.target! * 100).toFixed(1)}%`);
        expect(s.targetLabel, s.id).toContain(`${s.windowDays} days`);
      }
    }
  });

  it('the thresholds of the current-state objectives are the ones the doc states', () => {
    expect(TEMIX_BACKLOG_MAX_DAYS).toBe(7);
    expect(doc).toContain(`over ${TEMIX_BACKLOG_MAX_DAYS} days`);
    expect(PROMOTE_STUCK_AFTER_MIN).toBe(60);
    expect(doc).toContain('more than an hour');
    expect(PARSING_STUCK_AFTER_MIN).toBe(10);
    expect(doc).toContain(`after ${PARSING_STUCK_AFTER_MIN} minutes`);
    expect(PARSING_LOOKBACK_HOURS).toBe(24);
    expect(doc).toContain('in the last day');
  });

  it('the availability allowance in the doc is the one the arithmetic uses', () => {
    // 180 slots a day × 30 days × 0.5% = 27 slots of 4 minutes = 108 minutes.
    const slots = Math.round(180 * 30 * (1 - 0.995));
    expect(slots).toBe(27);
    expect(doc).toContain(`${slots} four-minute slots`);
    expect(doc).toContain(`${slots * 4} minutes`);
  });
});

describe('the schedules the objectives assume are the ones that run', () => {
  // Availability counts 4-minute slots 03:00–14:59 UTC and the sweep objective
  // half-hours at :15/:45; if vercel.json drifts, the page would report
  // "missed" slots that were never scheduled.
  it('vercel.json runs keep-warm and the sweep on exactly those grids, as the backup scheduler does', async () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };
    const byPath = new Map(vercel.crons.map((c) => [c.path, c.schedule]));
    expect(byPath.get('/api/cron/keep-warm')).toBe('*/4 3-14 * * *');
    expect(byPath.get('/api/cron/sla-escalate')).toBe('15,45 3-14 * * *');
    const { CRON_JOBS } = await import('@/scripts/ops/cron-scheduler');
    for (const j of CRON_JOBS) expect(byPath.get(j.path), j.key).toBe(j.cron);
  });
});
