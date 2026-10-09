/**
 * Launch fix (2026-10-09), found by the launch browser suite (approvals-queue.spec.ts):
 * /reactivations fetched every card's photos at once, including the on-file photos
 * inside the closed "Photos on file (for comparison)" section, and a busy queue used
 * up the Manager's photo limit (/api/photos/[id]: 60 at once, then 1 a second), so
 * later photos failed to load. Every image on the page is now loading="lazy": the
 * browser fetches one in a closed <details> only when the section is opened, and a
 * long list only as it scrolls into view.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(process.cwd(), 'app/(app)/reactivations/page.tsx'), 'utf8');

/** Each `<img ... />` element in the page source. */
function imgTags(src: string): string[] {
  return [...src.matchAll(/<img\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

describe('/reactivations photos load lazily', () => {
  it('has the evidence and the two on-file comparison photos', () => {
    expect(imgTags(source).length).toBe(3);
  });

  it('every image is loading="lazy", so a closed comparison section fetches nothing', () => {
    for (const tag of imgTags(source)) {
      expect(tag, tag).toMatch(/loading="lazy"/);
    }
  });
});
