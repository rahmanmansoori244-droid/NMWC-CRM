/**
 * The screen around a printout (owner decisions 2026-10-11, part C): a toolbar
 * with "Print / Save as PDF" and "Close", and the sheet centred at A4 width. The
 * toolbar is `no-print`; the notice below it is shown only by a print the button
 * did not start (app/(print)/print.css), so a Ctrl+P prints that notice and not
 * the form.
 */
import type { ReactNode } from 'react';
import type { Printout } from '@/lib/print';
import { PRINT_DIALOG_HINT, PRINTOUT_TITLES } from '@/lib/print';
import { CloseButton, PrintButton } from './PrintButton';

export const PRINT_BLOCKED_NOTICE =
  'This printout was not recorded. Use the Print button on the page so the print is recorded.';

export function PrintFrame({
  printout,
  id,
  backHref,
  children,
}: {
  printout: Printout;
  id: string;
  /** Where Close goes when the browser will not close the tab. */
  backHref: string;
  children: ReactNode;
}) {
  return (
    <div className="print-page">
      <div className="print-toolbar no-print">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-700">
            {PRINTOUT_TITLES[printout]} <span className="font-normal text-slate-500">· A4 · print or save as PDF</span>
          </p>
          {/* Review (2026-10-11): the browser's own header and footer print the page address and the date in the margins. */}
          <p className="text-xs text-slate-500">{PRINT_DIALOG_HINT}</p>
        </div>
        <div className="flex flex-wrap items-start justify-end gap-2">
          <PrintButton printout={printout} id={id} />
          <CloseButton backHref={backHref} />
        </div>
      </div>
      <p className="print-blocked">{PRINT_BLOCKED_NOTICE}</p>
      {children}
    </div>
  );
}

/** In scope, but nothing to print now: says why, with no Print button. */
export function PrintUnavailable({
  title,
  subject,
  message,
  backHref,
  alternative,
}: {
  title: string;
  subject: string;
  message: string;
  backHref: string;
  /** Where the printout that applies now is, when there is one. */
  alternative?: { href: string; label: string };
}) {
  return (
    <div className="print-page">
      <div className="print-toolbar no-print">
        <p className="text-sm font-semibold text-slate-700">{title}</p>
        <CloseButton backHref={backHref} />
      </div>
      <section className="print-sheet-message" role="status">
        <h1 className="text-lg font-semibold text-slate-900 [overflow-wrap:anywhere]">{subject}</h1>
        <p className="mt-2 text-base text-slate-700">Not available now — {message}</p>
        {alternative && (
          <p className="mt-3">
            <a href={alternative.href} className="font-medium text-brand-700 underline underline-offset-2">
              {alternative.label}
            </a>
          </p>
        )}
      </section>
    </div>
  );
}
