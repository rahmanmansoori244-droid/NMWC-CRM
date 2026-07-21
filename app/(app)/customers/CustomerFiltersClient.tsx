'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createSavedViewAction,
  deleteSavedViewAction,
} from '@/services/saved-views';
import { exportFilteredCustomersAction } from '@/services/customer-export';

type RoleFlags = {
  showRegion: boolean;
  showRoute: boolean;
  showSupervisor: boolean;
  showSalesman: boolean;
  canExport: boolean;
};

type Region = { id: string; name: string; code: string };
type RouteRow = { id: string; code: string; name: string; regionId: string };
type Channel = { id: string; label: string };
type SubChannel = { id: string; label: string; channelId: string };
type SimpleUser = { id: string; fullName: string; username: string };

type SavedViewItem = {
  id: string;
  name: string;
  urlParams: string;
};

export type CustomerFiltersClientProps = {
  initial: {
    q: string;
    status: string;
    region: string[];
    route: string[];
    channel: string[];
    subChannel: string[];
    supervisor: string;
    salesman: string;
    paymentTerms: string;
    minScore: string;
    maxScore: string;
    createdAfter: string;
    createdBefore: string;
    editedAfter: string;
    editedBefore: string;
  };
  flags: RoleFlags;
  regions: Region[];
  routes: RouteRow[];
  channels: Channel[];
  subChannels: SubChannel[];
  supervisors: SimpleUser[];
  salesmen: SimpleUser[];
  savedViews: SavedViewItem[];
};

/**
 * P2.1 / P2.2 / P2.3 (2026-05-10) — client-side filter bar for the
 * customers list. Owns:
 *   - the URL-driven filter form (multi-selects, date ranges, score range)
 *   - the "More filters" disclosure
 *   - the saved-view dropdown + "Save view" modal + per-view delete buttons
 *   - the "Export filtered" button (download via base64 → Blob)
 *
 * All state lives in plain useState. On submit the form rebuilds the URL
 * from scratch and navigates. Keeps the bookmarkable-URL contract intact.
 */
export function CustomerFiltersClient(props: CustomerFiltersClientProps) {
  const router = useRouter();
  const [showMore, setShowMore] = useState(
    () =>
      props.initial.subChannel.length > 0 ||
      props.initial.supervisor !== '' ||
      props.initial.salesman !== '' ||
      props.initial.paymentTerms !== '' ||
      props.initial.createdAfter !== '' ||
      props.initial.createdBefore !== '' ||
      props.initial.editedAfter !== '' ||
      props.initial.editedBefore !== ''
  );

  // Form state
  const [q, setQ] = useState(props.initial.q);
  const [status, setStatus] = useState(props.initial.status);
  const [region, setRegion] = useState<string[]>(props.initial.region);
  const [route, setRoute] = useState<string[]>(props.initial.route);
  const [channel, setChannel] = useState<string[]>(props.initial.channel);
  const [subChannel, setSubChannel] = useState<string[]>(props.initial.subChannel);
  const [supervisor, setSupervisor] = useState(props.initial.supervisor);
  const [salesman, setSalesman] = useState(props.initial.salesman);
  const [paymentTerms, setPaymentTerms] = useState(props.initial.paymentTerms);
  const [minScore, setMinScore] = useState(props.initial.minScore);
  const [maxScore, setMaxScore] = useState(props.initial.maxScore);
  const [createdAfter, setCreatedAfter] = useState(props.initial.createdAfter);
  const [createdBefore, setCreatedBefore] = useState(props.initial.createdBefore);
  const [editedAfter, setEditedAfter] = useState(props.initial.editedAfter);
  const [editedBefore, setEditedBefore] = useState(props.initial.editedBefore);

  // Saved-view modal + state
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);

  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  function buildUrlParams(): string {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set('q', q.trim());
    if (status) sp.set('status', status);
    if (region.length) sp.set('region', region.join(','));
    if (route.length) sp.set('route', route.join(','));
    if (channel.length) sp.set('channel', channel.join(','));
    if (subChannel.length) sp.set('subChannel', subChannel.join(','));
    if (supervisor) sp.set('supervisor', supervisor);
    if (salesman) sp.set('salesman', salesman);
    if (paymentTerms) sp.set('paymentTerms', paymentTerms);
    if (minScore) sp.set('minScore', minScore);
    if (maxScore) sp.set('maxScore', maxScore);
    if (createdAfter) sp.set('createdAfter', createdAfter);
    if (createdBefore) sp.set('createdBefore', createdBefore);
    if (editedAfter) sp.set('editedAfter', editedAfter);
    if (editedBefore) sp.set('editedBefore', editedBefore);
    return sp.toString();
  }

  // perf audit #19: wrap the filter navigation in a transition so the button
  // shows a pending state instead of the UI silently freezing for the round trip.
  const [applying, startApply] = useTransition();
  function onApply(e: React.FormEvent) {
    e.preventDefault();
    const params = buildUrlParams();
    startApply(() => {
      router.push(params ? `/customers?${params}` : '/customers');
    });
  }

  async function onSaveView(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    if (saveName.trim().length < 2) {
      setSaveError('Name must be at least 2 characters.');
      return;
    }
    setSaveBusy(true);
    const fd = new FormData();
    fd.set('name', saveName.trim());
    fd.set('urlParams', buildUrlParams());
    const res = await createSavedViewAction(fd);
    setSaveBusy(false);
    if (!res.ok) {
      setSaveError(res.message);
      return;
    }
    setSaveModalOpen(false);
    setSaveName('');
    router.refresh();
  }

  async function onDeleteView(id: string) {
    const fd = new FormData();
    fd.set('id', id);
    const res = await deleteSavedViewAction(fd);
    if (res.ok) router.refresh();
  }

  function onChooseView(urlParams: string) {
    router.push(urlParams ? `/customers?${urlParams}` : '/customers');
  }

  async function onExport() {
    setExportError(null);
    setExportBusy(true);
    const fd = new FormData();
    fd.set('urlParams', buildUrlParams());
    const res = await exportFilteredCustomersAction(fd);
    setExportBusy(false);
    if (!res.ok) {
      setExportError(res.message);
      return;
    }
    // Decode base64 and trigger a Blob download. Avoids stuffing a Buffer
    // through the RSC boundary in raw form.
    const bin = atob(res.data.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = res.data.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Filter routes by selected regions for usability — but only when the
  // route filter is visible to this role.
  const visibleRoutes =
    region.length === 0
      ? props.routes
      : props.routes.filter((r) => region.includes(r.regionId));
  const visibleSubChannels =
    channel.length === 0
      ? props.subChannels
      : props.subChannels.filter((sc) => channel.includes(sc.channelId));

  return (
    <div className="border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
      <form className="flex flex-wrap items-end gap-2" onSubmit={onApply}>
        <div className="flex flex-1 min-w-[200px]">
          <input
            type="search"
            name="q"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder="Search by name, code, phone…"
            className="w-full max-w-md rounded-md border border-slate-300 px-3 py-2.5 text-base shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <select
          value={status}
          onChange={(e) => setStatus(e.currentTarget.value)}
          className="rounded-md border border-slate-300 px-2 py-2.5 text-base"
          aria-label="Status"
        >
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="CLOSED">Closed</option>
          <option value="SUSPENDED">Suspended</option>
        </select>

        {props.flags.showRegion && (
          <MultiSelect
            label="Regions"
            value={region}
            onChange={setRegion}
            options={props.regions.map((r) => ({ value: r.id, label: r.name }))}
          />
        )}
        {props.flags.showRoute && (
          <MultiSelect
            label="Routes"
            value={route}
            onChange={setRoute}
            options={visibleRoutes.map((r) => ({ value: r.id, label: r.code }))}
          />
        )}
        <MultiSelect
          label="Channels"
          value={channel}
          onChange={setChannel}
          options={props.channels.map((c) => ({ value: c.id, label: c.label }))}
        />

        <div className="flex items-center gap-1.5">
          <label className="text-sm text-slate-600" htmlFor="minScore">
            Score
          </label>
          <input
            id="minScore"
            type="number"
            min={0}
            max={100}
            value={minScore}
            onChange={(e) => setMinScore(e.currentTarget.value)}
            placeholder="min"
            className="w-16 rounded-md border border-slate-300 px-2 py-2 text-sm"
          />
          <span className="text-slate-400">–</span>
          <input
            type="number"
            min={0}
            max={100}
            value={maxScore}
            onChange={(e) => setMaxScore(e.currentTarget.value)}
            placeholder="max"
            className="w-16 rounded-md border border-slate-300 px-2 py-2 text-sm"
          />
        </div>

        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          aria-expanded={showMore}
        >
          {showMore ? 'Fewer filters' : 'More filters'}
        </button>

        <button
          type="submit"
          disabled={applying}
          className="rounded-md bg-brand-600 px-4 py-2.5 text-base font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {applying ? 'Filtering…' : 'Filter'}
        </button>

        <Link
          href="/customers"
          className="rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Clear
        </Link>
      </form>

      {showMore && (
        <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 lg:grid-cols-4">
          <MultiSelect
            label="Sub-channels"
            value={subChannel}
            onChange={setSubChannel}
            options={visibleSubChannels.map((sc) => ({ value: sc.id, label: sc.label }))}
            block
          />
          {props.flags.showSupervisor && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Supervisor
              </label>
              <select
                value={supervisor}
                onChange={(e) => setSupervisor(e.currentTarget.value)}
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">Any supervisor</option>
                {props.supervisors.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName} ({u.username})
                  </option>
                ))}
              </select>
            </div>
          )}
          {props.flags.showSalesman && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Salesman
              </label>
              <select
                value={salesman}
                onChange={(e) => setSalesman(e.currentTarget.value)}
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">Any salesman</option>
                {props.salesmen.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName} ({u.username})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Payment terms
            </label>
            <select
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.currentTarget.value)}
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">All</option>
              <option value="CASH">Cash</option>
              <option value="CREDIT">Credit</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Created after
            </label>
            <input
              type="date"
              value={createdAfter}
              onChange={(e) => setCreatedAfter(e.currentTarget.value)}
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Created before
            </label>
            <input
              type="date"
              value={createdBefore}
              onChange={(e) => setCreatedBefore(e.currentTarget.value)}
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Last edited after
            </label>
            <input
              type="date"
              value={editedAfter}
              onChange={(e) => setEditedAfter(e.currentTarget.value)}
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Last edited before
            </label>
            <input
              type="date"
              value={editedBefore}
              onChange={(e) => setEditedBefore(e.currentTarget.value)}
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
        <button
          type="button"
          onClick={() => {
            setSaveError(null);
            setSaveName('');
            setSaveModalOpen(true);
          }}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Save view
        </button>

        <SavedViewsMenu
          views={props.savedViews}
          onChoose={onChooseView}
          onDelete={onDeleteView}
        />

        {props.flags.canExport && (
          <button
            type="button"
            onClick={onExport}
            disabled={exportBusy}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {exportBusy ? 'Exporting…' : 'Export filtered'}
          </button>
        )}
        {exportError && (
          <span className="text-sm text-red-600" role="alert">
            {exportError}
          </span>
        )}
      </div>

      {saveModalOpen && (
        <SaveViewModal
          name={saveName}
          onNameChange={setSaveName}
          error={saveError}
          busy={saveBusy}
          onCancel={() => {
            setSaveModalOpen(false);
            setSaveError(null);
          }}
          onSubmit={onSaveView}
        />
      )}
    </div>
  );
}

function MultiSelect({
  label,
  value,
  onChange,
  options,
  block,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  options: { value: string; label: string }[];
  block?: boolean;
}) {
  // For now use a native <select multiple>. Compact (size=1 isn't valid for
  // multi but size=4 is fine). Pill-tag improvement is a follow-up.
  return (
    <div className={block ? '' : ''}>
      <label className="mb-1 block text-xs font-medium text-slate-600">{label}</label>
      <select
        multiple
        value={value}
        onChange={(e) => {
          const selected: string[] = [];
          for (const opt of e.currentTarget.options) {
            if (opt.selected) selected.push(opt.value);
          }
          onChange(selected);
        }}
        className={
          (block ? 'block w-full ' : '') +
          'min-w-[140px] rounded-md border border-slate-300 px-2 py-1.5 text-sm'
        }
        size={Math.min(4, Math.max(2, options.length))}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SavedViewsMenu({
  views,
  onChoose,
  onDelete,
}: {
  views: SavedViewItem[];
  onChoose: (urlParams: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (views.length === 0) {
    return (
      <span className="text-sm text-slate-400" title="No saved views yet">
        No saved views
      </span>
    );
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Saved views ({views.length}) ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute z-10 mt-1 w-72 max-h-80 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg"
        >
          {views.map((v) => (
            <div
              key={v.id}
              className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 last:border-0"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onChoose(v.urlParams);
                }}
                className="flex-1 truncate text-left text-sm text-slate-700 hover:text-brand-700"
                title={v.urlParams || '(no filters)'}
              >
                {v.name}
              </button>
              <button
                type="button"
                onClick={() => onDelete(v.id)}
                className="rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-red-50 hover:text-red-700"
                aria-label={`Delete saved view ${v.name}`}
                title="Delete"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SaveViewModal({
  name,
  onNameChange,
  error,
  busy,
  onCancel,
  onSubmit,
}: {
  name: string;
  onNameChange: (v: string) => void;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-view-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onCancel}
        className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
        tabIndex={-1}
      />
      <form
        onSubmit={onSubmit}
        className="relative z-10 w-full max-w-md rounded-lg bg-white p-6 shadow-xl ring-1 ring-slate-200"
      >
        <h2 id="save-view-title" className="text-base font-semibold text-slate-900">
          Save current filter as a view
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Give this filter combination a name so you can recall it later.
        </p>
        <label className="mt-4 mb-1 block text-xs font-medium text-slate-700">
          View name
        </label>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.currentTarget.value)}
          placeholder="e.g. North Muscat low-completeness"
          className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-500"
          maxLength={60}
        />
        {error && (
          <p className="mt-1 text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
