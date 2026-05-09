import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { logoutAction } from '@/app/actions/auth';

export const metadata = { title: 'Home · NMWC' };

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  return (
    <main className="mx-auto max-w-2xl p-6">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-brand-900">NMWC</h1>
          <p className="text-sm text-slate-600">Customer Master</p>
        </div>
        <form action={logoutAction}>
          <button
            type="submit"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Sign out
          </button>
        </form>
      </header>
      <section className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h2 className="mb-2 text-lg font-semibold text-slate-900">
          Welcome, {session.user.name ?? session.user.username}
        </h2>
        <p className="text-sm text-slate-600">
          Role: <span className="font-medium text-slate-900">{session.user.role}</span>
        </p>
        <p className="mt-4 text-sm text-slate-500">
          M0 foundation is live. The full experience is being built milestone by milestone — see{' '}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">docs/TECH-SPEC.md §16</code>.
        </p>
      </section>
    </main>
  );
}
