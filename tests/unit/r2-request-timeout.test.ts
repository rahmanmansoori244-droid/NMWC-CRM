// @vitest-environment node
/**
 * REL-05, as corrected by the review of the recheck fixes (2026-09-28): the R2
 * client's 10-second request timeout has to END a request, not only log about it.
 *
 * lib/r2.ts set `requestTimeout: 10_000` and described the worst case of one call
 * as 2 × 13 s. The pinned @smithy/node-http-handler only logs a warning when that
 * time passes unless `throwOnRequestTimeout` is set, so a request R2 accepted and
 * never answered hung until Vercel killed the function. This drives the client's
 * real request handler against a local server that accepts the request and never
 * answers it, with the handler's timers on a faked clock.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the R2 client', () => {
  it('rejects a request R2 accepts and never answers once the 10-second request timeout passes', async () => {
    const sockets: net.Socket[] = [];
    let received!: () => void;
    const requestArrived = new Promise<void>((resolve) => (received = resolve));
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on('data', () => received());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      vi.stubEnv('R2_ACCOUNT_ID', 'timeout-test');
      vi.stubEnv('R2_ACCESS_KEY_ID', 'timeout-test-key');
      vi.stubEnv('R2_SECRET_ACCESS_KEY', 'timeout-test-secret');
      const { r2 } = await import('@/lib/r2');
      const handler = r2().config.requestHandler as unknown as {
        handle: (request: unknown) => Promise<unknown>;
      };

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const outcome = handler
        .handle({ protocol: 'http:', hostname: '127.0.0.1', port, method: 'GET', path: '/nmwc-photos/key', query: {}, headers: {} })
        .then(
          () => 'answered',
          (err: Error) => err.name
        );
      // Connected and sent: from here only the request timeout can end it.
      await requestArrived;
      await vi.advanceTimersByTimeAsync(10_000);
      const settled = await Promise.race([outcome, new Promise((resolve) => setImmediate(() => resolve('still waiting')))]);
      expect(settled).toBe('TimeoutError');
    } finally {
      vi.useRealTimers();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
