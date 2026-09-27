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
  approvalsResult,
  availabilityResult,
  backupResult,
  formatAge,
  importsStatus,
  ratioVerdict,
  slaSweepResult,
  slotAttainment,
  slotStarts,
  temixBacklogStatus,
  windowStart,
} from '@/lib/service-levels';
import { percentile } from '@/lib/service-status';
import { stageSnapshot, workingMinutesBetween } from '@/lib/working-hours';

const MIN = 60_000;
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
});

describe('windows start at the first measurement, never before', () => {
  const now = at('2026-10-30T10:00:00Z');
  it('clips to the first stored run when the table is younger than the window', () => {
    const first = at('2026-10-20T08:00:00Z');
    expect(windowStart(now, 30, first)).toEqual(first);
  });
  it('uses the full window once the history is long enough', () => {
    expect(windowStart(now, 30, at('2026-01-01T00:00:00Z'))).toEqual(new Date(now.getTime() - 30 * 24 * 60 * MIN));
  });
  it('nothing stored: no window', () => {
    expect(windowStart(now, 30, null)).toBeNull();
  });
});

describe('slots', () => {
  it('keep-warm slots are 4 minutes, on the hour grid, 03:00–14:59 UTC only', () => {
    const slots = slotStarts(at('2026-10-01T02:50:00Z'), at('2026-10-01T03:19:59Z'), 4, [3, 15]);
    expect(slots.map((t) => new Date(t).toISOString().slice(11, 16))).toEqual([
      '03:00', '03:04', '03:08', '03:12',
    ]);
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

  it('availability over a day with one silent hour misses 99.5%', () => {
    const from = at('2026-10-01T03:00:00Z');
    const now = at('2026-10-02T00:00:00Z');
    const runs = slotStarts(from, now, 4, [3, 15])
      .filter((t) => new Date(t).getUTCHours() !== 9) // 09:00–09:59 UTC: nothing
      .map((t) => ({ at: new Date(t + 30_000), ok: true }));
    const r = availabilityResult(runs, from, now);
    expect(r.total).toBe(180);
    expect(r.silentSlots).toBe(15);
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
  });
});

describe('approvals', () => {
  it('judges only the decisions that carry the snapshot, and says how many do not', () => {
    const r = approvalsResult([
      { role: 'SUPERVISOR', decided: 50, tracked: 40, within: 38, p50Minutes: 60, p90Minutes: 400 },
      { role: 'ACCOUNTANT', decided: 10, tracked: 10, within: 8, p50Minutes: 90, p90Minutes: 700 },
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

describe('current-state objectives', () => {
  const now = at('2026-10-10T08:00:00Z');
  it('the ERP hand-off is missed once anything has waited more than 7 days', () => {
    expect(temixBacklogStatus(null, now)).toBe('met');
    expect(temixBacklogStatus(new Date(now.getTime() - 6 * 24 * 60 * MIN), now)).toBe('met');
    expect(temixBacklogStatus(new Date(now.getTime() - 8 * 24 * 60 * MIN), now)).toBe('breached');
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

describe('the written targets and the measured ones cannot drift', () => {
  const doc = readFileSync('docs/SERVICE-LEVELS.md', 'utf8');
  it.each(SLOS.map((s) => [s.id, s] as const))('%s is in docs/SERVICE-LEVELS.md with its target', (_id, s) => {
    expect(doc).toContain(s.title);
    expect(doc).toContain(s.targetLabel);
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
