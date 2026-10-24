import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { canSeeCustomerHistory } from '@/lib/permissions';
import { loadCustomerHistory } from '@/lib/customer-history-load';
import { PageHeader } from '@/components/nmwc/PageHeader';
import {
  Banners,
  CreatedSection,
  RoutesSection,
  ShopPicker,
  TermsSection,
  TimelineSection,
} from './HistorySections';

export const metadata = { title: 'Customer history · NMWC' };
export const dynamic = 'force-dynamic';

type Search = { shop?: string | string[]; page?: string | string[] };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The owner's goal (2026-10-11): "the history of a customer: this route served
 * it, then that route; the date it was created; who changed what and when."
 * Read from the dated history (docs/HISTORY.md §11), never from AuditLog values.
 *
 * The Data Steward only (lib/permissions.ts canSeeCustomerHistory; widening it is
 * the owner's open question), checked before anything is read, so for any other
 * role the answer is the same whether the id exists or not — as /import/[batchId],
 * /temix and /duplicates do. Archived and merged customers are shown, with a
 * banner. Opening the page records nothing: no page view is audited in this app.
 */
export default async function CustomerHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!canSeeCustomerHistory(session.user.role)) redirect('/home');
  const { id } = await params;
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(one(sp.page) ?? '1', 10) || 1);
  const shopId = one(sp.shop)?.trim() || null;

  const view = await loadCustomerHistory(
    { id: session.user.id, role: session.user.role, username: session.user.username },
    id,
    { shopId, page }
  );
  // An unknown customer, or a ?shop= that was never one of its shops.
  if (!view) notFound();
  const { customer } = view;

  return (
    <main>
      <PageHeader
        title="History"
        subtitle={`${customer.nmwcCode} · ${customer.legalName}`}
        actions={
          customer.live ? (
            <Link
              href={`/customers/${customer.id}`}
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-base font-medium text-slate-700 hover:bg-slate-50"
            >
              Back to customer
            </Link>
          ) : undefined
        }
      />
      <div className="grid gap-4 p-4 sm:p-6">
        <Banners customer={customer} />
        <ShopPicker customerId={customer.id} shops={view.shops} selected={view.shop?.id ?? null} />
        {view.shop && (
          <p className="text-sm text-slate-600">
            Showing shop <span className="font-mono">{view.shop.code}</span> only. The customer’s terms and documents
            are on “All shops”.
          </p>
        )}
        <CreatedSection created={view.created} historyStart={view.historyStart} />
        <RoutesSection routes={view.routes} shopView={!!view.shop} />
        {view.terms && <TermsSection terms={view.terms} />}
        <TimelineSection
          customerId={customer.id}
          shopId={view.shop?.id ?? null}
          timeline={view.timeline}
          truncated={view.truncated}
        />
      </div>
    </main>
  );
}
