// @vitest-environment node
/**
 * scripts/ops/cron-scheduler.ts creates the two cron-job.org jobs that replace
 * GitHub's 2–3-runs-a-day scheduler for keep-warm and the SLA sweep (decision D3).
 * It writes persistent configuration at a third party and carries the production
 * CRON_SECRET, so both halves are proved here by behaviour against a simulated
 * cron-job.org — one that, like the real API, hands a job's Authorization header
 * back on every read.
 *
 * The rule every scenario ends on: neither secret appears in anything it printed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CRON_JOBS,
  FAILURE_EMAIL_AFTER,
  REQUEST_TIMEOUT_SEC,
  argvMode,
  cronToSchedule,
  desiredJob,
  jobDifferences,
  parseCronField,
  run,
  type JobBody,
} from '@/scripts/ops/cron-scheduler';
import { HEARTBEAT_EXPECTATIONS } from '@/lib/heartbeat';
import { REQUIRED_SECRETS } from '@/lib/ops/required-secrets';
import { runScriptOf, runStep, STEP_TEST_TIMEOUT_MS } from '../support/workflow-step';

// Zero-entropy on purpose: gitleaks scans this repository, and a realistic-looking
// fixture is a finding (it flagged the first version of this file). cron-auth.test.ts
// does the same.
const SECRET = 's'.repeat(32);
const API_KEY = 'k'.repeat(32);
const BASE = 'https://nmwc-cm.vercel.app';
const API = 'https://api.cron-job.org';

type Stored = Partial<JobBody> & { jobId: number; lastStatus?: number };
type Call = { method: string; url: string; auth: string | null; body: unknown };

/**
 * cron-job.org, as its REST documentation describes it, plus the production
 * keep-warm route the apply mode probes first.
 */
function fakeWorld(
  opts: {
    jobs?: Stored[];
    probeStatus?: number;
    apiStatus?: number;
    throwWith?: string;
    /** Jobs on a cron-job.org node that is not answering: left out of the list. */
    hidden?: number[];
  } = {}
) {
  const jobs = new Map<number, Stored>((opts.jobs ?? []).map((j) => [j.jobId, structuredClone(j)]));
  let nextId = 9000;
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, auth: headers.get('authorization'), body });
    if (opts.throwWith) throw new Error(opts.throwWith);
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (url === `${BASE}/api/cron/keep-warm`) return new Response('{}', { status: opts.probeStatus ?? 200 });
    if (!url.startsWith(API)) return new Response('not found', { status: 404 });
    if (headers.get('authorization') !== `Bearer ${API_KEY}`) return json(401, {});
    if (opts.apiStatus) return json(opts.apiStatus, { error: `quoted request ${SECRET}` });

    const path = url.slice(API.length);
    const id = Number(/^\/jobs\/(\d+)/.exec(path)?.[1]);
    if (method === 'GET' && path === '/jobs') {
      // The list carries no extendedData, as the real one does not.
      const hidden = new Set(opts.hidden ?? []);
      return json(200, {
        jobs: [...jobs.values()]
          .filter((j) => !hidden.has(j.jobId))
          .map(({ extendedData: _omit, ...rest }) => rest),
        someFailed: hidden.size > 0,
      });
    }
    if (method === 'PUT' && path === '/jobs') {
      const job = { ...(body as { job: Stored }).job, jobId: ++nextId };
      jobs.set(job.jobId, job);
      return json(200, { jobId: job.jobId });
    }
    if (method === 'GET' && /^\/jobs\/\d+$/.test(path)) {
      const job = jobs.get(id);
      return job ? json(200, { jobDetails: job }) : json(404, {});
    }
    if (method === 'PATCH' && /^\/jobs\/\d+$/.test(path)) {
      const job = jobs.get(id);
      if (!job) return json(404, {});
      jobs.set(id, { ...job, ...(body as { job: Stored }).job, jobId: id });
      return json(200, {});
    }
    if (method === 'GET' && /^\/jobs\/\d+\/history$/.test(path)) {
      return json(200, {
        history: [{ date: 1790260000, httpStatus: 200, status: 1, duration: 312, headers: `authorization: Bearer ${SECRET}` }],
        predictions: [],
      });
    }
    return json(400, {});
  }) as typeof fetch;
  return { jobs, calls, fetchImpl };
}

async function go(mode: 'check' | 'apply', world: ReturnType<typeof fakeWorld>, env: Record<string, string> = {}) {
  const lines: string[] = [];
  const from = world.calls.length;
  const code = await run(
    mode,
    { CRONJOB_API_KEY: API_KEY, CRON_SECRET: SECRET, APP_BASE_URL: BASE, ...env },
    { fetch: world.fetchImpl, log: (l) => lines.push(l), sleep: async () => undefined }
  );
  const out = lines.join('\n');
  // The invariant, asserted on every scenario rather than in one test of its own.
  expect(out, 'the CRON_SECRET must never be printed').not.toContain(SECRET);
  expect(out, 'the cron-job.org API key must never be printed').not.toContain(API_KEY);
  // Only this run's calls: a world can be reused across runs.
  const mine = world.calls.slice(from);
  return { code, out, writes: mine.filter((c) => c.method === 'PUT' || c.method === 'PATCH') };
}

const want = (key: 'keep-warm' | 'sla-escalate') =>
  desiredJob(CRON_JOBS.find((j) => j.key === key)!, BASE, SECRET);

/* ------------------------------------------------------------------------- */

describe('the schedules', () => {
  it('parses the cron fields these two jobs use', () => {
    expect(parseCronField('*', 'mdays')).toEqual([-1]);
    expect(parseCronField('*/4', 'minutes')).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56]);
    expect(parseCronField('3-14', 'hours')).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(parseCronField('45,15', 'minutes')).toEqual([15, 45]);
  });

  it('refuses what it cannot translate, rather than guessing', () => {
    expect(() => parseCronField('60', 'minutes')).toThrow(/outside/);
    expect(() => parseCronField('14-3', 'hours')).toThrow(/backwards/);
    expect(() => parseCronField('*/0', 'minutes')).toThrow(/step/);
    expect(() => parseCronField('MON', 'wdays')).toThrow(/unsupported/);
    expect(() => cronToSchedule('*/4 3-14 * *')).toThrow(/5 fields/);
  });

  it('are the SAME schedules the GitHub workflows they back up use', () => {
    // Two schedulers for one job must agree, or the backup and the primary fight.
    for (const job of CRON_JOBS) {
      const yml = readFileSync(`.github/workflows/${job.key}.yml`, 'utf8');
      expect(yml, `${job.key}.yml`).toContain(`cron: '${job.cron}'`);
    }
  });

  it('are what the dead-man in lib/heartbeat.ts expects, so a working job reads as ok', () => {
    for (const job of CRON_JOBS) {
      const s = cronToSchedule(job.cron);
      const exp = HEARTBEAT_EXPECTATIONS[job.key];
      // Evenly spaced, at the heartbeat's interval.
      const gaps = s.minutes.map((m, i) => (s.minutes[i + 1] ?? s.minutes[0]! + 60) - m);
      expect(new Set(gaps), `${job.key} minutes are evenly spaced`).toEqual(new Set([exp.everyMinutes]));
      // Inside, and covering, the heartbeat's active hours [from, to).
      const [from, to] = exp.activeHoursUtc!;
      expect(s.hours).toEqual(Array.from({ length: to - from }, (_, i) => from + i));
      expect([s.mdays, s.months, s.wdays]).toEqual([[-1], [-1], [-1]]);
    }
  });
});

describe('the job it writes', () => {
  it('is a GET, in UTC, enabled, with the bearer and failure e-mails', () => {
    const j = want('keep-warm');
    expect(j.url).toBe(`${BASE}/api/cron/keep-warm`);
    expect(j.requestMethod).toBe(0);
    expect(j.enabled).toBe(true);
    expect(j.schedule.timezone).toBe('UTC');
    expect(j.schedule.expiresAt).toBe(0);
    expect(j.requestTimeout).toBe(REQUEST_TIMEOUT_SEC);
    // With the `Bearer ` prefix: lib/cron-auth.ts rejects a bare secret.
    expect(j.extendedData.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
    expect(j.notification).toEqual({ onFailure: true, onFailureCount: FAILURE_EMAIL_AFTER, onSuccess: false, onDisable: true });
  });

  it('does not double the slash when the base URL ends in one', () => {
    expect(desiredJob(CRON_JOBS[0], `${BASE}/`, SECRET).url).toBe(`${BASE}/api/cron/keep-warm`);
  });
});

describe('jobDifferences', () => {
  it('finds nothing wrong with the job exactly as it should be', () => {
    expect(jobDifferences(want('sla-escalate'), want('sla-escalate'))).toEqual([]);
  });

  it('names every way a hand-made job goes wrong, and never the secret', () => {
    const bad: Partial<JobBody> = {
      ...want('keep-warm'),
      enabled: false,
      requestMethod: 1,
      schedule: { ...want('keep-warm').schedule, timezone: 'Asia/Muscat', minutes: [0] },
      // The commonest mistake: the secret without `Bearer `.
      extendedData: { headers: { Authorization: SECRET }, body: '' },
      notification: { onFailure: false, onFailureCount: 1, onSuccess: false, onDisable: false },
    };
    const d = jobDifferences(bad, want('keep-warm'));
    const text = d.join('\n');
    expect(text).toMatch(/DISABLED/);
    expect(text).toMatch(/request method/);
    expect(text).toMatch(/time zone/);
    expect(text).toMatch(/schedule minutes/);
    expect(text).toMatch(/Authorization header DIFFERS/);
    expect(text).toMatch(/failure e-mails are off/);
    expect(text).not.toContain(SECRET);
  });

  it('reports a missing Authorization header as missing', () => {
    const j = { ...want('keep-warm'), extendedData: { headers: {}, body: '' } };
    expect(jobDifferences(j, want('keep-warm'))).toContain('Authorization header is MISSING');
  });
});

describe('run — refusing before anything is written', () => {
  it('fails, and calls nothing, without an API key', async () => {
    const w = fakeWorld();
    const r = await go('apply', w, { CRONJOB_API_KEY: '' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/CRONJOB_API_KEY is not set/);
    expect(w.calls).toEqual([]);
  });

  it('fails, and calls nothing, without a production-length CRON_SECRET', async () => {
    const w = fakeWorld();
    const r = await go('apply', w, { CRON_SECRET: 'short' });
    expect(r.code).toBe(1);
    expect(w.calls).toEqual([]);
  });

  it('writes NO job when production refuses the bearer', async () => {
    // A job created with a wrong secret is a 401 every four minutes.
    const w = fakeWorld({ probeStatus: 401 });
    const r = await go('apply', w);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/refused PROD_CRON_SECRET/);
    expect(r.writes).toEqual([]);
    // And the probe really presented the bearer, with its prefix.
    expect(w.calls[0]).toMatchObject({ url: `${BASE}/api/cron/keep-warm`, auth: `Bearer ${SECRET}` });
  });
});

describe('run — apply', () => {
  it('creates both jobs on an empty account, exactly as specified, and then reports them green', async () => {
    const w = fakeWorld();
    const r = await go('apply', w);
    expect(r.code, r.out).toBe(0);
    expect(r.writes.map((c) => c.method)).toEqual(['PUT', 'PUT']);
    const stored = [...w.jobs.values()];
    expect(stored).toHaveLength(2);
    for (const key of ['keep-warm', 'sla-escalate'] as const) {
      const job = stored.find((j) => j.url === want(key).url);
      expect(job, key).toBeDefined();
      expect(jobDifferences(job, want(key)), key).toEqual([]);
    }
    // Every cron-job.org call carried the API key.
    expect(w.calls.filter((c) => c.url.startsWith(API)).every((c) => c.auth === `Bearer ${API_KEY}`)).toBe(true);
    expect(r.out).toMatch(/both jobs exist, are enabled and match/);
  });

  it('fixes a broken hand-made job in place, disables a duplicate, and leaves other jobs alone', async () => {
    const broken: Stored = {
      ...want('keep-warm'),
      jobId: 11,
      enabled: false,
      schedule: { ...want('keep-warm').schedule, timezone: 'Asia/Muscat' },
      extendedData: { headers: { Authorization: SECRET }, body: '' },
    };
    const duplicate: Stored = { ...want('keep-warm'), jobId: 12, enabled: true };
    const other: Stored = { jobId: 13, url: 'https://example.org/ping', enabled: true };
    const w = fakeWorld({ jobs: [broken, duplicate, other] });
    const r = await go('apply', w);
    expect(r.code, r.out).toBe(0);
    expect(jobDifferences(w.jobs.get(11), want('keep-warm'))).toEqual([]);
    expect(w.jobs.get(12)!.enabled).toBe(false);
    expect(w.jobs.get(13)).toEqual(other);
    expect(r.writes.some((c) => c.url.endsWith('/jobs/13'))).toBe(false);
    // The SLA job did not exist, so it was created, not left out.
    expect([...w.jobs.values()].some((j) => j.url === want('sla-escalate').url)).toBe(true);
  });

  it('is idempotent: a second apply changes nothing it needs to create', async () => {
    const w = fakeWorld();
    await go('apply', w);
    const before = w.jobs.size;
    const r = await go('apply', w);
    expect(r.code).toBe(0);
    expect(w.jobs.size).toBe(before);
    expect(r.writes.filter((c) => c.method === 'PUT')).toEqual([]);
  });
});

describe('run — check', () => {
  it('is read-only, and red when the jobs are wrong or missing', async () => {
    const w = fakeWorld({ jobs: [{ ...want('keep-warm'), jobId: 21, schedule: { ...want('keep-warm').schedule, timezone: 'Asia/Muscat' } }] });
    const r = await go('check', w);
    expect(r.code).toBe(1);
    expect(r.writes).toEqual([]);
    expect(r.out).toMatch(/time zone/);
    expect(r.out).toMatch(/no job calls this URL/);
  });

  it('is red when one job is perfect and the other does not exist', async () => {
    // The case above is red for its time zone too, so it cannot show that a
    // missing job on its own turns the check red.
    const w = fakeWorld({ jobs: [{ ...want('keep-warm'), jobId: 25 }] });
    const r = await go('check', w);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/matches exactly/);
    expect(r.out).toMatch(/no job calls this URL/);
  });

  it('is green only when both jobs match, and shows their recent executions', async () => {
    const w = fakeWorld({
      jobs: [
        { ...want('keep-warm'), jobId: 31 },
        { ...want('sla-escalate'), jobId: 32 },
      ],
    });
    const r = await go('check', w);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/HTTP 200 {2}OK/);
  });

  it('is red when two ENABLED jobs call one URL', async () => {
    const w = fakeWorld({
      jobs: [
        { ...want('keep-warm'), jobId: 41 },
        { ...want('keep-warm'), jobId: 42 },
        { ...want('sla-escalate'), jobId: 43 },
      ],
    });
    const r = await go('check', w);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/2 enabled jobs call this URL/);
  });
});

describe('run — an incomplete job list is never acted on', () => {
  // cron-job.org leaves out the jobs on a node that does not answer and says so
  // with someFailed. Acting on that list created a duplicate of a hidden job and
  // still ended green (review, 2026-09-24).
  it('apply writes nothing while the list is incomplete', async () => {
    const w = fakeWorld({
      jobs: [
        { ...want('keep-warm'), jobId: 51 },
        { ...want('sla-escalate'), jobId: 52 },
      ],
      hidden: [51, 52],
    });
    const r = await go('apply', w);
    expect(r.code).toBe(1);
    expect(r.writes).toEqual([]);
    expect(r.out).toMatch(/could not list every job/);
    expect(w.jobs.size).toBe(2);
  });

  it('check is red, and says why, while the list is incomplete', async () => {
    const w = fakeWorld({
      jobs: [
        { ...want('keep-warm'), jobId: 61 },
        { ...want('sla-escalate'), jobId: 62 },
        { ...want('sla-escalate'), jobId: 63 },
      ],
      // The duplicate is the hidden one: the visible pair alone would read green.
      hidden: [63],
    });
    const r = await go('check', w);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/could not list every job/);
  });
});

describe('run — the probe says which thing is wrong', () => {
  it('blames the secret only for a 401', async () => {
    for (const status of [404, 500, 503]) {
      const w = fakeWorld({ probeStatus: status });
      const r = await go('apply', w);
      expect(r.code, `HTTP ${status}`).toBe(1);
      expect(r.writes, `HTTP ${status}`).toEqual([]);
      expect(r.out, `HTTP ${status}`).not.toMatch(/refused PROD_CRON_SECRET/);
    }
  });

  it('points a 404 at APP_BASE_URL and a 5xx at production\'s health', async () => {
    expect((await go('apply', fakeWorld({ probeStatus: 404 }))).out).toMatch(/APP_BASE_URL/);
    expect((await go('apply', fakeWorld({ probeStatus: 503 }))).out).toMatch(/database/);
  });
});

describe('run — the owner\'s other jobs', () => {
  it('are listed by origin only, so a credential in their URL stays out of the log', async () => {
    const w = fakeWorld({
      jobs: [
        { ...want('keep-warm'), jobId: 71 },
        { ...want('sla-escalate'), jobId: 72 },
        { jobId: 73, url: 'https://hooks.example.org/ping/abc/def?token=zzz', enabled: true },
      ],
    });
    const r = await go('check', w);
    expect(r.code).toBe(0);
    expect(r.out).toContain('https://hooks.example.org/…');
    expect(r.out).not.toContain('token=zzz');
    expect(r.out).not.toContain('/ping/abc');
  });
});

describe('run — failures say what they mean and still print no secret', () => {
  it('turns a cron-job.org error into its documented meaning, not its body', async () => {
    // The fake's error body quotes the secret, as an error echoing the request might.
    const w = fakeWorld({ apiStatus: 403 });
    const r = await go('check', w);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/HTTP 403.*IP restriction/);
  });

  it('redacts a secret carried by an exception message', async () => {
    const w = fakeWorld({ throwWith: `connect ECONNRESET while sending Bearer ${SECRET}` });
    const r = await go('apply', w);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[redacted]');
  });
});

describe('the secret\'s checklist knows about the jobs', () => {
  it('tells whoever rotates PROD_CRON_SECRET to re-run apply', () => {
    // The registry said the value lives in two places. After this, it lives in
    // three, and a rotation that misses cron-job.org is a 401 every four minutes
    // until the jobs are disabled (review, 2026-09-24).
    const entry = REQUIRED_SECRETS.find((r) => r.name === 'PROD_CRON_SECRET');
    expect(entry?.workflows).toContain('cron-scheduler.yml');
    expect(entry?.alsoSetOn).toMatch(/External cron scheduler/);
    expect(entry?.alsoSetOn).toMatch(/apply/);
  });
});

describe('argvMode', () => {
  it('accepts exactly --check or --apply', () => {
    expect(argvMode(['--check'])).toBe('check');
    expect(argvMode(['--apply'])).toBe('apply');
    for (const bad of [[], ['--check', '--apply'], ['apply'], ['--force']]) {
      expect(argvMode(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the workflow runs it, with the secrets it needs, and cannot skip', { timeout: STEP_TEST_TIMEOUT_MS }, () => {
  const RAW = readFileSync('.github/workflows/cron-scheduler.yml', 'utf8').replace(/\r\n/g, '\n');
  const yml = RAW.split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  const STEP = 'Check or apply the two jobs';
  const script = runScriptOf(RAW, STEP);

  it('is dispatch-only with a check/apply choice', () => {
    expect(yml).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(yml).not.toMatch(/^\s+schedule:/m);
    expect(yml).toMatch(/options:\n\s+- check\n\s+- apply/);
  });

  it('hands the script the PRODUCTION cron secret and the API key, from secrets', () => {
    expect(yml).toMatch(/CRON_SECRET: \$\{\{ secrets\.PROD_CRON_SECRET \}\}/);
    expect(yml).toMatch(/CRONJOB_API_KEY: \$\{\{ secrets\.CRONJOB_API_KEY \}\}/);
    expect(yml).not.toMatch(/continue-on-error/);
    expect(yml).not.toMatch(/^\s+if:/m);
  });

  it('runs the script in the chosen mode and fails when it fails', () => {
    expect(script.length).toBeGreaterThan(50);
    const stubs = [
      'npx() {',
      '  echo "npx $*" >> "$STUB_DIR/calls"',
      '  return "${NPX_RC:-0}"',
      '}',
    ].join('\n');
    const ok = runStep(script, stubs, { MODE: 'check', GITHUB_JOB: 'scheduler', GITHUB_EVENT_NAME: 'workflow_dispatch' });
    expect(ok.status, ok.output).toBe(0);
    expect(ok.calls).toEqual(['npx tsx scripts/ops/cron-scheduler.ts --check']);
    const failed = runStep(script, stubs, { MODE: 'apply', NPX_RC: '1', GITHUB_JOB: 'scheduler', GITHUB_EVENT_NAME: 'workflow_dispatch' });
    expect(failed.status, 'a failing script fails the step').not.toBe(0);
    expect(failed.calls).toEqual(['npx tsx scripts/ops/cron-scheduler.ts --apply']);
  });

  it('refuses a mode it does not know, without running anything', () => {
    const r = runStep(script, 'npx() { echo "npx $*" >> "$STUB_DIR/calls"; }', { MODE: 'delete-everything' });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });
});
