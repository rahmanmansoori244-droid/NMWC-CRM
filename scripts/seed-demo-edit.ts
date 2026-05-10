/**
 * Seeds a single SUBMITTED CustomerEdit so the user-guide screenshots show
 * a populated supervisor queue + a real diff page.
 *
 * Idempotent — if a SUBMITTED edit already exists for the demo customer,
 * does nothing.
 */
import { PrismaClient, EditState, EditTarget, type Prisma } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

const DEMO_CUSTOMER_ID = 'cmozfay5m0003tvfkupla658l';

async function main() {
  const existing = await prisma.customerEdit.findFirst({
    where: { customerId: DEMO_CUSTOMER_ID, state: EditState.SUBMITTED },
  });
  if (existing) {
    console.log('SUBMITTED edit already exists for demo customer:', existing.id);
    return;
  }
  const c1 = await prisma.user.findUniqueOrThrow({ where: { username: 'c1-12345-nmwc' } });
  const cust = await prisma.customer.findUniqueOrThrow({ where: { id: DEMO_CUSTOMER_ID } });
  const edit = await prisma.customerEdit.create({
    data: {
      target: EditTarget.CUSTOMER,
      customerId: DEMO_CUSTOMER_ID,
      state: EditState.SUBMITTED,
      submittedById: c1.id,
      submittedAt: new Date(),
      decisionReason: 'Field visit — owner gave updated contact info.',
      fieldChanges: [
        { field: 'customer.contactPerson', before: cust.contactPerson, after: 'Ahmed Al Saadi' },
        { field: 'customer.primaryPhone', before: cust.primaryPhone, after: '+96891234567' },
        { field: 'customer.notes', before: cust.notes, after: 'Visited Sunday morning, owner present, accepts deliveries before 11am.' },
      ] as unknown as Prisma.InputJsonValue,
      attachmentChanges: [] as unknown as Prisma.InputJsonValue,
    },
  });
  console.log('Created demo SUBMITTED edit:', edit.id);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
