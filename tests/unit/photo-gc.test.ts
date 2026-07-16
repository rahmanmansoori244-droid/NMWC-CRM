/**
 * GAP-03 / Q4: never-attached-orphan sweep for the photo GC cron.
 *
 * The fake below is a miniature in-memory Prisma covering exactly the query
 * shapes the sweep issues (null-equality, lt, in, not-null, select, take), so
 * the tests exercise the sweep's real predicates against rows in every
 * lifecycle state — bound, edit-claimed, draft-referenced, young, abandoned —
 * instead of asserting on argument snapshots.
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  ORPHAN_GRACE_DAYS,
  collectDraftReferencedIds,
  sweepNeverAttachedOrphans,
} from '@/lib/photo-gc';

const NOW = new Date('2026-07-16T03:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
/** createdAt safely past the grace cutoff. */
const OLD = new Date(NOW.getTime() - (ORPHAN_GRACE_DAYS + 3) * DAY);
/** createdAt safely inside the grace window. */
const FRESH = new Date(NOW.getTime() - 1 * DAY);

type AttRow = {
  id: string;
  customerId: string | null;
  branchId: string | null;
  branchExtraId: string | null;
  editId: string | null;
  deletedAt: Date | null;
  hash: string | null;
  createdAt: Date;
};

type CustomerDraftRow = { crPhotoAttachmentId: string | null };
type BranchDraftRow = {
  shopPhotoAttachmentId: string | null;
  signboardPhotoAttachmentId: string | null;
  extraPhotoAttachmentIds: unknown;
};

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const val = row[key];
    if (cond === null) {
      if (val !== null) return false;
    } else if (cond instanceof Date) {
      if (!(val instanceof Date) || val.getTime() !== cond.getTime()) return false;
    } else if (typeof cond === 'object') {
      const c = cond as { lt?: Date; in?: unknown[]; not?: unknown };
      if (c.lt !== undefined && !(val instanceof Date && val.getTime() < c.lt.getTime())) {
        return false;
      }
      if (c.in !== undefined && !c.in.includes(val)) return false;
      if (c.not !== undefined && c.not === null && val === null) return false;
    } else if (val !== cond) {
      return false;
    }
  }
  return true;
}

function pick<T extends Record<string, unknown>>(row: T, select: Record<string, true>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) out[key] = row[key];
  return out as Partial<T>;
}

function makeFakeDb(seed: {
  attachments?: AttRow[];
  customerDrafts?: CustomerDraftRow[];
  branchDrafts?: BranchDraftRow[];
}) {
  const attachments = seed.attachments ?? [];
  const calls = { attachmentFindMany: 0, customerDraftFindMany: 0, branchDraftFindMany: 0 };
  /** Test hook: runs after the candidate SELECT, before the guarded UPDATE. */
  let afterFindMany: (() => void) | null = null;

  const db = {
    attachment: {
      async findMany(args: { where: Where; select: Record<string, true>; take?: number }) {
        calls.attachmentFindMany += 1;
        let rows = attachments.filter((r) => matches(r, args.where));
        if (args.take !== undefined) rows = rows.slice(0, args.take);
        const out = rows.map((r) => pick(r as Record<string, unknown>, args.select));
        afterFindMany?.();
        afterFindMany = null;
        return out;
      },
      async updateMany(args: { where: Where; data: Partial<AttRow> }) {
        let count = 0;
        for (const r of attachments) {
          if (!matches(r, args.where)) continue;
          Object.assign(r, args.data);
          count += 1;
        }
        return { count };
      },
    },
    editCustomerDraft: {
      async findMany(args: { where: Where; select: Record<string, true> }) {
        calls.customerDraftFindMany += 1;
        return (seed.customerDrafts ?? [])
          .filter((r) => matches(r, args.where))
          .map((r) => pick(r as Record<string, unknown>, args.select));
      },
    },
    editBranchDraft: {
      async findMany(args: { select: Record<string, true> }) {
        calls.branchDraftFindMany += 1;
        return (seed.branchDrafts ?? []).map((r) =>
          pick(r as Record<string, unknown>, args.select)
        );
      },
    },
  };
  return {
    db: db as unknown as PrismaClient,
    attachments,
    calls,
    setAfterFindMany(fn: () => void) {
      afterFindMany = fn;
    },
  };
}

function att(id: string, over: Partial<AttRow> = {}): AttRow {
  return {
    id,
    customerId: null,
    branchId: null,
    branchExtraId: null,
    editId: null,
    deletedAt: null,
    hash: `hash-${id}`,
    createdAt: OLD,
    ...over,
  };
}

describe('collectDraftReferencedIds', () => {
  it('collects every photo column across customer + branch drafts, skipping nulls', () => {
    const ids = collectDraftReferencedIds(
      [{ crPhotoAttachmentId: 'cr1' }, { crPhotoAttachmentId: null }],
      [
        {
          shopPhotoAttachmentId: 'shop1',
          signboardPhotoAttachmentId: null,
          extraPhotoAttachmentIds: ['x1', 'x2'],
        },
        {
          shopPhotoAttachmentId: null,
          signboardPhotoAttachmentId: 'sign1',
          extraPhotoAttachmentIds: null,
        },
      ]
    );
    expect(ids).toEqual(new Set(['cr1', 'shop1', 'x1', 'x2', 'sign1']));
  });

  it('tolerates malformed extraPhotoAttachmentIds Json (non-array, non-string entries)', () => {
    const ids = collectDraftReferencedIds(
      [],
      [
        {
          shopPhotoAttachmentId: null,
          signboardPhotoAttachmentId: null,
          extraPhotoAttachmentIds: { junk: true },
        },
        {
          shopPhotoAttachmentId: null,
          signboardPhotoAttachmentId: null,
          extraPhotoAttachmentIds: ['ok', 42, null, ''],
        },
      ]
    );
    expect(ids).toEqual(new Set(['ok']));
  });
});

describe('sweepNeverAttachedOrphans', () => {
  it('soft-deletes a never-attached upload past the grace period (deletedAt=now, hash=null)', async () => {
    const { db, attachments } = makeFakeDb({ attachments: [att('orphan')] });
    const res = await sweepNeverAttachedOrphans(db, NOW);
    expect(res).toEqual({ scanned: 1, swept: 1, skippedProtected: 0 });
    expect(attachments[0]!.deletedAt).toEqual(NOW);
    expect(attachments[0]!.hash).toBeNull();
  });

  it('leaves unbound uploads younger than the grace period alone', async () => {
    const { db, attachments } = makeFakeDb({
      attachments: [att('fresh', { createdAt: FRESH })],
    });
    const res = await sweepNeverAttachedOrphans(db, NOW);
    expect(res).toEqual({ scanned: 0, swept: 0, skippedProtected: 0 });
    expect(attachments[0]!.deletedAt).toBeNull();
    expect(attachments[0]!.hash).toBe('hash-fresh');
  });

  it('never touches attachments claimed by an edit — incl. GUARANTEE docs on open CREATE requests', async () => {
    const { db, attachments } = makeFakeDb({
      attachments: [att('guarantee', { editId: 'edit1' })],
    });
    const res = await sweepNeverAttachedOrphans(db, NOW);
    expect(res).toEqual({ scanned: 0, swept: 0, skippedProtected: 0 });
    expect(attachments[0]!.deletedAt).toBeNull();
  });

  it('never touches attachments bound to a customer/branch/extra slot', async () => {
    const { db, attachments } = makeFakeDb({
      attachments: [
        att('cr', { customerId: 'c1' }),
        att('shop', { branchId: 'b1' }),
        att('extra', { branchId: 'b1', branchExtraId: 'b1' }),
      ],
    });
    const res = await sweepNeverAttachedOrphans(db, NOW);
    expect(res).toEqual({ scanned: 0, swept: 0, skippedProtected: 0 });
    expect(attachments.every((a) => a.deletedAt === null)).toBe(true);
  });

  it('skips already-soft-deleted rows (they belong to the 30-day hard phase)', async () => {
    const past = new Date(NOW.getTime() - 10 * DAY);
    const { db, attachments } = makeFakeDb({
      attachments: [att('gone', { deletedAt: past, hash: null })],
    });
    const res = await sweepNeverAttachedOrphans(db, NOW);
    expect(res).toEqual({ scanned: 0, swept: 0, skippedProtected: 0 });
    expect(attachments[0]!.deletedAt).toEqual(past);
  });

  it('protects unbound rows still referenced by draft photo columns (defense-in-depth)', async () => {
    const { db, attachments, calls } = makeFakeDb({
      attachments: [
        att('cr-ref'),
        att('shop-ref'),
        att('sign-ref'),
        att('extra-ref'),
        att('true-orphan'),
      ],
      customerDrafts: [{ crPhotoAttachmentId: 'cr-ref' }],
      branchDrafts: [
        {
          shopPhotoAttachmentId: 'shop-ref',
          signboardPhotoAttachmentId: 'sign-ref',
          extraPhotoAttachmentIds: ['extra-ref'],
        },
      ],
    });
    const res = await sweepNeverAttachedOrphans(db, NOW);
    expect(res).toEqual({ scanned: 5, swept: 1, skippedProtected: 4 });
    const byId = new Map(attachments.map((a) => [a.id, a]));
    expect(byId.get('true-orphan')!.deletedAt).toEqual(NOW);
    for (const id of ['cr-ref', 'shop-ref', 'sign-ref', 'extra-ref']) {
      expect(byId.get(id)!.deletedAt).toBeNull();
      expect(byId.get(id)!.hash).toBe(`hash-${id}`);
    }
    expect(calls.customerDraftFindMany).toBe(1);
    expect(calls.branchDraftFindMany).toBe(1);
  });

  it('returns early without scanning drafts when there are no candidates', async () => {
    const { db, calls } = makeFakeDb({ attachments: [att('fresh', { createdAt: FRESH })] });
    const res = await sweepNeverAttachedOrphans(db, NOW);
    expect(res).toEqual({ scanned: 0, swept: 0, skippedProtected: 0 });
    expect(calls.customerDraftFindMany).toBe(0);
    expect(calls.branchDraftFindMany).toBe(0);
  });

  it('a claim racing between candidate SELECT and guarded UPDATE wins (row not swept)', async () => {
    const fake = makeFakeDb({ attachments: [att('racer'), att('orphan')] });
    // Simulate submitCreateCore stamping editId after the sweep chose its
    // candidates but before the guarded updateMany runs.
    fake.setAfterFindMany(() => {
      fake.attachments.find((a) => a.id === 'racer')!.editId = 'edit-race';
    });
    const res = await sweepNeverAttachedOrphans(fake.db, NOW);
    expect(res.scanned).toBe(2);
    expect(res.swept).toBe(1);
    const byId = new Map(fake.attachments.map((a) => [a.id, a]));
    expect(byId.get('racer')!.deletedAt).toBeNull();
    expect(byId.get('racer')!.hash).toBe('hash-racer');
    expect(byId.get('orphan')!.deletedAt).toEqual(NOW);
  });

  it('caps a run at batchSize candidates; the rest drain on later runs', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => att(`o${i}`));
    const { db, attachments } = makeFakeDb({ attachments: rows });
    const res = await sweepNeverAttachedOrphans(db, NOW, 3);
    expect(res).toEqual({ scanned: 3, swept: 3, skippedProtected: 0 });
    expect(attachments.filter((a) => a.deletedAt !== null)).toHaveLength(3);

    const second = await sweepNeverAttachedOrphans(db, NOW, 3);
    expect(second).toEqual({ scanned: 2, swept: 2, skippedProtected: 0 });
    expect(attachments.every((a) => a.deletedAt !== null)).toBe(true);
  });
});
