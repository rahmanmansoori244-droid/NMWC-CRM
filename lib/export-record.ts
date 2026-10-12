/**
 * Gap 14 (data audit 2026-10-10, lossless paths): every export that leaves the
 * building is recorded — who took it, with which filters and role scope, which
 * customers it held, and the SHA-256 of the exact bytes sent — so a customer list
 * found outside the company can be matched to the export it came from.
 *
 * One transaction, written BEFORE the bytes are sent (fail-closed, as the EXPORT
 * row always was): an ExportJob row (append-only since migration 20261014100000)
 * and its EXPORT audit row, whose entityId is the job's id. The file itself is
 * never stored (owner decision: a stored export is a new copy of PII at rest).
 *
 * The four exports call this: the customer master (services/exports.ts), the
 * filtered customer list (services/customer-export.ts), the field-update report
 * (app/api/exports/changes/route.ts) and the Temix upload file, on Generate and
 * on every re-download (services/temix.ts) — the largest of them: names, phones,
 * CR numbers, addresses and credit limits of every customer in the batch.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { src, withChangeContext } from '@/lib/change-context';
import { writeAudit, type AuditEnvelope } from '@/lib/audit';
import { sha256Hex } from '@/lib/fingerprint';

export type ExportKind = 'customer-master' | 'customers-filtered' | 'field-updates' | 'temix-batch';

export type ExportRecord = {
  kind: ExportKind;
  /** The validated filters and the role scope they were applied within. */
  filters: Prisma.InputJsonObject;
  /** The customers whose rows the file holds (deduplicated here). */
  customerIds: Iterable<string>;
  bytes: Uint8Array | ArrayBuffer;
  filename: string;
  rowCount: number;
  /** The EXPORT row's reason, as each export always wrote it. */
  reason: string;
};

/** The SHA-256 (hex) of the bytes as they will be sent. */
export function exportSha256(bytes: Uint8Array | ArrayBuffer): string {
  return sha256Hex(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

/** Record an export, then let the caller send the bytes. Throws: no record, no file. */
export async function recordExport(
  env: AuditEnvelope,
  x: ExportRecord
): Promise<{ exportJobId: string; fileSha256: string }> {
  const fileSha256 = exportSha256(x.bytes);
  const customerIds = [...new Set(x.customerIds)].sort();
  return withChangeContext(prisma, { actorId: env.actorId, source: src.export(x.kind) }, async (tx) => {
    const job = await tx.exportJob.create({
      data: {
        requestedById: env.actorId,
        filters: x.filters,
        status: 'DONE',
        rowCount: x.rowCount,
        completedAt: new Date(),
        kind: x.kind,
        fileSha256,
        filename: x.filename,
        customerIds,
      },
      select: { id: true },
    });
    await writeAudit(tx, env, {
      action: 'EXPORT',
      entityType: 'Export',
      entityId: job.id,
      reason: x.reason,
      after: {
        exportJobId: job.id,
        kind: x.kind,
        filters: x.filters,
        rowCount: x.rowCount,
        customers: customerIds.length,
        fileSha256,
        filename: x.filename,
      } as Prisma.InputJsonObject,
    });
    return { exportJobId: job.id, fileSha256 };
  });
}
