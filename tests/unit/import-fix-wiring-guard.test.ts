/**
 * Structural guards for the Steward's in-app fix of import rows (item 20),
 * asserted on comment-stripped source.
 *
 * The defect these prevent is "a correct helper nobody calls": the fix is only
 * safe while the upload and the fix run the SAME row check, and while every
 * fix action checks the role and takes the batch lock before it writes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';

const src = (f: string) => stripComments(readFileSync(f, 'utf8'));
const imports = src('services/imports.ts');
const fixes = src('services/import-fixes.ts');

/** The body of one top-level function, up to the next top-level declaration. */
function body(code: string, name: string): string {
  const at = code.search(new RegExp(`\\bfunction ${name}\\s*[(<]`));
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const rest = code.slice(at + 1);
  const next = rest.search(/\n(export )?(async )?function |\n(export )?const |\n(export )?type /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('one row check for the upload and the fix', () => {
  it('the upload checks each row through lib/import-row-check, and no longer holds its own copy of the rules', () => {
    const upload = body(imports, 'uploadCustomerMasterCore');
    expect(upload).toContain('checkCustomerRow(');
    expect(upload).toContain('fileCollisions(');
    expect(upload).toContain('masterCollisionMaps(');
    expect(imports).not.toMatch(/field:\s*'cust_code',\s*message:\s*'required'/);
    expect(imports).not.toMatch(/expected SAT\/SUN\/MON/);
  });

  it('the fix re-runs the same check, against the same master lookup', () => {
    const recheck = body(fixes, 'recheck');
    expect(recheck).toContain('checkCustomerRow(');
    expect(recheck).toContain('masterCollisionMaps(');
    expect(recheck).toContain('correctedRow(');
  });
});

describe('every fix action', () => {
  const cores = ['recheckCore', 'correctCore', 'releaseCore', 'excludeCore', 'includeCore'];

  it.each(cores)('%s checks the role before anything else, and writes inside the batch lock', (name) => {
    const b = body(fixes, name);
    const role = b.indexOf('requireSteward(');
    expect(role).toBeGreaterThan(-1);
    expect(role).toBeLessThan(b.indexOf('withBatch('));
    expect(b).not.toMatch(/prisma\.importRow\.(update|updateMany)\(/);
    // Every action leaves an audit row (writeAudit, directly or through audit()).
    expect(b).toMatch(/\bwriteAudit\(|\baudit\(/);
  });

  it('the batch lock is a row lock that refuses a live promote', () => {
    const w = body(fixes, 'withBatch');
    expect(w).toMatch(/FOR UPDATE/);
    expect(w).toContain("'BATCH_PROMOTING'");
  });

  it('only the Data Steward', () => {
    const r = body(fixes, 'requireSteward');
    expect(r).toContain('Role.STEWARD');
  });
});
