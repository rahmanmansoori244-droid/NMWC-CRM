/**
 * Benchmark item 40b: Call and Directions on the customer cards of the Today and
 * Customers lists. The owner said yes, for all roles.
 *
 * The card is one big link to the profile, and an <a> inside an <a> is invalid
 * HTML that React 19 reports as a hydration error — so these tests pin that the
 * chips are the link's SIBLINGS, that the profile link is still first and still
 * named exactly as the go-live walk finds it, and that the Today list sends each
 * card's Directions to that card's own branch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CustomerCard } from '@/components/nmwc/CustomerCard';
import { directionsHref } from '@/lib/contact-links';

const db = vi.hoisted(() => ({ branches: [] as unknown[] }));

// Forwards aria-label: the card's accessible name IS the thing under test.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u-s', role: 'SALESMAN', username: 'c4' } }) }));
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUniqueOrThrow: async () => ({ id: 'u-s', fullName: 'Salesman', ownedRouteId: 'r1' }) },
    customerEdit: { count: async () => 0 },
    branch: { findMany: async () => db.branches, count: async () => db.branches.length },
  },
}));

afterEach(cleanup);

const customer = {
  id: 'c1',
  nmwcCode: 'NMWC-018702',
  legalName: 'Al Maha Foodstuff',
  paymentTerms: 'CASH' as const,
  status: 'ACTIVE' as const,
  completenessScore: 60,
  primaryPhone: '+968 9555 1234',
};
const branch = { branchName: 'Main', address: 'Way 3021, Al Khuwair', gpsLat: 23.5881, gpsLng: 58.3829 };

describe('40b — CustomerCard: Call and Directions beside the profile link', () => {
  it('keeps the profile link first and named as before, with the chips outside it', () => {
    const { container } = render(<CustomerCard customer={customer} primaryBranch={branch} href="/customers/c1" />);
    const links = screen.getAllByRole('link');
    expect(links[0]!.getAttribute('aria-label')).toBe('Al Maha Foodstuff · NMWC-018702');
    expect(links[0]!.getAttribute('href')).toBe('/customers/c1');
    // No link inside another link.
    expect(container.querySelectorAll('a a')).toHaveLength(0);
    expect(links).toHaveLength(3);
  });

  it('dials the E.164 number while showing the stored value, and routes to the branch', () => {
    render(<CustomerCard customer={customer} primaryBranch={branch} href="/customers/c1" />);
    const call = screen.getByRole('link', { name: '+968 9555 1234' });
    expect(call.getAttribute('href')).toBe('tel:+96895551234');
    expect(call.getAttribute('target')).toBeNull();
    const directions = screen.getByRole('link', { name: 'Directions' });
    expect(directions.getAttribute('href')).toBe(directionsHref(23.5881, 58.3829));
    expect(directions.getAttribute('rel')).toBe('noopener noreferrer');
    for (const chip of [call, directions]) {
      // 44px: tapped one-handed on a phone.
      expect(chip.className.split(/\s+/)).toContain('min-h-[44px]');
      // Sentry records a clicked element's name; a customer name must not be in it.
      expect(chip.textContent).not.toContain('Al Maha');
      expect(chip.getAttribute('aria-label')).toBeNull();
    }
  });

  it('shows only what can be used: no strip at all without a dialable phone or a real point', () => {
    const { container } = render(
      <CustomerCard
        customer={{ ...customer, primaryPhone: 'ask the owner' }}
        primaryBranch={{ ...branch, gpsLat: null, gpsLng: null }}
        href="/customers/c1"
      />
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(container.textContent).not.toContain('ask the owner');
    expect(container.querySelector('.pb-4')).toBeNull();
  });

  it('drops an undialable phone even when there is a Directions chip to show', () => {
    const { container } = render(
      <CustomerCard customer={{ ...customer, primaryPhone: 'ask the owner' }} primaryBranch={branch} href="/customers/c1" />
    );
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([
      expect.stringContaining('Al Maha'),
      'Directions',
    ]);
    expect(container.textContent).not.toContain('ask the owner');
  });

  it('marks keyboard focus only, and lifts only over the profile link', () => {
    const { container } = render(<CustomerCard customer={customer} primaryBranch={branch} href="/customers/c1" />);
    const cls = container.querySelector('article')!.className.split(/\s+/);
    // focus-within also matched a tapped chip and left the ring lit behind the dialer.
    expect(cls).toContain('has-[:focus-visible]:ring-brand-500');
    expect(cls).toContain('has-[>a:hover]:shadow-md');
    expect(cls.filter((c) => /^(focus-within|hover):/.test(c))).toEqual([]);
  });

  it('shows Call alone, or Directions alone, when that is all there is', () => {
    render(<CustomerCard customer={customer} primaryBranch={{ ...branch, gpsLat: null }} href="/customers/c1" />);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([
      expect.stringContaining('Al Maha'),
      '+968 9555 1234',
    ]);
    cleanup();
    render(<CustomerCard customer={{ ...customer, primaryPhone: null }} primaryBranch={branch} href="/customers/c1" />);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([
      expect.stringContaining('Al Maha'),
      'Directions',
    ]);
  });

  it('keeps the chips when the card has no link', () => {
    const { container } = render(<CustomerCard customer={customer} primaryBranch={branch} />);
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['+968 9555 1234', 'Directions']);
    expect(container.querySelector('a[aria-label]')).toBeNull();
  });
});

describe('40b — the Today list, rendered', () => {
  it("sends each card's Directions to that card's own branch, and calls the customer", async () => {
    // Two branches of one customer on today's route: same phone, different places.
    const c = { id: 'c1', nmwcCode: 'NMWC-018702', legalName: 'Al Maha Foodstuff', paymentTerms: 'CASH', status: 'ACTIVE', completenessScore: 60, primaryPhone: '96895551234' };
    db.branches = [
      { id: 'b1', branchName: 'Khuwair', address: 'Al Khuwair', gpsLat: 23.5881, gpsLng: 58.3829, customer: c },
      { id: 'b2', branchName: 'Seeb', address: 'Seeb souq', gpsLat: 23.67, gpsLng: 58.19, customer: c },
    ];
    const { default: TodayPage } = await import('@/app/(app)/today/page');
    const { container } = render(await TodayPage());
    const cards = [...container.querySelectorAll('article')];
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => within(card as HTMLElement).getByRole('link', { name: 'Directions' }).getAttribute('href'))).toEqual([
      directionsHref(23.5881, 58.3829),
      directionsHref(23.67, 58.19),
    ]);
    for (const card of cards) {
      expect(within(card as HTMLElement).getByRole('link', { name: '96895551234' }).getAttribute('href')).toBe('tel:+96895551234');
    }
    expect(container.querySelectorAll('a a')).toHaveLength(0);
  });
});
