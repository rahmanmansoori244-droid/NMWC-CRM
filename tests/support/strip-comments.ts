/**
 * Blank every comment in a TS/TSX source, keeping each line where it was.
 *
 * Structural guards assert against source text, and CLAUDE.md requires comments
 * stripped first: a comment quoting the thing asserted makes the guard pass or
 * fail for the wrong reason. The naive `/\/\*[\s\S]*?\*\//` regex is wrong in both
 * directions — `accept="image/*"` opens a fake comment that swallows real code,
 * and a URL in JSX text (`Visit https://…`) reads as a `//` comment to a raw
 * token scan. This asks the TypeScript PARSER where the tokens are, so string
 * literals and JSX text are never mistaken for comments.
 *
 * Comments live in the trivia BETWEEN tokens, so every token is visited — not
 * only every node. A node walk (`forEachChild`) never reaches punctuation, and
 * missed every comment that sits just before a `}`, `)` or `/>`, or just after a
 * trailing comma: a commented-out `type="tel"` before `/>` survived and satisfied
 * the guard that was meant to catch its removal.
 *
 * JSX text is not trivia but it can LOOK like it: in `<p>{a} // per unit</p>` a
 * scan from the end of `{a}` reads `// per unit</p>` as a comment. So any range
 * that overlaps a JsxText token is dropped — inside JSX children, the only real
 * comment is `{/* … *\/}`, and that sits between the braces, not in the text.
 *
 * Comments are replaced character-for-character with spaces, newlines kept, so
 * line numbers and "the line before" still mean what they did in the file.
 */
import ts from 'typescript';

export function stripComments(src: string, fileName = 'file.tsx'): string {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  const ranges: Array<[number, number]> = [];
  const jsxText: Array<[number, number]> = [];
  const add = (rs: readonly ts.CommentRange[] | undefined) => {
    for (const r of rs ?? []) ranges.push([r.pos, r.end]);
  };

  const visit = (node: ts.Node): void => {
    // A JSDoc block is itself a comment; the token after it finds it as leading trivia.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxText.push([node.pos, node.end]);
      return;
    }
    const children = node.getChildren(sf);
    if (children.length === 0) {
      add(ts.getLeadingCommentRanges(src, node.getFullStart()));
      add(ts.getTrailingCommentRanges(src, node.getEnd()));
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sf);

  const inJsxText = ([from, to]: [number, number]) => jsxText.some(([a, b]) => from < b && to > a);
  const out = src.split('');
  for (const range of ranges) {
    if (inJsxText(range)) continue;
    for (let i = range[0]; i < range[1]; i++) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  }
  return out.join('');
}
