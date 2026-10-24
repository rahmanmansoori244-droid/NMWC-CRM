// @vitest-environment node
/**
 * Gap 28: scripts/ops/verify-seals.ts, the read-only check of the seal chain.
 *
 *  - It refuses to run without --expect-host (it ends in the shared production
 *    guard: tests/unit/scripts-production-guard.test.ts walks it like every
 *    script), before any client is built.
 *  - Its options are checked; an unknown one is refused.
 *  - What it prints is seq, day, table, the kind of mismatch, counts and hash
 *    prefixes: never a row's content.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mismatchLine, parseVerifySealsArgs, report } from '../../scripts/ops/verify-seals';
import { stripComments } from '../support/strip-comments';

describe('the command line', () => {
  it('reads its options', () => {
    expect(parseVerifySealsArgs(['--expect-host', 'ep-x'])).toEqual({ fromSeq: undefined, toSeq: undefined, offsite: true, all: false });
    expect(parseVerifySealsArgs(['--expect-host', 'ep-x', '--from-seq', '3', '--to-seq', '9', '--no-offsite', '--all'])).toEqual({
      fromSeq: 3,
      toSeq: 9,
      offsite: false,
      all: true,
    });
  });

  it.each([
    [['--from-seq']],
    [['--from-seq', '-1']],
    [['--to-seq', 'x']],
    [['--from-seq', '5', '--to-seq', '2']],
    [['--apply']],
    [['stray']],
  ])('refuses %j', (args) => {
    expect(() => parseVerifySealsArgs(['--expect-host', 'ep-x', ...args])).toThrow();
  });

  it('refuses to run without --expect-host, before it connects to anything', () => {
    const fake = ['postgresql://', 'nobody', ':', 'x', '@', 'ep-uat-fake.invalid', '/db'].join('');
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/ops/verify-seals.ts'], {
      env: { ...process.env, DIRECT_URL: fake, DATABASE_URL: fake },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refusing to run without --expect-host/);
    expect(r.stderr + r.stdout).not.toContain(fake);
  }, 150_000);

  it('imports only the pure seal modules and the R2 client, never the app’s database client', () => {
    const src = stripComments(readFileSync('scripts/ops/verify-seals.ts', 'utf8'), 'verify-seals.ts');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    expect(imports.filter((i) => i.includes('lib/'))).toEqual(['../../lib/seal/chain', '../../lib/seal/verify', '../../lib/seal/store']);
    expect(src).not.toMatch(/lib\/db|@\/lib/);
    expect(src).toMatch(/SET TRANSACTION READ ONLY/);
    expect(src).not.toMatch(/\$executeRaw`|INSERT|UPDATE "|DELETE/);
  });
});

describe('what it prints', () => {
  const seals = 12;
  const windowSeqs = Array.from({ length: 12 }, (_, i) => i);
  it('everything matches: exit 0', () => {
    const r = report({ seals, windowSeqs, rangesRecomputed: 160, mismatches: [] }, { offsite: true, all: false });
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toContain('Every seal matches.');
  });

  it('the FIRST mismatch only, unless --all: exit 1, with counts and hash prefixes, never a row', () => {
    const mismatches = [
      { kind: 'rows-changed' as const, seq: 4, day: '2026-10-24', table: 'AuditLog', detail: '12 rows, digest 0123456789ab sealed, fedcba987654 now' },
      { kind: 'offsite-missing' as const, seq: 7, day: '2026-10-27', detail: 'seals/v1/2026/2026-10-27-000007-0123456789abcdef.json' },
    ];
    const first = report({ seals, windowSeqs, rangesRecomputed: 160, mismatches }, { offsite: true, all: false });
    expect(first.code).toBe(1);
    expect(first.lines.filter((l) => l.startsWith('  seal'))).toEqual([mismatchLine(mismatches[0]!)]);
    expect(mismatchLine(mismatches[0]!)).toBe(
      '  seal      4  2026-10-24  AuditLog           rows changed (same count, digest differs): 12 rows, digest 0123456789ab sealed, fedcba987654 now'
    );
    const all = report({ seals, windowSeqs, rangesRecomputed: 160, mismatches }, { offsite: true, all: true });
    expect(all.lines.filter((l) => l.startsWith('  seal'))).toHaveLength(2);
  });
});
