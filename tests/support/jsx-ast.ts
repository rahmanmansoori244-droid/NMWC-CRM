/**
 * The JSX elements of a TSX source, read by the TypeScript parser.
 *
 * For structural guards that are about ELEMENTS — "every <table> sits in a
 * TableScroll", "every phone Field is type=tel". A line or regex match gets
 * those wrong in ways a parser cannot: the repo's own `npm run format` moves an
 * opening tag's attributes onto separate lines, and an `onChange={(v) => …}`
 * puts a `>` inside the tag. Comments are not nodes, so a commented-out
 * attribute is never read as a real one.
 */
import ts from 'typescript';

export type JsxAttr = { kind: 'string'; value: string } | { kind: 'expression'; text: string } | { kind: 'bare' };

export type JsxEl = {
  tag: string;
  attrs: Record<string, JsxAttr>;
  /** Tag of the nearest enclosing JSX element, '<>' for a fragment, null at the top. */
  parentTag: string | null;
  line: number;
};

export function jsxElements(src: string, fileName = 'file.tsx'): JsxEl[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: JsxEl[] = [];

  const parentTag = (node: ts.Node): string | null => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxElement(p)) return p.openingElement.tagName.getText(sf);
      if (ts.isJsxFragment(p)) return '<>';
    }
    return null;
  };

  const read = (tagName: ts.JsxTagNameExpression, attributes: ts.JsxAttributes, at: ts.Node) => {
    const attrs: Record<string, JsxAttr> = {};
    for (const a of attributes.properties) {
      if (!ts.isJsxAttribute(a)) continue;
      const name = a.name.getText(sf);
      const init = a.initializer;
      if (!init) attrs[name] = { kind: 'bare' };
      else if (ts.isStringLiteral(init)) attrs[name] = { kind: 'string', value: init.text };
      else if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression))
        attrs[name] = { kind: 'string', value: init.expression.text };
      else attrs[name] = { kind: 'expression', text: init.getText(sf) };
    }
    out.push({
      tag: tagName.getText(sf),
      attrs,
      parentTag: parentTag(at),
      line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) read(node.openingElement.tagName, node.openingElement.attributes, node);
    else if (ts.isJsxSelfClosingElement(node)) read(node.tagName, node.attributes, node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
