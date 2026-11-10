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

/**
 * The shapes Prisma 7.10.1 with the Postgres driver adapter gave on Postgres 17
 * (2026-11-10), values synthetic. The adapter's error is an Error with a `cause`;
 * for a database error Prisma has no code for, the cause also carries Postgres's
 * DETAIL, which quotes the whole failing row.
 */
const adapterError = (cause: Record<string, unknown>) => Object.assign(new Error('DriverAdapterError'), { name: 'DriverAdapterError', cause });
const ROW_DETAIL = 'Failing row contains (cmzzq0000, NMWC-ZQX-1, ZQX Trading LLC, CASH, +96891234567, 100.000).';
/** A CHECK refused on a model write: P2039, where Prisma 6 gave an error with no code. */
const v7ModelCheck = (table: string, name: string) => {
  const words = `new row for relation "${table}" violates check constraint "${name}"`;
  return err(`\nInvalid \`prisma.${table.toLowerCase()}.update()\` invocation:\n\n\nDatabase error. Code: \`23514\`. Message: \`${words}\``, {
    code: 'P2039',
    meta: {
      modelName: table,
      driverAdapterError: adapterError({ originalCode: '23514', originalMessage: words, kind: 'postgres', code: '23514', severity: 'ERROR', message: words, detail: ROW_DETAIL }),
    },
  });
};
/** The same CHECK from a raw query: P2010, the SQLSTATE in the adapter's cause. */
const v7RawCheck = (table: string, name: string) => {
  const words = `new row for relation "${table}" violates check constraint "${name}"`;
  return err(`\nInvalid \`prisma.$executeRaw()\` invocation:\n\n\nRaw query failed. Code: \`23514\`. Message: \`${words}\``, {
    code: 'P2010',
    meta: { driverAdapterError: adapterError({ originalCode: '23514', originalMessage: words, kind: 'postgres', code: '23514', severity: 'ERROR', message: words, detail: ROW_DETAIL }) },
  });
};
/** A foreign key: P2003 from a model write, P2010 from a raw one; the name in the message and in cause.constraint.index. */
const v7ForeignKey = (table: string, name: string, raw = false) => {
  const words = `insert or update on table "${table}" violates foreign key constraint "${name}"`;
  const cause = adapterError({ originalCode: '23503', originalMessage: words, kind: 'ForeignKeyConstraintViolation', constraint: { index: name } });
  return raw
    ? err(`\nInvalid \`prisma.$executeRaw()\` invocation:\n\n\nRaw query failed. Code: \`23503\`. Message: \`${words}\``, { code: 'P2010', meta: { driverAdapterError: cause } })
    : err(`\nInvalid \`prisma.${table.toLowerCase()}.create()\` invocation:\n\n\nForeign key constraint violated on the constraint: \`${name}\``, {
        code: 'P2003',
        meta: { modelName: table, driverAdapterError: cause },
      });
};

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

  it('Prisma 7: a CHECK on a model write is P2039, on a raw one P2010; a foreign key P2003 or P2010', () => {
    expect(dbRuleViolated(v7ModelCheck('Customer', 'Customer_credit_terms_only_credit'))).toBe(rule('Customer_credit_terms_only_credit'));
    expect(dbRuleViolated(v7RawCheck('Branch', 'Branch_gps_pair'))).toBe(rule('Branch_gps_pair'));
    expect(dbRuleViolated(v7ForeignKey('Customer', 'Customer_createdById_fkey'))).toBe(rule('Customer_createdById_fkey'));
    expect(dbRuleViolated(v7ForeignKey('Customer', 'Customer_createdById_fkey', true))).toBe(rule('Customer_createdById_fkey'));
    // A delete the RESTRICT link refuses names the link the same way.
    const restrict = 'update or delete on table "Customer" violates foreign key constraint "CustomerEdit_customerId_fkey" on table "CustomerEdit"';
    expect(
      dbRuleViolated(
        err('Foreign key constraint violated on the constraint: `CustomerEdit_customerId_fkey`', {
          code: 'P2003',
          meta: { modelName: 'Customer', driverAdapterError: adapterError({ originalCode: '23503', originalMessage: restrict, kind: 'ForeignKeyConstraintViolation', constraint: { index: 'CustomerEdit_customerId_fkey' } }) },
        })
      )
    ).toBe(rule('CustomerEdit_customerId_fkey'));
  });

  it('Prisma 7: every rule is found in the shape its kind arrives in, model and raw', () => {
    for (const r of DB_RULES) {
      const [model, raw] = r.kind === 'fk' ? [v7ForeignKey(r.table, r.name), v7ForeignKey(r.table, r.name, true)] : [v7ModelCheck(r.table, r.name), v7RawCheck(r.table, r.name)];
      expect(dbRuleViolated(model), `${r.name} (model)`).toBe(r);
      expect(dbRuleViolated(raw), `${r.name} (raw)`).toBe(r);
    }
  });

  it('Prisma 7: P2039 for anything that is not one of the rules stays unread', () => {
    // A CHECK that is not in lib/db-rules.ts, a statement timeout, the append-only trigger.
    expect(dbRuleViolated(v7ModelCheck('Branch', 'Branch_address_minlength'))).toBeNull();
    const timeout = 'canceling statement due to statement timeout';
    expect(
      dbRuleViolated(err(`Database error. Code: \`57014\`. Message: \`${timeout}\``, { code: 'P2039', meta: { modelName: 'Branch', driverAdapterError: adapterError({ originalCode: '57014', originalMessage: timeout, kind: 'postgres', code: '57014', message: timeout }) } }))
    ).toBeNull();
    // A rule's name with no constraint violation around it (a P2039 of another kind).
    expect(dbRuleViolated(err('Database error. Code: `42501`. Message: `Branch_gps_pair`', { code: 'P2039', meta: { modelName: 'Branch' } }))).toBeNull();
  });

  // Outside production Prisma quotes the lines of code around the failing call
  // in its message, before the error's own words. Found on Postgres by the gated
  // suite (2026-11-10): a rule's name on one of those lines was taken for the
  // rule that refused the save.
  it('the constraint the database named decides, not a rule named in the quoted lines of code', () => {
    const frame =
      '\nInvalid `tx.branch.update()` invocation in\nC:\\app\\services\\x.ts:230:60\n\n' +
      "  227 await refused(tx, 'Customer_createdById_fkey', c('1', { createdById: ghost }));\n" +
      '  228 // new row for relation "Customer" violates check constraint "Customer_credit_terms_only_credit"\n' +
      '  229 // Foreign key constraint violated on the constraint: `Customer_lastEditedById_fkey`\n' +
      '→ 230 tx.branch.update(\n';
    // Prisma 7: a foreign key (the adapter names it) and a CHECK (Postgres's words in the cause).
    const fk7 = v7ForeignKey('Branch', 'Branch_createdById_fkey');
    fk7.message = `${frame}Foreign key constraint violated on the constraint: \`Branch_createdById_fkey\``;
    expect(dbRuleViolated(fk7)).toBe(rule('Branch_createdById_fkey'));
    const check7 = v7ModelCheck('Branch', 'Branch_gps_pair');
    check7.message = `${frame}Database error. Code: \`23514\`. Message: \`new row for relation "Branch" violates check constraint "Branch_gps_pair"\``;
    expect(dbRuleViolated(check7)).toBe(rule('Branch_gps_pair'));
    // Prisma 6: meta.field_name for a foreign key; for a CHECK only the message, read from its end.
    expect(
      dbRuleViolated(err(`${frame}Foreign key constraint violated: \`Branch_createdById_fkey (index)\``, { code: 'P2003', meta: { modelName: 'Branch', field_name: 'Branch_createdById_fkey (index)' } }))
    ).toBe(rule('Branch_createdById_fkey'));
    expect(dbRuleViolated(err(`${frame}Foreign key constraint violated: \`Branch_lastEditedById_fkey (index)\``, { code: 'P2003' }))).toBe(rule('Branch_lastEditedById_fkey'));
    expect(dbRuleViolated(err(`${frame}new row for relation "Branch" violates check constraint "Branch_gps_pair"`))).toBe(rule('Branch_gps_pair'));
    // A constraint that is not one of the rules stays unread, whatever the quoted lines mention.
    const notARule = v7ModelCheck('Branch', 'Branch_address_minlength');
    notARule.message = `${frame}Database error. Code: \`23514\`. Message: \`new row for relation "Branch" violates check constraint "Branch_address_minlength"\``;
    expect(dbRuleViolated(notARule)).toBeNull();
    expect(dbRuleViolated(err(`${frame}new row for relation "Branch" violates check constraint "Branch_address_minlength"`))).toBeNull();
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

  it('Prisma 7: the same answer for a model write (P2039) and a raw one (P2010), and nothing of the failing row', async () => {
    for (const e of [v7ModelCheck('Customer', 'Customer_credit_terms_only_credit'), v7RawCheck('Customer', 'Customer_credit_terms_only_credit')]) {
      const res = await runAction(async () => {
        throw e;
      });
      expect(res).toEqual({ ok: false, code: 'DATA_RULE', message: rule('Customer_credit_terms_only_credit').refusal });
      expect(JSON.stringify(res)).not.toMatch(/ZQX|9123|Failing row/);
    }
    const fk = await runAction(async () => {
      throw v7ForeignKey('Attachment', 'Attachment_branchId_fkey');
    });
    expect(fk).toEqual({ ok: false, code: 'DATA_RULE', message: rule('Attachment_branchId_fkey').refusal });
    // A P2039 that is not one of the rules is still thrown, for Sentry and the 500 page.
    const other = v7ModelCheck('Branch', 'Branch_address_minlength');
    await expect(
      runAction(async () => {
        throw other;
      })
    ).rejects.toBe(other);
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
