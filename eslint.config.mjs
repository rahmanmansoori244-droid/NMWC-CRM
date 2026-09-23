import { FlatCompat } from '@eslint/eslintrc';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
    ignores: ['.next/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
  },
  {
    // DG-06/07: the AuditLog is the compliance artefact named in
    // docs/compliance/RECORDS-OF-PROCESSING.md and it is append-only at the
    // database. `ip` and `userAgent` are written by exactly one function —
    // writeAudit() in lib/audit.ts, fed by getAuditEnvelope(). Any direct
    // prisma.auditLog.create / tx.auditLog.create / createMany writes a row with
    // both forensic columns null, and nothing at the call site says so.
    //
    // An AST selector rather than a grep-style check, on purpose: Prettier wraps
    // long chains as `await prisma.auditLog\n  .create({`, which a text search for
    // "auditLog.create" does not match. Five current violations are in that shape,
    // including four of the five EXPORT audit rows — the ones "who exported the
    // customer master" depends on.
    //
    // `no-restricted-syntax` rather than a custom plugin, on purpose: no new
    // dependency, and this is one call shape, not a rule library. Note that rule
    // options do NOT merge across flat-config objects — if a later object sets
    // 'no-restricted-syntax' again, this entry is silently lost. Nothing else in
    // this config, and nothing in eslint-config-next, sets it today.
    //
    // Do NOT rewrite the selector to use esquery's `<` subject combinator: it does
    // not parse in the pinned ESLint, and a selector that throws fails OPEN — the
    // build logs one `ESLint: ...` line and continues unlinted. tests/unit/
    // audit-guard.test.ts is what fails loudly in that case.
    //
    // The scope is the request-serving tree only. `scripts/` is out, deliberately,
    // and that is a decision rather than an oversight: an operator CLI has no
    // request, so there are no headers to read and both forensic columns are null
    // whichever writer fills them. Importing lib/audit.ts into one would also pull
    // in `next/headers` and construct the pooled `@/lib/db` client as an import
    // side effect — every script here builds its own PrismaClient on DIRECT_URL on
    // purpose, because maintenance runs as the owner and not as nmwc_app. So the
    // conversion would change no stored row and would couple operator tooling to
    // the request runtime.
    //
    // Six scripts write the ledger directly — bulk-reset-credentials,
    // cleanup-synthetic-test, flatten-customer-branches, wipe-synthetic-data,
    // golive/bootstrap-accounts and ops/requeue-untracked. Their rows are blank in
    // `ip` and `userAgent` BY
    // CONSTRUCTION, and that class is named in §A6 of
    // docs/compliance/RECORDS-OF-PROCESSING.md so a reader of the ledger can tell
    // "acted outside any session" apart from "device not recorded".
    //
    // The escape hatch is `// eslint-disable-next-line no-restricted-syntax` with a
    // written reason. The one legitimate in-scope raw writer is excluded by path.
    files: [
      'app/**/*.{ts,tsx}',
      'components/**/*.{ts,tsx}',
      'lib/**/*.{ts,tsx}',
      'services/**/*.{ts,tsx}',
    ],
    ignores: [
      // The one legitimate writer: writeAudit() itself.
      'lib/audit.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[computed=false][property.name=/^(create|createMany|createManyAndReturn|upsert)$/] > MemberExpression[computed=false][property.name='auditLog']",
          message:
            'Audit rows must be written through writeAudit() from @/lib/audit, so every row carries ip and userAgent. Build the envelope once outside the transaction — const env = await getAuditEnvelope(actorId) — then call writeAudit(tx, env, {...}) inside prisma.$transaction, as services/users.ts does. Cron and sweep writes have no request context: pass { actorId, ip: null, userAgent: null } explicitly. Keep any existing .catch(() => undefined) on best-effort audit writes. See DG-06 and docs/compliance/RECORDS-OF-PROCESSING.md.',
        },
      ],
    },
  },
];
