import { PrismaClient } from '@prisma/client';
async function main() {
  if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
  const p = new PrismaClient();
  const [users, customers, routes] = await Promise.all([p.user.count(), p.customer.count(), p.route.count()]);
  console.log(`after clear: users=${users} customers=${customers} routes=${routes}`);
  await p.$disconnect();
  if (users > 1 || customers > 0 || routes > 0) { console.error('UAT NOT EMPTY — refusing to rehearse on stale data'); process.exit(2); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
