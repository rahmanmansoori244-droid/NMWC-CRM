// @vitest-environment node
/**
 * Owner decisions 2026-10-11: one Sales Director for every region in Oman, with
 * the SAME access as the GM everywhere — read scope, menus, landing page, the
 * approval queue and review page, e-mail, readiness and load checks, the account
 * import, the go-live accounts.
 *
 * "Everywhere" is a list of places nobody can hold in their head. Each of them
 * names the GM in a role list, and a place that names the GM but not the Sales
 * Director is either a decision someone has written down or a place that was
 * missed — the defect this project has met more than once: a correct rule that a
 * new role silently fell through. So every non-test source file whose code (its
 * comments stripped: a comment naming the GM proves nothing) names the GM role —
 * `Role.GM`, the string 'GM' or a `GM:` map key — must name SALES_DIRECTOR too,
 * unless it is allowlisted below with the reason.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { stripComments } from '../support/strip-comments';

const ROOT = process.cwd();
const DIRS = ['app', 'components', 'lib', 'services', 'scripts', 'prisma'];

/**
 * Files that name the GM and deliberately do NOT mirror him to the Sales
 * Director. Each needs a reason; an entry whose file no longer names the GM
 * fails below, so the list cannot go stale.
 */
const ALLOWED: Record<string, string> = {
  // The chain names the GM as its own step: the Sales Director has a step of his
  // own, earlier in the same chain, not a copy of the GM's.
  'lib/approval-chains.ts': 'the GM step is one step of the credit chain, not a role list',
  // Budgets are per step: the Sales Director's is set on its own line.
  'lib/working-hours.ts': 'per-step SLA budgets; the Sales Director has his own entry',
  // The plan per late step: who is told depends on which step is late.
  'lib/escalation.ts': 'per-step escalation targets, decided one step at a time',
  // The Muscat pilot seed refuses production and seeds the pilot's own accounts.
  'prisma/seed-muscat-pilot.ts': 'the pilot seed, which issued no Sales Director',
};

const NAMES_GM = /\bRole\.GM\b|'GM'|"GM"|(^|[\s{,])GM:/m;
const NAMES_SD = /SALES_DIRECTOR/;

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'migrations') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|cjs|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p).split(sep).join('/');
const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
const code = (p: string) =>
  stripComments(readFileSync(p, 'utf8'), p.endsWith('.tsx') ? 'file.tsx' : 'file.ts');
const namingGm = files.filter((f) => NAMES_GM.test(code(f)));

describe('the Sales Director mirrors the GM everywhere (owner decisions 2026-10-11)', () => {
  it('finds the places that name the GM', () => {
    // Guards the scan itself: matching nothing would pass for no reason.
    const found = namingGm.map(rel);
    for (const f of ['lib/access.ts', 'lib/permissions.ts', 'lib/notify-policy.ts', 'components/nmwc/Sidebar.tsx']) {
      expect(found, f).toContain(f);
    }
  });

  it.each(namingGm.map(rel).filter((f) => !ALLOWED[f]))('%s names SALES_DIRECTOR too', (f) => {
    expect(
      NAMES_SD.test(code(join(ROOT, f))),
      `${f} names the GM but not the Sales Director. Mirror the GM there, or allowlist it here with the reason.`
    ).toBe(true);
  });

  it.each(Object.keys(ALLOWED))('allowlisted %s still names the GM (or the entry is stale)', (f) => {
    expect(namingGm.map(rel)).toContain(f);
  });
});
