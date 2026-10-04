// @vitest-environment node
/**
 * F1 / X-IMPORTS-4 (e-mail half, 2026-10-05): the Steward sets or clears an
 * account's e-mail on /users (services/users.ts updateUserEmailAction).
 *
 * The address is where notification e-mail goes, so a wrong one sends work
 * alerts to someone else's mailbox. Pinned here: Steward only; trimmed and
 * lower-cased; '' clears; a clash with another account, in any letter case, is
 * a field error on the box and not a 500; the change and its audit row commit
 * together; the audit row names the field and never carries the value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type U = { id: string; role: string; email: string | null };
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; role: string; username: string } },
  users: new Map<string, { id: string; role: string; email: string | null }>(),
  audits: [] as Array<Record<string, unknown>>,
  /** When set, the next update throws a P2002 (another account took the address meanwhile). */
  raceClash: false,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => h.session }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async () => ({ ip: null, userAgent: null }),
  writeAudit: async (_tx: unknown, _env: unknown, row: Record<string, unknown>) => {
    h.audits.push(row);
  },
}));
vi.mock('@/lib/db', () => {
  const user = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const u = h.users.get(where.id);
      return u ? { ...u } : null;
    },
    findFirst: async ({
      where,
    }: {
      where: { id: { not: string }; email: { equals: string; mode: 'insensitive' } };
    }) => {
      const hit = [...h.users.values()].find(
        (u) => u.id !== where.id.not && (u.email ?? '').toLowerCase() === where.email.equals.toLowerCase()
      );
      return hit ? { id: hit.id } : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: { email: string | null } }) => {
      if (h.raceClash) {
        h.raceClash = false;
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['email'] } });
      }
      const u = h.users.get(where.id)!;
      u.email = data.email;
      return { ...u };
    },
    // requireActor's freshness reads (lib/session) — not part of this behaviour.
  };
  const prisma = {
    user,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const before = new Map([...h.users].map(([k, v]) => [k, { ...v }]));
      const auditsBefore = h.audits.length;
      try {
        return await fn({ user });
      } catch (e) {
        h.users = before;
        h.audits.length = auditsBefore;
        throw e;
      }
    },
  };
  return { prisma, directPrisma: prisma };
});
vi.mock('@/lib/session', () => ({
  requireActor: async () => {
    if (!h.session) throw Object.assign(new Error('UNAUTHENTICATED'), { code: 'UNAUTHENTICATED' });
    return h.session.user;
  },
}));

import { updateUserEmailAction } from '@/services/users';

const STEWARD = { id: 'stw', role: 'STEWARD', username: 'data.steward.x' };
const MANAGER = { id: 'mgr', role: 'MANAGER', username: 'manager.x' };

function seed(rows: U[]) {
  h.users = new Map(rows.map((r) => [r.id, { ...r }]));
}

async function save(userId: string, value: string) {
  const fd = new FormData();
  fd.set('userId', userId);
  fd.set('contactAddress', value);
  return updateUserEmailAction(fd);
}

beforeEach(() => {
  h.session = { user: STEWARD };
  h.audits = [];
  h.raceClash = false;
  seed([
    { id: 'stw', role: 'STEWARD', email: null },
    { id: 'acc', role: 'ACCOUNTANT', email: null },
    { id: 'mgr', role: 'MANAGER', email: 'Region.Manager@Example.test' },
    { id: 'sal', role: 'SALESMAN', email: null },
  ]);
});

describe('updateUserEmailAction', () => {
  it('stores the address trimmed and lower-cased, with an audit row that names the field only', async () => {
    const res = await save('acc', '  Accounts.North@Example.TEST ');
    expect(res.ok).toBe(true);
    expect(h.users.get('acc')!.email).toBe('accounts.north@example.test');
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ action: 'UPDATE', entityType: 'User', entityId: 'acc', reason: 'email_set' });
    expect(h.audits[0]!.after).toEqual({ changed: ['email'] });
    expect(JSON.stringify(h.audits)).not.toMatch(/accounts\.north/i);
  });

  it('an empty box clears the address', async () => {
    const res = await save('mgr', '   ');
    expect(res.ok).toBe(true);
    expect(h.users.get('mgr')!.email).toBeNull();
    expect(h.audits[0]).toMatchObject({ reason: 'email_cleared', after: { changed: ['email'] } });
    expect(JSON.stringify(h.audits)).not.toMatch(/region\.manager/i);
  });

  it('the same value again writes nothing and records nothing', async () => {
    seed([{ id: 'stw', role: 'STEWARD', email: null }, { id: 'acc', role: 'ACCOUNTANT', email: 'a@example.test' }]);
    expect((await save('acc', 'A@Example.test')).ok).toBe(true);
    expect(h.audits).toHaveLength(0);
  });

  it('refuses something that is not an address, on the box', async () => {
    const res = await save('acc', 'accounts north');
    expect(res.ok).toBe(false);
    expect((res as { fields?: Record<string, string> }).fields).toHaveProperty('contactAddress');
    expect(h.users.get('acc')!.email).toBeNull();
  });

  it('refuses an address another account holds, whatever its letter case', async () => {
    const res = await save('acc', 'region.manager@example.test');
    expect(res.ok).toBe(false);
    expect((res as { fields?: Record<string, string> }).fields?.contactAddress).toMatch(/already used/);
    expect(h.users.get('acc')!.email).toBeNull();
    expect(h.audits).toHaveLength(0);
  });

  it('a clash that lands between the check and the write is the same field error, and nothing is kept', async () => {
    h.raceClash = true;
    const res = await save('acc', 'fresh@example.test');
    expect(res.ok).toBe(false);
    expect((res as { fields?: Record<string, string> }).fields?.contactAddress).toMatch(/already used/);
    expect(h.users.get('acc')!.email).toBeNull();
    expect(h.audits).toHaveLength(0);
  });

  it('is the Steward’s alone: a Manager is refused, even for his own field force', async () => {
    h.session = { user: MANAGER };
    const res = await save('sal', 'sal@example.test');
    expect(res.ok).toBe(false);
    expect((res as { code: string }).code).toBe('FORBIDDEN');
    expect(h.users.get('sal')!.email).toBeNull();
  });

  it('a Steward cannot change his own address here (self-service is /profile)', async () => {
    const res = await save('stw', 'me@example.test');
    expect(res.ok).toBe(false);
    expect((res as { code: string }).code).toBe('FORBIDDEN');
  });
});
