/**
 * AGENTS.md carries CLAUDE.md's rules for agents other than Claude Code (Codex reads
 * AGENTS.md, not CLAUDE.md). A rule changed in one file and not the other would leave
 * one agent working to an older rule — the ones that keep production and customer data
 * safe included. So AGENTS.md must contain CLAUDE.md verbatim.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

describe('AGENTS.md mirrors CLAUDE.md', () => {
  it('contains every word of CLAUDE.md, in order', () => {
    const claude = read('CLAUDE.md').trim();
    expect(claude.length).toBeGreaterThan(1000);
    expect(read('AGENTS.md')).toContain(claude);
  });

  it('points a new agent at the handover and forbids pushing to main', () => {
    const agents = read('AGENTS.md');
    expect(agents).toContain('docs/HANDOVER.md');
    expect(agents).toMatch(/Never push to `main` and never merge/);
  });
});
