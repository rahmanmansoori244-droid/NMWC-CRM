'use server';

/**
 * The daily Temix import, stage 3: upload and staging (the merged plan, design
 * B: a module of its own, apart from the Import screen).
 *
 * The Data Steward uploads the day's Temix export (.xlsx or .csv, up to the
 * Import screen's 4.2 MB). The file's SHA-256 and size are taken first; its
 * headings are checked (lib/temix-daily-file.ts: the agreed columns, a customer
 * master refused); the same bytes are refused for the same load day and a file
 * is never staged behind a later day's (lib/temix-daily-order.ts); then the
 * file and every row are staged in ONE transaction, with one AuditLog row.
 *
 * NOTHING IS APPLIED TO CUSTOMERS. Upload writes only TemixDailyFile,
 * TemixDailyRow and AuditLog: no Customer, Branch, history or ledger row. The
 * Check (stage 4) and the Apply (stage 5) come later. ImportBatch and ImportRow
 * are not touched, so the Import screen's rule that no import file moves a
 * shop (tests/unit/import-shop-route-guard.test.ts) is exactly as it was.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { AuditAction, Prisma, Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireActor } from '@/lib/session';
import { ForbiddenError, RateLimitError, ValidationError, runAction, type SafeAction } from '@/lib/errors';
import { checkLimit } from '@/lib/rate-limit';
import { MAX_IMPORT_BYTES, importFileTooLarge } from '@/lib/import-file-size';
import { duplicateHeadingIssue, parseWorkbook } from '@/lib/excel';
import { sha256Hex } from '@/lib/fingerprint';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import { src, withChangeContext } from '@/lib/change-context';
import { CsvReadError, parseCsv } from '@/lib/temix-daily-csv';
import {
  dailyHeadingRefusal,
  notesAtUpload,
  reportDailyHeadings,
  sortedNotes,
  stageDailyRows,
  type DailySheetRow,
} from '@/lib/temix-daily-file';
import {
  applyBlockedBy,
  dateColumnDay,
  sameBytesEarlier,
  stagingRefusal,
  type DailyFileForOrder,
} from '@/lib/temix-daily-order';
import { dailyFileKind, dailyFileKindRefusal, dailyFileName } from '@/lib/temix-daily-upload';

export type TemixDailyUploadResult = {
  fileId: string;
  loadDay: string;
  rows: number;
  /** Rows carrying a note found at upload (lib/temix-daily-file.ts). */
  rowsWithNotes: number;
  /** Headings that are not read. */
  notRead: string[];
  /** Sheets of the workbook after the first, which are not read. */
  otherSheets: string[];
  /** An earlier day's file with exactly these bytes (the warning). */
  sameBytesAs: { loadDay: string; filename: string } | null;
  /** The earlier file that must be applied or discarded first. */
  waitsFor: { loadDay: string; filename: string } | null;
};

/** Rows inserted per statement. */
const ROW_CHUNK = 1000;

async function requireSteward() {
  const user = await requireActor();
  if (user.role !== Role.STEWARD) {
    throw new ForbiddenError('Only the Data Steward can upload the Temix daily file.');
  }
  return user;
}

export async function uploadTemixDailyFileAction(formData: FormData): SafeAction<TemixDailyUploadResult> {
  return runAction(() => uploadTemixDailyFileCore(formData));
}

async function uploadTemixDailyFileCore(formData: FormData): Promise<TemixDailyUploadResult> {
  const me = await requireSteward();
  const lim = await checkLimit(`temix-daily:${me.id}`, { capacity: 3, refillPerSec: 0.05 });
  if (!lim.ok) throw new RateLimitError(`Wait ${lim.retryAfterSec}s before another upload.`);

  const file = formData.get('file');
  if (!(file instanceof File)) throw new ValidationError({ file: 'No file uploaded.' });
  if (file.size > MAX_IMPORT_BYTES) throw new ValidationError({ file: importFileTooLarge(file.size) });
  const buf = Buffer.from(await file.arrayBuffer());
  // The file's identity first: what was uploaded is recorded as it came.
  const sha256 = sha256Hex(buf);
  const bytes = buf.length;
  const filename = dailyFileName(file.name);

  const kind = dailyFileKind(file.name, buf);
  const kindRefusal = dailyFileKindRefusal(kind, buf.length);
  if (kindRefusal || kind === null) throw new ValidationError({ file: kindRefusal ?? 'Unreadable file.' });

  let sheet: { name: string; headers: string[]; rows: DailySheetRow[]; rowNumbers: number[]; duplicateHeadings: Array<{ heading: string; first: string; again: string }> };
  let otherSheets: string[] = [];
  try {
    if (kind === 'csv') {
      sheet = parseCsv(buf, 'CSV');
    } else {
      const sheets = await parseWorkbook(buf);
      if (!sheets[0]) throw new ValidationError({ file: 'The workbook has no sheet.' });
      sheet = sheets[0];
      otherSheets = sheets.slice(1).map((s) => s.name);
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    const why = err instanceof CsvReadError ? err.message : `Could not read the file: ${(err as Error).message}`;
    throw new ValidationError({ file: why });
  }
  const repeated = duplicateHeadingIssue(sheet as Parameters<typeof duplicateHeadingIssue>[0]);
  if (repeated) throw new ValidationError({ file: `${repeated} Nothing was uploaded.` });
  const report = reportDailyHeadings(sheet.headers);
  const refusal = dailyHeadingRefusal(report);
  if (refusal) throw new ValidationError({ file: refusal });
  if (sheet.rows.length === 0) throw new ValidationError({ file: 'The file has headings but no rows. Nothing was uploaded.' });

  const staged = stageDailyRows(sheet, report);
  const fileId = randomUUID();
  const env = await getAuditEnvelope(me.id);

  try {
    const out = await withChangeContext(
      prisma,
      { actorId: me.id, source: src.temixDailyUpload(fileId) },
      async (tx) => {
        // One upload at a time decides the same-file and order rules.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('nmwc:temix-daily:upload', 42))`;
        // The load day is the database's Oman day, the one its guard checks, and
        // the upload time is the same instant, read AFTER the lock: the order
        // rule ranks files by uploadedAt, so it must follow the lock's order (the
        // column's default is the transaction's start, which may come before
        // another upload that took the lock first) and fall on the load day.
        const [{ day, at }] = await tx.$queryRaw<Array<{ day: string; at: Date }>>`
          SELECT to_char((t.at AT TIME ZONE 'Asia/Muscat')::date, 'YYYY-MM-DD') AS "day", t.at AS "at"
            FROM (SELECT clock_timestamp() AS at) t`;
        const loadDay = day;
        const uploadedAt = at;
        const others: DailyFileForOrder[] = (
          await tx.temixDailyFile.findMany({
            where: {
              state: { not: 'DISCARDED' },
              OR: [
                { fileSha256: sha256 },
                { loadDay: { gt: new Date(`${loadDay}T00:00:00Z`) } },
                { state: { notIn: ['LOADED', 'DISCARDED'] } },
              ],
            },
            select: { id: true, filename: true, loadDay: true, uploadedAt: true, state: true, fileSha256: true },
          })
        ).map((f) => ({ ...f, loadDay: dateColumnDay(f.loadDay) }));
        const upload = { loadDay, sha256 };
        const refused = stagingRefusal(upload, others);
        if (refused) throw new ValidationError({ file: refused });
        const same = sameBytesEarlier(upload, others);

        await tx.temixDailyFile.create({
          data: {
            id: fileId,
            filename,
            loadDay: new Date(`${loadDay}T00:00:00Z`),
            uploadedAt,
            uploadedById: me.id,
            fileSha256: sha256,
            fileBytes: bytes,
            headings: {
              kind,
              sheet: sheet.name,
              read: report.read,
              notRead: report.notRead,
              otherSheets,
              // The notes found at upload, counted once here so the list never
              // scans the rows: code words and numbers only.
              notesAtUpload: notesAtUpload(staged),
            } as Prisma.InputJsonValue,
            totalRows: staged.length,
            sameBytesAsFileId: same?.id ?? null,
          },
        });
        for (let i = 0; i < staged.length; i += ROW_CHUNK) {
          await tx.temixDailyRow.createMany({
            data: staged.slice(i, i + ROW_CHUNK).map((r) => ({
              fileId,
              rowNumber: r.rowNumber,
              raw: r.raw as Prisma.InputJsonValue,
              parsed: r.parsed as unknown as Prisma.InputJsonValue,
              custCodeKey: r.custCodeKey,
              branchCodeKey: r.branchCodeKey,
              holdReasons: sortedNotes(r.notes),
            })),
          });
        }
        const rowsWithNotes = staged.filter((r) => r.notes.length > 0).length;
        const self: DailyFileForOrder = {
          id: fileId,
          filename,
          loadDay,
          uploadedAt,
          state: 'STAGED',
          fileSha256: sha256,
        };
        const waits = applyBlockedBy(self, others);
        // Codes, counts and the file's identity only: never a value from a row,
        // and not the file's name (free text the uploader chose; it is kept on
        // the TemixDailyFile row that entityId names).
        await writeAudit(tx, env, {
          action: AuditAction.IMPORT,
          entityType: 'TemixDailyFile',
          entityId: fileId,
          after: {
            kind: 'TEMIX_DAILY_UPLOAD',
            loadDay,
            fileSha256: sha256,
            fileBytes: bytes,
            rows: staged.length,
            rowsWithNotes,
            notRead: report.notRead.length,
            sameBytesAsFileId: same?.id ?? null,
          },
        });
        return {
          fileId,
          loadDay,
          rows: staged.length,
          rowsWithNotes,
          notRead: report.notRead,
          otherSheets,
          sameBytesAs: same ? { loadDay: same.loadDay, filename: same.filename } : null,
          waitsFor: waits ? { loadDay: waits.loadDay, filename: waits.filename } : null,
        };
      },
      { timeout: 60_000, maxWait: 10_000 }
    );
    revalidatePath('/temix-daily');
    return out;
  } catch (err) {
    // The database's own same-file rule (TemixDailyFile_sha_day_live_unique),
    // should the check above ever be passed by.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ValidationError({
        file: 'This exact file was already uploaded for today. The same file is taken once per day. Nothing was uploaded.',
      });
    }
    throw err;
  }
}
