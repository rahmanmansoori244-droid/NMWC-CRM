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
  approvalsForManager,
  queuesForManager,
  MANAGER_VIEW_GROUPS,
  STEP_ROLES,
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
    // (1 - 0.995) × 5400 is 27.000…025; 27 bad slots is the allowance.
    expect(ratioVerdict(5400 - 27, 5400, 0.995, 5400).status).toBe('at-risk');
    expect(ratioVerdict(5400 - 28, 5400, 0.995, 5400).status).toBe('breached');
  });

  it('exactly 90% is at risk with 0% left — not "Error budget spent"', () => {
    // (1 - 0.9) × 40 is 3.999…: the budget line used to read "spent" here.
    for (const [good, total] of [[9, 10], [36, 40], [90, 100], [450, 500]]) {
      const v = ratioVerdict(good!, total!, 0.9);
      expect(v.status, `${good}/${total}`).toBe('at-risk');
      expect(v.budgetLeft, `${good}/${total}`).toBe(0);
      expect(formatBudget(v.budgetLeft)).toBe('0% of the error budget left');
    }
    // One night missed of 30 is exactly the backup budget, too.
    expect(ratioVerdict(29, 30, 29 / 30, 30).budgetLeft).toBe(0);
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
    role, decided: 10, tracked: 10, within: 9, p50Minutes: 60, p90Minutes: 400, people: ['a', 'b', 'c', 'd', 'e'], ...over,
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
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const t = (role: string, people: string[], within = 4, tracked = 5): TierDecisions => ({
    role, decided: tracked, tracked, within, p50Minutes: 30, p90Minutes: 90, people,
  });
  // The production shape: 11 Managers decide the Supervisor step, 7 accountants
  // their step, one person each holds the Finance Manager and GM steps.
  const prod = () => [
    t('SUPERVISOR', ids('m', 11), 38, 40),
    t('FINANCE_MANAGER', ['fm'], 2, 6),
    t('GM', ['gm'], 3, 5),
    t('ACCOUNTANT', ids('acc', 7), 30, 35),
  ];
  const shownKeys = (tiers: TierDecisions[]) => approvalsForManager(tiers).groups.filter((g) => g.shown).map((g) => g.group.key);

  it('the groups are fixed, and each step belongs to exactly one', () => {
    expect(MANAGER_VIEW_GROUPS.map((g) => g.key)).toEqual(['SUPERVISOR', 'CREDIT', 'MANAGER']);
    const roles = MANAGER_VIEW_GROUPS.flatMap((g) => g.roles);
    expect(new Set(roles).size).toBe(roles.length);
    expect([...roles].sort()).toEqual(['ACCOUNTANT', 'FINANCE_MANAGER', 'GM', 'MANAGER', 'SUPERVISOR']);
    expect(STEP_ROLES).toEqual(roles);
    expect(MIN_PEOPLE_FOR_TIER_DETAIL).toBe(3);
  });

  it('the Finance Manager and GM are always counted with the accountants, never alone', () => {
    const view = approvalsForManager(prod());
    const credit = view.groups.find((g) => g.group.key === 'CREDIT')!;
    expect(credit.shown).toBe(true);
    expect(credit.decisions.tracked).toBe(6 + 5 + 35);
    expect(credit.decisions.within).toBe(2 + 3 + 30);
    expect(credit.decisions.people).toHaveLength(9);
    // A median of three steps' medians is nobody's figure.
    expect(credit.decisions.p50Minutes).toBeNull();
    expect(view.headlineShown).toBe(true);
  });

  it('which groups are shown does not depend on the order the rows arrive in', () => {
    const tiers = prod();
    const reversed = [...tiers].reverse();
    expect(shownKeys(reversed)).toEqual(shownKeys(tiers));
    expect(approvalsForManager(reversed).groups.map((g) => g.decisions.tracked)).toEqual(
      approvalsForManager(tiers).groups.map((g) => g.decisions.tracked)
    );
  });

  it('it does not depend on which steps had decisions either: a new GM decision changes no group boundary', () => {
    const before = [t('SUPERVISOR', ids('m', 11)), t('ACCOUNTANT', ids('acc', 7))];
    const after = [...before, t('GM', ['gm'], 0, 1)];
    expect(shownKeys(after)).toEqual(shownKeys(before));
    expect(approvalsForManager(after).groups.map((g) => g.group.key)).toEqual(['SUPERVISOR', 'CREDIT', 'MANAGER']);
  });

  it('whatever can be subtracted from the company-wide figure stands for at least 3 people', () => {
    const cases = [
      prod(),
      [t('SUPERVISOR', ids('m', 11)), t('FINANCE_MANAGER', ['fm'])],
      [t('SUPERVISOR', ids('m', 11)), t('GM', ['gm']), t('MANAGER', ['m1', 'm2'])],
      [t('SUPERVISOR', ids('m', 5)), t('ACCOUNTANT', ['a1', 'a2']), t('GM', ['gm'])],
      [t('GM', ['gm'], 1, 2)],
      [t('SUPERVISOR', ['m1', 'm2']), t('MANAGER', ['m1'])],
    ];
    for (const tiers of cases) {
      const view = approvalsForManager(tiers);
      for (const g of view.groups.filter((x) => x.shown)) expect(g.decisions.people.length).toBeGreaterThanOrEqual(3);
      if (!view.headlineShown) continue;
      // company-wide minus every shown group = the groups not shown, together
      const hidden = view.groups.filter((x) => !x.shown && x.decisions.tracked > 0);
      if (hidden.length === 0) continue;
      expect(new Set(hidden.flatMap((x) => x.decisions.people)).size).toBeGreaterThanOrEqual(3);
    }
  });

  it('the company-wide figure itself is withheld when fewer than 3 people stand behind it', () => {
    // The first tracked decisions after the deploy can all be one person's.
    expect(approvalsForManager([t('GM', ['gm'], 1, 2)]).headlineShown).toBe(false);
    // One Manager on two steps is one person: 2 people, not 3.
    expect(approvalsForManager([t('SUPERVISOR', ['m1', 'm2']), t('MANAGER', ['m1'])]).headlineShown).toBe(false);
  });

  it('and when a hidden group could be recovered from it by subtraction', () => {
    // Supervisor step shown (5 people), credit steps hidden (GM alone): the
    // company-wide figure minus the Supervisor line would be the GM's record.
    const view = approvalsForManager([t('SUPERVISOR', ids('m', 5)), t('GM', ['gm'], 1, 2)]);
    expect(view.groups.find((g) => g.group.key === 'SUPERVISOR')!.shown).toBe(true);
    expect(view.groups.find((g) => g.group.key === 'CREDIT')!.shown).toBe(false);
    expect(view.headlineShown).toBe(false);
  });

  it('the waiting queues: three cards every time, figures only where 3+ people can decide', () => {
    const q = (role: string, holders: string[], open = 0) => ({ role, open, pastDue: 0, oldestWorkingMinutes: null, holders });
    const cards = queuesForManager([
      q('SUPERVISOR', ids('m', 11), 4),
      q('ACCOUNTANT', ids('acc', 7)),
      q('FINANCE_MANAGER', ['fm'], 1),
      q('GM', ['gm']),
      q('MANAGER', ids('m', 11)),
    ]);
    expect(cards.map((c) => c.group.key)).toEqual(['SUPERVISOR', 'CREDIT', 'MANAGER']);
    expect(cards.every((c) => c.shown)).toBe(true);
    expect(cards.find((c) => c.group.key === 'CREDIT')!.queue.open).toBe(1);
    // With no accountant (a pilot), the credit group stands for 2 people — the
    // Finance Manager and the GM — and is withheld, however many cards there are.
    const small = queuesForManager([q('FINANCE_MANAGER', ['fm'], 1), q('GM', ['gm'])]);
    expect(small.find((c) => c.group.key === 'CREDIT')!.shown).toBe(false);
    expect(small).toHaveLength(3);
  });

  it('a Supervisor step is held by the Supervisors and the Managers (the region fallback)', () => {
    const users = [...ids('m', 11).map((id) => ({ id, role: 'MANAGER' })), { id: 'gm', role: 'GM' }];
    const holders = holdersByStep(users);
    expect(holders('SUPERVISOR')).toHaveLength(11);
    expect(holders('GM')).toEqual(['gm']);
    expect(holders('FINANCE_MANAGER')).toEqual([]);
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
