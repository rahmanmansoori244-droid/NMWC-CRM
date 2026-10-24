/**
 * The sections of the customer's History page (page.tsx beside this file).
 * Server components only: no state, no photo, nothing sent to the browser but
 * the text. Each section is a <section aria-labelledby> with an h2, so it reads
 * as a named region. Laid out for a phone first: grids that stack, no table and
 * no sideways scroll. Every date is Oman's (lib/tz.ts).
 */
import Link from 'next/link';
import type { Route } from 'next';
import { omanDate, omanDateTime } from '@/lib/tz';
import {
  changeText,
  holderText,
  type ChangeEntry,
  type CreationView,
  type CustomerHistoryView,
  type FieldChange,
  type Paged,
  type RouteNote,
  type ShopChoice,
  type ShopRoutes,
  type SourceView,
  type TermsPeriod,
} from '@/lib/customer-history';

type HistoryPageHref = Route<`/customers/${string}/history` | `/customers/${string}/history?${string}`>;

/** This page, with the shop and the page kept. */
export function historyHref(customerId: string, o: { shop?: string | null; page?: number } = {}): HistoryPageHref {
  const p = new URLSearchParams();
  if (o.shop) p.set('shop', o.shop);
  if (o.page && o.page > 1) p.set('page', String(o.page));
  const qs = p.toString();
  return qs ? `/customers/${customerId}/history?${qs}` : `/customers/${customerId}/history`;
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <h2 id={id} className="mb-3 text-base font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** An Oman date, with the exact Oman time on hover. */
function Day({ at }: { at: Date }) {
  return (
    <time dateTime={at.toISOString()} title={omanDateTime(at)}>
      {omanDate(at)}
    </time>
  );
}

function DateRange({ from, until }: { from: Date; until: Date | null }) {
  return (
    <span className="whitespace-nowrap">
      <Day at={from} /> – {until ? <Day at={until} /> : 'now'}
    </span>
  );
}

function InferredBadge({ children }: { children?: React.ReactNode }) {
  return (
    <span className="inline-flex rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
      {children ?? 'On record at history start; earlier moves not recorded'}
    </span>
  );
}

function Cause({ cause }: { cause: SourceView }) {
  if (cause.raw) return <span className="font-mono text-[13px] [overflow-wrap:anywhere]">{cause.label}</span>;
  if (cause.href) {
    return (
      <Link href={cause.href} className="text-brand-700 underline underline-offset-2 [overflow-wrap:anywhere]">
        {cause.label}
      </Link>
    );
  }
  return <span className="[overflow-wrap:anywhere]">{cause.label}</span>;
}

export function Banners({ customer }: { customer: CustomerHistoryView['customer'] }) {
  if (customer.mergedInto) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Merged into{' '}
        <Link href={`/customers/${customer.mergedInto.id}`} className="font-medium underline">
          {customer.mergedInto.code}
        </Link>
        . Its shops, documents and requests are there now; below is its own history, the merge included.
      </p>
    );
  }
  if (customer.archivedAt) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Archived on <Day at={customer.archivedAt} />.
      </p>
    );
  }
  return null;
}

const STANDING: Record<Exclude<ShopChoice['standing'], 'current'>, string> = {
  archived: 'archived',
  moved: 'now another customer’s',
  gone: 'no longer on record',
};

export function ShopPicker({
  customerId,
  shops,
  selected,
}: {
  customerId: string;
  shops: ShopChoice[];
  selected: string | null;
}) {
  if (shops.length === 0) return null;
  const chip = (on: boolean) =>
    `inline-flex min-h-11 items-center rounded-full px-3 text-sm ring-1 ${
      on ? 'bg-brand-600 font-semibold text-white ring-brand-600' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'
    }`;
  return (
    <nav aria-label="Shops" className="flex flex-wrap gap-2">
      <Link href={historyHref(customerId)} aria-current={selected ? undefined : 'page'} className={chip(!selected)}>
        All shops
      </Link>
      {shops.map((s) => (
        <Link
          key={s.id}
          href={historyHref(customerId, { shop: s.id })}
          aria-current={selected === s.id ? 'page' : undefined}
          className={chip(selected === s.id)}
        >
          <span className="font-mono">{s.code}</span>
          {s.name ? <span className="ml-1.5 [overflow-wrap:anywhere]">{s.name}</span> : null}
          {s.standing !== 'current' ? <span className="ml-1.5 text-xs">({STANDING[s.standing]})</span> : null}
        </Link>
      ))}
    </nav>
  );
}

export function CreatedSection({ created, historyStart }: { created: CreationView; historyStart: Date | null }) {
  return (
    <Section id="history-created" title="Created">
      <p className="text-base text-slate-900 [overflow-wrap:anywhere]">{created.text}</p>
      {created.lineage && <p className="mt-1 text-sm text-slate-600 [overflow-wrap:anywhere]">{created.lineage}</p>}
      {created.cause?.href && (
        <p className="mt-1 text-sm">
          <Cause cause={created.cause} />
        </p>
      )}
      {historyStart && (
        <p className="mt-2 text-sm text-slate-500">
          History began on <Day at={historyStart} />: what is shown before that is the state found then.
        </p>
      )}
    </Section>
  );
}

function RouteList({ shop }: { shop: ShopRoutes }) {
  return (
    <ol aria-label={`Routes of shop ${shop.branchCode}`} className="divide-y divide-slate-100">
      {shop.periods.map((p, i) => (
        <li
          key={`${p.from.getTime()}-${i}`}
          className="grid grid-cols-1 gap-1 py-2 text-base sm:grid-cols-[10rem_minmax(0,1fr)_14rem] sm:gap-3"
        >
          <div>
            <span className="text-xs uppercase tracking-wide text-slate-500 sm:hidden">Route </span>
            <span className="font-mono font-medium text-slate-900">{p.routeCode}</span>
            {p.routeName && p.routeName !== p.routeCode && (
              <span className="block text-sm text-slate-500 [overflow-wrap:anywhere]">{p.routeName}</span>
            )}
          </div>
          <div className="min-w-0 [overflow-wrap:anywhere]">
            <span className="text-xs uppercase tracking-wide text-slate-500 sm:hidden">Salesman </span>
            <span className={p.holder.kind === 'person' ? 'text-slate-900' : 'text-slate-500'}>{holderText(p.holder)}</span>
            {p.holder.kind === 'person' && p.holder.usernameThen && (
              <span className="block text-sm text-slate-500">
                signed in as <span className="font-mono">{p.holder.usernameThen}</span> then
              </span>
            )}
          </div>
          <div className="text-slate-700">
            <span className="text-xs uppercase tracking-wide text-slate-500 sm:hidden">Dates </span>
            <DateRange from={p.from} until={p.until} />
            {p.inferred && (
              <span className="mt-1 block">
                <InferredBadge />
              </span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function NoteLine({ note }: { note: RouteNote }) {
  if (note.kind === 'merged') {
    return (
      <li>
        Merged into{' '}
        {note.mergedIntoId ? (
          <Link href={`/customers/${note.mergedIntoId}`} className="font-medium underline">
            {note.mergedIntoCode ?? 'another customer'}
          </Link>
        ) : (
          'another customer'
        )}{' '}
        from <Day at={note.from} />; its shops are served under that customer.
      </li>
    );
  }
  return (
    <li>
      No shop of this customer is on record before {note.to ? <Day at={note.to} /> : 'now'} (history start).
    </li>
  );
}

export function RoutesSection({
  routes,
  shopView,
}: {
  routes: CustomerHistoryView['routes'];
  shopView: boolean;
}) {
  return (
    <Section id="history-routes" title={shopView ? 'Routes that served this shop' : 'Routes that served this customer'}>
      {routes.shops.length === 0 && routes.notes.length === 0 && (
        <p className="text-base text-slate-500">No route is on record.</p>
      )}
      {routes.shops.length > 0 && (
        <div
          aria-hidden="true"
          className="hidden grid-cols-[10rem_minmax(0,1fr)_14rem] gap-3 border-b border-slate-200 pb-1 text-xs font-medium uppercase tracking-wide text-slate-500 sm:grid"
        >
          <span>Route</span>
          <span>Salesman who held it</span>
          <span>From – until</span>
        </div>
      )}
      <div className="grid gap-4">
        {routes.shops.map((s) => (
          <div key={s.branchId}>
            <h3 className="mt-2 font-semibold text-slate-900">
              Shop <span className="font-mono">{s.branchCode}</span>
            </h3>
            <RouteList shop={s} />
          </div>
        ))}
      </div>
      {routes.notes.length > 0 && (
        <ul className="mt-3 grid gap-1 text-sm text-slate-600">
          {routes.notes.map((n, i) => (
            <NoteLine key={`${n.kind}-${i}`} note={n} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-2 text-base [overflow-wrap:anywhere]">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-900">{children}</dd>
    </div>
  );
}

export function TermsSection({ terms }: { terms: TermsPeriod[] }) {
  return (
    <Section id="history-terms" title="Terms over time">
      {terms.length === 0 ? (
        <p className="text-base text-slate-500">No terms are on record.</p>
      ) : (
        <ol aria-label="Terms periods" className="grid gap-3 lg:grid-cols-2">
          {terms.map((t, i) => (
            <li key={`${t.from.getTime()}-${i}`} className="rounded-md border border-slate-200 bg-slate-50 p-4">
              <p className="mb-2 font-semibold text-slate-900">
                <DateRange from={t.from} until={t.until} />
              </p>
              {t.inferred && (
                <p className="mb-2">
                  <InferredBadge>On record at history start; earlier changes not recorded</InferredBadge>
                </p>
              )}
              <dl className="grid gap-1.5">
                <Row label="Cash or credit">{t.cashCredit}</Row>
                <Row label="Credit limit">{t.limit}</Row>
                <Row label="Credit days">{t.days}</Row>
                <Row label="Temix code">
                  <span className={t.temixCode === '—' ? '' : 'font-mono text-[15px]'}>{t.temixCode}</span>
                </Row>
                <Row label="Status">{t.status}</Row>
                <Row label="Channel">{t.channel}</Row>
                <Row label="Record">
                  {t.mergedIntoId ? (
                    <Link href={`/customers/${t.mergedIntoId}`} className="underline">
                      {t.record}
                    </Link>
                  ) : (
                    t.record
                  )}
                </Row>
                <Row label="Set by">
                  {t.setBy.who}
                  <span className="block text-sm">
                    <Cause cause={t.setBy.cause} />
                  </span>
                </Row>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

function ChangeLine({ c }: { c: FieldChange }) {
  if (c.kind !== 'changed' && c.href) {
    return (
      <li>
        {c.label}:{' '}
        {c.kind === 'value' ? `${c.from} → ` : ''}
        <Link href={c.href} className="underline">
          {c.to}
        </Link>
      </li>
    );
  }
  return <li>{changeText(c)}</li>;
}

function EntryItem({ e }: { e: ChangeEntry }) {
  return (
    <li className="grid gap-1 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-slate-600">
        {e.showRecorded ? (
          <span>
            Effective{' '}
            <time dateTime={e.effective.toISOString()} className="font-medium text-slate-900">
              {omanDateTime(e.effective)}
            </time>{' '}
            · recorded <time dateTime={e.recorded.toISOString()}>{omanDateTime(e.recorded)}</time>
          </span>
        ) : (
          <time dateTime={e.effective.toISOString()} className="font-medium text-slate-900">
            {omanDateTime(e.effective)}
          </time>
        )}
        {e.inferred && <InferredBadge>Inferred: the state found when history began</InferredBadge>}
      </div>
      <p className="text-base text-slate-900 [overflow-wrap:anywhere]">{e.who}</p>
      <p className="text-sm [overflow-wrap:anywhere]">
        <Cause cause={e.cause} />
      </p>
      <div className="mt-1 grid gap-2">
        {e.records.map((r, i) => (
          <div key={`${r.subject}-${i}`} className="rounded-md bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
            <p className="text-sm font-medium text-slate-900 [overflow-wrap:anywhere]">
              {r.subject} — {r.title}
            </p>
            {r.changes.length > 0 && (
              <ul className="mt-1 grid gap-0.5 text-sm text-slate-700 [overflow-wrap:anywhere]">
                {r.changes.map((c, j) => (
                  <ChangeLine key={`${c.label}-${j}`} c={c} />
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </li>
  );
}

export function TimelineSection({
  customerId,
  shopId,
  timeline,
  truncated,
}: {
  customerId: string;
  shopId: string | null;
  timeline: Paged<ChangeEntry>;
  truncated: boolean;
}) {
  const { page, pages } = timeline;
  const pagerLink = (on: boolean) =>
    `inline-flex min-h-11 items-center rounded-md px-3 ${on ? 'text-brand-700 hover:bg-brand-50' : 'pointer-events-none text-slate-400'}`;
  return (
    <Section id="history-changes" title="Every change">
      {truncated && (
        <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          Only the latest 5,000 changes are listed; older ones are in the audit log.
        </p>
      )}
      {timeline.total === 0 ? (
        <p className="text-base text-slate-500">No change is on record.</p>
      ) : (
        <ol aria-label="Changes" className="divide-y divide-slate-200">
          {timeline.items.map((e) => (
            <EntryItem key={e.key} e={e} />
          ))}
        </ol>
      )}
      {pages > 1 && (
        <nav aria-label="Pages of changes" className="mt-4 flex items-center justify-between gap-2 text-sm">
          <Link
            href={historyHref(customerId, { shop: shopId, page: Math.max(1, page - 1) })}
            aria-disabled={page === 1}
            className={pagerLink(page > 1)}
          >
            ← Newer
          </Link>
          <span className="text-slate-600">
            Page {page} of {pages}
          </span>
          <Link
            href={historyHref(customerId, { shop: shopId, page: Math.min(pages, page + 1) })}
            aria-disabled={page === pages}
            className={pagerLink(page < pages)}
          >
            Older →
          </Link>
        </nav>
      )}
    </Section>
  );
}
