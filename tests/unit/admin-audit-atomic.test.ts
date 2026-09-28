// @vitest-environment node
/**
 * F13 (services/users.ts and services/routes.ts) — an admin change and its audit
 * row commit together or not at all.
 *
 * What was wrong: each of these actions saved the change as one autocommit
 * statement and then wrote the AuditLog row as a second one. A transient fault on
 * the second (a pool timeout, P2024) left the change saved with no record of who
 * made it — for user administration the audit row is the only such record — and
 * runAction then told the admin "Nothing was saved", which was false.
 *
 * What changed: the change and writeAudit(tx, …) run in one interactive
 * transaction; the envelope is read before it opens.
 *
 * The database here is an in-memory stand-in whose $transaction really stages its
 * writes and throws them away when the callback throws, the way Postgres rolls an
 * interactive transaction back. So each case states the outcome — "the user is
 * unchanged", "no region exists" — rather than which client a call went through,
 * and the pre-fix code, which wrote the change outside any transaction, fails it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown> & { id: string };
type Tables = Record<'user' | 'region' | 'route' | 'auditLog', Map<string, Row>>;

const h = vi.hoisted(() => ({
  tables: null as unknown as Record<'user' | 'region' | 'route' | 'auditLog', Map<string, Record<string, unknown> & { id: string }>>,
  /** When set, the next AuditLog insert throws it. */
  failAudit: null as null | Error,
  /** Writes that did not go through a transaction. */
  autocommit: [] as string[],
  seq: 0,
  session: null as null | { user: Record<string, unknown> },
  /** A username another admin's insert takes just after this action's pre-check reads it. */
  raceUsername: null as null | string,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => h.session }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '10.1.2.3', 'user-agent': 'unit' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('bcryptjs', () => {
  const hash = async (plain: string) => `hash:${plain}`;
  const compare = async (plain: string, hashed: string) => hashed === `hash:${plain}`;
  return { default: { hash, compare }, hash, compare };
});
vi.mock('@/lib/db', () => {
  const uniqueError = (target: string) => Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002' });
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === 'object' && 'not' in (v as object) ? row[k] !== (v as { not: unknown }).not : row[k] === v
    );
  const model = (tables: () => Tables, name: keyof Tables, via: 'tx' | 'prisma') => ({
    findUnique: async ({ where, include }: { where: Record<string, unknown>; include?: { reports?: unknown } }) => {
      if (name === 'user' && h.raceUsername && where.username === h.raceUsername) {
        tables().user.set('ckracewinner000000000001', { id: 'ckracewinner000000000001', username: h.raceUsername });
        h.raceUsername = null;
        return null;
      }
      const row = [...tables()[name].values()].find((r) => matches(r, where));
      if (!row) return null;
      if (!include?.reports) return { ...row };
      const reports = [...tables().user.values()].filter((u) => u.supervisorId === row.id).map((u) => ({ id: u.id }));
      return { ...row, reports };
    },
    count: async ({ where }: { where: Record<string, unknown> }) =>
      [...tables()[name].values()].filter((r) => matches(r, where)).length,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (via === 'prisma') h.autocommit.push(`${name}.create`);
      if (name === 'auditLog' && h.failAudit) {
        const e = h.failAudit;
        h.failAudit = null;
        throw e;
      }
      for (const key of name === 'user' ? ['username'] : name === 'auditLog' ? [] : ['code']) {
        if ([...tables()[name].values()].some((r) => r[key] === data[key])) throw uniqueError(`${name}.${key}`);
      }
      h.seq += 1;
      const row = { isActive: true, ...data, id: `ck${name.toLowerCase()}${String(h.seq).padStart(20, '0')}` };
      tables()[name].set(row.id, row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      if (via === 'prisma') h.autocommit.push(`${name}.update`);
      const row = tables()[name].get(where.id);
      if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      const next = { ...row, ...data };
      tables()[name].set(where.id, next);
      return { ...next };
    },
  });
  const client = (tables: () => Tables, via: 'tx' | 'prisma') => ({
    user: model(tables, 'user', via),
    region: model(tables, 'region', via),
    route: model(tables, 'route', via),
    auditLog: model(tables, 'auditLog', via),
  });
  const clone = (t: Tables): Tables =>
    Object.fromEntries(
      Object.entries(t).map(([k, m]) => [k, new Map([...m].map(([id, r]) => [id, { ...r }]))])
    ) as Tables;
  const prisma = {
    ...client(() => h.tables as Tables, 'prisma'),
    // Interactive transaction: stage every write, keep them only if the callback returns.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged = clone(h.tables as Tables);
      const result = await fn(client(() => staged, 'tx'));
      h.tables = staged;
      return result;
    },
  };
  return { prisma, directPrisma: prisma };
});

import {
  createUserAction,
  toggleUserActiveAction,
  updateUserRoleAction,
} from '@/services/users';
import {
  createRegionAction,
  createRouteAction,
  toggleRegionActiveAction,
  toggleRouteActiveAction,
} from '@/services/routes';

const STEWARD = 'ckstewardactor0000000001';
const TARGET = 'cktargetuser000000000001';
const REGION = 'ckregionexisting00000001';
const ROUTE = 'ckrouteexisting000000001';

/** Prisma's pool timeout: transient, and it fails before anything could commit. */
const poolTimeout = () =>
  Object.assign(new Error('Timed out fetching a new connection from the connection pool.'), { code: 'P2024' });
const NOTHING_SAVED = {
  ok: false,
  code: 'DB_UNAVAILABLE',
  message: 'The database did not respond in time. Nothing was saved — please try again in a moment.',
};

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const snapshot = () => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(h.tables).map(([k, m]) => [k, [...m.values()]]))));

beforeEach(() => {
  h.seq = 0;
  h.failAudit = null;
  h.autocommit = [];
  h.raceUsername = null;
  h.session = { user: { id: STEWARD, role: 'STEWARD', username: 'steward.one', mustChangePassword: false } };
  h.tables = {
    user: new Map([
      [STEWARD, { id: STEWARD, username: 'steward.one', role: 'STEWARD', isActive: true, supervisorId: null, ownedRouteId: null }],
      [TARGET, { id: TARGET, username: 'sup.one', role: 'SUPERVISOR', isActive: true, supervisorId: null, ownedRouteId: null }],
    ]),
    region: new Map([[REGION, { id: REGION, code: 'MCT', name: 'Muscat', isActive: true }]]),
    route: new Map([[ROUTE, { id: ROUTE, code: 'M01', name: 'Muscat 1', regionId: REGION, isActive: true }]]),
    auditLog: new Map(),
  };
});

const ACTIONS: Array<{
  name: string;
  run: () => Promise<unknown>;
  /** What the successful change looks like, and that its audit row names it. */
  changed: () => void;
}> = [
  {
    name: 'createUserAction',
    run: () =>
      createUserAction(
        form({ username: 'new.sup', fullName: 'New Supervisor', role: 'SUPERVISOR', password: 'A-long-password-1' })
      ),
    changed: () => {
      const u = [...h.tables.user.values()].find((r) => r.username === 'new.sup');
      expect(u).toMatchObject({ role: 'SUPERVISOR', mustChangePassword: true });
      expect([...h.tables.auditLog.values()]).toMatchObject([
        { action: 'CREATE', entityType: 'User', entityId: u!.id, actorId: STEWARD, ip: '10.1.2.3' },
      ]);
    },
  },
  {
    name: 'toggleUserActiveAction',
    run: () => toggleUserActiveAction(form({ userId: TARGET })),
    changed: () => {
      expect(h.tables.user.get(TARGET)).toMatchObject({ isActive: false });
      expect(h.tables.user.get(TARGET)!.sessionsRevokedAt).toBeInstanceOf(Date);
      expect([...h.tables.auditLog.values()]).toMatchObject([
        { action: 'UPDATE', entityType: 'User', entityId: TARGET, reason: 'disabled', actorId: STEWARD },
      ]);
    },
  },
  {
    name: 'updateUserRoleAction',
    run: () => updateUserRoleAction(form({ userId: TARGET, newRole: 'VIEWER' })),
    changed: () => {
      expect(h.tables.user.get(TARGET)).toMatchObject({ role: 'VIEWER' });
      expect([...h.tables.auditLog.values()]).toMatchObject([
        { action: 'UPDATE', entityType: 'User', entityId: TARGET, reason: 'role_change', actorId: STEWARD },
      ]);
    },
  },
  {
    name: 'createRegionAction',
    run: () => createRegionAction(form({ code: 'SLL', name: 'Salalah' })),
    changed: () => {
      const r = [...h.tables.region.values()].find((x) => x.code === 'SLL');
      expect(r).toBeDefined();
      expect([...h.tables.auditLog.values()]).toMatchObject([
        { action: 'CREATE', entityType: 'Region', entityId: r!.id, actorId: STEWARD },
      ]);
    },
  },
  {
    name: 'createRouteAction',
    run: () => createRouteAction(form({ code: 'M02', name: 'Muscat 2', regionId: REGION })),
    changed: () => {
      const r = [...h.tables.route.values()].find((x) => x.code === 'M02');
      expect(r).toMatchObject({ regionId: REGION });
      expect([...h.tables.auditLog.values()]).toMatchObject([
        { action: 'CREATE', entityType: 'Route', entityId: r!.id, actorId: STEWARD },
      ]);
    },
  },
  {
    name: 'toggleRegionActiveAction',
    run: () => toggleRegionActiveAction(form({ id: REGION })),
    changed: () => {
      expect(h.tables.region.get(REGION)).toMatchObject({ isActive: false });
      expect([...h.tables.auditLog.values()]).toMatchObject([
        { action: 'UPDATE', entityType: 'Region', entityId: REGION, reason: 'disabled' },
      ]);
    },
  },
  {
    name: 'toggleRouteActiveAction',
    run: () => toggleRouteActiveAction(form({ id: ROUTE })),
    changed: () => {
      expect(h.tables.route.get(ROUTE)).toMatchObject({ isActive: false });
      expect([...h.tables.auditLog.values()]).toMatchObject([
        { action: 'UPDATE', entityType: 'Route', entityId: ROUTE, reason: 'disabled' },
      ]);
    },
  },
];

describe('an admin change and its audit row are one transaction', () => {
  it.each(ACTIONS)('$name: when it succeeds, the change and its audit row are both saved', async ({ run, changed }) => {
    expect(await run()).toEqual({ ok: true, data: undefined });
    changed();
    expect(h.autocommit, 'nothing written outside the transaction').toEqual([]);
  });

  it.each(ACTIONS)(
    '$name: when the audit insert times out, nothing is saved — so "Nothing was saved" is true',
    async ({ run }) => {
      const before = snapshot();
      h.failAudit = poolTimeout();
      expect(await run()).toEqual(NOTHING_SAVED);
      expect(snapshot()).toEqual(before);
      expect(h.autocommit).toEqual([]);
    }
  );

  it.each(ACTIONS)('$name: a non-transient audit failure still rolls the change back', async ({ run }) => {
    const before = snapshot();
    h.failAudit = Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' });
    await expect(run()).rejects.toThrow('Foreign key constraint violated');
    expect(snapshot()).toEqual(before);
  });
});

describe('the unique-code answers survive the move into a transaction', () => {
  it('a username taken between the pre-check and the insert is still "Username already taken."', async () => {
    // The pre-check reads outside the transaction and finds nothing; another
    // admin's insert of the same name lands before this one's.
    h.raceUsername = 'race.sup';
    const res = await createUserAction(
      form({ username: 'race.sup', fullName: 'Race', role: 'SUPERVISOR', password: 'A-long-password-1' })
    );
    expect(res).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { username: 'Username already taken.' },
    });
    expect(h.tables.auditLog.size).toBe(0);
  });

  it('a duplicate route code is still the generic conflict answer, with no audit row', async () => {
    const res = await createRouteAction(form({ code: 'M01', name: 'Again', regionId: REGION }));
    expect(res).toMatchObject({ ok: false, code: 'UNIQUE_CONSTRAINT' });
    expect(h.tables.auditLog.size).toBe(0);
  });
});
