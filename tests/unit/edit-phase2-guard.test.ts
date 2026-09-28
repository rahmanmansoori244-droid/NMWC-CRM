/**
 * Structural guards for phase 2's server part (auditor recheck 2026-09-27:
 * F05, F06, F19, F20). Each defect here was, or would be, "nobody called it":
 * a correct helper the approval stops passing, a gate fed the whole customer
 * again, a check moved out from under the lock. The mocked-Prisma tests
 * (edit-service.test.ts, edit-approval-service.test.ts) prove the behaviour;
 * these pin that the code still takes the path they prove.
 *
 * Read by the TypeScript parser, so a comment quoting a call can neither
 * satisfy nor trip a guard; the regex checks run on comment-stripped source.
 * Every guard is also run on a broken copy, because a guard that cannot fail
 * is not a guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { stripComments } from '../support/strip-comments';

type Call = { callee: string; args: string[]; start: number };
type Fn = { calls: Call[]; txBodies: Array<[number, number]> };

function readFn(src: string, name: string): Fn | null {
  const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let fn: ts.FunctionDeclaration | undefined;
  const find = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) fn = n;
    else ts.forEachChild(n, find);
  };
  find(sf);
  if (!fn?.body) return null;
  const calls: Call[] = [];
  const txBodies: Array<[number, number]> = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf).replace(/\s+/g, '');
      calls.push({ callee, args: n.arguments.map((a) => a.getText(sf)), start: n.getStart(sf) });
      const body = n.arguments[0];
      if (callee.endsWith('.$transaction') && body) txBodies.push([body.getStart(sf), body.getEnd()]);
    }
    ts.forEachChild(n, walk);
  };
  walk(fn.body);
  return { calls, txBodies };
}
const txOf = (f: Fn, c: Call) => f.txBodies.find(([a, b]) => c.start > a && c.start < b);
const first = (f: Fn, callee: string) => f.calls.find((c) => c.callee === callee);

const EDITS = readFileSync('services/edits.ts', 'utf8');

/**
 * Ruling 6 (F05): the mandatory-field gate is fed the gate's branch set — the
 * identifier `gateBranches`, or a `salesmanBranches(` call — never a customer's
 * whole `.branches`. That was the defect: another route's missing GPS blocked a
 * salesman who could neither see nor fix it.
 */
function gateProblems(src: string): string[] {
  const out: string[] = [];
  let calls = 0;
  for (const fnName of ['submitEditOnce', 'approveEditCore']) {
    const f = readFn(src, fnName);
    if (!f) {
      out.push(`${fnName} not found`);
      continue;
    }
    for (const c of f.calls.filter((x) => x.callee === 'collectMissingMandatory')) {
      calls += 1;
      const arg = c.args[1] ?? '';
      if (!(arg === 'gateBranches' || /^salesmanBranches\(/.test(arg))) {
        out.push(`${fnName}: collectMissingMandatory(…, ${arg}, …)`);
      }
    }
  }
  if (calls !== 2) out.push(`${calls} gate calls, expected the submit's and the approval's`);
  return out;
}

/**
 * F06 at approval: under the customer's lock, the stored changes are planned
 * against the row read under it (planApproval), before the gate re-check and
 * before the write — all in the claim's transaction.
 */
function approvalOrderProblems(src: string): string[] {
  const f = readFn(src, 'approveEditCore');
  if (!f) return ['approveEditCore not found'];
  const lock = f.calls.find((c) => c.callee === 'lockCustomerRow' && txOf(f, c));
  const read = f.calls.find((c) => c.callee === 'tx.customer.findUnique' && txOf(f, c));
  const plan = first(f, 'planApproval');
  const gate = first(f, 'collectMissingMandatory');
  const write = first(f, 'applyEditChanges');
  const steps = { lock, read, plan, gate, write };
  const out: string[] = [];
  for (const [k, v] of Object.entries(steps)) if (!v) out.push(`no ${k}`);
  if (out.length) return out;
  const t = txOf(f, lock!);
  for (const [k, v] of Object.entries(steps)) if (txOf(f, v!) !== t) out.push(`${k} outside the lock's transaction`);
  if (!(lock!.start < read!.start && read!.start < plan!.start && plan!.start < gate!.start && gate!.start < write!.start)) {
    out.push('not lock → read → plan → gate → write');
  }
  return out;
}

/** F06, the Steward/Manager direct write: locked and re-judged before its request row exists. */
function directWriteProblems(src: string): string[] {
  const f = readFn(src, 'submitEditOnce');
  if (!f) return ['submitEditOnce not found'];
  const create = f.calls.find((c) => c.callee === 'tx.customerEdit.create');
  if (!create) return ['no direct-write request row'];
  const t = txOf(f, create);
  const inTx = (callee: string) => f.calls.find((c) => c.callee === callee && txOf(f, c) === t);
  const out: string[] = [];
  for (const callee of ['lockCustomerRow', 'tx.customer.findUnique', 'classifyChanges', 'applyEditChanges']) {
    if (!inTx(callee)) out.push(`no ${callee} in the direct write's transaction`);
  }
  if (out.length) return out;
  if (!(inTx('lockCustomerRow')!.start < inTx('tx.customer.findUnique')!.start)) out.push('read before the lock');
  if (!(inTx('classifyChanges')!.start < create.start)) out.push('request row before the plan is judged');
  return out;
}

/** The old form's body is refused before its fields are read, and after the replay lookup. */
function outdatedProblems(src: string): string[] {
  const f = readFn(src, 'submitEditOnce');
  if (!f) return ['submitEditOnce not found'];
  const check = f.calls.find((c) => c.callee === 'isCurrentEditPayload' && c.args[0] === 'input');
  const parse = f.calls.find((c) => c.callee === 'submitEditSchema.safeParse');
  const bases = first(f, 'keysWithoutBase');
  const read = first(f, 'prisma.customer.findUnique');
  if (!check || !parse || !bases || !read) return ['a step is missing'];
  const out: string[] = [];
  if (check.start > parse.start) out.push('format checked after the parse');
  if (!(parse.start < bases.start && bases.start < read.start)) out.push('bases checked out of place');
  return out;
}

describe('phase 2 — the server takes the path its tests prove', () => {
  it('ruling 6: the gate is fed the gate’s branch set, never a customer’s whole branch list', () => {
    expect(gateProblems(EDITS)).toEqual([]);
    const broken = EDITS.replace(/(collectMissingMandatory\(\s*now,\s*)gateBranches,/, '$1now.branches,');
    expect(broken).not.toBe(EDITS);
    expect(gateProblems(broken)).toEqual(['approveEditCore: collectMissingMandatory(…, now.branches, …)']);
    const commented = EDITS.replace(/(collectMissingMandatory\(\s*customer,\s*)gateBranches,/, '$1/* gateBranches */ customer.branches,');
    expect(gateProblems(commented)).toEqual(['submitEditOnce: collectMissingMandatory(…, customer.branches, …)']);
  });

  it('the approval: lock → read → plan → gate → write, in the claim’s transaction', () => {
    expect(approvalOrderProblems(EDITS)).toEqual([]);
    // The lock taken only after the plan was made: the plan read an unlocked row.
    const lockLate = EDITS.replace('await lockCustomerRow(tx, edit.customerId!);', '').replace(
      'const write = payloadFromFieldChanges(classified.apply);',
      'await lockCustomerRow(tx, edit.customerId!);\n      const write = payloadFromFieldChanges(classified.apply);'
    );
    expect(lockLate).not.toBe(EDITS);
    expect(approvalOrderProblems(lockLate)).toEqual(['not lock → read → plan → gate → write']);
    // The approval's read taken on the pooled client, outside the transaction.
    const at = EDITS.indexOf('async function approveEditCore');
    const readOutside =
      EDITS.slice(0, at) +
      EDITS.slice(at).replace('const now = await tx.customer.findUnique({', 'const now = await prisma.customer.findUnique({');
    expect(approvalOrderProblems(readOutside)).toEqual(['no read']);
  });

  it('the direct write locks, reads and re-judges before its request row', () => {
    expect(directWriteProblems(EDITS)).toEqual([]);
    const unlocked = EDITS.replace('await lockCustomerRow(tx, customer.id);', '');
    expect(unlocked).not.toBe(EDITS);
    expect(directWriteProblems(unlocked)).toEqual(["no lockCustomerRow in the direct write's transaction"]);
  });

  it('a body in the old format is refused after the replay lookup and before its fields are read', () => {
    expect(outdatedProblems(EDITS)).toEqual([]);
    const late = EDITS.replace('  if (!isCurrentEditPayload(input)) throw new FormOutdatedError();\n', '').replace(
      '  if (keysWithoutBase(parsed.data).length > 0)',
      '  if (!isCurrentEditPayload(input)) throw new FormOutdatedError();\n  if (keysWithoutBase(parsed.data).length > 0)'
    );
    expect(late).not.toBe(EDITS);
    expect(outdatedProblems(late)).toEqual(['format checked after the parse']);
  });

  it('F19: the service never normalizes a phone itself — the schema validates, then normalizes', () => {
    const src = stripComments(EDITS, 'edits.ts');
    expect(src).not.toMatch(/\bnormalizePhone\(/);
    expect(src).toMatch(/import \{[^}]*\bsubmitEditSchema\b[^}]*\} from '@\/lib\/validation\/edit'/);
  });
});
