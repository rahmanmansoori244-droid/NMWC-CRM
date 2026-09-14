/**
 * B3 (enterprise assessment, 2026-09-14): prove a restored database is USABLE,
 * not merely present.
 *
 * The old restore drill asserted one thing — that the target had at least ten
 * tables in `public` — and could not have failed: the Neon branch it restored
 * into was cloned from production, so it already had every table before the
 * dump was applied. This harness replaces that with assertions that a recovery
 * actually depends on.
 *
 * The dangerous failure it is built around: `pg_dump` writes indexes,
 * constraints and TRIGGERS in the post-data section, after every COPY. A
 * restore that is truncated or whose errors were swallowed therefore comes up
 * with all 20,000 customer rows present and the append-only audit triggers
 * MISSING — silently undoing B4 at the moment the organisation is least able to
 * notice. Assertions T-* and F-* exist for exactly that.
 *
 *   npx tsx scripts/ops/restore-verify.ts --url "postgresql://..." [--manifest manifest.json]
 *
 * Flags:
 *   --url <conn>        database to verify (else RESTORE_VERIFY_URL, else DATABASE_URL)
 *   --manifest <path>   manifest written at dump time; enables exact row-count and
 *                       RPO-watermark checks (scripts/ops/backup-manifest.sql)
 *   --expect-app-role   also require the nmwc_app role and its REVOKEs to exist
 *                       (only true after app-role.ts has been re-run on the restore)
 *   --json <path>       write the full result as JSON
 *
 * Safe by construction: every statement is a read, except the functional probes,
 * which run inside a transaction that is always rolled back. It still refuses to
 * touch production unless ALLOW_PRODUCTION=1.
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { parsePrismaSchema, implicitJoinTables } from '../../lib/compliance/prisma-schema';

const PROD_MARKER = 'ep-sweet-haze';

/**
 * Database objects the migrations create. Kept explicit rather than derived, so
 * that a migration adding a trigger has to be acknowledged here — and the
 * self-check below fails CI if one is added without updating this list.
 */
const EXPECTED_TRIGGERS = [
  'auditlog_append_only',
  'auditlog_no_truncate',
  'editapproval_append_only',
  'editapproval_no_truncate',
  'branch_region_consistency_check',
  'editbranchdraft_region_consistency_check',
] as const;
const EXPECTED_FUNCTIONS = ['nmwc_forbid_audit_mutation', 'enforce_branch_region_consistency'] as const;
const EXPECTED_EXTENSIONS = ['pg_trgm'] as const;
/** Dropped on purpose by 20260510160000_p1_drop_phone_unique — one owner, several shops. */
const FORBIDDEN_INDEXES = ['Customer_primaryPhoneNorm_active_unique'] as const;

type Status = 'pass' | 'fail' | 'skip';
type Result = { id: string; title: string; status: Status; detail: string; meansIfFailed: string };

const results: Result[] = [];
function record(id: string, title: string, status: Status, detail: string, meansIfFailed: string) {
  results.push({ id, title, status, detail, meansIfFailed });
  const mark = status === 'pass' ? '✓' : status === 'skip' ? '–' : '✗';
  console.log(`  ${mark} ${id} ${title}${detail ? ` — ${detail}` : ''}`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

type Manifest = {
  takenAt?: string;
  rowCounts?: Record<string, number>;
  newestAuditAt?: string | null;
  serverVersion?: string;
};

async function main() {
  const url = arg('url') ?? process.env.RESTORE_VERIFY_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('no database URL: pass --url or set RESTORE_VERIFY_URL');
  if (url.includes(PROD_MARKER) && process.env.ALLOW_PRODUCTION !== '1') {
    throw new Error('Refusing to run against production without ALLOW_PRODUCTION=1');
  }
  const expectAppRole = process.argv.includes('--expect-app-role');
  const manifestPath = arg('manifest');
  let manifest: Manifest | null = null;
  if (manifestPath) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  }

  const schema = parsePrismaSchema(readFileSync('prisma/schema.prisma', 'utf8'));
  // Implicit m2m join tables carry the manager→region assignments the whole
  // authorization model reads, so they are expected by name, not 'unexpected'.
  const expectedTables = [...schema.models, ...implicitJoinTables(schema), '_prisma_migrations'].sort();
  const expectedEnums = [...schema.enums].sort();
  const expectedMigrations = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  // Self-check: a migration that adds a trigger must also update this script.
  const migrationSql = expectedMigrations
    .map((m) => readFileSync(`prisma/migrations/${m}/migration.sql`, 'utf8'))
    .join('\n');
  const declaredTriggers = new Set(
    [...migrationSql.matchAll(/CREATE\s+TRIGGER\s+"?([A-Za-z0-9_]+)"?/gi)].map((m) => m[1]!)
  );
  const unknownTriggers = [...declaredTriggers].filter(
    (t) => !(EXPECTED_TRIGGERS as readonly string[]).includes(t)
  );
  if (unknownTriggers.length) {
    throw new Error(
      `migrations create trigger(s) this verifier does not know about: ${unknownTriggers.join(', ')} — add them to EXPECTED_TRIGGERS in scripts/ops/restore-verify.ts`
    );
  }

  const db = new PrismaClient({ datasourceUrl: url });
  const q = <T>(sql: string) => db.$queryRawUnsafe<T[]>(sql);

  try {
    const [{ v, enc }] = await q<{ v: string; enc: string }>(
      `SELECT version() AS v, current_setting('server_encoding') AS enc`
    );
    console.log(`\nVerifying restore at ${url.replace(/:\/\/[^@]*@/, '://***@')}`);
    console.log(`  server: ${v.split(',')[0]}  encoding: ${enc}\n`);

    // ---- S: schema completeness -------------------------------------------
    const tables = (
      await q<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`
      )
    ).map((r) => r.table_name);
    const missingTables = expectedTables.filter((t) => !tables.includes(t));
    const extraTables = tables.filter((t) => !expectedTables.includes(t));
    record(
      'S-01',
      `all ${expectedTables.length} tables present`,
      missingTables.length ? 'fail' : 'pass',
      missingTables.length ? `missing: ${missingTables.join(', ')}` : `${tables.length} tables${extraTables.length ? ` (+${extraTables.length} unexpected: ${extraTables.join(', ')})` : ''}`,
      'a missing table means that whole feature is dead after recovery'
    );

    const enums = await q<{ typname: string; labels: string[] }>(
      `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE t.typnamespace = 'public'::regnamespace GROUP BY 1 ORDER BY 1`
    );
    const missingEnums = expectedEnums.filter((e) => !enums.some((r) => r.typname === e));
    record(
      'S-02',
      `all ${expectedEnums.length} enum types present`,
      missingEnums.length ? 'fail' : 'pass',
      missingEnums.length ? `missing: ${missingEnums.join(', ')}` : `${enums.length} enums`,
      'a missing enum type means the restore stopped before the type section completed'
    );

    const migRows = await q<{
      migration_name: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
    }>(`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at`);
    const applied = migRows.filter((m) => m.finished_at && !m.rolled_back_at).map((m) => m.migration_name);
    const missingMig = expectedMigrations.filter((m) => !applied.includes(m));
    record(
      'S-03',
      `migration ledger complete (${expectedMigrations.length} migrations)`,
      missingMig.length ? 'fail' : 'pass',
      missingMig.length ? `not applied/finished: ${missingMig.join(', ')}` : `${applied.length} applied, 0 rolled back`,
      'the restore predates a migration, so the code expects columns the data does not have'
    );

    const exts = (await q<{ extname: string }>(`SELECT extname FROM pg_extension`)).map((r) => r.extname);
    const missingExt = EXPECTED_EXTENSIONS.filter((e) => !exts.includes(e));
    record(
      'S-04',
      'required extensions installed',
      missingExt.length ? 'fail' : 'pass',
      missingExt.length ? `missing: ${missingExt.join(', ')}` : exts.filter((e) => e !== 'plpgsql').join(', '),
      'without pg_trgm the trigram indexes cannot exist and customer search degrades to a sequential scan'
    );

    const [{ ok: trgmOk }] = await q<{ ok: boolean }>(
      `SELECT similarity('AL BARAQ NATIONAL','AL BARAK NATIONAL') > 0 AS ok`
    );
    record(
      'S-05',
      'trigram matching is functional, not just registered',
      trgmOk ? 'pass' : 'fail',
      trgmOk ? 'similarity() returns > 0' : 'similarity() returned 0/null',
      'the extension row exists but the opclass is unusable — search will not find near-matches'
    );

    // ---- T: triggers, functions, constraints (the post-data section) ------
    const fns = await q<{ proname: string; owner_scoped: boolean }>(
      `SELECT proname, prosrc ~ 'session_user' AS owner_scoped FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname IN (${EXPECTED_FUNCTIONS.map((f) => `'${f}'`).join(',')})`
    );
    const missingFn = EXPECTED_FUNCTIONS.filter((f) => !fns.some((r) => r.proname === f));
    record(
      'T-01',
      'both plpgsql functions present',
      missingFn.length ? 'fail' : 'pass',
      missingFn.length ? `missing: ${missingFn.join(', ')}` : fns.map((f) => f.proname).join(', '),
      'the audit guard or the region-consistency guard is gone from the restored database'
    );
    const auditFn = fns.find((f) => f.proname === 'nmwc_forbid_audit_mutation');
    record(
      'T-02',
      'audit guard is the owner-scoped version',
      auditFn ? (auditFn.owner_scoped ? 'pass' : 'fail') : 'fail',
      auditFn ? (auditFn.owner_scoped ? 'checks session_user against the table owner' : 'body has no session_user check') : 'function absent',
      'the restore carries the pre-20260914160000 body, which any role could bypass through the CustomerEdit cascade'
    );

    const trgs = await q<{ tgname: string; tbl: string; tgenabled: string }>(
      `SELECT t.tgname, c.relname AS tbl, t.tgenabled FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal ORDER BY 1`
    );
    const missingTrg = EXPECTED_TRIGGERS.filter((t) => !trgs.some((r) => r.tgname === t));
    const disabled = trgs.filter((t) => t.tgenabled !== 'O');
    record(
      'T-03',
      `all ${EXPECTED_TRIGGERS.length} user triggers present and enabled`,
      missingTrg.length || disabled.length ? 'fail' : 'pass',
      missingTrg.length
        ? `MISSING: ${missingTrg.join(', ')}`
        : disabled.length
          ? `disabled: ${disabled.map((d) => d.tgname).join(', ')}`
          : `${trgs.length} enabled`,
      'THE dangerous one: triggers are restored after the data, so a truncated restore leaves every row present and the append-only audit guard gone'
    );

    const [{ total: fkTotal, validated: fkValidated }] = await q<{ total: number; validated: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE convalidated)::int AS validated
       FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace`
    );
    record(
      'T-04',
      'foreign keys present and validated',
      fkTotal > 0 && fkTotal === fkValidated ? 'pass' : 'fail',
      `${fkValidated}/${fkTotal} validated`,
      'referential integrity is not enforced on the restored database — later writes can create orphans'
    );

    const [{ total: ckTotal, validated: ckValidated }] = await q<{ total: number; validated: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE convalidated)::int AS validated
       FROM pg_constraint WHERE contype='c' AND connamespace='public'::regnamespace AND conname !~ '_not_null$'`
    );
    record(
      'T-05',
      'CHECK constraints present and validated',
      ckTotal > 0 && ckTotal === ckValidated ? 'pass' : 'fail',
      `${ckValidated}/${ckTotal} validated`,
      'GPS-range and minimum-length guards are missing, so bad coordinates can be written after recovery'
    );

    const invalidIdx = await q<{ idx: string }>(
      `SELECT c.relname AS idx FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE NOT i.indisvalid AND c.relnamespace = 'public'::regnamespace`
    );
    record(
      'T-06',
      'every index is valid',
      invalidIdx.length ? 'fail' : 'pass',
      invalidIdx.length ? `INVALID: ${invalidIdx.map((i) => i.idx).join(', ')}` : 'all valid',
      'an invalid index is ignored by the planner and never enforces its uniqueness'
    );

    const revived = await q<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relname IN (${FORBIDDEN_INDEXES.map((i) => `'${i}'`).join(',')})`
    );
    record(
      'T-07',
      'deliberately dropped indexes stay dropped',
      revived.length ? 'fail' : 'pass',
      revived.length ? `present again: ${revived.map((r) => r.relname).join(', ')}` : 'none present',
      'the dump predates the drop — one owner with several shops can no longer be saved'
    );

    const [{ tokens_type }] = await q<{ tokens_type: string }>(
      `SELECT data_type AS tokens_type FROM information_schema.columns WHERE table_name='RateLimit' AND column_name='tokens'`
    );
    record(
      'T-08',
      'RateLimit.tokens is still a floating type',
      tokens_type === 'double precision' ? 'pass' : 'fail',
      tokens_type,
      'an integer column truncates the fractional refill and the -1 denied marker, silently re-breaking the login limiter'
    );

    const unlogged = await q<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relpersistence <> 'p'`
    );
    record(
      'T-09',
      'no UNLOGGED tables',
      unlogged.length ? 'fail' : 'pass',
      unlogged.length ? unlogged.map((u) => u.relname).join(', ') : 'none',
      'the dump is taken with --no-unlogged-table-data, so an UNLOGGED table backs up with NO ROWS and no error'
    );

    // ---- D: data integrity -------------------------------------------------
    const orphans = await q<{ fk: string; n: number }>(
      `SELECT 'Branch.customerId' AS fk, count(*)::int AS n FROM "Branch" b LEFT JOIN "Customer" c ON c.id=b."customerId" WHERE c.id IS NULL
       UNION ALL SELECT 'Branch.routeId', count(*)::int FROM "Branch" b LEFT JOIN "Route" r ON r.id=b."routeId" WHERE r.id IS NULL
       UNION ALL SELECT 'Branch.regionId', count(*)::int FROM "Branch" b LEFT JOIN "Region" g ON g.id=b."regionId" WHERE g.id IS NULL
       UNION ALL SELECT 'AuditLog.actorId', count(*)::int FROM "AuditLog" a LEFT JOIN "User" u ON u.id=a."actorId" WHERE u.id IS NULL
       UNION ALL SELECT 'EditApproval.editId', count(*)::int FROM "EditApproval" e LEFT JOIN "CustomerEdit" ce ON ce.id=e."editId" WHERE ce.id IS NULL`
    );
    const withOrphans = orphans.filter((o) => Number(o.n) > 0);
    record(
      'D-01',
      'no orphaned rows across the main foreign keys',
      withOrphans.length ? 'fail' : 'pass',
      withOrphans.length ? withOrphans.map((o) => `${o.fk}=${o.n}`).join(', ') : 'none',
      'a COPY block was partially applied — rows reference parents that were never loaded'
    );

    const [{ n: regionMismatch }] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM "Branch" b JOIN "Route" r ON r.id=b."routeId" WHERE b."regionId" <> r."regionId"`
    );
    record(
      'D-02',
      'every branch sits in its route\'s region (B-19 invariant)',
      Number(regionMismatch) === 0 ? 'pass' : 'fail',
      `${regionMismatch} mismatched`,
      'the consistency trigger fires only on write, so restored rows are never re-checked by it — this query is the only place the invariant is tested after a restore'
    );

    const dupEdits = await q<{ scope: string; n: number }>(
      `SELECT 'customer' AS scope, count(*)::int AS n FROM (SELECT "customerId" FROM "CustomerEdit" WHERE state='SUBMITTED' AND "customerId" IS NOT NULL GROUP BY 1 HAVING count(*)>1) x
       UNION ALL SELECT 'branch', count(*)::int FROM (SELECT "branchId" FROM "CustomerEdit" WHERE state='SUBMITTED' AND "branchId" IS NOT NULL GROUP BY 1 HAVING count(*)>1) y`
    );
    const dup = dupEdits.filter((d) => Number(d.n) > 0);
    record(
      'D-03',
      'at most one open edit per customer and per branch',
      dup.length ? 'fail' : 'pass',
      dup.length ? dup.map((d) => `${d.scope}=${d.n}`).join(', ') : 'none',
      'the partial unique indexes could not have been created — the approval queue would show duplicates'
    );

    const [{ n: badHashes }] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM "User" WHERE "isActive" AND ("passwordHash" IS NULL OR "passwordHash" !~ '^\\$2[aby]\\$')`
    );
    // Accept either: production seeds a MANAGER admin, go-live adds a STEWARD.
    // What matters is that SOMEONE can administer the system after recovery.
    const [{ n: admins }] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM "User" WHERE "isActive" AND role IN ('STEWARD','MANAGER')`
    );
    record(
      'D-04',
      'active users can actually sign in',
      Number(badHashes) === 0 && Number(admins) > 0 ? 'pass' : 'fail',
      `${badHashes} unusable hashes, ${admins} active steward/manager account(s)`,
      'a restore nobody can log into is not a recovery'
    );

    const [{ n: nonAscii }] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM "Customer" WHERE "legalName" ~ '[^[:ascii:]]'`
    );
    record(
      'D-05',
      'encoding survived the round trip',
      enc === 'UTF8' ? 'pass' : 'fail',
      `server_encoding=${enc}, ${nonAscii} non-ASCII legal names`,
      'a non-UTF8 restore mangles every Arabic name in the master'
    );

    // ---- M: manifest comparison -------------------------------------------
    if (manifest?.rowCounts) {
      const live = await q<{ t: string; n: number }>(
        `SELECT c.relname AS t,
                (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::int AS n
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`
      );
      const liveMap = new Map(live.map((r) => [r.t, Number(r.n)]));
      const diffs: string[] = [];
      for (const [table, expected] of Object.entries(manifest.rowCounts)) {
        const got = liveMap.get(table);
        if (got === undefined) diffs.push(`${table}: table missing`);
        else if (got !== expected) diffs.push(`${table}: ${got} vs ${expected} at dump time`);
      }
      record(
        'M-01',
        'row counts match the dump-time manifest exactly',
        diffs.length ? 'fail' : 'pass',
        diffs.length ? diffs.slice(0, 8).join('; ') + (diffs.length > 8 ? ` (+${diffs.length - 8} more)` : '') : `${Object.keys(manifest.rowCounts).length} tables match`,
        'rows were lost between the dump and the restore — without the manifest this is undetectable'
      );

      if (manifest.newestAuditAt) {
        const [{ newest }] = await q<{ newest: Date | null }>(`SELECT max("at") AS newest FROM "AuditLog"`);
        const same =
          newest && new Date(manifest.newestAuditAt).getTime() === new Date(newest).getTime();
        record(
          'M-02',
          'the newest audit row matches the dump watermark',
          same ? 'pass' : 'fail',
          `restored ${newest ? new Date(newest).toISOString() : 'none'} vs manifest ${manifest.newestAuditAt}`,
          'the restored database is not the snapshot the manifest describes'
        );
      }
    } else {
      record('M-01', 'row counts match the dump-time manifest', 'skip', 'no --manifest given', '');
    }

    // ---- F: functional probes (all rolled back) ---------------------------
    // A trigger row in pg_trigger is not proof the trigger WORKS: the function
    // body can be the wrong version, or the trigger can be disabled at session
    // level. These probes exercise it for real.
    let auditRefused = false;
    let auditDetail = 'no AuditLog rows to probe';
    const [{ n: auditRows }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog"`);
    if (Number(auditRows) > 0) {
      try {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2000ms'`);
          await tx.$executeRawUnsafe(
            `UPDATE "AuditLog" SET "reason" = 'restore-drill-tamper' WHERE "id" = (SELECT "id" FROM "AuditLog" ORDER BY "at" DESC LIMIT 1)`
          );
          throw new Error('NOT_REFUSED');
        });
      } catch (err) {
        const msg = (err as Error).message;
        auditRefused = /append-only|insufficient_privilege|permission denied/i.test(msg);
        auditDetail = auditRefused ? 'UPDATE refused by the trigger' : `NOT refused: ${msg.slice(0, 120)}`;
      }
    }
    record(
      'F-01',
      'the restored AuditLog actually refuses an UPDATE',
      Number(auditRows) === 0 ? 'skip' : auditRefused ? 'pass' : 'fail',
      auditDetail,
      'the append-only guarantee did not survive the restore — B4 is silently undone'
    );

    let regionRefused = false;
    let regionDetail = '';
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2000ms'`);
        const sfx = `rv${Math.floor(Date.now() / 1000)}`;
        await tx.$executeRawUnsafe(
          `INSERT INTO "Region" ("id","name","code","updatedAt") VALUES ('${sfx}-ra','RV A ${sfx}','RVA${sfx}',now()), ('${sfx}-rb','RV B ${sfx}','RVB${sfx}',now())`
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "Route" ("id","name","code","regionId","updatedAt") VALUES ('${sfx}-rt','RV Route','RVR${sfx}','${sfx}-ra',now())`
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "Customer" ("id","nmwcCode","legalName","updatedAt") VALUES ('${sfx}-c','RVC${sfx}','RV Customer',now())`
        );
        // regionId deliberately disagrees with the route's region
        await tx.$executeRawUnsafe(
          `INSERT INTO "Branch" ("id","branchCode","branchName","customerId","routeId","regionId","address","updatedAt")
           VALUES ('${sfx}-b','RVB${sfx}','RV Branch','${sfx}-c','${sfx}-rt','${sfx}-rb','Restore drill probe address',now())`
        );
        throw new Error('NOT_REFUSED');
      });
    } catch (err) {
      const msg = (err as Error).message;
      regionRefused = /B-19|region/i.test(msg) && !msg.includes('NOT_REFUSED');
      regionDetail = regionRefused ? 'mismatched branch region refused' : `NOT refused: ${msg.slice(0, 120)}`;
    }
    record(
      'F-02',
      'the branch/route region guard still fires on write',
      regionRefused ? 'pass' : 'fail',
      regionDetail,
      'new branches can be filed under the wrong region after recovery, which breaks every region-scoped permission check'
    );

    // ---- R: the runtime role ----------------------------------------------
    const [{ n: roleCount }] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'nmwc_app'`
    );
    if (expectAppRole) {
      record(
        'R-01',
        'least-privilege role nmwc_app exists',
        Number(roleCount) > 0 ? 'pass' : 'fail',
        Number(roleCount) > 0 ? 'present' : 'absent',
        'the application cannot connect: pg_dump never carries roles, so the role must be re-created after every restore'
      );
    } else {
      record(
        'R-01',
        'least-privilege role nmwc_app',
        Number(roleCount) > 0 ? 'pass' : 'skip',
        Number(roleCount) > 0
          ? 'present'
          : 'ABSENT — expected: pg_dump carries no roles and --no-privileges strips every GRANT. Run scripts/ops/app-role.ts create + grant + verify against this database before pointing the app at it.',
        ''
      );
    }

    // ---- summary -----------------------------------------------------------
    const failed = results.filter((r) => r.status === 'fail');
    const passed = results.filter((r) => r.status === 'pass');
    const skipped = results.filter((r) => r.status === 'skip');
    console.log(
      `\n${failed.length ? '✗ RESTORE NOT VERIFIED' : '✓ restore verified'} — ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`
    );
    if (failed.length) {
      console.log('\nWhat each failure means:');
      for (const f of failed) console.log(`  ${f.id} ${f.title}\n      ${f.meansIfFailed}`);
    }

    const jsonPath = arg('json');
    if (jsonPath) {
      writeFileSync(
        jsonPath,
        JSON.stringify({ url: url.replace(/:\/\/[^@]*@/, '://***@'), results, manifest: manifestPath ?? null }, null, 2)
      );
      console.log(`\nwrote ${jsonPath}`);
    }

    if (failed.length) process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error('restore-verify failed:', (err as Error).message);
  process.exit(1);
});
