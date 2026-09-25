import { TableScroll } from '@/components/nmwc/TableScroll';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';

export const metadata = { title: 'My team · NMWC' };

export default async function TeamPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.SUPERVISOR) redirect('/home');

  const reports = await prisma.user.findMany({
    where: { supervisorId: session.user.id, role: Role.SALESMAN },
    include: {
      ownedRoute: true,
      _count: {
        select: {
          submittedEdits: { where: { state: 'SUBMITTED' } },
        },
      },
    },
    orderBy: { fullName: 'asc' },
  });

  return (
    <main>
      <PageHeader title="My team" subtitle={`${reports.length} salesmen`} />
      <div className="p-4 sm:p-6">
        <TableScroll label="Team" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Username</th>
                <th className="px-4 py-2 font-medium">Route</th>
                <th className="px-4 py-2 font-medium">Pending</th>
                <th className="px-4 py-2 font-medium">Last login</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reports.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-slate-900">{u.fullName}</td>
                  <td className="px-4 py-2 font-mono text-xs">{u.username}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {u.ownedRoute ? `${u.ownedRoute.code}` : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">{u._count.submittedEdits}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {u.lastLoginAt?.toLocaleDateString('en-GB') ?? 'never'}
                  </td>
                </tr>
              ))}
              {reports.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-xs text-slate-400">
                    No salesmen assigned to you yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableScroll>
      </div>
    </main>
  );
}
