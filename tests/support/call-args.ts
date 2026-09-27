/**
 * The argument text of every call to a callee in a source file, found by
 * balanced-bracket scanning rather than a lazy regex — a regex stops at the first
 * `}` or `)` it meets, so a nested object or a type cast in the arguments made the
 * structural guards read the wrong span (review, 2026-09-27).
 *
 * String and template literals are skipped so a bracket inside one does not
 * count. Run it on comment-stripped source (tests/support/strip-comments.ts).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function callArguments(src: string, callee: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(callee.source, callee.flags.includes('g') ? callee.flags : `${callee.flags}g`);
  for (const m of src.matchAll(re)) {
    let i = m.index! + m[0].length;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== '(') continue;
    const start = i + 1;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        for (i++; i < src.length && src[i] !== quote; i++) if (src[i] === '\\') i++;
        continue;
      }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          out.push(src.slice(start, i));
          break;
        }
      }
    }
  }
  return out;
}

/** Every .ts/.tsx file under the given directories. */
export function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n)) out.push(p);
    }
  };
  dirs.forEach(walk);
  return out;
}
