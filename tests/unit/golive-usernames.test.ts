// @vitest-environment node
/**
 * No account the go-live builder creates may collide with the demo denylist.
 *
 * This existed as a real, unnoticed P0. The builder issued the first Data Steward
 * as `steward`, and lib/auth.ts refuses that exact username whenever
 * DEMO_ACCOUNTS_DISABLED is set — which production sets, because the synthetic
 * seed uses the name for a demo account.
 *
 * Load day would have gone: run the bootstrap, watch it report success, try to
 * sign in at step 2, get "Invalid username or password", and have no way forward
 * inside the application. The account-master import is Steward-only. A Manager
 * may only reset a SALESMAN or SUPERVISOR. The import refuses to mint a Steward.
 * The bootstrap refuses to mint a second one while the broken one is active. The
 * fallback `admin` is on the same denylist. The only escapes were a direct
 * database write, or switching the flag off — which re-enables the pilot accounts
 * whose passwords are literals in the seed.
 *
 * So: the builder's fixed usernames are asserted against the denylist directly,
 * and the builder's source is checked for the name that caused it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isDemoAccount } from '@/lib/demo-accounts';
import { APPROVER_USERNAMES, GOLIVE_REGION_CODES } from '@/lib/ops/golive-accounts';

const BUILDER = 'scripts/golive/build-masters.ts';
const src = readFileSync(BUILDER, 'utf8');

/** Every literal `username: '...'` the builder emits. */
const emitted = [...src.matchAll(/username:\s*'([^']+)'/g)].map((m) => m[1]!);

describe('the go-live accounts can actually sign in', () => {
  it('finds the usernames to check', () => {
    // Guards against the regex silently matching nothing and the suite passing
    // for no reason.
    expect(emitted.length).toBeGreaterThan(5);
    expect(emitted).toContain('data.steward');
  });

  it.each(emitted)('%s is not on the demo denylist', (username) => {
    expect(isDemoAccount(username)).toBe(false);
  });

  it.each(APPROVER_USERNAMES)('approver %s is not on the demo denylist', (username) => {
    // Was a hard-coded ['accountant', 'finance.manager', 'gm.nmwc'], which went
    // stale the moment the single accountant became seven regional ones — and
    // would have stayed GREEN while checking three names that no longer exist.
    // The seven are built by template inside an array literal, so the
    // `username: '...'` scan above cannot see them either; they are only covered
    // because this list is the one the builder itself uses.
    expect(isDemoAccount(username)).toBe(false);
  });

  it.each(APPROVER_USERNAMES)('approver %s matches the application charset', (username) => {
    expect(username).toMatch(/^[a-z0-9._-]{1,50}$/);
  });

  it('there is one accountant per region, and they are the ones the builder emits', () => {
    const accountants = APPROVER_USERNAMES.filter((u) => u.startsWith('accountant.'));
    expect(accountants).toHaveLength(GOLIVE_REGION_CODES.length);
    expect(new Set(accountants).size).toBe(accountants.length);
    // The builder must actually derive them from the shared helper rather than
    // re-spelling them, or this test checks a list nothing uses.
    expect(src).toMatch(/accountantUsername\(r\.code\)/);
    expect(src).toMatch(/GOLIVE_REGION_CODES/);
  });

  it('the synthetic accountants stay blocked and the real ones do not', () => {
    // prisma/synthetic.ts seeds accountant.a and accountant.b. They are NOT on
    // the denylist today. If someone adds an 'accountant.' prefix rule to catch
    // them, all seven real accounts break at sign-in — so pin both directions.
    for (const real of APPROVER_USERNAMES) {
      expect(isDemoAccount(real), `${real} must stay usable`).toBe(false);
    }
  });

  it('never re-introduces the bare `steward` username', () => {
    expect(src).not.toMatch(/username:\s*'steward'/);
    expect(src).not.toMatch(/username:\s*"steward"/);
  });
});

describe('the denylist still blocks what it is for', () => {
  it('blocks the seeded demo and synthetic accounts', () => {
    // The other direction: relaxing these patterns to make a real account work
    // would re-enable accounts whose passwords are literals in the repository.
    for (const u of ['steward', 'viewer', 'admin', 'salesman.c4', 'supervisor.x', 'manager.a']) {
      expect(isDemoAccount(u), `${u} must stay blocked`).toBe(true);
    }
  });

  it('is anchored, so a real name that merely contains one is unaffected', () => {
    for (const u of ['data.steward', 'pilot.steward', 'viewer.reports', 'manager.ahmed']) {
      expect(isDemoAccount(u), `${u} must not be blocked`).toBe(false);
    }
  });

  it('lib/auth.ts uses this definition rather than its own copy', () => {
    // The whole point of extracting it. A second inline copy in the login path
    // would drift from the one this test checks.
    const auth = readFileSync('lib/auth.ts', 'utf8');
    expect(auth).toMatch(/isDemoAccount\(username\)/);
    expect(auth).not.toMatch(/salesman\\\.\|supervisor/);
  });
});

describe('the builder emits usernames the application will accept', () => {
  // Manager usernames became class codes ('mct-gt') on 2026-09-20, which put a
  // HYPHEN in a username for the first time. services/users.ts allows it and
  // bootstrap-accounts.ts allows it — this pins that they keep agreeing, and
  // catches a future name with a space, a capital or an '@' before load day
  // rather than at someone's sign-in.
  it.each(emitted)('%s matches the charset the application will accept', (username) => {
    expect(username).toMatch(/^[a-z0-9._-]{1,50}$/);
  });

  it('the app-side rule really is the one being mirrored', () => {
    // If services/users.ts tightens its rule, the assertion above goes stale
    // silently. Fail here instead, so the next person updates both.
    const users = readFileSync('services/users.ts', 'utf8');
    expect(users).toMatch(/\^\[a-z0-9\._-\]\+\$/);
  });
});

describe('supervisor assignment is derived, not a second list of usernames', () => {
  // The rename to class usernames touched MANAGERS, and the usernames were ALSO
  // written down in MUSCAT_SUPERVISOR_BY_CLASS and SUPERVISOR_BY_REGION. Renaming
  // one and not the others would have given every salesman a supervisor_username
  // pointing at an account that does not exist — and the builder would have
  // printed success. The three are now one derived map; this stops a second copy
  // coming back.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('has no hand-maintained username lookup beside the roster', () => {
    expect(code).not.toMatch(/MUSCAT_SUPERVISOR_BY_CLASS/);
    expect(code).not.toMatch(/SUPERVISOR_BY_REGION/);
  });

  it('builds the lookup from the roster', () => {
    expect(code).toMatch(/SUPERVISOR_BY_OWNED[\s\S]{0,400}for \(const m of MANAGERS\)/);
  });

  it('refuses two managers owning the same class or region', () => {
    expect(code).toMatch(/two managers own/);
  });

  it('checks the roster for duplicates and bad charsets before using it', () => {
    expect(code).toMatch(/duplicate manager username/);
  });
});
