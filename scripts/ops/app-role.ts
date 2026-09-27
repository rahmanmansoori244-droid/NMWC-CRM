/**
 * B4 (enterprise assessment, 2026-09-14): least-privilege runtime role.
 *
 * The application used to connect as the database OWNER (`neondb_owner`), so a
 * leaked DATABASE_URL could run DDL, rewrite the audit trail or truncate
 * tables. The runtime now connects as `nmwc_app`, which can read and write the
 * application tables but can NOT update/delete/truncate "AuditLog" or
 * "EditApproval", touch "_prisma_migrations", or run DDL. The owner credential
 * stays in DIRECT_URL (used only by `prisma migrate deploy` in the build, the
 * nightly backup and Steward-run maintenance scripts).
 *
 *   create  — create the role (or reset its password). Needs NMWC_APP_PASSWORD.
 *   grant   — (re)apply the privilege set. Idempotent and always safe to re-run.
 *             A migration that adds an ordinary table needs no re-grant: ALTER
 *             DEFAULT PRIVILEGES gives the role SELECT/INSERT/UPDATE on it. A
 *             table in DELETABLE DOES need one, because the defaults leave DELETE
 *             out on purpose — so re-run `grant` after deploying the migration
 *             that adds it (CronRun, 2026-09-27: OPERATIONS.md §5h).
 *   status  — read-only: what database is this, who am I, does the role exist,
 *             and does it hold DELETE exactly where it should.
 *   verify  — connect AS the app role (NMWC_APP_URL) and prove: reads/writes work,
 *             the rate-limit upsert works, audit rows can be inserted but not
 *             changed (not even with the maintenance GUC, not even through the
 *             CustomerEdit cascade), DDL is refused. Every probe runs inside ONE
 *             transaction that is rolled back at the end, so a verification
 *             leaves no trace — safe to run against production.
 *
 * All commands use DIRECT_URL (owner) except `verify`, which uses NMWC_APP_URL.
 * Production is refused unless ALLOW_PRODUCTION=1 is set explicitly by the owner.
 *
 *   node scripts/qa/run-with-env.mjs tsx scripts/ops/app-role.ts grant
 */
import { PrismaClient } from '@prisma/client';

const ROLE = 'nmwc_app';
const PROD_MARKER = 'ep-sweet-haze';

function ownerUrl(): string {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_URL (owner) is not set');
  if (url.includes(PROD_MARKER) && process.env.ALLOW_PRODUCTION !== '1') {
    throw new Error('Refusing to run against production without ALLOW_PRODUCTION=1');
  }
  return url;
}

function q(sql: string, client: PrismaClient) {
  return client.$executeRawUnsafe(sql);
}

async function create() {
  const password = process.env.NMWC_APP_PASSWORD;
  if (!password || password.length < 16) {
    throw new Error('NMWC_APP_PASSWORD must be set (16+ characters)');
  }
  if (password.includes("'")) throw new Error("NMWC_APP_PASSWORD must not contain a single quote");
  const owner = new PrismaClient({ datasourceUrl: ownerUrl() });
  try {
    const exists = await owner.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM pg_roles WHERE rolname = '${ROLE}'`
    );
    if (Number(exists[0]?.n ?? 0) > 0) {
      await q(`ALTER ROLE "${ROLE}" WITH LOGIN PASSWORD '${password}'`, owner);
      console.log(`role ${ROLE}: exists — password reset`);
    } else {
      await q(`CREATE ROLE "${ROLE}" WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`, owner);
      console.log(`role ${ROLE}: created`);
    }
  } finally {
    await owner.$disconnect();
  }
}

/**
 * Read-only. What is this database, who am I connected as, and does the role
 * exist yet? Safe to run against production at any time; changes nothing.
 */
/**
 * Every model the request path actually deletes from — verified by grepping
 * `.delete(`/`.deleteMany(` and `DELETE FROM` across app, lib and services. Add to
 * it only with the same evidence. RateLimit is here because the pg rate-limit
 * backend prunes its own rows. CronRun (item 9, 2026-09-27) because the
 * retention sweep prunes run history past 90 days
 * (app/api/cron/retention-sweep/route.ts, step 4). _ManagerRegions (2026-09-27)
 * because the account-master import replaces a manager's regions with
 * `managedRegions: { set: [...] }` (services/imports.ts), which deletes join
 * rows: a grep for `.delete(` does not find it, and the first `status` run
 * against production showed the role's old blanket DELETE was all that covered
 * it. Nested writes count as evidence too: `set`, `disconnect` on a many-to-many,
 * `deleteMany` inside `data`.
 */
const DELETABLE = [
  'Attachment',
  'Notification',
  'SavedView',
  'EditBranchDraft',
  'PasswordHistory',
  'RateLimit',
  'CronRun',
  '_ManagerRegions',
];

async function status() {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl() });
  try {
    const [{ me, db }] = await owner.$queryRawUnsafe<{ me: string; db: string }[]>(
      `SELECT current_user AS me, current_database() AS db`
    );
    const [{ n }] = await owner.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = '${ROLE}'`
    );
    console.log(`connected as ${me} on ${db}`);
    console.log(`role ${ROLE}: ${n > 0 ? 'exists' : 'does not exist yet'}`);
    if (n > 0) {
      // Every table in the schema, not a chosen few: DELETE must be held on
      // exactly DELETABLE. A table missing it breaks a sweep; a table holding it
      // that should not is the runtime credential able to empty it.
      const acl = await owner.$queryRawUnsafe<{ relname: string; can_delete: boolean }[]>(
        `SELECT relname, has_table_privilege('${ROLE}', oid, 'DELETE') AS can_delete
           FROM pg_class
          WHERE relnamespace = 'public'::regnamespace
            AND relkind IN ('r', 'p')
          ORDER BY relname`
      );
      let wrong = 0;
      for (const r of acl) {
        const want = DELETABLE.includes(r.relname);
        const note =
          want && !r.can_delete
            ? '  <-- MISSING: run `grant` (a table added since the last grant)'
            : !want && r.can_delete
              ? '  <-- UNEXPECTED: run `grant`, which takes it back'
              : '';
        if (note) wrong += 1;
        console.log(`  ${r.relname}: DELETE ${r.can_delete ? 'GRANTED' : 'refused'}${note}`);
      }
      // A default privilege would hand DELETE to the next table a migration adds.
      const [{ n: defaultDeletes }] = await owner.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n
           FROM pg_default_acl d, aclexplode(d.defaclacl) a
          WHERE d.defaclnamespace = 'public'::regnamespace
            AND d.defaclobjtype = 'r'
            AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = '${ROLE}')
            AND a.privilege_type = 'DELETE'`
      );
      if (defaultDeletes > 0) {
        wrong += 1;
        console.log('  default privileges: DELETE on future tables  <-- UNEXPECTED: run `grant`');
      }
      console.log(wrong === 0 ? 'DELETE is held exactly where it should be' : `${wrong} DELETE problem(s): run \`grant\``);
    }
  } finally {
    await owner.$disconnect();
  }
}

async function grant() {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl() });
  try {
    const [{ db, me }] = await owner.$queryRawUnsafe<{ db: string; me: string }[]>(
      `SELECT current_database() AS db, current_user AS me`
    );
    // DELETE is granted per table, not across the schema.
    //
    // It used to be `GRANT ... DELETE ON ALL TABLES`, with TRUNCATE revoked on the
    // ledgers — which reads like "bulk destruction is prevented" and is not. The
    // whole customer master, ~20,000 rows after the load, could be emptied row by
    // row by the runtime credential, with no audit row and no DDL. Deleting a
    // Branch additionally succeeded silently, because CustomerEdit.branchId is
    // nullable and the FK is ON DELETE SET NULL, quietly severing edit history
    // from the branch it was about.
    //
    // DELETE is granted per table from DELETABLE (above `status`), which says
    // what earns a table its place there.
    const stmts = [
      `GRANT CONNECT ON DATABASE "${db}" TO "${ROLE}"`,
      `GRANT USAGE ON SCHEMA public TO "${ROLE}"`,
      `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO "${ROLE}"`,
      // An earlier version of this set granted DELETE on ALL tables and in the
      // default privileges, and a GRANT never takes anything away, so a role
      // first provisioned then (production, 2026-09-15) kept DELETE everywhere
      // through every later `grant` (review of f05752e). Take it all back first,
      // then give it to exactly DELETABLE; same transaction, so there is no moment
      // in between.
      `REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM "${ROLE}"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${me}" IN SCHEMA public REVOKE DELETE ON TABLES FROM "${ROLE}"`,
      ...DELETABLE.map((t) => `GRANT DELETE ON "${t}" TO "${ROLE}"`),
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${ROLE}"`,
      // append-only ledgers: insert only
      `REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "AuditLog" FROM "${ROLE}"`,
      `REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "EditApproval" FROM "${ROLE}"`,
      // the app never deletes edits; without DELETE here the ON DELETE CASCADE into
      // "EditApproval" cannot be reached from the runtime credential at all
      `REVOKE DELETE, TRUNCATE ON "CustomerEdit" FROM "${ROLE}"`,
      // migrations are the owner's business
      `REVOKE ALL ON "_prisma_migrations" FROM "${ROLE}"`,
      // tables and sequences created by FUTURE migrations (run by the owner) inherit the grants
      // No DELETE here on purpose: a table added by a future migration must not
      // become deletable by the runtime credential without somebody deciding so.
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${me}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO "${ROLE}"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${me}" IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "${ROLE}"`,
    ];
    // ONE transaction. These were ten separate autocommitted statements, and the
    // GRANT that opens the set is schema-wide while the REVOKEs that narrow it
    // come after — so a dropped connection, a Neon cold start, the job timeout or
    // a cancelled workflow anywhere between them left nmwc_app holding UPDATE,
    // DELETE and TRUNCATE on both ledgers. The application works perfectly in that
    // state, so nothing surfaces it; the docstring's promise that re-running is
    // always safe made it likelier, not less. GRANT and REVOKE are transactional
    // DDL in PostgreSQL, so this costs nothing.
    // An explicit budget: Prisma's 5 s default is one round trip per statement too
    // short once the set grew past twenty statements over a slow link — run from an
    // operator's machine on 2026-09-27 it timed out and rolled back (whole, so
    // harmlessly). CI and GitHub-hosted runs sit next to the database.
    await owner.$transaction(
      async (tx) => {
        for (const s of stmts) await tx.$executeRawUnsafe(s);
      },
      { maxWait: 10_000, timeout: 120_000 }
    );
    console.log(`role ${ROLE}: grants applied by ${me} on ${db} (${stmts.length} statements, one transaction)`);
  } finally {
    await owner.$disconnect();
  }
}

const REFUSAL = /permission denied|append-only|must be owner|insufficient_privilege/i;

class Rollback extends Error {}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Run one probe under a savepoint so a refused statement does not poison the
 * surrounding transaction, and the probe's own side effects (locks, SET LOCAL)
 * are undone either way.
 */
async function expectRefused(tx: Tx, label: string, fn: () => Promise<unknown>) {
  await tx.$executeRawUnsafe('SAVEPOINT probe');
  let refused: string | null = null;
  try {
    await fn();
  } catch (err) {
    refused = (err as Error).message;
  }
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT probe');
  if (refused === null) throw new Error(`${label}: was ALLOWED — the role is over-privileged`);
  if (!REFUSAL.test(refused)) {
    throw new Error(`${label}: failed for an unexpected reason: ${refused.slice(0, 200)}`);
  }
  console.log(`  ✓ refused: ${label}`);
}

async function verify() {
  const url = process.env.NMWC_APP_URL;
  if (!url) throw new Error('NMWC_APP_URL (the nmwc_app connection string) is not set');
  if (url.includes(PROD_MARKER) && process.env.ALLOW_PRODUCTION !== '1') {
    throw new Error('Refusing to run against production without ALLOW_PRODUCTION=1');
  }
  const app = new PrismaClient({ datasourceUrl: url });
  let auditRowId = '';
  try {
    const [{ me }] = await app.$queryRawUnsafe<{ me: string }[]>(`SELECT current_user AS me`);
    if (me !== ROLE) throw new Error(`connected as ${me}, expected ${ROLE}`);
    console.log(`connected as ${me}`);

    // reads + the fast count the customers page uses
    const users = await app.user.count();
    await app.$queryRawUnsafe(`SELECT reltuples FROM pg_class WHERE relname = 'Customer'`);
    console.log(`  ✓ reads (users=${users}, pg_class visible)`);

    const actor = await app.user.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } });
    if (!actor) throw new Error('no user rows to attribute a verification audit row to');

    // Everything below happens in one transaction that is rolled back: the
    // verification writes nothing permanent, and a refused TRUNCATE cannot sit
    // on the ACCESS EXCLUSIVE lock queue for longer than lock_timeout.
    try {
      await app.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2000ms'`);

          // the durable rate limiter's single-statement upsert
          const key = `verify:${ROLE}:${Date.now()}`;
          await tx.$executeRaw`INSERT INTO "RateLimit" ("key", "tokens", "lastRefill", "updatedAt") VALUES (${key}, 4, NOW(), NOW())
            ON CONFLICT ("key") DO UPDATE SET "tokens" = "RateLimit"."tokens" - 1, "updatedAt" = NOW()`;
          console.log('  ✓ rate-limit upsert');

          // advisory locks — the app uses transaction-scoped ones (lib/create-guards.ts)
          const lock = await tx.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT pg_try_advisory_xact_lock(424242) AS ok`);
          if (!lock[0]?.ok) throw new Error('advisory lock not granted');
          console.log('  ✓ advisory xact lock');

          // audit: insert yes, change no
          const row = await tx.auditLog.create({
            data: { actorId: actor.id, action: 'UPDATE', entityType: 'System', entityId: 'app-role-verify', reason: `${ROLE} verification (rolled back)` },
          });
          auditRowId = row.id;
          console.log('  ✓ audit insert');
          await expectRefused(tx, 'audit UPDATE', () => tx.$executeRaw`UPDATE "AuditLog" SET "reason" = 'tampered' WHERE "id" = ${row.id}`);
          await expectRefused(tx, 'audit DELETE', () => tx.$executeRaw`DELETE FROM "AuditLog" WHERE "id" = ${row.id}`);
          await expectRefused(tx, 'audit DELETE with the maintenance GUC set', async () => {
            await tx.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'on'`);
            await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "id" = ${row.id}`;
          });
          await expectRefused(tx, 'audit TRUNCATE', () => tx.$executeRawUnsafe(`TRUNCATE "AuditLog"`));
          // The three probes above all match a real row, so the append-only
          // TRIGGER refuses them — and would refuse them just as loudly with the
          // ledger REVOKEs missing entirely. They prove layer 1 and say nothing
          // about layer 2, which is the half B4 is actually about and the half a
          // half-applied grant leaves off.
          //
          // A zero-row statement never reaches a row trigger, so only the ACL can
          // refuse these.
          await expectRefused(tx, 'audit UPDATE by ACL (zero rows, trigger cannot fire)', () =>
            tx.$executeRawUnsafe(`UPDATE "AuditLog" SET "reason" = "reason" WHERE false`)
          );
          await expectRefused(tx, 'audit DELETE by ACL (zero rows, trigger cannot fire)', () =>
            tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE false`)
          );
          await expectRefused(tx, 'EditApproval UPDATE by ACL (zero rows)', () =>
            tx.$executeRawUnsafe(`UPDATE "EditApproval" SET "reason" = "reason" WHERE false`)
          );
          // Not a ledger, but the same class of promise: the role must not be able
          // to empty the customer master row by row. TRUNCATE being refused reads
          // like bulk destruction is prevented; DELETE is what would do it.
          await expectRefused(tx, 'Customer DELETE by ACL (the 20,000-row path)', () =>
            tx.$executeRawUnsafe(`DELETE FROM "Customer" WHERE false`)
          );
          await expectRefused(tx, 'EditApproval DELETE', () => tx.$executeRawUnsafe(`DELETE FROM "EditApproval" WHERE false`));
          await expectRefused(tx, 'CustomerEdit DELETE (cascade path into the ledger)', () =>
            tx.$executeRawUnsafe(`DELETE FROM "CustomerEdit" WHERE false`)
          );
          // Item 9: the role can write run history and the retention sweep can
          // prune it. This runs after `grant`, so it proves the grant covers
          // CronRun (DELETABLE included); it does not test the default privileges
          // on their own — `status` shows whether a table added since the last
          // grant is missing DELETE.
          await tx.$executeRaw`INSERT INTO "CronRun" ("id", "key", "at", "ok", "durationMs") VALUES (${`verify-${Date.now()}`}, 'verify', NOW(), true, 0)`;
          await tx.$executeRawUnsafe(`DELETE FROM "CronRun" WHERE "key" = 'verify'`);
          console.log('  ✓ CronRun insert + delete (run history, pruned by the retention sweep)');
          // The account-master import replaces a manager's regions with `set`,
          // which deletes join rows.
          await tx.$executeRawUnsafe(`DELETE FROM "_ManagerRegions" WHERE false`);
          console.log('  ✓ _ManagerRegions delete (a manager\'s regions re-set by the account import)');
          // And a table the runtime has no business deleting from: the blanket
          // DELETE an earlier grant left behind must be gone.
          await expectRefused(tx, 'Branch DELETE by ACL', () => tx.$executeRawUnsafe(`DELETE FROM "Branch" WHERE false`));
          await expectRefused(tx, 'DDL (ALTER TABLE)', () => tx.$executeRawUnsafe(`ALTER TABLE "RateLimit" ADD COLUMN "x" INTEGER`));
          await expectRefused(tx, 'read _prisma_migrations', () => tx.$queryRawUnsafe(`SELECT count(*) FROM "_prisma_migrations"`));
          throw new Rollback();
        },
        { maxWait: 10_000, timeout: 60_000 }
      );
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    const leftover = auditRowId ? await app.auditLog.findUnique({ where: { id: auditRowId } }) : null;
    if (leftover) throw new Error('verification audit row survived the rollback');
    console.log('  ✓ rolled back — no rows left behind');
    console.log(`role ${ROLE}: verified`);
  } finally {
    await app.$disconnect();
  }
}

const cmd = process.argv[2];
const run = { create, grant, verify, status }[cmd as 'create' | 'grant' | 'verify' | 'status'];
if (!run) {
  console.error('usage: app-role.ts create|grant|verify|status');
  process.exit(2);
}
run().catch((err) => {
  console.error(`app-role ${cmd} failed:`, (err as Error).message);
  process.exit(1);
});
