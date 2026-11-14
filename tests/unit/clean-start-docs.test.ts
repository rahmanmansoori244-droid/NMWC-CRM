// @vitest-environment node
/**
 * Go-live clean start: the owner's guide quotes summary lines, refusal lines and
 * form labels verbatim. Every backticked phrase that looks like one must still
 * appear in the scripts and workflows ("…" and <x> are wildcards), so a renamed
 * line cannot leave the guide pointing at something the owner will never see
 * (review 2026-11-11: the guide promised figures on the Audit page that no
 * screen shows). A few phrases are prose or examples, listed below.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(f, 'utf8');
const SOURCES = [
  'scripts/ops/clean-start/run.sh',
  'scripts/ops/clean-start/seal-archive.sh',
  'scripts/ops/clean-start/photo-delete.sh',
  'scripts/ops/clean-start/rehearse-watch.ts',
  'scripts/ops/clean-start/compare-watch.ts',
  'scripts/ops/clean-start/expected-watch.json',
  'scripts/ops/clean-start/target-guard.sh',
  '.github/workflows/clean-start.yml',
  '.github/workflows/clean-start-photos.yml',
  '.github/workflows/db-backup.yml',
];
/** Examples, templates and prose fragments, not lines the code prints. */
const NOT_LINES = new Set([
  'REMOVE ALL TEST DATA 2026-11-18',
  'setting CLEANSTART_ACTOR_USERNAME present: no',
  'TRUNCATE … CONTINUE IDENTITY RESTRICT',
  ' is checked first), one at a time (',
  'restore-verify.ts --manifest',
  ' printed, then ',
]);

function missing(doc: string, src: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of doc.matchAll(/`([^`\n]+)`/g)) {
    const s = m[1]!.replace(/\\\|/g, '|');
    if (seen.has(s) || !/[:(]| /.test(s)) continue;
    seen.add(s);
    const parts = s
      .split(/…|<[^>]+>/)
      .map((x) => x.replace(/: (yes|no|ok|info|fail)$/, '').trim())
      .filter((x) => x.length > 5);
    if (parts.some((p) => !src.includes(p)) && !NOT_LINES.has(s)) out.push(s);
  }
  return out;
}

describe("the owner's guide quotes only lines the code prints", () => {
  const src = SOURCES.map(read).join('\n').replace(/''/g, "'");
  const guide = read('docs/GO-LIVE-CLEAN-START.md');
  const ops = read('docs/OPERATIONS.md');
  const section = ops.slice(ops.indexOf('## 5m.'), ops.indexOf('## 5l.') > ops.indexOf('## 5m.') ? ops.indexOf('## 5l.') : undefined);

  it('GO-LIVE-CLEAN-START.md and OPERATIONS 5m', () => {
    expect(section.length).toBeGreaterThan(1000);
    expect(missing(guide + section, src)).toEqual([]);
  });

  it('the check can fail', () => {
    expect(missing('`a line nobody prints: yes`', src)).toEqual(['a line nobody prints: yes']);
  });

  it('the GitHub timers that can start late are disabled for the reset evening and enabled again, by their real names', () => {
    for (const f of ['.github/workflows/sla-escalate.yml', '.github/workflows/keep-warm.yml']) {
      const name = /^name: (.+)$/m.exec(read(f))![1]!.trim();
      const step5 = guide.slice(guide.indexOf('## Step 5.'), guide.indexOf('## Step 6.'));
      const step6 = guide.slice(guide.indexOf('## Step 6.'), guide.indexOf('## Step 7.'));
      expect(step5, name).toContain(`**${name}**`);
      expect(step5).toContain('**Disable workflow**');
      expect(step5.indexOf(`**${name}**`)).toBeLessThan(step5.indexOf('Actions → **DB Backup**'));
      expect(step6, name).toContain(`**${name}**`);
      expect(step6).toContain('**Enable workflow**');
    }
    // The refusal a late run causes no longer blames only a person.
    expect(guide).toMatch(/`production unchanged since the plan: no` \| [^|]*late automatic timer/);
  });

  it('a waiting run that will not be approved is rejected (one concurrency group for both workflows)', () => {
    for (const f of ['.github/workflows/clean-start.yml', '.github/workflows/clean-start-photos.yml'])
      expect(read(f)).toMatch(/concurrency:\s*\n\s*group: clean-start\s*\n\s*cancel-in-progress: false/);
    const approve = guide.slice(guide.indexOf('**How to approve a run.**'), guide.indexOf('**The run id.**'));
    expect(approve).toMatch(/Review deployments\*\* → tick\s+\*\*production-reset\*\* → \*\*Reject\*\*/);
    expect(approve).toMatch(/no run may still show a\s+yellow circle/);
    const step5 = guide.slice(guide.indexOf('## Step 5.'), guide.indexOf('## Step 6.'));
    expect(step5).toMatch(/No earlier run may still show a yellow circle/);
  });

  it('the guide no longer says the Audit page shows the reset figures', () => {
    expect(guide).not.toMatch(/figures from the Audit page/i);
    expect(guide).not.toMatch(/Copy its figures/i);
    expect(ops).not.toMatch(/counts are visible only inside the CRM \(Audit\)/);
  });
});
