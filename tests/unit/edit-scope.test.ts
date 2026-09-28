/**
 * Phase 2, F05: a salesman's edit is gated on the branches of HIS route — the
 * ones his page shows — at submit, and on exactly that frozen set at approval
 * (lib/edit-scope.ts). The gate used to scan every live branch of the customer,
 * so on a chain split across routes neither salesman could submit until the
 * other had finished his branches.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Role } from '@prisma/client';
import { stripComments } from '../support/strip-comments';
import {
  gateBranchesForApproval,
  parseSubmitGate,
  salesmanBranches,
  submitGateRecord,
  withoutSubmitterLockedFields,
} from '@/lib/edit-scope';
import { filterBranchesByScope, type Scope } from '@/lib/access';

const R1 = 'route-1';
const R2 = 'route-2';
const A = { id: 'ckbranchA000000000000001', routeId: R1, regionId: 'g1', deletedAt: null };
const A2 = { id: 'ckbranchA000000000000002', routeId: R1, regionId: 'g1', deletedAt: null };
const B = { id: 'ckbranchB000000000000001', routeId: R2, regionId: 'g2', deletedAt: null };
const LIVE = [A, A2, B];

describe('salesmanBranches', () => {
  it('the live branches on his route; none without a route', () => {
    expect(salesmanBranches(LIVE, R1)).toEqual([A, A2]);
    expect(salesmanBranches(LIVE, R2)).toEqual([B]);
    expect(salesmanBranches(LIVE, null)).toEqual([]);
    expect(salesmanBranches(LIVE, undefined)).toEqual([]);
    expect(salesmanBranches(LIVE, 'route-9')).toEqual([]);
  });

  it('is what the salesman is shown: filterBranchesByScope answers with it', () => {
    const scope = (ownedRouteId: string | null): Scope => ({
      ownedRouteId,
      teamRouteIds: [],
      managedRegionIds: [],
    });
    const salesman = { id: 'u1', role: Role.SALESMAN, username: 's' };
    const archived = { ...A2, deletedAt: new Date() };
    for (const route of [R1, R2, null]) {
      expect(filterBranchesByScope(salesman, [A, archived, B], scope(route))).toEqual(
        salesmanBranches([A, B], route)
      );
    }
  });

  it('lib/access.ts takes it from lib/edit-scope.ts and filters no route of its own (structural)', () => {
    const access = stripComments(readFileSync('lib/access.ts', 'utf8'), 'lib/access.ts');
    expect(access).toMatch(/import\s*\{\s*salesmanBranches\s*\}\s*from\s*'\.\/edit-scope'/);
    const salesmanCase = access.slice(access.indexOf('export function filterBranchesByScope'));
    const arm = salesmanCase.slice(
      salesmanCase.indexOf('case Role.SALESMAN:'),
      salesmanCase.indexOf('case Role.SUPERVISOR:')
    );
    expect(arm).toMatch(/return salesmanBranches\(live, scope\.ownedRouteId\)/);
    expect(arm).not.toMatch(/routeId\s*===/);
    // …and lib/edit-scope.ts stays free of the database, so the dependency runs one way.
    const scopeSrc = stripComments(readFileSync('lib/edit-scope.ts', 'utf8'), 'lib/edit-scope.ts');
    expect(scopeSrc).not.toMatch(/from '\.\/(db|access)'/);
  });
});

describe('submitGate — { v: 1, branchIds }', () => {
  it('the stored record holds each id once, and nothing but ids', () => {
    expect(submitGateRecord([A.id, A2.id, A.id])).toEqual({ v: 1, branchIds: [A.id, A2.id] });
    expect(submitGateRecord([])).toEqual({ v: 1, branchIds: [] });
  });

  it('reads back through JSON; anything else is null', () => {
    const stored = JSON.parse(JSON.stringify(submitGateRecord([A.id])));
    expect(parseSubmitGate(stored)).toEqual({ v: 1, branchIds: [A.id] });
    for (const bad of [
      null,
      undefined,
      {},
      { v: 2, branchIds: [] },
      { v: 1 },
      { v: 1, branchIds: 'x' },
      { v: 1, branchIds: [''] },
      { v: 1, gate: 'FULL', branchIds: [] },
      [A.id],
    ]) {
      expect(parseSubmitGate(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('gateBranchesForApproval', () => {
  const salesman = (ownedRouteId: string | null) => ({ role: Role.SALESMAN, ownedRouteId });
  const changes = (...ids: string[]) =>
    ids.map((id) => ({ field: `branch.${id}.address`, before: 'a', after: 'b' }));

  it('a frozen record: exactly its live branches, whatever the submitter is now', () => {
    const submitGate = submitGateRecord([A.id]);
    for (const submitter of [
      salesman(R1),
      salesman(R2),
      salesman(null),
      { role: Role.SUPERVISOR, ownedRouteId: null },
    ]) {
      const g = gateBranchesForApproval({
        submitGate,
        liveBranches: LIVE,
        fieldChanges: changes(B.id),
        submitter,
      });
      expect(g).toEqual({ gateBranches: [A], source: 'frozen', unreadable: false });
    }
  });

  it('a frozen branch that is gone drops out; one created after submit is not added', () => {
    const later = { id: 'ckbranchA000000000000009', routeId: R1, regionId: 'g1', deletedAt: null };
    const g = gateBranchesForApproval({
      submitGate: submitGateRecord([A.id, A2.id]),
      liveBranches: [A, B, later], // A2 archived or moved to another customer
      fieldChanges: [],
      submitter: salesman(R1),
    });
    expect(g.gateBranches).toEqual([A]);
  });

  it('no record, salesman now (a request from before the column): named branches plus his current route', () => {
    const g = gateBranchesForApproval({
      submitGate: null,
      liveBranches: LIVE,
      fieldChanges: changes(B.id),
      submitter: salesman(R1),
    });
    expect(g).toEqual({ gateBranches: [A, A2, B], source: 'fallback', unreadable: false });
    const noRoute = gateBranchesForApproval({
      submitGate: null,
      liveBranches: LIVE,
      fieldChanges: changes(B.id),
      submitter: salesman(null),
    });
    expect(noRoute.gateBranches).toEqual([B]);
  });

  it('no record and not a salesman now: not gated, as before', () => {
    for (const role of [Role.STEWARD, Role.MANAGER, Role.SUPERVISOR, null]) {
      const g = gateBranchesForApproval({
        submitGate: null,
        liveBranches: LIVE,
        fieldChanges: changes(A.id),
        submitter: { role, ownedRouteId: R1 },
      });
      expect(g, String(role)).toEqual({ gateBranches: null, source: 'none', unreadable: false });
    }
  });

  it('an unreadable record is reported and falls back — gated even if he is no longer a salesman', () => {
    const g = gateBranchesForApproval({
      submitGate: { v: 1, gate: 'CORE', branchIds: 'garbage' },
      liveBranches: LIVE,
      fieldChanges: changes(A2.id),
      submitter: { role: Role.SUPERVISOR, ownedRouteId: R2 },
    });
    expect(g).toEqual({ gateBranches: [A2], source: 'fallback', unreadable: true });
  });

  it('reads fieldChanges defensively — it is JSON', () => {
    const odd = [
      null,
      7,
      { field: 3 },
      { field: 'draft.0.gps' },
      { field: `branch.${B.id}.gpsLat` },
    ];
    const g = gateBranchesForApproval({
      submitGate: null,
      liveBranches: LIVE,
      fieldChanges: odd,
      submitter: salesman(null),
    });
    expect(g.gateBranches).toEqual([B]);
    expect(
      gateBranchesForApproval({
        submitGate: null,
        liveBranches: LIVE,
        fieldChanges: 'x',
        submitter: salesman(null),
      }).gateBranches
    ).toEqual([]);
  });
});

describe('withoutSubmitterLockedFields — QA-013 at approval, one helper for the service and the page', () => {
  const changes = [
    { field: 'customer.legalName', before: 'A', after: 'B' },
    { field: 'customer.crNumber', before: '1', after: '2' },
    { field: 'customer.notes', before: null, after: 'x' },
    { field: `branch.${A.id}.address`, before: 'a', after: 'b' },
  ];
  const fields = (cs: Array<{ field: string }>) => cs.map((c) => c.field);

  it('a salesman on a CASH customer: legal name dropped, CR number kept', () => {
    expect(
      fields(withoutSubmitterLockedFields(changes, Role.SALESMAN, { paymentTerms: 'CASH' }))
    ).toEqual(['customer.crNumber', 'customer.notes', `branch.${A.id}.address`]);
  });

  it('a salesman on a customer now on CREDIT: both dropped', () => {
    expect(
      fields(withoutSubmitterLockedFields(changes, Role.SALESMAN, { paymentTerms: 'CREDIT' }))
    ).toEqual(['customer.notes', `branch.${A.id}.address`]);
  });

  it('anyone else: nothing dropped', () => {
    for (const role of [Role.STEWARD, Role.MANAGER, null, undefined]) {
      expect(withoutSubmitterLockedFields(changes, role, { paymentTerms: 'CREDIT' })).toEqual(
        changes
      );
    }
  });
});
