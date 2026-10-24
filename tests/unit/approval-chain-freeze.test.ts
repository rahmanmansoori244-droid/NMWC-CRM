// @vitest-environment node
/**
 * Gap 37 (data audit 2026-10-10): every request records the rules it was sent
 * under, close and reactivation included. The chain can be frozen as
 * `{ v, calendar, steps }` — the matrix version, the working calendar in force,
 * the steps with their budgets — and the bare array reads as version 0.
 *
 * Review of gap 37 (2026-10-25):
 *  - the object form is a two-step change: production's rollback target
 *    (a454239) reads only the bare array, and an object there is ONE Supervisor
 *    step. So this build reads both forms and still writes the bare array
 *    (CHAIN_OBJECT_FORM_ENABLED is false); a follow-up commit turns it on;
 *  - parseChain fails closed: a stored value that is present but is not a chain
 *    is refused (CHAIN_UNREADABLE) and logged, never read as the Supervisor
 *    fallback; only nothing stored, or the legacy empty array, falls back;
 *  - a step is checked on its role and scope only: a budget that is not a
 *    number (an SLA_* setting of '16h' stored as null) keeps every step and is
 *    "no frozen budget" for the sweep; freezeChain refuses to write one.
 *
 * Structural (comments stripped, per CLAUDE.md): every approvalChain write in
 * services/ goes through freezeChain; nothing reads the stored chain with
 * Array.isArray; the approvals list and the e-mail drain read it without
 * throwing (parseChainOrNull).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EditProcess, PaymentTerms, Role } from '@prisma/client';

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: log }));

import {
  CHAIN_OBJECT_FORM_ENABLED,
  CHAIN_UNREADABLE_MESSAGE,
  CHAIN_VERSION,
  SLA_SETTINGS_INVALID_MESSAGE,
  closeRequestChain,
  freezeChain,
  frozenStepBudgetMin,
  isFinalStep,
  parseChain,
  parseChainOrNull,
  reactivationChain,
  readFrozenChain,
  resolveChain,
  stepName,
  type ApprovalStep,
} from '@/lib/approval-chains';
import { AppError } from '@/lib/errors';
import { STAGE_SLA_MINUTES, workingCalendar } from '@/lib/working-hours';
import { stripComments } from '../support/strip-comments';

const credit = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT);
const cash = resolveChain(EditProcess.CREATE, PaymentTerms.CASH);
const update = resolveChain(EditProcess.UPDATE, PaymentTerms.CASH);
const fallback = update;
/** Through the Json column and back, as Prisma stores and returns it. */
const stored = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

/**
 * Production's reader at a454239 — the build an Instant Rollback lands on —
 * as it is there: an array of steps, or else the single Supervisor step.
 */
function rollbackTargetParseChain(approvalChain: unknown): unknown[] | 'SUPERVISOR_FALLBACK' {
  if (Array.isArray(approvalChain) && approvalChain.length > 0) return approvalChain;
  return 'SUPERVISOR_FALLBACK';
}

function refusal(fn: () => unknown): AppError | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e : null;
  }
}

beforeEach(() => {
  log.error.mockClear();
});

describe('the stored form ships off: this build writes what the rollback target reads', () => {
  it('CHAIN_OBJECT_FORM_ENABLED is false in this build (the enable is its own commit, OPERATIONS section 4)', () => {
    expect(CHAIN_OBJECT_FORM_ENABLED).toBe(false);
  });

  it.each([
    ['an update', update],
    ['a cash create', cash],
    ['a credit create', credit],
    ['a close', closeRequestChain()],
    ['a reactivation', reactivationChain()],
  ])('%s is written as the bare array, which a454239 reads step for step', (_label, steps) => {
    const value = stored(freezeChain(steps));
    expect(value).toEqual(steps);
    expect(rollbackTargetParseChain(value)).toEqual(steps);
    // And this build reads it the same.
    expect(parseChain(value)).toEqual(steps);
  });

  it('the object form — written only once enabled — is what a454239 would misread as one Supervisor step', () => {
    const value = stored(freezeChain(cash, true));
    expect(rollbackTargetParseChain(value)).toBe('SUPERVISOR_FALLBACK');
    // There, the Supervisor's approval at step 0 is final: the Accountant is skipped.
    expect(isFinalStep(fallback, 0)).toBe(true);
    expect(isFinalStep(parseChain(value), 0)).toBe(false);
  });
});

describe('the frozen chain', () => {
  it('enabled, it is { v, calendar, steps }: the matrix version and the calendar in force', () => {
    const f = freezeChain(credit, true);
    expect(f).toEqual({ v: CHAIN_VERSION, calendar: workingCalendar(), steps: credit });
    expect(CHAIN_VERSION).toBe(2);
    expect(readFrozenChain(stored(f))).toEqual(f);
    expect(parseChain(stored(f))).toEqual(credit);
  });

  it('the bare array reads as version 0, no calendar, its steps as they were', () => {
    expect(readFrozenChain(credit)).toEqual({ v: 0, calendar: null, steps: credit });
    expect(parseChain(credit)).toEqual(credit);
  });

  it('nothing stored, or the legacy empty array, is the Supervisor fallback', () => {
    for (const none of [null, undefined]) {
      expect(readFrozenChain(none)).toBeNull();
      expect(parseChain(none)).toEqual(fallback);
      expect(parseChainOrNull(none)).toEqual(fallback);
    }
    expect(readFrozenChain([])).toEqual({ v: 0, calendar: null, steps: [] });
    expect(parseChain([])).toEqual(fallback);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED: a stored value that is not a chain is refused and logged, never the Supervisor fallback', () => {
    for (const bad of [
      'chain',
      42,
      true,
      {},
      { v: 2 },
      { v: 2, calendar: null },
      { v: 0, calendar: null, steps: credit },
      { v: 1.5, calendar: null, steps: credit },
      { v: '2', calendar: null, steps: credit },
      { v: 2, calendar: null, steps: [] },
      { v: 2, calendar: null, steps: 'x' },
      { v: 2, calendar: null, steps: [null] },
      { v: 2, calendar: null, steps: [{ role: 'GM' }] },
      { v: 2, calendar: null, steps: [{ scope: 'GLOBAL' }] },
      { v: 2, calendar: null, steps: [{ role: '', scope: 'GLOBAL' }] },
      { v: 2, calendar: null, steps: [...credit.slice(0, 5), { role: 'ACCOUNTANT', scope: 'EVERYWHERE', slaHours: 9 }] },
    ]) {
      log.error.mockClear();
      expect(readFrozenChain(bad), JSON.stringify(bad)).toBeNull();
      const e = refusal(() => parseChain(bad));
      expect(e, JSON.stringify(bad)).not.toBeNull();
      expect(e).toMatchObject({ code: 'CHAIN_UNREADABLE', message: CHAIN_UNREADABLE_MESSAGE });
      expect(parseChainOrNull(bad), JSON.stringify(bad)).toBeNull();
      expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ why: expect.any(String) }), 'approval_chain.unreadable');
    }
  });

  it('a calendar that is missing or not an object is no calendar — the steps still read', () => {
    for (const calendar of [undefined, 'x', 7, ['a']]) {
      const value = { v: 2, ...(calendar === undefined ? {} : { calendar }), steps: credit };
      expect(readFrozenChain(value)).toEqual({ v: 2, calendar: null, steps: credit });
      expect(parseChain(value)).toHaveLength(6);
    }
  });

  it('a step whose budget is not a number (an SLA_* value of "16h", stored as null) keeps all six steps', () => {
    const fm = 3; // the Finance Manager step
    const nulled = credit.map((s, i) => (i === fm ? { ...s, slaHours: null } : s));
    for (const value of [stored({ v: 2, calendar: workingCalendar(), steps: nulled }), stored(nulled)]) {
      const chain = parseChain(value);
      expect(chain).toHaveLength(6);
      expect(chain.map((s) => s.role)).toEqual(['SUPERVISOR', 'SALES_DIRECTOR', 'SALESMAN', 'FINANCE_MANAGER', 'GM', 'ACCOUNTANT']);
      // The Supervisor's approval is not final, whatever the budget.
      expect(isFinalStep(chain, 0)).toBe(false);
      // That step froze no budget (the sweep uses the live policy); the others did.
      expect(frozenStepBudgetMin(value, fm)).toBeNull();
      expect(frozenStepBudgetMin(value, 4)).toBe(Math.round(credit[4]!.slaHours * 60));
    }
    expect(log.error).not.toHaveBeenCalled();
  });

  it('the close and reactivation chains record what already happens', () => {
    expect(closeRequestChain()).toEqual([{ role: Role.SUPERVISOR, scope: 'SUPERVISOR_OF_SUBMITTER', slaHours: STAGE_SLA_MINUTES[Role.SUPERVISOR]! / 60 }]);
    expect(closeRequestChain()).toEqual(update);
    expect(reactivationChain()).toEqual([{ role: Role.MANAGER, scope: 'REGION_OVERLAP', slaHours: STAGE_SLA_MINUTES[Role.MANAGER]! / 60 }]);
    // A reactivation's page names the Manager step now, not the Supervisor fallback.
    expect(stepName(parseChain(freezeChain(reactivationChain()))[0])).toBe('Manager');
    expect(stepName(parseChain(freezeChain(reactivationChain(), true))[0])).toBe('Manager');
    expect(stepName(parseChain(null)[0])).toBe('Supervisor');
  });
});

describe('freezeChain refuses what it cannot freeze', () => {
  it.each([
    ['NaN (an SLA_* value that is not a number)', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative budget', -1],
    ['no number at all', undefined],
  ])('a budget of %s: nothing is written, and the operator is told by the log', (_label, slaHours) => {
    const steps = credit.map((s, i) => (i === 3 ? ({ ...s, slaHours } as unknown as ApprovalStep) : s));
    for (const objectForm of [false, true]) {
      log.error.mockClear();
      const e = refusal(() => freezeChain(steps, objectForm));
      expect(e).toMatchObject({ code: 'SLA_SETTINGS_INVALID', message: SLA_SETTINGS_INVALID_MESSAGE });
      expect(log.error).toHaveBeenCalledWith({ roles: ['FINANCE_MANAGER'] }, 'approval_chain.budget_invalid');
    }
  });

  it('a zero budget is a budget (the deadline is the moment it is sent)', () => {
    const steps = update.map((s) => ({ ...s, slaHours: 0 }));
    expect(freezeChain(steps)).toEqual(steps);
  });

  it('an empty chain is never written', () => {
    expect(() => freezeChain([])).toThrow(/at least one step/);
  });
});

describe('the SLA sweep’s budget', () => {
  it('comes from the frozen step in either form, else null (the sweep then uses the live policy)', () => {
    const at = 3; // the Finance Manager step
    const minutes = Math.round(credit[at]!.slaHours * 60);
    expect(frozenStepBudgetMin(freezeChain(credit, true), at)).toBe(minutes);
    expect(frozenStepBudgetMin(credit, at)).toBe(minutes);
    expect(frozenStepBudgetMin(freezeChain(reactivationChain()), 0)).toBe(STAGE_SLA_MINUTES[Role.MANAGER]);
    expect(frozenStepBudgetMin(null, 0)).toBeNull();
    expect(frozenStepBudgetMin(freezeChain(credit, true), 9)).toBeNull();
    expect(frozenStepBudgetMin({ v: 2 }, 0)).toBeNull();
    // A budget that is not a number is no budget.
    for (const slaHours of [null, 'x', Number.NaN, -2]) {
      expect(frozenStepBudgetMin([{ role: 'SUPERVISOR', scope: 'SUPERVISOR_OF_SUBMITTER', slaHours }], 0)).toBeNull();
    }
    expect(frozenStepBudgetMin([null], 0)).toBeNull();
  });

  it('the sweep reads it through frozenStepBudgetMin, not Array.isArray', () => {
    const src = stripComments(readFileSync('app/api/cron/sla-escalate/route.ts', 'utf8'), 'route.ts');
    expect(src).toContain('frozenStepBudgetMin(e.approvalChain, e.currentStepIndex)');
    expect(src).not.toMatch(/Array\.isArray\(e\.approvalChain\)/);
  });
});

describe('every writer freezes the chain, and every reader reads it (structural)', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
    });
  const files = ['services', 'lib', 'app'].flatMap(walk);

  it('every approvalChain write in services/ is freezeChain(...), or a copy of the stored one', () => {
    let writes = 0;
    for (const f of walk('services')) {
      const src = stripComments(readFileSync(f, 'utf8'), f);
      for (const m of src.matchAll(/approvalChain:\s*([^,\n}]+)/g)) {
        const value = m[1]!.trim();
        if (value === 'true') continue; // a select
        writes += 1;
        const ok = /^freezeChain\(/.test(value) || /^frozenChain as unknown as Prisma\.InputJsonValue/.test(value) || value === 'edit.approvalChain';
        expect(ok, `${f}: approvalChain: ${value}`).toBe(true);
      }
    }
    // The UPDATE submit, the create submit and its revision, close and reactivation.
    expect(writes).toBeGreaterThanOrEqual(5);
    const creates = stripComments(readFileSync('services/creates.ts', 'utf8'), 'creates.ts');
    expect(creates).toContain('const frozenChain = freezeChain(chain);');
    const react = stripComments(readFileSync('services/reactivations.ts', 'utf8'), 'reactivations.ts');
    expect(react).toContain('approvalChain: freezeChain(reactivationChain())');
    expect(react).toContain('approvalChain: freezeChain(closeRequestChain())');
    // No writer turns the object form on by itself: only the flag does.
    for (const f of walk('services')) {
      expect(stripComments(readFileSync(f, 'utf8'), f), f).not.toMatch(/freezeChain\([^)]*,\s*true\)/);
    }
  });

  it('nothing reads the stored chain with Array.isArray (lib/approval-chains.ts is the one reader)', () => {
    for (const f of files.filter((x) => !/approval-chains\.ts$/.test(x))) {
      const src = stripComments(readFileSync(f, 'utf8'), f);
      expect(src, f).not.toMatch(/Array\.isArray\([^)]*approvalChain\)/);
    }
  });

  it('the approvals list and the e-mail drain read it without throwing; the decisions refuse', () => {
    const list = stripComments(readFileSync('app/(app)/approvals/page.tsx', 'utf8'), 'page.tsx');
    expect(list).toContain('parseChainOrNull(e.approvalChain)');
    expect(list).not.toMatch(/\bparseChain\(/);
    const drain = stripComments(readFileSync('lib/email/eligibility.ts', 'utf8'), 'eligibility.ts');
    expect(drain).toContain('parseChainOrNull(edit.approvalChain)');
    expect(drain).not.toMatch(/\bparseChain\(/);
    // The decision paths read it through parseChain, which refuses.
    const edits = stripComments(readFileSync('services/edits.ts', 'utf8'), 'edits.ts');
    expect(edits).toContain('isFinalStep(parseChain(edit.approvalChain), edit.currentStepIndex)');
    expect(edits).not.toContain('parseChainOrNull');
    const finalize = stripComments(readFileSync('lib/create-finalize.ts', 'utf8'), 'create-finalize.ts');
    expect(finalize).toContain('requiredAtFinalize(parseChain(edit.approvalChain))');
  });
});
