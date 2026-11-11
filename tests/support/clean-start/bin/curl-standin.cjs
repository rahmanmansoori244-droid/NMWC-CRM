/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS, run by node directly from the bash wrapper beside it */
// Local stand-in for curl, for the clean-start tests only. It answers the three
// kinds of HTTP the clean-start scripts make, from local state, and records
// every call (method + path, never a header value) in FAKE_HTTP_LOG:
//
//   <APP_BASE_URL>/api/health                 {commit: FAKE_COMMIT} behind FAKE_HEALTH_BEARER
//   <APP_BASE_URL>/api/cron/integrity-watch   runs FAKE_WATCH_CMD (the real watch, as the app would)
//                                             behind FAKE_CRON_SECRET
//   api.github.com/repos/<repo>/…             from FAKE_STATE_DIR/github.json
//   console.neon.tech/api/v2/projects/<id>…   a Neon project simulated with DATABASES on the
//                                             local test cluster (FAKE_PG_ADMIN_URL, FAKE_PSQL):
//                                             a branch with a compute is CREATE DATABASE … TEMPLATE
//                                             <FAKE_NEON_SOURCE_DB>, with a snapshot taken at
//                                             creation that a restore to a time after creation
//                                             returns to (the only history this stand-in keeps).
// Supports: -s -o FILE -w '%{http_code}' --max-time N -X M -H H -d BODY URL.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
let out = null;
let write = '';
let method = 'GET';
let body = '';
let url = '';
const headers = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-s' || a === '-sS') continue;
  else if (a === '-o') out = argv[++i];
  else if (a === '-w') write = argv[++i];
  else if (a === '--max-time') i++;
  else if (a === '-X') method = argv[++i];
  else if (a === '-H') { const h = argv[++i]; const c = h.indexOf(':'); headers[h.slice(0, c).toLowerCase()] = h.slice(c + 1).trim(); }
  else if (a === '-d') { body = argv[++i]; if (method === 'GET') method = 'POST'; }
  else if (/^https?:\/\//.test(a)) url = a;
  else { process.stderr.write(`curl stand-in: unsupported argument ${a}\n`); process.exit(2); }
}
const STATE = process.env.FAKE_STATE_DIR;
const u = new URL(url);
const logCall = (extra = {}) => {
  if (process.env.FAKE_HTTP_LOG)
    fs.appendFileSync(process.env.FAKE_HTTP_LOG, JSON.stringify({ method, host: u.host, path: u.pathname, query: u.search, ...extra }) + '\n');
};
const reply = (code, json) => {
  if (out) fs.writeFileSync(out, json === undefined ? '' : JSON.stringify(json));
  else if (json !== undefined) process.stdout.write(JSON.stringify(json));
  if (write === '%{http_code}') process.stdout.write(String(code));
  logCall({ code });
  process.exit(0);
};
const bearer = () => (headers.authorization || '').replace(/^Bearer /, '');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// ── the app ──
const app = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL) : null;
if (app && u.host === app.host) {
  if (u.pathname === '/api/health') {
    if (bearer() !== process.env.FAKE_HEALTH_BEARER) reply(401, { error: 'UNAUTHORIZED' });
    reply(200, { status: 'ok', commit: process.env.FAKE_COMMIT || 'unknown' });
  }
  if (u.pathname === '/api/cron/integrity-watch') {
    if (bearer() !== process.env.FAKE_CRON_SECRET) reply(401, { error: 'UNAUTHORIZED' });
    const r = spawnSync('bash', ['-c', process.env.FAKE_WATCH_CMD || 'exit 1'], { encoding: 'utf8', env: process.env });
    if (process.env.FAKE_WATCH_LOG) fs.appendFileSync(process.env.FAKE_WATCH_LOG, `${r.stdout || ''}${r.stderr || ''}\n`);
    reply(r.status === 0 ? 200 : 500, { checks: 0 });
  }
  reply(404, { error: 'not found' });
}

// ── GitHub ──
if (u.host === 'api.github.com') {
  if (!bearer()) reply(401, { message: 'Requires authentication' });
  const gh = readJson(path.join(STATE, 'github.json'), {});
  const m = /^\/repos\/[^/]+\/[^/]+\/(.*)$/.exec(u.pathname);
  const p = m ? m[1] : '';
  if (p === 'environments/production-reset') {
    if (!gh.environment) reply(404, { message: 'Not Found' });
    reply(200, gh.environment);
  }
  if (p === 'actions/workflows/db-backup.yml/runs') reply(200, { total_count: (gh.backupRuns || {})[u.searchParams.get('status')] || 0, workflow_runs: [] });
  if (p === 'actions/workflows/clean-start.yml/runs') reply(200, { total_count: (gh.cleanStartRuns || []).length, workflow_runs: gh.cleanStartRuns || [] });
  let mm = /^actions\/runs\/(\d+)\/jobs$/.exec(p);
  if (mm) reply(200, { jobs: (gh.jobs || {})[mm[1]] || [] });
  if (p === 'contents/scripts/ops') {
    const tree = (gh.trees || {})[u.searchParams.get('ref')];
    if (!tree) reply(404, { message: 'No commit found' });
    reply(200, [{ name: 'clean-start', type: 'dir', sha: tree }]);
  }
  if (p === 'contents/.github/workflows') {
    const blob = (gh.workflowBlobs || {})[u.searchParams.get('ref')];
    if (!blob) reply(404, { message: 'No commit found' });
    reply(200, [{ name: 'clean-start.yml', type: 'file', sha: blob }]);
  }
  reply(404, { message: 'Not Found' });
}

// ── Neon ──
if (u.host === 'console.neon.tech') {
  if (bearer() !== process.env.FAKE_NEON_API_KEY) reply(401, { code: '', message: 'authorization failed' });
  const m = /^\/api\/v2\/projects\/([^/]+)(.*)$/.exec(u.pathname);
  if (!m || m[1] !== process.env.FAKE_NEON_PROJECT_ID) reply(404, { code: '', message: 'project not found' });
  const sub = m[2];
  const file = path.join(STATE, 'neon.json');
  const st = readJson(file, { seq: 0, branches: [], retention: 604800 });
  const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 2));
  const sql = (q) => {
    if (!process.env.FAKE_PG_ADMIN_URL) return; // state only: no database behind the branches
    const r = spawnSync(process.env.FAKE_PSQL, [process.env.FAKE_PG_ADMIN_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' });
    if (r.status !== 0) { process.stderr.write(`curl stand-in (neon): ${r.stderr}\n`); reply(500, { code: '', message: 'internal' }); }
  };
  const ops = (branchId) => [{ id: `op-${++st.seq}`, branch_id: branchId, action: 'x', status: 'finished' }];
  const view = (b) => ({ id: b.id, name: b.name, default: !!b.default, primary: !!b.default, parent_id: b.parent || null });
  if (sub === '' && method === 'GET') reply(200, { project: { id: m[1], history_retention_seconds: st.retention } });
  if (sub === '/operations' && method === 'GET') reply(200, { operations: (st.pending || []).concat([{ id: 'op-0', status: 'finished' }]) });
  if (sub === '/branches' && method === 'GET') {
    const s = u.searchParams.get('search') || '';
    reply(200, { branches: st.branches.filter((b) => b.name.includes(s) || b.id.includes(s)).map(view) });
  }
  if (sub === '/branches' && method === 'POST') {
    const req = JSON.parse(body || '{}');
    const id = `br-fake-${++st.seq}`;
    const name = (req.branch && req.branch.name) || id;
    const parent = (req.branch && req.branch.parent_id) || st.branches.find((b) => b.default).id;
    const compute = Array.isArray(req.endpoints) && req.endpoints.length > 0;
    const b = { id, name, parent, db: null, snapshot: null, createdAt: new Date().toISOString() };
    if (compute) {
      b.db = `cs_neon_${st.seq}`;
      b.snapshot = `cs_neon_${st.seq}_t0`;
      sql(`CREATE DATABASE ${b.db} TEMPLATE ${process.env.FAKE_NEON_SOURCE_DB}`);
      sql(`CREATE DATABASE ${b.snapshot} TEMPLATE ${b.db}`);
    }
    st.branches.push(b);
    save();
    // FAKE_NEON_CREATE_TIMEOUT=1: Neon made the branch, but the answer never arrives (curl exit 28).
    if (process.env.FAKE_NEON_CREATE_TIMEOUT === '1') {
      logCall({ code: 0 });
      process.stderr.write('curl: (28) Operation timed out\n');
      process.exit(28);
    }
    reply(201, {
      branch: view(b),
      endpoints: compute ? [{ id: `ep-fake-${st.seq}`, host: 'localhost', type: 'read_write' }] : [],
      databases: [{ name: process.env.FAKE_NEON_DB_NAME || 'neondb', owner_name: process.env.FAKE_NEON_ROLE || 'postgres' }],
      roles: [{ name: process.env.FAKE_NEON_ROLE || 'postgres' }],
      operations: ops(id),
    });
  }
  if (sub === '/connection_uri' && method === 'GET') {
    const b = st.branches.find((x) => x.id === u.searchParams.get('branch_id'));
    if (!b || !u.searchParams.get('database_name') || !u.searchParams.get('role_name')) reply(400, { code: '', message: 'bad request' });
    if (b.default) reply(200, { uri: process.env.FAKE_NEON_DEFAULT_URI });
    if (!b.db) reply(400, { code: '', message: 'no compute' });
    reply(200, { uri: `${process.env.FAKE_NEON_URI_BASE}/${b.db}` });
  }
  let mm = /^\/branches\/([^/]+)\/restore$/.exec(sub);
  if (mm && method === 'POST') {
    const req = JSON.parse(body || '{}');
    const b = st.branches.find((x) => x.id === mm[1]);
    if (!b || !b.snapshot) reply(400, { code: '', message: 'cannot restore' });
    if (req.source_branch_id === b.id && !req.preserve_under_name) reply(400, { code: '', message: 'preserve_under_name is required' });
    if (!req.source_timestamp || new Date(req.source_timestamp) < new Date(b.createdAt)) reply(400, { code: '', message: 'timestamp outside history' });
    const keep = { id: `br-fake-${++st.seq}`, name: req.preserve_under_name, parent: b.parent, db: `cs_neon_${st.seq}`, snapshot: null };
    sql(`ALTER DATABASE ${b.db} RENAME TO ${keep.db}`);
    sql(`CREATE DATABASE ${b.db} TEMPLATE ${b.snapshot}`);
    st.branches.push(keep);
    save();
    reply(200, { branch: view(b), operations: ops(b.id) });
  }
  mm = /^\/branches\/([^/]+)$/.exec(sub);
  if (mm && method === 'DELETE') {
    const b = st.branches.find((x) => x.id === mm[1]);
    if (!b) reply(404, { code: '', message: 'not found' });
    if (b.default) reply(400, { code: '', message: 'cannot delete the default branch' });
    for (const d of [b.db, b.snapshot]) if (d) sql(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    st.branches = st.branches.filter((x) => x.id !== b.id);
    save();
    reply(200, { branch: view(b), operations: ops(b.id) });
  }
  reply(404, { code: '', message: `not simulated: ${method} ${sub}` });
}

process.stderr.write(`curl stand-in: no such host in the test: ${u.host}\n`);
if (write === '%{http_code}') process.stdout.write('000');
process.exit(7);
