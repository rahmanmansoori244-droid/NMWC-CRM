/**
 * Code review 2026-11-10, finding 23 (adversarial review): a re-upload of the
 * same account sheet must converge. A reset row an earlier upload of the SAME
 * file (same SHA-256) already applied used to be re-checked with the full
 * password-reuse test — two to seven slow password hashes — only to be held
 * back as a reused password. With many resets, a re-upload spent its whole time
 * budget on rows already done and never reached a new one.
 *
 * These two reads let the import hold such a row back with no hash at all. The
 * outcome is the one the reuse test gave (the sheet's password IS one the
 * account has had), told in plainer words; no password is set.
 */
import { prisma } from '@/lib/db';

/** How many earlier uploads of one file are looked at, newest first. */
const EARLIER_UPLOADS_READ = 50;

/** The earlier account uploads of this same file, newest first (ids only). */
export async function earlierAccountUploadsOfFile(batchId: string, fileSha256: string | null): Promise<string[]> {
  if (!fileSha256) return [];
  const rows = await prisma.importBatch.findMany({
    where: { kind: 'ACCOUNT', fileSha256, id: { not: batchId } },
    orderBy: { uploadedAt: 'desc' },
    take: EARLIER_UPLOADS_READ,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * When one of those uploads reset this account's password (its own audit row,
 * written in the same transaction as the reset, so it exists only if the reset
 * committed); null if none did. Reads the account's own reset rows by its
 * (entityType, entityId) index; returns a time, never a row.
 */
export async function resetByEarlierUpload(userId: string, earlierBatchIds: string[]): Promise<Date | null> {
  if (earlierBatchIds.length === 0) return null;
  const hit = await prisma.auditLog.findFirst({
    where: {
      entityType: 'User',
      entityId: userId,
      reason: 'password_reset_via_import',
      OR: earlierBatchIds.map((id) => ({ after: { path: ['batchId'], equals: id } })),
    },
    orderBy: { at: 'desc' },
    select: { at: true },
  });
  return hit?.at ?? null;
}
