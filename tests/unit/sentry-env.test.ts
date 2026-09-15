/**
 * DO-07: a report that cannot say which environment or which commit it came
 * from is much less useful than it looks. This project already shipped a build
 * 74 commits behind what everyone believed was live.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sentryEnvironment, sentryRelease } from '@/lib/sentry-env';

const KEYS = [
  'NEXT_PUBLIC_SENTRY_ENV',
  'NEXT_PUBLIC_SENTRY_RELEASE',
  'VERCEL_ENV',
  'VERCEL_GIT_COMMIT_SHA',
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('sentryEnvironment', () => {
  it('prefers the value baked into the client bundle', () => {
    process.env.NEXT_PUBLIC_SENTRY_ENV = 'preview';
    process.env.VERCEL_ENV = 'production';
    expect(sentryEnvironment()).toBe('preview');
  });

  it('falls back to VERCEL_ENV on the server, which knows preview from production', () => {
    delete process.env.NEXT_PUBLIC_SENTRY_ENV;
    process.env.VERCEL_ENV = 'preview';
    // NODE_ENV is "production" on every built deployment, which is the bug.
    expect(sentryEnvironment()).toBe('preview');
  });

  it('never returns empty', () => {
    delete process.env.NEXT_PUBLIC_SENTRY_ENV;
    delete process.env.VERCEL_ENV;
    expect(sentryEnvironment().length).toBeGreaterThan(0);
  });

  it('treats an empty string as absent rather than as an environment', () => {
    process.env.NEXT_PUBLIC_SENTRY_ENV = '';
    process.env.VERCEL_ENV = 'production';
    expect(sentryEnvironment()).toBe('production');
  });
});

describe('sentryRelease', () => {
  it('reports the commit the build came from', () => {
    process.env.NEXT_PUBLIC_SENTRY_RELEASE = 'abc1234';
    expect(sentryRelease()).toBe('abc1234');
  });

  it('falls back to the server-side commit SHA', () => {
    delete process.env.NEXT_PUBLIC_SENTRY_RELEASE;
    process.env.VERCEL_GIT_COMMIT_SHA = 'deadbeef';
    expect(sentryRelease()).toBe('deadbeef');
  });

  it('is undefined rather than an empty string when unknown', () => {
    // An empty release tags every issue with "" and is worse than none.
    process.env.NEXT_PUBLIC_SENTRY_RELEASE = '';
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    expect(sentryRelease()).toBeUndefined();
  });
});
