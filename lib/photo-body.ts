/**
 * Photos of a large customer (2026-11-15): the photo store's answer body, guarded so
 * that its connection is always given back.
 *
 * The photo route hands the store's body to the browser. When the browser leaves
 * before the route has returned, or sends HEAD, nobody reads or destroys that body,
 * and its connection stays out of the store client's pool (50 sockets) until the
 * process ends. Fifty such leaves and every photo answers 502 and every upload check
 * 503 (measured on a local production build, 2026-11-15).
 *
 * guardStoreBody gives the route:
 *  - `web`, the body as a web stream, made AT ONCE: a stream made from a body that
 *    was already destroyed reads as an empty, complete body (a 200 with nothing in
 *    it), while a body destroyed after this point errors the web stream instead;
 *  - `release()`, which gives the connection back (destroys or cancels the body), and
 *    is called by itself when the request's signal aborts (the browser is gone);
 *  - `isDestroyed()`, so the route can answer 502 instead of handing over a body
 *    that is already cut (destroyed before its end; a body that simply ended has
 *    all its bytes in `web` and is served).
 * A Node body also gets an idle limit on its socket: no byte for `idleMs` (30 s) and
 * it is destroyed and `onIdle` is called. It uses the response's own socket timeout,
 * with no 'data' listener, and Node's agent resets that timeout when the socket goes
 * back to the pool, so it does not carry over to the next request on it
 * (tests/unit/photo-body-socket.test.ts).
 */
import { Readable } from 'node:stream';

/** No byte from the photo store for this long and the body is cut (owner question: 30 s). */
export const STORE_IDLE_MS = 30_000;

export type GuardedBody = {
  readonly web: ReadableStream<Uint8Array>;
  isDestroyed(): boolean;
  release(): void;
};

type TimedReadable = Readable & { setTimeout?: (ms: number, cb: () => void) => unknown };

export function guardStoreBody(
  body: unknown,
  signal: AbortSignal,
  onIdle: () => void,
  idleMs: number = STORE_IDLE_MS
): GuardedBody | null {
  let guarded: GuardedBody;
  if (body instanceof Readable) {
    // On Node the SDK's Body is the http.IncomingMessage itself.
    const node = body as TimedReadable;
    if (typeof node.setTimeout === 'function') {
      node.setTimeout(idleMs, () => {
        onIdle();
        node.destroy();
      });
    }
    const web = Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
    guarded = {
      web,
      // Destroyed before its end. A body that ended is destroyed too (autoDestroy),
      // but then every byte is already queued in `web`: a small photo read in full
      // while the PHOTO_VIEW row was written must still be served.
      isDestroyed: () => node.destroyed && !node.readableEnded,
      release: () => {
        if (!node.destroyed) node.destroy();
      },
    };
  } else if (body instanceof ReadableStream) {
    const stream = body as ReadableStream<Uint8Array>;
    let cancelled = false;
    guarded = {
      web: stream,
      isDestroyed: () => cancelled,
      release: () => {
        if (!cancelled) {
          cancelled = true;
          // A stream already handed over is locked and refuses; nothing to do then.
          stream.cancel().catch(() => {});
        }
      },
    };
  } else {
    return null;
  }
  if (signal.aborted) guarded.release();
  else signal.addEventListener('abort', guarded.release, { once: true });
  return guarded;
}
