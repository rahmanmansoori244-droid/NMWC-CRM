/**
 * Oman working-hours SLA calendar (Phase 1 SLA/notifications increment).
 *
 * Ports the OLD system's SLA concept with its two confirmed defects fixed:
 *  1. Timezone (OLD BUG): OLD computed getHours()/getDay() on server-local
 *     time — UTC on Vercel — so "08:00–17:00" really meant 12:00–21:00 Oman.
 *     Asia/Muscat is UTC+4 with NO DST, so a constant offset is correct and
 *     avoids a tz library: shift to "Oman wall clock expressed in UTC fields"
 *     and use getUTC* everywhere.
 *  2. Precision/perf: OLD advanced hour-by-hour inside a bounded loop and
 *     only counted whole hours. This is a closed-form day walk at minute
 *     precision (loop iterations = working days spanned, not hours).
 *
 * Policy = constants with env override, not a table (same approach as OLD and
 * the app's other env-driven knobs). Defaults: Sun–Thu + Sat working (Friday
 * off — OLD parity), 08:00–17:00 Oman.
 */
import { Role } from '@prisma/client';

const TZ_OFFSET_MIN = Number(process.env.WORK_TZ_OFFSET_MIN ?? 240); // Asia/Muscat = UTC+4, no DST
const WORK_DAYS = new Set(
  (process.env.WORK_DAYS ?? '0,1,2,3,4').split(',').map((s) => Number(s.trim()))
); // getUTCDay() on the shifted clock: Sun=0 … Sat=6. Owner-confirmed workweek is
// Sun–Thu (5-day); Fri (5) AND Sat (6) are off. Override via WORK_DAYS if it changes.
const WORK_START_MIN = Math.round(Number(process.env.WORK_HOUR_START ?? 8) * 60);
const WORK_END_MIN = Math.round(Number(process.env.WORK_HOUR_END ?? 17) * 60);
const DAY_CAPACITY_MIN = WORK_END_MIN - WORK_START_MIN;

/**
 * Per-stage SLA budgets in working minutes, env-overridable.
 * SUPERVISOR 8h / ACCOUNTANT 9h are OLD-parity values (owner-confirmed);
 * FINANCE_MANAGER 16h / GM 24h / MANAGER 16h are placeholders (Q-sla open).
 * NOTE: lib/approval-chains.ts freezes each edit's budget onto its row at
 * submit, so changing these affects NEW submissions only — by design.
 */
export const STAGE_SLA_MINUTES: Partial<Record<Role, number>> = {
  [Role.SUPERVISOR]: Number(process.env.SLA_SUPERVISOR_MIN ?? 8 * 60),
  [Role.ACCOUNTANT]: Number(process.env.SLA_ACCOUNTANT_MIN ?? 9 * 60),
  [Role.FINANCE_MANAGER]: Number(process.env.SLA_FINANCE_MIN ?? 16 * 60),
  [Role.GM]: Number(process.env.SLA_GM_MIN ?? 24 * 60),
  [Role.MANAGER]: Number(process.env.SLA_MANAGER_MIN ?? 16 * 60),
};

export const DEFAULT_STAGE_SLA_MIN = 8 * 60;

/** How much later (multiple of the stage SLA) the level-2 escalation fires. */
export const ESCALATION_MULTIPLIER = 2;

// ── Wall-clock shifting: all day/minute math happens on the shifted clock. ──
function toLocal(d: Date): Date {
  return new Date(d.getTime() + TZ_OFFSET_MIN * 60_000);
}
function fromLocal(d: Date): Date {
  return new Date(d.getTime() - TZ_OFFSET_MIN * 60_000);
}
function minsOfDay(local: Date): number {
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}
function atMinutes(local: Date, minutes: number): Date {
  const d = new Date(local);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + minutes * 60_000);
}
function nextDayStart(local: Date): Date {
  const d = new Date(local);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + 24 * 60 * 60_000);
}
function isWorkDay(local: Date): boolean {
  return WORK_DAYS.has(local.getUTCDay());
}

/** Snap a (local) instant forward to the next moment inside a working window. */
function nextWorkingInstant(local: Date): Date {
  let d = new Date(local);
  // Bounded: with ≥1 working day per week, ≤8 iterations reach a window.
  for (let i = 0; i < 8; i += 1) {
    if (isWorkDay(d)) {
      const mins = minsOfDay(d);
      if (mins < WORK_START_MIN) return atMinutes(d, WORK_START_MIN);
      if (mins < WORK_END_MIN) return d;
    }
    d = nextDayStart(d);
  }
  return d;
}

/**
 * Minute-precision working-hours deadline: `slaMinutes` of WORKING time after
 * `start`. A submission at 16:30 Thursday with a 60-minute budget is due
 * 08:30 Saturday (Friday off), not 17:30 Thursday.
 * Degenerate configs (no working days / zero-width window) fall back to
 * wall-clock so a bad env can never wedge the queue.
 */
export function slaDeadline(start: Date, slaMinutes: number): Date {
  if (DAY_CAPACITY_MIN <= 0 || WORK_DAYS.size === 0 || slaMinutes <= 0) {
    return new Date(start.getTime() + Math.max(0, slaMinutes) * 60_000);
  }
  let remaining = slaMinutes;
  let local = nextWorkingInstant(toLocal(start));
  // Loop count = working days spanned (a 24h budget spans ~3 days).
  for (let i = 0; i < 4000 && remaining > 0; i += 1) {
    const available = WORK_END_MIN - minsOfDay(local);
    if (remaining <= available) {
      local = new Date(local.getTime() + remaining * 60_000);
      remaining = 0;
      break;
    }
    remaining -= available;
    local = nextWorkingInstant(nextDayStart(local));
  }
  return fromLocal(local);
}

/** Working minutes in [a, b]; 0 when b ≤ a. */
function workingMinutesBetween(a: Date, b: Date): number {
  if (b.getTime() <= a.getTime()) return 0;
  if (DAY_CAPACITY_MIN <= 0 || WORK_DAYS.size === 0) {
    return Math.round((b.getTime() - a.getTime()) / 60_000);
  }
  const end = toLocal(b);
  let local = nextWorkingInstant(toLocal(a));
  let total = 0;
  for (let i = 0; i < 4000 && local.getTime() < end.getTime(); i += 1) {
    const windowEnd = atMinutes(local, WORK_END_MIN);
    const segEnd = end.getTime() < windowEnd.getTime() ? end : windowEnd;
    if (segEnd.getTime() > local.getTime()) {
      total += Math.round((segEnd.getTime() - local.getTime()) / 60_000);
    }
    if (end.getTime() <= windowEnd.getTime()) break;
    local = nextWorkingInstant(nextDayStart(local));
  }
  return total;
}

/** Working minutes until `dueAt` (negative = overdue by that many working minutes). */
export function minutesRemaining(dueAt: Date, now: Date = new Date()): number {
  return now.getTime() <= dueAt.getTime()
    ? workingMinutesBetween(now, dueAt)
    : -workingMinutesBetween(dueAt, now);
}

/** Queue-pill label: "due in 5h" / "due in 90m" / "OVERDUE 3h". */
export function formatSlaStatus(dueAt: Date, now: Date = new Date()): {
  label: string;
  tone: 'ok' | 'warn' | 'overdue';
} {
  const mins = minutesRemaining(dueAt, now);
  const abs = Math.abs(mins);
  const human = abs >= 120 ? `${Math.round(abs / 60)}h` : `${abs}m`;
  if (mins < 0) return { label: `OVERDUE ${human}`, tone: 'overdue' };
  if (mins <= 120) return { label: `due in ${human}`, tone: 'warn' };
  return { label: `due in ${human}`, tone: 'ok' };
}
