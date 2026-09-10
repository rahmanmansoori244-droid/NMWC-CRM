'use client';

import { useMemo, useState } from 'react';

type Region = { id: string; name: string; code: string };
type Route = { id: string; code: string; name: string; regionId: string };

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
  // last 7 days so a Monday download shows the week's enrichment.
  const todayIso = new Date().toISOString().slice(0, 10);
  const weekAgoIso = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const [changesSince, setChangesSince] = useState<string>(weekAgoIso);
  const [changesUntil, setChangesUntil] = useState<string>(todayIso);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [includePending, setIncludePending] = useState(true);

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
        window.location.href = buildHref();
      }}
      className="grid gap-4"
    >
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
          <label className="mb-1 block text-xs font-medium text-slate-700">
            Min completeness %
          </label>
          <input
            type="number"
            min={0}
            max={100}
            value={minCompleteness}
            onChange={(e) => setMinCompleteness(e.currentTarget.value)}
            className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">
            Max completeness %
          </label>
          <input
            type="number"
            min={0}
            max={100}
            value={maxCompleteness}
            onChange={(e) => setMaxCompleteness(e.currentTarget.value)}
            className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">Updated since</label>
          <input
            type="date"
            value={updatedSince}
            onChange={(e) => setUpdatedSince(e.currentTarget.value)}
            className="block w-full rounded-md border-slate-300 px-3 py-2 text-sm shadow-sm"
          />
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 pt-4">
        <a
          href="/api/exports/customers"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Download all (no filters)
        </a>
        <button
          type="submit"
          className="rounded-md bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Download .xlsx
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
          <a
            href={buildChangesHref()}
            className="ml-auto rounded-md bg-amber-600 px-5 py-2 text-sm font-semibold text-white hover:bg-amber-700"
          >
            Download field-update report
          </a>
        </div>
      </fieldset>
    </form>
  );
}
