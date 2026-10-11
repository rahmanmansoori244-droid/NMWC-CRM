import { TableScroll } from '@/components/nmwc/TableScroll';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { omanDateTime } from '@/lib/tz';
import { Role, AuditAction, Prisma } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { loadScope } from '@/lib/access';
import {
  AUDIT_CUSTOMER_MATCH_LIMIT,
  AUDIT_ENTITY_TYPES,
  MANAGER_AUDIT_ACTIONS,
  MANAGER_AUDIT_ENTITY_TYPES,
  STEWARD_HIDDEN_BY_DEFAULT,
  auditCustomersByCode,
  customerFilterSql,
  managerAuditScopeSql,
  managerAuditUserIds,
  type AuditCustomer,
} from '@/lib/audit-scope';

export const metadata = { title: 'Audit log · NMWC' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type Search = {
  actor?: string;
  action?: string;
  entityType?: string;
  q?: string;
  /** Steward only (owner decisions 2026-10-11): an NMWC or Temix customer code. */
  customer?: string;
  page?: string;
};

/** The action filter's words for an action: its code, and the photo views by name too. */
const actionLabel = (a: AuditAction) => (a === AuditAction.PHOTO_VIEW ? 'Photo views (PHOTO_VIEW)' : a);

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
  const isManager = session.user.role === Role.MANAGER;
  const action =
    sp.action && Object.values(AuditAction).includes(sp.action as AuditAction)
      ? (sp.action as AuditAction)
      : null;
  const q = sp.q?.trim() || null;
  // Owner decisions 2026-10-11: the customer filter is the Data Steward's alone. On
  // a Manager's address it is ignored, and his links do not carry it on.
  const customerCode = isManager ? null : sp.customer?.trim() || null;
  const filters: Search = isManager ? { ...sp, customer: undefined } : sp;
  const include = { actor: { select: { fullName: true, username: true } } } as const;

  let total = 0;
  let logs: Prisma.AuditLogGetPayload<{ include: typeof include }>[] = [];
  // The reads written as SQL — a Manager's regional scope, or the Steward's
  // customer filter — share one WHERE for the count and the page of ids below.
  // Null when nothing is read that way.
  let rawConds: Prisma.Sql[] | null = null;
  let customers: AuditCustomer[] = [];
  if (isManager) {
    // RBAC-05-007: a Manager's log is regional — lib/audit-scope.ts says what
    // that covers and what it replaced. A Manager with no regions sees nothing.
    const scope = await loadScope(session.user.id);
    if (scope.managedRegionIds.length > 0) {
      const userIds = await managerAuditUserIds(prisma, session.user.id, scope.managedRegionIds);
      rawConds = [managerAuditScopeSql({ regionIds: scope.managedRegionIds, userIds })];
    }
  } else if (customerCode) {
    // Owner decisions 2026-10-11: who viewed this customer's documents. The
    // PHOTO_VIEW rows of every photo and document of the customers the code names —
    // its request photos and its branches' photos included, whose rows carry no
    // customer id. lib/audit-scope.ts says which documents, and how the query keeps
    // to the ledger's indexes. And who printed its printouts: the PRINT rows of its
    // customer form and of its requests' credit applications (part C; a default for
    // the owner to confirm). A code that names no customer shows nothing.
    customers = await auditCustomersByCode(prisma, customerCode);
    const asked = await customerFilterSql(prisma, customers.slice(0, AUDIT_CUSTOMER_MATCH_LIMIT));
    if (asked) rawConds = [asked];
  } else {
    const where: Prisma.AuditLogWhereInput = {};
    if (sp.actor) where.actorId = sp.actor;
    // Owner decisions 2026-10-11: photo views are left out of the Steward's list
    // and its count unless he picks that action (or uses the customer filter).
    where.action = action ?? { notIn: [...STEWARD_HIDDEN_BY_DEFAULT] };
    if (sp.entityType) where.entityType = sp.entityType;
    if (q) where.entityId = { contains: q };
    [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { at: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include,
      }),
    ]);
  }
  if (rawConds) {
    const conds = [...rawConds];
    if (sp.actor) conds.push(Prisma.sql`a."actorId" = ${sp.actor}`);
    if (action) conds.push(Prisma.sql`a."action" = ${action}::"AuditAction"`);
    if (sp.entityType) conds.push(Prisma.sql`a."entityType" = ${sp.entityType}`);
    // strpos: a literal substring, as Prisma's `contains` is on the Steward's path.
    if (q) conds.push(Prisma.sql`strpos(a."entityId", ${q}) > 0`);
    const whereSql = Prisma.join(conds, ' AND ');
    const [counted, ids] = await Promise.all([
      prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS "n" FROM "AuditLog" a WHERE ${whereSql}`,
      prisma.$queryRaw<Array<{ id: string }>>`SELECT a."id" FROM "AuditLog" a WHERE ${whereSql}
        ORDER BY a."at" DESC, a."id" DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
    ]);
    total = counted[0]?.n ?? 0;
    logs =
      ids.length === 0
        ? []
        : await prisma.auditLog.findMany({
            where: { id: { in: ids.map((r) => r.id) } },
            orderBy: [{ at: 'desc' }, { id: 'desc' }],
            include,
          });
  }
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Launch fix: the entity filter offers every type the viewer can see (it
  // offered seven), and keeps a type from the address it does not list.
  const entityTypes: readonly string[] = isManager ? MANAGER_AUDIT_ENTITY_TYPES : AUDIT_ENTITY_TYPES;
  const entityOptions =
    sp.entityType && !entityTypes.includes(sp.entityType) ? [...entityTypes, sp.entityType] : entityTypes;
  // Owner decision 2026-10-11: photo views (PHOTO_VIEW) are the Data Steward's to
  // read. A Manager is not offered them, and his scope leaves them out whatever the
  // address asks (lib/audit-scope.ts).
  const actionOptions: readonly AuditAction[] = isManager ? MANAGER_AUDIT_ACTIONS : Object.values(AuditAction);
  // Owner decisions 2026-10-11: the Steward's default list leaves photo views out;
  // its first action option and a line above the table say so.
  const photoViewsHidden = !isManager && !customerCode && !action;
  const matchedCodes = customers
    .slice(0, AUDIT_CUSTOMER_MATCH_LIMIT)
    .map((c) => (c.archived ? `${c.nmwcCode} (archived)` : c.nmwcCode));
  // ?actor= is supported but had no control, and Apply dropped it. It now rides
  // along in a hidden field, is named above the table, and can be cleared; the
  // Actor cells set it. The name comes from the rows shown, never a lookup.
  const actorName = sp.actor ? (logs.find((l) => l.actorId === sp.actor)?.actor.fullName ?? 'one person') : null;
  const qs = (overrides: Partial<Search>): Route => {
    const p = new URLSearchParams();
    const merged: Search = { ...filters, ...overrides };
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
        subtitle={`${total.toLocaleString('en-US')} matching events`}
      />
      <form
        method="get"
        className={`grid grid-cols-1 gap-2 border-b border-slate-200 bg-white p-3 text-sm sm:px-6 ${isManager ? 'sm:grid-cols-4' : 'sm:grid-cols-5'}`}
      >
        {/* Each filter named by a label a screen reader reads (a placeholder and
            a first option are not names); hidden, so the bar looks as it did.
            Fixed ids: the page has one filter form. */}
        <label htmlFor="audit-q" className="sr-only">
          Entity ID contains
        </label>
        <input
          id="audit-q"
          name="q"
          defaultValue={sp.q ?? ''}
          placeholder="Entity ID contains…"
          className="rounded-md border border-slate-300 px-3 py-2"
        />
        {!isManager && (
          <>
            {/* Owner decisions 2026-10-11: who viewed this customer's documents, and who
                printed its printouts. */}
            <label htmlFor="audit-customer" className="sr-only">
              Customer code (NMWC or Temix)
            </label>
            <input
              id="audit-customer"
              name="customer"
              defaultValue={sp.customer ?? ''}
              placeholder="Customer code: views, prints…"
              className="rounded-md border border-slate-300 px-3 py-2"
            />
          </>
        )}
        <label htmlFor="audit-action" className="sr-only">
          Action
        </label>
        <select
          id="audit-action"
          name="action"
          defaultValue={sp.action ?? ''}
          className="rounded-md border border-slate-300 px-2 py-2"
        >
          <option value="">{isManager || customerCode ? 'All actions' : 'All actions but photo views'}</option>
          {actionOptions.map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </select>
        <label htmlFor="audit-entity-type" className="sr-only">
          Entity type
        </label>
        <select
          id="audit-entity-type"
          name="entityType"
          defaultValue={sp.entityType ?? ''}
          className="rounded-md border border-slate-300 px-2 py-2"
        >
          <option value="">All entities</option>
          {entityOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {sp.actor && <input type="hidden" name="actor" value={sp.actor} />}
        <button
          type="submit"
          className="rounded-md bg-brand-600 px-3 py-2 font-semibold text-white"
        >
          Apply
        </button>
      </form>

      <div className="p-4 sm:p-6">
        {customerCode && (
          <p className="mb-3 text-sm text-slate-600">
            {matchedCodes.length > 0 ? (
              <>
                Showing who opened the photos and documents of{' '}
                <span className="font-medium text-slate-900">{matchedCodes.join(', ')}</span>, and who printed{' '}
                {matchedCodes.length === 1 ? 'its customer form or credit application' : 'their customer forms or credit applications'}
                {customers.length > AUDIT_CUSTOMER_MATCH_LIMIT
                  ? ` — this code names more than ${AUDIT_CUSTOMER_MATCH_LIMIT} customers; type an NMWC code to see one`
                  : ''}
                .{' '}
              </>
            ) : (
              <>
                No customer has the code <span className="font-medium text-slate-900">{customerCode}</span>.{' '}
              </>
            )}
            <Link href={qs({ customer: undefined, page: undefined })} className="text-brand-700 underline">
              Show the whole log
            </Link>
          </p>
        )}
        {photoViewsHidden && (
          <p className="mb-3 text-sm text-slate-600">
            Photo views are not in this list. To see who opened which photo or document, pick Photo views under
            Action, or type a customer&rsquo;s code.
          </p>
        )}
        {sp.actor && (
          <p className="mb-3 text-sm text-slate-600">
            Showing what <span className="font-medium text-slate-900">{actorName}</span> did.{' '}
            <Link href={qs({ actor: undefined, page: undefined })} className="text-brand-700 underline">
              Show everyone
            </Link>
          </p>
        )}
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
                  <td className="px-3 py-2 text-slate-500">{omanDateTime(l.at)}</td>
                  <td className="px-3 py-2">
                    <Link
                      href={qs({ actor: l.actorId, page: undefined })}
                      title="Show only what this person did"
                      className="hover:text-brand-700 hover:underline"
                    >
                      {l.actor.fullName}
                    </Link>
                  </td>
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
