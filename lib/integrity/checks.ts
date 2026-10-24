/**
 * Gap 29 (data audit 2026-10-10): the named, read-only checks the nightly
 * integrity watch runs (app/api/cron/integrity-watch, lib/integrity/run.ts).
 *
 * Three groups:
 *   data       — the data's own rules (a shop's region is its route's, a
 *                customer's status follows its shops, Temix codes are single and
 *                well formed, test scaffolding is not mixed with real records).
 *                These leave the flagged test records out (lib/test-records.ts).
 *   mechanism  — the record-keeping itself (every record has an open history
 *                interval that matches it, no change without a cause, the
 *                protection triggers and functions are as the migrations made
 *                them, the runtime role holds no ledger write it should not, the
 *                code counter never went back, the scheduled jobs ran, the test
 *                flags did not move, the older rows the NOT VALID database
 *                rules would refuse, the seals). These do NOT leave test records
 *                out: they test the recorder, not the data, and a mis-flag must
 *                not hide a defect.
 *   behaviour  — information only until the owner sets thresholds (exports and
 *                sign-in failures since the last run), test actors left out.
 *
 * Policy: every 'alert' check fails on any non-zero count; 'info' checks never
 * fail. Owner decisions 2026-10-24: test-scaffolding-mixed is information, and
 * scheduled-jobs-on-time counts only the jobs in ALERTING_JOBS
 * (lib/integrity/policy.ts), listing the others as information. At what count a
 * check alerts is still the owner's open question (docs/OPERATIONS.md section 5k).
 *
 * Each check returns counts, at most ten sample ids and counts by sub-kind —
 * never a name, a phone, a CR number or a code. The SQL reads only; every check
 * runs in its own read-only transaction with a statement timeout (run.ts).
 *
 * PURE of lib/db: the client is passed in.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { HEARTBEAT_EXPECTATIONS, STALE_AFTER_INTERVALS, heartbeatReport, type HeartbeatRow } from '../heartbeat';
import {
  APPEND_ONLY_APP_TABLES,
  HISTORY_TABLES,
  LEDGER_SEQUENCE_TABLES,
  LEDGER_SEQ_SEQUENCES,
  TEST_FLAG_TABLES,
  historySequence,
} from '../history-tables';
import { loadUnattributed, RUNTIME_ROLE } from '../history-report';
import { realBranchSql } from '../test-records';
import { omanDateISO } from '../tz';
import {
  capSamples,
  classifyTemixCodes,
  codeSequenceFindings,
  daysBetween,
  dbRuleFindings,
  functionFindings,
  missedRuns,
  scheduledJobFindings,
  statusDriftFindings,
  testFlagChanges,
  triggerFindings,
  type CheckPolicy,
  type CheckStatus,
  type DbRuleCatalogRow,
  type DbRuleCountRow,
  type FunctionRow,
  type TriggerRow,
} from './classify';
import { EXPECTED_FUNCTIONS, TRIGGER_BINDINGS } from './expected';
import { DB_RULE_NAMES, dbRulesCountSql } from '../db-rules';

type Tx = Pick<PrismaClient, '$queryRaw'> | Pick<Prisma.TransactionClient, '$queryRaw'>;

export type PreviousResult = { runAt: Date; status: string; count: number | null; detail: Record<string, unknown> | null };

export type CheckContext = {
  now: Date;
  /** The latest earlier result of each check, by id. */
  previous: Map<string, PreviousResult>;
};

export type CheckOutcome = {
  count: number;
  sampleIds: string[];
  detail?: Record<string, unknown>;
  /** The check decided its own status (an info subset, a first run, a role not set up). */
  status?: CheckStatus;
};

export type IntegrityCheck = {
  id: string;
  version: number;
  group: 'data' | 'mechanism' | 'behaviour';
  title: string;
  /** Why it matters, in a sentence the Steward reads. */
  why: string;
  /** What to do when it fails. */
  remedy: string;
  policy: CheckPolicy;
  /** Leaves the flagged test records out (the data and behaviour groups). */
  excludesTest: boolean;
  /** 'seal' checks are reported by the seal step (run.ts), not run here. */
  run?: (db: Tx, ctx: CheckContext) => Promise<CheckOutcome>;
};

const ts = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
const omanDay = (d: Date) => omanDateISO(d);
const DAY_MS = 86_400_000;

/** The count and the first ids of a set of rows with an `id` column. */
async function countAndSample(db: Tx, inner: Prisma.Sql): Promise<{ count: number; sampleIds: string[] }> {
  const [r] = await (db as Pick<PrismaClient, '$queryRaw'>).$queryRaw<Array<{ n: number; ids: string[] | null }>>(
    Prisma.sql`SELECT count(*)::int AS n, (array_agg(x."id"::text ORDER BY x."id"::text))[1:10] AS ids FROM (${inner}) x`
  );
  return { count: r?.n ?? 0, sampleIds: capSamples(r?.ids ?? []) };
}

const q = <T>(db: Tx, sql: Prisma.Sql) => (db as Pick<PrismaClient, '$queryRaw'>).$queryRaw<T[]>(sql);

/** Since the check's previous run, or the last 24 hours on its first. */
function since(ctx: CheckContext, id: string): Date {
  return ctx.previous.get(id)?.runAt ?? new Date(ctx.now.getTime() - DAY_MS);
}

// ── The master tables and their history ────────────────────────────────────

type Captured = {
  master: 'Customer' | 'Branch' | 'User' | 'Route' | 'Region' | 'Attachment';
  history: string;
  key: string;
  /** The columns the capture trigger records, master expression → history column. */
  compare: Array<[Prisma.Sql, string]>;
};

const col = (c: string) => [Prisma.raw(`m."${c}"`), c] as [Prisma.Sql, string];

/** Exactly the columns each capture trigger WHENs on and records (its last definition). */
export const CAPTURED: Captured[] = [
  {
    master: 'Customer',
    history: 'CustomerHistory',
    key: 'customerId',
    compare: ['nmwcCode', 'paymentTerms', 'creditLimit', 'paymentTermDays', 'temixCode', 'status', 'channelId', 'subChannelId', 'crPhotoId', 'deletedAt', 'mergedIntoId'].map(col),
  },
  {
    master: 'Branch',
    history: 'BranchHistory',
    key: 'branchId',
    compare: [
      ...['branchCode', 'customerId', 'routeId', 'regionId', 'dayOfVisit', 'status', 'deletedAt', 'coolersCount', 'standsCount', 'emptyBottlesCount', 'equipmentConfirmed'].map(col),
      [Prisma.raw(`(m."gpsLat" IS NOT NULL AND m."gpsLng" IS NOT NULL)`), 'hasGps'],
      ...['shopPhotoId', 'signboardPhotoId'].map(col),
    ],
  },
  {
    master: 'User',
    history: 'UserHistory',
    key: 'userId',
    compare: [
      ...['username', 'role', 'isActive', 'supervisorId', 'ownedRouteId'].map(col),
      [Prisma.raw(`COALESCE((SELECT array_agg(mr."A" ORDER BY mr."A") FROM "_ManagerRegions" mr WHERE mr."B" = m."id"), '{}')`), 'regionIds'],
    ],
  },
  { master: 'Route', history: 'RouteHistory', key: 'routeId', compare: ['code', 'name', 'regionId', 'isActive'].map(col) },
  { master: 'Region', history: 'RegionHistory', key: 'regionId', compare: ['code', 'name', 'isActive'].map(col) },
  {
    master: 'Attachment',
    history: 'AttachmentHistory',
    key: 'attachmentId',
    compare: ['kind', 'customerId', 'branchId', 'branchExtraId', 'editId', 'deletedAt', 'hash'].map(col),
  },
];

const latestHistory = (c: Captured, ref: string) =>
  Prisma.raw(`(SELECT h.* FROM "${c.history}" h WHERE h."${c.key}" = ${ref} ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1)`);

// ── The checks ─────────────────────────────────────────────────────────────

export const CHECKS: IntegrityCheck[] = [
  // ── data ──
  {
    id: 'shop-region-matches-route',
    version: 1,
    group: 'data',
    title: 'Shop region matches its route',
    why: 'Every region-scoped permission and figure reads a shop’s region; one that differs from its route’s region puts the shop in the wrong Manager’s view.',
    remedy: 'A route never changes region (OPERATIONS.md, "A route never changes region"): move the shop to a route in its region, or correct its region, through the app.',
    policy: 'alert',
    excludesTest: true,
    run: (db) =>
      countAndSample(
        db,
        Prisma.sql`SELECT b."id" FROM "Branch" b
                     JOIN "Route" r ON r."id" = b."routeId"
                     JOIN "Customer" c ON c."id" = b."customerId"
                    WHERE b."deletedAt" IS NULL AND c."deletedAt" IS NULL AND b."regionId" <> r."regionId"
                      AND ${realBranchSql('b')}`
      ),
  },
  {
    id: 'customer-status-follows-shops',
    version: 1,
    group: 'data',
    title: 'Customer status follows its shops',
    why: 'A customer whose every shop is closed but who is still active (or the reverse) is counted, exported and sent to Temix wrongly.',
    remedy:
      'Run scripts/ops/customer-status-drift.ts --list, then --apply: it corrects the close and reopen cases, the only ones counted here. An active customer whose open shops are all suspended follows the rule; it is listed as information, for a person to decide.',
    policy: 'alert',
    excludesTest: true,
    run: async (db) => {
      const rows = await q<{ id: string; status: string; shops: string[] }>(
        db,
        Prisma.sql`SELECT c."id", c."status"::text AS status, array_agg(b."status"::text) AS shops
                     FROM "Customer" c
                     JOIN "Branch" b ON b."customerId" = c."id" AND b."deletedAt" IS NULL
                    WHERE c."deletedAt" IS NULL AND NOT c."isTest" AND ${realBranchSql('b')}
                    GROUP BY c."id", c."status"
                   HAVING bool_or(b."status" = 'ACTIVE') IS DISTINCT FROM (c."status" = 'ACTIVE')
                       OR (bool_and(b."status" = 'CLOSED') AND c."status" <> 'CLOSED')`
      );
      return statusDriftFindings(rows);
    },
  },
  {
    id: 'temix-code-shared',
    version: 1,
    group: 'data',
    title: 'No two live customers share a Temix code',
    why: 'Temix knows one customer per code; two CRM customers on one code make the workbook and the inbound refresh update the wrong one.',
    remedy: 'Open each customer, find which one Temix really holds under the code, and correct or merge the other.',
    policy: 'alert',
    excludesTest: true,
    run: async (db) => {
      const rows = await q<{ ids: string[] }>(
        db,
        Prisma.sql`SELECT array_agg(x."id" ORDER BY x."id") AS ids FROM (
                     SELECT c."id", upper(btrim(c."temixCode")) AS k FROM "Customer" c
                      WHERE c."deletedAt" IS NULL AND NOT c."isTest" AND c."temixCode" IS NOT NULL AND btrim(c."temixCode") <> '') x
                    GROUP BY x.k HAVING count(*) > 1`
      );
      const ids = rows.flatMap((r) => r.ids);
      return { count: ids.length, sampleIds: capSamples(ids), detail: { codes: rows.length } };
    },
  },
  {
    id: 'temix-code-shape',
    version: 1,
    group: 'data',
    title: 'Temix codes are well formed',
    why: 'A code with a space, in lower case, too short or too long, or a CRM code typed as a Temix code never matches Temix.',
    remedy: 'Correct the code on the customer through the Temix workflow. The three migrated codes with a space inside are listed as information.',
    policy: 'alert',
    excludesTest: true,
    run: async (db) => {
      // The superset the rule can fail on; lib/integrity/classify.ts decides each.
      const rows = await q<{ id: string; code: string; nmwcCode: string }>(
        db,
        Prisma.sql`SELECT c."id", c."temixCode" AS code, c."nmwcCode" AS "nmwcCode" FROM "Customer" c
                    WHERE c."deletedAt" IS NULL AND NOT c."isTest" AND c."temixCode" IS NOT NULL
                      AND (c."temixCode" !~ '^[A-Z0-9]([A-Z0-9._/-]*[A-Z0-9])?$'
                           OR length(c."temixCode") NOT BETWEEN 3 AND 30
                           OR c."temixCode" ~ '^NMWC-[0-9]{4}-[0-9]')`
      );
      const r = classifyTemixCodes(rows);
      return { count: r.count, sampleIds: r.sampleIds, detail: r.detail };
    },
  },
  {
    id: 'test-scaffolding-mixed',
    version: 1,
    group: 'data',
    title: 'Test scaffolding is not mixed with real records',
    why: 'A real customer on the test route, a real route in the test region or a real person on test scaffolding is left out of, or wrongly counted in, every figure.',
    remedy:
      'Information only (owner decision 2026-10-24): it never alerts. Move the real record off the test scaffolding, or ask the owner to flag it as a test record (OPERATIONS.md section 7).',
    // Owner decision 2026-10-24: information, never alerting (a production walk leaves real-flagged customers on the test route).
    policy: 'info',
    excludesTest: true,
    run: async (db) => {
      const [customers, routes, users] = await Promise.all([
        countAndSample(
          db,
          Prisma.sql`SELECT DISTINCT c."id" FROM "Customer" c
                       JOIN "Branch" b ON b."customerId" = c."id" AND b."deletedAt" IS NULL
                       JOIN "Route" r ON r."id" = b."routeId"
                       JOIN "Region" g ON g."id" = b."regionId"
                      WHERE c."deletedAt" IS NULL AND NOT c."isTest" AND (r."isTest" OR g."isTest")`
        ),
        countAndSample(db, Prisma.sql`SELECT r."id" FROM "Route" r JOIN "Region" g ON g."id" = r."regionId" WHERE r."isTest" <> g."isTest"`),
        countAndSample(
          db,
          Prisma.sql`SELECT u."id" FROM "User" u JOIN "Route" r ON r."id" = u."ownedRouteId" WHERE u."isTest" <> r."isTest"
                     UNION
                     SELECT u."id" FROM "_ManagerRegions" mr JOIN "User" u ON u."id" = mr."B" JOIN "Region" g ON g."id" = mr."A"
                      WHERE NOT u."isTest" AND g."isTest"`
        ),
      ]);
      return {
        count: customers.count + routes.count + users.count,
        sampleIds: capSamples([...customers.sampleIds, ...routes.sampleIds, ...users.sampleIds]),
        detail: { customers: customers.count, routes: routes.count, users: users.count },
      };
    },
  },

  // ── mechanism ──
  {
    id: 'history-open-interval',
    version: 1,
    group: 'mechanism',
    title: 'Every record has an open history interval',
    why: 'The dated history answers "what was it on day D"; a live record without an open interval, or an open interval for a record that is gone, makes those answers wrong.',
    remedy: 'A write bypassed the capture triggers (a trigger switched off, or replica mode). Find when from the history and AuditLog, and have the owner repair it in a logged maintenance window.',
    policy: 'alert',
    excludesTest: false,
    run: async (db) => {
      const byTable: Record<string, number> = {};
      const samples: string[] = [];
      for (const c of CAPTURED) {
        const missing = await countAndSample(
          db,
          Prisma.sql`SELECT m."id" FROM ${Prisma.raw(`"${c.master}"`)} m
                      WHERE NOT EXISTS (SELECT 1 FROM ${latestHistory(c, 'm."id"')} l WHERE l."changeKind" <> 'DELETE')`
        );
        const orphan = await countAndSample(
          db,
          Prisma.sql`SELECT l.k AS "id" FROM (
                       SELECT DISTINCT ON (h.${Prisma.raw(`"${c.key}"`)}) h.${Prisma.raw(`"${c.key}"`)} AS k, h."changeKind"
                         FROM ${Prisma.raw(`"${c.history}"`)} h
                        ORDER BY h.${Prisma.raw(`"${c.key}"`)}, h."validFrom" DESC, h."id" DESC) l
                      WHERE l."changeKind" <> 'DELETE'
                        AND NOT EXISTS (SELECT 1 FROM ${Prisma.raw(`"${c.master}"`)} m WHERE m."id" = l.k)`
        );
        const n = missing.count + orphan.count;
        if (n > 0) byTable[c.master] = n;
        samples.push(...[...missing.sampleIds, ...orphan.sampleIds].map((id) => `${c.master}:${id}`));
      }
      return { count: Object.values(byTable).reduce((a, b) => a + b, 0), sampleIds: capSamples(samples), detail: { byTable } };
    },
  },
  {
    id: 'history-matches-master',
    version: 1,
    group: 'mechanism',
    title: 'The history’s latest values are the record’s',
    why: 'A write made with a capture trigger off (or in replica mode) changes the record without a history row; the history then disagrees with it.',
    remedy: 'Find the change in AuditLog and the database logs, then have the owner record it in a logged maintenance window. Run scripts/ops/verify-seals.ts before and after.',
    policy: 'alert',
    excludesTest: false,
    run: async (db) => {
      const byTable: Record<string, number> = {};
      const samples: string[] = [];
      for (const c of CAPTURED) {
        const masterRow = Prisma.join(c.compare.map(([m]) => m), ', ');
        const historyRow = Prisma.join(c.compare.map(([, h]) => Prisma.raw(`l."${h}"`)), ', ');
        const r = await countAndSample(
          db,
          Prisma.sql`SELECT m."id" FROM ${Prisma.raw(`"${c.master}"`)} m
                      CROSS JOIN LATERAL ${latestHistory(c, 'm."id"')} l
                      WHERE l."changeKind" <> 'DELETE' AND ROW(${masterRow}) IS DISTINCT FROM ROW(${historyRow})`
        );
        if (r.count > 0) byTable[c.master] = r.count;
        samples.push(...r.sampleIds.map((id) => `${c.master}:${id}`));
      }
      // Who holds each route (written by the User trigger when ownedRouteId moves).
      const owners = await countAndSample(
        db,
        Prisma.sql`SELECT r."id" FROM "Route" r
                    LEFT JOIN LATERAL (SELECT h."ownerId", h."changeKind" FROM "RouteOwnerHistory" h
                                        WHERE h."routeId" = r."id" ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1) l ON true
                    LEFT JOIN "User" u ON u."ownedRouteId" = r."id"
                   WHERE (l."changeKind" IS NULL AND u."id" IS NOT NULL)
                      OR (l."changeKind" IS NOT NULL AND l."ownerId" IS DISTINCT FROM u."id")`
      );
      if (owners.count > 0) byTable.RouteOwner = owners.count;
      samples.push(...owners.sampleIds.map((id) => `RouteOwner:${id}`));
      return { count: Object.values(byTable).reduce((a, b) => a + b, 0), sampleIds: capSamples(samples), detail: { byTable } };
    },
  },
  {
    id: 'history-unattributed-since-last-run',
    version: 1,
    group: 'mechanism',
    title: 'No change recorded without a cause',
    why: 'Every write names its cause; one recorded under source "sql" is SQL typed by hand, a script that does not name its run, or an application path missing its change context.',
    remedy: 'Look the sample rows up (scripts/ops/history-report.ts). By the runtime role: a defect to fix in the code. By another login: ask who ran it, and why.',
    policy: 'alert',
    excludesTest: false,
    run: async (db, ctx) => {
      const from = since(ctx, 'history-unattributed-since-last-run');
      const rows = await loadUnattributed(db, from);
      const n = rows.reduce((a, r) => a + r.n, 0);
      return {
        count: n,
        sampleIds: capSamples(rows.flatMap((r) => r.sampleIds.map((id) => `${r.table}:${id}`))),
        detail: { since: from.toISOString(), rows: rows.map((r) => ({ table: r.table, day: r.day, dbUser: r.dbUser === RUNTIME_ROLE ? 'runtime-role' : 'other', n: r.n })) },
      };
    },
  },
  {
    id: 'protection-triggers',
    version: 1,
    group: 'mechanism',
    title: 'Every protection trigger is present and on',
    why: 'The history and the ledgers are protected by triggers; one dropped, disabled, set to replica-only or re-pointed stops recording or protecting without an error.',
    remedy: 'Restore it from its migration at once (the owner, in a maintenance window), then run scripts/ops/verify-seals.ts and this check again.',
    policy: 'alert',
    excludesTest: false,
    run: async (db) => {
      const rows = await q<TriggerRow>(
        db,
        Prisma.sql`SELECT t.tgname AS name, t.tgenabled::text AS enabled, c.relname AS "table", p.proname AS fn
                     FROM pg_catalog.pg_trigger t
                     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
                     JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
                    WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
                      AND t.tgname = ANY(${Object.keys(TRIGGER_BINDINGS)}::text[])`
      );
      const f = triggerFindings(rows, TRIGGER_BINDINGS);
      const byKind: Record<string, number> = {};
      for (const x of f) byKind[x.kind] = (byKind[x.kind] ?? 0) + 1;
      return { count: f.length, sampleIds: capSamples(f.map((x) => x.name)), detail: { byKind, expected: Object.keys(TRIGGER_BINDINGS).length } };
    },
  },
  {
    id: 'protection-functions',
    version: 1,
    group: 'mechanism',
    title: 'The protection functions are as the migrations made them',
    why: 'A trigger can stay on while its function is replaced with one that does nothing; the body, rights and search path are compared with the migrations’.',
    remedy: 'Re-create the function from its last migration (the owner), find who changed it from the database logs, then run scripts/ops/verify-seals.ts.',
    policy: 'alert',
    excludesTest: false,
    run: async (db) => {
      const rows = await q<FunctionRow>(
        db,
        Prisma.sql`SELECT p.proname AS name, md5(p.prosrc) AS md5, p.prosecdef AS "securityDefiner", p.proconfig AS config
                     FROM pg_catalog.pg_proc p
                    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY(${Object.keys(EXPECTED_FUNCTIONS)}::text[])`
      );
      const f = functionFindings(rows, EXPECTED_FUNCTIONS);
      const byKind: Record<string, number> = {};
      for (const x of f) byKind[x.kind] = (byKind[x.kind] ?? 0) + 1;
      return { count: f.length, sampleIds: capSamples(f.map((x) => x.name)), detail: { byKind } };
    },
  },
  {
    id: 'runtime-role-privileges',
    version: 1,
    group: 'mechanism',
    title: 'The runtime role cannot change a ledger',
    why: 'The application’s own login may insert into the ledgers and the history, never change or delete them, and may never set their sequences.',
    remedy: 'Re-run `npx tsx scripts/ops/app-role.ts grant` (OPERATIONS.md section 5h), then `status`.',
    policy: 'alert',
    excludesTest: false,
    run: async (db) => {
      const [{ exists } = { exists: false }] = await q<{ exists: boolean }>(
        db,
        Prisma.sql`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${RUNTIME_ROLE}) AS exists`
      );
      if (!exists) return { count: 0, sampleIds: [], detail: { role: 'not set up' }, status: 'info' };
      const ledgers = ['AuditLog', 'EditApproval', ...HISTORY_TABLES, ...APPEND_ONLY_APP_TABLES];
      const checks: Array<[string, string]> = [
        ...ledgers.flatMap((t) => ['UPDATE', 'DELETE', 'TRUNCATE'].map((p) => [t, p] as [string, string])),
        ['CustomerEdit', 'DELETE'],
        ...HISTORY_TABLES.map((t) => [t, 'INSERT'] as [string, string]),
      ];
      const tables = await q<{ t: string; p: string }>(
        db,
        Prisma.sql`SELECT x.t, x.p FROM unnest(${checks.map((c) => c[0])}::text[], ${checks.map((c) => c[1])}::text[]) AS x(t, p)
                    WHERE to_regclass(format('public.%I', x.t)) IS NOT NULL
                      AND has_table_privilege(${RUNTIME_ROLE}, format('public.%I', x.t), x.p)`
      );
      const sequences = [...HISTORY_TABLES, ...LEDGER_SEQUENCE_TABLES].map(historySequence).concat([...LEDGER_SEQ_SEQUENCES]);
      const seqs = await q<{ s: string }>(
        db,
        Prisma.sql`SELECT x.s FROM unnest(${sequences}::text[]) AS x(s)
                    WHERE to_regclass(format('public.%I', x.s)) IS NOT NULL
                      AND has_sequence_privilege(${RUNTIME_ROLE}, format('public.%I', x.s), 'UPDATE')`
      );
      const found = [...tables.map((r) => `${r.t}:${r.p}`), ...seqs.map((r) => `${r.s}:UPDATE`)];
      return { count: found.length, sampleIds: capSamples(found), detail: { tables: tables.length, sequences: seqs.length } };
    },
  },
  {
    id: 'app-login-is-runtime-role',
    version: 1,
    group: 'mechanism',
    title: 'The application connects as the runtime role',
    why: 'Until production connects as the least-privilege role, the owner login can rewrite history in the maintenance window and nothing at the database stops it.',
    remedy: 'Owner: switch the production DATABASE_URL to the runtime role (CREDENTIAL-ROTATION step 1).',
    // Information until the owner switches production (an open question whether it alerts then).
    policy: 'info',
    excludesTest: false,
    run: async (db) => {
      const [r] = await q<{ login: string }>(db, Prisma.sql`SELECT session_user::text AS login`);
      const runtime = r?.login === RUNTIME_ROLE;
      return { count: runtime ? 0 : 1, sampleIds: [], detail: { login: runtime ? 'runtime-role' : 'other' } };
    },
  },
  {
    id: 'customer-code-sequence',
    version: 1,
    group: 'mechanism',
    title: 'The customer-code counter never went back',
    why: 'A counter behind the codes already given (or set back) makes the next new customer collide with an existing code.',
    remedy: 'Find when it moved (AuditLog, the database logs); the next finalize self-heals a counter that is behind, but a counter set back means someone changed it.',
    policy: 'alert',
    excludesTest: false,
    run: async (db, ctx) => {
      const rows = await q<{ scope: string; next: number; maxSeq: string | null }>(
        db,
        Prisma.sql`SELECT s."scope", s."next",
                          (SELECT max(CAST(split_part(c."nmwcCode", '-', 3) AS bigint))::text FROM "Customer" c
                            WHERE c."nmwcCode" ~ ('^NMWC-' || substr(s."scope", 10) || '-[0-9]{6,}$')) AS "maxSeq"
                     FROM "CodeSequence" s WHERE s."scope" ~ '^CUSTOMER-[0-9]{4}$'`
      );
      const prev = ctx.previous.get('customer-code-sequence')?.detail?.scopes as Record<string, number> | undefined;
      const r = codeSequenceFindings(
        rows.map((x) => ({ scope: x.scope, next: Number(x.next), maxSeq: x.maxSeq === null ? null : Number(x.maxSeq) })),
        prev ?? null
      );
      return { count: r.count, sampleIds: r.sampleIds, detail: r.detail };
    },
  },
  {
    id: 'scheduled-jobs-on-time',
    version: 1,
    group: 'mechanism',
    title: 'Every scheduled job ran as its schedule says',
    why: 'A stopped SLA sweep (late requests are never escalated), nightly backup or nightly check is otherwise noticed only when someone looks; only these three alert. The housekeeping jobs (keep-warm, the e-mail drain, the photo clean-up, the retention sweep) are listed as information.',
    remedy: 'Open /api/health with the monitor bearer and the job’s scheduler (vercel.json, the GitHub workflow); a failed run already alerted as cron.failed.',
    // Counts only the jobs in ALERTING_JOBS (owner decision 2026-10-24); the others are information.
    policy: 'alert',
    excludesTest: false,
    run: async (db, ctx) => {
      const prev = ctx.previous.get('scheduled-jobs-on-time');
      const yesterday = omanDay(new Date(ctx.now.getTime() - DAY_MS));
      const after = (prev?.detail?.checkedThroughDay as string | undefined) ?? omanDay(new Date(ctx.now.getTime() - 2 * DAY_MS));
      const days = daysBetween(after, yesterday);
      const start = days.length ? new Date(Date.parse(`${days[0]}T00:00:00Z`) - 4 * 3600_000) : ctx.now;
      const end = days.length ? new Date(Date.parse(`${days.at(-1)}T00:00:00Z`) + 20 * 3600_000) : ctx.now;
      const [runs, beats, failed] = await Promise.all([
        q<{ key: string; at: Date }>(db, Prisma.sql`SELECT "key", "at" FROM "CronRun" WHERE "at" >= ${ts(start)} AND "at" < ${ts(end)}`),
        q<HeartbeatRow>(db, Prisma.sql`SELECT "key", "lastRunAt", "lastOk", "lastError", "runs", "failures" FROM "CronHeartbeat"`),
        q<{ key: string; day: string; failures: number }>(
          db,
          Prisma.sql`SELECT "key", "day"::text AS day, "failures" FROM "JobRunDay" WHERE "day"::text = ANY(${days}::text[]) AND "failures" > 0`
        ),
      ]);
      const missed = missedRuns({
        expectations: HEARTBEAT_EXPECTATIONS,
        runs,
        days,
        heartbeat: heartbeatReport(beats, ctx.now),
        selfKey: 'integrity-watch',
        selfHasEarlierRun: prev !== undefined,
        staleAfterIntervals: STALE_AFTER_INTERVALS,
      });
      // Only the jobs that alert are counted; the others are information.
      const r = scheduledJobFindings(missed);
      return {
        count: r.count,
        sampleIds: r.sampleIds,
        status: r.status,
        detail: {
          checkedThroughDay: yesterday,
          days,
          ...r.detail,
          // Already alerted as cron.failed; shown here as information.
          failedRuns: failed.map((f) => ({ key: f.key, day: f.day, failures: f.failures })),
        },
      };
    },
  },
  {
    id: 'test-flags-changed',
    version: 1,
    group: 'mechanism',
    title: 'The test-record flags did not move',
    why: 'Figures and exports leave flagged records out; a flag set or cleared by anyone hides or shows records in every one of them.',
    remedy: 'Only the owner flags a test record, in a maintenance window (OPERATIONS.md section 7). If he did not, find who did from the database logs.',
    policy: 'alert',
    excludesTest: false,
    run: async (db, ctx) => {
      const rows = await q<{ t: string; ids: string[] | null }>(
        db,
        Prisma.join(
          TEST_FLAG_TABLES.map(
            (t) => Prisma.sql`SELECT ${t}::text AS t, array_agg("id" ORDER BY "id") AS ids FROM ${Prisma.raw(`"${t}"`)} WHERE "isTest"`
          ),
          ' UNION ALL '
        )
      );
      const current = Object.fromEntries(rows.map((r) => [r.t, r.ids ?? []]));
      const prev = ctx.previous.get('test-flags-changed')?.detail?.hashes as Record<string, string> | undefined;
      const r = testFlagChanges(current, prev ?? null);
      const flagged = Object.fromEntries(Object.entries(current).map(([t, ids]) => [t, ids.length]));
      if (r.firstRun) {
        return {
          count: 0,
          sampleIds: [],
          detail: { hashes: r.hashes, flagged, ids: Object.fromEntries(Object.entries(current).map(([t, ids]) => [t, ids.slice(0, 50)])) },
          status: 'info',
        };
      }
      return { count: r.changed.length, sampleIds: capSamples(r.changed), detail: { hashes: r.hashes, flagged, changed: r.changed } };
    },
  },
  {
    // Gap 31: the rules added NOT VALID (lib/db-rules.ts). Every row is counted,
    // test rows included, because a VALIDATE scans them all.
    id: 'db-rules-older-rows',
    version: 1,
    group: 'mechanism',
    title: 'Older rows that break the newer database rules',
    why: 'The rules the application keeps were added to the database NOT VALID: new and changed rows are checked, older ones are not. An older row that breaks a CHECK cannot be saved again by any path until it is corrected, and no rule can be validated while one row still breaks it.',
    remedy:
      'Information only. Correct the counted rows (OPERATIONS.md section 5l: CR keys with scripts/ops/recompute-cr-norm.ts, notification orphans with the owner’s OK, the rest through the app or with the Steward). A rule at 0 here on UAT and on production is listed as ready, and is then validated by a migration of its own.',
    policy: 'info',
    excludesTest: false,
    run: async (db) => {
      const [rows, catalog] = await Promise.all([
        q<DbRuleCountRow>(db, Prisma.raw(dbRulesCountSql())),
        q<DbRuleCatalogRow>(
          db,
          Prisma.sql`SELECT c.conname::text AS name, c.convalidated AS validated FROM pg_catalog.pg_constraint c
                      WHERE c.connamespace = 'public'::regnamespace AND c.conname = ANY(${[...DB_RULE_NAMES]}::text[])`
        ),
      ]);
      return dbRuleFindings(rows, catalog);
    },
  },
  {
    id: 'seal-written',
    version: 1,
    group: 'mechanism',
    title: 'Tonight’s seal was written',
    why: 'The seal is what proves the ledgers untouched; a night without one leaves that day’s rows unsealed until the next.',
    remedy: 'A deferred seal is retried the next night (a long transaction was open). Repeated: look for a stuck transaction (pg_stat_activity).',
    policy: 'alert',
    excludesTest: false,
  },
  {
    id: 'seal-chain-intact',
    version: 1,
    group: 'mechanism',
    title: 'The seal chain still matches the ledgers',
    why: 'A ledger row changed, deleted or slipped into a sealed range — by the owner login in a maintenance window, or anyone with the trigger off — breaks the chain here.',
    remedy:
      'Run scripts/ops/verify-seals.ts --all to see every mismatch; establish who changed what and why, and record it (OPERATIONS.md section 5e). Alerted once; while it stays it is shown as information.',
    policy: 'alert',
    excludesTest: false,
  },
  {
    id: 'seal-offsite-copies',
    version: 1,
    group: 'mechanism',
    title: 'The off-site copies of the seals are there',
    why: 'The R2 copy is the seal’s second witness; a copy missing or different from the database’s, or a copy the database has no seal for, is the first sign one of them was changed.',
    remedy:
      'A copy up to two days old is written again automatically. Older and missing, different, or an object under seals/ that is no seal of the chain: run scripts/ops/verify-seals.ts and compare (OPERATIONS.md section 5k).',
    policy: 'alert',
    excludesTest: false,
  },

  // ── behaviour (information until the owner sets thresholds) ──
  {
    id: 'exports-since-last-run',
    version: 1,
    group: 'behaviour',
    title: 'Exports since the last run',
    why: 'Every export takes customer data out of the system; how many, by whom, is the first question of any incident.',
    remedy: 'Information only. The owner sets the threshold (an open question); the export records are on the audit page.',
    policy: 'info',
    excludesTest: true,
    run: async (db, ctx) => {
      const from = since(ctx, 'exports-since-last-run');
      const rows = await q<{ id: string; role: string }>(
        db,
        Prisma.sql`SELECT j."id", u."role"::text AS role FROM "ExportJob" j JOIN "User" u ON u."id" = j."requestedById"
                    WHERE j."startedAt" >= ${ts(from)} AND NOT u."isTest"`
      );
      const byRole: Record<string, number> = {};
      for (const r of rows) byRole[r.role] = (byRole[r.role] ?? 0) + 1;
      return { count: rows.length, sampleIds: capSamples(rows.map((r) => r.id).sort()), detail: { since: from.toISOString(), byRole } };
    },
  },
  {
    id: 'sign-in-failures-since-last-run',
    version: 1,
    group: 'behaviour',
    title: 'Sign-in failures since the last run',
    why: 'A burst of failed sign-ins or throttle refusals is how a guessed password starts.',
    remedy: 'Information only. The owner sets the threshold (an open question); the events are in AuditLog and AuthEvent.',
    policy: 'info',
    excludesTest: true,
    run: async (db, ctx) => {
      const from = since(ctx, 'sign-in-failures-since-last-run');
      const rows = await q<{ kind: string; n: number }>(
        db,
        Prisma.sql`SELECT 'LOGIN_FAIL'::text AS kind, count(*)::int AS n FROM "AuditLog" a JOIN "User" u ON u."id" = a."actorId"
                    WHERE a."action" = 'LOGIN_FAIL' AND a."entityType" = 'User' AND a."at" >= ${ts(from)} AND NOT u."isTest"
                   UNION ALL
                   SELECT e."kind", count(*)::int FROM "AuthEvent" e LEFT JOIN "User" u ON u."id" = e."userId"
                    WHERE e."kind" IN ('LOGIN_FAIL_UNKNOWN', 'LOGIN_FAIL_REUSED_NAME', 'LOGIN_RATE_LIMITED')
                      AND e."at" >= ${ts(from)} AND (u."id" IS NULL OR NOT u."isTest")
                    GROUP BY e."kind"`
      );
      const byKind = Object.fromEntries(rows.filter((r) => r.n > 0).map((r) => [r.kind, r.n]));
      return { count: rows.reduce((a, r) => a + r.n, 0), sampleIds: [], detail: { since: from.toISOString(), byKind } };
    },
  },
];

export const CHECK_BY_ID = new Map(CHECKS.map((c) => [c.id, c]));

/** The checks whose failure is a critical alert: the record-keeping itself is in doubt. */
export const CRITICAL_CHECKS = ['seal-chain-intact', 'protection-triggers', 'protection-functions'] as const;
