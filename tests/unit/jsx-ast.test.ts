// @vitest-environment node
/**
 * tests/support/jsx-ast.ts is what the element guards read the UI through, so it
 * is tested on the shapes a line or regex match got wrong.
 */
import { describe, it, expect } from 'vitest';
import { jsxElements } from '../support/jsx-ast';

describe('jsxElements', () => {
  it('reads every attribute of a tag that holds an arrow function', () => {
    // `[^<>]` stopped at the `>` of `=>`: this field was invisible to the old guard.
    const [el] = jsxElements('<Field label="Alt phone" onChange={(v) => set(v)} type="tel" autoComplete="off" />;');
    expect(el!.tag).toBe('Field');
    expect(el!.attrs.label).toEqual({ kind: 'string', value: 'Alt phone' });
    expect(el!.attrs.type).toEqual({ kind: 'string', value: 'tel' });
    expect(el!.attrs.autoComplete).toEqual({ kind: 'string', value: 'off' });
    expect(el!.attrs.onChange?.kind).toBe('expression');
  });

  it('does not read a commented-out attribute as a real one', () => {
    const [el] = jsxElements('<Field\n  label="Alt phone"\n  // type="tel"\n/>;');
    expect(el!.attrs.type).toBeUndefined();
  });

  it('reads {"string"} as a string, a computed value as an expression, and a bare attribute as bare', () => {
    const [el] = jsxElements('<Field label={\'Phone\'} name={`p${i}`} disabled />;');
    expect(el!.attrs.label).toEqual({ kind: 'string', value: 'Phone' });
    expect(el!.attrs.name?.kind).toBe('expression');
    expect(el!.attrs.disabled).toEqual({ kind: 'bare' });
  });

  it('finds the enclosing element however the opening tag is laid out', () => {
    const src = [
      'const x = (',
      '  <TableScroll',
      '    label="Accounts"',
      '    className="rounded-lg"',
      '  >',
      '    {rows.length > 0 && <table />}',
      '  </TableScroll>',
      ');',
    ].join('\n');
    const table = jsxElements(src).find((e) => e.tag === 'table')!;
    expect(table.parentTag).toBe('TableScroll');
    expect(table.line).toBe(6);
  });

  it('names the element that really encloses it, and a fragment as <>', () => {
    const els = jsxElements('const x = <TableScroll><div><table /></div></TableScroll>;\nconst y = <><table /></>;');
    expect(els.filter((e) => e.tag === 'table').map((e) => e.parentTag)).toEqual(['div', '<>']);
  });
});
