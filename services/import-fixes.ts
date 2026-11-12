'use server';

/**
 * The Data Steward's in-app fix of import rows that were held back
 * (QUARANTINED) or rejected at promote (REJECTED) — benchmark item 20. Until
 * now the only fix was a corrected re-upload or an operator script.
 *
 * Owner decisions, 2026-09-25:
 *  - Re-check: run the row through the upload check again, as it stands. A
 *    rejected row takes its whole customer with it, and goes back to CLEAN so
 *    the next promote tries it again; a payment-terms or crosswalk rejection
 *    comes back rejected, because promote applies that guard again.
 *  - Correct: change only the cells the row's problem names, never payment
 *    terms, credit or the Temix code (lib/import-row-fix.ts).
 *  - Release: let a row held back only because its phone is on another
 *    customer through, with a written reason, audited as FORCE_OVERRIDE.
 *  - Exclude: record that a row stays out on purpose, so the batch can leave
 *    the Steward's Work list.
 *
 * Every action locks the batch row first (FOR UPDATE) and refuses while a
 * promote holds a live lease on it: the promote claim is an UPDATE of that
 * same row, so the two serialize, and a row cannot turn CLEAN under a promote
 * that is about to declare the batch finished.
 */
import { prisma } from '@/lib/db';
import { src, withChangeContext } from '@/lib/change-context';
import { ImportRowState, Prisma, Role } from '@prisma/client';
import { requireActor } from '@/lib/session';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { normalizeCR } from '@/lib/cr';
import { getAuditEnvelope, writeAudit, type AuditEnvelope } from '@/lib/audit';
import { correctionAudit } from '@/lib/import-lineage';
import {
  checkCustomerRow,
  rowCrNorm,
  rowBranchCode,
  rowCustCode,
  rowPhoneNorm,
  type FileDup,
  type SheetRow,
} from '@/lib/import-row-check';
import type { SiblingShop } from '@/lib/import-shop-code';
import {
  batchLoadHistory,
  fixTarget,
  masterCollisionMaps,
  masterShopCodes,
  newerUploadsCarrying,
  type FixTarget,
} from '@/lib/import-master-lookup';
import {
  acceptCells,
  canReleasePhone,
  canReleaseShopCode,
  cellValue,
  changedCells,
  correctedRow,
  fixWindowClosed,
  fixWindowMessage,
  newerUploadMessage,
  readCorrections,
  siblingSupersededMessage,
  type Corrections,
} from '@/lib/import-row-fix';
import {
  DISCARDED_BATCH_MESSAGE,
  stagedLoadExpired,
  stagedBatchExpiredMessage,
} from '@/lib/import-batch-guard';

type Tx = Prisma.TransactionClient;

async function requireSteward() {
  const user = await requireActor(); // F15: refuses a session that must change its password
  if (user.role !== Role.STEWARD) {
    throw new ForbiddenError('Only the Data Steward can fix import rows.');
  }
  return user;
}

type LockedBatch = {
  id: string;
  kind: string;
  status: string;
  promoteLeaseUntil: Date | null;
  uploadedAt: Date;
  filename: string;
  overwriteCrmFields: boolean;
};

const MIN_REASON = 5;
const PROBLEM: ImportRowState[] = [ImportRowState.QUARANTINED, ImportRowState.REJECTED];

/**
 * Lock the batch, refuse while a promote is running on it, then run `fn`. Gap 24:
 * the Steward is the actor and the row (or the batch's row set) the cause.
 */
async function withBatch<T>(
  batchId: string,
  cause: { actorId: string; row: string },
  fn: (tx: Tx, batch: LockedBatch) => Promise<T>
): Promise<T> {
  return withChangeContext(
    prisma,
    { actorId: cause.actorId, source: src.importFix(batchId, cause.row) },
    async (tx) => {
      const [batch] = await tx.$queryRaw<LockedBatch[]>`
        SELECT "id", "kind", "status"::text AS "status", "promoteLeaseUntil", "uploadedAt", "filename",
               "overwriteCrmFields"
          FROM "ImportBatch" WHERE "id" = ${batchId} FOR UPDATE`;
      if (!batch) throw new NotFoundError('Import batch not found.');
      if (batch.kind !== 'CUSTOMER') {
        throw new ValidationError({
          _form:
            'Only customer-master rows can be fixed here. Re-upload the account master instead.',
        });
      }
      if (
        batch.status === 'PROMOTING' &&
        batch.promoteLeaseUntil &&
        batch.promoteLeaseUntil > new Date()
      ) {
        throw new ConflictError(
          'BATCH_PROMOTING',
          'This batch is being promoted right now — wait for it to finish, then try again.'
        );
      }
      // Code review 2026-11-10, finding 6: a discarded batch is not touched again.
      if (batch.status === 'DISCARDED') {
        throw new ValidationError({ _form: DISCARDED_BATCH_MESSAGE }, DISCARDED_BATCH_MESSAGE);
      }
      return fn(tx, batch);
    },
    { timeout: 20_000, maxWait: 10_000 }
  );
}

type RowForFix = {
  id: string;
  batchId: string;
  rowNumber: number;
  state: ImportRowState;
  raw: Prisma.JsonValue;
  parsed: Prisma.JsonValue;
  issues: Prisma.JsonValue;
  corrections: Prisma.JsonValue;
  excludedAt: Date | null;
  createdAt: Date;
};

const rowSelect = {
  id: true,
  batchId: true,
  rowNumber: true,
  state: true,
  raw: true,
  parsed: true,
  issues: true,
  corrections: true,
  excludedAt: true,
  createdAt: true,
} as const;

function assertFixable(row: RowForFix) {
  if (!PROBLEM.includes(row.state)) {
    throw new ValidationError({
      _form: `Row ${row.rowNumber} is ${row.state} — only held-back or rejected rows can be fixed.`,
    });
  }
  if (row.excludedAt) {
    throw new ValidationError({
      _form: `Row ${row.rowNumber} was accepted as excluded. Include it again first.`,
    });
  }
  if (fixWindowClosed(row.createdAt)) {
    throw new ValidationError({ _form: fixWindowMessage(row.rowNumber) });
  }
  const raw = row.raw as Record<string, unknown> | null;
  if (!raw || Object.keys(raw).length === 0 || row.parsed === null) {
    throw new ValidationError({
      _form: `Row ${row.rowNumber}'s data was cleared by the 90-day retention sweep. Upload the corrected row again instead.`,
    });
  }
}

/**
 * The rows a fix acts on. A held-back row stands alone. A rejected row was
 * rejected with its whole customer — promote works one customer at a time —
 * so the customer's other rejected rows in this batch go with it; otherwise
 * part of a customer would be promoted without the rest.
 */
async function targetsFor(tx: Tx, row: RowForFix): Promise<RowForFix[]> {
  if (row.state !== ImportRowState.REJECTED) return [row];
  const code = (row.parsed as { custCode?: string } | null)?.custCode;
  if (!code) return [row];
  return tx.importRow.findMany({
    where: {
      batchId: row.batchId,
      state: ImportRowState.REJECTED,
      excludedAt: null,
      parsed: { path: ['custCode'], equals: code },
    },
    select: rowSelect,
    orderBy: { rowNumber: 'asc' },
  });
}

/**
 * Fix only in the newest upload that carries the customer — or, for a customer
 * linked to Temix, the branch (lib/import-row-fix.ts supersedingUpload). On
 * 2026-09-23 the same customers were in three batches; re-checking a row of an
 * older one would load that older data over what the newer upload wrote.
 * Each row is judged as it will be: its customer code (both the uploaded one
 * and a corrected one) and its branch code, corrections laid over.
 */
async function refuseIfNewerUpload(
  tx: Tx,
  batch: LockedBatch,
  rows: Array<{ row: RowForFix; c: Corrections }>,
  actedRowId: string
) {
  const targets: FixTarget[] = [];
  const rowOf = new Map<string, RowForFix>();
  for (const { row, c } of rows) {
    const now = correctedRow(row.raw, c);
    const branch = rowBranchCode(now);
    // The acted row, and one fixed before, load branch only for a customer
    // linked to Temix; a row the fix only brings back loads as a plain row.
    const fixed =
      row.id === actedRowId || (row.parsed as { fixedInApp?: boolean } | null)?.fixedInApp === true;
    const codes = new Set(
      [rowCustCode(now), (row.parsed as { custCode?: string } | null)?.custCode].filter(
        (x): x is string => !!x
      )
    );
    for (const code of codes) {
      const key = `${row.id}#${targets.length}`;
      rowOf.set(key, row);
      targets.push(fixTarget(key, code, branch, fixed));
    }
  }
  const newer = await newerUploadsCarrying(tx, batch.uploadedAt, targets);
  // The acted row's own answer first, as the batch page words it: naming a
  // sibling first told the Steward to exclude that row, and the retry was then
  // refused about the acted row itself (pre-merge review).
  const hit =
    targets.find((t) => newer.has(t.key) && rowOf.get(t.key)!.id === actedRowId) ??
    targets.find((t) => newer.has(t.key));
  if (!hit) return;
  const hitRow = rowOf.get(hit.key)!;
  const n = newer.get(hit.key)!;
  throw new ConflictError(
    'NEWER_UPLOAD',
    hitRow.id === actedRowId
      ? newerUploadMessage(hit.code, n)
      : siblingSupersededMessage(hitRow.rowNumber, hit.code, n)
  );
}

/**
 * Re-run the upload check over each target as uploaded plus its corrections,
 * against the master as it is now and the batch's other rows, and store the
 * result: CLEAN (the next promote loads it) or QUARANTINED with the reasons.
 */
async function recheck(
  tx: Tx,
  batch: LockedBatch,
  targets: RowForFix[],
  correctionsFor: (row: RowForFix) => Corrections,
  /** The row the Steward acted on; its customer's other rejected rows only come along. */
  actedRowId: string,
  /** Gap 22 (part C): the Steward, named on a CONFLICT row when a row changed meanwhile. */
  actorId: string
): Promise<{ clean: number; held: number }> {
  // Code review 2026-11-10, finding 6: a row of a STAGED batch past the age
  // limit is not brought back to load — the batch can no longer be promoted. A
  // batch already loaded keeps the fix window for its held-back rows
  // (fixBlocks / IMPORT_PAYLOAD_DAYS); its fixed rows load under the
  // newest-upload rule above.
  const history = await batchLoadHistory(tx, batch);
  if (stagedLoadExpired(batch.uploadedAt, history)) {
    const why = stagedBatchExpiredMessage(batch.uploadedAt);
    throw new ValidationError({ _form: why }, why);
  }
  const targetIds = new Set(targets.map((t) => t.id));
  // The unit this action's rows belong to: the acted row's own, when an earlier
  // fix already brought it back with others — a row that came back held back
  // and is fixed on its own stays with the rows it was rejected with, so
  // Withdraw from any of them takes them all back and promote judges them as
  // one (pre-merge review: re-fixing it moved it into a unit of its own, and a
  // withdraw left it to load part of the customer alone).
  const actedPrev = targets.find((t) => t.id === actedRowId)?.parsed as { fixGroup?: unknown } | null;
  const group = typeof actedPrev?.fixGroup === 'string' && actedPrev.fixGroup ? actedPrev.fixGroup : actedRowId;
  const corrected = targets.map((t) => ({
    t,
    c: correctionsFor(t),
    row: correctedRow(t.raw, correctionsFor(t)),
  }));

  // The batch's other rows, for the in-file duplicate checks: only the three
  // values the check compares, never the whole payload of a 20,000-row batch.
  // Rows accepted as excluded are not going into the master, so they no longer
  // collide with anything.
  const others = await tx.$queryRaw<
    Array<{
      id: string;
      rowNumber: number;
      code: string | null;
      phone: string | null;
      cr: string | null;
      branch: string | null;
      released: boolean | null;
    }>
  >`
    SELECT "id", "rowNumber", "parsed"->>'custCode' AS "code", "parsed"->>'phone' AS "phone", "parsed"->>'crNumber' AS "cr",
           "parsed"->>'branchCode' AS "branch", ("parsed"->>'shopCodeReleased') = 'true' AS "released"
      FROM "ImportRow"
     WHERE "batchId" = ${batch.id} AND "excludedAt" IS NULL AND "parsed" IS NOT NULL`;
  const phonesInFile = new Map<string, FileDup[]>();
  const crsInFile = new Map<string, FileDup[]>();
  const add = (m: Map<string, FileDup[]>, k: string | null, d: FileDup) => {
    if (!k) return;
    const a = m.get(k) ?? [];
    a.push(d);
    m.set(k, a);
  };
  // Owner's answer 2026-11-11 (A5): each customer's rows in the batch with their
  // branch_code, so a corrected code is checked against its siblings as the
  // upload checked it (a sibling released as a different shop is not compared).
  const shopsInFile = new Map<string, SiblingShop[]>();
  const addShop = (code: string | null, s: SiblingShop) => {
    if (!code || !s.code) return;
    shopsInFile.set(code, [...(shopsInFile.get(code) ?? []), s]);
  };
  for (const o of others) {
    if (targetIds.has(o.id)) continue;
    add(phonesInFile, o.phone, { row: o.rowNumber, code: o.code ?? '' });
    add(crsInFile, normalizeCR(o.cr), { row: o.rowNumber, code: o.code ?? '' });
    addShop(o.code, { row: o.rowNumber, code: o.branch ?? '', released: o.released === true });
  }
  for (const { t, c, row } of corrected) {
    add(phonesInFile, rowPhoneNorm(row), { row: t.rowNumber, code: rowCustCode(row) });
    add(crsInFile, rowCrNorm(row), { row: t.rowNumber, code: rowCustCode(row) });
    addShop(rowCustCode(row), { row: t.rowNumber, code: rowBranchCode(row) ?? '', released: !!c.shopCodeReleased });
  }
  const { masterPhones, masterCrs } = await masterCollisionMaps(
    corrected.map((x) => rowPhoneNorm(x.row)).filter((v): v is string => !!v),
    corrected.map((x) => rowCrNorm(x.row)).filter((v): v is string => !!v)
  );
  const channelKeys = new Set(
    (await tx.channel.findMany({ select: { key: true } })).map((c) => c.key.toUpperCase())
  );
  // And the shops the CRM has for each customer the rows name, read now.
  const masterShops = await masterShopCodes(
    corrected.map((x) => rowCustCode(x.row)),
    tx
  );
  const ctx = { channelKeys, phonesInFile, crsInFile, masterPhones, masterCrs, masterShops, shopsInFile };

  let clean = 0;
  let held = 0;
  for (const { t, c, row } of corrected) {
    const { parsed, issues } = checkCustomerRow(row as SheetRow, ctx, {
      phoneReleased: !!c.phoneReleased,
      shopCodeReleased: !!c.shopCodeReleased,
    });
    const nextState = issues.length > 0 ? ImportRowState.QUARANTINED : ImportRowState.CLEAN;
    // fixedFrom: the state and reasons the row had before its FIRST fix, so a
    // mistaken fix can be withdrawn back to exactly that (pre-merge review).
    // Every target records it — withdrawing the fix takes the customer's other
    // rows it released back with it (withdrawCore).
    const prev = (t.parsed ?? {}) as { fixedFrom?: unknown; fixedInApp?: unknown };
    const fixedFrom = prev.fixedFrom ?? { state: t.state, issues: t.issues };
    // fixedInApp — promote may then create or update this row's branch for a
    // customer linked to Temix, and writes nothing else about it (owner
    // decision, "branch only") — marks ONLY the row the Steward acted on, or
    // one fixed before. It marked every rejected row of the customer, so rows
    // nobody touched overwrote existing branches from the file, or were
    // rejected over and over for a blank branch_code (post-merge review).
    const fixedInApp = t.id === actedRowId || prev.fixedInApp === true;
    const res = await tx.importRow.updateMany({
      where: { id: t.id, state: t.state, excludedAt: null },
      data: {
        state: nextState,
        // fixGroup: every row this action brings back carries the acted row's
        // id, so the rows load together or not at all (promote), and Withdraw
        // takes back exactly them — inferring the group from the customer code
        // took back separate fixes too (pre-merge review).
        parsed: {
          ...parsed,
          ...(fixedInApp ? { fixedInApp: true } : {}),
          // Finding 6: fixed on a batch already loaded, so the batch still reads
          // as loaded after its PROMOTED status goes back to READY below.
          ...(history.everLoaded ? { fixedAfterLoad: true } : {}),
          fixedFrom,
          fixGroup: group,
        } as unknown as Prisma.InputJsonValue,
        issues: issues.length > 0 ? (issues as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        corrections:
          Object.keys(c).length > 0 ? (c as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
    if (res.count !== 1) {
      throw new ConflictError(
        'ROW_CHANGED',
        `Row ${t.rowNumber} changed while you were fixing it. Refresh and try again.`,
        { actorId, entityType: 'ImportRow', entityId: t.id, path: 'import-fix.recheck', expectedVersion: t.state }
      );
    }
    if (nextState === ImportRowState.CLEAN) clean++;
    else held++;
  }

  // A batch whose rows are CLEAN again must be promotable again. The counters
  // follow the rows, as promote's own counters do.
  const counts = await tx.importRow.groupBy({
    by: ['state'],
    where: { batchId: batch.id },
    _count: { _all: true },
  });
  const n = (s: ImportRowState) => counts.find((x) => x.state === s)?._count._all ?? 0;
  await tx.importBatch.update({
    where: { id: batch.id },
    data: {
      quarantinedRows: n(ImportRowState.QUARANTINED),
      rejectedRows: n(ImportRowState.REJECTED),
      ...(clean > 0 && batch.status === 'PROMOTED' ? { status: 'READY' as const } : {}),
    },
  });
  return { clean, held };
}

async function loadRow(tx: Tx, rowId: string): Promise<RowForFix> {
  const row = await tx.importRow.findUnique({ where: { id: rowId }, select: rowSelect });
  if (!row) throw new NotFoundError('Import row not found.');
  return row;
}

async function batchIdOf(rowId: string): Promise<string> {
  const r = await prisma.importRow.findUnique({ where: { id: rowId }, select: { batchId: true } });
  if (!r) throw new NotFoundError('Import row not found.');
  return r.batchId;
}

function done(batchId: string) {
  revalidatePath(`/import/${batchId}`);
  revalidatePath('/import');
  revalidatePath('/work');
}

export type FixResult = { clean: number; held: number };

// ── Re-check ────────────────────────────────────────────────────────────────

export async function recheckImportRowAction(formData: FormData): SafeAction<FixResult> {
  return runAction(() => recheckCore(formData));
}

async function recheckCore(formData: FormData): Promise<FixResult> {
  const me = await requireSteward();
  const rowId = String(formData.get('rowId') ?? '');
  if (!rowId) throw new ValidationError({ _form: 'Row required.' });
  const env = await getAuditEnvelope(me.id);
  const batchId = await batchIdOf(rowId);
  const result = await withBatch(batchId, { actorId: me.id, row: rowId }, async (tx, batch) => {
    const row = await loadRow(tx, rowId);
    assertFixable(row);
    const targets = await targetsFor(tx, row);
    await refuseIfNewerUpload(
      tx,
      batch,
      targets.map((t) => ({ row: t, c: readCorrections(t.corrections) })),
      row.id
    );
    const r = await recheck(tx, batch, targets, (t) => readCorrections(t.corrections), row.id, me.id);
    await audit(tx, env, 'UPDATE', row.id, 'Import row re-checked by the Data Steward', {
      rows: targets.length,
      ...r,
    });
    return r;
  });
  done(batchId);
  return result;
}

// ── Correct the failing cells ───────────────────────────────────────────────

export async function correctImportRowAction(formData: FormData): SafeAction<FixResult> {
  return runAction(() => correctCore(formData));
}

async function correctCore(formData: FormData): Promise<FixResult> {
  const me = await requireSteward();
  const rowId = String(formData.get('rowId') ?? '');
  if (!rowId) throw new ValidationError({ _form: 'Row required.' });
  let sent: Record<string, unknown>;
  try {
    sent = JSON.parse(String(formData.get('cells') ?? '{}'));
  } catch {
    throw new ValidationError({ _form: 'Could not read the corrected cells.' });
  }
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)) {
    throw new ValidationError({ _form: 'Could not read the corrected cells.' });
  }
  const env = await getAuditEnvelope(me.id);
  const batchId = await batchIdOf(rowId);
  const result = await withBatch(batchId, { actorId: me.id, row: rowId }, async (tx, batch) => {
    const row = await loadRow(tx, rowId);
    assertFixable(row);
    const accepted = acceptCells(row.issues, sent);
    if (!accepted.ok) throw new ValidationError({ _form: accepted.message });
    const mine = readCorrections(row.corrections);
    // Only what the Steward changed. The form is pre-filled, and recording every
    // offered cell said "corrected in the app" of values nobody touched — in
    // the audit row too, which keeps no values to check it against.
    const changed = changedCells(accepted.cells, correctedRow(row.raw, mine));
    if (Object.keys(changed).length === 0) {
      throw new ValidationError({ _form: 'Nothing changed. Use Re-check to check the row as it stands.' });
    }
    // Review of A5 (2026-11-11): a "Different shop" release was given for the
    // shop code the row had then. A correction of that code (or of the customer
    // code it is composed under) ends it, so a new code that only looks like
    // another shop is held back again instead of loading as a second shop.
    const merged: Corrections = { ...mine, cells: { ...(mine.cells ?? {}), ...changed } };
    if ('branch_code' in changed || 'cust_code' in changed) delete merged.shopCodeReleased;
    // Final check of the review (2026-11-11): the ledger says so, or it would show
    // the release followed by a plain correction, as if the release still applied.
    const releaseEnded = !!mine.shopCodeReleased && !merged.shopCodeReleased;
    const targets = await targetsFor(tx, row);
    const correctionsFor = (t: RowForFix) => (t.id === row.id ? merged : readCorrections(t.corrections));
    // A corrected customer or branch code is the identity the newest-upload
    // rule is about, so each row is judged with its corrections laid over.
    await refuseIfNewerUpload(
      tx,
      batch,
      targets.map((t) => ({ row: t, c: correctionsFor(t) })),
      row.id
    );
    const r = await recheck(tx, batch, targets, correctionsFor, row.id, me.id);
    // Gap 7: which cells were corrected, from what to what — kept after the
    // 90-day sweep empties the row. Non-personal cells (codes, channel, visit day,
    // status) keep their values; a personal one (name, address, phone, CR number,
    // contact, note) only its fingerprints: this ledger keeps everything for ever.
    const why = releaseEnded
      ? "Import row corrected by the Data Steward; its shop code changed, so the 'Different shop' release ends"
      : 'Import row corrected by the Data Steward';
    await audit(tx, env, 'UPDATE', row.id, why, {
      ...(releaseEnded ? { shopCodeReleaseEnded: true } : {}),
      columns: Object.keys(changed).sort(),
      cells: correctionAudit(
        changed,
        Object.fromEntries(Object.keys(changed).map((c) => [c, cellValue(correctedRow(row.raw, mine), c)]))
      ),
      batchId: batch.id,
      ...r,
    });
    return r;
  });
  done(batchId);
  return result;
}

// ── Release a shared phone ──────────────────────────────────────────────────

export async function releaseImportRowPhoneAction(formData: FormData): SafeAction<FixResult> {
  return runAction(() => releaseCore(formData));
}

async function releaseCore(formData: FormData): Promise<FixResult> {
  const me = await requireSteward();
  const rowId = String(formData.get('rowId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!rowId) throw new ValidationError({ _form: 'Row required.' });
  if (reason.length < MIN_REASON) {
    throw new ValidationError({
      reason: `Say why this phone may be shared (${MIN_REASON}+ characters).`,
    });
  }
  const env = await getAuditEnvelope(me.id);
  const batchId = await batchIdOf(rowId);
  const result = await withBatch(batchId, { actorId: me.id, row: rowId }, async (tx, batch) => {
    const row = await loadRow(tx, rowId);
    assertFixable(row);
    if (row.state !== ImportRowState.QUARANTINED || !canReleasePhone(row.issues)) {
      throw new ValidationError({
        _form:
          'Only a row held back solely because its phone is on another customer can be released.',
      });
    }
    const merged: Corrections = { ...readCorrections(row.corrections), phoneReleased: { reason } };
    await refuseIfNewerUpload(tx, batch, [{ row, c: merged }], row.id);
    const r = await recheck(tx, batch, [row], () => merged, row.id, me.id);
    await audit(
      tx,
      env,
      'FORCE_OVERRIDE',
      row.id,
      `Shared phone released by the Data Steward: ${reason}`,
      r
    );
    return r;
  });
  done(batchId);
  return result;
}

// ── Release a shop code as a different shop ─────────────────────────────────

/**
 * Owner's answer 2026-11-11 (A5): a row whose branch_code only LOOKS like one of
 * its customer's shops or rows (01 / 1, Ab / AB) is held back, never matched.
 * When the two really are different shops, the Steward lets the row through
 * with a written reason, exactly as a shared phone is released: audited as
 * FORCE_OVERRIDE, re-checked, and withdrawn like any other fix. Only a row whose
 * problems are such codes (and, perhaps, a phone on another customer, which is
 * then released on its own) can be.
 */
export async function releaseImportRowShopCodeAction(formData: FormData): SafeAction<FixResult> {
  return runAction(() => releaseShopCodeCore(formData));
}

async function releaseShopCodeCore(formData: FormData): Promise<FixResult> {
  const me = await requireSteward();
  const rowId = String(formData.get('rowId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!rowId) throw new ValidationError({ _form: 'Row required.' });
  if (reason.length < MIN_REASON) {
    throw new ValidationError({
      reason: `Say why this is a different shop (${MIN_REASON}+ characters).`,
    });
  }
  const env = await getAuditEnvelope(me.id);
  const batchId = await batchIdOf(rowId);
  const result = await withBatch(batchId, { actorId: me.id, row: rowId }, async (tx, batch) => {
    const row = await loadRow(tx, rowId);
    assertFixable(row);
    if (row.state !== ImportRowState.QUARANTINED || !canReleaseShopCode(row.issues)) {
      throw new ValidationError({
        _form:
          'Only a row held back because its shop code looks like another shop of the same customer can be released.',
      });
    }
    const merged: Corrections = { ...readCorrections(row.corrections), shopCodeReleased: { reason } };
    await refuseIfNewerUpload(tx, batch, [{ row, c: merged }], row.id);
    const r = await recheck(tx, batch, [row], () => merged, row.id, me.id);
    await audit(
      tx,
      env,
      'FORCE_OVERRIDE',
      row.id,
      `Shop code released as a different shop by the Data Steward: ${reason}`,
      r
    );
    return r;
  });
  done(batchId);
  return result;
}

// ── Withdraw a fix ──────────────────────────────────────────────────────────

/**
 * Put a row fixed in the app back to exactly what it was before its first fix
 * — its state and reasons, with the corrections dropped — so it can be
 * corrected again or excluded. Once a fix turned a row CLEAN nothing could
 * touch it before promote (pre-merge review): a mistyped correction had to be
 * loaded, or the batch never promoted. A cust_code typed wrong would merge the
 * row into another customer and overwrite its fields.
 *
 * A fix of a rejected row re-checks its customer's other rejected rows with it
 * (targetsFor), so withdrawing it takes those back too: withdrawing one row
 * left the rest CLEAN, and the next promote loaded part of the customer
 * without the row that carried its phone (post-merge review). Exactly the rows
 * that fix brought back (parsed.fixGroup) — not every fixed row of the
 * customer, which undid separate fixes and dropped their corrections
 * (pre-merge review).
 */
export async function withdrawImportRowFixAction(
  formData: FormData
): SafeAction<{ rows: number }> {
  return runAction(() => withdrawCore(formData));
}

type FixedFrom = { state?: unknown; issues?: unknown };

async function withdrawCore(formData: FormData): Promise<{ rows: number }> {
  const me = await requireSteward();
  const rowId = String(formData.get('rowId') ?? '');
  if (!rowId) throw new ValidationError({ _form: 'Row required.' });
  const env = await getAuditEnvelope(me.id);
  const batchId = await batchIdOf(rowId);
  const rows = await withBatch(batchId, { actorId: me.id, row: rowId }, async (tx, batch) => {
    const row = await loadRow(tx, rowId);
    const parsedNow = (row.parsed ?? {}) as { fixedInApp?: boolean; fixedFrom?: FixedFrom; fixGroup?: string };
    // The rows the same fix brought back with this one (its unit). A row fixed
    // before fixGroup existed stands alone.
    const unit = parsedNow.fixGroup
      ? await tx.importRow.findMany({
          where: {
            batchId: row.batchId,
            id: { not: row.id },
            state: { in: [ImportRowState.CLEAN, ImportRowState.QUARANTINED] },
            excludedAt: null,
            parsed: { path: ['fixGroup'], equals: parsedNow.fixGroup },
          },
          select: rowSelect,
          orderBy: { rowNumber: 'asc' },
        })
      : [];
    // Withdraw undoes a fix from any row of its unit that is still waiting: the
    // row acted on, a row that came back with it (CLEAN, fixedFrom), or the
    // acted row come back held back while rows it released wait CLEAN — those
    // could be neither withdrawn nor excluded, and loaded at the next promote
    // (pre-merge review).
    const hasFix = !!parsedNow.fixedFrom || parsedNow.fixedInApp === true;
    const waiting =
      !row.excludedAt &&
      hasFix &&
      (row.state === ImportRowState.CLEAN ||
        (row.state === ImportRowState.QUARANTINED &&
          unit.some((u) => u.state === ImportRowState.CLEAN)));
    if (!waiting) {
      throw new ValidationError({ _form: `Row ${row.rowNumber} is not a fixed row waiting to be promoted.` });
    }
    // Members still carrying a fix (a held-back member without one was never
    // brought back by it).
    const siblings = unit.filter((u) => !!((u.parsed ?? {}) as { fixedFrom?: FixedFrom }).fixedFrom);
    const channelKeys = new Set(
      (await tx.channel.findMany({ select: { key: true } })).map((c) => c.key.toUpperCase())
    );
    const empty = new Map();
    for (const r of [row, ...siblings]) {
      const from = ((r.parsed ?? {}) as { fixedFrom?: FixedFrom }).fixedFrom;
      const state =
        from?.state === ImportRowState.REJECTED ? ImportRowState.REJECTED : ImportRowState.QUARANTINED;
      const issues =
        Array.isArray(from?.issues) && from.issues.length > 0
          ? (from.issues as Prisma.InputJsonValue)
          : ([{ field: '_fix', message: 'fix withdrawn by the Data Steward — correct the row again or exclude it' }] as Prisma.InputJsonValue);
      // The row as uploaded, parsed again: a withdrawn cust_code correction must
      // not leave the row carrying the code it was mistakenly given.
      const { parsed } = checkCustomerRow((r.raw ?? {}) as SheetRow, {
        channelKeys,
        phonesInFile: empty,
        crsInFile: empty,
        masterPhones: empty,
        masterCrs: empty,
      });
      const res = await tx.importRow.updateMany({
        where: { id: r.id, state: r.state, excludedAt: null },
        data: {
          state,
          issues,
          parsed: parsed as unknown as Prisma.InputJsonValue,
          corrections: Prisma.DbNull,
        },
      });
      if (res.count !== 1) {
        throw new ConflictError(
          'ROW_CHANGED',
          `Row ${r.rowNumber} changed meanwhile. Refresh and try again.`,
          // Gap 22 (part C): the withdraw lost to a write that landed first.
          { actorId: me.id, entityType: 'ImportRow', entityId: r.id, path: 'import-fix.withdraw', expectedVersion: r.state }
        );
      }
    }
    const counts = await tx.importRow.groupBy({ by: ['state'], where: { batchId: batch.id }, _count: { _all: true } });
    const n = (s: ImportRowState) => counts.find((x) => x.state === s)?._count._all ?? 0;
    // A fix on a promoted batch set it back to READY (recheck). With nothing
    // CLEAN left it is finished again, as promote itself would have left it:
    // a READY batch with nothing to promote left the Work list once its last
    // problem row was excluded, and the retention sweep never emptied its rows
    // (post-merge review). PROMOTED and REJECTED rows exist only once a promote
    // has run, so a batch never promoted stays READY.
    const finishedAgain =
      batch.status === 'READY' &&
      n(ImportRowState.CLEAN) === 0 &&
      n(ImportRowState.PROMOTED) + n(ImportRowState.REJECTED) > 0;
    await tx.importBatch.update({
      where: { id: batch.id },
      data: {
        quarantinedRows: n(ImportRowState.QUARANTINED),
        rejectedRows: n(ImportRowState.REJECTED),
        ...(finishedAgain ? { status: 'PROMOTED' as const } : {}),
      },
    });
    await audit(tx, env, 'UPDATE', row.id, 'Import row fix withdrawn by the Data Steward', {
      rows: 1 + siblings.length,
    });
    return 1 + siblings.length;
  });
  done(batchId);
  return { rows };
}

// ── Accept as excluded / include again ──────────────────────────────────────

export async function excludeImportRowsAction(
  formData: FormData
): SafeAction<{ excluded: number }> {
  return runAction(() => excludeCore(formData));
}

async function excludeCore(formData: FormData): Promise<{ excluded: number }> {
  const me = await requireSteward();
  const batchId = String(formData.get('batchId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const which = String(formData.get('rowIds') ?? '');
  if (!batchId) throw new ValidationError({ _form: 'Batch required.' });
  if (reason.length < MIN_REASON) {
    throw new ValidationError({
      reason: `Say why these rows stay out (${MIN_REASON}+ characters).`,
    });
  }
  let rowIds: string[] | 'all';
  if (which === 'all') rowIds = 'all';
  else {
    try {
      const v = JSON.parse(which);
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string'))
        throw new Error();
      rowIds = v;
    } catch {
      throw new ValidationError({ _form: 'Choose the rows to exclude.' });
    }
  }
  const env = await getAuditEnvelope(me.id);
  const excluded = await withBatch(batchId, { actorId: me.id, row: 'excluded' }, async (tx) => {
    const res = await tx.importRow.updateMany({
      where: {
        batchId,
        state: { in: PROBLEM },
        excludedAt: null,
        ...(rowIds === 'all' ? {} : { id: { in: rowIds } }),
      },
      data: { excludedAt: new Date(), excludedById: me.id, excludedReason: reason },
    });
    if (res.count === 0)
      throw new ValidationError({ _form: 'No held-back or rejected row left to exclude.' });
    await writeAudit(tx, env, {
      action: 'UPDATE',
      entityType: 'ImportBatch',
      entityId: batchId,
      reason: `Import rows accepted as excluded: ${reason}`,
      after: { excluded: res.count } as unknown as Prisma.InputJsonValue,
    });
    return res.count;
  });
  done(batchId);
  return { excluded };
}

export async function includeImportRowAction(formData: FormData): SafeAction<void> {
  return runAction(() => includeCore(formData));
}

async function includeCore(formData: FormData): Promise<void> {
  const me = await requireSteward();
  const rowId = String(formData.get('rowId') ?? '');
  if (!rowId) throw new ValidationError({ _form: 'Row required.' });
  const env = await getAuditEnvelope(me.id);
  const batchId = await batchIdOf(rowId);
  await withBatch(batchId, { actorId: me.id, row: rowId }, async (tx) => {
    const res = await tx.importRow.updateMany({
      where: { id: rowId, excludedAt: { not: null } },
      data: { excludedAt: null, excludedById: null, excludedReason: null },
    });
    if (res.count === 0) throw new ValidationError({ _form: 'This row is not excluded.' });
    await audit(tx, env, 'UPDATE', rowId, 'Import row included again by the Data Steward', {});
  });
  done(batchId);
}

// ── The batch's "Overwrite CRM fields from this sheet" option ────────────────

/**
 * Code review 2026-11-10, finding 1. A customer import only FILLS blank
 * CRM-owned fields of a customer or shop that already exists, and never changes
 * its open/closed status (lib/import-crm-rule.ts). For a deliberate bulk
 * correction the Data Steward — nobody else — can switch that off for ONE batch:
 * with this option on, the sheet's name, phone, CR number, contact person,
 * channel, shop name, address, visit day and status replace what is on record,
 * as every re-import did before.
 *
 *  - Off by default; switching it on needs a written reason, kept in the audit
 *    row of the switch (UPDATE on the batch, before and after).
 *  - Only while the batch is ready to promote. Not in the middle of a load: a
 *    batch part-way through a promote must finish under the option it started
 *    with, or half its customers would be loaded one way and half the other.
 *  - Under the batch's row lock, which the promote's claim also takes, and the
 *    claim only takes the batch with the option as it read it
 *    (services/imports.ts), so the two cannot cross.
 *  - The promote switches it off again when the batch finishes.
 */
export async function setImportOverwriteAction(formData: FormData): SafeAction<{ on: boolean }> {
  return runAction(() => setOverwriteCore(formData));
}

const MIN_OVERWRITE_REASON = 10;
const MAX_OVERWRITE_REASON = 500;

async function setOverwriteCore(formData: FormData): Promise<{ on: boolean }> {
  const me = await requireSteward();
  const batchId = String(formData.get('batchId') ?? '');
  const which = String(formData.get('on') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!batchId) throw new ValidationError({ _form: 'Batch required.' });
  if (which !== 'on' && which !== 'off') {
    throw new ValidationError({ _form: 'Say whether the option is to be on or off.' });
  }
  const on = which === 'on';
  if (on && reason.length < MIN_OVERWRITE_REASON) {
    throw new ValidationError({
      reason: `Say why this sheet should replace CRM fields (${MIN_OVERWRITE_REASON}+ characters).`,
    });
  }
  if (on && reason.length > MAX_OVERWRITE_REASON) {
    throw new ValidationError({
      reason: `Keep the reason to ${MAX_OVERWRITE_REASON} characters or fewer.`,
    });
  }
  const env = await getAuditEnvelope(me.id);
  await withBatch(batchId, { actorId: me.id, row: 'overwrite' }, async (tx, batch) => {
    if (batch.status === 'PROMOTING') {
      throw new ValidationError({
        _form:
          'This batch is part-way through a promote — resume it first. The option cannot change in the middle of a load.',
      });
    }
    if (batch.status !== 'READY' && batch.status !== 'FAILED') {
      throw new ValidationError({
        _form: 'Only a batch that is ready to promote can change this option.',
      });
    }
    if (batch.overwriteCrmFields === on) {
      throw new ValidationError({
        _form: `The option is already ${on ? 'on' : 'off'} for this batch.`,
      });
    }
    await tx.importBatch.update({
      where: { id: batch.id },
      // overwriteCrmFieldsAt is when the option was last switched ON, and is
      // never cleared: it is what tells the batch page that this batch has had
      // it on at some time, after the promote has switched it off again.
      data: { overwriteCrmFields: on, ...(on ? { overwriteCrmFieldsAt: new Date() } : {}) },
    });
    await writeAudit(tx, env, {
      action: 'UPDATE',
      entityType: 'ImportBatch',
      entityId: batch.id,
      before: { overwriteCrmFields: !on } as Prisma.InputJsonValue,
      after: { overwriteCrmFields: on } as Prisma.InputJsonValue,
      reason: on
        ? `Overwrite CRM fields from this sheet switched ON: ${reason}`
        : 'Overwrite CRM fields from this sheet switched off',
    });
  });
  done(batchId);
  return { on };
}

// ── Discard a staged batch ──────────────────────────────────────────────────

/**
 * Code review 2026-11-10, finding 6: the Data Steward throws away a customer
 * batch that is staged (READY), or whose promote stopped part-way (PROMOTING
 * with no live lease, or the old FAILED), so that it can never be promoted or
 * resumed and leaves his Work list. With a written reason, audited as an UPDATE
 * on the batch (its status before and after, the rows still waiting to load).
 *
 * Nothing is deleted or changed in its rows: the rows a stopped promote already
 * loaded stay loaded, and the retention rules handle the rest as before. Under
 * the batch's row lock, which the promote's claim also takes; a live promote is
 * refused (withBatch).
 */
export async function discardImportBatchAction(formData: FormData): SafeAction<{ status: 'DISCARDED' }> {
  return runAction(() => discardCore(formData));
}

const MAX_DISCARD_REASON = 500;

async function discardCore(formData: FormData): Promise<{ status: 'DISCARDED' }> {
  const me = await requireSteward();
  const batchId = String(formData.get('batchId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!batchId) throw new ValidationError({ _form: 'Batch required.' });
  if (reason.length < MIN_REASON) {
    throw new ValidationError({ reason: `Say why this batch is discarded (${MIN_REASON}+ characters).` });
  }
  if (reason.length > MAX_DISCARD_REASON) {
    throw new ValidationError({ reason: `Keep the reason to ${MAX_DISCARD_REASON} characters or fewer.` });
  }
  const env = await getAuditEnvelope(me.id);
  await withBatch(batchId, { actorId: me.id, row: 'discard' }, async (tx, batch) => {
    if (batch.status !== 'READY' && batch.status !== 'PROMOTING' && batch.status !== 'FAILED') {
      throw new ValidationError({
        _form: `Only a batch that is staged or whose promote stopped part-way can be discarded; this one is ${batch.status}.`,
      });
    }
    const waiting = await tx.importRow.count({ where: { batchId: batch.id, state: ImportRowState.CLEAN } });
    const loaded = await tx.importRow.count({ where: { batchId: batch.id, state: ImportRowState.PROMOTED } });
    await tx.importBatch.update({
      where: { id: batch.id },
      data: { status: 'DISCARDED', promoteLeaseBy: null, promoteLeaseUntil: null, overwriteCrmFields: false },
    });
    await writeAudit(tx, env, {
      action: 'UPDATE',
      entityType: 'ImportBatch',
      entityId: batch.id,
      before: { status: batch.status } as Prisma.InputJsonValue,
      after: { status: 'DISCARDED', rowsNotLoaded: waiting, rowsLoadedBefore: loaded } as Prisma.InputJsonValue,
      reason: `Import batch discarded by the Data Steward: ${reason}`,
    });
  });
  done(batchId);
  return { status: 'DISCARDED' };
}

// ── Rows loaded with their shop NOT changed: acknowledged ───────────────────

/**
 * Code review 2026-11-10, finding 28 (second round). A promote counts on the
 * batch the rows it loaded with their shop NOT changed (ImportBatch
 * .shopNotChangedRows, services/imports.ts). The batch page shows that notice
 * until the Data Steward acknowledges it — after a refresh, a reload or on any
 * later visit — and this records the acknowledgement: how many rows, when and
 * who on the batch, and an AuditLog UPDATE row on the batch.
 *
 * `rows` is the total the notice showed. Rows a later promote of the batch adds
 * (a fixed row loaded afterwards) are not covered by it: the notice comes back
 * for them. A second tap on the same notice changes nothing and writes no
 * audit row. Refused while a promote is running on the batch (its count is
 * still rising). Steward only, like every action on the batch page.
 */
export async function acknowledgeShopsNotChangedAction(
  formData: FormData
): SafeAction<{ acknowledged: number; total: number }> {
  return runAction(() => acknowledgeShopsNotChangedCore(formData));
}

async function acknowledgeShopsNotChangedCore(formData: FormData): Promise<{ acknowledged: number; total: number }> {
  const me = await requireActor();
  if (me.role !== Role.STEWARD) {
    throw new ForbiddenError('Only the Data Steward can acknowledge this notice.');
  }
  const batchId = String(formData.get('batchId') ?? '');
  if (!batchId) throw new ValidationError({ _form: 'Batch required.' });
  const seen = Number(String(formData.get('rows') ?? ''));
  if (!Number.isInteger(seen) || seen < 1) {
    throw new ValidationError({ _form: 'Say how many rows the notice showed.' });
  }
  const env = await getAuditEnvelope(me.id);
  const out = await withChangeContext(
    prisma,
    { actorId: me.id, source: src.importFix(batchId, 'shops-not-changed') },
    async (tx) => {
      const [batch] = await tx.$queryRaw<
        Array<{ id: string; status: string; promoteLeaseUntil: Date | null; rows: number; acked: number }>
      >`
        SELECT "id", "status"::text AS "status", "promoteLeaseUntil",
               "shopNotChangedRows" AS "rows", "shopNotChangedAckRows" AS "acked"
          FROM "ImportBatch" WHERE "id" = ${batchId} FOR UPDATE`;
      if (!batch) throw new NotFoundError('Import batch not found.');
      if (batch.status === 'PROMOTING' && batch.promoteLeaseUntil && batch.promoteLeaseUntil > new Date()) {
        throw new ConflictError(
          'BATCH_PROMOTING',
          'This batch is being promoted right now — wait for it to finish, then acknowledge the notice.'
        );
      }
      if (seen > batch.rows) {
        throw new ValidationError({ _form: 'This page is out of date — reload it and read the notice again.' });
      }
      // Already acknowledged (a second tap, or another tab): nothing to record.
      if (seen <= batch.acked) return { acknowledged: 0, total: batch.rows };
      await tx.importBatch.update({
        where: { id: batch.id },
        data: { shopNotChangedAckRows: seen, shopNotChangedAckAt: new Date(), shopNotChangedAckById: me.id },
      });
      await writeAudit(tx, env, {
        action: 'UPDATE',
        entityType: 'ImportBatch',
        entityId: batch.id,
        before: { shopNotChangedAckRows: batch.acked } as Prisma.InputJsonValue,
        after: {
          shopNotChangedAckRows: seen,
          shopNotChangedRows: batch.rows,
          acknowledged: seen - batch.acked,
        } as Prisma.InputJsonValue,
        reason: `Rows loaded with something about their shop not applied (shop NOT changed, or route not applied), acknowledged by the Data Steward: ${seen - batch.acked}`,
      });
      return { acknowledged: seen - batch.acked, total: batch.rows };
    },
    { timeout: 20_000, maxWait: 10_000 }
  );
  done(batchId);
  return out;
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function audit(
  tx: Tx,
  env: AuditEnvelope,
  action: 'UPDATE' | 'FORCE_OVERRIDE',
  rowId: string,
  reason: string,
  after: Record<string, unknown>
) {
  await writeAudit(tx, env, {
    action,
    entityType: 'ImportRow',
    entityId: rowId,
    reason,
    after: after as unknown as Prisma.InputJsonValue,
  });
}
