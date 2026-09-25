import { TableScroll } from '@/components/nmwc/TableScroll';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { UploadAccountForm, UploadCustomerForm } from './forms';

export const metadata = { title: 'Imports · NMWC' };

export default async function ImportPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // RBAC-05-009: PRD §4 reserves imports to STEWARD. Manager has no role here.
  if (session.user.role !== Role.STEWARD) redirect('/home');

  const batches = await prisma.importBatch.findMany({
    orderBy: { uploadedAt: 'desc' },
    take: 30,
    include: { uploadedBy: { select: { fullName: true } } },
  });

  return (
    <main>
      <PageHeader
        title="Import Excel"
        subtitle="Upload account masters (regions / routes / users) or customer masters (.xlsx)."
      />

      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-2">
        <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <header className="mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Account master
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              Workbook with sheets <span className="font-mono">Regions</span>,{' '}
              <span className="font-mono">Routes</span>, <span className="font-mono">Users</span>.
              Existing rows with matching keys are <em>updated</em>.
            </p>
            <details className="mt-2 rounded bg-slate-50 p-3 text-xs text-slate-700">
              <summary className="cursor-pointer select-none font-medium">
                Expected columns
              </summary>
              <div className="mt-2 grid gap-2">
                <div>
                  <strong>Regions</strong>: <code>code</code>, <code>name</code>
                </div>
                <div>
                  <strong>Routes</strong>: <code>code</code>, <code>name</code>,{' '}
                  <code>region_code</code>
                </div>
                <div>
                  <strong>Users</strong>: <code>username</code>, <code>full_name</code>,{' '}
                  <code>role</code>, <code>password</code>, <code>supervisor_username</code> (opt),{' '}
                  <code>route_code</code> (opt for SALESMAN), <code>region_codes</code> (opt
                  comma-separated for MANAGER), <code>email</code> (opt), <code>phone</code> (opt)
                </div>
              </div>
            </details>
          </header>
          <UploadAccountForm />
        </section>

        <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <header className="mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Customer master
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              First sheet only. Goes to a staged batch — review and promote afterward.
            </p>
            <details className="mt-2 rounded bg-slate-50 p-3 text-xs text-slate-700">
              <summary className="cursor-pointer select-none font-medium">
                Expected columns
              </summary>
              <div className="mt-2">
                <code>cust_code</code>, <code>cust_name</code>, <code>branch_code</code>,{' '}
                <code>branch_name</code>, <code>sales_region</code>, <code>route</code>,{' '}
                <code>address</code>, <code>phone</code>, <code>contact_person</code>,{' '}
                <code>cr_no</code>, <code>payment_terms</code>
                <p className="mt-2 text-[11px] text-slate-500">
                  Legacy uppercase headings (e.g. <code>SALES REGION</code>, <code>CUST NAME</code>)
                  are also accepted.
                </p>
              </div>
            </details>
          </header>
          <UploadCustomerForm />
        </section>
      </div>

      <section className="px-4 pb-6 sm:px-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Recent batches</h2>
        <TableScroll label="Recent import batches" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">File</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">By</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Total</th>
                <th className="px-4 py-2 font-medium">Clean</th>
                <th className="px-4 py-2 font-medium">Quarantined</th>
                <th className="px-4 py-2 font-medium">Promoted</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {batches.map((b) => (
                <tr key={b.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {b.uploadedAt.toLocaleString('en-GB')}
                  </td>
                  <td className="px-4 py-2 font-medium">{b.filename}</td>
                  <td className="px-4 py-2 text-xs">{b.kind}</td>
                  <td className="px-4 py-2 text-xs text-slate-600">{b.uploadedBy.fullName}</td>
                  <td className="px-4 py-2 text-xs">{b.status}</td>
                  <td className="px-4 py-2 text-right">{b.totalRows}</td>
                  <td className="px-4 py-2 text-right text-emerald-700">{b.cleanRows}</td>
                  <td className="px-4 py-2 text-right text-amber-700">{b.quarantinedRows}</td>
                  <td className="px-4 py-2 text-right text-blue-700">{b.promotedRows}</td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      href={`/import/${b.id}`}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
              {batches.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-6 text-center text-xs text-slate-400">
                    No imports yet.
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
