import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

declare global {
  var __prismaClient: PrismaClient | undefined;
}

/**
 * Item 10 (review, 2026-09-27): Prisma's own log went straight to the console,
 * past the scrubber, and Vercel now keeps runtime logs for 30 days. A failed
 * query's message can carry the values it was given, so errors (and, in
 * development, warnings) are taken as events and written through lib/logger,
 * which scrubs phones, e-mails and digit runs and files them at their level.
 */
function createClient(): PrismaClient {
  const client = new PrismaClient({
    log: [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
    // Go-live (2026-09-10): Prisma's interactive-transaction default is 5 s.
    // Several multi-statement transactions (photo attach → slot update →
    // rescore → audit; reject; direct-write; Temix batches) never set their
    // own options, so on a slow link they die with "Transaction already
    // closed" — the photo-attach one was caught by the go-live flow test
    // (5.3 s over WAN). Same class of failure as the promote P2028 fix. The
    // hot paths that need more (promote, approve/finalize) still pass their own
    // per-call options, which take precedence over these defaults.
    transactionOptions: { maxWait: 10_000, timeout: 20_000 },
  });
  client.$on('error', (e) => logger.error({ target: e.target, err: e.message }, 'prisma.error'));
  if (process.env.NODE_ENV === 'development') {
    client.$on('warn', (e) => logger.warn({ target: e.target, err: e.message }, 'prisma.warn'));
  }
  // The event typing is a detail of this file; everything else takes a plain client.
  return client as unknown as PrismaClient;
}

export const prisma = globalThis.__prismaClient ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prismaClient = prisma;
}
