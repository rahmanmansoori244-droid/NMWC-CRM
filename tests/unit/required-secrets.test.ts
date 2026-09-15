// @vitest-environment node
/**
 * DO-16 — the operator checklist drifted for four months and nothing noticed.
 *
 * `scripts/print-required-secrets.ts` was written on 2026-05-10 and named seven
 * secrets. The workflows grew to sixteen names. Both the runbook and
 * OPERATIONS.md point the owner at that script as "the checklist", and the name
 * it omitted was `BACKUP_AGE_RECIPIENTS` — so an owner who followed it and
 * skipped the age key got a nightly plaintext gzip of the whole customer master
 * and every employee's password hash uploaded to R2, warned about inside a run
 * that stayed green, every night.
 *
 * A hand-maintained list drifts silently because nothing compares it to
 * anything. This compares it, in both directions: every name the workflows read
 * must be declared, and every declared name must actually be read.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { REQUIRED_SECRETS, WORKFLOW_PROVIDED } from '@/lib/ops/required-secrets';

const DIR = '.github/workflows';

/** name → the workflow basenames that reference it, comments ignored. */
function referencesFromWorkflows(): Map<string, { kind: 'secret' | 'variable'; files: Set<string> }> {
  const found = new Map<string, { kind: 'secret' | 'variable'; files: Set<string> }>();
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    const body = readFileSync(`${DIR}/${file}`, 'utf8');
    for (const line of body.split('\n')) {
      // A commented-out reference is documentation, not a requirement.
      if (line.trim().startsWith('#')) continue;
      for (const m of line.matchAll(/\b(secrets|vars)\.([A-Z][A-Z0-9_]*)\b/g)) {
        const kind = m[1] === 'secrets' ? 'secret' : 'variable';
        const name = m[2]!;
        if (WORKFLOW_PROVIDED.includes(name)) continue;
        const entry = found.get(name) ?? { kind, files: new Set<string>() };
        entry.files.add(file);
        found.set(name, entry);
      }
    }
  }
  return found;
}

const used = referencesFromWorkflows();
const declared = new Map(REQUIRED_SECRETS.map((r) => [r.name, r]));

describe('the checklist and the workflows agree', () => {
  it('finds something to check at all', () => {
    // Guards against the whole suite passing vacuously because the directory
    // moved or the regex stopped matching.
    expect(used.size).toBeGreaterThan(10);
    expect(REQUIRED_SECRETS.length).toBeGreaterThan(10);
  });

  it('declares every name the workflows read', () => {
    const missing = [...used.keys()].filter((n) => !declared.has(n)).sort();
    // This is the assertion that would have caught BACKUP_AGE_RECIPIENTS.
    expect(missing).toEqual([]);
  });

  it('declares nothing the workflows do not read', () => {
    const dead = REQUIRED_SECRETS.map((r) => r.name)
      .filter((n) => !used.has(n))
      .sort();
    // A checklist that asks the owner for a value nothing consumes trains them
    // to ignore it, which is how the real omission survives.
    expect(dead).toEqual([]);
  });

  it('puts each name on the right GitHub settings page', () => {
    // GitHub keeps secrets and variables apart, and a value set on the wrong page
    // simply reads as empty — which for the age recipients meant a plaintext dump.
    for (const [name, { kind }] of used) {
      expect(declared.get(name)?.kind, `${name} is a ${kind} in the workflows`).toBe(kind);
    }
  });

  it('names the right workflows for each entry', () => {
    for (const [name, { files }] of used) {
      expect([...(declared.get(name)?.workflows ?? [])].sort()).toEqual([...files].sort());
    }
  });
});

describe('the entry that motivated this', () => {
  it('BACKUP_AGE_RECIPIENTS is a REQUIRED variable', () => {
    const r = declared.get('BACKUP_AGE_RECIPIENTS');
    expect(r?.kind).toBe('variable');
    expect(r?.required).toBe(true);
  });

  it('the nightly backup refuses to upload plaintext without it', () => {
    // The workflow used to warn and upload anyway. Pinned here because the
    // consequence line in the declared list asserts this behaviour to the owner.
    const wf = readFileSync(`${DIR}/db-backup.yml`, 'utf8');
    expect(wf).toMatch(/::error::BACKUP_AGE_RECIPIENTS is not set/);
    expect(wf).not.toMatch(/::warning::BACKUP_AGE_RECIPIENTS is not set —/);
  });

  it('the override is an exact-string opt-in, not any truthy value', () => {
    const wf = readFileSync(`${DIR}/db-backup.yml`, 'utf8');
    // `= "true"` and nothing looser: "1", "yes" or "TRUE" must not disable
    // encryption by accident.
    expect(wf).toMatch(/\[ "\$\{ALLOW_PLAINTEXT_BACKUP:-\}" = "true" \]/);
  });
});

describe('every entry is usable by the person reading it', () => {
  it.each(REQUIRED_SECRETS.map((r) => [r.name, r] as const))(
    '%s says where it comes from and what breaks without it',
    (_name, r) => {
      expect(r.description.length).toBeGreaterThan(20);
      expect(r.source.length).toBeGreaterThan(10);
      expect(r.consequenceIfMissing.length).toBeGreaterThan(20);
      expect(r.workflows.length).toBeGreaterThan(0);
    }
  );

  it('PROD_CRON_SECRET names the second place it must be set', () => {
    // Its entire failure mode is being set in one place and not the other: the
    // GitHub secret and the Vercel env var must hold the SAME value, and nothing
    // renders the comment in keep-warm.yml that says so.
    expect(declared.get('PROD_CRON_SECRET')?.alsoSetOn).toMatch(/Vercel/);
    expect(declared.get('PROD_CRON_SECRET')?.alsoSetOn).toMatch(/CRON_SECRET/);
  });
});
