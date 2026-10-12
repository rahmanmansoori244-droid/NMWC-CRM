// @vitest-environment node
/**
 * Gap 11 (data audit 2026-10-10): an approval row records the approver's own
 * role and WHY he could decide, beside the step's role. lib/permissions.ts
 * stepAuthority returns the basis canActOnStep admits a user on; canActOnStep is
 * its wrapper, so the decision and its recorded reason can never disagree.
 *
 * What this pins:
 *   - each basis, on the case that earns it, and null wherever canActOnStep
 *     refuses — over a matrix of every role, step scope and context;
 *   - the Supervisor step tells the submitter's own Supervisor from a Manager of
 *     the request's regions (the fallback an auditor asks about);
 *   - every write site records it: the three approve rows and the reject row in
 *     services/edits.ts, the signed-application upload (SUBMITTER) and both
 *     reactivation decisions (REGION_MANAGER), and /status counts a reactivation
 *     once (lib/service-status.ts leaves its EditApproval row out).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Role } from '@prisma/client';
import {
  AUTHORITY_BASES,
  canActOnStep,
  canApproveSpecificEdit,
  stepAuthority,
  type SessionUser,
} from '@/lib/permissions';
import type { StepScope } from '@/lib/approval-chains';
import { stripComments } from '../support/strip-comments';
import { callArguments } from '../support/call-args';

const su = (id: string, role: Role): SessionUser => ({ id, role, username: id });
const submitter = { id: 'sub', supervisorId: 'sup' };
const inR1 = [{ regionId: 'r1', deletedAt: null }];
const inR1R2 = [
  { regionId: 'r1', deletedAt: null },
  { regionId: 'r2', deletedAt: null },
];

describe('stepAuthority: the basis of each decision', () => {
  it('the submitter’s own Supervisor on a Supervisor step', () => {
    expect(stepAuthority(su('sup', Role.SUPERVISOR), { role: Role.SUPERVISOR, scope: 'SUPERVISOR_OF_SUBMITTER' }, submitter)).toBe(
      'SUPERVISOR_OF_SUBMITTER'
    );
  });

  it('a Manager of every region of the request on a Supervisor step (the fallback)', () => {
    const step = { role: Role.SUPERVISOR, scope: 'SUPERVISOR_OF_SUBMITTER' as const };
    expect(stepAuthority(su('m', Role.MANAGER), step, submitter, { customerBranches: inR1, managedRegionIds: ['r1'] })).toBe(
      'REGION_MANAGER'
    );
    // Owner decision 3: every region of the scope, not one of them.
    expect(stepAuthority(su('m', Role.MANAGER), step, submitter, { customerBranches: inR1R2, managedRegionIds: ['r1'] })).toBeNull();
    // A Manager who is ALSO the submitter's supervisor decides as a Manager of the regions.
    expect(
      stepAuthority(su('sup', Role.MANAGER), step, submitter, { customerBranches: inR1, managedRegionIds: ['r1'] })
    ).toBe('REGION_MANAGER');
  });

  it('the Accountant over one of the request’s regions; the org-wide roles everywhere', () => {
    const acc = { role: Role.ACCOUNTANT, scope: 'REGION_OVERLAP' as const };
    expect(stepAuthority(su('a', Role.ACCOUNTANT), acc, submitter, { customerBranches: inR1R2, managedRegionIds: ['r2'] })).toBe(
      'REGION_OVERLAP'
    );
    expect(stepAuthority(su('a', Role.ACCOUNTANT), acc, submitter, { customerBranches: inR1, managedRegionIds: ['r2'] })).toBeNull();
    for (const role of [Role.FINANCE_MANAGER, Role.GM, Role.SALES_DIRECTOR]) {
      expect(stepAuthority(su('x', role), { role, scope: 'GLOBAL' }, submitter), role).toBe('GLOBAL');
    }
  });

  it('nobody on the salesman’s own signed-application step, and never the submitter or a second-step actor', () => {
    for (const role of Object.values(Role)) {
      expect(stepAuthority(su('x', role), { role: Role.SALESMAN, scope: 'SUBMITTER' }, submitter), role).toBeNull();
    }
    expect(stepAuthority(su('sub', Role.GM), { role: Role.GM, scope: 'GLOBAL' }, submitter)).toBeNull();
    expect(
      stepAuthority(su('gm', Role.GM), { role: Role.GM, scope: 'GLOBAL' }, submitter, { priorStepActorIds: ['gm'] })
    ).toBeNull();
  });

  it('agrees with canActOnStep (and canApproveSpecificEdit) on every role × scope × context', () => {
    const scopes: StepScope[] = ['SUPERVISOR_OF_SUBMITTER', 'REGION_OVERLAP', 'GLOBAL', 'SUBMITTER'];
    const contexts = [
      {},
      { customerBranches: inR1, managedRegionIds: ['r1'] },
      { customerBranches: inR1R2, managedRegionIds: ['r1'] },
      { customerBranches: inR1R2, managedRegionIds: ['r1', 'r2'] },
      { customerBranches: [{ regionId: 'r1', deletedAt: new Date() }], managedRegionIds: ['r1'] },
      { customerBranches: inR1, managedRegionIds: [] as string[] },
      { customerBranches: inR1, managedRegionIds: ['r1'], priorStepActorIds: ['u'] },
    ];
    let checked = 0;
    for (const actorRole of Object.values(Role)) {
      for (const stepRole of Object.values(Role)) {
        for (const scope of scopes) {
          for (const ctx of contexts) {
            for (const id of ['u', 'sup', 'sub']) {
              const user = su(id, actorRole);
              const basis = stepAuthority(user, { role: stepRole, scope }, submitter, ctx);
              expect(basis !== null).toBe(canActOnStep(user, { role: stepRole, scope }, submitter, ctx));
              if (basis !== null) expect(AUTHORITY_BASES).toContain(basis);
              if (scope === 'SUPERVISOR_OF_SUBMITTER' && !ctx.priorStepActorIds) {
                expect(basis !== null).toBe(canApproveSpecificEdit(user, submitter, ctx));
              }
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('the vocabulary is the database’s: five values, SUBMITTER only for the salesman’s own step', () => {
    expect([...AUTHORITY_BASES]).toEqual(['SUPERVISOR_OF_SUBMITTER', 'REGION_MANAGER', 'REGION_OVERLAP', 'GLOBAL', 'SUBMITTER']);
  });
});

describe('every decision row records its authority', () => {
  const read = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

  it('services/edits.ts: the gate keeps its basis, and all four decision rows carry it', () => {
    const src = read('services/edits.ts');
    expect(src).not.toMatch(/\bcanActOnStep\(/);
    expect(src.match(/= stepAuthority\(/g)?.length).toBe(2);
    const rows = callArguments(src, /tx\.editApproval\.create/);
    expect(rows).toHaveLength(4);
    const approve = rows.filter((r) => r.includes("decision: 'APPROVED'"));
    expect(approve).toHaveLength(3);
    for (const r of approve) expect(r).toContain('...decidedAs');
    expect(src).toMatch(
      /const decidedAs = \{\s*actorRole: session\.role,\s*authorityBasis: authority,\s*scopeRegionIds,\s*submitterRouteId: edit\.submittedBy\.ownedRouteId,\s*\}/
    );
    const reject = rows.find((r) => r.includes("decision: 'REJECTED'"))!;
    expect(reject).toMatch(/actorRole: session\.role,\s*authorityBasis: rejectAuthority,\s*scopeRegionIds: rejectRegionIds,\s*submitterRouteId: edit\.submittedBy\.ownedRouteId/);
  });

  it('services/signed-form.ts: the salesman’s own upload says SUBMITTER, never an approval basis', () => {
    const rows = callArguments(read('services/signed-form.ts'), /tx\.editApproval\.create/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/actorRole: session\.role,\s*authorityBasis: 'SUBMITTER',\s*scopeRegionIds: regionIds,/);
  });

  it('services/reactivations.ts: approve and reject each write the MANAGER step’s decision row after the claim', () => {
    const src = read('services/reactivations.ts');
    const rows = callArguments(src, /tx\.editApproval\.create/);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("reactivationDecision(edit, me, 'APPROVED', managerReason, decidedAt)");
    expect(rows[1]).toContain("reactivationDecision(edit, me, 'REJECTED', reason, decidedAt)");
    const helper = src.slice(src.indexOf('function reactivationDecision'), src.indexOf('function reactivationConflict'));
    expect(helper).toMatch(/stepIndex: 0,\s*role: Role\.MANAGER,/);
    expect(helper).toMatch(/authorityBasis: 'REGION_MANAGER',\s*scopeRegionIds: edit\.branch \? \[edit\.branch\.regionId\] : \[\],/);
    // After the claim: a lost race writes no decision row.
    for (const fn of ['approveReactivationCore', 'rejectReactivationCore']) {
      const body = src.slice(src.indexOf(`async function ${fn}`));
      const end = body.indexOf('\nasync function ', 10);
      const scoped = end > 0 ? body.slice(0, end) : body;
      expect(scoped.indexOf('if (claim.count === 0)'), fn).toBeGreaterThan(-1);
      expect(scoped.indexOf('tx.editApproval.create'), fn).toBeGreaterThan(scoped.indexOf('if (claim.count === 0)'));
    }
  });

  it('lib/service-status.ts counts a reactivation once: both EditApproval queries leave its row out', () => {
    const src = read('lib/service-status.ts');
    const tiers = src.slice(src.indexOf('async function approvalTiers'), src.indexOf('export function percentile'));
    const queries = tiers.split('FROM "EditApproval" a').slice(1);
    expect(queries).toHaveLength(2);
    for (const q of queries) expect(q.slice(0, 300)).toContain('AND e."isReactivation" = false');
  });
});
