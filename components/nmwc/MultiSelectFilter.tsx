'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search as SearchIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type MultiSelectOption = { value: string; label: string };

/**
 * Go-live (2026-09-23): the customers filter bar rendered Regions, Routes and
 * Channels as three native `<select multiple>` boxes at most four rows tall
 * (`size={Math.min(4, Math.max(2, options.length))}`). With 44 routes in the
 * loaded master the owner could not tell what was selected without scrolling
 * each box, and the three boxes side by side pushed the
 * Filter button off the right edge of a 1280px window ("i cannot see the rest
 * of the details"). This is the replacement: a one-line trigger that states the
 * current selection, opening a popover with a search field and real checkboxes.
 *
 * Deliberately a checkbox list rather than an ARIA listbox: checkboxes are
 * natively keyboard-operable and announce their own checked state, so the
 * control needs no roving-tabindex code to be correct — and code that is not
 * written cannot rot.
 */
export function MultiSelectFilter({
  label,
  value,
  onChange,
  options,
  allLabel = 'All',
  block = false,
  searchThreshold = 8,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  options: MultiSelectOption[];
  /** Trigger text when nothing is selected. */
  allLabel?: string;
  /** Full-width variant with the label above, for the "More filters" grid. */
  block?: boolean;
  /** Show the in-popover search box once the list is at least this long. */
  searchThreshold?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The Channels trigger sits near the right edge on a wide window; a
  // left-aligned panel would then hang off-screen, which is the bug we are
  // fixing. Measured on open rather than guessed from a breakpoint.
  const [alignRight, setAlignRight] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const firstOptionRef = useRef<HTMLInputElement>(null);

  const reactId = useId();
  const panelId = `msf-${reactId}-panel`;
  const labelId = `msf-${reactId}-label`;
  const summaryId = `msf-${reactId}-summary`;

  const showSearch = options.length >= searchThreshold;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.label.toLowerCase().includes(needle));
  }, [options, query]);

  // A selection can outlive its option list — picking a route and then narrowing
  // the region filter hides that route's checkbox but keeps the id in state (and
  // in the URL) until the next interaction prunes it. Fall back to the count so
  // the trigger never lies.
  const summary =
    value.length === 0
      ? allLabel
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? '1 selected')
        : `${value.length} selected`;

  useEffect(() => {
    if (!open) return;
    (showSearch ? searchRef.current : firstOptionRef.current)?.focus();
  }, [open, showSearch]);

  // Outside click closes. pointerdown, not click, so the panel is gone before a
  // click lands on whatever is underneath it.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function openPanel() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAlignRight(rect.left + 288 > window.innerWidth - 8);
    setQuery('');
    setOpen(true);
  }

  function closePanel(refocus: boolean) {
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  }

  /**
   * Every mutation goes through here, and it rebuilds the value from `options`.
   *
   * The `<select multiple>` this popover replaced did the same thing implicitly:
   * its onChange walked `e.currentTarget.options`, so an id whose option had
   * dropped out of the narrowed list was pruned by the next interaction with the
   * box. The popover kept it forever — tick a Dhofar route, then tighten Region
   * to Muscat and pick a Muscat route: the Dhofar id stayed in state, matched
   * nothing while Muscat was selected (both predicates must hold on the same
   * branch row) and came back the moment the Region chip came off, in the list
   * AND in the workbook 'Export filtered' posts.
   *
   * Rebuild from `options`, never from `filtered`: the in-popover search hides
   * options, it must not delete the selections behind them. Rebuilding in
   * `options` order also restores the DOM order the old box emitted, which is
   * the order saved views replay months later.
   */
  function commit(selected: Set<string>) {
    onChange(options.filter((o) => selected.has(o.value)).map((o) => o.value));
  }

  function toggle(optionValue: string) {
    const next = new Set(value);
    if (next.has(optionValue)) next.delete(optionValue);
    else next.add(optionValue);
    commit(next);
  }

  // `value` may hold ids this list cannot show (the case above, or a bookmarked
  // URL carrying an id outside the caller's scope). Count what is on screen and
  // name the rest, rather than printing "2 of 1 selected".
  const inList = options.reduce((n, o) => (value.includes(o.value) ? n + 1 : n), 0);
  const outsideList = value.length - inList;
  // True while the search box is hiding at least one option.
  const narrowed = filtered.length !== options.length;
  const shownSelected = filtered.reduce((n, o) => (value.includes(o.value) ? n + 1 : n), 0);

  return (
    <div
      ref={containerRef}
      className={cn('relative', block ? 'block' : 'inline-block')}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault();
          e.stopPropagation();
          closePanel(true);
        }
      }}
      onBlur={(e) => {
        // relatedTarget is null when focus moves to something unfocusable (the
        // panel's own padding). Only tabbing away should close it; the
        // pointerdown listener above already handles clicks outside.
        const next = e.relatedTarget as Node | null;
        if (next && !containerRef.current?.contains(next)) closePanel(false);
      }}
    >
      {block && (
        <span id={labelId} className="mb-1 block text-xs font-medium text-slate-600">
          {label}
        </span>
      )}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closePanel(false) : openPanel())}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-labelledby={block ? `${labelId} ${summaryId}` : undefined}
        className={cn(
          'inline-flex h-10 items-center gap-2 rounded-md border bg-white px-3 text-sm',
          'hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
          block ? 'w-full justify-between' : 'max-w-[15rem]',
          // brand-500, not brand-300: tailwind.config.ts defines brand at
          // 50/100/200/500/600/700/800/900 and has no 300, so `border-brand-300`
          // emitted no rule at all and the border fell back to preflight's
          // gray-200 — the facet WITH a selection outlined more faintly than the
          // untouched ones beside it, in the control added to make selections
          // obvious. Same trap as the accent-* note further down.
          value.length > 0 ? 'border-brand-500 bg-brand-50 hover:bg-brand-100' : 'border-slate-300'
        )}
      >
        {!block && <span className="shrink-0 text-slate-500">{label}</span>}
        <span
          id={summaryId}
          className={cn(
            'truncate font-medium',
            value.length > 0 ? 'text-brand-800' : 'text-slate-900'
          )}
        >
          {summary}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          className={cn(
            'absolute top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-slate-200 bg-white shadow-lg',
            alignRight ? 'right-0' : 'left-0'
          )}
        >
          {showSearch && (
            <div className="relative border-b border-slate-100 p-2">
              <SearchIcon
                className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                // The popover lives inside the filter <form>; without this,
                // Enter here submits the form and navigates away mid-selection.
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
                placeholder={`Search ${label.toLowerCase()}…`}
                aria-label={`Search ${label.toLowerCase()}`}
                className="w-full rounded-md border border-slate-300 py-1.5 pl-8 pr-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
          )}

          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-1.5 text-xs text-slate-500">
            <span>
              {inList} of {options.length} selected
              {outsideList > 0 && ` · ${outsideList} not in this list`}
            </span>
            <span className="flex items-center gap-2">
              {/* Both buttons act on exactly what is on screen and say which
                  that is. They used to disagree: Select all only ever added the
                  search matches while Clear called onChange([]) whatever the
                  search box said, so a steward who ticked twenty routes, typed
                  "SAL" to review four of them and pressed Clear lost all twenty
                  — sixteen of them never on screen, recoverable only by ticking
                  each one again. */}
              <button
                type="button"
                onClick={() => {
                  const next = new Set(value);
                  for (const o of filtered) next.add(o.value);
                  commit(next);
                }}
                className="rounded px-1 font-medium text-brand-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {narrowed ? 'Select shown' : 'Select all'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!narrowed) {
                    onChange([]);
                    return;
                  }
                  const next = new Set(value);
                  for (const o of filtered) next.delete(o.value);
                  commit(next);
                }}
                disabled={narrowed ? shownSelected === 0 : value.length === 0}
                className="rounded px-1 font-medium text-slate-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-40 disabled:hover:no-underline"
              >
                {narrowed ? 'Clear shown' : 'Clear'}
              </button>
            </span>
          </div>

          <ul className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-3 py-3 text-sm text-slate-500">No matches.</li>
            )}
            {filtered.map((o, i) => {
              const checked = value.includes(o.value);
              return (
                <li key={o.value}>
                  <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 has-[:focus-visible]:bg-slate-50">
                    <input
                      ref={i === 0 ? firstOptionRef : undefined}
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(o.value)}
                      // Same hazard the search input above guards, and it was
                      // guarded there only: the popover lives inside the
                      // customers <form>, and browsers implicitly submit on
                      // Enter from a checkbox, so a keyboard user ticking three
                      // routes and pressing Enter for "Done" navigated away
                      // mid-selection instead. Checkboxes toggle on Space, so
                      // nothing is lost by refusing Enter here.
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.preventDefault();
                      }}
                      // accent-*, not the @tailwindcss/forms utilities — this
                      // project has no forms plugin, so `text-brand-600` on a
                      // checkbox would style nothing.
                      className="h-4 w-4 shrink-0 accent-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    />
                    <span className="truncate">{o.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>

          <div className="flex justify-end border-t border-slate-100 p-2">
            <button
              type="button"
              onClick={() => closePanel(true)}
              className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
