// @vitest-environment node
/**
 * Photos of a large customer (2026-11-15): lib/photo-body.ts guardStoreBody, the
 * piece that gives the photo store's connection back when the photo route's answer
 * will not be read (the browser left, HEAD, an error), and cuts a body that sends
 * nothing for 30 s. The real-socket half is tests/unit/photo-body-socket.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { guardStoreBody, STORE_IDLE_MS } from '@/lib/photo-body';

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
