/**
 * B4 (enterprise assessment, 2026-09-14) — the audit trail is append-only AT
 * THE DATABASE: "AuditLog" and "EditApproval" refuse UPDATE / DELETE / TRUNCATE
 * even for the owner credential unless a maintenance transaction is opened
 * (prisma/migrations/20260914150000_audit_immutability).
 *
 *   RUN_AUDIT_IMMUTABLE=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/audit-immutability.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { purgeAuditLog, purgeCustomerEdits, withAuditMaintenance } from '../support/audit';

const ENABLED = process.env.RUN_AUDIT_IMMUTABLE === '1' && !!process.env.DATABASE_URL;
const sfx = `aim${Date.now().toString(36)}`;

describe.skipIf(!ENABLED)('B4: AuditLog and EditApproval are append-only at the database', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let userId = '';
  let customerId = '';

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    const u = await prisma.user.create({
      data: { username: `${sfx}.actor`, fullName: 'Audit Actor', role: 'STEWARD', passwordHash: 'x' },
    });
    userId = u.id;
    const c = await prisma.customer.create({
      data: { nmwcCode: `${sfx}-C`, legalName: `Audit customer ${sfx}` },
    });
    customerId = c.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await purgeCustomerEdits(prisma, { where: { customerId } });
    await purgeAuditLog(prisma, { where: { actorId: userId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('an AuditLog row can be written but not updated, deleted or truncated', async () => {
    const row = await prisma.auditLog.create({
      data: { actorId: userId, action: 'UPDATE', entityType: 'System', entityId: sfx, reason: 'original' },
    });
    await expect(
      prisma.auditLog.update({ where: { id: row.id }, data: { reason: 'tampered' } })
    ).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.deleteMany({ where: { actorId: userId } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "AuditLog"`)).rejects.toThrow(/append-only/);
    const still = await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } });
    expect(still.reason).toBe('original');
  });

  it('a decided request cannot be deleted because its step ledger is append-only (FK cascade is refused)', async () => {
    const edit = await prisma.customerEdit.create({
      data: {
        target: 'CUSTOMER',
        customerId,
        state: 'APPROVED',
        submittedById: userId,
        submittedAt: new Date(),
        fieldChanges: [],
        attachmentChanges: [],
        steps: { create: { cycle: 1, stepIndex: 0, role: 'SUPERVISOR', decision: 'APPROVED', actorId: userId } },
      },
      include: { steps: true },
    });
    expect(edit.steps).toHaveLength(1);
    await expect(
      prisma.editApproval.update({ where: { id: edit.steps[0]!.id }, data: { decision: 'REJECTED' } })
    ).rejects.toThrow(/append-only/);
    await expect(prisma.customerEdit.delete({ where: { id: edit.id } })).rejects.toThrow(/append-only/);
    expect(await prisma.customerEdit.findUnique({ where: { id: edit.id } })).not.toBeNull();
  });

  it('a maintenance transaction (SET LOCAL nmwc.audit_maintenance) may remove rows, and the override does not leak past it', async () => {
    const row = await prisma.auditLog.create({
      data: { actorId: userId, action: 'UPDATE', entityType: 'System', entityId: `${sfx}-tmp` },
    });
    const purged = await withAuditMaintenance(prisma, (tx) =>
      tx.auditLog.deleteMany({ where: { id: row.id } })
    );
    expect(purged.count).toBe(1);
    // A later statement on the same pool must NOT inherit the override.
    const again = await prisma.auditLog.create({
      data: { actorId: userId, action: 'UPDATE', entityType: 'System', entityId: `${sfx}-tmp2` },
    });
    await expect(prisma.auditLog.delete({ where: { id: again.id } })).rejects.toThrow(/append-only/);
  });
});
