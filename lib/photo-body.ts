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
 *
 * Buffered serving (2026-11-15, after the first build): the idle limit cannot tell a
 * browser that stopped reading from one that reads slowly, once a photo is bigger
 * than the buffers between the store and the browser (a 3 MB photo read at 16 KB
 * every 20 s was cut at 30 s; measured). So an ordinary photo is now read from the
 * store to its end first (readStoreBody) and only then sent. The store connection
 * is held only while the store delivers, and the 30 s limit measures the store, not
 * the browser. An object above PHOTO_BUFFER_MAX_BYTES (none should exist: uploads
 * are capped at 3 MB) is still handed over as a stream, as before.
 */
import { Readable } from 'node:stream';

/** No byte from the photo store for this long and the body is cut (owner question: 30 s). */
export const STORE_IDLE_MS = 30_000;

/** Photos up to this size are read in full before they are sent (uploads are capped at 3 MB). */
export const PHOTO_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

/** The store's body is not the size recorded for the photo at upload. */
export class PhotoSizeMismatch extends Error {
  readonly expected: number;
  readonly got: number;
  /** true: more bytes than expected arrived (reading stopped there); false: the body ended short. */
  readonly more: boolean;
  constructor(expected: number, got: number, more: boolean) {
    super(`photo body is ${more ? 'longer' : 'shorter'} than recorded (${got} ${more ? '>' : '<'} ${expected})`);
    this.name = 'PhotoSizeMismatch';
    this.expected = expected;
    this.got = got;
    this.more = more;
  }
}

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

/**
 * Reads the guarded body to its end and resolves with exactly `expectedBytes` bytes.
 * Rejects with PhotoSizeMismatch when the body ends short, or as soon as more bytes
 * than that have arrived (it then stops reading and releases the body, so it never
 * holds more than `expectedBytes` plus one chunk). A body destroyed while it reads
 * (browser gone, idle cut, store error) rejects with that error. On every rejection
 * the reader's lock is let go and the body is released; nothing is left locked and
 * unread.
 */
export async function readStoreBody(guarded: GuardedBody, expectedBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(new ArrayBuffer(expectedBytes));
  let got = 0;
  let failed = false;
  let failure: unknown;
  const fail = (err: unknown) => {
    failed = true;
    failure = err;
  };
  const reader = guarded.web.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.byteLength > expectedBytes) {
        fail(new PhotoSizeMismatch(expectedBytes, got + value.byteLength, true));
        break;
      }
      out.set(value, got);
      got += value.byteLength;
    }
    if (!failed && got < expectedBytes) fail(new PhotoSizeMismatch(expectedBytes, got, false));
  } catch (err) {
    fail(err);
  }
  // Let go of the lock first: a web body can only be cancelled when it is unlocked.
  reader.releaseLock();
  if (failed) {
    guarded.release();
    throw failure;
  }
  return out;
}
