/**
 * The daily Temix import, stage 6: reads of the ledger by day and of the open
 * spells (lib/temix-daily-finalize.ts), for finalize's writer
 * (lib/temix-daily-notices.ts) and the day's drill-down page
 * (app/(app)/temix-daily/day/[loadDay]). READS ONLY: no write, no lock, no
 * change context. The client is passed in.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { SPELL_CODES, SPELL_KINDS } from './temix-daily-finalize';

type Db = Pick<PrismaClient, '$queryRaw' | 'temixChange' | 'temixDailyFile'>;

export type SpellRow = {
  id: bigint;
  kind: string;
  customerId: string | null;
  toValue: string | null;
  detailCode: string | null;
  loadDay: Date;
  fileId: string;
};

/** The newest spell row of each kind and key (customer, value): a spell is open when it says SPELL_OPENED. */
export async function loadLatestSpellRows(db: Pick<PrismaClient, '$queryRaw'>): Promise<SpellRow[]> {
  return db.$queryRaw<SpellRow[]>(Prisma.sql`
    SELECT DISTINCT ON ("kind", "customerId", "toValue") "id", "kind", "customerId", "toValue", "detailCode", "loadDay", "fileId"
      FROM "TemixChange"
     WHERE "applied" = false
       AND "kind" IN (${Prisma.join([...SPELL_KINDS])})
       AND "detailCode" IN (${Prisma.join([...SPELL_CODES])})
     ORDER BY "kind", "customerId", "toValue", "id" DESC`);
}

/** A 'YYYY-MM-DD' load day as the Date the @db.Date column holds. */
export const loadDayDate = (day: string) => new Date(`${day}T00:00:00Z`);

/** The load day's summary input: its ledger rows counted by kind, applied and detail, and its loaded files' held rows. */
export async function loadDaySummaryInput(
  db: Pick<Db, 'temixChange' | 'temixDailyFile'>,
  loadDay: string
): Promise<{ changes: Array<{ kind: string; applied: boolean; detailCode: string | null; n: number }>; heldRows: number }> {
  const day = loadDayDate(loadDay);
  const [grouped, held] = await Promise.all([
    // The lines of the day's LOADED files only, as the day's page lists them (a file still applying lists nothing yet).
    db.temixChange.groupBy({ by: ['kind', 'applied', 'detailCode'], where: { loadDay: day, file: { state: 'LOADED' } }, _count: { _all: true } }),
    db.temixDailyFile.aggregate({ where: { loadDay: day, state: 'LOADED' }, _sum: { heldRows: true } }),
  ]);
  return {
    changes: grouped.map((g) => ({ kind: g.kind, applied: g.applied, detailCode: g.detailCode, n: g._count._all })),
    heldRows: held._sum.heldRows ?? 0,
  };
}
