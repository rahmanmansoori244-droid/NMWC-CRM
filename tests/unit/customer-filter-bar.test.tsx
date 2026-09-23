/**
 * Go-live (2026-09-23) — the customers filter bar, after the three-row redesign.
 *
 * The redesign added a chips row and a "Not applied yet — press Filter" hint on
 * top of a pre-existing defect nobody could see: the bar is never remounted
 * across a client navigation (page.tsx renders it with no `key`, and Next keeps
 * the tree mounted through a router transition), so its form state survived
 * Clear, saved views and Back. Silent staleness became an on-screen instruction
 * to press the button that undid what the owner had just done. Two of these
 * tests are that navigation, reproduced the only way it can be here — a rerender
 * with a changed `initial`, which is exactly what a transition delivers.
 *
 * The rest pin the three contracts the popover has to hold: it must not keep a
 * selection the owner cannot see (that one exported rows they believed they had
 * deselected), Clear and Select all must act on the same set, and the query
 * string must stay the one saved views were written against — SavedView.urlParams
 * is replayed verbatim months later, so both the key order and the value order
 * are a persistence contract, not cosmetics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

// next/link outside a Next runtime has no router to prefetch against. The bar
// uses it only for Clear.
//
// This mock MUST forward onClick. It did not, and the omission hid the very
// defect the test below exists for: Clear from an already-unfiltered URL
// performs no navigation, so resetting the form is the onClick's job and
// nothing else's. A mock that drops the handler makes that test fail against a
// correct fix and pass against no fix at all.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
    onClick,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
    onClick?: () => void;
  }) => (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  ),
}));

// Both are 'use server' modules that pull prisma, next/headers and next/cache.
vi.mock('@/services/saved-views', () => ({
  createSavedViewAction: vi.fn(async () => ({ ok: true, data: null })),
  deleteSavedViewAction: vi.fn(async () => ({ ok: true, data: null })),
}));
vi.mock('@/services/customer-export', () => ({
  exportFilteredCustomersAction: vi.fn(async () => ({ ok: false, message: 'not exercised here' })),
}));

import {
  CustomerFiltersClient,
  buildUrlParamsFrom,
  type CustomerFiltersClientProps,
} from '@/app/(app)/customers/CustomerFiltersClient';
import { MultiSelectFilter } from '@/components/nmwc/MultiSelectFilter';

type Values = CustomerFiltersClientProps['initial'];

const EMPTY: Values = {
  q: '',
  status: '',
  region: [],
  route: [],
  channel: [],
  subChannel: [],
  supervisor: '',
  salesman: '',
  paymentTerms: '',
  minScore: '',
  maxScore: '',
  createdAfter: '',
  createdBefore: '',
  editedAfter: '',
  editedBefore: '',
};

const REGIONS = [
  { id: 'rg-muscat', name: 'Muscat', code: 'MCT' },
  { id: 'rg-dhofar', name: 'Dhofar', code: 'DHF' },
];
const ROUTES = [
  { id: 'rt-muscat', code: 'CAK0240', name: 'Muscat North', regionId: 'rg-muscat' },
  { id: 'rt-dhofar', code: 'DHF0001', name: 'Salalah East', regionId: 'rg-dhofar' },
];
const CHANNELS = [{ id: 'ch-1', label: 'Wholesale' }];

function baseProps(initial: Values): CustomerFiltersClientProps {
  return {
    initial,
    flags: {
      showRegion: true,
      showRoute: true,
      showSupervisor: true,
      showSalesman: true,
      canExport: false,
    },
    regions: REGIONS,
    routes: ROUTES,
    channels: CHANNELS,
    subChannels: [],
    supervisors: [],
    salesmen: [],
    savedViews: [],
  };
}

/** Open a facet popover by its trigger; the trigger's name starts with the label. */
function openFacet(label: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }));
}

/** The chips row, read the only way it is uniquely addressable: its X buttons. */
function chipNames(): string[] {
  return screen
    .queryAllByRole('button', { name: /^Remove filter / })
    .map((b) => (b.getAttribute('aria-label') ?? '').replace('Remove filter ', ''));
}

function submitBar(container: HTMLElement) {
  const form = container.querySelector('form');
  if (!form) throw new Error('filter form not found');
  fireEvent.submit(form);
}

beforeEach(() => {
  push.mockClear();
  refresh.mockClear();
});
afterEach(cleanup);

describe('the bar follows the filters that are actually applied', () => {
  it('drops its pending state when Clear empties the URL', () => {
    // The reported failure: chips still read "Status: Active" / "Region: Muscat"
    // over an unfiltered list, with the hint telling the owner to press Filter —
    // which pushed both filters straight back.
    const applied: Values = { ...EMPTY, status: 'ACTIVE', region: ['rg-muscat'] };
    const { rerender } = render(<CustomerFiltersClient {...baseProps(applied)} />);
    // By the chip's own remove control: the words "Active" and "Muscat" are also
    // in the Status <select> and in the Regions trigger summary.
    expect(chipNames()).toEqual(['Status: Active', 'Region: Muscat']);
    expect(screen.queryByText(/Not applied yet/)).toBeNull();

    // Clear → /customers. Same element type, same position, no key: React keeps
    // the state and only `initial` changes.
    rerender(<CustomerFiltersClient {...baseProps(EMPTY)} />);

    expect(screen.queryByRole('button', { name: /^Remove filter/ })).toBeNull();
    expect(screen.queryByText(/Not applied yet/)).toBeNull();
  });

  it('clears the bar even when Clear changes no URL at all', () => {
    // Found by clicking the preview build, not by reading the code. The resync
    // above fires on appliedParams CHANGING, and Clear is a <Link
    // href="/customers">. From an ALREADY-unfiltered /customers the href is the
    // URL we are on, so Next performs no navigation, `initial` never changes and
    // nothing reset the form: tick a channel, press Clear, and the chip, the
    // trigger summary and the "Not applied yet — press Filter" hint all stayed.
    // Clear now empties the form itself in onClick rather than relying on a
    // navigation that may not happen.
    render(<CustomerFiltersClient {...baseProps(EMPTY)} />);

    openFacet('Channels');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wholesale' }));
    expect(chipNames()).toEqual(['Channel: Wholesale']);
    expect(screen.getByText(/Not applied yet/)).toBeTruthy();

    // No rerender: this is the whole point. The URL does not change, so the
    // component is never re-rendered with a different `initial`.
    fireEvent.click(screen.getByRole('link', { name: 'Clear' }));

    expect(chipNames()).toEqual([]);
    expect(screen.queryByText(/Not applied yet/)).toBeNull();
    expect(screen.getByRole('button', { name: /^Channels/ }).textContent).toMatch(/All channels/);
  });

  it('adopts a saved view rather than offering to discard it', () => {
    // Mounted unfiltered, then a saved view navigates to region + payment terms.
    // Before the fix this rendered the amber hint with no chips at all, and
    // pressing Filter pushed '' — back to the whole 18,677-row list.
    const { container, rerender } = render(<CustomerFiltersClient {...baseProps(EMPTY)} />);
    const view: Values = { ...EMPTY, region: ['rg-muscat'], paymentTerms: 'CREDIT' };
    rerender(<CustomerFiltersClient {...baseProps(view)} />);

    expect(screen.queryByText(/Not applied yet/)).toBeNull();
    expect(chipNames()).toEqual(['Region: Muscat', 'Payment: Credit']);

    // And the button the hint used to advertise now re-applies the view.
    submitBar(container);
    expect(push).toHaveBeenCalledWith('/customers?region=rg-muscat&paymentTerms=CREDIT');
  });

  it('opens More filters for a view whose filters live behind it', () => {
    const { rerender } = render(<CustomerFiltersClient {...baseProps(EMPTY)} />);
    expect(screen.queryByLabelText('Payment terms')).toBeNull();
    rerender(<CustomerFiltersClient {...baseProps({ ...EMPTY, paymentTerms: 'CREDIT' })} />);
    expect(screen.getByLabelText('Payment terms')).toBeInTheDocument();
  });

  it('does not eat what is being typed while its own Filter push is in flight', () => {
    // The reason the resync is not a blanket "props win". onApply runs inside a
    // transition; over this WAN link the round trip is long enough to keep
    // typing through, and resyncing on its commit would delete those keystrokes.
    const { container, rerender } = render(<CustomerFiltersClient {...baseProps(EMPTY)} />);
    const search = screen.getByLabelText('Search customers');
    fireEvent.change(search, { target: { value: 'al hail' } });
    submitBar(container);
    expect(push).toHaveBeenCalledWith('/customers?q=al+hail');

    // Owner keeps typing, then the push we made lands.
    fireEvent.change(search, { target: { value: 'al hail stores' } });
    rerender(<CustomerFiltersClient {...baseProps({ ...EMPTY, q: 'al hail' })} />);

    expect((search as HTMLInputElement).value).toBe('al hail stores');
    expect(screen.getByText(/Not applied yet/)).toBeInTheDocument();
  });

  it('claims its own push once only, so Back to the same URL still resyncs', () => {
    const { container, rerender } = render(<CustomerFiltersClient {...baseProps(EMPTY)} />);
    fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: 'nizwa' } });
    submitBar(container);
    rerender(<CustomerFiltersClient {...baseProps({ ...EMPTY, q: 'nizwa' })} />);
    // Clear…
    rerender(<CustomerFiltersClient {...baseProps(EMPTY)} />);
    expect((screen.getByLabelText('Search customers') as HTMLInputElement).value).toBe('');
    // …then Back to the filtered URL. This navigation is not ours.
    rerender(<CustomerFiltersClient {...baseProps({ ...EMPTY, q: 'nizwa' })} />);
    expect((screen.getByLabelText('Search customers') as HTMLInputElement).value).toBe('nizwa');
    expect(screen.queryByText(/Not applied yet/)).toBeNull();
  });

  it('takes the server normalisation of a score back, instead of reading dirty forever', () => {
    // '07' is a valid number-input value, so it reached the URL unchanged while
    // the server echoed back '7'. The two strings differed, so the bar read as
    // dirty under a filter that WAS applied and the amber hint could not be
    // dismissed by pressing Filter again.
    const { container, rerender } = render(<CustomerFiltersClient {...baseProps(EMPTY)} />);
    const min = screen.getByLabelText('Minimum completeness score') as HTMLInputElement;
    fireEvent.change(min, { target: { value: '07' } });
    submitBar(container);
    expect(push).toHaveBeenCalledWith('/customers?minScore=07');

    rerender(<CustomerFiltersClient {...baseProps({ ...EMPTY, minScore: '7' })} />);
    expect(min.value).toBe('7');
    expect(screen.queryByText(/Not applied yet/)).toBeNull();
  });

  it('clamps a score the browser would otherwise refuse to submit', () => {
    // The boxes carry max=100 and the form is not noValidate, so 500 made
    // checkValidity() false: Filter never reached onApply, and the hint went on
    // telling the owner to press the button the browser was blocking.
    render(<CustomerFiltersClient {...baseProps(EMPTY)} />);
    const min = screen.getByLabelText('Minimum completeness score') as HTMLInputElement;
    fireEvent.change(min, { target: { value: '500' } });
    fireEvent.blur(min);
    expect(min.value).toBe('100');
    fireEvent.change(min, { target: { value: '07' } });
    fireEvent.blur(min);
    expect(min.value).toBe('7');
  });
});

describe('a selection the owner cannot see never reaches the URL', () => {
  it('drops routes outside the region the owner has just narrowed to', () => {
    // Tick a Dhofar route, then narrow to Muscat. The route used to stay in
    // state — invisible, matching nothing while Muscat was selected (both
    // predicates must hold on the same branch row) — and came back in the list
    // and in 'Export filtered' the moment the Region chip came off.
    const { container } = render(
      <CustomerFiltersClient {...baseProps({ ...EMPTY, route: ['rt-dhofar'] })} />
    );
    expect(screen.getByText('DHF0001')).toBeInTheDocument();

    openFacet('Regions');
    fireEvent.click(screen.getByLabelText('Muscat'));

    expect(screen.queryByText('DHF0001')).toBeNull();
    submitBar(container);
    expect(push).toHaveBeenCalledWith('/customers?region=rg-muscat');
  });

  it('prints no database id for a facet this role was given no list for', () => {
    // page.tsx passes regions: [], routes: [], supervisors: [], salesmen: [] to
    // the roles that do not get those facets. A SALESMAN opening a link pasted
    // by a steward used to see chips of raw cuids.
    render(
      <CustomerFiltersClient
        {...baseProps({ ...EMPTY, region: ['cmg7ab0000001'], supervisor: 'cmg7cd0000002' })}
        flags={{
          showRegion: false,
          showRoute: false,
          showSupervisor: false,
          showSalesman: false,
          canExport: false,
        }}
        regions={[]}
        routes={[]}
        supervisors={[]}
        salesmen={[]}
      />
    );
    expect(screen.queryByText(/cmg7ab0000001/)).toBeNull();
    expect(screen.queryByText(/cmg7cd0000002/)).toBeNull();
    // The chip stays: its X is the only handle this role has on the filter.
    expect(screen.getAllByText('outside your access')).toHaveLength(2);
  });
});

describe('MultiSelectFilter', () => {
  const OPTIONS = [
    { value: 'rt-a', label: 'CAK0240 — Muscat North' },
    { value: 'rt-b', label: 'CAK0241 — Muscat South' },
  ];

  it('rebuilds its value from the options it can show, in option order', () => {
    // Both halves of the restored `<select multiple>` behaviour: the id whose
    // option is gone is pruned on the next interaction, and the value comes back
    // in option order rather than click order — the order saved views replay.
    const onChange = vi.fn();
    render(
      <MultiSelectFilter
        label="Routes"
        value={['rt-gone', 'rt-b']}
        onChange={onChange}
        options={OPTIONS}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Routes/ }));
    fireEvent.click(screen.getByLabelText('CAK0240 — Muscat North'));
    expect(onChange).toHaveBeenCalledWith(['rt-a', 'rt-b']);
  });

  it('counts what this list can show, and names the rest separately', () => {
    // "2 of 1 selected" was reachable whenever the region filter had narrowed
    // the route list under a selection made before it.
    render(
      <MultiSelectFilter
        label="Routes"
        value={['rt-gone', 'rt-b']}
        onChange={() => {}}
        options={OPTIONS}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Routes/ }));
    const panel = screen.getByRole('dialog', { name: 'Routes' });
    expect(within(panel).getByText(/of 2 selected/).textContent).toBe(
      '1 of 2 selected · 1 not in this list'
    );
  });

  it('clears only what the search is showing, and says which that is', () => {
    // Select all had always merged just the matches while Clear emptied
    // everything: a steward reviewing four of twenty ticked routes behind a
    // search lost all twenty, sixteen of them never on screen.
    const many = Array.from({ length: 10 }, (_, i) => ({
      value: `rt-${i}`,
      label: `Route ${i}`,
    }));
    const onChange = vi.fn();
    render(
      <MultiSelectFilter
        label="Routes"
        value={many.map((o) => o.value)}
        onChange={onChange}
        options={many}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Routes/ }));
    fireEvent.change(screen.getByLabelText('Search routes'), { target: { value: 'Route 3' } });

    fireEvent.click(screen.getByRole('button', { name: 'Clear shown' }));
    expect(onChange).toHaveBeenCalledWith([
      'rt-0',
      'rt-1',
      'rt-2',
      'rt-4',
      'rt-5',
      'rt-6',
      'rt-7',
      'rt-8',
      'rt-9',
    ]);
  });

  it('refuses Enter on an option, the way it already did on the search box', () => {
    // The popover renders inside the customers <form>, and browsers implicitly
    // submit on Enter from a checkbox — a keyboard user ticking routes with
    // Space and pressing Enter for "Done" navigated away mid-selection. jsdom
    // does not implement implicit submission, so this asserts the guard itself:
    // fireEvent returns false when the handler called preventDefault.
    render(<MultiSelectFilter label="Routes" value={[]} onChange={() => {}} options={OPTIONS} />);
    fireEvent.click(screen.getByRole('button', { name: /^Routes/ }));
    const box = screen.getByLabelText('CAK0240 — Muscat North');
    expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(false);
    // Space still reaches the browser, which is how a checkbox is operated.
    expect(fireEvent.keyDown(box, { key: ' ' })).toBe(true);
  });

  it('uses a border colour the theme can actually generate', () => {
    // tailwind.config.ts has no brand-300, so `border-brand-300` emitted no rule
    // and the facet WITH a selection was outlined more faintly than the ones
    // without. Asserting the class, because only a browser can show the colour.
    const { container } = render(
      <MultiSelectFilter label="Routes" value={['rt-a']} onChange={() => {}} options={OPTIONS} />
    );
    const cls = container.querySelector('button')?.className ?? '';
    expect(cls).not.toMatch(/border-brand-(300|400)\b/);
    expect(cls).toMatch(/border-brand-500\b/);
  });
});

describe('the query-string contract saved views replay', () => {
  it('emits every key in the documented order', () => {
    // SavedView.urlParams is stored raw and replayed months later. Reordering
    // these keys silently changes what every view saved before the change
    // resolves to.
    const all: Values = {
      q: ' al hail ',
      status: 'ACTIVE',
      region: ['rg1', 'rg2'],
      route: ['rt1'],
      channel: ['ch1'],
      subChannel: ['sc1'],
      supervisor: 'u-sup',
      salesman: 'u-sal',
      paymentTerms: 'CREDIT',
      minScore: '40',
      maxScore: '90',
      createdAfter: '2026-01-01',
      createdBefore: '2026-02-01',
      editedAfter: '2026-03-01',
      editedBefore: '2026-04-01',
    };
    expect(buildUrlParamsFrom(all)).toBe(
      'q=al+hail&status=ACTIVE&region=rg1%2Crg2&route=rt1&channel=ch1&subChannel=sc1' +
        '&supervisor=u-sup&salesman=u-sal&paymentTerms=CREDIT&minScore=40&maxScore=90' +
        '&createdAfter=2026-01-01&createdBefore=2026-02-01&editedAfter=2026-03-01' +
        '&editedBefore=2026-04-01'
    );
  });

  it('omits every empty value, so an untouched bar produces no query at all', () => {
    expect(buildUrlParamsFrom(EMPTY)).toBe('');
    expect(buildUrlParamsFrom({ ...EMPTY, q: '   ' })).toBe('');
  });
});
