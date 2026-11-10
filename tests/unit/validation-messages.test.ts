// @vitest-environment node
/**
 * What a user is told when a form, an upload, an export or a sign-in is refused,
 * and what an accepted one is read as — held to a record taken under zod 3.25.76,
 * before zod is upgraded to 4 (GHSA-mrhx-c7xc-m3w5).
 *
 * Why: zod writes the words of most refusals here, not this code. The routes
 * form shows "String must contain at least 2 character(s)" (backoffice.spec.ts
 * reads it), a value outside a list is answered with zod's "Invalid enum value"
 * sentence, and each service turns zod's issues into the form's field slots by
 * its own rule (the last issue on a key wins; a branch's GPS columns share one
 * slot; the signed-form upload reads the first issue and its code). Zod 4 words
 * every message differently, orders and stops issues differently, and treats an
 * absent key, a default and a union differently — any of which can change a
 * message under a field, which field it is under, or whether a body is accepted.
 *
 * How: every case drives the REAL consumer — the server action, the route
 * handler or the pure parser that reads the schema — with the database, the
 * session and the network replaced, and records what comes back:
 *   - the answer (a refusal's code, message and fields, in their order; a
 *     route's status and body, `details` included);
 *   - for a body that is accepted, what it was read as: the parsed value for the
 *     two payload schemas (keys that are present but undefined are marked, and
 *     so are Dates), and for the services whose schemas are private ('use
 *     server' modules export async functions only), the database calls the
 *     action made up to its first write — the write's `data` is the parsed form,
 *     and every write is stopped there (StopAtWrite), so nothing past it runs.
 * The record (fixtures/validation-messages.zod3.json) was generated once, under
 * zod 3.25.76 at a454239, by a script that is not part of the repository. This
 * file has no mode that writes it: a difference is a change in what users see,
 * to be explained, not re-recorded. The case ids must equal the record's, so a
 * case cannot be dropped to make the suite pass.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';

type Reads = Record<string, unknown>;
type Actor = { id: string; role: string; username: string; mustChangePassword?: boolean };

const h = vi.hoisted(() => {
  /** Thrown by every database write: the case ends there, and the write's `data` is recorded. */
  class StopAtWrite extends Error {
    constructor(public readonly at: string) {
      super(`stopped at ${at}`);
      this.name = 'StopAtWrite';
    }
  }
  return {
    StopAtWrite,
    user: null as unknown as { id: string; role: string; username: string },
    calls: [] as Array<[string, unknown]>,
    reads: {} as Record<string, unknown>,
  };
});

vi.mock('@/lib/db', () => {
  const WRITE = /^(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)$/;
  const pick = (args: unknown) => {
    if (!args || typeof args !== 'object') return args;
    const a = args as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if ('where' in a) out.where = a.where;
    if ('data' in a) out.data = a.data;
    return out;
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return async (args?: unknown) => {
            const key = `${name}.${method}`;
            h.calls.push([key, pick(args)]);
            if (WRITE.test(method)) throw new h.StopAtWrite(key);
            if (key in h.reads) {
              const r = h.reads[key];
              return typeof r === 'function' ? (r as (a: unknown) => unknown)(args) : structuredClone(r);
            }
            return method === 'findMany' ? [] : method === 'count' ? 0 : null;
          };
        },
      }
    );
  const prisma: unknown = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined;
        if (name === '$transaction') {
          return async (fn: unknown) =>
            typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(prisma) : Promise.all(fn as unknown[]);
        }
        if (name.startsWith('$')) {
          return async () => {
            h.calls.push([name, null]);
            return [];
          };
        }
        return model(name);
      },
    }
  );
  return { prisma, directPrisma: prisma };
});
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: h.user }),
  signIn: async (provider: string, opts: Record<string, unknown>) => {
    h.calls.push(['signIn', { provider, ...opts }]);
  },
  signOut: async () => {},
  handlers: {},
}));
// app/actions/auth.ts takes AuthError from next-auth, whose own import of next/server does not resolve under vitest.
vi.mock('next-auth', async () => {
  const errors = await import('@auth/core/errors');
  return { AuthError: errors.AuthError, CredentialsSignin: errors.CredentialsSignin, default: () => ({}) };
});
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '10.0.0.1', 'user-agent': 'unit' }),
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
  notFound: () => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });
  },
}));
vi.mock('@/lib/logger', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => logger };
  return { logger };
});
vi.mock('@/lib/audit', async (orig) => ({
  ...(await orig<typeof import('@/lib/audit')>()),
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: async (_tx: unknown, _env: unknown, row: unknown) => {
    h.calls.push(['writeAudit', row]);
  },
}));
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  checkLimit: async () => ({ ok: true, retryAfterSec: 0 }),
}));
vi.mock('@/lib/change-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/change-context')>()),
  setChangeContext: async () => {},
  withChangeContext: async (client: unknown, _cause: unknown, fn: (tx: unknown) => unknown) => fn(client),
}));
vi.mock('bcryptjs', () => {
  const compare = async (plain: string, hashed: string) => {
    h.calls.push(['bcrypt.compare', plain]);
    return hashed === `hash:${plain}`;
  };
  const hash = async (plain: string) => `hash:${plain}`;
  return { default: { compare, hash }, compare, hash };
});
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_client: unknown, cmd: { input: unknown }) => {
    h.calls.push(['r2.presign', cmd.input]);
    return 'https://r2.example/signed';
  },
}));
vi.mock('@/lib/r2', () => ({
  R2_BUCKET: 'bucket',
  r2: () => ({
    send: async (cmd: { input: unknown }) => {
      h.calls.push(['r2.send', cmd.input]);
      return { ContentLength: 1000, ContentType: 'image/jpeg', LastModified: new Date('2026-10-20T07:59:00.000Z') };
    },
  }),
}));
vi.mock('@/services/exports', () => ({
  buildCustomerExport: async (filters: unknown) => {
    h.calls.push(['buildCustomerExport', filters]);
    return { bytes: new Uint8Array([80, 75]), filename: 'customers.xlsx' };
  },
}));
vi.mock('@/lib/change-report', () => ({
  buildChangeReport: async (_user: unknown, filters: { includeTest?: boolean }) => {
    h.calls.push(['buildChangeReport', filters]);
    return {
      bytes: new Uint8Array([80, 75]),
      filename: 'changes.xlsx',
      rowCount: 0,
      changedRows: 0,
      changeCount: 0,
      customerIds: [],
      includeTest: filters.includeTest === true,
    };
  },
}));
vi.mock('@/lib/export-record', () => ({ recordExport: async () => ({}) }));
vi.mock('@/lib/export-scope', () => ({ requireExportUser: async () => h.user }));
vi.mock('@/lib/print-load', () => ({
  loadCreditApplicationPrint: async (_user: unknown, id: string) => {
    h.calls.push(['loadCreditApplicationPrint', id]);
    return null;
  },
  loadCustomerFormPrint: async (_user: unknown, id: string) => {
    h.calls.push(['loadCustomerFormPrint', id]);
    return null;
  },
}));

import { submitEditSchema, type ParsedSubmitEdit } from '@/lib/validation/edit';
import {
  collectAttachmentIds,
  collectMissingForCreate,
  submitCreateSchema,
  type ParsedSubmitCreate,
} from '@/lib/validation/create';
import { BRANCH_EDIT_FIELDS, CUSTOMER_EDIT_FIELDS, EDIT_PAYLOAD_VERSION } from '@/lib/edit-values';
import { CREDIT_DOCUMENT_KINDS, MAX_SIGNED_FORM_PAGES } from '@/lib/credit-documents';
import { parseCreateCopy, parseSignedPagesCopy } from '@/lib/create-draft';
import { parseSubmitGate } from '@/lib/edit-scope';
import {
  gpsManualReasonSchema,
  hasManualGps,
  manualGpsReasonForBranch,
  manualGpsReasonForPoint,
} from '@/lib/gps-manual';
import { submissionIdSchema } from '@/lib/submission';
import { submitEditAction } from '@/services/edits';
import { submitCreateAction } from '@/services/creates';
import {
  createUserAction,
  resetPasswordAction,
  updateUserAccountAction,
  updateUserEmailAction,
  updateUserRoleAction,
} from '@/services/users';
import { createRegionAction, createRouteAction } from '@/services/routes';
import { changeOwnPasswordAction } from '@/services/password';
import { attachPhotoAction, detachPhotoAction } from '@/services/photos';
import { submitSignedFormAction } from '@/services/signed-form';
import { recordPrintAction } from '@/services/prints';
import { loginAction } from '@/app/actions/auth';
import { POST as presignPOST } from '@/app/api/photos/presign/route';
import { POST as finalizePOST } from '@/app/api/photos/finalize/route';
import { GET as customersExportGET } from '@/app/api/exports/customers/route';
import { GET as changesExportGET } from '@/app/api/exports/changes/route';

// ─── what a case records ──────────────────────────────────────────────────────

/**
 * JSON for anything a case returns. undefined, NaN, ±Infinity and -0 would be
 * lost or merged by JSON, so each is a marker; a Date is its ISO time or
 * 'Invalid Date'; a string longer than 300 characters (zod's messages repeat a
 * long input) is its length, its two ends and its SHA-256.
 */
function ser(v: unknown): unknown {
  if (v === undefined) return '$undefined';
  if (typeof v === 'string') {
    if (v.length <= 300) return v;
    return { $string: v.length, head: v.slice(0, 80), tail: v.slice(-40), sha256: createHash('sha256').update(v).digest('hex') };
  }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '$NaN';
    if (v === Infinity) return '$Infinity';
    if (v === -Infinity) return '$-Infinity';
    if (Object.is(v, -0)) return '$-0';
    return v;
  }
  if (typeof v === 'bigint' || typeof v === 'symbol' || typeof v === 'function') return `$${typeof v}`;
  if (v instanceof Date) return { $date: Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString() };
  if (v instanceof Uint8Array) return { $bytes: v.length };
  if (Array.isArray(v)) return v.map(ser);
  if (v && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    const out: Record<string, unknown> =
      proto === Object.prototype || proto === null ? {} : { $class: (proto as { constructor?: { name?: string } })?.constructor?.name };
    for (const [k, x] of Object.entries(v)) out[k] = ser(x);
    return out;
  }
  return v;
}

type Case = { id: string; as: Actor; reads: Reads; run: () => Promise<unknown> };
const CASES: Case[] = [];
const ids = new Set<string>();
function add(id: string, as: Actor, run: () => Promise<unknown>, reads: Reads = {}) {
  if (ids.has(id)) throw new Error(`two cases are called ${id}`);
  ids.add(id);
  CASES.push({ id, as, reads, run });
}

/** What a payload case's schema read the body as (edit / create below); null for the other cases. */
const parsedRecord: { current: { value: unknown } | null } = { current: null };
// Read through a call: observe() clears it and a case's closure sets it, and TypeScript's
// narrowing after the clear cannot see the closure.
const recordedParse = () => parsedRecord.current;

/** Run one case and return its record. */
async function observe(c: Case): Promise<unknown> {
  h.user = { ...c.as };
  h.reads = c.reads;
  h.calls = [];
  parsedRecord.current = null;
  let out: Record<string, unknown>;
  try {
    out = { answer: await c.run() };
  } catch (e) {
    if (e instanceof h.StopAtWrite) out = { stoppedAt: e.at };
    else if (e && typeof e === 'object' && typeof (e as { digest?: unknown }).digest === 'string') {
      out = { signal: (e as { digest: string }).digest };
    } else out = { threw: String(e) };
  }
  const rec = recordedParse();
  if (rec) out.parsed = rec.value;
  if (h.calls.length > 0) out.calls = h.calls;
  return ser(out);
}

async function reply(res: Response) {
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') ? await res.json() : `$${type}` };
}

// ─── inputs ───────────────────────────────────────────────────────────────────

type Input = readonly [label: string, value: unknown];
const ABSENT = Symbol('absent');
const rep = (n: number, ch = 'a') => ch.repeat(Math.max(0, n));
/** A copy of `o` with `k` set to `v`, or without `k` when `v` is ABSENT. */
function put(o: Record<string, unknown>, k: string, v: unknown): Record<string, unknown> {
  const c = { ...o };
  if (v === ABSENT) delete c[k];
  else c[k] = v;
  return c;
}

/** Every field is also sent as each of these. 'absent' only where the key is required. */
const BASICS: Input[] = [
  ['undefined', undefined],
  ['null', null],
  ['number', 7],
  ['zero', 0],
  ['boolean', true],
  ['object', {}],
  ['array', []],
  ['empty', ''],
  ['spaces', '  '],
  ['tags-only', '<b></b>'],
];
const REQUIRED: Input[] = [['absent', ABSENT], ...BASICS];

function textInputs(min: number, max: number, rawMax = 2 * max): Input[] {
  return [
    ...BASICS,
    ...(min > 1 ? [[`len-${min - 1}`, rep(min - 1)] as const] : []),
    ...(min > 0 ? [[`len-${min}`, rep(min)] as const] : []),
    [`len-${max}`, rep(max)],
    [`len-${max + 1}`, rep(max + 1)],
    ['tags-around-max', `<b>${rep(max)}</b>`],
    ['tags-around-min', `<b>${rep(min)}</b>`],
    [`raw-${rawMax}-one-tag`, `<${rep(rawMax - 2, 'x')}>`],
    [`raw-${rawMax + 1}`, rep(rawMax + 1, 'x')],
    ['padded', '  Al Noor  '],
    ['inner-tag', '<i>Al</i> Noor'],
    ['unclosed', '<<<abc'],
    ['arabic', 'النور'],
  ];
}
function numberInputs(min: number, max: number): Input[] {
  return [
    ...BASICS,
    ['minus-1', -1],
    ['1.5', 1.5],
    ['minus-1.5', -1.5],
    ['1e20', 1e20],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['minus-Infinity', -Infinity],
    ['min', min],
    ['max', max],
    ['below-min', min - 0.5],
    ['above-max', max + 0.5],
    ['max-plus-1', max + 1],
    ['unsafe-int', 2 ** 53 + 2],
    ['str-5', '5'],
    ['str-1.5', '1.5'],
    ['str-minus-1', '-1'],
    ['str-abc', 'abc'],
    ['str-arabic', '٥٠٠'],
    ['str-Infinity', 'Infinity'],
    ['str-1e400', '1e400'],
    ['str-padded', ' 10 '],
  ];
}
function enumInputs(values: readonly string[]): Input[] {
  return [
    ...BASICS,
    ...values.map((v) => [`is-${v}`, v] as const),
    ['lower', values[0]!.toLowerCase()],
    ['padded', ` ${values[0]} `],
    ['bad', 'x'],
    ['long-2000', rep(2000, 'x')],
    ['quote', "it's"],
  ];
}
const BOOLS: Input[] = [...BASICS, ['false', false], ['str-true', 'true'], ['one', 1]];
const VALID_CUID = 'ckvalid000000000000000001';
const CUIDS: Input[] = [
  ...BASICS,
  ['valid', VALID_CUID],
  ['abc', 'abc'],
  ['upper-C-9', 'C12345678'],
  ['c-8', 'c1234567'],
  ['c-9', 'c12345678'],
  ['nbsp', 'c1234 5678'],
  ['space', 'c1234 5678'],
  ['hyphen', 'c1234-5678'],
  ['newline-end', 'c12345678\n'],
  ['uuid', 'a3bb189e-8bf9-4888-9912-ace4e6543002'],
  ['long', 'c' + rep(100_000, 'x')],
];
const V4 = 'a3bb189e-8bf9-4888-9912-ace4e6543002';
const UUIDS: Input[] = [
  ...BASICS,
  ['v4', V4],
  ['v4-upper', V4.toUpperCase()],
  ['nil', '00000000-0000-0000-0000-000000000000'],
  ['max', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
  ['v1', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
  ['v7', '0190a5e4-6b7a-7cc3-8f3e-1b2c3d4e5f60'],
  ['bad-variant', 'a3bb189e-8bf9-4888-c912-ace4e6543002'],
  ['no-hyphens', 'a3bb189e8bf948889912ace4e6543002'],
  ['braces', `{${V4}}`],
  ['not-hex', 'g3bb189e-8bf9-4888-9912-ace4e6543002'],
  ['newline-end', `${V4}\n`],
  ['short', V4.slice(0, -1)],
];
const EMAILS: Input[] = [
  ['plain', 'a@b.co'],
  ['padded-upper', '  A.Name@Example.COM  '],
  ['upper', 'A@B.CO'],
  ['double-dot', 'a..b@x.com'],
  ['lead-dot', '.a@x.com'],
  ['dot-before-at', 'a.@x.com'],
  ['no-tld', 'a@x'],
  ['one-letter-tld', 'a@x.c'],
  ['plus', 'a+tag@x.com'],
  ['apostrophe', "o'neil@x.com"],
  ['domain-lead-hyphen', 'a@-x.com'],
  ['domain-trail-hyphen', 'a@x-.com'],
  ['trailing-dot', 'a@x.com.'],
  ['ip-literal', 'a@[1.2.3.4]'],
  ['unicode-local', 'ü@x.com'],
  ['unicode-domain', 'a@ü.com'],
  ['inner-space', 'a b@x.com'],
  ['newline-end', 'a@b.co\n'],
  ['angle', '<a@x.com>'],
  ['quote', 'a"b@x.com'],
  ['percent', 'a%b@x.com'],
  ['digit-tld', 'a@x.c0m'],
  ['two-at', 'a@b@x.com'],
  ['subdomains', 'a@mail.x.co.om'],
  ['len-200', `${rep(188)}@example.com`],
  ['len-201', `${rep(189)}@example.com`],
  ['len-254', `${rep(242)}@example.com`],
  ['len-255', `${rep(243)}@example.com`],
];
const PHONES: Input[] = [
  ...BASICS,
  ['local-8', '91234567'],
  ['plus968', '+968 9123 4567'],
  ['968-no-plus', '96891234567'],
  ['00968', '0096891234567'],
  ['arabic-digits', '٩١٢٣٤٥٦٧'],
  ['persian-digits', '۹۱۲۳۴۵۶۷'],
  ['letters', 'call 91234567'],
  ['short', '9123'],
  ['landline', '24123456'],
  ['len-41', rep(41, '9')],
  ['padded', ' 91234567 '],
];
const CR_NUMBERS: Input[] = [
  ...BASICS,
  ['len-50', rep(50, '1')],
  ['len-51', rep(51, '1')],
  ['padded', '  CR-123  '],
  ['inner-space', 'CR 123'],
  ['tags', '<b>1</b>'],
  ['arabic-digits', '١٢٣٤'],
];
const DATETIMES: Input[] = [
  ...BASICS,
  ['Z', '2026-10-20T08:00:00Z'],
  ['offset-colon', '2026-10-20T08:00:00+04:00'],
  ['offset-no-colon', '2026-10-20T08:00:00+0400'],
  ['offset-hours', '2026-10-20T08:00:00+04'],
  ['offset-99', '2026-10-20T08:00:00+99:99'],
  ['minus-offset', '2026-10-20T08:00:00-05:30'],
  ['no-seconds-Z', '2026-10-20T08:00Z'],
  ['no-seconds-offset', '2026-10-20T08:00+04:00'],
  ['ms', '2026-10-20T08:00:00.123Z'],
  ['ns', '2026-10-20T08:00:00.123456789Z'],
  ['no-zone', '2026-10-20T08:00:00'],
  ['date-only', '2026-10-20'],
  ['lower-case', '2026-10-20t08:00:00z'],
  ['space-separated', '2026-10-20 08:00:00Z'],
  ['feb-30', '2026-02-30T08:00:00Z'],
  ['leap-day', '2024-02-29T08:00:00Z'],
  ['non-leap-day', '2026-02-29T08:00:00Z'],
  ['hour-24', '2026-10-20T24:00:00Z'],
  ['five-digit-year', '+02026-10-20T08:00:00Z'],
  ['words', 'yesterday'],
  ['date-object', new Date('2026-10-20T08:00:00.000Z')],
  ['invalid-date-object', new Date('x')],
  ['epoch-ms', 1760947200000],
];
/** The day filters of the two exports ("YYYY-MM-DD"), as query text. */
const DAYS: Input[] = [
  ['plain', '2026-09-30'],
  ['leap-day', '2024-02-29'],
  ['non-leap-day', '2026-02-29'],
  ['century-non-leap', '1900-02-29'],
  ['century-leap', '2000-02-29'],
  ['apr-31', '2026-04-31'],
  ['month-13', '2026-13-01'],
  ['month-00', '2026-00-10'],
  ['day-00', '2026-01-00'],
  ['one-digit-month', '2026-1-01'],
  ['datetime', '2026-09-30T00:00:00Z'],
  ['padded', ' 2026-09-30'],
  ['year-0', '0000-01-01'],
  ['year-9999', '9999-12-31'],
  ['slashes', '2026/09/30'],
  ['empty', ''],
  ['words', 'today'],
];
const REASONS: Input[] = [
  ...textInputs(5, 500, 2000),
  ['tags-make-it-short', '<b>abcd</b>'],
];

/** An array of ids capped at `cap`, as cappedArray and the plain `.max()` arrays take it. */
function idArrays(cap: number, valid: (i: number) => string = (i) => `ckarr${String(i).padStart(20, '0')}`): Input[] {
  const ok = (n: number) => Array.from({ length: n }, (_, i) => valid(i));
  return [
    ...BASICS.filter(([l]) => l !== 'array'),
    ['none', []],
    ['one', ok(1)],
    [`at-cap-${cap}`, ok(cap)],
    [`over-cap-${cap + 1}`, ok(cap + 1)],
    ['over-cap-one-bad', [...ok(cap), 'bad']],
    ['at-cap-one-bad', [...ok(cap - 1), 'bad']],
    ['one-bad', ['bad']],
    ['two-bad', ['bad1', 'bad2']],
    ['null-element', [null]],
    ['number-element', [1]],
    ['duplicate', [valid(0), valid(0)]],
    ['string-not-array', 'x'],
  ];
}

// ─── actors and canned reads ──────────────────────────────────────────────────

const SALESMAN: Actor = { id: 'usales01', role: 'SALESMAN', username: 'c4' };
const STEWARD: Actor = { id: 'ckstewardactor0000000001', role: 'STEWARD', username: 'steward.one' };
const SUPERVISOR: Actor = { id: 'cksupervisor000000000001', role: 'SUPERVISOR', username: 'sup.one' };
const VIEWER: Actor = { id: 'ckviewer0000000000000001', role: 'VIEWER', username: 'viewer.one' };

// ─── the customer UPDATE payload: lib/validation/edit.ts through submitEditAction ─

const CUSTOMER_ID = 'ckcustomer00000000000001';
const BRANCH_A = 'ckbrancha000000000000001';
const BRANCH_B = 'ckbranchb000000000000002';
const editBody = (over: Record<string, unknown> = {}) => ({
  v: EDIT_PAYLOAD_VERSION,
  customerId: CUSTOMER_ID,
  customer: {},
  customerBase: {},
  branches: [] as unknown[],
  ...over,
});
const POINT = { gpsLat: 23.6, gpsLng: 58.4, gpsAccuracy: 5, gpsCapturedAt: '2026-10-20T08:00:00Z' };
const POINT_BASE = { gpsLat: null, gpsLng: null };

const editWhole = (d: ParsedSubmitEdit) => ({
  ...d,
  branches: d.branches.length > 2 ? { $count: d.branches.length, first: d.branches[0] } : d.branches,
});
function edit(body: () => Record<string, unknown>, part: (d: ParsedSubmitEdit) => unknown = editWhole) {
  return async () => {
    const r = submitEditSchema.safeParse(body());
    parsedRecord.current = { value: r.success ? part(r.data) : '$refused' };
    return submitEditAction(body() as never);
  };
}

const EDIT_CUSTOMER_FIELDS: Array<[string, Input[]]> = [
  ['legalName', textInputs(2, 200)],
  ['paymentTerms', enumInputs(['CASH', 'CREDIT'])],
  ['crNumber', CR_NUMBERS],
  ['channelId', CUIDS],
  ['subChannelId', CUIDS],
  ['primaryPhone', PHONES],
  ['altPhone', PHONES],
  ['contactPerson', textInputs(2, 200)],
  ['contactRole', textInputs(0, 200)],
  ['status', enumInputs(['ACTIVE', 'CLOSED', 'SUSPENDED'])],
  ['notes', textInputs(0, 5000)],
];
for (const [f, inputs] of EDIT_CUSTOMER_FIELDS) {
  for (const [label, value] of inputs) {
    add(
      `edit.customer.${f}/${label}`,
      SALESMAN,
      edit(
        () => editBody({ customer: put({}, f, value), customerBase: { [f]: null } }),
        (d) => d.customer
      )
    );
  }
}

const DAYS_OF_WEEK = ['SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI'];
const EDIT_BRANCH_FIELDS: Array<[string, Input[]]> = [
  ['branchName', textInputs(1, 200)],
  ['address', textInputs(3, 500)],
  ['areaDescription', textInputs(0, 500)],
  ['gpsLat', numberInputs(16, 27)],
  ['gpsLng', numberInputs(51, 61)],
  ['gpsAccuracy', numberInputs(0, 10000)],
  ['gpsCapturedAt', DATETIMES],
  ['gpsManualReason', REASONS],
  ['dayOfVisit', enumInputs(DAYS_OF_WEEK)],
  ['openingHours', textInputs(0, 100)],
  ['deliveryWindow', textInputs(0, 100)],
  ['coolersCount', numberInputs(0, 100)],
  ['standsCount', numberInputs(0, 100)],
  ['emptyBottlesCount', numberInputs(0, 1000)],
  ['equipmentConfirmed', BOOLS],
  ['status', enumInputs(['ACTIVE', 'CLOSED', 'SUSPENDED'])],
];
const GPS_FIELDS = new Set(['gpsLat', 'gpsLng', 'gpsAccuracy', 'gpsCapturedAt', 'gpsManualReason']);
for (const [f, inputs] of EDIT_BRANCH_FIELDS) {
  for (const [label, value] of inputs) {
    add(
      `edit.branch.${f}/${label}`,
      SALESMAN,
      edit(
        () => editBody({ branches: [put({ branchId: BRANCH_A, base: { [f]: null } }, f, value)] }),
        (d) => d.branches[0]
      )
    );
    // The location travels whole: the same value inside a complete point.
    if (GPS_FIELDS.has(f)) {
      add(
        `edit.branch.in-point.${f}/${label}`,
        SALESMAN,
        edit(
          () => editBody({ branches: [put({ branchId: BRANCH_A, ...POINT, base: POINT_BASE }, f, value)] }),
          (d) => d.branches[0]
        )
      );
    }
  }
}
for (const [label, value] of [['absent', ABSENT] as const, ...CUIDS]) {
  add(
    `edit.branch.branchId/${label}`,
    SALESMAN,
    edit(
      () => editBody({ branches: [put({ address: 'Way 1', base: { address: null } }, 'branchId', value)] }),
      (d) => d.branches[0]
    )
  );
}
const BASES: Input[] = [
  ...REQUIRED,
  ['address-object', { address: {} }],
  ['address-array', { address: [] }],
  ['address-number', { address: 1 }],
  ['address-boolean', { address: false }],
  ['address-string', { address: 'Old way' }],
  ['address-undefined', { address: undefined }],
  ['address-date', { address: new Date('2026-10-20T08:00:00.000Z') }],
  ['unknown-key', { address: null, nope: 1 }],
  ['other-field-only', { branchName: null }],
];
for (const [label, value] of BASES) {
  add(
    `edit.branch.base/${label}`,
    SALESMAN,
    edit(
      () => editBody({ branches: [put({ branchId: BRANCH_A, address: 'Way 1' }, 'base', value)] }),
      (d) => d.branches[0]
    )
  );
}
const overrideArrays = (fields: readonly string[], one: string): Input[] => [
  ...BASICS.filter(([l]) => l !== 'array'),
  ['none', []],
  ['one', [one]],
  [`all-${fields.length}`, [...fields]],
  [`over-cap-${fields.length + 1}`, [...fields, one]],
  ['over-cap-one-bad', [...fields, 'nope']],
  ['at-cap-one-bad', [...fields.slice(1), 'nope']],
  ['one-bad', ['nope']],
  ['number-element', [1]],
  ['lower-case', [one.toUpperCase()]],
  ['string-not-array', one],
];
for (const [label, value] of overrideArrays(BRANCH_EDIT_FIELDS, 'address')) {
  add(
    `edit.branch.overrides/${label}`,
    SALESMAN,
    edit(
      () => editBody({ branches: [put({ branchId: BRANCH_A, address: 'Way 1', base: { address: null } }, 'overrides', value)] }),
      (d) => d.branches[0]
    )
  );
}
for (const [label, value] of overrideArrays(CUSTOMER_EDIT_FIELDS, 'notes')) {
  add(`edit.customerOverrides/${label}`, SALESMAN, edit(() => put(editBody(), 'customerOverrides', value)));
}
for (const [label, value] of CUIDS) {
  add(`edit.customerId/${label}`, SALESMAN, edit(() => put(editBody(), 'customerId', value)));
}
add('edit.customerId/absent', SALESMAN, edit(() => put(editBody(), 'customerId', ABSENT)));
for (const [label, value] of BOOLS) {
  add(`edit.isDraft/${label}`, SALESMAN, edit(() => put(editBody(), 'isDraft', value)));
}
add('edit.isDraft/absent', SALESMAN, edit(() => put(editBody(), 'isDraft', ABSENT)));
for (const [label, value] of UUIDS) {
  add(`edit.submissionId/${label}`, SALESMAN, edit(() => put(editBody(), 'submissionId', value)));
}
for (const [label, value] of [...REQUIRED, ['string', 'x'] as const]) {
  add(`edit.customer/${label}`, SALESMAN, edit(() => put(editBody(), 'customer', value)));
  add(`edit.customerBase/${label}`, SALESMAN, edit(() => put(editBody(), 'customerBase', value)));
}
add('edit.customerBase/legalName-object', SALESMAN, edit(() => editBody({ customer: { legalName: 'Al Noor' }, customerBase: { legalName: {} } })));
add('edit.customerBase/unknown-key', SALESMAN, edit(() => editBody({ customerBase: { nope: 1 } })));
add('edit.customerBase/missing-for-sent-key', SALESMAN, edit(() => editBody({ customer: { legalName: 'Al Noor' } })));
for (const [label, value] of [['v-absent', ABSENT], ['v-1', 1], ['v-3', 3], ['v-string', String(EDIT_PAYLOAD_VERSION)], ['v-null', null]] as const) {
  add(`edit.v/${label}`, SALESMAN, edit(() => put(editBody(), 'v', value)));
}
const validBranch = (id: string, over: Record<string, unknown> = {}) => ({ branchId: id, address: 'Way 1', base: { address: null }, ...over });
const manyBranches = (n: number) => Array.from({ length: n }, (_, i) => validBranch('ckbr' + String(i).padStart(21, '0')));
const EDIT_BRANCH_ARRAYS: Input[] = [
  ...REQUIRED.filter(([l]) => l !== 'array'),
  ['none', []],
  ['one', [validBranch(BRANCH_A)]],
  ['two', [validBranch(BRANCH_A), validBranch(BRANCH_B)]],
  ['at-cap-500', manyBranches(500)],
  ['over-cap-501', manyBranches(501)],
  ['over-cap-501-one-bad', [...manyBranches(500), { branchId: 1 }]],
  ['at-cap-500-one-bad', [...manyBranches(499), { branchId: 1 }]],
  ['null-element', [null]],
  ['number-element', [1]],
  ['string-element', ['x']],
  ['empty-element', [{}]],
  ['string-not-array', 'x'],
];
for (const [label, value] of EDIT_BRANCH_ARRAYS) {
  add(`edit.branches/${label}`, SALESMAN, edit(() => put(editBody(), 'branches', value)));
}
// Unknown keys, at each of the three strict levels.
add('edit.unknown-key/top', SALESMAN, edit(() => editBody({ nope: 1 })));
add('edit.unknown-key/top-two', SALESMAN, edit(() => editBody({ zeta: 1, alpha: 2 })));
add('edit.unknown-key/customer', SALESMAN, edit(() => editBody({ customer: { nope: 1 } })));
add('edit.unknown-key/branch', SALESMAN, edit(() => editBody({ branches: [validBranch(BRANCH_A, { nope: 1 })] })));
add('edit.unknown-key/all-three', SALESMAN, edit(() => editBody({ nope: 1, customer: { nope: 2 }, branches: [validBranch(BRANCH_A, { nope: 3 })] })));
// The GPS rules, alone.
const gpsBranch = (over: Record<string, unknown>) => editBody({ branches: [{ branchId: BRANCH_A, base: POINT_BASE, ...over }] });
const GPS_SHAPES: Array<[string, Record<string, unknown>]> = [
  ['lat-only', { gpsLat: 23.6 }],
  ['lng-only', { gpsLng: 58.4 }],
  ['point-no-companions', { gpsLat: 23.6, gpsLng: 58.4 }],
  ['point-no-time', { gpsLat: 23.6, gpsLng: 58.4, gpsAccuracy: 5 }],
  ['point-no-accuracy', { gpsLat: 23.6, gpsLng: 58.4, gpsCapturedAt: '2026-10-20T08:00:00Z' }],
  ['point-null-accuracy', { ...POINT, gpsAccuracy: null }],
  ['point-typed', { ...POINT, gpsAccuracy: null, gpsManualReason: 'No signal inside the mall' }],
  ['accuracy-only', { gpsAccuracy: 5 }],
  ['time-only', { gpsCapturedAt: '2026-10-20T08:00:00Z' }],
  ['reason-only', { gpsManualReason: 'No signal inside the mall' }],
  ['all-companions-no-point', { gpsAccuracy: 5, gpsCapturedAt: '2026-10-20T08:00:00Z', gpsManualReason: 'No signal here' }],
  ['point-out-of-oman', { ...POINT, gpsLat: 30, gpsLng: 70 }],
  ['lat-out-no-lng', { gpsLat: 30 }],
  ['lat-out-no-companions', { gpsLat: 30, gpsLng: 58.4 }],
  ['bad-accuracy-no-point', { gpsAccuracy: -1, gpsCapturedAt: 'x' }],
  ['lat-null', { gpsLat: null, gpsLng: 58.4 }],
];
for (const [label, over] of GPS_SHAPES) add(`edit.gps/${label}`, SALESMAN, edit(() => gpsBranch(over)));
// More than one fault in one body.
const COMBOS: Array<[string, () => Record<string, unknown>]> = [
  ['bad-phone+duplicate-branch', () => editBody({ customer: { primaryPhone: '123' }, customerBase: { primaryPhone: null }, branches: [validBranch(BRANCH_A), validBranch(BRANCH_A)] })],
  ['duplicate-branch', () => editBody({ branches: [validBranch(BRANCH_A), validBranch(BRANCH_A)] })],
  ['duplicate-branch+bad-field', () => editBody({ branches: [validBranch(BRANCH_A), validBranch(BRANCH_A, { address: '' })] })],
  ['duplicate-branch+unknown-key', () => editBody({ nope: 1, branches: [validBranch(BRANCH_A), validBranch(BRANCH_A)] })],
  ['duplicate-branch+bad-customerId', () => editBody({ customerId: 'abc', branches: [validBranch(BRANCH_A), validBranch(BRANCH_A)] })],
  ['unknown-key+gps-pair', () => gpsBranch({ gpsLat: 23.6, nope: 1 })],
  ['raw-too-long+gps-pair', () => gpsBranch({ address: rep(1001, 'x'), gpsLat: 23.6, base: { ...POINT_BASE, address: null } })],
  ['wrong-type+gps-pair', () => gpsBranch({ branchName: 5, gpsLat: 23.6, base: { ...POINT_BASE, branchName: null } })],
  ['null-required+gps-companions', () => gpsBranch({ branchName: null, gpsAccuracy: 5, base: { branchName: null } })],
  ['bad-count+gps-pair', () => gpsBranch({ coolersCount: -1.5, gpsLng: 58.4, base: { ...POINT_BASE, coolersCount: null } })],
  ['two-counts-bad', () => gpsBranch({ coolersCount: -1.5, standsCount: 101.5, base: { coolersCount: null, standsCount: null } })],
  ['count-and-confirmed-bad', () => gpsBranch({ emptyBottlesCount: 'x', equipmentConfirmed: 'x', base: { emptyBottlesCount: null, equipmentConfirmed: null } })],
  ['short-reason+no-point', () => gpsBranch({ gpsManualReason: 'abc' })],
  ['bad-time+point', () => gpsBranch({ ...POINT, gpsCapturedAt: 'x' })],
  ['two-branches-fail', () => editBody({ branches: [validBranch(BRANCH_A, { address: '' }), validBranch(BRANCH_B, { branchName: null, base: { address: null, branchName: null } })] })],
  ['branch-id-bad+fields-bad', () => editBody({ branches: [{ branchId: 'abc', branchName: 1, address: 1, base: {} }] })],
  ['branch-id-long+fields-bad', () => editBody({ branches: [{ branchId: 'c' + rep(100, 'x'), branchName: 1, base: {} }] })],
  ['branch-id-missing+fields-bad', () => editBody({ branches: [{ branchName: 1, base: {} }] })],
  ['over-cap+bad-customerId', () => editBody({ customerId: 'abc', branches: manyBranches(501) })],
  ['clearable-too-long+unknown', () => editBody({ customer: { notes: rep(5001), nope: 1 }, customerBase: { notes: null } })],
  ['customer-all-bad', () => editBody({ customer: { legalName: null, paymentTerms: null, crNumber: 5, channelId: null, subChannelId: 'abc', primaryPhone: null, altPhone: 'x', contactPerson: '', contactRole: 5, status: 'x', notes: [] }, customerBase: Object.fromEntries(CUSTOMER_EDIT_FIELDS.map((f) => [f, null])) })],
  ['customer-all-set', () => editBody({ customer: { legalName: '<b>Al Noor</b> Trading', paymentTerms: 'CREDIT', crNumber: ' 123 ', channelId: VALID_CUID, subChannelId: '', primaryPhone: '٩١٢٣٤٥٦٧', altPhone: null, contactPerson: 'Ali', contactRole: '<i></i>', status: 'ACTIVE', notes: '' }, customerBase: Object.fromEntries(CUSTOMER_EDIT_FIELDS.map((f) => [f, null])) })],
  ['branch-all-set', () => editBody({ branches: [{ branchId: BRANCH_A, branchName: ' Main ', address: '<p>Way 1</p>', areaDescription: '', ...POINT, gpsCapturedAt: '2026-10-20T08:00:00+04:00', dayOfVisit: 'SUN', openingHours: null, deliveryWindow: '  ', coolersCount: 0, standsCount: 100, emptyBottlesCount: 1000, equipmentConfirmed: false, status: 'CLOSED', overrides: ['address'], base: Object.fromEntries(BRANCH_EDIT_FIELDS.map((f) => [f, null])) }] })],
  ['branch-all-cleared', () => editBody({ branches: [{ branchId: BRANCH_A, branchName: null, address: null, areaDescription: null, gpsLat: null, gpsLng: null, gpsAccuracy: null, gpsCapturedAt: null, dayOfVisit: null, openingHours: null, deliveryWindow: null, coolersCount: null, standsCount: null, emptyBottlesCount: null, equipmentConfirmed: null, status: null, base: Object.fromEntries(BRANCH_EDIT_FIELDS.map((f) => [f, null])) }] })],
];
for (const [label, body] of COMBOS) add(`edit.combo/${label}`, SALESMAN, edit(body));
add('edit.body/null', SALESMAN, edit(() => null as never));
add('edit.body/array', SALESMAN, edit(() => [] as never));

// ─── the new-customer CREATE payload: lib/validation/create.ts through submitCreateAction ─

const CREATE_READS: Reads = { 'user.findUniqueOrThrow': { id: SALESMAN.id, supervisorId: null, ownedRoute: null } };
const createBody = (over: Record<string, unknown> = {}) => ({
  isDraft: true,
  customer: { legalName: 'Al Noor Trading', paymentTerms: 'CASH' },
  branches: [{ branchName: 'Main' }] as unknown[],
  ...over,
});
const createWhole = (d: ParsedSubmitCreate) => ({
  parsed: d,
  missing: collectMissingForCreate(d),
  photos: collectAttachmentIds(d).byKind,
});
/** The named top-level keys of a parsed create body (a key the output lacks is left out), and what the submit gate makes of it. */
const createKeys =
  (...keys: Array<keyof ParsedSubmitCreate>) =>
  (d: ParsedSubmitCreate) => ({
    parsed: Object.fromEntries(keys.filter((k) => k in d).map((k) => [k, d[k]])),
    missing: collectMissingForCreate(d),
    photos: collectAttachmentIds(d).byKind,
  });
function create(body: () => Record<string, unknown>, part: (d: ParsedSubmitCreate) => unknown = createWhole) {
  return async () => {
    const r = submitCreateSchema.safeParse(body());
    parsedRecord.current = { value: r.success ? part(r.data) : '$refused' };
    return submitCreateAction(body() as never);
  };
}
const CREATE_EMAILS: Input[] = [...BASICS, ...EMAILS];
const CREATE_CUSTOMER_FIELDS: Array<[string, Input[]]> = [
  ['legalName', [['absent', ABSENT], ...textInputs(2, 200)]],
  ['paymentTerms', [['absent', ABSENT], ...enumInputs(['CASH', 'CREDIT'])]],
  ['crNumber', CR_NUMBERS],
  ['channelId', CUIDS],
  ['subChannelId', CUIDS],
  ['primaryPhone', PHONES],
  ['altPhone', PHONES],
  ['contactPerson', textInputs(2, 200)],
  ['contactRole', textInputs(0, 200)],
  ['notes', textInputs(0, 5000)],
  ['crPhotoAttachmentId', CUIDS],
  ['email', CREATE_EMAILS],
];
for (const [f, inputs] of CREATE_CUSTOMER_FIELDS) {
  for (const [label, value] of inputs) {
    add(
      `create.customer.${f}/${label}`,
      SALESMAN,
      create(
        () => createBody({ customer: put({ legalName: 'Al Noor Trading', paymentTerms: 'CASH' }, f, value) }),
        (d) => d.customer
      ),
      CREATE_READS
    );
  }
}
add('create.customer/unknown-key', SALESMAN, create(() => createBody({ customer: { legalName: 'Al Noor Trading', paymentTerms: 'CASH', nope: 1 } }), (d) => d.customer), CREATE_READS);
for (const [label, value] of [...REQUIRED, ['string', 'x'] as const]) {
  add(`create.customer/${label}`, SALESMAN, create(() => put(createBody(), 'customer', value)), CREATE_READS);
}
/**
 * What z.coerce.date() takes. Text JavaScript's Date reads in the machine's own
 * zone ('2026-10-20T08:00:00', 'October 20, 2026') is left out where the parsed
 * time is recorded: that is Date's reading, not zod's, and the record must not
 * move with the zone a test runs in. The finalize route ignores the parsed time,
 * so it takes them.
 */
const LOCAL_TIME_TEXT = new Set(['no-zone']);
const COERCED_DATES: Input[] = [
  ...DATETIMES.filter(([l]) => !LOCAL_TIME_TEXT.has(l)),
  ['epoch-zero', 0],
  ['huge-number', 1e20],
];
const COERCED_DATES_ANY_ZONE: Input[] = [
  ...COERCED_DATES,
  ...DATETIMES.filter(([l]) => LOCAL_TIME_TEXT.has(l)),
  ['date-string-words', 'October 20, 2026'],
];
const CREATE_BRANCH_FIELDS: Array<[string, Input[]]> = [
  ['branchName', [['absent', ABSENT], ...textInputs(1, 200)]],
  ['address', textInputs(0, 500)],
  ['areaDescription', textInputs(0, 500)],
  ['gpsLat', numberInputs(16, 27)],
  ['gpsLng', numberInputs(51, 61)],
  ['gpsAccuracy', numberInputs(0, 10000)],
  ['gpsCapturedAt', COERCED_DATES],
  ['gpsManualReason', REASONS],
  ['dayOfVisit', enumInputs(DAYS_OF_WEEK)],
  ['openingHours', textInputs(0, 100)],
  ['deliveryWindow', textInputs(0, 100)],
  ['coolersCount', numberInputs(0, 100)],
  ['standsCount', numberInputs(0, 100)],
  ['emptyBottlesCount', numberInputs(0, 1000)],
  ['shopPhotoAttachmentId', CUIDS],
  ['signboardPhotoAttachmentId', CUIDS],
  ['extraPhotoAttachmentIds', idArrays(10)],
];
for (const [f, inputs] of CREATE_BRANCH_FIELDS) {
  for (const [label, value] of inputs) {
    add(
      `create.branch.${f}/${label}`,
      SALESMAN,
      create(() => createBody({ branches: [put({ branchName: 'Main' }, f, value)] }), (d) => d.branches[0]),
      CREATE_READS
    );
  }
}
add('create.branch/unknown-key', SALESMAN, create(() => createBody({ branches: [{ branchName: 'Main', nope: 1 }] }), (d) => d.branches[0]), CREATE_READS);
const CREDIT_FIELDS: Array<[string, Input[]]> = [
  [
    'requestedCreditLimit',
    [...numberInputs(0, 99_999_999_999), ['three-places', 1.2345], ['arabic-decimal', '١٢٫٥'], ['comma-thousands', '1,000'], ['str-500', '500'], ['persian', '۵۰۰']],
  ],
  ['requestedPaymentTermDays', [...numberInputs(1, 365), ['arabic-30', '٣٠'], ['persian-30', '۳۰']]],
];
for (const [f, inputs] of CREDIT_FIELDS) {
  for (const [label, value] of inputs) {
    add(
      `create.credit.${f}/${label}`,
      SALESMAN,
      create(
        () => createBody({ customer: { legalName: 'Al Noor Trading', paymentTerms: 'CREDIT' }, credit: put({}, f, value) }),
        createKeys('credit')
      ),
      CREATE_READS
    );
  }
}
for (const [label, value] of [...BASICS, ['unknown-key', { nope: 1 }] as const, ['string', 'x'] as const]) {
  add(`create.credit/${label}`, SALESMAN, create(() => createBody({ credit: value }), createKeys('credit')), CREATE_READS);
}
for (const [label, value] of CUIDS) {
  add(`create.editId/${label}`, SALESMAN, create(() => createBody({ editId: value }), createKeys('editId')), CREATE_READS);
}
add('create.editId/valid+bad-field', SALESMAN, create(() => createBody({ editId: VALID_CUID, customer: { legalName: '', paymentTerms: 'CASH' } })), CREATE_READS);
for (const [label, value] of [['absent', ABSENT] as const, ...BOOLS]) {
  add(`create.isDraft/${label}`, SALESMAN, create(() => put(createBody(), 'isDraft', value), createKeys('isDraft')), CREATE_READS);
}
for (const [label, value] of UUIDS) {
  add(`create.submissionId/${label}`, SALESMAN, create(() => createBody({ submissionId: value }), createKeys('submissionId')), CREATE_READS);
}
for (const [label, value] of idArrays(10)) {
  add(
    `create.guaranteeAttachmentIds/${label}`,
    SALESMAN,
    create(() => createBody({ guaranteeAttachmentIds: value }), createKeys('guaranteeAttachmentIds')),
    CREATE_READS
  );
}
/** A cuid-shaped id for page `i` of a kind: 25 characters, distinct per kind and page. */
const page = (k: string, i = 0) =>
  ('ck' + k.toLowerCase().replace(/[^a-z]/g, '').slice(0, 9)).padEnd(11, 'x') + String(i).padStart(14, '0');
const fullDocs = () => Object.fromEntries(CREDIT_DOCUMENT_KINDS.map((k) => [k, [page(k)]]));
const CREDIT_DOCS: Input[] = [
  ['absent', ABSENT],
  ...BASICS,
  ['string', 'x'],
  ['one-kind', { ID_CARD: [page('ID_CARD')] }],
  ['all-kinds', fullDocs()],
  ['kind-null', { ID_CARD: null }],
  ['kind-undefined', { ID_CARD: undefined }],
  ['kind-string', { ID_CARD: 'x' }],
  ['kind-empty', { ID_CARD: [] }],
  ['kind-over-cap', { ID_CARD: Array.from({ length: 5 }, (_, i) => page('ID_CARD', i)) }],
  ['kind-at-cap', { ID_CARD: Array.from({ length: 4 }, (_, i) => page('ID_CARD', i)) }],
  ['kind-bad-page', { ID_CARD: ['bad'] }],
  ['kind-over-cap-bad-page', { TAX_CARD: ['bad', 'bad', 'bad', 'bad', 'bad'] }],
  ['unknown-kind', { PASSPORT: [page('PASSPORT')] }],
];
for (const [label, value] of CREDIT_DOCS) {
  for (const terms of ['CASH', 'CREDIT'] as const) {
    for (const isDraft of [true, false]) {
      add(
        `create.creditDocuments/${label}/${terms}${isDraft ? '/draft' : '/submit'}`,
        SALESMAN,
        create(
          () => put(createBody({ isDraft, customer: { legalName: 'Al Noor Trading', paymentTerms: terms } }), 'creditDocuments', value),
          createKeys('creditDocuments')
        ),
        CREATE_READS
      );
    }
  }
}
const createBranches = (n: number) => Array.from({ length: n }, (_, i) => ({ branchName: `Branch ${i + 1}` }));
const CREATE_BRANCH_ARRAYS: Input[] = [
  ...REQUIRED.filter(([l]) => l !== 'array'),
  ['none', []],
  ['one', createBranches(1)],
  ['at-cap-10', createBranches(10)],
  ['over-cap-11', createBranches(11)],
  ['over-cap-11-one-bad', [...createBranches(10), {}]],
  ['at-cap-10-one-bad', [...createBranches(9), {}]],
  ['null-element', [null]],
  ['empty-element', [{}]],
  ['string-not-array', 'x'],
];
for (const [label, value] of CREATE_BRANCH_ARRAYS) {
  add(`create.branches/${label}`, SALESMAN, create(() => put(createBody(), 'branches', value)), CREATE_READS);
}
const CREATE_COMBOS: Array<[string, () => Record<string, unknown>]> = [
  ['credit-submit-nothing-given', () => createBody({ isDraft: false, customer: { legalName: 'Al Noor Trading', paymentTerms: 'CREDIT' } })],
  ['credit-submit-everything', () => createBody({
    isDraft: false,
    customer: { legalName: 'Al Noor Trading', paymentTerms: 'CREDIT', crNumber: ' 123 ', channelId: VALID_CUID, subChannelId: VALID_CUID, primaryPhone: '91234567', contactPerson: 'Ali', crPhotoAttachmentId: page('CR'), email: ' Ali@Example.COM ' },
    credit: { requestedCreditLimit: '١٢٫٥', requestedPaymentTermDays: '30' },
    creditDocuments: fullDocs(),
    guaranteeAttachmentIds: [page('GUARANTEE')],
    branches: [{ branchName: 'Main', address: 'Way 1', gpsLat: 23.6, gpsLng: 58.4, gpsAccuracy: 150, gpsCapturedAt: '2026-10-20T08:00:00Z', dayOfVisit: 'SUN', shopPhotoAttachmentId: page('SHOP'), signboardPhotoAttachmentId: page('SIGN'), extraPhotoAttachmentIds: [page('FREE')], coolersCount: '2', standsCount: '', emptyBottlesCount: null }],
  })],
  ['bad-phone+bad-gps', () => createBody({ customer: { legalName: 'Al Noor Trading', paymentTerms: 'CASH', primaryPhone: '123' }, branches: [{ branchName: 'Main', gpsLat: 30, gpsManualReason: 'abc' }] })],
  ['lat-only', () => createBody({ branches: [{ branchName: 'Main', gpsLat: 23.6 }] })],
  ['typed-point', () => createBody({ isDraft: false, branches: [{ branchName: 'Main', gpsLat: 23.6, gpsLng: 58.4, gpsAccuracy: 500, gpsManualReason: 'No signal in the mall' }] })],
  ['inaccurate-point', () => createBody({ isDraft: false, branches: [{ branchName: 'Main', gpsLat: 23.6, gpsLng: 58.4, gpsAccuracy: 500 }] })],
  ['unknown-keys-everywhere', () => ({ ...createBody({ branches: [{ branchName: 'Main', nope: 1 }], credit: { nope: 1 } }), nope: 1, customer: { legalName: 'Al Noor Trading', paymentTerms: 'CASH', nope: 1 } })],
  ['two-branches-fail', () => createBody({ branches: [{ branchName: '' }, { branchName: 'B', coolersCount: -1.5, shopPhotoAttachmentId: 'bad' }] })],
  ['everything-wrong', () => ({ editId: 1, isDraft: 'x', customer: { legalName: 1, paymentTerms: 1, email: 1 }, credit: { requestedCreditLimit: -1, requestedPaymentTermDays: 0.5 }, guaranteeAttachmentIds: [1], creditDocuments: { ID_CARD: [1] }, branches: [{ branchName: 1, gpsLat: 'x', coolersCount: 'x' }] })],
];
for (const [label, body] of CREATE_COMBOS) add(`create.combo/${label}`, SALESMAN, create(body), CREATE_READS);
add('create.body/null', SALESMAN, create(() => null as never), CREATE_READS);
add('create.body/empty', SALESMAN, create(() => ({})), CREATE_READS);

// ─── user administration (services/users.ts), routes, passwords: FormData ─────

/** A FormData from fields: ABSENT and undefined are left out, an array is one entry per element. */
function form(fields: Record<string, unknown>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === ABSENT || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) f.append(k, one instanceof Blob ? one : String(one));
  }
  return f;
}
const A_FILE = new Blob(['x'], { type: 'text/plain' });
function formText(min: number, max: number): Input[] {
  return [
    ['absent', ABSENT],
    ['empty', ''],
    ['spaces', '  '],
    ...(min > 1 ? [[`len-${min - 1}`, rep(min - 1)] as const] : []),
    ...(min > 0 ? [[`len-${min}`, rep(min)] as const] : []),
    [`len-${max}`, rep(max)],
    [`len-${max + 1}`, rep(max + 1)],
    ['padded', `  ${rep(Math.max(min, 3))}  `],
    ['file', A_FILE],
  ];
}
const formIds = (): Input[] => [
  ['absent', ABSENT],
  ['empty', ''],
  ['spaces', '  '],
  ['file', A_FILE],
  ...CUIDS.filter(([, v]) => typeof v === 'string' && v !== '' && v !== '  ' && v !== '<b></b>'),
];
const ROLES = ['SALESMAN', 'SUPERVISOR', 'ACCOUNTANT', 'FINANCE_MANAGER', 'GM', 'SALES_DIRECTOR', 'MANAGER', 'STEWARD', 'VIEWER'];
const formEnum = (values: readonly string[]): Input[] => [
  ['absent', ABSENT],
  ['empty', ''],
  ...values.map((v) => [`is-${v}`, v] as const),
  ['lower', values[0]!.toLowerCase()],
  ['padded', ` ${values[0]} `],
  ['bad', 'x'],
  ['long-2000', rep(2000, 'x')],
  ['file', A_FILE],
];
const regionIdLists = (): Input[] => {
  const ok = (n: number) => Array.from({ length: n }, (_, i) => `ckregion${String(i).padStart(17, '0')}`);
  return [
    ['none', []],
    ['one', ok(1)],
    ['at-max-50', ok(50)],
    ['over-max-51', ok(51)],
    ['over-max-51-one-bad', [...ok(50), 'bad']],
    ['at-max-50-one-bad', [...ok(49), 'bad']],
    ['one-bad', ['bad']],
    ['two-bad', ['bad1', 'bad2']],
    ['blank-dropped', ['', ok(1)[0]]],
    ['file', [A_FILE]],
  ];
};

const NEW_USER = { username: 'new.user', fullName: 'New User', role: 'VIEWER', password: 'correct-horse-battery' };
const CREATE_USER_FIELDS: Array<[string, Input[], Record<string, unknown>?]> = [
  ['username', [...formText(1, 50), ['upper', 'New.User'], ['inner-space', 'new user'], ['allowed-marks', 'new-user_1.x'], ['arabic', 'مستخدم'], ['two-char', 'c4'], ['padded-short', '  c4  ']]],
  ['fullName', formText(2, 200)],
  ['role', formEnum(ROLES)],
  ['email', [['absent', ABSENT], ['empty', ''], ['spaces', '  '], ['file', A_FILE], ...EMAILS]],
  ['phone', [['absent', ABSENT], ['empty', ''], ['spaces', '  '], ['len-50', rep(50, '9')], ['len-51', rep(51, '9')], ['plus968', '+968 9123 4567'], ['file', A_FILE]]],
  ['password', [['absent', ABSENT], ['empty', ''], ['len-11', rep(11, 'p')], ['len-12', rep(12, 'p')], ['spaces-12', rep(12, ' ')], ['padded', '  correct-horse  '], ['len-201', rep(201, 'p')], ['file', A_FILE]]],
  ['supervisorId', formIds()],
  ['ownedRouteId', formIds()],
  ['ownedRouteId', formIds(), { role: 'SALESMAN' }],
  ['regionId', regionIdLists(), { role: 'MANAGER' }],
];
for (const [f, inputs, over] of CREATE_USER_FIELDS) {
  for (const [label, value] of inputs) {
    const suffix = over ? `+${Object.values(over).join('+')}` : '';
    add(`users.create.${f}${suffix}/${label}`, STEWARD, async () => createUserAction(form(put({ ...NEW_USER, ...over }, f, value))));
  }
}
add('users.create/everything', STEWARD, async () =>
  createUserAction(form({ username: ' C4 ', fullName: ' Ali ', role: 'SALESMAN', email: ' Ali@Example.COM ', phone: ' 91234567 ', password: ' correct horse ', supervisorId: VALID_CUID, ownedRouteId: VALID_CUID, regionId: [] }))
);
add('users.create/nothing', STEWARD, async () => createUserAction(form({})));
add('users.create/all-bad', STEWARD, async () =>
  createUserAction(form({ username: 'A B', fullName: 'x', role: 'x', email: 'x', phone: rep(51), password: 'short', supervisorId: 'x', ownedRouteId: 'x', regionId: ['x', 'y'] }))
);

const ROLE_CHANGE = { userId: VALID_CUID, newRole: 'VIEWER' };
for (const [f, inputs] of [
  ['userId', formIds()],
  ['newRole', formEnum(ROLES)],
  ['ownedRouteId', formIds()],
] as Array<[string, Input[]]>) {
  for (const [label, value] of inputs) {
    add(`users.role.${f}/${label}`, STEWARD, async () => updateUserRoleAction(form(put(ROLE_CHANGE, f, value))));
  }
}
add('users.role/nothing', STEWARD, async () => updateUserRoleAction(form({})));

const ACCOUNT_EDIT = { userId: VALID_CUID, role: 'VIEWER' };
const onOff: Input[] = [['absent', ABSENT], ['on', 'on'], ['true', 'true'], ['empty', ''], ['ON', 'ON']];
for (const [f, inputs] of [
  ['userId', formIds()],
  ['role', formEnum(ROLES)],
  ['ownedRouteId', formIds()],
  ['supervisorId', formIds()],
  ['regionId', regionIdLists()],
  ['phone', [['empty', ''], ['spaces', '  '], ['len-50', rep(50, '9')], ['len-51', rep(51, '9')], ['padded-50', ` ${rep(50, '9')} `], ['file', A_FILE]]],
  ['contactAddress', [['empty', ''], ['len-200', rep(200)], ['len-201', rep(201)], ['padded-200', ` ${rep(200)} `], ['not-an-address', 'x'], ['file', A_FILE]]],
  ['clearPhone', onOff],
  ['clearContactAddress', onOff],
  ['routeSignIn', onOff],
  ['withdrawCreates', onOff],
] as Array<[string, Input[]]>) {
  for (const [label, value] of inputs) {
    add(`users.account.${f}/${label}`, STEWARD, async () => updateUserAccountAction(form(put(ACCOUNT_EDIT, f, value))));
  }
}
add('users.account/nothing', STEWARD, async () => updateUserAccountAction(form({})));

const EMAIL_READS: Reads = {
  'user.findUnique': { id: VALID_CUID, role: 'VIEWER', email: 'old@example.com' },
  'user.findFirst': null,
};
for (const [label, value] of [['absent', ABSENT], ['empty', ''], ['spaces', '  '], ['file', A_FILE], ['same-as-stored', ' OLD@example.com '], ...EMAILS] as Input[]) {
  add(`users.email.contactAddress/${label}`, STEWARD, async () => updateUserEmailAction(form({ userId: VALID_CUID, contactAddress: value })), EMAIL_READS);
}
for (const [label, value] of [['absent', ABSENT], ['empty', ''], ['spaces', '  ']] as Input[]) {
  add(`users.email.userId/${label}`, STEWARD, async () => updateUserEmailAction(form({ userId: value, contactAddress: 'a@b.co' })), EMAIL_READS);
}

for (const [label, value] of [['absent', ABSENT], ['empty', ''], ['len-11', rep(11, 'p')], ['len-12', rep(12, 'p')], ['spaces-12', rep(12, ' ')], ['padded', '  correct-horse  '], ['file', A_FILE]] as Input[]) {
  add(`users.reset.password/${label}`, STEWARD, async () => resetPasswordAction(form({ userId: VALID_CUID, password: value })));
}
add('users.reset.userId/absent', STEWARD, async () => resetPasswordAction(form({ password: rep(12, 'p') })));

const CODES: Input[] = [
  ['absent', ABSENT],
  ['empty', ''],
  ['spaces', '  '],
  ['one-letter', 'a'],
  ['two-lower', 'ab'],
  ['padded', '  ab  '],
  ['inner-space', 'a b'],
  ['dot', 'a.b'],
  ['accented', 'é1'],
  ['arabic', 'مسقط'],
  ['allowed-marks', 'mct-01_a'],
  ['len-20', rep(20, 'A')],
  ['len-21', rep(21, 'A')],
  ['file', A_FILE],
];
const NAMES: Input[] = [['absent', ABSENT], ['empty', ''], ['spaces', '  '], ['len-1', 'a'], ['len-2', 'ab'], ['padded-1', '  a  '], ['len-100', rep(100)], ['len-101', rep(101)], ['file', A_FILE]];
for (const [label, value] of CODES) {
  add(`routes.region.code/${label}`, STEWARD, async () => createRegionAction(form({ code: value, name: 'Muscat' })));
  add(`routes.route.code/${label}`, STEWARD, async () => createRouteAction(form({ code: value, name: 'Muscat 1', regionId: VALID_CUID })));
}
for (const [label, value] of NAMES) {
  add(`routes.region.name/${label}`, STEWARD, async () => createRegionAction(form({ code: 'MCT', name: value })));
  add(`routes.route.name/${label}`, STEWARD, async () => createRouteAction(form({ code: 'MCT1', name: value, regionId: VALID_CUID })));
}
for (const [label, value] of formIds()) {
  add(`routes.route.regionId/${label}`, STEWARD, async () => createRouteAction(form({ code: 'MCT1', name: 'Muscat 1', regionId: value })));
}
add('routes.region/nothing', STEWARD, async () => createRegionAction(form({})));
add('routes.route/nothing', STEWARD, async () => createRouteAction(form({})));

const CURRENT = 'Current-Password-1';
const PASSWORD_READS: Reads = { 'user.findUniqueOrThrow': { id: SALESMAN.id, passwordHash: `hash:${CURRENT}` } };
const PASSWORD_CHANGE = { currentPassword: CURRENT, newPassword: 'New-Password-2026', confirmNewPassword: 'New-Password-2026' };
for (const [f, inputs] of [
  ['currentPassword', [['absent', ABSENT], ['empty', ''], ['one', 'x'], ['len-200', rep(200, 'p')], ['len-201', rep(201, 'p')], ['padded', ` ${CURRENT} `], ['file', A_FILE]]],
  ['newPassword', [['absent', ABSENT], ['empty', ''], ['len-11', rep(11, 'p')], ['len-12', rep(12, 'p')], ['spaces-12', rep(12, ' ')], ['same-as-current', CURRENT], ['file', A_FILE]]],
  ['confirmNewPassword', [['absent', ABSENT], ['empty', ''], ['different', 'Other-Password-1'], ['padded', ' New-Password-2026 ']]],
] as Array<[string, Input[]]>) {
  for (const [label, value] of inputs) {
    add(`password.change.${f}/${label}`, SALESMAN, async () => changeOwnPasswordAction(form(put(PASSWORD_CHANGE, f, value))), PASSWORD_READS);
  }
}
add('password.change/nothing', SALESMAN, async () => changeOwnPasswordAction(form({})), PASSWORD_READS);
add('password.change/both-bad', SALESMAN, async () => changeOwnPasswordAction(form({ currentPassword: '', newPassword: 'short' })), PASSWORD_READS);

// ─── sign-in (app/actions/auth.ts loginAction) ────────────────────────────────

for (const [f, inputs] of [
  ['username', [['absent', ABSENT], ['empty', ''], ['spaces', '  '], ['two-char', 'c4'], ['padded', '  c4  '], ['upper', 'C4'], ['len-50', rep(50)], ['len-51', rep(51)], ['padded-50', ` ${rep(50)} `], ['file', A_FILE]]],
  ['password', [['absent', ABSENT], ['empty', ''], ['space', ' '], ['len-200', rep(200, 'p')], ['len-201', rep(201, 'p')], ['padded', ' secret '], ['file', A_FILE]]],
] as Array<[string, Input[]]>) {
  for (const [label, value] of inputs) {
    add(`login.${f}/${label}`, SALESMAN, async () => loginAction(form(put({ username: 'c4', password: 'secret-1' }, f, value))));
  }
}

// ─── photos: attach / detach (services/photos.ts), presign / finalize routes ──

const ATTACH_CUSTOMER = { attachmentId: VALID_CUID, customerId: CUSTOMER_ID, slot: 'CR' };
const ATTACH_BRANCH = { attachmentId: VALID_CUID, branchId: BRANCH_A, slot: 'SHOP' };
for (const [arm, base] of [['customer', ATTACH_CUSTOMER], ['branch', ATTACH_BRANCH]] as const) {
  for (const f of Object.keys(base).filter((k) => k !== 'slot')) {
    for (const [label, value] of [['absent', ABSENT] as const, ...CUIDS]) {
      add(`photos.attach.${arm}.${f}/${label}`, SALESMAN, async () => attachPhotoAction(put(base, f, value) as never));
    }
  }
  for (const [label, value] of [['absent', ABSENT] as const, ...enumInputs(['CR', 'SHOP', 'SIGNBOARD', 'FREE'])]) {
    add(`photos.attach.${arm}.slot/${label}`, SALESMAN, async () => attachPhotoAction(put(base, 'slot', value) as never));
  }
  add(`photos.attach.${arm}/unknown-key`, SALESMAN, async () => attachPhotoAction({ ...base, nope: 1 } as never));
}
add('photos.attach/both-ids', SALESMAN, async () => attachPhotoAction({ ...ATTACH_CUSTOMER, branchId: BRANCH_A } as never));
add('photos.attach/both-ids-shop', SALESMAN, async () => attachPhotoAction({ ...ATTACH_BRANCH, customerId: CUSTOMER_ID } as never));
add('photos.attach/neither-id', SALESMAN, async () => attachPhotoAction({ attachmentId: VALID_CUID, slot: 'CR' } as never));
add('photos.attach/bad-ids-both-arms', SALESMAN, async () => attachPhotoAction({ attachmentId: 'abc', customerId: 'abc', branchId: 'abc', slot: 'CR' } as never));
for (const [label, value] of [['null', null], ['string', 'x'], ['array', []], ['empty', {}]] as Input[]) {
  add(`photos.attach.body/${label}`, SALESMAN, async () => attachPhotoAction(value as never));
}
for (const [label, value] of [['absent', ABSENT] as const, ...CUIDS]) {
  add(`photos.detach.attachmentId/${label}`, SALESMAN, async () => detachPhotoAction(put({}, 'attachmentId', value) as never));
}
add('photos.detach.body/null', SALESMAN, async () => detachPhotoAction(null as never));

const HOST = 'nmwc.example';
function postJson(path: string, body: unknown) {
  return new NextRequest(`https://${HOST}${path}`, {
    method: 'POST',
    headers: { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
/** JSON carries no undefined, NaN or ±Infinity: those reach a route only as raw text, below. */
const jsonable = (inputs: Input[]) =>
  inputs.filter(([l]) => !['undefined', 'NaN', 'Infinity', 'minus-Infinity'].includes(l) && !l.startsWith('date-object') && !l.startsWith('invalid-date'));
const PRESIGN = { kind: 'SHOP', mimeType: 'image/jpeg', bytes: 400_000 };
const KINDS = ['SHOP', 'SIGNBOARD', 'CR', 'FREE', 'GUARANTEE', 'ID_CARD', 'MEMBERSHIP_CERT', 'VAT_CERT', 'TAX_CARD', 'CREDIT_FORM'];
for (const [f, inputs] of [
  ['kind', [['absent', ABSENT] as const, ...jsonable(enumInputs(KINDS))]],
  ['mimeType', [['absent', ABSENT] as const, ...jsonable(BASICS), ['png', 'image/png'], ['webp', 'image/webp'], ['gif', 'image/gif'], ['upper', 'IMAGE/JPEG'], ['pdf', 'application/pdf'], ['padded', ' image/jpeg ']]],
  ['bytes', [['absent', ABSENT] as const, ...jsonable(numberInputs(1, 3 * 1024 * 1024))]],
] as Array<[string, Input[]]>) {
  for (const [label, value] of inputs) {
    add(`photos.presign.${f}/${label}`, SALESMAN, async () => reply(await presignPOST(postJson('/api/photos/presign', put(PRESIGN, f, value)))));
  }
}
for (const [label, raw] of [
  ['bytes-1e400', '{"kind":"SHOP","mimeType":"image/jpeg","bytes":1e400}'],
  ['null', 'null'],
  ['array', '[]'],
  ['string', '"x"'],
  ['empty-object', '{}'],
  ['unknown-key', '{"kind":"SHOP","mimeType":"image/jpeg","bytes":1,"nope":1}'],
  ['all-bad', '{"kind":"x","mimeType":"x","bytes":-1.5}'],
] as const) {
  add(`photos.presign.raw/${label}`, SALESMAN, async () => reply(await presignPOST(postJson('/api/photos/presign', raw))));
}

/** The prefix finalize accepts today (the clock is fixed at 2026-10-20 below). */
const finalizeKey = (kind: unknown) => `2026/10/20/${SALESMAN.id}/${typeof kind === 'string' ? kind : 'SHOP'}/abc.jpg`;
const FINALIZE = { key: finalizeKey('SHOP'), kind: 'SHOP', hash: 'a'.repeat(64), width: 800, height: 600 };
for (const [f, inputs] of [
  ['key', [['absent', ABSENT] as const, ...jsonable(BASICS), ['len-500', finalizeKey('SHOP').padEnd(500, 'x')], ['len-501', finalizeKey('SHOP').padEnd(501, 'x')], ['other-day', '2020/01/01/usales01/SHOP/abc.jpg']]],
  ['kind', [['absent', ABSENT] as const, ...jsonable(enumInputs(KINDS))]],
  ['hash', [['absent', ABSENT] as const, ...jsonable(BASICS), ['upper', 'A'.repeat(64)], ['len-63', 'a'.repeat(63)], ['len-65', 'a'.repeat(65)], ['not-hex', 'g'.repeat(64)], ['newline-end', `${'a'.repeat(64)}\n`]]],
  ['width', jsonable(numberInputs(1, 20000))],
  ['height', jsonable(numberInputs(1, 20000))],
  ['capturedLat', jsonable(numberInputs(-90, 90))],
  ['capturedLng', jsonable(numberInputs(-180, 180))],
  ['capturedAt', jsonable(COERCED_DATES_ANY_ZONE)],
] as Array<[string, Input[]]>) {
  for (const [label, value] of inputs) {
    const body = put(f === 'kind' ? { ...FINALIZE, key: finalizeKey(value) } : FINALIZE, f, value);
    add(`photos.finalize.${f}/${label}`, SALESMAN, async () => reply(await finalizePOST(postJson('/api/photos/finalize', body))));
  }
}
for (const [label, raw] of [
  ['width-1e400', `{"key":"${finalizeKey('SHOP')}","kind":"SHOP","hash":"${'a'.repeat(64)}","width":1e400}`],
  ['null', 'null'],
  ['empty-object', '{}'],
  ['all-bad', '{"key":"","kind":"x","hash":"x","width":0.5,"height":-1,"capturedLat":91,"capturedLng":-181,"capturedAt":"x"}'],
] as const) {
  add(`photos.finalize.raw/${label}`, SALESMAN, async () => reply(await finalizePOST(postJson('/api/photos/finalize', raw))));
}

// ─── the signed credit application (services/signed-form.ts) and printing ─────

const SIGNED = { editId: VALID_CUID, attachmentIds: [page('CREDIT_FORM')], decisionToken: 'token' };
const signedPages = (n: number) => Array.from({ length: n }, (_, i) => page('CREDIT_FORM', i));
for (const [f, inputs] of [
  ['editId', [['absent', ABSENT] as const, ...CUIDS]],
  ['attachmentIds', [['absent', ABSENT] as const, ...BASICS.filter(([l]) => l !== 'array'), ['none', []], ['at-max-6', signedPages(6)], ['over-max-7', signedPages(7)], ['over-max-7-one-bad', [...signedPages(6), 'bad']], ['at-max-6-one-bad', [...signedPages(5), 'bad']], ['one-bad', ['bad']], ['bad-then-over', ['bad', ...signedPages(6)]], ['duplicate', [page('CREDIT_FORM'), page('CREDIT_FORM')]]]],
  ['decisionToken', [['absent', ABSENT] as const, ...BASICS, ['len-300', rep(300)], ['len-301', rep(301)]]],
] as Array<[string, Input[]]>) {
  for (const [label, value] of inputs) {
    add(`signed-form.${f}/${label}`, SALESMAN, async () => submitSignedFormAction(put(SIGNED, f, value) as never));
  }
}
add('signed-form.body/null', SALESMAN, async () => submitSignedFormAction(null as never));
add('signed-form/bad-id+no-pages', SALESMAN, async () => submitSignedFormAction({ editId: 'abc', attachmentIds: [] } as never));

for (const [f, inputs] of [
  ['printout', [['absent', ABSENT] as const, ...enumInputs(['CREDIT_APPLICATION', 'CUSTOMER_FORM'])]],
  ['id', [['absent', ABSENT] as const, ...CUIDS]],
] as Array<[string, Input[]]>) {
  for (const [label, value] of inputs) {
    add(`print.${f}/${label}`, SUPERVISOR, async () => recordPrintAction(put({ printout: 'CUSTOMER_FORM', id: VALID_CUID }, f, value) as never));
  }
}

// ─── exports: the query parameters (app/api/exports/{customers,changes}) ──────

function getWith(path: string, params: Array<[string, string]>) {
  return new NextRequest(`https://${HOST}${path}?${new URLSearchParams(params)}`);
}
const COMPLETENESS: Input[] = [['empty', ''], ['spaces', '  '], ['abc', 'abc'], ['minus-1', '-1'], ['zero', '0'], ['hundred', '100'], ['101', '101'], ['fraction', '50.5'], ['padded', ' 50 '], ['exponent', '1e2'], ['hex', '0x10'], ['Infinity', 'Infinity'], ['arabic', '٥٠']];
for (const [label, value] of COMPLETENESS) {
  add(`exports.customers.minCompleteness/${label}`, VIEWER, async () => reply(await customersExportGET(getWith('/api/exports/customers', [['minCompleteness', value as string]]))));
  add(`exports.customers.maxCompleteness/${label}`, VIEWER, async () => reply(await customersExportGET(getWith('/api/exports/customers', [['maxCompleteness', value as string]]))));
}
for (const [label, value] of DAYS) {
  add(`exports.customers.updatedSince/${label}`, VIEWER, async () => reply(await customersExportGET(getWith('/api/exports/customers', [['updatedSince', value as string]]))));
  add(`exports.changes.since/${label}`, VIEWER, async () => reply(await changesExportGET(getWith('/api/exports/changes', [['since', value as string]]))));
  add(`exports.changes.until/${label}`, VIEWER, async () => reply(await changesExportGET(getWith('/api/exports/changes', [['until', value as string]]))));
}
const FLAGS: Input[] = [['one', '1'], ['zero', '0'], ['true', 'true'], ['false', 'false'], ['yes', 'yes'], ['empty', ''], ['upper', 'TRUE']];
for (const [label, value] of FLAGS) {
  add(`exports.customers.includeTest/${label}`, VIEWER, async () => reply(await customersExportGET(getWith('/api/exports/customers', [['includeTest', value as string]]))));
  for (const p of ['onlyChanged', 'includePending', 'includeTest']) {
    add(`exports.changes.${p}/${label}`, VIEWER, async () => reply(await changesExportGET(getWith('/api/exports/changes', [[p, value as string]]))));
  }
}
for (const [label, params] of [
  ['status-valid', [['status', 'ACTIVE'], ['status', 'CLOSED']]],
  ['status-lower', [['status', 'active']]],
  ['status-bad', [['status', 'x']]],
  ['terms-valid', [['paymentTerms', 'CREDIT']]],
  ['terms-bad', [['paymentTerms', 'x']]],
  ['ids', [['regionId', 'r1'], ['routeId', 'ro1'], ['routeId', '']]],
  ['none', []],
  ['min-over-max', [['minCompleteness', '90'], ['maxCompleteness', '10']]],
] as Array<[string, Array<[string, string]>]>) {
  add(`exports.customers.lists/${label}`, VIEWER, async () => reply(await customersExportGET(getWith('/api/exports/customers', params))));
  add(`exports.changes.lists/${label}`, VIEWER, async () => reply(await changesExportGET(getWith('/api/exports/changes', params))));
}

// ─── pure readers of stored JSON and shared schemas ───────────────────────────

const GATES: Input[] = [
  ...REQUIRED.filter(([l]) => l !== 'absent'),
  ['string', 'x'],
  ['valid', { v: 1, branchIds: ['b1', 'b2'] }],
  ['valid-empty', { v: 1, branchIds: [] }],
  ['v-2', { v: 2, branchIds: ['b1'] }],
  ['v-string', { v: '1', branchIds: ['b1'] }],
  ['v-missing', { branchIds: ['b1'] }],
  ['ids-missing', { v: 1 }],
  ['blank-id', { v: 1, branchIds: [''] }],
  ['number-id', { v: 1, branchIds: [1] }],
  ['ids-string', { v: 1, branchIds: 'b1' }],
  ['unknown-key', { v: 1, branchIds: ['b1'], extra: 1 }],
  ['ids-null', { v: 1, branchIds: null }],
];
for (const [label, value] of GATES) add(`edit-scope.parseSubmitGate/${label}`, SALESMAN, async () => parseSubmitGate(value));

const ENTRY = { field: `branch.${BRANCH_A}.gpsLat`, before: 23, after: 23.6, gpsSource: 'MANUAL', gpsManualReason: 'No signal' };
const MARKER = { field: 'draft.0.gps', before: null, after: { lat: 23.6, lng: 58.4 }, gpsSource: 'MANUAL', gpsManualReason: 'Typed in' };
const CHANGES: Input[] = [
  ...BASICS.filter(([l]) => l !== 'array' && l !== 'zero'),
  ['none', []],
  ['entry', [ENTRY]],
  ['entry-no-after', [put(ENTRY, 'after', ABSENT)]],
  ['entry-after-undefined', [{ ...ENTRY, after: undefined }]],
  ['entry-after-null', [{ ...ENTRY, after: null }]],
  ['entry-lower-source', [{ ...ENTRY, gpsSource: 'manual' }]],
  ['entry-no-source', [put(ENTRY, 'gpsSource', ABSENT)]],
  ['entry-no-reason', [put(ENTRY, 'gpsManualReason', ABSENT)]],
  ['entry-reason-number', [{ ...ENTRY, gpsManualReason: 1 }]],
  ['entry-no-field', [put(ENTRY, 'field', ABSENT)]],
  ['entry-extra-key', [{ ...ENTRY, overrodeLive: 1 }]],
  ['entry-lng', [{ ...ENTRY, field: `branch.${BRANCH_A}.gpsLng` }]],
  ['null-then-entry', [null, ENTRY]],
  ['marker', [MARKER]],
  ['marker-no-after', [put(MARKER, 'after', ABSENT)]],
  ['marker-string-lat', [{ ...MARKER, after: { lat: '23.6', lng: 58.4 } }]],
  ['marker-lat-only', [{ ...MARKER, after: { lat: 23.6 } }]],
  ['marker-extra-key', [{ ...MARKER, after: { lat: 23.6, lng: 58.4, alt: 1 } }]],
  ['marker-array-after', [{ ...MARKER, after: [23.6, 58.4] }]],
  ['marker-other-index', [{ ...MARKER, field: 'draft.12.gps' }]],
  ['marker-bad-field', [{ ...MARKER, field: 'draft.x.gps' }]],
];
for (const [label, value] of CHANGES) {
  add(`gps-manual.readers/${label}`, SALESMAN, async () => ({
    forBranch: manualGpsReasonForBranch(value, BRANCH_A),
    forPoint: manualGpsReasonForPoint(value, 23.6, 58.4),
    forPointNull: manualGpsReasonForPoint(value, null, 58.4),
    any: hasManualGps(value),
  }));
}
const safe = (r: { success: boolean; data?: unknown }) => (r.success ? { ok: true, data: r.data } : { ok: false });
for (const [label, value] of UUIDS) add(`submission.submissionIdSchema/${label}`, SALESMAN, async () => safe(submissionIdSchema.safeParse(value)));
for (const [label, value] of REASONS) add(`gps-manual.reasonSchema/${label}`, SALESMAN, async () => safe(gpsManualReasonSchema.safeParse(value)));

// ─── what a copy put back from the phone sends (code review 2026-11-10, finding 4) ─
//
// Added when claude/review-fixes-1 was merged onto the upgrades. That branch adds
// no schema and changes none, but it gives three schemas inputs no earlier path
// could: the new-customer form and the signed-application pages now keep their
// work on the phone (lib/create-draft.ts) and send what they read back from it.
// A copy is read by hand, so a value the reader lets through — whatever the
// phone's storage held — goes to the schema as it is:
//   - the ids of sends that got no answer, which the form asks the server about
//     only when submissionIdSchema accepts them (CreateCustomerForm);
//   - photo, guarantee and page ids (any 1–64 of [A-Za-z0-9_-]) and GPS points
//     (any finite numbers, any time Date.parse reads, a typed-in reason of any
//     text), sent through submitCreateSchema and the signed-form upload's schema.
// Each case runs the copy through the real reader, builds what the form sends
// from it (the form's own mapping, as a draft), and records what the consumer
// answers. They were recorded under zod 3.25.76 on claude/review-fixes-1 at
// 718da18 (fixture.extendedWith), with this file's harness, and are checked
// like every other case.
const FROM_PHONE_FIRST = CASES.length;

/** The body CreateCustomerForm sends (as a draft) for the form a stored copy puts back. */
function createBodyFromCopy(stored: Record<string, unknown>): Record<string, unknown> {
  const copy = parseCreateCopy(JSON.stringify(stored));
  if (!copy) throw new Error('not a copy');
  const f = copy.form;
  const isCredit = f.paymentTerms === 'CREDIT';
  return {
    isDraft: true,
    customer: {
      legalName: f.legalName.trim(),
      paymentTerms: f.paymentTerms,
      crNumber: f.crNumber.trim() || undefined,
      channelId: f.channelId || undefined,
      subChannelId: f.subChannelId || undefined,
      primaryPhone: f.primaryPhone.trim() || undefined,
      altPhone: f.altPhone.trim() || undefined,
      contactPerson: f.contactPerson.trim() || undefined,
      contactRole: f.contactRole.trim() || undefined,
      notes: f.notes.trim() || undefined,
      crPhotoAttachmentId: f.crPhotoId ?? undefined,
      email: isCredit ? f.email.trim() || undefined : undefined,
    },
    // The copies below leave the two credit boxes blank.
    credit: isCredit ? { requestedCreditLimit: undefined, requestedPaymentTermDays: undefined } : undefined,
    guaranteeAttachmentIds: isCredit ? f.guaranteeIds : [],
    creditDocuments: isCredit ? Object.fromEntries(CREDIT_DOCUMENT_KINDS.map((k) => [k, f.creditDocs[k]])) : {},
    branches: f.branches.map((s) => ({
      branchName: s.branchName.trim() || 'Main',
      address: s.address.trim() || undefined,
      areaDescription: s.areaDescription.trim() || undefined,
      gpsLat: s.gps?.lat,
      gpsLng: s.gps?.lng,
      gpsAccuracy: s.gps?.accuracy,
      gpsCapturedAt: s.gps?.capturedAt,
      gpsManualReason: s.gps?.isManual ? s.gps.manualReason : undefined,
      dayOfVisit: s.dayOfVisit || undefined,
      openingHours: s.openingHours.trim() || undefined,
      deliveryWindow: s.deliveryWindow.trim() || undefined,
      coolersCount: s.coolers,
      standsCount: s.stands,
      emptyBottlesCount: s.bottles,
      shopPhotoAttachmentId: s.shopPhotoId ?? undefined,
      signboardPhotoAttachmentId: s.signboardPhotoId ?? undefined,
      extraPhotoAttachmentIds: s.extraPhotoIds.filter((id): id is string => id != null),
    })),
  };
}
const COPY = { v: 2, legalName: 'Al Noor Trading', paymentTerms: 'CASH', branches: [{ branchName: 'Main' }] };
const CREDIT_COPY = { ...COPY, paymentTerms: 'CREDIT' };
const copyBranch = (over: Record<string, unknown>) => ({ ...COPY, branches: [{ branchName: 'Main', ...over }] });

/** UUID-shaped strings the copy's reader keeps (any version, any variant, any case) beside UUIDS. */
const COPY_UUIDS: Input[] = [
  ...UUIDS.filter(([, v]) => typeof v === 'string'),
  ['v2', '000003e8-1234-21ef-8a00-325096b39f47'],
  ['v3', 'a3bb189e-8bf9-3888-9912-ace4e6543002'],
  ['v5', 'a3bb189e-8bf9-5888-9912-ace4e6543002'],
  ['v6', '1ef21d2f-1207-6660-8c4f-419efbd44d48'],
  ['v8', 'a3bb189e-8bf9-8888-9912-ace4e6543002'],
  ['version-0', 'a3bb189e-8bf9-0888-9912-ace4e6543002'],
  ['version-9', 'a3bb189e-8bf9-9888-9912-ace4e6543002'],
  ['version-f', 'a3bb189e-8bf9-f888-9912-ace4e6543002'],
  ['variant-0', 'a3bb189e-8bf9-4888-0912-ace4e6543002'],
  ['variant-7', 'a3bb189e-8bf9-4888-7912-ace4e6543002'],
  ['variant-a', 'a3bb189e-8bf9-4888-a912-ace4e6543002'],
  ['variant-b-upper', 'a3bb189e-8bf9-4888-B912-ace4e6543002'],
  ['variant-d', 'a3bb189e-8bf9-4888-d912-ace4e6543002'],
  ['variant-f', 'a3bb189e-8bf9-4888-f912-ace4e6543002'],
  ['mixed-case', 'A3bb189E-8BF9-4888-9912-aCe4e6543002'],
  ['max-upper', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'],
  ['nil-plus-one', '00000000-0000-0000-0000-000000000001'],
];
for (const [label, value] of COPY_UUIDS) {
  add(`create-draft.unanswered/${label}`, SALESMAN, async () => {
    const read = parseCreateCopy(JSON.stringify({ ...COPY, unanswered: [value] }))?.unanswered ?? null;
    return { read, asked: (read ?? []).filter((x) => submissionIdSchema.safeParse(x).success) };
  });
}

/** Id-shaped strings: what the copy's reader keeps (1–64 of [A-Za-z0-9_-]) and two it drops. */
const COPY_IDS: Input[] = [
  ['valid', VALID_CUID],
  ['underscore', 'ck_valid_000000000000001'],
  ['hyphen', 'ck-valid-000000000000001'],
  ['upper', 'CKVALID000000000000000001'],
  ['upper-inside', 'ckVALID000000000000000001'],
  ['c-8', 'c1234567'],
  ['c-9', 'c12345678'],
  ['abc', 'abc'],
  ['one-char', 'c'],
  ['digits', '123456789'],
  ['len-64', 'c' + rep(63, 'x')],
  ['len-65-dropped', 'c' + rep(64, 'x')],
  ['uuid', V4],
  ['space-dropped', 'c1234 5678'],
];
for (const [label, value] of COPY_IDS) {
  add(`create-draft.crPhotoId/${label}`, SALESMAN, create(() => createBodyFromCopy({ ...COPY, crPhotoId: value }), (d) => d.customer), CREATE_READS);
  add(`create-draft.shopPhotoId/${label}`, SALESMAN, create(() => createBodyFromCopy(copyBranch({ shopPhotoId: value })), (d) => d.branches), CREATE_READS);
  add(`create-draft.extraPhotoIds/${label}`, SALESMAN, create(() => createBodyFromCopy(copyBranch({ extraPhotoIds: [VALID_CUID.replace(/1$/, '2'), value] })), (d) => d.branches), CREATE_READS);
  add(`create-draft.guaranteeIds/${label}`, SALESMAN, create(() => createBodyFromCopy({ ...CREDIT_COPY, guaranteeIds: [value] })), CREATE_READS);
  add(`signed-form.restored/${label}`, SALESMAN, async () => {
    const copy = parseSignedPagesCopy(JSON.stringify({ token: 'token', ids: [page('CREDIT_FORM'), value] }), MAX_SIGNED_FORM_PAGES);
    if (!copy) throw new Error('not a copy');
    return submitSignedFormAction({ editId: VALID_CUID, attachmentIds: copy.ids, decisionToken: copy.token } as never);
  });
}
add('signed-form.restored/seven-kept-six', SALESMAN, async () => {
  const copy = parseSignedPagesCopy(JSON.stringify({ token: 'token', ids: signedPages(7) }), MAX_SIGNED_FORM_PAGES);
  if (!copy) throw new Error('not a copy');
  return submitSignedFormAction({ editId: VALID_CUID, attachmentIds: copy.ids, decisionToken: copy.token } as never);
});

/**
 * GPS points the copy's reader keeps: finite numbers, a time Date.parse reads, a
 * typed-in reason of any text. Text Date reads in the machine's own zone is left
 * out, as for COERCED_DATES: the parsed time is recorded.
 */
const GPS_POINT = { lat: 23.6, lng: 58.4, accuracy: 5, capturedAt: '2026-10-20T08:00:00Z' };
const COPY_POINTS: Array<[string, Record<string, unknown>]> = [
  ['point', GPS_POINT],
  ['no-accuracy', { lat: 23.6, lng: 58.4, capturedAt: '2026-10-20T08:00:00Z' }],
  ['lat-91', { ...GPS_POINT, lat: 91 }],
  ['lng-minus-181', { ...GPS_POINT, lng: -181 }],
  ['zero-zero', { ...GPS_POINT, lat: 0, lng: 0 }],
  ['accuracy-negative', { ...GPS_POINT, accuracy: -1 }],
  ['accuracy-huge', { ...GPS_POINT, accuracy: 1e9 }],
  ['date-only', { ...GPS_POINT, capturedAt: '2026-10-20' }],
  ['offset', { ...GPS_POINT, capturedAt: '2026-10-20T12:00:00+04:00' }],
  ['millis', { ...GPS_POINT, capturedAt: '2026-10-20T08:00:00.123Z' }],
  ['far-future', { ...GPS_POINT, capturedAt: '2030-01-01T00:00:00Z' }],
  ['year-1970', { ...GPS_POINT, capturedAt: '1970-01-01T00:00:00Z' }],
  ['manual-reason', { ...GPS_POINT, isManual: true, manualReason: 'No signal inside the shop' }],
  ['manual-no-reason', { ...GPS_POINT, isManual: true }],
  ['manual-blank-reason', { ...GPS_POINT, isManual: true, manualReason: '   ' }],
  ['manual-short-reason', { ...GPS_POINT, isManual: true, manualReason: 'ab' }],
  ['manual-tags-reason', { ...GPS_POINT, isManual: true, manualReason: '<b></b>' }],
  ['manual-500-reason', { ...GPS_POINT, isManual: true, manualReason: rep(500) }],
  ['manual-501-cut', { ...GPS_POINT, isManual: true, manualReason: rep(501) }],
];
for (const [label, gps] of COPY_POINTS) {
  add(`create-draft.gps/${label}`, SALESMAN, create(() => createBodyFromCopy(copyBranch({ gps })), (d) => d.branches), CREATE_READS);
}
const FROM_PHONE_IDS = CASES.slice(FROM_PHONE_FIRST).map((c) => c.id);

// ---- checks against the fixture ----

const FIXTURE = 'tests/unit/fixtures/validation-messages.zod3.json';
const GENERATED_WITH = 'zod 3.25.76 @ a454239';
/** The cases added with the merge of claude/review-fixes-1, recorded under zod 3 on that branch. */
const EXTENDED_WITH = 'zod 3.25.76 @ 718da18 (claude/review-fixes-1)';
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  generatedWith: string;
  extendedWith: Record<string, string[]>;
  cases: Record<string, unknown>;
};

// The clock and the random id a presign mints: fixed, so a record does not move with the day.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T08:00:00.000Z') });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
});
afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('what users are told, and what an accepted body is read as, is what zod 3 gave', () => {
  it('the record is the one taken under zod 3.25.76, and holds exactly these cases', () => {
    expect(fixture.generatedWith).toBe(GENERATED_WITH);
    expect(CASES.map((c) => c.id)).toEqual(Object.keys(fixture.cases));
    // Every case after the first record says where it was recorded: only the
    // phone-copy cases were added, and they come last.
    expect(fixture.extendedWith).toEqual({ [EXTENDED_WITH]: FROM_PHONE_IDS });
    expect(FROM_PHONE_IDS).toEqual(CASES.slice(FROM_PHONE_FIRST).map((c) => c.id));
    expect(FROM_PHONE_FIRST).toBe(3179);
  });

  it.each(CASES.map((c) => [c.id, c] as const))('%s', async (id, c) => {
    const got = await observe(c);
    const want = fixture.cases[id];
    expect(got).toEqual(want);
    // toEqual ignores key order; the order of a refusal's fields is what the form walks.
    expect(JSON.stringify(got)).toBe(JSON.stringify(want));
  });
});
