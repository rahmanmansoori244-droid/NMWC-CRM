import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Prisma, Role } from '@prisma/client';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { omanDateTime } from '@/lib/tz';
import { omanDayStart } from '@/lib/change-context';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { TableScroll } from '@/components/nmwc/TableScroll';
import { SPELL_CODE_LABEL, SPELL_OPENED, summaryCountsOf, type SpellCode } from '@/lib/temix-daily-finalize';
import { loadDayDate, loadDaySummaryInput, loadLatestSpellRows } from '@/lib/temix-daily-day-load';
import { loadSwitchedOffRoutesHoldingShops } from '@/lib/temix-daily-check-load';
import { summaryText } from '@/lib/temix-daily-summary';
import { TEMIX_DAILY_SUMMARY_ENABLED } from '@/lib/temix-daily-policy';
import { dateColumnDay } from '@/lib/temix-daily-order';
import { LOADED_FILE_LINES, markAllLabel } from '@/lib/temix-daily-review';
import { TemixDailyReviewButton } from './review-form';

export const metadata = { title: 'Temix daily: the day · NMWC' };

/** Lines listed per section; the counts beside each title are always complete. */
const LIST_MAX = 200;

const n = (x: number) => x.toLocaleString('en-US');

type SectionKey = 'moves' | 'confirmed' | 'missing' | 'accountant' | 'names' | 'routes';

const SECTIONS: ReadonlyArray<{ key: SectionKey; title: string; note: string; where: Prisma.TemixChangeWhereInput }> = [
  {
    key: 'moves',
    title: 'Shops moved to another route',
    note: 'Applied, dated the load day. Each customer’s History page shows the route it was on before.',
    where: { kind: 'ROUTE_MOVE', applied: true },
  },
  {
    key: 'confirmed',
    title: 'Temix codes confirmed',
    note: 'Customers made in the CRM whose Temix code, typed by the Accountant, a row of the file carries as theirs: the Temix queue went from Uploaded to Synced, and the salesman was told the customer is in Temix.',
    where: { kind: 'TEMIX_CODE_CONFIRMED', applied: true },
  },
  {
    key: 'missing',
    title: 'Customers missing from the file',
    note:
      'Live customers no row of the file names, by either code. Listed when the absence starts and when it ends, not every day. Whether the daily file is the full list waits for the owner: nothing is done about them.',
    where: { kind: 'MISSING_FROM_FILE' },
  },
  {
    key: 'accountant',
    title: 'Temix codes the Accountant typed, not in the file',
    note: 'Customers made in the CRM whose Temix code no row of the file carries as theirs yet (a held row, or one found as another customer, does not count). Listed when it starts and when the code appears.',
    where: { kind: 'ACCOUNTANT_CODE_NOT_SEEN' },
  },
  {
    key: 'names',
    title: 'Name differences (each listed once)',
    note: 'The CRM keeps its name. A difference is listed again only when Temix sends another name. The Temix name is shown while the file’s rows are kept (90 days).',
    where: { kind: 'NAME_DIFFERS' },
  },
  {
    key: 'routes',
    title: 'Switched-off routes still holding shops',
    note: 'Listed when it starts and when the route is switched on again or holds no shop.',
    where: { kind: 'ROUTE_INACTIVE' },
  },
];

const LINE_SELECT = {
  id: true,
  kind: true,
  applied: true,
  customerId: true,
  branchId: true,
  rowId: true,
  fromValue: true,
  toValue: true,
  detailCode: true,
  fileId: true,
  loadDay: true,
  createdAt: true,
  reviews: { orderBy: { reviewedAt: 'desc' as const }, take: 1, select: { reviewedAt: true, reviewedBy: { select: { fullName: true } } } },
} satisfies Prisma.TemixChangeSelect;

type Line = Prisma.TemixChangeGetPayload<{ select: typeof LINE_SELECT }>;

type Lookups = {
  customers: Map<string, { nmwcCode: string; legalName: string }>;
  branches: Map<string, string>;
  routes: Map<string, { code: string; isActive: boolean }>;
  shopsOnRoute: Map<string, number>;
  fileNames: Map<string, string>;
  temixNames: Map<string, string | null>;
};

/**
 * The daily Temix import, stage 6: the DRILL-DOWN of one load day. What the
 * day's loaded files changed (route moves) and what finalize listed for the
 * Data Steward (customers missing from the file, Accountant codes not in it,
 * name differences listed once, switched-off routes still holding shops), each
 * line with its "Reviewed" mark and a link to the customer's History page;
 * the day's summary in the words the alert would use (the alert itself is
 * switched off); and a second view of the spells still open that started on
 * an earlier day. Data Steward only. The page reads only; a mark is written by
 * services/temix-daily-review.ts.
 */
export default async function TemixDailyDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ loadDay: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== Role.STEWARD) redirect('/home');
  const { loadDay } = await params;
  const { view } = await searchParams;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(loadDay) || !omanDayStart(loadDay)) notFound();
  const day = loadDayDate(loadDay);
  const showOpen = view === 'open';

  const files = await prisma.temixDailyFile.findMany({
    where: { loadDay: day },
    orderBy: { uploadedAt: 'asc' },
    select: { id: true, filename: true, state: true, totalRows: true, appliedRows: true, noChangeRows: true, heldRows: true, noticeRows: true, loadedAt: true },
  });
  const summaryInput = await loadDaySummaryInput(prisma, loadDay);
  const summary = summaryText(loadDay, summaryCountsOf(summaryInput.changes, summaryInput.heldRows));
  const unreviewed = await prisma.temixChange.count({ where: { loadDay: day, ...LOADED_FILE_LINES, reviews: { none: {} } } });

  // The lines: of this day, or the spells still open that started before it.
  let sections: Array<{ key: SectionKey; title: string; note: string; total: number; lines: Line[] }> = [];
  let openEarlier: Line[] = [];
  let openEarlierTotal = 0;
  if (showOpen) {
    const latest = (await loadLatestSpellRows(prisma)).filter((s) => s.detailCode === SPELL_OPENED && s.loadDay < day);
    openEarlierTotal = latest.length;
    openEarlier = await prisma.temixChange.findMany({
      where: { id: { in: latest.slice(0, LIST_MAX * 3).map((s) => s.id) } },
      orderBy: [{ loadDay: 'asc' }, { id: 'asc' }],
      select: LINE_SELECT,
    });
  } else {
    sections = await Promise.all(
      SECTIONS.map(async (s) => {
        const where = { ...s.where, loadDay: day, ...LOADED_FILE_LINES };
        const [total, lines] = await Promise.all([
          prisma.temixChange.count({ where }),
          prisma.temixChange.findMany({ where, orderBy: { id: 'asc' }, take: LIST_MAX, select: LINE_SELECT }),
        ]);
        return { ...s, total, lines };
      })
    );
  }
  const all = [...sections.flatMap((s) => s.lines), ...openEarlier];
  const L = await lookups(all);

  return (
    <main>
      <PageHeader
        title={`Temix daily: ${loadDay}`}
        subtitle="What the day's loaded files changed, and what was listed for you to look at. Nothing on this page changes a customer."
        actions={
          <>
            <Link href="/temix-daily" className="text-sm font-medium text-brand-700 hover:underline">
              All daily files
            </Link>
          </>
        }
      />
      <div className="space-y-4 p-4 sm:p-6">
        <section aria-labelledby="summary-h" className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 id="summary-h" className="text-sm font-semibold text-slate-800">
            The day&apos;s summary
          </h2>
          <p className="mt-1 text-sm text-slate-800">{summary.body}</p>
          <p className="mt-2 text-xs text-slate-500">
            {TEMIX_DAILY_SUMMARY_ENABLED
              ? 'The same words go to the Data Steward as one alert a day.'
              : 'These are the words of the daily alert. The alert itself is switched off: nothing is sent yet.'}
          </p>
          {files.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-slate-700">
              {files.map((f) => (
                <li key={f.id}>
                  <Link href={`/temix-daily/${f.id}`} className="font-medium text-brand-700 hover:underline">
                    {f.filename}
                  </Link>{' '}
                  {f.state === 'LOADED'
                    ? `loaded ${f.loadedAt ? omanDateTime(f.loadedAt) : ''}: ${n(f.appliedRows)} applied, ${n(f.noChangeRows)} no change, ${n(f.heldRows)} held, ${n(f.noticeRows)} listed`
                    : `(${f.state.toLowerCase()}: nothing is listed for it until it is loaded)`}
                </li>
              ))}
            </ul>
          )}
        </section>

        <nav aria-label="Views" className="flex flex-wrap items-center gap-3 text-sm">
          <Link href={`/temix-daily/day/${loadDay}`} className={showOpen ? 'text-brand-700 hover:underline' : 'font-semibold text-slate-900'} aria-current={showOpen ? undefined : 'page'}>
            This day
          </Link>
          <Link
            href={`/temix-daily/day/${loadDay}?view=open`}
            className={showOpen ? 'font-semibold text-slate-900' : 'text-brand-700 hover:underline'}
            aria-current={showOpen ? 'page' : undefined}
          >
            Still open from earlier days
          </Link>
          {!showOpen && unreviewed > 0 && (
            <span className="ml-auto">
              <TemixDailyReviewButton loadDay={loadDay} label={markAllLabel(unreviewed)} />
            </span>
          )}
        </nav>

        {showOpen ? (
          <section aria-labelledby="open-h" className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 id="open-h" className="text-sm font-semibold text-slate-800">
              Still open, started before {loadDay} ({n(openEarlierTotal)})
            </h2>
            <p className="mt-1 text-xs text-slate-600">Each closes by itself when the customer, code or route is in order in a later file.</p>
            <Lines lines={openEarlier} L={L} loadDay={loadDay} withDay />
          </section>
        ) : (
          sections.map((s) => (
            <section key={s.key} aria-labelledby={`${s.key}-h`} className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <h2 id={`${s.key}-h`} className="text-sm font-semibold text-slate-800">
                {s.title} ({n(s.total)})
              </h2>
              <p className="mt-1 text-xs text-slate-600">{s.note}</p>
              {s.total > s.lines.length && <p className="mt-1 text-xs text-slate-500">The first {n(s.lines.length)} are listed.</p>}
              {s.lines.length > 0 && <Lines lines={s.lines} L={L} loadDay={loadDay} />}
            </section>
          ))
        )}
      </div>
    </main>
  );
}

/** Codes, names and counts for the lines: read by id, once. */
async function lookups(lines: readonly Line[]): Promise<Lookups> {
  const customerIds = [...new Set(lines.flatMap((l) => (l.customerId ? [l.customerId] : [])))];
  const branchIds = [...new Set(lines.flatMap((l) => (l.branchId ? [l.branchId] : [])))];
  const routeIds = [
    ...new Set(lines.flatMap((l) => (l.kind === 'ROUTE_MOVE' || l.kind === 'ROUTE_INACTIVE' ? [l.fromValue, l.toValue] : [])).filter((x): x is string => !!x)),
  ];
  const fileIds = [...new Set(lines.map((l) => l.fileId))];
  const nameRowIds = lines.flatMap((l) => (l.kind === 'NAME_DIFFERS' && l.rowId ? [l.rowId] : []));
  const [customers, branches, routes, held, files, names] = await Promise.all([
    customerIds.length ? prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, nmwcCode: true, legalName: true } }) : [],
    branchIds.length ? prisma.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, branchCode: true } }) : [],
    routeIds.length ? prisma.route.findMany({ where: { id: { in: routeIds } }, select: { id: true, code: true, isActive: true } }) : [],
    lines.some((l) => l.kind === 'ROUTE_INACTIVE') ? loadSwitchedOffRoutesHoldingShops(prisma) : [],
    fileIds.length ? prisma.temixDailyFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, filename: true } }) : [],
    // The file's name for a name difference: only that field, only while the row keeps its payload.
    nameRowIds.length
      ? prisma.$queryRaw<Array<{ id: string; name: string | null }>>(Prisma.sql`
          SELECT r."id", r."parsed"->>'custName' AS "name" FROM "TemixDailyRow" r WHERE r."id" = ANY(${nameRowIds}::text[])`)
      : [],
  ]);
  return {
    customers: new Map(customers.map((c) => [c.id, { nmwcCode: c.nmwcCode, legalName: c.legalName }])),
    branches: new Map(branches.map((b) => [b.id, b.branchCode])),
    routes: new Map(routes.map((r) => [r.id, { code: r.code, isActive: r.isActive }])),
    shopsOnRoute: new Map(held.map((r) => [r.id, r.shops])),
    fileNames: new Map(files.map((f) => [f.id, f.filename])),
    temixNames: new Map(names.map((r) => [r.id, r.name])),
  };
}

function Lines({ lines, L, loadDay, withDay = false }: { lines: readonly Line[]; L: Lookups; loadDay: string; withDay?: boolean }) {
  return (
    <TableScroll label="Lines of the day" className="mt-3 rounded-md ring-1 ring-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {withDay && (
              <th scope="col" className="px-3 py-2 font-medium">
                Since
              </th>
            )}
            <th scope="col" className="px-3 py-2 font-medium">
              Customer, route or code
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              What
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              File
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Reviewed
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {lines.map((l) => {
            const id = l.id.toString();
            const review = l.reviews[0];
            return (
              <tr key={id} className="align-top">
                {withDay && <td className="px-3 py-2 font-mono text-xs">{dateColumnDay(l.loadDay)}</td>}
                <td className="px-3 py-2">
                  <Subject l={l} L={L} />
                </td>
                <td className="px-3 py-2 text-xs text-slate-700">
                  <What l={l} L={L} />
                </td>
                <td className="px-3 py-2 text-xs">
                  <Link href={`/temix-daily/${l.fileId}`} className="text-brand-700 hover:underline">
                    {L.fileNames.get(l.fileId) ?? l.fileId}
                  </Link>
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {review ? (
                    `${review.reviewedBy.fullName}, ${omanDateTime(review.reviewedAt)}`
                  ) : withDay ? (
                    <TemixDailyReviewButton loadDay={dateColumnDay(l.loadDay)} changeId={id} />
                  ) : (
                    <TemixDailyReviewButton loadDay={loadDay} changeId={id} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}

function Subject({ l, L }: { l: Line; L: Lookups }) {
  if (l.kind === 'ROUTE_INACTIVE') {
    const r = l.toValue ? L.routes.get(l.toValue) : undefined;
    return <span className="font-mono text-xs">{r?.code ?? l.toValue}</span>;
  }
  const c = l.customerId ? L.customers.get(l.customerId) : undefined;
  if (!l.customerId) return <span className="text-xs text-slate-500">-</span>;
  return (
    <span>
      <Link href={`/customers/${l.customerId}/history`} className="font-mono text-xs text-brand-700 hover:underline">
        {c?.nmwcCode ?? l.customerId}
      </Link>
      {c && <span className="block text-xs text-slate-600">{c.legalName}</span>}
      {l.branchId && <span className="block font-mono text-xs text-slate-500">{L.branches.get(l.branchId) ?? l.branchId}</span>}
    </span>
  );
}

function What({ l, L }: { l: Line; L: Lookups }) {
  const spell = l.detailCode && l.detailCode in SPELL_CODE_LABEL ? SPELL_CODE_LABEL[l.detailCode as SpellCode] : null;
  const route = (id: string | null) => (id ? (L.routes.get(id)?.code ?? id) : '-');
  switch (l.kind) {
    case 'ROUTE_MOVE':
      return (
        <span>
          From route <span className="font-mono">{route(l.fromValue)}</span> to <span className="font-mono">{route(l.toValue)}</span>
          {l.detailCode === 'VIA_ROUTE_MAP' ? ' (through the route map)' : ''}
        </span>
      );
    case 'TEMIX_CODE_CONFIRMED':
      return <span>Temix code confirmed: Uploaded to Synced</span>;
    case 'MISSING_FROM_FILE':
      return <span>Missing from the file: {spell}</span>;
    case 'ACCOUNTANT_CODE_NOT_SEEN':
      return (
        <span>
          Temix code <span className="font-mono">{l.toValue}</span> not in the file: {spell}
        </span>
      );
    case 'ROUTE_INACTIVE': {
      const shops = l.toValue ? (L.shopsOnRoute.get(l.toValue) ?? 0) : 0;
      return (
        <span>
          Switched off, holding shops: {spell}
          {l.detailCode === SPELL_OPENED && ` (${n(shops)} live shop${shops === 1 ? '' : 's'} on it now)`}
        </span>
      );
    }
    case 'NAME_DIFFERS': {
      const name = l.rowId ? L.temixNames.get(l.rowId) : undefined;
      return <span>Temix writes: {name ? <q>{name}</q> : <em>(the file&apos;s row has been cleared)</em>}</span>;
    }
    default:
      return <span>{l.kind}</span>;
  }
}
