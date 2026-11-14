import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { omanDateTime } from '@/lib/tz';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { TableScroll } from '@/components/nmwc/TableScroll';
import {
  CHECK_HOLDS,
  CHECK_HOLD_LABEL,
  ROUTE_HOLD_LABEL,
  checkDailyFile,
  pilotGate,
  type CheckPlan,
  type RouteHold,
  type TermsField,
} from '@/lib/temix-daily-check';
import { loadCheckInput, loadPilotWaiting } from '@/lib/temix-daily-check-load';
import { applyBlockedBy, dateColumnDay, overtakenBy, type DailyFileForOrder } from '@/lib/temix-daily-order';
import { PilotBanner } from '../pilot-banner';

export const metadata = { title: 'Temix daily file: check · NMWC' };

/** Lines listed per section; the counts above each list are always complete. */
const LIST_MAX = 200;

const TERMS_LABEL: Record<TermsField, string> = {
  paymentTerms: 'Payment terms',
  creditLimit: 'Credit limit',
  paymentTermDays: 'Credit days',
};
const ROUTE_HOLDS: readonly RouteHold[] = ['ROUTE_MISSING', 'ROUTE_NOT_MATCHED', 'ROUTE_AMBIGUOUS', 'ROUTE_SWITCHED_OFF'];

const n = (x: number) => x.toLocaleString('en-US');

/**
 * The daily Temix import, stage 4: the Check of one staged file. What the file
 * WOULD change if it were applied now (route moves), what it would not
 * (held rows, routes not matched), and what waits for the owner (credit and
 * terms, status, missing and unknown customers), with the pilot banner. Every
 * figure is from lib/temix-daily-check.ts checkDailyFile, made on each visit
 * from the staged rows and the CRM as it is now. NOTHING IS WRITTEN: opening
 * this page again after a route-map entry is the re-check.
 */
export default async function TemixDailyCheckPage({ params }: { params: Promise<{ fileId: string }> }) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.STEWARD) redirect('/home');
  const { fileId } = await params;

  const file = await prisma.temixDailyFile.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      filename: true,
      loadDay: true,
      uploadedAt: true,
      state: true,
      fileSha256: true,
      totalRows: true,
      sameBytesAs: { select: { loadDay: true, filename: true } },
    },
  });
  if (!file) notFound();
  const { sameBytesAs, ...fileForOrder } = file;
  const me: DailyFileForOrder = { ...fileForOrder, loadDay: dateColumnDay(file.loadDay) };
  const finished = file.state === 'LOADED' || file.state === 'DISCARDED';

  const [waiting, orderFiles] = await Promise.all([
    loadPilotWaiting(prisma),
    prisma.temixDailyFile.findMany({
      where: { state: { not: 'DISCARDED' } },
      select: { id: true, filename: true, loadDay: true, uploadedAt: true, state: true, fileSha256: true },
    }),
  ]);
  const order = orderFiles.map((f) => ({ ...f, loadDay: dateColumnDay(f.loadDay) }));
  const waits = finished ? null : applyBlockedBy(me, order);
  const overtaken = finished ? null : overtakenBy(me, order);
  const gate = pilotGate(waiting);

  let plan: CheckPlan | null = null;
  let emptied = 0;
  let codes = { customer: new Map<string, string>(), branch: new Map<string, string>(), route: new Map<string, string>() };
  if (!finished) {
    const loaded = await loadCheckInput(prisma, file.id);
    emptied = loaded.emptied;
    if (emptied === 0) {
      plan = checkDailyFile(loaded.input);
      codes = {
        customer: new Map(loaded.input.customers.map((c) => [c.id, c.nmwcCode])),
        branch: new Map(loaded.input.branches.map((b) => [b.id, b.branchCode])),
        route: new Map(loaded.input.routes.map((r) => [r.id, r.code])),
      };
    }
  }

  return (
    <main>
      <PageHeader
        title={`Check: ${file.filename}`}
        subtitle={`Load day ${me.loadDay}, uploaded ${omanDateTime(file.uploadedAt)}. This page shows what the file would do if it were applied now. Nothing is applied from here.`}
        actions={
          <>
            <Link href="/temix-daily/routes" className="text-sm font-medium text-brand-700 hover:underline">
              Route map
            </Link>
            <Link href="/temix-daily" className="text-sm font-medium text-brand-700 hover:underline">
              All daily files
            </Link>
          </>
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        <PilotBanner gate={gate} />
        {overtaken ? (
          <p role="status" className="rounded-md bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">
            This file can never be applied: the file of {overtaken.loadDay} is already applied.
          </p>
        ) : (
          waits && (
            <p role="status" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
              This file waits for the file of {waits.loadDay} (&quot;{waits.filename}&quot;): that one must be applied or discarded first.
            </p>
          )
        )}
        {sameBytesAs && (
          <p role="status" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
            Exactly the same file as {dateColumnDay(sameBytesAs.loadDay)} (&quot;{sameBytesAs.filename}&quot;).
          </p>
        )}
        {finished && (
          <p role="status" className="rounded-md bg-slate-50 p-3 text-sm text-slate-700 ring-1 ring-slate-200">
            This file is {file.state === 'LOADED' ? 'loaded' : 'discarded'}. There is nothing to check.
          </p>
        )}
        {emptied > 0 && (
          <p role="status" className="rounded-md bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">
            The contents of {n(emptied)} of this file&apos;s rows were cleared by the 90-day rule. It cannot be checked or applied: upload a new file.
          </p>
        )}
        {plan && <Preview plan={plan} codes={codes} />}
      </div>
    </main>
  );
}

function Preview({
  plan,
  codes,
}: {
  plan: CheckPlan;
  codes: { customer: Map<string, string>; branch: Map<string, string>; route: Map<string, string> };
}) {
  const c = plan.counts;
  const moves = plan.rows.filter((p) => p.move);
  const held = plan.rows.filter((p) => p.verdict === 'HELD');
  const routeKept = plan.rows.filter((p) => p.routeHold);
  const terms = plan.rows.filter((p) => p.terms.length > 0);
  const route = (id: string) => codes.route.get(id) ?? id;
  const more = (total: number) =>
    total > LIST_MAX ? <p className="px-4 py-2 text-xs text-slate-500">The first {n(LIST_MAX)} of {n(total)} are listed.</p> : null;

  return (
    <>
      <section aria-labelledby="summary-h" className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 id="summary-h" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Summary
        </h2>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Figure label="Rows" value={c.rows} />
          <Figure label="Would move a shop" value={c.wouldMove} tone="brand" />
          <Figure label="Would change nothing" value={c.noChange} />
          <Figure label="Held" value={c.held} tone="amber" />
          <Figure label="Customers found" value={c.customersMatched} />
          <Figure label="Unknown customer codes" value={c.unknownCustomers.codes} />
          <Figure label="Customers not in the file" value={c.missing.customers} />
          <Figure label="Rows whose terms differ" value={c.terms.rows} />
        </dl>
      </section>

      <section aria-labelledby="moves-h" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
        <header className="p-5 pb-2">
          <h2 id="moves-h" className="text-sm font-semibold text-slate-800">
            Will change: route moves ({n(c.moves.shops)} shops of {n(c.moves.customers)} customers)
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            {n(c.moves.crossRegion)} into a route of another region; {n(c.moves.viaMap)} through a route-map entry. A shop moves
            only when its route code is exactly a CRM route or has a route-map entry, and the route is switched on.
          </p>
        </header>
        <TableScroll label="Route moves" className="border-t border-slate-100">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Row</th>
                <th scope="col" className="px-4 py-2 font-medium">Customer</th>
                <th scope="col" className="px-4 py-2 font-medium">Shop</th>
                <th scope="col" className="px-4 py-2 font-medium">From route</th>
                <th scope="col" className="px-4 py-2 font-medium">To route</th>
                <th scope="col" className="px-4 py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {moves.slice(0, LIST_MAX).map((p) => (
                <tr key={p.rowId}>
                  <td className="px-4 py-2 font-mono text-xs">{p.rowNumber}</td>
                  <td className="px-4 py-2 font-mono text-xs">{codes.customer.get(p.customerId!)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{codes.branch.get(p.move!.branchId)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{route(p.move!.fromRouteId)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{route(p.move!.toRouteId)}</td>
                  <td className="px-4 py-2 text-xs text-slate-600">
                    {[p.move!.fromRegionId !== p.move!.toRegionId ? 'another region' : null, p.move!.via === 'MAP' ? `route map (${p.route.kind === 'MAP' ? p.route.code : ''})` : null]
                      .filter(Boolean)
                      .join('; ') || '-'}
                  </td>
                </tr>
              ))}
              {moves.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-4 text-center text-xs text-slate-500">
                    No shop would move.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableScroll>
        {more(moves.length)}
      </section>

      <section aria-labelledby="held-h" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
        <header className="p-5 pb-2">
          <h2 id="held-h" className="text-sm font-semibold text-slate-800">
            Held: {n(c.held)} rows change nothing
          </h2>
          <ul className="mt-2 space-y-0.5 text-xs text-slate-700">
            {CHECK_HOLDS.filter((h) => c.holds[h]).map((h) => (
              <li key={h}>
                {n(c.holds[h]!)}: {CHECK_HOLD_LABEL[h]}
              </li>
            ))}
          </ul>
        </header>
        <TableScroll label="Held rows" className="border-t border-slate-100">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Row</th>
                <th scope="col" className="px-4 py-2 font-medium">Customer code</th>
                <th scope="col" className="px-4 py-2 font-medium">Shop code</th>
                <th scope="col" className="px-4 py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {held.slice(0, LIST_MAX).map((p) => (
                <tr key={p.rowId} className="align-top">
                  <td className="px-4 py-2 font-mono text-xs">{p.rowNumber}</td>
                  <td className="px-4 py-2 font-mono text-xs">{p.custCodeKey ?? '-'}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <ShopCode p={p} />
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-600">{p.holds.map((h) => CHECK_HOLD_LABEL[h]).join('; ')}</td>
                </tr>
              ))}
              {held.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-center text-xs text-slate-500">
                    No row is held.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableScroll>
        {more(held.length)}
      </section>

      <section aria-labelledby="route-h" className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 id="route-h" className="text-sm font-semibold text-slate-800">
          Route not applied: {n(routeKept.length)} shops keep their route
        </h2>
        <ul className="mt-2 space-y-0.5 text-xs text-slate-700">
          {ROUTE_HOLDS.filter((h) => c.routeHolds[h]).map((h) => (
            <li key={h}>
              {n(c.routeHolds[h]!)}: {ROUTE_HOLD_LABEL[h]}
            </li>
          ))}
        </ul>
        {plan.unmatchedRoutes.length > 0 && (
          <p className="mt-2 text-xs text-slate-700">
            Route codes not matched, in all rows of the file, held rows included (rows; of them, rows of a shop found and
            not held):{' '}
            {plan.unmatchedRoutes.slice(0, 50).map((u, i) => (
              <span key={u.code}>
                {i > 0 && ', '}
                <code>{u.code}</code> ({n(u.rows)}; {n(u.shopFound)})
              </span>
            ))}
            . A code is matched only once the owner&apos;s route master is entered on the{' '}
            <Link href="/temix-daily/routes" className="font-medium text-brand-700 hover:underline">
              route map
            </Link>
            ; then open this page again.
          </p>
        )}
      </section>

      <section aria-labelledby="terms-h" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
        <header className="p-5 pb-2">
          <h2 id="terms-h" className="text-sm font-semibold text-slate-800">
            Credit and terms that differ: {n(c.terms.rows)} rows of {n(c.terms.customers)} customers (not applied)
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            Nothing here is applied: which row of a customer is its main account, and which words Temix writes in
            payment_terms, wait for the owner. Values are compared as written. Payment terms {n(c.terms.byField.paymentTerms)},
            credit limit {n(c.terms.byField.creditLimit)}, credit days {n(c.terms.byField.paymentTermDays)}.{' '}
            {n(c.terms.customersWithRowsDisagreeing)} customers have rows in this file that do not agree with each other.
          </p>
        </header>
        <TableScroll label="Credit and terms that differ" className="border-t border-slate-100">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Row</th>
                <th scope="col" className="px-4 py-2 font-medium">Customer</th>
                <th scope="col" className="px-4 py-2 font-medium">Shop code</th>
                <th scope="col" className="px-4 py-2 font-medium">In the CRM</th>
                <th scope="col" className="px-4 py-2 font-medium">In the file</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {terms.slice(0, LIST_MAX).map((p) => (
                <tr key={p.rowId} className="align-top">
                  <td className="px-4 py-2 font-mono text-xs">{p.rowNumber}</td>
                  <td className="px-4 py-2 font-mono text-xs">{codes.customer.get(p.customerId!)}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    <ShopCode p={p} />
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {p.terms.map((d) => (
                      <p key={d.field}>
                        {TERMS_LABEL[d.field]}: {d.crm ?? 'blank'}
                      </p>
                    ))}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {p.terms.map((d) => (
                      <p key={d.field}>
                        {TERMS_LABEL[d.field]}: {d.file}
                      </p>
                    ))}
                  </td>
                </tr>
              ))}
              {terms.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-4 text-center text-xs text-slate-500">
                    No row&apos;s terms differ from its customer&apos;s.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableScroll>
        {more(terms.length)}
      </section>

      <section aria-labelledby="status-h" className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 id="status-h" className="text-sm font-semibold text-slate-800">
          Status: Temix A or I beside the CRM (not compared)
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          What A and I mean in the CRM, and whether status is a customer&apos;s or a shop&apos;s, wait for the owner. Rows of
          customers found, counted by each pair.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <StatusPairs title="Customer's status" label="Temix status beside the customer's status" pairs={c.statusByCustomer} />
          <StatusPairs title="Shop's status" label="Temix status beside the shop's status" pairs={c.statusByShop} />
        </div>
      </section>

      <section aria-labelledby="missing-h" className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 id="missing-h" className="text-sm font-semibold text-slate-800">
          Customers: {n(c.unknownCustomers.codes)} unknown, {n(c.missing.customers)} not in the file
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          Unknown: {n(c.unknownCustomers.codes)} customer codes on {n(c.unknownCustomers.rows)} rows that no customer in the CRM
          has. They are held: creating customers from the file waits for the owner.
          {c.unknownCustomers.codes > 0 && (
            <>
              {' '}
              {[...new Set(plan.rows.filter((p) => p.holds.includes('CUSTOMER_UNKNOWN')).map((p) => p.custCodeKey!))]
                .slice(0, 50)
                .join(', ')}
              {c.unknownCustomers.codes > 50 && ', …'}
            </>
          )}
        </p>
        <p className="mt-2 text-xs text-slate-600">
          Not in the file: {n(c.missing.customers)} live customers that no row names by their NMWC code or Temix code (
          {n(c.missing.withoutTemixCode)} of them have no Temix code yet). Whether the daily file is the full list of
          customers waits for the owner, so nobody is flagged.
          {c.missing.customers > 0 && (
            <>
              {' '}
              {plan.missingCustomerIds
                .slice(0, 50)
                .map((id) => codes.customer.get(id))
                .join(', ')}
              {c.missing.customers > 50 && ', …'}
            </>
          )}
        </p>
      </section>
    </>
  );
}

/** The shop code as written in the file, with its capitals form beside it when the two differ. */
function ShopCode({ p }: { p: { branchCodeWritten: string | null; branchCodeKey: string | null } }) {
  const written = p.branchCodeWritten?.trim() || null;
  if (!written) return <>{p.branchCodeKey ?? '-'}</>;
  return (
    <>
      {written}
      {p.branchCodeKey && p.branchCodeKey !== written && <span className="text-slate-500"> ({p.branchCodeKey})</span>}
    </>
  );
}

function Figure({ label, value, tone }: { label: string; value: number; tone?: 'brand' | 'amber' }) {
  const cls = tone === 'brand' ? 'text-brand-700' : tone === 'amber' ? 'text-amber-700' : 'text-slate-900';
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`text-lg font-semibold ${cls}`}>{n(value)}</dd>
    </div>
  );
}

function StatusPairs({ title, label, pairs }: { title: string; label: string; pairs: CheckPlan['counts']['statusByCustomer'] }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold text-slate-600">{title}</h3>
      <TableScroll label={label} className="rounded ring-1 ring-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-1.5 font-medium">Temix</th>
              <th scope="col" className="px-3 py-1.5 font-medium">CRM</th>
              <th scope="col" className="px-3 py-1.5 text-right font-medium">Rows</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pairs.map((p) => (
              <tr key={`${p.temix}|${p.crm}`}>
                <td className="px-3 py-1.5 font-mono text-xs">{p.temix === 'NONE' ? 'not A or I' : p.temix}</td>
                <td className="px-3 py-1.5 text-xs">{p.crm}</td>
                <td className="px-3 py-1.5 text-right text-xs">{n(p.rows)}</td>
              </tr>
            ))}
            {pairs.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-3 text-center text-xs text-slate-500">
                  None.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}
