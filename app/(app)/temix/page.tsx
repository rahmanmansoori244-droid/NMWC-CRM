import { TableScroll } from '@/components/nmwc/TableScroll';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role, TemixSyncState } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { TEMIX_QUEUE_WHERE } from '@/lib/temix';
import { GenerateBatchButton, BatchRowActions } from './TemixActions';

export const metadata = { title: 'Temix sync · NMWC' };
export const dynamic = 'force-dynamic';

export default async function TemixPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // Steward-only (owner role matrix: Temix batch upload/refresh is Steward's).
  if (session.user.role !== Role.STEWARD) redirect('/home');

  const [pendingUpload, deactivatePending, uploaded, queueTotal, batches] = await Promise.all([
    prisma.customer.count({
      where: { temixSyncState: TemixSyncState.PENDING_UPLOAD, deletedAt: null },
    }),
    // Deliberately NO deletedAt filter — deactivation rows are soft-deleted.
    prisma.customer.count({ where: { temixSyncState: TemixSyncState.DEACTIVATE_PENDING } }),
    prisma.customer.count({ where: { temixSyncState: TemixSyncState.UPLOADED } }),
    prisma.customer.count({ where: TEMIX_QUEUE_WHERE }),
    prisma.temixSyncBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { createdBy: { select: { fullName: true } } },
    }),
  ]);

  return (
    <main>
      <PageHeader
        title="Temix sync"
        subtitle="Batch upload queue for the Temix ERP — approved master data waiting to be carried over."
        actions={<GenerateBatchButton disabled={queueTotal === 0} />}
      />

      <div className="grid gap-3 p-4 sm:grid-cols-3 sm:p-6">
        <StatTile
          label="Pending upload"
          value={pendingUpload}
          hint="Approved creates & corrections not yet in a batch"
          tone={pendingUpload > 0 ? 'amber' : 'slate'}
        />
        <StatTile
          label="Pending deactivation"
          value={deactivatePending}
          hint="Archived customers Temix still lists as active"
          tone={deactivatePending > 0 ? 'red' : 'slate'}
        />
        <StatTile
          label="Uploaded — awaiting Temix"
          value={uploaded}
          hint="In a batch; synced when the Temix refresh returns their code"
          tone={uploaded > 0 ? 'sky' : 'slate'}
        />
      </div>

      <section className="px-4 pb-8 sm:px-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Batch history</h2>
        {batches.length === 0 ? (
          <EmptyState
            title="No batches yet"
            description="Generate an upload file when approved customers are waiting."
          />
        ) : (
          <TableScroll label="Temix batches" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Created</th>
                  <th className="px-4 py-2">By</th>
                  <th className="px-4 py-2">Customers</th>
                  <th className="px-4 py-2">Loaded into Temix</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td className="px-4 py-2.5 text-slate-900">
                      {b.createdAt.toLocaleString('en-GB')}
                      <span className="ml-2 font-mono text-[11px] text-slate-400">
                        …{b.id.slice(-6)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{b.createdBy.fullName}</td>
                    <td className="px-4 py-2.5 tabular-nums text-slate-700">{b.rowCount}</td>
                    <td className="px-4 py-2.5">
                      {b.markedLoadedAt ? (
                        <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                          ✓ {b.markedLoadedAt.toLocaleDateString('en-GB')}
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                          awaiting confirm
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <BatchRowActions batchId={b.id} loaded={!!b.markedLoadedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Flow: generate a batch (queued rows flip to “uploaded”) → carry the sheet to Temix →
          mark the batch loaded → the next Temix master refresh (via{' '}
          <Link href="/import" className="text-brand-700 underline">
            Import
          </Link>
          , with a <code className="font-mono">temix_code</code> column) back-fills ERP codes and
          settles rows to “synced”.
        </p>
      </section>
    </main>
  );
}

function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: 'amber' | 'red' | 'sky' | 'slate';
}) {
  const tones: Record<string, string> = {
    amber: 'ring-amber-200 bg-amber-50 text-amber-800',
    red: 'ring-red-200 bg-red-50 text-red-800',
    sky: 'ring-sky-200 bg-sky-50 text-sky-800',
    slate: 'ring-slate-200 bg-white text-slate-700',
  };
  return (
    <div className={`rounded-lg p-4 shadow-sm ring-1 ${tones[tone]}`}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-3xl font-bold tabular-nums">{value}</p>
      <p className="mt-1 text-xs opacity-70">{hint}</p>
    </div>
  );
}
