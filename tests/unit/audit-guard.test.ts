import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

/**
 * DG-06/07 — a test for the lint rule, because the build fails OPEN on a broken one.
 *
 * eslint.config.mjs bans direct `<client>.auditLog.create | createMany |
 * createManyAndReturn | upsert` outside lib/audit.ts, so every AuditLog row goes
 * through writeAudit() and carries `ip` and `userAgent`.
 *
 * If that esquery selector ever stops parsing, ESLint throws mid-lint, Next's
 * runLintCheck catches it, logs a single `ESLint: ...` line and lets `next build`
 * continue UNLINTED (next/dist/lib/eslint/runLintCheck.js). Nothing turns red.
 * This test is what turns red instead. It lints snippets against the real
 * eslint.config.mjs, so it fails if the rule is deleted, downgraded to 'warn',
 * re-scoped away from services/, or given a selector that no longer matches the
 * shapes below. It also pins the OTHER edge of the scope: scripts/ is outside the
 * rule on purpose, and a later widening that drags operator tooling in fails here
 * rather than at a production deploy.
 *
 * It cannot see build wiring. Two things still need checking by hand:
 *   1. `npx next lint` must name files under services/ (that is next.config.ts's
 *      eslint.dirs, not this config).
 *   2. After the conversions, `npx next lint` must report no warnings or errors.
 */

const RULE = 'no-restricted-syntax';

// Constructing ESLint loads the whole flat config (FlatCompat +
// next/core-web-vitals + next/typescript) and takes about a second, so build it
// once for the file and give each case a generous timeout.
const eslint = new ESLint({ cwd: process.cwd() });
const TIMEOUT = 30_000;

// The file paths below are virtual — ESLint uses them only to decide which config
// objects apply, and never reads them from disk.
async function guardHits(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE);
}

describe('DG-06: AuditLog rows must be written through writeAudit()', () => {
  it(
    'flags every banned write shape, at error severity',
    async () => {
      const banned: Array<[string, string]> = [
        [
          'plain create',
          'export async function f(prisma: any) { await prisma.auditLog.create({ data: {} }); }',
        ],
        [
          'transaction client',
          'export async function f(tx: any) { await tx.auditLog.create({ data: {} }); }',
        ],
        [
          'createMany',
          'export async function f(prisma: any) { await prisma.auditLog.createMany({ data: [] }); }',
        ],
        [
          'createManyAndReturn',
          'export async function f(p: any) { await p.auditLog.createManyAndReturn({ data: [] }); }',
        ],
        [
          'upsert',
          'export async function f(tx: any) { await tx.auditLog.upsert({ where: {}, create: {}, update: {} }); }',
        ],
        // The shape a grep for "auditLog.create" cannot see. Prettier wraps long
        // chains like this, and four of the five wrapped sites in this repo are
        // the EXPORT audit rows.
        [
          'Prettier-wrapped chain with a swallowed rejection',
          'export async function f(prisma: any) {\n  await prisma.auditLog\n    .create({ data: {} })\n    .catch(() => undefined);\n}',
        ],
      ];

      for (const [label, code] of banned) {
        const hits = await guardHits('services/__audit-guard-fixture.ts', code);
        expect(hits.length, `${label} should be flagged once`).toBe(1);
        // 2 = error. A 'warn' guard does not guard: warnings can never fail
        // `next build` — runLintCheck defaults maxWarnings to -1 and the build
        // passes no override.
        expect(hits[0]?.severity, `${label} must be an error, not a warning`).toBe(2);
      }
    },
    TIMEOUT
  );

  it(
    'covers every directory the writes actually live in',
    async () => {
      const code = 'export async function f(tx: any) { await tx.auditLog.create({ data: {} }); }';
      for (const dir of ['app', 'components', 'lib', 'services']) {
        const hits = await guardHits(`${dir}/__audit-guard-fixture.ts`, code);
        expect(hits.length, `${dir}/ must be in the rule's files list`).toBe(1);
      }
    },
    TIMEOUT
  );

  it(
    'leaves the legitimate raw writers alone',
    async () => {
      const code = 'export async function f(tx: any) { await tx.auditLog.create({ data: {} }); }';
      // writeAudit() itself.
      expect(await guardHits('lib/audit.ts', code)).toHaveLength(0);
      // tests/ is deliberately outside the rule's files, and outside eslint.dirs:
      // audit-immutability writes raw rows on purpose, and a lint error in a test
      // must never fail a production deploy. Same for the development seeds.
      expect(await guardHits('tests/integration/audit-immutability.test.ts', code)).toHaveLength(0);
      expect(await guardHits('prisma/seed-muscat-pilot.ts', code)).toHaveLength(0);
    },
    TIMEOUT
  );

  it(
    'stops at the request-serving tree — operator scripts are out of scope',
    async () => {
      // Not an oversight, and not a backlog item. An operator CLI runs outside any
      // request, so there are no headers to read and `ip`/`userAgent` are null
      // whichever writer fills them — converting these would change no stored row.
      // It would also couple maintenance tooling to the request runtime: lib/audit.ts
      // imports `next/headers` and constructs the pooled @/lib/db client on import,
      // while every script here deliberately builds its own PrismaClient on
      // DIRECT_URL, because maintenance runs as the owner and not as nmwc_app.
      //
      // These five really do write the ledger. The blank device and network on their
      // rows is a documented class, not missing data — RECORDS-OF-PROCESSING.md §A6.
      // Listing them here means a sixth cannot appear without someone reading this.
      const code = 'export async function f(tx: any) { await tx.auditLog.create({ data: {} }); }';
      const OPERATOR_WRITERS = [
        'scripts/bulk-reset-credentials.ts',
        'scripts/cleanup-synthetic-test.ts',
        'scripts/flatten-customer-branches.ts',
        'scripts/wipe-synthetic-data.ts',
        'scripts/golive/bootstrap-accounts.ts',
        // The least-privilege role probe: its insert proves the app role may INSERT
        // but not UPDATE/DELETE the ledger, and the transaction is rolled back. Not
        // an audit record at all.
        'scripts/ops/app-role.ts',
      ];
      for (const f of OPERATOR_WRITERS) {
        expect(await guardHits(f, code), `${f} must stay outside the rule`).toHaveLength(0);
      }
    },
    TIMEOUT
  );

  it(
    'does not fire on reads or on the sanctioned helper',
    async () => {
      expect(
        await guardHits(
          'services/__audit-guard-fixture.ts',
          'export async function f(p: any) { return p.auditLog.findMany({}); }'
        )
      ).toHaveLength(0);
      expect(
        await guardHits(
          'services/__audit-guard-fixture.ts',
          "import { writeAudit } from '@/lib/audit';\nexport async function f(tx: any, env: any) {\n  await writeAudit(tx, env, { action: 'CREATE', entityType: 'Customer', entityId: 'x' });\n}"
        )
      ).toHaveLength(0);
    },
    TIMEOUT
  );
});
