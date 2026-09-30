// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { OperatorRefusal, operatorErrorLabel } from '../../scripts/ops/error-label';

const PRIVATE_DETAIL = 'synthetic-private-row-and-connection-detail';

describe('operatorErrorLabel', () => {
  it('preserves deliberately marked operator instructions', () => {
    const refusal = new OperatorRefusal('--apply needs --actor <steward username>');
    expect(refusal.name).toBe('OperatorRefusal');
    expect(refusal).toBeInstanceOf(Error);
    expect(operatorErrorLabel(refusal)).toBe(refusal.message);
    // A mutable name alone cannot opt an ordinary error into revealing its message.
    expect(operatorErrorLabel(Object.assign(new Error(PRIVATE_DETAIL), { name: 'OperatorRefusal' }))).toBe('Error');
  });

  it('keeps only Prisma codes, including initialization errorCode', () => {
    expect(operatorErrorLabel(Object.assign(new Error(PRIVATE_DETAIL), { code: 'P1001' }))).toBe('P1001');
    expect(operatorErrorLabel(Object.assign(new Error(PRIVATE_DETAIL), { errorCode: 'P1017' }))).toBe('P1017');
  });

  it('reports the class instead of the message, mutable name or a non-Prisma code', () => {
    const error = Object.assign(new TypeError(PRIVATE_DETAIL), { name: PRIVATE_DETAIL, code: PRIVATE_DETAIL });
    expect(operatorErrorLabel(error)).toBe('TypeError');
    class SyntheticFailure extends Error {}
    expect(operatorErrorLabel(new SyntheticFailure(PRIVATE_DETAIL))).toBe('SyntheticFailure');
  });

  it('refuses extra text after a Prisma code and unsafe class labels', () => {
    expect(operatorErrorLabel(Object.assign(new Error(PRIVATE_DETAIL), { code: `P1001 ${PRIVATE_DETAIL}` }))).toBe('Error');
    const error = new Error(PRIVATE_DETAIL);
    Object.defineProperty(error, 'constructor', { value: { name: `Error ${PRIVATE_DETAIL}` } });
    expect(operatorErrorLabel(error)).toBe('Error');
  });

  it('never reads message, stack or name on an unmarked error', () => {
    const error = new Error();
    for (const key of ['message', 'stack', 'name']) {
      Object.defineProperty(error, key, { get: () => { throw new Error(PRIVATE_DETAIL); } });
    }
    expect(operatorErrorLabel(error)).toBe('Error');
  });

  it('handles non-errors and malformed thrown objects without printing their values', () => {
    expect(operatorErrorLabel(PRIVATE_DETAIL)).toBe('UnknownError');
    expect(operatorErrorLabel(null)).toBe('UnknownError');
    expect(operatorErrorLabel({ get code() { throw new Error(PRIVATE_DETAIL); } })).toBe('UnknownError');
  });
});

type Script = 'recompute-cr-norm' | 'rescore-completeness';
const SCRIPT_NAMES: Script[] = ['recompute-cr-norm', 'rescore-completeness'];
const compiled = new Map(
  [...SCRIPT_NAMES, 'requeue-untracked'].map((script) => [script, ts.transpileModule(
    readFileSync(`scripts/ops/${script}.ts`, 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
  ).outputText])
);

/** Run the actual CLI entry point, with no real client, process environment or file access. */
async function runCli(script: Script, args: string[], guardError?: Error) {
  const output = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
  let finish!: (code: number) => void;
  const finished = new Promise<number>((resolve) => { finish = resolve; });
  const exit = vi.fn((code: number) => finish(code));
  const client = vi.fn(() => { throw new Error('The refusal must precede Prisma construction'); });
  const readEnv = vi.fn(() => { throw new Error('This CLI refusal must not read .env'); });
  const modules: Record<string, unknown> = {
    '@prisma/client': {
      PrismaClient: client,
      Role: { STEWARD: 'STEWARD' },
      TemixSyncState: { SYNCED: 'SYNCED' },
      EditState: { DRAFT: 'DRAFT', SUBMITTED: 'SUBMITTED', NEEDS_CORRECTION: 'NEEDS_CORRECTION' },
    },
    'node:fs': { readFileSync: readEnv },
    '../../lib/temix': {},
    '../../lib/demo-accounts': {},
    '../../lib/cr': {},
    '../../lib/duplicate-pairing': {},
    '../../lib/locks': {},
    '../../lib/rescore': {},
    './error-label': { OperatorRefusal, operatorErrorLabel },
  };
  const processStub = {
    argv: ['node', `scripts/ops/${script}.ts`, ...args],
    env: { DIRECT_URL: 'postgresql://synthetic:unused@uat.invalid/test' },
    exit,
  };
  const load = (name: string) => {
    const exports: Record<string, unknown> = {};
    runInNewContext(compiled.get(name)!, {
      exports,
      require: (id: string) => {
        if (!Object.hasOwn(modules, id)) throw new Error(`Unexpected test import: ${id}`);
        return modules[id];
      },
      process: processStub,
      console: output,
    });
    return exports;
  };
  const guards = load('requeue-untracked');
  const requireExpectedHost = vi.fn(guards.requireExpectedHost as (...values: unknown[]) => void);
  if (guardError) requireExpectedHost.mockImplementation(() => { throw guardError; });
  modules['./requeue-untracked'] = { ...guards, requireExpectedHost };
  load(script);
  expect(await finished).toBe(2);
  expect(exit).toHaveBeenCalledOnce();
  expect(requireExpectedHost).toHaveBeenCalledOnce();
  expect(client).not.toHaveBeenCalled();
  expect(readEnv).not.toHaveBeenCalled();
  expect(output.error).toHaveBeenCalledOnce();
  expect(output.log).not.toHaveBeenCalled();
  expect(output.warn).not.toHaveBeenCalled();
  const recorded = JSON.stringify(Object.values(output).flatMap((spy) => spy.mock.calls));
  expect(recorded).not.toContain(PRIVATE_DETAIL);
  expect(recorded).not.toContain(processStub.env.DIRECT_URL);
  return output.error.mock.calls[0][0] as string;
}

describe.each(SCRIPT_NAMES)('%s CLI entry point', (script) => {
  it('prints the actual missing --expect-host refusal and exits 2 before opening a client', async () => {
    const message = await runCli(script, []);
    expect(message).toContain('FAILED: refusing to run without --expect-host.');
    expect(message).toContain('Name the database you intend');
    expect(message).toContain('This connects to uat.invalid.');
  });

  it.each([
    [Object.assign(new Error(PRIVATE_DETAIL), { code: 'P1001' }), 'P1001'],
    [new TypeError(PRIVATE_DETAIL), 'TypeError'],
  ] as const)('redacts a non-refusal thrown at the same guard stage (%s)', async (error, label) => {
    const message = await runCli(script, [], error);
    expect(message).toMatch(new RegExp(`FAILED: ${label}\\s*$`));
  });
});

it('prints rescore --apply without --actor guidance and exits 2 before opening a client', async () => {
  const message = await runCli('rescore-completeness', ['--expect-host', 'uat.invalid', '--apply']);
  expect(message).toContain('FAILED: --apply needs --actor <steward username>');
  expect(message).toContain('accountable for the change');
});
