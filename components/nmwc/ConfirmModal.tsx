'use client';

import { useEffect, useRef } from 'react';

/**
 * B-14: Accessible confirm modal that replaces window.confirm() for
 * destructive / consequential actions (Approve, Reactivate, etc.).
 *
 * Behavior:
 *  - Backdrop dims content behind a centered card.
 *  - Esc cancels, Enter confirms while focus is inside the modal.
 *  - On open, focus is moved to the confirm button. A simple focus
 *    trap keeps Tab cycling between Cancel and Confirm.
 *  - Body scroll is locked while the modal is open so a long approval
 *    queue doesn't scroll behind the dialog on mobile.
 */
export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  confirmTone = 'primary',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmTone?: 'primary' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Move focus to the confirm button on open. Restore body scroll on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  // Esc cancels, Enter confirms (while focus is inside the modal).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
        return;
      }
      // Simple two-element focus trap.
      if (e.key === 'Tab') {
        const cancel = cancelRef.current;
        const confirm = confirmRef.current;
        if (!cancel || !confirm) return;
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === cancel) {
            e.preventDefault();
            confirm.focus();
          }
        } else {
          if (active === confirm) {
            e.preventDefault();
            cancel.focus();
          }
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  const confirmClass =
    confirmTone === 'danger'
      ? 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-500'
      : 'bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-500';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      aria-describedby="confirm-modal-message"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop — clicking it cancels (same as Esc). */}
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onCancel}
        className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
        tabIndex={-1}
      />
      <div
        className="relative z-10 w-full max-w-md rounded-lg bg-white p-6 shadow-xl ring-1 ring-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="confirm-modal-title"
          className="text-base font-semibold text-slate-900"
        >
          {title}
        </h2>
        <p
          id="confirm-modal-message"
          className="mt-2 text-sm text-slate-600"
        >
          {message}
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`rounded-md px-4 py-2.5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
