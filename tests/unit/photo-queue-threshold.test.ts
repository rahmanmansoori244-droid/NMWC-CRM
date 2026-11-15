/**
 * Large-customer photos, part B: which pages load their photos through the
 * paced queue (lib/photo-pacing.ts). 39 photos (19 shops with two photos and
 * a CR document) stay 'direct'; 41 (20 shops and a CR document) are 'queued'.
 */
import { describe, expect, it } from 'vitest';
import { PHOTO_QUEUE_FROM, photoModeFor, profilePhotoCount } from '@/lib/photo-pacing';

const id = (n: number, k: string) => `${k}-${n}`;
const shops = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('photoModeFor', () => {
  it('more than 40 is queued, 40 or fewer direct', () => {
    expect(PHOTO_QUEUE_FROM).toBe(40);
    expect(photoModeFor(0)).toBe('direct');
    expect(photoModeFor(40)).toBe('direct');
    expect(photoModeFor(41)).toBe('queued');
  });
});

describe('customer profile', () => {
  const customer = (n: number, cr = true) => ({
    crPhoto: cr ? { id: 'cr' } : null,
    branches: shops(n).map((i) => ({ shopPhoto: { id: id(i, 's') }, signboardPhoto: { id: id(i, 'b') } })),
  });
  it('19 shops with 2 photos plus CR (39): direct; 20 shops plus CR (41): queued', () => {
    expect(profilePhotoCount(customer(19))).toBe(39);
    expect(photoModeFor(profilePhotoCount(customer(19)))).toBe('direct');
    expect(profilePhotoCount(customer(20))).toBe(41);
    expect(photoModeFor(profilePhotoCount(customer(20)))).toBe('queued');
  });
  it('counts only the photos there are', () => {
    expect(profilePhotoCount(customer(20, false))).toBe(40);
    expect(
      profilePhotoCount({ crPhoto: null, branches: [{ shopPhoto: { id: 'a' }, signboardPhoto: null }, { shopPhoto: null, signboardPhoto: null }] })
    ).toBe(1);
  });
});
