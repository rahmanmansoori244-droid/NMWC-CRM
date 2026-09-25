// @vitest-environment node
/**
 * Benchmark item 22: what the phone knows after a submit, and which submission
 * id a retry carries (lib/submit-client.ts, lib/submission.ts). The rule these
 * pin: only "offline" and "signed out" are certain that nothing was saved;
 * every other non-answer is "unconfirmed", keeps the id, and a retry with that
 * id is answered "Already received" if the first attempt landed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MAINTENANCE_HEADER, noticeFor, postForm, SubmissionIds, SUBMIT_TIMEOUT_MS } from '@/lib/submit-client';
import {
  alreadyReceivedMessage,
  MAINTENANCE_MESSAGE,
  newSubmissionId,
  omanWhen,
  OFFLINE_AFTER_UNCONFIRMED_MESSAGE,
  OFFLINE_MESSAGE,
  SIGNED_OUT_MESSAGE,
  submissionIdSchema,
  UNCONFIRMED_MESSAGE,
  type SubmitReceipt,
} from '@/lib/submission';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let online = true;
beforeEach(() => {
  online = true;
  vi.stubGlobal('navigator', {
    get onLine() {
      return online;
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('postForm — what is known after a submit', () => {
  it('posts JSON to the form route, same-origin, without following redirects', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, data: { editId: 'e1' } }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await postForm('customer-edit', { a: 1 });
    expect(out).toEqual({ kind: 'answered', result: { ok: true, data: { editId: 'e1' } } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/forms/customer-edit');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.redirect).toBe('manual');
    expect(init.credentials).toBe('same-origin');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('an answered error is an answer', async () => {
    const body = { ok: false, code: 'EDIT_LOCKED', message: 'Pending.' };
    vi.stubGlobal('fetch', async () => json(body));
    expect(await postForm('customer-edit', {})).toEqual({ kind: 'answered', result: body });
  });

  it('no network at all: the send fails at once, and nothing left the phone', async () => {
    online = false;
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await postForm('customer-edit', {})).toEqual({ kind: 'offline' });
  });

  it('a phone that wrongly says offline still sends — the flag only chooses the words', async () => {
    online = false;
    vi.stubGlobal('fetch', async () => json({ ok: true, data: { editId: 'e1' } }));
    expect(await postForm('customer-edit', {})).toEqual({
      kind: 'answered',
      result: { ok: true, data: { editId: 'e1' } },
    });
  });

  it('closed for maintenance: turned away unread — not "we cannot tell"', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('<html>closed</html>', {
          status: 503,
          headers: { 'content-type': 'text/html', [MAINTENANCE_HEADER]: '1' },
        })
    );
    expect(await postForm('customer-edit', {})).toEqual({ kind: 'maintenance' });
    expect(noticeFor({ kind: 'maintenance' })).toEqual({ tone: 'failed', text: MAINTENANCE_MESSAGE, retry: true });
  });

  it("the route's 401: signed out, nothing read — not an answer, so Try again is offered", async () => {
    vi.stubGlobal('fetch', async () =>
      json({ ok: false, code: 'SIGNED_OUT', message: 'You are signed out, so nothing was sent.' }, 401)
    );
    expect(await postForm('customer-edit', {})).toEqual({ kind: 'signedOut' });
  });

  it('a forced password change redirected it: turned away, nothing read', async () => {
    vi.stubGlobal('fetch', async () => ({ type: 'opaqueredirect', status: 0, headers: new Headers() }));
    expect(await postForm('customer-edit', {})).toEqual({ kind: 'signedOut' });
  });

  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a server fault, even with a JSON body', async () => json({ ok: false, code: 'X', message: 'boom' }, 500)],
    ['a gateway timeout page', async () => new Response('<html>504</html>', { status: 504, headers: { 'content-type': 'text/html' } })],
    ['a 200 that is not JSON', async () => new Response('<html>proxy</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['JSON that is not an action result', async () => json({ hello: 'world' })],
    ['a dropped database connection (may have committed)', async () => json({ ok: false, code: 'DB_INTERRUPTED', message: 'x' })],
    ['a database that did not answer', async () => json({ ok: false, code: 'DB_UNAVAILABLE', message: 'x' })],
  ])('%s is unconfirmed — it may have arrived', async (_label, respond) => {
    vi.stubGlobal('fetch', respond);
    expect(await postForm('customer-edit', {})).toEqual({ kind: 'unconfirmed' });
  });

  it('a 503 without the maintenance marker is a fault, and unconfirmed', async () => {
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 503, headers: { 'content-type': 'text/plain' } }));
    expect(await postForm('customer-edit', {})).toEqual({ kind: 'unconfirmed' });
  });

  it('a network error after going offline mid-request is still unconfirmed, not offline', async () => {
    vi.stubGlobal('fetch', async () => {
      online = false; // the request left; the signal dropped while waiting
      throw new TypeError('Failed to fetch');
    });
    expect(await postForm('customer-edit', {})).toEqual({ kind: 'unconfirmed' });
  });

  it('a stalled request is aborted at the timeout and reported unconfirmed', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      signal = init.signal!;
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const pending = postForm('customer-edit', {});
    await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS - 1);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    expect(await pending).toEqual({ kind: 'unconfirmed' });
  });

  it('waits 30 seconds by default — past a normal submit, inside the 60 s server limit', () => {
    expect(SUBMIT_TIMEOUT_MS).toBe(30_000);
  });
});

describe('SubmissionIds — when a retry reuses its id', () => {
  const ids = () => {
    let n = 0;
    return new SubmissionIds(() => `id-${++n}`);
  };

  it('the same payload after no answer keeps its id', () => {
    const s = ids();
    expect(s.idFor({ a: 1 })).toBe('id-1');
    s.settle({ kind: 'unconfirmed' });
    expect(s.idFor({ a: 1 })).toBe('id-1');
    s.settle({ kind: 'offline' });
    s.settle({ kind: 'signedOut' });
    expect(s.idFor({ a: 1 })).toBe('id-1');
  });

  it('a changed payload gets a new id — reusing it could answer "received" for the old one', () => {
    const s = ids();
    s.idFor({ a: 1 });
    s.settle({ kind: 'unconfirmed' });
    expect(s.idFor({ a: 2 })).toBe('id-2');
  });

  it('remembers that a try of the open id went unanswered — until an answer or a new payload', () => {
    const s = ids();
    s.idFor({ a: 1 });
    expect(s.uncertain).toBe(false);
    s.settle({ kind: 'offline' });
    expect(s.uncertain).toBe(false); // nothing left the phone: no doubt yet
    s.settle({ kind: 'unconfirmed' });
    expect(s.uncertain).toBe(true);
    s.settle({ kind: 'offline' });
    expect(s.uncertain).toBe(true); // still: the earlier try may have arrived
    s.idFor({ a: 2 });
    expect(s.uncertain).toBe(false);
    s.settle({ kind: 'unconfirmed' });
    s.settle({ kind: 'answered', result: { ok: true, data: undefined } });
    expect(s.uncertain).toBe(false);
  });

  it('any answer spends the id, ok or not', () => {
    const s = ids();
    s.idFor({ a: 1 });
    s.settle({ kind: 'answered', result: { ok: false, code: 'VALIDATION_FAILED', message: 'x' } });
    expect(s.idFor({ a: 1 })).toBe('id-2');
    s.settle({ kind: 'answered', result: { ok: true, data: undefined } });
    expect(s.idFor({ a: 1 })).toBe('id-3');
  });

  it('mints v4 UUIDs the server accepts', () => {
    const id = new SubmissionIds().idFor({});
    expect(submissionIdSchema.safeParse(id).success).toBe(true);
    expect(submissionIdSchema.safeParse(newSubmissionId()).success).toBe(true);
  });
});

describe('the words beside the button', () => {
  const now = new Date('2026-09-25T10:00:00.000Z'); // 14:00 in Muscat
  const receipt = (state: SubmitReceipt['state']): SubmitReceipt => ({
    editId: 'e1',
    state,
    submittedAt: '2026-09-25T06:42:00.000Z', // 10:42 in Muscat
    replayed: true,
  });

  it('each non-answer says whether anything was sent, and offers Try again', () => {
    expect(noticeFor({ kind: 'offline' })).toEqual({ tone: 'failed', text: OFFLINE_MESSAGE, retry: true });
    expect(noticeFor({ kind: 'signedOut' })).toEqual({ tone: 'failed', text: SIGNED_OUT_MESSAGE, retry: true });
    expect(noticeFor({ kind: 'unconfirmed' })).toEqual({ tone: 'failed', text: UNCONFIRMED_MESSAGE, retry: true });
    expect(OFFLINE_MESSAGE).toMatch(/nothing was sent/);
    expect(UNCONFIRMED_MESSAGE).toMatch(/cannot tell if it arrived/);
    expect(UNCONFIRMED_MESSAGE).toMatch(/never sent twice/);
  });

  it('offline after an unanswered try does not erase the doubt about that try', () => {
    expect(noticeFor({ kind: 'offline' }, { earlierUncertain: true })).toEqual({
      tone: 'failed',
      text: OFFLINE_AFTER_UNCONFIRMED_MESSAGE,
      retry: true,
    });
    expect(OFFLINE_AFTER_UNCONFIRMED_MESSAGE).not.toMatch(/nothing was sent/);
    expect(OFFLINE_AFTER_UNCONFIRMED_MESSAGE).toMatch(/may have arrived/);
  });

  it('every failure line stays short enough for the sticky bar on a 320 px phone', () => {
    for (const m of [
      OFFLINE_MESSAGE,
      OFFLINE_AFTER_UNCONFIRMED_MESSAGE,
      UNCONFIRMED_MESSAGE,
      SIGNED_OUT_MESSAGE,
      MAINTENANCE_MESSAGE,
    ]) {
      expect(m.length, m).toBeLessThanOrEqual(160);
    }
  });

  it('a replay is "Already received", in Oman time, with what happened since', () => {
    expect(noticeFor({ kind: 'answered', result: { ok: true, data: receipt('SUBMITTED') } }, { now })).toEqual({
      tone: 'received',
      text: '✓ Already received at 10:42 — it is waiting for approval. Nothing more to do.',
    });
    expect(alreadyReceivedMessage(receipt('APPROVED'), now)).toMatch(/Already received at 10:42, and approved since/);
    // A draft is still unsent: never "nothing more to do".
    expect(alreadyReceivedMessage(receipt('DRAFT'), now)).toBe(
      '✓ Already saved at 10:42. It is still a draft — submit it when ready.'
    );
    expect(alreadyReceivedMessage(receipt('NEEDS_CORRECTION'), now)).toMatch(
      /sent back for correction since\. Open My work/
    );
    // Rejected is final — not "sent back"; and no approver is named.
    expect(alreadyReceivedMessage(receipt('REJECTED'), now)).toMatch(/rejected since\. Open My work/);
    for (const st of ['DRAFT', 'SUBMITTED', 'APPROVED', 'NEEDS_CORRECTION', 'REJECTED'] as const) {
      expect(alreadyReceivedMessage(receipt(st), now)).not.toMatch(/supervisor/i);
    }
    // Sent back since: it arrived, but it is not the good-news green, and retrying is not the fix.
    expect(noticeFor({ kind: 'answered', result: { ok: true, data: receipt('NEEDS_CORRECTION') } }, { now })).toMatchObject({
      tone: 'failed',
      retry: false,
    });
  });

  it('a first-time success and a field error leave the notice to the form', () => {
    const fresh = { editId: 'e1', state: 'SUBMITTED', submittedAt: null, replayed: false };
    expect(noticeFor({ kind: 'answered', result: { ok: true, data: fresh } })).toBeNull();
    expect(
      noticeFor({ kind: 'answered', result: { ok: false, code: 'VALIDATION_FAILED', message: 'x', fields: { a: 'b' } } })
    ).toBeNull();
  });

  it('an answered error with no field is shown beside the button, without Try again', () => {
    expect(
      noticeFor({ kind: 'answered', result: { ok: false, code: 'EDIT_LOCKED', message: 'Pending.' } })
    ).toEqual({ tone: 'failed', text: 'Pending.', retry: false });
  });

  it('omanWhen: the time today, the day and time otherwise', () => {
    expect(omanWhen('2026-09-25T06:42:00.000Z', now)).toBe('10:42');
    expect(omanWhen('2026-09-24T06:42:00.000Z', now)).toBe('24 Sept, 10:42');
  });
});
