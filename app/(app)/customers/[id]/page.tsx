import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Role } from '@prisma/client';
import { loadScope, assertCanSeeCustomer } from '@/lib/access';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { CompletenessRing } from '@/components/nmwc/CompletenessRing';
import { StatusBadge } from '@/components/nmwc/StatusBadge';
import { PaymentTermsPill } from '@/components/nmwc/PaymentTermsPill';
import { BranchStatusActions } from '@/components/nmwc/BranchStatusActions';
import { MapPin, Phone, User as UserIcon, Camera, Calendar, Image as ImageIcon, Pencil } from 'lucide-react';

export const metadata = { title: 'Customer · NMWC' };

export default async function CustomerProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const { id } = await params;

  const customer = await prisma.customer.findFirst({
    where: { id, deletedAt: null },
    include: {
      channel: true,
      subChannel: true,
      crPhoto: true,
      branches: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        include: {
          region: true,
          route: true,
          shopPhoto: true,
          signboardPhoto: true,
        },
      },
      edits: {
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
          submittedBy: { select: { fullName: true, username: true } },
          reviewedBy: { select: { fullName: true, username: true } },
        },
      },
    },
  });
  if (!customer) notFound();

  // QA-001 fix — scope check before exposing the customer to the caller.
  const scope = await loadScope(session.user.id);
  const sessionUser = {
    id: session.user.id,
    role: session.user.role,
    username: session.user.username,
  };
  assertCanSeeCustomer(sessionUser, customer, scope);

  const canEdit =
    session.user.role !== Role.VIEWER &&
    session.user.role !== Role.SUPERVISOR; // supervisors approve, don't edit directly

  return (
    <main>
      <PageHeader
        title={customer.legalName}
        subtitle={customer.nmwcCode}
        actions={
          <div className="flex items-center gap-2">
            <PaymentTermsPill terms={customer.paymentTerms} />
            <StatusBadge status={customer.status} />
            <CompletenessRing value={customer.completenessScore} size={48} />
            {canEdit && (
              <Link
                href={`/customers/${customer.id}/edit`}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                <Pencil className="h-4 w-4" />
                Enrich
              </Link>
            )}
          </div>
        }
      />

      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-2">
        <Section title="Identity">
          <Row label="Legal name" value={customer.legalName} />
          <Row label="NMWC code" value={customer.nmwcCode} mono />
          <Row label="Payment terms" value={customer.paymentTerms} />
          <Row label="CR number" value={customer.crNumber ?? '—'} mono />
          <Row label="Notes" value={customer.notes ?? '—'} />
          <PhotoRow label="CR document" photo={customer.crPhoto} />
        </Section>

        <Section title="Channel & Contact">
          <Row label="Channel" value={customer.channel?.label ?? '—'} />
          <Row label="Sub-channel" value={customer.subChannel?.label ?? '—'} />
          <Row
            label="Primary phone"
            value={customer.primaryPhone ?? '—'}
            icon={<Phone className="h-4 w-4 text-slate-400" />}
          />
          <Row label="Alt phone" value={customer.altPhone ?? '—'} />
          <Row
            label="Contact"
            value={
              customer.contactPerson
                ? `${customer.contactPerson}${customer.contactRole ? ` (${customer.contactRole})` : ''}`
                : '—'
            }
            icon={<UserIcon className="h-4 w-4 text-slate-400" />}
          />
        </Section>

        <Section title={`Branches (${customer.branches.length})`} className="lg:col-span-2">
          <div className="grid gap-3 md:grid-cols-2">
            {customer.branches.map((b) => (
              <article
                key={b.id}
                className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm"
              >
                <header className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-slate-900">{b.branchName}</h3>
                    <p className="text-xs text-slate-500">
                      {b.branchCode} · {b.region.name} · {b.route.name}
                    </p>
                  </div>
                  <CompletenessRing value={b.completenessScore} size={36} />
                </header>
                <Row
                  label="Address"
                  value={b.address}
                  icon={<MapPin className="h-4 w-4 text-slate-400" />}
                />
                {b.gpsLat != null && b.gpsLng != null && (
                  <Row label="GPS" value={`${b.gpsLat.toFixed(5)}, ${b.gpsLng.toFixed(5)}`} mono />
                )}
                <Row
                  label="Day of visit"
                  value={b.dayOfVisit ?? '—'}
                  icon={<Calendar className="h-4 w-4 text-slate-400" />}
                />
                <Row label="Hours" value={b.openingHours ?? '—'} />
                <Row label="Delivery window" value={b.deliveryWindow ?? '—'} />
                <Row
                  label="Equipment"
                  value={`${b.coolersCount} coolers · ${b.standsCount} stands · ${b.emptyBottlesCount} empties`}
                />
                <div className="mt-3 flex gap-2">
                  <PhotoTile label="Shop" photo={b.shopPhoto} />
                  <PhotoTile label="Signboard" photo={b.signboardPhoto} />
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <StatusBadge status={b.status} />
                  {/* QA-008/009 — branch-level close/reactivation buttons (Salesman only) */}
                  {session.user.role === Role.SALESMAN && (
                    <BranchStatusActions branchId={b.id} status={b.status} />
                  )}
                </div>
              </article>
            ))}
          </div>
        </Section>

        {customer.edits.length > 0 && (
          <Section title="Recent activity" className="lg:col-span-2">
            <ul className="divide-y divide-slate-200 text-sm">
              {customer.edits.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900">
                      {e.submittedBy.fullName} submitted{' '}
                      {Array.isArray(e.fieldChanges) ? e.fieldChanges.length : 0} change(s)
                    </div>
                    <div className="text-xs text-slate-500">
                      {e.submittedAt?.toLocaleString('en-GB') ?? 'draft'}
                    </div>
                  </div>
                  <StatusBadge status={e.state} />
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </main>
  );
}

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200 ${className ?? ''}`}>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <dl className="grid gap-2">{children}</dl>
    </section>
  );
}

function Row({
  label,
  value,
  mono,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-start gap-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd
        className={`flex items-start gap-2 break-words text-slate-900 ${mono ? 'font-mono text-[13px]' : ''}`}
      >
        {icon}
        <span>{value}</span>
      </dd>
    </div>
  );
}

function PhotoRow({ label, photo }: { label: string; photo: { id: string } | null }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-start gap-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd>
        {photo ? (
          <span className="inline-flex items-center gap-2 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
            <Camera className="h-3 w-3" /> Captured
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-500">
            <ImageIcon className="h-3 w-3" /> Missing
          </span>
        )}
      </dd>
    </div>
  );
}

function PhotoTile({ label, photo }: { label: string; photo: { id: string } | null }) {
  return (
    <div
      className={`flex h-16 flex-1 items-center justify-center rounded-md border text-xs font-medium ${
        photo
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-dashed border-slate-300 bg-slate-50 text-slate-400'
      }`}
    >
      {photo ? <Camera className="mr-1 h-3.5 w-3.5" /> : <ImageIcon className="mr-1 h-3.5 w-3.5" />}
      {label}
    </div>
  );
}
