// @vitest-environment node
/**
 * Benchmark item 22 is only as good as its wiring: a correct postForm that a
 * form stops calling, or a receipt lookup a submit path skips, fails silently —
 * the salesman is back to a raw "Failed to fetch" or a red lock on his own
 * submit. The behaviour is proven against Postgres (golive-update-flow.test.ts,
 * section 12); this pins that every form and every submit path still takes part.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';

const src = (path: string) => stripComments(readFileSync(path, 'utf8'), path);

const FORMS = [
  ['app/(app)/customers/[id]/edit/EnrichmentForm.tsx', ["'customer-edit'"]],
  ['app/(app)/customers/new/CreateCustomerForm.tsx', ["'customer-create'"]],
  ['components/nmwc/BranchStatusActions.tsx', ["'branch-close'", "'branch-reactivate'"]],
] as const;

describe('every field form submits through postForm, with a submission id', () => {
  it.each(FORMS)('%s', (path, names) => {
    const s = src(path);
    expect(s).toMatch(/\bpostForm<SubmitReceipt>\(/);
    for (const name of names) expect(s).toContain(name);
    // An id per payload, kept for the life of the form (a new SubmissionIds per
    // submit never reuses an id), and every outcome settles it.
    expect(s).toMatch(/useRef<SubmissionIds \| null>\(null\)/);
    expect(s).toMatch(/idsRef\.current \?\?= new SubmissionIds\(\)/);
    expect(s).not.toMatch(/idsRef\.current = new SubmissionIds\(\)/);
    expect(s).toMatch(/\.idFor\(/);
    expect(s).toMatch(/\.settle\(outcome\)/);
    expect(s).toMatch(/submissionId/);
    // What happened is said beside the button, with Try again.
    expect(s).toMatch(/<SubmitNoticeBox\b[^>]*onRetry=/s);
    // Not the server actions: a stalled one cannot be aborted, and queues the retry.
    expect(s).not.toMatch(/from '@\/services\/(edits|creates|reactivations)'/);
  });
});

describe('every submit path answers a replay before doing anything else', () => {
  const PATHS = [
    ['services/edits.ts', 'submitEditCore', 'submitEditOnce'],
    ['services/creates.ts', 'submitCreateCore', 'submitCreateOnce'],
    ['services/reactivations.ts', 'requestReactivationCore', 'requestReactivationOnce'],
    ['services/reactivations.ts', 'markBranchClosedCore', 'markBranchClosedOnce'],
  ] as const;

  /** The text of one top-level `async function name(` up to the next one. */
  const fnBody = (s: string, name: string) => {
    const start = s.indexOf(`async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const next = s.indexOf('\nasync function ', start + 1);
    return s.slice(start, next === -1 ? undefined : next);
  };

  it.each(PATHS)('%s %s', (path, core, once) => {
    const s = src(path);
    const outer = fnBody(s, core);
    // First the receipt; then the real work, inside answerIfLanded — so a retry
    // refused by its own first attempt is answered from the receipt too.
    const replay = outer.search(/const replayed = await receipt\(\);\s*if \(replayed\) return replayed;/);
    const work = outer.search(new RegExp(`return answerIfLanded\\(\\(\\) => ${once}\\(`));
    expect(replay, 'no replay check').toBeGreaterThan(-1);
    expect(work, `the work does not run through answerIfLanded(${once})`).toBeGreaterThan(-1);
    expect(replay).toBeLessThan(work);
    expect(outer, 'real work before the receipt').not.toMatch(/checkLimit\(|prisma\.branch\.findFirst\(/);
    // The id is stored on the row the work writes, or a retry can never find it.
    expect(fnBody(s, once)).toMatch(/submissionId[,:]/);
  });

  it('the route serves exactly the forms the client can name', () => {
    const client = src('lib/submit-client.ts');
    const union = client.match(/export type FieldForm =([^;]+);/)![1]!;
    const named = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
    const route = src('app/api/forms/[form]/route.ts');
    const served = [...route.matchAll(/^\s+'([a-z-]+)': \(body\) =>/gm)].map((m) => m[1]).sort();
    expect(served).toEqual(named);
    expect(named).toHaveLength(4);
  });
});
