import { redirect } from 'next/navigation';
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
import { CreateUserForm } from './CreateUserForm';
import { UserRowActions } from './UserRowActions';

export const metadata = { title: 'Users · NMWC' };

export default async function UsersPage() {
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

  const [allUsers, routes] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
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
  const users = isManager
    ? allUsers.filter(
        (u) =>
          u.id === session.user.id ||
          managerCanAdministerUser(managed, footprint(u), session.user.id).ok
      )
    : allUsers;
  // "Reports to": Supervisors in scope plus Managers (the go-live org has no
  // Supervisor accounts — salesmen report to their regional Manager directly).
  const supervisors = allUsers
    .filter((u) => u.isActive && (u.role === Role.SUPERVISOR || u.role === Role.MANAGER))
    .filter((u) =>
      isManager ? managerCanAssignSupervisor(session.user.id, managed, footprint(u)) : true
    )
    .map((u) => ({ id: u.id, fullName: u.fullName, username: u.username, role: u.role }));

  return (
    <main>
      <PageHeader
        title="Users"
        subtitle={
          isManager
            ? managed.length === 0
              ? 'No regions assigned to you yet — ask a Steward'
              : `${users.length} accounts in your regions`
            : `${users.length} accounts`
        }
      />

      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[1fr_360px]">
        <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
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
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {u.lastLoginAt ? u.lastLoginAt.toLocaleDateString('en-GB') : 'never'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <UserRowActions
                      userId={u.id}
                      username={u.username}
                      isActive={u.isActive}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <aside className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Create user
          </h2>
          <CreateUserForm supervisors={supervisors} routes={routes} viewerRole={session.user.role} />
        </aside>
      </div>
    </main>
  );
}
