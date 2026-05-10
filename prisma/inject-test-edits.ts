/**
 * One-off — inject two SUBMITTED CustomerEdit rows on Route C1 customers,
 * with all mandatory fields pre-populated so the approve-time gate passes.
 *
 * Usage:  npx tsx prisma/inject-test-edits.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

async function main() {
  const c1 = await prisma.user.findUniqueOrThrow({ where: { username: 'c1-12345-nmwc' } });
  const ahmed = await prisma.user.findUniqueOrThrow({ where: { username: 'ahmed.alndabi' } });

  if (c1.supervisorId !== ahmed.id) {
    console.log('FIXUP: c1 supervisorId →', ahmed.id);
    await prisma.user.update({ where: { id: c1.id }, data: { supervisorId: ahmed.id } });
  }

  const candidates = await prisma.customer.findMany({
    where: {
      branches: { some: { route: { code: 'C1' }, deletedAt: null } },
      deletedAt: null,
      crPhotoId: null, // un-prepared customers
    },
    take: 5,
    orderBy: { nmwcCode: 'asc' },
    include: { branches: { take: 1, where: { deletedAt: null } } },
  });

  const channel = await prisma.channel.findUniqueOrThrow({ where: { key: 'GENERAL_TRADE' } });
  const subChannel = await prisma.subChannel.findFirstOrThrow({ where: { channelId: channel.id } });

  async function prepCustomer(c: (typeof candidates)[number]) {
    const today = new Date();
    const ymd = `${today.getUTCFullYear()}/${String(today.getUTCMonth() + 1).padStart(2, '0')}/${String(today.getUTCDate()).padStart(2, '0')}`;
    const mk = (kind: 'CR' | 'SHOP' | 'SIGNBOARD') =>
      prisma.attachment.create({
        data: {
          kind,
          r2Key: `${ymd}/${c1.id}/${kind}/test-${c.id}-${kind}-${Date.now()}.jpg`,
          mimeType: 'image/jpeg',
          bytes: 100000,
          capturedById: c1.id,
          capturedAt: new Date(),
          capturedLat: 23.6,
          capturedLng: 58.4,
          hash: `${'a'.repeat(63)}${kind.charCodeAt(0).toString(16)}`,
        },
      });
    const [crA, shopA, sigA] = await Promise.all([mk('CR'), mk('SHOP'), mk('SIGNBOARD')]);

    const phone = c.primaryPhone ?? `+9685${Math.floor(Math.random() * 9000000 + 1000000)}`;
    const cr = c.crNumber ?? `T${Math.floor(Math.random() * 9000000 + 1000000)}`;

    await prisma.customer.update({
      where: { id: c.id },
      data: {
        channelId: channel.id,
        subChannelId: subChannel.id,
        crNumber: cr,
        crNumberNorm: cr,
        primaryPhone: phone,
        primaryPhoneNorm: phone,
        contactPerson: c.contactPerson ?? 'Field Test Contact',
        crPhotoId: crA.id,
      },
    });
    await prisma.attachment.update({ where: { id: crA.id }, data: { customerId: c.id } });

    const branch = c.branches[0]!;
    await prisma.branch.update({
      where: { id: branch.id },
      data: {
        gpsLat: 23.6,
        gpsLng: 58.4,
        gpsAccuracy: 10,
        gpsCapturedAt: new Date(),
        dayOfVisit: 'SAT',
        shopPhotoId: shopA.id,
        signboardPhotoId: sigA.id,
        address:
          branch.address && branch.address.length >= 3 ? branch.address : 'Muttrah, Muscat',
      },
    });
    await prisma.attachment.update({ where: { id: shopA.id }, data: { branchId: branch.id } });
    await prisma.attachment.update({ where: { id: sigA.id }, data: { branchId: branch.id } });
    return c;
  }

  const customerA = await prepCustomer(candidates[0]);
  const editA = await prisma.customerEdit.create({
    data: {
      target: 'CUSTOMER',
      customerId: customerA.id,
      state: 'SUBMITTED',
      submittedById: c1.id,
      submittedAt: new Date(),
      fieldChanges: [
        {
          field: 'customer.notes',
          before: customerA.notes ?? null,
          after: 'Field-test by c1: store visited Sunday morning, all confirmed.',
        },
      ] as never,
      attachmentChanges: [] as never,
    },
  });
  console.log('SCENARIO A (will be APPROVED by ahmed):');
  console.log(`  customer:  ${customerA.nmwcCode} — ${customerA.legalName}`);
  console.log(`  editId:    ${editA.id}`);

  const customerB = await prepCustomer(candidates[1]);
  const editB = await prisma.customerEdit.create({
    data: {
      target: 'CUSTOMER',
      customerId: customerB.id,
      state: 'SUBMITTED',
      submittedById: c1.id,
      submittedAt: new Date(),
      fieldChanges: [
        {
          field: 'customer.notes',
          before: customerB.notes ?? null,
          after: 'wrong note — should be rejected',
        },
      ] as never,
      attachmentChanges: [] as never,
    },
  });
  console.log('\nSCENARIO B (will be REJECTED by ahmed):');
  console.log(`  customer:  ${customerB.nmwcCode} — ${customerB.legalName}`);
  console.log(`  editId:    ${editB.id}`);

  console.log('\nGo to https://nmwc-cm.vercel.app/approvals as ahmed.alndabi.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
