import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role, type Prisma } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { NoRegionNotice } from '@/components/nmwc/NoRegionNotice';
import { ReactivationDecisionForm } from './ReactivationDecisionForm';
import { loadScope } from '@/lib/access';
import { EVIDENCE_SELECT, evidenceIds, standsAsEvidence } from '@/lib/status-evidence';

export const metadata = { title: 'Reactivations · NMWC' };

export default async function ReactivationsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.MANAGER) redirect('/home');

  // RBAC-05-008: filter the queue to the Manager's region. Without this,
  // Manager A could see + decide on Manager B's region's requests.
  const scope = await loadScope(session.user.id);
  const where: Prisma.CustomerEditWhereInput = {
    isReactivation: true,
    state: 'SUBMITTED',
  };
  // Nothing can ever reach him, so the page says why instead of "No reactivation requests".
  const noRegion = scope.managedRegionIds.length === 0;
  if (noRegion) {
    where.id = '__none__';
  } else {
    where.branch = { regionId: { in: scope.managedRegionIds } };
  }

  const items = await prisma.customerEdit.findMany({
    where,
    include: {
      submittedBy: { select: { fullName: true } },
      customer: { select: { id: true, legalName: true, nmwcCode: true } },
      branch: {
        select: {
          id: true,
          branchName: true,
          shopPhotoId: true,
          signboardPhotoId: true,
          route: { select: { code: true } },
        },
      },
    },
    orderBy: { submittedAt: 'asc' },
  });

  // F10 / X-STATUS-2: which evidence photos still stand, in one read for the
  // whole queue. A removed one used to render as a broken image (the photo
  // route 404s it); it is said as removed now, and approval refuses it.
  const sentIds = [...new Set(items.flatMap((e) => evidenceIds(e.attachmentChanges)))];
  const evidenceById = new Map(
    (sentIds.length > 0
      ? await prisma.attachment.findMany({ where: { id: { in: sentIds } }, select: EVIDENCE_SELECT })
      : []
    ).map((r) => [r.id, r])
  );

  return (
    <main>
      <PageHeader
        title="Reactivation queue"
        subtitle={`${items.length} closed shops requesting reactivation`}
      />
      <div className="p-4 sm:p-6">
        {noRegion ? (
          // Launch browser suite (2026-10-07), as on /approvals. The header line
          // still reads "0 closed shops…": true, and the browser suite reads it.
          <NoRegionNotice requests="reactivation requests" />
        ) : items.length === 0 ? (
          <EmptyState
            title="No reactivation requests"
            description="When salesmen find a previously closed shop has reopened, they submit a request here for your review."
          />
        ) : (
          // grid-cols-1, here and inside each card: one column no wider than
          // the phone, whatever a card holds.
          <ul className="grid grid-cols-1 gap-3">
            {items.map((e) => (
              <li
                key={e.id}
                className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200"
              >
                <header className="border-b border-slate-200 bg-slate-50 px-4 py-3">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {e.customer?.legalName} —{' '}
                    <span className="text-slate-700">{e.branch?.branchName}</span>
                  </h3>
                  <p className="text-xs text-slate-500">
                    {e.customer?.nmwcCode} · route {e.branch?.route.code} · submitted by{' '}
                    {e.submittedBy.fullName}
                  </p>
                </header>
                <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-[1fr_auto] md:items-center">
                  <div>
                    <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
                      <strong>Reason:</strong> {e.decisionReason ?? '—'}
                    </p>
                    {/* final-hunt #12: the reviewer must see the FRESH evidence the
                        salesman captured for THIS reactivation (edit.attachmentChanges),
                        not the branch's stale on-file slot photos — those predate the
                        closure and prove nothing about the reopening. */}
                    {(() => {
                      const sent = evidenceIds(e.attachmentChanges);
                      const subject = { branchId: e.branchId, submittedById: e.submittedById };
                      const evidence = sent.filter((id) => standsAsEvidence(evidenceById.get(id), subject));
                      const removed = sent.length - evidence.length;
                      return (
                        <div className="mt-2 space-y-2">
                          <div>
                            <p className="text-xs font-medium text-emerald-700">
                              Fresh evidence (captured for this request)
                            </p>
                            {/* This queue's reject button is "Keep closed": the
                                warnings name it, as the approval refusals do. */}
                            {sent.length === 0 ? (
                              <p className="text-xs font-medium text-red-700">
                                No evidence photo attached — it cannot be approved; use Keep closed
                                to reject it.
                              </p>
                            ) : (
                              <>
                                {evidence.length > 0 && (
                                  <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
                                    {evidence.map((id) => (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img
                                        key={id}
                                        src={`/api/photos/${id}`}
                                        loading="lazy"
                                        decoding="async"
                                        alt="Reactivation evidence"
                                        className="h-24 w-full rounded-md object-cover ring-2 ring-emerald-300"
                                      />
                                    ))}
                                  </div>
                                )}
                                {removed > 0 && (
                                  <p className="mt-1 text-xs font-medium text-red-700">
                                    Evidence photo removed since the request was sent — it cannot be
                                    approved; use Keep closed to reject it.
                                  </p>
                                )}
                              </>
                            )}
                          </div>
                          {(e.branch?.shopPhotoId || e.branch?.signboardPhotoId) && (
                            // Launch fix (2026-10-09): loading="lazy" on these images. Without it the
                            // browser fetched every card's on-file photos at once, though the
                            // section is closed, and a busy queue used up the Manager's photo
                            // limit (60 at once, 1 a second), so later photos failed. A lazy image
                            // in a closed <details> is fetched only when the section is opened.
                            <details className="text-xs text-slate-500">
                              <summary className="cursor-pointer">Photos on file (for comparison)</summary>
                              <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
                                {e.branch?.shopPhotoId && (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={`/api/photos/${e.branch.shopPhotoId}`}
                                    loading="lazy"
                                    decoding="async"
                                    alt="On-file shop"
                                    className="h-24 w-full rounded-md object-cover"
                                  />
                                )}
                                {e.branch?.signboardPhotoId && (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={`/api/photos/${e.branch.signboardPhotoId}`}
                                    loading="lazy"
                                    decoding="async"
                                    alt="On-file signboard"
                                    className="h-24 w-full rounded-md object-cover"
                                  />
                                )}
                              </div>
                            </details>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  <ReactivationDecisionForm editId={e.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
