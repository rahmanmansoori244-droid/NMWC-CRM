// @vitest-environment node
/**
 * The account-master import (services/imports.ts, uploadAccountMasterCore) run
 * against an in-memory database: F07, F08, X-IMPORTS-1..4, ENH-6 and X-AUTH-3.
 *
 * The fake keeps what these findings are about and nothing more:
 *   - `$transaction` ROLLS BACK: the store is restored when the callback throws,
 *     so "the audit failed, so the account change did not happen" is a real
 *     assertion, not a mock's say-so.
 *   - the transaction client is a different object from the top-level one, and
 *     the top-level client refuses to write while a transaction is open. A write
 *     that escaped the transaction (the F07 defect: `writeAudit(null, …)` or
 *     `prisma.user.update` after the commit) would, on real Postgres, have
 *     committed on its own — here it fails loudly instead.
 *   - User.email and User.ownedRouteId are unique, as in the schema.
 * A fault hook makes any call throw a Prisma-shaped error, for X-IMPORTS-3.
 *
 * Also: what a failed row or batch report leaves in the log and in Sentry (a
 * mocked SDK), the run of database failures counted only while unbroken, and —
 * through the real parser (uploadWorkbook) — Excel row numbers after blank lines
 * and repeated headings refused only on the sheets the import reads (N05).
 *
 * And the Users UI's rules the import did not apply (post-merge review,
 * 2026-09-29): an active SUPERVISOR or MANAGER as supervisor (AUTH-06), no role
 * change for a Supervisor with reports, and a reset that refuses a reused password
 * and rotates the old hash into PasswordHistory (B-15) — with a fake bcrypt whose
 * hash of p is "hashed:p" — and the batch id on every row the import's account
 * write owes.
 *
 * tests/integration/import-route-handover.test.ts proves F07's rollback, F08,
 * X-IMPORTS-1, -2 and -4 and ENH-6 against Postgres in CI (RUN_IMPORT_TESTS).
 */
// The fake takes Prisma's argument objects as they come, the shapes of a dozen
// calls; typing each one would restate Prisma's types for no assertion's sake.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type U = {
  id: string;
  username: string;
  passwordHash: string;
  fullName: string;
  role: string;
  isActive: boolean;
  email: string | null;
  phone: string | null;
  supervisorId: string | null;
  ownedRouteId: string | null;
  mustChangePassword: boolean;
  sessionsRevokedAt: Date | null;
  regionIds: string[];
};
type Region = { id: string; code: string; name: string };
type RouteRow = { id: string; code: string; name: string; regionId: string };
type Audit = {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  viaTx: boolean;
};
/** PasswordHistory: `at` orders the rows as createdAt does. */
type History = { id: string; userId: string; hash: string; at: number };
type Store = {
  users: U[];
  regions: Region[];
  routes: RouteRow[];
  history: History[];
  audits: Audit[];
  batches: Array<Record<string, unknown> & { id: string }>;
  importRows: Array<{
    batchId: string;
    issues: Array<{ message: string; sheet: string; row: number }>;
  }>;
};
type Sheet = {
  name: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  rowNumbers: number[];
  duplicateHeadings: Array<{ heading: string; first: string; again: string }>;
};

const h = vi.hoisted(() => ({
  store: null as unknown as Store,
  /** null: the uploaded bytes go through the real parser (uploadWorkbook). */
  sheets: [] as Sheet[] | null,
  /** Sentry.captureException. */
  capture: vi.fn(),
  txOpen: 0,
  txOptions: [] as unknown[],
  seq: 0,
  /** Return an error to make that call throw it. */
  failOn: null as null | ((model: string, op: string, args: any) => Error | undefined),
  /** Return true to make that audit write throw. */
  auditFails: null as null | ((p: { reason?: string; action: string }) => boolean),
}));

const STEWARD = { id: 'stew', role: 'STEWARD', username: 'steward.x' };

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: STEWARD }) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/rate-limit', () => ({ checkLimit: async () => ({ ok: true }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.capture }));
vi.mock('@/lib/excel', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/excel')>();
  return {
    ...real,
    parseWorkbook: async (buf: Uint8Array) => h.sheets ?? real.parseWorkbook(buf),
  };
});
vi.mock('bcryptjs', () => ({
  default: {
    hash: async (p: string) => `hashed:${p}`,
    compare: async (p: string, hash: string) => hash === `hashed:${p}`,
  },
}));

// ── The fake database ────────────────────────────────────────────────────────
function prismaError(code: string, meta?: unknown) {
  // The raw message carries a value, as Postgres's do — it must never reach an issue.
  return Object.assign(new Error(`Invalid invocation (${code}): ali@example.invalid 96890000000`), {
    code,
    meta,
  });
}

function makeClient(isTx: boolean): any {
  const st = () => h.store;
  const gate = (model: string, op: string, args: unknown, write: boolean) => {
    if (write && !isTx && h.txOpen > 0) {
      throw new Error(`${model}.${op} written OUTSIDE the open transaction`);
    }
    const e = h.failOn?.(model, op, args);
    if (e) throw e;
  };
  const id = (p: string) => `${p}-${++h.seq}`;
  const userById = (uid: string) => st().users.find((u) => u.id === uid)!;
  const viewUser = (
    u: U,
    args: { select?: Record<string, boolean>; include?: Record<string, unknown> }
  ) => {
    if (args.select)
      return Object.fromEntries(Object.keys(args.select).map((k) => [k, (u as any)[k]]));
    const { regionIds, ...scalars } = u;
    const out: any = { ...scalars };
    if (args.include?.supervisor)
      out.supervisor = u.supervisorId ? { username: userById(u.supervisorId).username } : null;
    if (args.include?.ownedRoute)
      out.ownedRoute = u.ownedRouteId
        ? { code: st().routes.find((r) => r.id === u.ownedRouteId)!.code }
        : null;
    if (args.include?.managedRegions)
      out.managedRegions = regionIds.map((rid) => ({
        code: st().regions.find((r) => r.id === rid)!.code,
      }));
    if (args.include?.reports)
      out.reports = st()
        .users.filter((o) => o.supervisorId === u.id)
        .map((o) => ({ id: o.id }));
    return out;
  };
  const applyUser = (u: U, input: Record<string, any>) => {
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (k === 'ownedRoute')
        u.ownedRouteId = v.connect ? v.connect.id : v.disconnect ? null : u.ownedRouteId;
      else if (k === 'supervisor') u.supervisorId = v.connect.id;
      else if (k === 'managedRegions') {
        if (v.set) u.regionIds = v.set.map((x: { id: string }) => x.id);
        else if (v.connect)
          u.regionIds = [
            ...new Set([...u.regionIds, ...v.connect.map((x: { id: string }) => x.id)]),
          ];
        else throw new Error('unsupported managedRegions write');
      } else if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
        throw new Error(`unsupported nested write on User.${k}`);
      } else (u as any)[k] = v;
    }
    for (const field of ['email', 'ownedRouteId'] as const) {
      if (u[field] !== null && st().users.some((o) => o !== u && o[field] === u[field])) {
        throw prismaError('P2002', { target: [field] });
      }
    }
  };
  const notUser = (where: { ownedRouteId: string; NOT: { username: string } }) => (u: U) =>
    u.ownedRouteId === where.ownedRouteId && u.username !== where.NOT.username;

  return {
    user: {
      // The e-mail clash check: another account (NOT this username) holding the
      // address in any letter case.
      findFirst: async (args: any) => {
        gate('user', 'findFirst', args, false);
        const { equals, mode } = args.where.email;
        const fold = (v: string) => (mode === 'insensitive' ? v.toLowerCase() : v);
        const u = st().users.find(
          (x) => x.email !== null && fold(x.email) === fold(equals) && x.username !== args.where.NOT?.username
        );
        return u ? viewUser(u, args) : null;
      },
      findUnique: async (args: any) => {
        gate('user', 'findUnique', args, false);
        const u = st().users.find((x) => x.username === args.where.username);
        return u ? viewUser(u, args) : null;
      },
      findMany: async (args: any) => {
        gate('user', 'findMany', args, false);
        return st()
          .users.filter(notUser(args.where))
          .map((u) => viewUser(u, args));
      },
      updateMany: async (args: any) => {
        gate('user', 'updateMany', args, true);
        const hit = st().users.filter(notUser(args.where));
        for (const u of hit) Object.assign(u, args.data);
        return { count: hit.length };
      },
      upsert: async (args: any) => {
        gate('user', 'upsert', args, true);
        let u = st().users.find((x) => x.username === args.where.username);
        if (u) applyUser(u, args.update);
        else {
          u = {
            id: id('user'),
            username: '',
            passwordHash: '',
            fullName: '',
            role: '',
            isActive: true,
            email: null,
            phone: null,
            supervisorId: null,
            ownedRouteId: null,
            mustChangePassword: false,
            sessionsRevokedAt: null,
            regionIds: [],
          };
          st().users.push(u);
          applyUser(u, args.create);
        }
        return viewUser(u, {});
      },
    },
    // Every read returns a copy, as Prisma does: a row read before an update must
    // still show what it was.
    region: {
      findUnique: async (args: any) => {
        gate('region', 'findUnique', args, false);
        const r = st().regions.find((x) => x.code === args.where.code);
        return r ? { ...r } : null;
      },
      findMany: async (args: any) => {
        gate('region', 'findMany', args, false);
        return st()
          .regions.filter((r) => args.where.code.in.includes(r.code))
          .map((r) => ({ ...r }));
      },
      create: async (args: any) => {
        gate('region', 'create', args, true);
        const r = { id: id('region'), ...args.data };
        st().regions.push(r);
        return { ...r };
      },
      update: async (args: any) => {
        gate('region', 'update', args, true);
        const r = st().regions.find((x) => x.id === args.where.id)!;
        Object.assign(r, args.data);
        return { ...r };
      },
    },
    route: {
      findUnique: async (args: any) => {
        gate('route', 'findUnique', args, false);
        const r = st().routes.find((x) => x.code === args.where.code);
        if (!r) return null;
        return args.include?.region
          ? { ...r, region: { code: st().regions.find((g) => g.id === r.regionId)!.code } }
          : { ...r };
      },
      create: async (args: any) => {
        gate('route', 'create', args, true);
        const r = { id: id('route'), ...args.data };
        st().routes.push(r);
        return { ...r };
      },
      update: async (args: any) => {
        gate('route', 'update', args, true);
        const r = st().routes.find((x) => x.id === args.where.id)!;
        Object.assign(r, args.data);
        return { ...r };
      },
    },
    // What lib/password-policy.ts asks of it: the newest five of a user's rows,
    // one more, and the rest pruned.
    passwordHistory: {
      findMany: async (args: any) => {
        gate('passwordHistory', 'findMany', args, false);
        return st()
          .history.filter((r) => r.userId === args.where.userId)
          .sort((a, b) => b.at - a.at)
          .slice(0, args.take)
          .map((r) => Object.fromEntries(Object.keys(args.select).map((k) => [k, (r as any)[k]])));
      },
      create: async (args: any) => {
        gate('passwordHistory', 'create', args, true);
        const r = { id: id('ph'), at: ++h.seq, ...args.data };
        st().history.push(r);
        return { ...r };
      },
      deleteMany: async (args: any) => {
        gate('passwordHistory', 'deleteMany', args, true);
        const keep = new Set<string>(args.where.id.notIn);
        const before = st().history.length;
        st().history = st().history.filter(
          (r) => r.userId !== args.where.userId || keep.has(r.id)
        );
        return { count: before - st().history.length };
      },
    },
    auditLog: {
      create: async (args: any) => {
        gate('auditLog', 'create', args, true);
        const { actorId: _a, ip: _i, userAgent: _u, ...row } = args.data;
        st().audits.push({ ...row, viaTx: isTx });
        return row;
      },
    },
    importBatch: {
      create: async (args: any) => {
        gate('importBatch', 'create', args, true);
        const b = { id: id('batch'), ...args.data };
        st().batches.push(b);
        return b;
      },
      update: async (args: any) => {
        gate('importBatch', 'update', args, true);
        const b = st().batches.find((x) => x.id === args.where.id)!;
        Object.assign(b, args.data);
        return b;
      },
    },
    importRow: {
      createMany: async (args: any) => {
        gate('importRow', 'createMany', args, true);
        st().importRows.push(...args.data);
        return { count: args.data.length };
      },
    },
  };
}

// Hoisted, because the mocked modules below are loaded — and their factories run —
// before this file's own top-level code. makeClient and prismaError are function
// declarations, so they already exist when this runs.
const db = vi.hoisted(() => {
  const txClient = makeClient(true);
  return {
    ...makeClient(false),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
      h.txOptions.push(opts);
      const snapshot = structuredClone(h.store);
      h.txOpen++;
      try {
        return await fn(txClient);
      } catch (e) {
        h.store = snapshot;
        throw e;
      } finally {
        h.txOpen--;
      }
    },
  };
});

vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: async (tx: any, env: any, p: any) => {
    if (h.auditFails?.(p)) throw new Error('audit insert failed');
    await (tx ?? db).auditLog.create({
      data: { actorId: env.actorId, ip: env.ip, userAgent: env.userAgent, ...p },
    });
  },
}));

import { uploadAccountMasterAction } from '@/services/imports';
import { loadExcelJS } from '@/lib/excel';
import { logger } from '@/lib/logger';
import { assertPasswordNotReused } from '@/lib/password-policy';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const user = (over: Partial<U> & { id: string; username: string; role: string }): U => ({
  passwordHash: 'old-hash',
  fullName: `Name ${over.username}`,
  isActive: true,
  email: null,
  phone: null,
  supervisorId: null,
  ownedRouteId: null,
  mustChangePassword: false,
  sessionsRevokedAt: null,
  regionIds: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.seq = 0;
  h.txOpen = 0;
  h.txOptions = [];
  h.failOn = null;
  h.auditFails = null;
  h.store = {
    users: [user({ id: 'stew', username: 'steward.x', role: 'STEWARD' })],
    regions: [
      { id: 'rg-mct', code: 'MCT', name: 'Muscat' },
      { id: 'rg-bat', code: 'BAT', name: 'Batinah' },
    ],
    routes: [
      { id: 'rt-1', code: 'MCT-01', name: 'Muscat 1', regionId: 'rg-mct' },
      { id: 'rt-2', code: 'MCT-02', name: 'Muscat 2', regionId: 'rg-mct' },
    ],
    history: [],
    audits: [],
    batches: [],
    importRows: [],
  };
});

const addUser = (over: Partial<U> & { id: string; username: string; role: string }) => {
  const u = user(over);
  h.store.users.push(u);
  return u;
};
const find = (username: string) => h.store.users.find((u) => u.username === username);
const routeOwner = (routeId: string) =>
  h.store.users.find((u) => u.ownedRouteId === routeId)?.username ?? null;

async function upload(sheets: Array<{ name: string; rows: Array<Record<string, string>> }>) {
  h.sheets = sheets.map((s) => ({
    name: s.name,
    headers: Object.keys(s.rows[0] ?? {}),
    rows: s.rows,
    rowNumbers: s.rows.map((_, i) => i + 2),
    duplicateHeadings: [],
  }));
  return send(new Uint8Array([1, 2, 3]));
}
/** A real workbook, through the real parser: blank lines and headings as Excel has them. */
async function uploadWorkbook(build: (wb: import('exceljs').Workbook) => void) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  build(wb);
  h.sheets = null;
  return send(new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer));
}
async function send(bytes: Uint8Array<ArrayBuffer>) {
  const fd = new FormData();
  fd.set('file', new File([bytes], 'account-master.xlsx'));
  const res = await uploadAccountMasterAction(fd);
  const batch = h.store.batches.at(-1);
  const messages = h.store.importRows
    .filter((r) => r.batchId === batch?.id)
    .flatMap((r) => r.issues.map((i) => `${i.sheet} ${i.row}: ${i.message}`));
  return { res, batch, messages };
}
const usersSheet = (...rows: Array<Record<string, string>>) => [{ name: 'Users', rows }];
const okData = (res: Awaited<ReturnType<typeof uploadAccountMasterAction>>) => {
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return (res as { ok: true; data: { batchId: string; clean: number; issues: number } }).data;
};
/** Per-row audit rows: everything but the batch summary. */
const rowAudits = () => h.store.audits.filter((a) => a.entityType !== 'ImportBatch');

// ── F07 ──────────────────────────────────────────────────────────────────────
describe('F07: an account row and its audit rows stand or fall together', () => {
  const accountant = () =>
    addUser({
      id: 'acc',
      username: 'acct.mct',
      role: 'ACCOUNTANT',
      regionIds: ['rg-mct'],
      email: 'a@x.invalid',
    });
  const roleChangeRow = {
    username: 'acct.mct',
    full_name: 'Acct',
    role: 'SALESMAN',
    route_code: 'MCT-02',
    change_role: 'yes',
  };

  it('a failed role-change audit leaves role, route and sessions as they were, and quarantines the row', async () => {
    accountant();
    h.auditFails = (p) => p.reason === 'role_change_via_import';
    const { res, messages } = await upload(usersSheet(roleChangeRow));
    const data = okData(res);
    expect(data.clean).toBe(0);
    expect(data.issues).toBe(1);
    expect(messages).toEqual([
      `Users 2: nothing was written for "acct.mct": it could not be saved (Error).`,
    ]);
    const u = find('acct.mct')!;
    expect(u.role).toBe('ACCOUNTANT');
    expect(u.ownedRouteId).toBeNull();
    expect(u.sessionsRevokedAt).toBeNull();
    expect(u.regionIds).toEqual(['rg-mct']);
    expect(rowAudits()).toEqual([]);
  });

  it('a failed password-reset audit leaves the hash and the sessions as they were', async () => {
    addUser({ id: 's1', username: 'mct-01', role: 'SALESMAN', ownedRouteId: 'rt-1' });
    h.auditFails = (p) => p.reason === 'password_reset_via_import';
    const { res } = await upload(
      usersSheet({
        username: 'mct-01',
        full_name: 'Renamed',
        role: 'SALESMAN',
        route_code: 'MCT-01',
        password: 'a-new-password-1',
        reset_password: 'yes',
      })
    );
    expect(okData(res).clean).toBe(0);
    const u = find('mct-01')!;
    expect(u.passwordHash).toBe('old-hash');
    expect(u.sessionsRevokedAt).toBeNull();
    expect(u.fullName).toBe('Name mct-01');
    expect(rowAudits()).toEqual([]);
    // The old hash went into PasswordHistory in that transaction, and out with it.
    expect(h.store.history).toEqual([]);
  });

  it('a failed audit on a region-scoped row leaves the regions as they were', async () => {
    accountant();
    h.auditFails = (p) => p.reason === 'account_import';
    const { res } = await upload(
      usersSheet({
        username: 'acct.mct',
        full_name: 'Acct',
        role: 'ACCOUNTANT',
        region_codes: 'MCT,BAT',
      })
    );
    expect(okData(res).clean).toBe(0);
    expect(find('acct.mct')!.regionIds).toEqual(['rg-mct']);
  });

  it('when everything lands, the role, route, regions and every audit row land together, inside the transaction', async () => {
    accountant();
    const { res } = await upload(
      usersSheet({ ...roleChangeRow, password: 'a-new-password-1', reset_password: 'yes' })
    );
    expect(okData(res).clean).toBe(1);
    const u = find('acct.mct')!;
    expect(u.role).toBe('SALESMAN');
    expect(u.ownedRouteId).toBe('rt-2');
    expect(u.passwordHash).toBe('hashed:a-new-password-1');
    expect(h.store.history.map((r) => [r.userId, r.hash])).toEqual([['acc', 'old-hash']]);
    expect(rowAudits().map((a) => [a.reason, a.viaTx])).toEqual([
      ['password_reset_via_import', true],
      ['role_change_via_import', true],
      ['account_import', true],
    ]);
    // The transaction budget for a slow link is explicit, as promote's is.
    expect(h.txOptions).toContainEqual({ timeout: 20_000, maxWait: 10_000 });
  });

  it('regions set by a row go in with the account write, for a new account and an existing one', async () => {
    accountant();
    const { res } = await upload(
      usersSheet(
        { username: 'acct.mct', full_name: 'Acct', role: 'ACCOUNTANT', region_codes: 'BAT' },
        {
          username: 'acct.new',
          full_name: 'New',
          role: 'ACCOUNTANT',
          region_codes: 'MCT,BAT',
          password: '123456789012',
        }
      )
    );
    expect(okData(res).clean).toBe(2);
    expect(find('acct.mct')!.regionIds).toEqual(['rg-bat']);
    expect([...find('acct.new')!.regionIds].sort()).toEqual(['rg-bat', 'rg-mct']);
  });

  it('a blank region cell on an existing region-scoped account keeps its regions', async () => {
    accountant();
    const { res } = await upload(
      usersSheet({ username: 'acct.mct', full_name: 'Acct', role: 'ACCOUNTANT' })
    );
    expect(okData(res).clean).toBe(1);
    expect(find('acct.mct')!.regionIds).toEqual(['rg-mct']);
  });
});

// ── F08 ──────────────────────────────────────────────────────────────────────
describe('F08: without change_role the row must name the stored role', () => {
  it('case A: a SALESMAN on a VIEWER row keeps his route and his role; nothing is written', async () => {
    addUser({ id: 's1', username: 'mct-01', role: 'SALESMAN', ownedRouteId: 'rt-1' });
    const { res, messages } = await upload(
      usersSheet({ username: 'mct-01', full_name: 'X', role: 'VIEWER' })
    );
    const data = okData(res);
    expect(data.clean).toBe(0);
    expect(messages.join(' ')).toMatch(
      /"mct-01" is SALESMAN in the CRM but VIEWER in this row\. Nothing was written/
    );
    expect(find('mct-01')).toMatchObject({
      role: 'SALESMAN',
      ownedRouteId: 'rt-1',
      fullName: 'Name mct-01',
    });
    expect(rowAudits()).toEqual([]);
  });

  it('case B: a VIEWER on a SALESMAN row does not take the real salesman’s route', async () => {
    addUser({ id: 's1', username: 'mct-01', role: 'SALESMAN', ownedRouteId: 'rt-1' });
    addUser({ id: 'v1', username: 'viewer.a', role: 'VIEWER' });
    const { res } = await upload(
      usersSheet({ username: 'viewer.a', full_name: 'V', role: 'SALESMAN', route_code: 'MCT-01' })
    );
    expect(okData(res).clean).toBe(0);
    expect(routeOwner('rt-1')).toBe('mct-01');
    expect(find('viewer.a')!.role).toBe('VIEWER');
    expect(rowAudits().filter((a) => a.action === 'REASSIGN')).toEqual([]);
  });

  it('a stored MANAGER on a SALESMAN row is held back and pointed at the Users UI', async () => {
    addUser({ id: 'm1', username: 'manager.x', role: 'MANAGER', regionIds: ['rg-mct'] });
    const { res, messages } = await upload(
      usersSheet({ username: 'manager.x', full_name: 'M', role: 'SALESMAN', route_code: 'MCT-02' })
    );
    expect(okData(res).clean).toBe(0);
    expect(messages.join(' ')).toMatch(
      /is MANAGER in the CRM but SALESMAN in this row.*only in the Users UI/
    );
    expect(find('manager.x')).toMatchObject({ role: 'MANAGER', ownedRouteId: null });
  });

  it('with change_role=yes the role changes, the route moves, and REASSIGN and the role change are audited', async () => {
    addUser({ id: 's1', username: 'mct-01', role: 'SALESMAN', ownedRouteId: 'rt-1' });
    addUser({ id: 'v1', username: 'viewer.a', role: 'VIEWER' });
    const { res } = await upload(
      usersSheet({
        username: 'viewer.a',
        full_name: 'V',
        role: 'SALESMAN',
        route_code: 'MCT-01',
        change_role: 'yes',
      })
    );
    expect(okData(res).clean).toBe(1);
    expect(routeOwner('rt-1')).toBe('viewer.a');
    expect(find('viewer.a')!.role).toBe('SALESMAN');
    expect(rowAudits().map((a) => [a.action, a.entityId, a.reason])).toEqual([
      ['REASSIGN', 's1', 'route MCT-01 reassigned to viewer.a via import'],
      ['UPDATE', 'v1', 'role_change_via_import'],
      ['UPDATE', 'v1', 'account_import'],
    ]);
    // Each names the batch that did it.
    const batchId = h.store.batches[0].id;
    expect(rowAudits().map((a) => [a.before, a.after])).toEqual([
      [{ ownedRouteCode: 'MCT-01' }, { ownedRouteCode: null, batchId }],
      [{ role: 'VIEWER' }, { role: 'SALESMAN', batchId }],
      [{ route: null }, { username: 'viewer.a', route: 'MCT-01', changed: ['fullName'], batchId }],
    ]);
  });

  it('the self-change and admin-tier messages still win for their own cases', async () => {
    addUser({ id: 'm1', username: 'manager.x', role: 'MANAGER', regionIds: ['rg-mct'] });
    const { messages } = await upload(
      usersSheet(
        { username: 'steward.x', full_name: 'S', role: 'VIEWER', change_role: 'yes' },
        { username: 'manager.x', full_name: 'M', role: 'VIEWER', change_role: 'yes' }
      )
    );
    expect(messages).toEqual([
      'Users 2: cannot change your own role via import',
      'Users 3: promoting/demoting MANAGER or STEWARD via import is not permitted — use the Users UI',
    ]);
  });
});

// ── X-IMPORTS-2 ──────────────────────────────────────────────────────────────
describe('X-IMPORTS-2: a deactivated account is never handed a route', () => {
  it('the active owner keeps the route, and nothing is written for the deactivated one', async () => {
    addUser({ id: 's1', username: 'mct-01', role: 'SALESMAN', isActive: false });
    addUser({ id: 's2', username: 'mct-01b', role: 'SALESMAN', ownedRouteId: 'rt-1' });
    const { res, messages } = await upload(
      usersSheet({ username: 'mct-01', full_name: 'Gone', role: 'SALESMAN', route_code: 'MCT-01' })
    );
    expect(okData(res).clean).toBe(0);
    expect(messages.join(' ')).toMatch(
      /"mct-01" is deactivated, so route MCT-01 is not handed to it/
    );
    expect(routeOwner('rt-1')).toBe('mct-01b');
    expect(find('mct-01')!.fullName).toBe('Name mct-01');
    expect(rowAudits()).toEqual([]);
  });

  it('a deactivated account that still owns the route is left as it is — nothing changes hands', async () => {
    addUser({
      id: 's1',
      username: 'mct-01',
      role: 'SALESMAN',
      isActive: false,
      ownedRouteId: 'rt-1',
    });
    const { res } = await upload(
      usersSheet({
        username: 'mct-01',
        full_name: 'Name mct-01',
        role: 'SALESMAN',
        route_code: 'MCT-01',
      })
    );
    expect(okData(res).clean).toBe(1);
    expect(routeOwner('rt-1')).toBe('mct-01');
    expect(rowAudits()).toEqual([]);
  });
});

// ── X-IMPORTS-4 ──────────────────────────────────────────────────────────────
describe('X-IMPORTS-4: a blank email or phone cell keeps the stored value', () => {
  it('keeps them on a re-import, sets a new value when given one, and leaves a new account empty', async () => {
    addUser({
      id: 'v1',
      username: 'viewer.a',
      role: 'VIEWER',
      email: 'kept@x.invalid',
      phone: '+96890000001',
    });
    addUser({ id: 'v2', username: 'viewer.b', role: 'VIEWER', email: 'old@x.invalid' });
    const { res } = await upload(
      usersSheet(
        { username: 'viewer.a', full_name: 'A', role: 'VIEWER', email: '', phone: '' },
        { username: 'viewer.b', full_name: 'B', role: 'VIEWER', email: 'new@x.invalid' },
        { username: 'viewer.c', full_name: 'C', role: 'VIEWER', password: '123456789012' }
      )
    );
    expect(okData(res).clean).toBe(3);
    expect(find('viewer.a')).toMatchObject({ email: 'kept@x.invalid', phone: '+96890000001' });
    expect(find('viewer.b')!.email).toBe('new@x.invalid');
    expect(find('viewer.c')).toMatchObject({ email: null, phone: null });
  });
});

// ── ENH-6 ────────────────────────────────────────────────────────────────────
describe('ENH-6: an imported role change ends the person’s sessions, as the Users UI does', () => {
  it('stamps sessionsRevokedAt on a real change only', async () => {
    const earlier = new Date(Date.UTC(2026, 0, 1));
    addUser({
      id: 'a1',
      username: 'acct.a',
      role: 'ACCOUNTANT',
      regionIds: ['rg-mct'],
      sessionsRevokedAt: earlier,
    });
    addUser({ id: 'v1', username: 'viewer.a', role: 'VIEWER', sessionsRevokedAt: earlier });
    addUser({ id: 'v2', username: 'viewer.b', role: 'VIEWER', sessionsRevokedAt: earlier });
    const start = Date.now();
    const { res } = await upload(
      usersSheet(
        { username: 'acct.a', full_name: 'A', role: 'VIEWER', change_role: 'yes' },
        // change_role=yes naming the role the account already has: no change.
        { username: 'viewer.a', full_name: 'Name viewer.a', role: 'VIEWER', change_role: 'yes' },
        // A routine re-import row.
        { username: 'viewer.b', full_name: 'Name viewer.b', role: 'VIEWER' }
      )
    );
    expect(okData(res).clean).toBe(3);
    expect(find('acct.a')!.role).toBe('VIEWER');
    expect(find('acct.a')!.sessionsRevokedAt!.getTime()).toBeGreaterThanOrEqual(start);
    expect(find('viewer.a')!.sessionsRevokedAt).toEqual(earlier);
    expect(find('viewer.b')!.sessionsRevokedAt).toEqual(earlier);
  });
});

// ── X-IMPORTS-1 / X-AUTH-3 ───────────────────────────────────────────────────
describe('X-IMPORTS-1 / X-AUTH-3: every account, route and region the import changes is audited', () => {
  it('a new account gets one CREATE row with no password, hash, name or contact value', async () => {
    addUser({ id: 'sup', username: 'sup.a', role: 'SUPERVISOR' });
    const { res } = await upload(
      usersSheet({
        username: 'mct-02',
        full_name: 'New Salesman',
        role: 'SALESMAN',
        route_code: 'MCT-02',
        supervisor_username: 'sup.a',
        password: '1234',
        must_change_password: 'yes',
        email: 'new.salesman@x.invalid',
      })
    );
    expect(okData(res).clean).toBe(1);
    const id = find('mct-02')!.id;
    expect(rowAudits()).toEqual([
      {
        action: 'CREATE',
        entityType: 'User',
        entityId: id,
        after: {
          username: 'mct-02',
          role: 'SALESMAN',
          batchId: h.store.batches[0].id,
          supervisor: 'sup.a',
          route: 'MCT-02',
          regions: [],
          mustChangePassword: true,
          contactGiven: ['email'],
        },
        reason: 'account_import',
        viaTx: true,
      },
    ]);
    expect(JSON.stringify(h.store.audits)).not.toMatch(/1234|hashed:|new\.salesman@|New Salesman/);
  });

  it('a changed account gets one UPDATE row with what changed; an unchanged re-import writes none', async () => {
    addUser({
      id: 's1',
      username: 'mct-01',
      role: 'SALESMAN',
      ownedRouteId: 'rt-1',
      fullName: 'Ali',
    });
    const row = { username: 'mct-01', full_name: 'Ali', role: 'SALESMAN', route_code: 'MCT-02' };
    const first = await upload(usersSheet(row));
    expect(okData(first.res).clean).toBe(1);
    expect(rowAudits()).toEqual([
      {
        action: 'UPDATE',
        entityType: 'User',
        entityId: 's1',
        before: { route: 'MCT-01' },
        after: { username: 'mct-01', route: 'MCT-02', batchId: first.batch!.id },
        reason: 'account_import',
        viaTx: true,
      },
    ]);
    h.store.audits = [];
    const again = await upload(usersSheet(row));
    expect(okData(again.res).clean).toBe(1);
    expect(rowAudits()).toEqual([]);
  });

  it('a new region, a renamed one and a new route are audited; unchanged rows are not', async () => {
    const { res } = await upload([
      {
        name: 'Regions',
        rows: [
          { code: 'MCT', name: 'Muscat' },
          { code: 'BAT', name: 'Al Batinah' },
          { code: 'DHO', name: 'Dhofar' },
        ],
      },
      {
        name: 'Routes',
        rows: [
          { code: 'MCT-01', name: 'Muscat 1', region_code: 'MCT' },
          { code: 'DHO-01', name: 'Salalah 1', region_code: 'DHO' },
        ],
      },
    ]);
    expect(okData(res).clean).toBe(5);
    const dho = h.store.regions.find((r) => r.code === 'DHO')!;
    const dhoRoute = h.store.routes.find((r) => r.code === 'DHO-01')!;
    const batchId = h.store.batches[0].id;
    expect(rowAudits()).toEqual([
      {
        action: 'UPDATE',
        entityType: 'Region',
        entityId: 'rg-bat',
        before: { name: 'Batinah' },
        after: { name: 'Al Batinah', batchId },
        reason: 'account_import',
        viaTx: true,
      },
      {
        action: 'CREATE',
        entityType: 'Region',
        entityId: dho.id,
        after: { code: 'DHO', name: 'Dhofar', batchId },
        reason: 'account_import',
        viaTx: true,
      },
      {
        action: 'CREATE',
        entityType: 'Route',
        entityId: dhoRoute.id,
        after: { code: 'DHO-01', name: 'Salalah 1', regionCode: 'DHO', batchId },
        reason: 'account_import',
        viaTx: true,
      },
    ]);
  });

  it('a route moved to another region records both region codes', async () => {
    const { res } = await upload([
      { name: 'Routes', rows: [{ code: 'MCT-02', name: 'Muscat 2', region_code: 'BAT' }] },
    ]);
    expect(okData(res).clean).toBe(1);
    expect(h.store.routes.find((r) => r.code === 'MCT-02')!.regionId).toBe('rg-bat');
    expect(rowAudits()).toEqual([
      {
        action: 'UPDATE',
        entityType: 'Route',
        entityId: 'rt-2',
        before: { regionCode: 'MCT' },
        after: { regionCode: 'BAT', batchId: h.store.batches[0].id },
        reason: 'account_import',
        viaTx: true,
      },
    ]);
  });

  it('a failed audit leaves the route where it was', async () => {
    h.auditFails = (p) => p.reason === 'account_import';
    const { res, messages } = await upload([
      { name: 'Routes', rows: [{ code: 'MCT-02', name: 'Muscat 2', region_code: 'BAT' }] },
    ]);
    expect(okData(res).clean).toBe(0);
    expect(messages).toEqual([
      `Routes 2: nothing was written for route "MCT-02": it could not be saved (Error).`,
    ]);
    expect(h.store.routes.find((r) => r.code === 'MCT-02')!.regionId).toBe('rg-mct');
  });
});

describe('X-IMPORTS-1: a bare password reset and a bare role change still name their batch', () => {
  it('each writes one row, and it carries the batch id', async () => {
    addUser({ id: 's1', username: 'mct-01', role: 'SALESMAN', ownedRouteId: 'rt-1' });
    addUser({ id: 'v1', username: 'viewer.a', role: 'VIEWER' });
    // Nothing else about either account changes, so neither gets an account_import row.
    const { res, batch } = await upload(
      usersSheet(
        {
          username: 'mct-01',
          full_name: 'Name mct-01',
          role: 'SALESMAN',
          route_code: 'MCT-01',
          password: 'A-new-password-1',
          reset_password: 'yes',
        },
        { username: 'viewer.a', full_name: 'Name viewer.a', role: 'GM', change_role: 'yes' }
      )
    );
    expect(okData(res).clean).toBe(2);
    // GM is not in the Users sheet's sort order, so its row is taken first.
    expect(rowAudits()).toEqual([
      {
        action: 'UPDATE',
        entityType: 'User',
        entityId: 'v1',
        before: { role: 'VIEWER' },
        after: { role: 'GM', batchId: batch!.id },
        reason: 'role_change_via_import',
        viaTx: true,
      },
      {
        action: 'UPDATE',
        entityType: 'User',
        entityId: 's1',
        after: { batchId: batch!.id },
        reason: 'password_reset_via_import',
        viaTx: true,
      },
    ]);
  });
});

// ── the Users UI's rules, applied to the import (post-merge review) ──────────
describe('AUTH-06: supervisor_username names an active SUPERVISOR or MANAGER, as in the Users UI', () => {
  const newSalesman = (supervisor: string) => ({
    username: 'mct-02',
    full_name: 'New',
    role: 'SALESMAN',
    route_code: 'MCT-02',
    supervisor_username: supervisor,
    password: '123456789012',
  });

  it.each<[string, Partial<U>, string]>([
    [
      'a salesman',
      { role: 'SALESMAN', ownedRouteId: 'rt-1' },
      'is SALESMAN, and only a SUPERVISOR or MANAGER can supervise.',
    ],
    ['a viewer', { role: 'VIEWER' }, 'is VIEWER, and only a SUPERVISOR or MANAGER can supervise.'],
    [
      'an accountant',
      { role: 'ACCOUNTANT', regionIds: ['rg-mct'] },
      'is ACCOUNTANT, and only a SUPERVISOR or MANAGER can supervise.',
    ],
    ['a deactivated manager', { role: 'MANAGER', isActive: false }, 'is deactivated.'],
  ])('a new account naming %s is held back, and nothing is written', async (_, over, why) => {
    addUser({ id: 'x1', username: 'someone', role: 'SALESMAN', ...over });
    const { res, messages } = await upload(usersSheet(newSalesman('someone')));
    expect(okData(res).clean).toBe(0);
    expect(messages).toEqual([
      `Users 2: supervisor "someone" ${why} Nothing was written. Name an active SUPERVISOR or MANAGER in supervisor_username.`,
    ]);
    expect(find('mct-02')).toBeUndefined();
    expect(routeOwner('rt-2')).toBeNull();
    expect(rowAudits()).toEqual([]);
  });

  it('an existing account naming a viewer is held back, and keeps its supervisor and everything else', async () => {
    addUser({ id: 'sup', username: 'sup.a', role: 'SUPERVISOR' });
    addUser({ id: 'v1', username: 'viewer.a', role: 'VIEWER' });
    addUser({
      id: 's1',
      username: 'mct-01',
      role: 'SALESMAN',
      ownedRouteId: 'rt-1',
      supervisorId: 'sup',
    });
    const { res, messages } = await upload(
      usersSheet({
        username: 'mct-01',
        full_name: 'Renamed',
        role: 'SALESMAN',
        route_code: 'MCT-01',
        supervisor_username: 'viewer.a',
      })
    );
    expect(okData(res).clean).toBe(0);
    expect(messages[0]).toMatch(/^Users 2: supervisor "viewer\.a" is VIEWER, .*Nothing was written/);
    expect(find('mct-01')).toMatchObject({ supervisorId: 'sup', fullName: 'Name mct-01' });
    expect(rowAudits()).toEqual([]);
  });

  it('an active SUPERVISOR or MANAGER is accepted, on a new account and an existing one', async () => {
    addUser({ id: 'sup', username: 'sup.a', role: 'SUPERVISOR' });
    addUser({ id: 'm1', username: 'manager.x', role: 'MANAGER', regionIds: ['rg-mct'] });
    addUser({
      id: 's1',
      username: 'mct-01',
      role: 'SALESMAN',
      ownedRouteId: 'rt-1',
      supervisorId: 'sup',
    });
    const { res } = await upload(
      usersSheet(
        {
          username: 'mct-01',
          full_name: 'Name mct-01',
          role: 'SALESMAN',
          route_code: 'MCT-01',
          supervisor_username: 'manager.x',
        },
        newSalesman('sup.a')
      )
    );
    expect(okData(res).clean).toBe(2);
    expect(find('mct-01')!.supervisorId).toBe('m1');
    expect(find('mct-02')!.supervisorId).toBe('sup');
  });

  it('a row naming the supervisor the account already has is not judged again, even once he is deactivated', async () => {
    // Re-importing the go-live sheet after a manager left: the cell changes
    // nothing, so it must not hold back the row's other changes. Naming him for
    // a NEW account is still refused (the it.each above).
    addUser({ id: 'm1', username: 'manager.x', role: 'MANAGER', isActive: false });
    addUser({ id: 's1', username: 'mct-01', role: 'SALESMAN', ownedRouteId: 'rt-1', supervisorId: 'm1' });
    const { res, messages } = await upload(
      usersSheet({
        username: 'mct-01',
        full_name: 'Renamed',
        role: 'SALESMAN',
        route_code: 'MCT-01',
        supervisor_username: 'manager.x',
      })
    );
    expect(messages).toEqual([]);
    expect(okData(res).clean).toBe(1);
    expect(find('mct-01')).toMatchObject({ supervisorId: 'm1', fullName: 'Renamed' });
  });
});

describe('a Supervisor with reports keeps the role until they are reassigned, as in the Users UI', () => {
  it('holds the role change back, says how many reports, and writes nothing', async () => {
    const earlier = new Date(Date.UTC(2026, 0, 1));
    addUser({ id: 'sup', username: 'sup.a', role: 'SUPERVISOR', sessionsRevokedAt: earlier });
    addUser({ id: 's1', username: 'mct-01', role: 'SALESMAN', ownedRouteId: 'rt-1', supervisorId: 'sup' });
    addUser({ id: 's2', username: 'mct-02', role: 'SALESMAN', ownedRouteId: 'rt-2', supervisorId: 'sup' });
    const { res, messages } = await upload(
      usersSheet({ username: 'sup.a', full_name: 'Renamed', role: 'VIEWER', change_role: 'yes' })
    );
    expect(okData(res).clean).toBe(0);
    expect(messages).toEqual([
      `Users 2: "sup.a" is a SUPERVISOR with 2 report(s). Nothing was written. Reassign the 2 salesman/supervisor report(s) before changing this Supervisor's role.`,
    ]);
    expect(find('sup.a')).toMatchObject({
      role: 'SUPERVISOR',
      fullName: 'Name sup.a',
      sessionsRevokedAt: earlier,
    });
    expect(find('mct-01')!.supervisorId).toBe('sup');
    expect(rowAudits()).toEqual([]);
  });

  it('a Supervisor with no reports changes role; one with reports can still be re-imported as a Supervisor', async () => {
    addUser({ id: 'sup', username: 'sup.a', role: 'SUPERVISOR' });
    addUser({ id: 'sup2', username: 'sup.b', role: 'SUPERVISOR' });
    addUser({ id: 's1', username: 'mct-01', role: 'SALESMAN', ownedRouteId: 'rt-1', supervisorId: 'sup' });
    const { res } = await upload(
      usersSheet(
        { username: 'sup.a', full_name: 'Renamed', role: 'SUPERVISOR', change_role: 'yes' },
        { username: 'sup.b', full_name: 'Name sup.b', role: 'VIEWER', change_role: 'yes' }
      )
    );
    expect(okData(res).clean).toBe(2);
    expect(find('sup.a')).toMatchObject({ role: 'SUPERVISOR', fullName: 'Renamed' });
    expect(find('sup.b')!.role).toBe('VIEWER');
  });
});

describe('B-15: an import reset refuses a reused password and keeps the history, as the Users UI reset does', () => {
  const salesman = () =>
    addUser({
      id: 's1',
      username: 'mct-01',
      role: 'SALESMAN',
      ownedRouteId: 'rt-1',
      passwordHash: 'hashed:Current-pass-1',
    });
  const resetRow = (password: string) => ({
    username: 'mct-01',
    full_name: 'Name mct-01',
    role: 'SALESMAN',
    route_code: 'MCT-01',
    password,
    reset_password: 'yes',
    must_change_password: 'yes',
  });

  it('the old hash joins the history in the row transaction, so the forced change cannot go back to it', async () => {
    salesman();
    const { res, batch } = await upload(usersSheet(resetRow('Temp1234')));
    expect(okData(res).clean).toBe(1);
    const u = find('mct-01')!;
    expect(u).toMatchObject({ passwordHash: 'hashed:Temp1234', mustChangePassword: true });
    expect(h.store.history.map((r) => [r.userId, r.hash])).toEqual([['s1', 'hashed:Current-pass-1']]);
    // The finding's last step: at the forced change, the pre-reset password is refused.
    await expect(assertPasswordNotReused(u.id, u.passwordHash, 'Current-pass-1')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: { newPassword: 'You cannot reuse one of your last 5 passwords.' },
    });
    expect(rowAudits()).toEqual([
      {
        action: 'UPDATE',
        entityType: 'User',
        entityId: 's1',
        after: { batchId: batch!.id },
        reason: 'password_reset_via_import',
        viaTx: true,
      },
      {
        action: 'UPDATE',
        entityType: 'User',
        entityId: 's1',
        before: { mustChangePassword: false },
        after: { username: 'mct-01', mustChangePassword: true, batchId: batch!.id },
        reason: 'account_import',
        viaTx: true,
      },
    ]);
  });

  it.each<[string, string, History[]]>([
    ['its current password', 'Current-pass-1', []],
    [
      'one of its last five',
      'Older-pass-12',
      [{ id: 'ph-old', userId: 's1', hash: 'hashed:Older-pass-12', at: 0 }],
    ],
  ])('a reset to %s is held back, nothing is written, and the password is nowhere', async (_, pw, history) => {
    salesman();
    h.store.history.push(...history);
    const { res, messages } = await upload(usersSheet(resetRow(pw)));
    expect(okData(res).clean).toBe(0);
    expect(messages).toEqual([
      'Users 2: the new password for "mct-01" is its current password or one of its last five, so it was not issued. Nothing was written. Choose a different password.',
    ]);
    expect(find('mct-01')).toMatchObject({
      passwordHash: 'hashed:Current-pass-1',
      sessionsRevokedAt: null,
      mustChangePassword: false,
    });
    expect(h.store.history).toEqual(history);
    expect(rowAudits()).toEqual([]);
    const said = JSON.stringify([
      h.store.importRows,
      h.store.audits,
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.warn).mock.calls,
      vi.mocked(logger.error).mock.calls,
      h.capture.mock.calls,
    ]);
    expect(said).not.toContain(pw);
  });

  it('the same reset uploaded again is held back as reused, not issued again (what IMPORT_INTERRUPTED tells the Steward)', async () => {
    salesman();
    expect(okData((await upload(usersSheet(resetRow('Temp1234')))).res).clean).toBe(1);
    const first = { ...find('mct-01')! };
    h.store.audits = [];
    const again = await upload(usersSheet(resetRow('Temp1234')));
    expect(okData(again.res).clean).toBe(0);
    expect(again.messages).toEqual([
      expect.stringMatching(/^Users 2: the new password for "mct-01" is its current password/),
    ]);
    expect(find('mct-01')).toEqual(first);
    expect(h.store.history).toHaveLength(1);
    expect(rowAudits()).toEqual([]);
  });

  it("the Steward's own row is refused, as the Users UI refuses a reset of one's own account", async () => {
    const { res, messages } = await upload(
      usersSheet({
        username: 'steward.x',
        full_name: 'Name steward.x',
        role: 'STEWARD',
        password: 'A-new-password-1',
        reset_password: 'yes',
      })
    );
    expect(okData(res).clean).toBe(0);
    expect(messages).toEqual([
      'Users 2: cannot reset your own password via import — use /profile to change your own account',
    ]);
    expect(find('steward.x')).toMatchObject({ passwordHash: 'old-hash', sessionsRevokedAt: null });
    expect(h.store.history).toEqual([]);
    expect(rowAudits()).toEqual([]);
  });

  it('a database fault in the reuse check costs the row as a fault, not as a reused password', async () => {
    salesman();
    h.failOn = (model, op) =>
      model === 'passwordHistory' && op === 'findMany' ? prismaError('P2024') : undefined;
    const { res, messages } = await upload(usersSheet(resetRow('Temp1234')));
    expect(okData(res).clean).toBe(0);
    expect(messages).toEqual([
      'Users 2: the database did not answer (P2024), so nothing was written for "mct-01". Import this row again.',
    ]);
    expect(find('mct-01')!.passwordHash).toBe('hashed:Current-pass-1');
  });
});

// ── X-IMPORTS-3 ──────────────────────────────────────────────────────────────
describe('X-IMPORTS-3: a database fault mid-import is reported as what it was', () => {
  const viewers = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      username: `viewer.${i + 1}`,
      full_name: `V${i + 1}`,
      role: 'VIEWER',
      password: '123456789012',
    }));

  it('one row whose lookup times out is held back alone; the rest land and the batch is finalised', async () => {
    h.failOn = (model, op, args) =>
      model === 'user' && op === 'findUnique' && args.where.username === 'viewer.3'
        ? prismaError('P2024')
        : undefined;
    const { res, batch, messages } = await upload(usersSheet(...viewers(4)));
    const data = okData(res);
    expect(data).toMatchObject({ clean: 3, issues: 1 });
    expect(messages).toEqual([
      'Users 4: the database did not answer (P2024), so nothing was written for "viewer.3". Import this row again.',
    ]);
    expect(batch).toMatchObject({
      status: 'PROMOTED',
      cleanRows: 3,
      quarantinedRows: 1,
      promotedRows: 3,
    });
    expect(find('viewer.4')).toBeTruthy();
  });

  it('after three database failures in a row it stops, records the rest as not processed, and says what was applied', async () => {
    h.failOn = (model, op, args) =>
      model === 'user' && op === 'findUnique' && /^viewer\.[345]$/.test(args.where.username)
        ? prismaError('P1001')
        : undefined;
    const { res, batch, messages } = await upload(usersSheet(...viewers(7)));
    expect(res.ok).toBe(false);
    const fail = res as { ok: false; code: string; message: string };
    expect(fail.code).toBe('IMPORT_INTERRUPTED');
    expect(fail.message).toMatch(/2 row\(s\) were applied and are saved/);
    expect(fail.message).toMatch(
      /The 5 row\(s\) that were not applied are listed on this upload's batch page/
    );
    expect(fail.message).not.toMatch(/Nothing was saved/i);
    expect(batch).toMatchObject({ status: 'PROMOTED', cleanRows: 2, quarantinedRows: 5 });
    expect(messages.slice(3)).toEqual([
      expect.stringMatching(/^Users 7: not processed: /),
      expect.stringMatching(/^Users 8: not processed: /),
    ]);
    expect(find('viewer.6')).toBeUndefined();
    expect(find('viewer.7')).toBeUndefined();
  });

  it('when the batch record itself cannot be saved, the answer counts what was applied instead of "Nothing was saved"', async () => {
    h.failOn = (model, op) =>
      model === 'importBatch' && op === 'update' ? prismaError('P1001') : undefined;
    const { res, batch } = await upload(usersSheet(...viewers(2)));
    expect(res.ok).toBe(false);
    const fail = res as { ok: false; code: string; message: string };
    expect(fail.code).toBe('IMPORT_INTERRUPTED');
    expect(fail.message).toMatch(
      /^2 row\(s\) were applied and are saved, but the database stopped answering/
    );
    expect(find('viewer.1')).toBeTruthy();
    expect(batch!.status).toBe('PARSING');
    // No summary audit is attempted against a database that has just refused a write.
    expect(h.store.audits.filter((a) => a.entityType === 'ImportBatch')).toEqual([]);
  });

  it('a unique clash on e-mail names the field and never the value', async () => {
    addUser({ id: 'v9', username: 'viewer.9', role: 'VIEWER', email: 'taken@x.invalid' });
    const { res, messages } = await upload(
      usersSheet({
        username: 'viewer.1',
        full_name: 'V',
        role: 'VIEWER',
        password: '123456789012',
        email: 'taken@x.invalid',
      })
    );
    expect(okData(res).clean).toBe(0);
    expect(messages).toEqual([
      'Users 2: nothing was written for "viewer.1": its email is already used by another record.',
    ]);
    expect(find('viewer.1')).toBeUndefined();
  });

  // Launch fix (2026-10-07): the unique index is case-sensitive, so the same
  // mailbox in other capitals used to be written to a second account.
  it('an e-mail another account holds in other capitals is held back, in the words of the unique clash', async () => {
    addUser({ id: 'v9', username: 'viewer.9', role: 'VIEWER', email: 'Taken@X.invalid' });
    const { res, messages } = await upload(
      usersSheet({
        username: 'viewer.1',
        full_name: 'V',
        role: 'VIEWER',
        password: '123456789012',
        email: 'taken@x.INVALID',
      })
    );
    expect(okData(res).clean).toBe(0);
    expect(messages).toEqual([
      'Users 2: nothing was written for "viewer.1": its email is already used by another record.',
    ]);
    expect(find('viewer.1')).toBeUndefined();
  });

  it('an e-mail is stored lower-cased, and the account’s own address in other capitals is no clash', async () => {
    addUser({ id: 'v8', username: 'viewer.8', role: 'VIEWER', email: 'Own@X.invalid' });
    const { res } = await upload(
      usersSheet(
        { username: 'viewer.8', full_name: 'Eight', role: 'VIEWER', email: 'OWN@x.invalid' },
        { username: 'viewer.1', full_name: 'One', role: 'VIEWER', password: '123456789012', email: ' New.One@X.Invalid ' }
      )
    );
    expect(okData(res)).toMatchObject({ clean: 2, issues: 0 });
    expect(find('viewer.8')!.email).toBe('own@x.invalid');
    expect(find('viewer.1')!.email).toBe('new.one@x.invalid');
  });

  // ── the run is of failures IN A ROW ──
  const failLookup = (code: string, names: RegExp) => (model: string, op: string, args: any) =>
    model === 'user' && op === 'findUnique' && names.test(args.where.username)
      ? prismaError(code)
      : undefined;

  it('three transient failures with a rule-held row between them do not stop the import', async () => {
    // viewer.2 is read, then held back by a rule (a new account with no password):
    // the database answered for it, so the run of failures is broken there.
    h.failOn = failLookup('P1001', /^viewer\.[134]$/);
    const rows = viewers(5);
    rows[1] = { username: 'viewer.2', full_name: 'V2', role: 'VIEWER', password: '' };
    const { res, messages } = await upload(usersSheet(...rows));
    const data = okData(res);
    expect(data).toMatchObject({ clean: 1, issues: 4 });
    expect(messages).toEqual([
      expect.stringMatching(/^Users 2: the database did not answer \(P1001\)/),
      'Users 3: new user needs a password',
      expect.stringMatching(/^Users 4: the database did not answer \(P1001\)/),
      expect.stringMatching(/^Users 5: the database did not answer \(P1001\)/),
    ]);
    expect(find('viewer.5')).toBeTruthy();
  });

  it('the same on the Routes sheet: a route held back for an unknown region breaks the run', async () => {
    h.failOn = (model, op, args) =>
      model === 'region' && op === 'findUnique' && args.where.code === 'MCT'
        ? prismaError('P1001')
        : undefined;
    const route = (code: string, region: string) => ({ code, name: code, region_code: region });
    const { res, messages } = await upload([
      {
        name: 'Routes',
        rows: [
          route('R-1', 'MCT'),
          route('R-2', 'NOPE'),
          route('R-3', 'MCT'),
          route('R-4', 'MCT'),
          route('R-5', 'BAT'),
        ],
      },
    ]);
    expect(okData(res)).toMatchObject({ clean: 1, issues: 4 });
    expect(messages[1]).toBe('Routes 3: region "NOPE" not found');
    expect(h.store.routes.some((r) => r.code === 'R-5')).toBe(true);
  });

  it('a row whose read answered and whose write then timed out is still one of the three', async () => {
    h.failOn = (model, op, args) =>
      model === 'user' && op === 'upsert' && /^viewer\.[123]$/.test(args.where.username)
        ? prismaError('P2028')
        : undefined;
    const { res, messages } = await upload(usersSheet(...viewers(4)));
    expect(res.ok).toBe(false);
    expect((res as { code: string }).code).toBe('IMPORT_INTERRUPTED');
    expect(messages.at(-1)).toMatch(/^Users 5: not processed: /);
    expect(find('viewer.4')).toBeUndefined();
  });
});

// ── what a failure leaves behind ─────────────────────────────────────────────
describe('a failed row or report is logged with its message, and reported unless the database went away', () => {
  const warned = (event: string) =>
    vi
      .mocked(logger.warn)
      .mock.calls.filter((c) => c[1] === event)
      .map((c) => c[0] as Record<string, unknown>);

  it('an unexpected fault is logged by name and scrubbed message, and sent to Sentry cut down', async () => {
    h.failOn = (model, op, args) => {
      if (model !== 'user' || op !== 'upsert') return undefined;
      if (args.where.username === 'viewer.1')
        return new TypeError("Cannot read properties of undefined (reading 'id') ali@example.invalid");
      if (args.where.username === 'viewer.2') return prismaError('P2024');
      return undefined;
    };
    const { res, messages } = await upload(
      usersSheet(
        { username: 'viewer.1', full_name: 'V1', role: 'VIEWER', password: '123456789012' },
        { username: 'viewer.2', full_name: 'V2', role: 'VIEWER', password: '123456789012' }
      )
    );
    expect(okData(res).clean).toBe(0);
    // The Steward's issue still names the error type only.
    expect(messages[0]).toBe('Users 2: nothing was written for "viewer.1": it could not be saved (TypeError).');
    const lines = warned('import.account.row_failed');
    expect(lines).toEqual([
      expect.objectContaining({
        sheet: 'Users',
        row: 2,
        errName: 'TypeError',
        err: "Cannot read properties of undefined (reading 'id') [email]",
        transient: false,
      }),
      expect.objectContaining({
        sheet: 'Users',
        row: 3,
        code: 'P2024',
        errName: 'Error',
        err: 'Invalid invocation (P2024): [email][phone]',
        transient: true,
      }),
    ]);
    // Sentry hears about the bug, not about the database that did not answer.
    expect(h.capture).toHaveBeenCalledTimes(1);
    const [sent, ctx] = h.capture.mock.calls[0];
    expect(sent).toBeInstanceOf(Error);
    expect(sent.name).toBe('TypeError');
    expect(sent.message).toBe("Cannot read properties of undefined (reading 'id') [email]");
    expect(ctx).toEqual({ tags: { event: 'import.account.row_failed' } });
  });

  it('a report the database refused is not blamed on the database going away, and is sent to Sentry', async () => {
    h.failOn = (model, op) =>
      model === 'importBatch' && op === 'update' ? prismaError('P2000') : undefined;
    const { res } = await upload(usersSheet({ username: 'viewer.1', full_name: 'V', role: 'VIEWER', password: '123456789012' }));
    expect(res.ok).toBe(false);
    const fail = res as { ok: false; code: string; message: string };
    expect(fail.code).toBe('IMPORT_INTERRUPTED');
    expect(fail.message).toMatch(
      /^1 row\(s\) were applied and are saved, but this upload's report could not be saved \(P2000\)/
    );
    expect(fail.message).not.toMatch(/stopped answering/);
    expect(vi.mocked(logger.error).mock.calls.find((c) => c[1] === 'import.account.not_recorded')?.[0]).toMatchObject({
      code: 'P2000',
      errName: 'Error',
      err: 'Invalid invocation (P2000): [email][phone]',
      transient: false,
    });
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.capture.mock.calls[0][1]).toEqual({ tags: { event: 'import.account.not_recorded' } });
  });

  it('a report the database did not answer for still says so, and is not sent to Sentry', async () => {
    h.failOn = (model, op) =>
      model === 'importBatch' && op === 'update' ? prismaError('P1001') : undefined;
    const { res } = await upload(usersSheet({ username: 'viewer.1', full_name: 'V', role: 'VIEWER', password: '123456789012' }));
    expect((res as { message: string }).message).toMatch(
      /but the database stopped answering before this upload's report could be saved/
    );
    expect(h.capture).not.toHaveBeenCalled();
  });
});

// ── N05 in the account import ────────────────────────────────────────────────
describe('N05: rows are numbered as Excel shows them, and only the sheets read are checked for repeated headings', () => {
  it('reports the Excel row number on every sheet, blank lines included', async () => {
    const { res, messages } = await uploadWorkbook((wb) => {
      const regions = wb.addWorksheet('Regions');
      regions.getCell('A1').value = 'code';
      regions.getCell('B1').value = 'name';
      regions.getCell('A2').value = 'MCT';
      regions.getCell('B2').value = 'Muscat';
      regions.getCell('A4').value = 'NONAME'; // row 3 blank
      const routes = wb.addWorksheet('Routes');
      routes.getCell('A1').value = 'code';
      routes.getCell('B1').value = 'name';
      routes.getCell('C1').value = 'region_code';
      routes.getCell('A3').value = 'MCT-09'; // row 2 blank; no name, no region
      const users = wb.addWorksheet('Users');
      ['username', 'full_name', 'role', 'password'].forEach((v, i) => (users.getRow(1).getCell(i + 1).value = v));
      users.getRow(2).values = ['viewer.1', 'V1', 'VIEWER', '123456789012'];
      // Row 3 left blank, as people do between groups.
      users.getRow(4).values = ['viewer.2', '', 'VIEWER', '123456789012'];
      users.getRow(6).values = ['viewer.3', 'V3', 'VIEWER', '123456789012'];
    });
    expect(okData(res)).toMatchObject({ clean: 3, issues: 3 });
    expect(messages).toEqual([
      'Regions 4: code and name required',
      'Routes 3: code, name, region_code required',
      'Users 4: username, full_name, role required',
    ]);
    expect(find('viewer.3')).toBeTruthy();
  });

  it('the Users sheet sorted by role still reports each row where Excel has it', async () => {
    const { messages } = await uploadWorkbook((wb) => {
      const users = wb.addWorksheet('Users');
      ['username', 'full_name', 'role', 'password'].forEach((v, i) => (users.getRow(1).getCell(i + 1).value = v));
      users.getRow(2).values = ['viewer.1', 'V1', 'VIEWER', 'short'];
      users.getRow(5).values = ['sup.1', 'S1', 'SUPERVISOR', 'short'];
    });
    // Supervisors are processed first; each keeps its own row number.
    expect(messages).toEqual([
      'Users 5: password must be 12+ chars (or set must_change_password=yes)',
      'Users 2: password must be 12+ chars (or set must_change_password=yes)',
    ]);
  });

  it('a heading repeated on a sheet the import does not read does not refuse the file', async () => {
    const { res } = await uploadWorkbook((wb) => {
      wb.addWorksheet('Instructions').addRow(['Note', 'note']);
      const users = wb.addWorksheet('Users');
      users.addRow(['username', 'full_name', 'role', 'password']);
      users.addRow(['viewer.1', 'V1', 'VIEWER', '123456789012']);
    });
    expect(okData(res).clean).toBe(1);
    expect(find('viewer.1')).toBeTruthy();
  });

  it('a heading repeated on a sheet it reads refuses the file before anything is written', async () => {
    const { res } = await uploadWorkbook((wb) => {
      const users = wb.addWorksheet('Users');
      users.addRow(['username', 'full_name', 'role', 'password', 'Role']);
      users.addRow(['viewer.1', 'V1', 'VIEWER', '123456789012', 'MANAGER']);
    });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain(
      'Sheet \\"Users\\": the heading \\"Role\\" is in more than one column (C and E)'
    );
    expect(h.store.batches).toEqual([]);
    expect(find('viewer.1')).toBeUndefined();
  });
});
