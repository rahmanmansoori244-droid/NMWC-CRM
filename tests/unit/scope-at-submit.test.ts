// @vitest-environment node
/**
 * Gap 18 (data audit 2026-10-10): every request records where it was raised —
 * CustomerEdit.routeIdAtSubmit and regionIdsAtSubmit (lib/scope-at-submit.ts) —
 * so "the region it was in at the time" can be answered later for an update,
 * which could not be recovered before.
 *
 *  - the pure rule: a new customer's draft route and region; otherwise his own
 *    route and the regions of the request's scope by the queue's rule
 *    (requestScopeBranches);
 *  - structural (comments stripped, per CLAUDE.md): every submit path writes it
 *    — the UPDATE submit, the direct write, the CREATE submit and resubmit,
 *    close and reactivation — and the sealed CREATE audit row carries it; a draft
 *    save does not;
 *  - nothing that decides visibility reads it (the owner's open question A6).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createScopeAtSubmit, requestScopeAtSubmit } from '@/lib/scope-at-submit';
import { stripComments } from '../support/strip-comments';

const b = (id: string, regionId: string, routeId: string, deletedAt: Date | null = null) => ({ id, regionId, routeId, deletedAt });

describe('the scope at submit', () => {
  it('a new customer: its draft route and that route’s region', () => {
    expect(createScopeAtSubmit({ id: 'r1', regionId: 'g1' })).toEqual({ routeIdAtSubmit: 'r1', regionIdsAtSubmit: ['g1'] });
  });

  it('an update of customer fields: his route, and the region of his home branch', () => {
    const branches = [b('b2', 'gB', 'rB'), b('b1', 'gA', 'rA')];
    expect(
      requestScopeAtSubmit({
        branches,
        fieldChanges: [{ field: 'customer.contactPerson', before: null, after: 'x' }],
        homeBranchIds: ['b1'],
        submitterRouteId: 'rA',
        submitterRegionId: 'gA',
      })
    ).toEqual({ routeIdAtSubmit: 'rA', regionIdsAtSubmit: ['gA'] });
  });

  it('branch changes: the regions of the branches it changes, sorted, each once; a deleted branch is not live', () => {
    const branches = [b('b1', 'gB', 'rB'), b('b2', 'gA', 'rA'), b('b3', 'gA', 'rA'), b('b4', 'gC', 'rC', new Date())];
    expect(
      requestScopeAtSubmit({
        branches,
        fieldChanges: ['b1', 'b2', 'b3', 'b4'].map((id) => ({ field: `branch.${id}.dayOfVisit`, before: null, after: 'SUN' })),
        submitterRouteId: 'rA',
      })
    ).toEqual({ routeIdAtSubmit: 'rA', regionIdsAtSubmit: ['gA', 'gB'] });
  });

  it('a close or a reactivation: the shop’s region', () => {
    expect(requestScopeAtSubmit({ branches: [b('b1', 'gA', 'rA')], fieldChanges: [], branchId: 'b1', submitterRouteId: 'rA' })).toEqual({
      routeIdAtSubmit: 'rA',
      regionIdsAtSubmit: ['gA'],
    });
  });

  it('a direct write by someone with no route: route null, the scope by the same rule', () => {
    expect(
      requestScopeAtSubmit({
        branches: [b('b2', 'gB', 'rB'), b('b1', 'gA', 'rA')],
        fieldChanges: [{ field: 'customer.notes', before: null, after: 'x' }],
        submitterRouteId: null,
      })
    ).toEqual({ routeIdAtSubmit: null, regionIdsAtSubmit: ['gA'] });
    expect(requestScopeAtSubmit({ branches: [], fieldChanges: [], submitterRouteId: null })).toEqual({ routeIdAtSubmit: null, regionIdsAtSubmit: [] });
  });
});

describe('every submit path writes it (structural)', () => {
  const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

  it('the UPDATE submit and the direct write (services/edits.ts), not the draft save', () => {
    const s = src('services/edits.ts');
    const submitted = s.slice(s.indexOf('const submitted: Prisma.CustomerEditUncheckedCreateInput = {'), s.indexOf('if (isDraft) {\n        edit = await saveUpdateDraft('));
    expect(submitted).toMatch(/\.\.\.\(isDraft\s*\?\s*\{\}\s*:\s*requestScopeAtSubmit\(\{/);
    expect(submitted).toContain('homeBranchIds: salesmanBranches(customer.branches, me.ownedRouteId).map((b) => b.id)');
    const direct = s.slice(s.indexOf('state: EditState.APPROVED,'), s.indexOf('await applyEditChanges(tx, customer.id'));
    expect(direct).toMatch(/\.\.\.requestScopeAtSubmit\(\{\s*branches: now\.branches,\s*fieldChanges: apply,/);
    const draft = s.slice(s.indexOf('async function saveUpdateDraft('), s.indexOf('export async function clearReturnedEditAction('));
    expect(draft).not.toMatch(/routeIdAtSubmit|regionIdsAtSubmit|ScopeAtSubmit/);
  });

  it('the CREATE submit and resubmit, and its audit row (services/creates.ts)', () => {
    const s = src('services/creates.ts');
    const state = s.slice(s.indexOf('const stateFields = isDraft'), s.indexOf('const stateFields = isDraft') + 1500);
    expect(state).toContain('...createScopeAtSubmit(route),');
    expect(s).toContain('...(isDraft ? {} : createScopeAtSubmit(route)),');
  });

  it('close and reactivation (services/reactivations.ts), on the shop', () => {
    const s = src('services/reactivations.ts');
    expect(s.match(/\.\.\.requestScopeAtSubmit\(\{\s*branches: \[branch\],\s*fieldChanges: \[\],\s*branchId: branch\.id,\s*submitterRouteId: meRow\.ownedRouteId,/g)).toHaveLength(2);
  });

  it('the sealed CREATE row of a sent request carries it (lib/request-evidence.ts)', () => {
    const s = src('lib/request-evidence.ts');
    expect(s).toContain('routeIdAtSubmit: e.routeIdAtSubmit ?? null,');
    expect(s).toContain('regionIdsAtSubmit: [...(e.regionIdsAtSubmit ?? [])],');
  });

  it('nothing that decides who sees what reads it (owner question A6: not built)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
      });
    const readers = ['app', 'lib', 'services']
      .flatMap(walk)
      .filter((f) => /routeIdAtSubmit|regionIdsAtSubmit|ScopeAtSubmit/.test(src(f)))
      .map((f) => f.replace(/\\/g, '/'))
      .sort();
    expect(readers).toEqual([
      // Its classification and its foreign key's rule, not readers.
      'lib/compliance/pii-classification.ts',
      'lib/db-rules.ts',
      'lib/request-evidence.ts',
      'lib/scope-at-submit.ts',
      'services/creates.ts',
      'services/edits.ts',
      'services/reactivations.ts',
    ]);
  });
});
