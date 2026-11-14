/**
 * H8 (bug hunt round 2, F6): the customer profile and the photo slots of the
 * forms asked for every photo at once. The photo route allows each person a burst
 * of 60, then one a second (app/api/photos/[id]/route.ts), so a chain customer
 * with 30 or more photographed shops (a shop and a signboard photo each) showed
 * the photos past the 60th as broken images, with no second try. They now load
 * lazily (only those on screen are asked for) and a photo that fails is asked for
 * again later, with the retry the printout already used (PrintImage). The limit
 * is unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { stripComments } from '../support/strip-comments';
import { RetryingPhoto, MAX_PHOTO_ATTEMPTS } from '@/components/nmwc/RetryingPhoto';
import { PhotoCaptureSlot } from '@/components/nmwc/PhotoCaptureSlot';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('an on-screen photo loads lazily and is asked for again past the burst limit (H8)', () => {
  it('RetryingPhoto: lazy, async decode, and a failure is retried at a new address', async () => {
    vi.useFakeTimers();
    render(<RetryingPhoto src="/api/photos/ph1" alt="Shop" />);
    const img = () => screen.getByRole('img', { name: 'Shop' });
    expect(img().getAttribute('loading')).toBe('lazy');
    expect(img().getAttribute('decoding')).toBe('async');
    expect(img().getAttribute('src')).toBe('/api/photos/ph1');
    for (let attempt = 1; attempt < MAX_PHOTO_ATTEMPTS; attempt++) {
      fireEvent.error(img());
      await act(async () => {
        vi.advanceTimersByTime(1500 * 2 ** (attempt - 1) + 3000);
      });
      expect(img().getAttribute('src')).toBe(`/api/photos/ph1?attempt=${attempt}`);
    }
    // After the last attempt it stops asking.
    fireEvent.error(img());
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(img().getAttribute('src')).toBe(`/api/photos/ph1?attempt=${MAX_PHOTO_ATTEMPTS - 1}`);
  });

  it('the photo slot of a form: a photo on file is lazy and retried', async () => {
    vi.useFakeTimers();
    render(
      <PhotoCaptureSlot kind="SHOP" initial={{ attachmentId: 'att1', remoteUrl: '/api/photos/att1' }} />
    );
    const img = () => document.querySelector('img') as HTMLImageElement;
    expect(img().getAttribute('src')).toBe('/api/photos/att1');
    expect(img().getAttribute('loading')).toBe('lazy');
    fireEvent.error(img());
    await act(async () => {
      vi.advanceTimersByTime(4500);
    });
    expect(img().getAttribute('src')).toBe('/api/photos/att1?attempt=1');
  });

  it('the customer profile draws its photos with RetryingPhoto, never a bare <img>', () => {
    const src = stripComments(readFileSync('app/(app)/customers/[id]/page.tsx', 'utf8'));
    expect(src).not.toMatch(/<img\b/);
    // The CR row, and the shop and signboard tile of every shop.
    expect(src.match(/<RetryingPhoto\b/g)?.length).toBe(2);
  });
});
