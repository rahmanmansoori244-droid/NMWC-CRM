// @vitest-environment node
/**
 * Owner decision 7 (2026-10-07): every path that changes a branch's status makes
 * the customer's status follow it, through lib/customer-status.ts. A guard on
 * the source, because the defect this prevents is "a path that never called it"
 * (CLAUDE.md, structural guards): the reactivation path used to keep its own
 * rule (every branch active), and the import's branch-only lane had none.
 * Comments are stripped first, so a comment naming the helper does not count.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stripComments } from '../support/strip-comments';

const src = (file: string) => stripComments(readFileSync(path.join(process.cwd(), file), 'utf8'), file);

/** The body of `name` — from its declaration to the next top-level function. */
function body(file: string, name: string): string {
  const s = src(file);
  const start = s.search(new RegExp(`\\n(export )?async function ${name}\\(`));
  expect(start, `${file} declares ${name}`).toBeGreaterThan(-1);
  const rest = s.slice(start + 1);
  const next = rest.slice(1).search(/\n(export )?(async )?function /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('the customer status follows its shops on every path that changes a branch status', () => {
  it('applyEditChanges (an approved close, a Manager or Steward direct write) records the change and follows it', () => {
    const b = body('services/edits.ts', 'applyEditChanges');
    expect(b).toMatch(/statusEvents\(\s*currentBranch\.status/);
    expect(b).toMatch(/await followBranchStatus\(/);
    // Both callers hand it the envelope, so the move is audited.
    expect(src('services/edits.ts').match(/await applyEditChanges\([^;]*\{\s*env,/g) ?? []).toHaveLength(2);
  });

  it('approving a reactivation follows the same rule — no rule of its own', () => {
    const b = body('services/reactivations.ts', 'approveReactivationCore');
    expect(b).toMatch(/await followBranchStatus\(/);
    expect(b).not.toMatch(/\.every\(/);
    expect(b).not.toMatch(/customer\.update\(\{[^}]*where[^}]*\}[^)]*status:/s);
  });

  it('the import follows what each group changed, on every lane', () => {
    const s = src('services/imports.ts');
    expect(s).toMatch(/const statusBefore = existing\s*\?\s*await liveBranchStatuses\(tx, existing\.id\)/);
    expect(s).toMatch(/await followBranchStatus\(\s*tx,\s*env,\s*customerId,\s*branchStatusEvents\(statusBefore, await liveBranchStatuses\(tx, customerId\)\)/);
  });
});
