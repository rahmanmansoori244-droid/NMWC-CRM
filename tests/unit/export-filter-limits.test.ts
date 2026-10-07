// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ForbiddenError, PasswordChangeRequiredError } from '@/lib/errors';

const h = vi.hoisted(() => ({
  checkActor: vi.fn(),
  requireExportUser: vi.fn(),
  customers: vi.fn(),
  changes: vi.fn(),
  envelope: vi.fn(),
  audit: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ checkActor: h.checkActor }));
vi.mock('@/lib/export-scope', () => ({ requireExportUser: h.requireExportUser }));
vi.mock('@/services/exports', () => ({ buildCustomerExport: h.customers }));
vi.mock('@/lib/change-report', () => ({ buildChangeReport: h.changes }));
vi.mock('@/lib/audit', () => ({ getAuditEnvelope: h.envelope, writeAudit: h.audit }));
vi.mock('@/lib/logger', () => ({ logger: { error: h.error, warn: h.warn } }));

import { GET as customersGET } from '@/app/api/exports/customers/route';
import { GET as changesGET } from '@/app/api/exports/changes/route';

const actor = { id: 'viewer-1', role: 'VIEWER', username: 'export-reader' };
const bytes = new Uint8Array([80, 75, 3, 4]);
const endpoints = [
  { name: 'customers', get: customersGET, builder: h.customers, filterIndex: 0 },
  { name: 'changes', get: changesGET, builder: h.changes, filterIndex: 1 },
] as const;

function request(name: string, params = new URLSearchParams()) {
  return new NextRequest(`https://nmwc.example/api/exports/${name}?${params}`);
}

function appendIds(params: URLSearchParams, key: string, count: number, repeated?: string) {
  const values = Array.from({ length: count }, (_, i) => repeated ?? `${key}-${i}`);
  for (const value of values) params.append(key, value);
  return values;
}

async function expectInvalid(response: Response) {
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Invalid filter parameters' });
  expect(h.customers).not.toHaveBeenCalled();
  expect(h.changes).not.toHaveBeenCalled();
  expect(h.envelope).not.toHaveBeenCalled();
  expect(h.audit).not.toHaveBeenCalled();
  expect(h.error).not.toHaveBeenCalled();
  expect(h.warn).not.toHaveBeenCalled();
  expect(console.log).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  h.checkActor.mockResolvedValue({ ok: true, user: actor });
  h.requireExportUser.mockResolvedValue(actor);
  h.customers.mockResolvedValue({ bytes, filename: 'customers.xlsx' });
  h.changes.mockResolvedValue({
    bytes, filename: 'changes.xlsx', rowCount: 7, changedRows: 3, changeCount: 5,
  });
  h.envelope.mockResolvedValue({ actorId: actor.id, ip: null, userAgent: null });
  h.audit.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

for (const endpoint of endpoints) {
  describe(`GET /api/exports/${endpoint.name}: bounded filters`, () => {
    it('accepts exactly 500 IDs in each independent list without truncation', async () => {
      const params = new URLSearchParams();
      const regionIds = appendIds(params, 'regionId', 500);
      const routeIds = appendIds(params, 'routeId', 500);
      const req = request(endpoint.name, params);
      vi.spyOn(req.nextUrl.searchParams, 'getAll').mockImplementation(() => {
        throw new Error('Repeated filters must not be materialized with getAll');
      });

      expect((await endpoint.get(req)).status).toBe(200);
      expect(endpoint.builder).toHaveBeenCalledOnce();
      expect(endpoint.builder.mock.calls[0]![endpoint.filterIndex]).toMatchObject({
        regionIds, routeIds,
      });
    });

    it.each(['regionId', 'routeId'])('rejects 501 distinct %s values before export work', async (key) => {
      const params = new URLSearchParams();
      appendIds(params, key, 501);
      await expectInvalid(await endpoint.get(request(endpoint.name, params)));
    });

    it('stops reading repeated filters at the first excess occurrence', async () => {
      const req = request(endpoint.name);
      let occurrencesRead = 0;
      let tailRead = false;
      vi.spyOn(req.nextUrl.searchParams, Symbol.iterator).mockImplementation(function* () {
        for (let i = 0; i < 501; i++) {
          occurrencesRead++;
          yield ['regionId', `region-${i}`] as [string, string];
        }
        tailRead = true;
        throw new Error('The unbounded query tail was read');
      });
      await expectInvalid(await endpoint.get(req));
      expect(occurrencesRead).toBe(501);
      expect(tailRead).toBe(false);
    });

    it('preserves 500 repeated values, rather than silently changing the filters', async () => {
      const params = new URLSearchParams();
      const regionIds = appendIds(params, 'regionId', 500, 'same-region');
      const routeIds = appendIds(params, 'routeId', 500, 'same-route');
      expect((await endpoint.get(request(endpoint.name, params))).status).toBe(200);
      expect(endpoint.builder.mock.calls[0]![endpoint.filterIndex]).toMatchObject({
        regionIds, routeIds,
      });
    });

    it.each(['regionId', 'routeId'])('counts repeated %s values toward the limit', async (key) => {
      const params = new URLSearchParams();
      appendIds(params, key, 501, 'repeated-value');
      await expectInvalid(await endpoint.get(request(endpoint.name, params)));
    });

    it('accepts IDs of exactly 128 UTF-16 code units, including non-ASCII IDs', async () => {
      const regionId = 'r'.repeat(128);
      const routeId = '💧'.repeat(64);
      const params = new URLSearchParams({ regionId, routeId });
      expect((await endpoint.get(request(endpoint.name, params))).status).toBe(200);
      expect(endpoint.builder.mock.calls[0]![endpoint.filterIndex]).toMatchObject({
        regionIds: [regionId], routeIds: [routeId],
      });
    });

    it.each(['regionId', 'routeId'])('rejects a 129-code-unit %s without echoing or logging it', async (key) => {
      const rejected = `private-rejected-filter-${'x'.repeat(105)}`;
      expect(rejected.length).toBe(129);
      await expectInvalid(await endpoint.get(request(endpoint.name, new URLSearchParams({ [key]: rejected }))));
    });

    it('does not broaden an explicit blank ID to an omitted filter', async () => {
      const params = new URLSearchParams({ regionId: '', routeId: ' ' });
      expect((await endpoint.get(request(endpoint.name, params))).status).toBe(200);
      expect(endpoint.builder.mock.calls[0]![endpoint.filterIndex]).toMatchObject({
        regionIds: [''], routeIds: [' '],
      });
    });

    it('keeps absent filters undefined', async () => {
      expect((await endpoint.get(request(endpoint.name))).status).toBe(200);
      const filters = endpoint.builder.mock.calls[0]![endpoint.filterIndex];
      expect(filters.regionIds).toBeUndefined();
      expect(filters.routeIds).toBeUndefined();
    });

    it('keeps a normal seven-region, 43-route selection intact and ignores unknown keys', async () => {
      const params = new URLSearchParams();
      const regionIds = appendIds(params, 'regionId', 7);
      const routeIds = appendIds(params, 'routeId', 43);
      appendIds(params, 'unknown', 501, 'x'.repeat(129));
      expect((await endpoint.get(request(endpoint.name, params))).status).toBe(200);
      expect(endpoint.builder.mock.calls[0]![endpoint.filterIndex]).toMatchObject({
        regionIds, routeIds,
      });
    });

    it.each([401, 403])('returns auth refusal %s before accessing filter parameters', async (status) => {
      const refused = status === 401
        ? new ForbiddenError('Not signed in')
        : new PasswordChangeRequiredError();
      h.checkActor.mockResolvedValue({ ok: false, status, message: refused.message });
      h.requireExportUser.mockRejectedValue(refused);
      const req = request(endpoint.name, new URLSearchParams({ regionId: 'x'.repeat(129) }));
      const queryRead = vi.fn(() => { throw new Error('Filters read before auth'); });
      Object.defineProperty(req, 'nextUrl', { get: queryRead });

      const response = await endpoint.get(req);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: refused.message });
      expect(queryRead).not.toHaveBeenCalled();
      expect(h.customers).not.toHaveBeenCalled();
      expect(h.changes).not.toHaveBeenCalled();
      expect(h.audit).not.toHaveBeenCalled();
    });

    it('still returns the generated workbook and private download headers', async () => {
      const response = await endpoint.get(request(endpoint.name));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${endpoint.name}.xlsx"`);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      if (endpoint.name === 'changes') {
        expect(response.headers.get('x-row-count')).toBe('7');
        expect(response.headers.get('x-changed-rows')).toBe('3');
        expect(h.envelope).toHaveBeenCalledWith(actor.id);
        expect(h.audit).toHaveBeenCalledWith(null, {
          actorId: actor.id, ip: null, userAgent: null,
        }, expect.objectContaining({
          action: 'EXPORT', entityType: 'Export',
          reason: 'field-updates 7 rows / 3 changed / 5 changes',
        }));
      }
    });
  });
}

describe('customer-only filter validation', () => {
  it('accepts all supported status and payment-term choices at their respective caps', async () => {
    const params = new URLSearchParams();
    for (const status of ['ACTIVE', 'CLOSED', 'SUSPENDED']) params.append('status', status);
    for (const term of ['CASH', 'CREDIT']) params.append('paymentTerms', term);
    expect((await customersGET(request('customers', params))).status).toBe(200);
    expect(h.customers).toHaveBeenCalledWith(expect.objectContaining({
      statuses: ['ACTIVE', 'CLOSED', 'SUSPENDED'], paymentTerms: ['CASH', 'CREDIT'],
    }));
  });

  it.each([
    ['status', 'ACTIVE', 4],
    ['paymentTerms', 'CASH', 3],
  ] as const)('rejects excess %s occurrences even when each is a valid repeated choice', async (key, value, count) => {
    const params = new URLSearchParams();
    appendIds(params, key, count, value);
    await expectInvalid(await customersGET(request('customers', params)));
  });

  it.each([
    ['status', 'x'.repeat(10)],
    ['paymentTerms', 'x'.repeat(7)],
    ['status', 'UNKNOWN'],
    ['paymentTerms', 'OTHER'],
    ['status', ''],
    ['paymentTerms', ''],
  ])('rejects invalid %s choice %j with a generic response', async (key, value) => {
    await expectInvalid(await customersGET(request('customers', new URLSearchParams({ [key]: value }))));
  });

  it('preserves scalar coercion and the first scalar value when repeated', async () => {
    const params = new URLSearchParams({ minCompleteness: '20', maxCompleteness: '80', updatedSince: '2026-09-30' });
    params.append('minCompleteness', '999');
    expect((await customersGET(request('customers', params))).status).toBe(200);
    expect(h.customers).toHaveBeenCalledWith(expect.objectContaining({
      // The start of 30 September in OMAN (20:00 UTC the evening before), as the
      // field-update report reads a day — not UTC midnight, 04:00 in Oman.
      minCompleteness: 20, maxCompleteness: 80, updatedSince: new Date('2026-09-29T20:00:00Z'),
    }));
  });

  it.each([
    ['minCompleteness', '101'], ['maxCompleteness', '-1'], ['updatedSince', 'invalid'],
  ])('keeps existing validation of %s', async (key, value) => {
    await expectInvalid(await customersGET(request('customers', new URLSearchParams({ [key]: value }))));
  });
});

describe('change-report filter compatibility', () => {
  it('continues ignoring customer-only filters, even if too long or repeated', async () => {
    const params = new URLSearchParams();
    appendIds(params, 'status', 501, 'x'.repeat(129));
    appendIds(params, 'paymentTerms', 501, 'x'.repeat(129));
    expect((await changesGET(request('changes', params))).status).toBe(200);
    expect(h.changes.mock.calls[0]![1]).not.toHaveProperty('statuses');
    expect(h.changes.mock.calls[0]![1]).not.toHaveProperty('paymentTerms');
  });

  it('preserves inclusive Oman day boundaries and explicit booleans', async () => {
    const params = new URLSearchParams({ since: '2026-09-29', until: '2026-09-30', onlyChanged: 'true', includePending: '0' });
    expect((await changesGET(request('changes', params))).status).toBe(200);
    expect(h.changes).toHaveBeenCalledWith(actor, expect.objectContaining({
      since: new Date('2026-09-28T20:00:00Z'),
      until: new Date('2026-09-30T19:59:59.999Z'),
      onlyChanged: true, includePending: false,
    }));
  });

  it('preserves default booleans and blank scalar semantics', async () => {
    const params = new URLSearchParams({ since: '', until: '', onlyChanged: '', includePending: '' });
    expect((await changesGET(request('changes', params))).status).toBe(200);
    expect(h.changes.mock.calls[0]![1]).toMatchObject({
      since: undefined, until: undefined, onlyChanged: false, includePending: true,
    });
  });

  it.each([
    ['since', 'invalid'], ['until', 'invalid'], ['onlyChanged', 'yes'], ['includePending', 'yes'],
  ])('keeps existing validation of %s', async (key, value) => {
    await expectInvalid(await changesGET(request('changes', new URLSearchParams({ [key]: value }))));
  });

  it('still withholds the workbook if its export audit fails', async () => {
    h.audit.mockRejectedValue(new Error('audit unavailable'));
    const response = await changesGET(request('changes'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Export failed' });
    expect(h.error).toHaveBeenCalledWith({ err: 'audit unavailable' }, 'export.change_report.fail');
  });
});

describe('both exports read a picked day as the same Oman day', () => {
  // Process in UTC, as on Vercel; 21:30 UTC on the 7th is 01:30 on the 8th in Oman.
  beforeEach(() => {
    vi.stubEnv('TZ', 'UTC');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('starts "updated since" where the field-update report starts "changes from"', async () => {
    const day = '2026-10-08';
    expect((await customersGET(request('customers', new URLSearchParams({ updatedSince: day })))).status).toBe(200);
    expect((await changesGET(request('changes', new URLSearchParams({ since: day })))).status).toBe(200);
    const updatedSince = h.customers.mock.calls[0]![0].updatedSince as Date;
    expect(updatedSince.toISOString()).toBe('2026-10-07T20:00:00.000Z');
    expect(h.changes.mock.calls[0]![1].since).toEqual(updatedSince);
    // A customer updated at 01:30 Oman on the 8th is inside "updated since the 8th".
    expect(new Date('2026-10-07T21:30:00.000Z').getTime()).toBeGreaterThanOrEqual(updatedSince.getTime());
  });

  it('records the field-update export under the Oman day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T21:30:00.000Z'));
    expect((await changesGET(request('changes'))).status).toBe(200);
    expect(h.audit).toHaveBeenCalledWith(null, expect.anything(), expect.objectContaining({
      entityId: 'field-updates-2026-10-08',
    }));
  });
});
