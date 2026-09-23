'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Search as SearchIcon, SlidersHorizontal, X } from 'lucide-react';
import { MultiSelectFilter } from '@/components/nmwc/MultiSelectFilter';
import { createSavedViewAction, deleteSavedViewAction } from '@/services/saved-views';
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

/** Every filter the bar owns, in one bag so the URL builder is a pure function. */
type FilterValues = {
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

export type CustomerFiltersClientProps = {
  initial: FilterValues;
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
 * The query-string contract. Saved views store the raw string this returns and
 * replay it months later, so the key order and the emptiness rules here are
 * load-bearing: change them and every view saved before the change resolves to
 * a different URL.
 *
 * The 2026-09-23 filter-bar redesign kept the key order and the emptiness rules
 * exactly. It did briefly change the VALUE order — the popover appended each
 * newly-ticked id, where the `<select multiple>` it replaced always emitted DOM
 * option order — which made the bar read as dirty after unticking and re-ticking
 * the same box. MultiSelectFilter now rebuilds its value in option order, so
 * both halves of the string are back to what saved views were written against.
 * Exported for tests/unit/customer-filter-bar.test.tsx, which pins the order.
 */
export function buildUrlParamsFrom(v: FilterValues): string {
  const sp = new URLSearchParams();
  if (v.q.trim()) sp.set('q', v.q.trim());
  if (v.status) sp.set('status', v.status);
  if (v.region.length) sp.set('region', v.region.join(','));
  if (v.route.length) sp.set('route', v.route.join(','));
  if (v.channel.length) sp.set('channel', v.channel.join(','));
  if (v.subChannel.length) sp.set('subChannel', v.subChannel.join(','));
  if (v.supervisor) sp.set('supervisor', v.supervisor);
  if (v.salesman) sp.set('salesman', v.salesman);
  if (v.paymentTerms) sp.set('paymentTerms', v.paymentTerms);
  if (v.minScore) sp.set('minScore', v.minScore);
  if (v.maxScore) sp.set('maxScore', v.maxScore);
  if (v.createdAfter) sp.set('createdAfter', v.createdAfter);
  if (v.createdBefore) sp.set('createdBefore', v.createdBefore);
  if (v.editedAfter) sp.set('editedAfter', v.editedAfter);
  if (v.editedBefore) sp.set('editedBefore', v.editedBefore);
  return sp.toString();
}

/**
 * Normalise a typed completeness score the way the server will.
 *
 * The score boxes carry min=0/max=100 and the form is not noValidate, so a typed
 * 500 makes checkValidity() false: pressing Filter never reaches onApply, the
 * browser shows its own bubble, and the amber "Not applied yet — press Filter"
 * hint sits underneath telling the owner to keep pressing the button the browser
 * is refusing. parseScore in lib/customer-filters.ts clamps to 0..100 and drops
 * the leading zero from '07' regardless, so do it here on blur — before the
 * submit, not after the round trip.
 */
function clampScore(raw: string): string {
  if (raw === '') return '';
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return '';
  return String(Math.max(0, Math.min(100, n)));
}

/** Is anything set that only the "More filters" disclosure can show? */
function hasAdvancedFilters(v: FilterValues): boolean {
  return (
    v.subChannel.length > 0 ||
    v.supervisor !== '' ||
    v.salesman !== '' ||
    v.paymentTerms !== '' ||
    v.createdAfter !== '' ||
    v.createdBefore !== '' ||
    v.editedAfter !== '' ||
    v.editedBefore !== ''
  );
}

/** One removable filter shown in the summary row under the controls. */
type Chip = { key: string; group: string; text: string; onRemove: () => void };

/**
 * What a chip prints when the id it carries is not in the reference list this
 * role was given. page.tsx passes `regions: []`, `routes: []`, `supervisors: []`
 * and `salesmen: []` to the roles that do not get those facets, so a SALESMAN
 * opening a /customers link a steward pasted into chat used to see three chips
 * of raw cuids. The chip stays — its X is the only handle that role has on a
 * filter it has no control for — but it never shows a database id.
 */
const UNRESOLVED_LABEL = 'outside your access';

/**
 * More than this many picks in one facet collapse to a single "N selected"
 * chip. A steward who ticks all 44 routes must not push the customer list
 * below the fold; per-item removal stays available inside the popover.
 */
const CHIP_EXPAND_LIMIT = 5;

const SHELL = 'inline-flex h-10 items-center rounded-md border border-slate-300 bg-white text-sm';

/**
 * P2.1 / P2.2 / P2.3 (2026-05-10) — client-side filter bar for the
 * customers list. Owns:
 *   - the URL-driven filter form (facet popovers, date ranges, score range)
 *   - the "More filters" disclosure
 *   - the saved-view dropdown + "Save view" modal + per-view delete buttons
 *   - the "Export filtered" button (download via base64 → Blob)
 *
 * All state lives in plain useState. On submit the form rebuilds the URL
 * from scratch and navigates. Keeps the bookmarkable-URL contract intact.
 *
 * Go-live (2026-09-23): laid out as three stacked rows — search + apply,
 * then the facet controls, then the active-filter chips — because the old
 * single row (search, status, three `<select multiple>` boxes, score pair,
 * More filters, Filter) ran off the right edge of the owner's 1280px window
 * and the multi-selects gave no way to see a selection without scrolling
 * inside them.
 */
export function CustomerFiltersClient(props: CustomerFiltersClientProps) {
  const router = useRouter();
  const [showMore, setShowMore] = useState(() => hasAdvancedFilters(props.initial));

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

  // What the list below is ACTUALLY filtered by: the URL, arriving as
  // props.initial.
  const appliedParams = buildUrlParamsFrom(props.initial);

  /**
   * Go-live (2026-09-23): make the form follow the applied filters.
   *
   * This component is never remounted across a client navigation — page.tsx
   * renders it at the same position with no `key`, and Next keeps the tree
   * mounted through a router transition (which is the only reason the pending
   * state from perf audit #19 works at all). So every useState above is a
   * one-time initialiser, and the form kept the PREVIOUS filters after Clear,
   * after choosing a saved view and after Back.
   *
   * That staleness was invisible until this redesign; the chips row and the
   * "Not applied yet — press Filter" hint turned it into an on-screen
   * instruction to undo what the owner had just done — press Filter after Clear
   * and the cleared filters came straight back, press it after choosing a saved
   * view and the view was discarded. Save view and Export filtered read the same
   * pending state, so a view could be persisted that resolved to the unfiltered
   * 18,677-row list.
   *
   * The one navigation we must NOT follow is our own Filter submit: it runs
   * inside a transition, so on this WAN link the owner can keep typing while it
   * is in flight, and resyncing when it commits would eat those keystrokes. That
   * push is recorded and consumed exactly once — a later Back to the same URL is
   * not ours, and does resync. Pagination links keep the filters identical, so
   * `appliedParams` does not change and a half-typed search survives a page flip.
   *
   * Both markers are state, not refs: this block runs during render, and React
   * invokes render twice in development. A ref cleared here would be consumed by
   * the first invocation and read as null by the second, so the guard would hold
   * in production and not in front of whoever was testing it.
   */
  const [selfPushed, setSelfPushed] = useState<string | null>(null);
  const [syncedParams, setSyncedParams] = useState(appliedParams);
  if (syncedParams !== appliedParams) {
    const ours = selfPushed === appliedParams;
    setSelfPushed(null);
    setSyncedParams(appliedParams);
    if (!ours) {
      setQ(props.initial.q);
      setStatus(props.initial.status);
      setRegion(props.initial.region);
      setRoute(props.initial.route);
      setChannel(props.initial.channel);
      setSubChannel(props.initial.subChannel);
      setSupervisor(props.initial.supervisor);
      setSalesman(props.initial.salesman);
      setPaymentTerms(props.initial.paymentTerms);
      setMinScore(props.initial.minScore);
      setMaxScore(props.initial.maxScore);
      setCreatedAfter(props.initial.createdAfter);
      setCreatedBefore(props.initial.createdBefore);
      setEditedAfter(props.initial.editedAfter);
      setEditedBefore(props.initial.editedBefore);
      // Expand only. A saved view carrying a payment term must not land its
      // control behind a collapsed disclosure; a disclosure the owner opened
      // themselves must not slam shut under them.
      if (hasAdvancedFilters(props.initial)) setShowMore(true);
    }
  }

  // Saved-view modal + state
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);

  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const values: FilterValues = {
    q,
    status,
    region,
    route,
    channel,
    subChannel,
    supervisor,
    salesman,
    paymentTerms,
    minScore,
    maxScore,
    createdAfter,
    createdBefore,
    editedAfter,
    editedBefore,
  };

  function buildUrlParams(): string {
    return buildUrlParamsFrom(values);
  }

  // The chips show what is TYPED IN THE BAR, which is not necessarily what the
  // list below is showing. Say so rather than letting the owner wonder why
  // removing a chip changed nothing.
  const dirty = buildUrlParams() !== appliedParams;

  // perf audit #19: wrap the filter navigation in a transition so the button
  // shows a pending state instead of the UI silently freezing for the round trip.
  const [applying, startApply] = useTransition();
  function onApply(e: React.FormEvent) {
    e.preventDefault();
    const params = buildUrlParams();
    // Claim this navigation, so the resync above leaves the form alone when it
    // lands. Note what the server echoes back may differ from what we pushed
    // ('minScore=07' comes back as 'minScore=7'), and that is precisely a case
    // we DO want resynced — otherwise the amber hint sticks forever under a
    // filter that is applied.
    setSelfPushed(params);
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
    region.length === 0 ? props.routes : props.routes.filter((r) => region.includes(r.regionId));
  const visibleSubChannels =
    channel.length === 0
      ? props.subChannels
      : props.subChannels.filter((sc) => channel.includes(sc.channelId));

  /**
   * Narrowing Region takes the routes outside it off screen; narrowing Channel
   * does the same to sub-channels. Drop what has just gone out of view rather
   * than carrying it invisibly.
   *
   * applyCustomerFilters intersects regionId and routeId on the SAME branch row,
   * so a Dhofar route held behind a Muscat region filter matches nothing and the
   * list looks right — until the Region chip comes off, when those rows reappear
   * in the list and in the workbook 'Export filtered' posts. The chips row shows
   * the removal as it happens, which is more than the old `<select multiple>`
   * did when it pruned the same ids on the next click.
   *
   * Only prune a facet whose control this role actually has: a SUPERVISOR gets
   * `routes: []`, and dropping a route id they cannot see would change their
   * filter silently with nothing on screen to explain it.
   */
  function onRegionChange(next: string[]) {
    setRegion(next);
    if (!props.flags.showRoute || next.length === 0) return;
    const allowed = new Set(props.routes.filter((r) => next.includes(r.regionId)).map((r) => r.id));
    setRoute((prev) => prev.filter((id) => allowed.has(id)));
  }

  function onChannelChange(next: string[]) {
    setChannel(next);
    if (next.length === 0) return;
    const allowed = new Set(
      props.subChannels.filter((sc) => next.includes(sc.channelId)).map((sc) => sc.id)
    );
    setSubChannel((prev) => prev.filter((id) => allowed.has(id)));
  }

  // Chip labels resolve against the FULL lists, not the region-narrowed ones:
  // a route selected before the region filter was tightened is still in the
  // URL, and a chip the owner cannot read is a chip they cannot undo.
  function labelsOf<T>(rows: T[], id: (r: T) => string, text: (r: T) => string) {
    const map = new Map<string, string>();
    for (const r of rows) map.set(id(r), text(r));
    return map;
  }
  const regionLabels = labelsOf(
    props.regions,
    (r) => r.id,
    (r) => r.name
  );
  const routeLabels = labelsOf(
    props.routes,
    (r) => r.id,
    (r) => r.code
  );
  const channelLabels = labelsOf(
    props.channels,
    (c) => c.id,
    (c) => c.label
  );
  const subChannelLabels = labelsOf(
    props.subChannels,
    (sc) => sc.id,
    (sc) => sc.label
  );

  function multiChips(
    group: string,
    ids: string[],
    labels: Map<string, string>,
    set: (v: string[]) => void
  ): Chip[] {
    if (ids.length === 0) return [];
    if (ids.length > CHIP_EXPAND_LIMIT) {
      return [
        {
          key: `${group}:*`,
          group,
          text: `${ids.length} selected`,
          onRemove: () => set([]),
        },
      ];
    }
    return ids.map((id) => ({
      key: `${group}:${id}`,
      group,
      text: labels.get(id) ?? UNRESOLVED_LABEL,
      onRemove: () => set(ids.filter((x) => x !== id)),
    }));
  }

  const STATUS_LABELS: Record<string, string> = {
    ACTIVE: 'Active',
    CLOSED: 'Closed',
    SUSPENDED: 'Suspended',
  };

  const chips: Chip[] = [
    ...(q.trim() ? [{ key: 'q', group: 'Search', text: q.trim(), onRemove: () => setQ('') }] : []),
    ...(status
      ? [
          {
            key: 'status',
            group: 'Status',
            text: STATUS_LABELS[status] ?? status,
            onRemove: () => setStatus(''),
          },
        ]
      : []),
    ...multiChips('Region', region, regionLabels, onRegionChange),
    ...multiChips('Route', route, routeLabels, setRoute),
    ...multiChips('Channel', channel, channelLabels, onChannelChange),
    ...multiChips('Sub-channel', subChannel, subChannelLabels, setSubChannel),
    ...(supervisor
      ? [
          {
            key: 'supervisor',
            group: 'Supervisor',
            text: props.supervisors.find((u) => u.id === supervisor)?.fullName ?? UNRESOLVED_LABEL,
            onRemove: () => setSupervisor(''),
          },
        ]
      : []),
    ...(salesman
      ? [
          {
            key: 'salesman',
            group: 'Salesman',
            text: props.salesmen.find((u) => u.id === salesman)?.fullName ?? UNRESOLVED_LABEL,
            onRemove: () => setSalesman(''),
          },
        ]
      : []),
    ...(paymentTerms
      ? [
          {
            key: 'paymentTerms',
            group: 'Payment',
            text: paymentTerms === 'CASH' ? 'Cash' : 'Credit',
            onRemove: () => setPaymentTerms(''),
          },
        ]
      : []),
    ...(minScore || maxScore
      ? [
          {
            key: 'score',
            group: 'Score',
            text: `${minScore || '0'}–${maxScore || '100'}`,
            onRemove: () => {
              setMinScore('');
              setMaxScore('');
            },
          },
        ]
      : []),
    ...(createdAfter
      ? [
          {
            key: 'createdAfter',
            group: 'Created after',
            text: createdAfter,
            onRemove: () => setCreatedAfter(''),
          },
        ]
      : []),
    ...(createdBefore
      ? [
          {
            key: 'createdBefore',
            group: 'Created before',
            text: createdBefore,
            onRemove: () => setCreatedBefore(''),
          },
        ]
      : []),
    ...(editedAfter
      ? [
          {
            key: 'editedAfter',
            group: 'Edited after',
            text: editedAfter,
            onRemove: () => setEditedAfter(''),
          },
        ]
      : []),
    ...(editedBefore
      ? [
          {
            key: 'editedBefore',
            group: 'Edited before',
            text: editedBefore,
            onRemove: () => setEditedBefore(''),
          },
        ]
      : []),
  ];

  return (
    <div className="border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
      <form onSubmit={onApply}>
        {/* Row 1 — search and apply. Kept on its own line so the primary
            action is never the thing that falls off the right edge. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[16rem] flex-1">
            <SearchIcon
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              type="search"
              name="q"
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              placeholder="Search by name, code, phone…"
              aria-label="Search customers"
              className="h-10 w-full rounded-md border border-slate-300 pl-9 pr-3 text-base shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <button
            type="submit"
            disabled={applying}
            className="h-10 rounded-md bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-60"
          >
            {applying ? 'Filtering…' : 'Filter'}
          </button>

          <Link
            href="/customers"
            className="inline-flex h-10 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Clear
          </Link>
        </div>

        {/* Row 2 — the facets. flex-wrap, so a narrow window stacks them
            instead of hiding them past the right edge. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label
            className={`${SHELL} gap-2 pl-3 pr-2 focus-within:ring-2 focus-within:ring-brand-500`}
          >
            <span className="shrink-0 text-slate-500">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.currentTarget.value)}
              className="h-full max-w-[9rem] border-0 bg-transparent py-0 pl-0 pr-1 text-sm font-medium text-slate-900 focus:outline-none focus:ring-0"
            >
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="CLOSED">Closed</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </label>

          {props.flags.showRegion && (
            <MultiSelectFilter
              label="Regions"
              value={region}
              onChange={onRegionChange}
              options={props.regions.map((r) => ({ value: r.id, label: r.name }))}
              allLabel="All regions"
            />
          )}
          {props.flags.showRoute && (
            <MultiSelectFilter
              label="Routes"
              value={route}
              onChange={setRoute}
              options={visibleRoutes.map((r) => ({
                value: r.id,
                label: r.name ? `${r.code} — ${r.name}` : r.code,
              }))}
              allLabel="All routes"
            />
          )}
          <MultiSelectFilter
            label="Channels"
            value={channel}
            onChange={onChannelChange}
            options={props.channels.map((c) => ({ value: c.id, label: c.label }))}
            allLabel="All channels"
          />

          <div className={`${SHELL} gap-1.5 px-3`}>
            <span className="shrink-0 text-slate-500">Score</span>
            <input
              type="number"
              min={0}
              max={100}
              value={minScore}
              onChange={(e) => setMinScore(e.currentTarget.value)}
              onBlur={(e) => setMinScore(clampScore(e.currentTarget.value))}
              placeholder="0"
              aria-label="Minimum completeness score"
              className="w-12 rounded border-0 bg-transparent p-0 text-sm font-medium text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
            <span className="text-slate-400" aria-hidden="true">
              –
            </span>
            <input
              type="number"
              min={0}
              max={100}
              value={maxScore}
              onChange={(e) => setMaxScore(e.currentTarget.value)}
              onBlur={(e) => setMaxScore(clampScore(e.currentTarget.value))}
              placeholder="100"
              aria-label="Maximum completeness score"
              className="w-12 rounded border-0 bg-transparent p-0 text-sm font-medium text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            />
          </div>

          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            className={`${SHELL} gap-1.5 px-3 font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500`}
            aria-expanded={showMore}
            aria-controls="customer-more-filters"
          >
            <SlidersHorizontal className="h-4 w-4 text-slate-400" aria-hidden="true" />
            {showMore ? 'Fewer filters' : 'More filters'}
          </button>
        </div>

        {/* Row 3 — what is actually selected, readable without opening
            anything, each item removable on its own. */}
        {chips.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {chips.map((c) => (
              <span
                key={c.key}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-brand-200 bg-brand-50 py-1 pl-2.5 pr-1 text-xs text-brand-900"
              >
                <span className="truncate">
                  <span className="text-brand-700">{c.group}:</span>{' '}
                  <span className="font-medium">{c.text}</span>
                </span>
                <button
                  type="button"
                  onClick={c.onRemove}
                  aria-label={`Remove filter ${c.group}: ${c.text}`}
                  className="rounded-full p-0.5 text-brand-500 hover:bg-brand-200 hover:text-brand-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </span>
            ))}
            {dirty && (
              <span className="ml-1 text-xs font-medium text-amber-700" role="status">
                Not applied yet — press Filter
              </span>
            )}
          </div>
        )}
        {chips.length === 0 && dirty && (
          <p className="mt-2 text-xs font-medium text-amber-700" role="status">
            Not applied yet — press Filter
          </p>
        )}

        {showMore && (
          <div
            id="customer-more-filters"
            className="mt-3 grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <MultiSelectFilter
              label="Sub-channels"
              value={subChannel}
              onChange={setSubChannel}
              options={visibleSubChannels.map((sc) => ({
                value: sc.id,
                label: sc.label,
              }))}
              allLabel="All sub-channels"
              block
            />
            {props.flags.showSupervisor && (
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-slate-600"
                  htmlFor="cf-supervisor"
                >
                  Supervisor
                </label>
                <select
                  id="cf-supervisor"
                  value={supervisor}
                  onChange={(e) => setSupervisor(e.currentTarget.value)}
                  className="block h-10 w-full rounded-md border border-slate-300 px-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
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
                <label
                  className="mb-1 block text-xs font-medium text-slate-600"
                  htmlFor="cf-salesman"
                >
                  Salesman
                </label>
                <select
                  id="cf-salesman"
                  value={salesman}
                  onChange={(e) => setSalesman(e.currentTarget.value)}
                  className="block h-10 w-full rounded-md border border-slate-300 px-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
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
              <label
                className="mb-1 block text-xs font-medium text-slate-600"
                htmlFor="cf-paymentTerms"
              >
                Payment terms
              </label>
              <select
                id="cf-paymentTerms"
                value={paymentTerms}
                onChange={(e) => setPaymentTerms(e.currentTarget.value)}
                className="block h-10 w-full rounded-md border border-slate-300 px-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">All</option>
                <option value="CASH">Cash</option>
                <option value="CREDIT">Credit</option>
              </select>
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium text-slate-600"
                htmlFor="cf-createdAfter"
              >
                Created after
              </label>
              <input
                id="cf-createdAfter"
                type="date"
                value={createdAfter}
                onChange={(e) => setCreatedAfter(e.currentTarget.value)}
                className="block h-10 w-full rounded-md border border-slate-300 px-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium text-slate-600"
                htmlFor="cf-createdBefore"
              >
                Created before
              </label>
              <input
                id="cf-createdBefore"
                type="date"
                value={createdBefore}
                onChange={(e) => setCreatedBefore(e.currentTarget.value)}
                className="block h-10 w-full rounded-md border border-slate-300 px-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium text-slate-600"
                htmlFor="cf-editedAfter"
              >
                Last edited after
              </label>
              <input
                id="cf-editedAfter"
                type="date"
                value={editedAfter}
                onChange={(e) => setEditedAfter(e.currentTarget.value)}
                className="block h-10 w-full rounded-md border border-slate-300 px-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium text-slate-600"
                htmlFor="cf-editedBefore"
              >
                Last edited before
              </label>
              <input
                id="cf-editedBefore"
                type="date"
                value={editedBefore}
                onChange={(e) => setEditedBefore(e.currentTarget.value)}
                className="block h-10 w-full rounded-md border border-slate-300 px-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>
        )}
      </form>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
        <button
          type="button"
          onClick={() => {
            setSaveError(null);
            setSaveName('');
            setSaveModalOpen(true);
          }}
          className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Save view
        </button>

        <SavedViewsMenu views={props.savedViews} onChoose={onChooseView} onDelete={onDeleteView} />

        {props.flags.canExport && (
          <button
            type="button"
            onClick={onExport}
            disabled={exportBusy}
            className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60"
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
        className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Saved views ({views.length}) ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute z-10 mt-1 max-h-80 w-72 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg"
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
        <label
          className="mb-1 mt-4 block text-xs font-medium text-slate-700"
          htmlFor="save-view-name"
        >
          View name
        </label>
        <input
          id="save-view-name"
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
