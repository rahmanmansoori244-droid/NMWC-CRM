import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { CreateRegionForm, CreateRouteForm, ToggleButton } from './forms';

export const metadata = { title: 'Routes & Regions · NMWC' };

export default async function RoutesPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.MANAGER) redirect('/home');

  const regions = await prisma.region.findMany({
    orderBy: { code: 'asc' },
    include: {
      routes: {
        include: { owner: { select: { fullName: true, username: true } } },
        orderBy: { code: 'asc' },
      },
    },
  });

  return (
    <main>
      <PageHeader title="Routes & Regions" subtitle={`${regions.length} regions`} />

      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[1fr_320px]">
        <section className="space-y-4">
          {regions.map((region) => (
            <div
              key={region.id}
              className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200"
            >
              <header className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    {region.name}{' '}
                    <span className="font-mono text-xs font-normal text-slate-500">
                      {region.code}
                    </span>
                  </h2>
                  <p className="text-xs text-slate-500">{region.routes.length} routes</p>
                </div>
                <ToggleButton id={region.id} kind="region" isActive={region.isActive} />
              </header>
              <table className="min-w-full divide-y divide-slate-100 text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Code</th>
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Salesman</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {region.routes.map((route) => (
                    <tr key={route.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2 font-mono text-xs">{route.code}</td>
                      <td className="px-4 py-2">{route.name}</td>
                      <td className="px-4 py-2 text-slate-600">
                        {route.owner ? `${route.owner.fullName}` : '— unassigned —'}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                            route.isActive
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {route.isActive ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <ToggleButton id={route.id} kind="route" isActive={route.isActive} />
                      </td>
                    </tr>
                  ))}
                  {region.routes.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-3 text-center text-xs text-slate-400">
                        No routes in this region yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </section>

        <aside className="space-y-4">
          <div className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              New region
            </h2>
            <CreateRegionForm />
          </div>
          <div className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              New route
            </h2>
            <CreateRouteForm regions={regions.map((r) => ({ id: r.id, code: r.code, name: r.name }))} />
          </div>
        </aside>
      </div>
    </main>
  );
}
