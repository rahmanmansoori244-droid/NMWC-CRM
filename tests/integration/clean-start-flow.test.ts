// @vitest-environment node
/**
 * Go-live clean start, THE RUN FLOW end to end: the real
 * .github/workflows/clean-start.yml and clean-start-photos.yml, run job by job
 * and step by step (tests/support/clean-start/emulator.ts) against a seeded
 * "production" database on a throw-away local cluster, with local stand-ins for
 * everything outside it (tests/support/clean-start/bin): R2 is a folder per
 * bucket (aws), GitHub's API, Neon's API and the app's endpoints answer from
 * local state (curl — Neon branches are databases on the same cluster, and the
 * app's integrity-watch is the REAL watch on the "production" database), age
 * and jq are stand-ins. psql and pg_dump are the real clients.
 *
 *   dry-run         plan → exports → rehearse on a restored dump → reset on the copy
 *                   → verify → the watch twice; production unchanged
 *   neon-rehearsal  a "branch", reset there, restored to the noted time, the
 *                   fingerprint back, every temporary branch deleted
 *   apply           all of it on "production", with the owner's typed host and phrase
 *   seal-restore    after "production" was put back: old seals back, new chain aside
 *   finish          after a lost connection at COMMIT, both outcomes
 *   photos          the refusal before 7 days, then the deletion (UAT-shared and
 *                   odd keys kept, the safety branch deleted first, one audit row)
 *
 * and holds every line every step printed to the public log rule
 * (tests/support/clean-start/public-log.ts).
 *
 * PRODUCTION HERE is the test's own: the scripts run in a COPY of the
 * repository whose config/production-hosts.txt names the loopback address
 * 127.0.0.1, so the shared guard sees "production" exactly where the test put
 * it (the guard has no switch; this is how tests/unit/production-hosts.test.ts
 * tests it too). Copies and branches use "localhost". The real list, the real
 * scripts and every real service are untouched.
 *
 *   RUN_CLEAN_START_FLOW=1 CS_FLOW_ADMIN_URL=postgresql://postgres@localhost:<port>/postgres \
 *     CS_FLOW_PG_BIN=<folder with psql and pg_dump> npx vitest run tests/integration/clean-start-flow.test.ts
 *
 * It creates and drops databases, so it runs only against a cluster on this machine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Prisma, PrismaClient } from '@prisma/client';
import { assertNotProduction } from '../../scripts/lib/assert-not-production';
import { contextClient, setChangeContext, src } from '@/lib/change-context';
import { HEARTBEAT_EXPECTATIONS } from '@/lib/heartbeat';
import { formatCustomerCode } from '@/lib/codes';
import { omanDateISO, omanYear } from '@/lib/tz';
import { runIntegrityWatch } from '@/lib/integrity/run';
import { runWorkflow, describeJob, type RunResult } from '../support/clean-start/emulator';
import { baseEnv, standinPath, BIN, type Env } from '../support/clean-start/sandbox';
import { publicLogViolations } from '../support/clean-start/public-log';
import { folderStore } from '../support/clean-start/fake-app-watch';

vi.setConfig({ testTimeout: 1_800_000, hookTimeout: 1_200_000 });

const ENABLED = process.env.RUN_CLEAN_START_FLOW === '1' && !!process.env.CS_FLOW_ADMIN_URL && !!process.env.CS_FLOW_PG_BIN;
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const DAY_MS = 86_400_000;

describe.skipIf(!ENABLED)('go-live clean start: the run flow, end to end', () => {
  const admin = new URL(process.env.CS_FLOW_ADMIN_URL ?? 'postgresql://x@localhost:1/postgres');
  const port = admin.port;
  const PG_BIN = process.env.CS_FLOW_PG_BIN ?? '';
  const psqlExe = existsSync(join(PG_BIN, 'psql.exe')) ? join(PG_BIN, 'psql.exe') : join(PG_BIN, 'psql');
  const url = (host: string, db: string) => `postgresql://${admin.username}@${host}:${port}/${db}`;
  const PROD = 'cs_flow_prod';
  const PRISTINE = 'cs_flow_pristine';
  const RESTORE = 'cs_restore'; // the name the workflow's rehearse job creates
  const UAT = 'cs_flow_uat';
  const PROD_URL = url('127.0.0.1', PROD); // "production" for the copy's host list
  const PROD_LOCAL = url('localhost', PROD); // the same database, as the test (and the app stand-in) reach it

  let tree = '';
  let work = '';
  let s3 = '';
  let state = '';
  let db: PrismaClient;
  const now = new Date();
  const year = omanYear(now);
  const D = omanDateISO(now);
  const dayUtc = (day: string, h: number, m = 0) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h, m));
  const addDays = (day: string, n: number) => omanDateISO(new Date(dayUtc(day, 12).getTime() + n * DAY_MS));
  const Dm1 = addDays(D, -1);
  const Dm2 = addDays(D, -2);
  const Dm3 = addDays(D, -3);
  const sfx = `csf${Date.now().toString(36)}`;
  const actorName = `${sfx}.owner`;
  const photoKeys: string[] = [];
  const customerNames: string[] = [];
  let oldSealKeys: string[] = [];
  const FOREIGN = `seals/v1/${'9'.repeat(16)}/00000000.json`;
  const SHA = randomBytes(20).toString('hex');
  const ALL_LINES: string[] = [];
  let identity = '';
  let recipient = '';
  let runSeq = 7_000_000 + Math.floor(Math.random() * 1_000_000);
  const SECRETS = {
    hb: `hb-${randomUUID()}`,
    cron: `cron-${randomUUID()}`,
    neon: `neon-${randomUUID()}`,
    bk: `bk-${randomUUID()}`,
    ro: `ro-${randomUUID()}`,
    rw: `rw-${randomUUID()}`,
  };

  const sql = (target: string, q: string) => {
    const r = spawnSync(psqlExe, [target, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`sql failed: ${r.stderr}`);
    return (r.stdout ?? '').replace(/\r/g, '').trim();
  };
  const adminUrl = admin.toString();
  const dropDb = (name: string) => sql(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  const resetProd = () => {
    dropDb(PROD);
    sql(adminUrl, `CREATE DATABASE ${PROD} TEMPLATE ${PRISTINE}`);
  };
  const s3Pristine = () => join(work, 's3-pristine');
  const resetS3 = () => {
    rmSync(s3, { recursive: true, force: true });
    cpSync(s3Pristine(), s3, { recursive: true });
  };
  const neonFresh = () =>
    writeFileSync(join(state, 'neon.json'), JSON.stringify({ seq: 0, retention: 604800, branches: [{ id: 'br-main-0', name: 'main', default: true }] }));
  const neon = () => JSON.parse(readFileSync(join(state, 'neon.json'), 'utf8')) as { branches: Array<{ id: string; name: string; db: string | null }> };
  const has = (bucket: string, key: string) => existsSync(join(s3, bucket, ...key.split('/')));
  const listBucket = (bucket: string, prefix = ''): string[] => {
    const walk = (d: string, base = ''): string[] =>
      existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), `${base}${e.name}/`) : [`${base}${e.name}`])) : [];
    return walk(join(s3, bucket)).filter((k) => k.startsWith(prefix)).sort();
  };

  const env = (): Env => ({
    ...baseEnv(),
    PATH: standinPath(),
    TZ: 'UTC',
    NODE_ENV: 'test',
    FAKE_PG_BIN: PG_BIN,
    FAKE_S3_ROOT: s3,
    FAKE_S3_LOG: join(work, 's3.log'),
    FAKE_S3_READONLY_KEYS: SECRETS.ro,
    FAKE_HTTP_LOG: join(work, 'http.log'),
    FAKE_STATE_DIR: state,
    FAKE_COMMIT: SHA.slice(0, 7),
    FAKE_HEALTH_BEARER: SECRETS.hb,
    FAKE_CRON_SECRET: SECRETS.cron,
    FAKE_WATCH_CMD: `cd "${tree.replace(/\\/g, '/')}" && node --import tsx tests/support/clean-start/fake-app-watch.ts`,
    FAKE_WATCH_LOG: join(work, 'watch.log'),
    FAKE_APP_DB_URL: PROD_LOCAL,
    FAKE_PHOTOS_BUCKET: 'nmwc-photos',
    FAKE_NEON_API_KEY: SECRETS.neon,
    FAKE_NEON_PROJECT_ID: 'proj-flow',
    FAKE_NEON_SOURCE_DB: PROD,
    FAKE_NEON_URI_BASE: `postgresql://${admin.username}@localhost:${port}`,
    FAKE_NEON_DEFAULT_URI: PROD_URL,
    FAKE_PG_ADMIN_URL: adminUrl,
    FAKE_PSQL: psqlExe,
    FAKE_NEON_ROLE: admin.username,
    FAKE_UTC_HHMM: '1700',
    FAKE_PSQL_FAULT_FILE: join(work, 'fault'),
    PGPASSWORD: '',
    AUTH_SECRET: randomBytes(24).toString('base64'),
  });
  const secrets = (): Record<string, string> => ({
    DIRECT_URL: PROD_URL,
    CLEANSTART_ACTOR_USERNAME: actorName,
    HEALTH_BEARER: SECRETS.hb,
    PROD_CRON_SECRET: SECRETS.cron,
    BACKUP_R2_ACCOUNT_ID: 'acct-flow',
    BACKUP_R2_BUCKET: 'nmwc-backups',
    BACKUP_R2_ACCESS_KEY_ID: 'bk-flow',
    BACKUP_R2_SECRET_ACCESS_KEY: SECRETS.bk,
    BACKUP_AGE_IDENTITY: identity,
    CLEANSTART_R2_RO_ACCESS_KEY_ID: SECRETS.ro,
    CLEANSTART_R2_RO_SECRET_ACCESS_KEY: SECRETS.ro,
    CLEANSTART_R2_RW_ACCESS_KEY_ID: 'rw-flow',
    CLEANSTART_R2_RW_SECRET_ACCESS_KEY: SECRETS.rw,
    NEON_API_KEY: SECRETS.neon,
    NEON_PROJECT_ID: 'proj-flow',
    UAT_DATABASE_URL_RO: url('localhost', UAT),
  });
  const SKIPPED = /^(Install |i\. Smoke$)/;
  const run = (file: 'clean-start.yml' | 'clean-start-photos.yml', inputs: Record<string, string>): RunResult & { runId: string } => {
    const runId = String(++runSeq);
    dropDb(RESTORE);
    const r = runWorkflow({
      file: join(tree, '.github', 'workflows', file),
      cwd: tree,
      inputs,
      secrets: secrets(),
      vars: { BACKUP_AGE_RECIPIENTS: recipient, APP_BASE_URL: 'https://app.cs-flow.invalid' },
      github: { run_id: runId, sha: SHA, ref: 'refs/heads/main', repository: 'owner/nmwc', default_branch: 'main', token: 'ght-flow' },
      baseEnv: env(),
      jobEnvOverride: { rehearse: { CS_PG_ADMIN_URL: adminUrl, REHEARSE_URL: url('localhost', RESTORE), PGPASSWORD: '' } },
      // CS_FLOW_KEEP_WORK=1 (debugging only) keeps each job's work folder: its plaintext is this test's fake data.
      skip: (_job, s) => SKIPPED.test(s.name ?? '') || (process.env.CS_FLOW_KEEP_WORK === '1' && s.name === 'Remove the plaintext'),
    });
    ALL_LINES.push(...r.lines);
    return { ...r, runId };
  };
  const results = (r: RunResult) => Object.fromEntries(Object.entries(r.jobs).map(([k, v]) => [k, v.result]));
  const phrase = () => `REMOVE ALL TEST DATA ${omanDateISO(new Date())}`;
  const auditIds = async () => (await db.auditLog.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((a) => a.id);

  // ── the world ─────────────────────────────────────────────────────────

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1'].includes(admin.hostname)) throw new Error('ABORT: a local cluster only');
    work = join(tmpdir(), `nmwc-cs-flow-${sfx}`);
    tree = join(work, 'repo');
    s3 = join(work, 's3');
    state = join(work, 'state');
    for (const d of [tree, s3, state]) mkdirSync(d, { recursive: true });

    // The repository's files (tracked and new), beside a host list naming 127.0.0.1.
    const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
    for (const f of files) if (existsSync(f)) cpSync(f, join(tree, f));
    writeFileSync(join(tree, 'config', 'production-hosts.txt'), '# the clean-start flow test: "production" is the loopback address\n127.0.0.1\n');
    const nm = resolve('node_modules');
    if (process.platform === 'win32') spawnSync('cmd', ['/c', 'mklink', '/J', join(tree, 'node_modules'), nm]);
    else spawnSync('ln', ['-s', nm, join(tree, 'node_modules')]);
    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=flow', '-c', 'user.email=flow@test.invalid', ...a], { cwd: tree, encoding: 'utf8' });
    git('init', '-q', '.');
    git('add', 'scripts/ops/clean-start', '.github/workflows/clean-start.yml');
    git('commit', '-qm', 'flow');

    // age key of the test.
    const kg = spawnSync('bash', [join(BIN, 'age-keygen')], { encoding: 'utf8', env: { ...baseEnv(), PATH: standinPath() } });
    recipient = /age1[0-9a-f]+/.exec(`${kg.stdout}${kg.stderr}`)![0];
    identity = /AGE-SECRET-KEY-1[0-9a-f]+/.exec(kg.stdout)![0];

    // "production": migrated, seeded, a test period in it.
    for (const d of [PROD, PRISTINE, RESTORE, UAT]) dropDb(d);
    sql(adminUrl, `CREATE DATABASE ${PROD}`);
    const step = (args: string[]) => {
      const r = spawnSync(process.execPath, args, { cwd: tree, env: { ...baseEnv(), DATABASE_URL: PROD_LOCAL, DIRECT_URL: PROD_LOCAL, SEED_ADMIN_PASSWORD: 'Flow-Seed-Admin-2026!x' }, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${args[1]} failed: ${r.stderr?.slice(-1500)}`);
    };
    step([resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy']);
    step([resolve('node_modules/tsx/dist/cli.mjs'), 'prisma/seed.ts']);
    db = new PrismaClient({ datasourceUrl: assertNotProduction(PROD_LOCAL, []) });
    await seedWorld();
    await db.$disconnect();

    sql(adminUrl, `CREATE DATABASE ${PRISTINE} TEMPLATE ${PROD}`);
    await takeBackup();
    cpSync(s3, s3Pristine(), { recursive: true });
    writeFileSync(join(state, 'github.json'), JSON.stringify({ environment: { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }] }, backupRuns: {} }));
    neonFresh();
    // The test environment's photo table (the photos step's read-only UAT stand-in).
    sql(adminUrl, `CREATE DATABASE ${UAT}`);
    sql(url('localhost', UAT), `CREATE TABLE "Attachment" ("r2Key" text)`);
    db = new PrismaClient({ datasourceUrl: assertNotProduction(PROD_LOCAL, []) });
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (work && process.env.CS_FLOW_KEEP_WORK !== '1') {
      for (const d of [PROD, PRISTINE, RESTORE, UAT]) {
        try { dropDb(d); } catch { /* best effort */ }
      }
      try {
        for (const b of neon().branches) if (b.db) dropDb(b.db);
        const left = sql(adminUrl, `SELECT string_agg(datname, ' ') FROM pg_database WHERE datname LIKE 'cs_neon_%'`);
        for (const d of left.split(' ').filter(Boolean)) dropDb(d);
      } catch { /* best effort */ }
      const link = join(tree, 'node_modules');
      if (process.platform === 'win32') spawnSync('cmd', ['/c', 'rmdir', link]);
      else if (existsSync(link)) unlinkSync(link);
      if (!existsSync(join(link, 'prisma'))) rmSync(work, { recursive: true, force: true });
    }
  });

  async function seedWorld() {
    const c = contextClient(db, { actorId: null, source: src.test('clean-start-flow') });
    const S = sfx.toUpperCase();
    const region = (await c.region.create({ data: { code: `${S}A`, name: `Flow A ${sfx}` } })).id;
    const testRegion = (await c.region.create({ data: { code: `${S}ZZ`, name: `Flow test ${sfx}` } })).id;
    const route = (await c.route.create({ data: { code: `${S}R1`, name: `Flow route ${sfx}`, regionId: region } })).id;
    const testRoute = (await c.route.create({ data: { code: `${S}ZR`, name: `Flow test route ${sfx}`, regionId: testRegion } })).id;
    await new Promise((r) => setTimeout(r, 20));
    const salesman = (
      await c.user.create({ data: { username: `${sfx}.s1`, fullName: 'ZZ Flow Salesman', role: 'SALESMAN', passwordHash: '$2b$12$flowflowflowflowflowflO', ownedRouteId: route } })
    ).id;
    const actor = (await c.user.create({ data: { username: actorName, fullName: 'ZZ Flow Owner', role: 'MANAGER', passwordHash: '$2b$12$ownownownownownownownO' } })).id;
    const testUser = (
      await c.user.create({ data: { username: `zz.test.${sfx}`, fullName: 'ZZ Test', role: 'SALESMAN', passwordHash: '$2b$12$tsttsttsttsttsttsttstO', ownedRouteId: testRoute } })
    ).id;
    const chan = await db.channel.findFirstOrThrow({ select: { id: true } });
    const customers: string[] = [];
    for (const n of [5, 6, 7]) {
      const name = `ZZ Flow Customer ${sfx} ${n}`;
      customerNames.push(name);
      const id = (await c.customer.create({ data: { nmwcCode: formatCustomerCode(year, n), legalName: name, paymentTerms: 'CASH', channelId: chan.id } })).id;
      customers.push(id);
      const b = await c.branch.create({ data: { customerId: id, branchCode: `${formatCustomerCode(year, n)}-01`, branchName: `ZZ shop ${n}`, routeId: route, regionId: region, address: `ZZ Way ${n}, synthetic`, status: 'ACTIVE' } });
      for (const kind of ['CR', 'SHOP']) {
        const r2Key = `${D.replace(/-/g, '/')}/${salesman}/${kind}/${randomUUID()}.jpg`;
        photoKeys.push(r2Key);
        await c.attachment.create({
          data: { kind, r2Key, mimeType: 'image/jpeg', bytes: 1000, capturedById: salesman, capturedAt: new Date(), hash: sha(r2Key), customerId: id, branchId: kind === 'SHOP' ? b.id : null } as Prisma.AttachmentUncheckedCreateInput,
        });
        mkdirSync(join(s3, 'nmwc-photos', ...r2Key.split('/').slice(0, -1)), { recursive: true });
        writeFileSync(join(s3, 'nmwc-photos', ...r2Key.split('/')), 'jpeg');
      }
    }
    // A key without the photo shape (kept by the photo step).
    const odd = `legacy/${sfx}-odd.jpg`;
    photoKeys.push(odd);
    await c.attachment.create({ data: { kind: 'FREE', r2Key: odd, mimeType: 'image/jpeg', bytes: 10, capturedById: salesman, capturedAt: new Date(), hash: sha(odd), customerId: customers[0] } as Prisma.AttachmentUncheckedCreateInput });
    mkdirSync(join(s3, 'nmwc-photos', 'legacy'), { recursive: true });
    writeFileSync(join(s3, 'nmwc-photos', 'legacy', `${sfx}-odd.jpg`), 'jpeg');
    await db.codeSequence.create({ data: { scope: `CUSTOMER-${year}`, next: 8 } });
    await db.auditLog.create({ data: { id: `${sfx}-a1`, actorId: actor, action: 'UPDATE', entityType: 'Customer', entityId: customers[0]!, reason: 'flow test period' } });
    await db.savedView.create({ data: { userId: actor, name: 'Flow view', urlParams: 'q=zz' } });
    const runs: Prisma.CronRunCreateManyInput[] = [{ key: 'photo-gc', at: dayUtc(Dm3, 3), ok: true, durationMs: 5 }];
    for (const day of [Dm1, D]) {
      for (const [key, exp] of Object.entries(HEARTBEAT_EXPECTATIONS)) {
        if (key === 'db-backup') continue;
        if (exp.activeHoursUtc) {
          for (let t = dayUtc(day, exp.activeHoursUtc[0], 1).getTime(); t < dayUtc(day, exp.activeHoursUtc[1]).getTime(); t += exp.everyMinutes * 60_000)
            runs.push({ key, at: new Date(t), ok: true, durationMs: 5 });
        } else runs.push({ key, at: dayUtc(day, key === 'integrity-watch' ? 2 : 3, 30), ok: true, durationMs: 5 });
      }
    }
    await db.cronRun.createMany({ data: runs });
    for (const [key, exp] of Object.entries(HEARTBEAT_EXPECTATIONS)) {
      const lastRunAt = key === 'db-backup' ? new Date(now.getTime() - 3600_000) : exp.activeHoursUtc ? dayUtc(D, 14, 50) : dayUtc(D, key === 'integrity-watch' ? 2 : 3, 30);
      await db.cronHeartbeat.create({ data: { key, lastRunAt, lastOk: true, runs: 10 } });
    }
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'on'`);
      await setChangeContext(tx, { actorId: null, source: src.test('clean-start-flow') });
      await tx.user.update({ where: { id: testUser }, data: { isTest: true } });
      await tx.route.update({ where: { id: testRoute }, data: { isTest: true } });
      await tx.region.update({ where: { id: testRegion }, data: { isTest: true } });
    });
    // The test period's seal chain, written by the real watch into the photo bucket folder.
    const store = folderStore(join(s3, 'nmwc-photos'));
    for (const day of [Dm2, Dm1])
      await runIntegrityWatch(db, { store, now: dayUtc(day, 2, 30), inAppAlerts: false, alert: async () => true, audience: async () => [] });
    oldSealKeys = await store.list('seals/');
    expect(oldSealKeys).toHaveLength(2);
    // One old copy MISSING (archived from the export), one FOREIGN object (another chain).
    rmSync(join(s3, 'nmwc-photos', ...oldSealKeys[1]!.split('/')));
    await store.put(FOREIGN, '{}');
  }

  /** db-backup.yml's dump: pg_dump, gzip, the manifest with the dump's row counts, age, to db/<stamp>. */
  async function takeBackup() {
    const e = { ...baseEnv(), PATH: standinPath(), FAKE_PG_BIN: PG_BIN };
    const dump = spawnSync('bash', ['-c', `pg_dump --no-owner --no-privileges --format=plain --no-unlogged-table-data "${PROD_LOCAL}"`], { env: e, maxBuffer: 512 * 1024 * 1024 });
    if (dump.status !== 0) throw new Error('pg_dump failed');
    const gz = gzipSync(dump.stdout);
    const counts = spawnSync('bash', ['-c', `awk -f scripts/ops/dump-rowcounts.awk`], { input: dump.stdout, env: e, encoding: 'utf8' }).stdout;
    const man = spawnSync('bash', ['-c', `psql "${PROD_LOCAL}" -X -At -f scripts/ops/backup-manifest.sql`], { env: e, encoding: 'utf8' }).stdout;
    const manifest = JSON.parse(man) as Record<string, unknown>;
    manifest.rowCounts = Object.fromEntries(counts.split('\n').filter(Boolean).map((l) => l.split('\t')).map(([t, n]) => [t, Number(n)]));
    manifest.rowCountsSource = 'dump';
    const stamp = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace(/:/g, '-') + 'Z';
    const dir = join(s3, 'nmwc-backups', 'db');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(work, 'dump.sql.gz'), gz);
    const enc = spawnSync('bash', [join(BIN, 'age'), '-r', recipient, '-o', join(dir, `${stamp}.sql.gz.age`), join(work, 'dump.sql.gz')], { env: e });
    if (enc.status !== 0) throw new Error('age failed');
    rmSync(join(work, 'dump.sql.gz'));
    writeFileSync(join(dir, `${stamp}.manifest.json`), JSON.stringify(manifest));
  }

  const forbidden = () => [
    actorName,
    sfx,
    ...customerNames,
    ...photoKeys,
    ...oldSealKeys,
    FOREIGN,
    PROD,
    '127.0.0.1',
    identity,
    recipient,
    ...Object.values(SECRETS),
  ];
  const lines = (r: RunResult) => r.lines;
  const expectPublic = (r: RunResult) => expect(publicLogViolations(lines(r), forbidden())).toEqual([]);
  const notRunHere = (r: RunResult) => [...new Set(r.steps.filter((s) => s.outcome === 'not run here').map((s) => s.step))].sort();

  // ── the modes ─────────────────────────────────────────────────────────

  let dry: RunResult & { runId: string };
  it('dry-run: plan, exports, rehearsal on the restored dump, the watch twice — production unchanged', async () => {
    const before = await auditIds();
    dry = run('clean-start.yml', { mode: 'dry-run', confirm_host: '127.0.0.1', confirm_phrase: '', run_id: '' });
    expect(results(dry), describeJob(dry, 'plan') + describeJob(dry, 'rehearse')).toEqual({
      plan: 'success',
      rehearse: 'success',
      neon_rehearsal: 'skipped',
      apply: 'skipped',
      finish: 'skipped',
      seal_restore: 'skipped',
    });
    for (const l of [
      'connection is production, named by the owner: yes',
      "production serves this run's commit: yes",
      'environment production-reset has a required reviewer: yes',
      'exports match the plan: yes',
      'other objects under seals/ (reported once on the first night): yes',
      'backup restored with no error: yes',
      'restored backup passes restore-verify against its manifest: yes',
      'backup equals production: yes',
      'reset on the restored backup: ok',
      'verify on the restored backup: ok',
      'first integrity checks as expected: yes',
      "the nightly backup's table gate passes on the reset copy: yes",
      'next customer code would be number 000001: yes',
    ])
      expect(dry.lines, l).toContain(l);
    expect(notRunHere(dry)).toEqual(['Install dependencies', 'Install the Postgres 17 client and age', 'actions/checkout@v7', 'actions/setup-node@v7']);
    expect(await auditIds()).toEqual(before);
    expect(listBucket('nmwc-backups', `cleanstart/${dry.runId}/plan/`)).toEqual(
      ['photo-keys.txt.age', 'plan-id.txt.age', 'plan.json.age', 'seal-keys-foreign.txt.age', 'seals.jsonl.age'].map((f) => `cleanstart/${dry.runId}/plan/${f}`)
    );
    expect(has('nmwc-photos', oldSealKeys[0]!)).toBe(true);
    expectPublic(dry);
  });

  let neonRun: RunResult & { runId: string };
  it('neon-rehearsal: reset on a branch, restored to the noted time, the exact fingerprint back, every branch deleted', async () => {
    await db.$disconnect(); // a branch is CREATE DATABASE … TEMPLATE production: no session may hold it
    neonRun = run('clean-start.yml', { mode: 'neon-rehearsal', confirm_host: '127.0.0.1', confirm_phrase: '', run_id: '' });
    expect(results(neonRun), describeJob(neonRun, 'neon_rehearsal')).toMatchObject({ plan: 'success', neon_rehearsal: 'success', rehearse: 'skipped', apply: 'skipped' });
    for (const l of [
      'Neon branch created and confirmed: yes',
      'Neon branch host is not production: yes',
      "branch equals production's plan: yes",
      'reset on the Neon branch: ok',
      'first integrity checks as expected: yes',
      'Neon restored the branch to the noted time: yes',
      'the reset row is gone after the restore: yes',
      'the Neon restore returned the exact fingerprint: yes',
      'temporary Neon branches deleted: yes',
    ])
      expect(neonRun.lines, l).toContain(l);
    expect(neon().branches.map((b) => b.name)).toEqual(['main']);
    expect(sql(adminUrl, `SELECT count(*) FROM pg_database WHERE datname LIKE 'cs_neon_%'`)).toBe('0');
    expect(await auditIds()).not.toContain(`cleanstart-${neonRun.runId}`);
    expectPublic(neonRun);
    // GitHub now knows a green rehearsal of these scripts (what apply's neon-green reads).
    const tree_ = spawnSync('git', ['rev-parse', 'HEAD:scripts/ops/clean-start'], { cwd: tree, encoding: 'utf8' }).stdout.trim();
    const yml_ = spawnSync('git', ['rev-parse', 'HEAD:.github/workflows/clean-start.yml'], { cwd: tree, encoding: 'utf8' }).stdout.trim();
    const gh = JSON.parse(readFileSync(join(state, 'github.json'), 'utf8'));
    // a run ON THE DEFAULT BRANCH, whose workflow file is this checkout's too (neon-green, review 2026-11-11)
    gh.cleanStartRuns = [{ id: Number(neonRun.runId), head_sha: SHA, head_branch: 'main', display_title: 'Clean start neon-rehearsal' }];
    gh.workflowBlobs = { [SHA]: yml_ };
    gh.jobs = { [neonRun.runId]: [{ name: 'Neon rehearsal', conclusion: 'success' }] };
    gh.trees = { [SHA]: tree_ };
    writeFileSync(join(state, 'github.json'), JSON.stringify(gh));
  });

  it('apply refuses without the exact phrase, in PLAN, before anything is made', () => {
    const noPhrase = run('clean-start.yml', { mode: 'apply', confirm_host: '127.0.0.1', confirm_phrase: 'REMOVE ALL TEST DATA', run_id: '' });
    expect(results(noPhrase)).toMatchObject({ plan: 'failure', rehearse: 'skipped', apply: 'skipped' });
    expect(noPhrase.lines.some((l) => /clean start refused: the target guard refused/.test(l))).toBe(true);
    expect(sql(PROD_LOCAL, `SELECT count(*) FROM "AuditLog" WHERE id LIKE 'cleanstart-%'`)).toBe('0');
    expect(neon().branches.map((b) => b.name)).toEqual(['main']);
    expectPublic(noPhrase);
  });

  it('apply stopping before the reset (an archive conflict) changes nothing and deletes its unused safety branch', () => {
    // An archive object with other bytes already where this run will archive seal 0: archive refuses (additive only).
    const next = String(runSeq + 1);
    const bogus = join(s3, 'nmwc-backups', 'cleanstart', next, 'seal-archive', ...oldSealKeys[0]!.split('/'));
    mkdirSync(join(bogus, '..'), { recursive: true });
    writeFileSync(bogus, 'not the seal');
    const r = run('clean-start.yml', { mode: 'apply', confirm_host: '127.0.0.1', confirm_phrase: phrase(), run_id: '' });
    rmSync(bogus);
    expect(r.runId).toBe(next);
    expect(results(r), describeJob(r, 'apply')).toMatchObject({ plan: 'success', rehearse: 'success', apply: 'failure' });
    expect(r.lines).toContain('Neon branch created and confirmed: yes');
    expect(r.lines).toContain('temporary Neon branches deleted: yes');
    expect(neon().branches.map((b) => b.name)).toEqual(['main']);
    expect(sql(PROD_LOCAL, `SELECT count(*) FROM "AuditLog" WHERE id LIKE 'cleanstart-%'`)).toBe('0');
    expect(has('nmwc-photos', oldSealKeys[0]!)).toBe(true);
    expectPublic(r);
  });

  let applyA: RunResult & { runId: string };
  it('apply: the reset on "production", verified, old seals archived then retired, the first watch as expected', async () => {
    applyA = run('clean-start.yml', { mode: 'apply', confirm_host: '127.0.0.1', confirm_phrase: phrase(), run_id: '' });
    expect(results(applyA), describeJob(applyA, 'apply')).toMatchObject({ plan: 'success', rehearse: 'success', apply: 'success' });
    for (const l of [
      'green Neon rehearsal of these scripts within 14 days: yes',
      'the rehearsed backup is still the newest: yes',
      'production unchanged since the plan: yes',
      'Neon branch created and confirmed: yes',
      'old seals archived, re-read and chained: yes',
      'connection is production, named by the owner: yes',
      'reset: ok',
      'reset committed: yes',
      'kept accounts, routes and regions verified after the reset: yes',
      'old seal files removed from the live folder, each with a verified archive copy: yes',
      'integrity watch ran on production: yes',
      'seal-offsite-copies: fail',
      'first integrity checks as expected: yes',
      'Neon safety branch kept: yes',
    ])
      expect(applyA.lines, l).toContain(l);
    expect(applyA.lines.some((l) => /^reset started at \(UTC\): /.test(l))).toBe(true);
    expect(applyA.lines.some((l) => /^list_sha256 for the photo step: [0-9a-f]{64}$/.test(l))).toBe(true);
    expect(notRunHere(applyA)).toContain('i. Smoke');
    expect(await auditIds()).toEqual([`cleanstart-${applyA.runId}`]);
    expect(await db.customer.count()).toBe(0);
    expect(await db.codeSequence.count()).toBe(0);
    // Old seals: archived, re-readable, gone from the live folder; the foreign object stays; a new genesis.
    for (const k of oldSealKeys) {
      expect(has('nmwc-backups', `cleanstart/${applyA.runId}/seal-archive/${k}`), k).toBe(true);
      expect(has('nmwc-photos', k), k).toBe(false);
    }
    expect(has('nmwc-photos', FOREIGN)).toBe(true);
    expect(listBucket('nmwc-photos', 'seals/v1/').filter((k) => k !== FOREIGN)).toHaveLength(1);
    expect(neon().branches.map((b) => b.name)).toEqual(['main', `pre-clean-start-${omanDateISO(new Date())}-${applyA.runId}`]);
    expect(listBucket('nmwc-backups', `cleanstart/${applyA.runId}/report/`).length).toBeGreaterThanOrEqual(5);
    // The R2 write token was used only on the photo bucket, only to delete old seal keys.
    const calls = readFileSync(join(work, 's3.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const rw = calls.filter((c) => c.accessKeyId === 'rw-flow');
    expect(rw.every((c) => c.bucket === 'nmwc-photos' && ['delete', 'head', 'get', 'list'].includes(c.op))).toBe(true);
    expectPublic(applyA);
  });

  it('a second apply is refused: the plan guard sees the clean start (CS012)', () => {
    const again = run('clean-start.yml', { mode: 'apply', confirm_host: '127.0.0.1', confirm_phrase: phrase(), run_id: '' });
    expect(again.jobs.plan!.result).toBe('failure');
    expect(again.lines).toContain('plan checks: SQLSTATE CS012');
    expect(again.jobs.apply!.result).toBe('skipped');
    expectPublic(again);
  });

  it('seal-restore: after "production" was put back, the old seals return and the new chain is moved aside', async () => {
    await db.$disconnect();
    resetProd(); // the owner's Neon restore
    db = new PrismaClient({ datasourceUrl: assertNotProduction(PROD_LOCAL, []) });
    const newChain = listBucket('nmwc-photos', 'seals/v1/').filter((k) => k !== FOREIGN);
    const r = run('clean-start.yml', { mode: 'seal-restore', confirm_host: '127.0.0.1', confirm_phrase: '', run_id: applyA.runId });
    expect(results(r), describeJob(r, 'seal_restore')).toMatchObject({ seal_restore: 'success', plan: 'skipped' });
    expect(r.lines).toContain('production is back to before the reset (old chain, no reset row): yes');
    expect(r.lines).toContain('old seal files back in the live folder, hash-checked: yes');
    expect(r.lines).toContain('the abandoned new chain moved out of the live folder: yes');
    for (const k of oldSealKeys) expect(has('nmwc-photos', k), k).toBe(true); // the missing copy too, from the export
    for (const k of newChain) {
      expect(has('nmwc-photos', k)).toBe(false);
      expect(has('nmwc-backups', `cleanstart/${applyA.runId}/abandoned-chain/${k}`)).toBe(true);
    }
    expect(has('nmwc-photos', FOREIGN)).toBe(true);
    expectPublic(r);
  });

  let applyB: RunResult & { runId: string };
  it('finish, outcome A: the connection was lost AFTER the COMMIT — finish settles it, verifies and completes', async () => {
    await db.$disconnect();
    resetProd();
    resetS3();
    neonFresh();
    writeFileSync(join(work, 'fault'), 'commit-then-drop');
    applyB = run('clean-start.yml', { mode: 'apply', confirm_host: '127.0.0.1', confirm_phrase: phrase(), run_id: '' });
    writeFileSync(join(work, 'fault'), '');
    expect(applyB.jobs.apply!.result, describeJob(applyB, 'apply')).toBe('failure');
    expect(applyB.lines).toContain('reset: no connection (the outcome is unknown)');
    expect(applyB.lines).toContain('reset committed: unknown (no connection); run mode finish with this run id');
    expect(applyB.lines).toContain('Neon safety branch kept: yes');
    expect(sql(PROD_LOCAL, `SELECT count(*) FROM "AuditLog" WHERE id = 'cleanstart-${applyB.runId}'`)).toBe('1');
    const fin = run('clean-start.yml', { mode: 'finish', confirm_host: '127.0.0.1', confirm_phrase: '', run_id: applyB.runId });
    expect(results(fin), describeJob(fin, 'finish')).toMatchObject({ finish: 'success' });
    for (const l of ['reset committed: yes', 'kept accounts, routes and regions verified after the reset: yes', 'old seal files removed from the live folder, each with a verified archive copy: yes', 'first integrity checks as expected: yes'])
      expect(fin.lines, l).toContain(l);
    expect(has('nmwc-photos', oldSealKeys[0]!)).toBe(false);
    expect(neon().branches.map((b) => b.name)).toContain(`pre-clean-start-${omanDateISO(new Date())}-${applyB.runId}`);
    expectPublic(applyB);
    expectPublic(fin);
  });

  it('photos: refused before 7 days; then the deletion — shared and odd keys kept, safety branch first, one audit row', async () => {
    const listSum = applyB.lines.find((l) => l.startsWith('list_sha256 for the photo step: '));
    const sum = listSum ? listSum.split(': ')[1]! : sha(photoKeys.slice().sort().join('\n') + '\n');
    db = new PrismaClient({ datasourceUrl: assertNotProduction(PROD_LOCAL, []) });
    const inputs = { run_id: applyB.runId, list_sha256: sum, confirm_host: '127.0.0.1', confirm_phrase: 'DELETE TEST PHOTOS' };
    const early = run('clean-start-photos.yml', inputs);
    expect(early.jobs.photos!.result).toBe('failure');
    expect(early.lines).toContain('the reset is at least 7 days old: no');
    for (const k of photoKeys) expect(has('nmwc-photos', k), k).toBe(true);
    // Eight days later (the owner's window, on the test database only), and UAT uses one photo.
    sql(PROD_LOCAL, `BEGIN; SET LOCAL nmwc.audit_maintenance = 'on'; UPDATE "AuditLog" SET "at" = now() - interval '8 days' WHERE id = 'cleanstart-${applyB.runId}'; COMMIT;`);
    sql(url('localhost', UAT), `INSERT INTO "Attachment" VALUES ('${photoKeys[0]}')`);
    // Not before the real customer file is in (design section 6): refused, nothing deleted.
    const noFile = run('clean-start-photos.yml', inputs);
    expect(noFile.jobs.photos!.result).toBe('failure');
    expect(noFile.lines).toContain('the real customer file is loaded (customers exist): no');
    for (const k of photoKeys) expect(has('nmwc-photos', k), k).toBe(true);
    // The owner loads the real file (one customer stands for it).
    const chan = await db.channel.findFirstOrThrow({ select: { id: true } });
    await contextClient(db, { actorId: null, source: src.test('clean-start-flow') }).customer.create({
      data: { nmwcCode: formatCustomerCode(year, 1), legalName: `ZZ Flow Real ${sfx}`, paymentTerms: 'CASH', channelId: chan.id },
    });
    const wrongPhrase = run('clean-start-photos.yml', { ...inputs, confirm_phrase: 'delete test photos' });
    expect(wrongPhrase.jobs.photos!.result).toBe('failure');
    const r = run('clean-start-photos.yml', inputs);
    expect(r.jobs.photos!.result, describeJob(r, 'photos')).toBe('success');
    for (const l of ['the stored list, the typed value and the reset row agree: yes', 'production references none of the listed photos: yes', 'temporary Neon branches deleted: yes', 'keys kept because the test environment uses them: yes', 'keys skipped because they do not have the photo shape: yes', 'every photo to delete is confirmed gone: yes', 'photo deletion recorded in the audit log: ok'])
      expect(r.lines, l).toContain(l);
    expect(has('nmwc-photos', photoKeys[0]!)).toBe(true); // UAT uses it
    expect(has('nmwc-photos', photoKeys.find((k) => k.startsWith('legacy/'))!)).toBe(true);
    for (const k of photoKeys.slice(1).filter((k) => !k.startsWith('legacy/'))) expect(has('nmwc-photos', k), k).toBe(false);
    expect(neon().branches.map((b) => b.name)).toEqual(['main']);
    const row = await db.auditLog.findUnique({ where: { id: `cleanstart-photos-${r.runId}` } });
    expect(row?.source).toBe(`script:clean-start-photos:${r.runId}`);
    await db.$disconnect();
    for (const x of [early, wrongPhrase, r]) expectPublic(x);
  });

  it('finish, outcome B: the connection was lost BEFORE the COMMIT — nothing changed, the safety branch is deleted', async () => {
    resetProd();
    resetS3();
    neonFresh();
    writeFileSync(join(work, 'fault'), 'drop-before-commit');
    const applyC = run('clean-start.yml', { mode: 'apply', confirm_host: '127.0.0.1', confirm_phrase: phrase(), run_id: '' });
    writeFileSync(join(work, 'fault'), '');
    expect(applyC.jobs.apply!.result).toBe('failure');
    expect(applyC.lines).toContain('reset committed: unknown (no connection); run mode finish with this run id');
    expect(neon().branches).toHaveLength(2);
    const fin = run('clean-start.yml', { mode: 'finish', confirm_host: '127.0.0.1', confirm_phrase: '', run_id: applyC.runId });
    expect(fin.jobs.finish!.result).toBe('failure');
    expect(fin.lines).toContain('reset committed: no (nothing changed)');
    expect(fin.lines).toContain('temporary Neon branches deleted: yes');
    expect(neon().branches.map((b) => b.name)).toEqual(['main']);
    expect(sql(PROD_LOCAL, `SELECT count(*) FROM "AuditLog" WHERE id LIKE 'cleanstart-%'`)).toBe('0');
    expect(Number(sql(PROD_LOCAL, `SELECT count(*) FROM "Customer"`))).toBeGreaterThan(0);
    for (const k of [oldSealKeys[0]!, FOREIGN]) expect(has('nmwc-photos', k)).toBe(true);
    expectPublic(applyC);
    expectPublic(fin);
  });

  it('THE PUBLIC LOG RULE over every line of every run above', () => {
    expect(ALL_LINES.length).toBeGreaterThan(300);
    expect(publicLogViolations(ALL_LINES, forbidden())).toEqual([]);
  });
});
