import { randomBytes } from 'node:crypto';

/**
 * A cuid-shaped id ('c' + 24 lower-case base-36 characters), minted here so it
 * can be written to the crash registry BEFORE its row exists. It passes the
 * app's z.string().cuid() checks like Prisma's own default.
 */
export function newId(): string {
  const t = Date.now().toString(36).padStart(9, '0').slice(-9);
  let r = '';
  for (const b of randomBytes(15)) r += (b % 36).toString(36);
  return `c${t}${r}`;
}

/** A short, lower-case, base-36 run id: seconds since 2026-01-01 plus two random characters. */
export function makeRunId(now = Date.now()): string {
  const secs = Math.floor(now / 1000) - 1_767_225_600;
  let r = '';
  for (const b of randomBytes(2)) r += (b % 36).toString(36);
  return `${Math.max(0, secs).toString(36)}${r}`;
}

/** A small, stable hash of a string (for spreading addresses and numbers). */
export function smallHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
