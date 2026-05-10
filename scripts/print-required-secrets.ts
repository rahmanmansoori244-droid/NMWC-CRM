/**
 * Senior-audit operational follow-up #2: helper for the operator setting up
 * GitHub Actions secrets needed by the daily backup workflow.
 *
 * Reads `.env` for values that already exist locally, and prints exactly
 * which GitHub Actions secrets are needed and where to set them.
 *
 * Run with:  npx tsx scripts/print-required-secrets.ts
 *
 * Does NOT print secret VALUES. Only names + status (set/missing) + the
 * dashboard URL where the operator pastes the values.
 */
import { config } from 'dotenv';
config();

const REPO_URL = 'https://github.com/rahmanmansoori244-droid/NMWC-CRM/settings/secrets/actions';

type Required = {
  name: string;
  description: string;
  source: string;
  required: boolean;
  presentInLocalEnv?: string; // env var name to read from .env
};

const REQUIRED: Required[] = [
  {
    name: 'DIRECT_URL',
    description: 'Direct (non-pooled) Postgres connection string for pg_dump.',
    source: 'Neon console → Project → Connection details → "Direct" mode.',
    required: true,
    presentInLocalEnv: 'DIRECT_URL',
  },
  {
    name: 'BACKUP_R2_ACCOUNT_ID',
    description: 'Cloudflare account hosting the nmwc-backups R2 bucket.',
    source: 'Cloudflare dashboard → R2 → bucket settings.',
    required: true,
    presentInLocalEnv: 'R2_ACCOUNT_ID',
  },
  {
    name: 'BACKUP_R2_BUCKET',
    description: 'Bucket name (recommended: nmwc-backups, separate from photos).',
    source: 'Create the bucket via Cloudflare dashboard if missing.',
    required: true,
  },
  {
    name: 'BACKUP_R2_ACCESS_KEY_ID',
    description: 'Object Read+Write token scoped to the backups bucket.',
    source:
      'Cloudflare R2 → API tokens → Create token → Object Read & Write → restrict to nmwc-backups.',
    required: true,
  },
  {
    name: 'BACKUP_R2_SECRET_ACCESS_KEY',
    description: 'Pair of BACKUP_R2_ACCESS_KEY_ID — shown once at creation.',
    source: 'Same flow as BACKUP_R2_ACCESS_KEY_ID. Save before you close the dialog.',
    required: true,
  },
  {
    name: 'NEON_API_KEY',
    description: 'Used by the manual `restore-drill` job to spin up a temp branch.',
    source: 'Neon console → Settings → API keys.',
    required: false,
  },
  {
    name: 'NEON_PROJECT_ID',
    description: 'Neon project to drill into.',
    source: 'Neon console → Project → Settings → Project ID.',
    required: false,
  },
];

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function main() {
  console.log('GitHub Actions secrets required by .github/workflows/db-backup.yml');
  console.log('==================================================================\n');
  console.log(`Set them at: ${REPO_URL}\n`);
  console.log(pad('SECRET NAME', 32) + pad('REQUIRED?', 12) + 'LOCAL HINT');
  console.log(pad('-----------', 32) + pad('---------', 12) + '----------');
  for (const r of REQUIRED) {
    let hint = '(must be set manually)';
    if (r.presentInLocalEnv) {
      const v = process.env[r.presentInLocalEnv];
      hint = v
        ? `value found in .env at ${r.presentInLocalEnv} (${v.length} chars)`
        : `expected in .env at ${r.presentInLocalEnv} but not found`;
    }
    console.log(pad(r.name, 32) + pad(r.required ? 'YES' : 'optional', 12) + hint);
  }
  console.log('\nDetails:');
  for (const r of REQUIRED) {
    console.log(`\n  ${r.name}`);
    console.log(`    ${r.description}`);
    console.log(`    Source: ${r.source}`);
  }
  console.log('\nNext steps for the operator:');
  console.log(`  1. Create the R2 bucket "nmwc-backups" if it doesn't exist.`);
  console.log(
    `  2. Create a separate API token scoped to ONLY that bucket (Object Read & Write).`
  );
  console.log(
    `     Do NOT reuse the photos token — keeping them split limits blast radius.`
  );
  console.log(`  3. Open ${REPO_URL}`);
  console.log(`  4. Add each secret above.`);
  console.log(`  5. Trigger the workflow manually:`);
  console.log(`     https://github.com/rahmanmansoori244-droid/NMWC-CRM/actions/workflows/db-backup.yml`);
  console.log(`  6. Confirm a green run, then check the bucket has db/<DATE>.sql.gz.`);
}

main();
