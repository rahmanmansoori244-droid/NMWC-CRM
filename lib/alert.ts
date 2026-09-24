/**
 * The one way this system can reach a human who is not looking at a screen.
 *
 * GAP-2 (re-benchmark, 2026-09-24): there was no such way. A grep across `lib/`,
 * `services/`, `app/` and `package.json` for nodemailer, resend, sendgrid,
 * postmark, twilio, slack, webhook and smtp returned nothing, and
 * `lib/notifications.ts` says so in terms — `emailedAt` marks a batch-drain
 * queue whose drainer does not exist. So the SLA escalation sweep fired twice an
 * hour into an in-app bell nobody was watching, and a cron that stopped running
 * was visible only to someone who thought to curl `/api/health` with the monitor
 * bearer.
 *
 * Owner's decision (2026-09-24): one generic outgoing webhook, one URL in one env
 * var. Slack, Teams, Discord and the WhatsApp bridges all accept a JSON POST, so
 * this needs no vendor SDK, no account and no new dependency.
 *
 * The contract every caller can rely on: sendAlert NEVER THROWS and never
 * retries. An alert is a courtesy, not a step — a cron sweep, an import or a
 * health check must never fail because a webhook did.
 */
import { checkLimit } from './rate-limit';
import { isSelfMintedId, scrubAndTruncate } from './scrub';
import { logger } from './logger';

/**
 * Closed set, deliberately. The event key is the dedup bucket AND it goes on the
 * wire verbatim, so it must not be interpolable: a union of literals means
 * TypeScript rejects `` `sla.escalated:${customer.legalName}` `` at the call site
 * rather than a reviewer having to notice it. Adding an alert means adding a line
 * here, which is the point.
 */
export type AlertEvent =
  | 'sla.escalated'
  | 'cron.failed'
  | 'import.rejections';

export type AlertSeverity = 'info' | 'warn' | 'critical';

export type AlertInput = {
  severity: AlertSeverity;
  event: AlertEvent;
  /**
   * Sub-key that splits the dedup bucket, for an event that has more than one
   * independent subject: the cron job name, the import batch id.
   *
   * Without it `cron.failed` shares one bucket, so photo-gc failing would silence
   * the SLA sweep failing an hour later — a limiter that hides the second of two
   * unrelated outages is worse than no limiter. Code-chosen values only. It is
   * validated as a short lowercase slug, which stops a phone number, an e-mail, a
   * CR number and anything containing a space or a capital; it would NOT stop a
   * single lowercased word, so this field is for constants and self-minted ids.
   */
  scope?: string;
  /**
   * The line a human reads at 3am, assembled by the CALLER from values it chose.
   * Scrubbed and truncated on the way out — see the PII note below for what that
   * does and does not cover.
   */
  message: string;
  /** Numbers only, enforced by type AND at runtime. A name is not a number. */
  counts?: Record<string, number>;
  /** Identifiers this system minted (cuid / UUID). Anything else is DROPPED. */
  ids?: Record<string, string>;
};

/**
 * Hard ceiling on one POST. `vercel.json` gives every function under `app/`
 * `maxDuration: 60`, and the longest caller is the customer promote slice, whose
 * own budget clamps at 25 s and which can then spend one 20 s transaction: 25 +
 * 20 + 5 = 50 s, so a hanging webhook still cannot be what kills the slice.
 */
export const ALERT_TIMEOUT_MS = 5_000;

/**
 * At most one alert per event key per four-hour window.
 *
 * The SLA sweep runs at :15 and :45 through a twelve-hour Oman window
 * (docs/OPERATIONS.md §5d) — 24 invocations a day. Without a limiter a condition
 * that persists all day posts 24 times, and a channel that cries wolf 24 times
 * gets muted, which returns us to GAP-2 by a different route. Four hours caps a
 * persistent condition at four messages inside the working window: raised
 * immediately, then re-raised as each window turns.
 */
export const ALERT_RENOTIFY_SEC = 4 * 60 * 60;

/**
 * The window is part of the KEY, and this bucket is never refilled. That is the
 * only shape that re-raises on the backend production actually runs.
 *
 * A capacity-1 bucket refilling at 1/4h expresses "one per four hours" on the
 * in-memory backend and NOT on the durable one — and production is the durable
 * one (`RATE_LIMIT_BACKEND` unset, `DATABASE_URL` set). `checkLimitPg` debits a
 * token on EVERY call, floors the stored value at -1, and resets `lastRefill` to
 * NOW() while doing it: the SEC-C3 fix in lib/rate-limit.ts, which login's
 * fail-closed guarantee rests on and which is therefore not something to bend
 * for an alert. So a condition that stays true is re-asked every 30 minutes,
 * every ask resets the refill clock, and climbing back out of the -1 marker needs
 * two tokens' worth of UNINTERRUPTED time — 8 h at this rate — that never comes.
 * Simulated against the statement itself: the stored value reaches -1 on the
 * second ask and stays there, so 24 h of a permanently-true condition produced
 * ONE message and never the re-raise this file and OPERATIONS.md §5f both
 * promised (adversarial review, 2026-09-24; the original test proved the
 * re-raise only against the memory backend, which does give 7).
 *
 * No capacity/refill pair fixes that. Recovery from the -1 marker needs
 * `elapsed × refillPerSec >= 2` between two CONSECUTIVE calls, so any config
 * that re-raises at all has a period set by the caller's polling interval rather
 * than by four hours.
 *
 * So the four-hour window goes in the key instead. Every call inside one window
 * addresses one row and the first of them takes its single token; the next window
 * addresses a row that does not exist yet, and a row that does not exist starts
 * full. Both backends agree on that, nothing depends on in-memory state
 * surviving between serverless invocations, and the rows are ordinary `RateLimit`
 * rows — which the retention sweep already deletes after a day
 * (app/api/cron/retention-sweep/route.ts §1), so the windowed keys do not
 * accumulate.
 *
 * `refillPerSec` is left exactly as it was, and nothing depends on it: inside one
 * window the durable bucket is pinned at -1, and the in-memory one cannot reach a
 * whole token because a window is exactly `ALERT_RENOTIFY_SEC` long, so two calls
 * that share one are strictly less than that apart. The window in the key is what
 * re-arms this limiter; the refill rate is not.
 *
 * The cost, stated rather than implied: the windows are fixed — aligned to the
 * epoch, so 00/04/08/12/16/20 UTC — not four hours measured from the last
 * message. A condition first raised at 03:59 can therefore raise again at 04:00.
 * That is a burst of two against the 24 this exists to prevent, and it gives a
 * persistent condition four messages inside the twelve-hour working window rather
 * than three.
 */
const ALERT_LIMIT = { capacity: 1, refillPerSec: 1 / ALERT_RENOTIFY_SEC };

/** Which fixed four-hour window an instant falls into. */
function alertWindow(nowMs: number): number {
  return Math.floor(nowMs / (ALERT_RENOTIFY_SEC * 1000));
}

/** A 3am alert is a line, not a report. Bounds what a careless message can leak. */
export const ALERT_MESSAGE_MAX = 200;

/** Belt for callers that reach this from JavaScript or through an `as` cast. */
const EVENT_KEY = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/;
const SCOPE_KEY = /^[a-z][a-z0-9-]{1,32}$/;

/**
 * Field names inside `counts` and `ids`.
 *
 * A key is on the wire exactly as much as its value is: `wirePayload` renders
 * `k=v` pairs into the line a human reads, so `counts: { [customer.legalName]: 1 }`
 * published a legal name through a filter that only ever looked at values. The
 * design called itself structural and was not (adversarial review, 2026-09-24).
 *
 * A field name is a source literal in every call site, so it is held to the same
 * shape as `scope`: a bare identifier. That drops anything with a space, a `+`, an
 * `@`, a comma or a leading digit — which is a legal name, an address, a phone
 * number, an e-mail and a CR number. A key that fails is dropped together with its
 * value, the same way an id that is not self-minted is dropped, and the key is NOT
 * logged: a key that got here from data is itself the suspect value.
 *
 * What this does NOT stop is what `scope` does not stop either: one lowercased
 * word. `counts: { almahatrading: 1 }` is a field name as far as any pattern can
 * tell. Keys are literals at all three call sites; a caller building one out of
 * data is what review is for.
 */
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/**
 * One function, called by both the dedup key and the payload. A scope that is
 * validated in one place and not the other would either split a bucket the wire
 * says is shared, or share a bucket the wire says is split.
 */
function validScope(scope: string | undefined): string | undefined {
  return typeof scope === 'string' && SCOPE_KEY.test(scope) ? scope : undefined;
}

type WirePayload = {
  text: string;
  content: string;
  severity: AlertSeverity;
  event: string;
  scope?: string;
  message: string;
  counts: Record<string, number>;
  ids: Record<string, string>;
  env: string;
  at: string;
};

/**
 * Build the wire body field by field — never by spreading the input.
 *
 * TypeScript's excess-property check only fires on object literals, so a caller
 * holding a wider object can hand this function a whole Prisma customer row and
 * the compiler will not object. Constructing the payload explicitly means the
 * extra fields have nowhere to go.
 *
 * What this DOES stop reaching a third party: anything in `counts` that is not a
 * finite number; anything in `ids` that is not an identifier this system minted
 * (so a phone, a CR number, an address or a legal name is dropped); any field
 * NAME in either bag that is not a bare identifier, because the names are
 * rendered into the line as well as the values (FIELD_KEY above); and any
 * phone number, e-mail address or 7–12 digit run inside `message`, via the
 * shared scrubber in lib/scrub.ts.
 *
 * What it does NOT stop, stated rather than implied: a customer's LEGAL NAME
 * written into `message`. No pattern distinguishes "Al Maha Trading LLC" from
 * ordinary prose. The three call sites deliberately pass counts and a batch id
 * instead; a fourth that wants to name a customer should ask first.
 */
function wirePayload(a: AlertInput, now: Date): WirePayload {
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(a.counts ?? {})) {
    if (FIELD_KEY.test(k) && typeof v === 'number' && Number.isFinite(v)) counts[k] = v;
  }
  const ids: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.ids ?? {})) {
    if (FIELD_KEY.test(k) && typeof v === 'string' && isSelfMintedId(v)) ids[k] = v;
  }
  const severity: AlertSeverity =
    a.severity === 'critical' || a.severity === 'warn' ? a.severity : 'info';
  const message = scrubAndTruncate(String(a.message ?? ''), ALERT_MESSAGE_MAX);
  const pairs = [...Object.entries(counts), ...Object.entries(ids)]
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const scope = validScope(a.scope);
  const subject = scope ? `${a.event}/${scope}` : a.event;
  const line = `[${severity.toUpperCase()}] ${subject} — ${message}${pairs ? ` (${pairs})` : ''}`;
  return {
    // Slack and the Teams connector render `text`; Discord renders `content`.
    // Sending both means the owner pastes a URL and it works, instead of
    // discovering at 3am that their bridge ignored the only field we sent.
    text: line,
    content: line,
    severity,
    event: a.event,
    ...(scope ? { scope } : {}),
    message,
    counts,
    ids,
    // Which deployment is complaining. UAT and production share this code, and an
    // alert that does not say which one it came from wastes the first five minutes.
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
    at: now.toISOString(),
  };
}

/**
 * Everything that may be said in a log line about a failed POST.
 *
 * `(err as Error).message` could not be said. When fetch rejects while parsing the
 * URL, the message is `Failed to parse URL from <the whole webhook URL>` — so the
 * old `err.message.slice(0, 120)` in the catch below put a bearer credential into
 * a log line, on precisely the path that fires when the owner pastes a malformed
 * URL and then goes looking at logs. The not-https branch further down already
 * declares that this URL is never logged; this is the path that did it anyway
 * (adversarial review, 2026-09-24).
 *
 * So the label is the error's CLASS and never its text, and the return value is
 * constrained to `^[A-Za-z]{1,32}$`. A URL contains `:` and `/`, so no string this
 * function can return contains one — whatever a subclass puts in its `name`.
 */
function failureLabel(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  // What the AbortController raises when ALERT_TIMEOUT_MS runs out. Worth naming:
  // "the webhook did not answer in 5 s" is a different problem from "the webhook
  // refused us", and a reader of the logs needs to tell them apart.
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  return /^[A-Za-z]{1,32}$/.test(name) ? name : 'unknown';
}

/**
 * Post one alert. Returns true only when the webhook accepted it.
 *
 * Returns FALSE, silently and without throwing, when: `ALERT_WEBHOOK_URL` is
 * unset (the correct state until the owner pastes one in — alerts off is a
 * configuration, not an error); the URL is not https; this event key has already
 * alerted inside the current four-hour window; or the POST times out, is refused
 * or fails.
 *
 * Await it. Vercel does not guarantee work that continues after a response is
 * sent, so a fire-and-forget alert is an alert that sometimes does not happen —
 * and awaiting is safe precisely because this cannot throw.
 */
export async function sendAlert(a: AlertInput): Promise<boolean> {
  try {
    const url = process.env.ALERT_WEBHOOK_URL?.trim();
    if (!url) return false;
    if (!url.startsWith('https://')) {
      // Never log the URL. A Slack/Teams/Discord webhook URL is a bearer
      // credential: anyone holding it can post into the channel.
      logger.warn({ event: a.event }, 'alert.url_not_https');
      return false;
    }
    if (!EVENT_KEY.test(a.event)) {
      // The rejected key is NOT logged: the only way to reach here is a caller that
      // built the key from data, so the key itself is the suspect value.
      logger.warn({}, 'alert.bad_event_key');
      return false;
    }
    // Durable bucket, not a module-level Map. lib/rate-limit.ts already records
    // why (QA-006/QA-015): in-memory state is per-Lambda, and every caller here
    // is a fresh serverless invocation, so an in-memory guard would suppress
    // nothing at all in the one case this limiter exists for — a cron failing on
    // every run. checkLimit falls back to memory when the database is
    // unreachable for keys that are not login/password-reset, so an alert ABOUT
    // a database outage still goes out.
    //
    // The four-hour window is IN the key: see ALERT_LIMIT above for why a refill
    // rate cannot express the re-raise on the durable backend.
    const scope = validScope(a.scope);
    const nowMs = Date.now();
    const bucketWindow = alertWindow(nowMs);
    const gate = await checkLimit(
      `alert:${a.event}${scope ? `:${scope}` : ''}:w${bucketWindow}`,
      ALERT_LIMIT
    );
    if (!gate.ok) {
      // Deliberately NOT gate.retryAfterSec: that number describes a refill this
      // bucket does not do, and the durable backend reports 8 h for a bucket
      // pinned at -1. When the next window opens is the part that is true.
      const retryAfterSec = Math.ceil(
        ((bucketWindow + 1) * ALERT_RENOTIFY_SEC * 1000 - nowMs) / 1000
      );
      logger.info({ event: a.event, retryAfterSec }, 'alert.suppressed');
      return false;
    }
    // A hanging webhook must not hold the function open to its 60 s ceiling.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wirePayload(a, new Date())),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn({ event: a.event, status: res.status }, 'alert.rejected');
        return false;
      }
      return true;
    } finally {
      // Otherwise the pending timer can keep the invocation alive after the POST
      // has already answered.
      clearTimeout(timer);
    }
  } catch (err) {
    // Includes the abort. A failed send has already spent this window's token, so
    // the next occurrence inside the window stays quiet; when the window turns the
    // condition — if it is still true — raises itself again.
    //
    // The error's CLASS only, never its text: see failureLabel above. The text can
    // be `Failed to parse URL from <webhook url>`, and that URL is a credential.
    logger.warn({ event: a.event, err: failureLabel(err) }, 'alert.failed');
    return false;
  }
}
