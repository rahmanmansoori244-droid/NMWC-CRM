/**
 * Gap #3 (adversarial re-benchmark, 2026-09-24): the photographs have no backup.
 *
 * A database restore returns `Attachment` rows pointing at objects in
 * `nmwc-photos`, and `docs/OPERATIONS.md` §6.1 records that layer as "Nothing —
 * single copy": if an object was overwritten or deleted, the row is dangling and
 * the CR document behind a credit decision is gone. The owner's chosen answer is
 * R2 bucket versioning plus a non-current-version retention, which is a
 * Cloudflare-side setting. A setting nobody checks is a setting that gets turned
 * off, so this is the thing that checks it.
 *
 * Shaped after scripts/ops/r2-backups-lifecycle.ts — same `--check` flag, same
 * refusal on a missing admin credential, same output voice — with one deliberate
 * difference: there is NO APPLY MODE, so `--check` is required rather than
 * optional. Two reasons, both of them an incident waiting to happen:
 *
 *   * `PutBucketLifecycleConfiguration` REPLACES a bucket's entire lifecycle
 *     configuration. `nmwc-photos` already carries `gc-marked-7d`, which is the
 *     only thing that ever deletes the objects `app/api/cron/photo-gc/route.ts`
 *     tags instead of deleting (B-02). A script that PUT a non-current rule alone
 *     would drop it, and tagged photographs would accumulate forever.
 *   * Versioning cannot be turned on from here anyway. R2 answered
 *     `PutBucketVersioning` with NotImplemented when `scripts/r2-setup-lifecycle.ts`
 *     tried it (recorded in docs/SESSION-HANDOFF-2026-05-10.md).
 *
 * "Cannot verify" is reported as a FAILURE, never as a pass and never as a skip.
 * The restore drill's predecessor reported "skipped" for 127 consecutive runs
 * behind a variable nobody had created, and every one of them read as green.
 *
 *   npx tsx scripts/ops/r2-photos-versioning.ts --check
 *
 * WHICH BUCKET: the photo bucket is `R2_BUCKET` (default `nmwc-photos`, the same
 * contract lib/r2.ts reads), which is NOT the backup bucket — that is
 * `BACKUP_R2_BUCKET` (default `nmwc-backups`), deliberately separate credentials
 * and bucket so a leak of one does not expose the other.
 *
 * Credentials: an R2 token with **Admin Read & Write**. The object-scoped token
 * the app uses for photographs cannot read a bucket's configuration.
 *   R2_ACCOUNT_ID (falls back to BACKUP_R2_ACCOUNT_ID), and either
 *   R2_ADMIN_ACCESS_KEY_ID + R2_ADMIN_SECRET_ACCESS_KEY, or the BACKUP_R2_ADMIN_*
 *   pair. Those fallbacks are only correct if both buckets live in one Cloudflare
 *   account. Nothing in this repository asserts that they do, so if they do not,
 *   this check fails against a bucket that is not there — a finding, not a false
 *   pass.
 *
 * The fallback to BACKUP_R2_ADMIN_* is for a PERSON running this by hand with one
 * token exported. `.github/workflows/r2-config.yml` names both pairs, which makes it
 * dead there deliberately: §6.13 mints one bucket-scoped admin token per bucket, so a
 * leaked photographs token cannot reach the backups.
 */
import {
  S3Client,
  GetBucketVersioningCommand,
  GetBucketLifecycleConfigurationCommand,
  type LifecycleRule,
} from '@aws-sdk/client-s3';

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? process.env.BACKUP_R2_ACCOUNT_ID;
const ACCESS_KEY =
  process.env.R2_ADMIN_ACCESS_KEY_ID ?? process.env.BACKUP_R2_ADMIN_ACCESS_KEY_ID;
const SECRET_KEY =
  process.env.R2_ADMIN_SECRET_ACCESS_KEY ?? process.env.BACKUP_R2_ADMIN_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET ?? 'nmwc-photos';

/**
 * Days a non-current photo version is kept. Tied to the 30 days of database dumps
 * (§6.9), not chosen freely: a recovery can restore a dump up to 30 days old, so a
 * photo version that expires sooner than the oldest restorable dump re-opens
 * exactly the gap versioning is being switched on to close.
 */
const NONCURRENT_DAYS = 30;
/** What the owner is told to name the rule. Matched by SHAPE, not by this id — see findNoncurrent. */
const SUGGESTED_RULE_ID = 'noncurrent-versions-30d';

/** The `--check`-only argument contract, separated so it can be asserted without a bucket. */
export function argvIssue(argv: readonly string[]): string | null {
  if (argv.includes('--check')) return null;
  return (
    'this script only verifies — pass --check.\n' +
    '    There is deliberately no apply mode: PutBucketLifecycleConfiguration replaces a\n' +
    "    bucket's WHOLE lifecycle configuration, and nmwc-photos already carries\n" +
    '    gc-marked-7d, the only thing that ever deletes the objects photo-gc tags\n' +
    '    instead of deleting (B-02). Versioning cannot be set through the S3 API here\n' +
    '    either — R2 answered PutBucketVersioning with NotImplemented.\n' +
    '    Set both in the Cloudflare dashboard: docs/OPERATIONS.md §6.13.'
  );
}

/** What GetBucketVersioning told us, including the case where it would not say. */
export type VersioningRead = { status?: string; unreadable?: string };

export function versioningIssue(read: VersioningRead): string | null {
  // Order matters: an unreadable setting is not an unset one, and the two need
  // different things done about them.
  if (read.unreadable) return `could not be read — ${read.unreadable}`;
  if (read.status === 'Enabled') return null;
  if (!read.status) return 'never enabled on this bucket, so an overwritten or deleted photograph is gone';
  return `"${read.status}", not Enabled — versions stopped being kept when it was changed`;
}

/**
 * The fields of an R2 lifecycle rule this check reads, mapped out of the SDK's
 * response rather than passed through, so the predicate below can be asserted
 * against plain objects with no bucket and no credentials.
 */
export type PhotoLifecycleRule = {
  id: string;
  enabled: boolean;
  /**
   * null when the rule applies to every object in the bucket; otherwise what
   * narrows it, in words.
   *
   * A PREFIX is not the only narrowing R2 accepts: `Filter.Tag`, the object-size
   * filters and a `Filter.And` combining them all make a rule apply to part of the
   * bucket. The first version of this mapped `Filter?.Prefix ?? Prefix ?? ''`, so a
   * tag-scoped rule — the shape `nmwc-photos` already carries, `gc-marked-7d` — read
   * as covering the whole bucket. The scope test is the ONLY thing enforcing "no
   * prefix", so that made this check pass for exactly the rules it exists to reject.
   */
  scope: string | null;
  /**
   * null when the rule carries no NoncurrentVersionExpiration at all.
   *
   * `days` is NoncurrentDays. `keepVersions` is NewerNoncurrentVersions, which the
   * first version of this discarded — and a rule with NoncurrentDays=30 AND
   * NewerNoncurrentVersions=2 expires a version as soon as two newer ones exist,
   * which for a re-photographed CR document is the same afternoon, not thirty days.
   * Dropping the field made that read as a clean 30-day retention.
   */
  noncurrent: { days?: number; keepVersions?: number } | null;
};

/**
 * What narrows a lifecycle rule, or null when it applies to every object.
 *
 * Exported so the near-misses can be asserted against plain SDK-shaped objects with
 * no bucket and no credentials — the mapping is where the defect was, so the mapping
 * is what the test has to be able to break.
 */
export function ruleScope(rule: Pick<LifecycleRule, 'Prefix' | 'Filter'>): string | null {
  const parts: string[] = [];
  const sized = (f: {
    Prefix?: string;
    ObjectSizeGreaterThan?: number;
    ObjectSizeLessThan?: number;
  }): void => {
    // Only a NON-EMPTY prefix narrows anything: both shapes report the whole bucket
    // as ''.
    if (f.Prefix) parts.push(`prefix "${f.Prefix}"`);
    if (f.ObjectSizeGreaterThan !== undefined) {
      parts.push(`objects over ${f.ObjectSizeGreaterThan} bytes`);
    }
    if (f.ObjectSizeLessThan !== undefined) {
      parts.push(`objects under ${f.ObjectSizeLessThan} bytes`);
    }
  };
  const tagged = (t: { Key?: string; Value?: string }): void => {
    parts.push(`tag ${t.Key ?? '?'}=${t.Value ?? '?'}`);
  };

  if (rule.Filter) {
    sized(rule.Filter);
    if (rule.Filter.Tag) tagged(rule.Filter.Tag);
    if (rule.Filter.And) {
      const before = parts.length;
      sized(rule.Filter.And);
      for (const t of rule.Filter.And.Tags ?? []) tagged(t);
      // An `And` whose predicates none of the above could read must not fall back to
      // "whole bucket" — that is the exact direction this whole function exists to
      // stop failing in. Report it as a narrowing nobody can characterise, which is
      // a finding the operator can act on.
      if (parts.length === before) parts.push('a Filter.And this check cannot read');
    }
  }
  // Filter.Prefix is the current shape; the top-level Prefix is the deprecated one,
  // and R2 has answered with either. Both can be present and equal, hence the dedupe.
  sized({ Prefix: rule.Prefix });
  const unique = [...new Set(parts)];
  return unique.length ? unique.join(' and ') : null;
}

/**
 * The rule, in one sentence: EVERY enabled lifecycle rule that expires non-current
 * versions must expire them at exactly NONCURRENT_DAYS, and at least one of them
 * must cover the whole bucket.
 *
 * "At least one correct rule exists" would have been the obvious predicate and it
 * is wrong: overlapping lifecycle rules do not vote, the shortest expiry wins for
 * the keys it matches. A correct 30-day rule sitting beside a stray 7-day one
 * would have reported green while photographs older than a week were unrecoverable.
 */
export function noncurrentRetentionIssue(rules: readonly PhotoLifecycleRule[]): string | null {
  const withRetention = rules
    .filter((r) => r.noncurrent !== null)
    .map((r) => ({
      id: r.id,
      enabled: r.enabled,
      scope: r.scope,
      days: r.noncurrent?.days,
      keepVersions: r.noncurrent?.keepVersions,
    }));

  // Each branch names WHICH near-miss this is. They are not interchangeable: every
  // one needs a different field changed in the dashboard, and "the rule is wrong"
  // sends the operator looking in the wrong place.
  if (!withRetention.length) {
    return 'no rule expires non-current versions, so every superseded photograph is kept forever and the bucket grows without bound';
  }
  const enabled = withRetention.filter((r) => r.enabled);
  if (!enabled.length) {
    return `${withRetention.map((r) => r.id).join(', ')} holds the retention but is Disabled`;
  }
  if (!enabled.some((r) => r.scope === null)) {
    return `every non-current-version rule is narrowed to part of the bucket (${enabled
      .map((r) => `${r.id} → ${r.scope}`)
      .join(', ')}) — photographs outside it keep every version forever`;
  }
  const wrong = enabled.filter((r) => r.days !== NONCURRENT_DAYS);
  if (wrong.length) {
    return (
      `${wrong
        .map((r) => `${r.id}=${r.days ?? 'no day count, only a version count'}`)
        .join(', ')} — not ${NONCURRENT_DAYS} days. Shorter than the 30 days of database dumps ` +
      'leaves a restore pointing at objects that are already gone; longer keeps personal data past ' +
      'docs/compliance/DATA-RETENTION-SCHEDULE.md. One stray rule is enough: the shortest expiry ' +
      'wins for the keys it matches.'
    );
  }
  // Checked AFTER the day count, and separately, because it is a different field and
  // a different thing to go and change in the dashboard. A rule may carry both, and
  // then the day count is not what decides: NewerNoncurrentVersions expires a version
  // as soon as that many newer ones exist.
  const capped = enabled.filter((r) => r.keepVersions !== undefined);
  if (capped.length) {
    return (
      `${capped
        .map((r) => `${r.id} keeps only the newest ${r.keepVersions} non-current version(s)`)
        .join(', ')} — NewerNoncurrentVersions expires a version as soon as that many newer ones ` +
      `exist, whatever the ${NONCURRENT_DAYS}-day count beside it says. Re-photograph a CR document ` +
      'three times in an afternoon and the original is gone the same afternoon. Remove the version ' +
      'count and keep the day count.'
    );
  }
  return null;
}

function isCode(err: unknown, code: string, http?: number): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === code || e.Code === code || (http !== undefined && e.$metadata?.httpStatusCode === http);
}

/** Turn the errors that mean "we are not allowed to look" into that message, and rethrow the rest. */
function readRefusal(err: unknown, call: string): string {
  if (isCode(err, 'AccessDenied', 403)) {
    return (
      `${call} returned AccessDenied — this token can read and write objects but not read the\n` +
      `    bucket's configuration, or it is scoped to a different bucket than "${BUCKET}".\n` +
      `    Mint an Admin Read & Write token at https://dash.cloudflare.com/${ACCOUNT_ID}/r2/api-tokens`
    );
  }
  if (isCode(err, 'NoSuchBucket')) {
    return (
      `there is no bucket "${BUCKET}" in account ${ACCOUNT_ID?.slice(0, 8)}… — set R2_ACCOUNT_ID and\n` +
      '    R2_BUCKET for the PHOTO bucket. The fallback to BACKUP_R2_ACCOUNT_ID is only right when\n' +
      '    both buckets live in one Cloudflare account.'
    );
  }
  throw err;
}

async function readVersioning(r2: S3Client): Promise<VersioningRead> {
  try {
    const out = await r2.send(new GetBucketVersioningCommand({ Bucket: BUCKET }));
    // S3 and R2 both answer a never-versioned bucket with an empty body, so an
    // absent Status is "never enabled" rather than an error.
    return out.Status ? { status: out.Status } : {};
  } catch (err) {
    if (isCode(err, 'NotImplemented', 501)) {
      return {
        unreadable:
          'R2 answered NotImplemented, so this bucket does not expose GetBucketVersioning.\n' +
          '    Confirm it in the dashboard and record the date in docs/OPERATIONS.md §6.13. This is\n' +
          '    reported as a failure on purpose: unverified is not verified.',
      };
    }
    return { unreadable: readRefusal(err, 'GetBucketVersioning') };
  }
}

async function readRules(r2: S3Client): Promise<PhotoLifecycleRule[]> {
  try {
    const cur = await r2.send(new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }));
    return (cur.Rules ?? []).map((r) => ({
      id: r.ID ?? '(unnamed)',
      enabled: r.Status === 'Enabled',
      // Every narrowing, not just a prefix — see ruleScope.
      scope: ruleScope(r),
      // BOTH fields. NoncurrentDays alone is not the retention when
      // NewerNoncurrentVersions sits beside it.
      noncurrent: r.NoncurrentVersionExpiration
        ? {
            days: r.NoncurrentVersionExpiration.NoncurrentDays,
            keepVersions: r.NoncurrentVersionExpiration.NewerNoncurrentVersions,
          }
        : null,
    }));
  } catch (err) {
    // NoSuchBucket is ALSO a 404 on this call, so it is matched by NAME before the
    // status code is consulted. The obvious order — 404 means "this bucket has no
    // lifecycle rules" — would report a missing or mis-addressed bucket as "no rule
    // expires non-current versions", which is still a failure but sends the operator
    // to the wrong dashboard page for it.
    if (isCode(err, 'NoSuchBucket')) throw new Error(readRefusal(err, 'GetBucketLifecycleConfiguration'));
    if (isCode(err, 'NoSuchLifecycleConfiguration', 404)) return [];
    // Not a bare rethrow: an AccessDenied here would otherwise print as
    // "the rule is wrong", which is the wrong thing to go and fix.
    throw new Error(readRefusal(err, 'GetBucketLifecycleConfiguration'));
  }
}

function describe(rules: readonly PhotoLifecycleRule[]): string {
  if (!rules.length) return 'no lifecycle rules at all';
  return rules
    .map((r) => {
      const nc = r.noncurrent
        ? [
            r.noncurrent.days !== undefined ? `${r.noncurrent.days}d` : 'set, no day count',
            r.noncurrent.keepVersions !== undefined
              ? `keep newest ${r.noncurrent.keepVersions}`
              : null,
          ]
            .filter((s) => s !== null)
            .join(' + ')
        : '—';
      return `${r.id} [${r.enabled ? 'Enabled' : 'Disabled'}] scope=${
        r.scope ?? 'whole bucket'
      } noncurrent=${nc}`;
    })
    .join('; ');
}

async function main() {
  const badArgs = argvIssue(process.argv.slice(2));
  if (badArgs) {
    console.error(`R2 photo versioning — ${badArgs}`);
    process.exit(1);
  }
  if (!ACCOUNT_ID || !ACCESS_KEY || !SECRET_KEY) {
    console.error(
      'Missing R2 admin credentials for the PHOTO bucket. Need R2_ACCOUNT_ID and an admin token\n' +
        '(R2_ADMIN_ACCESS_KEY_ID + R2_ADMIN_SECRET_ACCESS_KEY, or the BACKUP_R2_ADMIN_* pair if both\n' +
        'buckets are in one Cloudflare account).\n' +
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

  console.log(`R2 photo versioning — bucket "${BUCKET}" (account ${ACCOUNT_ID.slice(0, 8)}…)`);
  const versioning = await readVersioning(r2);
  const rules = await readRules(r2);
  console.log(
    `  current: versioning=${
      versioning.unreadable ? 'unreadable' : (versioning.status ?? '(never enabled)')
    }; ${describe(rules)}`
  );

  const vIssue = versioningIssue(versioning);
  const nIssue = noncurrentRetentionIssue(rules);
  console.log(vIssue ? `  ✗ object versioning ${vIssue}` : '  ✓ object versioning is Enabled');
  console.log(
    nIssue
      ? `  ✗ non-current retention: ${nIssue}`
      : `  ✓ non-current versions expire after ${NONCURRENT_DAYS} days`
  );

  if (vIssue || nIssue) {
    console.error(
      '\n  Photographs are not protected against an overwrite or a delete. This cannot be fixed from\n' +
        `  code: Cloudflare dashboard → R2 → ${BUCKET} → Settings. Turn Object Versioning on, then add\n` +
        `  a lifecycle rule (suggested name "${SUGGESTED_RULE_ID}") that deletes non-current versions\n` +
        `  after ${NONCURRENT_DAYS} days, applying to the WHOLE bucket — no prefix, no tag filter, no\n` +
        '  size filter — and with no version count beside the day count. Steps: docs/OPERATIONS.md §6.13.'
    );
    process.exit(1);
  }

  // Said on the GREEN path deliberately. Versioning is easy to read as "the
  // photographs are backed up", and it is not that: every version lives in the
  // same bucket in the same account, so it survives an overwrite, a delete and a
  // faulty GC run, and does NOT survive the bucket or the account being deleted,
  // or Cloudflare losing the region. §6.1 still says the photographs have one copy.
  console.log(
    '\n  Covers: overwrite, delete, a faulty photo-gc run. Does NOT cover: the bucket or the\n' +
      '  Cloudflare account being deleted, or provider loss — there is still only one copy.'
  );
}

/**
 * Run only when invoked as a command. tests/unit/r2-photo-versioning-guard.test.ts
 * imports this module for the three predicates above, and a top-level main() would
 * have `npm test` reach out to Cloudflare — or exit the whole run on the missing
 * credential guard.
 */
if (/r2-photos-versioning\.ts$/.test(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error('R2 photo versioning check failed:', (err as Error).message);
    process.exit(1);
  });
}
