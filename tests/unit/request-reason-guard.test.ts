// @vitest-environment node
/**
 * Code review 2026-11-10, finding 18 — a structural guard (CLAUDE.md: where the
 * defect is "somebody wrote it to the wrong place", pin the source; comments are
 * stripped first).
 *
 * The defect was one column written by everyone: the salesman's reason, every
 * approver's reason and every closure note all went to
 * CustomerEdit.decisionReason, so each writer destroyed what the one before it
 * wrote. The rules these tests hold the source to:
 *
 *  WRITERS
 *   - requestReason (the requester's own words) is written by the two submit
 *     writers in services/reactivations.ts and by nothing else — no decision, no
 *     merge, no withdrawal can replace it (the database also freezes it);
 *   - a requester's reason reaches decisionReason only through the rollback
 *     bridge (REQUEST_REASON_LEGACY_COPY);
 *   - every write that moves a request FORWARD clears decisionReason (the
 *     advance, the approval that creates the customer, the signed-form upload,
 *     a resubmit), so an answered send-back is never left looking current;
 *   - a refusal of a close or a reactivation writes no reason to the request.
 *
 *  READERS
 *   - every screen that says why a request came back reads it through
 *     lib/request-reasons.ts — from the decision rows (EditApproval), with the
 *     request row's own copy only as the fallback that module defines. No page
 *     prints CustomerEdit.decisionReason itself: that is how an approved request
 *     came to show an answered send-back, and a salesman only the last
 *     approver's words;
 *   - the requester's own reason is shown through requestReasonOf only;
 *   - the printouts and the e-mail read neither column: a printed trail comes
 *     from the decision rows (EditApproval), and an e-mail carries no reason.
 *
 * The behaviour is proven in request-reason-writers.test.ts,
 * request-reason-submit.test.ts and tests/integration/request-reasons.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}
const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);
const SOURCES = ['app', 'lib', 'services', 'components'].flatMap(files);
const code = new Map(SOURCES.map((f) => [f, src(f)] as const));

/** The text of one top-level `async function name(` up to the next top-level function. */
function fnBody(s: string, name: string): string {
  const start = s.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = /\n(?:export )?(?:async )?function /.exec(s.slice(start + 1));
  return s.slice(start, next ? start + 1 + next.index : undefined);
}

/** Every `data: { … }` object literal in `s` that follows `opener`, brace-matched. */
function objectsAfter(s: string, opener: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = s.indexOf(opener, from);
    if (at < 0) return out;
    const open = s.indexOf('{', at + opener.length - 1);
    let depth = 0;
    let end = open;
    for (let i = open; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.push(s.slice(open, end + 1));
    from = end + 1;
  }
}

const REACTIVATIONS = code.get('services/reactivations.ts')!;
const EDITS = code.get('services/edits.ts')!;

describe('requestReason: written once, by the submit, and by nothing else', () => {
  it('the files that name the column at all are the ones that define, write, seal or classify it', () => {
    const naming = [...code].filter(([, s]) => /\brequestReason\b/.test(s)).map(([f]) => f).sort();
    // No page is among them: the two screens that show it call requestReasonOf.
    expect(naming).toEqual([
      // The personal-data inventory's classification.
      'lib/compliance/pii-classification.ts',
      // The sealed CREATE audit row (`after.requestReason`).
      'lib/request-evidence.ts',
      // The one definition of how it is read.
      'lib/request-reasons.ts',
      // The two submit writers, and the REACTIVATE audit row.
      'services/reactivations.ts',
    ]);
  });

  it('both submits write it from the salesman’s typed reason, inside the request’s create', () => {
    for (const fn of ['requestReactivationOnce', 'markBranchClosedOnce']) {
      const body = fnBody(REACTIVATIONS, fn);
      const creates = objectsAfter(body, 'tx.customerEdit.create({');
      expect(creates, fn).toHaveLength(1);
      expect(creates[0], fn).toMatch(/\brequestReason: reason,/);
      // The reason is the form's own field, trimmed: nothing else is called `reason` here.
      expect(body, fn).toContain("const reason = String(formData.get('reason') ?? '').trim();");
    }
  });

  it('no update of a request row ever sets it — in any service or library', () => {
    for (const [f, s] of code) {
      for (const call of ['customerEdit.update({', 'customerEdit.updateMany({', 'customerEdit.upsert({']) {
        for (const obj of objectsAfter(s, call)) expect(obj, `${f}: ${call}`).not.toMatch(/\brequestReason\b/);
      }
    }
    // And no other create of a request row writes one (an update or a new-customer request has none).
    for (const [f, s] of code) {
      if (f === 'services/reactivations.ts') continue;
      for (const obj of objectsAfter(s, 'customerEdit.create({')) expect(obj, f).not.toMatch(/\brequestReason\b/);
    }
  });

  it('a requester’s reason reaches decisionReason only through the rollback bridge', () => {
    for (const fn of ['requestReactivationOnce', 'markBranchClosedOnce']) {
      const [create] = objectsAfter(fnBody(REACTIVATIONS, fn), 'tx.customerEdit.create({');
      expect(create, fn).toContain('...(REQUEST_REASON_LEGACY_COPY ? { decisionReason: reason } : {}),');
      // No unconditional copy beside it.
      expect(create!.match(/decisionReason/g), fn).toHaveLength(1);
    }
    // Nothing else in the file writes or reads the column: the decisions leave it alone.
    expect(REACTIVATIONS.match(/\bdecisionReason\b/g)).toHaveLength(2);
  });
});

describe('a decision never replaces the requester’s reason, and never leaves a stale one', () => {
  it('refusing a reactivation writes no reason to the request', () => {
    const body = fnBody(REACTIVATIONS, 'rejectReactivationCore');
    const [claim] = objectsAfter(body, 'tx.customerEdit.updateMany({');
    expect(claim).toContain('state: EditState.REJECTED');
    expect(claim).not.toMatch(/Reason/);
    // The Manager's reason goes to his decision row and the audit row.
    expect(body).toContain("reactivationDecision(edit, me, 'REJECTED', reason, decidedAt)");
  });

  it('approving a reactivation reads the request’s reason through requestReasonOf, and writes none', () => {
    const body = fnBody(REACTIVATIONS, 'approveReactivationCore');
    expect(body).toContain('const requestReason = requestReasonOf(edit);');
    const [claim] = objectsAfter(body, 'tx.customerEdit.updateMany({');
    expect(claim).not.toMatch(/Reason/);
  });

  it('rejectEditCore: a close request keeps what it has; any other request takes this rejection’s reason', () => {
    const body = fnBody(EDITS, 'rejectEditCore');
    // To the salesman: a close is excluded by name.
    expect(body).toContain('...(isCloseRequest ? {} : { decisionReason: reason }),');
    expect(body).toContain('const isCloseRequest = edit.target === EditTarget.BRANCH;');
    // Step-back: only a multi-step (new-customer) request can step back.
    expect(body.match(/decisionReason: reason/g)).toHaveLength(2);
    // The decision row always carries it.
    const [decision] = objectsAfter(body, 'tx.editApproval.create({');
    expect(decision).toMatch(/decision: 'REJECTED',[\s\S]*\breason,/);
  });

  it('approveEditCore: the advance and the approval that creates the customer clear it; the update apply does not touch it', () => {
    const claims = objectsAfter(fnBody(EDITS, 'approveEditCore'), 'const claim = await tx.customerEdit.updateMany({');
    expect(claims).toHaveLength(3);
    const [advance, create, update] = claims as [string, string, string];
    expect(advance).toContain('currentStepIndex: stepIndex + 1');
    expect(advance).toContain('decisionReason: null,');
    expect(advance).toContain('decisionCategory: null,');
    expect(create).toContain('reviewedAt: finalizedAt');
    expect(create).toContain('decisionReason: null,');
    expect(create).toContain('decisionCategory: null,');
    // A single-step update or close is never stepped back, and a close an older
    // build sent still carries the salesman's reason there (the rollback bridge).
    expect(update).toContain('state: EditState.APPROVED');
    expect(update).not.toMatch(/decisionReason|decisionCategory|requestReason/);
  });

  it('the signed-form upload and a resubmit clear it', () => {
    const [upload] = objectsAfter(code.get('services/signed-form.ts')!, 'const claim = await tx.customerEdit.updateMany({');
    expect(upload).toContain('currentStepIndex: expected.stepIndex + 1');
    expect(upload).toContain('decisionReason: null,');
    expect(upload).toContain('decisionCategory: null,');
    const creates = code.get('services/creates.ts')!;
    const submitFields = creates.slice(creates.indexOf('state: EditState.SUBMITTED,'), creates.indexOf('const creditFields'));
    expect(submitFields).toContain('decisionReason: null,');
    expect(submitFields).toContain('decisionCategory: null,');
  });

  it('a merge’s auto-close writes its own sentence, from the one definition, as a closure note', () => {
    const s = code.get('services/duplicates.ts')!;
    expect(s.match(/mergeClosedReason\(loser\.nmwcCode, winner\.nmwcCode\)/g)).toHaveLength(2);
    expect(s).toContain('decisionReason: mergeClosedReason(loser.nmwcCode, winner.nmwcCode),');
    expect(s).not.toContain('Auto-closed: customer');
  });

  it('the earlier reasons of a round are read only for an alert that reaches the salesman', () => {
    const body = fnBody(EDITS, 'rejectEditCore');
    expect(body).toMatch(
      /const reachesSalesman =\s+\(target\.kind === 'TO_SALESMAN' && !isCloseRequest\) \|\|\s+\(target\.kind === 'STEP_BACK' && isSignedFormStep\(rejectChain\[target\.toStepIndex\]\)\);/
    );
    // Read before the transaction opens, like the loop guard's count.
    // (The transaction runs inside ownLostClaim since finding 21's second round.)
    expect(body.indexOf('const earlierSendBacks')).toBeLessThan(body.indexOf('() => withChangeContext('));
    expect(body.indexOf('const earlierSendBacks')).toBeGreaterThan(body.indexOf('const priorRejectsHere'));
    // And used by exactly the two alerts he receives.
    expect(body).toContain('needsCorrectionBody(rejectRequestName, reason, earlierSendBacks)');
    expect(body).toContain('earlier: earlierSendBacks,');
    expect(body.match(/earlierSendBacks/g)).toHaveLength(3);
  });
});

describe('every screen reads a reason through lib/request-reasons.ts', () => {
  /** The salesman's pages for work that came back to him, and the function each reads it by. */
  const SALESMAN_PAGES: Array<[string, string]> = [
    ['app/(app)/customers/new/page.tsx', 'currentReason('],
    ['app/(app)/rejected/page.tsx', 'sentBackTrail('],
    ['app/(app)/work/page.tsx', 'sentBackTrail('],
    ['app/(app)/customers/[id]/page.tsx', 'sentBackTrail('],
    ['app/(app)/customers/[id]/edit/page.tsx', 'sentBackTrail('],
  ];
  const APPROVER_PAGES = ['app/(app)/approvals/[id]/page.tsx', 'app/(app)/reactivations/page.tsx'];

  it.each(SALESMAN_PAGES)('%s reads the round’s decisions, through %s', (f, reader) => {
    const s = code.get(f)!;
    expect(s, f).toContain(reader);
    // With the decisions: the one trail, loaded with the request.
    expect(s, f).toContain('steps: DECISION_TRAIL');
    expect(s, f).toMatch(/from '@\/lib\/request-reasons'/);
  });

  it('no page prints a request’s decisionReason itself', () => {
    const pages = [...code].filter(([f]) => f.startsWith('app/') || f.startsWith('components/'));
    expect(pages.length).toBeGreaterThan(50);
    const offenders = pages
      // `decisionReason: true` (a select, for the fallback) and `decisionReason: null`
      // (the new-customer page silencing the form's old banner) are not prints.
      .filter(([, s]) => /\.decisionReason\b/.test(s))
      .map(([f]) => f)
      .sort();
    // The form still has the banner the page no longer feeds; it goes when the
    // form is next edited (docs/handover/04-PENDING-WORK.md B9.2). Until then the
    // page must hand it no reason, so the banner can never render.
    const FORM = 'app/(app)/customers/new/CreateCustomerForm.tsx';
    expect(offenders.filter((f) => f !== FORM)).toEqual([]);
    const page = code.get('app/(app)/customers/new/page.tsx')!;
    if (offenders.includes(FORM)) expect(page).toContain('decisionReason: null,');
    expect(page).not.toMatch(/decisionReason: edit\./);
  });

  it('no library reads the column either, but the ones that define it or write a closure note', () => {
    const naming = [...code].filter(([f, s]) => f.startsWith('lib/') && /\bdecisionReason\b/.test(s)).map(([f]) => f).sort();
    expect(naming).toEqual([
      // Closes a customer's drafts when it is archived: a closure note.
      'lib/archive-open-requests.ts',
      // The personal-data inventory's classification.
      'lib/compliance/pii-classification.ts',
      // The one definition of how it is read (the fallback for rows with no decision rows).
      'lib/request-reasons.ts',
      // Withdraws a request with an account change: a closure note.
      'lib/stranded-creates.ts',
    ]);
  });

  it('the approver’s page: the salesman’s reason through requestReasonOf, the decision box through currentReason', () => {
    const s = code.get('app/(app)/approvals/[id]/page.tsx')!;
    expect(s).toContain('const salesmanReason = requestReasonOf(edit, edit.steps);');
    expect(s).toContain('const decidedNow = currentReason(edit, edit.steps);');
    // The decision box prints a reason only for a send-back, a refusal or a closure note.
    const kinds = [...s.matchAll(/decidedNow\?\.kind === '([A-Z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(kinds)].sort()).toEqual(['CLOSED', 'REFUSED', 'SENT_BACK']);
    // …and the only quoted reasons on the page come from those, the salesman's note and the chain list.
    expect(s).not.toMatch(/edit\.(decisionReason|requestReason)/);
  });

  it('the Reactivations queue shows the requester’s reason through requestReasonOf', () => {
    const s = code.get('app/(app)/reactivations/page.tsx')!;
    expect(s).toContain("<strong>Reason:</strong> {requestReasonOf(e) ?? '—'}");
    for (const f of APPROVER_PAGES) expect(code.get(f), f).not.toMatch(/\.decisionReason\b/);
  });

  it('the earlier send-backs are rendered by the one component, on the pages a salesman reads', () => {
    const users = [...code].filter(([f, s]) => f.startsWith('app/') && s.includes('EarlierSendBacks')).map(([f]) => f).sort();
    expect(users).toEqual(['app/(app)/customers/new/page.tsx', 'app/(app)/rejected/page.tsx']);
  });
});

describe('printouts and e-mail read neither reason column', () => {
  it('lib/print-load.ts builds a printed trail from the decision rows', () => {
    const s = code.get('lib/print-load.ts')!;
    expect(s).not.toMatch(/decisionReason|requestReason/);
    expect(s).toMatch(/editApproval|steps/);
  });

  it('no lib/email module names either', () => {
    const email = files('lib/email');
    expect(email.length).toBeGreaterThan(0);
    for (const f of email) expect(code.get(f), f).not.toMatch(/decisionReason|requestReason/);
  });
});
