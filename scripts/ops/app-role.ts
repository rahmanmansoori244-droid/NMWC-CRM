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
 *   grant   — (re)apply the privilege set. Idempotent; run after every migration
 *             that adds a table is NOT needed thanks to ALTER DEFAULT PRIVILEGES,
 *             but re-running is always safe.
 *   status  — read-only: what database is this, who am I, does the role exist.
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
      const acl = await owner.$queryRawUnsafe<{ relname: string; can_delete: boolean }[]>(
        `SELECT relname, has_table_privilege('${ROLE}', oid, 'DELETE') AS can_delete
           FROM pg_class
          WHERE relnamespace = 'public'::regnamespace
            AND relname IN ('AuditLog', 'EditApproval', 'CustomerEdit', 'Customer')
          ORDER BY relname`
      );
      for (const r of acl) {
        console.log(`  ${r.relname}: DELETE ${r.can_delete ? 'GRANTED' : 'refused'}`);
      }
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
    const stmts = [
      `GRANT CONNECT ON DATABASE "${db}" TO "${ROLE}"`,
      `GRANT USAGE ON SCHEMA public TO "${ROLE}"`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${ROLE}"`,
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
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${me}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${ROLE}"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${me}" IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "${ROLE}"`,
    ];
    for (const s of stmts) await q(s, owner);
    console.log(`role ${ROLE}: grants applied by ${me} on ${db} (${stmts.length} statements)`);
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
          await expectRefused(tx, 'EditApproval DELETE', () => tx.$executeRawUnsafe(`DELETE FROM "EditApproval" WHERE false`));
          await expectRefused(tx, 'CustomerEdit DELETE (cascade path into the ledger)', () =>
            tx.$executeRawUnsafe(`DELETE FROM "CustomerEdit" WHERE false`)
          );
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
