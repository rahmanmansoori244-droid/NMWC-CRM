/**
 * Launch review, a shared or lost phone: Sign out left every form copy the
 * enrichment and new-customer forms keep in localStorage — customer names,
 * phones, contacts — for the next person on the phone to read. Sign out now
 * deletes the signing-out user's own copies first (lib/device-drafts.ts,
 * components/nmwc/SignOutButton.tsx), asks before deleting unsent work, and
 * leaves another user's copies and every other key alone. Driven through the
 * real button and the real TopBar (jsdom).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock('@/app/actions/auth', () => ({ logoutAction: h.logout }));
vi.mock('@/components/nmwc/Sidebar', () => ({ MobileNavDrawer: () => null }));

import { SignOutButton, signOutDraftsQuestion } from '@/components/nmwc/SignOutButton';
import { TopBar } from '@/components/nmwc/TopBar';
import { DEVICE_DRAFT_PREFIXES, clearDeviceDrafts, countDeviceDrafts } from '@/lib/device-drafts';

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
