/**
 * Gap 31 (data audit 2026-10-10): the rules the application keeps that the
 * database now keeps too — the single source for the migration that adds them
 * (prisma/migrations/20261025090000_db_rules_not_valid), the nightly count of
 * older rows that break them (lib/integrity/checks.ts db-rules-older-rows), the
 * operator's report (scripts/ops/db-rules-report.ts) and the words a refused
 * save is answered with (lib/db-errors.ts dbRuleViolated).
 *
 * Every rule is added NOT VALID, so the migration scans nothing and cannot fail
 * on old data. What that means (docs/OPERATIONS.md section 5l):
 *   - a NOT VALID CHECK is evaluated on every INSERT and every UPDATE of a row,
 *     an update to an unrelated column included. An older row that breaks one
 *     can therefore not be saved again by ANY path until it is corrected: an
 *     edit, a merge, an archive, the Temix refresh, a status follow, or a user
 *     delete that sets its creator to null;
 *   - a NOT VALID foreign key is checked only when its own columns change. An
 *     older orphan can still be saved as long as its link is not touched.
 * A rule is VALIDATEd by a later migration of its own, once the nightly count
 * says 0 for it on UAT and on production.
 *
 * Each CHECK holds only what every writer already guarantees: the zod bounds
 * (lib/validation/edit.ts, lib/validation/create.ts), normalizePhone
 * (lib/phone.ts) and normalizeCR (lib/cr.ts), so the database never refuses
 * what the application accepts. tests/unit/db-rules-parity.test.ts holds them
 * together; tests/unit/db-rules-migration-guard.test.ts holds the migration and
 * schema.prisma to this file.
 *
 * PURE: no imports. Every SQL string here is built from these constants only.
 */

/** Oman's envelope as the forms bound it (PROD-005: ~1° of slack on each edge). */
export const OMAN_GPS = { latMin: 16, latMax: 27, lngMin: 51, lngMax: 61 } as const;

/** The bounds of a reported GPS accuracy, in metres (both schemas). */
export const GPS_ACCURACY_MAX = 10000;

/** The equipment caps of the edit count() and the create schema. */
export const EQUIPMENT_CAPS = { coolersCount: 100, standsCount: 100, emptyBottlesCount: 1000 } as const;

/** The only shape normalizePhone returns (besides null): +968 and eight ASCII digits. */
export const PHONE_NORM_PATTERN = '^\\+968[0-9]{8}$';

/**
 * Exactly the code points normalizeCR removes or folds — ASCII lower case
 * (upper-cased), every character JavaScript's \s matches, the invisible format
 * characters, and the Arabic-Indic and Persian digits — written as \u escapes so
 * JavaScript's RegExp and PostgreSQL's regex engine read the same class. No
 * output of normalizeCR contains one of them. A row normalised before item 16
 * (2026-09-25) may: scripts/ops/recompute-cr-norm.ts corrects it.
 */
// Doubled backslashes, not String.raw: the test transform cooked a String.raw
// template's escapes (2026-10-24), and this text must reach Postgres as written.
export const CR_NORM_FORBIDDEN_CLASS =
  '\\u0061-\\u007A\\u0009-\\u000D\\u0020\\u00A0\\u00AD\\u061C\\u0660-\\u0669\\u06F0-\\u06F9\\u1680\\u180E\\u2000-\\u200F\\u2028-\\u202F\\u205F-\\u2064\\u2066-\\u206F\\u3000\\uFEFF';

export type DbRuleTable =
  | 'Customer'
  | 'Branch'
  | 'EditCustomerDraft'
  | 'EditBranchDraft'
  | 'Attachment'
  | 'Notification'
  | 'EditApproval'
  | 'CustomerEdit';

type Row = Record<string, unknown>;

type RuleCommon = {
  /** The constraint's name in the database. */
  name: string;
  table: DbRuleTable;
  columns: readonly string[];
  /** Why the rule exists, for the docs and the operator's report. */
  why: string;
  /** What a refused save tells the person, in words safe to show (no value). */
  refusal: string;
};

export type DbCheckRule = RuleCommon & {
  kind: 'check';
  /** The exact CHECK expression in the migration (unqualified column names). */
  sql: string;
  /** The same rule in JavaScript, with SQL's NULL semantics (a NULL result passes). */
  holds: (row: Row) => boolean;
};

export type FkAction = 'SET NULL' | 'RESTRICT' | 'NO ACTION' | 'CASCADE';

export type DbFkRule = RuleCommon & {
  kind: 'fk';
  refTable: string;
  refColumns: readonly string[];
  onDelete: Exclude<FkAction, 'CASCADE'>;
  onUpdate: 'CASCADE' | 'NO ACTION';
};

export type DbRule = DbCheckRule | DbFkRule;

const isNull = (v: unknown) => v === null || v === undefined;
const between = (v: unknown, lo: number, hi: number) => typeof v === 'number' && v >= lo && v <= hi;
const crForbidden = new RegExp(`[${CR_NORM_FORBIDDEN_CLASS}]`, 'u');
const phoneShape = new RegExp(PHONE_NORM_PATTERN);

const ASK_STEWARD = 'Ask the Data Steward to correct it.';
const STORED_CUSTOMER = (what: string) => `This customer's stored record breaks a data rule (${what}). ${ASK_STEWARD}`;
const STORED_SHOP = (what: string) => `This shop's stored record breaks a data rule (${what}). ${ASK_STEWARD}`;
const STORED_DRAFT = (what: string) => `This request's saved details break a data rule (${what}). ${ASK_STEWARD}`;
const DANGLING = (what: string) =>
  `This save points at ${what} that does not exist, so nothing was saved. Reload the page and try again; if it happens again, tell the Data Steward.`;

// ── The CHECK expressions (shared by the twin tables) ─────────────────────

const SUBCHANNEL_NEEDS_CHANNEL = `"subChannelId" IS NULL OR "channelId" IS NOT NULL`;
const PHONE_NORM_SHAPE = `"primaryPhoneNorm" IS NULL OR "primaryPhoneNorm" ~ '${PHONE_NORM_PATTERN}'`;
const CR_NORM_SHAPE = `"crNumberNorm" IS NULL OR ("crNumberNorm" <> '' AND "crNumberNorm" !~ '[${CR_NORM_FORBIDDEN_CLASS}]')`;
const GPS_IN_OMAN =
  `("gpsLat" IS NULL OR "gpsLat" BETWEEN ${OMAN_GPS.latMin} AND ${OMAN_GPS.latMax}) AND ` +
  `("gpsLng" IS NULL OR "gpsLng" BETWEEN ${OMAN_GPS.lngMin} AND ${OMAN_GPS.lngMax})`;
const GPS_PAIR = `("gpsLat" IS NULL) = ("gpsLng" IS NULL)`;
const GPS_ACCURACY = `"gpsAccuracy" IS NULL OR "gpsAccuracy" BETWEEN 0 AND ${GPS_ACCURACY_MAX}`;
const EQUIPMENT =
  `"coolersCount" BETWEEN 0 AND ${EQUIPMENT_CAPS.coolersCount} AND ` +
  `"standsCount" BETWEEN 0 AND ${EQUIPMENT_CAPS.standsCount} AND ` +
  `"emptyBottlesCount" BETWEEN 0 AND ${EQUIPMENT_CAPS.emptyBottlesCount}`;

const subChannelHolds = (r: Row) => isNull(r.subChannelId) || !isNull(r.channelId);
const phoneHolds = (r: Row) => isNull(r.primaryPhoneNorm) || (typeof r.primaryPhoneNorm === 'string' && phoneShape.test(r.primaryPhoneNorm));
const crHolds = (r: Row) =>
  isNull(r.crNumberNorm) || (typeof r.crNumberNorm === 'string' && r.crNumberNorm !== '' && !crForbidden.test(r.crNumberNorm));
const gpsInOmanHolds = (r: Row) =>
  (isNull(r.gpsLat) || between(r.gpsLat, OMAN_GPS.latMin, OMAN_GPS.latMax)) &&
  (isNull(r.gpsLng) || between(r.gpsLng, OMAN_GPS.lngMin, OMAN_GPS.lngMax));
const gpsAccuracyHolds = (r: Row) => isNull(r.gpsAccuracy) || between(r.gpsAccuracy, 0, GPS_ACCURACY_MAX);
/** NULL counts pass, as in SQL (the columns are NOT NULL, so none arrives). */
const capHolds = (v: unknown, cap: number) => isNull(v) || between(v, 0, cap);
const equipmentHolds = (r: Row) =>
  capHolds(r.coolersCount, EQUIPMENT_CAPS.coolersCount) &&
  capHolds(r.standsCount, EQUIPMENT_CAPS.standsCount) &&
  capHolds(r.emptyBottlesCount, EQUIPMENT_CAPS.emptyBottlesCount);

const WHY = {
  credit:
    'A cash customer carries no credit limit and no term days: finalize writes none for CASH, the import clears both on an explicit CASH, edits never change the terms, and scripts/ops/verify-load.ts gates it.',
  subChannel:
    'A sub-channel is always one of a channel’s (lib/channel-pair.ts); creates and edits refuse one without a channel. The composite foreign key skips a row whose channel is null (MATCH SIMPLE), so this CHECK covers that case.',
  phone:
    'The phone de-duplication key: normalizePhone (lib/phone.ts) returns null or +968 and eight digits, and every writer (create, edit, import) stores its output.',
  cr: 'The CR de-duplication key: no output of normalizeCR (lib/cr.ts) is empty or holds a character it removes or folds. A row normalised before item 16 may: scripts/ops/recompute-cr-norm.ts corrects it.',
  gps: 'The forms bound a shop’s GPS to Oman (16–27°N, 51–61°E, lib/validation/edit.ts and create.ts); the import writes no GPS. The database follows the app’s bounds, so it never refuses a point the app accepts.',
  gpsPair:
    'A shop’s location is a pair: the edit schema and the create submit gate both require both coordinates. A draft may hold one, so the draft table is left out.',
  accuracy: 'A reported GPS accuracy is 0 to 10,000 metres in both schemas.',
  equipment: 'Coolers and stands 0–100, empty bottles 0–1,000: the edit count() caps and the create schema. Only edits and creates write them.',
  user: 'Every writer stores a real user id as creator or last editor; a deleted user leaves the column null (SET NULL).',
  importBatch: 'The import batch a customer came from; a deleted batch leaves the column null (SET NULL).',
  temixBatch: 'The Temix batch a customer was last uploaded in; a deleted batch leaves the column null (SET NULL).',
  pair: 'A sub-channel belongs to its channel: (subChannelId, channelId) must be a SubChannel’s (id, channelId). Checked when the pair changes, as lib/channel-pair.ts checks it.',
  attachment:
    'A photo’s customer and shop links, SET NULL like branchExtraId: AttachmentHistory keeps the old link, and RESTRICT would block the fixture teardowns.',
  notification: 'A notification’s customer link; a deleted customer leaves it null (SET NULL). UAT held 232 orphans on 2026-10-10.',
  approvalRoute: 'EditApproval is an append-only ledger: the submitter’s route it names stays (RESTRICT).',
  originalCustomer: 'Set once by the trigger customeredit_original_customer and never changed: the customer stays (RESTRICT).',
  newRoute: 'The route a wrong-route request asks for: the evidence guard refuses a SET NULL on a sent request, so the route stays (RESTRICT).',
} as const;

export const DB_RULES: readonly DbRule[] = [
  // ── Customer ──
  {
    name: 'Customer_credit_terms_only_credit',
    kind: 'check',
    table: 'Customer',
    columns: ['paymentTerms', 'creditLimit', 'paymentTermDays'],
    sql: `"paymentTerms" = 'CREDIT' OR ("creditLimit" IS NULL AND "paymentTermDays" IS NULL)`,
    holds: (r) => r.paymentTerms === 'CREDIT' || (isNull(r.creditLimit) && isNull(r.paymentTermDays)),
    why: WHY.credit,
    refusal: STORED_CUSTOMER('credit figures on a cash customer'),
  },
  {
    name: 'Customer_subChannel_needs_channel',
    kind: 'check',
    table: 'Customer',
    columns: ['subChannelId', 'channelId'],
    sql: SUBCHANNEL_NEEDS_CHANNEL,
    holds: subChannelHolds,
    why: WHY.subChannel,
    refusal: STORED_CUSTOMER('a sub-channel with no channel'),
  },
  {
    name: 'Customer_primaryPhoneNorm_shape',
    kind: 'check',
    table: 'Customer',
    columns: ['primaryPhoneNorm'],
    sql: PHONE_NORM_SHAPE,
    holds: phoneHolds,
    why: WHY.phone,
    refusal: STORED_CUSTOMER('a phone key not in the +968 form'),
  },
  {
    name: 'Customer_crNumberNorm_shape',
    kind: 'check',
    table: 'Customer',
    columns: ['crNumberNorm'],
    sql: CR_NORM_SHAPE,
    holds: crHolds,
    why: WHY.cr,
    refusal: STORED_CUSTOMER('a CR key written before the current CR rule'),
  },
  {
    name: 'Customer_subChannelId_channelId_fkey',
    kind: 'fk',
    table: 'Customer',
    columns: ['subChannelId', 'channelId'],
    refTable: 'SubChannel',
    refColumns: ['id', 'channelId'],
    onDelete: 'NO ACTION',
    onUpdate: 'NO ACTION',
    why: WHY.pair,
    refusal: 'The sub-channel chosen is not one of the chosen channel’s, so nothing was saved. Pick the sub-channel again.',
  },
  {
    name: 'Customer_createdById_fkey',
    kind: 'fk',
    table: 'Customer',
    columns: ['createdById'],
    refTable: 'User',
    refColumns: ['id'],
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    why: WHY.user,
    refusal: DANGLING('a user'),
  },
  {
    name: 'Customer_lastEditedById_fkey',
    kind: 'fk',
    table: 'Customer',
    columns: ['lastEditedById'],
    refTable: 'User',
    refColumns: ['id'],
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    why: WHY.user,
    refusal: DANGLING('a user'),
  },
  {
    name: 'Customer_importBatchId_fkey',
    kind: 'fk',
    table: 'Customer',
    columns: ['importBatchId'],
    refTable: 'ImportBatch',
    refColumns: ['id'],
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    why: WHY.importBatch,
    refusal: DANGLING('an import batch'),
  },
  {
    name: 'Customer_lastTemixUploadBatchId_fkey',
    kind: 'fk',
    table: 'Customer',
    columns: ['lastTemixUploadBatchId'],
    refTable: 'TemixSyncBatch',
    refColumns: ['id'],
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    why: WHY.temixBatch,
    refusal: DANGLING('a Temix batch'),
  },

  // ── Branch ──
  {
    name: 'Branch_gps_in_oman',
    kind: 'check',
    table: 'Branch',
    columns: ['gpsLat', 'gpsLng'],
    sql: GPS_IN_OMAN,
    holds: gpsInOmanHolds,
    why: WHY.gps,
    refusal: STORED_SHOP('a location outside Oman'),
  },
  {
    name: 'Branch_gps_pair',
    kind: 'check',
    table: 'Branch',
    columns: ['gpsLat', 'gpsLng'],
    sql: GPS_PAIR,
    holds: (r) => isNull(r.gpsLat) === isNull(r.gpsLng),
    why: WHY.gpsPair,
    refusal: STORED_SHOP('a location with only one coordinate'),
  },
  {
    name: 'Branch_gpsAccuracy_range',
    kind: 'check',
    table: 'Branch',
    columns: ['gpsAccuracy'],
    sql: GPS_ACCURACY,
    holds: gpsAccuracyHolds,
    why: WHY.accuracy,
    refusal: STORED_SHOP('a GPS accuracy outside 0–10,000 m'),
  },
  {
    name: 'Branch_equipment_counts_range',
    kind: 'check',
    table: 'Branch',
    columns: ['coolersCount', 'standsCount', 'emptyBottlesCount'],
    sql: EQUIPMENT,
    holds: equipmentHolds,
    why: WHY.equipment,
    refusal: STORED_SHOP('equipment counts outside their limits'),
  },
  {
    name: 'Branch_createdById_fkey',
    kind: 'fk',
    table: 'Branch',
    columns: ['createdById'],
    refTable: 'User',
    refColumns: ['id'],
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    why: WHY.user,
    refusal: DANGLING('a user'),
  },
  {
    name: 'Branch_lastEditedById_fkey',
    kind: 'fk',
    table: 'Branch',
    columns: ['lastEditedById'],
    refTable: 'User',
    refColumns: ['id'],
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    why: WHY.user,
    refusal: DANGLING('a user'),
  },

  // ── EditCustomerDraft (a new customer's request) ──
  {
    name: 'EditCustomerDraft_subChannel_needs_channel',
    kind: 'check',
    table: 'EditCustomerDraft',
    columns: ['subChannelId', 'channelId'],
    sql: SUBCHANNEL_NEEDS_CHANNEL,
    holds: subChannelHolds,
    why: WHY.subChannel,
    refusal: STORED_DRAFT('a sub-channel with no channel'),
  },
  {
    name: 'EditCustomerDraft_primaryPhoneNorm_shape',
    kind: 'check',
    table: 'EditCustomerDraft',
    columns: ['primaryPhoneNorm'],
    sql: PHONE_NORM_SHAPE,
    holds: phoneHolds,
    why: WHY.phone,
    refusal: STORED_DRAFT('a phone key not in the +968 form'),
  },
  {
    name: 'EditCustomerDraft_crNumberNorm_shape',
    kind: 'check',
    table: 'EditCustomerDraft',
    columns: ['crNumberNorm'],
    sql: CR_NORM_SHAPE,
    holds: crHolds,
    why: WHY.cr,
    refusal: STORED_DRAFT('a CR key written before the current CR rule'),
  },
  {
    name: 'EditCustomerDraft_subChannelId_channelId_fkey',
    kind: 'fk',
    table: 'EditCustomerDraft',
    columns: ['subChannelId', 'channelId'],
    refTable: 'SubChannel',
    refColumns: ['id', 'channelId'],
    onDelete: 'NO ACTION',
    onUpdate: 'NO ACTION',
    why: WHY.pair,
    refusal: 'The sub-channel chosen is not one of the chosen channel’s, so nothing was saved. Pick the sub-channel again.',
  },

  // ── EditBranchDraft ──
  {
    name: 'EditBranchDraft_gps_in_oman',
    kind: 'check',
    table: 'EditBranchDraft',
    columns: ['gpsLat', 'gpsLng'],
    sql: GPS_IN_OMAN,
    holds: gpsInOmanHolds,
    why: WHY.gps,
    refusal: STORED_DRAFT('a shop location outside Oman'),
  },
  {
    name: 'EditBranchDraft_gpsAccuracy_range',
    kind: 'check',
    table: 'EditBranchDraft',
    columns: ['gpsAccuracy'],
    sql: GPS_ACCURACY,
    holds: gpsAccuracyHolds,
    why: WHY.accuracy,
    refusal: STORED_DRAFT('a GPS accuracy outside 0–10,000 m'),
  },
  {
    name: 'EditBranchDraft_equipment_counts_range',
    kind: 'check',
    table: 'EditBranchDraft',
    columns: ['coolersCount', 'standsCount', 'emptyBottlesCount'],
    sql: EQUIPMENT,
    holds: equipmentHolds,
    why: WHY.equipment,
    refusal: STORED_DRAFT('equipment counts outside their limits'),
  },

  // ── Attachment ──
  {
    name: 'Attachment_customerId_fkey',
    kind: 'fk',
    table: 'Attachment',
    columns: ['customerId'],
    refTable: 'Customer',
    refColumns: ['id'],
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    why: WHY.attachment,
    refusal: DANGLING('a customer'),
  },
  {
    name: 'Attachment_branchId_fkey',
    kind: 'fk',
    table: 'Attachment',
    columns: ['branchId'],
    refTable: 'Branch',
    refColumns: ['id'],
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    why: WHY.attachment,
    refusal: DANGLING('a shop'),
  },

  // ── Notification ──
  {
    name: 'Notification_customerId_fkey',
    kind: 'fk',
    table: 'Notification',
    columns: ['customerId'],
    refTable: 'Customer',
    refColumns: ['id'],
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    why: WHY.notification,
    refusal: DANGLING('a customer'),
  },

  // ── EditApproval ──
  {
    name: 'EditApproval_submitterRouteId_fkey',
    kind: 'fk',
    table: 'EditApproval',
    columns: ['submitterRouteId'],
    refTable: 'Route',
    refColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    why: WHY.approvalRoute,
    refusal: DANGLING('a route'),
  },

  // ── CustomerEdit ──
  {
    name: 'CustomerEdit_originalCustomerId_fkey',
    kind: 'fk',
    table: 'CustomerEdit',
    columns: ['originalCustomerId'],
    refTable: 'Customer',
    refColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    why: WHY.originalCustomer,
    refusal: DANGLING('a customer'),
  },
  {
    name: 'CustomerEdit_newRouteId_fkey',
    kind: 'fk',
    table: 'CustomerEdit',
    columns: ['newRouteId'],
    refTable: 'Route',
    refColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    why: WHY.newRoute,
    refusal: DANGLING('a route'),
  },
];

/**
 * The other foreign keys the gap-31 and gap-18 migrations write NOT VALID, which
 * no older row can break, so the nightly count leaves them out: the two request
 * links re-added as RESTRICT (they were SET NULL, and the old keys held), and the
 * route a request was sent from (a new column, null on every older row). Each
 * can be VALIDATEd at any time (docs/OPERATIONS.md section 5l).
 */
export const NOT_VALID_LINKS_NO_OLDER_ROW_BREAKS: readonly DbFkRule[] = [
  {
    name: 'CustomerEdit_customerId_fkey',
    kind: 'fk',
    table: 'CustomerEdit',
    columns: ['customerId'],
    refTable: 'Customer',
    refColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    why: 'The application never hard-deletes a customer; a request keeps the customer it is about (it was SET NULL).',
    refusal: DANGLING('a customer'),
  },
  {
    name: 'CustomerEdit_branchId_fkey',
    kind: 'fk',
    table: 'CustomerEdit',
    columns: ['branchId'],
    refTable: 'Branch',
    refColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    why: 'The application never hard-deletes a shop; a request keeps the shop it is about (it was SET NULL).',
    refusal: DANGLING('a shop'),
  },
  {
    // Gap 18 (migration 20261025090100_request_scope_at_submit): a new column.
    name: 'CustomerEdit_routeIdAtSubmit_fkey',
    kind: 'fk',
    table: 'CustomerEdit',
    columns: ['routeIdAtSubmit'],
    refTable: 'Route',
    refColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
    why: 'The route a request was raised from (gap 18): a sent request is evidence, so the route it names stays (RESTRICT).',
    refusal: DANGLING('a route'),
  },
];

export const DB_RULE_BY_NAME: ReadonlyMap<string, DbRule> = new Map(
  [...DB_RULES, ...NOT_VALID_LINKS_NO_OLDER_ROW_BREAKS].map((r) => [r.name, r])
);

const ident = (s: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`not an identifier: ${s}`);
  return `"${s}"`;
};

/**
 * The ids of the rows that break a rule now — the rows a VALIDATE would refuse.
 *   check: the rows whose expression is FALSE (NULL passes, as in a CHECK);
 *   fk:    the rows with every key column set (MATCH SIMPLE) and no row they name.
 * Table names are left unqualified on purpose: the gated suite proves the count
 * on TEMP-table shadows, which come first on the search path.
 */
export function dbRuleViolationsSql(rule: DbRule): string {
  const t = ident(rule.table);
  if (rule.kind === 'check') return `SELECT t."id" FROM ${t} t WHERE NOT COALESCE((${rule.sql}), TRUE)`;
  const set = rule.columns.map((c) => `t.${ident(c)} IS NOT NULL`).join(' AND ');
  const match = rule.columns.map((c, i) => `r.${ident(rule.refColumns[i]!)} = t.${ident(c)}`).join(' AND ');
  return `SELECT t."id" FROM ${t} t WHERE ${set} AND NOT EXISTS (SELECT 1 FROM ${ident(rule.refTable)} r WHERE ${match})`;
}

/** How many samples per rule the nightly check and the report read. */
export const DB_RULE_SAMPLES = 3;

/** One statement: per rule, its name, how many rows break it and its first ids. */
export function dbRulesCountSql(rules: readonly DbRule[] = DB_RULES, samples = DB_RULE_SAMPLES): string {
  return rules
    .map(
      (r) =>
        `SELECT '${r.name.replace(/'/g, "''")}'::text AS rule, count(*)::int AS n, ` +
        `(array_agg(x."id"::text ORDER BY x."id"::text))[1:${Math.max(0, Math.floor(samples))}] AS ids ` +
        `FROM (${dbRuleViolationsSql(r)}) x`
    )
    .join('\nUNION ALL\n');
}

/** The names the nightly check and the report look up in pg_constraint. */
export const DB_RULE_NAMES: readonly string[] = DB_RULES.map((r) => r.name);

/** The CHECK rules of one table, in DB_RULES order. */
export function checkRulesOf(table: DbRuleTable): DbCheckRule[] {
  return DB_RULES.filter((r): r is DbCheckRule => r.kind === 'check' && r.table === table);
}

/** The columns the CHECK rules of `table` read: what to select to test a row with brokenChecks. */
export function checkColumnsOf(table: DbRuleTable): string[] {
  return [...new Set(checkRulesOf(table).flatMap((r) => r.columns))];
}

/**
 * The CHECK rules of `table` that `row` breaks now: what any UPDATE of it would
 * be refused for, whatever column the UPDATE changes (a NOT VALID CHECK is
 * evaluated on every write of a row). One such row fails a whole multi-row
 * statement, so a batch writer tests its rows first and leaves these out
 * (services/temix.ts Generate and Mark loaded).
 */
export function brokenChecks(table: DbRuleTable, row: Row): DbCheckRule[] {
  return checkRulesOf(table).filter((r) => !r.holds(row));
}
