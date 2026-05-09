import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { ApproveRejectActions } from './ApproveRejectActions';

export const metadata = { title: 'Approval · NMWC' };

type FieldChange = { field: string; before: unknown; after: unknown };

export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.SUPERVISOR && session.user.role !== Role.MANAGER) {
    redirect('/home');
  }
  const { id } = await params;

  const edit = await prisma.customerEdit.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, legalName: true, nmwcCode: true } },
      submittedBy: { select: { id: true, fullName: true, supervisorId: true } },
      reviewedBy: { select: { fullName: true } },
    },
  });
  if (!edit) notFound();

  // Supervisor can only approve their own team's edits
  if (
    session.user.role === Role.SUPERVISOR &&
    edit.submittedBy.supervisorId !== session.user.id
  ) {
    redirect('/approvals');
  }

  const changes = (edit.fieldChanges as unknown as FieldChange[]) ?? [];
  const customerChanges = changes.filter((c) => c.field.startsWith('customer.'));
  const branchChangesByBranch = new Map<string, FieldChange[]>();
  for (const c of changes) {
    if (c.field.startsWith('branch.')) {
      const rest = c.field.slice('branch.'.length);
      const dot = rest.indexOf('.');
      if (dot < 0) continue;
      const branchId = rest.slice(0, dot);
      const list = branchChangesByBranch.get(branchId) ?? [];
      list.push({ ...c, field: rest.slice(dot + 1) });
      branchChangesByBranch.set(branchId, list);
    }
  }

  // Resolve branch names
  const branchIds = [...branchChangesByBranch.keys()];
  const branches = branchIds.length
    ? await prisma.branch.findMany({
        where: { id: { in: branchIds } },
        select: { id: true, branchName: true, route: { select: { code: true } } },
      })
    : [];
  const branchMap = new Map(branches.map((b) => [b.id, b]));

  const isPending = edit.state === 'SUBMITTED';

  return (
    <main className="pb-24">
      <PageHeader
        title={edit.customer?.legalName ?? '—'}
        subtitle={`${edit.customer?.nmwcCode} · submitted by ${edit.submittedBy.fullName}${edit.submittedAt ? ' · ' + new Date(edit.submittedAt).toLocaleString('en-GB') : ''}`}
        actions={
          <Link
            href={`/customers/${edit.customerId}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Open profile
          </Link>
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        {!isPending && (
          <div
            className={`rounded-md px-3 py-2 text-sm font-medium ring-1 ring-inset ${
              edit.state === 'APPROVED'
                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                : 'bg-amber-50 text-amber-800 ring-amber-200'
            }`}
          >
            Decision: <strong>{edit.state}</strong>
            {edit.reviewedBy ? ` by ${edit.reviewedBy.fullName}` : ''}
            {edit.reviewedAt ? ` on ${new Date(edit.reviewedAt).toLocaleString('en-GB')}` : ''}
            {edit.decisionReason ? (
              <p className="mt-1 italic">&ldquo;{edit.decisionReason}&rdquo;</p>
            ) : null}
          </div>
        )}

        {customerChanges.length > 0 && (
          <DiffSection title="Customer">
            {customerChanges.map((c) => (
              <DiffRow
                key={c.field}
                label={c.field.replace('customer.', '')}
                before={c.before}
                after={c.after}
              />
            ))}
          </DiffSection>
        )}

        {[...branchChangesByBranch.entries()].map(([branchId, list]) => {
          const b = branchMap.get(branchId);
          return (
            <DiffSection key={branchId} title={`Branch: ${b?.branchName ?? branchId} (${b?.route.code ?? ''})`}>
              {list.map((c) => (
                <DiffRow key={c.field} label={c.field} before={c.before} after={c.after} />
              ))}
            </DiffSection>
          );
        })}

        {changes.length === 0 && (
          <p className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-600">
            No field changes were captured on this edit.
          </p>
        )}
      </div>

      {isPending && (
        <div className="sticky bottom-0 -mx-4 mt-4 border-t border-slate-200 bg-white p-4 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] sm:-mx-6 sm:p-6">
          <ApproveRejectActions editId={edit.id} />
        </div>
      )}
    </main>
  );
}

function DiffSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
      <header className="border-b border-slate-200 bg-slate-50 px-4 py-2">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      </header>
      <div className="divide-y divide-slate-100">{children}</div>
    </section>
  );
}

function DiffRow({
  label,
  before,
  after,
}: {
  label: string;
  before: unknown;
  after: unknown;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr_1fr] gap-3 px-4 py-3 text-sm">
      <div className="font-medium text-slate-600">{label}</div>
      <div className="rounded-md bg-red-50 px-2 py-1 text-red-700 ring-1 ring-red-200">
        <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">Before</div>
        <div className="break-words">{formatValue(before)}</div>
      </div>
      <div className="rounded-md bg-emerald-50 px-2 py-1 text-emerald-700 ring-1 ring-emerald-200">
        <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">After</div>
        <div className="break-words">{formatValue(after)}</div>
      </div>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toLocaleString('en-GB');
  return JSON.stringify(v);
}
