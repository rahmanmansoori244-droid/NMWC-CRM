import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { loadScope } from '@/lib/access';
import { loadServiceStatus, type ApprovalsScope, type JobState, type ServiceStatus } from '@/lib/service-status';
import {
  STATUS_ROLES,
  TEMIX_BACKLOG_MAX_DAYS,
  formatAge,
  formatBudget,
  formatPct,
  formatWorkingMinutes,
  sloById,
  approvalsForManager,
  queuesForManager,
  type SloId,
  type SloStatus,
} from '@/lib/service-levels';
import { omanWhen } from '@/lib/submission';

export const metadata = { title: 'Service status · NMWC' };
export const dynamic = 'force-dynamic';

/**
 * Item 9 (re-benchmark, 2026-09-24): the service levels, measured — so "is it
 * working" has an answer before a user has to complain.
 *
 * Steward and Managers (STATUS_ROLES). No customer, no error text and no named
 * person. The approval figures are people's decisions: the Data Steward sees the
 * whole company's, anyone else only those on requests in their own regions —
 * requests they can already open at /approvals/[id] — in three fixed groups
 * (lib/service-levels.ts approvalsForManager). Everything else is company-wide.
 * Targets and definitions live in lib/service-levels.ts and docs/SERVICE-LEVELS.md.
 */
export default async function StatusPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!STATUS_ROLES.includes(session.user.role)) redirect('/home');

  const viewer = session.user.role;
  // Only the Data Steward counts the whole company's approvals; anyone else
  // counts their own regions', fail-closed (no regions counts nothing).
  const scope: ApprovalsScope =
    viewer === 'STEWARD' ? 'company' : { regionIds: (await loadScope(session.user.id)).managedRegionIds };
  const s = await loadServiceStatus(scope);

  return (
    <main>
      <PageHeader
        title="Service status"
        subtitle={
          scope === 'company'
            ? 'Whether the system is keeping its promises — measured from what it records. Company-wide figures; no customer is named.'
            : 'Whether the system is keeping its promises — measured from what it records. No customer is named. Approvals count the requests in your regions; everything else is company-wide.'
        }
        actions={
          <p className="text-xs text-slate-500">
            Measured at <span className="font-medium tabular-nums">{omanWhen(s.now, s.now)}</span> Oman time
          </p>
        }
      />

      <div className="space-y-8 p-4 sm:p-6">
        <section aria-labelledby="slo-heading">
          <h2 id="slo-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Service levels
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <AvailabilityCard s={s} />
            <ApprovalsCard s={s} scope={scope} />
            <SweepCard s={s} />
            <BackupCard s={s} />
            <TemixCard s={s} />
            <ImportsCard s={s} />
          </div>
        </section>

        <section aria-labelledby="queue-heading">
          <h2 id="queue-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            {scope === 'company' ? 'Approvals waiting right now' : 'Approvals waiting in your regions'}
          </h2>
          <OpenApprovals s={s} scope={scope} />
        </section>

        <section aria-labelledby="jobs-heading">
          <h2 id="jobs-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Scheduled jobs
          </h2>
          <Jobs jobs={s.jobs} now={s.now} />
        </section>

        <section className="rounded-lg bg-white p-5 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-2 font-semibold text-slate-800">What this page does not measure</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Signing in, how fast pages open on a phone, and photo uploads. The availability probe proves the app and its
              database answered; it does not load a page.
            </li>
            <li>
              Errors a user saw. Those are in Vercel → Logs (search the Reference shown on the error screen) and in
              Sentry.
            </li>
            <li>Public holidays: the SLA calendar is Sunday–Thursday 08:00–17:00 and counts a holiday as a working day.</li>
          </ul>
        </section>
      </div>
    </main>
  );
}

// ── Cards ─────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<SloStatus, { chip: string; label: string }> = {
  met: { chip: 'bg-emerald-50 text-emerald-800 ring-emerald-200', label: 'Met' },
  'at-risk': { chip: 'bg-amber-50 text-amber-800 ring-amber-200', label: 'At risk' },
  breached: { chip: 'bg-red-50 text-red-800 ring-red-200', label: 'Missed' },
  'no-data': { chip: 'bg-slate-100 text-slate-700 ring-slate-200', label: 'Not measured yet' },
};

function SloCard({
  id,
  status,
  value,
  children,
}: {
  id: SloId;
  status: SloStatus;
  value: string;
  children?: React.ReactNode;
}) {
  const def = sloById(id);
  const tone = STATUS_TONE[status];
  const target = `Target: ${def.targetLabel}`;
  return (
    <article className="flex flex-col rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900">{def.title}</h3>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${tone.chip}`}>{tone.label}</span>
      </div>
      <p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{target}</p>
      <div className="mt-3 space-y-1 text-xs text-slate-600">{children}</div>
      <p className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-500">{def.measures}</p>
    </article>
  );
}

function Since({ since, now }: { since: Date | null; now: Date }) {
  if (!since) return null;
  return <p>Measuring since {omanWhen(since, now)} — the window fills in as days pass.</p>;
}

function Budget({ left }: { left: number | null }) {
  const line = formatBudget(left);
  return line ? <p>{line}</p> : null;
}

function AvailabilityCard({ s }: { s: ServiceStatus }) {
  const a = s.availability;
  return (
    <SloCard id="availability" status={a.status} value={formatPct(a.ratio, 2)}>
      <p className="tabular-nums">
        {a.okSlots.toLocaleString('en-GB')} of {a.total.toLocaleString('en-GB')} slots answered
        {a.failedSlots > 0 && ` · ${a.failedSlots} failed`}
        {a.silentSlots > 0 && ` · ${a.silentSlots} with no probe at all`}
      </p>
      {a.p95DbMs !== null && <p className="tabular-nums">Database round trip p95: {a.p95DbMs} ms (warm)</p>}
      <Budget left={a.budgetLeft} />
      <Since since={a.since} now={s.now} />
    </SloCard>
  );
}

const TIER_LABEL: Record<string, string> = {
  SUPERVISOR: 'Supervisor step',
  ACCOUNTANT: 'Accountant step',
  FINANCE_MANAGER: 'Finance manager step',
  GM: 'General manager step',
  MANAGER: 'Manager (reactivations)',
};

function TierLine({ label, t }: { label: string; t: { within: number; tracked: number; p50Minutes: number | null; p90Minutes: number | null } }) {
  return (
    <p className="tabular-nums">
      {label}: {t.tracked > 0 ? `${t.within}/${t.tracked} on time` : 'no tracked decisions'}
      {t.p50Minutes !== null && `, median ${formatWorkingMinutes(t.p50Minutes)}`}
      {t.p90Minutes !== null && `, slowest 10% over ${formatWorkingMinutes(t.p90Minutes)}`}
    </p>
  );
}

function ApprovalsCard({ s, scope }: { s: ServiceStatus; scope: ApprovalsScope }) {
  const a = s.approvals;
  if (scope !== 'company') {
    // A Manager: requests in their own regions only, in the three fixed groups
    // (lib/service-levels.ts approvalsForManager).
    return (
      <SloCard id="approvals" status={a.status} value={formatPct(a.ratio)}>
        <p>
          {scope.regionIds.length === 0
            ? 'You manage no regions, so no approvals are counted for you.'
            : 'Requests in your regions only.'}
        </p>
        <p className="tabular-nums">
          {a.good.toLocaleString('en-GB')} of {a.total.toLocaleString('en-GB')} decisions on time
        </p>
        {approvalsForManager(a.tiers).map((g) => (
          <TierLine key={g.group.key} label={g.group.label} t={g.decisions} />
        ))}
        <Budget left={a.budgetLeft} />
        <Since since={a.since} now={s.now} />
      </SloCard>
    );
  }
  return (
    <SloCard id="approvals" status={a.status} value={formatPct(a.ratio)}>
      <p className="tabular-nums">
        {a.good.toLocaleString('en-GB')} of {a.total.toLocaleString('en-GB')} decisions on time
      </p>
      {a.tiers
        .filter((t) => t.decided > 0)
        .map((t) => (
          <TierLine key={t.role} label={TIER_LABEL[t.role] ?? t.role} t={t} />
        ))}
      {a.untracked > 0 && (
        <p>
          {a.untracked.toLocaleString('en-GB')} decision{a.untracked === 1 ? '' : 's'} made before the SLA was recorded
          on each step, not counted.
        </p>
      )}
      <Budget left={a.budgetLeft} />
      <Since since={a.since} now={s.now} />
    </SloCard>
  );
}

function SweepCard({ s }: { s: ServiceStatus }) {
  const w = s.slaSweep;
  return (
    <SloCard id="sla-sweep" status={w.status} value={formatPct(w.ratio)}>
      <p className="tabular-nums">
        {w.okSlots} of {w.total} half-hours swept
        {w.failedSlots > 0 && ` · ${w.failedSlots} failed`}
        {w.silentSlots > 0 && ` · ${w.silentSlots} missed`}
      </p>
      <Budget left={w.budgetLeft} />
      <Since since={w.since} now={s.now} />
    </SloCard>
  );
}

function BackupCard({ s }: { s: ServiceStatus }) {
  const b = s.backup;
  return (
    <SloCard id="backup" status={b.status} value={b.total > 0 ? `${b.good}/${b.total}` : '—'}>
      <p className="tabular-nums">
        {b.total === 0
          ? 'No full day measured yet.'
          : b.missedDays === 0
            ? 'Every day had a backup.'
            : `${b.missedDays} day${b.missedDays === 1 ? '' : 's'} without a backup.`}
      </p>
      <Since since={b.since} now={s.now} />
    </SloCard>
  );
}

function TemixCard({ s }: { s: ServiceStatus }) {
  const t = s.temix;
  return (
    <SloCard
      id="temix-backlog"
      status={t.status}
      value={t.oldestWaitingSince ? formatAge(s.now.getTime() - t.oldestWaitingSince.getTime()) : 'Empty'}
    >
      <p className="tabular-nums">
        {t.waiting.toLocaleString('en-GB')} customer{t.waiting === 1 ? '' : 's'} waiting for the Temix upload
        {t.oldestWaitingSince ? '; the value above is the oldest wait' : ''} (limit {TEMIX_BACKLOG_MAX_DAYS} days).
      </p>
      {t.uploadedAwaitingTemix > 0 && (
        <p className="tabular-nums">
          {t.uploadedAwaitingTemix.toLocaleString('en-GB')} uploaded and waiting for Temix to confirm.
        </p>
      )}
    </SloCard>
  );
}

function ImportsCard({ s }: { s: ServiceStatus }) {
  const i = s.imports;
  const stuck = i.stuckPromotes + i.stuckUploads;
  return (
    <SloCard id="imports" status={i.status} value={stuck === 0 ? 'None stuck' : `${stuck} stuck`}>
      {i.stuckPromotes > 0 && (
        <p>
          {i.stuckPromotes} promote{i.stuckPromotes === 1 ? '' : 's'} interrupted — the Data Steward resumes it from
          Work items.
        </p>
      )}
      {i.stuckUploads > 0 && (
        <p>
          {i.stuckUploads} upload{i.stuckUploads === 1 ? '' : 's'} in the last day never finished reading. Upload the
          file again; a dead upload drops off this count a day after it started.
        </p>
      )}
    </SloCard>
  );
}

// ── Right now ─────────────────────────────────────────────────────────────

function QueueCard({
  label,
  q,
}: {
  label: string;
  q: { open: number; pastDue: number; oldestWorkingMinutes: number | null };
}) {
  const late = q.pastDue > 0;
  return (
    <article
      className={`rounded-lg p-4 shadow-sm ring-1 ${
        late ? 'bg-amber-50 text-amber-900 ring-amber-200' : 'bg-white text-slate-800 ring-slate-200'
      }`}
    >
      <h3 className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</h3>
      <p className="mt-1 text-3xl font-bold tabular-nums">{q.open}</p>
      <p className="mt-1 text-xs tabular-nums opacity-80">
        {q.pastDue > 0 ? `${q.pastDue} past due` : 'none past due'}
        {q.oldestWorkingMinutes !== null &&
          ` · oldest waiting ${formatWorkingMinutes(q.oldestWorkingMinutes)} of working time`}
      </p>
    </article>
  );
}

function OpenApprovals({ s, scope }: { s: ServiceStatus; scope: ApprovalsScope }) {
  if (scope !== 'company') {
    // A Manager: their regions' requests, the same three cards every time.
    return (
      <div className="grid gap-3 sm:grid-cols-3">
        {queuesForManager(s.openApprovals).map((g) => (
          <QueueCard key={g.group.key} label={g.group.label.replace(/ steps?$/, '')} q={g.queue} />
        ))}
      </div>
    );
  }
  const open = s.openApprovals.filter((t) => t.open > 0);
  if (open.length === 0) {
    return (
      <p className="rounded-lg bg-white p-5 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">
        Nothing is waiting for an approver.
      </p>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {open.map((t) => (
        <QueueCard key={t.role} label={(TIER_LABEL[t.role] ?? t.role).replace(/ step$/, '')} q={t} />
      ))}
    </div>
  );
}

const JOB_TONE: Record<string, string> = {
  ok: 'text-emerald-700',
  'outside-window': 'text-slate-500',
  failed: 'text-red-700',
  stale: 'text-red-700',
  never: 'text-red-700',
};

const JOB_STATE_LABEL: Record<string, string> = {
  ok: 'Running',
  'outside-window': 'Not due now',
  failed: 'Last run failed',
  stale: 'Late',
  never: 'Never ran',
};

function Jobs({ jobs, now }: { jobs: JobState[]; now: Date }) {
  return (
    <ul className="divide-y divide-slate-100 rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
      {jobs.map((j) => {
        // A warning-tier job that alarms is amber, not red: it does not page (item 11).
        const tone = j.alarm && j.severity === 'warning' ? 'text-amber-700' : (JOB_TONE[j.state] ?? 'text-slate-700');
        return (
          <li key={j.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
            <span className="font-medium text-slate-800">
              {j.label}
              <span className="ml-2 text-xs font-normal text-slate-500">
                {j.severity === 'critical'
                  ? 'critical: turns the health check red when it stops'
                  : 'reported only: the health check stays green'}
              </span>
            </span>
            <span className="text-xs tabular-nums text-slate-600">
              <span className={`font-semibold ${tone}`}>{JOB_STATE_LABEL[j.state] ?? j.state}</span>
              {j.lastRunAt && ` · last run ${omanWhen(j.lastRunAt, now)}`}
              {j.lastVercelRunAt && ` · Vercel last ran it ${omanWhen(j.lastVercelRunAt, now)}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

