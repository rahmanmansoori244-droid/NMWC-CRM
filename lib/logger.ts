import pino from 'pino';

const redactPaths = [
  'password',
  'passwordHash',
  '*.password',
  '*.passwordHash',
  '*.primaryPhone',
  '*.altPhone',
  '*.email',
  '*.phone',
  '*.crNumber',
  '*.crNumberNorm',
  'req.headers.authorization',
  'req.headers.cookie',
];

/**
 * GAP-02 / F-15: pino's path-based redactor only matches structured keys.
 * Free-text fields (`err.message`, `reason`, `target`) frequently embed PII
 * (phones, CR numbers, customer codes) that the structured redactor misses.
 *
 * We add a serializer that scrubs an additional pattern set from any string
 * value before it hits the wire. Patterns target the most common Omani PII
 * shapes; absolute coverage is not the goal — defense in depth is.
 */
// B6: one implementation, shared with the Sentry configs and the cron
// heartbeat — see lib/scrub.ts.
import { scrubString } from './scrub';

import { DIGEST_KEY, isErrorDigest } from './scrub';

function scrubObject<T>(value: T, depth = 0): T {
  if (depth > 4) return value;
  if (typeof value === 'string') return scrubString(value) as unknown as T;
  if (Array.isArray(value)) {
    return (value.map((v) => scrubObject(v, depth + 1)) as unknown) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Item 10: the error screen's `Reference:` must stay findable (lib/scrub.ts).
      out[k] = k === DIGEST_KEY && isErrorDigest(v) ? v : scrubObject(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/**
 * Item 10 (re-benchmark, 2026-09-24): where a log line goes decides whether
 * anyone can find it.
 *
 * Vercel files a runtime log line by its STREAM, not by anything inside it:
 * stdout is `info`, stderr is `error` (docs: Runtime Logs → Level). pino writes
 * everything to stdout, so every `logger.error` in this app — a failed cron run,
 * an import that died mid-promote — was filed as info, and Vercel's Warning/Error
 * filter never showed one of them. Lines at warn and above now go to stderr.
 *
 * Node only. `app/error.tsx` and `app/(app)/error.tsx` import this module in the
 * browser, where pino is its console build and has no `multistream`.
 */
function destination(): pino.DestinationStream | undefined {
  if (typeof window !== 'undefined' || typeof process === 'undefined' || !process.stderr) return undefined;
  return pino.multistream(
    [
      { level: 'trace', stream: process.stdout },
      { level: 'warn', stream: process.stderr },
    ],
    // Each line goes to the highest stream it qualifies for, once — not to both.
    { dedupe: true }
  );
}

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    base: { service: 'nmwc-cm' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // "level":"error" rather than "level":50, so a line reads — and searches — as
      // what it is.
      level(label) {
        return { level: label };
      },
      log(obj) {
        return scrubObject(obj);
      },
    },
  },
  destination()
);

export type Logger = typeof logger;
