/**
 * PROD-001: verify the atomic claim on `customerEdit.updateMany` so two
 * supervisors hammering Approve at the same time can only land one APPROVED
 * row. The loser's transaction must observe count=0 and bail out without
 * applying the field changes twice.
 *
 * Strategy: create a SUBMITTED edit, fire two simultaneous claim+apply
 * transactions with Promise.all, count winners and losers.
 */
import { PrismaClient, EditState, EditTarget } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

async function tryClaim(editId: string, supervisorId: string, attempt: number) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const claim = await tx.customerEdit.updateMany({
        where: { id: editId, state: EditState.SUBMITTED },
        data: {
          state: EditState.APPROVED,
          reviewedById: supervisorId,
          reviewedAt: new Date(),
        },
      });
      if (claim.count === 0) {
        throw new Error('NOT_PENDING — already claimed');
      }
      // Sleep mimics applyEditChanges work
      await new Promise((r) => setTimeout(r, 30));
      return { winner: true, attempt };
    });
    return result;
  } catch (e) {
    return { winner: false, attempt, error: (e as Error).message };
  }
}

async function main() {
  // Pick an existing branch + customer to attach the throw-away edit to
  const branch = await prisma.branch.findFirst({
    where: { deletedAt: null, status: 'ACTIVE' },
    select: { id: true, customerId: true, branchCode: true },
  });
  if (!branch) throw new Error('no branch');
  const sup = await prisma.user.findUniqueOrThrow({
    where: { username: 'ahmed.alndabi' },
  });

  // Run 5 races
  let winners = 0;
  let losers = 0;
  for (let i = 0; i < 5; i++) {
    const e = await prisma.customerEdit.create({
      data: {
        target: EditTarget.CUSTOMER,
        customerId: branch.customerId,
        state: EditState.SUBMITTED,
        submittedById: sup.id,
        submittedAt: new Date(),
        fieldChanges: [{ field: 'customer.notes', before: null, after: `race-${i}` }],
        attachmentChanges: [],
      },
    });
    const results = await Promise.all([
      tryClaim(e.id, sup.id, 1),
      tryClaim(e.id, sup.id, 2),
      tryClaim(e.id, sup.id, 3),
    ]);
    const wins = results.filter((r) => r.winner).length;
    const losses = results.filter((r) => !r.winner).length;
    winners += wins;
    losers += losses;
    console.log(`Race #${i + 1}: ${wins} winner(s), ${losses} loser(s)`);
    if (wins !== 1) {
      console.error('FAIL: expected exactly 1 winner per race');
    }
    // Clean up
    await prisma.customerEdit.delete({ where: { id: e.id } });
  }

  console.log(
    `\nTotal: ${winners} winners across 5 races (expected 5), ${losers} losers (expected 10).`
  );
  if (winners === 5 && losers === 10) {
    console.log('PROD-001 atomic claim: PASS — only one approver wins per race.');
  } else {
    console.error('PROD-001 atomic claim: FAIL');
    process.exit(1);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
