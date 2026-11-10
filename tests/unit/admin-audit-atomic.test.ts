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
type Tables = Record<'user' | 'region' | 'route' | 'auditLog' | 'customerEdit' | 'notification', Map<string, Row>>;

const h = vi.hoisted(() => ({
  tables: null as unknown as Record<
    'user' | 'region' | 'route' | 'auditLog' | 'customerEdit' | 'notification',
    Map<string, Record<string, unknown> & { id: string }>
  >,
  /** When set, the next AuditLog insert throws it. */
  failAudit: null as null | Error,
  /** Writes that did not go through a transaction. */
  autocommit: [] as string[],
  seq: 0,
  session: null as null | { user: Record<string, unknown> },
  /** A username another admin's insert takes just after this action's pre-check reads it. */
  raceUsername: null as null | string,
  /** The same for a route: another create takes it just after the route pre-check. */
  raceRouteId: null as null | string,
  /** When set, the next User insert throws a P2002 with this meta (or none). */
  clashMeta: undefined as undefined | { meta?: unknown },
  /** Cache tags the actions revalidated (next/cache revalidateTag). */
  tags: [] as string[],
  /**
   * Finding 9: another admin's switch that commits just after this action read
   * the row. The next findUnique of this id returns the row as read, then the
   * table holds `isActive` (the other click's result).
   */
  raceSwitch: null as null | { id: string; isActive: boolean },
}));

vi.mock('@/lib/auth', () => ({ auth: async () => h.session }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '10.1.2.3', 'user-agent': 'unit' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: (tag: string) => h.tags.push(tag) }));
vi.mock('bcryptjs', () => {
  const hash = async (plain: string) => `hash:${plain}`;
  const compare = async (plain: string, hashed: string) => hashed === `hash:${plain}`;
  return { default: { hash, compare }, hash, compare };
});
vi.mock('@/lib/db', () => {
  // As Prisma raises it on Postgres: meta.target names the column(s).
  const uniqueError = (name: string, key: string) =>
    Object.assign(new Error(`Unique constraint failed on ${name}.${key}`), {
      code: 'P2002',
      meta: { modelName: name, target: [key] },
    });
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === 'object' && 'not' in (v as object)
        ? row[k] !== (v as { not: unknown }).not
        : v && typeof v === 'object' && 'in' in (v as object)
          ? (v as { in: unknown[] }).in.includes(row[k])
          : row[k] === v
    );
  const model = (tables: () => Tables, name: keyof Tables, via: 'tx' | 'prisma') => ({
    findUnique: async ({ where, include }: { where: Record<string, unknown>; include?: { reports?: unknown } }) => {
      if (name === 'user' && h.raceUsername && where.username === h.raceUsername) {
        tables().user.set('ckracewinner000000000001', { id: 'ckracewinner000000000001', username: h.raceUsername });
        h.raceUsername = null;
        return null;
      }
      if (name === 'user' && h.raceRouteId && where.ownedRouteId === h.raceRouteId) {
        tables().user.set('ckracewinner000000000002', {
          id: 'ckracewinner000000000002',
          username: 'route.winner',
          ownedRouteId: h.raceRouteId,
        });
        h.raceRouteId = null;
        return null;
      }
      const row = [...tables()[name].values()].find((r) => matches(r, where));
      if (!row) return null;
      if (h.raceSwitch && row.id === h.raceSwitch.id && via === 'prisma') {
        const read = { ...row };
        tables()[name].set(row.id, { ...row, isActive: h.raceSwitch.isActive });
        h.raceSwitch = null;
        if (!include?.reports) return read;
      }
      if (!include?.reports) return { ...row };
      const reports = [...tables().user.values()].filter((u) => u.supervisorId === row.id).map((u) => ({ id: u.id }));
      return { ...row, reports };
    },
    count: async ({ where }: { where: Record<string, unknown> }) =>
      [...tables()[name].values()].filter((r) => matches(r, where)).length,
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      [...tables()[name].values()].filter((r) => matches(r, where)).map((r) => ({ ...r })),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (via === 'prisma') h.autocommit.push(`${name}.updateMany`);
      const hit = [...tables()[name].values()].filter((r) => matches(r, where));
      for (const r of hit) tables()[name].set(r.id, { ...r, ...data });
      return { count: hit.length };
    },
    // The create's e-mail clash check: `email: { equals, mode: 'insensitive' }`.
    findFirst: async ({ where }: { where: { email?: { equals: string; mode?: string } } }) => {
      const want = where.email?.equals;
      if (want === undefined) throw new Error('findFirst: only the e-mail lookup is modelled');
      const fold = (v: unknown) => (where.email!.mode === 'insensitive' && typeof v === 'string' ? v.toLowerCase() : v);
      const row = [...tables()[name].values()].find((r) => r.email != null && fold(r.email) === fold(want));
      return row ? { id: row.id } : null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (via === 'prisma') h.autocommit.push(`${name}.create`);
      if (name === 'auditLog' && h.failAudit) {
        const e = h.failAudit;
        h.failAudit = null;
        throw e;
      }
      if (name === 'user' && h.clashMeta) {
        const { meta } = h.clashMeta;
        h.clashMeta = undefined;
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta });
      }
      // User's three unique columns, as in the schema; an absent value clashes with nothing.
      const unique = name === 'user' ? ['username', 'email', 'ownedRouteId'] : name === 'auditLog' ? [] : ['code'];
      for (const key of unique) {
        if (data[key] == null) continue;
        if ([...tables()[name].values()].some((r) => r[key] === data[key])) throw uniqueError(name, key);
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
    // Gap 24: the change context each transaction sets first (lib/change-context.ts).
    $executeRaw: async () => 1,
    // Gap 37: the open-work record a disable writes (lib/open-work.ts) reads his
    // sent-back requests (raw SQL) and his unattached photos: none here.
    $queryRaw: async () => [],
    attachment: { count: async () => 0 },
    user: model(tables, 'user', via),
    region: model(tables, 'region', via),
    route: model(tables, 'route', via),
    auditLog: model(tables, 'auditLog', via),
    customerEdit: model(tables, 'customerEdit', via),
    notification: model(tables, 'notification', via),
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

import { RESERVED_USERNAME_MESSAGE } from '@/lib/demo-accounts';

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
  h.raceRouteId = null;
  h.clashMeta = undefined;
  h.tags = [];
  h.session = { user: { id: STEWARD, role: 'STEWARD', username: 'steward.one', mustChangePassword: false } };
  h.tables = {
    user: new Map([
      [STEWARD, { id: STEWARD, username: 'steward.one', role: 'STEWARD', isActive: true, supervisorId: null, ownedRouteId: null }],
      [TARGET, { id: TARGET, username: 'sup.one', role: 'SUPERVISOR', isActive: true, supervisorId: null, ownedRouteId: null }],
    ]),
    region: new Map([[REGION, { id: REGION, code: 'MCT', name: 'Muscat', isActive: true }]]),
    route: new Map([[ROUTE, { id: ROUTE, code: 'M01', name: 'Muscat 1', regionId: REGION, isActive: true }]]),
    auditLog: new Map(),
    customerEdit: new Map(),
    notification: new Map(),
  };
});

const ACTIONS: Array<{
  name: string;
  run: () => Promise<unknown>;
  /** What the action answers on success (finding 9: the switches say what they did). */
  data?: unknown;
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
    run: () => toggleUserActiveAction(form({ userId: TARGET, active: 'false' })),
    data: { isActive: false, changed: true },
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
    run: () => toggleRegionActiveAction(form({ id: REGION, active: 'false' })),
    data: { isActive: false, changed: true },
    changed: () => {
      expect(h.tables.region.get(REGION)).toMatchObject({ isActive: false });
      expect([...h.tables.auditLog.values()]).toMatchObject([
        { action: 'UPDATE', entityType: 'Region', entityId: REGION, reason: 'disabled' },
      ]);
    },
  },
  {
    name: 'toggleRouteActiveAction',
    run: () => toggleRouteActiveAction(form({ id: ROUTE, active: 'false' })),
    data: { isActive: false, changed: true },
    changed: () => {
      expect(h.tables.route.get(ROUTE)).toMatchObject({ isActive: false });
      expect([...h.tables.auditLog.values()]).toMatchObject([
        { action: 'UPDATE', entityType: 'Route', entityId: ROUTE, reason: 'disabled' },
      ]);
    },
  },
];

describe('an admin change and its audit row are one transaction', () => {
  it.each(ACTIONS)('$name: when it succeeds, the change and its audit row are both saved', async ({ run, changed, data }) => {
    expect(await run()).toEqual({ ok: true, data });
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

  // Post-merge review (2026-09-29): every clash on create used to come back as
  // "Username already taken." under a username nobody held.
  const failed = (fields: Record<string, string>) => ({
    ok: false,
    code: 'VALIDATION_FAILED',
    message: 'Validation failed',
    fields,
  });

  it('an e-mail another account already holds is reported under Email, not Username', async () => {
    h.tables.user.set('ckaccountantholder000001', {
      id: 'ckaccountantholder000001',
      username: 'acct.mct',
      role: 'ACCOUNTANT',
      email: 'finance@x.invalid',
    });
    const before = snapshot();
    const res = await createUserAction(
      form({
        username: 'new.viewer',
        fullName: 'New Viewer',
        role: 'VIEWER',
        email: 'finance@x.invalid',
        password: 'A-long-password-1',
      })
    );
    expect(res).toEqual(failed({ email: 'That e-mail is already used by another account.' }));
    expect(snapshot()).toEqual(before);
  });

  // Launch fix (2026-10-07): User.email's unique index is case-sensitive, so an
  // address held in other capitals used to be accepted — two accounts, one mailbox.
  it('an e-mail another account holds in other capitals is refused, and nothing is written', async () => {
    h.tables.user.set('ckaccountantholder000001', {
      id: 'ckaccountantholder000001',
      username: 'acct.mct',
      role: 'ACCOUNTANT',
      email: 'Finance@X.invalid',
    });
    const before = snapshot();
    const res = await createUserAction(
      form({
        username: 'new.viewer',
        fullName: 'New Viewer',
        role: 'VIEWER',
        email: 'finance@x.INVALID',
        password: 'A-long-password-1',
      })
    );
    expect(res).toEqual(failed({ email: 'That e-mail is already used by another account.' }));
    expect(snapshot()).toEqual(before);
  });

  it('a new account’s e-mail is stored trimmed and lower-cased', async () => {
    const res = await createUserAction(
      form({
        username: 'new.viewer',
        fullName: 'New Viewer',
        role: 'VIEWER',
        email: '  New.Viewer@Example.TEST ',
        password: 'A-long-password-1',
      })
    );
    expect(res).toMatchObject({ ok: true });
    const u = [...h.tables.user.values()].find((r) => r.username === 'new.viewer');
    expect(u?.email).toBe('new.viewer@example.test');
  });

  it('a route another create took between the pre-check and the insert is reported under the route field', async () => {
    h.raceRouteId = ROUTE;
    const res = await createUserAction(
      form({
        username: 'new.salesman',
        fullName: 'New Salesman',
        role: 'SALESMAN',
        ownedRouteId: ROUTE,
        password: 'A-long-password-1',
      })
    );
    // `ownedRouteId` is the key the create form (CreateUserForm.tsx) shows under Route.
    expect(res).toEqual(failed({ ownedRouteId: 'That route is already assigned to another salesman.' }));
    expect([...h.tables.user.values()].some((u) => u.username === 'new.salesman')).toBe(false);
    expect(h.tables.auditLog.size).toBe(0);
  });

  it.each([
    ['User_email_key', { email: 'That e-mail is already used by another account.' }],
    ['User_ownedRouteId_key', { ownedRouteId: 'That route is already assigned to another salesman.' }],
    ['User_username_key', { username: 'Username already taken.' }],
  ])('a target given as the constraint name %s maps to its field', async (target, fields) => {
    h.clashMeta = { meta: { target } };
    const res = await createUserAction(
      form({ username: 'new.sup', fullName: 'New Supervisor', role: 'SUPERVISOR', password: 'A-long-password-1' })
    );
    expect(res).toEqual(failed(fields));
  });

  it('a clash that names no column is not blamed on the username', async () => {
    h.clashMeta = {};
    const res = await createUserAction(
      form({ username: 'new.sup', fullName: 'New Supervisor', role: 'SUPERVISOR', password: 'A-long-password-1' })
    );
    expect(res).toEqual(
      failed({
        _form: 'Another account already has this username, e-mail or route. Change it and try again.',
      })
    );
    expect(h.tables.auditLog.size).toBe(0);
  });

  it('a duplicate route code is still the generic conflict answer, with no audit row', async () => {
    const res = await createRouteAction(form({ code: 'M01', name: 'Again', regionId: REGION }));
    expect(res).toMatchObject({ ok: false, code: 'UNIQUE_CONSTRAINT' });
    expect(h.tables.auditLog.size).toBe(0);
  });
});

// Launch fix (2026-10-07): the /customers filters read the people from a
// 5-minute cache (lib/reference-data.ts 'ref:users'), which nothing revalidated,
// so a new salesman was missing from them for up to five minutes.
describe('a change to who exists, is active or holds which role refreshes the cached people list', () => {
  it.each([
    ['createUserAction', () => createUserAction(form({ username: 'new.sup', fullName: 'New Supervisor', role: 'SUPERVISOR', password: 'A-long-password-1' }))],
    ['toggleUserActiveAction', () => toggleUserActiveAction(form({ userId: TARGET, active: 'false' }))],
    ['updateUserRoleAction', () => updateUserRoleAction(form({ userId: TARGET, newRole: 'VIEWER' }))],
  ])('%s revalidates ref:users', async (_name, run) => {
    expect(await run()).toMatchObject({ ok: true });
    expect(h.tags).toContain('ref:users');
  });

  it('a refused change revalidates nothing', async () => {
    const res = await createUserAction(form({ username: 'Bad Name', fullName: 'X', role: 'SUPERVISOR', password: 'A-long-password-1' }));
    expect(res).toMatchObject({ ok: false });
    expect(h.tags).toEqual([]);
  });
});

// Owner decisions 2026-10-11 (review, Q-signed-form-stranded): a salesman's credit
// request waiting at his signed-application step. Nobody else can move it on or
// close it, so a disable is refused unless it withdraws the request, and then the
// withdraw, its audit row, the answered alerts and the disable are one transaction.
describe('disabling a salesman whose credit request waits at his signed-application step', () => {
  const SALES = 'cksalesmanatform00000001';
  const EDIT = 'ckeditatsignedform000001';
  beforeEach(() => {
    h.tables.user.set(SALES, {
      id: SALES,
      username: 'm01',
      fullName: 'Ali Salesman',
      role: 'SALESMAN',
      isActive: true,
      supervisorId: null,
      ownedRouteId: ROUTE,
    });
    h.tables.customerEdit.set(EDIT, {
      id: EDIT,
      process: 'CREATE',
      state: 'SUBMITTED',
      pendingRole: 'SALESMAN',
      currentStepIndex: 2,
      cycle: 1,
      submittedById: SALES,
      slaDueAt: new Date('2026-10-14T05:00:00Z'),
    });
    // His own must-act alert, and the print alert his Manager holds.
    h.tables.notification.set('n-own', { id: 'n-own', editId: EDIT, userId: SALES, kind: 'SIGNED_FORM_REQUESTED', readAt: null });
    h.tables.notification.set('n-mgr', { id: 'n-mgr', editId: EDIT, userId: 'ckmanager0000000000000001', kind: 'EDIT_STAGE_ADVANCED', readAt: null });
  });
  const disable = (withdraw: boolean) =>
    toggleUserActiveAction(form({ userId: SALES, active: 'false', ...(withdraw ? { withdrawCreates: 'on' } : {}) }));

  it('without the withdraw: refused, naming why, and nothing is written', async () => {
    const before = snapshot();
    const res = await disable(false);
    expect(res).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      fields: {
        withdrawCreates: expect.stringMatching(
          /^Ali Salesman has 1 credit request\(s\) waiting for him to upload the customer's signed credit application\. Nobody else can upload it, send the request back or close it/
        ),
      },
    });
    expect(snapshot()).toEqual(before);
  });

  it('with it: the request is withdrawn, its alerts answered, and the account disabled — in one transaction', async () => {
    expect(await disable(true)).toEqual({ ok: true, data: { isActive: false, changed: true } });
    expect(h.tables.customerEdit.get(EDIT)).toMatchObject({
      state: 'REJECTED',
      pendingRole: null,
      slaDueAt: null,
      reviewedById: STEWARD,
      decisionCategory: 'withdrawn',
    });
    expect(h.tables.notification.get('n-own')!.readAt).toBeInstanceOf(Date);
    expect(h.tables.notification.get('n-mgr')!.readAt).toBeInstanceOf(Date);
    expect(h.tables.user.get(SALES)).toMatchObject({ isActive: false });
    expect([...h.tables.auditLog.values()]).toMatchObject([
      {
        action: 'UPDATE',
        entityType: 'CustomerEdit',
        entityId: EDIT,
        reason: 'withdrawn when the account was disabled',
        after: { process: 'CREATE', state: 'REJECTED', from: 'SUBMITTED', cycle: 1, atStep: 2 },
      },
      { action: 'UPDATE', entityType: 'User', entityId: SALES, reason: 'disabled' },
    ]);
    expect(h.autocommit).toEqual([]);
  });

  it('with it, but the audit insert fails: neither the withdraw nor the disable is saved', async () => {
    const before = snapshot();
    h.failAudit = poolTimeout();
    expect(await disable(true)).toEqual(NOTHING_SAVED);
    expect(snapshot()).toEqual(before);
  });

  it('a draft or a sent-back request does not hold a disable back (a leaver’s no longer hold its shop)', async () => {
    h.tables.customerEdit.set(EDIT, { ...h.tables.customerEdit.get(EDIT)!, state: 'NEEDS_CORRECTION', pendingRole: null });
    expect(await disable(false)).toEqual({ ok: true, data: { isActive: false, changed: true } });
    expect(h.tables.customerEdit.get(EDIT)).toMatchObject({ state: 'NEEDS_CORRECTION' });
    expect(h.tables.user.get(SALES)).toMatchObject({ isActive: false });
  });

  it('enabling is never held back', async () => {
    h.tables.user.set(SALES, { ...h.tables.user.get(SALES)!, isActive: false });
    expect(await toggleUserActiveAction(form({ userId: SALES, active: 'true' }))).toEqual({
      ok: true,
      data: { isActive: true, changed: true },
    });
    expect(h.tables.user.get(SALES)).toMatchObject({ isActive: true });
    expect(h.tables.customerEdit.get(EDIT)).toMatchObject({ state: 'SUBMITTED' });
  });
});

// Code review 2026-11-10, finding 9: Disable / Enable was a blind flip. A second
// click from a screen opened earlier (another Manager acting on the same leaver,
// or the same admin after a lost reply) switched the leaver back ON, and the
// banner, built from the stale screen, said "Disabled".
describe('finding 9: Disable and Enable set the state the click wants', () => {
  const click = (active: 'true' | 'false' | null, userId = TARGET) =>
    toggleUserActiveAction(form({ userId, ...(active === null ? {} : { active }) }));
  const audits = () => [...h.tables.auditLog.values()];

  it('a double click on Disable: disabled once, the second click answers "already disabled" and writes nothing', async () => {
    expect(await click('false')).toEqual({ ok: true, data: { isActive: false, changed: true } });
    const after = snapshot();
    expect(await click('false')).toEqual({ ok: true, data: { isActive: false, changed: false } });
    expect(snapshot()).toEqual(after);
    expect(audits()).toHaveLength(1);
  });

  it('two admins on stale screens: the second Disable never re-enables the leaver', async () => {
    // Admin A disabled him at 09:00; admin B's screen, opened at 08:55, still
    // shows him Active and B clicks Disable at 09:05.
    h.tables.user.set(TARGET, { ...h.tables.user.get(TARGET)!, isActive: false });
    expect(await click('false')).toEqual({ ok: true, data: { isActive: false, changed: false } });
    expect(h.tables.user.get(TARGET)).toMatchObject({ isActive: false });
    expect(audits()).toEqual([]);
  });

  it('an Enable from a stale screen on an account someone already enabled: "already enabled", nothing written', async () => {
    expect(await click('true')).toEqual({ ok: true, data: { isActive: true, changed: false } });
    expect(h.tables.user.get(TARGET)).toMatchObject({ isActive: true });
    expect(h.tables.user.get(TARGET)!.sessionsRevokedAt).toBeUndefined();
    expect(audits()).toEqual([]);
  });

  it('Enable on a disabled account enables it, with one audit row', async () => {
    h.tables.user.set(TARGET, { ...h.tables.user.get(TARGET)!, isActive: false });
    expect(await click('true')).toEqual({ ok: true, data: { isActive: true, changed: true } });
    expect(audits()).toMatchObject([
      { entityId: TARGET, reason: 'enabled', before: { isActive: false }, after: { isActive: true } },
    ]);
  });

  it('a race: another admin\u2019s Disable commits between this one\u2019s read and its write; nothing is written twice', async () => {
    h.raceSwitch = { id: TARGET, isActive: false };
    expect(await click('false')).toEqual({ ok: true, data: { isActive: false, changed: false } });
    expect(h.tables.user.get(TARGET)).toMatchObject({ isActive: false });
    expect(h.tables.user.get(TARGET)!.sessionsRevokedAt).toBeUndefined();
    expect(audits()).toEqual([]);
  });

  it('a click that does not say what it wants is refused and changes nothing (no guessing)', async () => {
    const before = snapshot();
    const res = await click(null);
    expect(res).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      fields: { active: expect.stringMatching(/Reload the page/) },
    });
    expect(snapshot()).toEqual(before);
    for (const bad of ['on', '1', 'TRUE', '']) {
      const r = await toggleUserActiveAction(form({ userId: TARGET, active: bad }));
      expect(r, bad).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    }
    expect(snapshot()).toEqual(before);
  });

  it('a second Disable after a lost reply, with a credit request at his signed-form step, is not asked to withdraw again', async () => {
    const SALES = 'cksalesmanatform00000009';
    h.tables.user.set(SALES, {
      id: SALES,
      username: 'm09',
      fullName: 'Leaver',
      role: 'SALESMAN',
      isActive: false,
      supervisorId: null,
      ownedRouteId: ROUTE,
    });
    h.tables.customerEdit.set('ckedit9', {
      id: 'ckedit9',
      process: 'CREATE',
      state: 'SUBMITTED',
      pendingRole: 'SALESMAN',
      currentStepIndex: 2,
      cycle: 1,
      submittedById: SALES,
    });
    expect(await click('false', SALES)).toEqual({ ok: true, data: { isActive: false, changed: false } });
    expect(audits()).toEqual([]);
  });
});

// Code review 2026-11-10, finding 25: /users created an account on a demo-account
// name without complaint; in production it could then never sign in.
describe('finding 25: a reserved username is refused at creation', () => {
  it.each(['supervisor.salalah', 'salesman.ali', 'viewer', 'steward', 'admin', 'manager.b'])(
    '%s is refused under Username with the plain message, and nothing is written',
    async (username) => {
      const before = snapshot();
      const res = await createUserAction(
        form({ username, fullName: 'New Person', role: 'SUPERVISOR', password: 'A-long-password-1' })
      );
      expect(res).toEqual({
        ok: false,
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        fields: { username: RESERVED_USERNAME_MESSAGE },
      });
      expect(snapshot()).toEqual(before);
    }
  );

  it('typed with capitals or spaces it is still refused (the form lower-cases and trims first)', async () => {
    const res = await createUserAction(
      form({ username: '  Supervisor.Sur ', fullName: 'New Person', role: 'SUPERVISOR', password: 'A-long-password-1' })
    );
    expect(res).toMatchObject({ ok: false, fields: { username: RESERVED_USERNAME_MESSAGE } });
  });

  it('a name that only looks like one is created: data.steward', async () => {
    h.session = { user: { id: STEWARD, role: 'STEWARD', username: 'steward.one', mustChangePassword: false } };
    const res = await createUserAction(
      form({ username: 'data.steward', fullName: 'Data Steward Two', role: 'VIEWER', password: 'A-long-password-1' })
    );
    expect(res).toMatchObject({ ok: true });
  });
});
