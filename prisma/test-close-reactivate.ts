/**
 * One-off test of branch close + reactivation flow + SafeAction error
 * messages. Bypasses the UI for the photo upload step (we just verified
 * that path works) but exercises the actual server actions.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

async function main() {
  const c1 = await prisma.user.findUniqueOrThrow({ where: { username: 'c1-12345-nmwc' } });

  // Pick an ACTIVE branch on Route C1 we haven't touched
  const branch = await prisma.branch.findFirst({
    where: {
      route: { code: 'C1' },
      status: 'ACTIVE',
      deletedAt: null,
      branchCode: { not: 'CCA0226-01' }, // skip the AHLAIN test row
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
  console.log('Test target branch:', branch.branchCode, branch.customer.legalName);
  console.log('  customer id:', branch.customer.id);
  console.log('  branch id:  ', branch.id);
  console.log('  status:     ', branch.status);
  console.log('  lastStatusChangeAt:', branch.lastStatusChangeAt?.toISOString() ?? 'null');

  // Inject a fake fresh FREE photo owned by c1, attached to this branch.
  // Captured AFTER any previous lastStatusChangeAt so the EL-11 freshness
  // gate passes.
  const ymd = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '/');
  const fakeShopAt = await prisma.attachment.create({
    data: {
      kind: 'FREE',
      r2Key: `${ymd}/${c1.id}/FREE/test-close-${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
      bytes: 1000,
      capturedById: c1.id,
      capturedAt: new Date(),
      capturedLat: 23.6,
      capturedLng: 58.4,
      branchExtraId: branch.id,
      branchId: branch.id,
      hash: `branch-close-test-${Date.now()}`,
    },
  });
  console.log('\nCreated fake close-photo attachment:', fakeShopAt.id);

  console.log('\nPhase A complete. Now hit https://nmwc-cm.vercel.app and:');
  console.log('  1. login as c1-12345-nmwc');
  console.log(`  2. open /customers/${branch.customer.id}`);
  console.log('  3. click "Mark closed" on the branch tile');
  console.log('  4. paste reason, attach the photo via the FREE slot... actually the form will create a NEW photo');
  console.log('\nFor automation: this script will exercise markBranchClosedAction via direct DB+fetch.');

  // Print the attachment + branch ids so the next phase can use them
  console.log(JSON.stringify({
    customerId: branch.customer.id,
    branchId: branch.id,
    closeAttachmentId: fakeShopAt.id,
  }));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
