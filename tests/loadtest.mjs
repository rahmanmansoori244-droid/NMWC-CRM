/**
 * Heavy-duty load test: 10 concurrent users, all roles, every major workflow.
 * Run with: node tests/loadtest.mjs
 */

import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE ?? 'https://nmwc-cm.vercel.app';
const PWD = 'Demo!2026Demo';

// ─────────────────────────────────────────────────────────────
// Cookie jar (per user)
// ─────────────────────────────────────────────────────────────
function newJar() {
  return new Map();
}
function readCookies(res, jar) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const eq = c.indexOf('=');
    if (eq < 0) continue;
    jar.set(c.slice(0, eq), c.split(';')[0]);
  }
}
function cookieHeader(jar) {
  return [...jar.values()].join('; ');
}

async function login(username, jar) {
  const t0 = Date.now();
  const r0 = await fetch(`${BASE}/api/auth/csrf`);
  readCookies(r0, jar);
  const { csrfToken } = await r0.json();
  const r1 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
    body: new URLSearchParams({ csrfToken, username, password: PWD, callbackUrl: BASE + '/' }),
  });
  readCookies(r1, jar);
  const ms = Date.now() - t0;
  return { ok: r1.headers.get('location') === BASE + '/', loc: r1.headers.get('location'), ms };
}

async function get(jar, path) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, {
    headers: { Cookie: cookieHeader(jar) },
    redirect: 'manual',
  });
  const ms = Date.now() - t0;
  // Don't read the body unless we need to (saves bandwidth in load test).
  const ct = r.headers.get('content-type') ?? '';
  let bytes = 0;
  if (ct.includes('text/html') || ct.includes('application/json')) {
    bytes = (await r.text()).length;
  } else {
    bytes = (await r.arrayBuffer()).byteLength;
  }
  return { status: r.status, bytes, ms, loc: r.headers.get('location') };
}

// ─────────────────────────────────────────────────────────────
// Per-role workflows
// ─────────────────────────────────────────────────────────────

async function salesmanFlow(uname, jar) {
  const events = [];
  events.push(['login', await login(uname, jar)]);
  events.push(['/today', await get(jar, '/today')]);
  events.push(['/customers', await get(jar, '/customers')]);
  events.push(['/customers?q=test', await get(jar, '/customers?q=test')]);
  events.push(['/work', await get(jar, '/work')]);
  events.push(['/rejected', await get(jar, '/rejected')]);
  events.push(['/profile', await get(jar, '/profile')]);
  // pull a customer id from list and open profile + edit page
  const list = await fetch(BASE + '/customers', {
    headers: { Cookie: cookieHeader(jar) },
  });
  const html = await list.text();
  const ids = [...new Set([...html.matchAll(/customers\/([a-z0-9]{15,30})/g)].map((m) => m[1]))];
  if (ids.length) {
    events.push(['/customers/<id>', await get(jar, `/customers/${ids[0]}`)]);
    events.push(['/customers/<id>/edit', await get(jar, `/customers/${ids[0]}/edit`)]);
  }
  return events;
}

async function supervisorFlow(uname, jar) {
  const events = [];
  events.push(['login', await login(uname, jar)]);
  events.push(['/approvals', await get(jar, '/approvals')]);
  events.push(['/team', await get(jar, '/team')]);
  events.push(['/customers', await get(jar, '/customers')]);
  events.push(['/work', await get(jar, '/work')]);
  events.push(['/profile', await get(jar, '/profile')]);
  // open a pending approval
  const list = await fetch(BASE + '/approvals', { headers: { Cookie: cookieHeader(jar) } });
  const html = await list.text();
  const ids = [...new Set([...html.matchAll(/approvals\/([a-z0-9]{15,30})/g)].map((m) => m[1]))];
  if (ids.length) events.push(['/approvals/<id>', await get(jar, `/approvals/${ids[0]}`)]);
  return events;
}

async function managerFlow(uname, jar) {
  const events = [];
  events.push(['login', await login(uname, jar)]);
  events.push(['/dashboard', await get(jar, '/dashboard')]);
  events.push(['/users', await get(jar, '/users')]);
  events.push(['/routes', await get(jar, '/routes')]);
  events.push(['/customers', await get(jar, '/customers')]);
  events.push(['/audit', await get(jar, '/audit')]);
  events.push(['/reactivations', await get(jar, '/reactivations')]);
  events.push(['/work', await get(jar, '/work')]);
  events.push(['/api/exports/customers', await get(jar, '/api/exports/customers')]);
  return events;
}

async function stewardFlow(uname, jar) {
  const events = [];
  events.push(['login', await login(uname, jar)]);
  events.push(['/import', await get(jar, '/import')]);
  events.push(['/export', await get(jar, '/export')]);
  events.push(['/duplicates', await get(jar, '/duplicates')]);
  events.push(['/customers', await get(jar, '/customers')]);
  events.push(['/work', await get(jar, '/work')]);
  // download big export
  events.push(['/api/exports/customers', await get(jar, '/api/exports/customers')]);
  events.push(['/api/exports/customers?statuses=ACTIVE&minCompleteness=50', await get(jar, '/api/exports/customers?status=ACTIVE&minCompleteness=50')]);
  return events;
}

async function viewerFlow(uname, jar) {
  const events = [];
  events.push(['login', await login(uname, jar)]);
  events.push(['/dashboard', await get(jar, '/dashboard')]);
  events.push(['/customers', await get(jar, '/customers')]);
  events.push(['/customers?status=CLOSED', await get(jar, '/customers?status=CLOSED')]);
  events.push(['/api/exports/customers', await get(jar, '/api/exports/customers')]);
  return events;
}

// ─────────────────────────────────────────────────────────────
// Run 10 users in parallel
// ─────────────────────────────────────────────────────────────

const USERS = [
  { user: 'salesman.mct-01', role: 'salesman' },
  { user: 'salesman.mct-02', role: 'salesman' },
  { user: 'salesman.btn-01', role: 'salesman' },
  { user: 'salesman.dhf-01', role: 'salesman' },
  { user: 'supervisor.1', role: 'supervisor' },
  { user: 'supervisor.2', role: 'supervisor' },
  { user: 'manager.a', role: 'manager' },
  { user: 'manager.b', role: 'manager' },
  { user: 'steward', role: 'steward' },
  { user: 'viewer', role: 'viewer' },
];

const FLOWS = {
  salesman: salesmanFlow,
  supervisor: supervisorFlow,
  manager: managerFlow,
  steward: stewardFlow,
  viewer: viewerFlow,
};

async function run() {
  console.log(`# Heavy-load test against ${BASE}`);
  console.log(`# Starting ${USERS.length} concurrent users at ${new Date().toISOString()}\n`);
  const start = Date.now();

  // Stagger by 200ms to spread the login burst
  const promises = USERS.map(async (u, i) => {
    await sleep(i * 200);
    const jar = newJar();
    try {
      const events = await FLOWS[u.role](u.user, jar);
      return { user: u.user, role: u.role, events, error: null };
    } catch (err) {
      return { user: u.user, role: u.role, events: [], error: err.message ?? String(err) };
    }
  });
  const results = await Promise.all(promises);
  const totalMs = Date.now() - start;

  // Print compact results
  let totalCalls = 0;
  let errorCount = 0;
  let timeoutCount = 0;
  let slowestCall = { user: '', path: '', ms: 0 };
  const allTimings = [];

  for (const r of results) {
    if (r.error) {
      errorCount++;
      console.log(`✗ ${r.user.padEnd(20)} (${r.role.padEnd(10)}) — TOP-LEVEL ERROR: ${r.error}`);
      continue;
    }
    console.log(`✓ ${r.user.padEnd(20)} (${r.role.padEnd(10)}) — ${r.events.length} calls`);
    for (const [path, ev] of r.events) {
      totalCalls++;
      const ms = ev.ms ?? 0;
      allTimings.push(ms);
      if (ms > slowestCall.ms) slowestCall = { user: r.user, path, ms };
      const status = ev.status ?? (ev.ok ? '302' : 'X');
      const flag = ms > 3000 ? ' ⚠SLOW' : '';
      const errFlag = (typeof status === 'number' && status >= 500) ? ' ❌5XX' : '';
      const bytes = ev.bytes != null ? ` ${ev.bytes}b` : '';
      console.log(`    ${String(status).padEnd(4)} ${ms}ms${bytes.padStart(8)}  ${path}${flag}${errFlag}`);
      if (typeof status === 'number' && status >= 500) errorCount++;
      if (ms > 9000) timeoutCount++;
    }
  }

  // Stats
  allTimings.sort((a, b) => a - b);
  const p50 = allTimings[Math.floor(allTimings.length * 0.5)];
  const p95 = allTimings[Math.floor(allTimings.length * 0.95)];
  const p99 = allTimings[Math.floor(allTimings.length * 0.99)];
  const max = allTimings[allTimings.length - 1] ?? 0;

  console.log('\n# Summary');
  console.log(`# Total wall time:   ${totalMs}ms`);
  console.log(`# Total HTTP calls:  ${totalCalls}`);
  console.log(`# Errors (5xx/exc):  ${errorCount}`);
  console.log(`# Timeouts (>9s):    ${timeoutCount}`);
  console.log(`# Latency p50/p95/p99/max:  ${p50}ms / ${p95}ms / ${p99}ms / ${max}ms`);
  console.log(`# Slowest:           ${slowestCall.path} (${slowestCall.user}) ${slowestCall.ms}ms`);
}

run().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
