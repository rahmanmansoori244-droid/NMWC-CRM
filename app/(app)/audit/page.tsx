import { TableScroll } from '@/components/nmwc/TableScroll';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role, AuditAction, type Prisma } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { loadScope } from '@/lib/access';

export const metadata = { title: 'Audit log · NMWC' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type Search = {
  actor?: string;
  action?: string;
  entityType?: string;
  q?: string;
  page?: string;
};

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // RBAC-05-007: PRD §4 says Manager audit is regional + Steward audit is
  // global. Previous code only allowed Manager and showed them the global
  // log. Add STEWARD; for Manager, scope by their managed regions.
  if (session.user.role !== Role.MANAGER && session.user.role !== Role.STEWARD) {
    redirect('/home');
  }

  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  const where: Prisma.AuditLogWhereInput = {};
  if (sp.actor) where.actorId = sp.actor;
  if (sp.action && Object.values(AuditAction).includes(sp.action as AuditAction)) {
    where.action = sp.action as AuditAction;
  }
  if (sp.entityType) where.entityType = sp.entityType;
  if (sp.q) where.entityId = { contains: sp.q.trim() };

  // RBAC-05-007: Manager region scope. Audit rows do not directly carry a
  // region, so we filter by joining through Customer→branches for rows
  // about Customers/Branches/CustomerEdits. Audit rows about User/Import
  // remain visible to the Manager (people-ops they need) — Steward sees
  // everything.
  if (session.user.role === Role.MANAGER) {
    const scope = await loadScope(session.user.id);
    if (scope.managedRegionIds.length === 0) {
      // Fail-closed.
      where.id = '__none__';
    } else {
      // Find every customer + branch + edit + attachment id whose region is
      // in scope, then OR-filter the audit rows by entityType+entityId.
      const [custs, brchs] = await Promise.all([
        prisma.customer.findMany({
          where: {
            branches: {
              some: { regionId: { in: scope.managedRegionIds }, deletedAt: null },
            },
          },
          select: { id: true },
        }),
        prisma.branch.findMany({
          where: { regionId: { in: scope.managedRegionIds }, deletedAt: null },
          select: { id: true },
        }),
      ]);
      const custIds = custs.map((c) => c.id);
      const brchIds = brchs.map((b) => b.id);
      where.OR = [
        { entityType: 'Customer', entityId: { in: custIds.length ? custIds : ['__none__'] } },
        { entityType: 'Branch', entityId: { in: brchIds.length ? brchIds : ['__none__'] } },
        // CustomerEdit references cluster on customer ids — best-effort
        // surface; admin-tier rows like User/Import remain region-agnostic.
        { entityType: 'User' },
        { entityType: 'ImportBatch' },
      ];
    }
  }

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { at: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { actor: { select: { fullName: true, username: true } } },
    }),
  ]);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (overrides: Partial<Search>): Route => {
    const p = new URLSearchParams();
    const merged: Search = { ...sp, ...overrides };
    for (const k of Object.keys(merged) as (keyof Search)[]) {
      const v = merged[k];
      if (v) p.set(k, String(v));
    }
    return `?${p.toString()}`;
  };

  return (
    <main>
      <PageHeader
        title="Audit log"
        subtitle={`${total.toLocaleString()} matching events`}
      />
      <form
        method="get"
        className="grid grid-cols-1 gap-2 border-b border-slate-200 bg-white p-3 text-sm sm:grid-cols-4 sm:px-6"
      >
        <input
          name="q"
          defaultValue={sp.q ?? ''}
          placeholder="Entity ID contains…"
          className="rounded-md border border-slate-300 px-3 py-2"
        />
        <select
          name="action"
          defaultValue={sp.action ?? ''}
          className="rounded-md border border-slate-300 px-2 py-2"
        >
          <option value="">All actions</option>
          {Object.values(AuditAction).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          name="entityType"
          defaultValue={sp.entityType ?? ''}
          className="rounded-md border border-slate-300 px-2 py-2"
        >
          <option value="">All entities</option>
          <option value="Customer">Customer</option>
          <option value="Branch">Branch</option>
          <option value="CustomerEdit">CustomerEdit</option>
          <option value="User">User</option>
          <option value="ImportBatch">ImportBatch</option>
          <option value="Attachment">Attachment</option>
          <option value="Export">Export</option>
        </select>
        <button
          type="submit"
          className="rounded-md bg-brand-600 px-3 py-2 font-semibold text-white"
        >
          Apply
        </button>
      </form>

      <div className="p-4 sm:p-6">
        <TableScroll label="Audit log" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Actor</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Entity</th>
                <th className="px-3 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-500">{l.at.toLocaleString('en-GB')}</td>
                  <td className="px-3 py-2">{l.actor.fullName}</td>
                  <td className="px-3 py-2 font-mono">{l.action}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-600">
                    {l.entityType}/{l.entityId.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-2 text-slate-600">{l.reason ?? '—'}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-400">
                    No audit entries match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableScroll>
        {lastPage > 1 && (
          <nav className="mt-4 flex items-center justify-between text-sm">
            <Link
              href={qs({ page: String(Math.max(1, page - 1)) })}
              className={`rounded-md px-3 py-1.5 ${page === 1 ? 'pointer-events-none text-slate-400' : 'text-brand-700 hover:bg-brand-50'}`}
            >
              ← Previous
            </Link>
            <span className="text-slate-600">
              Page {page} of {lastPage}
            </span>
            <Link
              href={qs({ page: String(Math.min(lastPage, page + 1)) })}
              className={`rounded-md px-3 py-1.5 ${page === lastPage ? 'pointer-events-none text-slate-400' : 'text-brand-700 hover:bg-brand-50'}`}
            >
              Next →
            </Link>
          </nav>
        )}
      </div>
    </main>
  );
}
