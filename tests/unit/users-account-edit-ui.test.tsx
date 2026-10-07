/**
 * Owner decision 8 (2026-10-07), the screens: the Data Steward's Edit account
 * dialog on /users, the create form's regions and route hand-over, and the
 * page's Regions column and Edit buttons.
 *
 * Driven through the real components (jsdom) with the server actions mocked to
 * the shapes runAction returns (lib/errors.ts). What is pinned:
 *   - the dialog offers what the action would accept: routes that are free, held
 *     by a disabled account (the leaver) or his own, never one an active
 *     salesman works or one switched off; supervisors who cover the route's
 *     region; regions only for a Manager or Accountant;
 *   - it sends exactly the fields services/users.ts updateUserAccountAction reads;
 *   - a refusal lands on its field and the dialog stays; a success is announced
 *     in the banner above the table, with what the action says about open work;
 *   - the stored phone number never reaches the page — only whether one is on file;
 *   - picking a route fills the new salesman's username with the route code;
 *   - only the Steward gets Edit, and never on his own row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  edit: vi.fn(),
  create: vi.fn(),
  user: { id: 'stw', role: 'STEWARD', username: 'data.steward' },
  rows: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/services/users', () => ({
  updateUserAccountAction: h.edit,
  createUserAction: h.create,
  toggleUserActiveAction: vi.fn(),
  resetPasswordAction: vi.fn(),
  updateUserEmailAction: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g-mct'] }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
function project(
  row: Record<string, unknown>,
  select: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k];
    else if (v && typeof v === 'object' && 'select' in v) {
      const nested = row[k] as
        Record<string, unknown> | Array<Record<string, unknown>> | null | undefined;
      const inner = (v as { select: Record<string, unknown> }).select;
      out[k] =
        nested == null
          ? nested
          : Array.isArray(nested)
            ? nested.map((n) => project(n, inner))
            : project(nested, inner);
    }
  }
  return out;
}
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findMany: async (args: { select: Record<string, unknown> }) =>
        h.rows.map((r) => project(r, args.select)),
    },
    route: { findMany: async () => [] },
    region: { findMany: async () => [] },
  },
}));

import { UsersFeedback } from '@/app/(app)/users/UserRowActions';
import {
  EditAccountButton,
  type EditOptions,
  type EditableRow,
} from '@/app/(app)/users/EditAccount';
import { CreateUserForm } from '@/app/(app)/users/CreateUserForm';
import UsersPage from '@/app/(app)/users/page';

const OPTIONS: EditOptions = {
  regions: [
    { id: 'g-khb', code: 'KHB', name: 'Khaburah', isActive: true },
    { id: 'g-mct', code: 'MCT', name: 'Muscat', isActive: true },
    { id: 'g-old', code: 'OLD', name: 'Closed region', isActive: false },
  ],
  routes: [
    {
      id: 'r-c4',
      code: 'C4',
      name: 'Ruwi',
      regionId: 'g-mct',
      isActive: true,
      holder: { id: 'u-ali', fullName: 'Ali', username: 'c4', isActive: true },
    },
    { id: 'r-c5', code: 'C5', name: 'Qurum', regionId: 'g-mct', isActive: true, holder: null },
    {
      id: 'r-c6',
      code: 'C6',
      name: 'Seeb',
      regionId: 'g-mct',
      isActive: true,
      holder: { id: 'u-old', fullName: 'Old Salesman', username: 'c6', isActive: false },
    },
    {
      id: 'r-c7',
      code: 'C7',
      name: 'Busy',
      regionId: 'g-mct',
      isActive: true,
      holder: { id: 'u-busy', fullName: 'Busy Salesman', username: 'c7', isActive: true },
    },
    { id: 'r-k1', code: 'K1', name: 'Saham', regionId: 'g-khb', isActive: true, holder: null },
    {
      id: 'r-off',
      code: 'OFF1',
      name: 'Switched off',
      regionId: 'g-mct',
      isActive: false,
      holder: null,
    },
  ],
  supervisors: [
    {
      id: 'm-gt',
      fullName: 'Manager GT',
      username: 'mct-gt',
      role: 'MANAGER',
      isActive: true,
      managedRegionIds: ['g-mct'],
      teamRegionIds: [],
    },
    {
      id: 'm-khb',
      fullName: 'Manager KHB',
      username: 'khaburah',
      role: 'MANAGER',
      isActive: true,
      managedRegionIds: ['g-khb'],
      teamRegionIds: [],
    },
    {
      id: 's-team',
      fullName: 'Team Supervisor',
      username: 'sup.k',
      role: 'SUPERVISOR',
      isActive: true,
      managedRegionIds: [],
      teamRegionIds: ['g-khb'],
    },
  ],
};

const ALI: EditableRow = {
  id: 'u-ali',
  username: 'c4',
  fullName: 'Ali',
  role: 'SALESMAN',
  isActive: true,
  ownedRouteId: 'r-c4',
  routeCode: 'C4',
  supervisorId: 'm-gt',
  regionIds: [],
  hasPhone: true,
};

function openDialog(row: EditableRow = ALI) {
  render(
    <UsersFeedback editOptions={OPTIONS}>
      <EditAccountButton account={row} />
    </UsersFeedback>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  return screen.getByRole('dialog');
}
const optionTexts = (select: HTMLElement) =>
  [...(select as HTMLSelectElement).options].map((o) => o.textContent);
const sent = () => {
  expect(h.edit).toHaveBeenCalledTimes(1);
  const fd = h.edit.mock.calls[0]![0] as FormData;
  return {
    get: (k: string) => fd.get(k),
    all: (k: string) => fd.getAll(k),
    keys: [...new Set([...fd.keys()])].sort(),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: 'stw', role: 'STEWARD', username: 'data.steward' };
});
afterEach(cleanup);

describe('Edit account — what the dialog offers', () => {
  it('a salesman: his route, the routes that are free or held by a disabled account, and supervisors of the route’s region', () => {
    const dialog = openDialog();
    expect(within(dialog).getByText(/Edit Ali/)).toBeTruthy();
    const route = within(dialog).getByLabelText('Route');
    expect((route as HTMLSelectElement).value).toBe('r-c4');
    expect(optionTexts(route)).toEqual([
      '— Pick a route —',
      'C4 · Ruwi',
      'C5 · Qurum',
      'C6 · Seeb — from Old Salesman (disabled)',
      'K1 · Saham',
    ]);
    // C4 is in MCT: only the MCT Manager.
    expect(optionTexts(within(dialog).getByLabelText('Supervisor'))).toEqual([
      '—',
      'Manager GT (mct-gt) · Manager',
    ]);
    expect(within(dialog).queryByText('Regions')).toBeNull();
  });

  it('another region’s route brings that region’s supervisors, and the sign-in name follows the code', () => {
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText('Route'), { target: { value: 'r-k1' } });
    // The current supervisor stays listed so the select can show him; the server judges him.
    expect(optionTexts(within(dialog).getByLabelText('Supervisor'))).toEqual([
      '—',
      'Manager GT (mct-gt) · Manager',
      'Manager KHB (khaburah) · Manager',
      'Team Supervisor (sup.k)',
    ]);
    const signIn = within(dialog).getByRole('checkbox', {
      name: /Sign in with the route code: c4 becomes k1/,
    });
    expect((signIn as HTMLInputElement).checked).toBe(true);
  });

  it('the leaver’s route says it is taken from his disabled account and retires his sign-in name', () => {
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText('Route'), { target: { value: 'r-c6' } });
    expect(dialog.textContent).toMatch(
      /taken from Old Salesman’s disabled account, and his sign-in name c6 is retired/
    );
  });

  it('a Manager or Accountant: regions instead of route and supervisor; a switched-off region only if he has it', () => {
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'MANAGER' } });
    expect(within(dialog).queryByLabelText('Route')).toBeNull();
    expect(within(dialog).queryByLabelText('Supervisor')).toBeNull();
    const regions = within(dialog).getByRole('group', { name: 'Regions' });
    expect(within(regions).getAllByRole('checkbox')).toHaveLength(2);
    expect(dialog.textContent).toMatch(/A new role signs the person out/);
    cleanup();
    const acc = openDialog({
      ...ALI,
      id: 'u-acc',
      role: 'ACCOUNTANT',
      ownedRouteId: null,
      routeCode: null,
      supervisorId: null,
      regionIds: ['g-old'],
    });
    const boxes = within(within(acc).getByRole('group', { name: 'Regions' })).getAllByRole(
      'checkbox'
    );
    expect(boxes).toHaveLength(3);
    expect(boxes.filter((b) => (b as HTMLInputElement).checked)).toHaveLength(1);
  });

  it('never shows the stored phone number — only that one is on file, and a way to remove it', () => {
    const dialog = openDialog();
    const phone = within(dialog).getByLabelText('Phone') as HTMLInputElement;
    expect(phone.value).toBe('');
    expect(phone.type).toBe('tel');
    expect(phone.placeholder).toMatch(/A number is on file/);
    expect(within(dialog).getByRole('checkbox', { name: 'Remove the phone number' })).toBeTruthy();
    cleanup();
    const none = openDialog({ ...ALI, hasPhone: false });
    expect((within(none).getByLabelText('Phone') as HTMLInputElement).placeholder).toBe(
      'No number on file'
    );
    expect(within(none).queryByRole('checkbox', { name: 'Remove the phone number' })).toBeNull();
  });

  it('Escape and Cancel close it without saving', () => {
    openDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.edit).not.toHaveBeenCalled();
  });
});

describe('Edit account — what it sends and what it says', () => {
  it('moving a salesman onto the leaver’s route: the fields the action reads, and the banner after', async () => {
    h.edit.mockResolvedValue({
      ok: true,
      data: {
        changed: ['username', 'route'],
        username: 'c6',
        notes: [
          "Route C6 was taken from Old Salesman's disabled account, whose sign-in name is now c6.left.20261007.",
        ],
      },
    });
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText('Route'), { target: { value: 'r-c6' } });
    fireEvent.change(within(dialog).getByLabelText('Phone'), {
      target: { value: '+968 9000 0002' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const fd = sent();
    expect(fd.keys).toEqual([
      'ownedRouteId',
      'phone',
      'role',
      'routeSignIn',
      'supervisorId',
      'userId',
    ]);
    expect(fd.get('userId')).toBe('u-ali');
    expect(fd.get('role')).toBe('SALESMAN');
    expect(fd.get('ownedRouteId')).toBe('r-c6');
    expect(fd.get('supervisorId')).toBe('m-gt');
    expect(fd.get('routeSignIn')).toBe('on');
    expect(fd.get('phone')).toBe('+968 9000 0002');
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('Saved "c6": sign-in name, route.');
    expect(banner.textContent).toContain('whose sign-in name is now c6.left.20261007');
  });

  it('unticking the route code keeps the sign-in name', async () => {
    h.edit.mockResolvedValue({ ok: true, data: { changed: ['route'], username: 'c4', notes: [] } });
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText('Route'), { target: { value: 'r-c5' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Sign in with the route code/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.edit).toHaveBeenCalled());
    expect(sent().get('routeSignIn')).toBeNull();
  });

  it('a Manager’s regions go one regionId each, with no route or supervisor; the banner says he signs in again', async () => {
    h.edit.mockResolvedValue({
      ok: true,
      data: { changed: ['role', 'route', 'supervisor', 'regions'], username: 'c4', notes: [] },
    });
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'MANAGER' } });
    const regions = within(dialog).getByRole('group', { name: 'Regions' });
    for (const box of within(regions).getAllByRole('checkbox')) fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Remove the phone number' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const fd = sent();
    expect(fd.all('regionId')).toEqual(['g-khb', 'g-mct']);
    expect(fd.get('ownedRouteId')).toBeNull();
    expect(fd.get('supervisorId')).toBeNull();
    expect(fd.get('clearPhone')).toBe('on');
    expect(screen.getByRole('status').textContent).toMatch(/signed out and sign in again/);
  });

  it('a refusal lands under its field and the dialog stays open', async () => {
    h.edit.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: {
        ownedRouteId: 'Route C7 is worked by Busy Salesman (c7), whose account is active.',
      },
    });
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toMatch(/Busy Salesman/);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a save that changes nothing says so', async () => {
    h.edit.mockResolvedValue({ ok: true, data: { changed: [], username: 'c4', notes: [] } });
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Nothing changed for "c4".Dismiss')
    );
  });
});

describe('Create user — regions, and the route code as the username', () => {
  function renderCreate() {
    return render(
      <CreateUserForm
        viewerRole="STEWARD"
        regions={OPTIONS.regions.filter((g) => g.isActive)}
        supervisors={OPTIONS.supervisors}
        routes={[
          { id: 'r-c5', code: 'C5', name: 'Qurum', regionId: 'g-mct', holder: null },
          {
            id: 'r-c6',
            code: 'C6',
            name: 'Seeb',
            regionId: 'g-mct',
            holder: { fullName: 'Old Salesman', username: 'c6' },
          },
          { id: 'r-k1', code: 'K1', name: 'Saham', regionId: 'g-khb', holder: null },
        ]}
      />
    );
  }
  const roleSelect = (c: HTMLElement) =>
    c.querySelector('select[name="role"]') as HTMLSelectElement;
  const routeSelect = (c: HTMLElement) =>
    c.querySelector('select[name="ownedRouteId"]') as HTMLSelectElement;
  const username = (c: HTMLElement) =>
    c.querySelector('input[name="nmwc-new-account-handle"]') as HTMLInputElement;

  it('a Manager or Accountant is created with regions; other roles get none', () => {
    const { container } = renderCreate();
    expect(container.querySelectorAll('input[name="regionId"]')).toHaveLength(0);
    for (const role of ['MANAGER', 'ACCOUNTANT']) {
      fireEvent.change(roleSelect(container), { target: { value: role } });
      expect(container.querySelectorAll('input[name="regionId"]'), role).toHaveLength(2);
    }
    fireEvent.change(roleSelect(container), { target: { value: 'VIEWER' } });
    expect(container.querySelectorAll('input[name="regionId"]')).toHaveLength(0);
  });

  it('picking a route fills the username with its code, until the Steward types his own', () => {
    const { container } = renderCreate();
    fireEvent.change(routeSelect(container), { target: { value: 'r-c5' } });
    expect(username(container).value).toBe('c5');
    fireEvent.change(routeSelect(container), { target: { value: 'r-k1' } });
    expect(username(container).value).toBe('k1');
    fireEvent.change(username(container), { target: { value: 'custom.name' } });
    fireEvent.change(routeSelect(container), { target: { value: 'r-c5' } });
    expect(username(container).value).toBe('custom.name');
  });

  it('the leaver’s route is offered for the joiner, said to be handed over, with the region’s supervisors', () => {
    const { container } = renderCreate();
    expect(optionTexts(routeSelect(container))).toContain(
      'C6 · Seeb — from Old Salesman (disabled)'
    );
    fireEvent.change(routeSelect(container), { target: { value: 'r-c6' } });
    expect(container.textContent).toMatch(
      /his sign-in name c6 is retired so the new salesman can use it/
    );
    expect(
      optionTexts(container.querySelector('select[name="supervisorId"]') as HTMLElement)
    ).toEqual(['—', 'Manager GT (mct-gt) · Manager']);
  });

  it('what the create says about a hand-over is shown with "User created."', async () => {
    h.create.mockResolvedValue({
      ok: true,
      data: { notes: ["Route C6 was taken from Old Salesman's disabled account."] },
    });
    const { container } = renderCreate();
    fireEvent.submit(container.querySelector('form')!);
    expect(
      await screen.findByText(
        /User created\. Route C6 was taken from Old Salesman's disabled account\./
      )
    ).toBeTruthy();
  });
});

describe('/users — Regions column and the Steward’s Edit', () => {
  const account = (id: string, role: string, over: Record<string, unknown> = {}) => ({
    id,
    username: id,
    fullName: `Person ${id}`,
    role,
    isActive: true,
    lastLoginAt: null,
    mustChangePassword: false,
    email: null,
    phone: null,
    ownedRouteId: null,
    supervisorId: null,
    supervisor: null,
    ownedRoute: null,
    reports: [],
    managedRegions: [],
    ...over,
  });
  beforeEach(() => {
    h.rows = [
      account('stw', 'STEWARD'),
      account('mgr', 'MANAGER', {
        managedRegions: [
          { id: 'g-mct', code: 'MCT' },
          { id: 'g-khb', code: 'KHB' },
        ],
      }),
      account('acc', 'ACCOUNTANT'),
      account('sal', 'SALESMAN', {
        phone: '+96899887766',
        ownedRouteId: 'r-c4',
        ownedRoute: { code: 'C4', name: 'Ruwi', regionId: 'g-mct', region: { code: 'MCT' } },
      }),
    ];
  });

  const regionsCell = (container: HTMLElement, name: string) => {
    const row = [...container.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(name)
    )!;
    return row.querySelectorAll('td')[5]!.textContent;
  };

  it('shows each account’s regions, and says when a Manager or Accountant has none', async () => {
    const { container } = render(await UsersPage({ searchParams: Promise.resolve({}) }));
    expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toContain(
      'Regions'
    );
    expect(regionsCell(container, 'Person mgr')).toBe('KHB, MCT');
    expect(regionsCell(container, 'Person acc')).toBe('None — sees nothing');
    expect(regionsCell(container, 'Person sal')).toBe('MCT');
    expect(regionsCell(container, 'Person stw')).toBe('—');
  });

  it('the Steward gets Edit on every row but his own, and the phone number never reaches the page', async () => {
    const { container } = render(await UsersPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(3);
    expect(container.innerHTML).not.toContain('99887766');
    const salRow = [...container.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes('Person sal')
    )!;
    fireEvent.click(within(salRow as HTMLElement).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/Edit Person sal/);
    expect((within(dialog).getByLabelText('Phone') as HTMLInputElement).placeholder).toMatch(
      /on file/
    );
    expect(document.body.innerHTML).not.toContain('99887766');
  });

  it('a Manager gets no Edit', async () => {
    h.user = { id: 'mgr', role: 'MANAGER', username: 'mct-gt' };
    render(await UsersPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryAllByRole('button', { name: 'Edit' })).toHaveLength(0);
  });
});
