/**
 * The one check every script that opens a database runs before it connects: is
 * this production, and did the operator say so?
 *
 * WHY (data audit 2026-10-10, gap 3): scripts in this repository could delete or
 * rewrite history on production and nothing stopped them. Two clean-up scripts
 * opened the audit maintenance switch and deleted history, users and customers,
 * others rewrote customers, and none of them looked at which database it had been
 * handed. The owner's decision of 2026-10-11 deleted those scripts (git history
 * keeps them) and put this guard in front of every one that is left.
 *
 * WHICH HOSTS ARE PRODUCTION (code review 2026-11-10, finding 14): the markers in
 * config/production-hosts.txt, read through scripts/lib/production-hosts.cjs — the
 * one list every guard shares. It may hold several hosts (after a restore: the new
 * production first, the old one kept). A missing, empty or malformed list throws
 * the moment this file is imported, so every script that uses this guard refuses.
 *
 * THE RULE.
 *   - A host that starts with a production marker is refused unless the
 *     command line carries `--expect-host <value>` where the value itself starts
 *     with a production marker and is part of that host. That is the pattern
 *     scripts/ops/* already use: the operator has to NAME production to reach it,
 *     so a variable that silently fell back to the wrong .env cannot get there.
 *   - `--expect-host` given for any other host must match that host too, so the
 *     same mistake is caught on UAT.
 *   - A connection string this cannot read a host from is refused: a guard that
 *     cannot see the host cannot say it is not production. The marker anywhere
 *     in the string, percent-escaped or not, also counts as production, for the
 *     same reason.
 *
 * WHAT IT PRINTS. The host it is about to use, before anything connects, and
 * nothing else from the URL — never the user, the password, the database or the
 * query. A production host is shown as its public marker only: the full endpoint
 * id is what scripts/dev/prod-run.cjs masks, and the Provision app role workflow
 * runs a guarded script in a PUBLIC repository's job log. A refusal prints its
 * reason itself, on stderr, and then throws: several scripts here deliberately
 * print only an error's class name (restore-verify, the ops scripts' redaction),
 * and a refusal whose reason never reaches the operator is a refusal they cannot
 * act on.
 *
 * Returns the URL unchanged, so the caller hands the client the very value that
 * was checked:
 *
 *   new PrismaClient({ datasourceUrl: assertNotProduction(process.env.DIRECT_URL ?? process.env.DATABASE_URL) })
 *
 * tests/unit/scripts-production-guard.test.ts fails CI when a file under
 * scripts/ or prisma/ builds a database client without calling this (directly,
 * or through requireExpectedHost in scripts/ops/requeue-untracked.ts, which ends
 * by calling it).
 */
import { OperatorRefusal } from '../ops/error-label';
import {
  checkedHosts,
  hostMarker,
  loadProductionHosts,
  namesProduction,
  productionMarkerIn,
} from './production-hosts.cjs';

/**
 * Every production host marker, from config/production-hosts.txt (finding 14).
 * Read once, here: a list the guards cannot trust throws now, at import.
 */
export const PRODUCTION_HOSTS: readonly string[] = Object.freeze(loadProductionHosts());

/**
 * Production's host NOW: the list's first marker, the value operators type after
 * `--expect-host` and the one the guards' messages name.
 */
export const PRODUCTION_HOST_PREFIX: string = PRODUCTION_HOSTS[0]!;

/**
 * Thrown after the reason has been printed. An OperatorRefusal, so the ops
 * scripts' redacting error label still shows this message rather than a class.
 */
export class ProductionGuardRefusal extends OperatorRefusal {
  constructor() {
    super(
      'refused by the production guard (scripts/lib/assert-not-production.ts); ' +
        'the reason is printed above. Nothing was read or written.'
    );
    this.name = 'ProductionGuardRefusal';
  }
}

export type GuardOutput = { log: (line: string) => void; error: (line: string) => void };

const consoleOutput: GuardOutput = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * The value after `--expect-host`: null when the flag is absent, '' when it is
 * present without a value (the next argument is missing or is another flag).
 */
export function expectHostArg(args: readonly string[]): string | null {
  const i = args.indexOf('--expect-host');
  if (i < 0) return null;
  const value = args[i + 1] ?? '';
  return value.startsWith('--') ? '' : value;
}

/** The live site: production. Scripts whose browser part signs in there use this. */
export const LIVE_SITE = 'https://nmwc-cm.vercel.app';

/**
 * For a script whose browser part acts on the live site — it signs in to LIVE_SITE,
 * which is production, whatever database the checkout's .env names. Owner decisions
 * 2026-10-11: such a script runs only when its command line names production with
 * `--expect-host ep-sweet-haze`, the flag the database guard below reads, read the
 * same way (the documented two-word form, a value that starts with the marker).
 *
 * Call it first, at the top of the script, before Chromium starts or anything is
 * signed in to or written: it prints why it refuses and returns false, and the
 * caller exits (`if (!liveSiteNamed('…')) process.exit(2);`). Pinned by
 * tests/unit/scripts-production-guard.test.ts.
 */
export function liveSiteNamed(
  script: string,
  args: readonly string[] = process.argv.slice(2),
  out: GuardOutput = consoleOutput,
  hosts: readonly string[] = PRODUCTION_HOSTS
): boolean {
  const named = expectHostArg(args);
  if (named && namesProduction(named, hosts)) return true;
  out.error(`[live-site guard] refusing: ${script} signs in to the PRODUCTION site (${LIVE_SITE}).`);
  out.error(
    `  Run it only on purpose, with --expect-host ${checkedHosts(hosts)[0]} on the command line ` +
      '(owner decisions 2026-10-11). Nothing was opened, signed in to or written.'
  );
  return false;
}

/**
 * The arguments with `--expect-host <value>` taken out, for scripts that read
 * positional arguments: the flag must not shift a file path into the wrong slot.
 */
export function withoutExpectHost(args: readonly string[]): string[] {
  const i = args.indexOf('--expect-host');
  if (i < 0) return [...args];
  const hasValue = i + 1 < args.length && !args[i + 1]!.startsWith('--');
  return [...args.slice(0, i), ...args.slice(i + (hasValue ? 2 : 1))];
}

/**
 * Does this connection string point at production? The marker anywhere in it, in
 * any case, percent-escaped or not — the reading assertNotProduction uses. The
 * escapes are decoded because libpq, node-postgres and Prisma all decode the query,
 * and a `host` parameter there overrides the host in the URL, so
 * `?host=ep%2Dsweet%2Dhaze…` reached production while the host said localhost
 * (review of d02cb27). Only well-formed %XX escapes are decoded, so a stray `%`
 * cannot make this throw.
 *
 * Exported for the scripts that must never run on production at all, whatever the
 * command line says (prisma/seed.ts; owner decisions 2026-10-11).
 */
export function pointsAtProduction(url: string, hosts: readonly string[] = PRODUCTION_HOSTS): boolean {
  return productionMarkerIn(url, hosts) !== null;
}

export function assertNotProduction(
  url: string | undefined,
  args: readonly string[] = process.argv.slice(2),
  out: GuardOutput = consoleOutput,
  hosts: readonly string[] = PRODUCTION_HOSTS
): string {
  const refuse = (...lines: string[]): never => {
    for (const line of lines) out.error(line);
    throw new ProductionGuardRefusal();
  };
  // A list the guard cannot trust refuses (finding 14): never weaker.
  try {
    checkedHosts(hosts);
  } catch (e) {
    refuse((e as Error).message);
  }

  if (!url) {
    refuse(
      '[db-guard] refusing: no database connection string was given ' +
        '(DIRECT_URL / DATABASE_URL is not set).'
    );
  }
  const raw = url as string;
  let host = '';
  try {
    // Lower-cased by hand: for a postgresql:// URL the WHATWG parser keeps the
    // host as written, so `EP-SWEET-HAZE…` would otherwise slip past the prefix.
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    /* refused just below */
  }
  if (!host) {
    refuse(
      '[db-guard] refusing: this connection string has no host the guard can read,',
      '  so it cannot rule out production. Nothing was read or written.'
    );
  }

  // The marker this connection carries: its host's own first, else one anywhere in it.
  const marker = hostMarker(host, hosts) ?? productionMarkerIn(raw, hosts);
  const production = marker !== null;
  const shown = production ? `${marker}… (PRODUCTION)` : host;
  const expect = expectHostArg(args);

  if (expect === '') {
    refuse('[db-guard] refusing: --expect-host was passed without a host.');
  }
  if (expect !== null && !host.includes(expect.toLowerCase())) {
    // The value is shown as the marker when it names production: it may be the
    // full endpoint id, which this guard never prints (see the end of this function).
    const named = productionMarkerIn(expect, hosts);
    const asked = named ? `${named}…` : expect;
    refuse(
      `[db-guard] refusing: you asked for "${asked}" but this connection points at ${shown}.`,
      '  Check the connection string you set, in the same shell that runs this command.',
      '  Nothing was read or written.'
    );
  }
  if (production && (expect === null || !namesProduction(expect, hosts))) {
    refuse(
      `[db-guard] refusing: this connection points at PRODUCTION (${marker}…).`,
      '  Only the audited operator scripts run there, through scripts/dev/prod-run.cjs, and',
      `  only with --expect-host ${marker} on the command line (docs/OPERATIONS.md §5j).`,
      '  Nothing was read or written.'
    );
  }

  // The --expect-host value is not echoed here: it may be the full endpoint id.
  out.log(`[db-guard] database host: ${shown}${production ? ' — named with --expect-host' : ''}`);
  return raw;
}
