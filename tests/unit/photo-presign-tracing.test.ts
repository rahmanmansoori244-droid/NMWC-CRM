// @vitest-environment node
/**
 * AWS SDK 3.1082+ copies Lambda's W3C trace context into the request before
 * presigning it. The browser does not send that server context with its PUT.
 * Exercise the real SDK and route: a mock presigner would hide the regression.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { InvokeStore, InvokeStoreBase } from '@aws/lambda-invoke-store';

const h = vi.hoisted(() => ({
  client: undefined as S3Client | undefined,
  handle: vi.fn(),
}));
vi.mock('@/lib/session', () => ({
  checkActor: async () => ({ ok: true, user: { id: 'syntheticuser', role: 'SALESMAN' } }),
}));
vi.mock('@/lib/r2', () => ({ r2: () => h.client, R2_BUCKET: 'synthetic-photos' }));
vi.mock('@/lib/rate-limit', () => ({ checkLimit: async () => ({ ok: true }), PHOTO_LIMIT: {} }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));

import { POST } from '@/app/api/photos/presign/route';
import { PRESIGN_EXPIRES_S } from '@/lib/photo-attach';

const traceparent = '00-11111111111111111111111111111111-2222222222222222-01';
const tracestate = 'synthetic=presign';
const baggage = 'synthetic=photo-test';
const tracing = {
  [InvokeStoreBase.PROTECTED_KEYS.TRACEPARENT]: traceparent,
  [InvokeStoreBase.PROTECTED_KEYS.TRACESTATE]: tracestate,
  [InvokeStoreBase.PROTECTED_KEYS.BAGGAGE]: baggage,
};
let store: InvokeStoreBase;

beforeAll(async () => {
  // AsyncLocalStorage keeps these synthetic contexts scoped to each callback.
  store = await InvokeStore.getInstanceAsync(true);
});

beforeEach(() => {
  h.handle.mockReset().mockRejectedValue(new Error('Network is forbidden in this test'));
  h.client = new S3Client({
    region: 'auto',
    endpoint: 'https://r2.invalid',
    credentials: { accessKeyId: 'synthetic-photo-key', secretAccessKey: 'synthetic-photo-secret' },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { handle: h.handle },
  });
});

afterEach(() => {
  h.client?.destroy();
  expect(h.handle).not.toHaveBeenCalled();
});

describe('browser photo upload signatures', () => {
  it('the real SDK signs Lambda trace headers unless the caller excludes them', async () => {
    const signed = await store.run(tracing, () => getSignedUrl(
      h.client!,
      new PutObjectCommand({
        Bucket: 'synthetic-photos', Key: 'synthetic.jpg', ContentType: 'image/jpeg', ContentLength: 1000,
      }),
      { expiresIn: PRESIGN_EXPIRES_S }
    ));
    expect(new URL(signed).searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      ['baggage', 'content-length', 'host', 'traceparent', 'tracestate']
    );
  });

  it.each([
    { name: 'without tracing', context: {} },
    { name: 'with Lambda tracing', context: tracing },
  ])('returns a URL the browser can PUT $name', async ({ context }) => {
    const response = await store.run(context, () => POST(new NextRequest('https://crm.invalid/api/photos/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'SHOP', mimeType: 'image/jpeg', bytes: 1000 }),
    })));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    expect(body.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    const url = new URL(body.url);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(PRESIGN_EXPIRES_S));
    expect(url.pathname).toBe(`/synthetic-photos/${body.key}`);
    for (const value of [traceparent, tracestate, baggage]) {
      expect(JSON.stringify(body)).not.toContain(value);
      expect(decodeURIComponent(body.url)).not.toContain(value);
    }
  });
});
