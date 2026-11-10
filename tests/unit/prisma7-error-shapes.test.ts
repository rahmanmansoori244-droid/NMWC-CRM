// @vitest-environment node
/**
 * Prisma 7 (the Postgres driver adapter) reports database faults in new shapes.
 * Every decision this application takes on an error — retry or reject an import
 * row, which form field a clash belongs to, "nothing was saved" or "may or may
 * not have been saved", a lost seal race or a real failure, what an operator
 * script may print — must come out as it did on Prisma 6.
 *
 * The shapes below are the ones the upgrade's probe captured from real Prisma
 * 7.10.0 errors against PostgreSQL (class, code, meta layout, message format),
 * with synthetic values. The Prisma 6 shape of the same fault sits beside each
 * where it differed, and both must decide alike. On 7.10.1 (2026-11-10) the
 * unique, foreign-key, CHECK and raw-query shapes were captured again on
 * Postgres 17 and are the same; the rules main added since (a database rule's
 * own words, the Temix-code index) are pinned on those shapes in
 * db-rule-errors.test.ts and temix-code-unique.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import {
  RAW_UNIQUE_INDEX_COLUMNS,
  isDbConflict,
  isTransientDbError,
  mayHaveCommitted,
  sqlStateOf,
  uniqueTargetFields,
} from '@/lib/db-errors';
import { runAction } from '@/lib/errors';
import { accountRowFailure } from '@/lib/account-import';
import { isSealRace } from '@/lib/seal/seal';
import { describeError } from '../../scripts/ops/describe-error';

const VERSION = '7.10.1';
/** The adapter's DriverAdapterError, as Prisma 7 puts it in meta. */
const adapterError = (cause: Record<string, unknown>) =>
  Object.assign(new Error(String(cause.kind === 'postgres' ? cause.message : cause.kind)), { name: 'DriverAdapterError', cause });
const known = (code: string, message: string, meta: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: VERSION, meta });

/** A unique violation from a model query (P2002), as Prisma 7 reports it. */
const p2002 = (model: string, index: string) =>
  known('P2002', `\nInvalid \`prisma.${model.toLowerCase()}.create()\` invocation:\n\nUnique constraint failed on the constraint: \`${index}\``, {
    modelName: model,
    driverAdapterError: adapterError({
      kind: 'UniqueConstraintViolation',
      originalCode: '23505',
      originalMessage: `duplicate key value violates unique constraint "${index}"`,
      constraint: { index },
      table: model,
    }),
  });
/** Any statement of a raw query (P2010), Prisma 7. */
const p2010 = (sqlState: string, text: string, cause: Record<string, unknown> = {}) =>
  known('P2010', `\nInvalid \`prisma.$queryRaw()\` invocation:\n\n\nRaw query failed. Code: \`${sqlState}\`. Message: \`${text}\``, {
    driverAdapterError: adapterError({ kind: 'postgres', code: sqlState, severity: 'ERROR', message: text, originalCode: sqlState, originalMessage: text, ...cause }),
  });
/** A database error with no Prisma code of its own, from a model query (P2039, new in Prisma 7). */
const p2039 = (model: string, sqlState: string, text: string, detail?: string) =>
  known('P2039', `\nInvalid \`prisma.${model.toLowerCase()}.update()\` invocation:\n\nDatabase error. Code: \`${sqlState}\`. Message: \`${text}\``, {
    modelName: model,
    driverAdapterError: adapterError({ kind: 'postgres', code: sqlState, severity: 'ERROR', message: text, detail, originalCode: sqlState, originalMessage: text }),
  });
/** A write conflict from a model query: Prisma 7 reports 40001 AND 40P01 as P2034. */
const p2034 = (sqlState: '40001' | '40P01') =>
  known('P2034', '\nInvalid `prisma.route.update()` invocation:\n\nTransaction failed due to a write conflict or a deadlock. Please retry your transaction', {
    modelName: 'Route',
    driverAdapterError: adapterError({ kind: 'TransactionWriteConflict', originalCode: sqlState, originalMessage: sqlState === '40P01' ? 'deadlock detected' : 'could not serialize access due to concurrent update' }),
  });
const closed = (code: 'P1017' | 'P2010') =>
  known(code, code === 'P1017' ? '\nInvalid `prisma.route.update()` invocation:\n\nServer has closed the connection.' : '\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `N/A`. Message: `Server has closed the connection.`', {
    ...(code === 'P1017' ? { modelName: 'Route' } : {}),
    driverAdapterError: adapterError({ kind: 'ConnectionClosed' }),
  });
const unreachable = known('P1001', "\nInvalid `prisma.route.count()` invocation:\n\nCan't reach database server at ep-fake.neon.invalid:5432", {
  modelName: 'Route',
  driverAdapterError: adapterError({ kind: 'DatabaseNotReachable', host: 'ep-fake.neon.invalid', port: 5432 }),
});
/** A raw query's connection fault (P2010), as Prisma 7 reports it: the kind is only in the adapter error. */
const rawConnection = (kind: string, text: string) =>
  known('P2010', `\nInvalid \`prisma.$queryRaw()\` invocation:\n\n\nRaw query failed. Code: \`N/A\`. Message: \`${text}\``, {
    driverAdapterError: adapterError({ kind }),
  });
/** node-postgres failures the adapter passes through unwrapped. */
const pgError = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

async function answer(err: unknown): Promise<string> {
  try {
    const r = await runAction(async () => {
      throw err;
    });
    return r.ok ? 'ok' : r.code;
  } catch (e) {
    return e === err ? 'RETHROWN' : `OTHER ${(e as Error).name}`;
  }
}

describe('sqlStateOf: the SQLSTATE wherever the Prisma version put it', () => {
  it('reads Prisma 6 meta.code, Prisma 7 originalCode, or the "Code: `…`" both write into a raw message', () => {
    expect(sqlStateOf({ code: 'P2010', meta: { code: '40P01', message: 'x' } })).toBe('40P01');
    expect(sqlStateOf(p2034('40P01'))).toBe('40P01');
    expect(sqlStateOf(p2039('Branch', '23514', 'new row violates check constraint "Branch_address_minlength"'))).toBe('23514');
    expect(sqlStateOf(new Error('Raw query failed. Code: `57014`. Message: `canceling statement`'))).toBe('57014');
    // Nothing that is not five [0-9A-Z]: a v6 terminated query carried a non-code here.
    expect(sqlStateOf({ meta: { code: 'E57P01-ish' } })).toBeNull();
    expect(sqlStateOf(closed('P1017'))).toBeNull();
    expect(sqlStateOf(null)).toBeNull();
  });
});

describe('uniqueTargetFields: the columns of a unique clash, as Prisma 6 listed them', () => {
  it.each([
    ['User', 'User_username_key', ['username']],
    ['User', 'User_email_key', ['email']],
    ['User', 'User_ownedRouteId_key', ['ownedRouteId']],
    ['Route', 'Route_regionId_code_key', ['regionId', 'code']],
    ['SubChannel', 'SubChannel_channelId_key_key', ['channelId', 'key']],
    ['Channel', 'Channel_key_key', ['key']],
    ['JobRunDay', 'JobRunDay_key_day_key', ['key', 'day']],
    ['SealRecord', 'SealRecord_day_key', ['day']],
    // Raw-SQL partial indexes: the columns Prisma 6 read from Postgres's DETAIL.
    ['Customer', 'Customer_primaryPhoneNorm_active_unique', ['primaryPhoneNorm']],
    ['CustomerEdit', 'CustomerEdit_open_per_customer', ['customerId']],
    ['CustomerEdit', 'CustomerEdit_open_per_branch', ['branchId']],
    // An index on an expression: the expression, its quotes taken out, as Prisma 6 listed it.
    ['Customer', 'Customer_temixCode_live_unique', ['upper(btrim(temixCode))']],
  ])('%s %s -> %j', (model, index, columns) => {
    expect(uniqueTargetFields(p2002(model, index))).toEqual(columns);
  });

  it('a name it cannot read is passed on as the name, and a Prisma 6 shape as it was', () => {
    expect(uniqueTargetFields(p2002('Customer', 'Customer_someone_elses_index'))).toEqual(['Customer_someone_elses_index']);
    // Prisma 6: meta.target, an array of columns (or on some engines a constraint name).
    expect(uniqueTargetFields({ code: 'P2002', meta: { modelName: 'User', target: ['email'] } })).toEqual(['email']);
    expect(uniqueTargetFields({ code: 'P2002', meta: { modelName: 'User', target: 'User_email_key' } })).toEqual(['email']);
    // Prisma 7 when Postgres names no constraint: the columns it read from DETAIL.
    const fields = known('P2002', 'Unique constraint failed on the fields: (`a`, `b`)', {
      driverAdapterError: adapterError({ kind: 'UniqueConstraintViolation', constraint: { fields: ['a', 'b'] } }),
    });
    expect(uniqueTargetFields(fields)).toEqual(['a', 'b']);
    // A raw query's clash (P2010) never had a target in Prisma 6; Prisma 7's names
    // the constraint, but it is not read, so a caller decides exactly as before.
    expect(
      uniqueTargetFields(p2010('23505', 'duplicate key value violates unique constraint "User_username_key"', { kind: 'UniqueConstraintViolation', constraint: { index: 'User_username_key' }, table: 'User' }))
    ).toEqual([]);
    expect(uniqueTargetFields(new Error('nothing'))).toEqual([]);
    expect(uniqueTargetFields(null)).toEqual([]);
  });

  it('knows every raw-SQL unique index in prisma/migrations whose name does not follow <Model>_<columns>_key', () => {
    const dir = 'prisma/migrations';
    const sql = readdirSync(dir)
      .filter((d) => !d.endsWith('.toml'))
      .map((d) => readFileSync(join(dir, d, 'migration.sql'), 'utf8'))
      .join('\n');
    const found = new Map<string, string[]>();
    for (const m of sql.matchAll(/CREATE UNIQUE INDEX (?:IF NOT EXISTS )?"([^"]+)"\s+ON\s+"([^"]+)"\s*\(/g)) {
      const [, name, table] = m;
      // The key list runs to the parenthesis that closes it, and is split on the
      // commas outside any other: an index on an expression nests its own
      // (Customer_temixCode_live_unique is on upper(btrim("temixCode"))).
      const start = m.index! + m[0].length;
      const parts: string[] = [];
      let depth = 1;
      let from = start;
      let end = start;
      for (; end < sql.length && depth > 0; end++) {
        const ch = sql[end];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if ((ch === ',' && depth === 1) || depth === 0) {
          parts.push(sql.slice(from, end));
          from = end + 1;
        }
      }
      expect(depth, `${name}: its key list never closes`).toBe(0);
      // Each key as Prisma 6 listed it in meta.target: the quotes taken out.
      const columns = parts.map((c) => c.trim().replace(/"/g, '').replace(/\s+(ASC|DESC)$/i, ''));
      found.set(name!, columns);
      const conventional = name === `${table}_${columns.join('_')}_key`;
      if (!conventional) {
        expect(RAW_UNIQUE_INDEX_COLUMNS[name!], `${name} needs an entry in RAW_UNIQUE_INDEX_COLUMNS`).toEqual(columns);
      }
    }
    for (const name of Object.keys(RAW_UNIQUE_INDEX_COLUMNS)) {
      expect(found.has(name), `${name} is listed but no migration creates it`).toBe(true);
    }
    expect(found.size).toBeGreaterThan(20);
  });

  it('no column in the schema has an underscore, which the <Model>_<columns>_key split relies on', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    const fields = [...schema.matchAll(/^model \w+ \{([\s\S]*?)^\}/gm)].flatMap((m) =>
      m[1]!.split('\n').map((l) => /^\s+([A-Za-z_][A-Za-z0-9_]*)\s+\S/.exec(l)?.[1]).filter((f): f is string => !!f && !f.startsWith('@@'))
    );
    expect(fields.length).toBeGreaterThan(100);
    expect(fields.filter((f) => f.includes('_'))).toEqual([]);
  });
});

describe('isDbConflict / isTransientDbError / mayHaveCommitted on Prisma 7 shapes', () => {
  it('a deadlock and a serialization failure are conflicts — model (P2034) and raw (P2010) alike', () => {
    for (const err of [p2034('40001'), p2034('40P01')]) expect(isDbConflict(err, 'P2034')).toBe(true);
    expect(isDbConflict(p2010('40P01', 'deadlock detected', { kind: 'TransactionWriteConflict' }), 'P2010')).toBe(true);
    expect(isDbConflict(p2010('40001', 'could not serialize access', { kind: 'TransactionWriteConflict' }), 'P2010')).toBe(true);
    expect(isDbConflict(p2010('23514', 'violates check constraint "x"'), 'P2010')).toBe(false);
    expect(isDbConflict(p2039('Route', '57014', 'canceling statement due to statement timeout'), 'P2039')).toBe(false);
  });

  it.each([
    // [label, error, code passed, transient, may have committed, what the user is told]
    ['P1017: the connection reset mid-request (ECONNRESET)', closed('P1017'), 'P1017', true, true, 'DB_INTERRUPTED'],
    ['P2010: a raw query whose connection reset', closed('P2010'), 'P2010', true, true, 'DB_INTERRUPTED'],
    ['pg: the connection closed mid-request (FIN)', pgError('Connection terminated unexpectedly'), '', true, true, 'DB_INTERRUPTED'],
    ['pg: EPIPE mid-request', pgError('write EPIPE', 'EPIPE'), 'EPIPE', true, true, 'DB_INTERRUPTED'],
    ['pg: ECONNRESET passed through', pgError('read ECONNRESET', 'ECONNRESET'), 'ECONNRESET', true, true, 'DB_INTERRUPTED'],
    ['P1001: unreachable', unreachable, 'P1001', true, false, 'DB_UNAVAILABLE'],
    // A raw query reports every connection fault as P2010; the adapter's kind says which.
    ['P2010 DatabaseNotReachable: a raw query, unreachable', rawConnection('DatabaseNotReachable', "Can't reach database server at ep-fake.neon.invalid:5432"), 'P2010', true, false, 'DB_UNAVAILABLE'],
    ['P2010 TlsConnectionError: a raw query, the certificate refused', rawConnection('TlsConnectionError', 'Error opening a TLS connection: self-signed certificate'), 'P2010', true, false, 'DB_UNAVAILABLE'],
    ['P2010 SocketTimeout: a raw query whose socket timed out', rawConnection('SocketTimeout', 'Operation has timed out'), 'P2010', true, true, 'DB_INTERRUPTED'],
    ['pg pool: no free connection in time (Prisma 6: P2024)', pgError('timeout exceeded when trying to connect'), '', true, false, 'DB_UNAVAILABLE'],
    ['pg: the server did not answer the connect', pgError('Connection terminated due to connection timeout'), '', true, false, 'DB_UNAVAILABLE'],
    ['pg: a temporary DNS failure', pgError('getaddrinfo EAI_AGAIN ep-fake.neon.invalid', 'EAI_AGAIN'), 'EAI_AGAIN', true, false, 'DB_UNAVAILABLE'],
    ['pg: no route to host', pgError('connect EHOSTUNREACH', 'EHOSTUNREACH'), 'EHOSTUNREACH', true, false, 'DB_UNAVAILABLE'],
    ['P2028: the interactive transaction timed out', known('P2028', 'Transaction already closed', { modelName: 'Route', timeout: 400, timeTaken: 1200 }), 'P2028', true, false, 'DB_UNAVAILABLE'],
    ['P2034 40P01: a deadlock', p2034('40P01'), 'P2034', true, false, 'DB_UNAVAILABLE'],
    // Faults Prisma 6 did NOT treat as transient stay that way (its probe, same scenario).
    ['P2010 57P01: the backend was terminated mid-transaction', p2010('57P01', 'terminating connection due to administrator command'), 'P2010', false, false, 'RETHROWN'],
    ['P2039 57P01: a model write whose backend was terminated', p2039('Route', '57P01', 'terminating connection due to administrator command'), 'P2039', false, false, 'RETHROWN'],
    ['P2039 57014: a statement timeout', p2039('AuditLog', '57014', 'canceling statement due to statement timeout'), 'P2039', false, false, 'RETHROWN'],
    ['P2039 23514: a CHECK violation', p2039('Branch', '23514', 'new row for relation "Branch" violates check constraint "Branch_address_minlength"', 'Failing row contains (x).'), 'P2039', false, false, 'RETHROWN'],
    // Main's gap 31, on Prisma 7: a CHECK that IS one of the database rules (lib/db-rules.ts) is answered in the rule's words.
    ['P2039 23514: a CHECK that is a database rule', p2039('Branch', '23514', 'new row for relation "Branch" violates check constraint "Branch_gps_pair"', 'Failing row contains (x).'), 'P2039', false, false, 'DATA_RULE'],
    ['P2010 23514: the same rule from a raw query', p2010('23514', 'new row for relation "Branch" violates check constraint "Branch_gps_pair"', { detail: 'Failing row contains (x).' }), 'P2010', false, false, 'DATA_RULE'],
    ['P2039 42501: the append-only trigger', p2039('AuditLog', '42501', 'B4: UPDATE on "AuditLog" is forbidden — the audit trail is append-only.'), 'P2039', false, false, 'RETHROWN'],
    ['P1000: wrong password', known('P1000', 'Authentication failed against the database server', { driverAdapterError: adapterError({ kind: 'AuthenticationFailed', originalCode: '28P01' }) }), 'P1000', false, false, 'RETHROWN'],
  ] as const)('%s', async (_label, err, code, transient, committed, told) => {
    expect(isTransientDbError(err, code)).toBe(transient);
    expect(mayHaveCommitted(err, code)).toBe(committed);
    expect(await answer(err)).toBe(told);
  });

  it('a unique clash is still the user\'s problem: UNIQUE_CONSTRAINT, never an outage', async () => {
    const err = p2002('User', 'User_username_key');
    expect(isTransientDbError(err, 'P2002')).toBe(false);
    expect(await answer(err)).toBe('UNIQUE_CONSTRAINT');
    // services/edits.ts and lib/submission-replay.ts also match these words.
    expect(err.message).toMatch(/Unique constraint failed/i);
  });
});

describe('the account import and the customer promote name the clash as before', () => {
  it('accountRowFailure says which columns, not the constraint', () => {
    expect(accountRowFailure(p2002('User', 'User_username_key'), 'user a.b').message).toBe(
      'nothing was written for user a.b: its username is already used by another record.'
    );
    expect(accountRowFailure(p2002('Route', 'Route_regionId_code_key'), 'route R1').message).toBe(
      'nothing was written for route R1: its regionId, code is already used by another record.'
    );
    // Prisma 6's shape, the same sentence.
    expect(accountRowFailure({ code: 'P2002', meta: { target: ['username'] } }, 'user a.b').message).toBe(
      'nothing was written for user a.b: its username is already used by another record.'
    );
  });

  it('a dropped connection is still "may or may not have been written", a pool timeout "nothing was written"', () => {
    expect(accountRowFailure(pgError('Connection terminated unexpectedly'), 'X')).toMatchObject({ transient: true, mayHaveCommitted: true });
    expect(accountRowFailure(pgError('timeout exceeded when trying to connect'), 'X')).toMatchObject({ transient: true, mayHaveCommitted: false });
  });

  it('its message never carries the value that clashed', () => {
    const err = p2039('Branch', '23514', 'new row for relation "Branch" violates check constraint "Branch_address_minlength"', 'Failing row contains (+968 9123 4567).');
    const text = accountRowFailure(err, 'X').message;
    expect(text).toBe('nothing was written for X: the database refused it (Branch_address_minlength).');
    expect(text).not.toMatch(/968|Failing row/);
  });
});

describe('the seal retry predicate (lib/seal/seal.ts isSealRace)', () => {
  it('a unique clash on the seal or a serialization failure is a lost race, in both versions', () => {
    expect(isSealRace(p2002('SealRecord', 'SealRecord_day_key'))).toBe(true);
    expect(isSealRace(p2002('SealRecord', 'SealRecord_seq_key'))).toBe(true);
    expect(isSealRace(p2034('40001'))).toBe(true);
    expect(isSealRace(p2010('23505', 'duplicate key value violates unique constraint "SealRecord_seq_key"', { kind: 'UniqueConstraintViolation' }))).toBe(true);
    // Prisma 6: P2034 carried no SQLSTATE and meant 40001.
    expect(isSealRace({ code: 'P2034', meta: { modelName: 'SealRecord' } })).toBe(true);
    expect(isSealRace({ code: 'P2002', meta: { target: ['day'] } })).toBe(true);
  });

  it('a deadlock is not, though Prisma 7 reports it as P2034 too (Prisma 6: no code at all)', () => {
    expect(isSealRace(p2034('40P01'))).toBe(false);
    expect(isSealRace(new Error('Error occurred during query execution: deadlock detected'))).toBe(false);
    expect(isSealRace(p2010('40P01', 'deadlock detected', { kind: 'TransactionWriteConflict' }))).toBe(false);
  });
});

describe('describeError (scripts/ops): class and codes only', () => {
  it('reads the SQLSTATE Prisma 7 keeps in the adapter error, and never its message or DETAIL', () => {
    const err = p2039('Branch', '23514', 'new row for relation "Branch" violates check constraint "Branch_address_minlength"', 'Failing row contains (ZQX Trading, +968 9123 4567).');
    expect(describeError(err)).toBe('PrismaClientKnownRequestError P2039 23514');
    expect(describeError(p2002('User', 'User_email_key'))).toBe('PrismaClientKnownRequestError P2002 23505');
    expect(describeError(p2010('42501', 'permission denied for table _prisma_migrations'))).toBe('PrismaClientKnownRequestError P2010 42501');
    expect(describeError(closed('P1017'))).toBe('PrismaClientKnownRequestError P1017');
    // A code that is not shaped like one is left out.
    expect(describeError(known('P2039', 'x', { driverAdapterError: adapterError({ kind: 'postgres', originalCode: 'ZQX shop' }) }))).toBe(
      'PrismaClientKnownRequestError P2039'
    );
  });
});
