import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
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
  if (session.user.role !== Role.STEWARD && session.user.role !== Role.MANAGER)
    redirect('/home');
  const { batchId } = await params;

  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: {
      uploadedBy: { select: { fullName: true } },
      rows: { orderBy: { rowNumber: 'asc' }, take: 200 },
    },
  });
  if (!batch) notFound();

  const grouped: Record<string, typeof batch.rows> = {};
  for (const r of batch.rows) {
    grouped[r.state] = grouped[r.state] ?? [];
    grouped[r.state]!.push(r);
  }

  return (
    <main>
      <PageHeader
        title={batch.filename}
        subtitle={`${batch.kind} import · ${batch.totalRows} rows · ${batch.status}`}
        actions={
          batch.kind === 'CUSTOMER' && batch.status === 'READY' ? (
            <PromoteButton batchId={batch.id} cleanCount={batch.cleanRows} />
          ) : null
        }
      />
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 sm:p-6">
        <Stat label="Total" value={batch.totalRows} />
        <Stat label="Clean" value={batch.cleanRows} tone="green" />
        <Stat label="Quarantined" value={batch.quarantinedRows} tone="amber" />
        <Stat label="Promoted" value={batch.promotedRows} tone="blue" />
      </div>

      <section className="px-4 pb-6 sm:px-6">
        <div className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
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
              {batch.rows.map((r) => (
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
                  <td className="px-3 py-2 max-w-[600px] break-words font-mono text-[11px] text-slate-600">
                    {r.parsed ? JSON.stringify(r.parsed) : JSON.stringify(r.raw)}
                  </td>
                </tr>
              ))}
              {batch.rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-slate-400">
                    No rows.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
  tone?: 'green' | 'amber' | 'blue';
}) {
  const toneClass =
    tone === 'green'
      ? 'text-emerald-700 ring-emerald-200 bg-emerald-50'
      : tone === 'amber'
        ? 'text-amber-700 ring-amber-200 bg-amber-50'
        : tone === 'blue'
          ? 'text-blue-700 ring-blue-200 bg-blue-50'
          : 'text-slate-900 ring-slate-200 bg-white';
  return (
    <div className={`rounded-lg ring-1 ring-inset ${toneClass} px-3 py-2.5`}>
      <div className="text-xl font-bold">{value.toLocaleString()}</div>
      <div className="text-[11px] font-medium text-slate-600">{label}</div>
    </div>
  );
}
