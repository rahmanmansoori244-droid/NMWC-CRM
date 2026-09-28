/**
 * Structural guards for the photo claims (N06, X-PHOTO-1) and the upload role
 * gate (ENH-3). Behaviour is proved with Prisma mocked in
 * photo-attach-service.test.ts and photo-upload-roles.test.ts; these pin the
 * shape that makes it hold under concurrency, which a mock cannot show:
 *
 *  - attach claims the photo with ONE guarded write straight after the
 *    customer's lock, before the previous slot photo is soft-deleted and before
 *    any slot, score or audit write — never with an unconditional update by id;
 *  - attach reads its target (the customer, or the branch and its customer)
 *    again after the lock and refuses a changed one before that claim;
 *  - Remove reads the photo again inside its transaction before any write, and
 *    soft-deletes only through a write guarded on the wiring it read; a photo
 *    removed already is PHOTO_GONE, and only after every check;
 *  - the three claims of a photo (attach, a new-customer request's claim, and
 *    its bind at the final approval) share one "live and on no slot" fragment;
 *  - presign and finalize refuse a role after the sign-in check and before the
 *    rate-limit bucket, R2 and the database.
 *
 * Comments are stripped first (tests/support/strip-comments.ts), so a comment
 * quoting what is asserted can neither satisfy nor trip a guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';
import { UNWIRED_LIVE } from '@/lib/photo-attach';

const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

/** The text of every `$transaction( … )` call in `code`, parentheses matched. */
function transactions(code: string): string[] {
  const out: string[] = [];
  const TOKEN = '$transaction(';
  for (let i = code.indexOf(TOKEN); i !== -1; i = code.indexOf(TOKEN, i + TOKEN.length)) {
    let depth = 0;
    let j = i + TOKEN.length - 1;
    for (; j < code.length; j++) {
      if (code[j] === '(') depth += 1;
      else if (code[j] === ')' && --depth === 0) break;
    }
    out.push(code.slice(i, j + 1));
  }
  return out;
}

/** The body of `async function <name>` up to the next top-level function. */
function fn(code: string, name: string): string {
  const start = code.indexOf(`async function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = code.slice(start + 1).search(/\n(export )?(async )?function /);
  return next === -1 ? code.slice(start) : code.slice(start, start + 1 + next);
}

/** Offset of the first match, -1 if none. */
const at = (text: string, re: RegExp) => text.search(re);

/**
 * N06: in each attach transaction, the guarded claim is the first write, right
 * after the lock, and everything else is gated on it taking one row.
 */
function assertClaimFirst(tx: string) {
  const lock = at(tx, /await lockCustomer\(tx, /);
  const claim = at(tx, /await tx\.attachment\.updateMany\(\{\s*where: claimWhere\(/);
  const gate = at(tx, /if \(claim\.count !== 1\) \{\s*await assertOnRequestedSlot\(tx, /);
  expect(lock).toBeGreaterThan(-1);
  expect(claim).toBeGreaterThan(lock);
  expect(gate).toBeGreaterThan(claim);
  for (const write of [
    /tx\.attachment\.update\(/,
    /tx\.branch\.update\(/,
    /tx\.customer\.update\(/,
    /tx\.branch\.findUniqueOrThrow\(/,
    /tx\.customer\.findUniqueOrThrow\(/,
    /writeAudit\(/,
  ]) {
    const w = at(tx, write);
    if (w !== -1) expect(w, String(write)).toBeGreaterThan(gate);
  }
}

/**
 * Post-merge review (2026-09-29), the mirror of X-PHOTO-1 and X-STATUS-1 on
 * attach: the target read before any lock is read again after it, and a changed
 * one is refused, before the claim. `reads` are those reads; `conditions` the
 * parts the refusal's condition must hold: the customer live for the CR slot;
 * the branch live, still under the customer that was locked, and that customer
 * live for a branch slot.
 */
function assertTargetReadAgain(tx: string, reads: RegExp[], conditions: string[]) {
  const lock = at(tx, /await lockCustomer\(tx, /);
  const claim = at(tx, /await tx\.attachment\.updateMany\(\{\s*where: claimWhere\(/);
  const refuse = at(tx, /throw new ConflictError\('PHOTO_CHANGED', PHOTO_TARGET_CHANGED_MESSAGE\)/);
  expect(lock, 'the lock').toBeGreaterThan(-1);
  for (const read of reads) {
    const r = at(tx, read);
    expect(r, String(read)).toBeGreaterThan(lock);
    expect(refuse, `the refusal after ${String(read)}`).toBeGreaterThan(r);
  }
  expect(claim, 'the claim after the refusal').toBeGreaterThan(refuse);
  const cond = /if \(([^{]*)\)\s*\{\s*throw new ConflictError\('PHOTO_CHANGED', PHOTO_TARGET_CHANGED_MESSAGE\)/.exec(tx)?.[1] ?? '';
  const flat = cond.replace(/\s+/g, ' ');
  for (const part of conditions) expect(flat, part).toContain(part);
}

const CR_READ = [/const customerNow = await tx\.customer\.findUnique\(\{ where: \{ id: c\.id \}, select: \{ deletedAt: true \} \}\)/];
const CR_COND = ['!customerNow', 'customerNow.deletedAt'];
const BRANCH_READ = [
  /const branchNow = await tx\.branch\.findUnique\(\{\s*where: \{ id: b\.id \},\s*select: \{ customerId: true, deletedAt: true \},?\s*\}\)/,
  /const customerNow = await tx\.customer\.findUnique\(\{\s*where: \{ id: b\.customerId \},\s*select: \{ deletedAt: true \},?\s*\}\)/,
];
const BRANCH_COND = ['!branchNow', 'branchNow.deletedAt', 'branchNow.customerId !== b.customerId', '!customerNow', 'customerNow.deletedAt'];

describe('N06: attach claims the photo first, guarded', () => {
  const photos = src('services/photos.ts');
  const attach = fn(photos, 'attachPhotoCore');
  const txs = transactions(attach);

  it('both attach transactions (the CR slot, a branch slot) claim before anything else', () => {
    expect(txs).toHaveLength(2);
    for (const tx of txs) assertClaimFirst(tx);
  });

  it('both read their target again under the lock and refuse a changed one before the claim', () => {
    const [cr, branch] = txs as [string, string];
    expect(cr).toMatch(/await lockCustomer\(tx, c\.id\)/);
    expect(branch).toMatch(/await lockCustomer\(tx, b\.customerId\)/);
    assertTargetReadAgain(cr, CR_READ, CR_COND);
    assertTargetReadAgain(branch, BRANCH_READ, BRANCH_COND);
  });

  it('the re-read guard fails on a re-read above the lock, a claim above the refusal, or a condition left out', () => {
    const tx = (body: string) => `$transaction(async (tx) => {
      ${body}
    })`;
    const READ = `const customerNow = await tx.customer.findUnique({ where: { id: c.id }, select: { deletedAt: true } });`;
    const LOCK = `await lockCustomer(tx, c.id);`;
    const REFUSE = `if (!customerNow || customerNow.deletedAt) {
        throw new ConflictError('PHOTO_CHANGED', PHOTO_TARGET_CHANGED_MESSAGE);
      }`;
    const CLAIM = `const claim = await tx.attachment.updateMany({ where: claimWhere(att.id, data, null), data: {} });`;
    expect(() => assertTargetReadAgain(tx([LOCK, READ, REFUSE, CLAIM].join('\n')), CR_READ, CR_COND)).not.toThrow();
    expect(() => assertTargetReadAgain(tx([READ, LOCK, REFUSE, CLAIM].join('\n')), CR_READ, CR_COND)).toThrow();
    expect(() => assertTargetReadAgain(tx([LOCK, READ, CLAIM, REFUSE].join('\n')), CR_READ, CR_COND)).toThrow();
    expect(() => assertTargetReadAgain(tx([LOCK, CLAIM].join('\n')), CR_READ, CR_COND)).toThrow();
    const noTombstone = REFUSE.replace(' || customerNow.deletedAt', '');
    expect(() => assertTargetReadAgain(tx([LOCK, READ, noTombstone, CLAIM].join('\n')), CR_READ, CR_COND)).toThrow();
  });

  it('never wires the photo with an unconditional update by id', () => {
    expect(attach).not.toMatch(/tx\.attachment\.update\(\{\s*where: \{ id: att\.id \}/);
  });

  it('the claim re-asserts live, on no slot, unclaimed, the uploader and the kind', () => {
    const start = photos.indexOf('\nfunction claimWhere(');
    expect(start).toBeGreaterThan(-1);
    const body = photos.slice(start, photos.indexOf('\n}\n', start));
    expect(body).toMatch(/\.\.\.UNWIRED_LIVE,/);
    expect(body).toMatch(/editId: null,/);
    expect(body).toMatch(/capturedById \? \{ capturedById \} : \{\}/);
    expect(body).toMatch(/kind: AttachmentKind\[data\.slot\]/);
  });

  it('the guard fails on the shape it replaced', () => {
    // A structural guard that cannot fail is not a guard.
    const before = `$transaction(async (tx) => {
      await lockCustomer(tx, c.id);
      const prev = (await tx.customer.findUniqueOrThrow({ where: { id: c.id } })).crPhotoId;
      if (prev) await tx.attachment.update({ where: { id: prev }, data: {} });
      await tx.attachment.update({ where: { id: att.id }, data: { customerId: c.id } });
    })`;
    expect(() => assertClaimFirst(before)).toThrow();
    const late = `$transaction(async (tx) => {
      await lockCustomer(tx, c.id);
      if (prev) await tx.attachment.update({ where: { id: prev }, data: {} });
      const claim = await tx.attachment.updateMany({ where: claimWhere(att.id, data, null), data: {} });
      if (claim.count !== 1) { await assertOnRequestedSlot(tx, att.id, data); return false; }
    })`;
    expect(() => assertClaimFirst(late)).toThrow();
  });
});

describe('X-PHOTO-1: Remove reads again under the lock and soft-deletes only guarded', () => {
  const detach = fn(src('services/photos.ts'), 'detachPhotoCore');
  const txs = transactions(detach);

  it('one transaction: lock, read again, then the writes', () => {
    expect(txs).toHaveLength(1);
    const tx = txs[0];
    const lock = at(tx, /if \(ownerId\) await lockCustomer\(tx, ownerId\)/);
    const reread = at(tx, /await tx\.attachment\.findFirst\(\{ where: \{ id: att\.id, deletedAt: null \} \}\)/);
    const refuse = at(tx, /if \(moved\) throw new ConflictError\('PHOTO_CHANGED'/);
    expect(lock).toBeGreaterThan(-1);
    expect(reread).toBeGreaterThan(lock);
    expect(refuse).toBeGreaterThan(reread);
    for (const write of [
      /tx\.attachment\.updateMany\(/,
      /tx\.customer\.updateMany\(/,
      /tx\.branch\.updateMany\(/,
      /tx\.branch\.update\(/,
      /tx\.customer\.update\(/,
      /writeAudit\(/,
    ]) {
      const w = at(tx, write);
      expect(w, String(write)).toBeGreaterThan(refuse);
    }
  });

  // Post-merge review (2026-09-29): removed already is PHOTO_GONE, the one answer
  // the photo slot clears on. Before the transaction it is given only after the
  // scope, role and uploader checks, so NOT_FOUND stays the scope's answer and
  // says nothing about whether the id exists; under the lock, the re-read that
  // finds no live photo gives it before any write.
  it('removed already is PHOTO_GONE: after every check before the transaction, and first under the lock', () => {
    expect(detach).toMatch(/const att = await prisma\.attachment\.findFirst\(\{\s*where: \{ id: parsed\.data\.attachmentId \},?\s*\}\);/);
    const gone = at(detach, /if \(att\.deletedAt\) throw new ConflictError\('PHOTO_GONE', PHOTO_GONE_MESSAGE\);/);
    expect(gone, 'the PHOTO_GONE answer before the transaction').toBeGreaterThan(-1);
    for (const check of [
      /await assertCanAccessAttachment\(sessionUser, att, scope\);/,
      /if \(!PHOTO_WRITER_ROLES\.includes\(session\.user\.role\)\) \{/,
      /throw new ForbiddenError\('You can only remove photos you captured\.'\);/,
    ]) {
      const c = at(detach, check);
      expect(c, String(check)).toBeGreaterThan(-1);
      expect(gone, `PHOTO_GONE after ${String(check)}`).toBeGreaterThan(c);
    }
    expect(gone).toBeLessThan(at(detach, /\$transaction\(/));
    const tx = txs[0];
    const reread = at(tx, /await tx\.attachment\.findFirst\(\{ where: \{ id: att\.id, deletedAt: null \} \}\)/);
    const goneNow = at(tx, /if \(!now\) throw new ConflictError\('PHOTO_GONE', PHOTO_GONE_MESSAGE\);/);
    expect(goneNow).toBeGreaterThan(reread);
    expect(goneNow).toBeLessThan(at(tx, /if \(moved\) throw new ConflictError\('PHOTO_CHANGED'/));
    // Only these two say it; NotFoundError is never "gone".
    expect(detach.match(/'PHOTO_GONE'/g)).toHaveLength(2);
  });

  it('the soft-delete is guarded on the wiring it read, and must take one row', () => {
    const tx = txs[0];
    expect(tx).not.toMatch(/tx\.attachment\.update\(/);
    expect(tx).toMatch(
      /const gone = await tx\.attachment\.updateMany\(\{\s*where: \{ id: att\.id, deletedAt: null, \.\.\.wiring \},\s*data: \{ deletedAt: new Date\(\), hash: null \},?\s*\}\);\s*if \(gone\.count !== 1\) throw new ConflictError\('PHOTO_CHANGED'/
    );
    expect(detach).toMatch(
      /const wiring = \{\s*customerId: att\.customerId,\s*branchId: att\.branchId,\s*branchExtraId: att\.branchExtraId,\s*editId: att\.editId,?\s*\};/
    );
  });
});

describe('one "live and on no slot" fragment for every claim of a photo', () => {
  it('is those four columns', () => {
    expect(UNWIRED_LIVE).toEqual({ deletedAt: null, customerId: null, branchId: null, branchExtraId: null });
  });

  it("the new-customer request's claim and its bind at the final approval use it", () => {
    expect(src('services/creates.ts')).toMatch(
      /tx\.attachment\.updateMany\(\{\s*where: \{\s*id: \{ in: attachmentIds \},\s*\.\.\.UNWIRED_LIVE,/
    );
    const finalize = src('lib/create-finalize.ts');
    expect(finalize).toMatch(/where: \{\s*id: attachmentId,\s*\.\.\.UNWIRED_LIVE,\s*editId: edit\.id,?\s*\}/);
  });
});

describe('ENH-3: presign and finalize refuse a role before any cost', () => {
  const ROLE = /if \(!canUploadPhoto\(session\.user\.role\)\) return refuseRole\(\);/;
  const KIND = /if \(!canUploadPhoto\(session\.user\.role, kind\)\) return refuseRole\(\);/;
  // The sign-in check (F15: signed out, or a password to change first), and the
  // session the role is read from, taken from it. The anchor must be found:
  // compared against a check that was no longer there (-1), "after the sign-in
  // check" held for a role gate anywhere, even one ahead of checkActor.
  const SIGNED_IN = /const who = await checkActor\(\);\s*if \(!who\.ok\)/;
  const SESSION = /const session = \{ user: who\.user \};/;

  /** The role gate comes after the sign-in check, on the session it passed. */
  function roleAfterSignIn(code: string, role: number) {
    const signedIn = at(code, SIGNED_IN);
    expect(signedIn, 'the sign-in check').toBeGreaterThan(-1);
    const session = at(code, SESSION);
    expect(session, 'the session from the sign-in check').toBeGreaterThan(signedIn);
    expect(role).toBeGreaterThan(session);
  }

  it('presign: the role before the rate-limit bucket, the kind before a URL is signed', () => {
    const p = src('app/api/photos/presign/route.ts');
    const role = at(p, ROLE);
    const kind = at(p, KIND);
    roleAfterSignIn(p, role);
    expect(at(p, /await checkLimit\(/)).toBeGreaterThan(role);
    expect(kind).toBeGreaterThan(role);
    expect(at(p, /await getSignedUrl\(/)).toBeGreaterThan(kind);
  });

  it('finalize: the role before the body is read, the kind before R2 and the database', () => {
    const f = src('app/api/photos/finalize/route.ts');
    const role = at(f, ROLE);
    const kind = at(f, KIND);
    roleAfterSignIn(f, role);
    expect(at(f, /await req\.json\(\)/)).toBeGreaterThan(role);
    expect(kind).toBeGreaterThan(role);
    for (const after of [/new HeadObjectCommand\(/, /prisma\.attachment\.findFirst\(/, /prisma\.attachment\.create\(/]) {
      expect(at(f, after), String(after)).toBeGreaterThan(kind);
    }
  });

  it('the gate is the roles that attach and remove a photo', () => {
    const perms = src('lib/permissions.ts');
    const can = perms.slice(perms.indexOf('export function canUploadPhoto('));
    expect(can.slice(0, can.indexOf('\n}\n'))).toMatch(/if \(!PHOTO_WRITER_ROLES\.includes\(role\)\) return false;/);
  });
});
