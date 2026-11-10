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
 * with expected-watch.json. Night 2 does not assert scheduled-jobs-on-time when
 * the rehearsal starts before 15:00 UTC (the copy lacks the reset day's later
 * windowed runs; see that file).
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

export type ExpectedWatch = {
  night1: Table;
  night2: Table;
  withForeignSeals: { night1: Table; night2: Table };
  night2NotAssertedBeforeUtcHour: Record<string, number | string>;
};

export type Mismatch = {
  night: 1 | 2;
  checkId: string;
  got: Status | 'missing';
  expected: Status[] | 'not listed';
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

/** 02:30 UTC of the calendar day after `now`'s Oman date: the scheduled run of Oman day D+1. */
export function nextOmanMorning(now: Date): Date {
  const oman = new Date(now.getTime() + 4 * 3600_000);
  return new Date(
    Date.UTC(oman.getUTCFullYear(), oman.getUTCMonth(), oman.getUTCDate() + 1, 2, 30, 0, 0)
  );
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
  /** Assert scheduled-jobs-on-time on night 2 even before 15:00 UTC (a seeded database). */
  assertJobsOnNight2?: boolean;
  /** The real clock, for the 15:00 UTC rule; now by default. */
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
  const clock = opts.clock ?? new Date();
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
        if (typeof hour === 'number' && clock.getUTCHours() < hour) skip.add(id);
      }
    }
    mismatches.push(...compareNight(night, summary.results, table, skip));
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
