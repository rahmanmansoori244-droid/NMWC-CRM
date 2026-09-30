// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readJsonObject } from '@/lib/fetch-route';

const encoder = new TextEncoder();
const request = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new NextRequest('https://nmwc.example/api/forms/customer-edit', {
    method: 'POST', body, headers: { 'content-type': 'application/json', ...headers },
  });

function chunks(values: Uint8Array[], cancel = vi.fn()) {
  let index = 0;
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index < values.length) controller.enqueue(values[index++]!);
    else controller.close();
  });
  return { stream: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), pull, cancel };
}

afterEach(() => vi.restoreAllMocks());

describe('readJsonObject with an optional byte cap', () => {
  it('keeps the existing req.json path for callers that do not ask for a cap', async () => {
    const req = request(JSON.stringify({ text: 'x'.repeat(1024) }));
    const json = vi.spyOn(req, 'json');
    expect(await readJsonObject(req)).toEqual({ body: { text: 'x'.repeat(1024) } });
    expect(json).toHaveBeenCalledOnce();
  });

  it('accepts exactly the byte limit and rejects one byte more', async () => {
    const raw = '{"text":"ok"}';
    const limit = encoder.encode(raw).byteLength;
    expect(await readJsonObject(request(raw), limit)).toEqual({ body: { text: 'ok' } });
    const result = await readJsonObject(request(`${raw} `), limit);
    expect('refused' in result && result.refused.status).toBe(413);
  });

  it('counts UTF-8 bytes, not JavaScript characters', async () => {
    const raw = '{"text":"عمان"}';
    const bytes = encoder.encode(raw).byteLength;
    expect(bytes).toBeGreaterThan(raw.length);
    expect(await readJsonObject(request(raw), bytes)).toEqual({ body: { text: 'عمان' } });
    const result = await readJsonObject(request(raw), bytes - 1);
    expect('refused' in result && result.refused.status).toBe(413);
  });

  it('decodes split UTF-8 characters and a split BOM like req.json', async () => {
    const raw = '\uFEFF{"text":"عمان 🇴🇲"}';
    const bytes = encoder.encode(raw);
    const source = chunks(Array.from(bytes, (byte) => Uint8Array.of(byte)));
    const req = request(source.stream);
    expect(await readJsonObject(req, bytes.byteLength)).toEqual({ body: { text: 'عمان 🇴🇲' } });
    expect(source.cancel).not.toHaveBeenCalled();
    expect(req.body!.locked).toBe(false);
  });

  it.each<Record<string, string>>([{}, { 'content-length': '1' }, { 'content-length': 'not-a-length' }])(
    'counts the actual stream even when Content-Length is absent or misleading: %j',
    async (headers) => {
      const source = chunks([encoder.encode('{"text":"'), encoder.encode('overflow'), encoder.encode('"}')]);
      const req = request(source.stream, headers);
      const parse = vi.spyOn(JSON, 'parse');
      const result = await readJsonObject(req, 10);
      expect('refused' in result && result.refused.status).toBe(413);
      expect(source.pull).toHaveBeenCalledTimes(2);
      expect(source.cancel).toHaveBeenCalledOnce();
      expect(parse).not.toHaveBeenCalled();
      expect(req.body!.locked).toBe(false);
    }
  );

  it.each(['reject', 'pending'] as const)('keeps 413 when stream cancellation is %s', async (kind) => {
    const cancel = vi.fn(() => kind === 'reject'
      ? Promise.reject(new Error('private cancellation detail'))
      : new Promise<void>(() => {}));
    const source = chunks([encoder.encode('{"private":"detail"}')], cancel);
    const result = await readJsonObject(request(source.stream), 2);
    expect('refused' in result && result.refused.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['', '{invalid', 'null', '[]', '"text"', '1'])(
    'preserves the invalid JSON/object refusal for %j', async (raw) => {
      const result = await readJsonObject(request(raw), 1024);
      expect('refused' in result && result.refused.status).toBe(400);
      if ('refused' in result) expect((await result.refused.json()).code).toBe('INVALID_JSON');
    }
  );

  it('refuses a missing body as invalid JSON', async () => {
    const result = await readJsonObject(request(null), 1024);
    expect('refused' in result && result.refused.status).toBe(400);
  });

  it('never prints body bytes or read/cancel errors in responses or console output', async () => {
    const privateText = 'synthetic-private-request-value';
    const logs = ['log', 'error', 'warn'].map((method) =>
      vi.spyOn(console, method as 'log' | 'error' | 'warn').mockImplementation(() => {}));
    const source = chunks([encoder.encode(JSON.stringify({ text: privateText }))],
      vi.fn(() => Promise.reject(new Error(privateText))));
    const overflowing = await readJsonObject(request(source.stream), 2);
    expect('refused' in overflowing && overflowing.refused.status).toBe(413);
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error(privateText)); },
    });
    const failed = await readJsonObject(request(broken), 1024);
    expect('refused' in failed && failed.refused.status).toBe(400);
    for (const result of [overflowing, failed]) {
      if ('refused' in result) expect(await result.refused.text()).not.toContain(privateText);
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});
