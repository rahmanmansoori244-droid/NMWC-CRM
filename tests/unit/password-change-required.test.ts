// @vitest-environment node
/**
 * F15 / X-AUTH-1 — a session that must still change its password (AUTH-09) can
 * run nothing but the password change and sign-out.
 *
 * Before: the only enforcement was the Edge middleware's path check, which lets
 * /profile/change-password through. That page's form imported its action from
 * services/users.ts, so Next registered createUser / toggleUserActive /
 * resetPassword / updateUserRole in the page's action worker, and a flagged
 * Manager or Steward could POST them to that path. None of the actions, route
 * handlers or service guards looked at the flag.
 *
 * This file proves the fix by BEHAVIOUR: every export of every 'use server'
 * module in services/ — found by reading the directory, so a new module is
 * covered the day it is added — answers a flagged session with
 * PASSWORD_CHANGE_REQUIRED and touches the database not at all; so does every
 * route handler that acts for a user. The password change and sign-out still
 * work. tests/unit/actor-guard.test.ts pins the structure that keeps it so.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { stripComments } from '../support/strip-comments';

type StoredUser = { id: string; passwordHash: string; mustChangePassword: boolean };

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  /** Every database call, as "model.method". The flagged sweep expects none. */
  calls: [] as string[],
  users: new Map<string, StoredUser>(),
  userUpdates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
  audits: [] as Array<{ tx: boolean; reason?: string }>,
  signOut: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => h.session,
  signIn: vi.fn(),
  signOut: h.signOut,
}));
// next-auth's own entry imports `next/server` in a form vitest's node resolver
// refuses; the two error classes it re-exports come from @auth/core/errors.
vi.mock('next-auth', async () => {
  const errors = await import('@auth/core/errors');
  return { AuthError: errors.AuthError, CredentialsSignin: errors.CredentialsSignin };
});
vi.mock('next/cache', () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock('bcryptjs', () => {
  const compare = async (plain: string, hash: string) => hash === `hash:${plain}`;
  const hash = async (plain: string) => `hash:${plain}`;
  return { default: { compare, hash }, compare, hash };
});
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  systemAuditEnvelope: (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: async (tx: unknown, _env: unknown, p: { reason?: string }) => {
    h.calls.push('auditLog.create');
    h.audits.push({ tx: tx != null, reason: p.reason });
  },
}));
vi.mock('@/lib/db', () => {
  const answers: Record<string, (args: never) => unknown> = {
    'user.findUniqueOrThrow': ({ where }: { where: { id: string } }) => {
      const u = h.users.get(where.id);
      if (!u) throw new Error('not found');
      return u;
    },
    'user.update': (args: { where: { id: string }; data: Record<string, unknown> }) => {
      h.userUpdates.push(args);
      return { id: args.where.id, ...args.data };
    },
    'passwordHistory.findMany': () => [],
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method) => async (args: never) => {
          h.calls.push(`${name}.${String(method)}`);
          const answer = answers[`${name}.${String(method)}`];
          return answer ? answer(args) : null;
        },
      }
    );
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        if (prop === '$transaction') {
          return async (arg: unknown) => {
            h.calls.push('$transaction');
            return typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as unknown[]);
          };
        }
        if (typeof prop === 'string' && prop.startsWith('$')) {
          return async () => {
            h.calls.push(prop);
            return [];
          };
        }
        return model(String(prop));
      },
    }
  );
  return { prisma, directPrisma: prisma };
});

import { PasswordChangeRequiredError } from '@/lib/errors';

const SAVED_BACKEND = process.env.RATE_LIMIT_BACKEND;
process.env.RATE_LIMIT_BACKEND = 'memory';
afterAll(() => {
  if (SAVED_BACKEND === undefined) delete process.env.RATE_LIMIT_BACKEND;
  else process.env.RATE_LIMIT_BACKEND = SAVED_BACKEND;
});

const flagged = (role: string) => ({
  user: { id: 'u-flagged', role, username: `${role.toLowerCase()}.x`, mustChangePassword: true },
});

beforeEach(() => {
  h.session = null;
  h.calls = [];
  h.users.clear();
  h.userUpdates = [];
  h.audits = [];
  h.signOut.mockReset().mockResolvedValue(undefined);
});

/** The 'use server' modules in services/, read from disk — never a hand-kept list. */
const SERVICES = path.resolve('services');
const serverModules = readdirSync(SERVICES)
  .filter((f) => f.endsWith('.ts'))
  .filter((f) => /^\s*['"]use server['"]/.test(stripComments(readFileSync(path.join(SERVICES, f), 'utf8'))));

/** The one export a flagged session may run. */
const EXEMPT = new Set(['changeOwnPasswordAction']);
/**
 * Exports that act for nobody: no session, no database. services/imports.ts
 * re-exports the pure code formatter from lib/codes.ts, which makes it callable
 * as a server action by anyone — harmless (it formats two numbers), but it is
 * held to "touches no database" below rather than skipped.
 */
const PURE = new Set(['formatCustomerCode']);

async function exportedActions(): Promise<Array<[string, (...a: unknown[]) => Promise<unknown>]>> {
  const out: Array<[string, (...a: unknown[]) => Promise<unknown>]> = [];
  for (const f of serverModules) {
    const mod = (await import(path.join(SERVICES, f))) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === 'function') out.push([`${f}:${name}`, value as (...a: unknown[]) => Promise<unknown>]);
    }
  }
  return out;
}

/** Call it the way a hand-crafted POST would, and return the answer or what it threw. */
async function outcome(fn: (...a: unknown[]) => Promise<unknown>): Promise<unknown> {
  const fd = new FormData();
  fd.set('userId', 'ckabc0000000000000000000a');
  fd.set('username', 'puppet');
  try {
    return await fn(fd);
  } catch (err) {
    return err;
  }
}

describe('every server action refuses a session that must change its password', () => {
  it('found the modules and the actions to check — the sweep cannot pass on nothing', async () => {
    expect(serverModules).toEqual(expect.arrayContaining(['users.ts', 'routes.ts', 'edits.ts', 'password.ts']));
    const names = (await exportedActions()).map(([n]) => n);
    expect(names.length).toBeGreaterThan(40);
    // The four the change-password worker used to carry.
    for (const a of ['createUserAction', 'toggleUserActiveAction', 'resetPasswordAction', 'updateUserRoleAction']) {
      expect(names).toContain(`users.ts:${a}`);
    }
    expect(names).toContain('password.ts:changeOwnPasswordAction');
  });

  it.each(['MANAGER', 'STEWARD', 'SALESMAN'])(
    'a flagged %s gets PASSWORD_CHANGE_REQUIRED from every action, and nothing reaches the database',
    async (role) => {
      const checked: string[] = [];
      for (const [name, fn] of await exportedActions()) {
        if (EXEMPT.has(name.split(':')[1]!)) continue;
        h.session = flagged(role);
        h.calls = [];
        const out = await outcome(fn);
        if (PURE.has(name.split(':')[1]!)) {
          expect(h.calls, `${name} touched the database`).toEqual([]);
          continue;
        }
        if (out instanceof Error) {
          // The three exports that are also read by pages throw rather than answer.
          expect(out, name).toBeInstanceOf(PasswordChangeRequiredError);
        } else {
          expect(out, name).toMatchObject({ ok: false, code: 'PASSWORD_CHANGE_REQUIRED' });
        }
        expect(h.calls, `${name} touched the database`).toEqual([]);
        checked.push(name);
      }
      expect(checked.length).toBeGreaterThan(40);
    }
  );

  it('the same admin action runs past the guard once the flag is clear (the refusal is the flag, not the role)', async () => {
    const { createUserAction } = await import('@/services/users');
    h.session = { user: { ...flagged('STEWARD').user, mustChangePassword: false } };
    const res = await createUserAction(new FormData());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('VALIDATION_FAILED');
  });

  it('a session object without the flag at all is treated as not flagged', async () => {
    const { createUserAction } = await import('@/services/users');
    h.session = { user: { id: 'u1', role: 'STEWARD', username: 's' } };
    const res = await createUserAction(new FormData());
    if (!res.ok) expect(res.code).toBe('VALIDATION_FAILED');
  });

  it('signed out is still "Not signed in." (FORBIDDEN), as before', async () => {
    const { createUserAction } = await import('@/services/users');
    h.session = null;
    expect(await createUserAction(new FormData())).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      message: 'Not signed in.',
    });
  });
});

describe('the two ways out still work for a flagged session', () => {
  it('changeOwnPasswordAction changes the password and clears the flag', async () => {
    const { changeOwnPasswordAction } = await import('@/services/password');
    h.session = flagged('MANAGER');
    h.users.set('u-flagged', { id: 'u-flagged', passwordHash: 'hash:Initial-Shared-1', mustChangePassword: true });
    const fd = new FormData();
    fd.set('currentPassword', 'Initial-Shared-1');
    fd.set('newPassword', 'A-new-password-2026');
    const res = await changeOwnPasswordAction(fd);
    expect(res).toEqual({ ok: true, data: undefined });
    expect(h.userUpdates).toHaveLength(1);
    expect(h.userUpdates[0]!.data).toMatchObject({
      passwordHash: 'hash:A-new-password-2026',
      mustChangePassword: false,
    });
    expect(h.audits).toEqual([{ tx: true, reason: 'self_password_change' }]);
  });

  it('changeOwnPasswordAction still refuses when signed out', async () => {
    const { changeOwnPasswordAction } = await import('@/services/password');
    h.session = null;
    const res = await changeOwnPasswordAction(new FormData());
    expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(h.calls).toEqual([]);
  });

  it('logoutAction revokes the session and signs out', async () => {
    const { logoutAction } = await import('@/app/actions/auth');
    h.session = flagged('STEWARD');
    await logoutAction();
    expect(h.userUpdates).toHaveLength(1);
    expect(h.userUpdates[0]!.where).toEqual({ id: 'u-flagged' });
    expect(h.userUpdates[0]!.data.sessionsRevokedAt).toBeInstanceOf(Date);
    expect(h.signOut).toHaveBeenCalledWith({ redirectTo: '/login' });
  });
});

describe('every route handler that acts for a user refuses a flagged session with 403', () => {
  const HOST = 'nmwc.example';
  const req = (url: string, init: { method?: string; body?: unknown } = {}) =>
    new NextRequest(`https://${HOST}${url}`, {
      method: init.method ?? 'GET',
      headers: { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const params = <T>(p: T) => ({ params: Promise.resolve(p) });

  const ROUTES: Array<[string, () => Promise<Response>]> = [
    ...(['customer-edit', 'customer-create', 'branch-close', 'branch-reactivate'] as const).map(
      (form) =>
        [
          `POST /api/forms/${form}`,
          async () => (await import('@/app/api/forms/[form]/route')).POST(req(`/api/forms/${form}`, { method: 'POST', body: {} }), params({ form })),
        ] as [string, () => Promise<Response>]
    ),
    [
      'GET /api/forms/customer-create',
      async () =>
        (await import('@/app/api/forms/[form]/route')).GET(
          req('/api/forms/customer-create?submissionId=x'),
          params({ form: 'customer-create' })
        ),
    ],
    ['POST /api/photos/attach', async () => (await import('@/app/api/photos/attach/route')).POST(req('/api/photos/attach', { method: 'POST', body: {} }))],
    ['POST /api/photos/detach', async () => (await import('@/app/api/photos/detach/route')).POST(req('/api/photos/detach', { method: 'POST', body: {} }))],
    ['POST /api/photos/presign', async () => (await import('@/app/api/photos/presign/route')).POST(req('/api/photos/presign', { method: 'POST', body: {} }))],
    ['POST /api/photos/finalize', async () => (await import('@/app/api/photos/finalize/route')).POST(req('/api/photos/finalize', { method: 'POST', body: {} }))],
    ['GET /api/photos/[id]', async () => (await import('@/app/api/photos/[id]/route')).GET(req('/api/photos/a1'), params({ id: 'a1' }))],
    ['GET /api/exports/customers', async () => (await import('@/app/api/exports/customers/route')).GET(req('/api/exports/customers'))],
    ['GET /api/exports/changes', async () => (await import('@/app/api/exports/changes/route')).GET(req('/api/exports/changes'))],
    ['GET /api/perf-probe', async () => (await import('@/app/api/perf-probe/route')).GET()],
  ];

  it.each(ROUTES)('%s', async (_name, call) => {
    h.session = flagged('STEWARD');
    const res = await call();
    expect(res.status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('the fetch routes answer in the action shape, so the phone shows it as an answer', async () => {
    h.session = flagged('SALESMAN');
    const { POST } = await import('@/app/api/forms/[form]/route');
    const res = await POST(req('/api/forms/customer-edit', { method: 'POST', body: {} }), params({ form: 'customer-edit' }));
    expect(await res.json()).toEqual({
      ok: false,
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: 'You must change your password before continuing.',
    });
  });

  it('signed out is still 401 on the fetch routes', async () => {
    h.session = null;
    const { POST } = await import('@/app/api/forms/[form]/route');
    const res = await POST(req('/api/forms/customer-edit', { method: 'POST', body: {} }), params({ form: 'customer-edit' }));
    expect(res.status).toBe(401);
  });
});
