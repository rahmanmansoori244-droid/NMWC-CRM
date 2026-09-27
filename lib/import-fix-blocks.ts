/**
 * What the batch page must say about a row the Steward might fix, or has fixed
 * and is waiting to promote — asked exactly as the server asks it, so the page
 * never offers what the server refuses (item 20, pre-merge review):
 *
 *  - a held-back or rejected row past the fix window: refused (assertFixable);
 *  - a rejected row is fixed with its customer's other rejected rows in the
 *    batch (services/import-fixes.ts targetsFor), so one of THEM being
 *    overtaken by a newer upload rules the fix out too — the page used to ask
 *    about each row alone and offered a fix the server then refused;
 *  - the rows one fix brought back (parsed.fixGroup) load together or not at
 *    all: past the window, or with any of them overtaken, promote rejects them
 *    all (services/imports.ts), and the page says so on each.
 *
 * Server-only: it reads the database.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { fixTarget, newerUploadsCarrying, type FixTarget } from '@/lib/import-master-lookup';
import {
  fixExpiredMessage,
  fixUnitOf,
  fixWindowClosed,
  fixWindowMessage,
  newerUploadMessage,
  siblingSupersededMessage,
  supersededFixMessage,
} from '@/lib/import-row-fix';

type Db = PrismaClient | Prisma.TransactionClient;

export type FixBlockRow = {
  id: string;
  rowNumber: number;
  state: string;
  parsed: unknown;
  excludedAt: Date | null;
  createdAt: Date;
  /** The row still holds its uploaded data (the retention sweep has not emptied it). */
  hasData: boolean;
};

export type FixBlocks = {
  /** Why a row offers no fix (or why its waiting fix will not load), in the server's words. */
  blocked: Map<string, string>;
  /** For a row a fix only brought back with it: the row number of the row that fix acted on. */
  releasedWith: Map<string, number>;
  /** Of those, the rows whose acted row is held back again: they load without it. */
  releasedAlone: Set<string>;
  /**
   * Held-back rows whose fix can still be withdrawn: the row a fix acted on,
   * come back held back, while rows that fix released wait CLEAN
   * (services/import-fixes.ts withdrawCore).
   */
  withdrawable: Set<string>;
};

type P = { custCode?: string; branchCode?: string | null; fixedInApp?: boolean; fixedFrom?: unknown };
const p = (parsed: unknown) => (parsed ?? {}) as P;
const isProblem = (r: FixBlockRow) => r.state === 'QUARANTINED' || r.state === 'REJECTED';
/** A CLEAN row a fix brought back: the row acted on, or one released with it. */
const isFixRow = (r: { state: string; excludedAt: Date | null; parsed: unknown }) =>
  r.state === 'CLEAN' && !r.excludedAt && (p(r.parsed).fixedInApp === true || !!p(r.parsed).fixedFrom);

export async function fixBlocks(
  db: Db,
  batch: { id: string; uploadedAt: Date },
  rows: FixBlockRow[]
): Promise<FixBlocks> {
  const blocked = new Map<string, string>();
  const releasedWith = new Map<string, number>();
  const withdrawable = new Set<string>();
  const releasedAlone = new Set<string>();
  const targets: FixTarget[] = [];
  // How to word a hit on each target, keyed like the targets.
  const say = new Map<string, { rowId: string; message: (code: string, n: Parameters<typeof newerUploadMessage>[1]) => string }>();

  // ── Rows the Steward may fix ────────────────────────────────────────────
  const problems = rows.filter((r) => isProblem(r) && !r.excludedAt && r.hasData);
  for (const r of problems) {
    if (fixWindowClosed(r.createdAt)) blocked.set(r.id, fixWindowMessage(r.rowNumber));
  }
  const open = problems.filter((r) => !blocked.has(r.id));
  const rejectedCodes = [
    ...new Set(open.filter((r) => r.state === 'REJECTED').map((r) => p(r.parsed).custCode).filter((c): c is string => !!c)),
  ];
  const siblings = rejectedCodes.length
    ? await db.importRow.findMany({
        where: {
          batchId: batch.id,
          state: 'REJECTED',
          excludedAt: null,
          OR: rejectedCodes.map((code) => ({ parsed: { path: ['custCode'], equals: code } })),
        },
        select: { id: true, rowNumber: true, parsed: true },
      })
    : [];
  for (const r of open) {
    const code = p(r.parsed).custCode;
    if (!code) continue;
    const self = `${r.id}|${r.id}`;
    targets.push(fixTarget(self, code, p(r.parsed).branchCode ?? null, true));
    say.set(self, { rowId: r.id, message: (c, n) => newerUploadMessage(c, n) });
    if (r.state !== 'REJECTED') continue;
    for (const s of siblings) {
      if (s.id === r.id || p(s.parsed).custCode !== code) continue;
      const key = `${r.id}|${s.id}`;
      targets.push(fixTarget(key, code, p(s.parsed).branchCode ?? null, p(s.parsed).fixedInApp === true));
      say.set(key, { rowId: r.id, message: (c, n) => siblingSupersededMessage(s.rowNumber, c, n) });
    }
  }

  // ── Fixes waiting to promote, as the units promote judges ───────────────
  // Only the units of the rows on screen are read: reading every CLEAN row of
  // a 20,000-row batch, payload and all, on each render was megabytes per
  // page (pre-merge review).
  const heldWithFix = rows.filter(
    (r) => r.state === 'QUARANTINED' && !r.excludedAt && !!p(r.parsed).fixedFrom
  );
  const unitIds = [
    ...new Set([...rows.filter(isFixRow), ...heldWithFix].map((r) => fixUnitOf(r.id, r.parsed))),
  ];
  if (unitIds.length > 0) {
    const all = await db.importRow.findMany({
      where: {
        batchId: batch.id,
        state: { in: ['CLEAN', 'QUARANTINED'] },
        excludedAt: null,
        OR: [{ id: { in: unitIds } }, ...unitIds.map((u) => ({ parsed: { path: ['fixGroup'], equals: u } }))],
      },
      select: { id: true, rowNumber: true, parsed: true, createdAt: true, excludedAt: true, state: true },
    });
    const cleanUnits = new Set(all.filter(isFixRow).map((m) => fixUnitOf(m.id, m.parsed)));
    for (const r of heldWithFix) if (cleanUnits.has(fixUnitOf(r.id, r.parsed))) withdrawable.add(r.id);
    const members = all.filter(isFixRow);
    const units = new Map<string, typeof members>();
    for (const m of members) {
      const u = fixUnitOf(m.id, m.parsed);
      units.set(u, [...(units.get(u) ?? []), m]);
    }
    const shown = new Set(rows.filter(isFixRow).map((r) => r.id));
    for (const [unit, list] of units) {
      if (!list.some((m) => shown.has(m.id))) continue;
      // The acted row may itself have come back held back: look in every row read.
      const acted = all.find((m) => m.id === unit);
      for (const m of list) {
        if (shown.has(m.id) && p(m.parsed).fixedInApp !== true && acted) {
          releasedWith.set(m.id, acted.rowNumber);
          // Promote loads only CLEAN rows: with the acted row held back again,
          // this one loads without it (pre-merge review — it said "loads with it").
          if (acted.state !== 'CLEAN') releasedAlone.add(m.id);
        }
      }
      if (list.some((m) => fixWindowClosed(m.createdAt))) {
        for (const m of list) if (shown.has(m.id)) blocked.set(m.id, fixExpiredMessage(m.rowNumber));
        continue;
      }
      for (const m of list) {
        const code = p(m.parsed).custCode;
        if (!code) continue;
        const key = `unit:${unit}|${m.id}`;
        targets.push(fixTarget(key, code, p(m.parsed).branchCode ?? null, p(m.parsed).fixedInApp === true));
        say.set(key, { rowId: `unit:${unit}`, message: (c, n) => supersededFixMessage(c, n) });
      }
    }
    // One overtaken member stops its whole unit: record the first hit per unit.
    const unitOfShown = new Map(
      members.filter((m) => shown.has(m.id)).map((m) => [m.id, fixUnitOf(m.id, m.parsed)] as const)
    );
    const hits = targets.length ? await newerUploadsCarrying(db, batch.uploadedAt, targets) : new Map();
    const unitHit = new Map<string, string>();
    for (const t of targets) {
      const n = hits.get(t.key);
      const how = say.get(t.key);
      if (!n || !how) continue;
      if (how.rowId.startsWith('unit:')) {
        const unit = how.rowId.slice('unit:'.length);
        if (!unitHit.has(unit)) unitHit.set(unit, how.message(t.code, n));
      } else if (!blocked.has(how.rowId)) {
        blocked.set(how.rowId, how.message(t.code, n));
      }
    }
    for (const [id, unit] of unitOfShown) {
      const m = unitHit.get(unit);
      if (m && !blocked.has(id)) blocked.set(id, m);
    }
    return { blocked, releasedWith, releasedAlone, withdrawable };
  }

  const hits = targets.length ? await newerUploadsCarrying(db, batch.uploadedAt, targets) : new Map();
  for (const t of targets) {
    const n = hits.get(t.key);
    const how = say.get(t.key);
    if (n && how && !blocked.has(how.rowId)) blocked.set(how.rowId, how.message(t.code, n));
  }
  return { blocked, releasedWith, releasedAlone, withdrawable };
}
