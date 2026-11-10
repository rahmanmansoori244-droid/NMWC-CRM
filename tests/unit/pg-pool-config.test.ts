// @vitest-environment node
/**
 * Prisma 7: a connection string written for Prisma 6 keeps its meaning through the
 * Postgres driver adapter (lib/pg-pool-config.ts). Every Prisma 6 parameter this
 * project's URLs can carry is pinned here — the production and UAT ones (Neon:
 * sslmode, channel_binding, pgbouncer, connection_limit), the e2e harness's
 * (connection_limit / pool_timeout / connect_timeout) and CI's (none) — and so is
 * what happens with no URL at all.
 *
 * Fake hosts only (`.invalid` never resolves); nothing here connects.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PgPoolConfigError,
  UNSET_DATABASE_URL,
  V6_DEFAULTS,
  defaultPoolSize,
  pgPoolConfig,
} from '@/lib/pg-pool-config';
import { TEST_DB_PARAMS, OWNER_DB_PARAMS } from '../e2e/launch/support/env';
import { withDbParams } from '../e2e/launch/support/base';

const PASSWORD = 'synthetic-pw-q71';
const base = (query = '', host = 'ep-fake-pooler.us-east-1.aws.neon.invalid') =>
  ['postgresql://', 'synthetic_user', ':', PASSWORD, '@', host, '/neondb', query].join('');
const paramsOf = (s: string) => new URL(s).searchParams;

describe('pgPoolConfig: Prisma 6 defaults are kept', () => {
  it('no parameters: v6 pool size, its 10 s wait for a connection, its 300 s idle lifetime, no TLS change', () => {
    const c = pgPoolConfig(base());
    expect(c.connectionString).toBe(base());
    expect(c.max).toBe(defaultPoolSize());
    expect(c.connectionTimeoutMillis).toBe(10_000);
    expect(c.idleTimeoutMillis).toBe(V6_DEFAULTS.idleSeconds * 1000);
    expect(c.ssl).toBeUndefined();
    expect(c.enableChannelBinding).toBeUndefined();
    expect(c.maxLifetimeSeconds).toBeUndefined();
    expect(c.query_timeout).toBeUndefined();
    expect(c.options).toBeUndefined();
  });

  it('the default pool is never smaller than Prisma 6 made it (CPUs × 2 + 1, at least 3)', () => {
    expect(defaultPoolSize()).toBeGreaterThanOrEqual(3);
    expect((defaultPoolSize() - 1) % 2).toBe(0);
  });
});

describe('pgPoolConfig: each Prisma 6 parameter becomes its pg option and leaves the URL', () => {
  it('connection_limit -> max', () => {
    const c = pgPoolConfig(base('?connection_limit=1'));
    expect(c.max).toBe(1);
    expect(paramsOf(c.connectionString).has('connection_limit')).toBe(false);
    expect(pgPoolConfig(base('?connection_limit=17')).max).toBe(17);
  });

  it('pool_timeout and connect_timeout -> one connectionTimeoutMillis, the longer of the two', () => {
    expect(pgPoolConfig(base('?pool_timeout=30&connect_timeout=30')).connectionTimeoutMillis).toBe(30_000);
    expect(pgPoolConfig(base('?pool_timeout=60&connect_timeout=30')).connectionTimeoutMillis).toBe(60_000);
    // connect_timeout alone: v6's 10 s pool wait still applies.
    expect(pgPoolConfig(base('?connect_timeout=3')).connectionTimeoutMillis).toBe(10_000);
    expect(pgPoolConfig(base('?connect_timeout=30')).connectionTimeoutMillis).toBe(30_000);
    // pool_timeout alone: v6's 5 s connect timeout is the floor.
    expect(pgPoolConfig(base('?pool_timeout=1')).connectionTimeoutMillis).toBe(5_000);
    expect(pgPoolConfig(base('?pool_timeout=1&connect_timeout=1')).connectionTimeoutMillis).toBe(1_000);
    // 0 means "wait for ever" in both Prisma 6 and pg.
    expect(pgPoolConfig(base('?pool_timeout=0')).connectionTimeoutMillis).toBe(0);
    expect(pgPoolConfig(base('?connect_timeout=0&pool_timeout=20')).connectionTimeoutMillis).toBe(0);
    const left = paramsOf(pgPoolConfig(base('?pool_timeout=30&connect_timeout=30')).connectionString);
    expect(left.has('pool_timeout') || left.has('connect_timeout')).toBe(false);
  });

  it('the e2e harness parameters (tests/e2e/launch/support/env.ts) mean what they meant', () => {
    const app = pgPoolConfig(withDbParams(base(), TEST_DB_PARAMS));
    expect(app.max).toBe(3);
    expect(app.connectionTimeoutMillis).toBe(30_000);
    const owner = pgPoolConfig(withDbParams(base(), OWNER_DB_PARAMS));
    expect(owner.max).toBe(2);
    expect(owner.connectionTimeoutMillis).toBe(60_000);
    expect(paramsOf(app.connectionString).toString()).toBe('');
  });

  it('max_idle_connection_lifetime, max_connection_lifetime, socket_timeout', () => {
    const c = pgPoolConfig(base('?max_idle_connection_lifetime=60&max_connection_lifetime=1800&socket_timeout=20'));
    expect(c.idleTimeoutMillis).toBe(60_000);
    expect(c.maxLifetimeSeconds).toBe(1800);
    expect(c.query_timeout).toBe(20_000);
    expect(paramsOf(c.connectionString).toString()).toBe('');
    // 0 = no limit: not set at all.
    const z = pgPoolConfig(base('?max_connection_lifetime=0&socket_timeout=0'));
    expect(z.maxLifetimeSeconds).toBeUndefined();
    expect(z.query_timeout).toBeUndefined();
  });

  it.each(['require', 'prefer', 'verify-ca', 'verify-full', 'REQUIRE'])(
    'sslmode=%s: TLS with the certificate VERIFIED, and sslmode out of the URL (no pg SECURITY WARNING)',
    (mode) => {
      const c = pgPoolConfig(base(`?sslmode=${mode}`));
      expect(c.ssl).toEqual({ rejectUnauthorized: true });
      expect(paramsOf(c.connectionString).has('sslmode')).toBe(false);
    }
  );

  it('sslmode=disable or allow: no TLS', () => {
    expect(pgPoolConfig(base('?sslmode=disable')).ssl).toBe(false);
    expect(pgPoolConfig(base('?sslmode=allow')).ssl).toBe(false);
  });

  it('sslaccept=accept_invalid_certs is the one explicit way to skip verification', () => {
    const c = pgPoolConfig(base('?sslmode=require&sslaccept=accept_invalid_certs'));
    expect(c.ssl).toEqual({ rejectUnauthorized: false });
    expect(paramsOf(c.connectionString).has('sslaccept')).toBe(false);
    expect(pgPoolConfig(base('?sslmode=require&sslaccept=strict')).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('channel_binding -> enableChannelBinding (SCRAM-SHA-256-PLUS)', () => {
    expect(pgPoolConfig(base('?sslmode=require&channel_binding=require')).enableChannelBinding).toBe(true);
    expect(pgPoolConfig(base('?channel_binding=prefer')).enableChannelBinding).toBe(true);
    expect(pgPoolConfig(base('?channel_binding=disable')).enableChannelBinding).toBe(false);
    expect(paramsOf(pgPoolConfig(base('?channel_binding=require')).connectionString).has('channel_binding')).toBe(false);
  });

  it('pgbouncer, statement_cache_size and schema=public are dropped; another schema becomes search_path', () => {
    const c = pgPoolConfig(base('?pgbouncer=true&statement_cache_size=0&schema=public'));
    expect(paramsOf(c.connectionString).toString()).toBe('');
    expect(c.options).toBeUndefined();
    const other = pgPoolConfig(base('?schema=reporting'));
    expect(other.options).toBe('-c search_path=reporting');
    expect(paramsOf(other.connectionString).has('schema')).toBe(false);
    const both = pgPoolConfig(base('?schema=reporting&options=-c%20statement_timeout%3D5000'));
    expect(both.options).toBe('-c statement_timeout=5000 -c search_path=reporting');
    expect(() => pgPoolConfig(base('?schema=a;drop'))).toThrow(PgPoolConfigError);
  });

  it('a Neon pooled URL as this project writes it', () => {
    const c = pgPoolConfig(base('?sslmode=require&channel_binding=require&pgbouncer=true&connection_limit=1'));
    expect(c).toMatchObject({ max: 1, ssl: { rejectUnauthorized: true }, enableChannelBinding: true, connectionTimeoutMillis: 10_000 });
    // Only the address and the credentials are left for pg to read.
    expect(c.connectionString).toBe(base());
  });

  it('keeps what pg reads itself: application_name, a host= override, a percent-encoded password', () => {
    const enc = ['postgresql://', 'u', ':', 'p%40ss%2Fw', '@', 'db.invalid:6543', '/x', '?application_name=probe&host=other.invalid&connection_limit=2'].join('');
    const c = pgPoolConfig(enc);
    const u = new URL(c.connectionString);
    expect(u.password).toBe('p%40ss%2Fw');
    expect(u.port).toBe('6543');
    expect(u.searchParams.get('application_name')).toBe('probe');
    expect(u.searchParams.get('host')).toBe('other.invalid');
    expect(u.searchParams.has('connection_limit')).toBe(false);
  });
});

describe('pgPoolConfig: fails closed', () => {
  it.each([undefined, null, '', '   '])('no URL (%j) is an address that can never connect — never localhost:5432', (url) => {
    const c = pgPoolConfig(url);
    expect(c.connectionString).toBe(UNSET_DATABASE_URL);
    expect(new URL(c.connectionString).hostname).toBe('invalid.invalid');
  });

  it('refuses what it cannot carry over, without echoing the URL', () => {
    for (const bad of [
      'not a url',
      'mysql://u:p@db.invalid/x',
      base('?sslcert=/etc/ca.pem'),
      base('?sslidentity=id.p12&sslpassword=x'),
      base('?sslrootcert=/x'),
      base('?sslmode=sometimes'),
      base('?connection_limit=0'),
      base('?connection_limit=two'),
      base('?pool_timeout=-1'),
    ]) {
      let thrown: unknown;
      try {
        pgPoolConfig(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, bad.replace(PASSWORD, '…')).toBeInstanceOf(PgPoolConfigError);
      expect(String((thrown as Error).message)).not.toContain(PASSWORD);
      expect(String((thrown as Error).message)).not.toMatch(/postgres(ql)?:\/\//);
    }
  });
});

describe('the module stays pure', () => {
  it('imports nothing but node:os — no pg, no Prisma (the scripts production guard treats those as a connection)', () => {
    const src = readFileSync('lib/pg-pool-config.ts', 'utf8');
    const imports = [...src.matchAll(/^import[^;]*from\s*'([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['node:os']);
  });
});
