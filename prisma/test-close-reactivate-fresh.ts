/**
 * Set up a fresh, clean branch for the full close → approve → reactivate
 * cycle. Cleans up any leftover SUBMITTED/DRAFT edits on the chosen
 * customer so the unique-pending-edit constraint doesn't fight us.
 */
import { PrismaClient, EditState } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

async function main() {
  const c1 = await prisma.user.findUniqueOrThrow({ where: { username: 'c1-12345-nmwc' } });

  // Pick a DIFFERENT ACTIVE branch on Route C1 (skip AQA0549 which has
  // leftover edits from EL-01 testing).
  const branch = await prisma.branch.findFirst({
    where: {
      route: { code: 'C1' },
      status: 'ACTIVE',
      deletedAt: null,
      customerId: { not: 'cmozfdiur00jotvfkreapvu8d' }, // skip AQA0549
      branchCode: { not: 'CCA0226-01' }, // skip AHLAIN
    },
    orderBy: { branchCode: 'asc' },
    select: {
      id: true,
      branchCode: true,
      status: true,
      lastStatusChangeAt: true,
      customer: { select: { id: true, nmwcCode: true, legalName: true } },
    },
  });
  if (!branch) throw new Error('No suitable branch found');

  // Reject any leftover SUBMITTED/DRAFT edits on this customer so we
  // start clean.
  const cleared = await prisma.customerEdit.updateMany({
    where: {
      customerId: branch.customer.id,
      state: { in: [EditState.SUBMITTED, EditState.DRAFT] },
    },
    data: {
      state: EditState.NEEDS_CORRECTION,
      decisionReason: 'cleared for fresh test',
    },
  });
  console.log(`Cleared ${cleared.count} leftover edits on ${branch.customer.legalName}`);

  console.log('Test target branch:', branch.branchCode, branch.customer.legalName);
  console.log('  customer id:', branch.customer.id);
  console.log('  branch id:  ', branch.id);
  console.log('  status:     ', branch.status);
  console.log(
    '  lastStatusChangeAt:',
    branch.lastStatusChangeAt?.toISOString() ?? 'null'
  );

  // Inject a fake fresh FREE photo owned by c1, attached to this branch.
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
  const fakeShopAt = await prisma.attachment.create({
    data: {
      kind: 'FREE',
      r2Key: `${ymd}/${c1.id}/FREE/test-close-fresh-${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
      bytes: 1000,
      capturedById: c1.id,
      capturedAt: new Date(),
      capturedLat: 23.6,
      capturedLng: 58.4,
      branchExtraId: branch.id,
      branchId: branch.id,
      hash: `branch-close-fresh-${Date.now()}`,
    },
  });
  console.log('Created fake close-photo attachment:', fakeShopAt.id);

  console.log(
    JSON.stringify({
      customerId: branch.customer.id,
      branchId: branch.id,
      branchCode: branch.branchCode,
      legalName: branch.customer.legalName,
      closeAttachmentId: fakeShopAt.id,
    })
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
