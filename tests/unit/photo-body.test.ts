// @vitest-environment node
/**
 * Photos of a large customer (2026-11-15): lib/photo-body.ts guardStoreBody, the
 * piece that gives the photo store's connection back when the photo route's answer
 * will not be read (the browser left, HEAD, an error), and cuts a body that sends
 * nothing for 30 s. The real-socket half is tests/unit/photo-body-socket.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import {
  guardStoreBody,
  readStoreBody,
  PhotoSizeMismatch,
  PHOTO_BUFFER_MAX_BYTES,
  STORE_IDLE_MS,
} from '@/lib/photo-body';

type Timed = PassThrough & { setTimeout: ReturnType<typeof vi.fn> };

function nodeBody(): Timed {
  const b = new PassThrough() as Timed;
  b.setTimeout = vi.fn();
  return b;
}

function webBody() {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel,
  });
  return { stream, cancel };
}

const live = () => new AbortController().signal;

describe('a Node body (the SDK body on Node is the http.IncomingMessage)', () => {
  it('the idle limit is 30 s, and its callback calls onIdle and destroys the body', () => {
    expect(STORE_IDLE_MS).toBe(30_000);
    const b = nodeBody();
    const onIdle = vi.fn();
    const g = guardStoreBody(b, live(), onIdle)!;
    expect(b.setTimeout).toHaveBeenCalledTimes(1);
    expect(b.setTimeout.mock.calls[0]![0]).toBe(30_000);
    expect(onIdle).not.toHaveBeenCalled();
    expect(g.isDestroyed()).toBe(false);
    (b.setTimeout.mock.calls[0]![1] as () => void)();
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(b.destroyed).toBe(true);
    expect(g.isDestroyed()).toBe(true);
  });

  it('the idle limit can be given (the socket test uses short ones)', () => {
    const b = nodeBody();
    guardStoreBody(b, live(), () => {}, 250);
    expect(b.setTimeout.mock.calls[0]![0]).toBe(250);
  });

  it('adds no data listener of its own, and a body without setTimeout is still guarded', () => {
    const b = new PassThrough();
    const g = guardStoreBody(b, live(), () => {});
    expect(g).not.toBeNull();
    // Readable.toWeb reads through one 'data' listener; nothing else is added.
    expect(b.listenerCount('data')).toBe(1);
  });

  it('the web stream reads the body through', async () => {
    const b = nodeBody();
    const g = guardStoreBody(b, live(), () => {})!;
    b.end(Buffer.from([7, 8, 9]));
    const got = new Uint8Array(await new Response(g.web).arrayBuffer());
    expect([...got]).toEqual([7, 8, 9]);
  });

  it('a body that ended by itself is not read as cut, and its bytes stay in the web stream', async () => {
    const b = nodeBody();
    const g = guardStoreBody(b, live(), () => {})!;
    b.end(Buffer.alloc(3000, 4)); // small: one chunk, taken by the web stream at once
    await new Promise((r) => setTimeout(r, 10));
    expect(b.destroyed).toBe(true); // autoDestroy after the end
    expect(g.isDestroyed()).toBe(false);
    g.release(); // nothing left to give back
    expect(new Uint8Array(await new Response(g.web).arrayBuffer()).length).toBe(3000);
  });

  it('cancelling the web stream destroys the source', async () => {
    const b = nodeBody();
    const g = guardStoreBody(b, live(), () => {})!;
    b.write(Buffer.alloc(10));
    await g.web.cancel();
    expect(b.destroyed).toBe(true);
    expect(g.isDestroyed()).toBe(true);
  });

  it('release() destroys it, and a second release is safe', () => {
    const b = nodeBody();
    const destroy = vi.spyOn(b, 'destroy');
    const g = guardStoreBody(b, live(), () => {})!;
    g.release();
    expect(b.destroyed).toBe(true);
    expect(g.isDestroyed()).toBe(true);
    expect(() => g.release()).not.toThrow();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('a signal aborted already releases at once', () => {
    const b = nodeBody();
    const ac = new AbortController();
    ac.abort();
    const g = guardStoreBody(b, ac.signal, () => {})!;
    expect(b.destroyed).toBe(true);
    expect(g.isDestroyed()).toBe(true);
  });

  it('a later abort releases', () => {
    const b = nodeBody();
    const ac = new AbortController();
    const g = guardStoreBody(b, ac.signal, () => {})!;
    expect(b.destroyed).toBe(false);
    ac.abort();
    expect(b.destroyed).toBe(true);
    expect(g.isDestroyed()).toBe(true);
  });

  it('any Readable, not only a PassThrough', () => {
    const r = Readable.from([Buffer.from([1])]);
    expect(guardStoreBody(r, live(), () => {})).not.toBeNull();
  });
});

describe('a web ReadableStream (the unit-test fixtures)', () => {
  it('web is the same stream', () => {
    const { stream } = webBody();
    expect(guardStoreBody(stream, live(), () => {})!.web).toBe(stream);
  });

  it('release cancels it once, and isDestroyed becomes true', async () => {
    const { stream, cancel } = webBody();
    const cancelCalls = vi.spyOn(stream, 'cancel');
    const g = guardStoreBody(stream, live(), () => {})!;
    expect(g.isDestroyed()).toBe(false);
    g.release();
    g.release();
    await Promise.resolve();
    expect(cancelCalls).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(g.isDestroyed()).toBe(true);
  });

  it('a stream already handed over (locked) does not throw on release', async () => {
    const { stream } = webBody();
    const g = guardStoreBody(stream, live(), () => {})!;
    stream.getReader();
    expect(() => g.release()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // the refused cancel is swallowed
    expect(g.isDestroyed()).toBe(true);
  });

  it('an aborted signal cancels it at once; a later abort too', async () => {
    const a = webBody();
    const ac = new AbortController();
    ac.abort();
    expect(guardStoreBody(a.stream, ac.signal, () => {})!.isDestroyed()).toBe(true);
    const b = webBody();
    const ac2 = new AbortController();
    const g = guardStoreBody(b.stream, ac2.signal, () => {})!;
    ac2.abort();
    await Promise.resolve();
    expect(g.isDestroyed()).toBe(true);
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(b.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('anything else', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['{}', {}],
    ['a Uint8Array', new Uint8Array([1])],
  ])('%s gives null', (_name, body) => {
    expect(guardStoreBody(body, live(), () => {})).toBeNull();
  });
});

/**
 * Buffered serving (2026-11-15): readStoreBody reads an ordinary photo from the store
 * to its end before the route answers, and refuses a body that is not the size
 * recorded at upload.
 */
describe('readStoreBody', () => {
  const CHUNK = 16 * 1024;
  /** A Node body that receives `n` bytes in 16 KB chunks (byte i is i % 251). */
  function fed(n: number, end = true): Timed {
    const b = nodeBody();
    for (let at = 0; at < n; at += CHUNK) {
      const len = Math.min(CHUNK, n - at);
      b.write(Buffer.from(Uint8Array.from({ length: len }, (_, i) => (at + i) % 251)));
    }
    if (end) b.end();
    return b;
  }
  const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

  it('the buffer limit is 8 MB, above the 3 MB upload cap', () => {
    expect(PHOTO_BUFFER_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it('exact: resolves with exactly the expected bytes, the body read to its end', async () => {
    const b = fed(100_000);
    const g = guardStoreBody(b, live(), () => {})!;
    const got = await readStoreBody(g, 100_000);
    expect(got).toBeInstanceOf(Uint8Array);
    expect(got.byteLength).toBe(100_000);
    expect(got).toEqual(pattern(100_000));
    expect(b.readableEnded).toBe(true);
    expect(g.isDestroyed()).toBe(false);
    expect(g.web.locked).toBe(false);
  });

  it('short: the body ends early and it rejects with PhotoSizeMismatch (more = false), and releases', async () => {
    const b = fed(70_000);
    const g = guardStoreBody(b, live(), () => {})!;
    const release = vi.spyOn(g, 'release');
    const err = await readStoreBody(g, 100_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhotoSizeMismatch);
    expect(err).toMatchObject({ name: 'PhotoSizeMismatch', expected: 100_000, got: 70_000, more: false });
    expect(release).toHaveBeenCalled();
    expect(g.web.locked).toBe(false);
  });

  it('long: it stops as soon as more than expected arrived, releases the body, and rejects (more = true)', async () => {
    const b = fed(200_000, false); // and the store would go on sending
    const destroy = vi.spyOn(b, 'destroy');
    const g = guardStoreBody(b, live(), () => {})!;
    const err = (await readStoreBody(g, 100_000).catch((e: unknown) => e)) as PhotoSizeMismatch;
    expect(err).toBeInstanceOf(PhotoSizeMismatch);
    expect(err.more).toBe(true);
    expect(err.expected).toBe(100_000);
    // The first chunk past the limit: 7 chunks of 16 KB = 114688 bytes.
    expect(err.got).toBe(7 * CHUNK);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(b.destroyed).toBe(true);
    expect(b.readableEnded).toBe(false);
    expect(g.web.locked).toBe(false);
  });

  it('long: it never pulls more than the expected bytes plus one chunk (and what the stream queues ahead)', async () => {
    let pulled = 0;
    const cancel = vi.fn();
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled += CHUNK;
          c.enqueue(new Uint8Array(CHUNK));
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    const g = guardStoreBody(endless, live(), () => {})!;
    const err = (await readStoreBody(g, 10 * CHUNK).catch((e: unknown) => e)) as PhotoSizeMismatch;
    expect(err).toBeInstanceOf(PhotoSizeMismatch);
    expect(err.got).toBe(11 * CHUNK);
    expect(pulled).toBeLessThanOrEqual(12 * CHUNK);
    expect(cancel).toHaveBeenCalledTimes(1); // released: the endless body is cancelled
    expect(g.isDestroyed()).toBe(true);
  });

  it('destroyed mid-read (idle cut, store error): rejects with that error and leaves nothing locked', async () => {
    const b = fed(50_000, false);
    const g = guardStoreBody(b, live(), () => {})!;
    const pending = readStoreBody(g, 100_000).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    b.destroy(new Error('socket hang up'));
    const err = (await pending) as Error;
    expect(err).not.toBeInstanceOf(PhotoSizeMismatch);
    expect(err.message).toBe('socket hang up');
    expect(g.isDestroyed()).toBe(true);
    expect(g.web.locked).toBe(false);
  });

  it('the idle limit firing mid-read rejects the read (with the AbortError a plain destroy gives)', async () => {
    const b = fed(50_000, false);
    const onIdle = vi.fn();
    const g = guardStoreBody(b, live(), onIdle)!;
    const pending = readStoreBody(g, 100_000).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    (b.setTimeout.mock.calls[0]![1] as () => void)();
    const err = (await pending) as Error;
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(err.name).toBe('AbortError');
    expect(g.isDestroyed()).toBe(true);
  });

  it('a signal aborted mid-read destroys the body and rejects the read', async () => {
    const b = fed(50_000, false);
    const ac = new AbortController();
    const g = guardStoreBody(b, ac.signal, () => {})!;
    const pending = readStoreBody(g, 100_000).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    expect(b.destroyed).toBe(false);
    ac.abort();
    expect(b.destroyed).toBe(true);
    const err = (await pending) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PhotoSizeMismatch);
    expect(g.web.locked).toBe(false);
  });

  it('zero bytes: an empty body resolves with an empty array; any byte is too many', async () => {
    const empty = guardStoreBody(fed(0), live(), () => {})!;
    expect((await readStoreBody(empty, 0)).byteLength).toBe(0);
    const one = guardStoreBody(fed(1), live(), () => {})!;
    const err = (await readStoreBody(one, 0).catch((e: unknown) => e)) as PhotoSizeMismatch;
    expect(err).toBeInstanceOf(PhotoSizeMismatch);
    expect(err).toMatchObject({ expected: 0, got: 1, more: true });
  });

  it('a web body read in full resolves too (the unit-test fixtures)', async () => {
    const closed = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        c.enqueue(new Uint8Array([3]));
        c.close();
      },
    });
    expect([...(await readStoreBody(guardStoreBody(closed, live(), () => {})!, 3))]).toEqual([1, 2, 3]);
  });
});
