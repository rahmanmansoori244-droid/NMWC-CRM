/**
 * Phase 1 SLA: Oman working-hours calendar + escalation plan.
 *
 * Defaults under test: UTC+4 (Asia/Muscat, no DST), working days Sun–Thu +
 * Sat (Friday off), window 08:00–17:00 Oman = 04:00–13:00 UTC.
 * All fixture instants are written in UTC and annotated with Oman wall time.
 */
import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import {
  slaDeadline,
  minutesRemaining,
  formatSlaStatus,
  STAGE_SLA_MINUTES,
  ESCALATION_MULTIPLIER,
} from '@/lib/working-hours';
import { escalationPlan } from '@/lib/escalation';

// 2026-07-15 is a Wednesday (workday). 2026-07-17 is a Friday (off).
const WED_10_OMAN = new Date('2026-07-15T06:00:00.000Z'); // Wed 10:00 Oman
const WED_1630_OMAN = new Date('2026-07-15T12:30:00.000Z'); // Wed 16:30 Oman
const THU_1630_OMAN = new Date('2026-07-16T12:30:00.000Z'); // Thu 16:30 Oman
const FRI_NOON_OMAN = new Date('2026-07-17T08:00:00.000Z'); // Fri 12:00 Oman (off day)

describe('slaDeadline (working-hours calendar)', () => {
  it('stays inside the same working day when the budget fits', () => {
    // Wed 10:00 + 4h -> Wed 14:00 Oman (10:00 UTC).
    expect(slaDeadline(WED_10_OMAN, 4 * 60).toISOString()).toBe('2026-07-15T10:00:00.000Z');
  });

  it('rolls overnight: work stops at 17:00 and resumes 08:00 next day', () => {
    // Wed 16:30 + 60min -> 30min Wed + 30min Thu -> Thu 08:30 Oman (04:30 UTC).
    expect(slaDeadline(WED_1630_OMAN, 60).toISOString()).toBe('2026-07-16T04:30:00.000Z');
  });

  it('skips Friday entirely (Thu evening -> Sat morning)', () => {
    // Thu 16:30 + 60min -> 30min Thu + 30min SATURDAY (Fri off) -> Sat 08:30 Oman.
    expect(slaDeadline(THU_1630_OMAN, 60).toISOString()).toBe('2026-07-18T04:30:00.000Z');
  });

  it('a submission on the off day starts counting from the next working morning', () => {
    // Fri noon + 8h -> all of Sat 08:00-16:00 -> Sat 16:00 Oman (12:00 UTC).
    expect(slaDeadline(FRI_NOON_OMAN, 8 * 60).toISOString()).toBe('2026-07-18T12:00:00.000Z');
  });

  it('multi-day budgets walk whole 9h working days', () => {
    // Wed 10:00 + 24h working: 7h Wed + 9h Thu + (Fri off) + 8h Sat -> Sat 16:00 Oman.
    expect(slaDeadline(WED_10_OMAN, 24 * 60).toISOString()).toBe('2026-07-18T12:00:00.000Z');
  });

  it('supervisor OLD-parity example: 8h from Wed 10:00 lands Thu 09:00 Oman', () => {
    // 7h left Wed (10:00->17:00) + 1h Thu -> Thu 09:00 Oman (05:00 UTC).
    expect(slaDeadline(WED_10_OMAN, STAGE_SLA_MINUTES[Role.SUPERVISOR]!).toISOString()).toBe(
      '2026-07-16T05:00:00.000Z'
    );
  });
});

describe('minutesRemaining / formatSlaStatus', () => {
  it('counts only working minutes toward the deadline', () => {
    const due = slaDeadline(WED_1630_OMAN, 60); // Thu 08:30 Oman
    // From Wed 16:30, exactly the 60 budgeted working minutes remain — the
    // 15 overnight non-working hours do not count.
    expect(minutesRemaining(due, WED_1630_OMAN)).toBe(60);
  });

  it('overdue is negative in working minutes', () => {
    const due = new Date('2026-07-15T06:00:00.000Z'); // Wed 10:00 Oman
    const now = new Date('2026-07-15T08:00:00.000Z'); // Wed 12:00 Oman
    expect(minutesRemaining(due, now)).toBe(-120);
    expect(formatSlaStatus(due, now)).toEqual({ label: 'OVERDUE 2h', tone: 'overdue' });
  });

  it('warn tone inside the final 2 working hours', () => {
    const due = new Date('2026-07-15T07:00:00.000Z'); // Wed 11:00 Oman
    const now = new Date('2026-07-15T06:00:00.000Z'); // Wed 10:00 Oman
    expect(formatSlaStatus(due, now)).toEqual({ label: 'due in 60m', tone: 'warn' });
  });
});

describe('escalationPlan', () => {
  it('SUPERVISOR breach → region Managers; level 2 adds GM', () => {
    expect(escalationPlan(Role.SUPERVISOR, 1)).toEqual({
      regionScopedRoles: [Role.MANAGER],
      globalRoles: [],
    });
    expect(escalationPlan(Role.SUPERVISOR, 2)).toEqual({
      regionScopedRoles: [Role.MANAGER],
      globalRoles: [Role.GM],
    });
  });

  it('finance chain escalates upward: ACCOUNTANT → FM+GM, FM → GM, GM → Managers+Steward', () => {
    expect(escalationPlan(Role.ACCOUNTANT, 1).globalRoles).toEqual([
      Role.FINANCE_MANAGER,
      Role.GM,
    ]);
    expect(escalationPlan(Role.FINANCE_MANAGER, 1).globalRoles).toEqual([Role.GM]);
    expect(escalationPlan(Role.GM, 1).globalRoles).toEqual([Role.MANAGER, Role.STEWARD]);
  });

  it('deploy-gap rows (pendingRole null) escalate as Supervisor edits', () => {
    expect(escalationPlan(null, 1)).toEqual(escalationPlan(Role.SUPERVISOR, 1));
  });

  it('level-2 multiplier is 2× the stage budget', () => {
    expect(ESCALATION_MULTIPLIER).toBe(2);
  });
});
