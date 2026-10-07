/**
 * Launch fix (2026-10-07): /export lists only what the viewer may export, and a
 * refused export is shown on the page instead of raw JSON.
 *
 * What was wrong:
 *   - the page offered every active region and route to everyone; a Manager's
 *     pick outside his regions was intersected away by the export
 *     (lib/export-scope.ts) and returned an empty workbook;
 *   - every download was a navigation (window.location.href, or a plain link),
 *     so a 403 "Export too large…", a 400, a 401 or a 500 replaced the page with
 *     the route's JSON.
 *
 * The page is rendered with its session and database mocked (the region and
 * route reads honour their where clauses), and the form is driven with fetch
 * mocked to the export routes' answers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

type Where = Record<string, unknown> | undefined;
/** The where shapes the export page and lib/export-scope.ts send, and nothing else. */
type RegionWhere = {
  isActive?: boolean;
  id?: { in: string[] };
  managers?: { some: { id: string } };
  routes?: { some: { id: { in: string[] } } };
};
type RouteWhere = { isActive?: boolean; id?: { in: string[] }; regionId?: { in: string[] } };
const h = vi.hoisted(() => ({
  user: { id: 'me', role: 'MANAGER', username: 'me' },
  regions: [
    { id: 'g-mine', name: 'Muscat', code: 'MCT', isActive: true, managers: ['me'] },
    { id: 'g-other', name: 'Dhofar', code: 'DHO', isActive: true, managers: [] as string[] },
  ],
  routes: [
    { id: 'r-mine', code: 'MCT-01', name: 'Muscat 1', regionId: 'g-mine', isActive: true },
    { id: 'r-mine2', code: 'MCT-02', name: 'Muscat 2', regionId: 'g-mine', isActive: true },
    { id: 'r-other', code: 'DHO-01', name: 'Dhofar 1', regionId: 'g-other', isActive: true },
  ],
  /** Salesmen reporting to the Supervisor, by route. */
  reports: [{ ownedRouteId: 'r-mine2' }],
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('@/lib/db', () => {
  const inList = (cond: unknown, value: string) =>
    cond === undefined || ((cond as { in: string[] }).in ?? []).includes(value);
  return {
    prisma: {
      region: {
        findMany: async ({ where }: { where: Where }) =>
          h.regions
            .filter((r) => {
              const w = (where ?? {}) as RegionWhere;
              if (w.managers) return r.managers.includes(w.managers.some.id);
              if (w.isActive !== undefined && r.isActive !== w.isActive) return false;
              if (!inList(w.id, r.id)) return false;
              const picked = w.routes?.some.id.in;
              if (picked && !h.routes.some((rt) => rt.regionId === r.id && picked.includes(rt.id)))
                return false;
              return true;
            })
            .map(({ id, name, code }) => ({ id, name, code })),
      },
      route: {
        findMany: async ({ where }: { where: Where }) =>
          h.routes
            .filter((r) => {
              const w = (where ?? {}) as RouteWhere;
              return r.isActive === w.isActive && inList(w.regionId, r.regionId) && inList(w.id, r.id);
            })
            .map(({ id, code, name, regionId }) => ({ id, code, name, regionId })),
      },
      user: { findMany: async () => h.reports },
    },
  };
});

import ExportPage from '@/app/(app)/export/page';

const checkboxLabels = () =>
  [...document.querySelectorAll('input[type="checkbox"]')].map((c) => c.parentElement!.textContent!.trim());

beforeEach(() => {
  h.user = { id: 'me', role: 'MANAGER', username: 'me' };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/export lists only what the viewer may export', () => {
  it('a Manager: his regions and their routes', async () => {
    render(await ExportPage());
    const labels = checkboxLabels();
    expect(labels).toContain('Muscat');
    expect(labels).not.toContain('Dhofar');
    expect(labels).toEqual(expect.arrayContaining(['MCT-01', 'MCT-02']));
    expect(labels).not.toContain('DHO-01');
  });

  it('a Supervisor: his team’s routes and their region', async () => {
    h.user = { id: 'sup', role: 'SUPERVISOR', username: 'sup' };
    render(await ExportPage());
    const labels = checkboxLabels();
    expect(labels).toContain('Muscat');
    expect(labels).not.toContain('Dhofar');
    expect(labels).toContain('MCT-02');
    expect(labels).not.toContain('MCT-01');
  });

  it('the Steward: everything', async () => {
    h.user = { id: 'stw', role: 'STEWARD', username: 'stw' };
    render(await ExportPage());
    expect(checkboxLabels()).toEqual(expect.arrayContaining(['Muscat', 'Dhofar', 'MCT-01', 'MCT-02', 'DHO-01']));
  });

  it('a Manager with no regions is told there is nothing to export', async () => {
    h.regions = h.regions.map((r) => ({ ...r, managers: [] }));
    render(await ExportPage());
    expect(screen.getByText(/You have no managed regions yet/)).toBeTruthy();
    h.regions[0]!.managers = ['me'];
  });
});

describe('/export shows a refused download on the page', () => {
  const answer = (status: number, body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
    vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));

  async function openForm() {
    h.user = { id: 'stw', role: 'STEWARD', username: 'stw' };
    render(await ExportPage());
  }

  it.each([
    [403, { error: 'Export too large: 70000 rows. One file holds up to 60,000 rows — filter by region or route and export in parts.' }, 'Export too large: 70000 rows.'],
    [401, { error: 'Not signed in' }, 'Your session has ended. Sign in again, then download.'],
    [400, { error: 'Invalid filter parameters' }, 'These filters could not be read. Clear them and try again.'],
    [500, { error: 'Export failed' }, 'The export failed on the server.'],
  ])('%i: the reason, in red, and the page stays', async (status, body, words) => {
    const fetchMock = answer(status, body);
    vi.stubGlobal('fetch', fetchMock);
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Download .xlsx' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(words);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/exports\/customers\?/), expect.anything());
    expect(screen.getByRole('button', { name: 'Download .xlsx' })).toBeTruthy();
  });

  it('the field-update report and Download all go the same way', async () => {
    const fetchMock = answer(403, { error: 'Your role cannot export.' });
    vi.stubGlobal('fetch', fetchMock);
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Download field-update report' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Your role cannot export.');
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringMatching(/^\/api\/exports\/changes\?/), expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Download all (no filters)' }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/exports/customers', expect.anything()));
  });

  it('a page instead of the file (a sign-in redirect) is not saved as a workbook', async () => {
    vi.stubGlobal('fetch', answer(200, '<html></html>', { 'Content-Type': 'text/html' }));
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Download .xlsx' }));
    expect((await screen.findByRole('alert')).textContent).toContain('answered with a page instead of the file');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('a workbook is saved under the server’s file name, with no message', async () => {
    vi.stubGlobal(
      'fetch',
      answer(200, 'xlsx-bytes', {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="nmwc-customer-master-2026-10-07.xlsx"',
      })
    );
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Download .xlsx' }));
    await waitFor(() => expect(clicked).toEqual(['nmwc-customer-master-2026-10-07.xlsx']));
    expect(screen.queryByRole('alert')).toBeNull();
    click.mockRestore();
  });
});
