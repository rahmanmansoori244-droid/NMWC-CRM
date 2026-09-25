// @vitest-environment node
/**
 * tests/support/workflow-step.ts runs workflow steps for three guards. This pins
 * the one thing it must never blur: a step that FAILED and a step that never
 * finished.
 *
 * Until 2026-09-25 a step the harness killed on its time budget came back as
 * status -1. On Windows the smoke step's 24 attempts outran the 60 s budget under
 * a full suite run, and five scenarios failed with "expected -1 to be 1" — which
 * reads as the step classifying wrongly, when it had not answered at all. Worse,
 * every guard asserting `status).not.toBe(0)` took the -1 as the step correctly
 * failing, so a step that hung passed them.
 */
import { describe, it, expect } from 'vitest';
import { runStep, STEP_TEST_TIMEOUT_MS } from '../support/workflow-step';

describe('runStep tells a step that failed from one that never finished', { timeout: STEP_TEST_TIMEOUT_MS }, () => {
  it('returns a non-zero exit as the step\'s own answer', () => {
    const o = runStep('echo about to fail\nexit 3', '', {});
    expect(o.status, o.output).toBe(3);
    expect(o.output).toContain('about to fail');
  });

  it('throws, naming the budget, when it has to kill a step that does not exit', () => {
    // A loop of builtins, not `sleep`: a child process can outlive bash's kill and
    // hold the output pipe open, and spawnSync would wait for it.
    const started = Date.now();
    expect(() => runStep('echo started\nwhile :; do :; done', '', {}, {}, 3_000)).toThrow(
      /did not finish[\s\S]*KILLED it after 3s[\s\S]*not the step failing[\s\S]*Last output:\nstarted/
    );
    // The budget passed is the one enforced, not the 180 s default.
    expect(Date.now() - started).toBeLessThan(60_000);
  });
});
