// @vitest-environment node
/**
 * Gap 37: a request can no longer land on a customer archived a moment earlier,
 * and the archive's record of the requests it left is tidy.
 *
 *  - structural (comments stripped, per CLAUDE.md): every transaction that
 *    writes a request on an existing customer takes the customer's row lock and
 *    reads deletedAt again before its insert — the UPDATE submit, the draft
 *    save, close and reactivation through lockLiveCustomer, the direct write as
 *    it already did — and the archive checks for a request in review only after
 *    taking the same lock. A new-customer request has no customer yet, so
 *    services/creates.ts is not one of them;
 *  - openRequestsRecord: sorted, each id once, capped, with whole counts.
 *
 * The archive's own behaviour is in tests/unit/archive-temix-shared-code.test.ts;
 * the real race on Postgres in tests/integration/archive-open-requests.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';
import { ARCHIVE_REQUEST_LIST_CAP, openRequestsRecord } from '@/lib/archive-open-requests';

const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

describe('every request insert on a customer locks it first', () => {
  it.each(['services/edits.ts', 'services/reactivations.ts'])('%s', (file) => {
    const s = src(file);
    const inserts = [...s.matchAll(/tx\.customerEdit\.create\(/g)].map((m) => m.index!);
    expect(inserts.length).toBeGreaterThan(0);
    for (const at of inserts) {
      // The transaction (or helper) the insert is written in: from its opening to the insert.
      const open = Math.max(s.lastIndexOf('withChangeContext(', at), s.lastIndexOf('async function saveUpdateDraft(', at));
      expect(open, `${file}@${at}`).toBeGreaterThan(-1);
      const body = s.slice(open, at);
      const locked = /lockLiveCustomer\(tx, /.test(body) || (/lockCustomerRow\(tx, /.test(body) && /deletedAt\) throw new NotFoundError/.test(body));
      expect(locked, `${file}: the insert at ${at} does not lock its customer first`).toBe(true);
    }
  });

  it('lockLiveCustomer locks the row, then reads deletedAt again and refuses an archived customer', () => {
    const s = src('lib/locks.ts');
    const fn = s.slice(s.indexOf('export async function lockLiveCustomer'));
    expect(fn.indexOf('await lockCustomerRow(tx, customerId)')).toBeGreaterThan(-1);
    expect(fn.indexOf('await lockCustomerRow(tx, customerId)')).toBeLessThan(fn.indexOf('select: { deletedAt: true }'));
    expect(fn).toMatch(/if \(!now \|\| now\.deletedAt\) throw new NotFoundError\(CUSTOMER_ARCHIVED_MESSAGE\)/);
  });

  it('the archive checks for a request in review only after the lock, and closes the drafts after its claim', () => {
    const s = src('services/customers.ts');
    const lock = s.indexOf('await lockCustomersAndTemixCodeHolders(tx,');
    const review = s.indexOf("where: { customerId, state: EditState.SUBMITTED }");
    const claim = s.indexOf('const claim = await tx.customer.updateMany(');
    const close = s.indexOf('await closeOpenRequestsOnArchive(tx, env,');
    const row = s.indexOf("action: 'SOFT_DELETE'");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(review);
    expect(review).toBeLessThan(claim);
    expect(claim).toBeLessThan(close);
    expect(close).toBeLessThan(row);
    expect(s.slice(row, row + 800)).toContain('openRequests,');
  });
});

describe('openRequestsRecord', () => {
  it('sorted, each id once, a closed draft never also listed as sent back', () => {
    expect(openRequestsRecord(['b', 'a', 'b'], ['d', 'c', 'a'])).toEqual({
      closedDrafts: ['a', 'b'],
      closedDraftCount: 2,
      sentBack: ['c', 'd'],
      sentBackCount: 2,
    });
    expect(openRequestsRecord([], [])).toEqual({ closedDrafts: [], closedDraftCount: 0, sentBack: [], sentBackCount: 0 });
  });

  it('each list capped, the counts whole', () => {
    expect(ARCHIVE_REQUEST_LIST_CAP).toBe(200);
    const many = Array.from({ length: 250 }, (_, i) => `e${String(i).padStart(3, '0')}`);
    const r = openRequestsRecord(many, many.map((x) => `s${x}`));
    expect(r.closedDrafts).toHaveLength(200);
    expect(r.closedDraftCount).toBe(250);
    expect(r.sentBack).toHaveLength(200);
    expect(r.sentBackCount).toBe(250);
  });
});
