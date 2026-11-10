'use client';

/**
 * Leaving a form with unsent work on it (code review 2026-11-10, finding 4).
 *
 * The new-customer form and the signed-application upload were left by accident:
 * a pull down at the top of the page reloaded it, a tap meant for Submit hit the
 * bottom bar, a link was tapped. The form keeps a copy on the phone and brings it
 * back (lib/create-draft.ts), but a photo still uploading is cut off, and the
 * salesman is somewhere he did not mean to go. So, while there is unsent work:
 *   - a reload or closing the tab asks first (the browser's own "Leave site?");
 *   - a tap on a link to another page of the app asks first, in the app's words;
 *   - pulling down at the top of the page does not reload it.
 *
 * The Back gesture is not trapped: holding a history entry for it would break
 * the form's own `history.replaceState` to its saved address and the rule that
 * Back never returns to a sent form (lib/navigate.ts). Back loses nothing but a
 * photo still uploading — the forms write their copy when the page is hidden or
 * goes.
 */
import { useEffect, useRef } from 'react';
import { onSignOut } from './device-drafts';

export const LEAVE_FORM_QUESTION =
  'Leave this form? What you entered is kept on this phone and comes back when you open it again. A photo that is still uploading will be lost.';

/** When the phone could not keep the copy (storage full or blocked): leaving loses it. */
export const LEAVE_FORM_LOST_QUESTION = 'Leave this form? What you entered will be lost.';

/** On <html> while a guarded form is open: app/globals.css switches pull-to-refresh off for it. */
export const NO_PULL_REFRESH_CLASS = 'nmwc-no-pull-refresh';

const ALLOW_LEAVE = 'nmwc:allow-leave';

/**
 * The page is leaving on purpose — a submit that arrived, a withdraw, the
 * redirect to a draft that landed (lib/navigate.ts hardReplace calls this): no
 * form asks. A form that is still there afterwards asks again from its next
 * unsent change.
 */
export function allowLeave(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(ALLOW_LEAVE));
}

/**
 * While `active`: the browser asks before a reload or close, and a tap on a
 * same-origin link to another page asks `question` first. Released by
 * allowLeave() and by Sign out (which has asked its own question); armed again
 * the next time `active` turns on.
 */
export function useLeaveGuard(active: boolean, question: string = LEAVE_FORM_QUESTION): void {
  const questionRef = useRef(question);
  questionRef.current = question;

  useEffect(() => {
    if (!active) return;
    let released = false;
    const release = () => {
      released = true;
    };

    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (released) return;
      // Both, for every browser: the standard way and the one older ones read.
      e.preventDefault();
      e.returnValue = '';
    };

    // In the capture phase on the window, so it runs before the link's own
    // handler (next/link navigates from a click handler further down).
    const click = (e: MouseEvent) => {
      if (released || e.defaultPrevented) return;
      // Only a plain tap navigates here: a middle click or a modified one opens elsewhere.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as Element | null;
      const link = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
      if (!link) return;
      const opensIn = link.getAttribute('target');
      if ((opensIn && opensIn !== '_self') || link.hasAttribute('download')) return;
      let to: URL;
      try {
        to = new URL(link.getAttribute('href') ?? '', window.location.href);
      } catch {
        return;
      }
      if (to.origin !== window.location.origin) return;
      // The same page (a #fragment, or the page itself): nothing is left.
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;
      if (window.confirm(questionRef.current)) {
        // He chose to go: a link that loads a document must not ask a second time.
        release();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('click', click, true);
    window.addEventListener(ALLOW_LEAVE, release);
    const offSignOut = onSignOut(release);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('click', click, true);
      window.removeEventListener(ALLOW_LEAVE, release);
      offSignOut();
    };
  }, [active]);
}

/** How many open forms want pull-to-refresh off: the class goes when the last one does. */
let holders = 0;

/**
 * While `active`, pulling down at the top of the page does not reload it
 * (overscroll-behavior on the root scroller, app/globals.css). Counted, because
 * two guarded forms share the new-customer page.
 */
export function useNoPullToRefresh(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    holders += 1;
    document.documentElement.classList.add(NO_PULL_REFRESH_CLASS);
    return () => {
      holders = Math.max(0, holders - 1);
      if (holders === 0) document.documentElement.classList.remove(NO_PULL_REFRESH_CLASS);
    };
  }, [active]);
}
