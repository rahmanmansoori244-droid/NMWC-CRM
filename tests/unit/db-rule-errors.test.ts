// @vitest-environment node
/**
 * Gap 31: a save the database refuses under one of its rules (lib/db-rules.ts)
 * is answered with that rule's own words, not a 500. dbRuleViolated finds the
 * rule by its constraint name wherever the driver put it; runAction returns
 * { ok: false, code: 'DATA_RULE', message: rule.refusal }; anything else is
 * answered as before.
 */
import { describe, expect, it } from 'vitest';
import { dbRuleViolated } from '@/lib/db-errors';
import { runAction } from '@/lib/errors';
import { DB_RULES, DB_RULE_BY_NAME } from '@/lib/db-rules';

const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);
const rule = (name: string) => DB_RULE_BY_NAME.get(name)!;

describe('dbRuleViolated', () => {
  it('a foreign key: P2003, the name in meta.field_name', () => {
    const e = err('Foreign key constraint violated on the constraint: `Customer_createdById_fkey`', {
      code: 'P2003',
      meta: { field_name: 'Customer_createdById_fkey (index)' },
    });
    expect(dbRuleViolated(e)).toBe(rule('Customer_createdById_fkey'));
    // The name in the metadata alone is enough.
    expect(dbRuleViolated({ code: 'P2003', message: 'x', meta: { field_name: 'Attachment_branchId_fkey (index)' } })).toBe(
      rule('Attachment_branchId_fkey')
    );
  });

  it('a CHECK: P2004, P2010 from a raw query, and an engine error Prisma did not map', () => {
    expect(
      dbRuleViolated(
        err('A constraint failed on the database', {
          code: 'P2004',
          meta: { database_error: 'new row for relation "Customer" violates check constraint "Customer_credit_terms_only_credit"' },
        })
      )
    ).toBe(rule('Customer_credit_terms_only_credit'));
    expect(
      dbRuleViolated(
        err('Raw query failed. Code: `23514`.', {
          code: 'P2010',
          meta: { code: '23514', message: 'new row for relation "Branch" violates check constraint "Branch_gps_pair"' },
        })
      )
    ).toBe(rule('Branch_gps_pair'));
    expect(
      dbRuleViolated(err('Invalid `prisma.branch.update()` invocation: new row for relation "Branch" violates check constraint "Branch_gps_in_oman"'))
    ).toBe(rule('Branch_gps_in_oman'));
  });

  it('a name inside another name never matches: the draft twin is its own rule', () => {
    expect(dbRuleViolated(err('violates check constraint "EditBranchDraft_gps_in_oman"'))).toBe(rule('EditBranchDraft_gps_in_oman'));
    expect(dbRuleViolated(err('violates check constraint "EditCustomerDraft_subChannel_needs_channel"'))).toBe(
      rule('EditCustomerDraft_subChannel_needs_channel')
    );
  });

  it('every rule is found by its name', () => {
    for (const r of DB_RULES) {
      const e =
        r.kind === 'fk'
          ? err('Foreign key constraint violated', { code: 'P2003', meta: { field_name: `${r.name} (index)` } })
          : err(`new row for relation "${r.table}" violates check constraint "${r.name}"`);
      expect(dbRuleViolated(e), r.name).toBe(r);
    }
  });

  it('anything else is not a rule: another constraint, a unique key, a bare mention, a transient fault', () => {
    expect(dbRuleViolated(err('new row for relation "Branch" violates check constraint "Branch_address_minlength"'))).toBeNull();
    expect(dbRuleViolated(err('Unique constraint failed: Customer_credit_terms_only_credit', { code: 'P2002' }))).toBeNull();
    expect(dbRuleViolated(err('Customer_credit_terms_only_credit'))).toBeNull();
    expect(dbRuleViolated(err('Timed out fetching a new connection', { code: 'P2024' }))).toBeNull();
    expect(dbRuleViolated(null)).toBeNull();
    expect(dbRuleViolated('violates check constraint "Branch_gps_pair"')).toBeNull();
  });
});

describe('runAction answers a refused rule with its words', () => {
  it('DATA_RULE and the rule’s refusal, no value', async () => {
    const e = err('new row for relation "Customer" violates check constraint "Customer_credit_terms_only_credit"');
    const res = await runAction(async () => {
      throw e;
    });
    expect(res).toEqual({ ok: false, code: 'DATA_RULE', message: rule('Customer_credit_terms_only_credit').refusal });
    expect(rule('Customer_credit_terms_only_credit').refusal).toBe(
      "This customer's stored record breaks a data rule (credit figures on a cash customer). Ask the Data Steward to correct it."
    );
  });

  it('another database error is thrown as before', async () => {
    const e = err('new row for relation "Branch" violates check constraint "Branch_address_minlength"');
    await expect(
      runAction(async () => {
        throw e;
      })
    ).rejects.toBe(e);
  });

  it('every refusal is a plain sentence that names no value', () => {
    for (const r of DB_RULES) {
      expect(r.refusal, r.name).toMatch(/^[A-Z].*\.$/);
      expect(r.refusal).not.toMatch(/\$\{|undefined|null/);
      expect(r.why.length, r.name).toBeGreaterThan(40);
    }
  });
});
