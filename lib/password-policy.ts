/**
 * The password rules shared by an admin reset (services/users.ts) and a user's
 * own change (services/password.ts).
 *
 * Lives in lib/ and is NOT a 'use server' module: every export of one of those is
 * a server action, and these helpers take a user id and a transaction client, so
 * none of them may be callable from a browser. X-AUTH-1 is why they left
 * services/users.ts at all: the change-password page imported its action from
 * there, and Next registered every user-admin action of that module in the one
 * page a session with mustChangePassword may still reach.
 */
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ValidationError } from '@/lib/errors';

export const passwordRule = z.string().min(12, 'Password must be at least 12 characters');

/**
 * B-15: Password reuse prevention.
 *
 * Walks the user's last 5 PasswordHistory rows AND the user's current hash,
 * comparing each against the proposed plaintext. We compare against current
 * as well as history because the current hash isn't moved into history
 * until after a successful change — without that check, a user could
 * "rotate" to the same password they already have.
 *
 * bcrypt.compare is intentionally serial (we await each one). Five
 * sequential bcrypt compares at cost-12 is ~250-500ms total — fine for an
 * interactive password-change form, and parallelising leaks little.
 */
export async function assertPasswordNotReused(
  userId: string,
  currentHash: string,
  proposedPlain: string
): Promise<void> {
  if (await bcrypt.compare(proposedPlain, currentHash)) {
    throw new ValidationError({
      password: 'You cannot reuse one of your last 5 passwords.',
      newPassword: 'You cannot reuse one of your last 5 passwords.',
    });
  }
  const recent = await prisma.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { hash: true },
  });
  for (const row of recent) {
    if (await bcrypt.compare(proposedPlain, row.hash)) {
      throw new ValidationError({
        password: 'You cannot reuse one of your last 5 passwords.',
        newPassword: 'You cannot reuse one of your last 5 passwords.',
      });
    }
  }
}

/**
 * B-15: Push the user's previous hash onto PasswordHistory and prune so
 * only the most recent 5 rows remain. Runs inside the same transaction
 * as the User.update so a partial failure doesn't desync.
 */
export async function rotatePasswordHistory(
  tx: Prisma.TransactionClient,
  userId: string,
  oldHash: string
): Promise<void> {
  await tx.passwordHistory.create({
    data: { userId, hash: oldHash },
  });
  // Find the cutoff: the 6th-most-recent row (index 5). Anything
  // strictly older is pruned. Keeps the table at ≤5 rows per user.
  const keepers = await tx.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true },
  });
  if (keepers.length === 5) {
    await tx.passwordHistory.deleteMany({
      where: {
        userId,
        id: { notIn: keepers.map((k) => k.id) },
      },
    });
  }
}
