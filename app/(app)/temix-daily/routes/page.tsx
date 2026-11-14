import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { omanDateTime } from '@/lib/tz';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { TableScroll } from '@/components/nmwc/TableScroll';
import { unmatchedRouteCodes } from '@/lib/temix-daily-check';
import { loadLiveRouteMap, loadRoutes, loadSwitchedOffRoutesHoldingShops, loadWaitingRouteCodes } from '@/lib/temix-daily-check-load';
import { AddRouteMapEntryForm, RetireRouteMapEntryForm } from './forms';

export const metadata = { title: 'Temix route map · NMWC' };

const n = (x: number) => x.toLocaleString('en-US');

/**
 * The daily Temix import, stage 4: the route map. Temix route codes that are
 * not exactly a CRM route's code, and the CRM route each belongs to. It starts
 * EMPTY: the Data Steward enters the owner's route master here (add with a
 * reason, retire with a reason; nothing is ever edited or deleted). Beside it,
 * the route codes of the files waiting to be applied that nothing matches, and
 * the switched-off routes that still hold shops. Data Steward only.
 */
export default async function TemixRouteMapPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.STEWARD) redirect('/home');

  const entrySelect = {
    id: true,
    temixRouteCode: true,
    action: true,
    routeId: true,
    retiresId: true,
    reason: true,
    at: true,
    by: { select: { fullName: true } },
  } as const;
  const [routes, live, liveEntries, entries, codeCounts, offRoutes] = await Promise.all([
    loadRoutes(prisma),
    loadLiveRouteMap(prisma),
    prisma.temixRouteMap.findMany({
      where: { action: 'ADD', retiredBy: { is: null } },
      orderBy: { temixRouteCode: 'asc' },
      select: entrySelect,
    }),
    // The latest of everything else: retired entries and their retirements.
    prisma.temixRouteMap.findMany({ orderBy: { id: 'desc' }, take: 200, select: entrySelect }),
    loadWaitingRouteCodes(prisma),
    loadSwitchedOffRoutesHoldingShops(prisma),
  ]);
  const routeById = new Map(routes.map((r) => [r.id, r]));
  const liveIds = new Set(live.map((e) => e.id));
  const unmatched = unmatchedRouteCodes(codeCounts, routes, live);
  const past = entries.filter((e) => !(e.action === 'ADD' && liveIds.has(e.id.toString())));
  const routeLabel = (id: string | null) => {
    const r = id ? routeById.get(id) : undefined;
    return r ? `${r.code} (${r.name})${r.isActive ? '' : ', switched off'}` : '-';
  };

  return (
    <main>
      <PageHeader
        title="Temix route map"
        subtitle="Temix route codes that are not exactly a CRM route's code, and the CRM route each belongs to. A code is matched exactly first, then here; anything else is not matched, and the shop keeps its route."
        actions={
          <Link href="/temix-daily" className="text-sm font-medium text-brand-700 hover:underline">
            All daily files
          </Link>
        }
      />
      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-2">
        <section aria-labelledby="add-h" className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 id="add-h" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Add an entry
          </h2>
          <p className="mt-1 mb-3 text-xs text-slate-600">
            From the owner&apos;s route master only: the map starts empty, and no entry is made or suggested by the CRM. A code
            has one entry at a time; to change it, retire it and add the new one.
          </p>
          <AddRouteMapEntryForm routes={routes.map((r) => ({ id: r.id, label: routeLabel(r.id) }))} />
        </section>

        <section aria-labelledby="unmatched-h" className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 id="unmatched-h" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Route codes not matched
          </h2>
          <p className="mt-1 mb-3 text-xs text-slate-600">In the daily files waiting to be applied, with their rows.</p>
          <TableScroll label="Unmatched route codes with their rows" className="rounded ring-1 ring-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-1.5 font-medium">Temix route code</th>
                  <th scope="col" className="px-3 py-1.5 text-right font-medium">Rows</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {unmatched.map((u) => (
                  <tr key={u.code}>
                    <td className="px-3 py-1.5 font-mono text-xs">{u.code}</td>
                    <td className="px-3 py-1.5 text-right text-xs">{n(u.rows)}</td>
                  </tr>
                ))}
                {unmatched.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-3 py-3 text-center text-xs text-slate-500">
                      Every route code is matched.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableScroll>
          <h3 className="mt-4 text-xs font-semibold text-slate-600">Switched-off routes that still hold shops</h3>
          {offRoutes.length === 0 ? (
            <p className="mt-1 text-xs text-slate-500">None.</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
              {offRoutes.map((r) => (
                <li key={r.id}>
                  <code>{r.code}</code>: {n(r.shops)} shops
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby="live-h" className="px-4 pb-4 sm:px-6">
        <h2 id="live-h" className="mb-2 text-sm font-semibold text-slate-700">
          Entries in use ({n(live.length)})
        </h2>
        <TableScroll label="Route-map entries in use" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Temix route code</th>
                <th scope="col" className="px-4 py-2 font-medium">CRM route</th>
                <th scope="col" className="px-4 py-2 font-medium">Reason</th>
                <th scope="col" className="px-4 py-2 font-medium">Added</th>
                <th scope="col" className="px-4 py-2 font-medium">Retire</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {liveEntries.map((e) => (
                <tr key={e.id.toString()} className="align-top">
                  <td className="px-4 py-2 font-mono text-xs">{e.temixRouteCode}</td>
                  <td className="px-4 py-2 text-xs">{routeLabel(e.routeId)}</td>
                  <td className="px-4 py-2 text-xs text-slate-600">{e.reason}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {omanDateTime(e.at)}, {e.by.fullName}
                  </td>
                  <td className="px-4 py-2">
                    <RetireRouteMapEntryForm id={e.id.toString()} code={e.temixRouteCode} />
                  </td>
                </tr>
              ))}
              {liveEntries.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-xs text-slate-500">
                    The route map is empty: route codes are matched only when they are exactly a CRM route&apos;s code.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableScroll>
      </section>

      <section aria-labelledby="past-h" className="px-4 pb-6 sm:px-6">
        <h2 id="past-h" className="mb-2 text-sm font-semibold text-slate-700">
          Earlier entries and retirements
        </h2>
        <TableScroll label="Earlier route-map entries" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Temix route code</th>
                <th scope="col" className="px-4 py-2 font-medium">What</th>
                <th scope="col" className="px-4 py-2 font-medium">Reason</th>
                <th scope="col" className="px-4 py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {past.map((e) => (
                <tr key={e.id.toString()} className="align-top">
                  <td className="px-4 py-2 font-mono text-xs">{e.temixRouteCode}</td>
                  <td className="px-4 py-2 text-xs">
                    {e.action === 'ADD' ? `Added: ${routeLabel(e.routeId)} (retired since)` : `Retired entry ${e.retiresId?.toString()}`}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-600">{e.reason}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {omanDateTime(e.at)}, {e.by.fullName}
                  </td>
                </tr>
              ))}
              {past.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-xs text-slate-500">
                    Nothing yet.
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
