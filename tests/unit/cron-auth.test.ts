/**
 * The bearer check that guards every cron route, the health detail payload and
 * the backup report had no test of any kind.
 *
 * Two properties carry the whole weight and neither was asserted, so a refactor
 * could quietly undo either one with CI staying green:
 *
 *   1. The comparison is constant-time. An earlier revision of the health route
 *      compared with `===` (the finding recorded as SEC-14a, fixed in a6addee by
 *      extracting this helper). Nothing stopped that from coming back.
 *   2. It fails CLOSED when CRON_SECRET is unset. This matters more than it
 *      looks: the .env.example note claims the opposite — that a missing secret
 *      "silently leaves those endpoints unauthenticated" — so a reader with that
 *      mental model could "fix" the code to match the comment and open every
 *      cron route to the internet.
 *
 * These are behavioural tests, not a timing measurement: measuring nanosecond
 * deltas in a JS test is a flake generator. What is asserted instead is that the
 * comparison goes through `timingSafeEqual`, which is the property a reviewer
 * actually wants, plus the accept/reject behaviour around it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bearerMatches, cronAuthorized } from '@/lib/cron-auth';

const SECRET = 'a'.repeat(40);

describe('bearerMatches', () => {
  it('accepts exactly the expected bearer', () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it('rejects a wrong secret of the SAME length', () => {
    // The case a length check alone would pass, so this is what proves the
    // comparison itself runs.
    expect(bearerMatches(`Bearer ${'b'.repeat(40)}`, SECRET)).toBe(false);
  });

  it('rejects a secret that differs only in its last character', () => {
    expect(bearerMatches(`Bearer ${'a'.repeat(39)}b`, SECRET)).toBe(false);
  });

  it('rejects a correct secret sent without the Bearer scheme', () => {
    expect(bearerMatches(SECRET, SECRET)).toBe(false);
  });

  it('rejects a prefix and a longer value without throwing', () => {
    // timingSafeEqual THROWS on unequal lengths; the helper must length-check
    // first. If that guard is ever removed these become 500s on a public route
    // instead of 401s.
    expect(() => bearerMatches('Bearer a', SECRET)).not.toThrow();
    expect(bearerMatches('Bearer a', SECRET)).toBe(false);
    expect(bearerMatches(`Bearer ${SECRET}extra`, SECRET)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(bearerMatches(null, SECRET)).toBe(false);
    expect(bearerMatches('', SECRET)).toBe(false);
  });

  it('is not case-insensitive about the scheme', () => {
    // Documents the behaviour rather than endorsing it: every caller in this
    // repo sends "Bearer", and loosening it would widen the comparison surface.
    expect(bearerMatches(`bearer ${SECRET}`, SECRET)).toBe(false);
  });

  it('compares through timingSafeEqual, not ===', () => {
    // The structural half. A future edit that replaces the crypto comparison
    // with a string equality would keep every assertion above green — this is
    // the one that would not survive it.
    const src = readFileSync('lib/cron-auth.ts', 'utf8');
    expect(src).toMatch(/timingSafeEqual\s*\(/);
    // No direct equality against the presented header or the expected secret.
    expect(src).not.toMatch(/headerValue\s*===|===\s*presented|presented\s*===/);
  });
});

describe('cronAuthorized', () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it('accepts the configured secret', () => {
    expect(cronAuthorized(`Bearer ${SECRET}`)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(cronAuthorized(`Bearer ${'c'.repeat(40)}`)).toBe(false);
  });

  it('FAILS CLOSED when CRON_SECRET is unset', () => {
    // The property .env.example describes backwards. An unset secret must deny
    // every caller, including one that sends no header at all and one that
    // sends an empty bearer — never authorise them.
    vi.stubEnv('CRON_SECRET', '');
    expect(cronAuthorized('Bearer anything')).toBe(false);
    expect(cronAuthorized('Bearer ')).toBe(false);
    expect(cronAuthorized(null)).toBe(false);
  });

  it('fails closed when CRON_SECRET is absent entirely', () => {
    vi.stubEnv('CRON_SECRET', undefined);
    expect(cronAuthorized('Bearer anything')).toBe(false);
    expect(cronAuthorized(null)).toBe(false);
  });
});
