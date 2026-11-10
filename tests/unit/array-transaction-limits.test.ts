// @vitest-environment node
/**
 * Review of the Prisma 7 upgrade, 2026-11-10: array transactions and time.
 *
 * On Prisma 6, `prisma.$transaction([a, b])` had no time limit of Prisma's own.
 * On Prisma 7 it carries the interactive transaction's — `maxWait` to get a
 * connection and BEGIN, `timeout` for the whole batch — and past either one the
 * batch is rolled back and rejected with P2028 although its statements
 * succeeded. A client built without `transactionOptions` (every operator
 * script, seed and test client) gets the defaults: 2 s and 5 s. Nothing showed
 * locally, where Postgres answers in milliseconds; against Neon a cold
 * connection alone is at the edge of 2 s, and a waking compute past it. The
 * reviewer's probe: contextClient's seeding call on a connection ready after
 * 2.5 s was rejected after 2.0 s ("Unable to start a transaction in the given
 * time") though the harness's URL allows 30 s; a 250-customer UPDATE taking
 * 5.6 s was rolled back at 5.0 s.
 *
 * So every array transaction outside the application names its limits
 * (ARRAY_TX_LIMITS, lib/change-context.ts) and the application's client sets
 * its own once (lib/db.ts). Held here three ways: what the installed runtime
 * does (over a pool that opens no socket), that contextClient passes its
 * limits, and a scan that refuses the next array transaction written without
 * any.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { PrismaClient } from '@prisma/client';
import { ARRAY_TX_LIMITS, changeContextStatement, contextClient } from '@/lib/change-context';
import { isTransientDbError } from '@/lib/db-errors';
import { fakeClient } from '../support/fake-pg-pool';

const CTX = { actorId: null, source: 'test:array-limits' };
const clients: PrismaClient[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect()));
});

/**
 * A client whose own limits are a tenth of a second, standing in for Prisma's
 * 2 s / 5 s on a script client: what matters is which limit a call runs under,
 * not how long the test waits.
 */
const SHORT = { maxWait: 100, timeout: 150 };

describe('an array transaction carries the transaction limits on Prisma 7', () => {
  it('without options of its own it runs under the limits of its client: a slow connection is "unable to start", and nothing is sent', async () => {
    const { prisma, wire } = fakeClient({ connectMs: 400, transactionOptions: SHORT });
    clients.push(prisma);
    const err = await prisma
      .$transaction([changeContextStatement(prisma, CTX), prisma.$executeRaw`UPDATE "Customer" SET "creditLimit" = 0 WHERE false`])
      .then(
        () => null,
        (e: unknown) => e as { code?: string; message: string }
      );
    expect(err?.code).toBe('P2028');
    expect(err?.message).toMatch(/Unable to start a transaction in the given time/);
    // Read as the database not answering, never as bad data.
    expect(isTransientDbError(err, 'P2028')).toBe(true);
    expect(wire.filter((s) => /^(SELECT|UPDATE|COMMIT)/.test(s))).toEqual([]);
  });

  it('without options of its own, a batch that outlasts the timeout of its client is rolled back though its statements succeeded', async () => {
    const { prisma, wire } = fakeClient({
      transactionOptions: SHORT,
      onQuery: (sql) => (/^UPDATE/.test(sql) ? 400 : undefined),
    });
    clients.push(prisma);
    const err = await prisma
      .$transaction([changeContextStatement(prisma, CTX), prisma.$executeRaw`UPDATE "Customer" SET "creditLimit" = 0 WHERE false`])
      .then(
        () => null,
        (e: unknown) => e as { code?: string }
      );
    expect(err?.code).toBe('P2028');
    // The rollback is queued behind the statement; give it its turn on the connection.
    await vi.waitFor(() => expect(wire).toContain('ROLLBACK'));
    expect(wire).toContain('UPDATE "Customer"');
    expect(wire).not.toContain('COMMIT');
  });

  it('with ARRAY_TX_LIMITS the same slow connection and the same slow statement commit', async () => {
    const { prisma, wire } = fakeClient({
      connectMs: 400,
      transactionOptions: SHORT,
      onQuery: (sql) => (/^UPDATE/.test(sql) ? 400 : undefined),
    });
    clients.push(prisma);
    const [, written] = await prisma.$transaction(
      [changeContextStatement(prisma, CTX), prisma.$executeRaw`UPDATE "Customer" SET "creditLimit" = 0 WHERE false`],
      ARRAY_TX_LIMITS
    );
    expect(written).toBe(1);
    expect(wire).toEqual(['BEGIN', 'SELECT set_config(\'nmwc.actor\',', 'UPDATE "Customer"', 'COMMIT']);
  });

  it('the limits are as long to start as the harness allows a connection, and minutes for the batch', () => {
    expect(ARRAY_TX_LIMITS).toEqual({ maxWait: 30_000, timeout: 120_000 });
    // tests/e2e/launch/support/env.ts gives a waking Neon compute this long.
    const env = readFileSync('tests/e2e/launch/support/env.ts', 'utf8');
    const waits = [...env.matchAll(/connect_timeout: '(\d+)'/g)].map((m) => Number(m[1]) * 1000);
    expect(waits.length).toBeGreaterThan(0);
    for (const ms of waits) expect(ARRAY_TX_LIMITS.maxWait).toBeGreaterThanOrEqual(ms);
  });
});

describe('contextClient (seeds, fixture builders, the launch harness) names its limits', () => {
  it('a seeding call on a connection that takes longer than the maxWait of its client still lands, under its context', async () => {
    const { prisma, wire } = fakeClient({ connectMs: 400, transactionOptions: SHORT });
    clients.push(prisma);
    const seed = contextClient(prisma, CTX);
    await seed.region.createMany({ data: [{ code: 'ZZ', name: 'Probe' }] });
    expect(wire[0]).toBe('BEGIN');
    expect(wire[1]).toBe('SELECT set_config(\'nmwc.actor\',');
    expect(wire[2]).toMatch(/^INSERT INTO/);
    expect(wire.at(-1)).toBe('COMMIT');
  });
});

// ── the scan ──────────────────────────────────────────────────────────────────

type Call = { file: string; line: number; text: string; form: 'array' | 'interactive'; options: boolean };

/** Every `<x>.$transaction(…)` call in a source, by the TypeScript parser (never by a regex over text). */
function transactionCalls(file: string, source: string): Call[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Call[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === '$transaction') {
      const first = n.arguments[0];
      // A function is the interactive form; anything else — an array written
      // here, or a variable holding one — is the array form.
      const interactive = !!first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first));
      out.push({
        file,
        line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
        text: n.getText().replace(/\s+/g, ' ').slice(0, 70),
        form: interactive ? 'interactive' : 'array',
        options: n.arguments.length >= 2,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const SKIP = new Set(['node_modules', '.next', 'fixtures', 'test-results', 'playwright-report']);
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name).replace(/\\/g, '/');
    if (statSync(p).isDirectory()) return SKIP.has(name) ? [] : walk(p);
    return /\.(ts|tsx|mts|cts)$/.test(name) ? [p] : [];
  });
}

/** Outside the application: clients built without transactionOptions, so each array transaction names its own. */
const OUTSIDE_APP = ['scripts', 'prisma', 'tests/e2e', 'tests/integration', 'tests/support'];
/** The application: one client, whose limits lib/db.ts sets. */
const APP = ['app', 'lib', 'services', 'components'];

describe('no array transaction is left to the 2 s / 5 s defaults of Prisma', () => {
  it('the scan tells the two forms apart, and sees a missing options argument', () => {
    const calls = transactionCalls(
      'x.ts',
      `
      await prisma.$transaction([a, b]);
      await prisma.$transaction([a, b], ARRAY_TX_LIMITS);
      await this.db.$transaction(statements);
      await prisma.$transaction(async (tx) => { await tx.x.update({}); });
      await prisma.$transaction(async function (tx) {}, { timeout: 1 });
      // await prisma.$transaction([commented, out]);
      const s = 'prisma.$transaction([in, a, string])';
      `
    );
    expect(calls.map((c) => [c.form, c.options])).toEqual([
      ['array', false],
      ['array', true],
      ['array', false],
      ['interactive', false],
      ['interactive', true],
    ]);
  });

  it('every array transaction in scripts/, prisma/ and the test harnesses passes its limits', () => {
    const files = OUTSIDE_APP.flatMap(walk);
    expect(files.length).toBeGreaterThan(100);
    const calls = files.flatMap((f) => transactionCalls(f, readFileSync(f, 'utf8'))).filter((c) => c.form === 'array');
    // The ones this was written for are among them, so an empty scan cannot pass.
    for (const f of [
      'scripts/ops/zero-credit-limits.ts',
      'scripts/ops/requeue-untracked.ts',
      'scripts/ops/apply-quarantined-visit-days.ts',
      'scripts/ops/recompute-cr-norm.ts',
      'prisma/synthetic.ts',
      'tests/e2e/launch/support/world.ts',
    ]) {
      expect(calls.some((c) => c.file === f), `${f} no longer has the array transaction this scan was written for`).toBe(true);
    }
    const bare = calls.filter((c) => !c.options).map((c) => `${c.file}:${c.line}  ${c.text}`);
    expect(
      bare,
      'an array transaction without options runs under the defaults of Prisma on a script or test client (2 s to start, 5 s in all): ' +
        'pass ARRAY_TX_LIMITS from lib/change-context.ts as its second argument'
    ).toEqual([]);
  });

  it('lib/change-context.ts passes them for contextClient, and every other array transaction in the application runs on the client lib/db.ts gives limits', () => {
    const calls = APP.flatMap(walk)
      .flatMap((f) => transactionCalls(f, readFileSync(f, 'utf8')))
      .filter((c) => c.form === 'array');
    const own = calls.filter((c) => c.file === 'lib/change-context.ts');
    expect(own).toHaveLength(1);
    expect(own[0]!.options).toBe(true);
    // contextClient is handed a script's or a test's client, never the request client.
    // Any other array transaction in the application runs on lib/db.ts's client,
    // whose limits are set there for both forms:
    const db = readFileSync('lib/db.ts', 'utf8');
    expect(db).toMatch(/transactionOptions:\s*\{\s*maxWait:\s*10_000,\s*timeout:\s*20_000\s*\}/);
    // and there is exactly the one known today (the insights cards, each under its own statement_timeout).
    expect(calls.filter((c) => c.file !== 'lib/change-context.ts').map((c) => c.file)).toEqual(['lib/insights/load.ts']);
  });
});
