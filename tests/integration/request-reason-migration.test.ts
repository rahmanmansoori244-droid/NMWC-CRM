// @vitest-environment node
/**
 * Code review 2026-11-10, finding 18 — migration 20261110110000_request_reason
 * on Postgres, against a database that already holds requests.
 *
 * The migration gives a request's own reason its own column and back-fills it.
 * A back-fill that guessed would put a REVIEWER's words, or a merge's sentence,
 * into the column that from now on means "what the salesman said" — and the
 * evidence guard would then freeze the mistake. So this builds the database as
 * it stands BEFORE the migration (every earlier migration, from a temporary copy
 * of prisma/), writes one row for each shape the older builds left behind,
 * applies the real migration, and reads every row back:
 *
 *   copied      a close / reactivation still waiting, or approved; one refused
 *               with its own REJECTED decision row; one whose sealed CREATE row
 *               in the ledger carries the reason (a merge's overwrite RECOVERED);
 *   left NULL   a close / reactivation in NEEDS_CORRECTION (the reviewer's words
 *               replaced his); one closed by a merge, or kept closed, with no
 *               ledger copy; a blank reason; every update and new-customer request;
 *   untouched   decisionReason, on every row.
 *
 * Then the guard: requestReason is frozen once a request is sent and free on a
 * draft or a request sent back, every older rule still holds, and the function
 * in the catalog is the one the nightly integrity check expects.
 *
 * Its own scratch DATABASE on the server DATABASE_URL names (created, then
 * dropped), so nothing in the suite's shared database is touched. Refuses any
 * host but this machine's.
 *
 *   RUN_REQUEST_REASON_MIGRATION=1 DATABASE_URL=postgresql://…@localhost:…/… \
 *     npx vitest run tests/integration/request-reason-migration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { pgPoolConfig } from '@/lib/pg-pool-config';
import { EXPECTED_FUNCTIONS } from '@/lib/integrity/expected';
import { mergeClosedReason } from '@/lib/request-reasons';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const ENABLED = process.env.RUN_REQUEST_REASON_MIGRATION === '1' && !!process.env.DATABASE_URL;
const NAME = '20261110110000_request_reason';
const PRISMA_CLI = resolve('node_modules/prisma/build/index.js');
/** The repository's own Prisma config: prisma/schema.prisma and prisma/migrations. */
const REPO_CONFIG = resolve('prisma.config.ts');
const REFUSED = /cannot change once the request was sent|evidence, append-only/;

/** What each row should hold after the migration; null = left for a person, never guessed. */
type Case = {
  id: string;
  target: 'BRANCH' | 'CUSTOMER';
  process?: 'UPDATE' | 'CREATE';
  state: 'DRAFT' | 'SUBMITTED' | 'NEEDS_CORRECTION' | 'APPROVED' | 'REJECTED';
  isReactivation?: boolean;
  decisionReason: string | null;
  /** The request's CREATE row in the ledger: its `after`. */
  ledger?: Record<string, unknown>;
  /** A decision row of its own. */
  decision?: 'REJECTED' | 'APPROVED';
  expected: string | null;
  why: string;
};

const MERGE = mergeClosedReason('NMWC-000007', 'NMWC-000003');

const CASES: Case[] = [
  // ── copied ────────────────────────────────────────────────────────────────
  { id: 'close-waiting', target: 'BRANCH', state: 'SUBMITTED', decisionReason: 'Shop shut for good', expected: 'Shop shut for good', why: '2b: only its own submit wrote it' },
  { id: 'react-approved', target: 'BRANCH', state: 'APPROVED', isReactivation: true, decisionReason: 'Open again, new owner', decision: 'APPROVED', expected: 'Open again, new owner', why: '2b' },
  { id: 'close-refused', target: 'BRANCH', state: 'REJECTED', decisionReason: 'Owner left the country', decision: 'REJECTED', expected: 'Owner left the country', why: '2c: refused on the path that keeps his reason' },
  { id: 'merged-with-ledger', target: 'BRANCH', state: 'REJECTED', decisionReason: MERGE, ledger: { requestReason: 'Shop closed after the fire' }, expected: 'Shop closed after the fire', why: '2a: the sealed copy recovers what the merge overwrote' },
  { id: 'ledger-wins', target: 'BRANCH', state: 'SUBMITTED', decisionReason: 'what the row says', ledger: { requestReason: 'what was sealed when it was sent' }, expected: 'what was sealed when it was sent', why: '2a runs first: the ledger is the request as sent' },
  { id: 'sent-back-old-with-ledger', target: 'BRANCH', state: 'NEEDS_CORRECTION', isReactivation: true, decisionReason: 'Still shut — shutters down', ledger: { requestReason: 'Open again' }, expected: 'Open again', why: '2a: recovered even where the reviewer’s words replaced it' },
  // ── left NULL ─────────────────────────────────────────────────────────────
  { id: 'close-sent-back-old', target: 'BRANCH', state: 'NEEDS_CORRECTION', decisionReason: 'Photo is blurry, retake', decision: 'REJECTED', expected: null, why: 'refused before 2026-10-07: the text is the reviewer’s' },
  { id: 'react-sent-back-old', target: 'BRANCH', state: 'NEEDS_CORRECTION', isReactivation: true, decisionReason: 'Still shut', expected: null, why: 'the same, a reactivation' },
  { id: 'merged-no-ledger', target: 'BRANCH', state: 'REJECTED', decisionReason: MERGE, expected: null, why: 'the merge’s sentence, nothing to recover' },
  { id: 'merged-with-decision', target: 'BRANCH', state: 'REJECTED', decisionReason: MERGE, decision: 'REJECTED', expected: null, why: 'the merge’s sentence is never his, whatever else the row has' },
  { id: 'react-kept-closed-early', target: 'BRANCH', state: 'REJECTED', isReactivation: true, decisionReason: 'Open again', expected: null, why: 'REJECTED with no decision row: cannot be told from a merge' },
  { id: 'close-rejected-approved-row', target: 'BRANCH', state: 'REJECTED', decisionReason: 'Shop shut', decision: 'APPROVED', expected: null, why: 'a decision row, but not a refusal' },
  { id: 'close-blank', target: 'BRANCH', state: 'SUBMITTED', decisionReason: '   ', expected: null, why: 'blank is none' },
  { id: 'close-none', target: 'BRANCH', state: 'APPROVED', decisionReason: null, expected: null, why: 'nothing to copy' },
  { id: 'ledger-blank', target: 'BRANCH', state: 'REJECTED', decisionReason: null, ledger: { requestReason: '  ' }, expected: null, why: 'a blank sealed reason is none' },
  { id: 'ledger-not-text', target: 'BRANCH', state: 'REJECTED', decisionReason: null, ledger: { requestReason: 42 }, expected: null, why: 'only a string is a reason' },
  { id: 'update-sent-back', target: 'CUSTOMER', state: 'NEEDS_CORRECTION', decisionReason: 'Phone number format is incorrect', decision: 'REJECTED', expected: null, why: 'an update has no request-level reason' },
  { id: 'update-waiting', target: 'CUSTOMER', state: 'SUBMITTED', decisionReason: null, ledger: { requestReason: 'never written for an update' }, expected: null, why: 'not a close or reactivation, whatever the ledger says' },
  { id: 'update-approved', target: 'CUSTOMER', state: 'APPROVED', decisionReason: 'left behind by a step-back', decision: 'APPROVED', expected: null, why: 'a reviewer’s' },
  { id: 'create-stepped-back', target: 'CUSTOMER', process: 'CREATE', state: 'SUBMITTED', decisionReason: 'CR number does not match the photo', decision: 'REJECTED', expected: null, why: 'the Accountant’s reason on a new-customer request' },
  { id: 'create-withdrawn', target: 'CUSTOMER', process: 'CREATE', state: 'REJECTED', decisionReason: 'Withdrawn by the salesman who sent it.', expected: null, why: 'a closure note' },
  { id: 'create-draft', target: 'CUSTOMER', process: 'CREATE', state: 'DRAFT', decisionReason: null, expected: null, why: 'a draft' },
];

describe.skipIf(!ENABLED)('migration 20261110110000_request_reason against existing requests', () => {
  const sfx = `rr${Date.now().toString(36)}`;
  const scratchDb = `nmwc_${sfx}`;
  const user = `${sfx}-u`;
  const id = (c: string) => `${sfx}-${c}`;
  let admin: PrismaClient;
  let db: PrismaClient;
  let scratchUrl = '';
  let tmp = '';
  let secondDeploy = '';
  const before = new Map<string, string | null>();

  // Prisma 7: the migrations folder is the config's (migrations.path), not the
  // one beside --schema, so `migrate deploy --schema <copy>` would apply the
  // repository's folder — this migration included — and there would be no
  // "before". Each deploy names its config instead; the copy gets its own.
  const migrate = (config: string) =>
    execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--config', config], {
      env: { ...process.env, DATABASE_URL: scratchUrl, DIRECT_URL: scratchUrl },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  beforeAll(async () => {
    const base = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
      throw new Error(`ABORT: this suite creates and drops a database, so it runs only against this machine (got ${base.hostname})`);
    }
    // Prisma 7: the Postgres driver adapter, as every client outside the app is built.
    admin = new PrismaClient({ adapter: new PrismaPg(pgPoolConfig(base.toString())) });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchDb}"`);
    const scratch = new URL(base.toString());
    scratch.pathname = `/${scratchDb}`;
    scratchUrl = scratch.toString();

    // 1. The database as it stood before this migration: every earlier one.
    tmp = mkdtempSync(join(tmpdir(), 'nmwc-request-reason-'));
    cpSync('prisma/schema.prisma', join(tmp, 'schema.prisma'));
    cpSync('prisma/migrations/migration_lock.toml', join(tmp, 'migrations', 'migration_lock.toml'));
    const earlier = readdirSync('prisma/migrations').filter((m) => /^\d{14}_/.test(m) && m < NAME);
    expect(earlier.length).toBeGreaterThan(20);
    for (const m of earlier) cpSync(join('prisma/migrations', m), join(tmp, 'migrations', m), { recursive: true });
    // Its paths are read from the config's own folder. A plain object: 'prisma/config'
    // cannot be resolved from a folder outside the repository, and defineConfig
    // only types it.
    writeFileSync(
      join(tmp, 'prisma.config.ts'),
      [
        'export default {',
        "  schema: 'schema.prisma',",
        "  migrations: { path: 'migrations' },",
        "  datasource: { url: process.env.DIRECT_URL ?? '' },",
        '};',
        '',
      ].join('\n')
    );
    migrate(join(tmp, 'prisma.config.ts'));

    db = new PrismaClient({ adapter: new PrismaPg(pgPoolConfig(scratchUrl)) });
    const cols = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'CustomerEdit' AND column_name = 'requestReason'`;
    expect(cols, 'the column must not exist yet').toEqual([]);

    // 2. One row for each shape the older builds left behind.
    await db.user.create({
      data: { id: user, username: `u.${sfx}`, fullName: `Reason ${sfx}`, role: 'SALESMAN', passwordHash: 'x' },
    });
    for (const c of CASES) {
      // Raw SQL: the generated client already selects the column this database does not have yet.
      await db.$executeRaw`
        INSERT INTO "CustomerEdit"
          ("id", "target", "process", "state", "submittedById", "submittedAt", "isReactivation",
           "decisionReason", "fieldChanges", "attachmentChanges", "updatedAt")
        VALUES
          (${id(c.id)}, ${c.target}::"EditTarget", ${c.process ?? 'UPDATE'}::"EditProcess", ${c.state}::"EditState",
           ${user}, ${c.state === 'DRAFT' ? null : new Date('2026-10-20T06:00:00Z')}, ${c.isReactivation ?? false},
           ${c.decisionReason}, '[]'::jsonb, '[]'::jsonb, now())`;
      if (c.ledger) {
        await db.auditLog.create({
          data: { actorId: user, action: 'CREATE', entityType: 'CustomerEdit', entityId: id(c.id), after: c.ledger as never },
        });
      }
      if (c.decision) {
        await db.editApproval.create({
          data: { editId: id(c.id), cycle: 1, stepIndex: 0, role: 'SUPERVISOR', decision: c.decision, actorId: user, reason: 'the reviewer’s own reason' },
        });
      }
      before.set(id(c.id), c.decisionReason);
    }
    // A later ledger row about the same request must not be taken for the request as sent.
    await db.auditLog.create({
      data: {
        actorId: user,
        action: 'CREATE',
        entityType: 'CustomerEdit',
        entityId: id('merged-with-ledger'),
        after: { requestReason: 'a second CREATE row, written later' },
        at: new Date(Date.now() + 60_000),
      },
    });

    // 3. The real migration (and anything after it), from the repository's own folder.
    migrate(REPO_CONFIG);
    secondDeploy = migrate(REPO_CONFIG);
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchDb}" WITH (FORCE)`);
      await admin.$disconnect();
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const rows = () =>
    db.customerEdit.findMany({
      where: { submittedById: user },
      select: { id: true, state: true, requestReason: true, decisionReason: true },
    });

  it.each(CASES.map((c) => [c.id, c] as const))('%s', async (_name, c) => {
    const row = (await rows()).find((r) => r.id === id(c.id))!;
    expect(row.requestReason, c.why).toBe(c.expected);
  });

  it('copies exactly the unambiguous rows — six of them — and leaves the rest NULL', async () => {
    const got = await rows();
    expect(got).toHaveLength(CASES.length);
    expect(got.filter((r) => r.requestReason !== null).map((r) => r.id).sort()).toEqual(
      CASES.filter((c) => c.expected !== null).map((c) => id(c.id)).sort()
    );
    expect(CASES.filter((c) => c.expected !== null)).toHaveLength(6);
  });

  it('never changes decisionReason: every request in flight reads as it did', async () => {
    for (const r of await rows()) expect(r.decisionReason, r.id).toBe(before.get(r.id) ?? null);
  });

  it('a second deploy changes nothing', async () => {
    expect(secondDeploy).toMatch(/No pending migrations to apply/);
  });

  it('the guard in the catalog is the one the nightly integrity check expects', async () => {
    const [fn] = await db.$queryRaw<{ md5: string; definer: boolean; config: string[] | null }[]>`
      SELECT md5(p.prosrc) AS md5, p.prosecdef AS definer, p.proconfig AS config
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'nmwc_customeredit_evidence_guard'`;
    const expected = EXPECTED_FUNCTIONS.nmwc_customeredit_evidence_guard!;
    expect(fn!.md5).toBe(expected.md5);
    expect(fn!.definer).toBe(expected.securityDefiner);
    expect(fn!.config).toEqual([`search_path=${expected.searchPath}`]);
  });

  it('requestReason is frozen once a request is sent — set, changed or cleared', async () => {
    const set = (rowId: string, value: string | null) =>
      db.$executeRaw`UPDATE "CustomerEdit" SET "requestReason" = ${value} WHERE "id" = ${id(rowId)}`;
    // Changed, on a waiting, an approved and a refused request.
    for (const sent of ['close-waiting', 'react-approved', 'close-refused']) {
      await expect(set(sent, 'someone else’s words'), sent).rejects.toThrow(REFUSED);
      await expect(set(sent, null), sent).rejects.toThrow(REFUSED);
    }
    // Set where the back-fill left it NULL: a later guess is refused too.
    await expect(set('merged-no-ledger', 'a guess')).rejects.toThrow(REFUSED);
    await expect(set('update-waiting', 'a guess')).rejects.toThrow(REFUSED);
    await expect(set('close-waiting', 'x')).rejects.toThrow(/requestReason cannot change once the request was sent \(state SUBMITTED\)/);
    // Nothing moved.
    const now = new Map((await rows()).map((r) => [r.id, r.requestReason]));
    for (const c of CASES) expect(now.get(id(c.id)), c.id).toBe(c.expected);
  });

  it('a draft, and a request sent back to its salesman, are still his to change', async () => {
    const set = (rowId: string, value: string | null) =>
      db.$executeRaw`UPDATE "CustomerEdit" SET "requestReason" = ${value} WHERE "id" = ${id(rowId)}`;
    expect(await set('create-draft', 'typed on the draft')).toBe(1);
    expect(await set('update-sent-back', 'typed while correcting')).toBe(1);
    expect(await set('create-draft', null)).toBe(1);
    expect(await set('update-sent-back', null)).toBe(1);
  });

  it('every older rule of the guard still holds, and decisionReason still moves', async () => {
    const sent = id('close-waiting');
    await expect(
      db.$executeRaw`UPDATE "CustomerEdit" SET "fieldChanges" = '[{"field":"x"}]'::jsonb WHERE "id" = ${sent}`
    ).rejects.toThrow(/fieldChanges cannot change once the request was sent/);
    await expect(
      db.$executeRaw`UPDATE "CustomerEdit" SET "submittedAt" = now() WHERE "id" = ${sent}`
    ).rejects.toThrow(/submittedAt cannot change/);
    await expect(
      db.$executeRaw`UPDATE "CustomerEdit" SET "state" = 'DRAFT'::"EditState" WHERE "id" = ${sent}`
    ).rejects.toThrow(/its state cannot go from SUBMITTED to DRAFT/);
    await expect(
      db.$executeRaw`UPDATE "CustomerEdit" SET "state" = 'SUBMITTED'::"EditState" WHERE "id" = ${id('react-approved')}`
    ).rejects.toThrow(/a decided request stays decided/);
    // A decision's copy on the row is not evidence of the request: it moves, as it always has.
    expect(
      await db.$executeRaw`UPDATE "CustomerEdit" SET "decisionReason" = 'Auto-closed: for this test' WHERE "id" = ${id('update-waiting')}`
    ).toBe(1);
    // …and the requester's reason beside it did not.
    const [row] = await db.$queryRaw<{ requestReason: string | null }[]>`
      SELECT "requestReason" FROM "CustomerEdit" WHERE "id" = ${sent}`;
    expect(row!.requestReason).toBe('Shop shut for good');
  });
});
