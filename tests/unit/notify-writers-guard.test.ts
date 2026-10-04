// @vitest-environment node
/**
 * F1 (2026-10-05): the salesman-request notifications are written where they
 * commit with the request, and nowhere else.
 *
 * Structural, because the defects this guards are of the "nobody called it" and
 * "called it in the wrong place" kind (CLAUDE.md, Tests):
 *   - CREATE, CLOSE and REACTIVATION write their rows on the transaction that
 *     writes the request, so a refused insert or a lost race leaves none;
 *   - UPDATE writes them after its autocommitted insert, inside the existing
 *     best-effort try (a notify failure must never fail a committed submit), for
 *     a salesman's non-draft submit only;
 *   - no decision path (approve, reject, reactivation decisions, bulk) writes
 *     them: edit-approval-service.test.ts pins exactly one notifyUsers on an
 *     UPDATE final approval, and the owner asked for the salesman's actions only.
 * Comments are stripped first: a comment quoting a call is not a call.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../support/strip-comments';

const src = (path: string) => stripComments(readFileSync(path, 'utf8'), path);

/** The text of one top-level `async function name(` up to the next one. */
function fnBody(s: string, name: string): string {
  const start = s.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = s.indexOf('\nasync function ', start + 1);
  return s.slice(start, next === -1 ? undefined : next);
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

describe('where the hierarchy is told of a salesman request', () => {
  it('exactly four call sites, all in the salesman submit paths', () => {
    const sites = ['app', 'lib', 'services', 'components']
      .flatMap(files)
      .flatMap((f) => (src(f).match(/\bnotifySalesmanRequest\(/g) ?? []).map(() => f))
      .filter((f) => f !== 'lib/notify-hierarchy.ts');
    expect(sites.sort()).toEqual([
      'services/creates.ts',
      'services/edits.ts',
      'services/reactivations.ts',
      'services/reactivations.ts',
    ]);
  });

  it('CREATE: on the submit transaction, after the existing first-step row', () => {
    const s = fnBody(src('services/creates.ts'), 'submitCreateOnce');
    const tx = s.indexOf('prisma.$transaction(async (tx) =>');
    const firstStep = s.indexOf("kind: 'EDIT_SUBMITTED'");
    const call = s.indexOf('notifySalesmanRequest(tx, {');
    const txEnd = s.indexOf('}, { timeout: 20_000');
    expect(tx).toBeGreaterThan(-1);
    expect(firstStep).toBeGreaterThan(tx);
    expect(call).toBeGreaterThan(firstStep);
    expect(txEnd).toBeGreaterThan(call);
    expect(s.slice(call, call + 300)).toMatch(/event: 'CREATE'/);
    expect(s.slice(call, call + 400)).toMatch(/alreadyTold: audience/);
  });

  it.each([
    ['requestReactivationOnce', 'REACTIVATION', 'reactivate'],
    ['markBranchClosedOnce', 'CLOSE', 'close'],
  ])('%s: the insert and its rows in one transaction; the P2002 translated outside it', (fn, event, kind) => {
    const s = fnBody(src('services/reactivations.ts'), fn);
    const tx = s.indexOf('prisma.$transaction(async (tx) =>');
    const insert = s.indexOf('tx.customerEdit.create(');
    const call = s.indexOf('notifySalesmanRequest(tx, {');
    const conflict = s.indexOf(`}).catch((err: unknown) =>`);
    expect(tx, 'transaction').toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(tx);
    expect(call).toBeGreaterThan(insert);
    expect(conflict).toBeGreaterThan(call);
    expect(s.slice(conflict, conflict + 200)).toContain(`openEditConflict(err, me.id, branch.customerId, { kind: '${kind}'`);
    expect(s.slice(call, call + 300)).toContain(`event: '${event}'`);
    // The pooled client never writes this request: everything goes through tx.
    expect(s).not.toMatch(/\bprisma\.customerEdit\.create\(/);
    // The salesman's free-text reason is the request's, never a notification's.
    expect(s.slice(call, s.indexOf('return e;', call))).not.toMatch(/\breason\b/);
  });

  it('UPDATE: after the autocommitted insert, inside the best-effort try, for a salesman only', () => {
    const s = fnBody(src('services/edits.ts'), 'submitEditOnce');
    const insert = s.indexOf('edit = await prisma.customerEdit.create(');
    const guard = s.indexOf('if (!isDraft) {', insert);
    const tryAt = s.indexOf('try {', guard);
    const salesman = s.indexOf('if (me.role === Role.SALESMAN) {', tryAt);
    const call = s.indexOf('notifySalesmanRequest(prisma, {', salesman);
    const caught = s.indexOf("'edit.submit.notify_failed'", call);
    for (const [name, at] of Object.entries({ insert, guard, tryAt, salesman, call, caught })) {
      expect(at, name).toBeGreaterThan(-1);
    }
    expect(s.slice(call, call + 300)).toContain("event: 'UPDATE'");
    expect(s.slice(call, call + 600)).toContain('alreadyTold: firstAudience');
  });

  it('no decision path writes them', () => {
    const edits = src('services/edits.ts');
    for (const fn of ['approveEditCore', 'rejectEditCore']) {
      expect(fnBody(edits, fn), fn).not.toContain('notifySalesmanRequest');
    }
    const reacts = src('services/reactivations.ts');
    for (const fn of ['approveReactivationCore', 'rejectReactivationCore']) {
      expect(fnBody(reacts, fn), fn).not.toContain('notifySalesmanRequest');
    }
  });

  it('the hierarchy module writes only through notifyUsers, and never imports the e-mail code', () => {
    const s = src('lib/notify-hierarchy.ts');
    expect(s).not.toMatch(/\.notification\.(create|createMany|update|updateMany)\(/);
    expect(s).toMatch(/\bnotifyUsers\(db, audience\.mustAct,/);
    expect(s).toMatch(/\bnotifyUsers\(db, audience\.fyi,/);
    expect(s).not.toMatch(/from '\.\/email|from '@\/lib\/email/);
  });
});
