'use client';

/**
 * One document's pages on the new-customer form: the owner's ID card, the
 * membership certificate, the VAT registration certificate, the tax card (owner
 * decisions 2026-10-11, lib/credit-documents.ts) and the guarantee documents.
 *
 * Extracted from the guarantee grid of CreateCustomerForm, with what that grid
 * learnt kept (item 22 review):
 *   - each page on file is its own slot, keyed by its photo: a retake replaces it
 *     in place in the request, a Remove takes it off the list;
 *   - one empty slot for the next page, keyed by a counter that moves only when a
 *     new page is in. Keyed by the number of pages, removing another page
 *     remounted it mid-upload and let Submit go beside its running upload.
 * So the pages and the counter are one value (DocumentPages), and the form owns
 * it: the payload sends `ids`.
 *
 * `allowNew` off shows only the pages on file, removable, with no empty slot —
 * the guarantees a returned request still carries while the guarantee is no
 * longer asked for (GUARANTEE_REQUIRED_FOR_CREDIT off). The form keeps sending
 * them, so the submit's release step never deletes that evidence.
 */
import { PhotoCaptureSlot, type PhotoSlotKind } from '@/components/nmwc/PhotoCaptureSlot';
import { groupNamedBy } from '@/components/nmwc/LabeledField';

export type DocumentPages = { ids: string[]; emptySlot: number };

/** A document's pages as a request on file holds them, before anything is changed. */
export function documentPages(ids: readonly string[] = []): DocumentPages {
  return { ids: [...ids], emptySlot: 0 };
}

/**
 * A page on file replaced (`next` is its new photo) or removed (`next` null):
 * in place, never twice on the list.
 */
export function replacePage(pages: DocumentPages, pageId: string, next: string | null): DocumentPages {
  if (!next) return { ...pages, ids: pages.ids.filter((x) => x !== pageId) };
  if (next === pageId) return pages;
  return {
    ...pages,
    ids: pages.ids.map((x) => (x === pageId ? next : x)).filter((x, i, all) => all.indexOf(x) === i),
  };
}

/** A new page finished in the empty slot: on the list, and a fresh empty slot for the next. */
export function addPage(pages: DocumentPages, id: string): DocumentPages {
  return pages.ids.includes(id) ? pages : { ids: [...pages.ids, id], emptySlot: pages.emptySlot + 1 };
}

export function CreditDocumentSlots({
  id,
  caption,
  kind,
  pages,
  onPagesChange,
  max,
  allowNew = true,
  required = false,
  readOnly,
  locked,
  error,
  onBusyChange,
}: {
  /** The caption's id: it names the group, and `${id}-error` describes it. */
  id: string;
  caption: string;
  kind: PhotoSlotKind;
  pages: DocumentPages;
  /** An update of the pages as they are NOW (several slots may answer in one render). */
  onPagesChange: (update: (pages: DocumentPages) => DocumentPages) => void;
  max: number;
  /** Offer an empty slot for a new page (off: only the pages on file). */
  allowNew?: boolean;
  /** The empty slot reads as required while no page is on file. */
  required?: boolean;
  /** A request in review or closed: the pages are shown, nothing changes. */
  readOnly: boolean;
  /** A submit on its way: no new photo, no retake, no Remove. */
  locked: boolean;
  error?: string;
  onBusyChange: (busy: boolean) => void;
}) {
  return (
    <div {...groupNamedBy(id, error)}>
      <p id={id} className="mb-1 block text-sm font-medium text-slate-700">
        {caption}
      </p>
      {error && (
        <p id={`${id}-error`} className="mb-1 text-xs font-medium text-red-600">
          {error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {pages.ids.map((pid) => (
          <PhotoCaptureSlot
            key={pid}
            kind={kind}
            disabled={readOnly || locked}
            initial={{ attachmentId: pid, remoteUrl: `/api/photos/${pid}` }}
            onChange={(p) => {
              if (readOnly) return;
              onPagesChange((g) => replacePage(g, pid, p?.attachmentId ?? null));
            }}
            onBusyChange={onBusyChange}
          />
        ))}
        {!readOnly && allowNew && pages.ids.length < max && (
          <PhotoCaptureSlot
            key={`empty-${pages.emptySlot}`}
            kind={kind}
            required={required && pages.ids.length === 0}
            onChange={(p) => {
              const next = p?.attachmentId;
              if (next) onPagesChange((g) => addPage(g, next));
            }}
            onBusyChange={onBusyChange}
            disabled={locked}
          />
        )}
      </div>
    </div>
  );
}
