/**
 * The REAL Prisma client and the REAL Postgres driver adapter over a pool that
 * never opens a socket — for unit tests of what the installed runtime does with
 * a fault no local Postgres produces on demand: COMMIT failing, a connection
 * that takes seconds to arrive. `connect()` and `query()` are replaced on a
 * pg.Pool instance; everything above them (the adapter's error mapping, the
 * transaction manager, the client's own conversion of errors) is the code that
 * runs in production.
 *
 * The pool must be an instance of the adapter's OWN copy of pg (it tests
 * `instanceof`), so both are loaded through one require chain, and `pg` is
 * resolved from the adapter's folder rather than assumed to be hoisted.
 */
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';

const requireHere = createRequire(import.meta.url);
const adapterPath = requireHere.resolve('@prisma/adapter-pg');
const { PrismaPg } = requireHere(adapterPath) as typeof import('@prisma/adapter-pg');

type Query = string | { text: string; values?: unknown[] };
type Result = { rowCount: number; fields: unknown[]; rows: unknown[] };
type Pool = {
  connect: () => Promise<unknown>;
  query: (cfg: Query) => Promise<unknown>;
};
const pg = createRequire(adapterPath)('pg') as { Pool: new (config: { connectionString: string }) => Pool };

const OK: Result = { rowCount: 1, fields: [], rows: [] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A node socket error as node-postgres passes it on (the adapter tells it by code, syscall and errno). */
export function socketError(code: 'ECONNRESET' | 'ETIMEDOUT', errno: number): Error {
  return Object.assign(new Error(`read ${code}`), { code, errno, syscall: 'read' });
}

/** An error Postgres itself raised, as node-postgres's DatabaseError carries it. */
export function serverError(sqlState: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name: 'error', code: sqlState, severity: 'ERROR', ...extra });
}

export type FakeOptions = {
  /** What a statement does: throw to fail it, return nothing to succeed, or a number of ms to take. */
  onQuery?: (sql: string) => void | number | Promise<void | number>;
  /** How long the pool takes to hand out its connection. */
  connectMs?: number;
  /** The client's own transactionOptions, as lib/db.ts sets them; none = Prisma's defaults. */
  transactionOptions?: { maxWait?: number; timeout?: number };
};

/**
 * A client on a one-connection pool that answers every statement in order, as a
 * real connection does. `wire` is every statement that reached the connection.
 */
export function fakeClient(options: FakeOptions = {}): { prisma: PrismaClient; wire: string[] } {
  const wire: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const connection = {
    on() {},
    removeListener() {},
    release() {},
    query(cfg: Query): Promise<Result> {
      const sql = (typeof cfg === 'string' ? cfg : cfg.text).replace(/\s+/g, ' ').trim();
      const mine = chain.then(async () => {
        wire.push(sql.split(' ').slice(0, 2).join(' '));
        const took = await options.onQuery?.(sql);
        if (typeof took === 'number') await sleep(took);
        return OK;
      });
      chain = mine.catch(() => undefined);
      return mine;
    },
  };
  const pool = new pg.Pool({ connectionString: 'postgresql://u:p@db.invalid:5432/none' });
  pool.connect = async () => {
    if (options.connectMs) await sleep(options.connectMs);
    return connection;
  };
  pool.query = (cfg) => connection.query(cfg);
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool as never),
    ...(options.transactionOptions ? { transactionOptions: options.transactionOptions } : {}),
  });
  return { prisma, wire };
}
