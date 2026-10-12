/**
 * Seed script — the reference data an empty development, CI or UAT database needs:
 * the channels and their sub-channels, the seven regions, and one Manager account
 * (`admin`). Idempotent: safe to re-run.
 *
 * Run with: npm run db:seed
 *
 * Owner decisions 2026-10-11 (after the data audit of 2026-10-10):
 *   - it NEVER runs on production, not even when --expect-host names it. A
 *     connection string that points there (scripts/lib/assert-not-production.ts
 *     pointsAtProduction: the marker anywhere in it, percent-escaped or not) is
 *     refused before any client is built, so it cannot create the default `admin`
 *     Manager, or anything else, on production. Every other host still goes
 *     through the shared guard (assertNotProduction).
 *   - it only INSERTS rows that are missing and never changes an existing row: no
 *     Region name, no Channel or SubChannel label, no Channel displayOrder, no
 *     account. Every write is a createMany with skipDuplicates (INSERT … ON
 *     CONFLICT DO NOTHING): a row already there, or one that clashes with an
 *     existing row on any unique column, is left exactly as it is. Existing rows
 *     whose stored values differ from the seed's are listed by key only.
 */
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  ProductionGuardRefusal,
  assertNotProduction,
  pointsAtProduction,
  type GuardOutput,
} from '../scripts/lib/assert-not-production';
import { setChangeContext, src } from '../lib/change-context';

export const CHANNELS = [
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
export const REGIONS = [
  { code: 'MUSCAT', name: 'Muscat' },
  { code: 'BATINAH_N', name: 'Batinah North' },
  { code: 'BATINAH_S', name: 'Batinah South' },
  { code: 'DAKHILIYAH', name: 'Dakhiliyah' },
  { code: 'SHARQIYAH', name: 'Sharqiyah' },
  { code: 'DHAHIRAH', name: 'Dhahirah' },
  { code: 'DHOFAR', name: 'Dhofar' },
];

/** The account the seed creates when there is none by that name. */
export const ADMIN_USERNAME = 'admin';

/** A sub-channel's key, from its label. */
export const subChannelKey = (label: string) => label.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** The tables the seed touches, and the only calls it makes on them: reads, and inserts that skip what exists. */
export type SeedDb = {
  channel: Pick<PrismaClient['channel'], 'findMany' | 'createMany'>;
  subChannel: Pick<PrismaClient['subChannel'], 'findMany' | 'createMany'>;
  region: Pick<PrismaClient['region'], 'findMany' | 'createMany'>;
  user: Pick<PrismaClient['user'], 'findUnique' | 'createMany'>;
};

export type SeedReport = {
  inserted: { channels: number; subChannels: number; regions: number; admin: boolean };
  /** Existing rows whose stored values differ from the seed's, by key; each was left exactly as it is. */
  leftAsIs: string[];
};

/**
 * Owner decisions 2026-10-11: insert what is missing, change nothing that exists.
 * Every write is a createMany with skipDuplicates (INSERT … ON CONFLICT DO NOTHING),
 * so no existing row — its name, label, displayOrder or anything else — is ever
 * updated. The admin password is hashed only when the account is about to be made.
 */
export async function insertMissing(db: SeedDb, adminPasswordHash: () => Promise<string>): Promise<SeedReport> {
  const leftAsIs: string[] = [];
  const channelKeys = CHANNELS.map((c) => c.key);

  const channelsBefore = await db.channel.findMany({
    where: { key: { in: channelKeys } },
    select: { key: true, label: true, displayOrder: true },
  });
  for (const c of CHANNELS) {
    const before = channelsBefore.find((b) => b.key === c.key);
    if (before && (before.label !== c.label || before.displayOrder !== c.order)) leftAsIs.push(`Channel ${c.key}`);
  }
  const channels = await db.channel.createMany({
    data: CHANNELS.map((c) => ({ key: c.key, label: c.label, displayOrder: c.order })),
    skipDuplicates: true,
  });

  // Each channel as it stands now, inserted above or already there.
  const channelIds = new Map(
    (await db.channel.findMany({ where: { key: { in: channelKeys } }, select: { id: true, key: true } })).map(
      (c) => [c.key, c.id] as const
    )
  );
  const wanted = CHANNELS.flatMap((c) => {
    const channelId = channelIds.get(c.key);
    return channelId ? c.subs.map((label) => ({ channelKey: c.key, channelId, key: subChannelKey(label), label })) : [];
  });
  const subsBefore = await db.subChannel.findMany({
    where: { channelId: { in: [...channelIds.values()] } },
    select: { channelId: true, key: true, label: true },
  });
  for (const w of wanted) {
    const before = subsBefore.find((b) => b.channelId === w.channelId && b.key === w.key);
    if (before && before.label !== w.label) leftAsIs.push(`SubChannel ${w.channelKey}/${w.key}`);
  }
  const subChannels = await db.subChannel.createMany({
    data: wanted.map((w) => ({ channelId: w.channelId, key: w.key, label: w.label })),
    skipDuplicates: true,
  });

  const regionsBefore = await db.region.findMany({
    where: { code: { in: REGIONS.map((r) => r.code) } },
    select: { code: true, name: true },
  });
  for (const r of REGIONS) {
    const before = regionsBefore.find((b) => b.code === r.code);
    if (before && before.name !== r.name) leftAsIs.push(`Region ${r.code}`);
  }
  // A region whose name another region already has is skipped too (name is unique).
  const regions = await db.region.createMany({
    data: REGIONS.map((r) => ({ code: r.code, name: r.name })),
    skipDuplicates: true,
  });

  let admin = false;
  if (!(await db.user.findUnique({ where: { username: ADMIN_USERNAME }, select: { id: true } }))) {
    const made = await db.user.createMany({
      data: [
        {
          username: ADMIN_USERNAME,
          passwordHash: await adminPasswordHash(),
          fullName: 'NMWC Administrator',
          role: Role.MANAGER,
        },
      ],
      skipDuplicates: true,
    });
    admin = made.count === 1;
  }

  return {
    inserted: { channels: channels.count, subChannels: subChannels.count, regions: regions.count, admin },
    leftAsIs,
  };
}

const consoleOutput: GuardOutput = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * Owner decisions 2026-10-11: the seed never runs on production — not with
 * --expect-host, not with anything else on the command line. Called before any
 * client is built; prints why (never the URL) and throws.
 */
export function refuseProductionSeed(url: string | undefined, out: GuardOutput = consoleOutput): void {
  if (url && pointsAtProduction(url)) {
    out.error('[seed] refusing: this connection points at PRODUCTION, and prisma/seed.ts never runs there,');
    out.error('  not even with --expect-host: it would create the default admin Manager (owner decisions 2026-10-11).');
    out.error('  Nothing was read or written.');
    throw new ProductionGuardRefusal();
  }
}

async function main(): Promise<void> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  refuseProductionSeed(url);
  const prisma = new PrismaClient({ datasourceUrl: assertNotProduction(url) });
  const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMeNow!2026';
  try {
    console.log('▸ Inserting missing channels, sub-channels, regions and the admin account…');
    // Gap 24: one transaction, named as this seed, so the dated history of every
    // region and account it inserts says where they came from.
    const { inserted, leftAsIs } = await prisma.$transaction(
      async (tx) => {
        await setChangeContext(tx, { actorId: null, source: src.seed('seed') });
        return insertMissing(tx, () => bcrypt.hash(ADMIN_PASSWORD, 12));
      },
      { maxWait: 10_000, timeout: 60_000 }
    );
    console.log(
      `  inserted: ${inserted.channels} channel(s), ${inserted.subChannels} sub-channel(s), ${inserted.regions} region(s)`
    );
    if (leftAsIs.length > 0) {
      console.log(`  ${leftAsIs.length} existing row(s) differ from the seed's values and were left as they are:`);
      for (const row of leftAsIs) console.log(`    ${row}`);
    }
    // The password is never printed: it is SEED_ADMIN_PASSWORD, or this file's fallback.
    console.log(
      inserted.admin
        ? `  ${ADMIN_USERNAME} created (a Manager; password from SEED_ADMIN_PASSWORD, or this file's fallback). Change it at first sign-in (M1).`
        : `  ${ADMIN_USERNAME} already exists and was left as it is.`
    );
    console.log('✓ Seed complete.');
  } finally {
    await prisma.$disconnect();
  }
}

// Run when executed (npm run db:seed), not when a test imports the functions above.
if (/(^|[\\/])seed\.ts$/.test(process.argv[1] ?? '')) {
  main().catch((err) => {
    // A refusal has already printed its reason.
    if (err instanceof ProductionGuardRefusal) {
      console.error(err.message);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  });
}
