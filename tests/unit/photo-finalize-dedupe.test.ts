// @vitest-environment node
/**
 * Production walk 2026-10-09: a salesman who picked a photo he had sent before
 * could not submit. Finalize deduped on (hash, uploader) and handed back ANY
 * live match — one on a customer's slot, one claimed by a request (withdrawn
 * and approved ones included), one of another kind — and Submit refused it
 * ("already wired to a customer", "belongs to another request", "kind
 * mismatch") with nothing he could do.
 *
 * Finalize now dedupes only to a photo he can still use: his own (NEW-PHOTO-002
 * — never another uploader's), the same hash and kind, live, on no slot and
 * claimed by no request. Any other match gets a row of its own, for the object
 * just uploaded. That row keeps the time the bytes first arrived from him, so
 * the close / reopen evidence rule (captured after the shop's last status
 * change) holds as it did when the old row came back.
 *
 * The attachment table is an in-memory list, and findFirst applies the route's
 * own `where`, `orderBy` and `select` to it — flat equality only: anything else
 * throws, so a condition added later cannot pass here by being ignored. R2 and
 * the session are mocked; the route is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Row = {
  id: string;
  kind: string;
  hash: string | null;
  r2Key: string;
  capturedById: string;
  capturedAt: Date;
  deletedAt: Date | null;
  customerId: string | null;
  branchId: string | null;
  branchExtraId: string | null;
  editId: string | null;
};

const h = vi.hoisted(() => {
  const rows: Row[] = [];
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === 'object') throw new Error(`the test table takes plain equality only (where.${k})`);
      if (!(k in row)) throw new Error(`the test table has no column ${k}`);
      return (row as Record<string, unknown>)[k] === v;
    });
  const pick = (row: Row, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, (row as Record<string, unknown>)[k]])) : { ...row };
  const made = { n: 0 };
  return {
    user: { id: 'sales1', role: 'SALESMAN', username: 's1' },
    rows,
    made,
    send: vi.fn(),
    findFirst: vi.fn(
      async (q: { where: Record<string, unknown>; orderBy?: Record<string, string>; select?: Record<string, boolean> }) => {
        let found = rows.filter((r) => matches(r, q.where));
        if (q.orderBy) {
          if (JSON.stringify(q.orderBy) !== '{"capturedAt":"asc"}') throw new Error(`unexpected orderBy ${JSON.stringify(q.orderBy)}`);
          found = [...found].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
        }
        return found[0] ? pick(found[0], q.select) : null;
      }
    ),
    create: vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'deletedAt' | 'customerId' | 'branchId' | 'branchExtraId' | 'editId'> }) => {
      const row: Row = {
        id: `attnew${++made.n}`,
        deletedAt: null,
        customerId: null,
        branchId: null,
        branchExtraId: null,
        editId: null,
        ...data,
      };
      rows.push(row);
      return row;
    }),
  };
});
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/r2', () => ({ r2: () => ({ send: h.send }), R2_BUCKET: 'bucket' }));
vi.mock('@/lib/db', () => ({ prisma: { attachment: { findFirst: h.findFirst, create: h.create } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST as finalizePOST } from '@/app/api/photos/finalize/route';

const ME = 'sales1';
const HASH = 'b'.repeat(64);
/** When R2 says the object just uploaded arrived. */
const UPLOADED_AT = new Date('2026-10-09T08:00:00.000Z');
const hoursBefore = (n: number) => new Date(UPLOADED_AT.getTime() - n * 3_600_000);

/** A key as presign mints one for this user — today's date (UTC), as finalize checks it; a new one per upload. */
let uploads = 0;
function mintedKey(kind: string) {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${ymd}/${ME}/${kind}/00000000-0000-4000-8000-${String(++uploads).padStart(12, '0')}.jpg`;
}

async function finalize(kind: string, hash = HASH) {
  const key = mintedKey(kind);
  const res = await finalizePOST(
    new NextRequest('https://nmwc.example/api/photos/finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, kind, hash }),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, key };
}

/** A photo row as finalize and the claims leave it: his, live, on no slot, unless said otherwise. */
function row(o: Partial<Row> & { id: string; kind: string }): Row {
  return {
    hash: HASH,
    r2Key: `old/${o.id}.jpg`,
    capturedById: ME,
    capturedAt: hoursBefore(48),
    deletedAt: null,
    customerId: null,
    branchId: null,
    branchExtraId: null,
    editId: null,
    ...o,
  };
}

const seed = (...rs: Row[]) => {
  h.rows.splice(0, h.rows.length, ...rs.map((r) => ({ ...r })));
};
const created = () => h.rows.filter((r) => r.id.startsWith('attnew'));

beforeEach(() => {
  h.user = { id: ME, role: 'SALESMAN', username: 's1' };
  h.rows.splice(0);
  h.made.n = 0;
  h.send.mockReset().mockResolvedValue({ ContentLength: 1000, ContentType: 'image/jpeg', LastModified: UPLOADED_AT });
  h.findFirst.mockClear();
  h.create.mockClear();
});

describe('finalize hands back an earlier upload only when he can still use it (production walk 2026-10-09)', () => {
  it('his own live photo of the same picture and kind, on no slot and claimed by no request: that photo again, nothing written', async () => {
    seed(row({ id: 'free', kind: 'SHOP' }));
    const res = await finalize('SHOP');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ attachmentId: 'free', deduped: true });
    expect(h.create).not.toHaveBeenCalled();
  });

  it.each([
    ["on a customer's record (its CR document)", 'CR', { kind: 'CR', customerId: 'cust1' }],
    ["on a branch's shop-front slot", 'SHOP', { kind: 'SHOP', branchId: 'br1' }],
    ['an extra photo of a branch', 'FREE', { kind: 'FREE', branchId: 'br1', branchExtraId: 'br1' }],
    ['claimed by a new-customer request — in review, withdrawn or approved alike', 'SHOP', { kind: 'SHOP', editId: 'edit1' }],
    ['a guarantee document claimed by a request', 'GUARANTEE', { kind: 'GUARANTEE', editId: 'edit1' }],
    ['of another kind: the same picture taken for the signboard', 'SHOP', { kind: 'SIGNBOARD' }],
    ['removed (soft-deleted), its hash still set', 'SHOP', { kind: 'SHOP', deletedAt: hoursBefore(1) }],
  ] as const)('%s: a row of its own for the object just uploaded', async (_label, kind, prior) => {
    const before = row({ id: 'prior', ...prior });
    seed(before);
    const res = await finalize(kind);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ attachmentId: 'attnew1', deduped: false });
    expect(created()).toEqual([
      expect.objectContaining({ id: 'attnew1', kind, hash: HASH, r2Key: res.key, capturedById: ME, editId: null, customerId: null }),
    ]);
    // The earlier photo is left exactly as it was: on its slot, with its request.
    expect(h.rows.find((r) => r.id === 'prior')).toEqual(before);
  });

  it("another uploader's photo of the same picture is never handed back (NEW-PHOTO-002), nor its time taken", async () => {
    seed(row({ id: 'theirs', kind: 'SHOP', capturedById: 'sales2', capturedAt: hoursBefore(72) }));
    const res = await finalize('SHOP');
    expect(res.body).toEqual({ attachmentId: 'attnew1', deduped: false });
    expect(created()[0]!.capturedAt).toEqual(UPLOADED_AT);
  });

  it('a picture never sent before: a new row, timed by R2', async () => {
    seed(row({ id: 'other-bytes', kind: 'SHOP', hash: 'c'.repeat(64), capturedAt: hoursBefore(72) }));
    const res = await finalize('SHOP');
    expect(res.body).toEqual({ attachmentId: 'attnew1', deduped: false });
    expect(created()[0]!.capturedAt).toEqual(UPLOADED_AT);
  });

  it('the same picture picked twice in one go, of one kind: the second finalize gets the first one’s photo while it is still free', async () => {
    const first = await finalize('SHOP');
    expect(first.body).toEqual({ attachmentId: 'attnew1', deduped: false });
    const second = await finalize('SHOP');
    expect(second.body).toEqual({ attachmentId: 'attnew1', deduped: true });
    expect(created()).toHaveLength(1);
  });
});

describe('a new row for bytes he sent before keeps the time they first arrived (EL-11/EL-12 evidence)', () => {
  // The close and reopen evidence must be captured after the shop's last status
  // change (services/reactivations.ts). When the old row came back, its time
  // came with it; a new row timed by this upload would let a photo sent before
  // a closure "prove" the reopening.
  it('the earliest of his live photos of that picture, whatever their slot, request or kind', async () => {
    seed(
      row({ id: 'on-slot', kind: 'SHOP', branchId: 'br1', capturedAt: hoursBefore(5) }),
      row({ id: 'evidence', kind: 'FREE', branchId: 'br1', branchExtraId: 'br1', capturedAt: hoursBefore(30) }),
      row({ id: 'claimed', kind: 'SHOP', editId: 'edit1', capturedAt: hoursBefore(10) }),
      // Not counted: removed (the old dedupe never matched it either), and another uploader's.
      row({ id: 'removed', kind: 'FREE', deletedAt: hoursBefore(2), capturedAt: hoursBefore(100) }),
      row({ id: 'theirs', kind: 'FREE', capturedById: 'sales2', capturedAt: hoursBefore(200) })
    );
    const res = await finalize('FREE');
    expect(res.body).toEqual({ attachmentId: 'attnew1', deduped: false });
    expect(created()[0]!.capturedAt).toEqual(hoursBefore(30));
  });

  it('never a time later than this upload', async () => {
    seed(row({ id: 'on-slot', kind: 'SHOP', branchId: 'br1', capturedAt: new Date(UPLOADED_AT.getTime() + 60_000) }));
    await finalize('SHOP');
    expect(created()[0]!.capturedAt).toEqual(UPLOADED_AT);
  });
});
