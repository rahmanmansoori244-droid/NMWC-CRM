'use client';

import type { ReactNode } from 'react';

/**
 * Launch fix (2026-10-09): React error #418 on a full load of a menu page,
 * followed by dozens of "Cannot read properties of null (reading 'parentNode')".
 *
 * WHAT HAPPENED. app/(app)/layout.tsx put the page slot ({children}) straight
 * inside a <div>. In the page data Next sends, that slot is Next's router element,
 * and one of its props is app/(app)/error.tsx, a client component in a script of
 * its own. Until that script has loaded, React's data reader hands the slot over
 * as a "lazy" placeholder. On a busy phone or a cold cache React can start
 * hydrating before the script is in, so the <div> suspends on that placeholder.
 * When the script lands a moment later, Next's own copy of React
 * (19.2.0-canary-0bdb9206-20250818) replays the <div> and claims a DOM node for
 * it a second time, from where its hydration cursor now stands: inside the div,
 * on the loading skeleton's <!--$?--> marker. That cannot match, so React throws
 * #418 (args[]=HTML) outside any Suspense boundary, throws away the server's
 * page and renders the whole document again on the client. The body is cleared,
 * so every later streamed "$RS" script finds its placeholder gone: the
 * parentNode errors.
 *
 * React 19.3 fixed the replay (replaySuspendedUnitOfWork puts the cursor back on
 * the element before it claims again); Next 15.5 does not ship it.
 *
 * THE FIX. A component between the <div> and the slot. Now the component, not the
 * <div>, is what suspends and is replayed, and a component claims no DOM node,
 * so the replay is harmless. It must be a client component: a server component
 * would leave nothing between the two in the page data. It renders nothing of its
 * own. tests/unit/route-slot.test.tsx shows the bug on Next's React, the fix, and
 * that the layout keeps the slot inside RouteSlot.
 */
export function RouteSlot({ children }: { children: ReactNode }) {
  return children;
}
