// @vitest-environment node
/**
 * GAP-2 (2026-09-24): lib/alert.ts is the only way this system can reach a human,
 * and it posts to a third party. Both halves of that need proving rather than
 * asserting — that it stays quiet and harmless when unconfigured, and that a
 * customer's phone number cannot ride out on it.
 *
 * Memory backend: these tests must never touch a database. lib/rate-limit.ts reads
 * this variable on every call rather than at import, so one describe below
 * deliberately unsets it to exercise the DURABLE path — the one production runs —
 * against a simulation of its statement, with lib/db mocked. Every case uses its
 * own `scope`, because the dedup bucket is keyed on event+severity+scope and the in-memory
 * buckets are module state shared across this file.
 */
process.env.RATE_LIMIT_BACKEND = 'memory';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { logger } from '@/lib/logger';
import {
  sendAlert,
  ALERT_TIMEOUT_MS,
  ALERT_MESSAGE_MAX,
  ALERT_RENOTIFY_SEC,
} from '@/lib/alert';
import { importRejectionAlert } from '@/lib/import-rejection-alert';

const HOOK = 'https://hooks.example.test/services/T0/B0/zzzz';

/**
 * A fixed instant for every test that cares about the dedup window.
 *
 * The window is a fixed clock window aligned to the epoch (00/04/08/12/16/20 UTC),
 * so a fixture on the real clock would straddle a boundary now and then and read as
 * a flake rather than as the boundary it is. 04:15 UTC is one of the sweep's real
 * times (:15 and :45 across 03–15 UTC) and sits fifteen minutes into the 04:00
 * window, so seven half-hourly repeats stay inside it and +4 h lands in the next.
 */
const BASE = new Date('2026-09-24T04:15:00.000Z');

type Call = { url: string; init: RequestInit };

/** A fetch that accepts everything, recording what it was given. */
function acceptingFetch(calls: Call[]) {
  return vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200 } as Response;
  });
}

function sentBody(calls: Call[], i = 0): Record<string, unknown> {
  return JSON.parse(String(calls[i]!.init.body)) as Record<string, unknown>;
}

/** Everything on the wire, as one string — the only thing a leak test can search. */
function wireText(calls: Call[], i = 0): string {
  return String(calls[i]!.init.body);
}

describe('sendAlert — when it must stay silent', () => {
  let calls: Call[];
  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', acceptingFetch(calls));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ALERT_WEBHOOK_URL;
  });

  it('no-ops SILENTLY and returns false with no webhook configured', async () => {
    // The state every deployment is in until the owner pastes a URL in. An alert
    // channel that throws when unconfigured would turn "we cannot page anyone"
    // into "the cron sweep 500s", which is strictly worse than the gap it closes.
    //
    // The log assertions are not decoration. Deleting the `if (!url) return false`
    // guard from lib/alert.ts leaves `url.startsWith(...)` throwing on undefined,
    // which the outer catch swallows — so a test that checked only the return value
    // and the absence of a fetch call PASSED against that mutant, the fifth vacuous
    // guard on this project caught at the last moment. Silence is the contract, and
    // a swallowed TypeError logs `alert.failed`, so asserting silence is what
    // distinguishes the guard from its absence.
    delete process.env.ALERT_WEBHOOK_URL;
    const warn = vi.spyOn(logger, 'warn');
    const info = vi.spyOn(logger, 'info');
    const sent = await sendAlert({
      severity: 'critical',
      event: 'cron.failed',
      scope: 'unset',
      message: 'nobody should hear this',
    });
    expect(sent).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('refuses a non-https webhook', async () => {
    // A Slack, Teams or Discord webhook is always https. A plain-http URL is a
    // typo or a man-in-the-middle, and an alert body crossing the internet in
    // clear is exactly what the PII rules below exist to prevent.
    process.env.ALERT_WEBHOOK_URL = 'http://hooks.example.test/plain';
    expect(
      await sendAlert({ severity: 'warn', event: 'sla.escalated', scope: 'plain', message: 'x' })
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an event key that is not a code constant', async () => {
    // The event key is the dedup bucket AND goes on the wire verbatim. The type is
    // a closed union so TypeScript rejects an interpolated key; this is the belt
    // for a JavaScript caller or an `as` cast.
    process.env.ALERT_WEBHOOK_URL = HOOK;
    expect(
      await sendAlert({
        severity: 'warn',
        event: 'sla.escalated Al Maha Trading LLC' as 'sla.escalated',
        message: 'x',
      })
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not log a rejected event key on ANY path, the non-https one included', async () => {
    // The non-https branch used to run BEFORE the key was validated and logged
    // `a.event` raw — so a key built from data reached the log through the one
    // branch whose own comment is about keeping secrets out of it.
    process.env.ALERT_WEBHOOK_URL = 'http://hooks.example.test/plain';
    const warn = vi.spyOn(logger, 'warn');
    const info = vi.spyOn(logger, 'info');
    const bad = 'sla.escalated Al Maha Trading LLC' as 'sla.escalated';
    expect(await sendAlert({ severity: 'warn', event: bad, message: 'x' })).toBe(false);
    const logged = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
    expect(logged).not.toContain('Al Maha');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never throws on malformed input, even with a webhook configured', async () => {
    // "sendAlert NEVER THROWS" is the contract every caller awaits it on. With a
    // URL set, `sendAlert(undefined)` threw a TypeError reading `.event`, then threw
    // AGAIN reading it inside the catch — out of the function (adversarial review,
    // 2026-09-24). TypeScript stops this at the three call sites; the contract is
    // for the fourth, written in JavaScript or through a cast.
    process.env.ALERT_WEBHOOK_URL = HOOK;
    const warn = vi.spyOn(logger, 'warn');
    for (const input of [undefined, null, 'cron.failed', 42, {}, { event: 7 }]) {
      await expect(sendAlert(input as never), `sendAlert(${JSON.stringify(input)})`).resolves.toBe(
        false
      );
    }
    expect(fetch).not.toHaveBeenCalled();
    // Refused on purpose, not swallowed by the catch: a swallowed TypeError logs
    // `alert.failed`, and that is the mutant this line tells apart.
    expect(warn.mock.calls.map((c) => c[1])).not.toContain('alert.failed');
  });
});

describe('sendAlert — what reaches the wire', () => {
  let calls: Call[];
  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', acceptingFetch(calls));
    process.env.ALERT_WEBHOOK_URL = HOOK;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ALERT_WEBHOOK_URL;
  });

  it('posts one JSON body carrying a line both Slack and Discord render', async () => {
    const sent = await sendAlert({
      severity: 'critical',
      event: 'sla.escalated',
      scope: 'happy',
      message: 'Approval requests passed their SLA.',
      counts: { escalated: 4, level2: 1 },
    });
    expect(sent).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(HOOK);
    expect(calls[0]!.init.method).toBe('POST');
    const body = sentBody(calls);
    // Slack and the Teams connector read `text`; Discord reads `content`. Sending
    // one field would mean the owner's bridge silently rendering nothing.
    expect(body.text).toBe(body.content);
    expect(String(body.text)).toContain('[CRITICAL]');
    expect(String(body.text)).toContain('sla.escalated/happy');
    expect(String(body.text)).toContain('escalated=4');
    expect(body.counts).toEqual({ escalated: 4, level2: 1 });
    expect(body.event).toBe('sla.escalated');
    // Which deployment is complaining — UAT and production share this code.
    expect(typeof body.env).toBe('string');
  });

  it('DROPS every id that is not an identifier this system minted, KEY or value', async () => {
    // The `ids` bag is an allowlist, not a denylist: a value is forwarded only if
    // the whole string is a cuid or a UUID. A phone number, a CR number and a
    // legal name are none of those, so they cannot ride out in a field whose name
    // makes them look harmless.
    //
    // And the KEY is on the wire exactly as much as the value is — wirePayload
    // renders `k=v` into the line a human reads. Until 2026-09-24 every key was
    // copied through verbatim while the filter looked only at values, so the two
    // PII entries below whose *name* is the personal data could not fail this test:
    // both were dropped for having a value that was not self-minted, which is the
    // wrong reason and the same green tick. They now carry a perfectly valid cuid,
    // so the key is the only thing that can stop them.
    await sendAlert({
      severity: 'warn',
      event: 'import.rejections',
      scope: 'ids',
      message: 'a load finished with rejections',
      ids: {
        batchId: 'clz1abcdefghijklmnopqrstu',
        phone: '91234567',
        cr: '1234567',
        name: 'Al Maha Trading LLC',
        addr: 'Way 4821, Ghala, Muscat',
        'Al Maha Trading LLC': 'clz1abcdefghijklmnopqrstu',
        '+968 9123 4567': 'clz1abcdefghijklmnopqrstu',
      },
    });
    const body = sentBody(calls);
    expect(body.ids).toEqual({ batchId: 'clz1abcdefghijklmnopqrstu' });
    // The line itself, not just the structured bag: this is what a Slack channel
    // shows, and it is assembled from the keys.
    expect(String(body.text)).toContain('batchId=clz1abcdefghijklmnopqrstu');
    const wire = wireText(calls);
    expect(wire).not.toContain('Al Maha Trading');
    expect(wire).not.toContain('Ghala');
    expect(wire).not.toContain('91234567');
    expect(wire).not.toContain('1234567');
    expect(wire).not.toContain('9123 4567');
  });

  it('DROPS every count that is not a finite number, and every key that is not a name', async () => {
    // Typed `Record<string, number>`, but TypeScript's excess-property check does
    // not reach a value handed over from a wider object, so the runtime filter is
    // the one that actually holds. A name is not a number.
    //
    // The last two entries are the key channel, and they are the ones this test
    // could not fail on before 2026-09-24: their values are honest finite numbers,
    // so nothing but a rule about the KEY can keep `[customer.legalName]: 1` off
    // the wire.
    await sendAlert({
      severity: 'warn',
      event: 'import.rejections',
      scope: 'counts',
      message: 'counts only',
      counts: {
        rejected: 1833,
        contact: 'Ali Said' as unknown as number,
        phone: '+968 9123 4567' as unknown as number,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        'Al Maha Trading LLC': 4,
        '+968 9123 4567': 7,
      },
    });
    expect(sentBody(calls).counts).toEqual({ rejected: 1833 });
    expect(String(sentBody(calls).text)).toContain('rejected=1833');
    const wire = wireText(calls);
    expect(wire).not.toContain('Ali Said');
    expect(wire).not.toContain('Al Maha Trading');
    expect(wire).not.toContain('9123 4567');
  });

  it('scrubs phone numbers, e-mails and CR-style digit runs out of the message', async () => {
    // The message is the one free-text field, so it goes through the shared
    // scrubber in lib/scrub.ts rather than a second copy of those patterns.
    await sendAlert({
      severity: 'warn',
      event: 'sla.escalated',
      scope: 'scrub',
      message: 'breach on +968 9123 4567 / ali.said@example.com / CR 1234567',
    });
    const body = sentBody(calls);
    expect(body.message).toContain('[phone]');
    expect(body.message).toContain('[email]');
    expect(wireText(calls)).not.toContain('9123 4567');
    expect(wireText(calls)).not.toContain('ali.said@example.com');
  });

  it('truncates the message, so a careless caller has a bounded blast radius', async () => {
    await sendAlert({
      severity: 'info',
      event: 'sla.escalated',
      scope: 'trunc',
      message: 'x'.repeat(ALERT_MESSAGE_MAX + 500),
    });
    expect(String(sentBody(calls).message)).toHaveLength(ALERT_MESSAGE_MAX);
  });

  it('never forwards a field the payload does not name', async () => {
    // The payload is built field by field precisely so that a caller who hands
    // over a whole Prisma row — which the compiler permits through a widened
    // type — cannot leak the rest of it.
    const smuggled = {
      severity: 'warn',
      event: 'sla.escalated',
      scope: 'extra',
      message: 'counts only',
      legalName: 'Al Maha Trading LLC',
      primaryPhone: '+96891234567',
    } as unknown as Parameters<typeof sendAlert>[0];
    await sendAlert(smuggled);
    const body = sentBody(calls);
    expect(Object.keys(body).sort()).toEqual(
      ['at', 'content', 'counts', 'env', 'event', 'ids', 'message', 'scope', 'severity', 'text'].sort()
    );
    expect(wireText(calls)).not.toContain('Al Maha Trading');
  });
});

describe('sendAlert — the webhook URL is a credential', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ALERT_WEBHOOK_URL;
  });

  it('keeps the URL out of the log even when the failure message quotes the whole of it', async () => {
    // The real shape, not a hypothetical: undici rejects with
    // `TypeError: Failed to parse URL from <url>` when the URL will not parse, so
    // the catch's `err.message.slice(0, 120)` logged a bearer credential — anyone
    // holding it can post into the owner's channel — on exactly the path that fires
    // when the owner has pasted something malformed and is then reading the logs.
    // Found by adversarial review on 2026-09-24, in a file that already declared
    // two comments above that this URL is never logged.
    process.env.ALERT_WEBHOOK_URL = HOOK;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(`Failed to parse URL from ${HOOK}`);
      })
    );
    const warn = vi.spyOn(logger, 'warn');
    expect(
      await sendAlert({ severity: 'critical', event: 'cron.failed', scope: 'leak', message: 'x' })
    ).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    // Every part of it, because a slice of a webhook URL is still the secret part:
    // the path segments are the whole of the authentication.
    for (const fragment of [HOOK, 'hooks.example.test', '/services/T0/B0/zzzz', 'zzzz']) {
      expect(logged, `the log line must not carry ${fragment}`).not.toContain(fragment);
    }
    // And it still says something a reader can act on: which alert, and what class
    // of failure. A log line that says nothing is its own defect.
    expect(warn.mock.calls[0]![0]).toEqual({ event: 'cron.failed', err: 'TypeError' });
    expect(warn.mock.calls[0]![1]).toBe('alert.failed');
  });

  it('has no log line in lib/alert.ts that could carry the URL or a raw error text', async () => {
    // The test above proves the one path a reviewer found by running it. This is the
    // rule, so the next branch added to this file cannot reintroduce it: every
    // logger payload in lib/alert.ts names code-chosen fields only.
    //
    // Comments are stripped first — several of them discuss the URL and
    // `err.message` by name, so an assertion against the raw text would fail for
    // the wrong reason, or pass on a comment that outlived its code.
    const src = readFileSync('lib/alert.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const payloads = [...src.matchAll(/logger\.\w+\(\s*(\{[\s\S]*?\})\s*,/g)].map((m) => m[1]!);
    // Without this the loop below can pass on an empty list.
    expect(payloads.length).toBeGreaterThan(2);
    // And every logger call must BE one of those, or the scan has a blind spot the
    // shape `logger.warn('sending to ' + url)` would walk straight through.
    expect(payloads.length, 'every logger call here passes an object literal first').toBe(
      [...src.matchAll(/logger\.\w+\(/g)].length
    );
    // And its message is a plain string literal with nothing after it. The payload
    // checks below read only the first argument, so `'alert.failed' + cause`, a
    // template literal carrying the URL, or a pino format argument walked past
    // them (review, 2026-09-24).
    const exact = [
      ...src.matchAll(/logger\.\w+\(\s*\{[^{}]*\}\s*,\s*'[a-z_.]+'\s*\);/g),
    ].length;
    expect(exact, 'every logger call is exactly (payload, \'literal.message\')').toBe(
      [...src.matchAll(/logger\.\w+\(/g)].length
    );
    // And `logger` appears ONLY in those calls. `logger?.warn`, `logger['warn']`,
    // a destructured `warn` and `.bind(logger)` each make a call every scan here
    // is blind to, and `console.*` is a second logger of its own (review,
    // 2026-09-24). The payload pattern above also no longer spans braces, so a
    // lazy match cannot run on into a second argument.
    expect(src, 'lib/alert.ts must not write to the console').not.toMatch(/\bconsole\b/);
    const uses = [...src.replace(/^import .*$/gm, '').matchAll(/\blogger\b/g)].length;
    expect(uses, 'every use of `logger` is one of the exact calls').toBe(exact);
    for (const payload of payloads) {
      expect(payload, 'a logger payload in lib/alert.ts').not.toMatch(/url/i);
      expect(payload, 'a logger payload in lib/alert.ts').not.toMatch(/\.message\b/);
      // The validated `event`, never the caller's `a.event`: an unvalidated key is
      // the suspect value, and reading `a` inside the catch is what re-threw out of
      // sendAlert when `a` itself was undefined. Harmless today only because the
      // input guard returns first — this keeps it harmless if that guard moves.
      expect(payload, 'a logger payload in lib/alert.ts').not.toMatch(/\ba\.\w/);
    }
    // And every field in every payload is one of these, with exactly this value.
    // The patterns above are a denylist, and `cause: (err as Error)?.cause` walked
    // through it — undici's real parse error carries the whole webhook URL in its
    // cause, where the fake error in the test above has none (review, 2026-09-24).
    const ALLOWED: Record<string, string> = {
      event: 'event',
      retryAfterSec: 'retryAfterSec',
      status: 'res.status',
      err: 'failureLabel(err)',
    };
    for (const payload of payloads) {
      const fields = payload
        .slice(1, -1)
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean);
      for (const field of fields) {
        const [key, value = key] = field.split(/\s*:\s*/);
        expect(Object.keys(ALLOWED), `field "${field}" in a lib/alert.ts log line`).toContain(key);
        expect(value, `field "${field}" in a lib/alert.ts log line`).toBe(ALLOWED[key!]);
      }
    }
  });
});

describe('sendAlert — the timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.ALERT_WEBHOOK_URL;
  });

  it('aborts a webhook that never answers', async () => {
    // A hanging webhook must not hold a Vercel function to its 60s ceiling
    // (vercel.json maxDuration). Without the abort this test hangs and vitest
    // fails it on its own timeout — which is the correct signal either way.
    process.env.ALERT_WEBHOOK_URL = HOOK;
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init.signal as AbortSignal;
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      )
    );
    const pending = sendAlert({
      severity: 'critical',
      event: 'cron.failed',
      scope: 'hang',
      message: 'never answers',
    });
    // Let sendAlert get past its awaits and register the timer before the clock moves.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(ALERT_TIMEOUT_MS + 10);
    await expect(pending).resolves.toBe(false);
    expect(signal?.aborted).toBe(true);
  });
});

describe('sendAlert — the rate limit', () => {
  let calls: Call[];
  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', acceptingFetch(calls));
    process.env.ALERT_WEBHOOK_URL = HOOK;
    // The clock is pinned for every test here, not just the one that moves it. The
    // dedup window is a FIXED clock window (lib/alert.ts), so two calls made a
    // millisecond apart on the real clock land in different windows a few times a
    // year — the "red every Sunday" shape this project already has a rule about.
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.ALERT_WEBHOOK_URL;
  });

  const alert = (scope: string) =>
    sendAlert({ severity: 'critical', event: 'cron.failed', scope, message: 'failed again' });

  it('posts the first occurrence and suppresses the repeat', async () => {
    // The SLA sweep runs 24 times a day. A condition that persists all day must
    // not post 24 times: a channel that cries wolf gets muted, which returns us
    // to GAP-2 by another route.
    expect(await alert('dedup')).toBe(true);
    expect(await alert('dedup')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('keeps one bucket per job, so a dead cron cannot silence another outage', async () => {
    expect(await alert('joba')).toBe(true);
    expect(await alert('jobb')).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('does not let a WARN silence a CRITICAL in the same window', async () => {
    // The SLA sweep's exact sequence. 04:15: one request escalated for the first
    // time — warn. 04:45: a different request escalated for the SECOND time —
    // critical. The sweep counts escalations as edges, on the run that performs
    // them, so with event+scope as the whole key the critical was dropped and never
    // counted again (adversarial review, 2026-09-24).
    const sla = (severity: 'warn' | 'critical') =>
      sendAlert({ severity, event: 'sla.escalated', message: 'escalated' });
    expect(await sla('warn')).toBe(true);
    vi.setSystemTime(new Date(BASE.getTime() + 30 * 60_000));
    expect(await sla('critical'), 'the critical must get through').toBe(true);
    expect(sentBody(calls, 1).severity).toBe('critical');
    // And each severity is still deduplicated on its own.
    expect(await sla('warn')).toBe(false);
    expect(await sla('critical')).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('re-raises a still-true condition once the renotify window has passed', async () => {
    // The in-memory backend: dev, and the fallback checkLimit takes for a
    // non-security key when the database is unreachable — which is one of the
    // moments an alert matters most. The DURABLE backend, the one production runs,
    // is the test below this describe; it is a different code path and it used to
    // behave differently.
    expect(await alert('renotify')).toBe(true);
    expect(await alert('renotify')).toBe(false);
    vi.setSystemTime(new Date(BASE.getTime() + ALERT_RENOTIFY_SEC * 1000));
    expect(await alert('renotify')).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

/**
 * The dedup, on the backend production actually runs.
 *
 * tests/unit/alert.test.ts pinned RATE_LIMIT_BACKEND='memory' at the top of the
 * file, so the re-raise above was only ever proved against checkLimitMemory —
 * while production leaves RATE_LIMIT_BACKEND unset with DATABASE_URL set, which is
 * checkLimitPg. Those two disagree: checkLimitPg debits a token on EVERY call,
 * floors the stored value at -1 and resets "lastRefill" as it does so, so a
 * capacity-1/4h-refill bucket re-raised NEVER there — 24 h of a permanently-true
 * condition posted one message (adversarial review, 2026-09-24).
 *
 * No test may touch a database, so the statement is simulated rather than run. The
 * simulation is written from the SQL in lib/rate-limit.ts and asserts the statement
 * still has the shape it simulates, because a fake that has silently drifted from
 * the thing it stands in for is the vacuous guard this project keeps finding.
 */
type PgRow = { tokens: number; lastRefill: number };

/** The landmarks of checkLimitPg's statement that this simulation depends on. */
const PG_STATEMENT = [
  'INSERT INTO "RateLimit"',
  // The -1 denied marker: the reason a refill-based dedup cannot re-raise here.
  'GREATEST(',
  '("tokens" >= 0) AS "granted"',
  // A denied call resets the refill clock, which is the other half of it.
  '"lastRefill" = NOW()',
];

function simulatedPgLimiter() {
  const rows = new Map<string, PgRow>();
  /** Anything wrong with the statement, or with this simulation of it. */
  const problems: string[] = [];
  let served = 0;
  const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    // Collected, NOT thrown, and asserted at the end of the test instead.
    //
    // An `expect` that throws in here is caught by checkLimit, which then falls back
    // to the in-memory limiter for any key that is not login/passwordreset — so a
    // throwing assertion would quietly turn this into the memory test it exists to
    // replace, and still pass. Found by mutating one of these landmarks and watching
    // the test stay green.
    for (const landmark of PG_STATEMENT) {
      if (!sql.includes(landmark)) problems.push(`the statement no longer contains ${landmark}`);
    }
    // Parameter order in the statement: key, capacity - 1, capacity, refillPerSec.
    if (values.length !== 4) {
      problems.push(`expected 4 bound parameters, got ${values.length}`);
      return [];
    }
    const [key, initial, capacity, refillPerSec] = values as [string, number, number, number];
    const now = Date.now();
    const existing = rows.get(key);
    served += 1;
    if (!existing) {
      // INSERT: a row that does not exist starts at capacity - 1 and is granted.
      rows.set(key, { tokens: initial, lastRefill: now });
      return [{ tokens: initial, granted: initial >= 0 }];
    }
    // ON CONFLICT DO UPDATE: refill, then ALWAYS debit, floored at -1.
    const refilled = Math.min(
      capacity,
      existing.tokens + ((now - existing.lastRefill) / 1000) * refillPerSec
    );
    const tokens = Math.max(-1, refilled - 1);
    rows.set(key, { tokens, lastRefill: now });
    return [{ tokens, granted: tokens >= 0 }];
  });
  return { queryRaw, problems, served: () => served };
}

describe('sendAlert — the dedup on the durable backend', () => {
  const BACKEND = process.env.RATE_LIMIT_BACKEND;
  const DB = process.env.DATABASE_URL;

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock('@/lib/db');
    vi.resetModules();
    delete process.env.ALERT_WEBHOOK_URL;
    if (BACKEND === undefined) delete process.env.RATE_LIMIT_BACKEND;
    else process.env.RATE_LIMIT_BACKEND = BACKEND;
    if (DB === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = DB;
  });

  it('re-raises every four hours although the durable bucket never refills', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', acceptingFetch(calls));
    process.env.ALERT_WEBHOOK_URL = HOOK;
    // Production's configuration exactly: no backend override, a DATABASE_URL set.
    delete process.env.RATE_LIMIT_BACKEND;
    process.env.DATABASE_URL = 'postgresql://simulated/never-connected';
    const pg = simulatedPgLimiter();
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ prisma: { $queryRaw: pg.queryRaw } }));
    const { sendAlert: send } = await import('@/lib/alert');

    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const alert = () =>
      send({ severity: 'critical', event: 'cron.failed', scope: 'durable', message: 'failed again' });

    expect(await alert()).toBe(true);
    // The sweep keeps asking every 30 minutes while the condition stays true: 04:45
    // through 07:45, all inside BASE's window. Each of these asks is what reset the
    // refill clock and held the old bucket at -1 for ever.
    for (let i = 1; i <= 7; i++) {
      vi.setSystemTime(new Date(BASE.getTime() + i * 30 * 60_000));
      expect(await alert(), `the ask at +${i * 30} minutes must be suppressed`).toBe(false);
    }
    // 08:15: the next window. This is the assertion that was false in production.
    vi.setSystemTime(new Date(BASE.getTime() + ALERT_RENOTIFY_SEC * 1000));
    expect(await alert()).toBe(true);
    expect(calls).toHaveLength(2);
    expect(sentBody(calls, 1).scope).toBe('durable');
    // The durable path really was the one taken, and answered every one of the nine
    // gate checks itself — otherwise this test is the memory backend again under
    // another name, which is what it exists to stop being.
    expect(pg.problems, 'the simulation must still match lib/rate-limit.ts').toEqual([]);
    expect(pg.served(), 'every gate check went through the simulated durable bucket').toBe(9);
  });

  it('lets a CRITICAL through after a WARN in the same window, on this backend too', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', acceptingFetch(calls));
    process.env.ALERT_WEBHOOK_URL = HOOK;
    delete process.env.RATE_LIMIT_BACKEND;
    process.env.DATABASE_URL = 'postgresql://simulated/never-connected';
    const pg = simulatedPgLimiter();
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ prisma: { $queryRaw: pg.queryRaw } }));
    const { sendAlert: send } = await import('@/lib/alert');

    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const sla = (severity: 'warn' | 'critical') =>
      send({ severity, event: 'sla.escalated', message: 'escalated' });

    expect(await sla('warn')).toBe(true);
    vi.setSystemTime(new Date(BASE.getTime() + 30 * 60_000));
    expect(await sla('critical')).toBe(true);
    expect(await sla('critical')).toBe(false);
    expect(calls.map((_, i) => sentBody(calls, i).severity)).toEqual(['warn', 'critical']);
    expect(pg.problems).toEqual([]);
    expect(pg.served(), 'all three gate checks went through the durable bucket').toBe(3);
  });
});

/**
 * Structural, because the defect class here is "nobody called it".
 *
 * GAP-2 was not a broken sender — it was the absence of one. A sender that exists,
 * is tested, and is wired to nothing is the same outage with more code in it, and
 * this project has shipped a correct helper nothing used more than once. So: every
 * event the type declares must have a call site, and every call site must pass an
 * event the type declares.
 *
 * Comments are stripped first. The comments in all three call sites discuss
 * `sendAlert` by name, so an assertion run against the raw text would pass on a
 * comment that outlived the call it describes.
 */
describe('every alert has a caller and every caller has an alert', () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /** The three places the owner chose, and nothing else. */
  const CALL_SITES = [
    'app/api/cron/sla-escalate/route.ts',
    'services/imports.ts',
    'lib/heartbeat.ts',
  ];

  const sources = new Map(CALL_SITES.map((f) => [f, strip(readFileSync(f, 'utf8'))]));

  /**
   * Where each event's literal is written. The import service raises its alert
   * but the decision — and so the `event:` literal — lives in
   * lib/import-rejection-alert.ts, because a 'use server' module cannot export it
   * for a behavioural test.
   */
  const EVENT_SOURCES = [...CALL_SITES, 'lib/import-rejection-alert.ts'];
  const eventSources = new Map(
    EVENT_SOURCES.map((f) => [f, strip(readFileSync(f, 'utf8'))])
  );

  const declared = (() => {
    const body = strip(readFileSync('lib/alert.ts', 'utf8'));
    const block = /export type AlertEvent =([\s\S]*?);/.exec(body);
    expect(block, 'lib/alert.ts must still declare an AlertEvent union').not.toBeNull();
    return [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
  })();

  it('finds a union and three call sites to check at all', () => {
    // Without this the two assertions below can both pass on nothing.
    expect(declared.length).toBeGreaterThan(2);
    for (const [file, src] of sources) {
      expect(src, `${file} must call sendAlert`).toMatch(/\bsendAlert\(/);
      expect(src, `${file} must import it from lib/alert`).toMatch(/from '(?:@\/lib|\.)\/alert'/);
    }
  });

  it('wires every declared event to exactly one of those call sites', () => {
    for (const event of declared) {
      const callers = [...eventSources.entries()].filter(([, src]) =>
        src.includes(`event: '${event}',`)
      );
      expect(callers.map(([f]) => f), `${event} must be sent from exactly one place`).toHaveLength(1);
    }
  });

  it('declares every event those call sites send', () => {
    for (const [file, src] of eventSources) {
      for (const m of src.matchAll(/\bevent: '([^']+)'/g)) {
        expect(declared, `${file} sends ${m[1]}`).toContain(m[1]);
      }
    }
  });

  it('awaits every alert those call sites raise', () => {
    // A reviewer mutated `await alertJobFailed(key)` in lib/heartbeat.ts to `void
    // alertJobFailed(key)` and this suite stayed green, though lib/alert.ts states
    // that awaiting is mandatory: Vercel does not promise to finish work after the
    // response is sent, so a fire-and-forget alert is an alert that sometimes does
    // not happen — and awaiting is safe precisely because sendAlert cannot throw.
    // The behavioural test at the bottom of this file did not catch it either; it
    // asserts after enough microtask hops that an un-awaited send still lands.
    //
    // The two shape assertions below happen to pin `await sendAlert({` for the route
    // and the import service. Nothing pinned the heartbeat's own hop, which is the
    // one that goes through a helper, so this covers every raise in every site.
    let checked = 0;
    for (const [file, src] of sources) {
      for (const m of src.matchAll(/([A-Za-z]+)\s+(sendAlert|alertJobFailed)\s*\(/g)) {
        if (m[1] === 'function') continue; // the declaration of the helper itself
        checked += 1;
        expect(m[1], `${file}: ${m[2]}(…) must be awaited`).toBe('await');
      }
    }
    // Four raises across three files: the route, the import service, and the
    // heartbeat's two hops. A raise written with NOTHING in front of it matches
    // nothing above, so the count is what catches that shape.
    expect(checked, 'every raise must be seen by the loop above').toBe(4);
  });

  it('pins WHEN each of the two written-in-a-handler alerts fires', () => {
    // "The call is present" is not enough: wrapping either one in `if (false)`
    // left every other assertion in this describe green when it was tried, which
    // is the vacuous-guard shape this project has now found five times. The cron
    // site is covered behaviourally below; these two are route/action code whose
    // behavioural setup would dwarf what it proves, so their TRIGGER is pinned
    // instead of only their presence.
    //
    // Each call is pinned BETWEEN the statements either side of it, not merely
    // present: `if (!done) { … }` wrapped round the import's call matched the older
    // pattern while making the alert unreachable (review, 2026-09-24). A wrapper, an
    // early `return` placed just ahead, or a move into another block all break the
    // adjacency.
    //
    // The sweep alerts on escalations, never on a quiet run — after its summary log
    // line and immediately before it answers — and a second-level escalation is
    // CRITICAL. Without the severity in this pin, `severity: 'warn'` put the P1 this
    // file's dedup tests close straight back, with every test green (review,
    // 2026-09-24): a warn and a critical share nothing only if they differ.
    expect(sources.get('app/api/cron/sla-escalate/route.ts')).toMatch(
      /'cron\.sla_escalate'\);\s*if \(escalated > 0 \|\| level2 > 0\) \{\s*await sendAlert\(\{\s*severity: level2 > 0 \? 'critical' : 'warn',[\s\S]*?\}\);\s*\}\s*return NextResponse\.json\(\{ escalated, level2,/
    );
    // The import's decision is proved by behaviour below (lib/import-rejection-
    // alert.ts). This pins the one thing behaviour cannot see: that the service
    // hands it THIS batch's row states and THIS slice's lease result, and sends
    // whatever it returns. Pinning the old inline `if` let `countOf(REJECTED)`
    // become `countOf(CLEAN)` — an alert that can never fire — with this test green.
    const imports = sources.get('services/imports.ts')!;
    expect(imports).toMatch(
      /const stateCounts = await prisma\.importRow\.groupBy\(\{\s*by: \['state'\],\s*where: \{ batchId \},/
    );
    // And it sits at the slice's top level: straight after the audit write's
    // `.catch(…)` closes, straight before the final-slice revalidation.
    // Item 20: the rejected rows already accepted as excluded are counted for THIS
    // batch and handed over, so a re-promoted fixed batch does not re-alert them.
    expect(imports).toMatch(
      /'import\.audit_failed'\);\s*\}\);\s*const excludedRejected =\s*done && finalize\.count > 0\s*\?\s*await prisma\.importRow\.count\(\{\s*where: \{ batchId, state: ImportRowState\.REJECTED, excludedAt: \{ not: null \} \},\s*\}\)\s*:\s*0;\s*const rejectionAlert = importRejectionAlert\(\{\s*batchId,\s*stateCounts,\s*finalisedByThisSlice: finalize\.count > 0,\s*groups: groups\.size,\s*excludedRejected,\s*\}\);\s*if \(rejectionAlert\) await sendAlert\(rejectionAlert\);\s*if \(done\) \{\s*revalidatePath\('\/import'\);/
    );
  });
});

describe('importRejectionAlert — one alert per finished batch, only with rejections', () => {
  type Counts = Partial<Record<'PENDING' | 'CLEAN' | 'QUARANTINED' | 'PROMOTED' | 'REJECTED', number>>;
  const rows = (c: Counts) =>
    Object.entries(c).map(([state, n]) => ({
      state: state as 'CLEAN',
      _count: { _all: n as number },
    }));
  const BATCH = 'clz3k9x0a0000abcd1234efgh';
  const decide = (c: Counts, finalisedByThisSlice = true) =>
    importRejectionAlert({ batchId: BATCH, stateCounts: rows(c), finalisedByThisSlice, groups: 7 });

  it('fires on the finishing slice when rows were rejected, with the WHOLE batch counts', () => {
    const a = decide({ PROMOTED: 18296, REJECTED: 1833, QUARANTINED: 69 });
    expect(a).not.toBeNull();
    expect(a!.event).toBe('import.rejections');
    expect(a!.severity).toBe('warn');
    expect(a!.scope).toBe(BATCH);
    expect(a!.counts).toEqual({ rejected: 1833, promoted: 18296, groups: 7 });
    expect(a!.ids).toEqual({ batchId: BATCH });
  });

  it('stays silent while any CLEAN row remains — an intermediate slice', () => {
    expect(decide({ CLEAN: 1, PROMOTED: 500, REJECTED: 20 })).toBeNull();
  });

  it('stays silent for a slice that lost the lease, so a resumed load posts once', () => {
    expect(decide({ PROMOTED: 500, REJECTED: 20 }, false)).toBeNull();
  });

  it('stays silent on a clean finish — nothing rejected', () => {
    expect(decide({ PROMOTED: 500, QUARANTINED: 3 })).toBeNull();
    expect(decide({ PROMOTED: 500, REJECTED: 0 })).toBeNull();
  });

  it('counts REJECTED, not any other state that happens to be non-zero', () => {
    // The mutant that motivated moving this here: counting the wrong state. Each
    // other state is non-zero and REJECTED is zero, so only a correct count is null.
    expect(decide({ PROMOTED: 5, QUARANTINED: 5, PENDING: 5 })).toBeNull();
    expect(decide({ REJECTED: 1 })!.counts!.rejected).toBe(1);
  });

  it('item 20: rejections already accepted as excluded are dealt with — not counted, and not alerted on alone', () => {
    const withExcluded = (excludedRejected: number) =>
      importRejectionAlert({
        batchId: BATCH,
        stateCounts: rows({ PROMOTED: 18296, REJECTED: 1833 }),
        finalisedByThisSlice: true,
        groups: 7,
        excludedRejected,
      });
    expect(withExcluded(1800)!.counts).toEqual({ rejected: 33, excluded: 1800, promoted: 18296, groups: 7 });
    expect(withExcluded(1833)).toBeNull();
  });
});

describe('a failed cron run actually reaches the webhook', () => {
  // The one wiring proved by behaviour rather than by source text, because this is
  // the site where an `if (false)` slipped past the structural guard above. The
  // database is mocked, not reached: no test in this repository may touch one.
  const upsert = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    upsert.mockReset().mockResolvedValue({});
    process.env.ALERT_WEBHOOK_URL = HOOK;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ALERT_WEBHOOK_URL;
  });

  async function record(key: 'photo-gc' | 'keep-warm' | 'retention-sweep', ok: boolean) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', acceptingFetch(calls));
    vi.doMock('@/lib/db', () => ({ prisma: { cronHeartbeat: { upsert } } }));
    const { recordHeartbeat } = await import('@/lib/heartbeat');
    await recordHeartbeat(key, { ok, durationMs: 1 });
    return calls;
  }

  it('alerts when a run is recorded as failed', async () => {
    const calls = await record('photo-gc', false);
    expect(calls).toHaveLength(1);
    const body = sentBody(calls);
    expect(body.event).toBe('cron.failed');
    expect(body.scope).toBe('photo-gc');
    expect(body.severity).toBe('critical');
  });

  it('stays silent when the run succeeded', async () => {
    expect(await record('retention-sweep', true)).toHaveLength(0);
  });

  it('still alerts when the heartbeat row itself could not be written', async () => {
    // The alert sits outside recordHeartbeat's try/catch on purpose: when the
    // database is what failed, the upsert throws, the throw is swallowed, and the
    // webhook is then the ONLY thing that gets out of the process at all.
    upsert.mockRejectedValue(new Error('connection terminated'));
    const calls = await record('keep-warm', false);
    expect(calls).toHaveLength(1);
    // And not the error text: it can quote a colliding phone number or CR number.
    expect(wireText(calls)).not.toContain('connection terminated');
  });
});

describe('the env var and the example file cannot drift', () => {
  it('.env.example documents the variable lib/alert.ts actually reads', () => {
    // DO-16's lesson, one size down: the checklist a human follows and the name
    // the code reads have to be compared by something. An owner who cannot find
    // the variable never sets it, and the system goes on reaching nobody.
    const code = readFileSync('lib/alert.ts', 'utf8');
    const example = readFileSync('.env.example', 'utf8');
    const read = [...code.matchAll(/process\.env\.(ALERT_[A-Z0-9_]+)/g)].map((m) => m[1]!);
    expect(read).toContain('ALERT_WEBHOOK_URL');
    for (const name of new Set(read)) {
      expect(example, `${name} is read by lib/alert.ts`).toContain(`${name}=`);
    }
  });
});
