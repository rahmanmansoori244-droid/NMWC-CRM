/**
 * Secure bulk credential reset.
 *
 * SEC-C2 (2026-07-15): this script previously HARD-CODED two shared weak
 * 8-digit passwords (one for salesmen, one for staff) and set
 * `mustChangePassword=false`, committing live pilot credentials to git and
 * nullifying per-user auditability. That is fixed here:
 *
 *   - No password is hard-coded. A unique, cryptographically-random password is
 *     generated per user (>= 12 chars, meeting the app password policy).
 *   - `mustChangePassword=true` is forced on every reset user, so each person
 *     sets their own secret on first login.
 *   - `sessionsRevokedAt` is bumped so any live JWT dies immediately.
 *   - PasswordHistory is preserved (the old script wiped it — a downgrade).
 *   - The generated passwords are printed to STDOUT ONLY, for the operator to
 *     distribute over a secure channel. They are NEVER written to a file, the
 *     repo, or the audit log.
 *
 * SAFETY: dry-run by default. It only mutates the database when the env var
 * `CONFIRM_CREDENTIAL_RESET=yes` is set, so an accidental invocation can never
 * lock the field team out.
 *
 * NOTE (git history): removing the hard-coded values here does NOT remove them
 * from git history. The exposed secrets must still be rotated and the history
 * scrubbed (see docs/discovery/blueprint-inputs/security-remediation.md
 * SR-C1/SR-C2). Treat every previously committed password as burned.
 *
 * Usage:
 *   # dry run (default) — prints who WOULD be reset, changes nothing:
 *   npx tsx scripts/bulk-reset-credentials.ts
 *   # execute for real:
 *   CONFIRM_CREDENTIAL_RESET=yes npx tsx scripts/bulk-reset-credentials.ts
 *   # optionally target one user only:
 *   CONFIRM_CREDENTIAL_RESET=yes npx tsx scripts/bulk-reset-credentials.ts --username=c1-nmwc
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

const CONFIRMED = process.env.CONFIRM_CREDENTIAL_RESET === 'yes';

/** username to reset a single user, or reset all active users when absent. */
const onlyUsername = process.argv
  .find((a) => a.startsWith('--username='))
  ?.split('=')[1];

/** 12-char url-safe random password (~72 bits entropy); meets the >=12 policy. */
function generatePassword(): string {
  return crypto.randomBytes(9).toString('base64url');
}

async function main() {
  console.log('=== Secure bulk credential reset ===');
  console.log(CONFIRMED ? 'MODE: EXECUTE (will write to DB)\n' : 'MODE: DRY RUN (no changes — set CONFIRM_CREDENTIAL_RESET=yes to execute)\n');

  const targets = await prisma.user.findMany({
    where: {
      isActive: true,
      ...(onlyUsername ? { username: onlyUsername } : {}),
    },
    orderBy: { username: 'asc' },
    select: { id: true, username: true, role: true },
  });

  if (targets.length === 0) {
    console.log('No matching active users. Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Users to reset (${targets.length}):`);
  for (const u of targets) console.log(`  ${u.role.padEnd(16)} ${u.username}`);

  if (!CONFIRMED) {
    console.log('\nDry run complete — no passwords generated, no changes made.');
    await prisma.$disconnect();
    return;
  }

  // Generate + hash a unique password per user.
  const issued: Array<{ id: string; username: string; password: string; hash: string }> = [];
  for (const u of targets) {
    const password = generatePassword();
    const hash = await bcrypt.hash(password, 12); // cost 12, same as the seed
    issued.push({ id: u.id, username: u.username, password, hash });
  }

  const now = new Date();
  await prisma.$transaction(
    async (tx) => {
      for (const u of issued) {
        await tx.user.update({
          where: { id: u.id },
          data: {
            passwordHash: u.hash,
            mustChangePassword: true, // force each user to set their own secret
            sessionsRevokedAt: now, // kill any live JWT immediately
          },
        });
      }
      // One audit row — records THAT a reset happened + which users, never the
      // passwords themselves.
      const anyActor = issued[0]!.id;
      await tx.auditLog.create({
        data: {
          actorId: anyActor,
          action: 'UPDATE',
          entityType: 'CredentialBulkReset',
          entityId: now.toISOString(),
          reason: `Secure bulk credential reset: ${issued.length} user(s) → unique random passwords, mustChangePassword=true, sessions revoked. Passwords printed to operator stdout only.`,
          after: {
            resetCount: issued.length,
            usernames: issued.map((u) => u.username),
          } as unknown as Prisma.InputJsonValue,
        },
      });
    },
    { timeout: 60_000 }
  );

  console.log('\n=== Generated passwords (distribute securely, then discard) ===');
  console.log('Do NOT paste these into the repo, chat, email, or any log.\n');
  for (const u of issued) {
    console.log(`  ${u.username.padEnd(20)} ${u.password}`);
  }
  console.log(`\nDone. ${issued.length} user(s) reset; each must change password on next login.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
