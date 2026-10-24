/**
 * ConfirmModal's keyboard (B-14, and the back-office accessibility pass).
 *
 * Its document-level Enter handler confirmed whatever had focus: an approver who
 * tabbed to Cancel and pressed Enter approved the request (or reactivated the
 * shop, or marked the Temix batch loaded). On Cancel, Enter is now Cancel — the
 * button's own click — and on Confirm it still confirms. Escape cancels from
 * anywhere; focus starts on Confirm, stays between the two buttons, and returns
 * to what had it before the dialog opened.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { ConfirmModal } from '@/components/nmwc/ConfirmModal';

afterEach(cleanup);

function Harness({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <ConfirmModal
        open={open}
        title="Approve this edit?"
        message="Changes will go live on the customer immediately."
        confirmLabel="Approve"
        onConfirm={() => {
          onConfirm();
          setOpen(false);
        }}
        onCancel={() => {
          onCancel();
          setOpen(false);
        }}
      />
    </>
  );
}

/** What a browser does with Enter on a focused button: keydown, then (not prevented) the click. */
function pressEnterOn(el: HTMLElement) {
  const notPrevented = fireEvent.keyDown(el, { key: 'Enter' });
  if (notPrevented) fireEvent.click(el);
}

function openIt() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<Harness onConfirm={onConfirm} onCancel={onCancel} />);
  const opener = screen.getByRole('button', { name: 'Open' });
  opener.focus();
  fireEvent.click(opener);
  return { onConfirm, onCancel, opener };
}

describe('ConfirmModal keyboard', () => {
  it('focus starts on Confirm, and Enter there confirms', () => {
    const { onConfirm, onCancel } = openIt();
    const confirm = screen.getByRole('button', { name: 'Approve' });
    expect(document.activeElement).toBe(confirm);
    pressEnterOn(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Enter on Cancel cancels, and does not confirm', () => {
    const { onConfirm, onCancel, opener } = openIt();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    // Tab from Confirm wraps to Cancel (the two-button trap).
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    pressEnterOn(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Focus goes back to what opened it.
    expect(document.activeElement).toBe(opener);
  });

  it('Escape cancels from anywhere in it', () => {
    const { onConfirm, onCancel } = openIt();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('the confirm button is white on emerald-700 (4.5:1 and over), not emerald-600', () => {
    openIt();
    const cls = screen.getByRole('button', { name: 'Approve' }).className.split(/\s+/);
    expect(cls).toContain('bg-emerald-700');
    expect(cls).not.toContain('bg-emerald-600');
  });
});
