// @vitest-environment node
/**
 * B7.1: this repository is public, and `git add -A` stages every file that is not
 * ignored. An env file copied into a checkout — from the private pack, during a
 * move to another computer, or written by tooling — must be ignored whatever it is
 * called. The only env file Git may track is the template.
 *
 * Checked with Git itself rather than by reading .gitignore: `--no-index` judges
 * each path by the rules alone, so the paths need not exist, and the tracked
 * template is not excused by already being in the index.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '--quiet', path], { stdio: 'ignore' });
    return true;
  } catch (e) {
    // Exit 1 means "not ignored". Anything else (128: not a repository) is a real failure.
    if ((e as { status?: number }).status === 1) return false;
    throw e;
  }
}

describe('.gitignore keeps env files out of the public repository (B7.1)', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    '.env.production.local',
    '.env.development',
    '.env.uat',
    '.env.prod',
    'prod.env',
    // The shape of a file copied in from the private pack under its own name.
    'PRODUCTION--copy.env',
    'PRODUCTION--copy.env.local',
    'UAT--copy.env',
    'secrets/UAT--copy.env',
    'scripts/.env',
  ])('ignores %s', (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it.each([
    '.env.example',
    'next-env.d.ts',
    'lib/env.ts',
    'lib/environment.ts',
    'scripts/dev/env-check.cjs',
  ])('does not ignore %s', (path) => {
    expect(isIgnored(path)).toBe(false);
  });

  it('matches no tracked file', () => {
    // A rule that matches a tracked file goes unnoticed, because Git keeps tracking
    // it, while every NEW file of that shape is silently dropped: a bare `*.sql`
    // once did that to each new migration (8b122da).
    const tracked = execFileSync('git', ['ls-files', '--cached', '--ignored', '--exclude-standard'], {
      encoding: 'utf8',
    });
    expect(tracked.trim()).toBe('');
  });
});
