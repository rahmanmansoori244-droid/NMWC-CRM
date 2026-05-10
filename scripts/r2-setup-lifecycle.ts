/**
 * Senior-audit operational follow-up #3: configure R2 bucket versioning + a
 * lifecycle rule that permanently expires objects tagged `gc-marked=true`
 * after 7 days.
 *
 * Why: photo-gc cron now writes the tag instead of `DeleteObjectCommand`
 * (B-02). Without a matching lifecycle rule on R2 the tagged objects
 * accumulate forever. With it, soft-deleted photos linger ≥7 days for
 * accidental-delete recovery, then disappear.
 *
 * Note: Cloudflare R2 supports the S3 lifecycle API but with limits
 * (max 1000 rules per bucket, no transitions to other storage classes,
 * tag-based filters supported). The same goes for Object Versioning —
 * supported via the S3 PutBucketVersioning API.
 *
 * Idempotent: re-running just overwrites the existing config. Run with:
 *   npx tsx scripts/r2-setup-lifecycle.ts
 */
import {
  S3Client,
  PutBucketVersioningCommand,
  GetBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
// Prefer admin token (bucket-level config scope) when present; fall back to
// the regular R2 object token. The admin path is required for
// PutBucketLifecycleConfiguration; the object token returns AccessDenied.
const ACCESS_KEY = process.env.R2_ADMIN_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY = process.env.R2_ADMIN_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET ?? 'nmwc-photos';
const USING_ADMIN = !!process.env.R2_ADMIN_ACCESS_KEY_ID;

if (!ACCOUNT_ID || !ACCESS_KEY || !SECRET_KEY) {
  console.error(
    'Missing R2 credentials. Need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in env.'
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

async function configureVersioning() {
  console.log(`[1/2] Enabling Object Versioning on ${BUCKET}…`);
  try {
    await r2.send(
      new PutBucketVersioningCommand({
        Bucket: BUCKET,
        VersioningConfiguration: { Status: 'Enabled' },
      })
    );
    const status = await r2.send(new GetBucketVersioningCommand({ Bucket: BUCKET }));
    console.log(`      → Status: ${status.Status ?? '(unset)'}`);
  } catch (err) {
    // R2 returns NotImplemented (HTTP 501) for PutBucketVersioning when the
    // bucket lacks the versioning bucket-class. AWS SDK exposes this as either
    // err.name='NotImplemented' or err.Code='NotImplemented' depending on
    // protocol path.
    const e = err as { name?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    const isNotImplemented =
      e.name === 'NotImplemented' ||
      e.Code === 'NotImplemented' ||
      e.$metadata?.httpStatusCode === 501 ||
      (e.message ?? '').includes('NotImplemented');
    if (isNotImplemented) {
      console.warn(
        `      ⚠ R2 does not expose PutBucketVersioning via the S3 API.`
      );
      console.warn(
        `        → Enable Object Versioning manually:`
      );
      console.warn(
        `          https://dash.cloudflare.com/${ACCOUNT_ID}/r2/default/buckets/${BUCKET}/settings`
      );
      return;
    }
    throw err;
  }
}

async function configureLifecycle() {
  console.log(`[2/2] Setting lifecycle rule "gc-marked-7d" on ${BUCKET}…`);
  try {
    await r2.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: BUCKET,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'gc-marked-7d',
              Status: 'Enabled',
              Filter: {
                Tag: { Key: 'gc-marked', Value: 'true' },
              },
              Expiration: {
                Days: 7,
              },
            },
            {
              ID: 'incomplete-multipart-1d',
              Status: 'Enabled',
              Filter: { Prefix: '' },
              AbortIncompleteMultipartUpload: {
                DaysAfterInitiation: 1,
              },
            },
          ],
        },
      })
    );
    const cur = await r2.send(new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }));
    console.log(`      → ${cur.Rules?.length ?? 0} rule(s) active`);
    for (const r of cur.Rules ?? []) {
      console.log(`        - ${r.ID} [${r.Status}]`);
    }
  } catch (err) {
    const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    const isAccessDenied =
      e.name === 'AccessDenied' ||
      e.Code === 'AccessDenied' ||
      e.$metadata?.httpStatusCode === 403;
    if (isAccessDenied) {
      console.warn(
        `      ⚠ The R2 token in your .env (${(process.env.R2_ACCESS_KEY_ID ?? '').slice(0, 8)}…) has only Object Read/Write permission, not Bucket Admin.`
      );
      console.warn(`        Two ways to fix:`);
      console.warn(
        `        A) Create a new token with Admin Read & Write at`
      );
      console.warn(
        `           https://dash.cloudflare.com/${ACCOUNT_ID}/r2/api-tokens`
      );
      console.warn(
        `           Set R2_ADMIN_ACCESS_KEY_ID + R2_ADMIN_SECRET_ACCESS_KEY in .env, re-run this script.`
      );
      console.warn(
        `        B) Set the lifecycle rule manually via the R2 dashboard:`
      );
      console.warn(
        `           https://dash.cloudflare.com/${ACCOUNT_ID}/r2/default/buckets/${BUCKET}/settings`
      );
      console.warn(
        `           Add rule: Tag filter "gc-marked"="true" → Expire after 7 days.`
      );
      return;
    }
    throw err;
  }
}

async function main() {
  console.log(
    `R2 setup for bucket "${BUCKET}" (account ${(ACCOUNT_ID ?? '').slice(0, 8)}… using ${USING_ADMIN ? 'ADMIN' : 'object'} token)`
  );
  await configureVersioning();
  await configureLifecycle();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('R2 setup failed:', err);
  process.exit(1);
});
