'use client';

import { useId, useMemo, useState } from 'react';
import { omanDateISO } from '@/lib/tz';

type Region = { id: string; name: string; code: string };
type Route = { id: string; code: string; name: string; regionId: string };

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * The words for an export the server refused (app/api/exports/*: 400 for
 * unreadable filters, 401 signed out, 403 for a role or a too-large export —
 * whose message says how to split it — and 500).
 */
function refusalText(status: number, error: string): string {
  if (status === 401) return 'Your session has ended. Sign in again, then download.';
  if (status === 403 && error) return error;
  if (status === 400) return 'These filters could not be read. Clear them and try again.';
  return 'The export failed on the server. Nothing was downloaded — try again, and tell the Steward if it keeps failing.';
}

export function ExportFiltersForm({
  regions,
  routes,
}: {
  regions: Region[];
  routes: Route[];
}) {
  const [regionIds, setRegionIds] = useState<string[]>([]);
  const [routeIds, setRouteIds] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<string[]>([]);
  const [minCompleteness, setMinCompleteness] = useState<string>('');
  const [maxCompleteness, setMaxCompleteness] = useState<string>('');
  const [updatedSince, setUpdatedSince] = useState<string>('');
  // Field-update report (go-live): window + row options. Default window = the
  // last 7 days so a Monday download shows the week's enrichment. Oman days, as
  // the report reads them: the UTC date made "until" yesterday before 04:00.
  const todayIso = omanDateISO();
  const weekAgoIso = omanDateISO(new Date(Date.now() - 7 * 86400_000));
  const [changesSince, setChangesSince] = useState<string>(weekAgoIso);
  const [changesUntil, setChangesUntil] = useState<string>(todayIso);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [includePending, setIncludePending] = useState(true);
  // Launch fix: each download used to be a navigation (window.location.href or
  // a plain link), so any refusal — 403 "Export too large…", 400, 401, 500 —
  // replaced this page with raw JSON. It is fetched instead: a file is saved, a
  // refusal is shown here, and the filters stay as they were.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each label tied to its field: a bare <label> beside a bare input names
  // nothing for a screen reader, and a tap on it focuses nothing.
  const uid = useId();

  async function download(href: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(href, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setError(refusalText(res.status, typeof body?.error === 'string' ? body.error : ''));
        return;
      }
      // A redirect (to sign-in or the forced password change) answers 200 with a page.
      if (!(res.headers.get('Content-Type') ?? '').includes(XLSX)) {
        setError('The server answered with a page instead of the file. Reload this page, sign in if asked, and try again.');
        return;
      }
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'nmwc-export.xlsx';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError('The export could not be reached. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  // Filter routes by selected regions for usability
  const filteredRoutes = useMemo(
    () => (regionIds.length === 0 ? routes : routes.filter((r) => regionIds.includes(r.regionId))),
    [regionIds, routes]
  );

  function buildHref() {
    const sp = new URLSearchParams();
    regionIds.forEach((id) => sp.append('regionId', id));
    routeIds.forEach((id) => sp.append('routeId', id));
    statuses.forEach((s) => sp.append('status', s));
    paymentTerms.forEach((p) => sp.append('paymentTerms', p));
    if (minCompleteness) sp.set('minCompleteness', minCompleteness);
    if (maxCompleteness) sp.set('maxCompleteness', maxCompleteness);
    if (updatedSince) sp.set('updatedSince', updatedSince);
    return `/api/exports/customers?${sp.toString()}`;
  }

  function buildChangesHref() {
    const sp = new URLSearchParams();
    regionIds.forEach((id) => sp.append('regionId', id));
    routeIds.forEach((id) => sp.append('routeId', id));
    if (changesSince) sp.set('since', changesSince);
    if (changesUntil) sp.set('until', changesUntil);
    sp.set('onlyChanged', onlyChanged ? '1' : '0');
    sp.set('includePending', includePending ? '1' : '0');
    return `/api/exports/changes?${sp.toString()}`;
  }

  function toggle(list: string[], setList: (l: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void download(buildHref());
      }}
      className="grid gap-4"
    >
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700 ring-1 ring-red-200">
          {error}
        </p>
      )}
      <fieldset>
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Regions
        </legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {regions.map((r) => (
            <label
              key={r.id}
              className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm"
            >
              <input
                type="checkbox"
                checked={regionIds.includes(r.id)}
                onChange={() => toggle(regionIds, setRegionIds, r.id)}
              />
              <span>{r.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Routes
        </legend>
        <div className="max-h-48 overflow-y-auto rounded-md border border-slate-200 p-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {filteredRoutes.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={routeIds.includes(r.id)}
                  onChange={() => toggle(routeIds, setRouteIds, r.id)}
                />
                <span className="font-mono">{r.code}</span>
              </label>
            ))}
            {filteredRoutes.length === 0 && (
              <p className="col-span-full text-xs text-slate-400">
                Pick a region first to filter routes.
              </p>
            )}
          </div>
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset>
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Status
          </legend>
          <div className="flex flex-wrap gap-2">
            {['ACTIVE', 'CLOSED', 'SUSPENDED'].map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={statuses.includes(s)}
                  onChange={() => toggle(statuses, setStatuses, s)}
                />
                {s}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Payment terms
          </legend>
          <div className="flex flex-wrap gap-2">
            {['CASH', 'CREDIT'].map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={paymentTerms.includes(s)}
                  onChange={() => toggle(paymentTerms, setPaymentTerms, s)}
                />
                {s}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={`${uid}-min`} className="mb-1 block text-xs font-medium text-slate-700">
            Min completeness %
          </label>
          <input
            id={`${uid}-min`}
            type="number"
            min={0}
            max={100}
            value={minCompleteness}
            onChange={(e) => setMinCompleteness(e.currentTarget.value)}
            className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
          />
        </div>
        <div>
          <label htmlFor={`${uid}-max`} className="mb-1 block text-xs font-medium text-slate-700">
            Max completeness %
          </label>
          <input
            id={`${uid}-max`}
            type="number"
            min={0}
            max={100}
            value={maxCompleteness}
            onChange={(e) => setMaxCompleteness(e.currentTarget.value)}
            className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
          />
        </div>
        <div>
          <label htmlFor={`${uid}-updated-since`} className="mb-1 block text-xs font-medium text-slate-700">
            Updated since
          </label>
          <input
            id={`${uid}-updated-since`}
            type="date"
            value={updatedSince}
            onChange={(e) => setUpdatedSince(e.currentTarget.value)}
            className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
          />
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 pt-4">
        <button
          type="button"
          disabled={busy}
          onClick={() => void download('/api/exports/customers')}
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Download all (no filters)
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Preparing…' : 'Download .xlsx'}
        </button>
      </div>

      {/* Field-update report: what the salesmen changed (highlighted) vs. not.
          Region/route selections above apply to this report too. */}
      <fieldset className="rounded-md border border-amber-200 bg-amber-50/60 p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-amber-800">
          Field-update report (changes highlighted)
        </legend>
        <p className="mb-3 text-xs text-amber-900">
          Every customer in the selected regions/routes, one row per branch. Cells changed by an
          approved salesman edit in the window are <span className="rounded bg-yellow-300 px-1">yellow</span>;
          proposals still awaiting approval are <span className="rounded bg-orange-300 px-1">orange</span>.
          A second sheet lists every change (before → after, who, when).
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="changes-since">
              Changes from
            </label>
            <input
              id="changes-since"
              type="date"
              value={changesSince}
              onChange={(e) => setChangesSince(e.currentTarget.value)}
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="changes-until">
              Changes until
            </label>
            <input
              id="changes-until"
              type="date"
              value={changesUntil}
              onChange={(e) => setChangesUntil(e.currentTarget.value)}
              className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={onlyChanged}
              onChange={(e) => setOnlyChanged(e.currentTarget.checked)}
            />
            Only customers with changes
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includePending}
              onChange={(e) => setIncludePending(e.currentTarget.checked)}
            />
            Mark pending (not yet approved) proposals
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => void download(buildChangesHref())}
            className="ml-auto rounded-md bg-amber-600 px-5 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
          >
            Download field-update report
          </button>
        </div>
      </fieldset>
    </form>
  );
}
