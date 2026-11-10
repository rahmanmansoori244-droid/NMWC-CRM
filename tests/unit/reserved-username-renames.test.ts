// @vitest-environment node
/**
 * Code review 2026-11-10, finding 25, second round: every path that sets or
 * changes a sign-in name goes through the one reserved-name check
 * (reservedUsernameRefusal in lib/demo-accounts.ts), not only /users create and
 * the account import.
 *
 * The writers of User.username outside the seeds (which create the demo accounts
 * themselves) are:
 *   - /users create (services/users.ts createUserCore): tests/unit/admin-audit-atomic.test.ts;
 *   - the account import, a NEW account only (it never renames one):
 *     tests/unit/account-import-service.test.ts;
 *   - the Steward's "sign in with the route's code" on Edit account
 *     (updateUserAccountCore, routeSignIn): here, and on Postgres in
 *     tests/integration/account-edit.test.ts;
 *   - the leaver's retired sign-in name at a route hand-over (freeRetiredUsername,
 *     used by create and by Edit account): here;
 *   - the go-live bootstrap of the Steward and the Managers
 *     (scripts/golive/bootstrap-accounts.ts): here, by running it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { retiredUsername, routeSignInName, routeSignInRefusal } from '@/lib/account-edit';
import { RESERVED_USERNAME_MESSAGE, reservedUsernameRefusal } from '@/lib/demo-accounts';
import { reservedInFile, reservedToCreate } from '../../scripts/golive/bootstrap-reserved';

describe('the route sign-in rename refuses a reserved name', () => {
  it.each(['ADMIN', 'Steward', 'VIEWER', 'MANAGER.A', 'manager.b', 'SALESMAN.C4', ' Supervisor.Sur '])(
    'route code %j is refused, naming the code, the name and how to keep the current one',
    (code) => {
      const msg = routeSignInRefusal(code, 'c4');
      expect(msg).not.toBeNull();
      expect(msg).toContain(`Route code ${code}`);
      expect(msg).toContain(routeSignInName(code));
      expect(msg).toMatch(/reserved/);
      expect(msg).toMatch(/Untick it to keep c4\.$/);
      // It is the shared check that decides, not a copy of the patterns.
      expect(reservedUsernameRefusal(routeSignInName(code))).toBe(RESERVED_USERNAME_MESSAGE);
    }
  );

  it.each(['C4', 'SH01', 'DATA.STEWARD', 'VIEWER.REPORTS', 'MANAGER.C', 'MCT-GT'])(
    'route code %j is accepted',
    (code) => {
      expect(routeSignInRefusal(code, 'c4')).toBeNull();
    }
  );

  it('an account that already has the name is not renamed, so nothing is refused', () => {
    // Accounts that already hold a reserved name are not touched (first round).
    expect(routeSignInRefusal('VIEWER', 'viewer')).toBeNull();
  });
});

describe('a retired leaver name is never newly reserved', () => {
  it.each(['c4', 'sh01', 'data.steward', 'manager.c', 'viewer.reports', 'mct-gt', 'own.name'])(
    '%s retires to an allowed name',
    (name) => {
      for (const attempt of [1, 2, 20]) {
        expect(reservedUsernameRefusal(retiredUsername(name, '2026-11-10', attempt))).toBeNull();
      }
    }
  );
});

/** The body of a function in services/users.ts, from its name to the next one. */
const users = readFileSync('services/users.ts', 'utf8');
const body = (from: string, to: string) => {
  const a = users.indexOf(from);
  const b = users.indexOf(to, a + 1);
  expect(a, from).toBeGreaterThan(-1);
  expect(b, to).toBeGreaterThan(a);
  return users.slice(a, b);
};

describe('services/users.ts sends every rename through the check', () => {
  it('Edit account: the route sign-in name is checked before it is taken', () => {
    const fn = body('async function updateUserAccountCore(', 'export async function updateUserEmailAction(');
    const check = fn.indexOf('routeSignInRefusal(route.code, target.username)');
    const take = fn.indexOf('username = wanted;');
    expect(check).toBeGreaterThan(-1);
    expect(take).toBeGreaterThan(check);
    expect(fn.slice(check, take)).toMatch(/throw new ValidationError\(\{ routeSignIn: reserved \}\)/);
  });

  it('the hand-over: the retired name is checked before it is handed out', () => {
    const fn = body('async function freeRetiredUsername(', 'async function handOverRoute(');
    const check = fn.indexOf('reservedUsernameRefusal(name)');
    expect(check).toBeGreaterThan(-1);
    expect(fn.indexOf('if (!taken) return name;')).toBeGreaterThan(check);
  });

  it('create still checks the name it is given', () => {
    const fn = body('async function createUserCore(', 'export async function toggleUserActiveAction(');
    expect(fn).toMatch(/reservedUsernameRefusal\(data\.username\)/);
  });
});

describe('the go-live bootstrap refuses only a reserved name it would create (third round)', () => {
  // A URL nothing listens on, and no production host.
  const fake = ['postgresql://', 'nobody', ':', 'x', '@', '127.0.0.1:9', '/none'].join('');
  const run = (cfg: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-names-'));
    const file = join(dir, 'managers.json');
    writeFileSync(file, JSON.stringify(cfg));
    try {
      return spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/golive/bootstrap-accounts.ts', file, '--expect-host', 'ep-uat-fake.invalid'],
        { env: { ...process.env, DIRECT_URL: fake, DATABASE_URL: fake }, encoding: 'utf8', timeout: 120_000 }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const person = (username: string) => ({ username, fullName: 'Test Person', password: 'Test-Pass-1', regions: [] });

  it('reservedInFile lists every reserved name in the file, as spelt there', () => {
    expect(reservedInFile({ steward: person('Steward'), managers: [person('mct-gt'), person('manager.a')] })).toEqual([
      'Steward',
      'manager.a',
    ]);
    expect(reservedInFile({ steward: person('data.steward'), managers: [person('mct-gt')] })).toEqual([]);
  });

  it('a reserved name that already exists is skipped as before, not refused — in any case or spacing', () => {
    const cfg = { steward: person(' Steward '), managers: [person('mct-gt'), person('Manager.A')] };
    expect(reservedToCreate(cfg, new Set(['steward', 'manager.a']), false)).toEqual([]);
  });

  it('a reserved name the run would newly create is refused, each one named', () => {
    const cfg = { steward: person('Steward'), managers: [person('mct-gt'), person('manager.a'), person('salesman.c4')] };
    expect(reservedToCreate(cfg, new Set(['manager.a']), false)).toEqual(['Steward', 'salesman.c4']);
  });

  it('the Steward entry is not created while an active Steward exists, so its name is not refused then', () => {
    const cfg = { steward: person('steward'), managers: [person('manager.b')] };
    expect(reservedToCreate(cfg, new Set(), true)).toEqual(['manager.b']);
    expect(reservedToCreate(cfg, new Set(), false)).toEqual(['steward', 'manager.b']);
  });

  it('the script refuses after reading the database and before its first write', () => {
    const src = readFileSync('scripts/golive/bootstrap-accounts.ts', 'utf8');
    const banner = src.indexOf('console.log(`Target: ${host}`);');
    const check = src.indexOf('reservedToCreate(cfg, new Set(existing.map((u) => u.username)), stewards.length > 0)');
    const refusal = src.indexOf('would be created.', check);
    const firstWrite = src.indexOf('await make(', check);
    expect(banner).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(banner);
    expect(refusal).toBeGreaterThan(check);
    expect(firstWrite).toBeGreaterThan(refusal);
    // make() still skips an existing account ("exists as ...") as it always did.
    expect(src).toContain('skipped.push(`${username} (exists as ${clash.role})`);');
  });

  it('a reserved name in the file no longer stops the run before the host guard: whether it exists is asked of the database', () => {
    const r = run({ steward: person('Steward'), managers: [person('mct-gt'), person('manager.a')] });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/reserved/);
    expect(r.stderr).toMatch(/refusing: you asked for "ep-uat-fake\.invalid"/);
    expect(r.stderr).toMatch(/Nothing has been written\./);
  }, 150_000);

  it('allowed names pass the check and reach the next guard (the host the operator named)', () => {
    const r = run({ steward: person('data.steward'), managers: [person('mct-gt')] });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/reserved/);
    expect(r.stderr).toMatch(/refusing: you asked for "ep-uat-fake\.invalid"/);
  }, 150_000);
});
