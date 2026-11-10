// @vitest-environment node
/**
 * Code review 2026-11-10, finding 27: approving a change to one shop rewrote
 * every shop of the customer (lib/shop-rescore.ts).
 *
 *   - the rescore after a change writes only the scores that differ, in raw SQL
 *     (lib/rescore.ts), never through a Prisma update that moves updatedAt;
 *   - each branch score is its own statement, and a database rule refusing one
 *     is answered with that shop's code;
 *   - a refusal that is not about a shop's stored record is left as it was;
 *   - services/edits.ts and services/reactivations.ts no longer write a score
 *     of their own.
 *
 * On Postgres: tests/integration/sister-shops.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';
import { namingShop, rescoreAfterChangeTx, shopRuleRefusal } from '@/lib/shop-rescore';
import { scoreBranch } from '@/lib/completeness';
import type { RescoreBranch } from '@/lib/rescore';
import { ConflictError, runAction } from '@/lib/errors';

const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);
/** A raw UPDATE refused by a NOT VALID rule, as Prisma 6 reports it on Postgres 17 (tests/unit/db-rule-errors.test.ts). */
const rawRefused = (name: string) =>
  err('Raw query failed. Code: `23514`.', {
    code: 'P2010',
    meta: { code: '23514', message: `new row for relation "Branch" violates check constraint "${name}"` },
  });

describe('shopRuleRefusal', () => {
  it('a shop rule names the shop by its code, in the rule’s own words', () => {
    const r = shopRuleRefusal(rawRefused('Branch_gps_in_oman'), 'ZZ-B-0042');
    expect(r).toBeInstanceOf(ConflictError);
    expect(r!.code).toBe('DATA_RULE');
    expect(r!.message).toBe(
      "Shop ZZ-B-0042's stored record breaks a data rule (a location outside Oman). Ask the Data Steward to correct it."
    );
    // A Prisma model write's shape too.
    expect(shopRuleRefusal(err('violates check constraint "Branch_equipment_counts_range"'), 'X-1')!.message).toBe(
      "Shop X-1's stored record breaks a data rule (equipment counts outside their limits). Ask the Data Steward to correct it."
    );
  });

  it('runAction answers it with those words', async () => {
    const res = await runAction(async () => {
      throw shopRuleRefusal(rawRefused('Branch_gps_pair'), 'ZZ-B-7')!;
    });
    expect(res).toEqual({
      ok: false,
      code: 'DATA_RULE',
      message: "Shop ZZ-B-7's stored record breaks a data rule (a location with only one coordinate). Ask the Data Steward to correct it.",
    });
  });

  it('anything else is left alone: a customer rule, a dangling link, another error, no code', () => {
    expect(shopRuleRefusal(err('violates check constraint "Customer_credit_terms_only_credit"'), 'B-1')).toBeNull();
    expect(
      shopRuleRefusal(err('Foreign key constraint violated', { code: 'P2003', meta: { field_name: 'Branch_lastEditedById_fkey (index)' } }), 'B-1')
    ).toBeNull();
    expect(shopRuleRefusal(err('Timed out', { code: 'P2024' }), 'B-1')).toBeNull();
    expect(shopRuleRefusal(rawRefused('Branch_gps_in_oman'), null)).toBeNull();
  });
});

describe('namingShop', () => {
  it('passes a result through, renames a shop rule, rethrows anything else unchanged', async () => {
    expect(await namingShop('B-1', async () => 7)).toBe(7);
    await expect(namingShop('B-1', async () => Promise.reject(rawRefused('Branch_gpsAccuracy_range')))).rejects.toThrow(
      "Shop B-1's stored record breaks a data rule (a GPS accuracy outside 0–10,000 m)."
    );
    const other = err('boom');
    await expect(namingShop('B-1', async () => Promise.reject(other))).rejects.toBe(other);
  });
});

const branch = (id: string, branchCode: string, over: Partial<RescoreBranch> = {}) => {
  const b: RescoreBranch & { branchCode: string } = {
    id,
    branchCode,
    completenessScore: 0,
    deletedAt: null,
    gpsLat: null,
    gpsLng: null,
    address: 'Way 12, Muscat',
    shopPhotoId: null,
    signboardPhotoId: null,
    dayOfVisit: 'SUN',
    coolersCount: 0,
    standsCount: 0,
    emptyBottlesCount: 0,
    equipmentConfirmed: false,
    openingHours: null,
    deliveryWindow: null,
    status: 'ACTIVE',
    ...over,
  };
  return b;
};
const right = <T extends RescoreBranch>(b: T): T => ({ ...b, completenessScore: scoreBranch(b) });

function fakeTx(branches: Array<ReturnType<typeof branch>>, customerScore: number) {
  const findMany = vi.fn(async () => [
    {
      id: 'c-1',
      completenessScore: customerScore,
      channelId: 'ch-1',
      subChannelId: 'sub-1',
      primaryPhone: '+96891234567',
      contactPerson: 'Someone',
      crNumber: null,
      crPhotoId: null,
      paymentTerms: 'CASH',
      notes: null,
      branches,
    },
  ]);
  const $executeRaw = vi.fn(async () => 1);
  // Any Prisma model write would move updatedAt: none may happen.
  const update = vi.fn();
  const tx = { customer: { findMany, update, updateMany: update }, branch: { update, updateMany: update }, $executeRaw };
  return { tx: tx as never, findMany, $executeRaw, update };
}

describe('rescoreAfterChangeTx', () => {
  it('sister shops already right are not written at all; the changed shop’s score is, in raw SQL', async () => {
    const changed = branch('b-changed', 'ZZ-1', { gpsLat: 23.6, gpsLng: 58.4, completenessScore: 0 });
    const sisters = [right(branch('b-s1', 'ZZ-2', { shopPhotoId: 'p1' })), right(branch('b-s2', 'ZZ-3'))];
    const { tx, $executeRaw, update, findMany } = fakeTx([changed, ...sisters], 0);
    const res = await rescoreAfterChangeTx(tx, 'c-1');
    expect(findMany).toHaveBeenCalledTimes(1);
    expect((findMany.mock.calls[0] as unknown as [{ where: unknown }])[0].where).toEqual({ id: 'c-1' });
    expect(res.plan.branches.map((m) => m.id)).toEqual(['b-changed']);
    // One statement for the one branch that moved, one for the customer.
    expect($executeRaw).toHaveBeenCalledTimes(2);
    expect(res.written).toEqual({ customers: 1, branches: 1 });
    expect(update).not.toHaveBeenCalled();
  });

  it('nothing moved: nothing written', async () => {
    const b = right(branch('b-1', 'ZZ-1'));
    const { tx, $executeRaw, update } = fakeTx([b], -1);
    // The customer's stored score is wrong here (-1), so only it is written.
    const res = await rescoreAfterChangeTx(tx, 'c-1');
    expect(res.plan.branches).toEqual([]);
    expect($executeRaw).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('a sister shop whose score is corrected and which breaks a rule: the refusal names it', async () => {
    const changed = right(branch('b-changed', 'ZZ-1'));
    const bad = branch('b-bad', 'ZZ-OLD-9', { completenessScore: 99 });
    const { tx, $executeRaw } = fakeTx([changed, bad], 0);
    $executeRaw.mockImplementationOnce(async () => {
      throw rawRefused('Branch_gps_in_oman');
    });
    await expect(rescoreAfterChangeTx(tx, 'c-1')).rejects.toMatchObject({
      code: 'DATA_RULE',
      message: "Shop ZZ-OLD-9's stored record breaks a data rule (a location outside Oman). Ask the Data Steward to correct it.",
    });
  });
});

describe('the approval and reactivation paths write no score of their own (finding 27)', () => {
  for (const file of ['services/edits.ts', 'services/reactivations.ts']) {
    it(file, () => {
      const src = stripComments(readFileSync(file, 'utf8'), file);
      expect(src).not.toMatch(/\bscoreCustomer\b|\bscoreBranch\b/);
      expect(src).not.toMatch(/completenessScore\s*:/);
      expect(src).toMatch(/rescoreAfterChangeTx\(tx, /);
    });
  }
});
