/**
 * The daily Temix import, stage 6: what FINALIZE lists for the Data Steward
 * once every row of a file is done (the merged plan, finalize and alerts).
 * A PURE PLAN: no database. lib/temix-daily-notices.ts reads its input and
 * writes what it returns, as notice rows of the ledger (TemixChange,
 * applied = false) and "listed once" marks (TemixNoticeSeen). Nothing here
 * changes a customer, a shop or a route, and nothing here is sent to anyone.
 *
 * OPEN SPELLS. An absence is written ONCE, when it starts, and once more when
 * it ends, never every day it lasts. The ledger is INSERT-only, so a spell is
 * two rows of one kind, told apart by detailCode:
 *    SPELL_OPENED               the absence starts (this file);
 *    SPELL_CLOSED_SEEN          the customer or code is in this file again;
 *    SPELL_CLOSED_NOT_EXPECTED  it is no longer expected (archived, merged,
 *                               made a test customer, or its code changed);
 *    SPELL_CLOSED_CLEARED       (routes) switched on again, or holds no shop.
 * A spell is open while the newest row of its kind and key is SPELL_OPENED.
 * The kinds:
 *  - MISSING_FROM_FILE (key: the customer): a live, non-test customer that no
 *    row of the file names by either code, the same rule the Check counts
 *    (customersNotNamed in lib/temix-daily-check.ts). Whether the daily file is
 *    the full list is the owner's question: until he answers, a spell is a
 *    line to look at, never an action, and nobody but the Steward sees it.
 *  - ACCOUNTANT_CODE_NOT_SEEN (key: the customer and the code): a customer
 *    made in the CRM (an NMWC-YYYY-NNNNNN code) carrying the Temix code the
 *    Accountant typed at its final approval, and no row of the file has that
 *    code as its customer code. Such a customer is usually also missing; both
 *    are listed, each under its own rule (whether to list it once is the
 *    owner's question). When the code appears the spell is closed. The Temix
 *    queue state (UPLOADED to SYNCED) and the salesman's TEMIX_SYNC_ACKED are
 *    NOT written here: no customer is changed and no one is told.
 *  - ROUTE_INACTIVE (key: the route): a CRM route that is switched off and
 *    still holds live shops, whoever put them there.
 *
 * NAMES LISTED ONCE (NAME_DIFFERS). For a row whose customer the apply found,
 * the file's cust_name and the CRM's legal name are compared after the same
 * folding (fold below: NFKC, invisible characters out, spaces collapsed,
 * capitals). A difference is listed once per customer and per Temix value:
 * the value is kept only as a keyed hash (TemixNoticeSeen.valueHash, HMAC-SHA256
 * under a key derived from AUTH_SECRET), so a short common name cannot be
 * guessed back from the table. Rotating AUTH_SECRET lists each difference once
 * more. Without a key the names are not compared at all (namesChecked false).
 * Nothing is changed: the CRM keeps its name (the CRM is master for names).
 *
 * The ledger keeps codes and ids only: a notice names its customer (id), its
 * row (id) and, for a code or a route, the code or the route id. Never a name.
 *
 * PURE: node:crypto and pure modules only.
 */
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { APP_CUSTOMER_CODE } from './codes';
import { normalizeTemixCode } from './temix-code';
import { customersNotNamed } from './temix-daily-check';
import { isCellError } from './temix-daily-file';
import type { SummaryCounts } from './temix-daily-summary';

// ── Codes ─────────────────────────────────────────────────────────────────

export const SPELL_OPENED = 'SPELL_OPENED';
export const SPELL_CLOSED_SEEN = 'SPELL_CLOSED_SEEN';
export const SPELL_CLOSED_NOT_EXPECTED = 'SPELL_CLOSED_NOT_EXPECTED';
export const SPELL_CLOSED_CLEARED = 'SPELL_CLOSED_CLEARED';
export const SPELL_CODES = [SPELL_OPENED, SPELL_CLOSED_SEEN, SPELL_CLOSED_NOT_EXPECTED, SPELL_CLOSED_CLEARED] as const;
export type SpellCode = (typeof SPELL_CODES)[number];

/** The ledger kinds that are written as open spells. */
export const SPELL_KINDS = ['MISSING_FROM_FILE', 'ACCOUNTANT_CODE_NOT_SEEN', 'ROUTE_INACTIVE'] as const;
export type SpellKind = (typeof SPELL_KINDS)[number];

/** Every ledger kind finalize writes (all notices: applied = false). */
export const FINALIZE_KINDS = [...SPELL_KINDS, 'NAME_DIFFERS'] as const;
export type FinalizeKind = (typeof FINALIZE_KINDS)[number];

export const SPELL_CODE_LABEL: Record<SpellCode, string> = {
  SPELL_OPENED: 'started',
  SPELL_CLOSED_SEEN: 'ended: in the file again',
  SPELL_CLOSED_NOT_EXPECTED: 'ended: no longer expected (archived, merged, a test customer, or its code changed)',
  SPELL_CLOSED_CLEARED: 'ended: switched on again, or no shop left on it',
};

// ── Inputs ────────────────────────────────────────────────────────────────

/** A customer as finalize reads it: codes and flags, never a name. */
export type FinalizeCustomer = { id: string; nmwcCode: string; temixCode: string | null; live: boolean; isTest: boolean };

/** A row of the file: its code, and the customer the apply found for it (null: none, or two). */
export type FinalizeRow = { id: string; rowNumber: number; custCodeKey: string | null; customerId: string | null };

/** A spell whose newest row is SPELL_OPENED. value: the code (Accountant) or the route id (routes). */
export type OpenSpell = { kind: SpellKind; customerId: string | null; value: string | null };

/** The names compared: the file's name on a found customer's row, and the CRM's. Read here, never stored. */
export type NameInput = {
  key: Buffer | null;
  rows: ReadonlyArray<{ rowId: string; rowNumber: number; customerId: string; name: string | null }>;
  crmNames: ReadonlyMap<string, string>;
  /** `${customerId}|${valueHash}` already listed. */
  seen: ReadonlySet<string>;
};

export type FinalizeInput = {
  rows: readonly FinalizeRow[];
  customers: readonly FinalizeCustomer[];
  open: readonly OpenSpell[];
  /** Switched-off routes that hold live shops now. */
  inactiveRoutes: ReadonlyArray<{ id: string; shops: number }>;
  names: NameInput;
};

/** A notice row to write (the writer adds fileId, loadDay and applied = false). */
export type Notice = {
  kind: FinalizeKind;
  customerId: string | null;
  rowId: string | null;
  field: string | null;
  toValue: string | null;
  detailCode: SpellCode | null;
};

export type FinalizePlan = {
  notices: Notice[];
  /** The "listed once" marks to add with the NAME_DIFFERS notices. */
  seen: Array<{ customerId: string; valueHash: string }>;
  namesChecked: boolean;
};

// ── Names ─────────────────────────────────────────────────────────────────

/** The HKDF label of the name key: a new label is a new key, so change it only with a new version. */
export const NAME_KEY_LABEL = 'nmwc-temix-daily-name-v1';

const nameKeys = new Map<string, Buffer>();

/** The key the name hashes are made with, derived from the app's signing secret; null when there is none. */
export function nameKey(secret: string | undefined = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET): Buffer | null {
  if (!secret) return null;
  const hit = nameKeys.get(secret);
  if (hit) return hit;
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), NAME_KEY_LABEL, 32));
  if (nameKeys.size > 4) nameKeys.clear();
  nameKeys.set(secret, key);
  return key;
}

/** Which key made a hash (first 8 hex of its SHA-256): a rotated secret gives another. */
export function nameKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/** A name as it is compared: NFKC, invisible characters removed, spaces collapsed, trimmed, capitals. */
export function foldName(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFKC')
    .replace(/[­​-‏‪-‮⁠-⁤﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** The keyed hash of a folded name (hex, 64). */
export function nameHash(key: Buffer, folded: string): string {
  return createHmac('sha256', key).update(folded, 'utf8').digest('hex');
}

// ── Who is expected ───────────────────────────────────────────────────────

/** The Temix code the Accountant typed for a customer made in the CRM, normalised; null when it has none or is not expected. */
export function accountantCodeOf(c: FinalizeCustomer): string | null {
  if (!c.live || c.isTest || !c.temixCode || !APP_CUSTOMER_CODE.test(c.nmwcCode)) return null;
  return normalizeTemixCode(c.temixCode) || null;
}

const spellKey = (kind: SpellKind, customerId: string | null, value: string | null) => `${kind}|${customerId ?? ''}|${value ?? ''}`;

// ── The plan ──────────────────────────────────────────────────────────────

/**
 * What finalize writes for one file, given what is open. Idempotent: once its
 * notices are written (and so are the spells they open or close), the same
 * input planned again writes nothing.
 */
export function planFinalize(input: FinalizeInput): FinalizePlan {
  const notices: Notice[] = [];
  const named = new Set(input.rows.map((r) => r.custCodeKey).filter((k): k is string => !!k));
  // The first row (by row number) that names a code: the row a "seen again" notice points at.
  const firstRow = new Map<string, FinalizeRow>();
  for (const r of [...input.rows].sort((a, b) => a.rowNumber - b.rowNumber))
    if (r.custCodeKey && !firstRow.has(r.custCodeKey)) firstRow.set(r.custCodeKey, r);
  const byId = new Map(input.customers.map((c) => [c.id, c]));
  const open = new Map(input.open.map((s) => [spellKey(s.kind, s.customerId, s.value), s]));
  const rowNaming = (c: FinalizeCustomer | undefined): FinalizeRow | null => {
    if (!c) return null;
    for (const code of [c.nmwcCode, c.temixCode]) {
      const k = code ? normalizeTemixCode(code) : '';
      const r = k ? firstRow.get(k) : undefined;
      if (r) return r;
    }
    return null;
  };
  const sortById = <T extends { id: string }>(xs: readonly T[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const openOf = (kind: SpellKind) =>
    input.open
      .filter((s) => s.kind === kind)
      .sort((a, b) => spellKey(a.kind, a.customerId, a.value).localeCompare(spellKey(b.kind, b.customerId, b.value)));

  // Customers missing from the file.
  const missing = customersNotNamed(input.customers, named);
  const missingIds = new Set(missing.map((c) => c.id));
  for (const c of sortById(missing))
    if (!open.has(spellKey('MISSING_FROM_FILE', c.id, null)))
      notices.push({ kind: 'MISSING_FROM_FILE', customerId: c.id, rowId: null, field: null, toValue: null, detailCode: SPELL_OPENED });
  for (const s of openOf('MISSING_FROM_FILE')) {
    if (!s.customerId || missingIds.has(s.customerId)) continue;
    const row = rowNaming(byId.get(s.customerId));
    notices.push({
      kind: 'MISSING_FROM_FILE',
      customerId: s.customerId,
      rowId: row?.id ?? null,
      field: null,
      toValue: null,
      detailCode: row ? SPELL_CLOSED_SEEN : SPELL_CLOSED_NOT_EXPECTED,
    });
  }

  // Temix codes the Accountant typed that the file does not carry.
  for (const c of sortById(input.customers)) {
    const code = accountantCodeOf(c);
    if (code && !named.has(code) && !open.has(spellKey('ACCOUNTANT_CODE_NOT_SEEN', c.id, code)))
      notices.push({ kind: 'ACCOUNTANT_CODE_NOT_SEEN', customerId: c.id, rowId: null, field: 'temixCode', toValue: code, detailCode: SPELL_OPENED });
  }
  for (const s of openOf('ACCOUNTANT_CODE_NOT_SEEN')) {
    const c = s.customerId ? byId.get(s.customerId) : undefined;
    const code = c ? accountantCodeOf(c) : null;
    if (code && code === s.value) {
      if (!named.has(code)) continue; // still not seen: the spell stays open
      notices.push({ ...base(s), rowId: firstRow.get(code)?.id ?? null, detailCode: SPELL_CLOSED_SEEN });
    } else {
      notices.push({ ...base(s), rowId: null, detailCode: SPELL_CLOSED_NOT_EXPECTED });
    }
  }

  // Switched-off routes still holding shops.
  const inactive = new Set(input.inactiveRoutes.filter((r) => r.shops > 0).map((r) => r.id));
  for (const id of [...inactive].sort())
    if (!open.has(spellKey('ROUTE_INACTIVE', null, id)))
      notices.push({ kind: 'ROUTE_INACTIVE', customerId: null, rowId: null, field: 'routeId', toValue: id, detailCode: SPELL_OPENED });
  for (const s of openOf('ROUTE_INACTIVE'))
    if (s.value && !inactive.has(s.value)) notices.push({ ...base(s), rowId: null, detailCode: SPELL_CLOSED_CLEARED });

  // Name differences, each listed once.
  const seen: FinalizePlan['seen'] = [];
  const key = input.names.key;
  if (key) {
    const listed = new Set(input.names.seen);
    for (const r of [...input.names.rows].sort((a, b) => a.rowNumber - b.rowNumber)) {
      // A spreadsheet error in the cell (#N/A and the like) is not a name.
      if (isCellError(r.name)) continue;
      const file = foldName(r.name);
      const crm = input.names.crmNames.get(r.customerId);
      if (!file || crm === undefined || file === foldName(crm)) continue;
      const valueHash = nameHash(key, file);
      const k = `${r.customerId}|${valueHash}`;
      if (listed.has(k)) continue;
      listed.add(k);
      seen.push({ customerId: r.customerId, valueHash });
      notices.push({ kind: 'NAME_DIFFERS', customerId: r.customerId, rowId: r.rowId, field: 'legalName', toValue: null, detailCode: null });
    }
  }
  return { notices, seen, namesChecked: key !== null };
}

function base(s: OpenSpell): Omit<Notice, 'rowId' | 'detailCode'> {
  return {
    kind: s.kind,
    customerId: s.customerId,
    field: s.kind === 'ROUTE_INACTIVE' ? 'routeId' : s.kind === 'ACCOUNTANT_CODE_NOT_SEEN' ? 'temixCode' : null,
    toValue: s.value,
  };
}

/**
 * Which spells are open, from the newest ledger row of each kind and key
 * (newest first is not required: the row with the highest id wins).
 */
export function openSpellsOf(rows: ReadonlyArray<{ id: bigint | number; kind: string; customerId: string | null; toValue: string | null; detailCode: string | null }>): OpenSpell[] {
  const newest = new Map<string, { id: bigint; row: (typeof rows)[number] }>();
  for (const r of rows) {
    if (!(SPELL_KINDS as readonly string[]).includes(r.kind) || !(SPELL_CODES as readonly string[]).includes(r.detailCode ?? '')) continue;
    const kind = r.kind as SpellKind;
    const value = kind === 'MISSING_FROM_FILE' ? null : r.toValue;
    const k = spellKey(kind, r.customerId, value);
    const id = BigInt(r.id);
    const had = newest.get(k);
    if (!had || id > had.id) newest.set(k, { id, row: r });
  }
  return [...newest.values()]
    .filter((x) => x.row.detailCode === SPELL_OPENED)
    .map((x) => ({ kind: x.row.kind as SpellKind, customerId: x.row.customerId, value: x.row.kind === 'MISSING_FROM_FILE' ? null : x.row.toValue }));
}

// ── The summary ───────────────────────────────────────────────────────────

/**
 * The day's summary, counted from the ledger rows of the load day and the
 * held rows of its loaded files: changes applied, spells started and ended,
 * names listed. Kinds and numbers only (lib/temix-daily-summary.ts summaryText
 * turns them into words).
 */
export function summaryCountsOf(
  changes: ReadonlyArray<{ kind: string; applied: boolean; detailCode: string | null; n?: number }>,
  heldRows: number
): SummaryCounts {
  const out: SummaryCounts = {};
  let by = 1;
  const add = (k: keyof SummaryCounts) => {
    out[k] = (out[k] ?? 0) + by;
  };
  for (const c of changes) {
    by = c.n ?? 1;
    if (c.applied) {
      add(c.kind as keyof SummaryCounts);
      continue;
    }
    if ((SPELL_KINDS as readonly string[]).includes(c.kind)) {
      if (c.detailCode === SPELL_OPENED) add(c.kind as SpellKind);
      else if (c.kind === 'MISSING_FROM_FILE') add('MISSING_FROM_FILE_ENDED');
      else if (c.kind === 'ACCOUNTANT_CODE_NOT_SEEN' && c.detailCode === SPELL_CLOSED_SEEN) add('ACCOUNTANT_CODE_SEEN');
      else if (c.kind === 'ROUTE_INACTIVE') add('ROUTE_INACTIVE_ENDED');
      continue;
    }
    add(c.kind as keyof SummaryCounts);
  }
  if (heldRows > 0) out.HELD_ROWS = heldRows;
  return out;
}
