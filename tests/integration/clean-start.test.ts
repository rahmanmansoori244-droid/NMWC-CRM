// @vitest-environment node
/**
 * Go-live clean start, end to end on Postgres (design final.build_plan 10).
 *
 * A scratch DATABASE on the server DATABASE_URL names (created, then dropped),
 * built the way ci.yml's db-tests job builds its own: migrate deploy, the seed,
 * the runtime role's grants. Into it, everything a test period leaves behind:
 * merged customers, photos in every slot, requests in every state, a new-customer
 * request with its drafts, revisions and decisions, notifications, an import and
 * its rows, an export, a Temix batch, sign-in events, purge summaries, job-run
 * days and runs, a rate-limit bucket, saved views, a CUSTOMER-<year> counter,
 * the test flags, a route whose holder is younger than the route, and a seal
 * chain of two seals written by the real nightly watch. Then, exactly as the
 * clean-start workflow will:
 *
 *   plan.sql (the exports and the plan id), the target guard, reset.sql through
 *   psql, verify.sql, and the real watch twice (rehearse-watch.ts);
 *
 * and asserts: every emptied table empty but the one reset row and the
 * baselines; the kept tables byte-identical (password hashes included); the
 * next customer code NMWC-<year>-000001; history-open-interval and
 * history-matches-master pass; no trigger off and no function changed; and the
 * refusals: a second run, a row changed between plan and apply (rolled back
 * completely), the runtime role, a wrong host or a missing confirmation.
 *
 * Runs only against this machine (it creates and drops a database), never
 * production (the shared guards), and needs psql and bash on PATH, the seed
 * password and the runtime role's URL (NMWC_APP_URL) as ci.yml sets them.
 *
 *   RUN_CLEAN_START=1 DATABASE_URL=postgresql://…@localhost:…/… NMWC_APP_URL=… \
 *     npx vitest run tests/integration/clean-start.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  assertNotProduction,
  pointsAtProduction,
  PRODUCTION_HOST_PREFIX,
} from '../../scripts/lib/assert-not-production';
import { contextClient, setChangeContext, src } from '@/lib/change-context';
import { CHECK_BY_ID } from '@/lib/integrity/checks';
import { HEARTBEAT_EXPECTATIONS } from '@/lib/heartbeat';
import { formatCustomerCode } from '@/lib/codes';
import { omanDateISO, omanYear } from '@/lib/tz';
import {
  rehearseWatch,
  rehearsalTarget,
  memoryStore,
  nextOmanMorning,
} from '../../scripts/ops/clean-start/rehearse-watch';
import { runIntegrityWatch } from '@/lib/integrity/run';
import { listAuditRows } from '@/lib/audit-rows';
import {
  CLEAN_START_KIND_LABELS,
  cleanStartCounts,
  isCleanStartRecord,
  readCleanStartAt,
} from '@/lib/clean-start-record';
import { comparisonFor } from '@/lib/insights/compare';
import { parsePeriod } from '@/lib/insights/period';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 600_000 });

const ENABLED = process.env.RUN_CLEAN_START === '1' && !!process.env.DATABASE_URL;
const PRISMA_CLI = resolve('node_modules/prisma/build/index.js');
const DIR = 'scripts/ops/clean-start';
const TABLES = JSON.parse(readFileSync(`${DIR}/tables.json`, 'utf8')) as {
  EMPTY: string[];
  KEEP: string[];
  baseline: string[];
};
const KEEP_HASHED = [
  'User',
  'PasswordHistory',
  'Region',
  'Route',
  '_ManagerRegions',
  'Channel',
  'SubChannel',
  'CronHeartbeat',
];
const DAY_MS = 86_400_000;

/** The checkout's migration list as guards.sql CS007 hashes it. */
function expectedMigrations(): string {
  const lines = readdirSync('prisma/migrations')
    .filter((d) => /^\d{14}_/.test(d))
    .sort()
    .map(
      (d) =>
        `${d} ${createHash('sha256')
          .update(readFileSync(`prisma/migrations/${d}/migration.sql`))
          .digest('hex')}\n`
    );
  return createHash('sha256').update(lines.join('')).digest('hex');
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** psql on Windows writes text files with CRLF; the runner (Linux) writes LF. */
const fileBytes = (p: string) =>
  process.platform === 'win32'
    ? Buffer.from(readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))
    : readFileSync(p);

type Run = { code: number; out: string };

describe.skipIf(!ENABLED)('go-live clean start on Postgres', () => {
  const sfx = `cs${Date.now().toString(36)}`;
  const scratchDb = `nmwc_${sfx}`;
  let admin: PrismaClient;
  let db: PrismaClient;
  let scratchUrl = '';
  let appUrl = '';
  let tmp = '';
  /** TEMPLATE copies made by the refusal cases (dropped in afterAll too). */
  const copies: string[] = [];
  const now = new Date();
  const year = omanYear(now);
  const D = omanDateISO(now);
  const dayUtc = (day: string, h: number, m = 0) =>
    new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h, m));
  const addDays = (day: string, n: number) =>
    omanDateISO(new Date(dayUtc(day, 12).getTime() + n * DAY_MS));
  const Dm1 = addDays(D, -1);
  const Dm2 = addDays(D, -2);
  const Dm3 = addDays(D, -3);
  // The day after: the reset's own day, if midnight in Oman (20:00 UTC) passes while the suite runs.
  const Dp1 = addDays(D, 1);

  const w = {
    actor: '',
    actorName: `${sfx}.owner`,
    sup: '',
    salesman: '',
    salesman2: '',
    manager: '',
    steward: '',
    testUser: '',
    regionA: '',
    regionB: '',
    testRegion: '',
    route1: '',
    route2: '',
    testRoute: '',
    customers: [] as string[],
    keys: [] as string[],
    oldSealKeys: [] as string[],
    /** When each seeded job run was (ms): the reset keeps those from the Oman day before its own. */
    cronRunAts: [] as number[],
  };

  const run = (cmd: string, env: Record<string, string>): Run => {
    const r = spawnSync('bash', ['-c', cmd], { env: { ...process.env, ...env }, encoding: 'utf8' });
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  /** The same, without blocking this process: for a command that must wait on another session here. */
  const runAsync = (cmd: string, env: Record<string, string>): Promise<Run> =>
    new Promise((resolveRun, reject) => {
      const p = spawn('bash', ['-c', cmd], { env: { ...process.env, ...env } });
      let out = '';
      p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      p.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
      p.on('error', reject);
      p.on('close', (code) => resolveRun({ code: code ?? -1, out }));
    });
  /** reset.sql exactly as the workflow runs it: the target guard, then psql with its variables. */
  const reset = (
    vars: Record<string, string>,
    url = scratchUrl,
    mode: 'rehearse' | 'apply' = 'rehearse',
    env: Record<string, string> = {}
  ): Run => {
    const v = Object.entries(vars)
      .map(([k, x]) => `-v ${k}='${x}'`)
      .join(' ');
    return run(
      `bash ${DIR}/target-guard.sh ${mode} && psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f ${DIR}/reset.sql ${v}`,
      { DIRECT_URL: url, ...env }
    );
  };
  const plan = (outDir: string): Run =>
    run(
      `PGOPTIONS='-c default_transaction_read_only=on' psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f ${DIR}/plan.sql -v out_dir='${outDir}' -v actor_username='${w.actorName}' -v expected_migrations='${expectedMigrations()}'`,
      { DIRECT_URL: scratchUrl }
    );
  const planIds = (outDir: string) =>
    Object.fromEntries(
      readFileSync(join(outDir, 'plan-id.txt'), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => l.split('=') as [string, string])
    );

  /** Every table's row count. */
  const counts = async (client = db) => {
    const rows = await client.$queryRaw<Array<{ t: string; n: string }>>`
      SELECT c.relname AS t, (xpath('/table/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, false, '')))[1]::text AS n
        FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'`;
    return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]));
  };
  /** The kept tables as text, row for row (password hashes included). */
  const keptRows = async () => {
    const out: Record<string, string[]> = {};
    for (const t of KEEP_HASHED) {
      const order =
        t === '_ManagerRegions' ? 'x."A", x."B"' : t === 'CronHeartbeat' ? 'x."key"' : 'x."id"';
      const rows = await db.$queryRawUnsafe<Array<{ j: string }>>(
        `SELECT to_jsonb(x)::text AS j FROM public."${t}" x ORDER BY ${order}`
      );
      out[t] = rows.map((r) => r.j);
    }
    return out;
  };
  const protection = async () => ({
    triggers: await db.$queryRaw<
      Array<{ d: string }>
    >`SELECT c.relname || ':' || t.tgname || ':' || t.tgenabled::text || ':' || pg_get_triggerdef(t.oid) AS d
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace ORDER BY 1`,
    functions: await db.$queryRaw<
      Array<{ d: string }>
    >`SELECT p.proname || ':' || md5(p.prosrc) || ':' || COALESCE(array_to_string(p.proconfig, ';'), '') AS d
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`,
    sequences: await db.$queryRaw<
      Array<{ s: string; v: string | null }>
    >`SELECT sequencename AS s, last_value::text AS v FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`,
  });

  const photoKey = (user: string, kind: string) =>
    `${D.replace(/-/g, '/')}/${user}/${kind}/${randomUUID()}.jpg`;

  beforeAll(async () => {
    const base = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
      throw new Error(
        `ABORT: this suite creates and drops a database, so it runs only against this machine (got ${base.hostname})`
      );
    }
    for (const k of ['DATABASE_URL', 'DIRECT_URL', 'NMWC_APP_URL'] as const) {
      if (pointsAtProduction(process.env[k] ?? ''))
        throw new Error(`ABORT: ${k} points at production`);
    }
    if (!process.env.NMWC_APP_URL)
      throw new Error(
        'NMWC_APP_URL (the runtime role, as ci.yml sets it) is needed for the runtime-role refusal'
      );
    admin = new PrismaClient({ datasourceUrl: assertNotProduction(base.toString(), []) });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchDb}"`);
    const scratch = new URL(base.toString());
    scratch.pathname = `/${scratchDb}`;
    scratchUrl = scratch.toString();
    const app = new URL(process.env.NMWC_APP_URL);
    app.pathname = `/${scratchDb}`;
    appUrl = app.toString();
    tmp = mkdtempSync(join(tmpdir(), 'nmwc-clean-start-'));

    // The database as ci.yml's db-tests job builds it.
    const env = { ...process.env, DATABASE_URL: scratchUrl, DIRECT_URL: scratchUrl };
    const step = (args: string[]) => {
      const r = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
      if (r.status !== 0)
        throw new Error(`${args.slice(0, 3).join(' ')} failed: ${r.stderr?.slice(-2000)}`);
    };
    step([PRISMA_CLI, 'migrate', 'deploy']);
    step([resolve('node_modules/tsx/dist/cli.mjs'), 'prisma/seed.ts']);
    step([resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/ops/app-role.ts', 'grant']);

    db = new PrismaClient({ datasourceUrl: assertNotProduction(scratchUrl, []) });
    await seedWorld();
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      for (const name of [scratchDb, ...copies]) {
        await admin
          .$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
          .catch(() => undefined);
      }
      await admin.$disconnect();
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  /** In the owner's window (the test flags), under the suite's change context. */
  const inWindow = (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'on'`);
      await setChangeContext(tx, { actorId: null, source: src.test('clean-start') });
      await fn(tx);
    });

  async function seedWorld() {
    const c = contextClient(db, { actorId: null, source: src.test('clean-start') });
    const S = sfx.toUpperCase();
    // Regions, routes and people. Route 1's holder is YOUNGER than the route; route 2's is older.
    w.regionA = (
      await c.region.create({ data: { code: `${S}A`, name: `Clean start A ${sfx}` } })
    ).id;
    w.regionB = (
      await c.region.create({ data: { code: `${S}B`, name: `Clean start B ${sfx}` } })
    ).id;
    w.testRegion = (
      await c.region.create({ data: { code: `${S}ZZ`, name: `Clean start test ${sfx}` } })
    ).id;
    w.salesman2 = (
      await c.user.create({
        data: {
          username: `${sfx}.s2`,
          fullName: 'ZZ Salesman Two',
          role: 'SALESMAN',
          passwordHash: '$2b$12$keptkeptkeptkeptkeptkO',
        },
      })
    ).id;
    w.route1 = (
      await c.route.create({
        data: { code: `${S}R1`, name: `Route one ${sfx}`, regionId: w.regionA },
      })
    ).id;
    w.route2 = (
      await c.route.create({
        data: { code: `${S}R2`, name: `Route two ${sfx}`, regionId: w.regionB },
      })
    ).id;
    w.testRoute = (
      await c.route.create({
        data: { code: `${S}ZR`, name: `Test route ${sfx}`, regionId: w.testRegion },
      })
    ).id;
    await new Promise((r) => setTimeout(r, 20));
    w.sup = (
      await c.user.create({
        data: {
          username: `${sfx}.sup`,
          fullName: 'ZZ Supervisor',
          role: 'SUPERVISOR',
          passwordHash: '$2b$12$supsupsupsupsupsupsupO',
        },
      })
    ).id;
    w.salesman = (
      await c.user.create({
        data: {
          username: `${sfx}.s1`,
          fullName: 'ZZ Salesman',
          role: 'SALESMAN',
          passwordHash: '$2b$12$salsalsalsalsalsalsalO',
          ownedRouteId: w.route1,
          supervisorId: w.sup,
        },
      })
    ).id;
    await c.user.update({
      where: { id: w.salesman2 },
      data: { ownedRouteId: w.route2, supervisorId: w.sup },
    });
    w.manager = (
      await c.user.create({
        data: {
          username: `${sfx}.m`,
          fullName: 'ZZ Manager',
          role: 'MANAGER',
          passwordHash: '$2b$12$mgrmgrmgrmgrmgrmgrmgrO',
          managedRegions: { connect: [{ id: w.regionA }, { id: w.regionB }] },
        },
      })
    ).id;
    w.steward = (
      await c.user.create({
        data: {
          username: `${sfx}.stw`,
          fullName: 'ZZ Steward',
          role: 'STEWARD',
          passwordHash: '$2b$12$stwstwstwstwstwstwstwO',
        },
      })
    ).id;
    w.actor = (
      await c.user.create({
        data: {
          username: w.actorName,
          fullName: 'ZZ Owner',
          role: 'MANAGER',
          passwordHash: '$2b$12$ownownownownownownownO',
          mustChangePassword: true,
        },
      })
    ).id;
    w.testUser = (
      await c.user.create({
        data: {
          username: `zz.test.${sfx}`,
          fullName: 'ZZ Test',
          role: 'SALESMAN',
          passwordHash: '$2b$12$tsttsttsttsttsttsttstO',
          ownedRouteId: w.testRoute,
        },
      })
    ).id;
    await c.user.create({
      data: {
        username: `${sfx}.gone`,
        fullName: 'ZZ Inactive',
        role: 'SALESMAN',
        passwordHash: 'x',
        isActive: false,
      },
    });
    await db.passwordHistory.createMany({
      data: [
        { userId: w.salesman, hash: '$2b$12$oldoldoldoldoldoldoldO' },
        { userId: w.actor, hash: '$2b$12$prevprevprevprevprevpO' },
      ],
    });
    await db.savedView.createMany({
      data: [
        { userId: w.manager, name: 'My view', urlParams: 'q=zz&status=ACTIVE' },
        { userId: w.salesman, name: 'Route', urlParams: 'route=R1' },
      ],
    });

    // Customers: one merged into another, which is merged into a third; an imported one; the counter's own.
    const chan = await db.channel.findFirstOrThrow({ select: { id: true } });
    const cust = async (code: string, extra: Partial<Prisma.CustomerUncheckedCreateInput> = {}) => {
      const id = (
        await c.customer.create({
          data: {
            nmwcCode: code,
            legalName: `ZZ ${code}`,
            paymentTerms: 'CASH',
            channelId: chan.id,
            ...extra,
          },
        })
      ).id;
      w.customers.push(id);
      return id;
    };
    const c1 = await cust(formatCustomerCode(year, 5));
    const c2 = await cust(`${S}-C2`);
    const c3 = await cust(`${S}-C3`);
    await c.customer.update({
      where: { id: c2 },
      data: { mergedIntoId: c1, deletedAt: new Date() },
    });
    await c.customer.update({
      where: { id: c3 },
      data: { mergedIntoId: c2, deletedAt: new Date() },
    });
    const cTest = await cust(`${S}-T`);
    await db.codeSequence.create({ data: { scope: `CUSTOMER-${year}`, next: 6 } });

    // Shops.
    const b1 = (
      await c.branch.create({
        data: {
          customerId: c1,
          branchCode: `${formatCustomerCode(year, 5)}-01`,
          branchName: 'ZZ shop',
          routeId: w.route1,
          regionId: w.regionA,
          address: 'ZZ Way 1, synthetic',
          status: 'ACTIVE',
        },
      })
    ).id;
    const b2 = (
      await c.branch.create({
        data: {
          customerId: c2,
          branchCode: `${S}-C2-01`,
          branchName: 'ZZ shop 2',
          routeId: w.route2,
          regionId: w.regionB,
          address: 'ZZ Way 2, synthetic',
          status: 'CLOSED',
        },
      })
    ).id;
    await c.branch.create({
      data: {
        customerId: cTest,
        branchCode: `${S}-T-01`,
        branchName: 'ZZ test shop',
        routeId: w.testRoute,
        regionId: w.testRegion,
        address: 'ZZ Way 3, synthetic',
      },
    });

    // Photos in every slot: CR, shop, signboard, extra, guarantee, a request's, a soft-deleted one.
    const photo = async (kind: string, data: Record<string, unknown>) => {
      const r2Key = photoKey(w.salesman, kind);
      w.keys.push(r2Key);
      return (
        await c.attachment.create({
          data: {
            kind,
            r2Key,
            mimeType: 'image/jpeg',
            bytes: 1000,
            capturedById: w.salesman,
            capturedAt: new Date(),
            hash: sha256(r2Key),
            ...data,
          } as Prisma.AttachmentUncheckedCreateInput,
        })
      ).id;
    };
    const cr = await photo('CR', { customerId: c1 });
    const shop = await photo('SHOP', { customerId: c1, branchId: b1 });
    const sign = await photo('SIGNBOARD', { customerId: c1, branchId: b1 });
    await photo('FREE', { customerId: c1, branchExtraId: b1 });
    await photo('GUARANTEE', { customerId: c1 });
    await photo('SHOP', { customerId: c2, branchId: b2, deletedAt: new Date() });
    await c.customer.update({ where: { id: c1 }, data: { crPhotoId: cr } });
    await c.branch.update({
      where: { id: b1 },
      data: { shopPhotoId: shop, signboardPhotoId: sign },
    });

    // Requests in every state, on the customer and its shop, and a new-customer request with its drafts.
    const t0 = new Date();
    const chain = [{ role: 'SUPERVISOR', slaHours: 24 }];
    const edits: string[] = [];
    for (const state of [
      'DRAFT',
      'SUBMITTED',
      'NEEDS_CORRECTION',
      'APPROVED',
      'REJECTED',
    ] as const) {
      const sent = state !== 'DRAFT';
      const e = await c.customerEdit.create({
        data: {
          target: state === 'APPROVED' ? 'BRANCH' : 'CUSTOMER',
          customerId: c1,
          branchId: state === 'APPROVED' ? b1 : null,
          state,
          submittedById: w.salesman,
          submittedAt: sent ? t0 : null,
          reviewedById: state === 'APPROVED' || state === 'REJECTED' ? w.sup : null,
          reviewedAt: state === 'APPROVED' || state === 'REJECTED' ? t0 : null,
          decisionReason:
            state === 'REJECTED' || state === 'NEEDS_CORRECTION' ? 'Photo unclear' : null,
          process: 'UPDATE',
          approvalChain: chain as never,
          paymentTermsAtSubmit: 'CASH',
          pendingRole: state === 'SUBMITTED' ? 'SUPERVISOR' : null,
          stageEnteredAt: sent ? t0 : null,
          fieldChanges: [
            { field: 'customer.notes', before: null, after: `note ${state}` },
          ] as never,
          attachmentChanges: [] as never,
          routeIdAtSubmit: sent ? w.route1 : null,
        },
      });
      edits.push(e.id);
      if (state === 'APPROVED' || state === 'REJECTED' || state === 'NEEDS_CORRECTION') {
        await db.editApproval.create({
          data: {
            editId: e.id,
            cycle: 1,
            stepIndex: 0,
            role: 'SUPERVISOR',
            decision: state === 'APPROVED' ? 'APPROVED' : 'REJECTED',
            actorId: w.sup,
            reason: 'ok',
            submitterRouteId: w.route1,
          },
        });
      }
      if (sent) {
        await db.editRevision.create({
          data: {
            editId: e.id,
            cycle: 1,
            process: 'UPDATE',
            submittedAt: t0,
            submittedById: w.salesman,
            payload: { fields: 1 } as never,
            payloadSha256: sha256(e.id),
          },
        });
      }
    }
    const create = await c.customerEdit.create({
      data: {
        target: 'CUSTOMER',
        state: 'SUBMITTED',
        submittedById: w.salesman,
        submittedAt: t0,
        process: 'CREATE',
        approvalChain: chain as never,
        paymentTermsAtSubmit: 'CASH',
        pendingRole: 'SUPERVISOR',
        stageEnteredAt: t0,
        fieldChanges: [] as never,
        attachmentChanges: [] as never,
        routeIdAtSubmit: w.route1,
      },
    });
    edits.push(create.id);
    const reqPhoto = await photo('SHOP', { editId: create.id });
    await db.editCustomerDraft.create({
      data: { editId: create.id, legalName: 'ZZ New Shop LLC', paymentTerms: 'CASH' },
    });
    await db.editBranchDraft.create({
      data: {
        editId: create.id,
        branchName: 'ZZ new',
        regionId: w.regionA,
        routeId: w.route1,
        address: 'ZZ Way 9, synthetic',
        shopPhotoAttachmentId: reqPhoto,
        extraPhotoAttachmentIds: [] as never,
      },
    });

    // Notifications, an import, an export, a Temix batch, the logs.
    await db.notification.createMany({
      data: [
        {
          userId: w.sup,
          kind: 'EDIT_SUBMITTED',
          title: 'New request',
          body: `ZZ ${formatCustomerCode(year, 5)}`,
          editId: edits[1],
          customerId: c1,
        },
        {
          userId: w.salesman,
          kind: 'EDIT_APPROVED_FINAL',
          title: 'Approved',
          body: 'ZZ',
          editId: edits[3],
          readAt: t0,
        },
      ] as Prisma.NotificationCreateManyInput[],
    });
    const batch = await db.importBatch.create({
      data: {
        filename: 'zz.xlsx',
        uploadedById: w.steward,
        status: 'PROMOTED',
        totalRows: 1,
        promotedRows: 1,
        // The 42nd migration (20261111120000_import_shop_notice_ack): an emptied
        // table pointing into a kept one. Filled so the TRUNCATE ... RESTRICT
        // and the byte-identical User check run with the key in use.
        shopNotChangedRows: 1,
        shopNotChangedAckRows: 1,
        shopNotChangedAckAt: t0,
        shopNotChangedAckById: w.steward,
      },
    });
    const row = await db.importRow.create({
      data: {
        batchId: batch.id,
        rowNumber: 2,
        raw: { name: 'ZZ' } as never,
        parsed: { name: 'ZZ' } as never,
        state: 'PROMOTED',
      },
    });
    await cust(`${S}-IMP`, { importBatchId: batch.id, importRowId: row.id });
    await db.exportJob.create({
      data: {
        requestedById: w.manager,
        filters: {} as never,
        status: 'DONE',
        rowCount: 3,
        customerIds: [c1, c2],
      },
    });
    const temix = await db.temixSyncBatch.create({
      data: {
        createdById: w.steward,
        rowCount: 1,
        customerIds: [c1] as never,
        status: 'DONE',
        markedLoadedAt: t0,
      },
    });
    await c.customer.update({ where: { id: c1 }, data: { lastTemixUploadBatchId: temix.id } });
    await db.auditLog.createMany({
      data: [
        { actorId: w.salesman, action: 'LOGIN', entityType: 'User', entityId: w.salesman },
        { actorId: w.salesman, action: 'LOGIN_FAIL', entityType: 'User', entityId: w.salesman },
        {
          actorId: w.sup,
          action: 'APPROVE',
          entityType: 'CustomerEdit',
          entityId: edits[3]!,
          after: { legalName: 'ZZ' } as never,
        },
      ],
    });
    await db.authEvent.createMany({
      data: [
        { kind: 'LOGIN_FAIL_UNKNOWN', usernameHmac: sha256('nobody') },
        { kind: 'SESSION_REVOKE', userId: w.salesman },
      ],
    });
    await db.purgeSummary.create({
      data: {
        job: 'retention-sweep',
        rule: 'rate-limit-1d',
        tableName: 'RateLimit',
        action: 'DELETE',
        rows: 2,
        dateColumn: 'updatedAt',
      },
    });
    await db.jobRunDay.create({
      data: {
        key: 'photo-gc',
        day: dayUtc(Dm2, 0),
        runs: 1,
        failures: 0,
        firstAt: dayUtc(Dm2, 3),
        lastAt: dayUtc(Dm2, 3),
        maxDurationMs: 10,
        sources: ['vercel'],
      },
    });
    await db.rateLimit.create({ data: { key: `login:${sfx}`, tokens: 3 } });

    // The job runs: an old day (removed), and every scheduled run of D-1 and D (kept), so the
    // first nights' scheduled-jobs-on-time has what production will have. D+1 too: the reset
    // cuts the job runs by the DATABASE's clock, so if midnight in Oman passes between this
    // seeding and the reset, the reset's own day is D+1 and the two nights read D and D+1.
    // The suite must not depend on the hour it runs at (see resetOmanDay below).
    const runs: Prisma.CronRunCreateManyInput[] = [
      { key: 'photo-gc', at: dayUtc(Dm3, 3), ok: true, durationMs: 5 },
    ];
    for (const day of [Dm1, D, Dp1]) {
      for (const [key, exp] of Object.entries(HEARTBEAT_EXPECTATIONS)) {
        if (key === 'db-backup') continue;
        if (exp.activeHoursUtc) {
          for (
            let t = dayUtc(day, exp.activeHoursUtc[0], 1).getTime();
            t < dayUtc(day, exp.activeHoursUtc[1]).getTime();
            t += exp.everyMinutes * 60_000
          ) {
            runs.push({ key, at: new Date(t), ok: true, durationMs: 5 });
          }
        } else
          runs.push({
            key,
            at: dayUtc(day, key === 'integrity-watch' ? 2 : 3, 30),
            ok: true,
            durationMs: 5,
          });
      }
    }
    await db.cronRun.createMany({ data: runs });
    w.cronRunAts = runs.map((r) => new Date(r.at).getTime());
    for (const [key, exp] of Object.entries(HEARTBEAT_EXPECTATIONS)) {
      const lastRunAt =
        key === 'db-backup'
          ? new Date(now.getTime() - 3600_000)
          : exp.activeHoursUtc
            ? dayUtc(D, 14, 50)
            : dayUtc(D, key === 'integrity-watch' ? 2 : 3, 30);
      await db.cronHeartbeat.create({ data: { key, lastRunAt, lastOk: true, runs: 10 } });
    }

    // The test flags (owner's window), and the seal chain of the test period: two nights of the real watch.
    await inWindow(async (tx) => {
      await tx.user.update({ where: { id: w.testUser }, data: { isTest: true } });
      await tx.route.update({ where: { id: w.testRoute }, data: { isTest: true } });
      await tx.region.update({ where: { id: w.testRegion }, data: { isTest: true } });
      await tx.customer.update({ where: { id: cTest }, data: { isTest: true } });
    });
    const old = memoryStore();
    for (const day of [Dm2, Dm1])
      await runIntegrityWatch(db, {
        store: old,
        now: dayUtc(day, 2, 30),
        inAppAlerts: false,
        alert: async () => true,
        audience: async () => [],
      });
    w.oldSealKeys = [...old.objects.keys()];
  }

  // ── the run, in the order the workflow makes it ──────────────────────────

  let planId = '';
  let before: Record<string, number> = {};
  let kept: Record<string, string[]> = {};
  let prot: Awaited<ReturnType<typeof protection>>;
  const RUN = '424242';
  const vars = () => ({
    run_id: RUN,
    plan_id: planId,
    actor_username: w.actorName,
    expected_migrations: expectedMigrations(),
    commit: 'cf44e12',
    backup_key: 'db/2026-11-18T1530Z.sql.gz.age',
    backup_sha256: sha256('dump'),
  });

  it('the world is there: a seal chain of two, a counter, photos, requests in every state', async () => {
    const n = await counts();
    expect(n.SealRecord).toBe(2);
    expect(w.oldSealKeys).toHaveLength(2);
    expect(n.IntegrityCheckResult).toBeGreaterThan(20);
    expect(n.CodeSequence).toBe(1);
    expect(n.Attachment).toBe(w.keys.length);
    expect((await db.customerEdit.groupBy({ by: ['state'] })).length).toBe(5);
    for (const t of TABLES.EMPTY) expect(n[t], t).toBeGreaterThan(0);
    const holder = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "Route" r JOIN "User" o ON o."ownedRouteId" = r."id" WHERE o."createdAt" > r."createdAt"`;
    expect(holder[0]!.n).toBeGreaterThanOrEqual(1);
    // The 42nd migration's key is in use: an import batch acknowledged by a kept account.
    expect(await db.importBatch.count({ where: { shopNotChangedAckById: w.steward } })).toBe(1);
  });

  it('follow-up 1 (F2): before any clean start there is no moment, and the dashboard compares as before', async () => {
    expect(await readCleanStartAt(db)).toBeNull();
    const cleanStart = { ok: true as const, data: await readCleanStartAt(db) };
    for (const period of ['7d', '30d', '90d', '12m']) {
      expect(comparisonFor(parsePeriod({ period }, new Date()), cleanStart), period).toEqual({ kind: 'compare' });
    }
  });

  it('PLAN: read-only exports whose hashes are the ones the fingerprint binds', async () => {
    const out = join(tmp, 'plan1');
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    const r = plan(out);
    expect(r, r.out).toMatchObject({ code: 0 });
    expect(r.out.trim()).toBe('');
    const ids = planIds(out);
    expect(ids.plan_id).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(fileBytes(join(out, 'photo-keys.txt')))).toBe(ids.photo_keys_sha256);
    expect(sha256(fileBytes(join(out, 'seals.jsonl')))).toBe(ids.seals_sha256);
    expect(ids.migrations_sha256).toBe(expectedMigrations());
    const keys = readFileSync(join(out, 'photo-keys.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
    expect(keys).toEqual([...w.keys].sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1)));
    expect(
      readFileSync(join(out, 'seals.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)
    ).toHaveLength(2);
    const p = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8')) as Record<string, unknown>;
    expect(p.temixBatchMarkedLoaded).toBe(true);
    expect((p.oldChain as { genesis: boolean }).genesis).toBe(true);
    expect(p.photoKeysNotPhotoShaped).toBe(0);
    planId = ids.plan_id!;
  });

  it('a row changed between plan and apply: refused (CS013) and rolled back completely', async () => {
    const c = contextClient(db, { actorId: null, source: src.test('clean-start') });
    await c.user.update({ where: { id: w.manager }, data: { fullName: 'ZZ Manager renamed' } });
    const n0 = await counts();
    const k0 = await keptRows();
    const r = reset(vars());
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/ERROR:\s+CS013/);
    expect(r.out).not.toMatch(/reset committed/);
    expect(await counts()).toEqual(n0);
    expect(await keptRows()).toEqual(k0);
    // Re-planned, the new state is the plan.
    const out = join(tmp, 'plan2');
    mkdirSync(out);
    expect(plan(out).code).toBe(0);
    const id2 = planIds(out).plan_id!;
    expect(id2).not.toBe(planId);
    planId = id2;
  });

  it('refuses a wrong host, a missing confirmation, and production for a rehearsal', () => {
    const today = omanDateISO(new Date());
    // Built from the shared list (no marker is written in a code file); never connected to.
    const fakeProd = `postgresql://u:p@${PRODUCTION_HOST_PREFIX}-zz0000.eu-central-1.aws.neon.tech/neondb`;
    const prod = PRODUCTION_HOST_PREFIX;
    // apply on a host that is not production
    let r = reset(vars(), scratchUrl, 'apply', {
      CONFIRM_HOST: prod,
      CONFIRM_PHRASE: `REMOVE ALL TEST DATA ${today}`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not on the production host list/);
    // apply on production without confirm_host, with a wrong phrase, with yesterday's phrase
    r = reset(vars(), fakeProd, 'apply', { CONFIRM_PHRASE: `REMOVE ALL TEST DATA ${today}` });
    expect([r.code, /confirm_host is empty/.test(r.out)]).toEqual([1, true]);
    r = reset(vars(), fakeProd, 'apply', { CONFIRM_HOST: prod });
    expect([r.code, /confirm_phrase/.test(r.out)]).toEqual([1, true]);
    r = reset(vars(), fakeProd, 'apply', {
      CONFIRM_HOST: prod,
      CONFIRM_PHRASE: `REMOVE ALL TEST DATA ${addDays(today, -1)}`,
    });
    expect(r.code).toBe(1);
    r = reset(vars(), fakeProd, 'apply', {
      CONFIRM_HOST: 'ep-other',
      CONFIRM_PHRASE: `REMOVE ALL TEST DATA ${today}`,
    });
    expect(r.code).toBe(1);
    // the guard alone (nothing is run after it): production, named, with today's phrase, passes
    const alone = run(`bash ${DIR}/target-guard.sh apply`, {
      DIRECT_URL: fakeProd,
      CONFIRM_HOST: prod,
      CONFIRM_PHRASE: `REMOVE ALL TEST DATA ${today}`,
      PROD_DB_HOST_MARKER: prod,
    });
    expect(alone, alone.out).toMatchObject({ code: 0 });
    // a rehearsal never runs on production, the marker anywhere in the string
    r = reset(vars(), fakeProd, 'rehearse');
    expect([r.code, /PRODUCTION/.test(r.out)]).toEqual([1, true]);
    r = reset(vars(), `${scratchUrl}?host=${prod.replace(/-/g, '%2D')}-zz0000`, 'rehearse');
    expect(r.code).toBe(1);
    // and the watch rehearsal refuses production through the shared guard
    expect(() => rehearsalTarget(fakeProd)).toThrow();
  });

  it('the runtime role cannot run it', async () => {
    const n0 = await counts();
    const r = reset(vars(), appUrl);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/ERROR:\s+(42501|CS002)/);
    expect(await counts()).toEqual(n0);
  });

  // ── refusals, each on a fresh TEMPLATE copy of the planned database ─────
  // (review 2026-11-11: no guard, self-check or verify check may silently become a no-op)

  /** A fresh copy of the scratch database as it is now; `db` is reconnected afterwards. */
  const copyOf = async (tag: string) => {
    const name = `${scratchDb}_${tag}`;
    await db.$disconnect();
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${scratchDb}"`);
    } finally {
      db = new PrismaClient({ datasourceUrl: assertNotProduction(scratchUrl, []) });
    }
    copies.push(name);
    const u = new URL(scratchUrl);
    u.pathname = `/${name}`;
    return assertNotProduction(u.toString(), []);
  };
  const dropCopy = async (url: string) => {
    const name = new URL(url).pathname.slice(1);
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  };
  /** SQL as the suite's owner login on a copy (never production: assertNotProduction above). */
  const sqlOn = (url: string, sql: string): Run =>
    run(`psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -c "$CS_SQL"`, { DIRECT_URL: url, CS_SQL: sql });
  const planOn = (url: string, extra: Record<string, string> = {}): Run => {
    const out = mkdtempSync(join(tmp, 'p-'));
    const v = { actor_username: w.actorName, expected_migrations: expectedMigrations(), ...extra };
    return run(
      `PGOPTIONS='-c default_transaction_read_only=on' psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f ${DIR}/plan.sql -v out_dir='${out}' ${Object.entries(
        v
      )
        .map(([k, x]) => `-v ${k}='${x}'`)
        .join(' ')}`,
      { DIRECT_URL: url }
    );
  };
  const tableCounts = (url: string) =>
    run(
      `psql "$DIRECT_URL" -X -q -At -c "SELECT string_agg(c.relname || '=' || (xpath('/table/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, false, '')))[1]::text, ',' ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'"`,
      { DIRECT_URL: url }
    ).out.trim();

  it('an unchanged copy plans to the same plan id (the control for the cases below)', async () => {
    const url = await copyOf('ctl');
    const out = mkdtempSync(join(tmp, 'ctl-'));
    const r = run(
      `PGOPTIONS='-c default_transaction_read_only=on' psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f ${DIR}/plan.sql -v out_dir='${out}' -v actor_username='${w.actorName}' -v expected_migrations='${expectedMigrations()}'`,
      { DIRECT_URL: url }
    );
    expect(r, r.out).toMatchObject({ code: 0 });
    expect(planIds(out).plan_id).toBe(planId);
    await dropCopy(url);
  });

  it.each([
    [
      'a new photo record',
      `INSERT INTO "Attachment" SELECT (jsonb_populate_record(NULL::"Attachment", to_jsonb(a) || jsonb_build_object('id', 'zz-cs-new', 'r2Key', a."r2Key" || '.x'))).* FROM "Attachment" a ORDER BY a."id" LIMIT 1`,
    ],
    ['a customer-code counter moved on', `UPDATE "CodeSequence" SET "next" = "next" + 1`],
    ['a request record touched', `UPDATE "CustomerEdit" SET "updatedAt" = "updatedAt" + interval '1 second' WHERE "id" = (SELECT max("id") FROM "CustomerEdit")`],
  ])('between plan and apply, %s: CS013, and the copy is unchanged afterwards', async (_label, change) => {
    const url = await copyOf(`c13${copies.length}`);
    const ch = sqlOn(url, change);
    expect(ch, ch.out).toMatchObject({ code: 0 });
    const n0 = tableCounts(url);
    const r = reset(vars(), url);
    expect(r.code, r.out).toBe(3);
    expect(r.out).toMatch(/ERROR:\s+CS013/);
    expect(r.out).not.toMatch(/reset committed/);
    expect(tableCounts(url)).toBe(n0);
    await dropCopy(url);
  });

  it('a new customer between plan and apply: CS013', async () => {
    const url = await copyOf('c13cust');
    const ch = sqlOn(
      url,
      `INSERT INTO "Customer" SELECT (jsonb_populate_record(NULL::"Customer", to_jsonb(c) || jsonb_build_object('id', 'zz-cs-cust', 'nmwcCode', 'NMWC-1999-999999', 'temixCode', NULL, 'importRowId', NULL, 'crPhotoId', NULL))).* FROM "Customer" c WHERE c."isTest" = false ORDER BY c."id" LIMIT 1`
    );
    expect(ch, ch.out).toMatchObject({ code: 0 });
    const r = reset(vars(), url);
    expect([r.code, /ERROR:\s+CS013/.test(r.out)], r.out).toEqual([3, true]);
    await dropCopy(url);
  });

  it('a write that commits while the reset WAITS for its locks is refused (CS013), whatever isolation level the login defaults to', async () => {
    // Review 2026-11-15: reset.sql began with a bare BEGIN. Under a role or database
    // default of REPEATABLE READ its snapshot is taken by its first SELECT, before the
    // LOCK; a writer the LOCK waited for was then invisible to the plan check, and the
    // TRUNCATE removed a row that is in neither the plan nor the backup. Here: this
    // session's default is REPEATABLE READ, and a customer is committed during the wait.
    // Deterministic (review 2026-11-15): the writer commits only once pg_stat_activity
    // shows the reset's backend WAITING on a lock, never after a fixed sleep (on a slow
    // runner the reset could start after the commit, and the old reset.sql then passed).
    const url = await copyOf('iso');
    const writer = new PrismaClient({ datasourceUrl: url });
    const watcher = new PrismaClient({ datasourceUrl: url });
    let inserted!: () => void;
    const hasInserted = new Promise<void>((ok) => (inserted = ok));
    let release!: () => void;
    const released = new Promise<void>((ok) => (release = ok));
    try {
      const held = writer.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO "Customer" SELECT (jsonb_populate_record(NULL::"Customer", to_jsonb(c) || jsonb_build_object('id', 'zz-cs-late', 'nmwcCode', 'NMWC-1999-999998', 'temixCode', NULL, 'importRowId', NULL, 'crPhotoId', NULL))).* FROM "Customer" c WHERE c."isTest" = false ORDER BY c."id" LIMIT 1`
          );
          inserted();
          // Holds its row lock until the reset is seen waiting for its locks.
          await released;
        },
        { timeout: 150_000, maxWait: 10_000 }
      );
      await hasInserted;
      const writerPid = await watcher.$queryRawUnsafe<{ pid: number }[]>(
        `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`
      );
      expect(writerPid, 'the writer holds its open transaction').toHaveLength(1);
      const v = Object.entries(vars())
        .map(([k, x]) => `-v ${k}='${x}'`)
        .join(' ');
      let resetDone = false;
      const resetRun = runAsync(
        `bash ${DIR}/target-guard.sh rehearse && PGOPTIONS='-c default_transaction_isolation=repeatable\\ read' psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f ${DIR}/reset.sql ${v}`,
        { DIRECT_URL: url }
      ).finally(() => (resetDone = true));
      let sawWait = false;
      const deadline = Date.now() + 120_000;
      while (!resetDone && Date.now() < deadline) {
        const w = await watcher.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND ${Number(writerPid[0]!.pid)} = ANY(pg_blocking_pids(pid))`
        );
        if (Number(w[0]!.n) > 0) {
          sawWait = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      release();
      await held;
      const r = await resetRun;
      expect(sawWait, `the reset was seen waiting on a lock before the writer committed\n${r.out}`).toBe(true);
      expect(r.code, r.out).toBe(3);
      expect(r.out).toMatch(/ERROR:\s+CS013/);
      expect(r.out).not.toMatch(/reset committed/);
    } finally {
      release();
      await writer.$disconnect();
      await watcher.$disconnect();
    }
    // Nothing was removed: the late customer and everything else is still there, no reset row.
    const left = run(
      `psql "$DIRECT_URL" -X -q -At -c "SELECT (SELECT count(*) FROM \\"Customer\\" WHERE id = 'zz-cs-late') || ' ' || (SELECT count(*) FROM \\"AuditLog\\" WHERE id LIKE 'cleanstart-%') || ' ' || (SELECT count(*) > 1 FROM \\"Customer\\")"`,
      { DIRECT_URL: url }
    ).out.trim();
    expect(left).toBe('1 0 true');
    await dropCopy(url);
  });

  it.each([
    ['CS001', 'an extra table in public', `CREATE TABLE public.zz_extra (x int)`, {}],
    [
      'CS004',
      'a trigger disabled',
      `DO $$ DECLARE t record; BEGIN SELECT c.relname, g.tgname INTO t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND c.relnamespace = 'public'::regnamespace ORDER BY 1, 2 LIMIT 1; EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', t.relname, t.tgname); END $$`,
      {},
    ],
    [
      'CS006',
      'a migration that failed and was never resolved (unfinished, not marked rolled back)',
      `INSERT INTO public._prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count) VALUES ('zz-cs-failed', repeat('a', 64), '20990101000000_zz_cs_failed', now(), 0)`,
      {},
    ],
    ['CS007', 'migrations that are not the checkout', null, { expected_migrations: '0'.repeat(64) }],
    [
      'CS007',
      'a migration marked rolled back and never applied again',
      `UPDATE public._prisma_migrations SET rolled_back_at = now() WHERE migration_name = (SELECT max(migration_name) FROM public._prisma_migrations)`,
      {},
    ],
    [
      'CS007',
      'a migration recorded as applied twice',
      `INSERT INTO public._prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count) SELECT 'zz-cs-twice', m.checksum, m.migration_name, m.started_at + interval '1 minute', now(), 1 FROM public._prisma_migrations m ORDER BY m.migration_name LIMIT 1`,
      {},
    ],
    ['CS009', 'an export file key set', `BEGIN; SET LOCAL nmwc.audit_maintenance = 'on'; UPDATE "ExportJob" SET "r2Key" = 'exports/zz.csv' WHERE "id" = (SELECT min("id") FROM "ExportJob"); COMMIT`, {}],
    ['CS011', 'an unknown actor', null, { actor_username: 'zz.nobody.at.all' }],
  ] as const)('PLAN refuses %s: %s', async (code, _label, change, extra) => {
    const url = await copyOf(`${code.toLowerCase()}n${copies.length}`);
    if (change) {
      const ch = sqlOn(url, change);
      expect(ch, ch.out).toMatchObject({ code: 0 });
    }
    const r = planOn(url, extra as Record<string, string>);
    expect(r.code, r.out).toBe(3);
    expect(r.out).toMatch(new RegExp(`ERROR:\\s+${code}`));
    await dropCopy(url);
  });

  it('a migration that once failed, was marked rolled back and then applied (what `migrate resolve --rolled-back` leaves for ever) is history: PLAN passes and the reset commits', async () => {
    // Review 2026-11-15: CS006 refused ANY rolled-back row and CS007 hashed every row, so a
    // database repaired once as docs/OPERATIONS.md section 5 says could never be planned.
    const url = await copyOf('mighist');
    // The failed attempt's row: before the applied one, unfinished, marked rolled back, and
    // with the checksum of the file as it was then.
    const ch = sqlOn(
      url,
      `INSERT INTO public._prisma_migrations (id, checksum, migration_name, logs, started_at, rolled_back_at, applied_steps_count) SELECT 'zz-cs-rolled-back', repeat('b', 64), m.migration_name, 'lock timeout', m.started_at - interval '1 hour', m.started_at - interval '30 minutes', 0 FROM public._prisma_migrations m ORDER BY m.migration_name DESC LIMIT 1`
    );
    expect(ch, ch.out).toMatchObject({ code: 0 });
    const out = mkdtempSync(join(tmp, 'mh-'));
    const p = run(
      `PGOPTIONS='-c default_transaction_read_only=on' psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f ${DIR}/plan.sql -v out_dir='${out}' -v actor_username='${w.actorName}' -v expected_migrations='${expectedMigrations()}'`,
      { DIRECT_URL: url }
    );
    expect(p, p.out).toMatchObject({ code: 0 });
    const ids = planIds(out);
    // What is APPLIED is still exactly the checkout's; the ledger itself differs, so the plan id does.
    expect(ids.migrations_sha256).toBe(expectedMigrations());
    expect(ids.plan_id).toMatch(/^[0-9a-f]{64}$/);
    expect(ids.plan_id).not.toBe(planId);
    // The same guards run again under the reset's locks.
    const r = reset({ ...vars(), plan_id: ids.plan_id! }, url);
    expect(r, r.out).toMatchObject({ code: 0 });
    expect(r.out).toMatch(/clean-start: reset committed/);
    const v = run(`psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -v run_id=${RUN} -f ${DIR}/verify.sql`, { DIRECT_URL: url });
    expect(v, v.out).toMatchObject({ code: 0 });
    await dropCopy(url);
  });

  it('PLAN refuses a test-flagged actor (CS011)', async () => {
    const [u] = await db.$queryRaw<Array<{ username: string }>>`SELECT "username" FROM "User" WHERE "id" = ${w.testUser}`;
    const url = await copyOf('cs011t');
    const r = planOn(url, { actor_username: u!.username });
    expect([r.code, /ERROR:\s+CS011/.test(r.out)], r.out).toEqual([3, true]);
    await dropCopy(url);
  });

  it('the self-check catches a kept table changed inside the reset (CS106), and a kept account changed (a history row, CS102); both roll back', async () => {
    // A copy of the scripts with ONE extra statement just before the self-check.
    const cs = join(tmp, 'cs-mutated');
    for (const [tag, stmt, code] of [
      ['ch', `UPDATE public."Channel" SET "label" = "label" || ' x' WHERE "id" = (SELECT min("id") FROM public."Channel");`, 'CS106'],
      ['us', `UPDATE public."User" SET "fullName" = "fullName" || ' x' WHERE "id" = '${w.manager}';`, 'CS102'],
    ] as const) {
      rmSync(cs, { recursive: true, force: true });
      mkdirSync(cs);
      for (const f of readdirSync(DIR)) if (f.endsWith('.sql') || f.endsWith('.json')) {
        writeFileSync(join(cs, f), readFileSync(join(DIR, f)));
      }
      const resetSql = readFileSync(join(DIR, 'reset.sql'), 'utf8');
      const at = resetSql.indexOf('\\ir selfcheck.sql');
      expect(at).toBeGreaterThan(0);
      writeFileSync(join(cs, 'reset.sql'), `${resetSql.slice(0, at)}${stmt}\n${resetSql.slice(at)}`);
      const url = await copyOf(`sc${tag}`);
      const n0 = tableCounts(url);
      const v = Object.entries(vars())
        .map(([k, x]) => `-v ${k}='${x}'`)
        .join(' ');
      const r = run(
        `bash ${DIR}/target-guard.sh rehearse && psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f '${join(cs, 'reset.sql')}' ${v}`,
        { DIRECT_URL: url }
      );
      expect(r.code, r.out).toBe(3);
      expect(r.out).toMatch(new RegExp(`ERROR:\\s+${code}`));
      expect(r.out).not.toMatch(/reset committed/);
      expect(tableCounts(url)).toBe(n0);
      await dropCopy(url);
    }
  });

  it('RESET: one transaction, committed, and nothing but the reset line in the log', async () => {
    before = await counts();
    kept = await keptRows();
    prot = await protection();
    const t0 = Date.now();
    const r = reset(vars());
    const ms = Date.now() - t0;
    expect(r, r.out).toMatchObject({ code: 0 });
    expect(r.out.trim().split(/\r?\n/)).toEqual([
      'clean-start target guard: rehearsal target is not production: yes',
      'clean-start: reset committed',
    ]);
    console.log(`[clean-start] reset.sql took ${ms} ms`);
  });

  it('VERIFY passes', () => {
    const r = run(
      `psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -v run_id=${RUN} -f ${DIR}/verify.sql`,
      { DIRECT_URL: scratchUrl }
    );
    expect(r, r.out).toMatchObject({ code: 0 });
    expect(r.out.trim()).toBe('clean-start: verify ok');
    const wrong = run(
      `psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -v run_id=999 -f ${DIR}/verify.sql`,
      { DIRECT_URL: scratchUrl }
    );
    expect([wrong.code, /CS301/.test(wrong.out)]).toEqual([3, true]);
  });

  it('every emptied table is empty, but the one reset row and the baselines', async () => {
    const n = await counts();
    for (const t of TABLES.EMPTY) {
      if (t === 'AuditLog') expect(n[t]).toBe(1);
      else if (t === 'RegionHistory') expect(n[t]).toBe(n.Region);
      else if (t === 'RouteHistory') expect(n[t]).toBe(n.Route);
      else if (t === 'UserHistory') expect(n[t]).toBe(n.User);
      else if (t === 'RouteOwnerHistory') expect(n[t]).toBeGreaterThan(n.Route!);
      else expect(n[t], t).toBe(0);
    }
    const [row] = await db.$queryRaw<
      Array<{
        id: string;
        actorId: string;
        source: string;
        action: string;
        after: Record<string, unknown>;
      }>
    >`
      SELECT "id", "actorId", "source", "action"::text AS action, "after" FROM "AuditLog"`;
    expect(row).toMatchObject({
      id: `cleanstart-${RUN}`,
      actorId: w.actor,
      source: `script:clean-start:${RUN}`,
      action: 'DELETE',
    });
    expect((row!.after.removed as Record<string, number>).Customer).toBe(before.Customer);
    expect((row!.after.kept as Record<string, number>).User).toBe(before.User);
    expect((row!.after.oldChain as { chain: string }).chain).toMatch(/^[0-9a-f]{16}$/);
    expect(row!.after.planId).toBe(planId);
    // The baselines and the reset row share one transaction and carry the run.
    const tx = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(DISTINCT x."txId")::int AS n FROM (
        SELECT "txId" FROM "AuditLog" UNION ALL SELECT "txId" FROM "UserHistory" UNION ALL SELECT "txId" FROM "RouteHistory"
        UNION ALL SELECT "txId" FROM "RegionHistory" UNION ALL SELECT "txId" FROM "RouteOwnerHistory") x`;
    expect(tx[0]!.n).toBe(1);
    const kinds = await db.$queryRaw<
      Array<{ k: string }>
    >`SELECT DISTINCT "sourceKind" AS k FROM "UserHistory"`;
    expect(kinds).toEqual([{ k: 'script' }]);
  });

  it('follow-up 1 (F1): the Audit page’s data layer returns the reset row, with every count as the tables were', async () => {
    // The Steward's default list, exactly as app/(app)/audit/page.tsx reads it.
    const { total, logs } = await listAuditRows(db, { action: null, q: null }, 1);
    expect(total).toBe(1);
    const row = logs.find((l) => isCleanStartRecord(l));
    expect(row?.id).toBe(`cleanstart-${RUN}`);
    const rows = cleanStartCounts(row!.after)!;
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
    const now = await counts();
    for (const t of TABLES.EMPTY) {
      expect(by[t], t).toEqual({ kind: t, label: CLEAN_START_KIND_LABELS[t], removed: before[t], kept: null });
    }
    for (const t of TABLES.KEEP) {
      expect(by[t], t).toEqual({ kind: t, label: CLEAN_START_KIND_LABELS[t], removed: null, kept: before[t] });
    }
    for (const t of ['CodeSequence', 'CronRun']) {
      expect(by[t]!.kept, t).toBe(now[t]);
      expect(by[t]!.removed, t).toBe(before[t]! - now[t]!);
      expect(by[t]!.removed, t).toBeGreaterThan(0);
    }
    // Every kind the record holds is one the page has words for, and every figure is there.
    expect(rows).toHaveLength(TABLES.EMPTY.length + TABLES.KEEP.length + 2);
    expect(rows.every((r) => r.label !== r.kind && (r.removed !== null || r.kept !== null))).toBe(true);
  });

  it('follow-up 1 (F2): the clean start’s moment is its record’s, and a comparison reaching back before it is not drawn', async () => {
    const [row] = await db.auditLog.findMany({ select: { at: true } });
    // Read as the dashboard reads it: inside a transaction (lib/insights/load.ts loadCleanStart).
    const at = await db.$transaction((tx) => readCleanStartAt(tx));
    expect(at?.toISOString()).toBe(row!.at.toISOString());
    const cleanStart = { ok: true as const, data: at };
    // Today: every preset's period before starts before the reset.
    for (const period of ['7d', '30d', '90d', '12m']) {
      expect(comparisonFor(parsePeriod({ period }, new Date()), cleanStart), period).toEqual({
        kind: 'no-earlier-data',
        cleanStartAt: at,
      });
    }
    // Five weeks on, the 7 days and the 7 before them are both after it: compared as before.
    const later = new Date(at!.getTime() + 35 * 86_400_000);
    expect(comparisonFor(parsePeriod({ period: '7d' }, later), cleanStart)).toEqual({ kind: 'compare' });
    expect(comparisonFor(parsePeriod({ period: '30d' }, later), cleanStart).kind).toBe('no-earlier-data');
    // A row the app writes later, alike but for its id and source, does not move the
    // moment (rolled back, so the suites after this one see the reset's log as it is).
    const ROLLBACK = new Error('rollback');
    let seen: Date | null = null;
    await expect(
      db.$transaction(async (tx) => {
        await tx.auditLog.create({
          data: { actorId: w.steward, action: 'DELETE', entityType: 'System', entityId: 'clean-start', reason: 'not the reset' },
        });
        seen = await readCleanStartAt(tx);
        throw ROLLBACK;
      })
    ).rejects.toBe(ROLLBACK);
    expect((seen as Date | null)?.toISOString()).toBe(at!.toISOString());
    expect(await db.auditLog.count()).toBe(1);
  });

  it('the kept tables are byte-identical: accounts with their password hashes, history of passwords, regions, routes, manager links, channels', async () => {
    expect(await keptRows()).toEqual(kept);
  });

  /**
   * The reset's own Oman day, by the DATABASE's clock (reset.sql cut the job runs by it):
   * the day the suite started, or the next one if midnight in Oman passed meanwhile.
   */
  const resetOmanDay = async () => {
    const [r] = await db.$queryRaw<Array<{ day: string }>>`
      SELECT to_char(a."at" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Muscat', 'YYYY-MM-DD') AS day
        FROM "AuditLog" a WHERE a."id" = ${`cleanstart-${RUN}`}`;
    expect([D, Dp1]).toContain(r!.day);
    return r!.day;
  };

  it('job runs: the Oman day before and the reset day kept, older ones gone', async () => {
    const R = await resetOmanDay();
    const cut = dayUtc(addDays(R, -1), 0).getTime() - 4 * 3600_000;
    expect(await db.cronRun.count({ where: { at: { lt: new Date(cut) } } })).toBe(0);
    const keptRuns = w.cronRunAts.filter((t) => t >= cut).length;
    expect(await db.cronRun.count()).toBe(keptRuns);
    expect(keptRuns).toBeLessThan(before.CronRun!);
    // On the day the suite started: every seeded run but the one old one.
    if (R === D) expect(keptRuns).toBe(before.CronRun! - 1);
  });

  it('the counter gives NMWC-<year>-000001 next, and no sequence went back', async () => {
    expect(await db.codeSequence.count()).toBe(0);
    const next = await db
      .$transaction(async (tx) => {
        const [r] = await tx.$queryRaw<Array<{ next: number }>>`
          INSERT INTO "CodeSequence" ("scope", "next") VALUES (${`CUSTOMER-${year}`}, 2)
          ON CONFLICT ("scope") DO UPDATE SET "next" = "CodeSequence"."next" + 1 RETURNING "next"`;
        throw Object.assign(new Error('rollback'), { next: Number(r!.next) });
      })
      .catch((e: { next?: number }) => e.next);
    expect(next).toBe(2);
    expect(formatCustomerCode(year, next! - 1)).toBe(`NMWC-${year}-000001`);
    expect(await db.codeSequence.count()).toBe(0);
    const after = await protection();
    const was = new Map(prot.sequences.map((s) => [s.s, BigInt(s.v ?? '0')]));
    for (const s of after.sequences)
      expect(BigInt(s.v ?? '0') >= (was.get(s.s) ?? 0n), s.s).toBe(true);
  });

  it('no trigger off, no function changed; history-open-interval and history-matches-master pass', async () => {
    const after = await protection();
    expect(after.triggers).toEqual(prot.triggers);
    expect(after.functions).toEqual(prot.functions);
    for (const id of [
      'history-open-interval',
      'history-matches-master',
      'protection-triggers',
      'protection-functions',
    ]) {
      const out = await CHECK_BY_ID.get(id)!.run!(db, { now: new Date(), previous: new Map() });
      expect(out.count, id).toBe(0);
    }
  });

  it('a second run is refused (the reset is recorded; the state is no longer the plan)', async () => {
    const n0 = await counts();
    const r = reset(vars());
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/ERROR:\s+CS01[23]/);
    expect(await counts()).toEqual(n0);
  });

  // ── the first two nights of the watch ───────────────────────────────────
  // Every clock below is INJECTED: night 1 is an instant of the reset's own Oman day (R,
  // by the database's clock), never "now". Until the review of 2026-11-15 these tests
  // read the real clock, and between 20:00 and 02:30 UTC (00:00-06:30 in Oman) the
  // rehearsal's night 2 fell on night 1's own Oman day: no second seal, no day of job
  // runs, and still "as expected". The pure rules, minute by minute, are in
  // tests/unit/clean-start-watch-clock.test.ts; here the REAL watch runs through the day.

  /** The just-reset database, copied before any watch ran on it; never connected to. */
  let justReset = '';
  /** One throw-away copy of the just-reset database (the watch writes seals and results). */
  const onResetCopy = async <T>(tag: string, fn: (client: PrismaClient) => Promise<T>): Promise<T> => {
    const name = `${scratchDb}_${tag}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${justReset}"`);
    copies.push(name);
    const u = new URL(scratchUrl);
    u.pathname = `/${name}`;
    const client = new PrismaClient({ datasourceUrl: assertNotProduction(u.toString(), []) });
    try {
      return await fn(client);
    } finally {
      await client.$disconnect();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  };
  /** What a rehearsal left behind: the seals, and the days each night's job check read. */
  const nightsOf = async (client: PrismaClient) => ({
    seals: await client.$queryRaw<Array<{ seq: number; day: string; prevHash: string | null; hash: string }>>`
      SELECT "seq", "day"::text AS day, "prevHash", "hash" FROM "SealRecord" ORDER BY "seq"`,
    jobDays: (
      await client.$queryRaw<Array<{ days: string[] }>>`
        SELECT "detail" -> 'days' AS days FROM "IntegrityCheckResult"
         WHERE "checkId" = 'scheduled-jobs-on-time' ORDER BY "runAt"`
    ).map((x) => x.days),
  });

  it('the watch at EVERY hour of the reset day (injected clocks): a first seal, the first chained seal the next Oman morning, a day of job runs read each night', async () => {
    const R = await resetOmanDay();
    const [Rm1, Rp1] = [addDays(R, -1), addDays(R, 1)];
    // The schedulers' heartbeats as they will be on the reset evening. They were seeded as
    // of the day the suite started; if the reset's day is the next one (midnight in Oman
    // passed meanwhile), the schedulers have run a day more by then. (CronHeartbeat is a
    // kept table: its byte-identity through the reset is asserted above, before this.)
    if (R !== D)
      await db.$executeRaw`UPDATE "CronHeartbeat" SET "lastRunAt" = "lastRunAt" + interval '1 day' WHERE "key" <> 'db-backup'`;
    justReset = new URL(await copyOf('rst')).pathname.slice(1);

    // Night 1 at every UTC hour of Oman day R (20:00 the evening before to 19:59), and
    // each side of the rules' boundaries: 02:30 UTC (that morning's own watch), 15:00 UTC
    // (the day's last windowed job run), 20:00 UTC (midnight in Oman).
    const at = (h: number, m = 0) => (h >= 20 ? dayUtc(Rm1, h, m) : dayUtc(R, h, m));
    const instants = [
      ...Array.from({ length: 24 }, (_, h) => at(h)),
      at(23, 59),
      at(2, 29),
      at(2, 30),
      at(14, 59),
      at(15, 30),
      at(19, 59),
    ].sort((a, b) => a.getTime() - b.getTime());
    expect(new Set(instants.map((t) => t.getUTCHours())).size).toBe(24);
    expect(new Set(instants.map((t) => omanDateISO(t)))).toEqual(new Set([R]));

    const jobDayComplete = dayUtc(R, 15).getTime();
    for (const [i, t] of instants.entries()) {
      const label = t.toISOString();
      await onResetCopy(`w${i}`, async (client) => {
        // The copy is "taken" at night 1's time: the 15:00 UTC rule follows it (no real clock).
        const r = await rehearseWatch(client, runIntegrityWatch, { now: t });
        expect(r.mismatches, label).toEqual([]);
        expect(r.ok, label).toBe(true);
        expect(r.nights.map((n) => n.at), label).toEqual([label, `${Rp1}T02:30:00.000Z`]);
        expect(r.nights[1]!.at, label).toBe(nextOmanMorning(t).toISOString());
        expect(r.nights.map((n) => n.statuses['seal-written']), label).toEqual(['info', 'pass']);
        // Night 2 reads the reset day's job runs. This database holds them all, so the
        // check passes at every hour; the rehearsal ASSERTS it only when a real copy
        // taken at night 1's time could hold them (from 15:00 UTC of day R).
        expect(['pass', 'info'], label).toContain(r.nights[1]!.statuses['scheduled-jobs-on-time']);
        expect(r.nights[0]!.notAsserted, label).toEqual([]);
        expect(r.nights[1]!.notAsserted, label).toEqual(
          t.getTime() >= jobDayComplete ? [] : ['scheduled-jobs-on-time']
        );
        const left = await nightsOf(client);
        // Two seals, one per Oman day, the second chained to the first: never "already".
        expect(left.seals.map((s) => [s.seq, s.day]), label).toEqual([
          [0, R],
          [1, Rp1],
        ]);
        expect(left.seals[0]!.prevHash, label).toBeNull();
        expect(left.seals[1]!.prevHash, label).toBe(left.seals[0]!.hash);
        // Each night's job check read one whole Oman day: never an empty list.
        expect(left.jobDays, label).toEqual([[Rm1], [R]]);
      });
    }
  });

  it('the first two nights of the integrity watch are as the design expects, with and without foreign seals', async () => {
    const R = await resetOmanDay();
    expect(justReset).not.toBe('');
    // The planned evening: 19:30 in Oman on the reset day.
    const evening = dayUtc(R, 15, 30);
    const r = await rehearseWatch(db, runIntegrityWatch, { now: evening, assertJobsOnNight2: true });
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.nights.map((n) => n.statuses['seal-written'])).toEqual(['info', 'pass']);
    expect(r.nights[1]!.at).toBe(nextOmanMorning(new Date(r.nights[0]!.at)).toISOString());
    expect(r.nights[1]!.at).toBe(`${addDays(R, 1)}T02:30:00.000Z`);
    const seals = await db.sealRecord.findMany({
      orderBy: { seq: 'asc' },
      select: { seq: true, prevHash: true },
    });
    expect(seals.map((s) => s.seq)).toEqual([0, 1]);

    // The old chain's copies left in seals/: reported once as new (critical), then
    // information. In the planned evening, and for a run that slipped past midnight in Oman.
    for (const [tag, night1] of [
      ['fk', evening],
      ['fkl', dayUtc(addDays(R, -1), 21, 15)],
    ] as const) {
      await onResetCopy(tag, async (other) => {
        const r2 = await rehearseWatch(other, runIntegrityWatch, {
          now: night1,
          foreignKeys: w.oldSealKeys,
          assertJobsOnNight2: true,
        });
        expect(r2.mismatches, tag).toEqual([]);
        expect(r2.nights.map((n) => n.statuses['seal-offsite-copies']), tag).toEqual(['fail', 'info']);
        expect((await nightsOf(other)).seals.map((s) => s.seq), tag).toEqual([0, 1]);
      });
    }
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${justReset}" WITH (FORCE)`);
  });

  it('VERIFY after the CRM was used: the full check refuses (CS306), mode finish (scope=finish) still settles "committed" and passes', async () => {
    const url = await copyOf('used');
    const ch = sqlOn(url, `INSERT INTO "CodeSequence" ("scope", "next") VALUES ('CUSTOMER-${year}', 2)`);
    expect(ch, ch.out).toMatchObject({ code: 0 });
    const full = run(`psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -v run_id=${RUN} -f ${DIR}/verify.sql`, {
      DIRECT_URL: url,
    });
    expect([full.code, /ERROR:\s+CS306/.test(full.out)], full.out).toEqual([3, true]);
    const fin = run(
      `psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -v run_id=${RUN} -v scope=finish -f ${DIR}/verify.sql`,
      { DIRECT_URL: url }
    );
    expect(fin, fin.out).toMatchObject({ code: 0 });
    expect(fin.out.trim()).toBe('clean-start: verify ok');
    // and finish still answers "not committed" for another run's id
    const other = run(
      `psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -v run_id=999 -v scope=finish -f ${DIR}/verify.sql`,
      { DIRECT_URL: url }
    );
    expect([other.code, /CS301/.test(other.out)]).toEqual([3, true]);
    await dropCopy(url);
  });

  it('PHOTOS record: a red delete step is recorded as NOT complete, never as "deleted"; a re-run attempt gets its own row', async () => {
    const url = await copyOf('photos');
    const sum = run(
      `psql "$DIRECT_URL" -X -q -At -c "SELECT a.\\"after\\" ->> 'photoKeysSha256' FROM \\"AuditLog\\" a WHERE a.id = 'cleanstart-${RUN}'"`,
      { DIRECT_URL: url }
    ).out.trim();
    expect(sum).toMatch(/^[0-9a-f]{64}$/);
    const record = (runId: string, complete: string, deleted: number, attempt = '1') =>
      run(
        `psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f ${DIR}/photos-record.sql -v run_id=${runId} -v reset_run_id=${RUN} ` +
          `-v actor_username='${w.actorName}' -v list_sha256=${sum} -v listed=10 -v skipped_shape=1 -v skipped_uat=1 -v deleted=${deleted} -v complete=${complete} -v attempt=${attempt}`,
        { DIRECT_URL: url }
      );
    expect(record('801', 'yes', 8), 'complete').toMatchObject({ code: 0 });
    expect(record('802', 'no', 3), 'partial').toMatchObject({ code: 0 });
    // "Re-run failed jobs" keeps the run id: attempt 2 gets its own row, not a 23505.
    expect(record('802', 'yes', 5, '2'), 'attempt 2').toMatchObject({ code: 0 });
    const again = record('802', 'yes', 5, '2');
    expect([again.code, /23505/.test(again.out)]).toEqual([3, true]);
    for (const [complete, attempt] of [['maybe', '1'], ['yes', '0'], ['yes', 'x']]) {
      const bad = record('803', complete!, 3, attempt);
      expect([bad.code, /CS401/.test(bad.out)], `${complete} ${attempt}`).toEqual([3, true]);
    }
    const rows = run(
      `psql "$DIRECT_URL" -X -q -At -F '|' -c "SELECT id, reason, \\"after\\" ->> 'complete', \\"after\\" ->> 'deleted', \\"after\\" ->> 'runAttempt' FROM \\"AuditLog\\" WHERE id LIKE 'cleanstart-photos-%' ORDER BY id"`,
      { DIRECT_URL: url }
    ).out.trim().split(/\r?\n/).map((l) => l.split('|'));
    expect(rows.map((r) => [r[0], r[2], r[3], r[4]])).toEqual([
      ['cleanstart-photos-801', 'true', '8', '1'],
      ['cleanstart-photos-802', 'false', '3', '1'],
      ['cleanstart-photos-802-2', 'true', '5', '2'],
    ]);
    expect(rows[0]![1]).toMatch(/were deleted from storage/);
    expect(rows[1]![1]).toMatch(/did NOT complete/);
    expect(rows[1]![1]).not.toMatch(/were deleted/);
    // The actor rule the row needs (CS401) is asked BEFORE anything is deleted (facts.sql
    // actor-ok; the photo run refuses on "f"): an account switched off, flagged as a test
    // account or renamed since the reset must not show up only after the photos are gone.
    const actorOk = (name: string) =>
      run(
        `psql "$DIRECT_URL" -X -q -At -v ON_ERROR_STOP=1 -f ${DIR}/facts.sql -v fact=actor-ok -v actor_username='${name}'`,
        { DIRECT_URL: url }
      ).out.trim();
    expect(actorOk(w.actorName)).toBe('t');
    for (const bad of ['zz.nobody.at.all', '', `zz.test.${sfx}`, `${sfx}.gone`]) {
      expect(actorOk(bad), bad).toBe('f');
      const refused = run(
        `psql "$DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f ${DIR}/photos-record.sql -v run_id=804 -v reset_run_id=${RUN} ` +
          `-v actor_username='${bad}' -v list_sha256=${sum} -v listed=10 -v skipped_shape=1 -v skipped_uat=1 -v deleted=8 -v complete=yes -v attempt=1`,
        { DIRECT_URL: url }
      );
      expect([refused.code, /CS401/.test(refused.out)], bad).toEqual([3, true]);
    }
    await dropCopy(url);
  });
});
