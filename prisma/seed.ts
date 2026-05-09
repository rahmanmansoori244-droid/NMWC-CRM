/**
 * Seed script — minimal demo data for M0/M1.
 * Idempotent: safe to re-run.
 *
 * Run with: npm run db:seed
 */
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

const CHANNELS = [
  {
    key: 'HORECA',
    label: 'HORECA',
    order: 1,
    subs: ['Restaurants', 'Cafés/Coffee shops', 'Hotels/Resorts', 'Catering', 'Cinemas', 'Gyms'],
  },
  { key: 'MODERN_TRADE', label: 'Modern Trade', order: 2, subs: ['Hypermarkets', 'Supermarkets'] },
  {
    key: 'GENERAL_TRADE',
    label: 'General Trade',
    order: 3,
    subs: ['Small Groceries', 'Mini-markets', 'Pharmacies'],
  },
  {
    key: 'CONVENIENCE_AND_GAS',
    label: 'Convenience & Gas',
    order: 4,
    subs: ['Petrol station convenience stores'],
  },
  {
    key: 'ECOMMERCE',
    label: 'E-Commerce',
    order: 5,
    subs: ['Food-delivery apps', 'eGrocery apps'],
  },
  {
    key: 'HOME_OFFICE_DELIVERY',
    label: 'Home & Office Delivery',
    order: 6,
    subs: ['Residential 5gb', 'Small offices'],
  },
  {
    key: 'INSTITUTIONS',
    label: 'Institutions',
    order: 7,
    subs: [
      'Government/Municipalities/Military',
      'Education',
      'Healthcare',
      'Construction/Worker camps',
      'Mosques',
    ],
  },
];

// 7 NMWC regions in Oman (placeholder names; real list comes when owner sends master Excel)
const REGIONS = [
  { code: 'MUSCAT', name: 'Muscat' },
  { code: 'BATINAH_N', name: 'Batinah North' },
  { code: 'BATINAH_S', name: 'Batinah South' },
  { code: 'DAKHILIYAH', name: 'Dakhiliyah' },
  { code: 'SHARQIYAH', name: 'Sharqiyah' },
  { code: 'DHAHIRAH', name: 'Dhahirah' },
  { code: 'DHOFAR', name: 'Dhofar' },
];

async function main() {
  console.log('▸ Seeding channels…');
  for (const c of CHANNELS) {
    const channel = await prisma.channel.upsert({
      where: { key: c.key },
      create: { key: c.key, label: c.label, displayOrder: c.order },
      update: { label: c.label, displayOrder: c.order },
    });
    for (const subLabel of c.subs) {
      const subKey = subLabel.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      await prisma.subChannel.upsert({
        where: { channelId_key: { channelId: channel.id, key: subKey } },
        create: { channelId: channel.id, key: subKey, label: subLabel },
        update: { label: subLabel },
      });
    }
  }

  console.log('▸ Seeding regions…');
  for (const r of REGIONS) {
    await prisma.region.upsert({
      where: { code: r.code },
      create: { code: r.code, name: r.name },
      update: { name: r.name },
    });
  }

  console.log('▸ Seeding admin user…');
  const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMeNow!2026';
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await prisma.user.upsert({
    where: { username: 'admin' },
    create: {
      username: 'admin',
      passwordHash,
      fullName: 'NMWC Administrator',
      role: Role.MANAGER,
    },
    update: {},
  });

  console.log('✓ Seed complete.');
  console.log(`  Login as: admin / ${ADMIN_PASSWORD}`);
  console.log('  Change this password immediately after first login (M1).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
