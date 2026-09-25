import { TableScroll } from '@/components/nmwc/TableScroll';
import type { Route } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ImportRowState, Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { PromoteButton } from './PromoteButton';
import {
  ROW_VIEWS,
  ROW_VIEW_LABEL,
  ROWS_PAGE_SIZE,
  issueLines,
  lastPage,
  pageRange,
  parsePage,
  parseRowView,
  rowSummary,
  rowViewWhere,
  uploadedValues,
  viewCounts,
  type RowView,
} from '@/lib/import-rows-view';

export const metadata = { title: 'Import batch · NMWC' };

export default async function ImportBatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ show?: string; page?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // RBAC-05-009: STEWARD-only.
  if (session.user.role !== Role.STEWARD) redirect('/home');
  const { batchId } = await params;
  const sp = await searchParams;
  const view = parseRowView(sp.show);

  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { uploadedBy: { select: { fullName: true } } },
  });
  if (!batch) notFound();

  // Every row is reachable (item 20). The table used to be the first 200 problem
  // rows and the first 100 others, with nothing past them: one go-live load had
  // 1,833 rejections, and the Steward could open 200. Now each view pages through
  // all of its rows, and says how many there are.
  const [stateCounts, warningCount] = await Promise.all([
    prisma.importRow.groupBy({ by: ['state'], where: { batchId }, _count: { _all: true } }),
    prisma.importRow.count({ where: rowViewWhere(batchId, 'warnings') }),
  ]);
  const counts = viewCounts(
    Object.fromEntries(stateCounts.map((c) => [c.state, c._count._all])),
    warningCount
  );
  const pages = lastPage(counts[view]);
  const page = Math.min(parsePage(sp.page), pages);
  const displayRows = await prisma.importRow.findMany({
    where: rowViewWhere(batchId, view),
    orderBy: { rowNumber: 'asc' },
    skip: (page - 1) * ROWS_PAGE_SIZE,
    take: ROWS_PAGE_SIZE,
  });
  const href = (v: RowView, p = 1): Route => (p > 1 ? `?show=${v}&page=${p}` : `?show=${v}`);

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
      {counts.rejected > 0 && (
        <div className="mx-4 -mt-1 mb-2 text-xs text-red-700 sm:mx-6">
          {counts.rejected.toLocaleString()} row(s) were rejected and are <strong>not</strong> in
          the master.{' '}
          <Link href={href('rejected')} className="font-medium underline">
            See them with the reason
          </Link>
          .
        </div>
      )}

      <section className="px-4 pb-6 sm:px-6">
        <nav aria-label="Which rows" className="mb-3 flex flex-wrap gap-2 text-xs">
          {ROW_VIEWS.map((v) => (
            <Link
              key={v}
              href={href(v)}
              aria-current={v === view ? 'page' : undefined}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 font-medium ring-1 ring-inset ${
                v === view
                  ? 'bg-slate-900 text-white ring-slate-900'
                  : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'
              }`}
            >
              {ROW_VIEW_LABEL[v]}
              <span className="tabular-nums opacity-80">{counts[v].toLocaleString()}</span>
            </Link>
          ))}
        </nav>
        <TableScroll label="Import rows" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Row</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Branch · route · day</th>
                <th className="px-3 py-2 font-medium">What happened</th>
                <th className="px-3 py-2 font-medium">As uploaded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {displayRows.map((r) => {
                const who = rowSummary(r.raw, r.parsed);
                const lines = issueLines(r.issues);
                const uploaded = uploadedValues(r.raw);
                return (
                  <tr key={r.id} className="align-top hover:bg-slate-50">
                    <td className="px-3 py-2 font-mono text-[11px] tabular-nums">#{r.rowNumber}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 font-medium ${stateClass(r.state)}`}
                      >
                        {r.state}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-mono text-[11px] text-slate-500">{who.code ?? '—'}</div>
                      <div className="text-slate-800">{who.name ?? ''}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {[who.branch, who.route, who.day].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="max-w-[420px] px-3 py-2">
                      {lines.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <ul className="grid gap-1">
                          {lines.map((l, i) => (
                            <li key={i} className={r.state === 'PROMOTED' ? 'text-amber-800' : 'text-red-800'}>
                              <span className="font-semibold">{l.label}:</span> {l.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {uploaded.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <details>
                          <summary className="cursor-pointer select-none text-slate-600">
                            {uploaded.length} column{uploaded.length === 1 ? '' : 's'}
                          </summary>
                          <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
                            {uploaded.map(([k, v]) => (
                              <div key={k} className="contents">
                                <dt className="text-slate-500">{k}</dt>
                                <dd className="break-all text-slate-800">{v}</dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      )}
                    </td>
                  </tr>
                );
              })}
              {displayRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-slate-400">
                    {view === 'all' ? 'No rows.' : `No rows in "${ROW_VIEW_LABEL[view]}".`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableScroll>
        {counts[view] > 0 && (
          <nav aria-label="Pages" className="mt-3 flex items-center justify-between gap-2 text-sm">
            <Link
              href={href(view, Math.max(1, page - 1))}
              aria-disabled={page === 1}
              className={`rounded-md px-3 py-1.5 ${page === 1 ? 'pointer-events-none text-slate-400' : 'text-brand-700 hover:bg-brand-50'}`}
            >
              ← Previous
            </Link>
            <span className="text-xs text-slate-600 tabular-nums">{pageRange(page, counts[view])}</span>
            <Link
              href={href(view, Math.min(pages, page + 1))}
              aria-disabled={page === pages}
              className={`rounded-md px-3 py-1.5 ${page === pages ? 'pointer-events-none text-slate-400' : 'text-brand-700 hover:bg-brand-50'}`}
            >
              Next →
            </Link>
          </nav>
        )}
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
