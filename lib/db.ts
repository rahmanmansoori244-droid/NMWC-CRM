import { PrismaClient } from '@prisma/client';

declare global {
  var __prismaClient: PrismaClient | undefined;
}

export const prisma =
  globalThis.__prismaClient ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
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

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prismaClient = prisma;
}
