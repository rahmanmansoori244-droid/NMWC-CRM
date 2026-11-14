// @vitest-environment node
/**
 * The go-live bootstrap's reserved-name check (scripts/golive/bootstrap-accounts.ts
 * with scripts/golive/bootstrap-reserved.ts; code review 2026-11-10, finding 25,
 * third round), on Postgres, through the real script run as the operator runs it.
 * The pure halves are unit-tested (tests/unit/reserved-username-renames.test.ts);
 * this is the half that reads the database:
 *
 *   • a reserved name the run would CREATE (here a Manager spelled "  Manager.A ")
 *     stops the run before anything is written: no account, no audit row, no
 *     history row for any name in the file, and the operator is told why;
 *   • a reserved name that is already an account (the seed's `admin`) is skipped
 *     as it always was ("exists as ..."), and the other Managers are created, each
 *     with mustChangePassword and its one CREATE audit row;
 *   • a reserved Steward entry is not refused while an active Steward exists (the
 *     Steward entry is then skipped whole). The opposite case, no active Steward,
 *     is left to the unit test: other suites on this database create and remove
 *     Stewards in parallel, so "no active Steward" cannot be held here;
 *   • a second run of the same file creates nothing and writes no audit row.
 *
 *   RUN_BOOTSTRAP_RESERVED=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/bootstrap-reserved.test.ts
 */
import { pointsAtProduction } from '../../scripts/lib/assert-not-production';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { RESERVED_USERNAME_MESSAGE } from '../../lib/demo-accounts';
import { purgeAuditLog } from '../support/audit';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_BOOTSTRAP_RESERVED === '1' && !!process.env.DATABASE_URL;

const sfx = `br${Date.now().toString(36)}`;
// Made-up, and written as words so it reads as no secret.
const PASSWORD = 'bootstrap test password one';
const TSX = resolve('node_modules/tsx/dist/cli.mjs');
const SCRIPT = 'scripts/golive/bootstrap-accounts.ts';

describe.skipIf(!ENABLED)("the go-live bootstrap's reserved-name check, on Postgres", () => {
  let prisma: PrismaClient;
  let tmp = '';
  let host = '';
  const made: string[] = [];
  const mgr1 = `bm1.${sfx}`;
  const mgr2 = `bm2.${sfx}`;
  let reservedBefore = 0;
  // Set from the database's clock once connected; until then, nothing counts as this run's.
  let started = new Date(8.64e15);

  /** The bootstrap, as the operator runs it, on the connection it resolves itself. */
  const bootstrap = (cfg: unknown, name: string) => {
    const file = join(tmp, `${name}.json`);
    writeFileSync(file, JSON.stringify(cfg));
    const r = spawnSync(process.execPath, [TSX, SCRIPT, file, '--expect-host', host], {
      env: { ...process.env },
      encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };

  /** What exists for these names; history only since `since` (history rows are never deleted). */
  const theirTrace = async (usernames: string[], since: Date) => {
    const users = await prisma.user.findMany({ where: { username: { in: usernames } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    return {
      users: users.length,
      audit: ids.length ? await prisma.auditLog.count({ where: { entityId: { in: ids } } }) : 0,
      history: await prisma.userHistory.count({ where: { username: { in: usernames }, recordedAt: { gte: since } } }),
    };
  };

  // The database's clock, as the history triggers stamp recordedAt with it.
  const dbNow = async () => (await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;

  const reservedNow = () =>
    prisma.user.count({ where: { username: { in: ['steward', 'manager.a', 'manager.b', 'viewer'] } } });

  beforeAll(async () => {
    // The script resolves DIRECT_URL first, as here; the guard below is the suite's own.
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
    if (pointsAtProduction(url)) throw new Error('ABORT: the test database points at production');
    // The host name, without the port: the shared guard compares that (assertNotProduction).
    host = new URL(url).hostname;
    expect(host, 'a host in the connection string').not.toBe('');
    prisma = new PrismaClient({ datasourceUrl: url });
    started = await dbNow();
    tmp = mkdtempSync(join(tmpdir(), 'nmwc-bootstrap-reserved-'));
    // An active Steward for the whole file, so the Steward entry is skipped whole.
    const stw = await prisma.user.create({
      data: { username: `stw.${sfx}`, fullName: 'Bootstrap Steward', role: 'STEWARD', passwordHash: 'x' },
      select: { id: true },
    });
    made.push(stw.id);
    // The seed's admin: a reserved name that is an account already.
    expect(await prisma.user.count({ where: { username: 'admin' } }), 'the seed made admin').toBe(1);
    reservedBefore = await reservedNow();
  });

  afterAll(async () => {
    if (!prisma) return;
    // Its Managers, and a reserved account only if this run made it (a check
    // that failed open would have): never one that was there before.
    const created = await prisma.user.findMany({
      where: {
        OR: [
          { username: { in: [mgr1, mgr2] } },
          { username: { in: ['steward', 'manager.a', 'manager.b', 'viewer'] }, createdAt: { gte: started } },
        ],
      },
      select: { id: true },
    });
    const all = [...made, ...created.map((u) => u.id)];
    if (all.length) {
      await purgeAuditLog(prisma, { where: { OR: [{ actorId: { in: all } }, { entityId: { in: all } }] } });
      await prisma.passwordHistory.deleteMany({ where: { userId: { in: all } } });
      await prisma.user.deleteMany({ where: { id: { in: all } } });
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it('a reserved Manager the run would create stops it before anything is written', async () => {
    const since = await dbNow();
    const r = bootstrap(
      {
        steward: { username: `stw.${sfx}`, fullName: 'Steward', password: PASSWORD },
        managers: [
          { username: mgr1, fullName: 'Manager One', regions: [], password: PASSWORD },
          { username: '  Manager.A ', fullName: 'Old Demo', regions: [], password: PASSWORD },
        ],
      },
      'refused'
    );
    expect(r.status).toBe(1);
    expect(r.err).toContain('refusing: reserved username(s)');
    expect(r.err).toContain('Manager.A');
    expect(r.err).toContain(RESERVED_USERNAME_MESSAGE);
    expect(r.err).toContain('Nothing has been written.');
    expect(r.out).not.toContain('Created (');
    expect(await theirTrace([mgr1, 'manager.a'], since)).toEqual({ users: 0, audit: 0, history: 0 });
    expect(await reservedNow()).toBe(reservedBefore);
  });

  it('a reserved name that is an account already is skipped; the others are created as before', async () => {
    const adminBefore = await prisma.user.findUniqueOrThrow({
      where: { username: 'admin' },
      select: { id: true, role: true, passwordHash: true, mustChangePassword: true, updatedAt: true },
    });
    const r = bootstrap(
      {
        // Reserved, but an active Steward exists: the Steward entry is skipped whole.
        steward: { username: 'steward', fullName: 'Steward', password: PASSWORD },
        managers: [
          { username: mgr1, fullName: 'Manager One', regions: [], password: PASSWORD },
          { username: 'ADMIN', fullName: 'Admin Again', regions: [], password: PASSWORD },
          { username: mgr2, fullName: 'Manager Two', regions: [], password: PASSWORD },
        ],
      },
      'allowed'
    );
    expect(r.err).not.toContain('BOOTSTRAP FAILED');
    expect(r.status).toBe(0);
    expect(r.out).toContain('Created (2):');
    expect(r.out).toContain(`${mgr1} (MANAGER)`);
    expect(r.out).toContain(`${mgr2} (MANAGER)`);
    expect(r.out).toContain('admin (exists as MANAGER)');
    expect(r.out).toContain('steward — one already exists');

    // admin is untouched; no "steward" account appeared.
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { username: 'admin' },
        select: { id: true, role: true, passwordHash: true, mustChangePassword: true, updatedAt: true },
      })
    ).toEqual(adminBefore);
    expect(await reservedNow()).toBe(reservedBefore);
    expect(await prisma.auditLog.count({ where: { entityId: adminBefore.id, reason: { startsWith: 'go-live bootstrap' } } })).toBe(0);

    for (const username of [mgr1, mgr2]) {
      const u = await prisma.user.findUniqueOrThrow({
        where: { username },
        select: { id: true, role: true, mustChangePassword: true, isActive: true },
      });
      expect(u).toMatchObject({ role: 'MANAGER', mustChangePassword: true, isActive: true });
      const audit = await prisma.auditLog.findMany({ where: { entityId: u.id }, select: { action: true, after: true } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'CREATE',
        after: { username, role: 'MANAGER', bootstrap: true, mustChangePassword: true },
      });
    }
  });

  it('a second run of the same file creates nothing and writes no audit row', async () => {
    const ids = (await prisma.user.findMany({ where: { username: { in: [mgr1, mgr2] } }, select: { id: true } })).map(
      (u) => u.id
    );
    expect(ids).toHaveLength(2);
    const auditBefore = await prisma.auditLog.count({ where: { entityId: { in: ids } } });
    const r = bootstrap(
      {
        steward: { username: 'steward', fullName: 'Steward', password: PASSWORD },
        managers: [
          { username: mgr1, fullName: 'Manager One', regions: [], password: PASSWORD },
          { username: 'admin', fullName: 'Admin Again', regions: [], password: PASSWORD },
          { username: mgr2, fullName: 'Manager Two', regions: [], password: PASSWORD },
        ],
      },
      'again'
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain('Created (0): —');
    expect(r.out).toContain(`${mgr1} (exists as MANAGER)`);
    expect(r.out).toContain(`${mgr2} (exists as MANAGER)`);
    expect(await prisma.auditLog.count({ where: { entityId: { in: ids } } })).toBe(auditBefore);
    expect(await reservedNow()).toBe(reservedBefore);
  });
});
