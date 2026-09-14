/**
 * B5: the dead-man logic behind the bearer /api/health cron report.
 * Pure — no DB. `heartbeatReport` turns stored rows into per-job states.
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

  it('outside the active window a windowed job is not expected (no alarm) unless it has been silent for a day', () => {
    const night = at(20); // 20:00 UTC — keep-warm/sla run 03:00–14:59
    expect(state([row('keep-warm', 5 * 60, night)], night, 'keep-warm').state).toBe('outside-window');
    expect(state([row('sla-escalate', 6 * 60, night)], night, 'sla-escalate').alarm).toBe(false);
    const silentForDays = state([row('keep-warm', 3 * 24 * 60, night)], night, 'keep-warm');
    expect(silentForDays.state).toBe('stale');
    expect(silentForDays.alarm).toBe(true);
  });

  it('gives a grace period at the start of the window (yesterday\'s last run is not stale at 03:05)', () => {
    const early = at(3, 5);
    // last run yesterday 14:58 UTC → ~12 h ago
    expect(state([row('sla-escalate', 12 * 60 + 7, early)], early, 'sla-escalate').state).toBe('ok');
    // but once the grace (3 intervals = 90 min) has passed, silence is stale
    const later = at(4, 40);
    expect(state([row('sla-escalate', 13 * 60 + 42, later)], later, 'sla-escalate').state).toBe('stale');
  });

  it('photo-gc is daily: fine after 20 h, stale after three days', () => {
    const now = at(12);
    expect(state([row('photo-gc', 20 * 60, now)], now, 'photo-gc').state).toBe('ok');
    expect(state([row('photo-gc', 3 * 24 * 60 + 1, now)], now, 'photo-gc').state).toBe('stale');
  });
});
