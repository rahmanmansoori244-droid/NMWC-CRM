// @vitest-environment node
/**
 * Lossless paths (data audit 2026-10-10, gaps 4, 7, 8, 12, 14, 15, 19, 20, 27):
 * structural guards, per CLAUDE.md ("structural guards over behavioural ones
 * where the defect is 'nobody called it'"). Comments are stripped first.
 *
 * Each says one thing a write path must keep doing so that what it changed, or
 * what it was about, is not lost. The database side (the evidence guard, the
 * photo history, the append-only ledgers) is pinned by
 * tests/unit/history-migration-guard.test.ts and proven on Postgres by the gated
 * suites tests/integration/{import-lineage,merge-record,edit-revision,
 * edit-evidence-guard,export-record,photo-history,finalize-birth}.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { stripComments } from '../support/strip-comments';

const read = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

/** The text of the first `name(` call's argument list, parentheses matched. */
function callArgs(src: string, name: string, from = 0): string {
  const at = src.indexOf(`${name}(`, from);
  expect(at, name).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = at + name.length; i < src.length; i++) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unclosed ${name}(`);
}

describe('gap 15: a removed or replaced photo keeps its fingerprint', () => {
  it('no write in app/, lib/ or services/ wipes Attachment.hash', () => {
    const offenders = ['app', 'lib', 'services']
      .flatMap(walk)
      .filter((f) => /\bhash:\s*null\b/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('a slot write names the photo it replaced, and the replaced one gets a SOFT_DELETE row', () => {
    const src = read('services/photos.ts');
    expect(src.match(/replacedAttachmentId:/g)?.length).toBe(2);
    expect(src.match(/await softDeleteReplaced\(tx, env, /g)?.length).toBe(3);
    expect(callArgs(src, 'async function softDeleteReplaced')).toBeTruthy();
    expect(src).toMatch(/action: 'SOFT_DELETE',\s*entityType: 'Attachment'/);
  });

  it("a release at a new-customer resubmit and of a signed application's page has its SOFT_DELETE row", () => {
    for (const f of ['services/creates.ts', 'services/signed-form.ts']) {
      expect(read(f), f).toMatch(/for \(const a of released\) \{\s*await writeAudit\(tx, env, \{\s*action: 'SOFT_DELETE'/);
    }
  });
});

describe('gaps 4 and 7: an import names its file, its row and what it changed', () => {
  const src = read('services/imports.ts');

  it('both uploads keep the file’s SHA-256 and size on the batch', () => {
    expect(src.match(/fileSha256: sha256Hex\(buf\),\s*fileBytes: buf\.length,/g)?.length).toBe(2);
  });

  it('a created customer names the sheet row that created it', () => {
    expect(src).toMatch(/importBatchId: batchId,\s*importRowId: g\.rowIds\[leadIdx\],/);
  });

  it('the full lane writes only the cells that differ, and none for an unchanged customer', () => {
    expect(src).toMatch(/const customerChanged = existing \? differingCells\(customerWrite, existing\) : null;/);
    expect(src).toMatch(/if \(existing && customerChanged!\.length === 0\) \{\s*customerId = existing\.id;\s*customerUnchanged = true;/);
  });

  it('the refresh lane writes only the cells that differ, and still flips UPLOADED to SYNCED', () => {
    const at = src.indexOf('const refreshChanged = differingCells(refreshWrite, existing!);');
    expect(at).toBeGreaterThan(-1);
    expect(src.indexOf('if (refreshChanged.length > 0) {', at)).toBeGreaterThan(at);
    expect(src.indexOf("where: { id: existing!.id, temixSyncState: 'UPLOADED' }", at)).toBeGreaterThan(at);
  });

  it('every created or changed customer and shop has its audit row, under its own sheet row', () => {
    expect(src.match(/await auditEntity\(/g)?.length).toBeGreaterThanOrEqual(6);
    expect(src).toMatch(/afterWrite: \(k, branchId, change\) =>\s*auditEntity\(laneIdx\[k\]!/);
    expect(src).toContain('const auditEntity = async (');
    expect(src).toMatch(/reason: importAuditReason\(batchId, lineage\.rowNumber, lineage\.lane\)/);
  });

  it("a Steward's correction records the cells, as values or fingerprints", () => {
    expect(read('services/import-fixes.ts')).toMatch(/cells: correctionAudit\(/);
  });
});

describe('gap 8: a merge says what moved, and where the loser went', () => {
  const src = read('services/duplicates.ts');
  it('the loser points at the winner, its shops move with a version bump, each closed request has its REJECT row', () => {
    expect(src).toMatch(/deletedAt: new Date\(\),\s*mergedIntoId: winner\.id,/);
    expect(src).toMatch(/data: \{ customerId: winner\.id, lastEditedById: session\.id, version: \{ increment: 1 \} \}/);
    expect(src).toMatch(/for \(const e of autoClosed\) \{\s*await writeAudit\(tx, env, \{\s*action: 'REJECT',/);
  });
  it('the MERGE row lists the moved shops, documents and requests and keeps the typed reason', () => {
    const merge = src.slice(src.indexOf("action: 'MERGE'"));
    for (const k of ['movedBranchIds', 'movedAttachmentIds', 'repointedEditIds', 'autoClosedEditIds', 'loserSnapshot']) {
      expect(merge, k).toContain(k);
    }
    expect(merge).toMatch(/: reason\s*\?\s*`Merged \$\{loser\.nmwcCode\} into \$\{winner\.nmwcCode\}\. \$\{reason\}`/);
  });
});

describe('gaps 12 and 27: a new-customer request keeps every round and every birth', () => {
  it('every submit (not a draft) writes its EditRevision in the submit transaction', () => {
    const src = read('services/creates.ts');
    const tx = src.slice(src.indexOf('const edit = await withChangeContext(prisma, cause, async (tx) => {'));
    expect(tx).toMatch(/if \(!isDraft\) \{\s*const drafts = await tx\.editBranchDraft\.findMany\(/);
    expect(tx).toMatch(/await tx\.editRevision\.create\(\{/);
    expect(tx).toMatch(/duplicateSignals,/);
  });
  it('a submit refused as a duplicate is recorded in its own transaction', () => {
    const src = read('services/creates.ts');
    expect(src).toMatch(/DUPLICATE_REFUSALS\.has\(err\.code\)\) \{\s*await recordRefusedDuplicate\(/);
    expect(src).toMatch(/entityType: 'CustomerCreateAttempt',/);
  });
  it('finalize links each draft to its shop and writes the shop’s birth row', () => {
    const src = read('lib/create-finalize.ts');
    expect(src).toMatch(/await tx\.editBranchDraft\.update\(\{ where: \{ id: b\.id \}, data: \{ branchId: branch\.id \} \}\);/);
    expect(src).toMatch(/action: 'CREATE',\s*entityType: 'Branch',/);
    expect(src).toMatch(/const draftsInOrder = \[\.\.\.edit\.branchDrafts\]\.sort\(/);
  });
  it('a rejection keeps its category on the decision row and in the ledger', () => {
    const src = read('services/edits.ts');
    const reject = src.slice(src.indexOf('async function rejectEditCore'));
    expect(reject).toMatch(/reason,\s*category,/);
    expect(reject).toMatch(/decisionCategory: category,\s*\} as unknown as Prisma\.InputJsonValue/);
  });
});

describe('gaps 19 and 20: a request, once sent, is in the ledger as sent', () => {
  it('a salesman’s update submit and every close and reactivation submit write a CustomerEdit CREATE row with it', () => {
    const edits = read('services/edits.ts');
    expect(edits).not.toMatch(/prisma\.customerEdit\.create\(/);
    expect(edits).toMatch(/action: 'CREATE',\s*entityType: 'CustomerEdit',\s*entityId: e\.id,\s*reason: 'request sent',\s*after: sentRequestAudit\(e\),/);
    const react = read('services/reactivations.ts');
    expect(react.match(/after: sentRequestAudit\(e\),/g)?.length).toBe(2);
    expect(react.match(/attachmentChanges: \[evidenceEntry\(att, branch\.lastStatusChangeAt\)\]/g)?.length).toBe(2);
  });
  it('an approval says what it wrote; a direct write lists every applied change', () => {
    const edits = read('services/edits.ts');
    expect(edits).toMatch(/\.\.\.approvalOutcome\(\{/);
    expect(edits).toMatch(/applied: appliedList,/);
  });
  it('a reopening records its request, evidence and the closure it was checked against', () => {
    const react = read('services/reactivations.ts');
    const row = react.slice(react.indexOf("action: 'REACTIVATE'"));
    for (const k of ['editId', 'evidenceAttachmentId', 'evidenceCapturedAt', 'branchLastStatusChangeAtAtRequest', 'closureReference', 'managerReason']) {
      expect(row, k).toContain(k);
    }
    // Read before the write that moves the closure time.
    expect(react.indexOf('const atRequest = readEvidenceEntry(edit.attachmentChanges);')).toBeLessThan(
      react.indexOf("status: 'ACTIVE',\n        lastEditedById: me.id,")
    );
  });
});

describe('gap 14: every export is recorded with its file and customers before it is sent', () => {
  it('each export path calls recordExport with the bytes it sends', () => {
    for (const [f, kind] of [
      ['services/exports.ts', 'customer-master'],
      ['services/customer-export.ts', 'customers-filtered'],
      ['app/api/exports/changes/route.ts', 'field-updates'],
    ] as const) {
      const src = read(f);
      expect(src, f).toContain(`kind: '${kind}'`);
      expect(callArgs(src, 'recordExport'), f).toMatch(/customerIds/);
    }
  });
});
