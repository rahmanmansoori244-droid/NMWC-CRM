/**
 * Structural guards for F10, X-STATUS-1 and F13 (reactivation reject).
 *
 * The defects were "nobody called it" and "it ran outside the transaction":
 * a correct evidence check nobody made at decision time, a reactivation that
 * wrote a branch without re-reading it, an audit row written after its change
 * had already committed on its own. A later edit can quietly move any of these
 * back — the evidence read above the customer lock, the audit write out of the
 * transaction — and every behavioural test with a mocked client still passes.
 *
 * Read by the TypeScript parser, not by regex: comments are not nodes, so a
 * comment quoting `assertStatusEvidence(tx, …)` can neither satisfy nor trip a
 * guard. Each guard is also run on a small broken source, because a guard that
 * cannot fail is not a guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

type Call = { callee: string; args: string[]; start: number; node: ts.CallExpression };
type Fn = { sf: ts.SourceFile; calls: Call[]; txBodies: Array<[number, number]> };

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
      calls.push({ callee, args: n.arguments.map((a) => a.getText(sf)), start: n.getStart(sf), node: n });
      const body = n.arguments[0];
      if (callee.endsWith('.$transaction') && body) txBodies.push([body.getStart(sf), body.getEnd()]);
    }
    ts.forEachChild(n, walk);
  };
  walk(fn.body);
  return { sf, calls, txBodies };
}

const txOf = (f: Fn, c: Call) => f.txBodies.find(([a, b]) => c.start > a && c.start < b);

/** The nearest `if` whose THEN branch holds the call, within the function. */
function guardingIf(c: Call): ts.IfStatement | null {
  let child: ts.Node = c.node;
  for (let p = c.node.parent; p && !ts.isFunctionDeclaration(p); child = p, p = p.parent) {
    if (ts.isIfStatement(p) && p.thenStatement === child) return p;
  }
  return null;
}

/**
 * F10: the decision reads the request's evidence on the transaction client,
 * inside the same transaction as the customer's row lock, after that lock and
 * before the first write of the decision.
 */
function evidenceProblems(src: string, fnName: string, firstWrite: string): string[] {
  const f = readFn(src, fnName);
  if (!f) return [`${fnName} not found`];
  const out: string[] = [];
  const lock = f.calls.find((c) => c.callee === 'lockCustomerRow' && c.args[0] === 'tx' && txOf(f, c));
  const write = f.calls.find((c) => c.callee === firstWrite && txOf(f, c));
  const checks = f.calls.filter((c) => c.callee === 'assertStatusEvidence');
  if (!lock) out.push('no customer row lock inside a transaction');
  if (!write) out.push(`no ${firstWrite} inside a transaction`);
  if (checks.length === 0) out.push('no assertStatusEvidence call');
  for (const c of checks) {
    if (c.args[0] !== 'tx') out.push('evidence read on a client other than the transaction');
    if (!txOf(f, c) || (lock && txOf(f, c) !== txOf(f, lock))) out.push('evidence read outside the lock’s transaction');
    if (lock && c.start < lock.start) out.push('evidence read before the customer lock');
    if (write && c.start > write.start) out.push(`evidence read after ${firstWrite}`);
  }
  return out;
}

/** F13: every audit row and every claim of the decision commit in one transaction. */
function auditAtomicProblems(src: string, fnName: string): string[] {
  const f = readFn(src, fnName);
  if (!f) return [`${fnName} not found`];
  const out: string[] = [];
  const audits = f.calls.filter((c) => c.callee === 'writeAudit');
  const claims = f.calls.filter((c) => c.callee.endsWith('customerEdit.updateMany'));
  if (audits.length === 0) out.push('no writeAudit call');
  if (claims.length === 0) out.push('no claim');
  for (const a of audits) {
    if (a.args[0] !== 'tx') out.push(`writeAudit(${a.args[0]}, …) is not on the transaction client`);
    if (!txOf(f, a)) out.push('writeAudit outside a transaction');
  }
  for (const c of claims) {
    if (c.callee !== 'tx.customerEdit.updateMany') out.push(`${c.callee} is its own commit`);
    if (audits[0] && txOf(f, c) !== txOf(f, audits[0])) out.push('claim and audit row in different transactions');
  }
  if (f.calls.some((c) => c.callee === 'getAuditEnvelope' && txOf(f, c))) out.push('envelope built inside the transaction');
  return out;
}

const EDITS = readFileSync('services/edits.ts', 'utf8');
const REACT = readFileSync('services/reactivations.ts', 'utf8');

describe('F10: the evidence is re-read where the decision is made', () => {
  it('approving a close request: under the lock, before applyEditChanges', () => {
    expect(evidenceProblems(EDITS, 'approveEditCore', 'applyEditChanges')).toEqual([]);
  });

  it('…and a status-only request is always asked, evidence entry or not', () => {
    const f = readFn(EDITS, 'approveEditCore')!;
    const check = f.calls.find((c) => c.callee === 'assertStatusEvidence')!;
    const cond = guardingIf(check)?.expression.getText(f.sf) ?? '';
    // Guarded only by "is a close request": status-only OR carries evidence.
    expect(cond.replace(/\s+/g, ' ')).toBe('isStatusOnlyEdit || evidenceIds(edit.attachmentChanges).length > 0');
  });

  it('approving a reactivation: under the lock, before the branch write, unconditionally', () => {
    expect(evidenceProblems(REACT, 'approveReactivationCore', 'tx.branch.update')).toEqual([]);
    const f = readFn(REACT, 'approveReactivationCore')!;
    expect(guardingIf(f.calls.find((c) => c.callee === 'assertStatusEvidence')!)).toBeNull();
  });

  it('no reject path consults the evidence — a request whose photo is gone must stay rejectable', () => {
    for (const [src, fn] of [
      [EDITS, 'rejectEditCore'],
      [REACT, 'rejectReactivationCore'],
    ] as const) {
      const f = readFn(src, fn);
      expect(f, fn).not.toBeNull();
      expect(f!.calls.map((c) => c.callee), fn).not.toContain('assertStatusEvidence');
    }
  });

  it('the guard fires on a check moved above the lock, out of the transaction, or removed', () => {
    const broken = (body: string) => `async function approveReactivationCore() {
      const edit = await load();
      ${body}
    }`;
    expect(
      evidenceProblems(
        broken(`await prisma.$transaction(async (tx) => {
          await assertStatusEvidence(tx, edit);
          await lockCustomerRow(tx, edit.customerId!);
          await tx.branch.update({ where: { id: edit.branchId! } });
        });`),
        'approveReactivationCore',
        'tx.branch.update'
      )
    ).toContain('evidence read before the customer lock');
    expect(
      evidenceProblems(
        broken(`await assertStatusEvidence(prisma, edit);
        await prisma.$transaction(async (tx) => {
          await lockCustomerRow(tx, edit.customerId!);
          await tx.branch.update({ where: { id: edit.branchId! } });
        });`),
        'approveReactivationCore',
        'tx.branch.update'
      )
    ).toEqual(expect.arrayContaining(['evidence read on a client other than the transaction', 'evidence read outside the lock’s transaction']));
    expect(
      evidenceProblems(
        broken(`await prisma.$transaction(async (tx) => {
          await lockCustomerRow(tx, edit.customerId!);
          // await assertStatusEvidence(tx, edit);
          await tx.branch.update({ where: { id: edit.branchId! } });
        });`),
        'approveReactivationCore',
        'tx.branch.update'
      )
    ).toEqual(['no assertStatusEvidence call']);
  });
});

describe('X-STATUS-1: a reactivation re-reads the branch and customer before reopening', () => {
  it('both reads are on the transaction, after the lock and before the branch write', () => {
    const f = readFn(REACT, 'approveReactivationCore')!;
    const at = (callee: string) => f.calls.find((c) => c.callee === callee && txOf(f, c))?.start ?? -1;
    const lock = at('lockCustomerRow');
    const write = at('tx.branch.update');
    for (const read of ['tx.branch.findUnique', 'tx.customer.findUnique']) {
      expect(at(read), read).toBeGreaterThan(lock);
      expect(at(read), read).toBeLessThan(write);
    }
    expect(lock).toBeGreaterThan(-1);
  });

  it('it refuses a removed, moved or reopened branch and an archived customer', () => {
    const f = readFn(REACT, 'approveReactivationCore')!;
    // `new ConflictError('STATE_CHANGED', …)`, and the `if` that throws it.
    let conflict: ts.NewExpression | undefined;
    const find = (x: ts.Node): void => {
      if (
        ts.isNewExpression(x) &&
        x.expression.getText(f.sf) === 'ConflictError' &&
        x.arguments?.[0]?.getText(f.sf) === `'STATE_CHANGED'`
      ) {
        conflict = x;
      }
      ts.forEachChild(x, find);
    };
    find(f.sf);
    expect(conflict, 'the STATE_CHANGED refusal exists').toBeTruthy();
    let n: ts.Node | undefined = conflict;
    while (n && !ts.isIfStatement(n)) n = n.parent;
    const cond = (n as ts.IfStatement | undefined)?.expression.getText(f.sf).replace(/\s+/g, ' ') ?? '';
    for (const part of [
      '!branchNow',
      'branchNow.deletedAt',
      'branchNow.customerId !== edit.customerId',
      `branchNow.status !== 'CLOSED'`,
      '!customerNow',
      'customerNow.deletedAt',
    ]) {
      expect(cond, part).toContain(part);
    }
  });
});

describe('F13: rejecting a reactivation commits the decision and its audit row together', () => {
  it('the claim and writeAudit(tx, …) share one transaction; no writeAudit(null, …)', () => {
    expect(auditAtomicProblems(REACT, 'rejectReactivationCore')).toEqual([]);
  });

  it('approving one already did — and still does', () => {
    expect(auditAtomicProblems(REACT, 'approveReactivationCore')).toEqual([]);
  });

  it('the guard fires on the old shape: a claim that commits alone, then writeAudit(null, …)', () => {
    const old = `async function rejectReactivationCore() {
      const claim = await prisma.customerEdit.updateMany({ where: {} , data: {} });
      if (claim.count === 0) throw new Error('x');
      await writeAudit(null, await getAuditEnvelope(me.id), { action: 'REJECT' });
    }`;
    expect(auditAtomicProblems(old, 'rejectReactivationCore')).toEqual(
      expect.arrayContaining([
        'writeAudit(null, …) is not on the transaction client',
        'writeAudit outside a transaction',
        'prisma.customerEdit.updateMany is its own commit',
      ])
    );
  });
});
