import pino from 'pino';

const redactPaths = [
  'password',
  'passwordHash',
  '*.password',
  '*.passwordHash',
  '*.primaryPhone',
  '*.altPhone',
  'req.headers.authorization',
  'req.headers.cookie',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: 'nmwc-cm' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
