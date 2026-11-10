// @vitest-environment node
/**
 * Review of the zod 4 upgrade, 2026-11-10. array3 (lib/zod.ts) keeps zod 3's
 * bounded array — the count first, then every element read — for the three
 * lists whose shown message depends on that order: the signed-form upload's
 * pages and the two users forms' regions. Reading every element of a list far
 * over its cap is the work GHSA-mrhx-c7xc-m3w5 is about, and on zod 4 it was
 * worse than slow: by the reviewer's measurement 130,000 empty ids sent to the
 * signed-form upload (about 400 KB, any signed-in salesman) made the parse
 * THROW "RangeError: Maximum call stack size exceeded" after 450 ms — zod 4
 * merges a child's issues with a spread call — so the caller got a 500 where
 * zod 3 refused in 86 ms; 1.5 million took 6.4 s and then threw.
 *
 * Now a list longer than array3Ceiling(cap) is refused on its count alone and
 * none of its elements is parsed; up to the ceiling nothing moves (the record in
 * validation-messages.test.ts holds that). Held here on array3 itself and
 * through the three real actions, with the database refusing every call.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';

const h = vi.hoisted(() => ({
  user: { id: 'u1', role: 'SALESMAN', username: 'mct01' } as { id: string; role: string; username: string },
  dbCalls: [] as string[],
}));

/** Nothing here may reach the database: each refusal comes before the first read. */
vi.mock('@/lib/db', () => {
  const refuse = (path: string): unknown =>
    new Proxy(() => {}, {
      get: (_t, name) => (typeof name === 'string' && name !== 'then' ? refuse(`${path}.${name}`) : undefined),
      apply: () => {
        h.dbCalls.push(path);
        throw new Error(`the database was reached: ${path}`);
      },
    });
  const prisma = refuse('prisma');
  return { prisma, directPrisma: prisma };
});
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('@/lib/logger', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => logger };
  return { logger };
});
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  checkLimit: async () => ({ ok: true, retryAfterSec: 0 }),
}));

import { array3, array3Ceiling, cuid3, string3, z } from '@/lib/zod';
import { MAX_SIGNED_FORM_PAGES } from '@/lib/credit-documents';
import { submitSignedFormAction } from '@/services/signed-form';
import { createUserAction, updateUserAccountAction } from '@/services/users';

const CUID = 'cjld2cjxh0000qzrmn831i7rn';
const FAR_OVER = 200_000;
/** Generous for a slow CI runner; before the ceiling 200,000 ids took most of a second and then threw. */
const QUICK_MS = 250;

type Issue = { code: string; path: PropertyKey[]; message: string };
const issuesOf = (r: { success: boolean; error?: { issues: readonly unknown[] } }): Issue[] =>
  r.success ? [] : (r.error!.issues as Issue[]).map((i) => ({ code: i.code, path: i.path, message: i.message }));

async function timed<T>(fn: () => Promise<T> | T): Promise<{ ms: number; value: T }> {
  let best = Infinity;
  let value: T | undefined;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    value = await fn();
    best = Math.min(best, performance.now() - t);
  }
  return { ms: best, value: value as T };
}

describe('array3 reads a list element by element only up to its ceiling', () => {
  const pages = array3(string3().check(cuid3()), {
    min: { value: 1, message: 'Add a page.' },
    max: { value: 6, message: 'At most 6 pages.' },
  });
  const regions = array3(string3().check(cuid3()), { max: { value: 50 } });

  it('the ceiling is twenty times the cap and never under a thousand', () => {
    expect(array3Ceiling(6)).toBe(1000);
    expect(array3Ceiling(50)).toBe(1000);
    expect(array3Ceiling(51)).toBe(1020);
    expect(array3Ceiling(500)).toBe(10_000);
  });

  it('at the ceiling the answer is the one zod 3 gave: the count, then every bad element', () => {
    const at = array3Ceiling(6);
    const issues = issuesOf(pages.safeParse(Array(at).fill('')));
    expect(issues).toHaveLength(at + 1);
    expect(issues[0]).toEqual({ code: 'too_big', path: [], message: 'At most 6 pages.' });
    expect(issues[1]).toEqual({ code: 'invalid_format', path: [0], message: 'Invalid cuid' });
    expect(issues.at(-1)).toEqual({ code: 'invalid_format', path: [at - 1], message: 'Invalid cuid' });
    // The users forms show the LAST issue: a bad id's, as under zod 3.
    const last = issuesOf(regions.safeParse(Array(array3Ceiling(50)).fill('x'))).at(-1);
    expect(last).toEqual({ code: 'invalid_format', path: [array3Ceiling(50) - 1], message: 'Invalid cuid' });
  });

  it('one past the ceiling is refused on its count alone, and the element schema is given none', () => {
    let read = 0;
    const counting = array3(
      z.string().refine(() => {
        read++;
        return false;
      }),
      { max: { value: 6, message: 'At most 6 pages.' } }
    );
    const over = Array(array3Ceiling(6) + 1).fill('');
    expect(issuesOf(counting.safeParse(over))).toEqual([{ code: 'too_big', path: [], message: 'At most 6 pages.' }]);
    expect(read).toBe(0);
    // A valid list that long is refused the same way (zod 3 said the same: the count, alone).
    expect(issuesOf(pages.safeParse(Array(array3Ceiling(6) + 1).fill(CUID)))).toEqual([
      { code: 'too_big', path: [], message: 'At most 6 pages.' },
    ]);
    // Without words of its own the count reads as zod 3 worded it.
    expect(issuesOf(regions.safeParse(Array(array3Ceiling(50) + 1).fill('x')))).toEqual([
      { code: 'too_big', path: [], message: 'Array must contain at most 50 element(s)' },
    ]);
  });

  it('inside an object, the far-over list is one issue under its key and stops nothing else', () => {
    const schema = z.object({ editId: string3().check(cuid3()), attachmentIds: pages });
    const r = schema.safeParse({ editId: 'bad', attachmentIds: Array(FAR_OVER).fill('') });
    expect(issuesOf(r)).toEqual([
      { code: 'invalid_format', path: ['editId'], message: 'Invalid cuid' },
      { code: 'too_big', path: ['attachmentIds'], message: 'At most 6 pages.' },
    ]);
  });

  it.each([
    ['empty ids', ''],
    ['ids of the wrong type', 7],
    ['objects', {}],
  ])('%s, 1.5 million of them (a 4.5 MB body): refused, not thrown, at once', async (_label, el) => {
    const list = Array(1_500_000).fill(el);
    const { ms, value } = await timed(() => pages.safeParse(list));
    expect(issuesOf(value)).toEqual([{ code: 'too_big', path: [], message: 'At most 6 pages.' }]);
    expect(ms).toBeLessThan(QUICK_MS);
  });

  it('every array3 in the app names its cap (without one there is no ceiling)', () => {
    for (const file of ['services/signed-form.ts', 'services/users.ts']) {
      const src = stripComments(readFileSync(file, 'utf8'));
      const calls = src.split('array3(').slice(1);
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) expect(call.slice(0, 400), file).toMatch(/\bmax:\s*\{\s*value:/);
    }
    // And the type refuses a call without one.
    // @ts-expect-error -- `max` is required
    expect(() => array3(z.string(), {})).toThrow();
  });
});

describe('the three lists kept on array3, through their real actions', () => {
  type Refusal = { ok: false; code: string; message: string; fields?: Record<string, string> };
  const form = (fields: Record<string, string>, regionIds: string[]): FormData => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    for (const id of regionIds) f.append('regionId', id);
    return f;
  };

  it(`the signed-form upload: ${FAR_OVER.toLocaleString('en')} empty page ids are refused in the words of the count`, async () => {
    h.user = { id: 'sal1', role: 'SALESMAN', username: 'mct-01' };
    h.dbCalls.length = 0;
    const input = { editId: CUID, attachmentIds: Array(FAR_OVER).fill('') };
    const { ms, value } = await timed(() => submitSignedFormAction(input));
    expect(value).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      fields: { signedForm: `At most ${MAX_SIGNED_FORM_PAGES} pages.` },
    });
    expect(ms).toBeLessThan(QUICK_MS);
    expect(h.dbCalls).toEqual([]);
  });

  it('the signed-form upload: one page over the cap, with a bad id, still answers as before', async () => {
    h.user = { id: 'sal1', role: 'SALESMAN', username: 'mct-01' };
    const res = (await submitSignedFormAction({
      editId: CUID,
      attachmentIds: [...Array(MAX_SIGNED_FORM_PAGES).fill(CUID), 'bad'],
    })) as Refusal;
    expect(res.fields).toEqual({ signedForm: `At most ${MAX_SIGNED_FORM_PAGES} pages.` });
  });

  it(`creating a user: ${FAR_OVER.toLocaleString('en')} bad region ids are refused under "regionIds"`, async () => {
    h.user = { id: 'stw1', role: 'STEWARD', username: 'steward' };
    h.dbCalls.length = 0;
    const fd = form(
      { username: 'new.user', fullName: 'New User', role: 'MANAGER', password: 'correct-horse-battery' },
      Array(FAR_OVER).fill('x')
    );
    const { ms, value } = await timed(() => createUserAction(fd));
    const res = value as Refusal;
    expect(res.ok).toBe(false);
    expect(res.code).toBe('VALIDATION_FAILED');
    expect(res.fields).toEqual({ regionIds: 'Array must contain at most 50 element(s)' });
    expect(ms).toBeLessThan(QUICK_MS);
    expect(h.dbCalls).toEqual([]);
  });

  it(`editing an account: ${FAR_OVER.toLocaleString('en')} bad region ids are refused under "regionIds"`, async () => {
    h.user = { id: 'stw1', role: 'STEWARD', username: 'steward' };
    h.dbCalls.length = 0;
    const fd = form({ userId: CUID, role: 'MANAGER' }, Array(FAR_OVER).fill('x'));
    const { ms, value } = await timed(() => updateUserAccountAction(fd));
    const res = value as Refusal;
    expect(res.ok).toBe(false);
    expect(res.code).toBe('VALIDATION_FAILED');
    expect(res.fields).toEqual({ regionIds: 'Array must contain at most 50 element(s)' });
    expect(ms).toBeLessThan(QUICK_MS);
    expect(h.dbCalls).toEqual([]);
  });

  it('the users forms: fifty-one regions with a bad one last still show the words of the bad id (the last issue, as under zod 3)', async () => {
    h.user = { id: 'stw1', role: 'STEWARD', username: 'steward' };
    const ids = [...Array.from({ length: 50 }, (_, i) => `ckregion${String(i).padStart(17, '0')}`), 'bad'];
    const res = (await updateUserAccountAction(form({ userId: CUID, role: 'MANAGER' }, ids))) as Refusal;
    expect(res.fields).toEqual({ regionIds: 'Invalid cuid' });
  });
});
