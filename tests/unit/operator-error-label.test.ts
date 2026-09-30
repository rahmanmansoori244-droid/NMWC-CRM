// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { operatorErrorLabel } from '../../scripts/ops/error-label';

const PRIVATE_DETAIL = 'synthetic-private-row-and-connection-detail';

describe('operatorErrorLabel', () => {
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

  it('never reads message, stack or name', () => {
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

describe.each(['recompute-cr-norm', 'rescore-completeness'])('%s CLI catch', (script) => {
  it('logs only the shared error label across all console methods, then exits 2', () => {
    // Execute the real CLI callback in isolation; never invoke main or create a client.
    const file = `scripts/ops/${script}.ts`;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const callbacks: ts.Expression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'catch') callbacks.push(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(callbacks).toHaveLength(1);
    const callback = callbacks[0].getText(source);
    expect(callback).toContain('operatorErrorLabel(e)');
    const js = ts.transpileModule(`(${callback})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    for (const [error, label] of [
      [new TypeError(PRIVATE_DETAIL), 'TypeError'],
      [Object.assign(new Error(PRIVATE_DETAIL), { code: 'P1001' }), 'P1001'],
    ] as const) {
      const output = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
      const exit = vi.fn();
      const report = runInNewContext(js, { console: output, process: { exit }, operatorErrorLabel });
      report(error);
      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(2);
      expect(output.error).toHaveBeenCalledOnce();
      expect(output.error.mock.calls[0]).toEqual([expect.stringMatching(new RegExp(`FAILED: ${label}\\s*$`))]);
      expect(output.log).not.toHaveBeenCalled();
      expect(output.warn).not.toHaveBeenCalled();
      const recorded = JSON.stringify(Object.values(output).flatMap((spy) => spy.mock.calls));
      expect(recorded).not.toContain(PRIVATE_DETAIL);
    }
  });
});
