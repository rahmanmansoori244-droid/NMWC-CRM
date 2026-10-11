/**
 * The printed page (owner decisions 2026-10-11, part C), laid out like the owner's
 * reference: a header with the company, the printout's title and the customer on
 * the left and the codes and status on the right; then titled sections with
 * labels and values in two aligned columns, a location block, and the photos and
 * documents in a neat grid. A4 portrait, English; app/(print)/print.css carries
 * the page size, margins and page breaks, and hides everything outside the sheet.
 *
 * Server components, no state: what a sheet shows is what lib/print-load.ts read.
 */
import type { ReactNode } from 'react';
import { omanDate, omanDateTime } from '@/lib/tz';
import {
  APPROVER_BOX_LINES,
  COMPANY_NAME,
  CREDIT_DECLARATION,
  CUSTOMER_SIGNATURE_BOXES,
} from '@/lib/print';
import type { PrintFigure, PrintLocation, PrintRow, PrintTrail } from '@/lib/print-load';
import { PrintImage } from './PrintImage';

export type PrintCode = { label: string; value: string; mono?: boolean; muted?: boolean };

export function PrintSheet({
  title,
  subject,
  codes,
  status,
  printedBy,
  printedAt,
  meta,
  children,
}: {
  title: string;
  /** The customer's name, under the title. */
  subject: string;
  /** Right-hand block: the codes, one under the other. */
  codes: PrintCode[];
  status: string;
  printedBy: string;
  printedAt: Date;
  /** Left of the "Printed by" line: who sent it, when. */
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="print-sheet bg-white text-slate-900" aria-label={`${title}: ${subject}`}>
      {/* Wraps on a phone: the codes go under the title instead of squeezing it. */}
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b-2 border-slate-800 pb-3">
        <div className="min-w-0 flex-1 basis-[55%]">
          <p className="text-[8pt] font-semibold uppercase tracking-[0.12em] text-slate-500">{COMPANY_NAME}</p>
          <h1 className="mt-1 text-[17pt] font-bold leading-tight">{title}</h1>
          <p className="mt-1 text-[11.5pt] font-semibold leading-snug text-slate-800 [overflow-wrap:anywhere]">{subject}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5 text-right">
          <dl className="space-y-1">
            {codes.map((c) => (
              <div key={c.label}>
                <dt className="text-[7.5pt] font-medium uppercase tracking-wide text-slate-500">{c.label}</dt>
                <dd
                  className={`${c.mono ? 'font-mono text-[11pt] font-semibold' : 'text-[9pt]'} ${c.muted ? 'text-slate-500' : 'text-slate-900'}`}
                >
                  {c.value}
                </dd>
              </div>
            ))}
          </dl>
          <span className="print-pill rounded-full border border-slate-400 bg-slate-100 px-2.5 py-0.5 text-[8.5pt] font-semibold text-slate-800">
            {status}
          </span>
        </div>
      </header>
      <p className="mt-1.5 flex flex-wrap justify-between gap-x-4 gap-y-0.5 text-[8pt] text-slate-500">
        <span>{meta}</span>
        <span>
          Printed by {printedBy} · {omanDateTime(printedAt)} (Oman time)
        </span>
      </p>
      <div className="mt-4 space-y-4">{children}</div>
    </article>
  );
}

/**
 * One titled block. `keepTogether` (the default) keeps it on one page; a block
 * that can run longer than a page (the photos) lets its items break instead.
 */
export function PrintSection({
  title,
  children,
  keepTogether = true,
  newPage = false,
}: {
  title: string;
  children: ReactNode;
  keepTogether?: boolean;
  /** Starts on a new page when printed (the credit application's annex). */
  newPage?: boolean;
}) {
  return (
    <section
      className={`print-section rounded-lg border border-slate-300 ${keepTogether ? 'print-keep' : ''} ${newPage ? 'print-new-page' : ''}`}
    >
      <h2 className="border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-[10.5pt] font-semibold text-slate-800">{title}</h2>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/**
 * Labels and values in two aligned columns (8pt label above a 10.5pt value). An
 * empty value prints "—", so the columns stay aligned; an empty wide row (notes,
 * a landmark) is left out.
 */
export function InfoGrid({ rows }: { rows: PrintRow[] }) {
  const shown = rows.filter((r) => !(r.wide && (r.value == null || r.value === '')));
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-2.5">
      {shown.map((r) => (
        <div key={r.label} className={r.wide ? 'col-span-2' : undefined}>
          <dt className="text-[8pt] text-slate-500">{r.label}</dt>
          <dd
            className={`text-[10.5pt] leading-snug text-slate-900 [overflow-wrap:anywhere] ${r.mono ? 'font-mono text-[10pt]' : ''}`}
          >
            {r.value == null || r.value === '' ? '—' : r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Coordinates (monospace), the accuracy the phone reported, and when it was taken, Oman time. */
export function LocationBlock({ location }: { location: PrintLocation | null }) {
  return (
    <div className="print-keep mt-3 rounded-md border border-slate-200 px-3 py-2">
      <p className="text-[8pt] font-semibold uppercase tracking-wide text-slate-500">Location</p>
      {location ? (
        <>
          <p className="font-mono text-[10.5pt] text-slate-900">
            {location.lat.toFixed(6)}, {location.lng.toFixed(6)}
          </p>
          <p className="text-[8.5pt] text-slate-600">
            Accuracy: {location.accuracy != null ? `±${Math.round(location.accuracy)} m` : 'not recorded'}
          </p>
          <p className="text-[8.5pt] text-slate-600">
            Captured: {location.capturedAt ? omanDateTime(location.capturedAt) : 'not recorded'}
          </p>
        </>
      ) : (
        <p className="text-[9pt] text-slate-500">No location recorded.</p>
      )}
    </div>
  );
}

/**
 * Photos and document pages, three to a row, each 4:3 with its caption: a photo
 * fills its frame, a document page is shown whole. Loaded eagerly and retried
 * past the photo route's burst limit (PrintImage), and PrintButton waits for
 * every one before it prints. Each comes through /api/photos, which checks scope
 * and records the view.
 */
export function PhotoGrid({ figures }: { figures: PrintFigure[] }) {
  if (figures.length === 0) {
    return <p className="text-[9pt] text-slate-500">No photos or documents on file.</p>;
  }
  return (
    <div className="grid grid-cols-3 gap-3">
      {figures.map((f) => (
        <figure key={f.id} className="print-keep">
          <div className="aspect-[4/3] overflow-hidden rounded-md border border-slate-200 bg-slate-50">
            <PrintImage
              id={f.id}
              alt={f.caption}
              className={`h-full w-full ${f.document ? 'object-contain' : 'object-cover'}`}
            />
          </div>
          <figcaption className="mt-1 text-[8pt] leading-tight text-slate-600">{f.caption}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/**
 * The customer's declaration, verbatim from the owner's paper form (lib/print.ts),
 * and under it the customer's boxes: Name and Designation, then Signature and the
 * company stamp, the stamp box taller. One block kept on one page, so the text
 * signed for and the signature are never on different sheets. Blank: filled in
 * by hand at the shop.
 */
export function DeclarationBlock() {
  const height: Record<(typeof CUSTOMER_SIGNATURE_BOXES)[number], string> = {
    Name: 'min-h-[16mm]',
    Designation: 'min-h-[16mm]',
    Signature: 'min-h-[30mm]',
    'Company stamp': 'min-h-[42mm]',
  };
  return (
    <PrintSection title="Customer Declaration">
      <p className="text-justify text-[10pt] leading-relaxed text-slate-900">{CREDIT_DECLARATION}</p>
      <p className="mb-1.5 mt-4 text-[8pt] font-semibold uppercase tracking-wide text-slate-500">For the customer</p>
      <div className="grid grid-cols-2 items-start gap-3">
        {CUSTOMER_SIGNATURE_BOXES.map((box) => (
          <section
            key={box}
            aria-label={`Customer: ${box}`}
            className={`rounded-md border border-slate-400 px-2.5 py-1.5 ${height[box]}`}
          >
            <p className="text-[8pt] font-semibold uppercase tracking-wide text-slate-500">{box}</p>
          </section>
        ))}
      </div>
    </PrintSection>
  );
}

/**
 * One box per approver of the customer's chain (lib/print.ts signatureRolesFor):
 * the role, then a line each for the name, the signature and the date, written
 * in by hand, with its caption under it.
 */
export function ApproverSignatureBoxes({ signatures }: { signatures: Array<{ title: string }> }) {
  return (
    <PrintSection title="Approvals — signatures">
      <div className={`grid gap-3 ${signatures.length > 2 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {signatures.map((s) => (
          <section key={s.title} aria-label={`Signature: ${s.title}`} className="rounded-md border border-slate-400 px-2.5 py-2">
            <p className="text-[9pt] font-semibold text-slate-800">{s.title}</p>
            {APPROVER_BOX_LINES.map((line) => (
              <div key={line}>
                <div className={`border-b border-slate-400 ${line === 'Signature' ? 'h-[14mm]' : 'h-[8mm]'}`} />
                <p className="mt-0.5 text-[7pt] uppercase tracking-wide text-slate-500">{line}</p>
              </div>
            ))}
          </section>
        ))}
      </div>
    </PrintSection>
  );
}

/**
 * Who made this customer in the CRM: who sent the request and when, then each
 * step of its chain with who completed it and when (Oman time).
 */
export function ApprovalTrail({ trail }: { trail: PrintTrail }) {
  if (trail.kind === 'import') {
    return (
      <p className="text-[10pt] text-slate-700">
        Loaded by import{trail.at ? ` on ${omanDate(trail.at)}` : ''}; no approval trail in the CRM.
      </p>
    );
  }
  if (trail.kind === 'none') {
    return (
      <p className="text-[10pt] text-slate-700">
        Not created through a new-customer request in the CRM; no approval trail.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[10pt] text-slate-800">
        Submitted by <strong>{trail.submittedBy}</strong>
        {trail.submittedAt ? ` · ${omanDateTime(trail.submittedAt)}` : ''}
        <span className="ml-2 text-[8pt] text-slate-500">
          Request ref. <span className="font-mono">{trail.requestId}</span>
        </span>
      </p>
      {/* A grid with table roles, not a <table>: every app table scrolls inside a
          TableScroll (mobile-quick-wins), which a sheet of paper has no use for. */}
      <div role="table" aria-label="Approval trail" className="text-[9.5pt]">
        <div role="row" className={`${TRAIL_ROW} border-b border-slate-300 text-[8pt] uppercase tracking-wide text-slate-500`}>
          {['Step', 'Decision', 'By', 'Date and time'].map((h) => (
            <span key={h} role="columnheader" className="py-1 font-medium">
              {h}
            </span>
          ))}
        </div>
        {trail.steps.map((s, i) => (
          <div key={i} role="row" className={`${TRAIL_ROW} border-b border-slate-100 text-slate-800`}>
            <span role="cell" className="py-1 font-medium">
              {s.step}
            </span>
            <span role="cell" className="py-1">
              {s.decision}
            </span>
            <span role="cell" className="py-1">
              {s.by ?? '—'}
            </span>
            <span role="cell" className="py-1">
              {s.at ? omanDateTime(s.at) : '—'}
            </span>
          </div>
        ))}
      </div>
      {(trail.sentBackInRound > 0 || trail.earlierRounds > 0) && (
        <p className="text-[8.5pt] text-slate-600">
          {trail.sentBackInRound > 0 ? `Sent back between steps ${times(trail.sentBackInRound)} in this round. ` : ''}
          {trail.earlierRounds > 0 ? `Returned to the salesman for correction ${times(trail.earlierRounds)} before. ` : ''}
          The full history is on the request&apos;s page in the CRM.
        </p>
      )}
    </div>
  );
}

const TRAIL_ROW = 'grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,1.1fr)] gap-x-3';

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
