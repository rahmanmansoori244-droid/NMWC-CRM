/**
 * Go-live clean start: the first two nights of the integrity watch, rehearsed
 * (design section 3 step 5, and final.first_night_integrity).
 *
 * On a database reset.sql has JUST reset — the restored backup in the REHEARSE
 * job, the Neon rehearsal branch, or the integration suite's scratch database —
 * the real nightly watch (lib/integrity/run.ts runIntegrityWatch) runs twice:
 *
 *   night 1  now: the run APPLY step h makes right after COMMIT (Oman day D);
 *   night 2  02:30 UTC of the next Oman day (D+1), when the scheduled run comes.
 *
 * Both with an in-memory seal store (seeded with the keys PLAN found under
 * seals/ that are not production's chain), no in-app alert and a webhook that
 * does nothing: nothing leaves the runner. Every check's status is compared
 * with expected-watch.json, and the seal step must really have written a seal
 * each night: the new chain's first one on night 1, the first one chained to
 * it on night 2 (the status alone cannot tell that from "today's seal is
 * already there").
 *
 * AT ANY HOUR. Night 2 is one Oman day after night 1 whatever the clock says:
 * a rehearsal that slips past midnight in Oman (20:00 UTC) simulates the
 * morning after its own Oman day, not the coming 02:30 UTC, which would be
 * the SAME Oman day (no second seal, no day of job runs: a night that proves
 * nothing and still read "as expected"). Night 2 reads the job runs of night
 * 1's Oman day, whose last windowed run comes just before 15:00 UTC on that
 * date: a copy taken earlier cannot hold them all, so scheduled-jobs-on-time
 * is then reported, not asserted (expected-watch.json). In the planned evening
 * (15:30-20:00 UTC) nothing differs from before: night 2 is the coming 02:30
 * UTC and every check is asserted.
 *
 * WHY THIS FILE HOLDS NO DATABASE CLIENT. lib/integrity/run.ts imports
 * lib/alert.ts, which imports lib/rate-limit.ts, which imports lib/db.ts — a
 * client that reads DATABASE_URL by itself. tests/unit/scripts-production-guard.test.ts
 * refuses any file under scripts/ that reaches such a module, and neither that
 * guard nor the application may be changed by this work. So this file is pure:
 * it takes the watch function and the client from its caller, and checks the
 * target with the shared guard (rehearsalTarget). The caller is the gated runner
 * tests/integration/clean-start-watch.test.ts (RUN_CLEAN_START_WATCH=1), the
 * way tests/integration/golive-rehearsal.test.ts runs its rehearsal:
 *
 *   RUN_CLEAN_START_WATCH=1 DATABASE_URL=… DIRECT_URL=… \
 *     [CLEAN_START_FOREIGN_KEYS=<file: one key per line>] [CLEAN_START_WATCH_OUT=<file>] \
 *     npx vitest run tests/integration/clean-start-watch.test.ts
 *
 * NEVER PRODUCTION: rehearsalTarget refuses a connection string carrying any
 * production marker (scripts/lib/assert-not-production.ts, the shared host
 * list), whatever the command line says — --expect-host is not read. The watch
 * writes a seal and results: on production that is the real watch's job.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNotProduction, pointsAtProduction } from '../../lib/assert-not-production';
import { mismatchSignature } from '../../../lib/seal/chain';

export type Status = 'pass' | 'fail' | 'info' | 'error';
type Table = Record<string, Status[]>;

/** What the seal step did (lib/integrity/run.ts, seal-written detail.result). */
export type SealResult = 'genesis' | 'sealed' | 'already' | 'deferred' | 'unknown';
const SEAL_RESULTS: readonly SealResult[] = ['genesis', 'sealed', 'already', 'deferred'];

export type ExpectedWatch = {
  night1: Table;
  night2: Table;
  withForeignSeals: { night1: Table; night2: Table };
  night2NotAssertedBeforeUtcHour: Record<string, number | string>;
  sealWrittenResult: { about?: string; night1: SealResult; night2: SealResult };
};

export type Mismatch = {
  night: 1 | 2;
  checkId: string;
  got: Status | 'missing' | SealResult;
  expected: Status[] | 'not listed' | SealResult[];
};

export type NightResult = {
  night: 1 | 2;
  at: string;
  statuses: Record<string, Status>;
  notAsserted: string[];
};

export type RehearsalResult = { ok: boolean; nights: NightResult[]; mismatches: Mismatch[] };

/** lib/seal/store.ts SealStore, by shape. */
export type SealStoreShape = {
  get(key: string): Promise<string | null>;
  put(key: string, body: string, hash: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
};

/** lib/integrity/run.ts runIntegrityWatch, by shape (the caller hands the real one in). */
export type WatchFn<Db> = (
  db: Db,
  deps: {
    store: SealStoreShape;
    now: Date;
    inAppAlerts: boolean;
    alert: (input: unknown) => Promise<boolean>;
    audience: () => Promise<string[]>;
  }
) => Promise<{
  results: ReadonlyArray<{
    checkId: string;
    status: string;
    detail: Record<string, unknown> | null;
  }>;
}>;

export const EXPECTED_FILE = join(__dirname, 'expected-watch.json');

export function loadExpected(file = EXPECTED_FILE): ExpectedWatch {
  return JSON.parse(readFileSync(file, 'utf8')) as ExpectedWatch;
}

/**
 * The connection string, checked: never production. Refuses (throws, after the
 * shared guard printed why) whatever the command line holds.
 */
export function rehearsalTarget(url: string | undefined): string {
  if (url !== undefined && pointsAtProduction(url)) {
    console.error(
      '[clean-start] refusing: the watch rehearsal never runs on production (scripts/lib/assert-not-production.ts).'
    );
    throw new Error('refused: production');
  }
  // No arguments: --expect-host is never honoured here, so production is refused outright.
  return assertNotProduction(url, []);
}

/** A seal store in memory; `foreign` are keys already under seals/ that are not this chain's. */
export function memoryStore(
  foreign: readonly string[] = []
): SealStoreShape & { objects: Map<string, string> } {
  const objects = new Map<string, string>(foreign.map((k) => [k, '{}']));
  return {
    objects,
    async get(key) {
      return objects.has(key) ? objects.get(key)! : null;
    },
    async put(key, body) {
      objects.set(key, body);
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

/** Oman is UTC+4 all year (no daylight saving), as lib/tz.ts and run.sh have it. */
const OMAN_OFFSET_MS = 4 * 3_600_000;

/** The Oman calendar date of an instant: [year, month index, day]. */
function omanYmd(at: Date): [number, number, number] {
  const o = new Date(at.getTime() + OMAN_OFFSET_MS);
  return [o.getUTCFullYear(), o.getUTCMonth(), o.getUTCDate()];
}

/**
 * Night 2: the scheduled integrity watch (02:30 UTC, 06:30 Oman, vercel.json)
 * of the Oman day AFTER `now`'s Oman day. For a reset run in the evening
 * (15:30-20:00 UTC), and for any `now` from 02:30 to 20:00 UTC, that is the
 * coming 02:30 UTC. From 20:00 to 02:30 UTC (00:00-06:30 Oman) the coming 02:30
 * UTC is still `now`'s own Oman day: a second run that day writes no seal and
 * checks no day of job runs, so it would rehearse nothing while every status
 * still read as expected; night 2 is then one day further (review 2026-11-15).
 * The review of 2026-11-11 had chosen the coming 02:30 UTC so that night 2
 * would not expect job runs a copy taken that evening cannot hold: that is now
 * jobDayCompleteAt's rule, which reports the job check without asserting it.
 */
export function nextOmanMorning(now: Date): Date {
  const [y, m, d] = omanYmd(now);
  return new Date(Date.UTC(y, m, d + 1, 2, 30, 0, 0));
}

/**
 * The first instant a copy can hold every scheduled job run of night 1's Oman
 * day: `utcHour`:00 UTC on that day's calendar date (the windowed jobs run
 * 03:00-15:00 UTC, inside the Oman day; expected-watch.json names the hour).
 * Night 2 reads exactly that day, so before this instant its job check is
 * reported, not asserted. One rule for every hour: an evening run (15:30-20:00
 * UTC) is past it; a run after midnight in Oman (20:00-24:00 UTC) is before
 * it, since its Oman day has only begun; so is any run before 15:00 UTC.
 */
export function jobDayCompleteAt(night1: Date, utcHour: number): Date {
  const [y, m, d] = omanYmd(night1);
  return new Date(Date.UTC(y, m, d, utcHour, 0, 0, 0));
}

/** What the seal step reported, or 'unknown' (never free text: the line reaches the public log). */
export function sealResultOf(detail: Record<string, unknown> | null | undefined): SealResult {
  const r = detail?.result;
  return typeof r === 'string' && (SEAL_RESULTS as readonly string[]).includes(r)
    ? (r as SealResult)
    : 'unknown';
}

/** The signature run.ts records for a listed object that is not this chain's (lib/seal/chain.ts). */
export function foreignSignature(key: string): string {
  return mismatchSignature({ kind: 'offsite-unexpected', seq: -1, key });
}

/** Compare one night's results with its table. */
export function compareNight(
  night: 1 | 2,
  results: ReadonlyArray<{ checkId: string; status: string }>,
  table: Table,
  skip: ReadonlySet<string> = new Set()
): Mismatch[] {
  const out: Mismatch[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    seen.add(r.checkId);
    if (skip.has(r.checkId)) continue;
    const want = table[r.checkId];
    if (!want)
      out.push({ night, checkId: r.checkId, got: r.status as Status, expected: 'not listed' });
    else if (!want.includes(r.status as Status))
      out.push({ night, checkId: r.checkId, got: r.status as Status, expected: want });
  }
  for (const id of Object.keys(table))
    if (!seen.has(id) && !skip.has(id))
      out.push({ night, checkId: id, got: 'missing', expected: table[id]! });
  return out;
}

export type RehearseOptions = {
  /** Night 1's time; now by default. */
  now?: Date;
  /** Keys under seals/ that PLAN found and that are not production's chain. */
  foreignKeys?: readonly string[];
  expected?: ExpectedWatch;
  /** Assert scheduled-jobs-on-time on night 2 whatever the clock (a seeded database). */
  assertJobsOnNight2?: boolean;
  /** When the copy was taken, for the 15:00 UTC rule (jobDayCompleteAt); night 1's time by default. */
  clock?: Date;
};

/** Run the watch twice and compare (see the header). */
export async function rehearseWatch<Db>(
  db: Db,
  runWatch: WatchFn<Db>,
  opts: RehearseOptions = {}
): Promise<RehearsalResult> {
  const expected = opts.expected ?? loadExpected();
  const foreign = [...(opts.foreignKeys ?? [])];
  const store = memoryStore(foreign);
  const sigs = new Set(foreign.filter((k) => k.startsWith('seals/')).map(foreignSignature));
  const night1At = opts.now ?? new Date();
  const night2At = nextOmanMorning(night1At);
  const clock = opts.clock ?? night1At;
  const mismatches: Mismatch[] = [];
  const nights: NightResult[] = [];

  for (const [night, at] of [
    [1, night1At],
    [2, night2At],
  ] as const) {
    const summary = await runWatch(db, {
      store,
      now: at,
      inAppAlerts: false,
      alert: async () => true,
      audience: async () => [],
    });
    const table: Table = { ...(night === 1 ? expected.night1 : expected.night2) };
    if (sigs.size > 0)
      Object.assign(
        table,
        night === 1 ? expected.withForeignSeals.night1 : expected.withForeignSeals.night2
      );
    const skip = new Set<string>();
    if (night === 2 && !opts.assertJobsOnNight2) {
      for (const [id, hour] of Object.entries(expected.night2NotAssertedBeforeUtcHour)) {
        if (
          typeof hour === 'number' &&
          clock.getTime() < jobDayCompleteAt(night1At, hour).getTime()
        )
          skip.add(id);
      }
    }
    mismatches.push(...compareNight(night, summary.results, table, skip));
    // A seal was really written: the new chain's first, then the first chained to it.
    // "already" (a second run on one Oman day) is a pass too, and proves nothing.
    const sealRow = summary.results.find((r) => r.checkId === 'seal-written');
    const wantSeal =
      night === 1 ? expected.sealWrittenResult.night1 : expected.sealWrittenResult.night2;
    if (sealRow && table['seal-written']?.includes(sealRow.status as Status)) {
      const gotSeal = sealResultOf(sealRow.detail);
      if (gotSeal !== wantSeal)
        mismatches.push({ night, checkId: 'seal-written', got: gotSeal, expected: [wantSeal] });
    }
    // The foreign-seal exception is accepted only when the open findings are exactly the pre-listed keys.
    if (sigs.size > 0) {
      const copies = summary.results.find((r) => r.checkId === 'seal-offsite-copies');
      const open = Array.isArray(copies?.detail?.open)
        ? (copies!.detail!.open as Array<{ sig?: unknown }>)
        : [];
      const sigsOpen = new Set(open.map((o) => String(o.sig)));
      const same = sigsOpen.size === sigs.size && [...sigs].every((s) => sigsOpen.has(s));
      if (!same)
        mismatches.push({
          night,
          checkId: 'seal-offsite-copies',
          got: (copies?.status ?? 'missing') as Status,
          expected: ['fail'],
        });
    }
    nights.push({
      night,
      at: at.toISOString(),
      statuses: Object.fromEntries(summary.results.map((r) => [r.checkId, r.status as Status])),
      notAsserted: [...skip],
    });
  }
  return { ok: mismatches.length === 0, nights, mismatches };
}

/** The lines the public log may show: check ids, statuses, yes/no. Never a count. */
export function reportLines(r: RehearsalResult): string[] {
  const out: string[] = [];
  for (const n of r.nights) {
    out.push(`night ${n.night}:`);
    for (const [id, s] of Object.entries(n.statuses).sort())
      out.push(`  ${id}: ${s}${n.notAsserted.includes(id) ? ' (not asserted)' : ''}`);
  }
  for (const m of r.mismatches) {
    out.push(
      `  MISMATCH night ${m.night} ${m.checkId}: ${m.got}, expected ${Array.isArray(m.expected) ? m.expected.join('|') : m.expected}`
    );
  }
  out.push(`first integrity checks as expected: ${r.ok ? 'yes' : 'no'}`);
  return out;
}

/** The --out / CLEAN_START_WATCH_OUT file: the status table as JSON. */
export function reportJson(r: RehearsalResult): string {
  return JSON.stringify(
    {
      night1: r.nights[0]?.statuses ?? {},
      night2: r.nights[1]?.statuses ?? {},
      notAsserted: { night2: r.nights[1]?.notAsserted ?? [] },
      ok: r.ok,
      mismatches: r.mismatches,
    },
    null,
    2
  );
}
