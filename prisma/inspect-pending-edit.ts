/**
 * Quick read of pending CustomerEdits on the AQA0549 customer so we know
 * what's blocking the close attempt.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

async function main() {
  const customerId = process.argv[2] ?? 'cmozfdiur00jotvfkreapvu8d';
  const edits = await prisma.customerEdit.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      state: true,
      target: true,
      branchId: true,
      isReactivation: true,
      isWrongRoute: true,
      createdAt: true,
      updatedAt: true,
      decisionReason: true,
      decisionCategory: true,
      fieldChanges: true,
      attachmentChanges: true,
      submittedById: true,
      reviewedById: true,
      branch: { select: { branchCode: true, status: true } },
    },
  });
  console.log(`Found ${edits.length} edits:`);
  const userIds = new Set<string>();
  for (const e of edits) {
    if (e.submittedById) userIds.add(e.submittedById);
    if (e.reviewedById) userIds.add(e.reviewedById);
  }
  const users = await prisma.user.findMany({
    where: { id: { in: [...userIds] } },
    select: { id: true, username: true },
  });
  const userById = new Map(users.map((u) => [u.id, u.username]));

  for (const e of edits) {
    console.log('---');
    console.log(`  id=${e.id} state=${e.state} target=${e.target}`);
    console.log(`  createdAt=${e.createdAt.toISOString()} by=${userById.get(e.submittedById)}`);
    if (e.reviewedById)
      console.log(`  reviewedAt=${e.updatedAt.toISOString()} by=${userById.get(e.reviewedById)}`);
    console.log(`  branch=${e.branch?.branchCode} (currently ${e.branch?.status})`);
    console.log(`  isReactivation=${e.isReactivation} isWrongRoute=${e.isWrongRoute}`);
    if (e.decisionReason) console.log(`  decisionReason=${e.decisionReason}`);
    if (e.decisionCategory) console.log(`  decisionCategory=${e.decisionCategory}`);
    if (e.fieldChanges) console.log(`  fieldChanges=${JSON.stringify(e.fieldChanges).slice(0, 300)}`);
    if (e.attachmentChanges)
      console.log(`  attachmentChanges=${JSON.stringify(e.attachmentChanges).slice(0, 300)}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
