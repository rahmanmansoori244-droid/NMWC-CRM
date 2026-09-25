// @vitest-environment node
/**
 * tests/support/strip-comments.ts is what the structural guards read source
 * through, so it is tested on the cases that broke the regex it replaces, and on
 * the ones that broke its own first version (a node walk that never saw the
 * comments sitting next to punctuation).
 */
import { describe, it, expect } from 'vitest';
import { stripComments } from '../support/strip-comments';

/** Every comment gone, every other character exactly where it was. */
function expectStripped(src: string, gone: string[], kept: string[], fileName = 'x.tsx') {
  const out = stripComments(src, fileName);
  expect(out.length).toBe(src.length);
  expect(out.split('\n')).toHaveLength(src.split('\n').length);
  for (const g of gone) expect(out, `"${g}" should be blanked`).not.toContain(g);
  for (const k of kept) expect(out, `"${k}" should survive`).toContain(k);
}

describe('stripComments', () => {
  it('blanks // and /* */ comments and keeps every line where it was', () => {
    const src = ['const a = 1; // secret-looking note', '/* one', '   two */', 'const b = 2;'].join('\n');
    expectStripped(src, ['secret-looking', 'two'], ['const a = 1;', 'const b = 2;'], 'x.ts');
  });

  it('does not read accept="image/*" as the start of a comment', () => {
    // The naive regex opened a comment at `/*` here and swallowed real code.
    const src = '<input accept="image/*" />\nconst after = <table className="x" />;\n/* real */';
    expectStripped(src, ['real'], ['accept="image/*"', '<table className="x" />']);
  });

  it('blanks a JSX {/* comment */} and nothing around it', () => {
    const src = 'const x = (\n  <div>\n    {/* <table> quoted in a comment */}\n    <span>kept</span>\n  </div>\n);';
    expectStripped(src, ['<table>'], ['<span>kept</span>']);
  });

  it('leaves a string that merely contains // alone', () => {
    const src = "const u = 'https://api.cron-job.org'; // trailing";
    expectStripped(src, ['trailing'], ["'https://api.cron-job.org'"], 'x.ts');
  });

  it('blanks JSDoc blocks and a comment at the very end of the file', () => {
    const src = '/** type="tel" in a doc */\nconst a = 1;\n// last words';
    expectStripped(src, ['type="tel"', 'last words'], ['const a = 1;'], 'x.ts');
  });

  describe('comments next to punctuation, which a node walk never reached', () => {
    it('before the closing brace of a block', () => {
      expectStripped('function f() {\n  go();\n  // c-block\n}', ['c-block'], ['go();'], 'x.ts');
    });

    it('after the trailing comma of the last property', () => {
      expectStripped('const o = {\n  a: 1, // c-comma\n};', ['c-comma'], ['a: 1,'], 'x.ts');
    });

    it('as the last "attribute" before />', () => {
      // The exact shape that let a removed type="tel" satisfy the item-36 guard.
      const src = '<Field\n  label="Alt phone"\n  // type="tel" autoComplete="off"\n/>;';
      expectStripped(src, ['type="tel"', 'autoComplete'], ['label="Alt phone"', '/>']);
    });

    it('before the ) of a parenthesised JSX return', () => {
      expectStripped('const f = () => (\n  <div />\n  // c-paren\n);', ['c-paren'], ['<div />']);
    });

    it('inside empty call parentheses', () => {
      expectStripped('f(/* c-call */);', ['c-call'], ['f(', ');'], 'x.ts');
    });

    it('before the } of a JSX attribute expression', () => {
      const src = '<Row value={\n  x\n  // <PhoneLink phone={y} />\n} />;';
      expectStripped(src, ['<PhoneLink'], ['value={', 'x']);
    });
  });

  describe('JSX text is prose, never a comment', () => {
    it('keeps a URL in JSX text', () => {
      const src = 'const x = <p>Visit https://example.org/help now</p>;';
      expect(stripComments(src, 'x.tsx')).toBe(src);
    });

    it('keeps // text that follows an expression on the same line, and the markup after it', () => {
      const src = 'const x = <p>{a} // per unit <b>x</b></p>;';
      expect(stripComments(src, 'x.tsx')).toBe(src);
    });

    it('keeps /* text that follows an expression, and every line after it', () => {
      const src = 'const x = <p>{a} /* not a comment</p>;\nconst t = <table className="x" />;';
      expect(stripComments(src, 'x.tsx')).toBe(src);
    });

    it('keeps // text straight after an opening tag', () => {
      const src = 'const x = <p>// x</p>;';
      expect(stripComments(src, 'x.tsx')).toBe(src);
    });

    it('keeps // text on its own line inside an element', () => {
      const src = 'const x = (\n  <p>\n    // text\n  </p>\n);';
      expect(stripComments(src, 'x.tsx')).toBe(src);
    });
  });
});
