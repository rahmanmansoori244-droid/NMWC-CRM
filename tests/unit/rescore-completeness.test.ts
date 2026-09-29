// @vitest-environment node
/**
 * scripts/ops/rescore-completeness.ts (auditor recheck 2026-09-27, F21 part 2):
 * the one-off rescore of every live customer and branch after the deploy that
 * fixed the import's scoring.
 *
 * These pin the operator conventions every script in scripts/ops keeps — the
 * database is named with --expect-host before any client exists, a dry run
 * writes nothing, --apply names an accountable Steward, the ledger gets a
 * STARTING and a COMPLETED row — that it prints and records counts only, and,
 * against an in-memory database, that --apply locks each page before it reads
 * it, leaves updatedAt and version alone, and that a second run finds nothing.
 * The same run against Postgres: tests/integration/rescore-completeness.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Prisma, type PrismaClient } from '@prisma/client';
import { stripComments } from '../support/strip-comments';
import {
  prepare,
  parseRescoreArgs,
  run,
  formatTally,
  emptyTally,
  addToTally,
  DEFAULT_CHUNK,
} from '../../scripts/ops/rescore-completeness';
import { scoreBranch, scoreCustomer } from '@/lib/completeness';
import type { RescoreBranch, RescoreCustomer } from '@/lib/rescore';

const URL_OF = (host: string) => ['postgresql://', 'u:p', '@', host, '/db'].join('');

describe('prepare: the database is named before anything connects', () => {
  it('refuses without --expect-host, for a dry run too', () => {
    expect(() => prepare([], { DIRECT_URL: URL_OF('ep-test-1.example') })).toThrow(
      /refusing to run without --expect-host/
    );
    expect(() => prepare(['--expect-host'], { DIRECT_URL: URL_OF('ep-test-1.example') })).toThrow(
      /refusing to run without --expect-host/
    );
  });

  it('refuses a connection whose host is not the one named, and a missing one', () => {
    expect(() =>
      prepare(['--expect-host', 'ep-other'], { DIRECT_URL: URL_OF('ep-test-1.example') })
    ).toThrow(/refusing: you asked for "ep-other"/);
    expect(() => prepare(['--expect-host', 'ep-test-1'], {})).toThrow(/set DIRECT_URL/);
  });

  it('takes the owner connection (DIRECT_URL) over the pooled one, and returns its host, not the URL', () => {
    const out = prepare(['--expect-host', 'ep-owner'], {
      DIRECT_URL: URL_OF('ep-owner.example'),
      DATABASE_URL: URL_OF('ep-pooled.example'),
    });
    expect(out.host).toBe('ep-owner.example');
    expect(out.opts).toEqual({ apply: false, actor: '', chunk: DEFAULT_CHUNK });
  });
});

describe('parseRescoreArgs', () => {
  it('--apply without --actor is refused: the ledger must name who ran it', () => {
    expect(() => parseRescoreArgs(['--apply'])).toThrow(/--apply needs --actor/);
    expect(parseRescoreArgs(['--apply', '--actor', 'data.steward'])).toEqual({
      apply: true,
      actor: 'data.steward',
      chunk: DEFAULT_CHUNK,
    });
  });

  it('--actor without a username is refused, including when a flag follows it', () => {
    expect(() => parseRescoreArgs(['--actor'])).toThrow(/--actor was passed without a username/);
    expect(() => parseRescoreArgs(['--actor', '--apply'])).toThrow(
      /--actor was passed without a username/
    );
  });

  it('--chunk takes a whole number from 1 to 1,000', () => {
    expect(parseRescoreArgs(['--chunk', '50']).chunk).toBe(50);
    for (const bad of ['0', '-5', '2.5', 'abc', '5000', '']) {
      expect(() => parseRescoreArgs(['--chunk', bad])).toThrow(/--chunk needs a whole number/);
    }
  });
});

// ── An in-memory database the script runs against ───────────────────────────

type Row = { completenessScore: number; version: number; updatedAt: Date };
type FakeCustomer = Omit<RescoreCustomer, 'branches'> &
  Row & {
    deletedAt: Date | null;
    legalName: string;
    nmwcCode: string;
    branches: Array<RescoreBranch & Row & { branchCode: string }>;
  };

const STAMP = new Date('2026-09-20T08:00:00Z');
const fakeBranch = (id: string, over: Partial<RescoreBranch> = {}) => ({
  id,
  branchCode: `CODE-${id}`,
  completenessScore: 0,
  version: 3,
  updatedAt: STAMP,
  deletedAt: null,
  gpsLat: 23.6,
  gpsLng: 58.4,
  address: 'Way 12, Muscat',
  shopPhotoId: null,
  signboardPhotoId: null,
  dayOfVisit: 'SUN' as const,
  coolersCount: 0,
  standsCount: 0,
  emptyBottlesCount: 0,
  equipmentConfirmed: false,
  openingHours: null,
  deliveryWindow: null,
  status: 'ACTIVE' as const,
  ...over,
});
const fakeCustomer = (
  id: string,
  branches: FakeCustomer['branches'],
  over: Partial<FakeCustomer> = {}
): FakeCustomer => ({
  id,
  nmwcCode: `NMWC-${id}`,
  legalName: `Secret Shop ${id}`,
  completenessScore: 0,
  version: 9,
  updatedAt: STAMP,
  deletedAt: null,
  channelId: 'ch',
  subChannelId: 'sub',
  primaryPhone: '+96891234567',
  contactPerson: 'Someone',
  crNumber: null,
  crPhotoId: null,
  paymentTerms: 'CASH',
  notes: null,
  branches,
  ...over,
});

function fakeDb(
  customers: FakeCustomer[],
  users = [{ id: 'u-stew', username: 'data.steward', role: 'STEWARD', isActive: true }],
  /** What commits while a page waits for its locks (the ids it asked for). */
  whileLocking: (ids: unknown[]) => void = () => {}
) {
  const events: string[] = [];
  const ledger: Array<Record<string, unknown>> = [];
  const byId = new Map(customers.map((c) => [c.id, c]));
  const allBranches = () => customers.flatMap((c) => c.branches);

  const read = (args: {
    where: { deletedAt?: null; id?: { gt?: string; in?: string[] } };
    take?: number;
    select: Record<string, unknown>;
  }) => {
    let rows = [...customers].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (args.where.deletedAt === null) rows = rows.filter((c) => c.deletedAt === null);
    const gt = args.where.id?.gt;
    if (gt) rows = rows.filter((c) => c.id > gt);
    const ids = args.where.id?.in;
    if (ids) rows = rows.filter((c) => ids.includes(c.id));
    if (args.take) rows = rows.slice(0, args.take);
    if (!('branches' in args.select)) return rows.map((c) => ({ id: c.id }));
    return rows.map((c) => ({ ...c, branches: c.branches.filter((b) => b.deletedAt === null) }));
  };

  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      events.push(`lock ${q.values.join(',')}`);
      expect(q.sql).toMatch(/ORDER BY "id" COLLATE "C" FOR UPDATE$/);
      whileLocking(q.values);
      return [];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      const table = /^UPDATE "(\w+)"/.exec(q.sql)![1];
      events.push(`write ${table}`);
      let n = 0;
      for (let i = 0; i < q.values.length; i += 2) {
        const row: Row | undefined =
          table === 'Branch'
            ? allBranches().find((b) => b.id === q.values[i])
            : byId.get(q.values[i] as string);
        if (row && row.completenessScore !== q.values[i + 1]) {
          row.completenessScore = q.values[i + 1] as number;
          n += 1;
        }
      }
      return n;
    }),
    customer: {
      findMany: vi.fn(async (args: Parameters<typeof read>[0]) => {
        // The live-ids check under the lock reads ids only; the rescore reads branches.
        events.push('branches' in args.select ? 'tx read' : 'tx live ids');
        return read(args);
      }),
    },
  };
  const prisma = {
    $queryRawUnsafe: vi.fn(async () => [{ ok: 1 }]),
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>, opts: unknown) => {
      events.push('begin');
      expect(opts).toEqual({ timeout: 20_000, maxWait: 10_000 });
      const out = await fn(tx);
      events.push('commit');
      return out;
    }),
    customer: { findMany: vi.fn(async (args: Parameters<typeof read>[0]) => read(args)) },
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { username: string } }) =>
          users.find((u) => u.username === where.username) ?? null
      ),
      findMany: vi.fn(async () => users),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push('ledger');
        ledger.push(data);
        return data;
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, raw: prisma, tx, events, ledger };
}

/** Five live customers (one stale, one right, …), one archived, in id order c-1 … c-6. */
function world() {
  const stale = fakeCustomer(
    'c-1',
    [fakeBranch('b-1'), fakeBranch('b-2', { completenessScore: 7 })],
    {
      completenessScore: 1,
    }
  );
  const rightBranch = fakeBranch('b-3');
  rightBranch.completenessScore = scoreBranch(rightBranch);
  const right = fakeCustomer('c-2', [rightBranch]);
  right.completenessScore = scoreCustomer(right, [rightBranch]);
  const archivedBranch = fakeBranch('b-9', {
    deletedAt: new Date('2026-09-01T00:00:00Z'),
    completenessScore: 55,
  });
  const withArchivedBranch = fakeCustomer('c-3', [fakeBranch('b-4'), archivedBranch]);
  const noBranches = fakeCustomer('c-4', []);
  const down = fakeCustomer('c-5', [fakeBranch('b-5', { completenessScore: 60 })], {
    completenessScore: 100,
  });
  const archived = fakeCustomer('c-6', [fakeBranch('b-6')], {
    deletedAt: new Date('2026-09-01T00:00:00Z'),
  });
  return [stale, right, withArchivedBranch, noBranches, down, archived];
}

const lines = () => {
  const out: string[] = [];
  return { out, log: (l: string) => out.push(l) };
};

describe('run: the dry run', () => {
  it('writes nothing — no transaction, no score, no ledger row — and prints counts only', async () => {
    const customers = world();
    const db = fakeDb(customers);
    const { out, log } = lines();
    const code = await run(
      { apply: false, actor: '', chunk: 2 },
      db.prisma,
      'ep-test.example',
      log
    );
    expect(code).toBe(0);
    expect(db.raw.$transaction).not.toHaveBeenCalled();
    expect(db.raw.auditLog.create).not.toHaveBeenCalled();
    expect(db.tx.$executeRaw).not.toHaveBeenCalled();
    expect(customers.every((c) => c.version === 9 && c.updatedAt === STAMP)).toBe(true);

    const text = out.join('\n');
    expect(text).toMatch(/Live customers scanned:\s+5\n/);
    expect(text).toMatch(/Live branches scanned:\s+5\n/);
    expect(text).toContain('DRY RUN — nothing was written');
    // No id, code, name or phone of any row reaches the console.
    for (const c of customers) {
      for (const secret of [
        c.id,
        c.nmwcCode,
        c.legalName,
        c.primaryPhone!,
        ...c.branches.flatMap((b) => [b.id, b.branchCode]),
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('given --actor, resolves it, so the rehearsal meets the refusal --apply would', async () => {
    const db = fakeDb(world(), [
      { id: 'u-v', username: 'zz.viewer', role: 'VIEWER', isActive: true },
    ]);
    await expect(
      run({ apply: false, actor: 'zz.viewer', chunk: 2 }, db.prisma, 'h', () => {})
    ).rejects.toThrow(/is a VIEWER, not a STEWARD/);
    expect(db.raw.auditLog.create).not.toHaveBeenCalled();
  });

  it('given a usable --actor, still writes nothing without --apply', async () => {
    const db = fakeDb(world());
    const { out, log } = lines();
    expect(await run({ apply: false, actor: 'data.steward', chunk: 2 }, db.prisma, 'h', log)).toBe(
      0
    );
    expect(out.join('\n')).toMatch(/Audit actor:\s+data\.steward \(--actor\)/);
    expect(db.raw.$transaction).not.toHaveBeenCalled();
    expect(db.raw.auditLog.create).not.toHaveBeenCalled();
  });

  it('says so, and stops, when every score is already right', async () => {
    const b = fakeBranch('b-1');
    b.completenessScore = scoreBranch(b);
    const c = fakeCustomer('c-1', [b]);
    c.completenessScore = scoreCustomer(c, [b]);
    const db = fakeDb([c]);
    const { out, log } = lines();
    expect(await run({ apply: true, actor: 'data.steward', chunk: 2 }, db.prisma, 'h', log)).toBe(
      0
    );
    expect(out.join('\n')).toContain('Nothing to do');
    expect(db.raw.auditLog.create).not.toHaveBeenCalled();
    expect(db.raw.$transaction).not.toHaveBeenCalled();
  });
});

describe('run: --apply', () => {
  it('ledger STARTING, then per page: lock, read, write — COMPLETED; updatedAt and version untouched; a second run finds 0', async () => {
    const customers = world();
    const db = fakeDb(customers);
    const { out, log } = lines();
    const code = await run(
      { apply: true, actor: 'data.steward', chunk: 2 },
      db.prisma,
      'ep-test.example',
      log
    );
    expect(code).toBe(0);

    // Pages of two live customers, each locked (sorted) before it is read, and
    // checked live again under the lock.
    const tx = db.events.filter((e) => e !== 'ledger');
    expect(tx).toEqual([
      'begin',
      'lock c-1,c-2',
      'tx live ids',
      'tx read',
      'write Branch',
      'write Customer',
      'commit',
      'begin',
      'lock c-3,c-4',
      'tx live ids',
      'tx read',
      'write Branch',
      'write Customer',
      'commit',
      'begin',
      'lock c-5',
      'tx live ids',
      'tx read',
      'write Branch',
      'write Customer',
      'commit',
    ]);
    expect(db.events[0]).toBe('ledger');
    expect(db.events[db.events.length - 1]).toBe('ledger');

    // Every live score is now lib/completeness.ts's, and nothing else moved.
    for (const c of customers.filter((x) => x.deletedAt === null)) {
      const liveBranches = c.branches.filter((b) => b.deletedAt === null);
      expect(c.completenessScore).toBe(scoreCustomer(c, liveBranches));
      for (const b of liveBranches) expect(b.completenessScore).toBe(scoreBranch(b));
    }
    for (const c of customers) {
      expect([c.version, c.updatedAt]).toEqual([9, STAMP]);
      for (const b of c.branches) expect([b.version, b.updatedAt]).toEqual([3, STAMP]);
    }
    // Archived rows are not the dashboard's, and are left as they were.
    expect(customers[5].completenessScore).toBe(0);
    expect(customers[2].branches[1].completenessScore).toBe(55);

    // The ledger: one run, two rows, counts only, and the actor who was named.
    expect(
      db.ledger.map((r) => [
        r.actorId,
        r.entityType,
        r.action,
        (r.after as { phase: string }).phase,
      ])
    ).toEqual([
      ['u-stew', 'CompletenessRescore', 'UPDATE', 'started'],
      ['u-stew', 'CompletenessRescore', 'UPDATE', 'completed'],
    ]);
    expect(db.ledger[0].entityId).toBe(db.ledger[1].entityId);
    expect(db.ledger[1].after).toMatchObject({
      customersWritten: 4,
      branchesWritten: 4,
      remaining: 0,
    });
    const recorded = JSON.stringify(db.ledger) + out.join('\n');
    for (const c of customers) {
      for (const secret of [
        c.id,
        c.nmwcCode,
        c.legalName,
        ...c.branches.map((b) => b.branchCode),
      ]) {
        expect(recorded).not.toContain(secret);
      }
    }

    const again = fakeDb(customers);
    const second = lines();
    expect(await run({ apply: false, actor: '', chunk: 2 }, again.prisma, 'h', second.log)).toBe(0);
    expect(second.out.join('\n')).toContain('Nothing to do');
  });

  it('a customer archived while its page waits for the lock is not rescored, nor counted; paging carries on', async () => {
    // livePage reads c-1 and c-2 as live; before the page's FOR UPDATE gets c-2,
    // a Steward archives it (or merges it away): deletedAt set, its branches
    // tombstoned, its score left as it was. The lock matches on id, so it still
    // locks c-2 — and lib/rescore.ts, which does not filter archived customers,
    // used to score it with no live branches and write that on the archived row.
    const customers = world();
    const [c1, c2] = customers;
    const kept = c2.completenessScore;
    // What the old code wrote: the customer-only part, with no live branch left.
    expect(scoreCustomer(c2, [])).not.toBe(kept);
    const c2BranchScore = c2.branches[0].completenessScore;
    const archivedAt = new Date('2026-09-29T09:00:00Z');
    const db = fakeDb(customers, undefined, (ids) => {
      if (!ids.includes('c-2') || c2.deletedAt) return;
      c2.deletedAt = archivedAt;
      for (const b of c2.branches) b.deletedAt = archivedAt;
    });
    const { log } = lines();
    const code = await run({ apply: true, actor: 'data.steward', chunk: 2 }, db.prisma, 'h', log);
    expect(code).toBe(0);

    // The archived row keeps what it had; the live one beside it is rescored.
    expect(c2.completenessScore).toBe(kept);
    expect(c2.branches[0].completenessScore).toBe(c2BranchScore);
    expect(c1.completenessScore).toBe(scoreCustomer(c1, c1.branches));
    // The cursor stayed on the ids as read: every later page still ran.
    const locks = db.events.filter((e) => e.startsWith('lock'));
    expect(locks).toEqual(['lock c-1,c-2', 'lock c-3,c-4', 'lock c-5']);
    // The ids each raw UPDATE was given: c-1 and the later pages, never c-2.
    const writtenIds = (
      db.tx.$executeRaw.mock.calls as unknown as Array<[TemplateStringsArray, ...unknown[]]>
    ).flatMap(([s, ...v]) => Prisma.sql(s, ...v).values.filter((_, i) => i % 2 === 0));
    expect(writtenIds).toContain('c-1');
    expect(writtenIds).not.toContain('c-2');
    // The ledger counts the rows written: c-1, c-3, c-4 and c-5 — as when c-2
    // was right and live (above) — not the archived c-2 as a fifth.
    expect(db.ledger[1].after).toMatchObject({ customersWritten: 4, remaining: 0 });
  });
});

describe('the report', () => {
  it('counts ups, downs, points and branches stored as 0 — numbers and labels only', () => {
    const t = addToTally(emptyTally(), {
      customersScanned: 3,
      branchesScanned: 4,
      customers: [
        { id: 'c-1', from: 10, to: 40 },
        { id: 'c-2', from: 90, to: 80 },
      ],
      branches: [
        { id: 'b-1', from: 0, to: 35 },
        { id: 'b-2', from: 0, to: 20 },
        { id: 'b-3', from: 50, to: 45 },
      ],
    });
    expect(formatTally(t)).toEqual([
      'Live customers scanned:           3',
      '  scores to change:               2 (1 up, 1 down; +30 / -10 points)',
      'Live branches scanned:            4',
      '  scores to change:               3 (2 up, 1 down; +55 / -5 points)',
      '    of which stored as 0:         2',
    ]);
    expect(formatTally(t).join('\n')).not.toMatch(/[cb]-\d/);
  });
});

describe('the script keeps the operator conventions (comment-stripped source)', () => {
  const src = stripComments(readFileSync('scripts/ops/rescore-completeness.ts', 'utf8'), 'x.ts');
  const main = src.slice(src.indexOf('async function main('));
  const runBody = src.slice(
    src.indexOf('export async function run('),
    src.indexOf('async function main(')
  );

  it('owner connection, its own client built only after the host check', () => {
    expect(src).toMatch(/env\.DIRECT_URL \?\? env\.DATABASE_URL/);
    expect(main).toMatch(/new PrismaClient\(\{ datasourceUrl: url \}\)/);
    expect(main.indexOf('prepare(')).toBeGreaterThan(-1);
    expect(main.indexOf('prepare(')).toBeLessThan(main.indexOf('new PrismaClient('));
    expect(
      src.slice(src.indexOf('export function prepare('), src.indexOf('export type RescoreTally'))
    ).toMatch(/requireExpectedHost\(/);
  });

  it('every write sits after the dry run returns', () => {
    const dryReturn = runBody.indexOf('if (!opts.apply || !actor)');
    expect(dryReturn).toBeGreaterThan(-1);
    for (const w of ['auditLog.create(', '$transaction(', 'rescoreCustomerTx(']) {
      expect(runBody.indexOf(w)).toBeGreaterThan(dryReturn);
    }
  });

  it('each page is locked in lib/locks.ts order, then narrowed to the ids still live, before it is rescored, inside one bounded transaction', () => {
    const t = runBody.slice(runBody.indexOf('prisma.$transaction('));
    const lock = t.indexOf('lockCustomersAndTemixCodeHolders(tx, ids, null)');
    const liveRead = t.search(
      /tx\.customer\.findMany\(\{\s*where: \{ id: \{ in: ids \}, deletedAt: null \}/
    );
    const rescore = t.indexOf('rescoreCustomerTx(tx, live)');
    expect(lock).toBeGreaterThan(-1);
    expect(liveRead).toBeGreaterThan(lock);
    expect(rescore).toBeGreaterThan(liveRead);
    // The page's own ids are never rescored unfiltered.
    expect(t).not.toMatch(/rescoreCustomerTx\(tx, ids\)/);
    expect(t).toMatch(/\{ timeout: 20_000, maxWait: 10_000 \}/);
  });

  it('imports no request-runtime module: only lib/locks, lib/rescore and the shared operator guards', () => {
    const froms = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(froms).toEqual([
      '../../lib/locks',
      '../../lib/rescore',
      './requeue-untracked',
      '@prisma/client',
    ]);
  });

  it('runs main() only as a command, so importing it for these tests opens no connection', () => {
    expect(src).toMatch(
      /if \(\/rescore-completeness\\\.ts\$\/\.test\(process\.argv\[1\] \?\? ''\)\)/
    );
  });

  it('is an npm script beside the other operator scripts', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['ops:rescore-completeness']).toBe('tsx scripts/ops/rescore-completeness.ts');
  });
});
