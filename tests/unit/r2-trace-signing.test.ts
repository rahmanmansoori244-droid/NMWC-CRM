// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { InvokeStore, InvokeStoreBase } from '@aws/lambda-invoke-store';
import * as Sentry from '@sentry/nextjs';
import { serverIntegrations } from '@/lib/sentry-server-integrations';

const credentials = { accessKeyId: 'synthetic-r2-key', secretAccessKey: 'synthetic-r2-secret' };
const context = {
  [InvokeStoreBase.PROTECTED_KEYS.TRACEPARENT]: '00-11111111111111111111111111111111-2222222222222222-01',
  [InvokeStoreBase.PROTECTED_KEYS.TRACESTATE]: 'synthetic=r2',
  [InvokeStoreBase.PROTECTED_KEYS.BAGGAGE]: 'synthetic=r2',
};
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const hmac = (key: string | Buffer, text: string) => createHmac('sha256', key).update(text).digest();
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Independently verify what reached the server, not the SDK's pre-HTTP request.
// Instrumentation can change a signed header between those two points.
function verifies(request: IncomingMessage): boolean {
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(request.headers.authorization ?? '');
  if (!match || match[1] !== credentials.accessKeyId) return false;
  const scope = match[2]!;
  const signedHeaders = match[3]!;
  const signature = match[4]!;
  const names = signedHeaders.split(';');
  if (names.some((name) => typeof request.headers[name] !== 'string')) return false;
  const canonicalHeaders = names.map((name) => `${name}:${(request.headers[name] as string).trim().replace(/\s+/g, ' ')}\n`).join('');
  const url = new URL(request.url!, 'http://127.0.0.1');
  const query = [...url.searchParams].map(([key, value]) => [encode(key), encode(value)].join('=')).sort().join('&');
  const payloadHash = request.headers['x-amz-content-sha256'] ?? sha256('');
  const canonical = [request.method, url.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const [date, region, service, terminator] = scope.split('/');
  if (!date || !region || !service || terminator !== 'aws4_request') return false;
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), service), terminator);
  const expected = hmac(key, ['AWS4-HMAC-SHA256', request.headers['x-amz-date'], scope, sha256(canonical)].join('\n'));
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

let store: InvokeStoreBase;
beforeAll(async () => {
  store = await InvokeStore.getInstanceAsync(true);
  Sentry.init({
    dsn: 'https://public@sentry.invalid/1',
    defaultIntegrations: false,
    integrations: serverIntegrations(),
    tracesSampleRate: 1,
    tracePropagationTargets: ['http://127.0.0.1'],
    // All telemetry stays in memory; the only socket is the loopback test server.
    transport: () => ({ send: async () => ({ statusCode: 200 }), flush: async () => true }),
  });
});

afterAll(async () => {
  await Sentry.close(2000);
  vi.unstubAllEnvs();
});

async function headObject(hardened: boolean) {
  const received: Array<{ valid: boolean; signedHeaders: string; baggage?: string }> = [];
  const server = http.createServer((request, response) => {
    const valid = verifies(request);
    received.push({
      valid,
      signedHeaders: request.headers.authorization?.split('SignedHeaders=')[1]?.split(',')[0] ?? '',
      baggage: request.headers.baggage?.toString(),
    });
    response.writeHead(valid ? 200 : 403, { 'content-length': '0' });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let client: S3Client | undefined;
  try {
    const { port } = server.address() as AddressInfo;
    if (hardened) {
      vi.stubEnv('R2_ACCOUNT_ID', 'synthetic-account');
      vi.stubEnv('R2_ACCESS_KEY_ID', credentials.accessKeyId);
      vi.stubEnv('R2_SECRET_ACCESS_KEY', credentials.secretAccessKey);
      const { r2 } = await import('@/lib/r2');
      client = r2();
      client.config.endpoint = async () => ({ protocol: 'http:', hostname: '127.0.0.1', port, path: '/' });
    } else {
      client = new S3Client({ region: 'auto', endpoint: `http://127.0.0.1:${port}`, credentials, forcePathStyle: true, maxAttempts: 1 });
    }
    // Fail closed if endpoint resolution ever stops respecting the local override.
    const handler = client.config.requestHandler;
    const handle = handler.handle.bind(handler);
    vi.spyOn(handler, 'handle').mockImplementation((request, options) => {
      if (request.hostname !== '127.0.0.1' || request.port !== port) throw new Error('Non-local request forbidden');
      return handle(request, options);
    });
    const command = new HeadObjectCommand({ Bucket: 'synthetic-photos', Key: 'trace-check.jpg' });
    const status = await store.run(context, () => Sentry.startSpan({ name: 'synthetic R2 HEAD' }, async () => {
      try {
        return (await client!.send(command)).$metadata.httpStatusCode;
      } catch (error) {
        return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      }
    }));
    expect(received).toHaveLength(1);
    // Prove Sentry's real outgoing integration ran and changed the baggage.
    expect(received[0]!.baggage).toContain('sentry-trace_id=');
    return { status, ...received[0]! };
  } finally {
    client?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  }
}

describe('R2 signatures with InvokeStore and Sentry HTTP tracing', () => {
  it('reproduces an invalid signature when Sentry changes SDK-signed baggage', async () => {
    const result = await headObject(false);
    expect(result.signedHeaders.split(';')).toContain('baggage');
    expect(result.valid).toBe(false);
    expect(result.status).toBe(403);
  });

  it('the application R2 client sends a HeadObject signature the server can verify', async () => {
    const result = await headObject(true);
    expect(result.valid).toBe(true);
    expect(result.status).toBe(200);
    expect(result.signedHeaders.split(';')).toContain('host');
    for (const header of ['traceparent', 'tracestate', 'baggage']) {
      expect(result.signedHeaders.split(';')).not.toContain(header);
    }
  });
});
