/**
 * app/(app)/customers/new/CreditDocumentSlots.tsx — the pages of one document
 * on the new-customer form (owner decisions 2026-10-11: the four credit
 * documents; and the guarantees). The list and the empty slot's key are one
 * value, so the key moves only when a new page is in (item 22 review: keyed by
 * the number of pages, removing another page remounted the empty slot
 * mid-upload). The slots themselves: create-form-photo-slots.test.tsx.
 */
import { describe, it, expect } from 'vitest';
import { addPage, documentPages, replacePage } from '@/app/(app)/customers/new/CreditDocumentSlots';

describe('the pages of one document', () => {
  it('start as the request holds them, a copy, with the first empty slot', () => {
    const ids = ['a', 'b'];
    const pages = documentPages(ids);
    expect(pages).toEqual({ ids: ['a', 'b'], emptySlot: 0 });
    ids.push('c');
    expect(pages.ids).toEqual(['a', 'b']);
    expect(documentPages()).toEqual({ ids: [], emptySlot: 0 });
  });

  it('a new page joins the end and moves the empty slot on; the same page twice is one', () => {
    const one = addPage(documentPages(['a']), 'b');
    expect(one).toEqual({ ids: ['a', 'b'], emptySlot: 1 });
    expect(addPage(one, 'b')).toBe(one);
  });

  it('a retake replaces the page in place; a removal takes it off; neither moves the empty slot', () => {
    const pages = { ids: ['a', 'b', 'c'], emptySlot: 3 };
    expect(replacePage(pages, 'b', 'x')).toEqual({ ids: ['a', 'x', 'c'], emptySlot: 3 });
    expect(replacePage(pages, 'b', null)).toEqual({ ids: ['a', 'c'], emptySlot: 3 });
    expect(replacePage(pages, 'b', 'b')).toBe(pages);
    // A retake that comes back as a page already on the list (finalize dedupes a
    // picture taken again) is not listed twice.
    expect(replacePage(pages, 'b', 'c')).toEqual({ ids: ['a', 'c'], emptySlot: 3 });
  });
});
