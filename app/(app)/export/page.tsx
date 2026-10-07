import { canExport } from '@/lib/permissions';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { resolveExportScope } from '@/lib/export-scope';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { ExportFiltersForm } from './ExportFiltersForm';

export const metadata = { title: 'Export · NMWC' };

export default async function ExportPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // UAT-06: match the permission, not a single excluded role.
  if (!canExport(session.user)) redirect('/home');

  // Launch fix: the lists are cut to what this role may export — the scope both
  // exports apply (lib/export-scope.ts), which intersects a pick with it. A
  // Manager used to be offered every region and route, and a pick outside his
  // regions returned an empty workbook.
  const scope = await resolveExportScope(session.user);
  const [regions, routes] = await Promise.all([
    prisma.region.findMany({
      where: {
        isActive: true,
        ...(scope.allowedRegionIds ? { id: { in: scope.allowedRegionIds } } : {}),
        ...(scope.allowedRouteIds ? { routes: { some: { id: { in: scope.allowedRouteIds } } } } : {}),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true },
    }),
    prisma.route.findMany({
      where: {
        isActive: true,
        ...(scope.allowedRegionIds ? { regionId: { in: scope.allowedRegionIds } } : {}),
        ...(scope.allowedRouteIds ? { id: { in: scope.allowedRouteIds } } : {}),
      },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, regionId: true },
    }),
  ]);
  // A region-less Manager or a Supervisor with no team exports nothing (fail-closed).
  const nothingInScope =
    scope.allowedRegionIds?.includes('__none__') || scope.allowedRouteIds?.includes('__none__');

  return (
    <main>
      <PageHeader
        title="Export to Excel"
        subtitle="Build a snapshot of the customer master, then upload it to ERP."
      />
      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[1fr_360px]">
        <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          {nothingInScope && (
            <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
              {session.user.role === 'SUPERVISOR'
                ? 'No salesman reports to you yet, so there is nothing for you to export.'
                : 'You have no managed regions yet, so there is nothing for you to export. Ask a Steward.'}
            </p>
          )}
          <ExportFiltersForm regions={regions} routes={routes} />
        </section>
        <aside className="rounded-lg bg-amber-50 p-5 text-sm text-amber-900 ring-1 ring-amber-200">
          <h2 className="mb-2 font-semibold">Workbook shape</h2>
          <p className="mb-2 text-amber-800">
            One row per <strong>branch</strong>. Multiple branches of the same parent customer
            share <code>cust_code</code> but have distinct <code>branch_code</code>.
          </p>
          <p className="mb-2 text-amber-800">
            <strong>Not an import file.</strong> Some columns differ from what the importer
            expects (region and channel are names here, and the customer status would be
            applied to every branch), so re-uploading this workbook can change data you did
            not edit. For bulk changes, start from the import template.
          </p>
          <p className="mb-3 text-xs text-amber-700">
            Photo columns show <code>yes</code> when a photo is present. The actual files stay in
            Cloudflare R2 — view them in the customer profile.
          </p>
          <h2 className="mb-2 font-semibold">Field-update report</h2>
          <p className="mb-2 text-amber-800">
            Same rows, but every cell a salesman changed (and a supervisor/manager approved) in the
            chosen window is highlighted, with a note showing the old value, who changed it and
            when. Unhighlighted cells were not touched.
          </p>
          <p className="text-xs text-amber-700">
            Sheets: <strong>Customers</strong> (highlighted master), <strong>Changes</strong> (one
            row per change), <strong>By salesman</strong> (totals), <strong>Legend</strong>.
          </p>
        </aside>
      </div>
    </main>
  );
}
