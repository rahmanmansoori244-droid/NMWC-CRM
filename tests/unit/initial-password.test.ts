import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DIGITS,
  isWeakSecret,
  makeInitialPasswordIssuer,
} from '@/scripts/golive/initial-password';

/**
 * SEC-11. The go-live builder must stamp a DIFFERENT initial password on every account it
 * creates. Usernames are public (route codes, printed on the journey plan), so a shared
 * initial password means anyone who hears it can sign in as a colleague who has not signed
 * in yet — and every approval and audit row from then on carries the wrong name.
 *
 * The two load-bearing cases are "never issues the same secret to two accounts" (the
 * literal statement of the finding) and "the builder has no shared-password constant left"
 * (the regression guard — every other case here would still pass if someone quietly put
 * the constant back). Reading a source file as text follows the convention already set by
 * tests/unit/import-templates.test.ts.
 */
const BUILDER = path.join('scripts', 'golive', 'build-masters.ts');

describe('go-live initial passwords are per-account (SEC-11)', () => {
  it('issues an 8-digit value with no leading zero', () => {
    const issue = makeInitialPasswordIssuer();
    for (let i = 0; i < 200; i++) expect(issue()).toMatch(/^[1-9]\d{7}$/);
  });

  it('never issues the same secret to two accounts', () => {
    const issue = makeInitialPasswordIssuer();
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) seen.add(issue());
    expect(seen.size).toBe(2_000);
  });

  it('issues values the account-master importer will accept', () => {
    // services/imports.ts: an initial password shorter than 12 is accepted ONLY when the
    // row sets must_change_password (floor 4). Every row the builder writes sets it.
    const issue = makeInitialPasswordIssuer();
    for (let i = 0; i < 200; i++) {
      const pw = issue();
      expect(pw.length).toBe(DIGITS);
      expect(pw.length).toBeGreaterThanOrEqual(4);
      expect(pw.length).toBeLessThan(12);
    }
  });

  it('redraws when the RNG lands on an obvious run', () => {
    const scripted = [12345678, 87654321, 11111111, 12121212, 43214321, 49382716];
    let i = 0;
    const issue = makeInitialPasswordIssuer(() => scripted[i++]);
    expect(issue()).toBe('49382716');
    expect(scripted.slice(0, 5).map(String).every(isWeakSecret)).toBe(true);
  });

  it('redraws on a collision even when the RNG repeats itself', () => {
    const scripted = [55667788, 55667788, 55667788, 21908374];
    let i = 0;
    const issue = makeInitialPasswordIssuer(() => scripted[Math.min(i++, scripted.length - 1)]);
    expect(issue()).toBe('55667788');
    expect(issue()).toBe('21908374');
  });

  it('fails loudly rather than repeating when the random source is stuck', () => {
    const issue = makeInitialPasswordIssuer(() => 55667788);
    expect(issue()).toBe('55667788');
    expect(() => issue()).toThrow(/distinct initial password/);
  });

  it('the builder has no shared-password constant or env override left', () => {
    const src = readFileSync(BUILDER, 'utf8');
    expect(src).not.toMatch(/INITIAL_PASSWORD/);
    expect(src).not.toMatch(/process\.env\.[A-Za-z_]*PASSWORD/);
    expect(src).toContain("import { makeInitialPasswordIssuer } from './initial-password';");
    // ONE issuer for the whole build — that is what makes the values unique across it.
    expect(src).toContain('const issueInitialPassword = makeInitialPasswordIssuer();');
    // Every account the builder creates must draw its own value, including any added later.
    const pwLines = (src.match(/^\s*const pw = .*$/gm) ?? []).map((l) => l.trim());
    expect(pwLines.length).toBeGreaterThanOrEqual(3);
    expect(new Set(pwLines)).toEqual(new Set(['const pw = issueInitialPassword();']));
    expect(src).toContain('const stewardPw = issueInitialPassword();');
    expect(src).toContain('password: issueInitialPassword() }');
  });
});
