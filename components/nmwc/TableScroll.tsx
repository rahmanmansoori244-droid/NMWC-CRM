/**
 * The one way a table is placed on a page (benchmark item 38).
 *
 * Every table in the app sat in an `overflow-hidden` card, and on a phone that
 * failed two ways. Where the card was a grid item (Users) it CLIPPED the table:
 * the row actions were unreachable, on desktop at 1280px too. Everywhere else the
 * table's width propagated up through app/(app)/layout.tsx's `flex-1` column, so
 * the whole PAGE panned sideways — header and filters sliding off-screen — while
 * the table's own box never scrolled. Temix already used `overflow-x-auto` and
 * panned the page anyway, for the same second reason.
 *
 *   overflow-x-auto          the table scrolls inside its own box
 *   [contain:inline-size]    its width stops propagating to the layout column —
 *                            the part `overflow-x-auto` alone does not do
 *   w-full                   without it a flex-row parent collapses the
 *                            size-contained box to zero width
 *
 * Deliberately NOT fixed by adding `min-w-0` to the layout column instead: measured,
 * that turned the panning pages into clipped ones and hid values on the approval
 * review. The fix stays local to the tables.
 *
 * No 'use client': server pages render it. role/aria-label/tabIndex let a keyboard
 * user focus the region and scroll it with the arrow keys.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Callers pass the card styling (rounded, ring, shadow). Any overflow-* they pass
 * is DROPPED rather than merged: tailwind-merge treats `overflow-hidden` and
 * `overflow-x-auto` as different groups and keeps both, which is how every card
 * here clipped its table in the first place.
 */
export const TABLE_SCROLL_CLASSES = 'w-full overflow-x-auto [contain:inline-size]';

const withoutOverflow = (className?: string) =>
  className
    ?.split(/\s+/)
    .filter((c) => !/^(?:[\w-]+:)*overflow-/.test(c))
    .join(' ');

export function TableScroll({
  label,
  className,
  children,
}: {
  /** Names the scroll region for assistive technology, e.g. "Accounts". */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(withoutOverflow(className), TABLE_SCROLL_CLASSES)}
    >
      {children}
    </div>
  );
}
