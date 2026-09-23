/**
 * The Create user panel must never offer the browser a username/password pair.
 *
 * The owner's screenshot of that panel on go-live day showed Username pre-filled
 * with "data.steward" — their OWN sign-in — and Password pre-filled from the
 * browser's password manager, with Role reading Salesman: one submit away from
 * creating a duplicate account carrying the Steward's own password. Chrome ignores
 * `autoComplete="off"` on anything its heuristics read as a credential pair and
 * keys those heuristics off the `name` and `type` attributes, so the fix renames
 * the two fields to something no password manager recognises and remaps them to
 * the names `createUserAction` reads at submit.
 *
 * That fix is two halves that fail in opposite ways and neither half fails loudly:
 * rename the inputs back and the autofill returns; drop the remap and every
 * Create user submit posts an empty username to the server. Both survive a build
 * and a type check, so the guard is structural — it asserts the shape, not the
 * behaviour, because the behaviour is Chrome's and cannot be driven from here.
 *
 * Comments are stripped before every assertion. The author's comment in
 * CreateUserForm.tsx quotes `autoComplete="off"` and the `name`/`type` attributes
 * verbatim while explaining the rule. The patterns below are anchored tightly
 * enough that today the prose satisfies none of them — checked, not assumed — but
 * the prose is one loosened regex away from being what makes this file green after
 * the code it describes has been deleted, which is the failure this project has
 * already had once.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const FORM = 'app/(app)/users/CreateUserForm.tsx';
const ROW_ACTIONS = 'app/(app)/users/UserRowActions.tsx';
const SERVICE = 'services/users.ts';

function withoutComments(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const form = withoutComments(FORM);
const rowActions = withoutComments(ROW_ACTIONS);
const service = withoutComments(SERVICE);

/** The value a `const NAME = '…'` declaration is given, or null. */
function constValue(code: string, name: string): string | null {
  return new RegExp(`const\\s+${name}\\s*=\\s*'([^']+)'`).exec(code)?.[1] ?? null;
}

// What a password manager reads a field name as. Not Chrome's real heuristic —
// that is undocumented and version-specific — but the tokens that got us here.
const CREDENTIAL_TOKENS = new Set([
  'user',
  'username',
  'login',
  'signin',
  'email',
  'mail',
  'pass',
  'passwd',
  'password',
  'pwd',
]);

describe('the Create user panel hides its credential fields from the browser', () => {
  it.each(['USERNAME_FIELD', 'PASSWORD_FIELD'])('%s is named nothing a password manager knows', (name) => {
    const value = constValue(form, name);
    expect(value, `${name} is no longer a string constant in ${FORM}`).not.toBeNull();
    const tokens = value!.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    expect(tokens.filter((t) => CREDENTIAL_TOKENS.has(t))).toEqual([]);
  });

  it('declares no input called username or password', () => {
    // Both JSX spellings: name="username" and name={'username'}.
    const offenders = form
      .split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /name=\{?\s*['"](username|password)['"]\s*\}?/.test(l));
    expect(offenders).toEqual([]);
  });

  it('routes both fields through the aliases rather than a literal name', () => {
    expect(form).toMatch(/name=\{USERNAME_FIELD\}/);
    expect(form).toMatch(/name=\{PASSWORD_FIELD\}/);
  });

  it('remaps both aliases back to the names the server action reads', () => {
    // Without this the rename posts an empty username and the panel fails on
    // every submit — the half of the fix that a type check cannot see.
    expect(form).toMatch(/fd\.set\(\s*'username'\s*,[\s\S]{0,60}?USERNAME_FIELD/);
    expect(form).toMatch(/fd\.set\(\s*'password'\s*,[\s\S]{0,60}?PASSWORD_FIELD/);
    expect(form).toMatch(/fd\.delete\(USERNAME_FIELD\)/);
    expect(form).toMatch(/fd\.delete\(PASSWORD_FIELD\)/);
  });

  it('is remapping onto the names services/users.ts actually reads', () => {
    // The other end of the contract: createUserAction reads the FormData by
    // literal key, so the two literals above are not free to change.
    expect(service).toMatch(/formData\.get\(\s*'username'\s*\)/);
    expect(service).toMatch(/formData\.get\(\s*'password'\s*\)/);
  });
});

describe('the autoComplete attributes are real and reach the input', () => {
  it('the create form and its username field opt out', () => {
    expect(form).toMatch(/<form[^>]*autoComplete="off"/);
    expect(form).toMatch(/name=\{USERNAME_FIELD\}[\s\S]{0,200}?autoComplete="off"/);
  });

  it('every password input asks for a NEW password, not the stored one', () => {
    expect(form).toMatch(/autoComplete="new-password"/);
    // The row's Reset password box is the second place a manager offers to fill.
    expect(rowActions).toMatch(/type="password"[\s\S]{0,120}?autoComplete="new-password"/);
  });

  it('the shared Field component forwards autoComplete to the input', () => {
    // The attribute is a prop on a local wrapper; if it stops being spread onto
    // the <input/>, every autoComplete above becomes decoration.
    expect(form).toMatch(/<input[\s\S]{0,300}?autoComplete=\{autoComplete\}/);
  });
});
