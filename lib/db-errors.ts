/**
 * REL-06: telling "the database was unavailable" apart from "this data is bad".
 *
 * This lived inside `services/imports.ts`, where it was learned the hard way:
 * transient engine faults were being recorded as permanent row REJECTIONS, so
 * infrastructure noise silently dropped good customers while the import batch
 * still finished green. The same distinction matters everywhere — a server
 * action that hits a pool timeout should tell the user to try again, not
 * present a generic failure — so it lives here, importing nothing but the pure
 * lib/db-rules.ts (gap 31), and both `lib/errors.ts` and `services/imports.ts` use it.
 *
 * Prisma 7 (the Postgres driver adapter) reports the same faults in new shapes,
 * and every rule below reads both, so each decision is the one Prisma 6 made
 * (pinned against real shapes of each in tests/unit/db-errors.test.ts):
 *   - the SQLSTATE moved from `meta.code` to
 *     `meta.driverAdapterError.cause.originalCode` (sqlStateOf);
 *   - a unique violation names its constraint (`User_email_key`) where Prisma 6
 *     listed the columns in `meta.target` (uniqueTargetFields);
 *   - a deadlock (40P01) from a model query is P2034 like a serialization
 *     failure, where it used to arrive with no code at all;
 *   - a database error Prisma has no code for is P2039 rather than an error
 *     with no code;
 *   - node-postgres's own failures pass through unwrapped, as plain Errors: a
 *     connection that closed mid-request ("Connection terminated
 *     unexpectedly"), no free pool connection in time ("timeout exceeded when
 *     trying to connect"), and the socket codes the adapter does not map;
 *   - a failure of COMMIT itself arrives as the adapter's own error, with no
 *     Prisma code and no meta at all (bareAdapterCause below): it is read as
 *     the code the same fault has on a statement.
 */
import { DB_RULE_BY_NAME, type DbRule } from './db-rules';

/**
 * Prisma codes that mean "the database was unavailable or slow", not "this data
 * is bad": unreachable, timed out, connection closed, no pool connection, and
 * the interactive-transaction timeout.
 */
export const TRANSIENT_DB_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1011',
  'P1017',
  'P2024',
  'P2028',
]);

/**
 * Node socket codes on an error node-postgres passes through as it is (the
 * adapter maps ENOTFOUND, ECONNREFUSED, ECONNRESET and ETIMEDOUT to P1001 /
 * P1017 / P1008 itself). The first set can only happen before anything was
 * sent; the second also mid-request, so a commit may already have landed.
 */
const SOCKET_BEFORE_SEND = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN']);
const SOCKET_MID_REQUEST = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED']);

/** Engine and driver words for "the connection or the engine died mid-request". */
const DIED_MID_REQUEST =
  /Response from the Engine was empty|Server has closed the connection|Connection terminated unexpectedly/i;
/** Words for "never reached it, or never got a connection": nothing was sent. */
const NEVER_REACHED =
  /Timed out fetching a new connection|Can't reach database server|timeout exceeded when trying to connect|Connection terminated due to connection timeout|Client has encountered a connection error and is not queryable/i;

const isSqlState = (c: unknown): c is string => typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c);
/** Only a real Error's words count, as before: a plain object's `message` is not Postgres's. */
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : '');

type AdapterCause = {
  originalCode?: unknown;
  kind?: unknown;
  table?: unknown;
  constraint?: { fields?: unknown; index?: unknown } | null;
};
type PrismaMeta = {
  code?: unknown;
  target?: unknown;
  modelName?: unknown;
  driverAdapterError?: { cause?: AdapterCause | null } | null;
};
const metaOf = (err: unknown): PrismaMeta | null => {
  const meta = (err as { meta?: unknown } | null)?.meta;
  return meta && typeof meta === 'object' ? (meta as PrismaMeta) : null;
};
/**
 * The adapter's own error, handed to the application as it is. Prisma 7 turns an
 * adapter error into a coded one (PrismaClientKnownRequestError, the adapter's
 * error under meta.driverAdapterError) for a statement and for BEGIN, but NOT
 * for COMMIT: when COMMIT fails — the connection reset or timed out while it
 * was on the wire, or the deferred constraint trigger that runs at commit
 * (managerregions_history_capture) hit a deadlock — the caller of $transaction
 * gets the bare DriverAdapterError. It has no `code` and no `meta`, its message
 * is only the kind's name ("ConnectionClosed"), and its `cause` is the object a
 * coded error carries at meta.driverAdapterError.cause. Seen on 7.10.1 with a
 * real client over a pool whose COMMIT fails (review of the upgrade,
 * 2026-11-10; tests/unit/prisma7-commit-errors.test.ts produces it that way on
 * every run, and prisma7-error-shapes.test.ts pins the shapes), the array and
 * the interactive form alike. Unread, every rule below answered "not mine", so
 * a lost COMMIT — the one moment where it is unknown whether the save landed
 * (item 22) — was a 500 instead of "may or may not have been saved", and the
 * customer import marked the group REJECTED.
 * Told by its name and an object cause, as the adapter's own isDriverAdapterError tells it.
 */
function bareAdapterCause(err: unknown): AdapterCause | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { name?: unknown; cause?: unknown };
  return e.name === 'DriverAdapterError' && e.cause !== null && typeof e.cause === 'object' ? (e.cause as AdapterCause) : null;
}
const causeOf = (err: unknown): AdapterCause | null => {
  const cause = metaOf(err)?.driverAdapterError?.cause;
  return cause && typeof cause === 'object' ? cause : bareAdapterCause(err);
};

/**
 * The Prisma code each adapter kind is given when Prisma does convert it — its
 * runtime's own table (7.10.1), a database's own error (kind "postgres") being
 * P2039. A bare adapter error is read as that code, so a fault at COMMIT and the
 * same fault on a statement are one decision in every rule here.
 */
const BARE_ADAPTER_KIND_CODES: Readonly<Record<string, string>> = {
  AuthenticationFailed: 'P1000',
  DatabaseNotReachable: 'P1001',
  DatabaseDoesNotExist: 'P1003',
  SocketTimeout: 'P1008',
  DatabaseAlreadyExists: 'P1009',
  DatabaseAccessDenied: 'P1010',
  TlsConnectionError: 'P1011',
  ConnectionClosed: 'P1017',
  TransactionAlreadyClosed: 'P1018',
  LengthMismatch: 'P2000',
  UniqueConstraintViolation: 'P2002',
  ForeignKeyConstraintViolation: 'P2003',
  RestrictViolation: 'P2003',
  InvalidInputValue: 'P2007',
  NullConstraintViolation: 'P2011',
  ValueOutOfRange: 'P2020',
  TableDoesNotExist: 'P2021',
  ColumnNotFound: 'P2022',
  TransactionWriteConflict: 'P2034',
  TooManyConnections: 'P2037',
  postgres: 'P2039',
};
function bareAdapterCode(err: unknown): string | null {
  const kind = bareAdapterCause(err)?.kind;
  return typeof kind === 'string' && Object.hasOwn(BARE_ADAPTER_KIND_CODES, kind) ? BARE_ADAPTER_KIND_CODES[kind]! : null;
}

const isPrismaCode = (code: unknown): code is string => typeof code === 'string' && /^P\d{4}$/.test(code);

/**
 * The error's own `code` (Prisma's, or a socket code node-postgres left on a
 * plain Error), or for a bare adapter error the code Prisma gives its kind;
 * undefined when it has none. What a caller passes on to the rules below, and
 * compares with 'P2002' itself.
 */
export function dbErrorCode(err: unknown): string | undefined {
  const own = (err as { code?: unknown } | null)?.code;
  if (typeof own === 'string' && own !== '') return own;
  return bareAdapterCode(err) ?? undefined;
}

/**
 * The code a rule decides by: the caller's when it is a Prisma code; otherwise —
 * '' or whatever placeholder stood in for "none" ('UNKNOWN' in the customer
 * promote) — a bare adapter error's, so a caller that reads `err.code` itself
 * is answered the same.
 */
function codeFor(err: unknown, code: string): string {
  return isPrismaCode(code) ? code : (bareAdapterCode(err) ?? code);
}

/**
 * The SQLSTATE behind a Prisma error, or null: Prisma 6's `meta.code` (raw
 * queries), Prisma 7's `meta.driverAdapterError.cause.originalCode`, else the
 * "Code: `XXXXX`" both write into a raw query's message. Five characters of
 * [0-9A-Z] only — never anything else from the error.
 */
export function sqlStateOf(err: unknown): string | null {
  const meta = metaOf(err);
  if (isSqlState(meta?.code)) return meta.code;
  const original = causeOf(err)?.originalCode;
  if (isSqlState(original)) return original;
  return /Code: `([0-9A-Z]{5})`/.exec(messageOf(err))?.[1] ?? null;
}

/**
 * Unique indexes created by raw SQL in prisma/migrations, whose names do not
 * follow Prisma's `<Model>_<column>[_<column>…]_key`, and the columns each one
 * covers — what Prisma 6 put in `meta.target` for them. The Temix-code index is
 * on an expression, and Prisma 6 listed that expression with its quotes taken
 * out (seen on Postgres 17 with Prisma 6.19, 2026-10-25); temixCodeIndexViolated
 * below reads the same words.
 * tests/unit/prisma7-error-shapes.test.ts checks this list against every CREATE
 * UNIQUE INDEX in the migrations.
 */
export const RAW_UNIQUE_INDEX_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  CustomerEdit_open_per_customer: ['customerId'],
  CustomerEdit_open_per_branch: ['branchId'],
  Customer_primaryPhoneNorm_active_unique: ['primaryPhoneNorm'],
  Customer_temixCode_live_unique: ['upper(btrim(temixCode))'],
};

/** The columns a unique constraint's name covers; the name itself when it cannot tell. */
function columnsOfConstraint(name: string, table: string | null): string[] {
  const raw = RAW_UNIQUE_INDEX_COLUMNS[name];
  if (raw) return [...raw];
  // Prisma names a unique index `<Model>_<columns joined by _>_key`; no column
  // in this schema has an underscore in its name.
  const m = /^([A-Za-z][A-Za-z0-9]*)_([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)_key$/.exec(name);
  if (m && (table === null || m[1] === table)) return m[2]!.split('_');
  return [name];
}

/**
 * The columns a unique violation (P2002) was on, as Prisma 6's `meta.target`
 * listed them: `meta.target` itself (an array, or on some engines a constraint
 * name), or Prisma 7's `meta.driverAdapterError.cause.constraint` (`fields`, or
 * the `index` name, turned back into its columns). Schema identifiers only, so
 * safe to show or log; [] when the error names none.
 */
export function uniqueTargetFields(err: unknown): string[] {
  const meta = metaOf(err);
  const cause = causeOf(err);
  const table = typeof cause?.table === 'string' ? cause.table : typeof meta?.modelName === 'string' ? meta.modelName : null;
  const strings = (v: unknown[]): string[] => v.filter((t): t is string => typeof t === 'string');
  const target = meta?.target;
  if (Array.isArray(target)) return strings(target);
  if (typeof target === 'string' && target !== '') return columnsOfConstraint(target, table);
  // Only a model query's P2002 had a target in Prisma 6; a raw query's clash
  // (P2010) never did, so it has none here either.
  const constraint = dbErrorCode(err) === 'P2002' ? cause?.constraint : null;
  if (constraint && typeof constraint === 'object') {
    if (Array.isArray(constraint.fields)) return strings(constraint.fields);
    if (typeof constraint.index === 'string' && constraint.index !== '') return columnsOfConstraint(constraint.index, table);
  }
  return [];
}

/**
 * Postgres aborted the transaction to break a deadlock (40P01) or a serialization
 * failure (40001). Prisma reports it as P2034 from a model query (Prisma 7: both;
 * Prisma 6: 40001 only), and as P2010 carrying the SQLSTATE from a raw one (the
 * row locks in lib/locks.ts are raw); an engine error Prisma 6 did not map has
 * no code, only Postgres's own words.
 * The aborted transaction rolled back whole and the same request run again
 * normally succeeds: not the data's fault, and not a programmer error.
 */
export function isDbConflict(err: unknown, given: string): boolean {
  const code = codeFor(err, given);
  if (code === 'P2034') return true;
  const msg = messageOf(err);
  if (code === 'P2010' || code === 'P2039') {
    const sqlState = sqlStateOf(err);
    return sqlState === '40P01' || sqlState === '40001';
  }
  // No Prisma code at all — whatever placeholder the caller passed for it ('',
  // 'UNKNOWN' in the customer promote) — leaves only Postgres's own words.
  return !isPrismaCode(code) && /deadlock detected|could not serialize access/i.test(msg);
}

/**
 * Prisma 7 reports EVERY adapter error of a raw query as P2010 (and a model
 * query's unmapped ones as P2039), a dropped connection included; the kind of
 * fault survives only in `meta.driverAdapterError.cause.kind`. These kinds are
 * read as the code the same fault has on a model query, so a raw statement and a
 * model write that lose their connection the same way are answered the same way.
 */
const ADAPTER_KIND_CODES: Readonly<Record<string, string>> = {
  DatabaseNotReachable: 'P1001',
  SocketTimeout: 'P1008',
  TlsConnectionError: 'P1011',
  ConnectionClosed: 'P1017',
};
function effectiveCode(err: unknown, given: string): string {
  const code = codeFor(err, given);
  if (code !== 'P2010' && code !== 'P2039') return code;
  const kind = causeOf(err)?.kind;
  return typeof kind === 'string' && Object.hasOwn(ADAPTER_KIND_CODES, kind) ? ADAPTER_KIND_CODES[kind]! : code;
}

/** A node-postgres socket code passed through unwrapped, or null. */
function socketCode(err: unknown, code: string): string | null {
  if (SOCKET_BEFORE_SEND.has(code) || SOCKET_MID_REQUEST.has(code)) return code;
  const own = (err as { code?: unknown } | null)?.code;
  return typeof own === 'string' && (SOCKET_BEFORE_SEND.has(own) || SOCKET_MID_REQUEST.has(own)) ? own : null;
}

export function isTransientDbError(err: unknown, code: string): boolean {
  if (TRANSIENT_DB_CODES.has(code) || TRANSIENT_DB_CODES.has(effectiveCode(err, code))) return true;
  // A deadlock or serialization abort is not bad data either: an import row it
  // hits is retried, not rejected for good.
  if (isDbConflict(err, code)) return true;
  if (socketCode(err, code)) return true;
  // Engine- and driver-level faults arrive as plain Errors with no Prisma code
  // at all — the empty-response one is what a killed or restarted Prisma 6 query
  // engine produced; the connection ones are node-postgres's (Prisma 7).
  const msg = messageOf(err);
  return DIED_MID_REQUEST.test(msg) || NEVER_REACHED.test(msg);
}

/**
 * Of those, the faults that can come AFTER the commit: the connection or the
 * engine died mid-request, or gave up waiting on a statement the database may
 * still have finished. What was written is unknown, so nothing may promise that
 * nothing was saved (item 22). The rest — unreachable, no pool connection, an
 * interactive transaction that closed (and so rolled back) — failed before any
 * write could stand.
 */
export function mayHaveCommitted(err: unknown, code: string): boolean {
  const effective = effectiveCode(err, code);
  if (effective === 'P1017' || effective === 'P1008') return true;
  const socket = socketCode(err, code);
  if (socket) return SOCKET_MID_REQUEST.has(socket);
  return DIED_MID_REQUEST.test(messageOf(err));
}

/**
 * Postgres's words for a refused rule (`violates check constraint "<name>"`,
 * `violates foreign key constraint "<name>"`) and Prisma's for a foreign key
 * ("Foreign key constraint violated on the constraint: `<name>`" in Prisma 7,
 * "…violated: `<name> (index)`" in Prisma 6). JSON writes the quotes escaped.
 */
const NAMED_CONSTRAINT =
  /violates (?:check|foreign key) constraint \\?"([A-Za-z0-9_]+)\\?"|Foreign key constraint violated(?: on the constraint)?: `([A-Za-z0-9_]+)(?: \(index\))?`/g;

/**
 * The constraint a refused write names, from the most certain place that names
 * one: the adapter's own field (Prisma 7, a foreign key), Prisma 6's
 * meta.field_name, Postgres's words in the metadata, then in the message —
 * there the LAST mention, where the error's own words are; the lines of calling
 * code come before them. null when it names none in a form known here.
 */
function constraintNamed(err: object, message: string, meta: string): string | null {
  const index = causeOf(err)?.constraint?.index;
  if (typeof index === 'string' && index !== '') return index;
  const field = (metaOf(err) as { field_name?: unknown } | null)?.field_name;
  if (typeof field === 'string' && field !== '') return field.replace(/ \(index\)$/, '');
  const read = (text: string) => [...text.matchAll(NAMED_CONSTRAINT)].map((m) => (m[1] ?? m[2]) as string);
  return read(meta)[0] ?? read(message).at(-1) ?? null;
}

/**
 * Gap 31: which database rule (lib/db-rules.ts) refused a save, or null when the
 * error is not one of them. A rule added NOT VALID refuses every later save of an
 * older row that breaks it, by any path; without this the person saw a generic
 * failure (a 500) and nobody could tell which rule, or which record, was at fault.
 *
 * Matched by the constraint's NAME, wherever the driver put it: a foreign key as
 * P2003 (meta.field_name "<name> (index)"), a CHECK as P2004 or, from a raw
 * query, P2010 (Postgres's own words in the message or meta), and an engine
 * error Prisma did not map (no code) that quotes `violates check constraint
 * "<name>"` or `violates foreign key constraint "<name>"`. A name is matched
 * whole, so one rule's name inside another's never matches.
 *
 * Prisma 7 (seen on Postgres 17 with 7.10.1 and the driver adapter, 2026-11-10):
 *   - a CHECK refused on a MODEL write is P2039 — the code Prisma 7 gives a
 *     database error it has none for — where Prisma 6 gave an error with no code
 *     at all. Its message and meta.driverAdapterError.cause quote Postgres's
 *     words and the SQLSTATE 23514. Without P2039 here every such save was a 500
 *     again instead of the rule's own words;
 *   - a CHECK from a raw query is still P2010, the SQLSTATE now in
 *     cause.originalCode (sqlStateOf), the words unchanged;
 *   - a foreign key is still P2003 from a model write and P2010 from a raw one,
 *     the name in the message and in cause.constraint.index.
 * The adapter's cause also carries Postgres's DETAIL ("Failing row contains
 * (…)"), the row's own values: it is read here for the rule's name only, and
 * nothing of it is returned.
 *
 * The constraint the DATABASE named decides (constraintNamed), before any other
 * mention of a rule's name. Outside production Prisma quotes the lines of code
 * around the failing call in its message, and a rule's name written on one of
 * those lines was taken for the rule refused: the gated suite on Postgres
 * (tests/integration/db-rules.test.ts, first run 2026-11-10) was answered with
 * another rule's words for a save Branch_createdById_fkey refused. Production's
 * messages carry no such lines, so nothing changes there.
 */
export function dbRuleViolated(err: unknown): DbRule | null {
  if (!err || typeof err !== 'object') return null;
  // A bare adapter error (a rule refused at COMMIT) is read as the code its kind has on a statement.
  const code = dbErrorCode(err) ?? (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? '');
  let meta = '';
  try {
    meta = JSON.stringify((err as { meta?: unknown }).meta ?? '');
  } catch {
    meta = '';
  }
  const text = `${message} ${meta}`;
  const constraintError =
    code === 'P2003' ||
    code === 'P2004' ||
    ((code === 'P2010' || code === 'P2039') && /23514|23503|check constraint|foreign key constraint/i.test(text)) ||
    ((code === undefined || code === null || code === '') && /violates (check|foreign key) constraint/i.test(text));
  if (!constraintError) return null;
  // The constraint the database named: one of the rules, or not.
  const named = constraintNamed(err, message, meta);
  if (named !== null) return DB_RULE_BY_NAME.get(named) ?? null;
  // A shape that names its constraint in no form known here: the rule's name
  // anywhere in the error, whole, as before.
  for (const [name, rule] of DB_RULE_BY_NAME) {
    if (new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(text)) return rule;
  }
  return null;
}

/**
 * Owner decision 2026-10-25 (migration 20261025120000_temix_code_unique): one live
 * customer per Temix code, compared upper case with the ends trimmed. A partial
 * index on an expression, so Prisma cannot describe it (schema.prisma) and CI's
 * drift gate allows it by name.
 */
export const TEMIX_CODE_UNIQUE_INDEX = 'Customer_temixCode_live_unique';

/** The index's key, with the quotes taken out, as Postgres and Prisma quote it. */
const TEMIX_CODE_INDEX_KEY = /upper\(btrim\(temixCode(::text)?\)\)/i;

/**
 * Whether a refused save broke TEMIX_CODE_UNIQUE_INDEX, the way dbRuleViolated
 * reads a rule: wherever the driver put it. Postgres does not name the index in
 * the detail of a unique violation, only its key, so the key counts too (seen on
 * Postgres 17 with Prisma 6.19, 2026-10-25):
 *   - a model write: P2002, meta.target ["upper(btrim(temixCode))"];
 *   - a raw write: P2010, meta.code "23505", the message `Key
 *     (upper(btrim("temixCode")))=(…) already exists.`;
 *   - an engine error Prisma did not map (no code) that quotes `duplicate key
 *     value violates unique constraint "Customer_temixCode_live_unique"`.
 * Prisma 7 with the driver adapter names the index instead of its key (seen on
 * Postgres 17 with 7.10.1, 2026-11-10): a model write is P2002 and a raw write
 * P2010, both with meta.driverAdapterError.cause.constraint.index
 * "Customer_temixCode_live_unique" and Postgres's `duplicate key value violates
 * unique constraint "…"` in cause.originalMessage; a unique violation is never
 * P2039 (the adapter maps 23505 itself). When the adapter names the index, that
 * name alone decides: the message may quote lines of calling code outside
 * production (see dbRuleViolated), and those are not the database's words.
 * The index's name is matched whole; any other unique violation is not this one.
 */
export function temixCodeIndexViolated(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = dbErrorCode(err) ?? (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? '');
  let meta = '';
  try {
    meta = JSON.stringify((err as { meta?: unknown }).meta ?? '');
  } catch {
    meta = '';
  }
  const text = `${message} ${meta}`;
  const uniqueError =
    code === 'P2002' ||
    (code === 'P2010' && /23505|duplicate key value|already exists/i.test(text)) ||
    ((code === undefined || code === null || code === '') && /duplicate key value violates unique constraint/i.test(text));
  if (!uniqueError) return false;
  const index = causeOf(err)?.constraint?.index;
  if (typeof index === 'string' && index !== '') return index === TEMIX_CODE_UNIQUE_INDEX;
  if (new RegExp(`(^|[^A-Za-z0-9_])${TEMIX_CODE_UNIQUE_INDEX}([^A-Za-z0-9_]|$)`).test(text)) return true;
  return TEMIX_CODE_INDEX_KEY.test(text.replace(/\\?"/g, ''));
}
