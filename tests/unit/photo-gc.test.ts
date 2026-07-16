/**
 * GAP-03 / Q4: never-attached-orphan + stale-edit-claim sweeps for the photo
 * GC cron.
 *
 * The fake below is a miniature in-memory Prisma covering exactly the query
 * shapes the sweeps issue (null-equality, lt, in, not-null, the `edit`
 * relation filter, select, take), so the tests exercise the sweeps' real
 * predicates against rows in every lifecycle state — bound, edit-claimed,
 * draft-referenced, young, abandoned — instead of asserting on argument
 * snapshots.
 */
import { describe, it, expect } from 'vitest';
import { EditState, type PrismaClient } from '@prisma/client';
import {
  ORPHAN_GRACE_DAYS,
  STALE_CLAIM_GRACE_DAYS,
  collectDraftReferencedIds,
  sweepNeverAttachedOrphans,
  sweepStaleEditClaims,
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
type EditRow = { id: string; state: EditState; updatedAt: Date };

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
  edits?: EditRow[];
}) {
  const attachments = seed.attachments ?? [];
  const edits = seed.edits ?? [];
  const calls = { attachmentFindMany: 0, customerDraftFindMany: 0, branchDraftFindMany: 0 };
  /** Test hook: runs after the candidate SELECT, before the guarded UPDATE. */
  let afterFindMany: (() => void) | null = null;

  // Attachment where-clauses may carry an `edit: {...}` relation filter —
  // resolve it against the edits table the way the SQL subquery would.
  function attMatches(row: AttRow, where: Where): boolean {
    const { edit: editWhere, ...rest } = where as { edit?: Where } & Where;
    if (!matches(row as unknown as Record<string, unknown>, rest)) return false;
    if (editWhere !== undefined) {
      if (row.editId === null) return false;
      const e = edits.find((x) => x.id === row.editId);
      if (!e || !matches(e as unknown as Record<string, unknown>, editWhere)) return false;
    }
    return true;
  }

  const db = {
    // Interactive-transaction passthrough: the fake has no isolation to model;
    // production race semantics are covered by the FOR UPDATE re-check below.
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(db);
    },
    // The stale-claim sweep's only raw query: SELECT id FROM "CustomerEdit"
    // WHERE id IN (...) AND state IN (...) AND updatedAt < cutoff FOR UPDATE.
    // Reconstruct the bound params (Prisma.join fragments carry .values) and
    // evaluate the row-local predicates against the CURRENT edits table —
    // exactly what Postgres re-checks on the locked rows.
    async $queryRaw(_strings: TemplateStringsArray, ...values: unknown[]) {
      const params = values.flatMap((v) =>
        v && typeof v === 'object' && Array.isArray((v as { values?: unknown[] }).values)
          ? (v as { values: unknown[] }).values
          : [v]
      );
      const stateNames = new Set<string>(Object.values(EditState));
      const states = params.filter((p): p is string => typeof p === 'string' && stateNames.has(p));
      const ids = params.filter((p): p is string => typeof p === 'string' && !stateNames.has(p));
      const cutoff = params.find((p): p is Date => p instanceof Date);
      return edits
        .filter(
          (e) =>
            ids.includes(e.id) &&
            states.includes(e.state) &&
            cutoff !== undefined &&
            e.updatedAt.getTime() < cutoff.getTime()
        )
        .map((e) => ({ id: e.id }));
    },
    attachment: {
      async findMany(args: { where: Where; select: Record<string, true>; take?: number }) {
        calls.attachmentFindMany += 1;
        let rows = attachments.filter((r) => attMatches(r, args.where));
        if (args.take !== undefined) rows = rows.slice(0, args.take);
        const out = rows.map((r) => pick(r as Record<string, unknown>, args.select));
        afterFindMany?.();
        afterFindMany = null;
        return out;
      },
      async updateMany(args: { where: Where; data: Partial<AttRow> }) {
        let count = 0;
        for (const r of attachments) {
          if (!attMatches(r, args.where)) continue;
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
    edits,
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

/** updatedAt safely past the stale-claim cutoff. */
const IDLE = new Date(NOW.getTime() - (STALE_CLAIM_GRACE_DAYS + 5) * DAY);
/** updatedAt safely inside the stale-claim window. */
const ACTIVE = new Date(NOW.getTime() - 10 * DAY);

describe('sweepStaleEditClaims', () => {
  it.each([EditState.DRAFT, EditState.NEEDS_CORRECTION, EditState.REJECTED])(
    'releases claims of a %s create request idle past the grace period',
    async (state) => {
      const { db, attachments } = makeFakeDb({
        attachments: [
          att('cr', { editId: 'e1' }),
          att('guarantee', { editId: 'e1' }),
        ],
        edits: [{ id: 'e1', state, updatedAt: IDLE }],
      });
      const res = await sweepStaleEditClaims(db, NOW);
      expect(res).toEqual({ scanned: 2, swept: 2 });
      for (const a of attachments) {
        expect(a.deletedAt).toEqual(NOW);
        expect(a.hash).toBeNull();
      }
    }
  );

  it('does not consult draft photo columns — an abandoned draft is exactly what gets released', async () => {
    const { db, calls } = makeFakeDb({
      attachments: [att('cr-ref', { editId: 'e1' })],
      customerDrafts: [{ crPhotoAttachmentId: 'cr-ref' }],
      edits: [{ id: 'e1', state: EditState.NEEDS_CORRECTION, updatedAt: IDLE }],
    });
    const res = await sweepStaleEditClaims(db, NOW);
    expect(res).toEqual({ scanned: 1, swept: 1 });
    expect(calls.customerDraftFindMany).toBe(0);
    expect(calls.branchDraftFindMany).toBe(0);
  });

  it.each([EditState.SUBMITTED, EditState.APPROVED])(
    'never releases claims of a %s request, however old — in-flight/finalized requests keep photos',
    async (state) => {
      const { db, attachments } = makeFakeDb({
        attachments: [att('claim', { editId: 'e1' })],
        edits: [{ id: 'e1', state, updatedAt: IDLE }],
      });
      const res = await sweepStaleEditClaims(db, NOW);
      expect(res).toEqual({ scanned: 0, swept: 0 });
      expect(attachments[0]!.deletedAt).toBeNull();
    }
  );

  it('leaves claims of a recently-touched NEEDS_CORRECTION request alone', async () => {
    const { db, attachments } = makeFakeDb({
      attachments: [att('claim', { editId: 'e1' })],
      edits: [{ id: 'e1', state: EditState.NEEDS_CORRECTION, updatedAt: ACTIVE }],
    });
    const res = await sweepStaleEditClaims(db, NOW);
    expect(res).toEqual({ scanned: 0, swept: 0 });
    expect(attachments[0]!.deletedAt).toBeNull();
  });

  it('never touches bound rows even when their provenance edit is stale', async () => {
    const { db, attachments } = makeFakeDb({
      attachments: [
        att('bound-cr', { editId: 'e1', customerId: 'c1' }),
        att('bound-shop', { editId: 'e1', branchId: 'b1' }),
      ],
      edits: [{ id: 'e1', state: EditState.NEEDS_CORRECTION, updatedAt: IDLE }],
    });
    const res = await sweepStaleEditClaims(db, NOW);
    expect(res).toEqual({ scanned: 0, swept: 0 });
    expect(attachments.every((a) => a.deletedAt === null)).toBe(true);
  });

  it('ignores never-attached rows (editId null) — those belong to the other clause', async () => {
    const { db, attachments } = makeFakeDb({ attachments: [att('unclaimed')] });
    const res = await sweepStaleEditClaims(db, NOW);
    expect(res).toEqual({ scanned: 0, swept: 0 });
    expect(attachments[0]!.deletedAt).toBeNull();
  });

  it('a resume racing the sweep is caught by the FOR UPDATE re-check (claims spared)', async () => {
    const fake = makeFakeDb({
      attachments: [att('racer-claim', { editId: 'e1' }), att('stale-claim', { editId: 'e2' })],
      edits: [
        { id: 'e1', state: EditState.NEEDS_CORRECTION, updatedAt: IDLE },
        { id: 'e2', state: EditState.NEEDS_CORRECTION, updatedAt: IDLE },
      ],
    });
    // Simulate submitCreateCore resuming e1 (state flip + updatedAt bump)
    // after the sweep chose its candidates. The FOR UPDATE lock re-asserts
    // state + idle-age row-locally on the latest committed row, so e1 drops
    // out and only e2's claim is swept. (In production the lock additionally
    // BLOCKS a mid-statement resume until the sweep commits, which the resume
    // then handles via its deletedAt-guarded re-claim → PHOTO_CONFLICT.)
    fake.setAfterFindMany(() => {
      const e = fake.edits.find((x) => x.id === 'e1')!;
      e.state = EditState.SUBMITTED;
      e.updatedAt = NOW;
    });
    const res = await sweepStaleEditClaims(fake.db, NOW);
    expect(res).toEqual({ scanned: 2, swept: 1 });
    const byId = new Map(fake.attachments.map((a) => [a.id, a]));
    expect(byId.get('racer-claim')!.deletedAt).toBeNull();
    expect(byId.get('racer-claim')!.hash).toBe('hash-racer-claim');
    expect(byId.get('stale-claim')!.deletedAt).toEqual(NOW);
  });

  it('caps a run at batchSize candidates; the rest drain on later runs', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => att(`c${i}`, { editId: 'e1' }));
    const { db, attachments } = makeFakeDb({
      attachments: rows,
      edits: [{ id: 'e1', state: EditState.DRAFT, updatedAt: IDLE }],
    });
    const res = await sweepStaleEditClaims(db, NOW, 3);
    expect(res).toEqual({ scanned: 3, swept: 3 });
    expect(attachments.filter((a) => a.deletedAt !== null)).toHaveLength(3);

    const second = await sweepStaleEditClaims(db, NOW, 3);
    expect(second).toEqual({ scanned: 2, swept: 2 });
    expect(attachments.every((a) => a.deletedAt !== null)).toBe(true);
  });
});
