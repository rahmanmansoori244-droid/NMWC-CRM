'use server';

/**
 * X-AUTH-1: the ONE server action the change-password page may carry.
 *
 * Next registers every export of a 'use server' module a page imports in that
 * page's action worker. /profile/change-password is the only page the
 * middleware lets a session with mustChangePassword reach, so when its form
 * imported this action from services/users.ts, a flagged Manager or Steward
 * could POST createUser / resetPassword / toggleUserActive / updateUserRole to
 * that path and run them without ever changing the password. Keep this module
 * to this one export: tests/unit/actor-guard.test.ts and the CI step after
 * `next build` (scripts/ci/check-action-workers.ts) both fail if it grows.
 */
import { prisma } from '@/lib/db';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { ValidationError, runAction, type SafeAction } from '@/lib/errors';
import { requireActor } from '@/lib/session';
import { revalidatePath } from 'next/cache';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import {
  assertPasswordNotReused,
  passwordRule,
  rotatePasswordHistory,
} from '@/lib/password-policy';

/**
 * AUTH-16: self-service password change. Validates the current password
 * then writes a new hash and clears `mustChangePassword`. Bumps
 * `sessionsRevokedAt` so any other open sessions for this user die.
 */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordRule,
});

export async function changeOwnPasswordAction(formData: FormData): SafeAction<void> {
  return runAction(() => changeOwnPasswordCore(formData));
}

async function changeOwnPasswordCore(formData: FormData) {
  // F15: the one action a session with mustChangePassword may run.
  const actor = await requireActor({ allowPasswordChange: true });

  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get('currentPassword'),
    newPassword: formData.get('newPassword'),
  });
  if (!parsed.success) {
    throw new ValidationError(
      Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]))
    );
  }
  const me = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
  const ok = await bcrypt.compare(parsed.data.currentPassword, me.passwordHash);
  if (!ok) {
    // AUTH-19: same opaque message as a login failure so we don't leak whether
    // the current password was wrong vs. a server hiccup.
    throw new ValidationError({ currentPassword: 'Current password incorrect.' });
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    throw new ValidationError({ newPassword: 'New password must differ from current.' });
  }
  // B-15: also reject if the chosen new password matches any of the last
  // 5 hashes for this user. The current hash is checked above (current ===
  // new short-circuits earlier), so only history needs checking here.
  await assertPasswordNotReused(me.id, me.passwordHash, parsed.data.newPassword);

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  const env = await getAuditEnvelope(me.id);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: me.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        sessionsRevokedAt: new Date(),
      },
    });
    // B-15: stash the OLD hash in PasswordHistory and prune to 5 entries.
    await rotatePasswordHistory(tx, me.id, me.passwordHash);
    await writeAudit(tx, env, {
      action: 'UPDATE',
      entityType: 'User',
      entityId: me.id,
      reason: 'self_password_change',
    });
  });
  revalidatePath('/profile');
}
