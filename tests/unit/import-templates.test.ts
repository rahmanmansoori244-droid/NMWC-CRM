import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseWorkbook } from '@/lib/excel';

/**
 * Guards the go-live import templates (docs/import-templates/*.xlsx) against the
 * importer's ACTUAL recognized headers, using the real parseWorkbook the app
 * uses. If a template drifts from what the importer reads — or the customer data
 * stops being the first sheet — this fails. Regenerate with
 * `npx tsx scripts/build-import-templates.ts`.
 */
const DIR = path.join('docs', 'import-templates');
const ACCT = path.join(DIR, 'account-master-template.xlsx');
const CUST = path.join(DIR, 'customer-master-template.xlsx');

describe('go-live import templates match the importer contract', () => {
  it('account master has Regions/Routes/Users with the exact columns the parser reads', async () => {
    if (!existsSync(ACCT)) throw new Error('run: npx tsx scripts/build-import-templates.ts');
    const sheets = await parseWorkbook(readFileSync(ACCT));
    const byName = Object.fromEntries(sheets.map((s) => [s.name, s]));
    // parser looks these up case-insensitively by name (services/imports.ts).
    expect(byName['Regions'].headers).toEqual(['code', 'name']);
    expect(byName['Routes'].headers).toEqual(['code', 'name', 'region_code']);
    expect(byName['Users'].headers).toEqual([
      'username',
      'full_name',
      'role',
      'password',
      'supervisor_username',
      'route_code',
      'region_codes',
      'email',
      'phone',
      'reset_password',
      'change_role',
      'must_change_password',
    ]);
    // example Users row is well-formed (a supervisor + a salesman + an accountant).
    const roles = byName['Users'].rows.map((r) => String(r.role));
    expect(roles).toContain('SUPERVISOR');
    expect(roles).toContain('SALESMAN');
    expect(roles).toContain('ACCOUNTANT');
    // MANAGER/STEWARD must NOT be in the template (import rejects them).
    expect(roles).not.toContain('MANAGER');
    expect(roles).not.toContain('STEWARD');
  });

  it('customer master data is the FIRST sheet with the parser-read columns', async () => {
    if (!existsSync(CUST)) throw new Error('run: npx tsx scripts/build-import-templates.ts');
    const sheets = await parseWorkbook(readFileSync(CUST));
    // CRITICAL: the customer importer reads sheets[0]. Instructions must come after.
    expect(sheets[0].name).toBe('Customers');
    expect(sheets[0].headers).toEqual([
      'cust_code',
      'cust_name',
      'branch_code',
      'branch_name',
      'sales_region',
      'route',
      'address',
      'phone',
      'contact_person',
      'cr_no',
      'payment_terms',
      'credit_limit',
      'payment_term_days',
      'temix_code',
      'channel',
      'day_of_visit',
      'customer_status',
    ]);
    // The multi-branch example shares one cust_code across two rows (the shape the
    // in-file dedup fix, F-UAT-7, must accept).
    const codes = sheets[0].rows.map((r) => String(r.cust_code));
    expect(codes.filter((c) => c === 'C-10001').length).toBe(2);
    // payment_terms only ever CASH/CREDIT in the examples.
    for (const r of sheets[0].rows) expect(['CASH', 'CREDIT']).toContain(String(r.payment_terms));
  });
});
