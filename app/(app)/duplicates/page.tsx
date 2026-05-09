import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { Role } from '@prisma/client';
import { findDuplicateCandidates } from '@/services/duplicates';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { CompletenessRing } from '@/components/nmwc/CompletenessRing';
import { MergeForm } from './MergeForm';

export const metadata = { title: 'Duplicates · NMWC' };

export default async function DuplicatesPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.STEWARD && session.user.role !== Role.MANAGER) {
    redirect('/home');
  }

  const candidates = await findDuplicateCandidates(50);

  return (
    <main>
      <PageHeader
        title="Duplicate review"
        subtitle={`${candidates.length} suspected pair${candidates.length === 1 ? '' : 's'} (showing top 50)`}
      />

      <div className="p-4 sm:p-6">
        {candidates.length === 0 ? (
          <EmptyState
            title="No duplicates detected"
            description="Phone, CR, and fuzzy-name matches are all clean."
          />
        ) : (
          <ul className="grid gap-3">
            {candidates.map((c) => (
              <li
                key={`${c.a.id}-${c.b.id}`}
                className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200"
              >
                <header className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 font-medium ${
                        c.reason === 'PHONE'
                          ? 'bg-red-50 text-red-700'
                          : c.reason === 'CR'
                            ? 'bg-amber-50 text-amber-700'
                            : 'bg-sky-50 text-sky-700'
                      }`}
                    >
                      {c.reason} match
                    </span>
                    <span className="text-slate-500">
                      similarity {Math.round(c.similarity * 100)}%
                    </span>
                  </div>
                </header>
                <div className="grid gap-0 md:grid-cols-2">
                  <Side side={c.a} />
                  <div className="border-t border-slate-200 md:border-l md:border-t-0">
                    <Side side={c.b} />
                  </div>
                </div>
                <footer className="border-t border-slate-200 bg-slate-50 px-4 py-3">
                  <MergeForm
                    aId={c.a.id}
                    bId={c.b.id}
                    aLabel={`${c.a.legalName} (${c.a.nmwcCode})`}
                    bLabel={`${c.b.legalName} (${c.b.nmwcCode})`}
                  />
                </footer>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function Side({ side }: { side: { id: string; nmwcCode: string; legalName: string; primaryPhone: string | null; crNumber: string | null; completenessScore: number; branchCount: number } }) {
  return (
    <div className="flex items-start gap-3 p-4">
      <CompletenessRing value={side.completenessScore} size={40} />
      <div className="min-w-0 flex-1 text-sm">
        <h3 className="truncate font-semibold text-slate-900">{side.legalName}</h3>
        <p className="font-mono text-xs text-slate-500">{side.nmwcCode}</p>
        <dl className="mt-2 grid grid-cols-[80px_1fr] gap-y-0.5 text-xs">
          <dt className="text-slate-500">Phone</dt>
          <dd>{side.primaryPhone ?? '—'}</dd>
          <dt className="text-slate-500">CR</dt>
          <dd className="font-mono">{side.crNumber ?? '—'}</dd>
          <dt className="text-slate-500">Branches</dt>
          <dd>{side.branchCount}</dd>
        </dl>
      </div>
    </div>
  );
}
