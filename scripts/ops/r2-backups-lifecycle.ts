/**
 * B3 (enterprise assessment, 2026-09-14): put the backup bucket's retention in
 * code instead of in a comment.
 *
 * `.github/workflows/db-backup.yml` claimed "Retention: 30 days, enforced
 * bucket-side via R2 lifecycle rule" and then said, in the same comment block,
 * "TODO operator: confirm lifecycle rule is set". Nothing in the repository ever
 * configured `nmwc-backups` — `scripts/r2-setup-lifecycle.ts` only ever targets
 * the photos bucket. So the documented retention period was, in the worst case,
 * "forever", and in the best case unverifiable: a complete plaintext copy of
 * every customer and every employee password hash, accumulating daily, with the
 * deletion rule existing only as a sentence.
 *
 * This script SETS the rule and, with `--check`, VERIFIES it — so the claim in
 * the residency register (`docs/compliance/DATA-RESIDENCY-REGISTER.md`) can be
 * evidenced on demand rather than believed.
 *
 *   npx tsx scripts/ops/r2-backups-lifecycle.ts            # apply
 *   npx tsx scripts/ops/r2-backups-lifecycle.ts --check    # verify only, exit 1 if wrong
 *
 * Credentials: an R2 token with **Admin Read & Write** on the backups bucket.
 * The object-scoped token the backup workflow uses cannot set lifecycle rules.
 *   BACKUP_R2_ACCOUNT_ID, and either
 *   BACKUP_R2_ADMIN_ACCESS_KEY_ID + BACKUP_R2_ADMIN_SECRET_ACCESS_KEY, or
 *   R2_ADMIN_ACCESS_KEY_ID + R2_ADMIN_SECRET_ACCESS_KEY (account-wide admin).
 */
import {
  S3Client,
  PutBucketLifecycleConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';

const ACCOUNT_ID = process.env.BACKUP_R2_ACCOUNT_ID ?? process.env.R2_ACCOUNT_ID;
const ACCESS_KEY =
  process.env.BACKUP_R2_ADMIN_ACCESS_KEY_ID ?? process.env.R2_ADMIN_ACCESS_KEY_ID;
const SECRET_KEY =
  process.env.BACKUP_R2_ADMIN_SECRET_ACCESS_KEY ?? process.env.R2_ADMIN_SECRET_ACCESS_KEY;
const BUCKET = process.env.BACKUP_R2_BUCKET ?? 'nmwc-backups';
const CHECK_ONLY = process.argv.includes('--check');

/** Days a dump is kept. Must match docs/compliance/DATA-RETENTION-SCHEDULE.md. */
const RETENTION_DAYS = 30;
const RULE_ID = 'db-dumps-30d';
const MULTIPART_RULE_ID = 'incomplete-multipart-1d';

if (!ACCOUNT_ID || !ACCESS_KEY || !SECRET_KEY) {
  console.error(
    'Missing R2 admin credentials. Need BACKUP_R2_ACCOUNT_ID and an admin token\n' +
      '(BACKUP_R2_ADMIN_ACCESS_KEY_ID + BACKUP_R2_ADMIN_SECRET_ACCESS_KEY, or the R2_ADMIN_* pair).\n' +
      'Create one at https://dash.cloudflare.com/<account>/r2/api-tokens with Admin Read & Write.'
  );
  process.exit(1);
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  forcePathStyle: true,
});

const DESIRED = {
  Rules: [
    {
      ID: RULE_ID,
      Status: 'Enabled' as const,
      // Every dump lands under db/ — both the plaintext legacy `.sql.gz` and
      // the encrypted `.sql.gz.age` keys.
      Filter: { Prefix: 'db/' },
      Expiration: { Days: RETENTION_DAYS },
    },
    {
      ID: MULTIPART_RULE_ID,
      Status: 'Enabled' as const,
      Filter: { Prefix: '' },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    },
  ],
};

async function readRules() {
  try {
    const cur = await r2.send(new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }));
    return cur.Rules ?? [];
  } catch (err) {
    const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    if (
      e.name === 'NoSuchLifecycleConfiguration' ||
      e.Code === 'NoSuchLifecycleConfiguration' ||
      e.$metadata?.httpStatusCode === 404
    ) {
      return [];
    }
    throw err;
  }
}

function describe(rules: Awaited<ReturnType<typeof readRules>>): string {
  if (!rules.length) return '(no lifecycle rules — dumps are kept FOREVER)';
  return rules
    .map((r) => `${r.ID} [${r.Status}] prefix=${r.Filter?.Prefix ?? ''} days=${r.Expiration?.Days ?? '—'}`)
    .join('; ');
}

function retentionRuleIsCorrect(rules: Awaited<ReturnType<typeof readRules>>): boolean {
  const rule = rules.find((r) => r.ID === RULE_ID);
  return (
    !!rule &&
    rule.Status === 'Enabled' &&
    rule.Expiration?.Days === RETENTION_DAYS &&
    (rule.Filter?.Prefix ?? '') === 'db/'
  );
}

async function main() {
  console.log(`R2 backup retention — bucket "${BUCKET}" (account ${ACCOUNT_ID!.slice(0, 8)}…)`);
  const before = await readRules();
  console.log(`  current: ${describe(before)}`);

  if (CHECK_ONLY) {
    if (retentionRuleIsCorrect(before)) {
      console.log(`  ✓ "${RULE_ID}" expires db/ objects after ${RETENTION_DAYS} days`);
      return;
    }
    console.error(
      `  ✗ "${RULE_ID}" is missing or wrong — dumps of the entire customer master are not being expired.\n` +
        `    Fix: npx tsx scripts/ops/r2-backups-lifecycle.ts`
    );
    process.exit(1);
  }

  try {
    await r2.send(
      new PutBucketLifecycleConfigurationCommand({ Bucket: BUCKET, LifecycleConfiguration: DESIRED })
    );
  } catch (err) {
    const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'AccessDenied' || e.Code === 'AccessDenied' || e.$metadata?.httpStatusCode === 403) {
      console.error(
        `  ✗ AccessDenied — the token can read and write objects but not configure the bucket.\n` +
          `    Create an Admin Read & Write token at https://dash.cloudflare.com/${ACCOUNT_ID}/r2/api-tokens\n` +
          `    and set BACKUP_R2_ADMIN_ACCESS_KEY_ID / BACKUP_R2_ADMIN_SECRET_ACCESS_KEY.\n` +
          `    Or set it by hand: bucket → Settings → Lifecycle rules → prefix "db/" → expire after ${RETENTION_DAYS} days.`
      );
      process.exit(1);
    }
    throw err;
  }

  const after = await readRules();
  console.log(`  applied: ${describe(after)}`);
  if (!retentionRuleIsCorrect(after)) {
    console.error('  ✗ rule did not take effect as written — check the bucket in the dashboard');
    process.exit(1);
  }
  console.log(`  ✓ dumps under db/ now expire after ${RETENTION_DAYS} days`);
}

main().catch((err) => {
  console.error('R2 backup lifecycle setup failed:', (err as Error).message);
  process.exit(1);
});
