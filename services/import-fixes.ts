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
import { ImportRowState, Prisma, Role } from '@prisma/client';
import { auth } from '@/lib/auth';
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
import {
  checkCustomerRow,
  rowCrNorm,
  rowBranchCode,
  rowCustCode,
  rowPhoneNorm,
  type FileDup,
  type SheetRow,
} from '@/lib/import-row-check';
import {
  fixTarget,
  masterCollisionMaps,
  newerUploadsCarrying,
  type FixTarget,
} from '@/lib/import-master-lookup';
import {
  acceptCells,
  canReleasePhone,
  changedCells,
  correctedRow,
  fixWindowClosed,
  fixWindowMessage,
  newerUploadMessage,
  readCorrections,
  type Corrections,
} from '@/lib/import-row-fix';

type Tx = Prisma.TransactionClient;

async function requireSteward() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  if (session.user.role !== Role.STEWARD) {
    throw new ForbiddenError('Only the Data Steward can fix import rows.');
  }
  return session.user;
}

type LockedBatch = {
  id: string;
  kind: string;
  status: string;
  promoteLeaseUntil: Date | null;
  uploadedAt: Date;
  filename: string;
};

const MIN_REASON = 5;
const PROBLEM: ImportRowState[] = [ImportRowState.QUARANTINED, ImportRowState.REJECTED];

/** Lock the batch, refuse while a promote is running on it, then run `fn`. */
async function withBatch<T>(
  batchId: string,
  fn: (tx: Tx, batch: LockedBatch) => Promise<T>
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      const [batch] = await tx.$queryRaw<LockedBatch[]>`
        SELECT "id", "kind", "status"::text AS "status", "promoteLeaseUntil", "uploadedAt", "filename"
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
  rows: Array<{ row: RowForFix; c: Corrections }>
) {
  const targets: FixTarget[] = [];
  for (const { row, c } of rows) {
    const now = correctedRow(row.raw, c);
    const branch = rowBranchCode(now);
    const codes = new Set(
      [rowCustCode(now), (row.parsed as { custCode?: string } | null)?.custCode].filter(
        (x): x is string => !!x
      )
    );
    for (const code of codes) targets.push(fixTarget(String(targets.length), code, branch));
  }
  const newer = await newerUploadsCarrying(tx, batch.uploadedAt, targets);
  const hit = targets.find((t) => newer.has(t.key));
  if (hit) throw new ConflictError('NEWER_UPLOAD', newerUploadMessage(hit.code, newer.get(hit.key)!));
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
  actedRowId: string
): Promise<{ clean: number; held: number }> {
  const targetIds = new Set(targets.map((t) => t.id));
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
    }>
  >`
    SELECT "id", "rowNumber", "parsed"->>'custCode' AS "code", "parsed"->>'phone' AS "phone", "parsed"->>'crNumber' AS "cr"
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
  for (const o of others) {
    if (targetIds.has(o.id)) continue;
    add(phonesInFile, o.phone, { row: o.rowNumber, code: o.code ?? '' });
    add(crsInFile, normalizeCR(o.cr), { row: o.rowNumber, code: o.code ?? '' });
  }
  for (const { t, row } of corrected) {
    add(phonesInFile, rowPhoneNorm(row), { row: t.rowNumber, code: rowCustCode(row) });
    add(crsInFile, rowCrNorm(row), { row: t.rowNumber, code: rowCustCode(row) });
  }
  const { masterPhones, masterCrs } = await masterCollisionMaps(
    corrected.map((x) => rowPhoneNorm(x.row)).filter((v): v is string => !!v),
    corrected.map((x) => rowCrNorm(x.row)).filter((v): v is string => !!v)
  );
  const channelKeys = new Set(
    (await tx.channel.findMany({ select: { key: true } })).map((c) => c.key.toUpperCase())
  );
  const ctx = { channelKeys, phonesInFile, crsInFile, masterPhones, masterCrs };

  let clean = 0;
  let held = 0;
  for (const { t, c, row } of corrected) {
    const { parsed, issues } = checkCustomerRow(row as SheetRow, ctx, {
      phoneReleased: !!c.phoneReleased,
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
        parsed: {
          ...parsed,
          ...(fixedInApp ? { fixedInApp: true } : {}),
          fixedFrom,
        } as unknown as Prisma.InputJsonValue,
        issues: issues.length > 0 ? (issues as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        corrections:
          Object.keys(c).length > 0 ? (c as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
    if (res.count !== 1) {
      throw new ConflictError(
        'ROW_CHANGED',
        `Row ${t.rowNumber} changed while you were fixing it. Refresh and try again.`
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
  const result = await withBatch(batchId, async (tx, batch) => {
    const row = await loadRow(tx, rowId);
    assertFixable(row);
    const targets = await targetsFor(tx, row);
    await refuseIfNewerUpload(
      tx,
      batch,
      targets.map((t) => ({ row: t, c: readCorrections(t.corrections) }))
    );
    const r = await recheck(tx, batch, targets, (t) => readCorrections(t.corrections), row.id);
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
  const result = await withBatch(batchId, async (tx, batch) => {
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
    const merged: Corrections = { ...mine, cells: { ...(mine.cells ?? {}), ...changed } };
    const targets = await targetsFor(tx, row);
    const correctionsFor = (t: RowForFix) => (t.id === row.id ? merged : readCorrections(t.corrections));
    // A corrected customer or branch code is the identity the newest-upload
    // rule is about, so each row is judged with its corrections laid over.
    await refuseIfNewerUpload(
      tx,
      batch,
      targets.map((t) => ({ row: t, c: correctionsFor(t) }))
    );
    const r = await recheck(tx, batch, targets, correctionsFor, row.id);
    // Column names only. The values are customer data, and this ledger keeps
    // them for ever; the row itself holds them until the retention sweep.
    await audit(tx, env, 'UPDATE', row.id, 'Import row corrected by the Data Steward', {
      columns: Object.keys(changed).sort(),
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
  const result = await withBatch(batchId, async (tx, batch) => {
    const row = await loadRow(tx, rowId);
    assertFixable(row);
    if (row.state !== ImportRowState.QUARANTINED || !canReleasePhone(row.issues)) {
      throw new ValidationError({
        _form:
          'Only a row held back solely because its phone is on another customer can be released.',
      });
    }
    const merged: Corrections = { ...readCorrections(row.corrections), phoneReleased: { reason } };
    await refuseIfNewerUpload(tx, batch, [{ row, c: merged }]);
    const r = await recheck(tx, batch, [row], () => merged, row.id);
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
 * without the row that carried its phone (post-merge review).
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
  const rows = await withBatch(batchId, async (tx, batch) => {
    const row = await loadRow(tx, rowId);
    const parsedNow = (row.parsed ?? {}) as { fixedInApp?: boolean; fixedFrom?: FixedFrom };
    if (row.state !== ImportRowState.CLEAN || parsedNow.fixedInApp !== true || row.excludedAt) {
      throw new ValidationError({ _form: `Row ${row.rowNumber} is not a fixed row waiting to be promoted.` });
    }
    // The customer's other rows a fix released from REJECTED: they were
    // rejected together with this one, and go back together. Matched on the
    // code the row carries now and the one it was uploaded with, in case the
    // fix corrected cust_code.
    const codes = [
      ...new Set(
        [(row.parsed as { custCode?: string } | null)?.custCode, rowCustCode((row.raw ?? {}) as SheetRow)].filter(
          (x): x is string => !!x
        )
      ),
    ];
    const siblings = (
      await tx.importRow.findMany({
        where: {
          batchId: row.batchId,
          id: { not: row.id },
          state: ImportRowState.CLEAN,
          excludedAt: null,
          OR: codes.map((code) => ({ parsed: { path: ['custCode'], equals: code } })),
        },
        select: rowSelect,
        orderBy: { rowNumber: 'asc' },
      })
    ).filter(
      (s) => ((s.parsed ?? {}) as { fixedFrom?: FixedFrom }).fixedFrom?.state === ImportRowState.REJECTED
    );
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
        where: { id: r.id, state: ImportRowState.CLEAN, excludedAt: null },
        data: {
          state,
          issues,
          parsed: parsed as unknown as Prisma.InputJsonValue,
          corrections: Prisma.DbNull,
        },
      });
      if (res.count !== 1) {
        throw new ConflictError('ROW_CHANGED', `Row ${r.rowNumber} changed meanwhile. Refresh and try again.`);
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
  const excluded = await withBatch(batchId, async (tx) => {
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
  await withBatch(batchId, async (tx) => {
    const res = await tx.importRow.updateMany({
      where: { id: rowId, excludedAt: { not: null } },
      data: { excludedAt: null, excludedById: null, excludedReason: null },
    });
    if (res.count === 0) throw new ValidationError({ _form: 'This row is not excluded.' });
    await audit(tx, env, 'UPDATE', rowId, 'Import row included again by the Data Steward', {});
  });
  done(batchId);
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
