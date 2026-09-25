import { TableScroll } from '@/components/nmwc/TableScroll';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ImportRowState, Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { PromoteButton } from './PromoteButton';

export const metadata = { title: 'Import batch · NMWC' };

export default async function ImportBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // RBAC-05-009: STEWARD-only.
  if (session.user.role !== Role.STEWARD) redirect('/home');
  const { batchId } = await params;

  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { uploadedBy: { select: { fullName: true } } },
  });
  if (!batch) notFound();

  // The table used to be the first 200 rows by number, so a rejection at row 1,900
  // of a real master was unreachable in the app entirely. Rows that need a decision
  // are fetched FIRST and always shown; the rest fill the remaining space.
  const [problemRows, otherRows] = await Promise.all([
    prisma.importRow.findMany({
      where: { batchId, state: { in: [ImportRowState.REJECTED, ImportRowState.QUARANTINED] } },
      orderBy: { rowNumber: 'asc' },
      take: 200,
    }),
    prisma.importRow.findMany({
      where: { batchId, state: { notIn: [ImportRowState.REJECTED, ImportRowState.QUARANTINED] } },
      orderBy: { rowNumber: 'asc' },
      take: 100,
    }),
  ]);
  const displayRows = [...problemRows, ...otherRows];

  // RK-3: promote runs in slices, so "how much is left" is the live CLEAN count,
  // not the batch's original cleanRows (which never changes once parsed).
  const remainingClean =
    batch.kind === 'CUSTOMER'
      ? await prisma.importRow.count({ where: { batchId, state: ImportRowState.CLEAN } })
      : 0;
  // FAILED is included deliberately: the pre-RK-3 promote wrote that state on an
  // abort, so a database migrated from it can hold batches stuck there. The service
  // accepts FAILED in its claim — without it here that recovery path has no button
  // and the batch stays stranded exactly as before.
  const promotable =
    batch.status === 'READY' || batch.status === 'PROMOTING' || batch.status === 'FAILED';
  const leaseHeld = !!batch.promoteLeaseUntil && batch.promoteLeaseUntil > new Date();
  // A run holds a short grace lease BETWEEN its slices, so a healthy load still reads
  // as held here. No live lease therefore does mean the run stopped (tab closed,
  // timeout, network drop) — committed rows are safe, the batch just needs resuming.
  const interrupted = (batch.status === 'PROMOTING' && !leaseHeld) || batch.status === 'FAILED';

  return (
    <main>
      <PageHeader
        title={batch.filename}
        subtitle={`${batch.kind} import · ${batch.totalRows} rows · ${batch.status}`}
        actions={
          batch.kind === 'CUSTOMER' && promotable ? (
            <PromoteButton
              batchId={batch.id}
              remainingCount={remainingClean}
              resume={batch.status === 'PROMOTING' || batch.status === 'FAILED'}
              leaseHeld={leaseHeld}
            />
          ) : null
        }
      />
      {interrupted && (
        <div className="mx-4 mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200 sm:mx-6">
          <strong className="font-semibold">Promote interrupted.</strong>{' '}
          {remainingClean > 0 ? (
            <>
              The {batch.promotedRows.toLocaleString()} rows already promoted are saved —{' '}
              {remainingClean.toLocaleString()} still to go. Click{' '}
              <span className="font-semibold">Resume promote</span> to continue where it stopped.
            </>
          ) : (
            <>
              Every row has been dealt with, but the batch was never closed off. Click{' '}
              <span className="font-semibold">Finish promote</span> to complete it.
            </>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-6 sm:p-6">
        <Stat label="Total" value={batch.totalRows} />
        <Stat label="Clean" value={batch.cleanRows} tone="green" />
        <Stat label="Quarantined" value={batch.quarantinedRows} tone="amber" />
        <Stat label="Promoted" value={batch.promotedRows} tone="blue" />
        {/* Rejected was not shown at all: a batch could finish PROMOTED reading
            "3300 clean / 3180 promoted" with the 120 lost customers nowhere on the
            page. A load the operator has to trust must show what it dropped. */}
        <Stat label="Rejected" value={batch.rejectedRows} tone="red" />
        <Stat label="Left to promote" value={remainingClean} />
      </div>
      {batch.rejectedRows > 0 && (
        <div className="mx-4 -mt-1 mb-2 text-xs text-red-700 sm:mx-6">
          {batch.rejectedRows.toLocaleString()} row(s) were rejected and are <strong>not</strong> in
          the master. They are listed first below, with the reason.
        </div>
      )}

      <section className="px-4 pb-6 sm:px-6">
        <TableScroll label="Import rows" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Row</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Issues</th>
                <th className="px-3 py-2 font-medium">Raw / Parsed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {displayRows.map((r) => (
                <tr key={r.id} className="align-top hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-[11px]">#{r.rowNumber}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 font-medium ${stateClass(r.state)}`}
                    >
                      {r.state}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-amber-700">
                    {r.issues ? JSON.stringify(r.issues) : '—'}
                  </td>
                  <td className="max-w-[600px] break-words px-3 py-2 font-mono text-[11px] text-slate-600">
                    {r.parsed ? JSON.stringify(r.parsed) : JSON.stringify(r.raw)}
                  </td>
                </tr>
              ))}
              {displayRows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-slate-400">
                    No rows.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableScroll>
      </section>
    </main>
  );
}

function stateClass(state: string) {
  switch (state) {
    case 'CLEAN':
      return 'bg-emerald-50 text-emerald-700';
    case 'PROMOTED':
      return 'bg-blue-50 text-blue-700';
    case 'QUARANTINED':
      return 'bg-amber-50 text-amber-700';
    case 'REJECTED':
      return 'bg-red-50 text-red-700';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'green' | 'amber' | 'blue' | 'red';
}) {
  const toneClass =
    tone === 'green'
      ? 'text-emerald-700 ring-emerald-200 bg-emerald-50'
      : tone === 'amber'
        ? 'text-amber-700 ring-amber-200 bg-amber-50'
        : tone === 'blue'
          ? 'text-blue-700 ring-blue-200 bg-blue-50'
          : tone === 'red'
            ? 'text-red-700 ring-red-200 bg-red-50'
            : 'text-slate-900 ring-slate-200 bg-white';
  return (
    <div className={`rounded-lg ring-1 ring-inset ${toneClass} px-3 py-2.5`}>
      <div className="text-xl font-bold">{value.toLocaleString()}</div>
      <div className="text-[11px] font-medium text-slate-600">{label}</div>
    </div>
  );
}
