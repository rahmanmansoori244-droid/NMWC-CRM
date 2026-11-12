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
    // The loop's row is `sheetRow` since the code review of 2026-11-10 (finding
    // 1): what the sheet gives. `r`, which the skip and the write still read, is
    // what the CRM field rule lets the import write (below).
    const start = src.indexOf('for (const [k, sheetRow] of fullBranches.entries())');
    expect(start).toBeGreaterThan(-1);
    const loop = src.slice(start, src.indexOf('tx.branch.upsert('));
    expect(loop).toMatch(
      /if \(branchOwner && differingBranchCells\(r, branchOwner\)\.length === 0\) continue;/
    );
  });

  // Code review 2026-11-10, finding 1: a re-import replaced CRM-owned values on
  // every customer with no Temix code on record. The rule that stops it is only
  // as good as the places that call it, so they are pinned.
  it('every write of a customer or shop that exists goes through the CRM field rule first', () => {
    // Full lane, shops: the rule narrows the row BEFORE the skip and the upsert,
    // and the upsert's update reads the narrowed row.
    const start = src.indexOf('for (const [k, sheetRow] of fullBranches.entries())');
    const upsert = src.indexOf('tx.branch.upsert(');
    const loop = src.slice(start, upsert);
    // Owner's answer 2026-11-11 ("A1 stop"): a shop that exists first keeps its
    // route (lib/import-shop-route.ts), then the rule narrows that row. This
    // pinned `branchCrmRule(overwriteCrm, sheetRow, branchOwner)`.
    const held = loop.indexOf('const held = branchOwner ? holdShopRoute(sheetRow, branchOwner, routeById) : null;');
    expect(held).toBeGreaterThan(-1);
    const rule = loop.indexOf('const crm = branchCrmRule(overwriteCrm, held ? held.row : sheetRow, branchOwner);');
    expect(rule).toBeGreaterThan(held);
    expect(loop.indexOf('const r = crm.row;')).toBeGreaterThan(rule);
    expect(loop.indexOf('differingBranchCells(r, branchOwner)')).toBeGreaterThan(loop.indexOf('const r = crm.row;'));
    const update = callAt(upsert);
    expect(update.slice(update.indexOf('update:'), update.indexOf('create:'))).not.toMatch(/sheetRow\./);

    // Full lane, the customer: the write is built from the narrowed sheet, never from the row.
    expect(src).toMatch(/const crmCustomer = customerCrmRule\(\s*overwriteCrm,/);
    const write = /const customerWrite: Record<string, unknown> = \{[\s\S]*?\n\s*\};/.exec(src)![0];
    expect(write).toMatch(/legalName: crmCustomer\.sheet\.custName,/);
    expect(write).not.toMatch(/\blead\.(custName|phone|contactPerson|crNumber)\b/);
    expect(write).not.toMatch(/\bgroupChannelId\b/);

    // Fixed rows (the branch-only lane): the update reads the narrowed row.
    const lane = src.slice(src.indexOf('async function refreshLaneBranches('), src.indexOf('async function writeLaneNotes('));
    // Owner's answer 2026-11-11: the row with the shop's own route (`h`), then the rule (this pinned `branchCrmRule(overwriteCrm, r, found)`).
    expect(lane).toMatch(/const held = holdShopRoute\(r, found, routeById\);\s*const h = held\.row;/);
    expect(lane).toMatch(/const rule = branchCrmRule\(overwriteCrm, h, found\);\s*const w = rule\.row;/);
    const laneUpdate = lane.slice(lane.indexOf('tx.branch.update('));
    expect(laneUpdate.slice(0, laneUpdate.indexOf('version: { increment: 1 }'))).not.toMatch(/\br\.(nameGiven|sheetAddress|dayOfVisit|status)\b/);

    // The status a sheet states is not read for a customer that exists, unless the option is on.
    expect(src).toMatch(
      /const statedStatus: CustomerStatus \| null = existing && !overwriteCrm \? null : sheetStatus;/
    );
    // The option is the batch's, read in the preflight and held by the claim.
    expect(src).toMatch(/const overwriteCrm = preflight\.overwriteCrmFields === true;/);
    expect(callsOf('prisma.importBatch.updateMany')[0]).toMatch(/overwriteCrmFields: overwriteCrm,/);
    // The lane is decided in lib/import-plan.ts, which the summary also runs.
    expect(src).toMatch(/const lane = decideLane\(\{/);
  });

  it('the promote rescores through lib/rescore.ts, and writes no score of its own', () => {
    expect(callsOf('rescoreCustomerTx')).toEqual(['rescoreCustomerTx(tx, [customerId])']);
    expect(src).not.toMatch(/completenessScore\s*:/);
    expect(src).not.toMatch(/\bscoreCustomer\b|\bscoreBranch\b/);
  });

  it('the full lane merges its row reset, so the lead row keeps the sub-channel note', () => {
    // Since the owner's answer of 2026-11-11 the reset also sets the row's route
    // note, per row (fullIdx.forEach); it still spreads what the row had first.
    const reset =
      /fullIdx\.forEach\(\(i, k\) => \{[^}]*?rowNotes\[i\] = \{\s*\.\.\.rowNotes\[i\],\s*note: null,\s*written: true,/.exec(src);
    expect(reset).not.toBeNull();
    // The note is set before that reset, on the lead row, only when the clear is.
    const note = src.indexOf('rowNotes[plainIdx[0]] = {');
    expect(note).toBeGreaterThan(src.indexOf('if (clearSub) {'));
    expect(note).toBeLessThan(reset!.index);
    // Gap 4 (lossless paths): the write is built once (customerWrite), and the
    // upsert sends only the cells of it that differ from the stored customer.
    expect(src).toMatch(/const customerWrite: Record<string, unknown> = \{[\s\S]*?subChannelId: clearSub \? null : undefined,/);
    expect(callsOf('tx.customer.upsert')[0]).toMatch(/customerChanged \?\? Object\.keys\(customerWrite\)/);
  });
});
