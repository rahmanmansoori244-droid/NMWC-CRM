import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';

export const metadata = { title: 'Audit log · NMWC' };

export default async function AuditPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.MANAGER) redirect('/home');

  const logs = await prisma.auditLog.findMany({
    orderBy: { at: 'desc' },
    take: 100,
    include: { actor: { select: { fullName: true, username: true } } },
  });

  return (
    <main>
      <PageHeader title="Audit log" subtitle="Last 100 events" />
      <div className="p-4 sm:p-6">
        <div className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
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
                    No audit entries yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
