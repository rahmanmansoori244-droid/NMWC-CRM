/**
 * The checklist the runbook and OPERATIONS.md point the owner at.
 *
 * It used to carry its own hand-written list of seven secrets, written on
 * 2026-05-10 and never touched again while the workflows grew to sixteen names.
 * The one it omitted that mattered was BACKUP_AGE_RECIPIENTS: an owner who
 * followed this script and skipped the age key got a nightly plaintext copy of
 * the entire customer master uploaded to R2 under a green run.
 *
 * It now renders `lib/ops/required-secrets.ts`, which a unit test compares
 * against the workflow files in both directions, so this cannot drift again.
 *
 * Run with:  npm run ops:print-secrets
 *
 * Prints names and set/missing only. Never a value, of anything, ever.
 */
import { config } from 'dotenv';
import { REQUIRED_SECRETS, type RequiredSecret } from '../lib/ops/required-secrets';

config({ path: ['.env.local', '.env'] });

const REPO = 'https://github.com/rahmanmansoori244-droid/NMWC-CRM';
const PAGE: Record<RequiredSecret['kind'], string> = {
  variable: `${REPO}/settings/variables/actions`,
  secret: `${REPO}/settings/secrets/actions`,
};

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function localHint(r: RequiredSecret): string {
  if (!r.localEnv) return 'set by hand';
  const v = process.env[r.localEnv];
  // Length only. The value itself never reaches stdout, a log, or a screenshot.
  return v ? `in .env as ${r.localEnv} (${v.length} chars)` : `not found in .env (${r.localEnv})`;
}

function table(kind: RequiredSecret['kind'], rows: RequiredSecret[]): void {
  if (rows.length === 0) return;
  const label = kind === 'variable' ? 'VARIABLES' : 'SECRETS';
  console.log(`\n${label} — set these at:`);
  console.log(`  ${PAGE[kind]}\n`);
  console.log('  ' + pad('NAME', 30) + pad('NEEDED?', 11) + 'LOCAL VALUE');
  console.log('  ' + pad('----', 30) + pad('-------', 11) + '-----------');
  for (const r of rows) {
    console.log('  ' + pad(r.name, 30) + pad(r.required ? 'REQUIRED' : 'optional', 11) + localHint(r));
  }
}

function main(): void {
  const live = REQUIRED_SECRETS.filter((r) => !r.escapeHatch);
  const hatches = REQUIRED_SECRETS.filter((r) => r.escapeHatch);

  console.log('GitHub Actions configuration for NMWC CRM');
  console.log('=========================================');
  console.log('\nGitHub keeps variables and secrets on two different pages, so this is');
  console.log('split the same way. Work the VARIABLES page first — it holds the age key');
  console.log('recipients, and without those the nightly backup now refuses to run.');

  // Variables first, deliberately: that is the page carrying the omission that
  // caused this rewrite.
  table('variable', live.filter((r) => r.kind === 'variable'));
  table('secret', live.filter((r) => r.kind === 'secret'));

  console.log('\n\nWHAT EACH ONE IS, AND WHAT HAPPENS WITHOUT IT');
  console.log('=============================================');
  for (const r of live) {
    console.log(`\n  ${r.name}  (${r.kind}, ${r.required ? 'REQUIRED' : 'optional'})`);
    console.log(`    ${r.description}`);
    console.log(`    Where to get it: ${r.source}`);
    console.log(`    Read by: ${r.workflows.join(', ')}`);
    if (r.alsoSetOn) console.log(`    ALSO set the same value at: ${r.alsoSetOn}`);
    console.log(`    If missing: ${r.consequenceIfMissing}`);
  }

  if (hatches.length > 0) {
    console.log('\n\nDo NOT set these unless you have read docs/OPERATIONS.md §6.7');
    console.log('============================================================');
    for (const r of hatches) {
      console.log(`\n  ${r.name}  (${r.kind})`);
      console.log(`    ${r.description}`);
      console.log(`    ${r.source}`);
    }
  }

  const missingRequired = live.filter((r) => r.required);
  console.log('\n\nORDER OF WORK');
  console.log('=============');
  console.log('  1. Generate the age key pair: age-keygen -o nmwc-backup.key');
  console.log('     Put the PUBLIC key in BACKUP_AGE_RECIPIENTS and escrow the private half');
  console.log('     somewhere that is not this machine and not this repository.');
  console.log('  2. Create the backups bucket, and an API token scoped to ONLY that bucket.');
  console.log('     Do not reuse the photographs token: separate tokens limit the blast radius.');
  console.log(`  3. Set the ${missingRequired.length} required names above on their two pages.`);
  console.log('  4. Run the backup once by hand, then confirm the bucket holds');
  console.log('     db/<timestamp>.sql.gz.age — the .age suffix is the proof it was encrypted.');
  console.log(`     ${REPO}/actions/workflows/db-backup.yml`);
  console.log('  5. Add the restore-drill secrets and run the drill once. Until you do, it');
  console.log('     fails red on purpose: no backup of this system has ever been restored.');
  console.log('');
}

main();
