/**
 * Large-customer photos, part B: which pages load their photos through the
 * paced queue (lib/photo-pacing.ts). 39 photos (19 shops with two photos and
 * a CR document) stay 'direct'; 41 (20 shops and a CR document) are 'queued'.
 */
import { describe, expect, it } from 'vitest';
import { PHOTO_QUEUE_FROM, approvalPhotoCount, photoModeFor, profilePhotoCount } from '@/lib/photo-pacing';

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

describe('approval detail', () => {
  // The ten PhotoRow call sites, each a list of the ids it renders.
  const rows = (n: number) => [
    ['cr'], // CR document of a new-customer request
    [], // guarantees
    [], // a credit document
    [], // the signed application
    ...shops(n).map((i) => [id(i, 's'), id(i, 'b')]), // each branch draft
    [], // the evidence
    [], // CR document on file
  ];
  it('19 shops with 2 photos plus CR (39): direct; 20 shops plus CR (41): queued', () => {
    expect(approvalPhotoCount(rows(19))).toBe(39);
    expect(photoModeFor(approvalPhotoCount(rows(19)))).toBe('direct');
    expect(approvalPhotoCount(rows(20))).toBe(41);
    expect(photoModeFor(approvalPhotoCount(rows(20)))).toBe('queued');
  });
  it('counts every one of the 10 PhotoRow sources', () => {
    const sources = [
      'createCr',
      'guarantees',
      'creditDocument',
      'signedForm',
      'branchDraft',
      'evidence',
      'liveCr',
      'liveShop',
      'liveSignboard',
      'liveOther',
    ];
    const lists = sources.map((s) => [`${s}-1`, `${s}-2`]);
    expect(approvalPhotoCount(lists)).toBe(20);
    for (let i = 0; i < sources.length; i++) {
      const one = sources.map((_, j) => (j === i ? [`x-${j}`] : []));
      expect(approvalPhotoCount(one), sources[i]).toBe(1);
    }
    expect(approvalPhotoCount([[null, undefined, ''], []])).toBe(0);
  });
});
