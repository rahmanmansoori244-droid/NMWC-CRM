'use client';

import { useEffect, useRef, type RefObject } from 'react';

/** What a keyboard can land on inside a dialog (disabled controls and tabIndex -1 excluded). */
const FOCUSABLE =
  'button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard behaviour for a dialog that is mounted while open (rendered
 * conditionally): the pattern of BulkApprovalQueue's RejectModal, shared.
 *
 *  - On mount, focus moves to `initialFocus` when given, else to the first
 *    focusable element inside `dialogRef`.
 *  - Tab and Shift+Tab stay inside the dialog. The focusable list is re-queried
 *    on every keypress, not cached: a button that turns disabled while the user
 *    types would otherwise receive focus it cannot take. Focus that is outside
 *    the dialog (a click on its padding leaves it on <body>) is pulled back in.
 *  - Escape calls `onClose` (when given).
 *  - On unmount, focus goes back to whatever had it before the dialog opened.
 */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  { onClose, initialFocus }: { onClose?: () => void; initialFocus?: RefObject<HTMLElement | null> } = {}
): void {
  // The latest onClose without re-running the mount effect (which would steal focus back).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const first = initialFocus?.current ?? dialog?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
    first?.focus();

    function onKey(e: KeyboardEvent) {
      const root = dialogRef.current;
      if (e.key === 'Escape') {
        if (!onCloseRef.current) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex !== -1);
      if (focusable.length === 0) return;
      const head = focusable[0]!;
      const tail = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (!active || !root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? tail : head).focus();
        return;
      }
      if (e.shiftKey && active === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && active === tail) {
        e.preventDefault();
        head.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Only when it is still on the page (a row that re-rendered away has nowhere to take it).
      if (previous && previous.isConnected) previous.focus();
    };
    // Mount-only: the dialog is rendered while open, so mounting is the moment it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
