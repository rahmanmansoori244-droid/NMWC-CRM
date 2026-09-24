// @vitest-environment node
/**
 * The photo bucket's versioning check, pinned without a bucket — and pinned as
 * being CALLED, which is the half this project keeps losing.
 *
 * Gap #3 (adversarial re-benchmark, 2026-09-24): photographs have no backup, and
 * the owner's answer — R2 object versioning plus a non-current-version retention —
 * is a Cloudflare dashboard setting. `scripts/ops/r2-backups-lifecycle.ts --check`
 * is the precedent for verifying one of those from code, and it is also the warning:
 * it could verify the 30-day dump retention from 2026-09-14, four documents cited it
 * as the evidence, and no workflow ever ran it. "On demand" meant never.
 *
 * So there are two halves here and both are load-bearing:
 *   * the predicates AND the mapping that feeds them, because a check that cannot
 *     tell a 7-day retention from a 30-day one is worse than no check — and the
 *     first version could not tell a tag-scoped rule from a whole-bucket one;
 *   * the wiring, because a correct predicate nobody calls is the exact defect
 *     shape that produced 127 "skipped" restore drills.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  argvIssue,
  ruleScope,
  versioningIssue,
  noncurrentRetentionIssue,
  type PhotoLifecycleRule,
} from '@/scripts/ops/r2-photos-versioning';

/**
 * The checks live in a workflow OF THEIR OWN, not as a second job in db-backup.yml.
 * GitHub reports success or failure per workflow, and this check is red until the
 * owner mints an admin token per bucket — inside db-backup.yml it would have
 * camouflaged a failed backup and disarmed the ALLOW_PLAINTEXT_BACKUP guard, whose
 * whole mechanism is that run turning red. Both files are read here so neither side
 * of that separation can be undone quietly.
 */
const R2_WORKFLOW = '.github/workflows/r2-config.yml';
const BACKUP_WORKFLOW = '.github/workflows/db-backup.yml';

/**
 * Strip whole-line comments before asserting against a workflow. The new job's own
 * explanation quotes the script paths being matched, and a comment must never be the
 * thing that makes an assertion pass — that is a guard failing open while looking
 * green. Only whole-line `#`, because `#` is a legal character inside the shell and
 * jq expressions in these files.
 */
const stripComments = (path: string): string =>
  readFileSync(path, 'utf8').replace(/^[ \t]*#.*$/gm, '');

const r2Yaml = stripComments(R2_WORKFLOW);
const backupYaml = stripComments(BACKUP_WORKFLOW);

/** The r2-config job on its own. Anchor on the next top-level key too. */
const r2Job = (() => {
  const start = r2Yaml.indexOf('\n  r2-config:');
  if (start === -1) return '';
  const rest = r2Yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
})();

/** The script, comments removed, for the assertions that can only be structural. */
const script = readFileSync('scripts/ops/r2-photos-versioning.ts', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * readRules' body ONLY. The first version of this test indexed the whole file, and
 * `isCode(err, 'NoSuchBucket')` also appears in readRefusal further up — so it
 * compared readRefusal's line against readRules' and passed whichever way round
 * readRules had them. Swapping the branches did not turn it red. That is the
 * indexOf-matched-the-wrong-occurrence defect this project has already found once.
 */
const readRules = (() => {
  const start = script.indexOf('async function readRules');
  if (start === -1) return '';
  const rest = script.slice(start + 1);
  const next = rest.search(/\n(?:async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
})();

/** A bucket configured the way §6.13 tells the owner to configure it. */
const CORRECT: PhotoLifecycleRule[] = [
  { id: 'gc-marked-7d', enabled: true, scope: 'tag gc-marked=true', noncurrent: null },
  { id: 'incomplete-multipart-1d', enabled: true, scope: null, noncurrent: null },
  { id: 'noncurrent-versions-30d', enabled: true, scope: null, noncurrent: { days: 30 } },
];

describe('the --check-only argument contract', () => {
  it('accepts --check', () => {
    expect(argvIssue(['--check'])).toBeNull();
  });

  it('refuses every other invocation, including an empty one', () => {
    // There is no apply mode on purpose: PutBucketLifecycleConfiguration replaces
    // the bucket's whole configuration and would drop gc-marked-7d (B-02).
    for (const argv of [[], ['--apply'], ['--force'], ['-c'], ['check']]) {
      expect(argvIssue(argv), `argv ${JSON.stringify(argv)}`).toMatch(/pass --check/);
    }
  });
});

describe('what narrows a lifecycle rule', () => {
  it('reads an unfiltered rule as covering the whole bucket', () => {
    for (const rule of [{}, { Prefix: '' }, { Filter: {} }, { Filter: { Prefix: '' } }]) {
      expect(ruleScope(rule), JSON.stringify(rule)).toBeNull();
    }
  });

  it('reads a prefix in either shape, current or deprecated', () => {
    expect(ruleScope({ Filter: { Prefix: 'photos/' } })).toBe('prefix "photos/"');
    expect(ruleScope({ Prefix: 'photos/' })).toBe('prefix "photos/"');
    // Both present and equal is one narrowing, not two.
    expect(ruleScope({ Prefix: 'photos/', Filter: { Prefix: 'photos/' } })).toBe('prefix "photos/"');
  });

  it('does not read a TAG-scoped rule as covering the whole bucket', () => {
    // This is the shape that actually turns up: nmwc-photos already carries it, as
    // gc-marked-7d. `Filter?.Prefix ?? Prefix ?? ''` read it as the whole bucket, and
    // the scope test is the ONLY thing enforcing "no prefix" — so the check passed for
    // exactly the rule it exists to reject.
    expect(ruleScope({ Filter: { Tag: { Key: 'gc-marked', Value: 'true' } } })).toBe(
      'tag gc-marked=true'
    );
  });

  it('does not read a SIZE-scoped rule as covering the whole bucket', () => {
    expect(ruleScope({ Filter: { ObjectSizeGreaterThan: 1048576 } })).toBe(
      'objects over 1048576 bytes'
    );
    expect(ruleScope({ Filter: { ObjectSizeLessThan: 1024 } })).toBe('objects under 1024 bytes');
  });

  it('does not read a Filter.And rule as covering the whole bucket', () => {
    const scope = ruleScope({
      Filter: { And: { Prefix: 'cr/', Tags: [{ Key: 'gc-marked', Value: 'true' }] } },
    });
    expect(scope).toMatch(/prefix "cr\/"/);
    expect(scope).toMatch(/tag gc-marked=true/);
  });

  it('does not read an unreadable Filter.And as covering the whole bucket either', () => {
    // If R2 or the SDK ever grows a predicate this mapping does not know, the wrong
    // answer is "whole bucket" — that is the direction the original defect failed in.
    expect(ruleScope({ Filter: { And: {} } })).toMatch(/cannot read/);
  });
});

describe('versioning must be Enabled, and unreadable is not enabled', () => {
  it('passes only on Enabled', () => {
    expect(versioningIssue({ status: 'Enabled' })).toBeNull();
  });

  it('fails when the bucket was never versioned', () => {
    // S3 and R2 answer a never-versioned bucket with an empty body, so the absent
    // Status is the common real-world case, not an edge one.
    expect(versioningIssue({})).toMatch(/never enabled/);
  });

  it('fails when versioning was turned back off', () => {
    const issue = versioningIssue({ status: 'Suspended' });
    expect(issue).toMatch(/Suspended/);
    expect(issue).toMatch(/not Enabled/);
  });

  it('treats "could not be read" as a failure, not a pass', () => {
    // R2 answered PutBucketVersioning with NotImplemented in 2026-05. If it answers
    // the GET the same way, the only honest result is a failure: unverified is not
    // verified, and a skip here is how 127 drill runs reported green.
    expect(versioningIssue({ unreadable: 'R2 answered NotImplemented' })).toMatch(/could not be read/);
  });

  it('lets unreadable win over a status, so a refactor cannot make it pass', () => {
    expect(versioningIssue({ unreadable: 'AccessDenied', status: 'Enabled' })).toMatch(
      /could not be read/
    );
  });
});

describe('the non-current-version retention', () => {
  it('accepts the documented configuration beside the rules already on the bucket', () => {
    expect(noncurrentRetentionIssue(CORRECT)).toBeNull();
  });

  it('does not care what the rule is named', () => {
    // The owner creates it by hand in the Cloudflare dashboard, so its id is
    // whatever they typed. Pinning the id would fail on a correct bucket.
    expect(
      noncurrentRetentionIssue([
        { id: 'keep-old-photos', enabled: true, scope: null, noncurrent: { days: 30 } },
      ])
    ).toBeNull();
  });

  it('fails when nothing expires non-current versions', () => {
    expect(noncurrentRetentionIssue([])).toMatch(/no rule expires non-current versions/);
    // The rules the photos bucket already has are not a retention: gc-marked-7d
    // expires CURRENT versions, which on a versioned bucket only writes a delete
    // marker and leaves the bytes as a non-current version.
    expect(noncurrentRetentionIssue(CORRECT.slice(0, 2))).toMatch(
      /no rule expires non-current versions/
    );
  });

  it('fails when the rule exists but is Disabled', () => {
    const issue = noncurrentRetentionIssue([
      { id: 'noncurrent-versions-30d', enabled: false, scope: null, noncurrent: { days: 30 } },
    ]);
    expect(issue).toMatch(/Disabled/);
    expect(issue).toMatch(/noncurrent-versions-30d/);
  });

  it.each([
    'prefix "photos/"',
    'tag gc-marked=true',
    'objects over 1048576 bytes',
    'prefix "cr/" and tag gc-marked=true',
  ])('fails when the only non-current rule is narrowed by %s', (scope) => {
    // A prefix was never the only way to narrow a rule, and the earlier predicate
    // only asked about a prefix — so a 30-day retention that applied to tagged
    // objects alone, leaving every untagged photograph unversioned forever, read
    // as green.
    const issue = noncurrentRetentionIssue([
      { id: 'noncurrent-versions-30d', enabled: true, scope, noncurrent: { days: 30 } },
    ]);
    expect(issue).toMatch(/narrowed to part of the bucket/);
    expect(issue).toContain(scope);
  });

  it.each([7, 1, 29, 31, 90, 365])('fails on a %i-day retention', (days) => {
    const issue = noncurrentRetentionIssue([
      { id: 'noncurrent-versions-30d', enabled: true, scope: null, noncurrent: { days } },
    ]);
    expect(issue).toMatch(new RegExp(`=${days}\\b`));
    expect(issue).toMatch(/not 30 days/);
  });

  it('fails on a version-count rule with no day count', () => {
    expect(
      noncurrentRetentionIssue([
        { id: 'keep-3-versions', enabled: true, scope: null, noncurrent: { keepVersions: 3 } },
      ])
    ).toMatch(/no day count/);
  });

  it('fails on a correct 30-day rule that ALSO caps how many versions are kept', () => {
    // NewerNoncurrentVersions was discarded by the first version of this check, so a
    // cap of 2 beside NoncurrentDays=30 read as a clean 30-day retention — while in
    // fact a version is expired as soon as two newer ones exist, which for a
    // re-photographed CR document is the same afternoon.
    const issue = noncurrentRetentionIssue([
      {
        id: 'noncurrent-versions-30d',
        enabled: true,
        scope: null,
        noncurrent: { days: 30, keepVersions: 2 },
      },
    ]);
    expect(issue).toMatch(/newest 2 non-current version/);
    expect(issue).toMatch(/NewerNoncurrentVersions/);
  });

  it('fails when a correct rule sits beside a shorter one', () => {
    // The hole the obvious predicate would have had. Overlapping lifecycle rules do
    // not vote — the shortest expiry wins for the keys it matches — so "at least one
    // correct rule exists" would have reported green while photographs older than a
    // week were already unrecoverable.
    const issue = noncurrentRetentionIssue([
      ...CORRECT,
      { id: 'stray-7d', enabled: true, scope: null, noncurrent: { days: 7 } },
    ]);
    expect(issue).toMatch(/stray-7d=7/);
    expect(issue).toMatch(/shortest expiry/);
  });
});

describe('what readRules takes off the wire', () => {
  it('reads every narrowing, not only Filter.Prefix', () => {
    // The mapping is where the defect was: `r.Filter?.Prefix ?? r.Prefix ?? ''` made a
    // tag-, size- or And-scoped rule indistinguishable from a whole-bucket one.
    expect(readRules).toContain('ruleScope(r)');
    expect(readRules).not.toMatch(/Filter\?\.Prefix/);
  });

  it('keeps NewerNoncurrentVersions instead of only NoncurrentDays', () => {
    expect(readRules).toContain('NoncurrentDays');
    expect(readRules).toContain('NewerNoncurrentVersions');
  });
});

describe('a bucket it cannot read is not a bucket with no rules', () => {
  /**
   * Structural, because the ordering lives in a catch block around a network call
   * and there is no way to reach it without a bucket. `NoSuchBucket` and
   * `NoSuchLifecycleConfiguration` are both 404 on GetBucketLifecycleConfiguration,
   * so the name has to be matched first — otherwise a mis-addressed bucket reports
   * "no rule expires non-current versions", which is a failure for the wrong reason
   * and sends the operator to the wrong dashboard page.
   */
  it('looks at readRules on its own, not at the whole file', () => {
    expect(readRules, 'readRules must be findable').not.toBe('');
    expect(readRules).toContain('GetBucketLifecycleConfigurationCommand');
    // The END boundary is the half that can actually be wrong, and the earlier
    // version of this test asserted the other one: readRefusal is defined ABOVE
    // readRules, so `not.toContain('function readRefusal')` held however the slice
    // was built — including a slice that ran to the end of the file, which is the
    // failure it was meant to catch. These are the neighbours a runaway slice
    // really swallows.
    expect(readRules).not.toContain('function describe');
    expect(readRules).not.toContain('async function main');
    // And the narrowing has to matter: the whole file carries a SECOND NoSuchBucket
    // match, in readRefusal, and the ordering assertion below is only meaningful
    // while readRules holds exactly one of them.
    expect(script.match(/'NoSuchBucket'/g)?.length ?? 0).toBeGreaterThan(1);
    expect(readRules.match(/'NoSuchBucket'/g)).toHaveLength(1);
  });

  it('matches NoSuchBucket before falling back to the 404 meaning "no rules"', () => {
    const iBucket = readRules.indexOf("isCode(err, 'NoSuchBucket')");
    const iNoRules = readRules.indexOf("isCode(err, 'NoSuchLifecycleConfiguration', 404)");
    expect(iBucket, 'the NoSuchBucket branch must exist in readRules').toBeGreaterThan(-1);
    expect(iNoRules, 'the no-lifecycle-configuration branch must exist').toBeGreaterThan(-1);
    expect(iBucket).toBeLessThan(iNoRules);
  });

  it('does not let a bare 404 mean NoSuchBucket either', () => {
    // The reverse mistake: a nameless 404 would then be reported as a missing bucket.
    expect(script).not.toMatch(/isCode\(err, 'NoSuchBucket', 404\)/);
  });
});

describe('the check is wired to something that actually runs', () => {
  it('finds the r2-config job', () => {
    // If this job is renamed or removed, every assertion below would pass vacuously.
    expect(r2Job, `${R2_WORKFLOW} has no r2-config job`).not.toBe('');
  });

  it('runs on a schedule of its own', () => {
    expect(r2Yaml).toMatch(/schedule:/);
    expect(r2Yaml).toMatch(/cron:/);
  });

  it('runs both bucket checks, not just the new one', () => {
    // r2-backups-lifecycle.ts --check existed from 2026-09-14 and nothing ever
    // called it. It is wired here in the same step for exactly that reason.
    expect(r2Job).toContain('scripts/ops/r2-photos-versioning.ts --check');
    expect(r2Job).toContain('scripts/ops/r2-backups-lifecycle.ts --check');
  });

  it('runs both even when the first one fails', () => {
    expect(r2Job).toMatch(/RC=1/);
    expect(r2Job).toMatch(/exit \$RC/);
    // Without this pair the step reads as if both checks run and only the first
    // one does: `set -e` would abort at the `||` of a failing check. Asserting
    // RC=1 and `exit $RC` alone did not catch that — adding `-e` left this test
    // green, which is how it was found.
    expect(r2Job).toMatch(/set -uo pipefail/);
    expect(r2Job).not.toMatch(/set -euo pipefail/);
  });

  it('keeps one admin token per bucket, and does not let them cross', () => {
    // An account-wide admin token would hand whoever holds the photographs' token
    // the backups as well — the separation the whole backup design rests on. Both
    // pairs are named so that each script's `?? <other pair>` fallback resolves to
    // the empty string a missing secret arrives as, instead of reaching across.
    for (const name of [
      'BACKUP_R2_ADMIN_ACCESS_KEY_ID',
      'BACKUP_R2_ADMIN_SECRET_ACCESS_KEY',
      'R2_ADMIN_ACCESS_KEY_ID',
      'R2_ADMIN_SECRET_ACCESS_KEY',
    ]) {
      expect(r2Job, name).toContain(name);
    }
    // A `||` chain between the two pairs would restore the crossing that the empty
    // string prevents, because GitHub's `||` treats an unset secret as falsy.
    expect(r2Job).not.toMatch(/R2_ADMIN_[A-Z_]*\s*:\s*\$\{\{[^}]*\|\|/);
  });

  it('cannot be skipped — in the YAML or inside the shell', () => {
    // `if:` or `continue-on-error` is how a check becomes a 127-run "skipped".
    expect(r2Job).not.toMatch(/^\s*if:/m);
    expect(r2Job).not.toMatch(/continue-on-error/);
    // They are not the only way. The same thing written INSIDE a run block — test
    // the credential, print a note, exit 0 — left all of the assertions above
    // green, which is how this half was found missing. No step in this job may
    // succeed early, and none may report a check it did not run as anything other
    // than a failure.
    expect(r2Job).not.toMatch(/\bexit\s+0\b/);
    expect(r2Job).not.toMatch(/skip/i);
  });

  it('is a workflow of its own, so a not-yet-configured check cannot fail the backup', () => {
    // GitHub reports success or failure per WORKFLOW, not per job. As a second job in
    // db-backup.yml this check — red from merge until the owner mints the tokens —
    // camouflaged the backup job's own failure, which is the alarm that caught seven
    // missing nights this month, and disarmed the ALLOW_PLAINTEXT_BACKUP guard, whose
    // entire mechanism is that run turning red.
    expect(backupYaml).toContain('/api/ops/backup-report');
    expect(backupYaml).toContain('An unencrypted dump must not leave a green run behind');
    expect(backupYaml).not.toContain('r2-photos-versioning.ts');
    expect(backupYaml).not.toContain('r2-backups-lifecycle.ts --check');
    expect(backupYaml).not.toContain('r2-config:');
    // And nothing from the backup half may drift back in here: this workflow must
    // stay unable to take a dump, feed the dead-man, or touch the database.
    expect(r2Yaml).not.toContain('backup-report');
    expect(r2Yaml).not.toContain('pg_dump');
    expect(r2Yaml).not.toContain('DIRECT_URL');
    expect(r2Job).not.toMatch(/needs:/);
  });
});
