/**
 * Launch review, a shared or lost phone: Sign out left every form copy the
 * enrichment and new-customer forms keep in localStorage — customer names,
 * phones, contacts — for the next person on the phone to read. Sign out now
 * deletes the signing-out user's own copies first (lib/device-drafts.ts,
 * components/nmwc/SignOutButton.tsx), asks before deleting unsent work, and
 * leaves another user's copies and every other key alone; neither form on
 * screen writes its copy back while the sign-out is on its way. Driven through
 * the real button, the real TopBar and the real forms (jsdom).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock('@/app/actions/auth', () => ({ logoutAction: h.logout }));
vi.mock('@/components/nmwc/Sidebar', () => ({ MobileNavDrawer: () => null }));
// For the two forms rendered at the end.
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/nmwc/PhotoCaptureSlot', () => ({ PhotoCaptureSlot: () => null }));
vi.mock('@/lib/navigate', () => ({ hardReplace: vi.fn() }));

import { SignOutButton, signOutDraftsQuestion } from '@/components/nmwc/SignOutButton';
import { TopBar } from '@/components/nmwc/TopBar';
import { DEVICE_DRAFT_PREFIXES, clearDeviceDrafts, countDeviceDrafts } from '@/lib/device-drafts';
import { EnrichmentForm } from '@/app/(app)/customers/[id]/edit/EnrichmentForm';
import { CreateCustomerForm } from '@/app/(app)/customers/new/CreateCustomerForm';

const MINE = ['nmwc:draft:u1:cust-a', 'nmwc:draft:u1:cust-b', 'nmwc:create:u1:new', 'nmwc:create:u1:edit-7'];
// Another user's copies on a shared phone, a user id that merely starts with
// "u1", and keys that are not form copies.
const KEPT = ['nmwc:draft:u2:cust-a', 'nmwc:create:u2:new', 'nmwc:draft:u10:cust-a', 'nmwc:sidebar', 'other'];

function seed() {
  for (const k of [...MINE, ...KEPT]) localStorage.setItem(k, '{"primaryPhone":"+96891234567"}');
}
const stored = () => Object.keys(localStorage).sort();

beforeEach(() => {
  localStorage.clear();
  h.logout.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Sign out deletes the signing-out user’s form copies from the phone', () => {
  it('asks first, then deletes exactly his copies and signs out', async () => {
    seed();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SignOutButton userId="u1" className="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(confirm).toHaveBeenCalledWith(signOutDraftsQuestion(4));
    expect(stored()).toEqual([...KEPT].sort());
    await waitFor(() => expect(h.logout).toHaveBeenCalledTimes(1));
  });

  it('kept signed in, and every copy kept, when he says no', async () => {
    seed();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SignOutButton userId="u1" className="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(stored()).toEqual([...MINE, ...KEPT].sort());
    await new Promise((r) => setTimeout(r, 20));
    expect(h.logout).not.toHaveBeenCalled();
  });

  it('nothing to lose: no question, straight out', async () => {
    localStorage.setItem('nmwc:draft:u2:cust-a', '{}');
    const confirm = vi.spyOn(window, 'confirm');
    render(<SignOutButton userId="u1" className="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(stored()).toEqual(['nmwc:draft:u2:cust-a']);
    await waitFor(() => expect(h.logout).toHaveBeenCalledTimes(1));
  });

  it('the TopBar button deletes the signed-in user’s copies', async () => {
    seed();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<TopBar user={{ id: 'u2', fullName: 'Second', username: 'c5', role: 'SALESMAN' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(stored()).toEqual(
      [...MINE, ...KEPT.filter((k) => !k.startsWith('nmwc:draft:u2:') && !k.startsWith('nmwc:create:u2:'))].sort()
    );
    await waitFor(() => expect(h.logout).toHaveBeenCalledTimes(1));
  });

  it('a browser that refuses storage still signs out', async () => {
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(countDeviceDrafts('u1')).toBe(0);
    expect(clearDeviceDrafts('u1')).toBe(0);
    render(<SignOutButton userId="u1" className="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(h.logout).toHaveBeenCalledTimes(1));
  });

  it('an empty user id matches nothing', () => {
    seed();
    expect(clearDeviceDrafts('')).toBe(0);
    expect(stored()).toEqual([...MINE, ...KEPT].sort());
  });

  it('the prefixes are the ones the two forms write', () => {
    // A form that renamed its key would keep its copies past Sign out again.
    const enrich = readFileSync('app/(app)/customers/[id]/edit/EnrichmentForm.tsx', 'utf8');
    const create = readFileSync('app/(app)/customers/new/CreateCustomerForm.tsx', 'utf8');
    expect(DEVICE_DRAFT_PREFIXES).toEqual(['nmwc:draft:', 'nmwc:create:']);
    expect(enrich).toContain('const draftKey = `nmwc:draft:${sessionUserId}:${customer.id}`;');
    expect(create).toContain("const draftKey = `nmwc:create:${sessionUserId}:${editId ?? 'new'}`;");
  });
});

describe('a form on screen does not write its copy back while Sign out is on its way', () => {
  // logoutAction is a round trip, and the form stays on screen until the sign-in
  // page loads. Its 500 ms autosave, already due when Sign out was tapped, or
  // set off by a change in that time, wrote the copy straight back.
  const customer = {
    id: 'cust-a', nmwcCode: 'SYNTHETIC', legalName: 'Synthetic customer',
    paymentTerms: 'CASH' as const, crNumber: null, channelId: null, subChannelId: null,
    primaryPhone: '+96890000000', altPhone: null, contactPerson: 'Synthetic contact', contactRole: null,
    status: 'ACTIVE' as const, notes: null, crPhotoId: null,
    branches: [{
      id: 'synthetic-branch', branchName: 'Synthetic branch', address: 'Synthetic address', areaDescription: null,
      gpsLat: 23.5, gpsLng: 58.3, gpsAccuracy: 5, gpsCapturedAt: new Date('2026-01-01T00:00:00Z'),
      dayOfVisit: 'SUN' as const, openingHours: null, deliveryWindow: null,
      coolersCount: 0, standsCount: 0, emptyBottlesCount: 0, equipmentConfirmed: false,
      status: 'ACTIVE' as const, shopPhotoId: 'synthetic-photo', signboardPhotoId: null,
      region: { name: 'Synthetic region' }, route: { code: 'SYNTHETIC' },
    }],
  };
  const tick = (ms = 500) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const signOut = () => fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('the enrichment form', async () => {
    const key = 'nmwc:draft:u1:cust-a';
    render(
      <>
        <EnrichmentForm customer={customer} channels={[]} lockName={false} lockCr={false}
          userRole="SALESMAN" canSubmit sessionUserId="u1" gate="CORE" />
        <SignOutButton userId="u1" className="" />
      </>
    );
    const notes = () => screen.getByLabelText(/Notes/);
    fireEvent.change(notes(), { target: { value: 'Typed before Sign out' } });
    await tick();
    expect(JSON.parse(localStorage.getItem(key)!).notes).toBe('Typed before Sign out');

    fireEvent.change(notes(), { target: { value: 'Typed just before Sign out' } });
    signOut();
    expect(localStorage.getItem(key)).toBeNull();
    await tick(); // the autosave that was due
    expect(localStorage.getItem(key)).toBeNull();
    fireEvent.change(notes(), { target: { value: 'Typed while signing out' } });
    await tick(2000);
    expect(localStorage.getItem(key)).toBeNull();
    expect(h.logout).toHaveBeenCalledTimes(1);
  });

  it('the new-customer form', async () => {
    const key = 'nmwc:create:u1:new';
    render(
      <>
        <CreateCustomerForm channels={[]} initial={null} sessionUserId="u1" />
        <SignOutButton userId="u1" className="" />
      </>
    );
    const name = () => screen.getByLabelText('Legal name *');
    fireEvent.change(name(), { target: { value: 'Synthetic Trading' } });
    await tick();
    expect(JSON.parse(localStorage.getItem(key)!).legalName).toBe('Synthetic Trading');

    fireEvent.change(name(), { target: { value: 'Synthetic Trading LLC' } });
    signOut();
    expect(localStorage.getItem(key)).toBeNull();
    await tick();
    expect(localStorage.getItem(key)).toBeNull();
    fireEvent.change(name(), { target: { value: 'Synthetic Trading LLC (Ruwi)' } });
    await tick(2000);
    expect(localStorage.getItem(key)).toBeNull();
    expect(h.logout).toHaveBeenCalledTimes(1);
  });

  it('a form opened afterwards keeps its copy as before', async () => {
    const key = 'nmwc:create:u1:new';
    const first = render(<SignOutButton userId="u1" className="" />);
    signOut();
    first.unmount();
    render(<CreateCustomerForm channels={[]} initial={null} sessionUserId="u1" />);
    fireEvent.change(screen.getByLabelText('Legal name *'), { target: { value: 'Next sign-in' } });
    await tick();
    expect(JSON.parse(localStorage.getItem(key)!).legalName).toBe('Next sign-in');
  });
});
