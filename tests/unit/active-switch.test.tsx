/**
 * Code review 2026-11-10, finding 9: Disable / Enable on /users and /routes was a
 * blind flip. Each click now sends the state it wants (lib/active-switch.ts), and
 * what the screen says is built from the server's answer.
 *
 * The services are proved in tests/unit/admin-audit-atomic.test.ts (accounts)
 * and tests/unit/region-route-toggle.test.tsx (regions and routes); this file
 * proves the shared parsing, the wording, and the /routes button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ region: vi.fn(), route: vi.fn() }));
vi.mock('@/services/routes', () => ({
  createRegionAction: vi.fn(),
  createRouteAction: vi.fn(),
  toggleRegionActiveAction: h.region,
  toggleRouteActiveAction: h.route,
}));

import { ACTIVE_FIELD, placeSwitchMessage, userSwitchMessage, wantedActive } from '@/lib/active-switch';
import { ToggleButton } from '@/app/(app)/routes/forms';

const fd = (v?: string) => {
  const f = new FormData();
  if (v !== undefined) f.set(ACTIVE_FIELD, v);
  return f;
};

describe('wantedActive: only "true" or "false", never a guess', () => {
  it('reads the two values', () => {
    expect(wantedActive(fd('true'))).toBe(true);
    expect(wantedActive(fd('false'))).toBe(false);
  });
  it.each([undefined, '', 'on', '1', '0', 'TRUE', 'False', ' true'])('%s is no answer', (v) => {
    expect(wantedActive(fd(v))).toBeNull();
  });
});

describe('the words come from the server’s answer', () => {
  it('accounts', () => {
    expect(userSwitchMessage('c4', { isActive: false, changed: true })).toBe(
      'Disabled "c4". It is on the Disabled tab, where Enable puts it back.'
    );
    expect(userSwitchMessage('c4', { isActive: true, changed: true })).toBe('Enabled "c4".');
    expect(userSwitchMessage('c4', { isActive: false, changed: false })).toBe(
      '"c4" was already disabled. Nothing changed. It is on the Disabled tab.'
    );
    expect(userSwitchMessage('c4', { isActive: true, changed: false })).toBe('"c4" was already enabled. Nothing changed.');
  });
  it('regions and routes', () => {
    expect(placeSwitchMessage('route', { isActive: false, changed: false })).toBe(
      'This route was already disabled. Nothing changed.'
    );
    expect(placeSwitchMessage('region', { isActive: true, changed: false })).toBe(
      'This region was already enabled. Nothing changed.'
    );
    expect(placeSwitchMessage('route', { isActive: true, changed: true })).toBe('The route is now enabled.');
  });
});

describe('the /routes switch button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'alert').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('Disable on a route sends active=false; a real change says nothing more (the list refreshes)', async () => {
    h.route.mockResolvedValue({ ok: true, data: { isActive: false, changed: true } });
    render(<ToggleButton id="r1" kind="route" isActive />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(h.route).toHaveBeenCalledTimes(1));
    const sent = h.route.mock.calls[0]![0] as FormData;
    expect([sent.get('id'), sent.get(ACTIVE_FIELD)]).toEqual(['r1', 'false']);
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('Enable on a stale region row that someone already enabled: told "already enabled"', async () => {
    h.region.mockResolvedValue({ ok: true, data: { isActive: true, changed: false } });
    render(<ToggleButton id="g1" kind="region" isActive={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('This region was already enabled. Nothing changed.'));
    expect((h.region.mock.calls[0]![0] as FormData).get(ACTIVE_FIELD)).toBe('true');
  });

  // Code review 2026-11-10, finding 9, second round: a tab still running the code
  // from before the deploy sends no wanted state, and the alert says to reload.
  // Third round: proved through the real action in
  // tests/unit/region-route-toggle.test.tsx; a test here, with the action mocked
  // to return the message, passed on the old code too.

  it('a refusal is still shown as before', async () => {
    h.route.mockResolvedValue({ ok: false, code: 'FORBIDDEN', message: 'That region is not one you manage.' });
    render(<ToggleButton id="r1" kind="route" isActive />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('That region is not one you manage.'));
  });
});
