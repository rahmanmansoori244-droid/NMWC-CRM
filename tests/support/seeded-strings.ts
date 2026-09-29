/**
 * Random strings that are the same on every run, so a failure reproduces from
 * its seed — for holding a rewritten function to the output of the one it
 * replaced. The generator is mulberry32, as in duplicate-pairing.test.ts.
 */
export function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` strings, each 0 to `maxPieces` pieces drawn from `pieces`. A piece may
 * be longer than one character ('<b>', 'x@y.z'), so the corpus holds the shapes
 * that matter and not only noise; repeat a piece to weight it.
 */
export function seededStrings(
  seed: number,
  count: number,
  pieces: readonly string[],
  maxPieces: number
): string[] {
  const r = seededRandom(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = Math.floor(r() * (maxPieces + 1));
    let s = '';
    for (let j = 0; j < n; j++) s += pieces[Math.floor(r() * pieces.length)];
    out.push(s);
  }
  return out;
}

/** The fastest of `runs` timings of fn(), in ms: one GC pause must not fail a timing guard. */
export function fastestMs(fn: () => unknown, runs = 3): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}
