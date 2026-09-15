// @vitest-environment node
/**
 * The docblock above is not decoration. vitest.config.ts defaults to jsdom, and
 * jsdom means Vite's WEB transform, which rewrites `process.env.NODE_ENV` to
 * "test" at transform time. `vi.stubEnv` would then change nothing and the
 * production case below could never pass. The node environment uses the ssr
 * transform, where `process.env.NODE_ENV` survives to runtime and the stub works.
 *
 * SEC-14c — the session cookie's attributes, pinned.
 *
 * `__Host-` is a browser-enforced assertion with three requirements: Secure, a
 * Path of exactly "/", and NO Domain attribute. Every one of them is load-bearing
 * in a different direction, and getting any of them wrong is silent — the browser
 * simply refuses to store the cookie, and nobody can sign in. So they are asserted
 * rather than trusted to a comment.
 *
 * Adding a `domain` option is the specific mistake this guards: it looks like
 * hardening, it voids the prefix, and it locks every user out at once.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

async function loadConfig() {
  // Fresh module each time: the cookie name is decided at module scope from
  // NODE_ENV, so a cached copy would carry the previous environment's answer.
  vi.resetModules();
  return (await import('@/auth.config')).authConfig;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the production session cookie', () => {
  it('uses the __Host- prefix and satisfies every condition the prefix imposes', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const c = (await loadConfig()).cookies?.sessionToken;

    expect(c?.name).toBe('__Host-authjs.session-token');
    // Requirement 1: Secure. Without it the browser drops the cookie outright.
    expect(c?.options?.secure).toBe(true);
    // Requirement 2: Path exactly "/". Any other value voids the prefix.
    expect(c?.options?.path).toBe('/');
    // Requirement 3: no Domain, at all. This is the one someone "hardens" later.
    expect(c?.options).not.toHaveProperty('domain');
    // Not part of the prefix, but the two attributes the comment claims.
    expect(c?.options?.httpOnly).toBe(true);
    expect(c?.options?.sameSite).toBe('lax');
  });
});

describe('the development session cookie', () => {
  it('carries no prefix, because dev runs over plain http', async () => {
    // A prefixed cookie needs Secure, and a Secure cookie is dropped over http.
    // Prefixing in development would break local sign-in entirely.
    vi.stubEnv('NODE_ENV', 'development');
    const c = (await loadConfig()).cookies?.sessionToken;
    expect(c?.name).toBe('authjs.session-token');
    expect(c?.options?.secure).toBe(false);
  });
});
