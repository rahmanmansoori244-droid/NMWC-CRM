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

  it('the approver accounts the runbook names are clear too', () => {
    // These come from the account master rather than a literal in the builder.
    for (const u of ['accountant', 'finance.manager', 'gm.nmwc']) {
      expect(isDemoAccount(u)).toBe(false);
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
