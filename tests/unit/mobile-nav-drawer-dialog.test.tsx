/**
 * Launch browser suite (2026-10-07): the phone menu drawer is a modal dialog.
 *
 * What was wrong (components/nmwc/Sidebar.tsx MobileNavDrawer): the open drawer
 * was a bare <nav> laid over the page. A screen reader was not told that the page
 * behind it was out of reach; focus stayed on the Open menu button and Tab walked
 * on into the page underneath; and tapping the page you were already on left it
 * open, because only a change of address closed it.
 *
 * Driven through the real component (jsdom): open, it is role="dialog",
 * aria-modal, named "Menu", with focus inside; Tab and Shift+Tab go round inside
 * it; the Close button, Escape and any link — the current page's too — close it
 * and put focus back on the Open menu button. The salesman still gets no drawer.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { MouseEvent, ReactNode } from 'react';

const h = vi.hoisted(() => ({ pathname: '/dashboard' }));
vi.mock('next/navigation', () => ({ usePathname: () => h.pathname }));
// The real Link calls its onClick and then navigates; jsdom cannot navigate.
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
    onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        onClick?.(e);
        e.preventDefault();
      }}
    >
      {children}
    </a>
  ),
}));

import { MobileNavDrawer } from '@/components/nmwc/Sidebar';

beforeEach(() => {
  h.pathname = '/dashboard';
});
afterEach(cleanup);

function openDrawer() {
  render(
    <>
      <MobileNavDrawer role="MANAGER" />
      <a href="/behind">A link on the page behind</a>
    </>
  );
  const button = screen.getByRole('button', { name: 'Open menu' });
  fireEvent.click(button);
  return { button, dialog: screen.getByRole('dialog') };
}

const tab = (shiftKey = false) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey });

describe('the phone menu drawer is a modal dialog', () => {
  it('open, it is an aria-modal dialog named Menu holding the menu, with focus inside it', () => {
    const { button, dialog } = openDrawer();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBe(dialog);
    expect(within(dialog).getByRole('navigation')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Dashboard' })).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Tab from the last item goes to the first, and Shift+Tab from the first to the last', () => {
    const { dialog } = openDrawer();
    const close = within(dialog).getByRole('button', { name: 'Close menu' });
    const links = within(dialog).getAllByRole('link');
    const last = links[links.length - 1]!;
    expect(last.textContent).toBe('Change password');

    last.focus();
    tab();
    expect(document.activeElement).toBe(close);
    tab(true);
    expect(document.activeElement).toBe(last);
  });

  it('Tab with focus somehow outside the drawer brings it back inside', () => {
    const { dialog } = openDrawer();
    screen.getByRole('link', { name: 'A link on the page behind' }).focus();
    tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('the Close button closes it and puts focus back on Open menu', () => {
    const { button, dialog } = openDrawer();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape closes it and puts focus back on Open menu', () => {
    const { button } = openDrawer();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('tapping the page you are already on closes it', () => {
    const { button, dialog } = openDrawer();
    fireEvent.click(within(dialog).getByRole('link', { name: 'Dashboard' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('tapping another page closes it too', () => {
    const { dialog } = openDrawer();
    fireEvent.click(within(dialog).getByRole('link', { name: 'Customers' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the tap-outside backdrop closes it, and is not a second "Close menu" to a screen reader or Tab', () => {
    const { button, dialog } = openDrawer();
    expect(screen.getAllByRole('button', { name: 'Close menu' })).toHaveLength(1);
    const backdrop = dialog.previousElementSibling as HTMLElement;
    expect(backdrop.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('the salesman still gets no drawer: his phone has the tab bar', () => {
    render(<MobileNavDrawer role="SALESMAN" />);
    expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull();
  });
});
