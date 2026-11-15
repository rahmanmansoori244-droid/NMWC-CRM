// @vitest-environment node
/**
 * Photos of a large customer (2026-11-15): guardStoreBody on real sockets, no mocks.
 *
 * A node:http server on 127.0.0.1 inside the test plays the photo store; a
 * keep-alive http.Agent with maxSockets 2 plays the store client's pool; every
 * answer goes through guardStoreBody as the photo route sends it. Held here:
 *  (a) many answers over one kept-alive socket add no listener to it;
 *  (b) an earlier answer's short idle limit does not survive on the pooled socket;
 *  (c) a body never read is cut after idleMs, onIdle once, and the pool is empty;
 *  (d) an aborted signal, before or after guarding, frees the socket at once;
 *  (e) cancelling the web stream mid-body frees the socket.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { guardStoreBody } from '@/lib/photo-body';

const SMALL = Buffer.alloc(32 * 1024, 1);
const BIG = 8 * 1024 * 1024; // far more than every buffer between the two ends

let server: http.Server;
let port: number;
let agent: http.Agent;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/small') {
      res.writeHead(200, { 'Content-Length': SMALL.length });
      res.end(SMALL);
    } else if (req.url === '/pause') {
      // Half the body, a pause, then the rest.
      res.writeHead(200, { 'Content-Length': SMALL.length });
      res.write(SMALL.subarray(0, SMALL.length / 2));
      setTimeout(() => res.end(SMALL.subarray(SMALL.length / 2)), 600);
    } else if (req.url === '/big') {
      res.writeHead(200, { 'Content-Length': BIG });
      const chunk = Buffer.alloc(64 * 1024, 2);
      let sent = 0;
      const pump = () => {
        while (sent < BIG && !res.destroyed) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        if (!res.destroyed) res.end();
      };
      pump();
    } else {
      res.writeHead(404).end();
    }
  });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((ok) => server.close(ok));
});

// A fresh pool per test, so one test's sockets never meet another's.
afterEach(() => agent?.destroy());
const newAgent = () => (agent = new http.Agent({ keepAlive: true, maxSockets: 2 }));

const inUse = () => Object.values(agent.sockets).reduce((n, l) => n + (l?.length ?? 0), 0);
const free = () => Object.values(agent.freeSockets).reduce((n, l) => n + (l?.length ?? 0), 0);

function get(path: string): Promise<http.IncomingMessage> {
  return new Promise((ok, fail) => {
    http.get({ host: '127.0.0.1', port, path, agent }, ok).on('error', fail);
  });
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function readAll(web: ReadableStream<Uint8Array>): Promise<number> {
  let n = 0;
  const reader = web.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return n;
    n += value.length;
  }
}

function listenerTotal(s: Socket): number {
  return s.eventNames().reduce((n, e) => n + s.listenerCount(e), 0);
}

describe('guardStoreBody on real sockets', () => {
  it('(a) 20 answers read in full over one kept-alive socket add no listener to it', async () => {
    newAgent();
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on('warning', onWarning);
    try {
      const sockets = new Set<Socket>();
      const counts: number[] = [];
      for (let i = 0; i < 20; i++) {
        const res = await get('/small');
        const sock = res.socket as Socket;
        sockets.add(sock);
        const g = guardStoreBody(res, new AbortController().signal, () => {}, 30_000)!;
        expect(await readAll(g.web)).toBe(SMALL.length);
        await until(() => free() === 1 && inUse() === 0); // back in the pool
        counts.push(listenerTotal(sock));
        expect(sock.timeout ?? 0).toBe(0); // the idle limit went with the answer
      }
      expect(sockets.size).toBe(1);
      expect(new Set(counts).size).toBe(1);
      expect(warnings).not.toContain('MaxListenersExceededWarning');
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('(b) an earlier short idle limit does not cut a later answer on the same socket', async () => {
    newAgent();
    const idle: string[] = [];
    const first = await get('/small');
    const sock = first.socket; // res.socket is let go once the answer ends
    const g1 = guardStoreBody(first, new AbortController().signal, () => idle.push('first'), 150)!;
    expect(await readAll(g1.web)).toBe(SMALL.length);
    await until(() => free() === 1);

    const second = await get('/pause'); // pauses 600 ms, four times the first limit
    expect(second.socket).toBe(sock);
    const g2 = guardStoreBody(second, new AbortController().signal, () => idle.push('second'), 10_000)!;
    expect(await readAll(g2.web)).toBe(SMALL.length);
    expect(g2.isDestroyed()).toBe(false);

    // And with no guard at all on the reused socket: nothing left behind cuts it.
    await until(() => free() === 1);
    const third = await get('/pause');
    expect(third.socket).toBe(sock);
    let n = 0;
    for await (const chunk of third) n += (chunk as Buffer).length;
    expect(n).toBe(SMALL.length);
    expect(idle).toEqual([]);
  });

  it('(c) a body never read is cut after idleMs, onIdle once, and the pool is empty', async () => {
    newAgent();
    let idleCalls = 0;
    const res = await get('/big');
    const g = guardStoreBody(res, new AbortController().signal, () => idleCalls++, 200)!;
    expect(inUse()).toBe(1);
    await until(() => g.isDestroyed(), 3000);
    expect(idleCalls).toBe(1);
    await until(() => inUse() === 0);
    await new Promise((r) => setTimeout(r, 400)); // nothing fires twice
    expect(idleCalls).toBe(1);
    expect(inUse()).toBe(0);
    expect(free()).toBe(0);
  });

  it('(d) a signal aborted before guarding frees the socket at once', async () => {
    newAgent();
    const res = await get('/big');
    const ac = new AbortController();
    ac.abort();
    const g = guardStoreBody(res, ac.signal, () => {}, 30_000)!;
    expect(g.isDestroyed()).toBe(true);
    await until(() => inUse() === 0, 500);
  });

  it('(d) a signal aborted after guarding frees the socket at once', async () => {
    newAgent();
    const res = await get('/big');
    const ac = new AbortController();
    const g = guardStoreBody(res, ac.signal, () => {}, 30_000)!;
    await new Promise((r) => setTimeout(r, 50));
    expect(inUse()).toBe(1);
    ac.abort();
    expect(g.isDestroyed()).toBe(true);
    await until(() => inUse() === 0, 500);
  });

  it('(e) cancelling the web stream mid-body frees the socket', async () => {
    newAgent();
    const res = await get('/big');
    const g = guardStoreBody(res, new AbortController().signal, () => {}, 30_000)!;
    const reader = g.web.getReader();
    const { value } = await reader.read();
    expect(value!.length).toBeGreaterThan(0);
    expect(inUse()).toBe(1);
    await reader.cancel();
    // Node aborts the response's request for it, on the next tick.
    await until(() => g.isDestroyed() && inUse() === 0, 500);
  });
});
