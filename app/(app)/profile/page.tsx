import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { logoutAction } from '@/app/actions/auth';
import { PageHeader } from '@/components/nmwc/PageHeader';

export const metadata = { title: 'Profile · NMWC' };

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    include: {
      ownedRoute: { include: { region: true } },
      supervisor: { select: { fullName: true } },
    },
  });

  return (
    <main>
      <PageHeader title="My profile" subtitle="Account and assignments" />
      <div className="p-4 sm:p-6">
        <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <dl className="grid gap-3 text-sm">
            <Row label="Full name" value={user.fullName} />
            <Row label="Username" value={user.username} mono />
            <Row label="Role" value={user.role} />
            <Row label="Email" value={user.email ?? '—'} />
            <Row label="Phone" value={user.phone ?? '—'} />
            <Row label="Reports to" value={user.supervisor?.fullName ?? '—'} />
            <Row
              label="Route"
              value={
                user.ownedRoute
                  ? `${user.ownedRoute.code} · ${user.ownedRoute.name} (${user.ownedRoute.region.name})`
                  : '—'
              }
            />
            <Row
              label="Last login"
              value={user.lastLoginAt?.toLocaleString('en-GB') ?? 'never'}
            />
          </dl>
          <div className="mt-6 flex flex-wrap gap-2">
            {/* AUTH-16: self-service password change. */}
            <Link
              href="/profile/change-password"
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Change password
            </Link>
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Sign out
              </button>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className={`text-slate-900 ${mono ? 'font-mono text-[13px]' : ''}`}>{value}</dd>
    </div>
  );
}
