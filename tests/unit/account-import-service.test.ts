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
 * tests/integration/import-route-handover.test.ts proves F07's rollback, F08,
 * X-IMPORTS-1, -2 and -4 and ENH-6 against Postgres in CI (RUN_IMPORT_TESTS).
 */
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
type Store = {
  users: U[];
  regions: Region[];
  routes: RouteRow[];
  audits: Audit[];
  batches: Array<Record<string, unknown> & { id: string }>;
  importRows: Array<{
    batchId: string;
    issues: Array<{ message: string; sheet: string; row: number }>;
  }>;
};
type Sheet = { name: string; headers: string[]; rows: Array<Record<string, string>> };

const h = vi.hoisted(() => ({
  store: null as unknown as Store,
  sheets: [] as Sheet[],
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
vi.mock('@/lib/excel', () => ({ parseWorkbook: async () => h.sheets }));
vi.mock('bcryptjs', () => ({ default: { hash: async (p: string) => `hashed:${p}` } }));

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
  }));
  const fd = new FormData();
  fd.set('file', new File([new Uint8Array([1, 2, 3])], 'account-master.xlsx'));
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
});
