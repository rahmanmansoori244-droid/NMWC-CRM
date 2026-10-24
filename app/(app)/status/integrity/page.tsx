import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { TableScroll } from '@/components/nmwc/TableScroll';
import { omanDateTime } from '@/lib/tz';
import { CHECKS, CHECK_BY_ID } from '@/lib/integrity/checks';
import { INTEGRITY_INAPP_ALERTS_ENABLED } from '@/lib/integrity/policy';
import { CUSTOMER_SAMPLES, SHOP_SAMPLES, loadIntegrityReport, type IntegrityReport, type ResultRow } from '@/lib/integrity/report';

export const metadata = { title: 'Integrity · NMWC' };
export const dynamic = 'force-dynamic';

/**
 * Gap 29 and gap 28 (data audit 2026-10-10): what the nightly integrity watch
 * found (app/api/cron/integrity-watch), for the Data Steward only.
 *
 * The latest run, check by check — what it found, why it matters and what to do —
 * with its samples resolved to links where they are customers or shops; each
 * check's last fourteen runs; the last ten seals of the ledgers; and the last
 * thirty days of what the retention rules deleted (PurgeSummary). Ids and counts
 * only are stored; a customer's code is read here, at view time, for the link.
 */
export default async function IntegrityPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'STEWARD') redirect('/home');

  let report: IntegrityReport | null = null;
  try {
    report = await loadIntegrityReport(prisma);
  } catch {
    report = null;
  }

  return (
    <main>
      <PageHeader
        title="Integrity"
        subtitle="What the nightly data check found, whether the ledgers still match their seals, and what the clean-ups deleted. Counts and record links only."
      />
      <div className="space-y-6 p-4 sm:p-6">
        <p className="text-sm">
          <Link href="/status" className="font-medium text-brand-700 hover:underline">
            Back to Service status
          </Link>
        </p>
        {!report ? (
          <p className="rounded-md bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
            The results could not be read just now. Reload the page; if it stays, the integrity tables may not be installed on this
            database yet.
          </p>
        ) : (
          <>
            <LatestRun report={report} />
            <Seals report={report} />
            <Purges report={report} />
          </>
        )}
      </div>
    </main>
  );
}

const TONE: Record<string, string> = {
  pass: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  fail: 'bg-red-50 text-red-700 ring-red-200',
  info: 'bg-slate-100 text-slate-600 ring-slate-200',
  error: 'bg-amber-50 text-amber-800 ring-amber-200',
};
const DOT: Record<string, string> = { pass: 'bg-emerald-500', fail: 'bg-red-500', info: 'bg-slate-400', error: 'bg-amber-500' };

function Badge({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${TONE[status] ?? TONE.info}`}>
      {status}
    </span>
  );
}

function Samples({ r, report }: { r: ResultRow; report: IntegrityReport }) {
  if (r.sampleIds.length === 0) return null;
  const linkable = CUSTOMER_SAMPLES.has(r.checkId) || SHOP_SAMPLES.has(r.checkId);
  return (
    <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-slate-600">
      <span className="text-slate-500">Examples:</span>
      {r.sampleIds.map((id) => {
        const c = linkable ? report.customerOf.get(id) : undefined;
        return c ? (
          <Link key={id} href={`/customers/${c.id}`} className="font-mono text-brand-700 hover:underline">
            {c.code}
          </Link>
        ) : (
          <span key={id} className="font-mono">
            {id}
          </span>
        );
      })}
      {r.count !== null && r.count > r.sampleIds.length && <span>…</span>}
    </p>
  );
}

function LatestRun({ report }: { report: IntegrityReport }) {
  if (!report.latestRunAt) {
    return (
      <section className="rounded-lg bg-white p-5 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">
        The nightly check has not run yet. It runs at 06:30 Oman time (app/api/cron/integrity-watch).
      </section>
    );
  }
  const byId = new Map(report.latest.map((r) => [r.checkId, r]));
  const failing = report.latest.filter((r) => r.status === 'fail').length;
  return (
    <section aria-labelledby="latest-heading" className="space-y-3">
      <h2 id="latest-heading" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Last run · {omanDateTime(report.latestRunAt)} · {failing} failing
      </h2>
      {!INTEGRITY_INAPP_ALERTS_ENABLED && (
        <p className="text-xs text-slate-500">
          The in-app alert is not switched on yet (it follows this release); a failing check reaches the operators’ alert channel
          and this page.
        </p>
      )}
      <ul className="space-y-2">
        {CHECKS.map((c) => {
          const r = byId.get(c.id);
          const trend = report.trend.get(c.id) ?? [];
          return (
            <li key={c.id} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-900">
                  {c.title}
                  {r?.count !== null && r?.count !== undefined && <span className="ml-2 tabular-nums text-slate-600">{r.count}</span>}
                </p>
                <div className="flex items-center gap-2">
                  <span className="flex gap-0.5" aria-label={`last ${trend.length} runs`}>
                    {trend.map((s, i) => (
                      <span key={i} title={s} className={`inline-block h-2 w-2 rounded-full ${DOT[s] ?? DOT.info}`} />
                    ))}
                  </span>
                  <Badge status={r?.status ?? 'info'} />
                </div>
              </div>
              <p className="mt-1 text-xs text-slate-600">{c.why}</p>
              {r && (r.status === 'fail' || r.status === 'error') && (
                <p className="mt-1 text-xs text-slate-800">
                  <span className="font-semibold">What to do: </span>
                  {r.status === 'error' ? 'The check could not run tonight; it runs again tomorrow. If it stays, tell the operators.' : c.remedy}
                </p>
              )}
              {r && <Samples r={r} report={report} />}
              {!r && <p className="mt-1 text-xs text-slate-500">Not in the last run.</p>}
            </li>
          );
        })}
        {report.latest
          .filter((r) => !CHECK_BY_ID.has(r.checkId))
          .map((r) => (
            <li key={r.checkId} className="rounded-lg bg-white p-4 text-sm shadow-sm ring-1 ring-slate-200">
              {r.checkId} <Badge status={r.status} />
            </li>
          ))}
      </ul>
    </section>
  );
}

function Seals({ report }: { report: IntegrityReport }) {
  return (
    <section aria-labelledby="seals-heading">
      <h2 id="seals-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Ledger seals (last 10)
      </h2>
      {report.seals.length === 0 ? (
        <p className="rounded-lg bg-white p-4 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">
          No seal yet. The first night writes the genesis; the second seals every ledger row that existed then.
        </p>
      ) : (
        <TableScroll label="Ledger seals" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2">Seal</th>
                <th className="px-3 py-2">Day</th>
                <th className="px-3 py-2">Hash</th>
                <th className="px-3 py-2">Rows sealed</th>
                <th className="px-3 py-2">Tables</th>
              </tr>
            </thead>
            <tbody>
              {report.seals.map((s) => (
                <tr key={s.seq} className="border-t border-slate-100 tabular-nums">
                  <td className="px-3 py-2">{s.seq === 0 ? '0 (genesis)' : s.seq}</td>
                  <td className="px-3 py-2">{s.day}</td>
                  <td className="px-3 py-2 font-mono">{s.hash.slice(0, 16)}</td>
                  <td className="px-3 py-2">{s.rows.toLocaleString('en-US')}</td>
                  <td className="px-3 py-2">{s.tables}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Whether the chain and the off-site copies still match is the two seal checks above. The full chain is checked with
        scripts/ops/verify-seals.ts (docs/OPERATIONS.md section 5k).
      </p>
    </section>
  );
}

function Purges({ report }: { report: IntegrityReport }) {
  return (
    <section aria-labelledby="purges-heading">
      <h2 id="purges-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        What the clean-ups deleted (last 30 days)
      </h2>
      {report.purges.length === 0 ? (
        <p className="rounded-lg bg-white p-4 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">Nothing was deleted in the last 30 days.</p>
      ) : (
        <TableScroll label="Purge summaries" className="rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2">Rule</th>
                <th className="px-3 py-2">Table</th>
                <th className="px-3 py-2">Batches</th>
                <th className="px-3 py-2">Rows</th>
                <th className="px-3 py-2">Oldest</th>
                <th className="px-3 py-2">Newest</th>
              </tr>
            </thead>
            <tbody>
              {report.purges.map((p) => (
                <tr key={`${p.rule}-${p.tableName}`} className="border-t border-slate-100 tabular-nums">
                  <td className="px-3 py-2 font-mono">{p.rule}</td>
                  <td className="px-3 py-2">{p.tableName}</td>
                  <td className="px-3 py-2">{p.batches}</td>
                  <td className="px-3 py-2">{p.rows.toLocaleString('en-US')}</td>
                  <td className="px-3 py-2">{p.oldestAt ? omanDateTime(p.oldestAt) : '—'}</td>
                  <td className="px-3 py-2">{p.newestAt ? omanDateTime(p.newestAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      <p className="mt-2 text-xs text-slate-500">
        One summary is kept for every batch a retention rule deletes (docs/compliance/DATA-RETENTION-SCHEDULE.md); the summaries are
        kept for ever.
      </p>
    </section>
  );
}
