'use client';

/**
 * The only way a printout is printed with its content (owner decisions
 * 2026-10-11, part C): the print is recorded first (services/prints.ts writes the
 * PRINT audit row), and only an ok answer opens the browser's print dialog.
 *
 * The sheet prints only while <html data-print-ok> is set (app/(print)/print.css).
 * This button sets it just before window.print(), for that one print only
 * (allowOnePrint): the browser's afterprint clears it, and so does a timer when
 * no afterprint comes. So every print needs its own row: Ctrl+P, or the browser
 * menu, on the page prints a notice instead of the form.
 *
 * What a PRINT row is: a deliberate request to print this printout, recorded
 * before the dialog opens. It does not stop a copy — the page is on screen, and
 * a screenshot, a saved page or a removed stylesheet copy it with no row
 * (AUDITOR-BRIEF "Printouts").
 *
 * Every photo and document must be in first: a page that printed with a hole
 * where the ID card should be would look complete to whoever files it. The button
 * waits while any is still loading (PrintImage retries one the photo route's
 * burst limit turned away), then decodes them; one that failed for good stops the
 * print, with the count, before anything is recorded.
 */
import { useState } from 'react';
import { recordPrintAction } from '@/services/prints';
import type { Printout } from '@/lib/print';

const NOT_RECORDED = 'This print could not be recorded, so it was not started.';
/** Longer than PrintImage's last retry (about a minute after the first failure). */
const IMAGES_WAIT_MS = 90_000;

/**
 * How long the browser has to open its print dialog (beforeprint) after the
 * button's window.print(). The call comes after two awaits (the photos, then
 * the record), so the click's user activation may have expired, and a browser
 * may ignore it: then no dialog opens, no afterprint ever comes, and without
 * this the permission stayed on the page until it was reloaded (review,
 * 2026-10-11).
 */
export const PRINT_DIALOG_OPEN_MS = 10_000;
/**
 * The longest one print keeps its permission once its dialog opened. Desktop
 * browsers end it sooner with afterprint; iOS Safari may never fire afterprint
 * (unverified on a real device: 04-PENDING A8), and this bounds it there.
 */
export const ONE_PRINT_MS = 120_000;

/**
 * Lets exactly the print this call starts carry the sheet: sets data-print-ok,
 * opens the dialog, and takes the permission away again on the first of —
 * afterprint; no beforeprint within PRINT_DIALOG_OPEN_MS (the call was
 * ignored); ONE_PRINT_MS after beforeprint (afterprint never came); a throw
 * from print(). Never removed during the print itself: beforeprint only starts
 * the longer clock, because the sheet is laid out for print after it.
 */
export function allowOnePrint(win: Window = window): void {
  const html = win.document.documentElement;
  let timer = 0;
  const end = () => {
    win.clearTimeout(timer);
    win.removeEventListener('beforeprint', opened);
    win.removeEventListener('afterprint', end);
    html.removeAttribute('data-print-ok');
  };
  function opened() {
    win.clearTimeout(timer);
    timer = win.setTimeout(end, ONE_PRINT_MS);
  }
  win.addEventListener('beforeprint', opened);
  win.addEventListener('afterprint', end);
  html.setAttribute('data-print-ok', '');
  timer = win.setTimeout(end, PRINT_DIALOG_OPEN_MS);
  try {
    win.print();
  } catch {
    end();
  }
}

/** Resolves once no photo of the sheet is still loading, or after IMAGES_WAIT_MS. */
async function imagesSettled(): Promise<HTMLImageElement[]> {
  const all = () => Array.from(document.querySelectorAll<HTMLImageElement>('.print-sheet img'));
  const started = Date.now();
  while (all().some((img) => img.dataset.printImage === 'loading') && Date.now() - started < IMAGES_WAIT_MS) {
    await new Promise((r) => window.setTimeout(r, 250));
  }
  return all();
}

export function PrintButton({ printout, id }: { printout: Printout; id: string }) {
  const [busy, setBusy] = useState<false | 'photos' | 'recording'>(false);
  const [error, setError] = useState<string | null>(null);

  async function onPrint() {
    setBusy('photos');
    setError(null);
    try {
      const images = await imagesSettled();
      const loaded = await Promise.allSettled(
        // An image that is not a PrintImage has no state: decode alone says whether it is in.
        images.map((img) => ((img.dataset.printImage ?? 'loaded') === 'loaded' ? img.decode() : Promise.reject(new Error('not loaded'))))
      );
      const missing = loaded.filter((r) => r.status === 'rejected').length;
      if (missing > 0) {
        setError(
          `${missing === 1 ? '1 photo or document' : `${missing} photos or documents`} did not load, so the print was not started. Reload the page and try again.`
        );
        return;
      }
      setBusy('recording');
      const res = await recordPrintAction({ printout, id });
      if (!res.ok) {
        setError(`${NOT_RECORDED} ${res.message}`);
        return;
      }
      allowOnePrint();
    } catch {
      setError(`${NOT_RECORDED} Check the connection and try again.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onPrint}
        disabled={busy !== false}
        className="inline-flex min-h-11 items-center rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {busy === 'photos' ? 'Loading photos…' : busy === 'recording' ? 'Recording…' : 'Print / Save as PDF'}
      </button>
      {error && (
        <p role="alert" className="max-w-md text-right text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Closes the tab the printout opened in (the app's links open it in a new one).
 * A tab the browser will not let a page close goes back to where it came from.
 */
export function CloseButton({ backHref }: { backHref: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        window.close();
        window.setTimeout(() => {
          if (!window.closed) window.location.assign(backHref);
        }, 200);
      }}
      className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
    >
      Close
    </button>
  );
}
