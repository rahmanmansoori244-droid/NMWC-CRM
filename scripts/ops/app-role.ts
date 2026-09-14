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
 *   verify  — connect AS the app role (NMWC_APP_URL) and prove: reads/writes work,
 *             the rate-limit upsert works, audit rows can be inserted but not
 *             changed, DDL is refused.
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

async function expectRefused(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    const msg = (err as Error).message;
    if (/permission denied|append-only|must be owner|insufficient_privilege/i.test(msg)) {
      console.log(`  ✓ refused: ${label}`);
      return;
    }
    throw new Error(`${label}: failed for an unexpected reason: ${msg.slice(0, 200)}`);
  }
  throw new Error(`${label}: was ALLOWED — the role is over-privileged`);
}

async function verify() {
  const url = process.env.NMWC_APP_URL;
  if (!url) throw new Error('NMWC_APP_URL (the nmwc_app connection string) is not set');
  if (url.includes(PROD_MARKER) && process.env.ALLOW_PRODUCTION !== '1') {
    throw new Error('Refusing to run against production without ALLOW_PRODUCTION=1');
  }
  const app = new PrismaClient({ datasourceUrl: url });
  try {
    const [{ me }] = await app.$queryRawUnsafe<{ me: string }[]>(`SELECT current_user AS me`);
    if (me !== ROLE) throw new Error(`connected as ${me}, expected ${ROLE}`);
    console.log(`connected as ${me}`);

    // reads + the fast count the customers page uses
    const users = await app.user.count();
    await app.$queryRawUnsafe(`SELECT reltuples FROM pg_class WHERE relname = 'Customer'`);
    console.log(`  ✓ reads (users=${users}, pg_class visible)`);

    // the durable rate limiter's single-statement upsert
    const key = `verify:${ROLE}:${Date.now()}`;
    await app.$executeRawUnsafe(
      `INSERT INTO "RateLimit" ("key", "tokens", "lastRefill", "updatedAt") VALUES ('${key}', 4, NOW(), NOW())
       ON CONFLICT ("key") DO UPDATE SET "tokens" = "RateLimit"."tokens" - 1, "updatedAt" = NOW()`
    );
    await app.rateLimit.delete({ where: { key } });
    console.log('  ✓ rate-limit upsert + delete');

    // advisory locks (create-flow guards)
    const lock = await app.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT pg_try_advisory_lock(424242) AS ok`);
    if (!lock[0]?.ok) throw new Error('advisory lock not granted');
    await app.$queryRawUnsafe(`SELECT pg_advisory_unlock(424242) AS ok`);
    console.log('  ✓ advisory lock');

    // audit: insert yes, change no
    const actor = await app.user.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } });
    if (!actor) throw new Error('no user rows to attribute a verification audit row to');
    const row = await app.auditLog.create({
      data: { actorId: actor.id, action: 'UPDATE', entityType: 'System', entityId: 'app-role-verify', reason: `${ROLE} verification` },
    });
    console.log('  ✓ audit insert');
    await expectRefused('audit UPDATE', () => app.auditLog.update({ where: { id: row.id }, data: { reason: 'tampered' } }));
    await expectRefused('audit DELETE', () => app.auditLog.delete({ where: { id: row.id } }));
    await expectRefused('audit TRUNCATE', () => app.$executeRawUnsafe(`TRUNCATE "AuditLog"`));
    await expectRefused('EditApproval DELETE', () => app.$executeRawUnsafe(`DELETE FROM "EditApproval" WHERE false`));
    await expectRefused('DDL (ALTER TABLE)', () => app.$executeRawUnsafe(`ALTER TABLE "RateLimit" ADD COLUMN "x" INTEGER`));
    await expectRefused('read _prisma_migrations', () => app.$queryRawUnsafe(`SELECT count(*) FROM "_prisma_migrations"`));
    console.log(`role ${ROLE}: verified`);
  } finally {
    await app.$disconnect();
  }
}

const cmd = process.argv[2];
const run = { create, grant, verify }[cmd as 'create' | 'grant' | 'verify'];
if (!run) {
  console.error('usage: app-role.ts create|grant|verify');
  process.exit(2);
}
run().catch((err) => {
  console.error(`app-role ${cmd} failed:`, (err as Error).message);
  process.exit(1);
});
