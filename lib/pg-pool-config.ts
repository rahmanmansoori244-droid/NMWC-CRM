/**
 * Prisma 7: the pool options for the Postgres driver adapter (@prisma/adapter-pg),
 * from a connection string written for Prisma 6.
 *
 * Prisma 6 ran its own pool and read its settings from the URL's query string.
 * Prisma 7 hands the connection to node-postgres (`pg`), which ignores those
 * parameters and has its own defaults — no connect timeout at all, ten
 * connections, ten seconds idle. Nothing about DATABASE_URL or DIRECT_URL has to
 * change: the Prisma 6 parameters are read here and turned into pg's options, so
 * a URL means what it meant before.
 *
 *   connection_limit        -> max                   (default: CPUs × 2 + 1, as v6)
 *   pool_timeout,
 *   connect_timeout         -> connectionTimeoutMillis, the larger of the two
 *                              (v6 defaults 10 s and 5 s; 0 = wait for ever).
 *                              pg has ONE timer for "no free connection" and "the
 *                              server did not answer", where v6 had two.
 *   max_idle_connection_lifetime -> idleTimeoutMillis (default 300 s, as v6)
 *   max_connection_lifetime -> maxLifetimeSeconds
 *   socket_timeout          -> query_timeout (client side, as v6)
 *   sslmode                 -> ssl. require / prefer / verify-ca / verify-full
 *                              connect over TLS and VERIFY the certificate (the
 *                              upgrade guide's advice; Neon's certificates are
 *                              publicly trusted). disable / allow: no TLS.
 *                              Taken out of the URL, because pg's own parser
 *                              would override the option with its legacy reading
 *                              and print a SECURITY WARNING.
 *   sslaccept=accept_invalid_certs -> rejectUnauthorized: false (an explicit opt-out)
 *   channel_binding=require|prefer -> enableChannelBinding (SCRAM-SHA-256-PLUS)
 *   pgbouncer, statement_cache_size -> dropped: pg uses unnamed statements, which
 *                              PgBouncer's transaction mode accepts
 *   schema                  -> dropped when public; otherwise search_path
 *
 * Certificate files (sslcert, sslidentity, sslrootcert, sslkey, sslpassword) are
 * refused with an error rather than dropped: dropping one would quietly connect
 * on different terms than the URL asks for. Nothing in this project uses them.
 *
 * A missing or empty URL gives a connection string that can never connect
 * (`.invalid` does not resolve), never pg's own default of localhost:5432 — which
 * on a developer's machine is somebody's real database.
 *
 * PURE: imports nothing from 'pg' or '@prisma/*' (tests/unit/scripts-production-
 * guard.test.ts treats a pg import as opening a database), so the operator
 * scripts and the app share it. tests/unit/pg-pool-config.test.ts pins every row.
 */
import { availableParallelism } from 'node:os';

/** The subset of pg's PoolConfig this sets (structurally compatible with it). */
export type PgPoolOptions = {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  maxLifetimeSeconds?: number;
  query_timeout?: number;
  ssl?: false | { rejectUnauthorized: boolean };
  enableChannelBinding?: boolean;
  options?: string;
};

/** Never resolves (RFC 2606), so a client built without a URL fails closed. */
export const UNSET_DATABASE_URL = 'postgresql://database-url-not-set@invalid.invalid:5432/none';

/** Prisma 6's defaults, which these options keep. */
export const V6_DEFAULTS = {
  poolTimeoutSeconds: 10,
  connectTimeoutSeconds: 5,
  idleSeconds: 300,
} as const;

const DROPPED = ['pgbouncer', 'statement_cache_size'];
const MAPPED = [
  'connection_limit',
  'pool_timeout',
  'connect_timeout',
  'max_idle_connection_lifetime',
  'max_connection_lifetime',
  'socket_timeout',
  'sslmode',
  'sslaccept',
  'channel_binding',
  'schema',
];
const REFUSED = ['sslcert', 'sslidentity', 'sslpassword', 'sslrootcert', 'sslkey'];

export class PgPoolConfigError extends Error {
  override name = 'PgPoolConfigError';
}

/** Seconds from a URL parameter: a non-negative number, or null when absent. Never echoes the value. */
function seconds(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new PgPoolConfigError(`connection string: ${key} must be a number of seconds`);
  return n;
}

/** v6's CPUs × 2 + 1 (physical cores there; logical ones here, so never fewer). */
export function defaultPoolSize(): number {
  let cpus = 1;
  try {
    cpus = Math.max(1, availableParallelism());
  } catch {
    /* an exotic runtime: one CPU */
  }
  return cpus * 2 + 1;
}

export function pgPoolConfig(url: string | null | undefined): PgPoolOptions {
  const source = typeof url === 'string' && url.trim() !== '' ? url.trim() : UNSET_DATABASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    // Never echo the string: it carries a password.
    throw new PgPoolConfigError('connection string: not a valid URL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new PgPoolConfigError('connection string: expected the postgresql scheme');
  }
  const params = parsed.searchParams;
  for (const key of REFUSED) {
    if (params.has(key)) {
      throw new PgPoolConfigError(
        `connection string: ${key} is not supported with the Postgres driver adapter — configure the certificate in lib/pg-pool-config.ts`
      );
    }
  }

  const limit = params.get('connection_limit');
  let max = defaultPoolSize();
  if (limit !== null && limit.trim() !== '') {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) throw new PgPoolConfigError('connection string: connection_limit must be a whole number above 0');
    max = n;
  }

  // 0 means "no timeout" in both Prisma 6 and pg.
  const poolTimeout = seconds(params, 'pool_timeout') ?? V6_DEFAULTS.poolTimeoutSeconds;
  const connectTimeout = seconds(params, 'connect_timeout') ?? V6_DEFAULTS.connectTimeoutSeconds;
  const wait = poolTimeout === 0 || connectTimeout === 0 ? 0 : Math.max(poolTimeout, connectTimeout);
  const idle = seconds(params, 'max_idle_connection_lifetime') ?? V6_DEFAULTS.idleSeconds;
  const lifetime = seconds(params, 'max_connection_lifetime');
  const socketTimeout = seconds(params, 'socket_timeout');

  const out: PgPoolOptions = {
    connectionString: '',
    max,
    connectionTimeoutMillis: Math.round(wait * 1000),
    idleTimeoutMillis: Math.round(idle * 1000),
  };
  if (lifetime !== null && lifetime > 0) out.maxLifetimeSeconds = lifetime;
  if (socketTimeout !== null && socketTimeout > 0) out.query_timeout = Math.round(socketTimeout * 1000);

  const sslmode = (params.get('sslmode') ?? '').toLowerCase();
  const sslaccept = (params.get('sslaccept') ?? '').toLowerCase();
  if (sslmode === 'require' || sslmode === 'prefer' || sslmode === 'verify-ca' || sslmode === 'verify-full') {
    out.ssl = { rejectUnauthorized: sslaccept !== 'accept_invalid_certs' };
  } else if (sslmode === 'disable' || sslmode === 'allow') {
    out.ssl = false;
  } else if (sslmode !== '') {
    throw new PgPoolConfigError('connection string: sslmode must be disable, allow, prefer, require, verify-ca or verify-full');
  }

  const binding = (params.get('channel_binding') ?? '').toLowerCase();
  if (binding === 'require' || binding === 'prefer') out.enableChannelBinding = true;
  else if (binding === 'disable') out.enableChannelBinding = false;

  const schema = params.get('schema');
  if (schema && schema !== 'public') {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) throw new PgPoolConfigError('connection string: schema must be a plain identifier');
    const existing = params.get('options');
    out.options = `${existing ? `${existing} ` : ''}-c search_path=${schema}`;
    params.delete('options');
  }

  for (const key of [...MAPPED, ...DROPPED]) params.delete(key);
  out.connectionString = parsed.toString();
  return out;
}
