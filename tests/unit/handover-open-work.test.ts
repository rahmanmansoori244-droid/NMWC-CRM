// @vitest-environment node
/**
 * Gap 37 (data audit 2026-10-10): when a salesman leaves, the Steward is shown
 * his open requests and drafts; the ledger now keeps that list too, as
 * `after.openWork` on the hand-over rows.
 *
 *  - openWorkRecord (lib/account-edit.ts): each list sorted with each id once,
 *    a withdrawn id taken out of the others, each list capped at 200, the counts
 *    whole, the photo count a whole number;
 *  - structural (comments stripped, per CLAUDE.md): every REASSIGN writer — the
 *    hand-over on /users and the account import — the disable row and the
 *    account_edit row of a route or role change carry openWork, read by
 *    loadOpenWork inside the transaction after its withdrawals; and the loader
 *    reads ids and a count only.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { OPEN_WORK_LIST_CAP, openWorkRecord } from '@/lib/account-edit';
import { stripComments } from '../support/strip-comments';

const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

describe('openWorkRecord', () => {
  it('sorted, each id once, a withdrawn id out of the other lists, counts whole', () => {
    const r = openWorkRecord({
      inReview: ['e3', 'e1', 'e3'],
      drafts: ['d2', 'w1'],
      sentBack: ['s1', 'w2', 's1'],
      withdrawn: ['w2', 'w1'],
      unattachedPhotos: 4,
    });
    expect(r).toEqual({
      inReview: ['e1', 'e3'],
      drafts: ['d2'],
      sentBack: ['s1'],
      withdrawn: ['w1', 'w2'],
      counts: { inReview: 2, drafts: 1, sentBack: 1, withdrawn: 2 },
      unattachedPhotos: 4,
    });
  });

  it('each list capped at 200, the counts whole', () => {
    expect(OPEN_WORK_LIST_CAP).toBe(200);
    const ids = (p: string) => Array.from({ length: 230 }, (_, i) => `${p}${String(i).padStart(3, '0')}`);
    const r = openWorkRecord({ inReview: ids('a'), drafts: ids('b'), sentBack: ids('c'), withdrawn: ids('w'), unattachedPhotos: 1.7 });
    for (const k of ['inReview', 'drafts', 'sentBack', 'withdrawn'] as const) {
      expect(r[k]).toHaveLength(200);
      expect(r.counts[k]).toBe(230);
    }
    expect(r.unattachedPhotos).toBe(1);
    expect(openWorkRecord({ inReview: [], drafts: [], sentBack: [], withdrawn: [], unattachedPhotos: -3 }).unattachedPhotos).toBe(0);
  });
});

describe('every hand-over row carries openWork (structural)', () => {
  it('the hand-over on /users: the leaver’s REASSIGN row', () => {
    const s = src('services/users.ts');
    const fn = s.slice(s.indexOf('async function handOverRoute('), s.indexOf('async function handOverNotes('));
    expect(fn).toContain('const openWork = await loadOpenWork(tx, p.from.id);');
    const reassign = fn.slice(fn.indexOf("action: 'REASSIGN'"));
    expect(reassign).toContain("after: { ownedRouteCode: null, ...(p.retired ? { username: p.retired } : {}), openWork }");
    // Read after his route was taken, inside the hand-over's transaction.
    expect(fn.indexOf('data: { ownedRouteId: null')).toBeLessThan(fn.indexOf('loadOpenWork('));
  });

  it('the disable row, after the withdrawals it made', () => {
    const s = src('services/users.ts');
    const fn = s.slice(s.indexOf('async function toggleUserActiveCore('), s.indexOf('export async function resetPasswordAction('));
    expect(fn).toContain('await loadOpenWork(tx, userId, atSignedForm.map((e) => e.id))');
    expect(fn.indexOf('withdrawWithAccountChange(')).toBeLessThan(fn.indexOf('loadOpenWork('));
    expect(fn).toMatch(/after: \{ isActive: updated\.isActive, \.\.\.\(openWork \? \{ openWork \} : \{\}\) \}/);
  });

  it('the account_edit row of a route or role change, after the withdrawals it made', () => {
    const s = src('services/users.ts');
    const fn = s.slice(s.indexOf('export async function updateUserAccountAction('), s.indexOf('export async function updateUserEmailAction('));
    expect(fn).toMatch(/before\.route !== after\.route \|\| before\.role !== after\.role\s*\?\s*await loadOpenWork\(tx, target\.id, strandedCreates\.map\(\(e\) => e\.id\)\)/);
    expect(fn.lastIndexOf('withdrawWithAccountChange(')).toBeLessThan(fn.indexOf('loadOpenWork('));
    const row = fn.slice(fn.indexOf("reason: 'account_edit'") - 400, fn.indexOf("reason: 'account_edit'"));
    expect(row).toContain('{ ...audit.after, openWork }');
  });

  it('the account import: each displaced owner’s REASSIGN row', () => {
    const s = src('services/imports.ts');
    const at = s.indexOf("action: 'REASSIGN'");
    expect(at).toBeGreaterThan(-1);
    expect(s.indexOf("action: 'REASSIGN'", at + 1)).toBe(-1);
    const around = s.slice(at - 300, at + 600);
    expect(around).toContain('const openWork = await loadOpenWork(tx, u.id);');
    expect(around).toMatch(/ownedRouteCode: null,\s*batchId: batch\.id,\s*openWork,/);
  });

  it('every REASSIGN writer in app, lib and services is one of those two', () => {
    const files = ['services/users.ts', 'services/imports.ts', 'services/routes.ts', 'services/customers.ts', 'lib/account-import.ts'];
    let n = 0;
    for (const f of files) {
      let s = '';
      try {
        s = src(f);
      } catch {
        continue;
      }
      n += (s.match(/action: 'REASSIGN'/g) ?? []).length;
    }
    expect(n).toBe(2);
  });

  it('the loader reads ids and one count, inside the caller’s transaction', () => {
    const s = src('lib/open-work.ts');
    expect(s).toContain('state: EditState.SUBMITTED');
    expect(s).toContain('state: EditState.DRAFT');
    expect(s).toContain('openReturnedIds(tx, userId)');
    expect(s).toMatch(/attachment\.count\(\{\s*where: \{ capturedById: userId, deletedAt: null, customerId: null, branchId: null, branchExtraId: null, editId: null \}/);
    expect(s.match(/select: \{ id: true \}/g)).toHaveLength(2);
  });
});
