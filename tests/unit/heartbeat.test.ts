/**
 * B5: the dead-man logic behind the bearer /api/health cron report.
 * Pure — no DB. `heartbeatReport` turns stored rows into per-job states.
 *
 * The allowance is anchored on the previous window close (see
 * allowedAgeMinutes in lib/heartbeat.ts): the opening grace must never hide a
 * job that has been dead for days, and an alarm must not reset at 15:00 just
 * because the window closed.
 */
import { describe, it, expect } from 'vitest';
import { heartbeatReport, STALE_AFTER_INTERVALS, HEARTBEAT_EXPECTATIONS } from '@/lib/heartbeat';

const row = (key: string, minutesAgo: number, now: Date, ok = true) => ({
  key,
  lastRunAt: new Date(now.getTime() - minutesAgo * 60_000),
  lastOk: ok,
  lastError: ok ? null : 'boom',
  runs: 10,
  failures: ok ? 0 : 1,
});
const at = (utcHour: number, minute = 0) => new Date(Date.UTC(2026, 8, 14, utcHour, minute, 0));
const minutesBetween = (later: Date, earlier: Date) => (later.getTime() - earlier.getTime()) / 60_000;
const state = (rows: ReturnType<typeof row>[], now: Date, key: string) =>
  heartbeatReport(rows, now).find((r) => r.key === key)!;

describe('heartbeatReport', () => {
  it('reports every expected job, "never" (alarm) when a job has no row at all', () => {
    const report = heartbeatReport([], at(10));
    expect(report.map((r) => r.key).sort()).toEqual(Object.keys(HEARTBEAT_EXPECTATIONS).sort());
    for (const r of report) {
      expect(r.state).toBe('never');
      expect(r.alarm).toBe(true);
    }
  });

  it('keep-warm: ok when the last run is within 3 intervals inside the window, stale beyond', () => {
    const now = at(10);
    expect(state([row('keep-warm', 5, now)], now, 'keep-warm').state).toBe('ok');
    const stale = state([row('keep-warm', 4 * STALE_AFTER_INTERVALS + 1, now)], now, 'keep-warm');
    expect(stale.state).toBe('stale');
    expect(stale.alarm).toBe(true);
  });

  it('a job that last reported failure alarms as "failed"', () => {
    const now = at(10);
    const r = state([row('sla-escalate', 3, now, false)], now, 'sla-escalate');
    expect(r.state).toBe('failed');
    expect(r.alarm).toBe(true);
    expect(r.lastError).toBe('boom');
  });

  it('outside the active window a windowed job is not expected (no alarm) if it ran near the last close', () => {
    const night = at(20); // 20:00 UTC — keep-warm/sla run 03:00–14:59
    expect(state([row('keep-warm', 5 * 60, night)], night, 'keep-warm').state).toBe('outside-window');
    expect(state([row('sla-escalate', 6 * 60, night)], night, 'sla-escalate').alarm).toBe(false);
    const silentForDays = state([row('keep-warm', 3 * 24 * 60, night)], night, 'keep-warm');
    expect(silentForDays.state).toBe('stale');
    expect(silentForDays.alarm).toBe(true);
    // 02:59 next morning, last run 14:45 the day before (12 h 14 min ago) — still fine
    const dawn = at(2, 59);
    expect(state([row('sla-escalate', 12 * 60 + 14, dawn)], dawn, 'sla-escalate').state).toBe('outside-window');
  });

  it('a job that died mid-window stays stale after the window closes (the alarm does not reset at 15:00)', () => {
    // last run 10:00 → stale at 14:59, still stale at 15:00 and at 16:14
    for (const now of [at(14, 59), at(15, 0), at(16, 14)]) {
      const r = state([row('sla-escalate', minutesBetween(now, at(10)), now)], now, 'sla-escalate');
      expect(r.state).toBe('stale');
      expect(r.alarm).toBe(true);
    }
    // whereas a healthy last run at 14:45 is "outside-window" at 15:00 and at 16:14
    for (const now of [at(15, 0), at(16, 14)]) {
      const r = state([row('sla-escalate', minutesBetween(now, at(14, 45)), now)], now, 'sla-escalate');
      expect(r.state).toBe('outside-window');
      expect(r.alarm).toBe(false);
    }
    // keep-warm dead since 14:56 yesterday → stale at 15:00 today and at 15:09
    const yesterday1456 = new Date(at(14, 56).getTime() - 24 * 60 * 60_000);
    for (const now of [at(15, 0), at(15, 9)]) {
      expect(state([row('keep-warm', minutesBetween(now, yesterday1456), now)], now, 'keep-warm').state).toBe('stale');
    }
  });

  it("gives a grace period at the start of the window (yesterday's last run is not stale at 03:05)", () => {
    const early = at(3, 5);
    // last run yesterday 14:58 UTC → ~12 h ago
    expect(state([row('sla-escalate', 12 * 60 + 7, early)], early, 'sla-escalate').state).toBe('ok');
    expect(state([row('keep-warm', 12 * 60 + 9, early)], early, 'keep-warm').state).toBe('ok');
    // but once the grace (3 intervals = 90 min) has passed, silence is stale
    const later = at(4, 40);
    expect(state([row('sla-escalate', 13 * 60 + 42, later)], later, 'sla-escalate').state).toBe('stale');
    // keep-warm's grace is only 12 min: yesterday's run is stale at 03:13
    const kwLater = at(3, 13);
    expect(state([row('keep-warm', 12 * 60 + 17, kwLater)], kwLater, 'keep-warm').state).toBe('stale');
  });

  it('the opening grace never hides a job that has been dead for days', () => {
    const early = at(3, 15);
    const sla = state([row('sla-escalate', 5 * 24 * 60, early)], early, 'sla-escalate');
    expect(sla.state).toBe('stale');
    expect(sla.alarm).toBe(true);
    const kw = state([row('keep-warm', 5 * 24 * 60, at(3, 5))], at(3, 5), 'keep-warm');
    expect(kw.state).toBe('stale');
    expect(kw.alarm).toBe(true);
    // and a run from yesterday's LAST slot is fine at the same moment
    expect(state([row('sla-escalate', 12 * 60 + 30, early)], early, 'sla-escalate').state).toBe('ok');
  });

  it('db-backup tolerates GitHub cron drift but not a missed night', () => {
    // GitHub delivers this schedule late: across 127 real runs the worst gap
    // between two dumps was 33.2 h and half of all gaps exceeded 24 h. The
    // allowance is 40 h so ordinary drift is not an alarm and a missed night is.
    const now = at(10);
    expect(state([row('db-backup', 8 * 60, now)], now, 'db-backup').state).toBe('ok');
    expect(state([row('db-backup', 34 * 60, now)], now, 'db-backup').state).toBe('ok');
    const missed = state([row('db-backup', 41 * 60, now)], now, 'db-backup');
    expect(missed.state).toBe('stale');
    expect(missed.alarm).toBe(true);
    // photo-gc has the same daily cadence but no override, so it still
    // tolerates three days — the override is what makes the backup stricter.
    expect(state([row('photo-gc', 41 * 60, now)], now, 'photo-gc').state).toBe('ok');
  });

  it('a backup that ran but reported failure alarms immediately', () => {
    const now = at(10);
    const r = state([row('db-backup', 30, now, false)], now, 'db-backup');
    expect(r.state).toBe('failed');
    expect(r.alarm).toBe(true);
  });

  it('photo-gc is daily: fine after 20 h, stale after three days', () => {
    const now = at(12);
    expect(state([row('photo-gc', 20 * 60, now)], now, 'photo-gc').state).toBe('ok');
    expect(state([row('photo-gc', 3 * 24 * 60 + 1, now)], now, 'photo-gc').state).toBe('stale');
  });
});
