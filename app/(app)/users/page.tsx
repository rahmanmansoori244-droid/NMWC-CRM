import { TableScroll } from '@/components/nmwc/TableScroll';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { loadScope } from '@/lib/access';
import {
  managerCanAdministerUser,
  managerCanAssignSupervisor,
  type UserRegionFootprint,
} from '@/lib/permissions';
import { isDemoAccount } from '@/lib/demo-accounts';
import { CreateUserForm } from './CreateUserForm';
import { UserRowActions, UsersFeedback } from './UserRowActions';

export const metadata = { title: 'Users · NMWC' };

const STATUS_FILTERS = ['active', 'disabled', 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

type Search = { status?: string };

// Go-live: the production roster is 63 live accounts plus 26 disabled pilot/QA
// leftovers that own audit and approval history and therefore cannot be deleted.
// Reading the chain top-down beats Prisma's `role: 'asc'`, which follows the
// enum's DECLARED order (schema.prisma) — SALESMAN first, the Steward buried
// under sixty salesmen.
//
// A Record and not an array, because an array is a second hand-maintained copy of
// the enum that tsc does not check: a role added to schema.prisma would have been
// accepted here with 8 of 9 values, and every account holding it would have sorted
// silently below sixty salesmen. `Record<Role, number>` names the missing role at
// build time, the way ROLE_LABELS in CreateUserForm.tsx already does.
//
// It deliberately disagrees with SEVERITY in scripts/golive/audit-accounts.ts,
// which puts MANAGER above ACCOUNTANT and VIEWER above SALESMAN: that map ranks
// how much a LEFTOVER account should worry the reader (VIEWER is org-wide and can
// export the master), this one is the org chart a roster is read down. Same enum,
// two different questions — do not "reconcile" them into one.
const ROLE_ORDER: Record<Role, number> = {
  STEWARD: 0,
  GM: 1,
  FINANCE_MANAGER: 2,
  ACCOUNTANT: 3,
  MANAGER: 4,
  SUPERVISOR: 5,
  SALESMAN: 6,
  VIEWER: 7,
};

export default async function UsersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // final-hunt #29 / completes #0: user admin is MANAGER or STEWARD. Before this,
  // only MANAGER could reach /users, so the Steward provisioning path restored in
  // #0 (the ONLY way to create approver-tier accounts) had no UI to reach.
  if (session.user.role !== Role.MANAGER && session.user.role !== Role.STEWARD) {
    redirect('/home');
  }

  // RBAC-05-023: drop email/phone from the listing for everyone (the admin
  // tier doesn't need each other's PII; salesman PII is in the underlying
  // User row but kept off the table). The Manager can still reach a user's
  // detail (future) for legitimate cases.
  // B2 / SEC-02: a MANAGER administers their regions only. The list, the
  // supervisor dropdown and the route dropdown are narrowed with the SAME pure
  // rules the server actions enforce (lib/permissions.ts), so the UI never
  // offers what the server would refuse. A STEWARD sees everything.
  const isManager = session.user.role === Role.MANAGER;
  const scope = isManager ? await loadScope(session.user.id) : null;
  const managed = scope?.managedRegionIds ?? [];

  const sp = await searchParams;
  const status: StatusFilter = STATUS_FILTERS.includes(sp.status as StatusFilter)
    ? (sp.status as StatusFilter)
    : 'active';

  const [allUsers, routes] = await Promise.all([
    prisma.user.findMany({
      // Role grouping is applied in memory against ROLE_ORDER — the database
      // can only sort this enum in its declared order, which is the wrong one.
      orderBy: [{ fullName: 'asc' }],
      select: {
        id: true,
        username: true,
        fullName: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        ownedRouteId: true,
        supervisorId: true,
        supervisor: { select: { fullName: true, username: true } },
        ownedRoute: { select: { code: true, name: true, regionId: true } },
        reports: { select: { ownedRoute: { select: { regionId: true } } } },
        managedRegions: { select: { id: true } },
      },
    }),
    prisma.route.findMany({
      where: {
        isActive: true,
        owner: null,
        ...(isManager ? { regionId: { in: managed.length ? managed : ['__none__'] } } : {}),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    }),
  ]);
  const footprint = (u: (typeof allUsers)[number]): UserRegionFootprint => ({
    id: u.id,
    role: u.role,
    supervisorId: u.supervisorId,
    ownedRouteRegionId: u.ownedRoute?.regionId ?? null,
    teamRegionIds: [
      ...new Set(u.reports.map((r) => r.ownedRoute?.regionId).filter((r): r is string => !!r)),
    ],
    managedRegionIds: u.managedRegions.map((r) => r.id),
  });
  // Manager: own account + accounts they may administer. Steward: everyone.
  const administrable = isManager
    ? allUsers.filter(
        (u) =>
          u.id === session.user.id ||
          managerCanAdministerUser(managed, footprint(u), session.user.id).ok
      )
    : allUsers;
  const roster = [...administrable].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.fullName.localeCompare(b.fullName)
  );
  const activeCount = roster.filter((u) => u.isActive).length;
  const disabledCount = roster.length - activeCount;
  // Go-live: the list defaults to ACTIVE. The disabled pilot/QA accounts are
  // correctly dead, and they made a 63-account roster unreadable on the screen
  // being handed to real staff. The filter is in the URL so a reload keeps it and
  // it can be linked; "hidden" in the subtitle is what stops the default from
  // LOOKING like an account went missing.
  const users =
    status === 'all' ? roster : roster.filter((u) => u.isActive === (status === 'active'));
  const hiddenCount = roster.length - users.length;
  // The green badge means isActive, which is NOT the same as "can sign in":
  // production sets DEMO_ACCOUNTS_DISABLED and lib/auth.ts then refuses every
  // username lib/demo-accounts.ts matches — `admin`, `steward`, `viewer` and the
  // `salesman.`/`supervisor.`/`manager.a|b` prefixes — whatever the row says. All
  // of those are among the disabled leftovers today, so this badge renders
  // nowhere; it is here for the moment someone works down the Disabled tab and
  // clicks Enable on one, because the row would then read Active, be handed out,
  // and fail at sign-in with no in-app recovery — the near miss recorded in the
  // header of lib/demo-accounts.ts. Rename such an account; do not relax the list.
  const demoDisabled = process.env.DEMO_ACCOUNTS_DISABLED === 'true';
  // "Reports to": Supervisors in scope plus Managers (the go-live org has no
  // Supervisor accounts — salesmen report to their regional Manager directly).
  // Ordered here on purpose: the roster above sorts in memory, so the query's
  // orderBy was narrowed to fullName — which also flattened this dropdown, whose
  // order used to be a side effect of `role: 'asc'` (SUPERVISOR is declared index
  // 1, MANAGER index 5, so Supervisors arrived as a block first). ROLE_ORDER is
  // the wrong sort for it: that reads the org chart downwards and would bury the
  // direct supervisors under the nine Managers.
  const supervisors = allUsers
    .filter((u) => u.isActive && (u.role === Role.SUPERVISOR || u.role === Role.MANAGER))
    .filter((u) =>
      isManager ? managerCanAssignSupervisor(session.user.id, managed, footprint(u)) : true
    )
    .map((u) => ({ id: u.id, fullName: u.fullName, username: u.username, role: u.role }))
    .sort(
      (a, b) =>
        Number(a.role === Role.MANAGER) - Number(b.role === Role.MANAGER) ||
        a.fullName.localeCompare(b.fullName)
    );

  const noun = users.length === 1 ? 'account' : 'accounts';
  const shown = status === 'all' ? `${users.length} ${noun}` : `${users.length} ${status} ${noun}`;
  const subtitle =
    isManager && managed.length === 0
      ? 'No regions assigned to you yet — ask a Steward'
      : `${shown}${isManager ? ' in your regions' : ''}` +
        (hiddenCount > 0 ? ` · ${hiddenCount} hidden by this filter` : '');

  const tabs: { key: StatusFilter; label: string; count: number }[] = [
    { key: 'active', label: 'Active', count: activeCount },
    { key: 'disabled', label: 'Disabled', count: disabledCount },
    { key: 'all', label: 'All', count: roster.length },
  ];

  return (
    <main>
      <PageHeader title="Users" subtitle={subtitle} />

      <nav
        aria-label="Filter accounts by status"
        className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-6 py-3 text-sm"
      >
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/users?status=${t.key}`}
            aria-current={status === t.key ? 'page' : undefined}
            className={`rounded-md px-3 py-1.5 font-medium ${
              status === t.key
                ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-200'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t.label}
            <span className="ml-1.5 text-xs text-slate-500">{t.count}</span>
          </Link>
        ))}
      </nav>

      {/* The banner lives outside the grid so it cannot take a grid cell and push
          the table into the Create-user column. */}
      <UsersFeedback>
        <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[1fr_360px]">
          <TableScroll label="Accounts" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Username</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Reports to</th>
                  <th className="px-4 py-3 font-medium">Route</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Last login</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 font-medium text-slate-900">{u.fullName}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-700">{u.username}</td>
                    <td className="px-4 py-2">{u.role}</td>
                    <td className="px-4 py-2 text-slate-600">{u.supervisor?.fullName ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-600">
                      {u.ownedRoute ? `${u.ownedRoute.code}` : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          u.isActive
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {u.isActive ? 'Active' : 'Disabled'}
                      </span>
                      {u.isActive && demoDisabled && isDemoAccount(u.username) && (
                        <span
                          title="Refused at sign-in while DEMO_ACCOUNTS_DISABLED is set (lib/demo-accounts.ts). Rename the account — do not relax the list."
                          className="ml-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800"
                        >
                          Cannot sign in
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {u.lastLoginAt ? u.lastLoginAt.toLocaleDateString('en-GB') : 'never'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <UserRowActions userId={u.id} username={u.username} isActive={u.isActive} />
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-slate-400">
                      No {status === 'all' ? '' : `${status} `}accounts to show.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableScroll>

          <aside className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Create user
            </h2>
            <CreateUserForm
              supervisors={supervisors}
              routes={routes}
              viewerRole={session.user.role}
            />
          </aside>
        </div>
      </UsersFeedback>
    </main>
  );
}
