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
    </form>
  );
}
