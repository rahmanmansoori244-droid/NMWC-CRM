/**
 * Every GitHub Actions secret and variable this repository's workflows read,
 * declared once.
 *
 * DO-16 — why this exists. `scripts/print-required-secrets.ts` was written on
 * 2026-05-10, the runbook and OPERATIONS.md both point the owner at it as "the
 * checklist", and it had not been touched since: it named seven secrets and the
 * workflows had grown to sixteen names. The one it omitted that mattered was
 * `BACKUP_AGE_RECIPIENTS`. An owner who followed the checklist and skipped the
 * age key got a nightly job that uploaded a plaintext gzip of the entire customer
 * master, plus every employee's bcrypt password hash, to R2 — printing a warning
 * inside a green Actions run, and repeating every night.
 *
 * A hand-maintained checklist drifts silently because nothing compares it to
 * anything. `tests/unit/required-secrets.test.ts` now does: it reads the workflow
 * files, extracts every `secrets.X` and `vars.X`, and fails when this list and
 * the workflows disagree in either direction. Same shape as
 * `lib/compliance/pii-classification.ts`, for the same reason.
 *
 * Pure data. No imports, no runtime consumer, no values — only names.
 */

export type RequiredSecret = {
  /** The name as the workflows reference it. */
  name: string;
  /** GitHub keeps these on two different settings pages. */
  kind: 'secret' | 'variable';
  /** True when a normal production deployment does not work without it. */
  required: boolean;
  /** Workflow file basenames that read it. Pinned by the drift test. */
  workflows: string[];
  description: string;
  /** Where the owner obtains the value. */
  source: string;
  /** Local .env name holding the same value, where one exists. */
  localEnv?: string;
  /** What breaks, in the owner's terms, when it is missing. */
  consequenceIfMissing: string;
  /** A second place the SAME value must be set, or the pair silently disagrees. */
  alsoSetOn?: string;
  /** Escape hatches are rendered apart, so nobody sets one while working a list. */
  escapeHatch?: boolean;
};

/** Provided by GitHub itself; never set by a human. Excluded from the drift test. */
export const WORKFLOW_PROVIDED = ['GITHUB_TOKEN'];

export const REQUIRED_SECRETS: RequiredSecret[] = [
  // ---- secrets ----
  {
    name: 'DIRECT_URL',
    kind: 'secret',
    required: true,
    workflows: ['db-backup.yml', 'provision-app-role.yml'],
    description: 'Direct (non-pooled) Postgres connection string, as the owner role.',
    source: 'Neon console → Project → Connection details → "Direct" mode.',
    localEnv: 'DIRECT_URL',
    consequenceIfMissing:
      'The nightly backup fails at its Validate step. No dump is taken, and the dead-man probe reports a stale heartbeat.',
  },
  {
    name: 'BACKUP_R2_ACCOUNT_ID',
    kind: 'secret',
    required: true,
    workflows: ['db-backup.yml', 'restore-drill.yml'],
    description: 'Cloudflare account hosting the backups bucket.',
    source: 'Cloudflare dashboard → R2 → bucket settings.',
    localEnv: 'R2_ACCOUNT_ID',
    consequenceIfMissing: 'The dump is taken and then cannot be uploaded. Nothing is retained.',
  },
  {
    name: 'BACKUP_R2_BUCKET',
    kind: 'secret',
    required: true,
    workflows: ['db-backup.yml', 'restore-drill.yml'],
    description: 'Bucket name. Keep it separate from the photographs bucket.',
    source: 'Create it in the Cloudflare dashboard if it does not exist.',
    consequenceIfMissing: 'Same as BACKUP_R2_ACCOUNT_ID: the dump is taken and discarded.',
  },
  {
    name: 'BACKUP_R2_ACCESS_KEY_ID',
    kind: 'secret',
    required: true,
    workflows: ['db-backup.yml', 'restore-drill.yml'],
    description: 'Object Read & Write token scoped to the backups bucket ONLY.',
    source: 'Cloudflare R2 → API tokens → Create token → Object Read & Write.',
    consequenceIfMissing: 'Upload is refused. Nothing is retained.',
  },
  {
    name: 'BACKUP_R2_SECRET_ACCESS_KEY',
    kind: 'secret',
    required: true,
    workflows: ['db-backup.yml', 'restore-drill.yml'],
    description: 'The pair of BACKUP_R2_ACCESS_KEY_ID. Shown once, at creation.',
    source: 'Same flow. Save it before closing the dialog.',
    consequenceIfMissing: 'Upload is refused. Nothing is retained.',
  },
  {
    name: 'PROD_CRON_SECRET',
    kind: 'secret',
    required: true,
    workflows: ['db-backup.yml', 'keep-warm.yml', 'sla-escalate.yml'],
    description: 'Bearer token the scheduled jobs present to the production endpoints.',
    source: 'Generate one value (32+ random characters) and use it in BOTH places below.',
    alsoSetOn: 'Vercel → Production → Environment Variables → CRON_SECRET (the SAME value)',
    consequenceIfMissing:
      'Every scheduled call is refused with 401. The SLA sweep stops escalating and the backup report never reaches the dead-man probe — which then alarms, correctly.',
  },
  {
    name: 'BACKUP_AGE_IDENTITY',
    kind: 'secret',
    required: false,
    workflows: ['restore-drill.yml'],
    description: 'The age PRIVATE key, used only by the monthly restore drill to decrypt.',
    source: 'The private half of the key pair whose public half is BACKUP_AGE_RECIPIENTS.',
    consequenceIfMissing:
      'The restore drill cannot decrypt and fails red. That is the intended signal until the key exists: it means no backup of this system has ever been proven restorable.',
  },
  {
    name: 'NEON_API_KEY',
    kind: 'secret',
    required: false,
    workflows: ['restore-drill.yml'],
    description: 'Lets the drill create and drop a throw-away branch to restore into.',
    source: 'Neon console → Settings → API keys.',
    consequenceIfMissing: 'The monthly restore drill cannot run.',
  },
  {
    name: 'NEON_PROJECT_ID',
    kind: 'secret',
    required: false,
    workflows: ['restore-drill.yml'],
    description: 'The Neon project the drill restores into.',
    source: 'Neon console → Project → Settings → Project ID.',
    consequenceIfMissing: 'The monthly restore drill cannot run.',
  },
  {
    name: 'NMWC_APP_PASSWORD',
    kind: 'secret',
    required: false,
    workflows: ['provision-app-role.yml'],
    description: 'Password for the least-privilege runtime role nmwc_app.',
    source: 'Generate 40 random characters. Used when creating or resetting the role.',
    consequenceIfMissing:
      'The role-provisioning workflow cannot create or reset the role. It is dispatch-only, so nothing scheduled breaks.',
  },

  // ---- variables ----
  {
    name: 'BACKUP_AGE_RECIPIENTS',
    kind: 'variable',
    required: true,
    workflows: ['db-backup.yml'],
    description:
      'Age PUBLIC key(s), comma separated, that the nightly dump is encrypted to. Two is the right number: one working key and one escrowed.',
    source: 'Generate with `age-keygen`. Escrow the private half OFF this machine.',
    consequenceIfMissing:
      'The nightly dump is now REFUSED. Before 2026-09-15 it was uploaded in plaintext under a green run — a full copy of the customer master and every password hash, every night. This is the omission that motivated this list.',
  },
  {
    name: 'APP_BASE_URL',
    kind: 'variable',
    required: true,
    workflows: ['db-backup.yml'],
    description: 'Production origin the backup job posts its completion report to.',
    source: 'The production URL, with no trailing slash.',
    consequenceIfMissing:
      'The backup runs but files no report, so the dead-man health probe sees a stale heartbeat and alarms even though the backup succeeded.',
  },
  {
    name: 'KEEP_WARM_PREVIEW_URL',
    kind: 'variable',
    required: false,
    workflows: ['keep-warm.yml'],
    description: 'Optional second origin to keep warm, normally the UAT preview.',
    source: 'The preview alias URL.',
    consequenceIfMissing: 'Only production is kept warm. Harmless.',
  },
  {
    name: 'MIN_DUMP_BYTES',
    kind: 'variable',
    required: false,
    workflows: ['db-backup.yml'],
    description: 'Floor below which a dump is treated as truncated and the run fails.',
    source: 'Set it from a known-good run, not from a guess.',
    consequenceIfMissing: 'The built-in default applies.',
  },
  {
    name: 'PROD_DB_HOST_MARKER',
    kind: 'variable',
    required: false,
    workflows: ['db-backup.yml', 'restore-drill.yml'],
    description:
      'Endpoint fragment identifying production, so a job refuses to act on the wrong database.',
    source: 'The production Neon endpoint id.',
    consequenceIfMissing:
      'The wrong-database guard is disarmed. The jobs still run; they simply stop checking they are pointed where they think.',
  },
  {
    name: 'ALLOW_PLAINTEXT_BACKUP',
    kind: 'variable',
    required: false,
    escapeHatch: true,
    workflows: ['db-backup.yml'],
    description:
      'Set to the exact string "true" to let the nightly job upload an UNENCRYPTED dump.',
    source: 'Do not set this. It exists so that an emergency is possible, not easy.',
    consequenceIfMissing: 'Nothing. Its absence is the correct state.',
  },
];
