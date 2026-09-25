import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { Role } from '@prisma/client';
import { findDuplicateCandidates } from '@/services/duplicates';
import {
  duplicatesSubtitle,
  type DismissalStamp,
  type MarkedDistinctPair,
} from '@/lib/duplicate-pairing';
import { omanDateISO } from '@/lib/tz';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { CompletenessRing } from '@/components/nmwc/CompletenessRing';
import { MergeForm } from './MergeForm';
import { UndoDistinct } from './UndoDistinct';
import { PhoneLink } from '@/components/nmwc/ContactLinks';

export const metadata = { title: 'Duplicates · NMWC' };

const PAGE_SIZE = 50;

/** "2026-09-25 by Aisha Al Balushi" — Oman date, and who, when the ledger knows. */
function stampText(s: DismissalStamp): string {
  const when = s.at ? omanDateISO(new Date(s.at)) : 'earlier';
  return s.by ? `${when} by ${s.by}` : when;
}

export default async function DuplicatesPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // RBAC-05-009: PRD §4 reserves duplicate merge to STEWARD only.
  if (session.user.role !== Role.STEWARD) redirect('/home');

  const { pairs: candidates, total, markedDistinct } = await findDuplicateCandidates(PAGE_SIZE);

  return (
    <main>
      <PageHeader
        title="Duplicate review"
        subtitle={duplicatesSubtitle(candidates.length, total)}
      />

      <div className="p-4 sm:p-6">
        {candidates.length === 0 ? (
          <EmptyState
            title="No suspected duplicates"
            description="The check pairs customers who share a CR number, or share the exact name and phone with a branch in the same region. A pair marked distinct stays hidden until the two come to share a different CR number, name or phone."
          />
        ) : (
          <ul className="grid gap-3">
            {candidates.map((c) => (
              <li
                key={`${c.a.id}-${c.b.id}`}
                className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200"
              >
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 font-medium ${
                        c.reason === 'CR'
                          ? 'bg-red-50 text-red-700'
                          : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {c.reason === 'CR' ? 'CR-number match' : 'Name + phone + region match'}
                    </span>
                    <span className="text-slate-500">high confidence</span>
                  </div>
                  {c.markedDistinctBefore && (
                    <p className="text-xs text-slate-600">
                      Marked distinct {stampText(c.markedDistinctBefore)}; back because what they
                      share has changed since.
                    </p>
                  )}
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

        <MarkedDistinct pairs={markedDistinct} />
      </div>
    </main>
  );
}

/**
 * The pairs a "Mark distinct" is hiding right now, each with an Undo (owner
 * decision 2026-09-25). A pair whose dismissal has lapsed is not here — it is
 * back in the list above, with a note that it was marked distinct before.
 * Collapsed by default: over months this list only grows, and the page is for
 * the pairs still to review.
 */
function MarkedDistinct({ pairs }: { pairs: MarkedDistinctPair[] }) {
  if (pairs.length === 0) return null;
  return (
    <details className="mt-6 rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-900">
        Marked distinct ({pairs.length.toLocaleString('en-US')})
      </summary>
      <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-600">
        Pairs a Steward marked as different customers, hidden from the list above. A pair comes
        back by itself if the two come to share a different CR number, name or phone.
      </p>
      <ul className="divide-y divide-slate-200 border-t border-slate-200">
        {pairs.map((p) => {
          const aLabel = `${p.a.legalName} (${p.a.nmwcCode})`;
          const bLabel = `${p.b.legalName} (${p.b.nmwcCode})`;
          return (
            <li
              key={`${p.a.id}-${p.b.id}`}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="text-slate-900">
                  {p.a.legalName} <span className="font-mono text-xs text-slate-500">{p.a.nmwcCode}</span>
                  {' · '}
                  {p.b.legalName} <span className="font-mono text-xs text-slate-500">{p.b.nmwcCode}</span>
                </p>
                <p className="text-xs text-slate-500">Marked distinct {stampText(p)}</p>
              </div>
              <UndoDistinct aId={p.a.id} bId={p.b.id} aLabel={aLabel} bLabel={bLabel} />
            </li>
          );
        })}
      </ul>
    </details>
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
          <dd>{side.primaryPhone ? <PhoneLink phone={side.primaryPhone} /> : '—'}</dd>
          <dt className="text-slate-500">CR</dt>
          <dd className="font-mono">{side.crNumber ?? '—'}</dd>
          <dt className="text-slate-500">Branches</dt>
          <dd>{side.branchCount}</dd>
        </dl>
      </div>
    </div>
  );
}
