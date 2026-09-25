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
  rowCustCode,
  rowPhoneNorm,
  type FileDup,
  type SheetRow,
} from '@/lib/import-row-check';
import { masterCollisionMaps } from '@/lib/import-master-lookup';
import {
  acceptCells,
  canReleasePhone,
  correctedRow,
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
 * Fix only in the newest upload that carries the customer. On 2026-09-23 the
 * same customers were in three batches; re-checking a row of an older one
 * would load that older data over what the newer upload wrote.
 */
async function refuseIfNewerUpload(tx: Tx, batch: LockedBatch, codes: string[]) {
  if (codes.length === 0) return;
  const newer = await tx.importRow.findFirst({
    where: {
      batch: { kind: 'CUSTOMER', uploadedAt: { gt: batch.uploadedAt } },
      OR: codes.map((c) => ({ parsed: { path: ['custCode'], equals: c } })),
    },
    select: { batch: { select: { filename: true, uploadedAt: true } }, parsed: true },
  });
  if (newer) {
    const code = (newer.parsed as { custCode?: string } | null)?.custCode ?? codes[0];
    throw new ConflictError(
      'NEWER_UPLOAD',
      `A newer upload, "${newer.batch.filename}", also carries customer ${code}. Fix the row there instead — fixing this older one would load older data over it.`
    );
  }
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
  correctionsFor: (row: RowForFix) => Corrections
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
    const res = await tx.importRow.updateMany({
      where: { id: t.id, state: t.state, excludedAt: null },
      data: {
        state: nextState,
        // fixedInApp: promote may then create or update this row's branch even
        // for a customer linked to Temix (owner decision, "branch only").
        parsed: { ...parsed, fixedInApp: true } as unknown as Prisma.InputJsonValue,
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
    await refuseIfNewerUpload(tx, batch, codesOf(targets));
    const r = await recheck(tx, batch, targets, (t) => readCorrections(t.corrections));
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
    const merged: Corrections = { ...mine, cells: { ...(mine.cells ?? {}), ...accepted.cells } };
    const targets = await targetsFor(tx, row);
    // A corrected customer code is the identity the newest-upload rule is about.
    await refuseIfNewerUpload(tx, batch, [
      ...codesOf(targets),
      ...(accepted.cells.cust_code ? [accepted.cells.cust_code] : []),
    ]);
    const r = await recheck(tx, batch, targets, (t) =>
      t.id === row.id ? merged : readCorrections(t.corrections)
    );
    // Column names only. The values are customer data, and this ledger keeps
    // them for ever; the row itself holds them until the retention sweep.
    await audit(tx, env, 'UPDATE', row.id, 'Import row corrected by the Data Steward', {
      columns: Object.keys(accepted.cells).sort(),
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
    await refuseIfNewerUpload(tx, batch, codesOf([row]));
    const merged: Corrections = { ...readCorrections(row.corrections), phoneReleased: { reason } };
    const r = await recheck(tx, batch, [row], () => merged);
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

function codesOf(rows: RowForFix[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const code = (r.parsed as { custCode?: string } | null)?.custCode;
    if (code) out.add(code);
  }
  return [...out];
}

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
