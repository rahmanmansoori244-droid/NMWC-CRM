/**
 * Launch e2e: the run-wide environment and the database clients.
 *
 * Nothing here runs at import time except reading process.env: the old
 * playwright.config.ts (testDir tests/e2e) also collects tests/e2e/launch, so an
 * import must never connect, throw or print. The clients are created on first
 * use, and every one of them is refused on the production database.
 *
 * The constants below are read ONCE, at first import. playwright.launch.config.ts
 * sets E2E_RUN_ID & co. before anything imports this file (it imports base.ts
 * only), and workers inherit them.
 */
import { PrismaClient } from '@prisma/client';
import { assertNotProduction, withDbParams } from './base';

export {
  PROD_MARKER,
  REGISTRY_DIR,
  REPO_ROOT,
  STATE_DIR,
  assertNotProduction,
  chromiumExecutable,
  redact,
  safeError,
  withDbParams,
} from './base';

/** Set once by playwright.launch.config.ts (`??=`), so every worker shares it. */
export const RUN_ID = process.env.E2E_RUN_ID ?? '';
export const PORT = Number(process.env.E2E_PORT ?? 3000);
export const BASE_URL = `http://localhost:${PORT}`;
export const SERVER_MODE: 'prod' | 'dev' = process.env.E2E_SERVER === 'dev' ? 'dev' : 'prod';
/** Auth.js cookie name: auth.config.ts picks it from NODE_ENV of the server. */
export const SESSION_COOKIE: '__Host-authjs.session-token' | 'authjs.session-token' =
  SERVER_MODE === 'prod' ? '__Host-authjs.session-token' : 'authjs.session-token';

export const hasR2 = Boolean(
  process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
);

/** True only under playwright.launch.config.ts with RUN_LAUNCH_E2E=1. */
export function launchEnabled(): boolean {
  return process.env.RUN_LAUNCH_E2E === '1' && process.env.E2E_LAUNCH_CONFIG === '1';
}

/**
 * Pool sizes. The test workers stay small (4 workers × 3); the Next server's
 * own pool is set by the config (E2E_SERVER_DB_CONNECTIONS). connect_timeout is
 * raised because a suspended Neon compute takes a few seconds to wake, which
 * Prisma's 5 s default turns into a P1001.
 */
export const TEST_DB_PARAMS = { connection_limit: '3', pool_timeout: '30', connect_timeout: '30' };
export const OWNER_DB_PARAMS = { connection_limit: '2', pool_timeout: '60', connect_timeout: '30' };

let appClient: PrismaClient | undefined;
let ownerClient: PrismaClient | undefined;

/** The worker's PrismaClient on DATABASE_URL (the app's connection), created on first use. */
export function getDb(): PrismaClient {
  if (appClient) return appClient;
  assertNotProduction();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Run through scripts/qa/run-with-env.mjs.');
  appClient = new PrismaClient({ datasourceUrl: withDbParams(url, TEST_DB_PARAMS) });
  return appClient;
}

/**
 * The table OWNER (DIRECT_URL): the only role that may open the audit-maintenance
 * window, and the only one sure to hold DELETE on every table (the least-privilege
 * nmwc_app role holds DELETE on a handful). Cleanup runs on it.
 */
export function ownerDb(): PrismaClient {
  if (ownerClient) return ownerClient;
  assertNotProduction();
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_URL is not set. Run through scripts/qa/run-with-env.mjs.');
  ownerClient = new PrismaClient({ datasourceUrl: withDbParams(url, OWNER_DB_PARAMS) });
  return ownerClient;
}

/**
 * `db` reads like a PrismaClient but connects only when first used, so importing
 * the support index never opens a connection.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getDb();
    const value = Reflect.get(client, prop, client) as unknown;
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(client) : value;
  },
});

export async function disconnectDb(): Promise<void> {
  const clients = [appClient, ownerClient];
  appClient = undefined;
  ownerClient = undefined;
  await Promise.all(clients.map((c) => c?.$disconnect().catch(() => undefined)));
}
