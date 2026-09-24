/**
 * The two sub-daily production jobs, scheduled where they will actually run.
 *
 * keep-warm (every 4 minutes) and the SLA escalation sweep (:15 and :45) are
 * called by .github/workflows/keep-warm.yml and sla-escalate.yml — and GitHub's
 * scheduler delivers 2–3 of each a day, not 180 and 24 (e.g. 08:08, 13:35 and
 * 17:56 on 2026-09-23). So escalations ran hours late and /api/health reported
 * both jobs `stale`. The owner's decision D3 (2026-09-14, docs/OPERATIONS.md §5d)
 * is an external scheduler; setting cron-job.org up by hand did not work.
 *
 * This creates, fixes or checks those two jobs through cron-job.org's REST API
 * (https://docs.cron-job.org/rest-api.html). It runs INSIDE GitHub Actions —
 * .github/workflows/cron-scheduler.yml — for one reason: the bearer the jobs
 * must present is the `PROD_CRON_SECRET` repository secret, the value the
 * GitHub-scheduled workflows already use successfully. Run there, nobody copies
 * CRON_SECRET out of Vercel (where it may be unrevealable), pastes it into a web
 * form, or has it pass through a terminal or a transcript.
 *
 *   --check   read-only: what exists, how it differs, the last executions
 *   --apply   probe the bearer, then create or patch the two jobs, then re-check
 *
 * Exit code is 0 only when both jobs exist, are enabled and match exactly.
 *
 * What this must never print: the CRON_SECRET, the cron-job.org API key, or a
 * job's `extendedData.headers` (the API returns configured headers on read,
 * Authorization included). Every line goes through `say()`, which also replaces
 * both secret values if anything ever carries one.
 */

/** One job, from one place. The schedules match the GitHub workflows they back up. */
export const CRON_JOBS = [
  {
    key: 'keep-warm',
    title: 'NMWC CRM — keep-warm',
    path: '/api/cron/keep-warm',
    cron: '*/4 3-14 * * *',
  },
  {
    key: 'sla-escalate',
    title: 'NMWC CRM — SLA escalation sweep',
    path: '/api/cron/sla-escalate',
    cron: '15,45 3-14 * * *',
  },
] as const;

export type CronJobSpec = (typeof CRON_JOBS)[number];

/** cron-job.org's schedule shape. `[-1]` means "every" in that field. */
export type JobSchedule = {
  timezone: string;
  expiresAt: number;
  hours: number[];
  mdays: number[];
  minutes: number[];
  months: number[];
  wdays: number[];
};

/** The subset of cron-job.org's DetailedJob this script writes and compares. */
export type JobBody = {
  url: string;
  title: string;
  enabled: boolean;
  saveResponses: boolean;
  requestTimeout: number;
  redirectSuccess: boolean;
  requestMethod: number;
  schedule: JobSchedule;
  extendedData: { headers: Record<string, string>; body: string };
  notification: {
    onFailure: boolean;
    onFailureCount: number;
    onSuccess: boolean;
    onDisable: boolean;
  };
};

/** Seconds cron-job.org waits for an answer. Its free tier allows up to 30. */
export const REQUEST_TIMEOUT_SEC = 30;

/**
 * E-mail after this many CONSECUTIVE failures. Two, not one: a single cold start
 * or a Vercel blip should not page anyone, and two misses is 8 minutes for
 * keep-warm and an hour for the sweep — the heartbeat's own staleness allowance
 * (lib/heartbeat.ts) is the second line behind this.
 */
export const FAILURE_EMAIL_AFTER = 2;

const RANGES = {
  minutes: [0, 59],
  hours: [0, 23],
  mdays: [1, 31],
  months: [1, 12],
  wdays: [0, 6],
} as const;

type Field = keyof typeof RANGES;

/** One cron field → cron-job.org's array. Supports `*`, `*\/n`, `a-b`, `a,b` and numbers. */
export function parseCronField(field: string, which: Field): number[] {
  const [lo, hi] = RANGES[which];
  if (field === '*') return [-1];
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const step = /^\*\/(\d+)$/.exec(part);
    const range = /^(\d+)-(\d+)$/.exec(part);
    const one = /^(\d+)$/.exec(part);
    if (step) {
      const n = Number(step[1]);
      if (n < 1) throw new Error(`cron ${which}: step must be at least 1 in "${field}"`);
      for (let v = lo; v <= hi; v += n) out.add(v);
    } else if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > b) throw new Error(`cron ${which}: range ${a}-${b} runs backwards`);
      for (let v = a; v <= b; v++) out.add(v);
    } else if (one) {
      out.add(Number(one[1]));
    } else {
      throw new Error(`cron ${which}: unsupported syntax "${part}"`);
    }
  }
  const values = [...out].sort((x, y) => x - y);
  for (const v of values) {
    if (v < lo || v > hi) throw new Error(`cron ${which}: ${v} is outside ${lo}-${hi}`);
  }
  return values;
}

/** A five-field cron expression, in UTC, → cron-job.org's schedule. */
export function cronToSchedule(expr: string): JobSchedule {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron: expected 5 fields, got ${f.length} in "${expr}"`);
  const [minute, hour, mday, month, wday] = f as [string, string, string, string, string];
  return {
    // UTC, always: the schedules and lib/heartbeat.ts's active hours are UTC, and a
    // job left on the account's local time zone is one of the ways the hand set-up
    // can go wrong without anything saying so.
    timezone: 'UTC',
    expiresAt: 0,
    minutes: parseCronField(minute, 'minutes'),
    hours: parseCronField(hour, 'hours'),
    mdays: parseCronField(mday, 'mdays'),
    months: parseCronField(month, 'months'),
    wdays: parseCronField(wday, 'wdays'),
  };
}

/** The job exactly as it should exist. `bearer` is CRON_SECRET; nothing here prints it. */
export function desiredJob(spec: CronJobSpec, baseUrl: string, bearer: string): JobBody {
  return {
    url: `${baseUrl.replace(/\/+$/, '')}${spec.path}`,
    title: spec.title,
    enabled: true,
    saveResponses: false,
    requestTimeout: REQUEST_TIMEOUT_SEC,
    redirectSuccess: false,
    // 0 = GET in cron-job.org's RequestMethod enum. The routes export GET only.
    requestMethod: 0,
    schedule: cronToSchedule(spec.cron),
    // `Bearer ` with the space: lib/cron-auth.ts compares the whole header, so a
    // bare secret is a 401 on every call — the first thing to rule out by hand.
    extendedData: { headers: { Authorization: `Bearer ${bearer}` }, body: '' },
    notification: {
      onFailure: true,
      onFailureCount: FAILURE_EMAIL_AFTER,
      onSuccess: false,
      onDisable: true,
    },
  };
}

const sameList = (a: readonly number[] | undefined, b: readonly number[]) =>
  Array.isArray(a) && a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === b[i]);

/**
 * Every way `existing` differs from `desired`, as labels that are safe to print.
 * The Authorization header is compared, never shown: the label says only whether
 * it is missing or different.
 */
export function jobDifferences(existing: Partial<JobBody> | undefined, desired: JobBody): string[] {
  if (!existing) return ['job does not exist'];
  const out: string[] = [];
  if (existing.url !== desired.url) out.push(`url is ${JSON.stringify(existing.url)}`);
  if (existing.enabled !== true) out.push('job is DISABLED');
  if (existing.requestMethod !== desired.requestMethod) out.push(`request method is ${existing.requestMethod}, not 0 (GET)`);
  if (existing.requestTimeout !== desired.requestTimeout) out.push(`timeout is ${existing.requestTimeout}, not ${desired.requestTimeout}`);
  const s = existing.schedule;
  if (!s) {
    out.push('no schedule');
  } else {
    if (s.timezone !== 'UTC') out.push(`time zone is ${JSON.stringify(s.timezone)}, not UTC`);
    if (s.expiresAt !== 0 && s.expiresAt !== undefined) out.push(`schedule expires at ${s.expiresAt}`);
    for (const k of ['minutes', 'hours', 'mdays', 'months', 'wdays'] as const) {
      if (!sameList(s[k], desired.schedule[k])) out.push(`schedule ${k} is ${JSON.stringify(s[k])}`);
    }
  }
  const auth = existing.extendedData?.headers?.Authorization ?? existing.extendedData?.headers?.authorization;
  if (auth === undefined) out.push('Authorization header is MISSING');
  else if (auth !== desired.extendedData.headers.Authorization) out.push('Authorization header DIFFERS from PROD_CRON_SECRET');
  const n = existing.notification;
  if (!n?.onFailure) out.push('failure e-mails are off');
  else if (n.onFailureCount !== desired.notification.onFailureCount) out.push(`failure e-mail after ${n.onFailureCount} failures`);
  if (n && !n.onDisable) out.push('no e-mail when cron-job.org disables the job');
  return out;
}

/** cron-job.org's JobStatus enum, for the history lines. */
export const JOB_STATUS: Record<number, string> = {
  0: 'not run yet',
  1: 'OK',
  2: 'failed (DNS)',
  3: 'failed (could not connect)',
  4: 'failed (HTTP error)',
  5: 'failed (timeout)',
  6: 'failed (response too large)',
  7: 'failed (invalid URL)',
  8: 'failed (internal)',
  9: 'failed (unknown)',
};

/** cron-job.org's documented API error codes, so a failure says what it means. */
export const API_ERRORS: Record<number, string> = {
  400: 'bad request (invalid input)',
  401: 'the API key is invalid',
  403: 'the API key cannot be used from here — remove its IP restriction (GitHub runners change address)',
  404: 'not found',
  409: 'conflict (already exists)',
  429: 'quota or rate limit exceeded (100 requests a day on a free account)',
  500: 'cron-job.org internal error',
};

export function argvMode(argv: readonly string[]): 'check' | 'apply' | null {
  if (argv.length === 1 && argv[0] === '--check') return 'check';
  if (argv.length === 1 && argv[0] === '--apply') return 'apply';
  return null;
}

/* ------------------------------------------------------------------------- */

const API = 'https://api.cron-job.org';

type ApiJob = Partial<JobBody> & {
  jobId: number;
  lastStatus?: number;
  lastExecution?: number;
  nextExecution?: number;
};

type HistoryItem = { date: number; httpStatus: number; status: number; duration: number };

/** What run() needs from the outside world — injected so the tests can stand in for it. */
export type Deps = {
  fetch: typeof fetch;
  /** Receives every line of output. run() redacts both secrets before calling it. */
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
};

export type RunEnv = {
  CRONJOB_API_KEY?: string;
  CRON_SECRET?: string;
  APP_BASE_URL?: string;
};

const iso = (unix?: number) => (unix && unix > 0 ? new Date(unix * 1000).toISOString().slice(0, 16) + 'Z' : '—');
const norm = (u?: string) => (u ?? '').replace(/\/+$/, '');

/**
 * The whole behaviour. Returns the exit code: 0 only when both jobs exist, are
 * enabled, match exactly and have no enabled duplicate.
 */
export async function run(mode: 'check' | 'apply', env: RunEnv, deps: Deps): Promise<number> {
  const key = env.CRONJOB_API_KEY?.trim() ?? '';
  const bearer = env.CRON_SECRET?.trim() ?? '';
  const baseUrl = (env.APP_BASE_URL?.trim() || 'https://nmwc-cm.vercel.app').replace(/\/+$/, '');

  // The ONLY path to output. Replaces either secret wherever it appears, so a
  // line that carried one by mistake — an error message, a URL, a field this
  // file forgot to leave out — prints [redacted] instead.
  const say = (line = '') => {
    let out = String(line);
    for (const secret of [key, bearer]) if (secret) out = out.split(secret).join('[redacted]');
    deps.log(out);
  };

  if (!key) {
    say('::error::CRONJOB_API_KEY is not set. Create one at cron-job.org → Settings → API (no IP restriction) and add it as a repository secret. docs/OPERATIONS.md §5d.');
    return 1;
  }
  if (bearer.length < 16) {
    say('::error::CRON_SECRET (the PROD_CRON_SECRET repository secret) is missing or too short to be the production value.');
    return 1;
  }
  if (!baseUrl.startsWith('https://')) {
    say('::error::APP_BASE_URL must be an https URL.');
    return 1;
  }

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await deps.fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      // Status and its documented meaning only: an error body can quote the request.
      throw new Error(
        `cron-job.org ${method} ${path.replace(/\d+/g, '<id>')} → HTTP ${res.status}: ${API_ERRORS[res.status] ?? 'unexpected'}`
      );
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  const desired = CRON_JOBS.map((spec) => desiredJob(spec, baseUrl, bearer));
  const list = async () => (await api<{ jobs?: ApiJob[] }>('GET', '/jobs')).jobs ?? [];

  try {
    if (mode === 'apply') {
      // A job created with the wrong bearer is a 401 every four minutes. Prove the
      // secret against production first, on the route that has no side effects.
      const warm = desired.find((d) => d.url.endsWith('/api/cron/keep-warm'))!;
      const res = await deps.fetch(warm.url, {
        headers: { authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(30_000),
      });
      await res.arrayBuffer().catch(() => undefined);
      say(`probe: GET ${warm.url} with the bearer → HTTP ${res.status}`);
      if (res.status < 200 || res.status >= 300) {
        say('::error::production refused PROD_CRON_SECRET, so no job was written. It must equal CRON_SECRET in Vercel → Production.');
        return 1;
      }
      const jobs = await list();
      for (const want of desired) {
        const matches = jobs.filter((j) => norm(j.url) === norm(want.url));
        if (matches.length === 0) {
          const created = await api<{ jobId: number }>('PUT', '/jobs', { job: want });
          say(`created job ${created.jobId}: ${want.title}`);
          await deps.sleep(1_100); // PUT /jobs: at most one a second
        } else {
          await api('PATCH', `/jobs/${matches[0]!.jobId}`, { job: want });
          say(`updated job ${matches[0]!.jobId}: ${want.title}`);
          // A second job on the same URL doubles every call. Disabled, not deleted:
          // it may be the owner's hand-made attempt, and a disabled job can still
          // be looked at, and removed, by a person.
          for (const dup of matches.slice(1)) {
            if (dup.enabled === false) continue;
            await api('PATCH', `/jobs/${dup.jobId}`, { job: { enabled: false } });
            say(`disabled duplicate job ${dup.jobId} (same URL)`);
          }
        }
      }
      say('');
      say('re-reading what cron-job.org now holds:');
    }

    const jobs = await list();
    let ok = true;
    for (const want of desired) {
      const all = jobs.filter((j) => norm(j.url) === norm(want.url));
      const enabled = all.filter((j) => j.enabled !== false);
      say('');
      say(want.title);
      say(`  ${want.url}`);
      if (all.length === 0) {
        say('  ✗ no job calls this URL');
        ok = false;
        continue;
      }
      if (enabled.length > 1) {
        say(`  ✗ ${enabled.length} enabled jobs call this URL — every call is doubled`);
        ok = false;
      }
      const first = (enabled[0] ?? all[0])!;
      const detail = (await api<{ jobDetails: ApiJob }>('GET', `/jobs/${first.jobId}`)).jobDetails;
      // Only named fields are printed. extendedData — which holds the
      // Authorization header — is compared by jobDifferences and never shown.
      say(
        `  job ${first.jobId}: ${detail.enabled ? 'enabled' : 'DISABLED'}, last run ${iso(detail.lastExecution)} (${
          JOB_STATUS[detail.lastStatus ?? 0] ?? detail.lastStatus
        }), next ${iso(detail.nextExecution)}`
      );
      const diffs = jobDifferences(detail, want);
      for (const d of diffs) say(`  ✗ ${d}`);
      if (diffs.length === 0) say('  ✓ matches exactly');
      else ok = false;
      const hist = await api<{ history?: HistoryItem[] }>('GET', `/jobs/${first.jobId}/history`);
      const recent = (hist.history ?? []).slice(0, 8);
      if (recent.length === 0) say('  no executions recorded yet');
      else {
        say('  last executions (UTC):');
        for (const h of recent) {
          say(`    ${iso(h.date)}  HTTP ${h.httpStatus}  ${JOB_STATUS[h.status] ?? h.status}  ${h.duration} ms`);
        }
      }
    }
    const others = jobs.filter((j) => !desired.some((d) => norm(d.url) === norm(j.url)));
    if (others.length) {
      say('');
      say(`${others.length} other job(s) on this account, not touched:`);
      for (const j of others) say(`  job ${j.jobId}: ${j.enabled ? 'enabled' : 'disabled'} ${j.url}`);
    }
    say('');
    say(ok ? '✓ both jobs exist, are enabled and match.' : '✗ the jobs are not as they should be (see above).');
    return ok ? 0 : 1;
  } catch (err) {
    say(`::error::${err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error'}`);
    return 1;
  }
}

/**
 * Run only when invoked as a command: tests/unit/cron-scheduler.test.ts imports
 * this module, and a top-level call would have `npm test` reach cron-job.org —
 * or exit the run on the missing key.
 */
if (/cron-scheduler\.ts$/.test(process.argv[1] ?? '')) {
  const mode = argvMode(process.argv.slice(2));
  if (!mode) {
    console.error('usage: cron-scheduler.ts --check | --apply');
    process.exit(2);
  }
  void run(
    mode,
    {
      CRONJOB_API_KEY: process.env.CRONJOB_API_KEY,
      CRON_SECRET: process.env.CRON_SECRET,
      APP_BASE_URL: process.env.APP_BASE_URL,
    },
    {
      fetch,
      log: (line) => console.log(line),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }
  ).then((code) => process.exit(code));
}
