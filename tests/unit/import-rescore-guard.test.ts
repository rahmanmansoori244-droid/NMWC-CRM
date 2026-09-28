/**
 * Auditor recheck 2026-09-27, F21 part 2 and F16 in the import: the structural
 * half of what tests/unit/customer-import-service.test.ts proves on a fake.
 *
 * The defects this guards were "nobody wrote it": the promote rescored only the
 * customer, so a branch it created stayed at 0; neither branch write bumped
 * version; and the full lane's row-note reset replaced a note set before it. A
 * new branch write or a rewritten score block can bring each back without any
 * behaviour test noticing, because each test drives the paths that exist.
 * Asserted against services/imports.ts with its comments stripped.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';

const src = stripComments(readFileSync('services/imports.ts', 'utf8'), 'imports.ts');

/** The text of the call starting at `from`, up to its matching close paren. */
function callAt(from: number): string {
  let depth = 0;
  for (let i = src.indexOf('(', from); i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')' && --depth === 0) return src.slice(from, i + 1);
  }
  throw new Error('unbalanced call');
}
const callsOf = (name: string) =>
  [...src.matchAll(new RegExp(name.replace(/[.$]/g, (c) => `\\${c}`) + '\\(', 'g'))].map((m) =>
    callAt(m.index!)
  );

describe('services/imports.ts: branch writes, scores and row notes', () => {
  it('every branch update carries version + 1, as an approved edit does (B-05)', () => {
    const updates = callsOf('tx.branch.update');
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u).toMatch(/version: \{ increment: 1 \}/);
    const upserts = callsOf('tx.branch.upsert');
    expect(upserts.length).toBeGreaterThan(0);
    for (const u of upserts) {
      const update = u.slice(u.indexOf('update:'), u.indexOf('create:'));
      expect(update).toMatch(/version: \{ increment: 1 \}/);
    }
    // No bulk branch write that would bypass it.
    expect(callsOf('tx.branch.updateMany')).toEqual([]);
  });

  it('the full lane writes a branch only when the row changes it', () => {
    const loop = src.slice(
      src.indexOf('for (const r of fullBranches)'),
      src.indexOf('tx.branch.upsert(')
    );
    expect(loop).toMatch(
      /if \(branchOwner && differingBranchCells\(r, branchOwner\)\.length === 0\) continue;/
    );
  });

  it('the promote rescores through lib/rescore.ts, and writes no score of its own', () => {
    expect(callsOf('rescoreCustomerTx')).toEqual(['rescoreCustomerTx(tx, [customerId])']);
    expect(src).not.toMatch(/completenessScore\s*:/);
    expect(src).not.toMatch(/\bscoreCustomer\b|\bscoreBranch\b/);
  });

  it('the full lane merges its row reset, so the lead row keeps the sub-channel note', () => {
    expect(src).toMatch(
      /for \(const i of fullIdx\) rowNotes\[i\] = \{ \.\.\.rowNotes\[i\], note: null, written: true \};/
    );
    // The note is set before that reset, on the lead row, only when the clear is.
    const note = src.indexOf('rowNotes[plainIdx[0]] = {');
    expect(note).toBeGreaterThan(src.indexOf('if (clearSub) {'));
    expect(note).toBeLessThan(src.indexOf('for (const i of fullIdx) rowNotes[i]'));
    expect(callsOf('tx.customer.upsert')[0]).toMatch(/subChannelId: clearSub \? null : undefined,/);
  });
});
