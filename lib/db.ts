import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { logger } from './logger';
import { registerConflictRecorder } from './errors';
import { pgPoolConfig } from './pg-pool-config';

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
  // Prisma 7: the client talks to Postgres through node-postgres. DATABASE_URL
  // (the pooled least-privilege role) keeps its Prisma 6 meaning — its pool and
  // TLS parameters are turned into pg's options by lib/pg-pool-config.ts — and the
  // client no longer reads .env itself (Next and Vercel provide the variables).
  //
  // A connection the server closes while it sits idle in the pool (a Neon compute
  // suspending, a pooler restart) is an 'error' event on the pool. The adapter
  // always listens for it, so it can never crash the process; it is logged here,
  // scrubbed like Prisma's own errors, and the next query opens a new connection.
  const adapter = new PrismaPg(pgPoolConfig(process.env.DATABASE_URL), {
    onPoolError: (err) => logger.error({ err: err.message, code: (err as { code?: unknown }).code }, 'pg.pool.error'),
  });
  const client = new PrismaClient({
    adapter,
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

/**
 * Gap 22 (part C): a save that lost a race is recorded as a CONFLICT audit row
 * (lib/conflict-record.ts). runAction in lib/errors.ts finds the recorder here;
 * that file is imported by client components too, so it cannot import this one.
 * Registered by the module every server write path already loads, and loaded
 * lazily, so a plain read never pulls the audit writer in.
 */
registerConflictRecorder(async (err) => {
  const { recordConflict } = await import('./conflict-record');
  await recordConflict(err);
});
