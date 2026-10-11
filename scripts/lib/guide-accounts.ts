/**
 * The accounts the guide screenshot scripts sign in as (owner item 20, 2026-10-11).
 *
 * No username or password is written in this repository any more: the operator sets
 * them in the shell for the one run, and nowhere else — not in a committed file, not
 * in `.env`, not in a script copied into the checkout. The scripts read them only
 * after their `--expect-host ep-sweet-haze` refusal (`liveSiteNamed`), so a run that
 * does not name production never looks at them.
 *
 *   scripts/capture-guide-screenshots.ts:
 *     GUIDE_SALESMAN_USERNAME, GUIDE_SALESMAN_PASSWORD
 *     GUIDE_SUPERVISOR_USERNAME, GUIDE_SUPERVISOR_PASSWORD
 *     GUIDE_MANAGER_USERNAME, GUIDE_MANAGER_PASSWORD
 *   scripts/capture-steward-screenshots.ts:
 *     GUIDE_STEWARD_USERNAME, GUIDE_STEWARD_PASSWORD
 *
 * A missing or empty variable stops the script before Chromium starts. The message
 * names the variables, never a value, and nothing here prints a username or a
 * password.
 */
import type { GuardOutput } from './assert-not-production';

export type GuideRole = 'salesman' | 'supervisor' | 'manager' | 'steward';

/** One account to sign in as. `label` is what the scripts print; never the username. */
export type GuideAccount = { label: GuideRole; username: string; password: string };

/** The two environment variables of each account, username first. */
export const GUIDE_ACCOUNT_VARS: Readonly<Record<GuideRole, readonly [string, string]>> = {
  salesman: ['GUIDE_SALESMAN_USERNAME', 'GUIDE_SALESMAN_PASSWORD'],
  supervisor: ['GUIDE_SUPERVISOR_USERNAME', 'GUIDE_SUPERVISOR_PASSWORD'],
  manager: ['GUIDE_MANAGER_USERNAME', 'GUIDE_MANAGER_PASSWORD'],
  steward: ['GUIDE_STEWARD_USERNAME', 'GUIDE_STEWARD_PASSWORD'],
};

const consoleOutput: GuardOutput = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * The accounts for these roles, from the environment; null (after saying which
 * variables are missing) when any is unset or empty. The caller exits:
 * `if (!accounts) process.exit(2);`. A username is trimmed; a password is taken
 * exactly as set.
 */
export function guideAccountsFromEnv<R extends GuideRole>(
  script: string,
  roles: readonly R[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  out: GuardOutput = consoleOutput
): Record<R, GuideAccount> | null {
  const missing: string[] = [];
  const accounts = {} as Record<R, GuideAccount>;
  for (const role of roles) {
    const [userVar, passwordVar] = GUIDE_ACCOUNT_VARS[role];
    const username = (env[userVar] ?? '').trim();
    const password = env[passwordVar] ?? '';
    if (!username) missing.push(userVar);
    if (!password) missing.push(passwordVar);
    accounts[role] = { label: role, username, password };
  }
  if (missing.length === 0) return accounts;
  out.error(`[guide accounts] refusing: ${script} needs ${missing.join(', ')}.`);
  out.error(
    '  Set them in the shell for this run only (owner item 20, 2026-10-11): never in a ' +
      'committed file or in .env. Nothing was opened, signed in to or written.'
  );
  return null;
}
