/**
 * Gap 28 (data audit 2026-10-10): WHAT the daily seal covers, and how a row is
 * turned into bytes. Fixed per format version: a seal made with version N is
 * always verified with version N's lists, so a column added later can never
 * change how an old row hashes.
 *
 * Every append-only ledger is sealed, by a strictly increasing key: AuditLog,
 * EditApproval and ExportJob by their seq (migration 20261024120200; their ids
 * are cuids), the others by their BIGSERIAL id. SealRecord is the chain itself.
 *
 * A row's bytes are Postgres's own `json_build_array(<the listed columns>)::text`,
 * computed inside the database: timestamps, dates, jsonb, numeric, enums and
 * arrays print in one canonical ISO/JSON form whatever the session's DateStyle
 * or TimeZone. No sealed column is a float (tests/unit/seal-columns-guard.test.ts).
 * The range digest is the SHA-256 of the row digests concatenated in key order;
 * an empty range's digest is the SHA-256 of ''.
 *
 * Table names, keys and columns come only from these constants (an identifier
 * whitelist checked again where the SQL is built); range bounds are bound
 * parameters.
 *
 * PURE: no imports but Prisma's SQL helpers.
 */
import { Prisma } from '@prisma/client';

export const SEAL_FORMAT_VERSION = 1;

export type SealedTable = {
  table: string;
  /** The strictly increasing key the ranges are read by. */
  key: 'id' | 'seq';
  /** The columns hashed, in this order. */
  columns: readonly string[];
};

const HISTORY_META = [
  'id',
  'changeKind',
  'changedFields',
  'validFrom',
  'recordedAt',
  'effectiveRequested',
  'actorId',
  'source',
  'sourceKind',
  'txId',
  'dbUser',
] as const;

/** Format version → the sealed tables, in body order. */
export const SEALED_TABLES: Record<number, readonly SealedTable[]> = {
  1: [
    {
      table: 'AuditLog',
      key: 'seq',
      columns: ['seq', 'id', 'actorId', 'action', 'entityType', 'entityId', 'before', 'after', 'reason', 'ip', 'userAgent', 'at', 'source', 'txId'],
    },
    {
      table: 'EditApproval',
      key: 'seq',
      columns: [
        'seq',
        'id',
        'editId',
        'cycle',
        'stepIndex',
        'role',
        'decision',
        'actorId',
        'reason',
        'at',
        'stageEnteredAt',
        'slaDueAt',
        'workingMinutes',
        'category',
        'actorRole',
        'authorityBasis',
        'scopeRegionIds',
        'submitterRouteId',
      ],
    },
    {
      table: 'ExportJob',
      key: 'seq',
      columns: [
        'seq',
        'id',
        'requestedById',
        'filters',
        'status',
        'r2Key',
        'rowCount',
        'startedAt',
        'completedAt',
        'errorMessage',
        'kind',
        'fileSha256',
        'filename',
        'customerIds',
      ],
    },
    {
      table: 'CustomerHistory',
      key: 'id',
      columns: [
        ...HISTORY_META,
        'customerId',
        'nmwcCode',
        'paymentTerms',
        'creditLimit',
        'paymentTermDays',
        'temixCode',
        'status',
        'channelId',
        'subChannelId',
        'crPhotoId',
        'deletedAt',
        'mergedIntoId',
      ],
    },
    {
      table: 'BranchHistory',
      key: 'id',
      columns: [
        ...HISTORY_META,
        'branchId',
        'branchCode',
        'customerId',
        'routeId',
        'regionId',
        'dayOfVisit',
        'status',
        'deletedAt',
        'coolersCount',
        'standsCount',
        'emptyBottlesCount',
        'equipmentConfirmed',
        'hasGps',
        'shopPhotoId',
        'signboardPhotoId',
      ],
    },
    {
      table: 'UserHistory',
      key: 'id',
      columns: [...HISTORY_META, 'userId', 'username', 'role', 'isActive', 'supervisorId', 'ownedRouteId', 'regionIds'],
    },
    { table: 'RouteOwnerHistory', key: 'id', columns: [...HISTORY_META, 'routeId', 'ownerId'] },
    { table: 'RouteHistory', key: 'id', columns: [...HISTORY_META, 'routeId', 'code', 'name', 'regionId', 'isActive'] },
    { table: 'RegionHistory', key: 'id', columns: [...HISTORY_META, 'regionId', 'code', 'name', 'isActive'] },
    {
      table: 'AttachmentHistory',
      key: 'id',
      columns: [
        ...HISTORY_META,
        'attachmentId',
        'kind',
        'customerId',
        'branchId',
        'branchExtraId',
        'editId',
        'deletedAt',
        'hash',
        'capturedById',
        'capturedAt',
      ],
    },
    {
      table: 'EditRevision',
      key: 'id',
      columns: [
        'id',
        'editId',
        'cycle',
        'process',
        'submittedAt',
        'submittedById',
        'paymentTerms',
        'requestedCreditLimit',
        'requestedPaymentTermDays',
        'approvalChain',
        'payload',
        'payloadSha256',
        'recordedAt',
        'source',
      ],
    },
    {
      table: 'AuthEvent',
      key: 'id',
      columns: ['id', 'at', 'kind', 'userId', 'usernameHmac', 'keyId', 'reason', 'ip', 'userAgent', 'actorId', 'source', 'txId', 'dbUser'],
    },
    {
      table: 'JobRunDay',
      key: 'id',
      columns: ['id', 'key', 'day', 'runs', 'failures', 'firstAt', 'lastAt', 'maxDurationMs', 'sources', 'recordedAt'],
    },
    {
      table: 'PurgeSummary',
      key: 'id',
      columns: [
        'id',
        'at',
        'job',
        'rule',
        'tableName',
        'action',
        'rows',
        'dateColumn',
        'oldestAt',
        'newestAt',
        'cutoff',
        'retentionDays',
        'detail',
        'runId',
        'source',
        'txId',
      ],
    },
  ],
};

/**
 * Columns of a sealed model deliberately left out of the current version, with
 * the reason. A column in neither list fails tests/unit/seal-columns-guard.test.ts:
 * adding one to a ledger means deciding whether the next format version seals it.
 */
export const SEAL_UNSEALED_COLUMNS: Record<string, Record<string, string>> = {};

export function sealedTables(version: number): readonly SealedTable[] {
  const t = SEALED_TABLES[version];
  if (!t) throw new Error(`unknown seal format version ${version}`);
  return t;
}

const IDENT = /^[A-Za-z][A-Za-z0-9]{0,62}$/;

function ident(name: string): Prisma.Sql {
  if (!IDENT.test(name)) throw new Error(`bad sealed identifier ${name}`);
  return Prisma.raw(`"${name}"`);
}

/** Look a table up in a version's whitelist; anything else is refused. */
export function sealedTable(version: number, table: string): SealedTable {
  const t = sealedTables(version).find((x) => x.table === table);
  if (!t) throw new Error(`${table} is not sealed in format version ${version}`);
  return t;
}

/** One row's bytes, as SQL over alias t. */
export function rowJsonSql(t: SealedTable): Prisma.Sql {
  return Prisma.sql`json_build_array(${Prisma.join(
    t.columns.map((c) => Prisma.sql`t.${ident(c)}`),
    ', '
  )})::text`;
}

/**
 * The count and digest of the rows with from < key <= to. The digest is the
 * SHA-256 (hex) of the rows' own SHA-256s concatenated in key order.
 */
export function rangeDigestSql(version: number, table: string, from: bigint, to: bigint): Prisma.Sql {
  const t = sealedTable(version, table);
  const key = ident(t.key);
  return Prisma.sql`SELECT count(*)::int AS n,
       encode(sha256(convert_to(COALESCE(string_agg(
         encode(sha256(convert_to(${rowJsonSql(t)}, 'UTF8')), 'hex'),
         '' ORDER BY t.${key}), ''), 'UTF8')), 'hex') AS digest
  FROM ${ident(t.table)} t
 WHERE t.${key} > ${from.toString()}::bigint AND t.${key} <= ${to.toString()}::bigint`;
}

/** The highest key visible now (0 for an empty table). */
export function maxKeySql(version: number, table: string): Prisma.Sql {
  const t = sealedTable(version, table);
  return Prisma.sql`SELECT COALESCE(max(t.${ident(t.key)}), 0)::text AS next FROM ${ident(t.table)} t`;
}

/** How many rows have a key at or below `to`: every one a seal has covered. */
export function countUpToSql(version: number, table: string, to: bigint): Prisma.Sql {
  const t = sealedTable(version, table);
  return Prisma.sql`SELECT count(*)::text AS n FROM ${ident(t.table)} t WHERE t.${ident(t.key)} <= ${to.toString()}::bigint`;
}

/** SHA-256 of the empty string: the digest of a range with no rows. */
export const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
