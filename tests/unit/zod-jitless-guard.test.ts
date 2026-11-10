// @vitest-environment node
/**
 * zod 4 and the content-security-policy. Zod 4 turns an object schema into a
 * parser with `new Function` when it may, and first asks whether it may by
 * running `new Function('')` once. Production's policy allows no 'unsafe-eval'
 * (lib/csp.ts), so in a browser both are refused — and the refusal is REPORTED
 * as a policy violation even though zod catches it. Three client bundles carry
 * zod (the customer update form, the new-customer form and the close / reopen
 * buttons, through lib/submission.ts), so lib/zod.ts switches the compiler off
 * (`jitless`) before any schema exists, and every schema is built from it.
 *
 * What this file holds:
 *   - the switch is on, with zod 3's words, the moment lib/zod.ts has loaded;
 *   - with `Function` refusing the way a browser under that policy refuses, not
 *     one schema of the app — nor a new object schema — asks for it, and every
 *     parse answers as it does without the refusal;
 *   - the check can fail: with the switch off, zod does ask (so this is not a
 *     trap that nothing can spring);
 *   - nothing in app/, components/, lib/ or services/ may import zod except
 *     lib/zod.ts — the ESLint rule that says so really runs (a broken rule fails
 *     open: Next logs one line and builds unlinted, as audit-guard.test.ts tells).
 *
 * The browser itself is checked by the launch e2e's platform spec, which fails
 * on a policy violation in the console of a production build.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ESLint } from 'eslint';
import { z, zod3Message } from '@/lib/zod';
import { submissionIdSchema } from '@/lib/submission';
import { submitCreateSchema } from '@/lib/validation/create';
import { submitEditSchema } from '@/lib/validation/edit';
import { gpsManualReasonSchema } from '@/lib/gps-manual';
import { passwordRule } from '@/lib/password-policy';
import { parseSubmitGate } from '@/lib/edit-scope';

const RealFunction = Function;

/** `Function` as a page under a policy without 'unsafe-eval' has it: any use to build code throws. */
function refusingFunction(): { trap: FunctionConstructor; asked: () => number } {
  let asked = 0;
  const refuse = () => {
    asked += 1;
    throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script");
  };
  const trap = new Proxy(RealFunction, { construct: refuse, apply: refuse }) as FunctionConstructor;
  return { trap, asked: () => asked };
}

/** What a parse answered, in a form two runs can be compared by. */
const answer = (r: { success: boolean; data?: unknown; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
  r.success ? { ok: true, data: JSON.stringify(r.data) } : { ok: false, issues: r.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };

/** Every schema a browser bundle or a request reaches, each with a body it takes and one it refuses. */
function parseEverything() {
  const fresh = z.object({ a: z.string(), b: z.object({ c: z.number().int() }).strict() });
  return [
    answer(fresh.safeParse({ a: 'x', b: { c: 1 } })),
    answer(fresh.safeParse({ a: 1, b: { c: 1.5, d: true } })),
    answer(submissionIdSchema.safeParse('3f2b8c1e-7a4d-4e9b-8c6f-1a2b3c4d5e6f')),
    answer(submissionIdSchema.safeParse('not-a-uuid')),
    answer(submitCreateSchema.safeParse({})),
    answer(submitCreateSchema.safeParse({ customer: { legalName: 'ZZ Trading' }, branches: [{}] })),
    answer(submitEditSchema.safeParse({})),
    answer(submitEditSchema.safeParse({ customerId: 'x', branches: [{ branchId: 'y', gpsLat: 99 }] })),
    answer(gpsManualReasonSchema.safeParse('the shop moved across the road')),
    answer(gpsManualReasonSchema.safeParse('')),
    answer(passwordRule.safeParse('short')),
    { ok: true, data: JSON.stringify(parseSubmitGate({ v: 1, branchIds: ['b1'] })) },
    { ok: true, data: JSON.stringify(parseSubmitGate({ v: 2 })) },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Whatever a test did, the app's settings are the ones every later parse runs on.
  z.config({ jitless: true, customError: zod3Message });
});

describe('zod never builds code: the policy allows no eval', () => {
  it('lib/zod.ts has switched the compiler off and installed zod 3’s words', () => {
    expect(z.config().jitless).toBe(true);
    expect(z.config().customError).toBe(zod3Message);
  });

  it('with Function refusing as it does under the policy, no schema asks for it and every answer is the same', () => {
    const plain = parseEverything();
    const { trap, asked } = refusingFunction();
    vi.stubGlobal('Function', trap);
    let refused: ReturnType<typeof parseEverything>;
    try {
      refused = parseEverything();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(asked()).toBe(0);
    expect(refused).toEqual(plain);
    // Not vacuous: bodies were both taken and refused.
    expect(plain.some((a) => a.ok)).toBe(true);
    expect(plain.some((a) => !a.ok)).toBe(true);
  });

  it('the check can fail: with the switch off, zod does ask (and falls back when refused)', () => {
    const { trap, asked } = refusingFunction();
    z.config({ jitless: false });
    vi.stubGlobal('Function', trap);
    let parsed: { success: boolean };
    try {
      // The question is asked when an object schema is built, so build one now.
      parsed = z.object({ a: z.string() }).safeParse({ a: 'x' });
    } finally {
      vi.unstubAllGlobals();
      z.config({ jitless: true });
    }
    expect(asked()).toBeGreaterThan(0);
    expect(parsed.success).toBe(true);
  });
});

describe('only lib/zod.ts imports zod (the ESLint rule runs)', () => {
  // Constructing ESLint loads the whole flat config; once for the file.
  const eslint = new ESLint({ cwd: process.cwd() });
  const TIMEOUT = 30_000;
  const hits = async (filePath: string, code: string) => {
    const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
    return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports');
  };

  it(
    'an import of zod, or of a zod subpath, is an error anywhere in app/, components/, lib/ and services/',
    async () => {
      for (const file of ['lib/zz-probe.ts', 'services/zz-probe.ts', 'components/nmwc/ZzProbe.tsx', 'app/(app)/zz-probe/page.tsx', 'app/api/zz-probe/route.ts']) {
        for (const spec of ['zod', 'zod/v4', 'zod/mini', 'zod/v4/core']) {
          const found = await hits(file, `import { z } from '${spec}';\nexport const s = z.string();\n`);
          expect(found.length, `${file} importing ${spec}`).toBeGreaterThan(0);
          expect(found.every((m) => m.severity === 2), `${file} importing ${spec}: severity`).toBe(true);
        }
        // A type-only import builds no schema, but it is refused all the same: one door.
        expect((await hits(file, "import type { z } from 'zod';\nexport type S = z.ZodType;\n")).length, `${file} type import`).toBeGreaterThan(0);
      }
    },
    TIMEOUT
  );

  it(
    'lib/zod.ts itself may, and the app’s own door is not refused',
    async () => {
      expect(await hits('lib/zod.ts', "import { z } from 'zod';\nexport { z };\n")).toEqual([]);
      expect(await hits('lib/zz-probe.ts', "import { z } from '@/lib/zod';\nexport const s = z.string();\n")).toEqual([]);
      expect(await hits('lib/validation/zz-probe.ts', "import { z } from '../zod';\nexport const s = z.string();\n")).toEqual([]);
    },
    TIMEOUT
  );
});
