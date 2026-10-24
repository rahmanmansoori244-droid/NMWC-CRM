// @vitest-environment node
/**
 * Gap 31: the database never refuses what the application accepts. Each CHECK
 * in lib/db-rules.ts holds only what the writers already guarantee, so:
 *
 *  - the zod bounds of the edit and create schemas (GPS, accuracy, equipment)
 *    are the CHECK bounds: accepted at the bound, refused just beyond it;
 *  - every output of normalizePhone passes the phone-key rule, and every output
 *    of normalizeCR the CR-key rule, over a seeded corpus of hostile input;
 *  - every code point of the CR rule's forbidden class is one normalizeCR
 *    removes or folds;
 *  - the writers of the credit figures write none for a cash customer
 *    (structural: comments stripped, per CLAUDE.md).
 *
 * The JS predicates (rule.holds) are the CHECKs with SQL's NULL semantics; the
 * gated tests/integration/db-rules.test.ts proves the SQL itself on Postgres.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { branchPatchSchema } from '@/lib/validation/edit';
import { createBranchDraftSchema } from '@/lib/validation/create';
import { normalizePhone } from '@/lib/phone';
import { normalizeCR } from '@/lib/cr';
import { MAP } from '@/lib/insights/policy';
import {
  CR_NORM_FORBIDDEN_CLASS,
  DB_RULES,
  DB_RULE_BY_NAME,
  EQUIPMENT_CAPS,
  GPS_ACCURACY_MAX,
  OMAN_GPS,
  PHONE_NORM_PATTERN,
  dbRuleViolationsSql,
  dbRulesCountSql,
  type DbCheckRule,
} from '@/lib/db-rules';
import { seededStrings } from '../support/seeded-strings';
import { stripComments } from '../support/strip-comments';

const check = (name: string) => {
  const r = DB_RULE_BY_NAME.get(name);
  if (!r || r.kind !== 'check') throw new Error(`no check ${name}`);
  return r as DbCheckRule;
};
const editShape = branchPatchSchema.innerType().shape;
const createShape = createBranchDraftSchema.shape;
const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => s.safeParse(v).success;
const EPS = 1e-6;

describe('the zod bounds are the CHECK bounds', () => {
  it('GPS: 16–27°N, 51–61°E, in both schemas, the rule and the insights map box', () => {
    expect(OMAN_GPS).toEqual({ latMin: 16, latMax: 27, lngMin: 51, lngMax: 61 });
    expect(MAP.bounds).toEqual(OMAN_GPS);
    for (const shape of [editShape, createShape]) {
      for (const [field, lo, hi] of [
        ['gpsLat', OMAN_GPS.latMin, OMAN_GPS.latMax],
        ['gpsLng', OMAN_GPS.lngMin, OMAN_GPS.lngMax],
      ] as const) {
        const s = shape[field];
        expect(ok(s, lo), `${field} ${lo}`).toBe(true);
        expect(ok(s, hi), `${field} ${hi}`).toBe(true);
        expect(ok(s, lo - EPS), `${field} below`).toBe(false);
        expect(ok(s, hi + EPS), `${field} above`).toBe(false);
      }
    }
    const gps = check('Branch_gps_in_oman');
    expect(gps.holds({ gpsLat: 16, gpsLng: 61 })).toBe(true);
    expect(gps.holds({ gpsLat: 27, gpsLng: 51 })).toBe(true);
    expect(gps.holds({ gpsLat: 16 - EPS, gpsLng: 58 })).toBe(false);
    expect(gps.holds({ gpsLat: 23, gpsLng: 61 + EPS })).toBe(false);
    expect(gps.holds({ gpsLat: null, gpsLng: null })).toBe(true);
    // One coordinate alone passes the bounds rule; the pair rule refuses it on a shop.
    expect(gps.holds({ gpsLat: 23, gpsLng: null })).toBe(true);
    expect(check('Branch_gps_pair').holds({ gpsLat: 23, gpsLng: null })).toBe(false);
    expect(check('Branch_gps_pair').holds({ gpsLat: null, gpsLng: null })).toBe(true);
    expect(check('Branch_gps_pair').holds({ gpsLat: 23, gpsLng: 58 })).toBe(true);
    expect(gps.sql).toBe(check('EditBranchDraft_gps_in_oman').sql);
    // NaN is refused by both (Postgres orders NaN above every number).
    expect(gps.holds({ gpsLat: Number.NaN, gpsLng: 58 })).toBe(false);
    expect(ok(editShape.gpsLat, Number.NaN)).toBe(false);
  });

  it('GPS accuracy: 0–10,000 m in both schemas', () => {
    expect(GPS_ACCURACY_MAX).toBe(10000);
    for (const shape of [editShape, createShape]) {
      expect(ok(shape.gpsAccuracy, 0)).toBe(true);
      expect(ok(shape.gpsAccuracy, GPS_ACCURACY_MAX)).toBe(true);
      expect(ok(shape.gpsAccuracy, -EPS)).toBe(false);
      expect(ok(shape.gpsAccuracy, GPS_ACCURACY_MAX + EPS)).toBe(false);
    }
    for (const name of ['Branch_gpsAccuracy_range', 'EditBranchDraft_gpsAccuracy_range']) {
      const r = check(name);
      expect(r.holds({ gpsAccuracy: 0 })).toBe(true);
      expect(r.holds({ gpsAccuracy: GPS_ACCURACY_MAX })).toBe(true);
      expect(r.holds({ gpsAccuracy: null })).toBe(true);
      expect(r.holds({ gpsAccuracy: GPS_ACCURACY_MAX + EPS })).toBe(false);
      expect(r.holds({ gpsAccuracy: -EPS })).toBe(false);
    }
  });

  it('equipment: coolers and stands 0–100, empty bottles 0–1,000, in both schemas', () => {
    expect(EQUIPMENT_CAPS).toEqual({ coolersCount: 100, standsCount: 100, emptyBottlesCount: 1000 });
    for (const shape of [editShape, createShape]) {
      for (const [field, cap] of Object.entries(EQUIPMENT_CAPS) as Array<[keyof typeof EQUIPMENT_CAPS, number]>) {
        expect(ok(shape[field], 0), field).toBe(true);
        expect(ok(shape[field], cap), field).toBe(true);
        expect(ok(shape[field], cap + 1), field).toBe(false);
        expect(ok(shape[field], -1), field).toBe(false);
      }
    }
    for (const name of ['Branch_equipment_counts_range', 'EditBranchDraft_equipment_counts_range']) {
      const r = check(name);
      expect(r.holds({ coolersCount: 100, standsCount: 100, emptyBottlesCount: 1000 })).toBe(true);
      expect(r.holds({ coolersCount: 0, standsCount: 0, emptyBottlesCount: 0 })).toBe(true);
      expect(r.holds({ coolersCount: 101, standsCount: 0, emptyBottlesCount: 0 })).toBe(false);
      expect(r.holds({ coolersCount: 0, standsCount: 0, emptyBottlesCount: 1001 })).toBe(false);
      expect(r.holds({ coolersCount: -1, standsCount: 0, emptyBottlesCount: 0 })).toBe(false);
    }
  });
});

describe('the normalisers’ outputs pass the key rules', () => {
  const PHONE_PIECES = ['9', '7', '1', '0', '5', '+', '00', '968', '+968', ' ', '-', '(', ')', '\u0669', '\u0661', '\u06F9', '\u06F0', 'x', '\u00A0', '\u200F', '.'];
  const CR_PIECES = [
    '1', '2', '0', '9', 'a', 'z', 'A', 'Z', 'cr', 'CR', '-', '/', '.', '_', ' ', '\t', '\n', '\u00A0', '\u2007', '\u3000',
    '\u200B', '\u200D', '\u200E', '\u202B', '\u2066', '\u2069', '\uFEFF', '\u00AD', '\u061C', '\u180E', '\u1680', '\u2028',
    '\u205F', '\u2060', '\u2064', '\u0660', '\u0669', '\u06F0', '\u06F9', '\u00DF', '\u00E9', 'ı', 'ſ', 'ﬁ', 'ǅ', 'ω', '\u0639', '#', '<b>',
  ];

  it('normalizePhone: null or +968 and eight ASCII digits, which the rule accepts', () => {
    const phone = check('Customer_primaryPhoneNorm_shape');
    expect(phone.sql).toBe(check('EditCustomerDraft_primaryPhoneNorm_shape').sql);
    const shape = new RegExp(PHONE_NORM_PATTERN);
    let seen = 0;
    for (const s of seededStrings(31_0001, 20_000, PHONE_PIECES, 14)) {
      const out = normalizePhone(s);
      expect(phone.holds({ primaryPhoneNorm: out }), JSON.stringify([s, out])).toBe(true);
      if (out !== null) {
        seen += 1;
        expect(shape.test(out)).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(100);
    // What the rule refuses: the shapes a hand-written row might hold.
    for (const bad of ['', '91234567', '968912345678', '+968 91234567', '+9689123456', '+968\u0669\u0661\u0662\u0663\u0664\u0665\u0666\u0667']) {
      expect(phone.holds({ primaryPhoneNorm: bad }), bad).toBe(false);
    }
  });

  it('normalizeCR: never empty and never a character it removes or folds', () => {
    const cr = check('Customer_crNumberNorm_shape');
    expect(cr.sql).toBe(check('EditCustomerDraft_crNumberNorm_shape').sql);
    let seen = 0;
    for (const s of seededStrings(31_0002, 20_000, CR_PIECES, 10)) {
      const out = normalizeCR(s);
      expect(cr.holds({ crNumberNorm: out }), JSON.stringify([s, out])).toBe(true);
      if (out !== null) seen += 1;
    }
    expect(seen).toBeGreaterThan(100);
    // A row normalised before item 16, or by hand: refused until recompute-cr-norm.
    for (const bad of ['', 'cr-123', '12 34', '\u0661\u0662\u0663', '123\u200B', '\uFEFF123']) {
      expect(cr.holds({ crNumberNorm: bad }), JSON.stringify(bad)).toBe(false);
    }
    expect(cr.holds({ crNumberNorm: 'CR-1234567/2024' })).toBe(true);
  });

  /** Every code point of the class, from its \uXXXX ranges. */
  function classCodePoints(cls: string): number[] {
    const out: number[] = [];
    const re = /\\u([0-9A-F]{4})(?:-\\u([0-9A-F]{4}))?/g;
    let consumed = 0;
    for (const m of cls.matchAll(re)) {
      consumed += m[0].length;
      const lo = parseInt(m[1]!, 16);
      const hi = m[2] ? parseInt(m[2], 16) : lo;
      for (let c = lo; c <= hi; c++) out.push(c);
    }
    // The class is ONLY escapes, so JavaScript and Postgres read the same thing.
    expect(consumed).toBe(cls.length);
    return out;
  }

  it('every code point of the forbidden class is removed or folded by normalizeCR', () => {
    const points = classCodePoints(CR_NORM_FORBIDDEN_CLASS);
    expect(points.length).toBeGreaterThan(80);
    for (const c of points) {
      const ch = String.fromCharCode(c);
      const out = normalizeCR(`A${ch}B`);
      expect(out, `U+${c.toString(16)}`).not.toBeNull();
      expect(out!.includes(ch), `U+${c.toString(16).padStart(4, '0')} survives normalizeCR`).toBe(false);
    }
  });
});

describe('the credit figures are never written on a cash customer', () => {
  const src = (f: string) => stripComments(readFileSync(f, 'utf8'), f);

  it('the import’s create lane and finalize write null credit for CASH', () => {
    const imports = src('services/imports.ts');
    expect(imports).toContain("creditLimit: pt === 'CREDIT' ? (lead.creditLimit ?? null) : null,");
    expect(imports).toContain("paymentTermDays: pt === 'CREDIT' ? (lead.paymentTermDays ?? null) : null,");
    const finalize = src('lib/create-finalize.ts');
    expect(finalize).toContain('creditLimit: isCredit ? edit.requestedCreditLimit : null,');
    expect(finalize).toContain('paymentTermDays: isCredit ? edit.requestedPaymentTermDays : null,');
  });

  it('the import’s refresh lane clears both on an explicit CASH, and an edit never changes the terms', () => {
    const imports = src('services/imports.ts');
    expect(imports).toMatch(/creditLimit:\s*effectiveTerms === 'CREDIT'\s*\?\s*\(lead\.creditLimit \?\? undefined\)\s*:\s*ptPresent\s*\?\s*null\s*:\s*undefined/);
    expect(imports).toMatch(/paymentTermDays:\s*effectiveTerms === 'CREDIT'\s*\?\s*\(lead\.paymentTermDays \?\? undefined\)\s*:\s*ptPresent\s*\?\s*null\s*:\s*undefined/);
    expect(src('services/edits.ts')).toMatch(/fieldChanges\.some\(\(c\) => c\.field === 'customer\.paymentTerms'\)\)\s*\{\s*throw new ValidationError/);
    const credit = check('Customer_credit_terms_only_credit');
    expect(credit.holds({ paymentTerms: 'CASH', creditLimit: null, paymentTermDays: null })).toBe(true);
    expect(credit.holds({ paymentTerms: 'CASH', creditLimit: 0, paymentTermDays: null })).toBe(false);
    expect(credit.holds({ paymentTerms: 'CASH', creditLimit: null, paymentTermDays: 30 })).toBe(false);
    expect(credit.holds({ paymentTerms: 'CREDIT', creditLimit: null, paymentTermDays: null })).toBe(true);
  });
});

describe('the violation SQL', () => {
  it('a check counts the rows whose expression is FALSE (NULL passes, as in a CHECK)', () => {
    expect(dbRuleViolationsSql(check('Branch_gps_pair'))).toBe(
      'SELECT t."id" FROM "Branch" t WHERE NOT COALESCE((("gpsLat" IS NULL) = ("gpsLng" IS NULL)), TRUE)'
    );
  });

  it('a foreign key counts the rows with every key column set and no row it names (MATCH SIMPLE)', () => {
    const pair = DB_RULE_BY_NAME.get('Customer_subChannelId_channelId_fkey')!;
    expect(dbRuleViolationsSql(pair)).toBe(
      'SELECT t."id" FROM "Customer" t WHERE t."subChannelId" IS NOT NULL AND t."channelId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SubChannel" r WHERE r."id" = t."subChannelId" AND r."channelId" = t."channelId")'
    );
  });

  it('one statement over every rule, unqualified tables (so TEMP shadows can stand in), reads only', () => {
    const sql = dbRulesCountSql();
    expect(sql.split('\nUNION ALL\n')).toHaveLength(DB_RULES.length);
    for (const r of DB_RULES) expect(sql).toContain(`SELECT '${r.name}'::text AS rule`);
    expect(sql).not.toMatch(/public\./);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/);
    // No personal column is returned: only the rule, a count and row ids.
    expect(sql).not.toMatch(/AS "?(legalName|primaryPhone|crNumber)"?\b/);
  });
});
