// @vitest-environment node
/**
 * Code review 2026-11-10, finding 21, second round — structural, per CLAUDE.md
 * (comments stripped first). A decision's atomic claim that matched nothing
 * throws a LostClaimError, and its transaction is run inside the wrapper that
 * answers a claim lost to the approver's OWN earlier request with "Your
 * decision already arrived" (lib/already-decided.ts answerLostClaim). A new
 * claim written with a plain ConflictError, or a transaction left outside the
 * wrapper, would credit his own decision to "another reviewer" again.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';

const read = (file: string) => stripComments(readFileSync(file, 'utf8'), file);
const count = (src: string, re: RegExp) => (src.match(new RegExp(re.source, 'g')) ?? []).length;

describe('every decision claim answers a claim lost to the approver himself', () => {
  it.each([
    ['services/edits.ts', /ownLostClaim\([^)]*\(\) => withChangeContext\(/, 4],
    ['services/reactivations.ts', /ownReactivationClaim\([^)]*\(\) => withChangeContext\(/, 2],
  ] as const)('%s', (file, wrapped, claims) => {
    const src = read(file);
    // No claim refusal is thrown as a plain ConflictError any more.
    expect(src).not.toMatch(/new ConflictError\(\s*'NOT_PENDING',\s*'[^']*just decided by another reviewer/);
    expect(count(src, /new LostClaimError\(/)).toBe(claims);
    // Each claim's transaction runs inside the wrapper (one claim per transaction).
    expect(count(src, wrapped)).toBe(claims);
  });
});
