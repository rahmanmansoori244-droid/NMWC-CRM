/**
 * Load the visit days that the Managers filled into the per-region "visit days to fill"
 * workbooks, onto the branches that still have no visit day.
 *
 *   NMWC_PROD_ENV_FILE=<env file> node scripts/dev/prod-run.cjs scripts/ops/visitdays-from-sheets.ts \
 *     --expect-host <host marker> --sheets <folder or .xlsx> [--sheets …] [--out <folder>] [--actor <username>]
 *
 *   then, naming the set the dry run wrote and the hash it printed:
 *     … --expect-host <host marker> --set <set .json> --set-sha <hash> --rehearse [--chunk <n>]
 *     … --expect-host <host marker> --set <set .json> --set-sha <hash> --apply [--chunk <n>]
 *
 *   and only to undo a run:
 *     … --expect-host <host marker> --reverse <runId> [--confirm]
 *
 *   or: npm run ops:visitdays-from-sheets -- <the same arguments>
 *
 * WHY. A branch with no visit day never appears on a salesman's Today list. The live
 * branches that had none were exported for the region's Managers to fill: one workbook per
 * region, one sheet per route, named by the route code. Columns A–I hold the CRM's own
 * values (Route, Branch code, Customer code, Customer name, Branch name, Area, Address,
 * Cash/Credit, Status) and are locked; J is the visit day, a drop-down of the seven day
 * codes; K is free notes. This loads what comes back. The Steward's /import is no
 * substitute: a re-import leaves the existing branches of an ERP-linked customer unchanged
 * unless each row is fixed by hand, and any branch it does write sends its customer back
 * to the Temix queue.
 *
 * WHAT IT WRITES, per branch: dayOfVisit, version + 1, lastEditedById (the Steward the run
 * is attributed to) and updatedAt; one AuditLog UPDATE row with the day before (none), the
 * day after and where it came from (file, sheet, row); the customer's updatedAt, which the
 * master export's "updated since" filter reads; and the customer's completeness scores,
 * which count the visit day. Nothing is queued for Temix: the visit day is not sent to the
 * ERP.
 *
 * FILL ONLY, AND TIMID. Writing the wrong day sends a salesman to the wrong shop on the
 * wrong morning, so the failure direction is "leave it alone". A row is loaded only when
 * ALL of these hold:
 *   - J is one of SAT SUN MON TUE WED THU FRI (case and spaces aside);
 *   - K is empty. A note is for a person to read, not for this script to guess at: the
 *     sheet tells the Manager to write "closed" or "not on this route" there;
 *   - column A is the sheet's own route, and the branch is on that route now;
 *   - B is a live branch of a live customer, and that customer is the one C names;
 *   - the branch is ACTIVE and still has no visit day. A day set in the app since the
 *     sheets were made is never overwritten;
 *   - every other row that names the same branch passes all of the above and gives the
 *     same day. One row that disagrees in any way — another day, a note, a blank, another
 *     route — holds the branch back, and every row naming it goes to a person.
 * The route sheet of one route in two workbooks means two versions of a region's sheets:
 * the run refuses, so one version is read at a time.
 * Rows that need a person — a note, a day that is not one of the seven codes, a branch that
 * moved, closed, belongs to another customer or already has another day, rows that
 * disagree — are listed in the private review workbook, with the reason. Blank rows, and
 * rows whose branch already has that very day, are only counted.
 *
 * THE RUN ORDER, and why each step exists:
 *   1. Dry run (--sheets). Reads the sheets and the database (read-only) and writes two
 *      private files into --out (default golive-data/visitdays/from-sheets/): the SET,
 *      every branch it would write with its day, and the REVIEW workbook. It prints counts
 *      only, and the set's SHA-256.
 *   2. An independent check: a second person or agent re-derives the set from the same
 *      sheets and compares it.
 *   3. --rehearse: every write of --apply, inside transactions that are rolled back. Time
 *      it: --apply takes about as long.
 *   4. --apply, with --set and --set-sha naming the reviewed set. Each transaction takes
 *      up to --chunk branches (default 200) and their customers' locks, reads each branch
 *      again and writes it, in one guarded statement, only if nothing about it has changed
 *      since the dry run (same customer, route and version, still live and ACTIVE, still no
 *      day); the rest are counted as changed since the review, and a new dry run picks them
 *      up. It then checks that every written day landed with exactly one audit row.
 *   Run npm run smoke before and after.
 *
 * TARGETS ANY DATABASE, NAMED. The guards are those of requeue-untracked.ts: --expect-host
 * is required for every mode, and the dry run resolves the audit actor, so it meets every
 * refusal --apply would. Through scripts/dev/prod-run.cjs the connection string never
 * reaches the terminal.
 *
 * LEDGER. AuditLog entityType 'VisitDaysFromSheets', entityId = the run id: a STARTING row
 * before the first write and a COMPLETED row after the last, counts only. Every branch row
 * carries the run id, so a run that dies halfway is still reversible; the run id is printed
 * as soon as the STARTING row is written.
 *
 * REVERSIBLE: --reverse <runId> sets the day back to none on every branch the run wrote
 * that has not changed since (same day, same version, same customer). It is a dry run
 * unless --confirm. This is the one way a visit day is cleared rather than changed: an
 * operator's undo of this script's own writes.
 *
 * COUNTS ONLY on stdout. The set and review files hold codes and the Managers' notes, and
 * belong with the rest of golive-data/: private, never committed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Prisma, PrismaClient, type DayOfWeek } from '@prisma/client';
import { duplicateHeadingIssue, loadExcelJS, parseWorkbook, type ParsedSheet } from '../../lib/excel';
import { lockCustomersAndTemixCodeHolders } from '../../lib/locks';
import { rescoreCustomerTx } from '../../lib/rescore';
import { connectWaking, requireExpectedHost, resolveActor } from './requeue-untracked';
import { OperatorRefusal, operatorErrorLabel } from './error-label';

/** The instructions sheet every workbook starts with. */
export const HELP_SHEET = 'How to fill';
/** The headings this script reads, as the sheets were built. Matched without case. */
export const COLUMNS = {
  route: 'Route',
  branch: 'Branch code',
  customer: 'Customer code',
  day: 'Visit day',
  notes: 'Notes',
} as const;
export const DAY_CODES = ['SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI'] as const;
export const LEDGER_ENTITY = 'VisitDaysFromSheets';
const SET_KIND = 'visitdays-from-sheets';
export const DEFAULT_OUT = path.join('golive-data', 'visitdays', 'from-sheets');
/** Branches per transaction. Each transaction is a fixed handful of statements. */
export const DEFAULT_CHUNK = 200;
const MAX_CHUNK = 1000;
const BRANCH_REASON =
  'operator script scripts/ops/visitdays-from-sheets.ts: the visit day a Manager entered on ' +
  "the region's visit-day sheet, for a branch that had none (fill only). Run outside any " +
  'session, so ip and userAgent are null by construction.';

export type SheetRow = {
  file: string;
  sheet: string;
  /** The Excel row number. */
  row: number;
  /** Column A, upper case. */
  route: string;
  branchCode: string;
  /** Column C, upper case. */
  customerCode: string;
  /** Column J as entered, trimmed. */
  day: string;
  /** Column K, trimmed. */
  note: string;
};
export type SheetProblem = { file: string; sheet: string; why: string };
export type CrmBranch = {
  id: string;
  branchCode: string;
  customerId: string;
  customerCode: string;
  routeId: string;
  routeCode: string;
  status: string;
  dayOfVisit: string | null;
  version: number;
};
export type SetItem = {
  branchId: string;
  customerId: string;
  routeId: string;
  /** The branch's version when the dry run read it: --apply writes only that version. */
  version: number;
  day: DayOfWeek;
  branchCode: string;
  file: string;
  sheet: string;
  row: number;
};
export type ReviewRow = SheetRow & { why: string };
export type Plan = { items: SetItem[]; review: ReviewRow[]; counts: Record<string, number> };
export type Mode = 'dry' | 'rehearse' | 'apply' | 'reverse';
export type Options = {
  mode: Mode;
  sheets: string[];
  out: string;
  setFile: string;
  setSha: string;
  actor: string;
  runId: string;
  confirm: boolean;
  chunk: number;
};

export const REASONS = {
  blank: 'left blank',
  note: 'has a note: for a person, not loaded',
  noteOnly: 'a note and no day: for a person',
  badDay: 'the visit day is not one of SAT SUN MON TUE WED THU FRI',
  sheetRoute: "column A is not this sheet's route",
  noBranch: 'no live branch has this branch code',
  otherCustomer: 'the branch belongs to another customer',
  moved: 'the branch is on another route now',
  inactive: 'the branch is not ACTIVE',
  sameDay: 'already has this day',
  otherDay: 'the branch has another day already (set since the sheet was made)',
  conflict: 'this branch is on more than one row, and they do not all give the same day without a note',
  repeat: 'repeated rows with the same day (loaded once)',
} as const;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).trim();
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** A path as the operator should paste it: forward slashes, quoted. */
const shown = (p: string) => JSON.stringify(p.split(path.sep).join('/'));

/** One of the seven day codes, whatever the case and spacing, or null. */
export function dayCode(raw: string): DayOfWeek | null {
  const s = raw.trim().toUpperCase();
  return (DAY_CODES as readonly string[]).includes(s) ? (s as DayOfWeek) : null;
}

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/**
 * Every row of every route sheet, and the sheets that cannot be read as one. lib/excel.ts
 * reads each heading from its own column, so a moved column is still read right; a sheet
 * missing a heading, or with a heading in two columns, is not read at all. A route sheet
 * found in two workbooks refuses the run: it means two versions of one region's sheets.
 */
export function readSheets(books: Array<{ file: string; sheets: ParsedSheet[] }>): {
  rows: SheetRow[];
  problems: SheetProblem[];
} {
  const rows: SheetRow[] = [];
  const problems: SheetProblem[] = [];
  const seen = new Map<string, string>();
  for (const { file, sheets } of books) {
    for (const s of sheets) {
      const name = s.name.trim();
      if (name.toLowerCase() === HELP_SHEET.toLowerCase()) continue;
      const first = seen.get(name.toUpperCase());
      if (first !== undefined && first !== file) {
        throw new OperatorRefusal(
          `the route sheet ${name} is in two workbooks, ${first} and ${file}: two versions of one ` +
            "region's sheets? Pass one version at a time. Nothing has been read from the database."
        );
      }
      seen.set(name.toUpperCase(), file);
      if (duplicateHeadingIssue(s)) {
        problems.push({ file, sheet: name, why: 'a heading is in more than one column' });
        continue;
      }
      const heading = (want: string) => s.headers.find((h) => h.toLowerCase() === want.toLowerCase());
      const missing = Object.values(COLUMNS).filter((h) => !heading(h));
      if (missing.length > 0) {
        problems.push({ file, sheet: name, why: `missing heading(s): ${missing.join(', ')}` });
        continue;
      }
      const k = {
        route: heading(COLUMNS.route)!,
        branch: heading(COLUMNS.branch)!,
        customer: heading(COLUMNS.customer)!,
        day: heading(COLUMNS.day)!,
        notes: heading(COLUMNS.notes)!,
      };
      s.rows.forEach((r, i) => {
        rows.push({
          file,
          sheet: name,
          row: s.rowNumbers[i]!,
          route: text(r[k.route]).toUpperCase(),
          branchCode: text(r[k.branch]),
          customerCode: text(r[k.customer]).toUpperCase(),
          day: text(r[k.day]),
          note: text(r[k.notes]),
        });
      });
    }
  }
  return { rows, problems };
}

type Judged =
  | { r: SheetRow; kind: 'blank' }
  | { r: SheetRow; kind: 'same' }
  | { r: SheetRow; kind: 'person'; why: string }
  | { r: SheetRow; kind: 'load'; b: CrmBranch; day: DayOfWeek };

/** One row on its own: what it would do if no other row named its branch. */
function judge(r: SheetRow, byCode: Map<string, CrmBranch>): Judged {
  if (!r.day && !r.note) return { r, kind: 'blank' };
  if (r.note) return { r, kind: 'person', why: r.day ? REASONS.note : REASONS.noteOnly };
  const day = dayCode(r.day);
  if (!day) return { r, kind: 'person', why: REASONS.badDay };
  if (r.route !== r.sheet.toUpperCase()) return { r, kind: 'person', why: REASONS.sheetRoute };
  const b = byCode.get(r.branchCode.toUpperCase());
  if (!b) return { r, kind: 'person', why: REASONS.noBranch };
  if (b.customerCode.toUpperCase() !== r.customerCode) return { r, kind: 'person', why: REASONS.otherCustomer };
  if (b.routeCode.toUpperCase() !== r.route) return { r, kind: 'person', why: REASONS.moved };
  if (b.status !== 'ACTIVE') return { r, kind: 'person', why: REASONS.inactive };
  if (b.dayOfVisit) return b.dayOfVisit === day ? { r, kind: 'same' } : { r, kind: 'person', why: REASONS.otherDay };
  return { r, kind: 'load', b, day };
}

/**
 * What to write, and why each other row is left alone. `branches` are the live branches of
 * live customers whose codes the sheets name, as the database holds them now. Rows are
 * grouped by branch code first: a branch loads only when every row naming it would load,
 * with the same day.
 */
export function planVisitDays(rows: SheetRow[], branches: CrmBranch[]): Plan {
  const byCode = new Map(branches.map((b) => [b.branchCode.toUpperCase(), b]));
  const counts: Record<string, number> = {};
  const count = (why: string, n = 1) => {
    counts[why] = (counts[why] ?? 0) + n;
  };
  const review: ReviewRow[] = [];
  const toPerson = (r: SheetRow, why: string) => {
    count(why);
    review.push({ ...r, why });
  };
  const groups = new Map<string, Judged[]>();
  for (const r of rows) {
    const key = r.branchCode.toUpperCase();
    const list = groups.get(key) ?? [];
    list.push(judge(r, byCode));
    groups.set(key, list);
  }
  const items: SetItem[] = [];
  for (const group of groups.values()) {
    const loads = group.filter((j): j is Extract<Judged, { kind: 'load' }> => j.kind === 'load');
    if (loads.length === 0) {
      // Nothing here would be written: each row stands on its own.
      for (const j of group) {
        if (j.kind === 'blank') count(REASONS.blank);
        else if (j.kind === 'same') count(REASONS.sameDay);
        else if (j.kind === 'person') toPerson(j.r, j.why);
      }
      continue;
    }
    if (loads.length !== group.length || new Set(loads.map((j) => j.day)).size > 1) {
      for (const j of group) toPerson(j.r, REASONS.conflict);
      continue;
    }
    if (group.length > 1) count(REASONS.repeat, group.length - 1);
    const { r, b, day } = loads[0]!;
    items.push({
      branchId: b.id,
      customerId: b.customerId,
      routeId: b.routeId,
      version: b.version,
      day,
      branchCode: b.branchCode,
      file: r.file,
      sheet: r.sheet,
      row: r.row,
    });
  }
  items.sort((a, b) => byCodeUnits(a.branchId, b.branchId));
  return { items, review, counts };
}

/** The set file: what was read, and every branch to write. Its SHA-256 pins --apply to it. */
export function setFileBody(
  items: SetItem[],
  files: Array<{ file: string; sha256: string }>,
  builtAt: string
): string {
  return JSON.stringify({ kind: SET_KIND, builtAt, files, items }, null, 1) + '\n';
}

/** Read a set file back, refusing anything that is not one or does not match its hash. */
export function loadSet(raw: string, setSha: string): { items: SetItem[]; files: string[]; sha: string } {
  const sha = sha256(raw);
  if (!/^[0-9a-f]{12,64}$/i.test(setSha) || !sha.startsWith(setSha.toLowerCase())) {
    throw new OperatorRefusal(
      '--set-sha does not match that set file: it changed after the dry run, or it is not the ' +
        'set that was reviewed. Nothing has been written.'
    );
  }
  let parsed: { kind?: unknown; items?: unknown; files?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new OperatorRefusal('that set file is not JSON. Nothing has been written.');
  }
  const ok = (i: unknown): i is SetItem => {
    const x = i as Partial<SetItem>;
    return (
      typeof x === 'object' &&
      x !== null &&
      typeof x.branchId === 'string' &&
      typeof x.customerId === 'string' &&
      typeof x.routeId === 'string' &&
      Number.isInteger(x.version) &&
      typeof x.day === 'string' &&
      (DAY_CODES as readonly string[]).includes(x.day)
    );
  };
  if (parsed.kind !== SET_KIND || !Array.isArray(parsed.items) || !parsed.items.every(ok)) {
    throw new OperatorRefusal('that file is not a visit-day set written by this script. Nothing has been written.');
  }
  const ids = new Set(parsed.items.map((i) => i.branchId));
  if (ids.size !== parsed.items.length) {
    throw new OperatorRefusal('that set names a branch twice. Nothing has been written.');
  }
  const files = Array.isArray(parsed.files)
    ? parsed.files.map((f) => text((f as { file?: unknown }).file)).filter(Boolean)
    : [];
  return { items: parsed.items, files, sha };
}

/** The headings of the review workbook. */
export const REVIEW_HEADINGS = ['File', 'Sheet', 'Row', 'Route', 'Branch code', 'Customer code', 'Visit day', 'Notes', 'Why'];

/**
 * The review, as a workbook rather than text: every cell is a plain string or number, so
 * a note that starts with = or a quote is shown as written and never runs as a formula.
 */
export async function reviewWorkbook(review: ReviewRow[], problems: SheetProblem[]): Promise<Uint8Array> {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Review');
  ws.addRow(REVIEW_HEADINGS);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const p of problems) ws.addRow([p.file, p.sheet, '', '', '', '', '', '', `sheet not read: ${p.why}`]);
  for (const r of review) ws.addRow([r.file, r.sheet, r.row, r.route, r.branchCode, r.customerCode, r.day, r.note, r.why]);
  ws.columns.forEach((c, i) => {
    c.width = [30, 12, 6, 10, 18, 16, 10, 40, 60][i] ?? 14;
  });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** The workbooks to read: each file named, and every .xlsx in each folder named. */
export function listWorkbooks(paths: string[]): string[] {
  const out = new Map<string, string>();
  for (const p of paths) {
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      throw new OperatorRefusal(`--sheets: nothing at ${p}`);
    }
    const files = isDir
      ? readdirSync(p)
          .filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'))
          .sort(byCodeUnits)
          .map((f) => path.join(p, f))
      : [p];
    for (const f of files) out.set(path.resolve(f), f);
  }
  if (out.size === 0) throw new OperatorRefusal('--sheets: no .xlsx workbook found');
  const names = [...out.values()].map((f) => path.basename(f));
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) {
    throw new OperatorRefusal(`two workbooks are named ${twice}: the set and the review name each by its file name`);
  }
  return [...out.values()];
}

/**
 * Transactions for a set: at most `size` branches each. A customer's branches stay
 * together when they fit; a customer with more than `size` is split, and each part
 * takes that customer's lock again.
 */
export function chunksOf(items: SetItem[], size: number): SetItem[][] {
  const byCustomer = new Map<string, SetItem[]>();
  for (const it of [...items].sort((a, b) => byCodeUnits(a.customerId, b.customerId) || byCodeUnits(a.branchId, b.branchId))) {
    const list = byCustomer.get(it.customerId) ?? [];
    list.push(it);
    byCustomer.set(it.customerId, list);
  }
  const chunks: SetItem[][] = [];
  let current: SetItem[] = [];
  for (const list of byCustomer.values()) {
    for (let i = 0; i < list.length; i += size) {
      const part = list.slice(i, i + size);
      if (current.length > 0 && current.length + part.length > size) {
        chunks.push(current);
        current = [];
      }
      current.push(...part);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const VALUE_FLAGS = ['--expect-host', '--sheets', '--out', '--set', '--set-sha', '--actor', '--reverse', '--chunk'];
const SWITCHES = ['--rehearse', '--apply', '--confirm'];

/** The arguments, refused when they do not make one clear run. */
export function parseArgs(args: string[]): Options {
  // A mistyped flag must stop the run, not be skipped: `--aply` would otherwise run a dry
  // run that looks like success, and a stray value would be read as nothing at all.
  for (let i = 0; i < args.length; i += 1) {
    if (VALUE_FLAGS.includes(args[i]!)) i += 1;
    else if (!SWITCHES.includes(args[i]!)) throw new OperatorRefusal(`unknown argument: ${args[i]}`);
  }
  const valueAfter = (flag: string): string[] => {
    const out: string[] = [];
    args.forEach((a, i) => {
      if (a !== flag) return;
      const v = args[i + 1] ?? '';
      if (!v || v.startsWith('--')) throw new OperatorRefusal(`${flag} was passed without a value`);
      out.push(v);
    });
    return out;
  };
  const one = (flag: string): string => {
    const v = valueAfter(flag);
    if (v.length > 1) throw new OperatorRefusal(`${flag} was passed more than once`);
    return v[0] ?? '';
  };
  const modes = (['--rehearse', '--apply', '--reverse'] as const).filter((m) => args.includes(m));
  if (modes.length > 1) throw new OperatorRefusal('pass at most one of --rehearse, --apply and --reverse');
  const mode: Mode = modes[0] ? (modes[0].slice(2) as Mode) : 'dry';
  const chunkArg = one('--chunk');
  const chunk = chunkArg ? Number(chunkArg) : DEFAULT_CHUNK;
  if (!Number.isInteger(chunk) || chunk < 1 || chunk > MAX_CHUNK) {
    throw new OperatorRefusal(`--chunk takes a whole number of branches from 1 to ${MAX_CHUNK}`);
  }
  const opts: Options = {
    mode,
    sheets: valueAfter('--sheets'),
    out: one('--out') || DEFAULT_OUT,
    setFile: one('--set'),
    setSha: one('--set-sha'),
    actor: one('--actor'),
    runId: mode === 'reverse' ? one('--reverse') : '',
    confirm: args.includes('--confirm'),
    chunk,
  };
  if (mode === 'dry' && opts.sheets.length === 0) {
    throw new OperatorRefusal('the dry run needs --sheets <folder or .xlsx> (pass it more than once for several)');
  }
  if (mode !== 'dry' && opts.sheets.length > 0) {
    throw new OperatorRefusal(
      `--${mode} does not read the sheets: it ${mode === 'reverse' ? "reads the run's own audit rows" : 'loads the set the dry run wrote and you reviewed'}. Drop --sheets.`
    );
  }
  if ((mode === 'rehearse' || mode === 'apply') && (!opts.setFile || !opts.setSha)) {
    throw new OperatorRefusal(
      `--${mode} needs --set <the set file the dry run wrote> and --set-sha <the hash it printed>`
    );
  }
  if (opts.confirm && mode !== 'reverse') throw new OperatorRefusal('--confirm belongs to --reverse');
  return opts;
}

async function liveBranches(
  db: PrismaClient | Prisma.TransactionClient,
  codes: string[]
): Promise<CrmBranch[]> {
  // Each code as written and in upper case: a code typed in another case still finds its
  // branch, and is then grouped with the branch's own row.
  const unique = [...new Set(codes.filter(Boolean).flatMap((c) => [c, c.toUpperCase()]))];
  const out: CrmBranch[] = [];
  for (let i = 0; i < unique.length; i += 1000) {
    const rows = await db.branch.findMany({
      where: { branchCode: { in: unique.slice(i, i + 1000) }, deletedAt: null, customer: { deletedAt: null } },
      select: {
        id: true,
        branchCode: true,
        customerId: true,
        routeId: true,
        status: true,
        dayOfVisit: true,
        version: true,
        route: { select: { code: true } },
        customer: { select: { nmwcCode: true } },
      },
    });
    for (const b of rows) {
      out.push({
        id: b.id,
        branchCode: b.branchCode,
        customerId: b.customerId,
        customerCode: b.customer.nmwcCode,
        routeId: b.routeId,
        routeCode: b.route.code,
        status: b.status,
        dayOfVisit: b.dayOfVisit,
        version: b.version,
      });
    }
  }
  return out;
}

const printCounts = (counts: Record<string, number>, log: (l: string) => void) => {
  for (const [why, n] of Object.entries(counts).sort((a, b) => b[1] - a[1] || byCodeUnits(a[0], b[0]))) {
    log(`  ${String(n).padStart(6)}  ${why}`);
  }
};
const dayTally = (items: Array<{ day: string }>) =>
  DAY_CODES.map((d) => `${d}=${items.filter((i) => i.day === d).length}`).join(' ');

async function dryRun(opts: Options, prisma: PrismaClient, log: (l: string) => void): Promise<number> {
  const files = listWorkbooks(opts.sheets);
  const books: Array<{ file: string; sheets: ParsedSheet[]; sha256: string }> = [];
  for (const f of files) {
    const bytes = readFileSync(f);
    books.push({ file: path.basename(f), sheets: await parseWorkbook(bytes), sha256: sha256(bytes) });
  }
  const { rows, problems } = readSheets(books);
  const branches = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return liveBranches(tx, rows.map((r) => r.branchCode));
    },
    { timeout: 120_000 }
  );
  const plan = planVisitDays(rows, branches);
  const routeSheets = books.reduce(
    (n, b) => n + b.sheets.filter((s) => s.name.trim().toLowerCase() !== HELP_SHEET.toLowerCase()).length,
    0
  );
  log(`Workbooks read:   ${books.length}`);
  log(`Route sheets:     ${routeSheets} (not read: ${problems.length}, listed in the review workbook)`);
  log(`Rows on them:     ${rows.length}`);
  printCounts(plan.counts, log);
  log(`TO WRITE:         ${plan.items.length} branch(es)${plan.items.length ? `  (${dayTally(plan.items)})` : ''}`);

  // Resolved before anything is written, so the dry run meets the refusal --apply would
  // (requeue-untracked.ts explains why).
  const actor = await resolveActor(prisma, opts.actor);
  log(`Audit actor:      ${actor.username}${opts.actor ? ' (--actor)' : ' (the one active Steward)'}`);

  const at = new Date();
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  mkdirSync(opts.out, { recursive: true });
  const reviewFile = path.join(opts.out, `visitdays-from-sheets-${stamp}-review.xlsx`);
  writeFileSync(reviewFile, await reviewWorkbook(plan.review, problems));
  log(`Review workbook:  ${shown(reviewFile)} (${plan.review.length + problems.length} line(s) for a person)`);
  if (plan.items.length === 0) {
    log('='.repeat(76));
    log('Nothing to load: no row passes every check. No set file was written.\n');
    return 0;
  }
  const setFile = path.join(opts.out, `visitdays-from-sheets-${stamp}.json`);
  const body = setFileBody(
    plan.items,
    books.map((b) => ({ file: b.file, sha256: b.sha256 })),
    at.toISOString()
  );
  writeFileSync(setFile, body);
  const sha = sha256(body).slice(0, 16);
  log(`Set file:         ${shown(setFile)}`);
  log(`Set SHA-256:      ${sha}`);
  log('='.repeat(76));
  log('DRY RUN — nothing was written to the database. Next, in order:');
  log('  1. have the set checked independently against the same sheets;');
  log(`  2. --set ${shown(setFile)} --set-sha ${sha} --rehearse`);
  log('  3. the same with --apply, between two runs of npm run smoke.\n');
  return 0;
}

class Rollback extends Error {
  constructor(readonly tally: { done: SetItem[]; changed: number }) {
    super('rehearsal: rolled back');
  }
}

/**
 * The guarded write of one chunk, in one statement: each branch is written only if it is
 * still exactly as the dry run read it. Returns the ids actually written.
 */
async function writeDays(tx: Prisma.TransactionClient, items: SetItem[], actorId: string): Promise<Set<string>> {
  if (items.length === 0) return new Set();
  const values = Prisma.join(
    items.map(
      (it) =>
        Prisma.sql`(${it.branchId}::text, ${it.version}::int, ${it.customerId}::text, ${it.routeId}::text, ${it.day}::"DayOfWeek")`
    )
  );
  const written = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "Branch" AS b
       SET "dayOfVisit" = v.day, "version" = b."version" + 1, "lastEditedById" = ${actorId}::text
      FROM (VALUES ${values}) AS v(id, version, "customerId", "routeId", day)
     WHERE b."id" = v.id AND b."version" = v.version AND b."customerId" = v."customerId"
       AND b."routeId" = v."routeId" AND b."deletedAt" IS NULL AND b."status" = 'ACTIVE'
       AND b."dayOfVisit" IS NULL
    RETURNING b."id"`;
  return new Set(written.map((w) => w.id));
}

async function writeSet(
  opts: Options,
  prisma: PrismaClient,
  host: string,
  log: (l: string) => void
): Promise<number> {
  let raw: string;
  try {
    raw = readFileSync(opts.setFile, 'utf8');
  } catch {
    throw new OperatorRefusal(`--set: cannot read ${opts.setFile}. Nothing has been written.`);
  }
  const { items, files, sha } = loadSet(raw, opts.setSha);
  const apply = opts.mode === 'apply';
  log(`Set:              ${items.length} branch(es) from ${files.length} workbook(s)  (${dayTally(items)})`);
  const actor = await resolveActor(prisma, opts.actor);
  log(`Audit actor:      ${actor.username}${opts.actor ? ' (--actor)' : ' (the one active Steward)'}`);
  if (items.length === 0) {
    log('\nNothing to do: the set is empty.\n');
    return 0;
  }
  const at = new Date();
  const runId = `visitdays-from-sheets-${at.toISOString()}`;
  if (apply) {
    // The claim row first, so a run that dies halfway is still in the ledger.
    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'UPDATE',
        entityType: LEDGER_ENTITY,
        entityId: runId,
        reason:
          `operator script scripts/ops/visitdays-from-sheets.ts on ${host}: STARTING — about to ` +
          `set the visit day on up to ${items.length} branch(es) that had none, from the visit-day ` +
          'sheets the Managers filled. Each branch row carries this run id, so the run can be ' +
          'reversed with --reverse even if it stops halfway. Run outside any session, so ip and ' +
          'userAgent are null by construction.',
        after: { phase: 'started', planned: items.length, setSha256: sha, files, host } as Prisma.InputJsonValue,
      },
    });
    log(`Run id:           ${runId}  (--reverse needs it)`);
  }

  const chunks = chunksOf(items, opts.chunk);
  const written: SetItem[] = [];
  let changed = 0;
  for (const [k, chunk] of chunks.entries()) {
    const customerIds = [...new Set(chunk.map((c) => c.customerId))];
    let tally: { done: SetItem[]; changed: number };
    try {
      tally = await prisma.$transaction(
        async (tx) => {
          await lockCustomersAndTemixCodeHolders(tx, customerIds, null);
          const now = await tx.branch.findMany({
            where: { id: { in: chunk.map((c) => c.branchId) } },
            select: {
              id: true,
              customerId: true,
              routeId: true,
              status: true,
              dayOfVisit: true,
              version: true,
              deletedAt: true,
              customer: { select: { deletedAt: true } },
            },
          });
          const byId = new Map(now.map((b) => [b.id, b]));
          const unchanged = chunk.filter((it) => {
            const b = byId.get(it.branchId);
            return (
              !!b &&
              b.deletedAt === null &&
              b.customer.deletedAt === null &&
              b.customerId === it.customerId &&
              b.routeId === it.routeId &&
              b.status === 'ACTIVE' &&
              b.dayOfVisit === null &&
              b.version === it.version
            );
          });
          const ids = await writeDays(tx, unchanged, actor.id);
          const done = unchanged.filter((it) => ids.has(it.branchId));
          // Written in the rehearsal too (it rolls back), so --apply is not the first run of
          // these statements.
          if (done.length > 0) {
            // updatedAt through the client, as everywhere else (lib/rescore.ts explains why
            // the database never sets it): the master export prints a branch's as last edited.
            await tx.branch.updateMany({ where: { id: { in: [...ids] } }, data: { updatedAt: at } });
            await tx.auditLog.createMany({
              data: done.map((it) => ({
                actorId: actor.id,
                action: 'UPDATE' as const,
                entityType: 'Branch',
                entityId: it.branchId,
                reason: BRANCH_REASON,
                before: { dayOfVisit: null, version: it.version } as Prisma.InputJsonValue,
                after: {
                  dayOfVisit: it.day,
                  version: it.version + 1,
                  runId,
                  source: { file: it.file, sheet: it.sheet, row: it.row },
                } as Prisma.InputJsonValue,
              })),
            });
            const customers = [...new Set(done.map((d) => d.customerId))];
            // A changed branch moves its customer's updatedAt, which the master export's
            // "updated since" filter reads (as the import's branch lane does).
            await tx.customer.updateMany({ where: { id: { in: customers } }, data: { updatedAt: at } });
            await rescoreCustomerTx(tx, customers);
          }
          const t = { done, changed: chunk.length - done.length };
          if (!apply) throw new Rollback(t);
          return t;
        },
        { timeout: 120_000, maxWait: 30_000 }
      );
    } catch (e) {
      if (!(e instanceof Rollback)) {
        log(`STOPPED in chunk ${k + 1} of ${chunks.length}: ${written.length} written before it${apply ? `; run ${runId}` : ''}`);
        throw e;
      }
      tally = e.tally;
    }
    written.push(...tally.done);
    changed += tally.changed;
    log(`  chunk ${k + 1}/${chunks.length}: ${apply ? 'wrote' : 'would write'} ${tally.done.length}, changed since the review ${tally.changed}`);
  }

  if (!apply) {
    log('='.repeat(76));
    log(`REHEARSED (rolled back): would write ${written.length}; changed since the review ${changed}.`);
    log('Nothing was written. Next: the same command with --apply, between two runs of npm run smoke.\n');
    return 0;
  }

  log(`  written         ${written.length}`);
  log(`  changed since the review, left alone ${changed}`);
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: 'UPDATE',
      entityType: LEDGER_ENTITY,
      entityId: runId,
      reason:
        `operator script scripts/ops/visitdays-from-sheets.ts on ${host}: COMPLETED — ` +
        `${written.length} branch(es) now carry the visit day from the sheets; ${changed} had ` +
        'changed since the dry run and were left alone. Written before the check that re-reads ' +
        'them, so a failed check cannot lose these counts. Pairs with the STARTING row of the ' +
        'same entityId. Run outside any session, so ip and userAgent are null by construction.',
      after: { phase: 'completed', planned: items.length, written: written.length, changed, setSha256: sha } as Prisma.InputJsonValue,
    },
  });

  // The check: every written day is there, and each has exactly one audit row. A failed
  // read must not leave the run looking unfinished: the COMPLETED row above already has it.
  let checked: { landed: number; auditRows: number } | null = null;
  try {
    let landed = 0;
    const wantDay = new Map(written.map((w) => [w.branchId, w.day]));
    const ids = [...wantDay.keys()];
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await prisma.branch.findMany({
        where: { id: { in: ids.slice(i, i + 1000) } },
        select: { id: true, dayOfVisit: true },
      });
      landed += rows.filter((r) => r.dayOfVisit === wantDay.get(r.id)).length;
    }
    const auditRows = await prisma.auditLog.count({
      where: { entityType: 'Branch', action: 'UPDATE', after: { path: ['runId'], equals: runId } },
    });
    checked = { landed, auditRows };
  } catch (e) {
    log(`The check FAILED to read: ${operatorErrorLabel(e)}`);
  }
  const clean = checked !== null && checked.landed === written.length && checked.auditRows === written.length;
  log('='.repeat(76));
  log(
    checked === null
      ? 'Not checked: the days are written and the ledger has its COMPLETED row, but the check could not read them.'
      : `Checked: ${checked.landed} of ${written.length} day(s) in place; ${checked.auditRows} audit row(s) for this run.`
  );
  log('');
  log('For the record — paste this into the go-live log:');
  log('');
  log(`  scripts/ops/visitdays-from-sheets.ts --apply   ${at.toISOString()}`);
  log(`  database        ${host}`);
  log(`  run as          ${actor.username}`);
  log(`  run id          ${runId}`);
  log(`  set SHA-256     ${sha.slice(0, 16)}`);
  log(`  written         ${written.length} of ${items.length}; changed since the review ${changed}`);
  log(`  audit rows      AuditLog entityType=${LEDGER_ENTITY} entityId=${runId} (STARTING + COMPLETED)`);
  log('');
  if (checked === null) {
    log('Next: read this run\'s branches again before anything else, then npm run smoke.\n');
    return 2;
  }
  log(
    clean
      ? 'Next: npm run smoke. Each day written onto a branch whose day the verify:load\n' +
          'expectation does not already count adds 1 to it: derive it from the ledger, never\n' +
          'from the total.\n'
      : 'The check does NOT match what was written. Stop, and read the branches of this run\n' +
          'before anything else.\n'
  );
  return clean ? 0 : 1;
}

async function reverseRun(
  opts: Options,
  prisma: PrismaClient,
  host: string,
  log: (l: string) => void
): Promise<number> {
  const runId = opts.runId;
  const rows = await prisma.auditLog.findMany({
    where: { entityType: 'Branch', action: 'UPDATE', after: { path: ['runId'], equals: runId } },
    select: { entityId: true, after: true },
  });
  if (rows.length === 0) throw new OperatorRefusal(`no branch row carries the run id ${runId}. Nothing has been written.`);
  type Wrote = { branchId: string; day: string; version: number };
  const wrote: Wrote[] = rows.map((r) => {
    const a = r.after as { dayOfVisit?: unknown; version?: unknown } | null;
    return { branchId: r.entityId, day: String(a?.dayOfVisit ?? ''), version: Number(a?.version) };
  });
  // The branches that still hold exactly what the run wrote: same day, same version, still
  // live. Anything else changed since, and is left to that change.
  const asWritten = async (db: PrismaClient | Prisma.TransactionClient, subset: Wrote[]) => {
    const out: Array<Wrote & { customerId: string }> = [];
    for (let i = 0; i < subset.length; i += 1000) {
      const part = subset.slice(i, i + 1000);
      const now = await db.branch.findMany({
        where: { id: { in: part.map((w) => w.branchId) } },
        select: { id: true, customerId: true, dayOfVisit: true, version: true, deletedAt: true },
      });
      const byId = new Map(now.map((b) => [b.id, b]));
      for (const w of part) {
        const b = byId.get(w.branchId);
        if (b && b.deletedAt === null && b.dayOfVisit === w.day && b.version === w.version) {
          out.push({ ...w, customerId: b.customerId });
        }
      }
    }
    return out;
  };
  const still = await asWritten(prisma, wrote);
  log(`Run ${runId}: ${wrote.length} branch(es) written; ${still.length} still as written; ${wrote.length - still.length} changed since (left alone).`);
  const actor = await resolveActor(prisma, opts.actor);
  log(`Audit actor:      ${actor.username}${opts.actor ? ' (--actor)' : ' (the one active Steward)'}`);
  if (!opts.confirm) {
    log('='.repeat(76));
    log('DRY RUN — nothing was written. Add --confirm to set those days back to none.\n');
    return 0;
  }
  const at = new Date();
  let reversed = 0;
  const chunks = chunksOf(
    still.map((s) => ({ branchId: s.branchId, customerId: s.customerId, routeId: '', version: s.version, day: s.day as DayOfWeek, branchCode: '', file: '', sheet: '', row: 0 })),
    opts.chunk
  );
  for (const chunk of chunks) {
    const locked = new Set(chunk.map((c) => c.customerId));
    reversed += await prisma.$transaction(
      async (tx) => {
        await lockCustomersAndTemixCodeHolders(tx, [...locked], null);
        // Read again under the lock. A branch whose customer is no longer one this chunk
        // locked (a merge moves branches without bumping their version) is left alone.
        const mine = (await asWritten(tx, chunk.map((c) => ({ branchId: c.branchId, day: c.day, version: c.version })))).filter((s) =>
          locked.has(s.customerId)
        );
        if (mine.length === 0) return 0;
        const values = Prisma.join(
          mine.map(
            (s) => Prisma.sql`(${s.branchId}::text, ${s.version}::int, ${s.customerId}::text, ${s.day}::"DayOfWeek")`
          )
        );
        const undone = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "Branch" AS b
             SET "dayOfVisit" = NULL, "version" = b."version" + 1, "lastEditedById" = ${actor.id}::text
            FROM (VALUES ${values}) AS v(id, version, "customerId", day)
           WHERE b."id" = v.id AND b."version" = v.version AND b."customerId" = v."customerId"
             AND b."dayOfVisit" = v.day AND b."deletedAt" IS NULL
          RETURNING b."id"`;
        const ids = new Set(undone.map((u) => u.id));
        const done = mine.filter((s) => ids.has(s.branchId));
        if (done.length > 0) {
          await tx.branch.updateMany({ where: { id: { in: [...ids] } }, data: { updatedAt: at } });
          await tx.auditLog.createMany({
            data: done.map((s) => ({
              actorId: actor.id,
              action: 'UPDATE' as const,
              entityType: 'Branch',
              entityId: s.branchId,
              reason: `REVERSE of ${runId}: the visit day goes back to none. ${BRANCH_REASON}`,
              before: { dayOfVisit: s.day, version: s.version } as Prisma.InputJsonValue,
              after: { dayOfVisit: null, version: s.version + 1, reverseOf: runId } as Prisma.InputJsonValue,
            })),
          });
          const customers = [...new Set(done.map((d) => d.customerId))];
          await tx.customer.updateMany({ where: { id: { in: customers } }, data: { updatedAt: at } });
          await rescoreCustomerTx(tx, customers);
        }
        return done.length;
      },
      { timeout: 120_000, maxWait: 30_000 }
    );
  }
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: 'UPDATE',
      entityType: LEDGER_ENTITY,
      entityId: runId,
      reason:
        `operator script scripts/ops/visitdays-from-sheets.ts on ${host}: REVERSED at ${at.toISOString()} — ` +
        `${reversed} branch(es) set back to no visit day; the rest had changed since the run and ` +
        'were left alone.',
      after: { phase: 'reversed', reversed, written: wrote.length } as Prisma.InputJsonValue,
    },
  });
  log('='.repeat(76));
  log(`REVERSED: ${reversed} of ${wrote.length}. Next: npm run smoke.\n`);
  return 0;
}

/** One run against one database. main() supplies the client; tests pass their own. */
export async function run(
  opts: Options,
  prisma: PrismaClient,
  host: string,
  log: (line: string) => void = console.log
): Promise<number> {
  log(`\nTarget: ${host}`);
  log(
    {
      dry: 'Mode:   DRY RUN — reads only; writes the set and review files',
      rehearse: 'Mode:   REHEARSAL — every write, rolled back',
      apply: 'Mode:   APPLY — visit days WILL be written',
      reverse: opts.confirm ? 'Mode:   REVERSE — visit days WILL be set back to none' : 'Mode:   REVERSE, DRY RUN — nothing will be written',
    }[opts.mode]
  );
  log('='.repeat(76));
  await connectWaking(prisma);
  if (opts.mode === 'dry') return dryRun(opts, prisma, log);
  if (opts.mode === 'reverse') return reverseRun(opts, prisma, host, log);
  return writeSet(opts, prisma, host, log);
}

export async function main(): Promise<number> {
  // DIRECT_URL, like every other operator script: DATABASE_URL is the pooled
  // least-privilege role, and maintenance runs as the owner.
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new OperatorRefusal('set DIRECT_URL (preferred) or DATABASE_URL');
  const args = process.argv.slice(2);
  const host = (/@([^/?]+)/.exec(url) ?? [])[1] ?? '?';
  requireExpectedHost(args, url, host);
  const opts = parseArgs(args);
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    return await run(opts, prisma, host);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Run only when invoked as a command: the tests import this module for its helpers, and a
 * top-level main() would have `npm test` open a database connection — against whatever
 * .env holds.
 */
if (/visitdays-from-sheets\.ts$/.test(process.argv[1] ?? '')) {
  main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(`\nVISIT-DAY LOAD FAILED: ${operatorErrorLabel(e)}\n`);
      process.exit(2);
    });
}
