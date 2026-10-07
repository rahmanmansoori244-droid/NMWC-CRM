// @vitest-environment node
/**
 * The SLA sweep (app/api/cron/sla-escalate), run through its real route with the
 * database played by an in-memory store — so its audiences, its claims and its
 * idempotency are pinned without running it on UAT, where it would read and
 * escalate every overdue request in the shared database.
 *
 * Launch fix (2026-10-07), what it pins:
 *   - audiences: an escalation goes only to people who can OPEN the request, by
 *     the gate of app/(app)/approvals/[id]/page.tsx: a Manager only over one of
 *     the request's regions, the Finance Manager and the GM anywhere, never a
 *     Steward. A late GM step used to go to every active Manager in the company
 *     and every Steward, with the customer's name; most of them got a 404;
 *   - claims: a request decided, or moved to a new stage, after the sweep read it
 *     is not escalated and gets no row and no audit;
 *   - idempotency: a second run (Vercel's cron and the GitHub workflow both call
 *     it) escalates nothing again, pings no Steward again, deletes nothing again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { matchesWhere } from '../support/where-eval';

type Edit = {
  id: string;
  state: string;
  process: 'UPDATE' | 'CREATE';
  isReactivation: boolean;
  pendingRole: string | null;
  currentStepIndex: number;
  cycle: number;
  approvalChain: null;
  slaDueAt: Date | null;
  stageEnteredAt: Date | null;
  escalationLevel: number;
  lastEscalatedAt: Date | null;
  slaBreachedAt: Date | null;
  submittedById: string;
  customerId: string | null;
  /** The live branches' regions (UPDATE), or the draft routes' (CREATE). */
  regions: string[];
};
type User = { id: string; role: string; isActive: boolean; regions: string[] };
type Note = {
  id: string;
  userId: string;
  kind: string;
  title: string;
  body: string;
  editId: string | null;
  customerId: string | null;
  readAt: Date | null;
  createdAt: Date;
};

const h = vi.hoisted(() => ({
  edits: [] as Edit[],
  users: [] as User[],
  notes: [] as Note[],
  audits: [] as Array<{ entityId: string; action: string }>,
  temixQueue: 0,
  /** Runs after the sweep has read its rows and before the claim: a decision landing in between. */
  beforeClaim: null as null | (() => void),
  seq: 0,
}));

const NOW = new Date('2026-10-07T08:00:00.000Z'); // Wednesday 12:00 Oman
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function includeShape(e: Edit) {
  const customer =
    e.process === 'UPDATE'
      ? { id: e.customerId, nmwcCode: `C-${e.id}`, legalName: `Shop ${e.id}`, branches: e.regions.map((regionId) => ({ regionId })) }
      : null;
  return {
    ...e,
    submittedBy: { id: e.submittedById },
    customer,
    customerDraft: e.process === 'CREATE' ? { legalName: `New ${e.id}` } : null,
    branchDrafts: e.process === 'CREATE' ? e.regions.map((regionId) => ({ route: { regionId } })) : [],
  };
}

const flat = (e: Edit) => {
  const { regions: _r, ...rest } = e;
  return rest as unknown as Record<string, unknown>;
};

const db = {
  customerEdit: {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      h.edits.filter((e) => matchesWhere(flat(e), where)).map((e) => includeShape(structuredClone(e)))
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Edit> }) => {
      if (h.beforeClaim) {
        h.beforeClaim();
        h.beforeClaim = null;
      }
      const hit = h.edits.filter((e) => matchesWhere(flat(e), where));
      for (const e of hit) Object.assign(e, data);
      return { count: hit.length };
    }),
  },
  user: {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: { role: string | { in: string[] }; isActive: boolean; managedRegions?: { some: { id: { in: string[] } } } };
      }) => {
        const roles = typeof where.role === 'string' ? [where.role] : where.role.in;
        return h.users
          .filter(
            (u) =>
              roles.includes(u.role) &&
              u.isActive === where.isActive &&
              (!where.managedRegions || u.regions.some((r) => where.managedRegions!.some.id.in.includes(r)))
          )
          .map((u) => ({ id: u.id }));
      }
    ),
  },
  notification: {
    createMany: vi.fn(async ({ data }: { data: Array<Omit<Note, 'id' | 'readAt' | 'createdAt'>> }) => {
      for (const d of data) {
        h.notes.push({
          ...d,
          editId: d.editId ?? null,
          customerId: d.customerId ?? null,
          id: `n${++h.seq}`,
          readAt: null,
          createdAt: new Date(),
        });
      }
      return { count: data.length };
    }),
    findFirst: vi.fn(
      async ({ where }: { where: { userId: string; kind: string; OR: [{ readAt: null }, { createdAt: { gt: Date } }] } }) =>
        h.notes.find(
          (n) =>
            n.userId === where.userId &&
            n.kind === where.kind &&
            (n.readAt === null || n.createdAt > where.OR[1].createdAt.gt)
        ) ?? null
    ),
    findMany: vi.fn(async ({ where, take }: { where: { readAt: { not: null; lt: Date } }; take: number }) =>
      h.notes
        .filter((n) => n.readAt !== null && n.readAt < where.readAt.lt)
        .slice(0, take)
        .map((n) => ({ id: n.id }))
    ),
    deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
      const before = h.notes.length;
      h.notes = h.notes.filter((n) => !where.id.in.includes(n.id));
      return { count: before - h.notes.length };
    }),
  },
  customer: { count: vi.fn(async () => h.temixQueue) },
  $executeRaw: vi.fn(async () => 0),
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
};

// A getter: the factory is hoisted above `db`, and reads it only when the route runs.
vi.mock('@/lib/db', () => ({
  get prisma() {
    return db;
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/heartbeat', () => ({ withHeartbeat: (_key: string, handler: unknown) => handler }));
vi.mock('@/lib/alert', () => ({ sendAlert: vi.fn(async () => true) }));
vi.mock('@/lib/temix', () => ({ TEMIX_QUEUE_WHERE: { temixQueued: true } }));
vi.mock('@/lib/audit', () => ({
  systemAuditEnvelope: (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: vi.fn(async (_tx: unknown, _env: unknown, row: { entityId: string; action: string }) => {
    h.audits.push({ entityId: row.entityId, action: row.action });
  }),
}));

import { GET } from '@/app/api/cron/sla-escalate/route';
import { hrefFor, APPROVER_ROLES } from '@/lib/notification-links';
import type { Role } from '@prisma/client';

const SECRET = 'sla-sweep-test-secret';
const req = (auth = `Bearer ${SECRET}`) =>
  ({ headers: new Headers({ authorization: auth, 'user-agent': 'vercel-cron/1.0' }) }) as unknown as NextRequest;
async function run() {
  const res = await GET(req());
  return { status: res.status, body: (await res.json()) as Record<string, number> };
}

const ORG: User[] = [
  { id: 'mgr-r1a', role: 'MANAGER', isActive: true, regions: ['r1'] },
  { id: 'mgr-r1b', role: 'MANAGER', isActive: true, regions: ['r1'] },
  { id: 'mgr-r1-off', role: 'MANAGER', isActive: false, regions: ['r1'] },
  { id: 'mgr-r2', role: 'MANAGER', isActive: true, regions: ['r2'] },
  { id: 'acc-r1', role: 'ACCOUNTANT', isActive: true, regions: ['r1'] },
  { id: 'sup-1', role: 'SUPERVISOR', isActive: true, regions: [] },
  { id: 'fm', role: 'FINANCE_MANAGER', isActive: true, regions: [] },
  { id: 'gm', role: 'GM', isActive: true, regions: [] },
  { id: 'gm-off', role: 'GM', isActive: false, regions: [] },
  { id: 'stw', role: 'STEWARD', isActive: true, regions: ['r1', 'r2'] },
  { id: 'stw-off', role: 'STEWARD', isActive: false, regions: [] },
  { id: 'vw', role: 'VIEWER', isActive: true, regions: ['r1', 'r2'] },
];

/** One request overdue at `pendingRole`, past its level-1 time but not its level-2 one. */
function overdue(id: string, pendingRole: string, regions: string[], over: Partial<Edit> = {}): Edit {
  return {
    id,
    state: 'SUBMITTED',
    process: 'UPDATE',
    isReactivation: false,
    pendingRole,
    currentStepIndex: 0,
    cycle: 1,
    approvalChain: null,
    // Entered Tuesday 12:00 Oman: nine working hours by now, under any 2× budget.
    stageEnteredAt: new Date(NOW.getTime() - DAY),
    slaDueAt: new Date(NOW.getTime() - HOUR),
    escalationLevel: 0,
    lastEscalatedAt: null,
    slaBreachedAt: null,
    submittedById: 'sal-1',
    customerId: `cust-${id}`,
    regions,
    ...over,
  };
}

const told = (editId: string, kind = 'SLA_BREACH') =>
  h.notes
    .filter((n) => n.editId === editId && n.kind === kind)
    .map((n) => n.userId)
    .sort();

/** The gate of app/(app)/approvals/[id]/page.tsx (and /reactivations for a Manager). */
function canOpen(userId: string, e: Edit): boolean {
  const u = ORG.find((x) => x.id === userId)!;
  if (!APPROVER_ROLES.includes(u.role as Role)) return false;
  if (u.role === 'SUPERVISOR') return false; // the sweep never escalates to a Supervisor
  if (u.role === 'MANAGER' || u.role === 'ACCOUNTANT') return u.regions.some((r) => e.regions.includes(r));
  return true; // FINANCE_MANAGER, GM: org-wide
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  process.env.CRON_SECRET = SECRET;
  h.users = ORG.map((u) => ({ ...u }));
  h.edits = [];
  h.notes = [];
  h.audits = [];
  h.temixQueue = 0;
  h.beforeClaim = null;
  h.seq = 0;
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('who a breach is escalated to', () => {
  it('only people who can open the request; never a Steward, a Viewer, a disabled account or another region’s Manager', async () => {
    const sup = overdue('e-sup', 'SUPERVISOR', ['r1']);
    const gmStep = overdue('e-gm', 'GM', ['r2'], { process: 'CREATE', customerId: null });
    const acc = overdue('e-acc', 'ACCOUNTANT', ['r1'], { process: 'CREATE', customerId: null });
    const react = overdue('e-react', 'MANAGER', ['r1'], { isReactivation: true });
    const orphan = overdue('e-orphan', 'SUPERVISOR', ['r9']);
    h.edits = [sup, gmStep, acc, react, orphan];

    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ escalated: 5, level2: 0, sweepErrors: 0 });

    expect(told('e-sup')).toEqual(['mgr-r1a', 'mgr-r1b']);
    // A late GM step: the request's region's Managers only — before, every
    // active Manager in the company and every Steward.
    expect(told('e-gm')).toEqual(['mgr-r2']);
    expect(told('e-acc')).toEqual(['fm', 'gm']);
    expect(told('e-react')).toEqual(['gm']);
    // Nobody covers the region: the GM, never every Manager.
    expect(told('e-orphan')).toEqual(['gm']);

    for (const n of h.notes) {
      const e = h.edits.find((x) => x.id === n.editId)!;
      const role = ORG.find((u) => u.id === n.userId)!.role as Role;
      expect(canOpen(n.userId, e), `${n.userId} on ${e.id}`).toBe(true);
      // ...and the inbox links each of them to the request's own page.
      const href = hrefFor({ ...n, edit: { isReactivation: e.isReactivation } }, role);
      expect(href, `${n.userId} on ${e.id}`).toBe(
        e.isReactivation && role === 'MANAGER' ? '/reactivations' : `/approvals/${e.id}`
      );
    }
    for (const never of ['stw', 'stw-off', 'vw', 'mgr-r1-off', 'gm-off', 'acc-r1', 'sup-1']) {
      expect(h.notes.filter((n) => n.userId === never), never).toEqual([]);
    }
    // Each escalation is audited once, as the system.
    expect(h.audits.map((a) => a.entityId).sort()).toEqual(['e-acc', 'e-gm', 'e-orphan', 'e-react', 'e-sup']);
  });

  it('a second escalation at the Supervisor step adds the GM; a late GM step stays with the region’s Managers', async () => {
    const longAgo = new Date(NOW.getTime() - 30 * DAY);
    h.edits = [
      overdue('e-sup2', 'SUPERVISOR', ['r1'], { escalationLevel: 1, stageEnteredAt: longAgo, slaDueAt: longAgo }),
      overdue('e-gm2', 'GM', ['r1'], { escalationLevel: 1, stageEnteredAt: longAgo, slaDueAt: longAgo }),
    ];
    const { body } = await run();
    expect(body).toMatchObject({ escalated: 0, level2: 2 });
    expect(told('e-sup2')).toEqual(['gm', 'mgr-r1a', 'mgr-r1b']);
    expect(told('e-gm2')).toEqual(['mgr-r1a', 'mgr-r1b']);
    expect(h.edits.map((e) => e.escalationLevel)).toEqual([2, 2]);
  });
});

describe('the claim: a racing decision always wins', () => {
  it('a request decided after the sweep read it is not escalated: no row, no audit, still decided', async () => {
    h.edits = [overdue('e-1', 'SUPERVISOR', ['r1'])];
    h.beforeClaim = () => {
      h.edits[0]!.state = 'APPROVED';
    };
    const { body } = await run();
    expect(body).toMatchObject({ escalated: 0, sweepErrors: 0 });
    expect(h.notes).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.edits[0]).toMatchObject({ state: 'APPROVED', escalationLevel: 0, slaBreachedAt: null });
  });

  it('a request advanced to a new stage after the read keeps that stage’s clock: no breach is marked on it', async () => {
    h.edits = [overdue('e-2', 'SUPERVISOR', ['r1'], { process: 'CREATE', customerId: null })];
    const fresh = new Date(NOW.getTime() + 8 * HOUR);
    h.beforeClaim = () => {
      Object.assign(h.edits[0]!, { currentStepIndex: 1, pendingRole: 'ACCOUNTANT', slaDueAt: fresh, escalationLevel: 0 });
    };
    const { body } = await run();
    expect(body.escalated).toBe(0);
    expect(h.notes).toEqual([]);
    expect(h.edits[0]).toMatchObject({ currentStepIndex: 1, escalationLevel: 0, slaBreachedAt: null, slaDueAt: fresh });
  });

  it('the claim is pinned on the stage it read and on a live breach', async () => {
    h.edits = [overdue('e-3', 'SUPERVISOR', ['r1'], { currentStepIndex: 0, cycle: 2 })];
    await run();
    expect(db.customerEdit.updateMany).toHaveBeenCalledWith({
      where: { id: 'e-3', state: 'SUBMITTED', escalationLevel: 0, currentStepIndex: 0, cycle: 2, slaDueAt: { lt: NOW } },
      data: { escalationLevel: 1, lastEscalatedAt: NOW, slaBreachedAt: NOW },
    });
  });
});

describe('idempotency: a second run does nothing again', () => {
  it('no second breach row, no second audit, no second Temix ping, nothing more deleted', async () => {
    h.edits = [overdue('e-sup', 'SUPERVISOR', ['r1']), overdue('e-acc', 'ACCOUNTANT', ['r1'])];
    h.temixQueue = 3;
    h.notes = [
      // Read 100 days ago: collected. Unread and old, or read recently: kept.
      { id: 'old-read', userId: 'gm', kind: 'EDIT_SUBMITTED', title: '', body: '', editId: null, customerId: null, readAt: new Date(NOW.getTime() - 100 * DAY), createdAt: new Date(NOW.getTime() - 101 * DAY) },
      { id: 'old-unread', userId: 'gm', kind: 'EDIT_SUBMITTED', title: '', body: '', editId: null, customerId: null, readAt: null, createdAt: new Date(NOW.getTime() - 101 * DAY) },
      { id: 'new-read', userId: 'gm', kind: 'EDIT_SUBMITTED', title: '', body: '', editId: null, customerId: null, readAt: new Date(NOW.getTime() - DAY), createdAt: new Date(NOW.getTime() - 2 * DAY) },
    ];

    const first = await run();
    expect(first.body).toMatchObject({ escalated: 2, level2: 0, temixPinged: 1, gcDeleted: 1, sweepErrors: 0 });
    // The one active Steward is pinged about Temix; the disabled one is not.
    expect(h.notes.filter((n) => n.kind === 'TEMIX_UPLOAD_READY').map((n) => n.userId)).toEqual(['stw']);
    const ids = new Set(h.notes.map((n) => n.id));
    expect(ids.has('old-read')).toBe(false);
    expect(ids.has('old-unread') && ids.has('new-read')).toBe(true);
    const rowsAfterFirst = h.notes.length;
    const auditsAfterFirst = h.audits.length;

    vi.setSystemTime(new Date(NOW.getTime() + 30 * 60 * 1000)); // the next half-hourly call
    const second = await run();
    expect(second.body).toMatchObject({ escalated: 0, level2: 0, temixPinged: 0, gcDeleted: 0, sweepErrors: 0 });
    expect(h.notes.length).toBe(rowsAfterFirst);
    expect(h.audits.length).toBe(auditsAfterFirst);
  });

  it('refuses a call without the bearer, and touches nothing', async () => {
    h.edits = [overdue('e-1', 'SUPERVISOR', ['r1'])];
    const res = await GET(req('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(db.customerEdit.findMany).not.toHaveBeenCalled();
    expect(h.edits[0]!.escalationLevel).toBe(0);
  });
});
