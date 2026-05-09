/**
 * GAP-04: branded 404 page. Replaces Next.js's default which has no
 * "go back" affordance and confuses users who got bounced from a customer
 * they're not in scope for (notFound() is used by lib/access for clean 404s).
 */
import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <section className="max-w-md rounded-lg bg-white p-6 text-center shadow-sm ring-1 ring-slate-200">
        <h1 className="text-3xl font-bold text-brand-900">404</h1>
        <p className="mt-2 text-sm text-slate-600">
          That page doesn&apos;t exist or isn&apos;t available to your account.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link
            href="/home"
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Go to home
          </Link>
          <Link
            href="/profile"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            My profile
          </Link>
        </div>
      </section>
    </main>
  );
}
