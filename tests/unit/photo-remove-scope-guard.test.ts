import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../support/strip-comments';

const source = stripComments(readFileSync('services/photos.ts', 'utf8'));
const remove = source.slice(source.indexOf('async function detachPhotoCore('));
const transaction = 'await prisma.$transaction(async (tx) => {';
const recheck = 'await assertCanAccessAttachment(sessionUser, now, scope, tx);';

function assertLockedScope(code: string) {
  const start = code.indexOf(transaction);
  expect(start).toBeGreaterThan(-1);
  const tx = code.slice(start);
  const lock = tx.indexOf('await lockCustomer(tx, ownerId)');
  const read = tx.indexOf('await tx.attachment.findFirst(');
  const wiring = tx.indexOf("if (moved) throw new ConflictError('PHOTO_CHANGED'");
  const scope = tx.indexOf(recheck);
  expect(lock).toBeGreaterThan(-1);
  expect(read).toBeGreaterThan(lock);
  expect(wiring).toBeGreaterThan(read);
  expect(scope).toBeGreaterThan(wiring);
  for (const write of [
    'tx.attachment.updateMany(', 'tx.customer.updateMany(', 'tx.branch.updateMany(',
    'tx.branch.update(', 'tx.customer.update(', 'writeAudit(',
  ]) {
    expect(tx.indexOf(write), write).toBeGreaterThan(scope);
  }
}

describe('Remove scope is rechecked through the transaction before any write', () => {
  it('locks, rereads and checks wiring before rechecking scope against the current photo', () => {
    assertLockedScope(remove);
  });

  it('rejects a missing, pre-lock, pooled-client or stale-photo check', () => {
    // Use a valid specimen even before the fix, so these controls independently
    // prove the guard can reject each regression rather than an absent anchor.
    const without = remove.replace(recheck, '');
    const anchor = "if (moved) throw new ConflictError('PHOTO_CHANGED', PHOTO_CHANGED_MESSAGE);";
    expect(without).toContain(anchor);
    const valid = without.replace(anchor, anchor + '\n' + recheck);
    expect(() => assertLockedScope(valid)).not.toThrow();
    for (const invalid of [
      without,
      without.replace(transaction, transaction + '\n' + recheck),
      valid.replace(recheck, 'await assertCanAccessAttachment(sessionUser, now, scope, prisma);'),
      valid.replace(recheck, 'await assertCanAccessAttachment(sessionUser, att, scope, tx);'),
    ]) expect(() => assertLockedScope(invalid)).toThrow();
  });
});
