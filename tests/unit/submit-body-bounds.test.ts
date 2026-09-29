// @vitest-environment node
/**
 * Review of the fix for the adversarial pass after phase 2, finding 4. Capping
 * the edit payload's `branches` at 500 did not bound a request's work: zod 3's
 * `z.array(x).max(n)` reports the length and then parses every element anyway,
 * raising an issue for each bad one, and services/edits.ts turned every issue
 * into a field of the error. By the reviewer's measurement a 4.5 MB body of 1.5
 * million `{}` branches took 52 s to parse and 16 s more to map, into an error of
 * 109 MB; one branch whose `overrides` held a million names, 24 s. CREATE's
 * .max(10) arrays had the same defect. Now every array in either payload is
 * refused on its length before any element is read (cappedArray), and a failed
 * parse reports at most 200 issues, each clipped to 500 characters
 * (reportedIssues), through both services.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { stripComments } from '../support/strip-comments';
import { fastestMs } from '../support/seeded-strings';

const h = vi.hoisted(() => ({
  user: { id: 'u-sales', role: 'SALESMAN', username: 'mct01' } as {
    id: string;
    role: string;
    username: string;
  },
}));
/** Nothing here may reach the database: each refusal comes before the first read. */
const db = vi.hoisted(() => ({
  customer: { findUnique: vi.fn(), findFirst: vi.fn() },
  user: { findUniqueOrThrow: vi.fn() },
  customerEdit: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  subChannel: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(), getAuditEnvelope: vi.fn() }));
vi.mock('@/lib/notifications', () => ({
  notifyUsers: vi.fn(),
  resolveStepAudience: vi.fn(async () => []),
  resolveStewardAudience: vi.fn(async () => []),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkLimit: async () => ({ ok: true, retryAfterSec: 0 }),
  FORM_LIMIT: {},
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  MAX_BRANCHES_PER_EDIT,
  TOO_MANY_BRANCHES_MESSAGE,
  TOO_MANY_OVERRIDES_MESSAGE,
  submitEditSchema,
} from '@/lib/validation/edit';
import {
  MAX_CREATE_ATTACHMENTS,
  MAX_CREATE_BRANCHES,
  TOO_MANY_CREATE_BRANCHES_MESSAGE,
  TOO_MANY_EXTRA_PHOTOS_MESSAGE,
  TOO_MANY_GUARANTEES_MESSAGE,
  submitCreateSchema,
} from '@/lib/validation/create';
import { MAX_REPORTED_ISSUES, MAX_REPORTED_MESSAGE, reportedIssues } from '@/lib/validation/fields';
import { BRANCH_EDIT_FIELDS, CUSTOMER_EDIT_FIELDS, EDIT_PAYLOAD_VERSION } from '@/lib/edit-values';
import { submitEditAction } from '@/services/edits';
import { submitCreateAction } from '@/services/creates';

const CUSTOMER_ID = 'ckcustomer00000000000001';
const cuid = (i: number) => 'ckbranch' + String(i).padStart(16, '0');
const MILLION = 1_000_000;

const editBody = (over: Record<string, unknown> = {}) => ({
  v: EDIT_PAYLOAD_VERSION,
  customerId: CUSTOMER_ID,
  customer: {},
  customerBase: {},
  branches: [] as unknown[],
  ...over,
});
/** One branch patch the schema accepts. */
const validBranch = (i = 0, over: Record<string, unknown> = {}) => ({
  branchId: cuid(i),
  address: 'Way 1',
  base: { address: null },
  ...over,
});
const createBody = (over: Record<string, unknown> = {}) => ({
  isDraft: true,
  customer: { legalName: 'Al Noor Trading', paymentTerms: 'CASH' },
  branches: [{ branchName: 'Main' }] as unknown[],
  ...over,
});

type Parse = { success: boolean; error?: { issues: z.ZodIssue[] } };
const issuesOf = (r: Parse) =>
  r.success ? [] : r.error!.issues.map((i) => ({ path: i.path, message: i.message }));
/** Parse `body` three times; the fastest must be quick, and every result the same. */
function timedParse(schema: { safeParse: (b: unknown) => Parse }, body: unknown) {
  let r: Parse = { success: true };
  const ms = fastestMs(() => {
    r = schema.safeParse(body);
  });
  return { ms, issues: issuesOf(r) };
}
async function fastestAsyncMs<T>(fn: () => Promise<T>, runs = 3): Promise<{ ms: number; last: T }> {
  let best = Infinity;
  let last: T | undefined;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    last = await fn();
    best = Math.min(best, performance.now() - t);
  }
  return { ms: best, last: last as T };
}
type Fail = { ok: false; code: string; fields: Record<string, string> };
const failed = (r: unknown): Fail => {
  expect((r as { ok: boolean }).ok).toBe(false);
  return r as Fail;
};

beforeEach(() => {
  h.user = { id: 'u-sales', role: 'SALESMAN', username: 'mct01' };
  for (const group of [db.customer, db.user, db.customerEdit, db.subChannel]) {
    for (const f of Object.values(group)) f.mockReset();
  }
  db.$transaction.mockReset();
});

describe('an array over its limit is refused on its length, before any element is read', () => {
  // Through zod's .max(), 300,000 `{}` branches took 6 s in a local run, and a
  // million, timed three times, crashed the test worker; gated, each case takes
  // well under a millisecond, so 50 ms leaves room
  // for a slow CI runner. One element over the limit is parsed first: without
  // the gate it fails there, on its per-element issues, before the million.
  type Case = [
    string,
    { safeParse: (b: unknown) => Parse },
    (n: number) => unknown,
    number,
    Array<{ path: unknown[]; message: string }>,
  ];
  const empties = (n: number) => Array.from({ length: n }, () => ({}));
  const names = (n: number) => Array<string>(n).fill('x');
  const CASES: Case[] = [
    [
      'edit: empty branches',
      submitEditSchema,
      (n) => editBody({ branches: empties(n) }),
      MAX_BRANCHES_PER_EDIT,
      [{ path: ['branches'], message: TOO_MANY_BRANCHES_MESSAGE }],
    ],
    [
      'edit: one branch whose overrides holds unknown names',
      submitEditSchema,
      (n) => editBody({ branches: [validBranch(0, { overrides: names(n) })] }),
      BRANCH_EDIT_FIELDS.length,
      [{ path: ['branches', 0, 'overrides'], message: TOO_MANY_OVERRIDES_MESSAGE }],
    ],
    [
      'edit: customerOverrides of unknown names',
      submitEditSchema,
      (n) => editBody({ customerOverrides: names(n) }),
      CUSTOMER_EDIT_FIELDS.length,
      [{ path: ['customerOverrides'], message: TOO_MANY_OVERRIDES_MESSAGE }],
    ],
    [
      'create: empty branches',
      submitCreateSchema,
      (n) => createBody({ branches: empties(n) }),
      MAX_CREATE_BRANCHES,
      [{ path: ['branches'], message: TOO_MANY_CREATE_BRANCHES_MESSAGE }],
    ],
    [
      'create: guarantee documents that are not ids',
      submitCreateSchema,
      (n) => createBody({ guaranteeAttachmentIds: names(n) }),
      MAX_CREATE_ATTACHMENTS,
      [{ path: ['guaranteeAttachmentIds'], message: TOO_MANY_GUARANTEES_MESSAGE }],
    ],
    [
      'create: one branch with extra photos that are not ids',
      submitCreateSchema,
      (n) => createBody({ branches: [{ branchName: 'Main', extraPhotoAttachmentIds: names(n) }] }),
      MAX_CREATE_ATTACHMENTS,
      [
        {
          path: ['branches', 0, 'extraPhotoAttachmentIds'],
          message: TOO_MANY_EXTRA_PHOTOS_MESSAGE,
        },
      ],
    ],
  ];
  it.each(CASES)(
    '%s: one over the limit, and 1,000,000, are one issue, in under 50 ms',
    (_n, schema, body, limit, want) => {
      expect(issuesOf(schema.safeParse(body(limit + 1)))).toEqual(want);
      const { ms, issues } = timedParse(schema, body(MILLION));
      expect(issues).toEqual(want);
      expect(ms).toBeLessThan(50);
    }
  );
});

describe('the limits are the ones there were', () => {
  it('edit: every field once in overrides and customerOverrides parses; one more is refused', () => {
    const ok = submitEditSchema.safeParse(
      editBody({
        customerOverrides: [...CUSTOMER_EDIT_FIELDS],
        branches: [validBranch(0, { overrides: [...BRANCH_EDIT_FIELDS] })],
      })
    );
    expect(ok.success).toBe(true);
    const over = submitEditSchema.safeParse(
      editBody({
        customerOverrides: [...CUSTOMER_EDIT_FIELDS, 'notes'],
        branches: [validBranch(0, { overrides: [...BRANCH_EDIT_FIELDS, 'address'] })],
      })
    );
    expect(issuesOf(over)).toEqual([
      { path: ['customerOverrides'], message: TOO_MANY_OVERRIDES_MESSAGE },
      { path: ['branches', 0, 'overrides'], message: TOO_MANY_OVERRIDES_MESSAGE },
    ]);
  });

  it('edit: 501 branches is one issue, and none of the branches is read', () => {
    expect(MAX_BRANCHES_PER_EDIT).toBe(500);
    // Every branch here is invalid; zod's .max() reported each of them as well.
    const bad = Array.from({ length: MAX_BRANCHES_PER_EDIT + 1 }, () => ({ branchId: 1 }));
    expect(issuesOf(submitEditSchema.safeParse(editBody({ branches: bad })))).toEqual([
      { path: ['branches'], message: TOO_MANY_BRANCHES_MESSAGE },
    ]);
    // Under the limit, the branches are read as before.
    const r = submitEditSchema.safeParse(editBody({ branches: bad.slice(1) }));
    expect(issuesOf(r).length).toBeGreaterThan(MAX_BRANCHES_PER_EDIT);
  });

  it('create: 10 branches, 10 guarantee documents and 10 extra photos pass; 11 of each is refused', () => {
    expect([MAX_CREATE_BRANCHES, MAX_CREATE_ATTACHMENTS]).toEqual([10, 10]);
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => 'ckatt' + String(i).padStart(20, '0'));
    const branches = (n: number, extras: number) =>
      Array.from({ length: n }, () => ({ branchName: 'B', extraPhotoAttachmentIds: ids(extras) }));
    const ok = submitCreateSchema.safeParse(
      createBody({ guaranteeAttachmentIds: ids(10), branches: branches(10, 10) })
    );
    expect(issuesOf(ok)).toEqual([]);
    const over = submitCreateSchema.safeParse(
      createBody({
        guaranteeAttachmentIds: ids(11),
        branches: [...branches(1, 11), ...branches(10, 0)],
      })
    );
    expect(issuesOf(over)).toEqual([
      { path: ['guaranteeAttachmentIds'], message: TOO_MANY_GUARANTEES_MESSAGE },
      { path: ['branches'], message: TOO_MANY_CREATE_BRANCHES_MESSAGE },
    ]);
    const extras = submitCreateSchema.safeParse(createBody({ branches: branches(1, 11) }));
    expect(issuesOf(extras)).toEqual([
      { path: ['branches', 0, 'extraPhotoAttachmentIds'], message: TOO_MANY_EXTRA_PHOTOS_MESSAGE },
    ]);
    // At least one branch, as before.
    expect(issuesOf(submitCreateSchema.safeParse(createBody({ branches: [] })))).toEqual([
      { path: ['branches'], message: 'At least one branch is required.' },
    ]);
  });

  it('a value that is not an array passes the gate and is refused as before', () => {
    const r = submitEditSchema.safeParse(editBody({ branches: 'x', customerOverrides: 1 }));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => [i.path, i.code])).toEqual([
      [['customerOverrides'], 'invalid_type'],
      [['branches'], 'invalid_type'],
    ]);
    const c = submitCreateSchema.safeParse(createBody({ branches: { length: 1 } }));
    expect(c.success).toBe(false);
    if (c.success) return;
    expect(c.error.issues.map((i) => [i.path, i.code])).toEqual([[['branches'], 'invalid_type']]);
  });
});

describe('reportedIssues: the most a failed parse puts in an error', () => {
  it('the first 200 issues, each message clipped to 500 characters', () => {
    expect([MAX_REPORTED_ISSUES, MAX_REPORTED_MESSAGE]).toEqual([200, 500]);
    const issues = Array.from(
      { length: 1000 },
      (_, i): z.ZodIssue => ({
        code: 'custom',
        path: ['f' + i],
        message: i % 2 ? 'short' : 'y'.repeat(2000),
      })
    );
    const out = reportedIssues(issues);
    expect(out.map((i) => i.path[0])).toEqual(issues.slice(0, 200).map((i) => i.path[0]));
    expect(out[1]!.message).toBe('short');
    expect(out[0]!.message).toHaveLength(500);
    expect(out[0]!.message.endsWith('y…')).toBe(true);
    // A message exactly at the limit is kept whole.
    expect(
      reportedIssues([{ code: 'custom', path: [], message: 'z'.repeat(500) }])[0]!.message
    ).toBe('z'.repeat(500));
  });
});

describe('through the actions: refused before the database, and the error stays small', () => {
  it('edit: 1,000,000 empty branches is one field, in under 50 ms', async () => {
    const one = await submitEditAction(
      editBody({
        branches: Array.from({ length: MAX_BRANCHES_PER_EDIT + 1 }, () => ({})),
      }) as unknown as Parameters<typeof submitEditAction>[0]
    );
    expect(failed(one).fields).toEqual({ branches: TOO_MANY_BRANCHES_MESSAGE });
    const body = editBody({ branches: Array.from({ length: MILLION }, () => ({})) });
    const { ms, last } = await fastestAsyncMs(() =>
      submitEditAction(body as unknown as Parameters<typeof submitEditAction>[0])
    );
    expect(failed(last)).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: { branches: TOO_MANY_BRANCHES_MESSAGE },
    });
    expect(Object.keys(failed(last).fields)).toEqual(['branches']);
    expect(ms).toBeLessThan(50);
    expect(db.customer.findUnique).not.toHaveBeenCalled();
  });

  it('edit: 500 branches that each fail are 200 fields, every message clipped', async () => {
    // zod's message for a value outside an enum repeats the value.
    const branches = Array.from({ length: MAX_BRANCHES_PER_EDIT }, (_, i) =>
      validBranch(i, { dayOfVisit: 'x'.repeat(2000), base: { address: null, dayOfVisit: null } })
    );
    const res = failed(
      await submitEditAction(
        editBody({ branches }) as unknown as Parameters<typeof submitEditAction>[0]
      )
    );
    expect(res.code).toBe('VALIDATION_FAILED');
    const messages = Object.values(res.fields);
    expect(messages).toHaveLength(MAX_REPORTED_ISSUES);
    expect(Object.keys(res.fields)[0]).toBe('branch.' + cuid(0) + '.dayOfVisit');
    for (const m of messages) {
      expect(m.length).toBe(MAX_REPORTED_MESSAGE);
      expect(m.endsWith('…')).toBe(true);
    }
    expect(db.customer.findUnique).not.toHaveBeenCalled();
  });

  it('edit: an id too long to be real is not repeated in the key of each field that fails', async () => {
    const longId = 'c' + 'x'.repeat(100_000); // z.string().cuid() takes it
    const branch = { branchId: longId, branchName: 1, address: 1, openingHours: 1, base: {} };
    const res = failed(
      await submitEditAction(
        editBody({ branches: [branch] }) as unknown as Parameters<typeof submitEditAction>[0]
      )
    );
    expect(Object.keys(res.fields)).toEqual([
      'branches.0.branchName',
      'branches.0.address',
      'branches.0.openingHours',
    ]);
    expect(JSON.stringify(res.fields).length).toBeLessThan(1000);
    // A real id still names the key, so the form shows the error by its field.
    const real = failed(
      await submitEditAction(
        editBody({ branches: [{ ...branch, branchId: cuid(0) }] }) as unknown as Parameters<
          typeof submitEditAction
        >[0]
      )
    );
    expect(Object.keys(real.fields)[0]).toBe('branch.' + cuid(0) + '.branchName');
  });

  it('create: 1,000,000 empty branches is refused in under 50 ms', async () => {
    const one = await submitCreateAction(
      createBody({
        branches: Array.from({ length: MAX_CREATE_BRANCHES + 1 }, () => ({})),
      }) as unknown as Parameters<typeof submitCreateAction>[0]
    );
    expect(failed(one).fields).toEqual({ branches: TOO_MANY_CREATE_BRANCHES_MESSAGE });
    const body = createBody({ branches: Array.from({ length: MILLION }, () => ({})) });
    const { ms, last } = await fastestAsyncMs(() =>
      submitCreateAction(body as unknown as Parameters<typeof submitCreateAction>[0])
    );
    expect(failed(last)).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: { branches: TOO_MANY_CREATE_BRANCHES_MESSAGE },
    });
    expect(Object.keys(failed(last).fields)).toEqual(['branches']);
    expect(ms).toBeLessThan(50);
    expect(db.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('create: a message that repeats a long value is clipped', async () => {
    const res = failed(
      await submitCreateAction(
        createBody({
          customer: { legalName: 'Al Noor Trading', paymentTerms: 'x'.repeat(2000) },
        }) as unknown as Parameters<typeof submitCreateAction>[0]
      )
    );
    expect(Object.keys(res.fields)).toEqual(['customer.paymentTerms']);
    expect(res.fields['customer.paymentTerms']).toHaveLength(MAX_REPORTED_MESSAGE);
    expect(db.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('every array in the two payloads is capped (structural)', () => {
  // Whitespace removed, so a call split over lines still reads as one.
  const compact = (f: string) =>
    [...stripComments(readFileSync(f, 'utf8'), f)].filter((c) => c.trim() !== '').join('');
  const count = (s: string, needle: string) => s.split(needle).length - 1;

  it.each(['lib/validation/edit.ts', 'lib/validation/create.ts'])(
    '%s: each z.array sits in cappedArray',
    (f) => {
      const src = compact(f);
      expect(count(src, 'z.array(')).toBeGreaterThan(0);
      expect(count(src, '.array(')).toBe(count(src, 'z.array('));
      expect(count(src, 'cappedArray(z.array(')).toBe(count(src, 'z.array('));
    }
  );
});
