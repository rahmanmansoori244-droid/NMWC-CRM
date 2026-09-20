/**
 * Is the deployment actually working? One command, no credentials, no database.
 *
 *   npm run smoke                      # production
 *   npm run smoke -- <url>             # a preview, or UAT
 *   HEALTH_BEARER=… npm run smoke      # adds the monitor-only checks
 *
 * Every assertion here is one that has ALREADY been wrong on this system at least
 * once. It is not a generic uptime probe — it is the set of things that broke,
 * turned into something runnable in fifteen seconds:
 *
 *   - B1: production served a four-month-old build for weeks, and the only way
 *     anyone noticed was a 404 on a route that should have existed.
 *   - SEC-14b: the content-security-policy was changed twice; if the nonce is not
 *     where Next expects it, the page renders blank and nothing else reports it.
 *   - SEC-14d/DO-16: a wrong monitor bearer used to return a green 200, so the
 *     dead-man alarm could be switched off by a typo.
 *   - The cron routes are the SLA engine and the backup report; when their bearer
 *     check regressed nothing user-facing changed.
 *
 * Exit code is 0 only when every check passes, so it can gate a deploy or a load.
 *
 * READ-ONLY. It performs GETs and one unauthenticated POST that is expected to be
 * refused. It never signs in, never writes, and never touches the database.
 */

type Check = {
  name: string;
  why: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
};

const args = process.argv.slice(2);
const expectIdx = args.indexOf('--expect-commit');
/**
 * Whether the flag was GIVEN, kept separately from whether it carried a value.
 *
 * Collapsing the two is what made `--expect-commit` with an unset shell variable
 * indistinguishable from not passing it at all — the assertion silently did not
 * run and the suite reported a pass.
 */
const EXPECT_GIVEN = expectIdx >= 0;
/** Short sha production must be running. */
const EXPECT_COMMIT = EXPECT_GIVEN ? (args[expectIdx + 1] ?? '') : '';
const BASE = (args.find((a) => a.startsWith('http')) ?? 'https://nmwc-cm.vercel.app').replace(
  /\/$/,
  ''
);
const MONITOR = process.env.HEALTH_BEARER ?? '';

async function get(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { 'user-agent': 'nmwc-smoke/1', ...(init?.headers ?? {}) },
  });
  return res;
}

/** The directives SEC-14b added, plus the ones that were always there. */
const REQUIRED_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

const checks: Check[] = [
  {
    name: 'health (anonymous)',
    why: 'the liveness probe must answer, and must say nothing else',
    run: async () => {
      const res = await get('/api/health');
      const body = (await res.json()) as Record<string, unknown>;
      const keys = Object.keys(body);
      const ok = res.status === 200 && keys.length === 1 && body.status === 'ok';
      return { ok, detail: `${res.status} ${JSON.stringify(body)} keys=${keys.length}` };
    },
  },
  {
    name: 'health rejects a wrong bearer',
    why: 'a mistyped HEALTH_BEARER used to get the green anonymous answer, which silently switches the dead man off',
    run: async () => {
      const res = await get('/api/health', {
        headers: { authorization: 'Bearer smoke-test-definitely-not-the-monitor-token' },
      });
      return { ok: res.status === 401, detail: `${res.status} (want 401)` };
    },
  },
  {
    name: 'login page renders',
    why: 'a broken CSP renders this blank, and nothing else reports it',
    run: async () => {
      const res = await get('/login');
      const html = await res.text();
      const ok = res.status === 200 && html.includes('Customer Master') && html.length > 2000;
      return { ok, detail: `${res.status}, ${html.length} bytes` };
    },
  },
  {
    name: 'exactly one CSP header',
    why: 'middleware sets one and next.config supplies a fallback; two get intersected and the stricter one wins unpredictably',
    run: async () => {
      const res = await get('/login');
      // getSetCookie-style duplicate detection: fetch joins duplicates with ", ".
      const raw = res.headers.get('content-security-policy') ?? '';
      const count = raw ? raw.split(/,\s*(?=[a-z-]+ )/).length : 0;
      return { ok: count === 1, detail: `${count} policy/policies` };
    },
  },
  {
    name: 'CSP carries every required directive',
    why: 'form-action and base-uri do not fall back to default-src; without them any page can post a form anywhere',
    run: async () => {
      const res = await get('/login');
      const csp = res.headers.get('content-security-policy') ?? '';
      const missing = REQUIRED_CSP.filter((d) => !csp.includes(d));
      return { ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : 'all present' };
    },
  },
  {
    name: 'CSP script-src carries a nonce and strict-dynamic',
    why: 'if Next cannot find the nonce it stops stamping its bootstrap and production renders blank',
    run: async () => {
      const res = await get('/login');
      const csp = res.headers.get('content-security-policy') ?? '';
      const m = /script-src 'self' 'nonce-([^']+)' 'strict-dynamic'/.exec(csp);
      const noUnsafe = !csp.includes("'unsafe-inline'") || !/script-src[^;]*'unsafe-inline'/.test(csp);
      return { ok: !!m && noUnsafe, detail: m ? 'nonce present, no unsafe-inline in script-src' : 'NO NONCE' };
    },
  },
  {
    name: 'the page is actually stamped with that nonce',
    why: 'the header can be right while the framework fails to use it — this is what a blank production looks like from outside',
    run: async () => {
      const res = await get('/login');
      const csp = res.headers.get('content-security-policy') ?? '';
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? '';
      const html = await res.text();
      const stamped = nonce ? html.split(`nonce="${nonce}"`).length - 1 : 0;
      return { ok: stamped > 0, detail: `${stamped} nonce'd script tag(s)` };
    },
  },
  {
    name: 'security headers',
    why: 'nosniff is what makes the photo content-type pin safe (SEC-14e)',
    run: async () => {
      const res = await get('/login');
      const want: Record<string, string> = {
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'strict-origin-when-cross-origin',
      };
      const bad = Object.entries(want).filter(([h, v]) => res.headers.get(h) !== v);
      const hsts = (res.headers.get('strict-transport-security') ?? '').includes('max-age=');
      return {
        ok: bad.length === 0 && hsts,
        detail: bad.length ? `wrong: ${bad.map(([h]) => h).join(', ')}` : 'all present',
      };
    },
  },
  {
    name: 'root redirects to /login',
    why: 'the middleware auth gate is documented as inert; this is the redirect that actually protects the app',
    run: async () => {
      const res = await get('/');
      const loc = res.headers.get('location') ?? '';
      const ok = res.status >= 300 && res.status < 400 && loc.includes('/login');
      return { ok, detail: `${res.status} → ${loc || '(no location)'}` };
    },
  },
  {
    name: 'a protected page redirects when signed out',
    why: 'if this ever returns 200 the customer master is public',
    run: async () => {
      const res = await get('/customers');
      const ok = res.status >= 300 && res.status < 400;
      return { ok, detail: `${res.status} (want a redirect)` };
    },
  },
  {
    name: 'cron routes refuse an unauthenticated call',
    why: 'these run the SLA engine and the photo GC; a regressed bearer check is invisible in the UI',
    run: async () => {
      const routes = ['sla-escalate', 'keep-warm', 'photo-gc', 'retention-sweep'];
      const got = await Promise.all(
        routes.map(async (r) => `${r}=${(await get(`/api/cron/${r}`)).status}`)
      );
      const ok = got.every((g) => g.endsWith('=401'));
      return { ok, detail: got.join(' ') };
    },
  },
  {
    name: 'ops and data routes refuse an unauthenticated call',
    why: 'backup-report feeds the dead man; the other two serve customer data and photographs',
    run: async () => {
      const bGet = (await get('/api/ops/backup-report')).status;
      const bPost = (await get('/api/ops/backup-report', { method: 'POST' })).status;
      const photo = (await get('/api/photos/smoke-test-no-such-id')).status;
      const exp = (await get('/api/exports/changes')).status;
      const ok = bGet === 405 && bPost === 401 && photo === 401 && exp === 401;
      return { ok, detail: `backup GET=${bGet} POST=${bPost} photo=${photo} export=${exp}` };
    },
  },
  {
    name: 'served from the intended region',
    why: 'production once served from fra1 while the database sat in us-east — every query paid a transatlantic round trip',
    run: async () => {
      const res = await get('/login');
      const id = res.headers.get('x-vercel-id') ?? '';
      const ok = id.includes('iad1');
      return { ok, detail: id || '(no x-vercel-id — not a Vercel deployment?)' };
    },
  },
  {
    name: 'auth provider points at THIS host',
    why: 'an AUTH_URL set for production leaks into previews, so a preview signs you in against the wrong database',
    run: async () => {
      const res = await get('/api/auth/providers');
      const body = await res.text();
      const host = new URL(BASE).host;
      const ok = res.status === 200 && body.includes(host);
      return { ok, detail: ok ? `signin host = ${host}` : `does NOT name ${host}` };
    },
  },
];

// --expect-commit needs the monitor bearer: the commit is only in the detailed
// health payload. Refusing here rather than skipping, because the caller asked a
// question and a skipped check answers it with "all checks passed" — which is how
// production served a four-month-old build while every smoke run was green.
// A flag with no value is a slip, not a request to skip the check. `$SHA` unset
// leaves `--expect-commit` as the last argument; the BASE parser also reads argv,
// so a URL can land here too. Both are caught by requiring a sha shape.
if (EXPECT_GIVEN && !/^[0-9a-f]{7,40}$/i.test(EXPECT_COMMIT)) {
  console.error(
    '\n  --expect-commit needs a commit sha, and got ' +
      (EXPECT_COMMIT ? `"${EXPECT_COMMIT}"` : 'nothing') +
      '.\n' +
      '  Refusing to run: an assertion that silently does not run reports as a pass,\n' +
      '  which is the whole reason this check exists.\n'
  );
  process.exit(2);
}

if (EXPECT_GIVEN && !MONITOR) {
  console.error(
    '\n  asked to assert a commit with --expect-commit, but HEALTH_BEARER is not set.\n' +
      '  The commit is only readable from /api/health with the monitor bearer, so the\n' +
      '  assertion CANNOT run. Refusing to report a pass it did not earn.\n\n' +
      '  Set HEALTH_BEARER, or drop --expect-commit and accept that this run does not\n' +
      '  tell you which build production is serving.\n'
  );
  process.exit(2);
}

if (MONITOR) {
  checks.push({
    name: 'production is running the commit you think it is',
    why: 'production served a four-month-old build for weeks; the only reason anyone noticed was a 404 on a route that should have existed',
    run: async () => {
      const res = await get('/api/health', { headers: { authorization: `Bearer ${MONITOR}` } });
      const body = (await res.json()) as { commit?: string; deployedEnv?: string };
      const commit = body.commit ?? 'unknown';
      if (!EXPECT_COMMIT) {
        return {
          ok: commit !== 'unknown',
          detail: `${commit} (${body.deployedEnv}) — pass --expect-commit <sha> to assert it`,
        };
      }
      const want = EXPECT_COMMIT.slice(0, 7);
      return { ok: commit === want, detail: `running ${commit}, expected ${want}` };
    },
  });
  checks.push({
    name: 'monitor bearer unlocks the detail, and no cron job is alarming',
    why: 'this is the endpoint an uptime monitor watches; 503 here means a scheduled job is dead',
    run: async () => {
      const res = await get('/api/health', { headers: { authorization: `Bearer ${MONITOR}` } });
      const body = (await res.json()) as {
        checks?: Record<string, string>;
        cron?: { alarms?: string[] };
      };
      const alarms = body.cron?.alarms ?? [];
      const bad = Object.entries(body.checks ?? {}).filter(([, v]) => v === 'fail');
      return {
        ok: res.status === 200 && alarms.length === 0 && bad.length === 0,
        detail: `${res.status} alarms=[${alarms.join(',')}] failed=[${bad.map(([k]) => k).join(',')}]`,
      };
    },
  });
}

async function main() {
  console.log(`\nSmoke test — ${BASE}`);
  console.log(`${MONITOR ? 'with' : 'without'} the monitor bearer` + (MONITOR ? '' : '  (set HEALTH_BEARER for the cron checks)'));
  console.log('='.repeat(72));

  let failed = 0;
  for (const c of checks) {
    let line: { ok: boolean; detail: string };
    try {
      line = await c.run();
    } catch (err) {
      line = { ok: false, detail: `threw: ${(err as Error).message}` };
    }
    if (!line.ok) failed += 1;
    console.log(`${line.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(46)} ${line.detail}`);
    if (!line.ok) console.log(`      why it matters: ${c.why}`);
  }

  console.log('='.repeat(72));
  if (failed === 0) {
    console.log(`all ${checks.length} checks passed\n`);
    return 0;
  }
  console.log(`${failed} of ${checks.length} FAILED\n`);
  return 1;
}

main().then((code) => process.exit(code));
