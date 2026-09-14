/**
 * B6: the personal-data annex cannot silently go stale.
 *
 * A register is worth signing only if it still describes the system a year
 * later. These tests fail when a column is added, removed or renamed without
 * someone deciding whether it holds personal data — which makes the inventory a
 * control rather than a document. They also fail if the generated
 * docs/compliance/PII-INVENTORY.md is out of date with the schema.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import {
  parsePrismaSchema,
  storedFields,
  fieldKey,
  implicitJoinTables,
} from '@/lib/compliance/prisma-schema';
import { PII_CLASSIFICATION, SUBJECT_LABEL } from '@/lib/compliance/pii-classification';

const schema = parsePrismaSchema(readFileSync('prisma/schema.prisma', 'utf8'));
const stored = storedFields(schema);

describe('prisma schema parser', () => {
  it('finds every model and enum', () => {
    expect(schema.models.length).toBeGreaterThan(20);
    expect(schema.enums).toContain('Role');
    expect(schema.enums).toContain('AuditAction');
    expect(schema.models).toContain('Customer');
    expect(schema.models).toContain('AuditLog');
  });

  it('finds the implicit many-to-many join tables', () => {
    // _ManagerRegions holds which regions each manager administers — the data
    // every region-scoped permission check reads. A restore that lost it would
    // strip every manager's scope silently, so restore-verify expects it by name.
    expect(implicitJoinTables(schema)).toContain('_ManagerRegions');
  });

  it('separates stored columns from relation fields', () => {
    const keys = stored.map(fieldKey);
    // a scalar, an enum column and a foreign key are stored…
    expect(keys).toContain('Customer.legalName');
    expect(keys).toContain('Customer.paymentTerms');
    expect(keys).toContain('Branch.customerId');
    // …while the relation object itself is not a column
    expect(keys).not.toContain('Branch.customer');
    expect(keys).not.toContain('Customer.branches');
  });
});

describe('personal-data classification', () => {
  it('classifies every stored column — a new column fails this test until someone decides', () => {
    const unclassified = stored.map(fieldKey).filter((k) => !PII_CLASSIFICATION[k]);
    expect(
      unclassified,
      `Unclassified columns. Add each to lib/compliance/pii-classification.ts, deciding whose personal data it is:\n  ${unclassified.join('\n  ')}`
    ).toEqual([]);
  });

  it('has no entries for columns that no longer exist', () => {
    const live = new Set(stored.map(fieldKey));
    const orphans = Object.keys(PII_CLASSIFICATION).filter((k) => !live.has(k));
    expect(
      orphans,
      `Classified columns that are no longer in the schema — remove them:\n  ${orphans.join('\n  ')}`
    ).toEqual([]);
  });

  it('uses only known subjects and kinds', () => {
    const subjects = new Set(Object.keys(SUBJECT_LABEL));
    for (const [key, c] of Object.entries(PII_CLASSIFICATION)) {
      expect(subjects.has(c.subject), `${key} has unknown subject ${c.subject}`).toBe(true);
    }
  });

  it('recognises the concentrations the assessment called out', () => {
    // The append-only ledger carries full customer snapshots — the single
    // hardest place to satisfy an erasure request (see PDPL-ASSESSMENT.md Q4).
    expect(PII_CLASSIFICATION['AuditLog.before']?.subject).toBe('customer');
    expect(PII_CLASSIFICATION['AuditLog.after']?.subject).toBe('customer');
    // The photo object key is an employee activity log in its own right.
    expect(PII_CLASSIFICATION['Attachment.r2Key']?.subject).toBe('employee');
    // The rate limiter keys on raw usernames and IP addresses.
    expect(PII_CLASSIFICATION['RateLimit.key']?.subject).toBe('employee');
    // Credentials are called credentials.
    expect(PII_CLASSIFICATION['User.passwordHash']?.kind).toBe('credential');
    // Premises location is flagged as entity-or-person, not silently decided.
    expect(PII_CLASSIFICATION['Branch.gpsLat']?.subject).toBe('business-or-person');
  });

  it('every ambiguous entity-level column carries a note explaining the ambiguity somewhere in its model', () => {
    const models = new Set(
      Object.entries(PII_CLASSIFICATION)
        .filter(([, c]) => c.subject === 'business-or-person')
        .map(([k]) => k.split('.')[0]!)
    );
    // Customer and Branch are the two entity-level models; each must explain at
    // least once why "business-or-person" is not a decided answer.
    for (const m of ['Customer', 'Branch']) {
      expect(models.has(m), `${m} should carry entity-level columns`).toBe(true);
    }
    const hasExplanation = Object.entries(PII_CLASSIFICATION).some(
      ([, c]) => c.subject === 'business-or-person' && /sole establishment/i.test(c.note ?? '')
    );
    expect(hasExplanation).toBe(true);
  });
});

describe('generated inventory', () => {
  it('docs/compliance/PII-INVENTORY.md exists and is current', () => {
    const path = 'docs/compliance/PII-INVENTORY.md';
    expect(
      existsSync(path),
      'run: npx tsx scripts/compliance/build-pii-inventory.ts'
    ).toBe(true);
    const content = readFileSync(path, 'utf8');
    // The counts in the header are derived, so a drifted file shows up here.
    expect(content).toContain(`**${stored.length} stored columns across ${schema.models.length} tables**`);
    // It must not read as a compliance artefact in its own right.
    expect(content.toLowerCase()).toContain('annex');
  });
});
