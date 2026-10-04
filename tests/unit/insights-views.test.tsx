/**
 * F2: the dashboard's server-rendered pieces — the map, the chart and the
 * "What stands out" sentences — without a page around them.
 *
 * What matters here beyond looks: the map never prints a coordinate (only grid
 * cells the database counted reach it, and it labels itself approximate); the
 * chart's numbers are readable without colour or hover; the sentences never
 * compare the viewer with anyone else.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { OmanHeatMap, heatClasses } from '@/components/insights/OmanHeatMap';
import { ColumnChart } from '@/components/insights/ColumnChart';
import { KpiTile } from '@/components/insights/KpiTile';
import { OMAN_FRAME, OMAN_POLYGONS, frameAround, frameSize, outlinePath, project } from '@/lib/geo/oman';
import { MAP } from '@/lib/insights/policy';
import { concentration, highlights } from '@/lib/insights/highlights';
import type { Insights } from '@/lib/insights/load';

afterEach(cleanup);

describe('the outline of Oman', () => {
  it('is the mainland, Musandam and Masirah, all inside the box the app validates GPS against', () => {
    expect(OMAN_POLYGONS).toHaveLength(3);
    for (const poly of OMAN_POLYGONS) {
      for (const [lng, lat] of poly) {
        expect(lat).toBeGreaterThanOrEqual(MAP.bounds.latMin);
        expect(lat).toBeLessThanOrEqual(MAP.bounds.latMax);
        expect(lng).toBeGreaterThanOrEqual(MAP.bounds.lngMin);
        expect(lng).toBeLessThanOrEqual(MAP.bounds.lngMax);
      }
    }
    expect(outlinePath(OMAN_FRAME).match(/Z/g)).toHaveLength(3);
  });

  it('projects north up and east right', () => {
    const [xMuscat, yMuscat] = project(OMAN_FRAME, [58.41, 23.59]);
    const [xSalalah, ySalalah] = project(OMAN_FRAME, [54.09, 17.02]);
    expect(xMuscat).toBeGreaterThan(xSalalah);
    expect(yMuscat).toBeLessThan(ySalalah);
  });

  it('closes in on one region’s cells, keeping the country’s proportions', () => {
    const f = frameAround([{ lat: 23.55, lng: 58.35 }, { lat: 23.6, lng: 58.5 }], 0.01);
    expect(f.lngMin).toBeLessThan(58.35);
    expect(f.lngMax).toBeGreaterThan(58.51);
    expect(f.latMax - f.latMin).toBeGreaterThanOrEqual(1);
    const a = frameSize(f);
    const c = frameSize(OMAN_FRAME);
    expect(Math.abs(a.width / a.height - c.width / c.height)).toBeLessThan(0.02);
    expect(frameAround([], 0.01)).toEqual(OMAN_FRAME);
  });
});

describe('the heat map', () => {
  it('colour classes: one per count when there are few, at most five otherwise, ending at the largest', () => {
    expect(heatClasses([1, 1, 2])).toEqual([1, 2]);
    const many = heatClasses([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50]);
    expect(many.length).toBeLessThanOrEqual(5);
    expect([...many].sort((a, b) => a - b)).toEqual(many);
    expect(many.at(-1)).toBe(50);
  });

  it('draws one square per cell, says it is approximate, and prints no coordinate', () => {
    const cells = [
      { lat: 23.55, lng: 58.35, n: 4 },
      { lat: 17.05, lng: 54.1, n: 1 },
    ];
    const { container } = render(<OmanHeatMap cells={cells} cellDeg={0.05} zoom={false} />);
    expect(container.querySelectorAll('svg rect title')).toHaveLength(2);
    expect(container.textContent).toMatch(/Outline approximate, not a survey map/);
    expect(container.textContent).toMatch(/4 open branches with GPS/);
    expect(container.textContent).not.toMatch(/23\.55|58\.35|17\.05/);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/2 squares hold 5 open branches/);
  });
});

describe('the column chart', () => {
  const points = [
    { key: 'a', label: '28 Sep', values: [2, 1] },
    { key: 'b', label: '5 Oct', values: [0, 3], partial: true },
  ];
  const series = [
    { key: 'x', label: 'Cash', color: '#2a78d6' },
    { key: 'y', label: 'Credit', color: '#eb6834' },
  ];

  it('names every series with its total, and lists every bucket in words', () => {
    const { container } = render(<ColumnChart series={series} points={points} unit="new customers" emptyText="none" />);
    expect(container.textContent).toMatch(/Cash2/);
    expect(container.textContent).toMatch(/Credit4/);
    expect(container.textContent).toMatch(/28 Sep: 3 new customers \(2 cash, 1 credit\)/);
    expect(container.textContent).toMatch(/5 Oct \(part of the period\): 3 new customers/);
  });

  it('leaves out legend totals that would not add up', () => {
    const { container } = render(
      <ColumnChart series={series} points={points} unit="customers" emptyText="none" legendTotals={false} />
    );
    expect(container.textContent).not.toMatch(/Cash2/);
  });

  it('says so when there is nothing to draw', () => {
    render(<ColumnChart series={series} points={[{ key: 'a', label: 'x', values: [0, 0] }]} unit="u" emptyText="Nothing yet." />);
    expect(screen.getByText('Nothing yet.')).toBeTruthy();
  });
});

describe('a figure whose query failed', () => {
  it('says it is not available instead of showing a zero', () => {
    const { container } = render(<KpiTile label="New customers" value="0" failed />);
    expect(container.textContent).toMatch(/Not available just now/);
    expect(container.textContent).not.toMatch(/\b0\b/);
  });
});

describe('What stands out', () => {
  const routeRef = (id: string, hasOwner: boolean) => ({ id, code: id.toUpperCase(), name: id, regionId: 'r', regionName: 'R', hasOwner });
  const counts = { branches: 10, customers: 10, open: 10, closed: 0, closedInPeriod: 0, openWithGps: 4, openNoDay: 3, openNoShop: 0, openNoSign: 0, openNoEquipment: 0, customersNoCr: 0, imported: 0, completenessPct: 50 };
  const data: Insights = {
    state: {
      ok: true,
      data: {
        total: { ...counts, customers: 200, open: 180, openWithGps: 60, openNoDay: 30 },
        regions: [
          { ...counts, open: 100, openWithGps: 20, region: { id: 'r1', name: 'Alpha', code: 'A' } },
          { ...counts, open: 80, openWithGps: 40, region: { id: 'r2', name: 'Beta', code: 'B' } },
        ],
        routes: [
          { ...counts, route: routeRef('a1', true) },
          { ...counts, route: routeRef('b1', false) },
          { ...counts, route: routeRef('c1', true) },
        ],
      },
    },
    created: { ok: true, data: { total: 12, prevTotal: 10, cash: 9, credit: 3, unrecorded: 0, series: [], regions: [], routes: [{ route: routeRef('a1', true), n: 2 }] } },
    updated: {
      ok: true,
      data: {
        customers: 50, byRequest: 45, directOnly: 5, changes: 60, prevCustomers: 40,
        families: { gps: 0, phone: 0, address: 0, visitDay: 0, channel: 0, equipment: 0, contact: 0 },
        series: [], regions: [], routes: [],
      },
    },
    statusChanges: { ok: false },
    pipeline: { ok: false },
    heat: { ok: true, data: { cellDeg: 0.05, cells: [{ lat: 1, lng: 1, n: 30 }, ...Array.from({ length: 11 }, () => ({ lat: 2, lng: 2, n: 3 }))], totalCells: 12, located: 63, openBranches: 180, openWithGps: 60 } },
  };

  it('reads the view: trend, reach, idle routes, the largest GPS gap, visit days, concentration', () => {
    const items = highlights(data, 'in the last 30 days');
    const text = items.map((i) => i.text).join(' | ');
    expect(text).toMatch(/12 new customers created in the field in the last 30 days, up 20% on the period before\. 3 of them on credit\./);
    expect(text).toMatch(/Approved updates reached 25% of the customers in view \(50 of 200\)/);
    expect(text).toMatch(/2 routes with customers had no approved field request in the last 30 days; 1 of them has no salesman assigned/);
    expect(text).toMatch(/the most in Alpha \(80, 80% of its open branches\)/);
    expect(text).toMatch(/30 open branches have no visit day \(17%\)/);
    expect(text).toMatch(/Half of the branches located on the map sit in 2 squares/);
  });

  it('leaves out what failed, and never compares the viewer with anyone else', () => {
    const items = highlights(data, 'in the last 30 days');
    expect(items.some((i) => i.key === 'closures')).toBe(false);
    expect(items.map((i) => i.text).join(' ')).not.toMatch(/company|national|organisation|average|other region|Manager [A-Z]/);
  });

  it('concentration is only read when the drawn cells can show it', () => {
    expect(concentration({ cellDeg: 0.05, cells: [{ lat: 1, lng: 1, n: 5 }], totalCells: 1, located: 5, openBranches: 5, openWithGps: 5 })).toBeNull();
  });
});
