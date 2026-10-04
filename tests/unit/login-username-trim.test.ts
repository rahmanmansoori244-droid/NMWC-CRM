// @vitest-environment node
/**
 * Sign-in trims the username; it never trims the password.
 *
 * What was wrong: loginSchema (app/actions/auth.ts) and credentialsSchema
 * (lib/auth.ts) lower-cased the username but kept its spaces. A phone keyboard
 * adds a space after a word it completed, so a salesman who typed his name and
 * tapped a suggestion was looked up — and rate-limited — as a padded name that
 * no account has, and was told "Invalid username or password".
 *
 * What changed: the three username schemas the comment above loginSchema keeps
 * in step (the form's, the callback route's in authorize(), and the user-admin
 * rule in services/users.ts) all trim first. The login form's username box also
 * turns off auto-capitalise and auto-correct.
 *
 * The behaviour is checked at the two sign-in schemas through the code that
 * parses them: loginAction() (what it hands to signIn) and authorize() (what it
 * looks up, rate-limits and compares). next-auth's wrapper is replaced so its
 * signIn() can be observed and the Credentials provider's authorize() reached;
 * the provider itself is the real one, and the limiter runs on its in-memory
 * backend.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { stripComments } from '../support/strip-comments';

type StoredUser = {
  id: string;
  username: string;
  passwordHash: string;
  isActive: boolean;
  mustChangePassword: boolean;
  fullName: string;
  email: string | null;
  role: string;
};
type Authorize = (creds: Record<string, unknown>) => Promise<{ username: string } | null>;

const h = vi.hoisted(() => ({
  config: null as null | { providers: Array<{ options?: { authorize?: unknown } }> },
  ip: '10.0.0.1',
  users: new Map<string, StoredUser>(),
  lookups: [] as string[],
  /** Every plain-text password bcrypt.compare saw, exactly as it arrived. */
  compared: [] as string[],
  /** next-auth's signIn(), replaced: what loginAction hands it is what loginSchema produced. */
  signIn: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': h.ip }),
  cookies: async () => ({ set: () => {}, get: () => undefined }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
}));
vi.mock('next-auth', async () => {
  const errors = await import('@auth/core/errors');
  return {
    AuthError: errors.AuthError,
    CredentialsSignin: errors.CredentialsSignin,
    default: (config: { providers: Array<{ options?: { authorize?: unknown } }> }) => {
      h.config = config;
      return { handlers: {}, auth: async () => null, signIn: h.signIn, signOut: async () => {} };
    },
  };
});
vi.mock('bcryptjs', () => {
  const compare = async (plain: string, hash: string) => {
    h.compared.push(plain);
    return hash === `hash:${plain}`;
  };
  const hash = async (plain: string) => `hash:${plain}`;
  return { default: { compare, hash }, compare, hash };
});
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: null, userAgent: null }),
  writeAudit: async () => {},
}));
vi.mock('@/lib/db', () => {
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { username?: string; id?: string } }) => {
        h.lookups.push(where.username ?? where.id ?? '');
        return (where.username ? h.users.get(where.username) : undefined) ?? null;
      },
      update: async () => ({}),
    },
  };
  return { prisma, directPrisma: prisma };
});
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/rate-limit')>();
  return { ...real, checkLimit: vi.fn(real.checkLimit) };
});

import { checkLimit } from '@/lib/rate-limit';
import { loginAction } from '@/app/actions/auth';

const SAVED_BACKEND = process.env.RATE_LIMIT_BACKEND;
afterAll(() => {
  if (SAVED_BACKEND === undefined) delete process.env.RATE_LIMIT_BACKEND;
  else process.env.RATE_LIMIT_BACKEND = SAVED_BACKEND;
});

let n = 0;
/** A fresh account on a fresh network per test: the in-memory buckets outlive a test. */
function freshUser(password: string) {
  n += 1;
  const username = `trim${n}.${Date.now().toString(36)}`;
  h.users.set(username, {
    id: `id-${username}`,
    username,
    passwordHash: `hash:${password}`,
    isActive: true,
    mustChangePassword: false,
    fullName: 'Test User',
    email: null,
    role: 'SALESMAN',
  });
  h.ip = `10.77.${n % 250}.${(n * 7) % 250}`;
  return username;
}

function authorize(): Authorize {
  const provider = h.config?.providers[0];
  const fn = provider?.options?.authorize;
  if (typeof fn !== 'function') throw new Error('the Credentials provider has no authorize()');
  return fn as Authorize;
}

/** loginAction with a raw username and password; returns its error, or where it redirected. */
async function submit(username: string, password: string): Promise<string> {
  const fd = new FormData();
  fd.set('username', username);
  fd.set('password', password);
  try {
    const res = await loginAction(fd);
    return res ? res.error : 'returned without redirect';
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (url) return `redirect:${url}`;
    throw e;
  }
}

/** Spaces, a tab and a newline either side — what a phone or a paste leaves behind. */
const PADS: Array<[string, string]> = [
  ['  ', ''],
  ['', '  '],
  ['\t', '\t'],
  [' \t ', ' \n'],
];
const PADDED_PASSWORD = '  pass word\t';

beforeEach(() => {
  process.env.RATE_LIMIT_BACKEND = 'memory';
  h.lookups = [];
  h.compared = [];
  h.signIn.mockClear();
  vi.mocked(checkLimit).mockClear();
});

describe('loginSchema: the form hands sign-in the trimmed, lower-case username', () => {
  it.each(PADS)('%j + name + %j signs in as the bare lower-case name; the password is untouched', async (before, after) => {
    const username = freshUser(PADDED_PASSWORD);
    expect(await submit(`${before}${username.toUpperCase()}${after}`, PADDED_PASSWORD)).toBe('redirect:/home');
    expect(h.signIn.mock.calls).toEqual([
      ['credentials', { username, password: PADDED_PASSWORD, redirect: false }],
    ]);
    // The forced-change lookup after sign-in reads the same, bare name.
    expect(h.lookups).toEqual([username]);
  });

  it('a username of nothing but whitespace is refused before sign-in is called', async () => {
    expect(await submit(' \t \n', 'anything')).toBe('Please enter your username and password.');
    expect(h.signIn).not.toHaveBeenCalled();
  });
});

describe('credentialsSchema: authorize() looks up, rate-limits and signs in the trimmed name', () => {
  it.each(PADS)('%j + name + %j is the account; the password reaches bcrypt as typed', async (before, after) => {
    const username = freshUser(PADDED_PASSWORD);
    const user = await authorize()({ username: `${before}${username.toUpperCase()}${after}`, password: PADDED_PASSWORD });
    expect(user?.username).toBe(username);
    expect(h.lookups).toEqual([username]);
    expect(vi.mocked(checkLimit).mock.calls.map(([key]) => key)).toContain(`login:user:${username}`);
    expect(h.compared).toEqual([PADDED_PASSWORD]);
  });

  it('the password is not trimmed: the same password without its spaces is refused', async () => {
    const username = freshUser(PADDED_PASSWORD);
    expect(await authorize()({ username, password: PADDED_PASSWORD.trim() })).toBeNull();
    expect(h.compared).toEqual([PADDED_PASSWORD.trim()]);
  });

  it('a username of nothing but whitespace is refused before any bucket is charged or row read', async () => {
    expect(await authorize()({ username: ' \t ', password: 'anything' })).toBeNull();
    expect(checkLimit).not.toHaveBeenCalled();
    expect(h.lookups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Structure: every username schema the "keep the three schemas in step" comment
// names trims, ahead of its other rules.
// ---------------------------------------------------------------------------

const COMMENT_HOME = 'app/actions/auth.ts';

/** The files the comment above loginSchema names, and its own file ("this schema"). */
function filesTheCommentNames(): string[] {
  const lines = readFileSync(COMMENT_HOME, 'utf8').split(/\r?\n/);
  const decl = lines.findIndex((l) => /^const loginSchema\b/.test(l));
  expect(decl, 'loginSchema is declared at the top level').toBeGreaterThan(0);
  const block: string[] = [];
  for (let i = decl - 1; i >= 0 && /^\s*\/\//.test(lines[i]!); i -= 1) block.unshift(lines[i]!);
  const comment = block.join('\n');
  // Reading the comment on purpose: it is the list of schemas to keep in step.
  expect(comment).toMatch(/keep the three schemas in step/);
  const named = [...comment.matchAll(/\b(?:app|lib|services)\/[\w/.-]+?\.ts\b/g)].map((m) => m[0]);
  return [...new Set([COMMENT_HOME, ...named])];
}

/**
 * Every `username:` property whose value is a zod chain — directly, or through a
 * `const` it names — as the chain's method names in order: `z.string().trim()
 * .min(1)` is ['string', 'trim', 'min']. Comments are stripped first; the parser
 * then sees only code.
 */
function usernameSchemas(src: string, file: string): string[][] {
  const sf = ts.createSourceFile(file, stripComments(src, file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const consts = new Map<string, ts.Expression>();
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      consts.set(node.name.text, node.initializer);
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'username') values.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const zodChain = (e: ts.Expression): string[] | null => {
    const methods: string[] = [];
    let cur: ts.Expression = e;
    while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      methods.unshift(cur.expression.name.text);
      cur = cur.expression.expression;
    }
    return ts.isIdentifier(cur) && cur.text === 'z' ? methods : null;
  };
  const out: string[][] = [];
  for (const v of values) {
    const e = ts.isIdentifier(v) ? consts.get(v.text) : v;
    const chain = e ? zodChain(e) : null;
    if (chain) out.push(chain);
  }
  return out;
}

const trimsFirst = (chain: string[]) => chain[0] === 'string' && chain[1] === 'trim';

describe('structure: the username schemas stay in step and all trim first', () => {
  it('the comment still names three files: the form action, authorize() and the user-admin rule', () => {
    expect(filesTheCommentNames().sort()).toEqual(['app/actions/auth.ts', 'lib/auth.ts', 'services/users.ts']);
  });

  it.each(filesTheCommentNames())('%s: its username schema trims before any other rule', (file) => {
    const schemas = usernameSchemas(readFileSync(file, 'utf8'), file);
    // Exactly one, so the guard cannot pass by finding nothing.
    expect(schemas, `${file}: username schemas found`).toHaveLength(1);
    expect(schemas[0], file).toSatisfy(trimsFirst);
  });

  it('the finder sees an untrimmed schema, a trim placed too late, and a commented-out trim', () => {
    const find = (s: string) => usernameSchemas(s, 'fixture.ts');
    expect(find('const s = z.object({ username: z.string().min(1) });')[0]).not.toSatisfy(trimsFirst);
    // zod runs a string's checks in order: min(1) before trim() would pass "  ".
    expect(find('const s = z.object({ username: z.string().min(1).trim() });')[0]).not.toSatisfy(trimsFirst);
    expect(find('const s = z.object({ username: z.string()/* .trim() */.min(1) });')[0]).not.toSatisfy(trimsFirst);
    expect(find('const r = z.string().trim().min(1);\nconst s = z.object({ username: r });')[0]).toSatisfy(trimsFirst);
  });
});

describe('structure: the login form username box does not let the keyboard rewrite it', () => {
  it('turns off auto-capitalise, auto-correct and spell-check', () => {
    const file = 'components/nmwc/LoginForm.tsx';
    const src = stripComments(readFileSync(file, 'utf8'), file);
    const start = src.indexOf('id="username"');
    expect(start).toBeGreaterThan(0);
    const input = src.slice(src.lastIndexOf('<input', start), src.indexOf('/>', start));
    expect(input).toMatch(/\bautoCapitalize="none"/);
    expect(input).toMatch(/\bautoCorrect="off"/);
    expect(input).toMatch(/\bspellCheck=\{false\}/);
  });
});
