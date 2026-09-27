// @vitest-environment node
/**
 * Item 13: docs/SECRETS-INVENTORY.md is the one list of what the running
 * application reads from its environment, and who holds it.
 *
 * The list it replaced — OPERATIONS.md §3 — named eight variables while the code
 * read thirty-odd, including CRON_SECRET, HEALTH_BEARER and ALERT_WEBHOOK_URL. A
 * hand-kept list drifts because nothing compares it to anything; this does, the
 * same way tests/unit/required-secrets.test.ts pins the GitHub side.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIRS = ['app', 'lib', 'services', 'components'];
const ROOT_FILES = [
  'middleware.ts',
  'auth.config.ts',
  'instrumentation.ts',
  'instrumentation-client.ts',
  'sentry.server.config.ts',
  'sentry.edge.config.ts',
  'next.config.ts',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// Comments stripped first: a comment that quotes `process.env.X` is not a read.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

function namesReadByTheApp(): Set<string> {
  const names = new Set<string>();
  const files = [...DIRS.flatMap(sourceFiles), ...ROOT_FILES];
  for (const f of files) {
    for (const m of strip(readFileSync(f, 'utf8')).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]!);
  }
  // Prisma reads its connection strings from the schema, not from TypeScript.
  for (const m of readFileSync('prisma/schema.prisma', 'utf8').matchAll(/env\("([A-Z0-9_]+)"\)/g)) names.add(m[1]!);
  return names;
}

describe('the inventory lists every variable the application reads', () => {
  const doc = readFileSync('docs/SECRETS-INVENTORY.md', 'utf8');
  const names = namesReadByTheApp();

  it('finds the reads at all (a broken scan would pass everything)', () => {
    for (const known of ['DATABASE_URL', 'DIRECT_URL', 'CRON_SECRET', 'HEALTH_BEARER', 'R2_SECRET_ACCESS_KEY']) {
      expect(names, known).toContain(known);
    }
  });

  it.each([...names].sort())('%s is on docs/SECRETS-INVENTORY.md', (name) => {
    expect(doc).toContain(`\`${name}\``);
  });
});

describe('OPERATIONS.md points at the inventory rather than keeping its own list', () => {
  it('section 3 refers to the inventory', () => {
    const ops = readFileSync('docs/OPERATIONS.md', 'utf8');
    const section = ops.slice(ops.indexOf('## 3. Environment variables'), ops.indexOf('## 4. Deploy'));
    expect(section).toContain('SECRETS-INVENTORY.md');
  });
});
