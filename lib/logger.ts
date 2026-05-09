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
const PHONE_PATTERN = /\+?968\d{8}\b|\b\d{8,12}\b/g;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

function scrubString(s: string): string {
  return s.replace(PHONE_PATTERN, '[phone]').replace(EMAIL_PATTERN, '[email]');
}

function scrubObject<T>(value: T, depth = 0): T {
  if (depth > 4) return value;
  if (typeof value === 'string') return scrubString(value) as unknown as T;
  if (Array.isArray(value)) {
    return (value.map((v) => scrubObject(v, depth + 1)) as unknown) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubObject(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: 'nmwc-cm' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    log(obj) {
      return scrubObject(obj);
    },
  },
});

export type Logger = typeof logger;
