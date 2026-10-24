// @vitest-environment node
/**
 * Gap 37 (data audit 2026-10-10): every request records the rules it was sent
 * under. The approval chain is frozen as `{ v, calendar, steps }` — the matrix
 * version, the working calendar in force, the steps with their budgets — for
 * every sent request, close and reactivation included; rows frozen before read
 * as version 0 (the bare array, no calendar).
 *
 *  - freezeChain / readFrozenChain / parseChain over the v0 array, the object
 *    form and malformed values (parseChain keeps its contract: steps, or the
 *    Supervisor fallback);
 *  - the close and reactivation chains record what already happened
 *    (pendingRole SUPERVISOR or MANAGER, on that role's budget);
 *  - the SLA sweep's budget comes from either form, and falls back otherwise;
 *  - structural (comments stripped, per CLAUDE.md): every approvalChain write in
 *    services/ goes through freezeChain, and nothing reads the stored chain with
 *    Array.isArray any more.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EditProcess, PaymentTerms, Role } from '@prisma/client';
import {
  CHAIN_VERSION,
  closeRequestChain,
  freezeChain,
  frozenStepBudgetMin,
  parseChain,
  reactivationChain,
  readFrozenChain,
  resolveChain,
  stepName,
} from '@/lib/approval-chains';
import { STAGE_SLA_MINUTES, workingCalendar } from '@/lib/working-hours';
import { stripComments } from '../support/strip-comments';

const credit = resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT);

describe('the frozen chain', () => {
  it('is { v, calendar, steps }: the matrix version and the calendar in force', () => {
    const f = freezeChain(credit);
    expect(f).toEqual({ v: CHAIN_VERSION, calendar: workingCalendar(), steps: credit });
    expect(CHAIN_VERSION).toBe(2);
    expect(f.calendar).toMatchObject({ tzOffsetMin: expect.any(Number), workDays: expect.any(Array), startMin: expect.any(Number), endMin: expect.any(Number) });
    // It survives the JSON column as it went in.
    expect(readFrozenChain(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  it('a row frozen before reads as version 0, no calendar, its steps as they were', () => {
    expect(readFrozenChain(credit)).toEqual({ v: 0, calendar: null, steps: credit });
    expect(parseChain(credit)).toEqual(credit);
    expect(parseChain(freezeChain(credit))).toEqual(credit);
  });

  it('anything else is no chain, and parseChain falls back to the Supervisor step', () => {
    const fallback = resolveChain(EditProcess.UPDATE, PaymentTerms.CASH);
    for (const bad of [
      null,
      undefined,
      'chain',
      42,
      {},
      { v: 2 },
      { v: 2, calendar: null },
      { v: 0, calendar: null, steps: credit },
      { v: 1.5, calendar: null, steps: credit },
      { v: '2', calendar: null, steps: credit },
      { v: 2, calendar: 'x', steps: credit },
      { v: 2, steps: credit },
      { v: 2, calendar: null, steps: [{ role: 'GM' }] },
      { v: 2, calendar: null, steps: 'x' },
    ]) {
      expect(readFrozenChain(bad), JSON.stringify(bad)).toBeNull();
      expect(parseChain(bad)).toEqual(fallback);
    }
    // An empty chain in either form is read, and parses to the fallback.
    expect(readFrozenChain([])).toEqual({ v: 0, calendar: null, steps: [] });
    expect(parseChain([])).toEqual(fallback);
    expect(parseChain(freezeChain([]))).toEqual(fallback);
  });

  it('the close and reactivation chains record what already happens', () => {
    expect(closeRequestChain()).toEqual([{ role: Role.SUPERVISOR, scope: 'SUPERVISOR_OF_SUBMITTER', slaHours: STAGE_SLA_MINUTES[Role.SUPERVISOR]! / 60 }]);
    expect(closeRequestChain()).toEqual(resolveChain(EditProcess.UPDATE, PaymentTerms.CASH));
    expect(reactivationChain()).toEqual([{ role: Role.MANAGER, scope: 'REGION_OVERLAP', slaHours: STAGE_SLA_MINUTES[Role.MANAGER]! / 60 }]);
    // A reactivation's page names the Manager step now, not the Supervisor fallback.
    expect(stepName(parseChain(freezeChain(reactivationChain()))[0])).toBe('Manager');
    expect(stepName(parseChain(null)[0])).toBe('Supervisor');
  });
});

describe('the SLA sweep’s budget', () => {
  it('comes from the frozen step in either form, else null (the sweep then uses the live policy)', () => {
    const at = 3; // the Finance Manager step
    const minutes = Math.round(credit[at]!.slaHours * 60);
    expect(frozenStepBudgetMin(freezeChain(credit), at)).toBe(minutes);
    expect(frozenStepBudgetMin(credit, at)).toBe(minutes);
    expect(frozenStepBudgetMin(freezeChain(reactivationChain()), 0)).toBe(STAGE_SLA_MINUTES[Role.MANAGER]);
    expect(frozenStepBudgetMin(null, 0)).toBeNull();
    expect(frozenStepBudgetMin(freezeChain(credit), 9)).toBeNull();
    expect(frozenStepBudgetMin({ v: 2 }, 0)).toBeNull();
  });

  it('the sweep reads it through frozenStepBudgetMin, not Array.isArray', () => {
    const src = stripComments(readFileSync('app/api/cron/sla-escalate/route.ts', 'utf8'), 'route.ts');
    expect(src).toContain('frozenStepBudgetMin(e.approvalChain, e.currentStepIndex)');
    expect(src).not.toMatch(/Array\.isArray\(e\.approvalChain\)/);
  });
});

describe('every writer freezes the chain (structural)', () => {
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
  });

  it('nothing reads the stored chain with Array.isArray (readFrozenChain is the one reader)', () => {
    for (const f of files.filter((x) => !/approval-chains\.ts$/.test(x))) {
      const src = stripComments(readFileSync(f, 'utf8'), f);
      expect(src, f).not.toMatch(/Array\.isArray\([^)]*approvalChain\)/);
    }
  });
});
