/**
 * The argument text of every call to a callee in a source file, found by
 * balanced-bracket scanning rather than a lazy regex — a regex stops at the first
 * `}` or `)` it meets, so a nested object or a type cast in the arguments made the
 * structural guards read the wrong span (review, 2026-09-27).
 *
 * String and template literals are skipped so a bracket inside one does not
 * count. Run it on comment-stripped source (tests/support/strip-comments.ts). A
 * call it cannot balance is an error, never a silent skip: a guard that quietly
 * drops the call it cannot read passes for the wrong reason (review of f05752e).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The text between an opening bracket at `open` and its match. */
function balanced(src: string, open: number, where: string): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      for (i++; i < src.length && src[i] !== quote; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`call-args: unbalanced brackets after ${where} — the guard cannot read this call`);
}

export function callArguments(src: string, callee: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(callee.source, callee.flags.includes('g') ? callee.flags : `${callee.flags}g`);
  for (const m of src.matchAll(re)) {
    let i = m.index! + m[0].length;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== '(') continue;
    out.push(balanced(src, i, m[0]));
  }
  return out;
}

/** Every `{ … }` that follows `key:` in some text — each occurrence, not just the first. */
export function objectsAfter(src: string, key: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(key.source, key.flags.includes('g') ? key.flags : `${key.flags}g`);
  for (const m of src.matchAll(re)) {
    let i = m.index! + m[0].length;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] === '{') out.push(balanced(src, i, m[0]));
  }
  return out;
}

/** The first `{ … }` after `key:` (e.g. the `where` of one Prisma call's arguments). */
export function objectAfter(src: string, key: RegExp): string | null {
  return objectsAfter(src, key)[0] ?? null;
}

/** The text of an object literal with every nested `{…}`, `[…]` and `(…)` removed. */
export function topLevel(objectText: string): string {
  let out = '';
  let depth = 0;
  for (const c of objectText) {
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (depth === 0) out += c;
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
