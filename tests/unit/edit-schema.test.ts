/**
 * Phase 2: the customer UPDATE payload, patch v2 (lib/validation/edit.ts).
 *
 *   N02 — text is stripped of HTML BEFORE its length is checked, on every field,
 *         for every role: '<shop>' used to reach the master as an empty name.
 *   F19 — a phone is checked with lib/phone.ts's rule and output normalized;
 *         an invalid one used to be dropped by the service without a word.
 *   F20 — absent keeps, null clears (only where clearable), a value sets.
 *   Nothing is coerced: z.coerce made null into 0 and into 1970-01-01.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';
import {
  DUPLICATE_BRANCH_MESSAGE,
  EDIT_PAYLOAD_VERSION,
  GPS_COMPANIONS_NEED_POINT_MESSAGE,
  GPS_PAIR_MESSAGE,
  GPS_POINT_NEEDS_COMPANIONS_MESSAGE,
  branchPatchSchema,
  customerPatchSchema,
  isCurrentEditPayload,
  keysWithoutBase,
  submitEditSchema,
  type ParsedSubmitEdit,
} from '@/lib/validation/edit';
import {
  BRANCH_EDIT_FIELDS,
  CLEARABLE_BRANCH_FIELDS,
  CLEARABLE_CUSTOMER_FIELDS,
  CUSTOMER_EDIT_FIELDS,
} from '@/lib/edit-values';
import { INVALID_PHONE_MESSAGE } from '@/lib/phone';

const CUSTOMER_ID = 'ckcustomer00000000000001';
const B1 = 'ckbranch0000000000000001';
const B2 = 'ckbranch0000000000000002';
const CHANNEL = 'ckchannel000000000000001';
const PERSIAN = '۹۱۲۳۴۵۶۷';
const ARABIC = '٩١٢٣٤٥٦٧';

/** A body whose every sent key carries a base of null (the value is irrelevant to the schema). */
function body(
  customer: Record<string, unknown> = {},
  branches: Array<Record<string, unknown>> = []
) {
  return {
    v: EDIT_PAYLOAD_VERSION,
    customerId: CUSTOMER_ID,
    customer,
    customerBase: Object.fromEntries(Object.keys(customer).map((k) => [k, null])),
    branches: branches.map((b) => ({
      branchId: B1,
      base: Object.fromEntries(
        Object.keys(b)
          .filter((k) => k !== 'branchId')
          .map((k) => [k, null])
      ),
      ...b,
    })),
  };
}
const customerIssue = (customer: Record<string, unknown>, field: string) => {
  const r = submitEditSchema.safeParse(body(customer));
  if (r.success) return undefined;
  return r.error.issues.find((i) => i.path.join('.') === `customer.${field}`)?.message;
};
const branchIssue = (branch: Record<string, unknown>, field: string) => {
  const r = submitEditSchema.safeParse(body({}, [branch]));
  if (r.success) return undefined;
  return r.error.issues.find((i) => i.path.join('.') === `branches.0.${field}`)?.message;
};
const parse = (customer: Record<string, unknown>, branches: Array<Record<string, unknown>> = []) =>
  submitEditSchema.parse(body(customer, branches));

describe('N02 — strip, then validate', () => {
  const REQUIRED = [
    ['customer', 'legalName', 'Legal name must be at least 2 characters.'],
    ['customer', 'contactPerson', 'Contact person must be at least 2 characters.'],
    ['branch', 'branchName', 'Branch name is required.'],
    ['branch', 'address', 'Address must be at least 3 characters.'],
  ] as const;

  it.each(REQUIRED)(
    '%s.%s refuses markup-only and blank values with its own message',
    (scope, field, msg) => {
      for (const v of ['<shop>', '  ', '<b></b>', '']) {
        const got =
          scope === 'customer'
            ? customerIssue({ [field]: v }, field)
            : branchIssue({ [field]: v }, field);
        expect(got, JSON.stringify(v)).toBe(msg);
      }
    }
  );

  it('real names pass unchanged — Latin and Arabic — and markup inside one is stripped', () => {
    expect(parse({ legalName: 'Al Noor Trading' }).customer.legalName).toBe('Al Noor Trading');
    expect(parse({ legalName: 'مؤسسة النور للتجارة' }).customer.legalName).toBe(
      'مؤسسة النور للتجارة'
    );
    expect(parse({ contactPerson: 'Said <b>Al</b> Harthy' }).customer.contactPerson).toBe(
      'Said Al Harthy'
    );
    expect(parse({}, [{ address: '  Way 123, <i>Al Khuwair</i> ' }]).branches[0]!.address).toBe(
      'Way 123, Al Khuwair'
    );
  });

  it('an optional text reduced to nothing by the strip is a clear', () => {
    const p = parse({ notes: '<b></b>', contactRole: ' <br> ' }, [
      { areaDescription: '<p></p>', openingHours: '', deliveryWindow: '   ' },
    ]);
    expect(p.customer.notes).toBeNull();
    expect(p.customer.contactRole).toBeNull();
    expect(p.branches[0]!.areaDescription).toBeNull();
    expect(p.branches[0]!.openingHours).toBeNull();
    expect(p.branches[0]!.deliveryWindow).toBeNull();
  });

  it('length is judged on what is stored, not on the markup', () => {
    // 5000 characters of notes, wrapped in a tag, fit.
    expect(parse({ notes: `<p>${'x'.repeat(5000)}</p>` }).customer.notes).toHaveLength(5000);
    expect(customerIssue({ notes: 'x'.repeat(5001) }, 'notes')).toBeTruthy();
    expect(customerIssue({ legalName: 'x'.repeat(201) }, 'legalName')).toBeTruthy();
  });

  it('no field in the v2 schema or its helpers checks a length before it strips (structural)', () => {
    const read = (f: string) => stripComments(readFileSync(f, 'utf8'), f);
    const edit = read('lib/validation/edit.ts');
    // The pre-v2 schema (min before strip, z.coerce) is gone with the service
    // that parsed it; the whole file is held to the rule.
    expect(edit).not.toMatch(/legacyCustomerEditSchema|legacySubmitEditSchema/);
    expect(edit).toMatch(/export const submitEditSchema\b/);
    const fields = read('lib/validation/fields.ts');
    expect(fields).toMatch(/\.transform\(stripHtml\)\s*\.pipe\(/);
    for (const [name, src] of [
      ['edit.ts', edit],
      ['fields.ts', fields],
    ] as const) {
      expect(src, name).not.toMatch(/\.min\([^)]*\)[^,;]*\.transform\(stripHtml/);
      expect(src, name).not.toMatch(/z\.coerce/);
    }
  });
});

describe('F19 — phones', () => {
  it('Arabic-Indic, Persian and spaced numbers come out normalized', () => {
    for (const v of [ARABIC, PERSIAN, '9123 4567', '+968 9123-4567', '0096891234567']) {
      expect(parse({ primaryPhone: v }).customer.primaryPhone, v).toBe('+96891234567');
      expect(parse({ altPhone: v }).customer.altPhone, v).toBe('+96891234567');
    }
  });

  it('a number that is not an Oman phone is a field error on its own key', () => {
    for (const v of ['1234567', '12345678901234', 'call 91234567', PERSIAN.slice(0, 7)]) {
      expect(customerIssue({ primaryPhone: v }, 'primaryPhone'), v).toBe(INVALID_PHONE_MESSAGE);
      expect(customerIssue({ altPhone: v }, 'altPhone'), v).toBe(INVALID_PHONE_MESSAGE);
    }
  });

  it("alt phone '' or null clears it; primary phone refuses both", () => {
    expect(parse({ altPhone: '' }).customer.altPhone).toBeNull();
    expect(parse({ altPhone: '  ' }).customer.altPhone).toBeNull();
    expect(parse({ altPhone: null }).customer.altPhone).toBeNull();
    const msg = 'Primary phone cannot be removed — enter the correct number.';
    expect(customerIssue({ primaryPhone: null }, 'primaryPhone')).toBe(msg);
    expect(customerIssue({ primaryPhone: '' }, 'primaryPhone')).toBe(msg);
  });
});

describe('F20 — absent keeps, null clears only where clearable', () => {
  const CUSTOMER_CLEARS: Record<string, unknown[]> = {
    crNumber: [null, '', '   '],
    subChannelId: [null, ''],
    altPhone: [null, ''],
    contactRole: [null, ''],
    notes: [null, ''],
  };
  const BRANCH_CLEARS: Record<string, unknown[]> = {
    areaDescription: [null, ''],
    openingHours: [null, ''],
    deliveryWindow: [null, ''],
  };

  it('the schema takes null on exactly the clearable fields — the sets in lib/edit-values.ts are the rule', () => {
    for (const f of CUSTOMER_EDIT_FIELDS) {
      expect(submitEditSchema.safeParse(body({ [f]: null })).success, `customer.${f}`).toBe(
        CLEARABLE_CUSTOMER_FIELDS.has(f)
      );
    }
    // The GPS group is tested on its own below: its fields travel together.
    for (const f of BRANCH_EDIT_FIELDS.filter((x) => !x.startsWith('gps'))) {
      expect(submitEditSchema.safeParse(body({}, [{ [f]: null }])).success, `branch.${f}`).toBe(
        CLEARABLE_BRANCH_FIELDS.has(f)
      );
    }
  });

  it('the tables here are the clearable sets', () => {
    expect(Object.keys(CUSTOMER_CLEARS).sort()).toEqual([...CLEARABLE_CUSTOMER_FIELDS].sort());
    // gpsAccuracy is clearable only as a GPS companion; its own test is below.
    expect([...Object.keys(BRANCH_CLEARS), 'gpsAccuracy'].sort()).toEqual(
      [...CLEARABLE_BRANCH_FIELDS].sort()
    );
  });

  it.each(Object.entries(CUSTOMER_CLEARS))(
    'customer.%s: null and blank become null',
    (field, values) => {
      for (const v of values) {
        const p = parse({ [field]: v });
        expect((p.customer as Record<string, unknown>)[field], JSON.stringify(v)).toBeNull();
      }
    }
  );

  it.each(Object.entries(BRANCH_CLEARS))(
    'branch.%s: null and blank become null',
    (field, values) => {
      for (const v of values) {
        const p = parse({}, [{ [field]: v }]);
        expect((p.branches[0] as Record<string, unknown>)[field], JSON.stringify(v)).toBeNull();
      }
    }
  );

  it.each([
    ['legalName', 'Legal name cannot be removed.'],
    ['paymentTerms', 'Payment terms cannot be removed.'],
    ['channelId', 'Channel cannot be removed — pick one.'],
    ['primaryPhone', 'Primary phone cannot be removed — enter the correct number.'],
    ['contactPerson', 'Contact person cannot be removed.'],
    ['status', 'Status cannot be removed.'],
  ])('customer.%s refuses null: %s', (field, msg) => {
    expect(customerIssue({ [field]: null }, field)).toBe(msg);
  });

  it.each([
    ['branchName', 'Branch name cannot be removed.'],
    ['address', 'Address cannot be removed — correct it instead.'],
    ['dayOfVisit', 'Day of visit cannot be removed once set — pick the right day.'],
    ['coolersCount', 'Coolers cannot be empty — enter 0.'],
    ['standsCount', 'Stands cannot be empty — enter 0.'],
    ['emptyBottlesCount', 'Empty bottles cannot be empty — enter 0.'],
    ['status', 'Status cannot be removed.'],
  ])('branch.%s refuses null: %s', (field, msg) => {
    expect(branchIssue({ [field]: null }, field)).toBe(msg);
  });

  it('the location cannot be removed', () => {
    const r = submitEditSchema.safeParse(
      body({}, [
        { gpsLat: null, gpsLng: null, gpsAccuracy: null, gpsCapturedAt: '2026-09-28T09:00:00Z' },
      ])
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toBe('The location cannot be removed.');
  });

  it("the channel refuses '' too, and a CR number is trimmed", () => {
    expect(customerIssue({ channelId: '' }, 'channelId')).toBe(
      'Channel cannot be removed — pick one.'
    );
    expect(parse({ channelId: CHANNEL }).customer.channelId).toBe(CHANNEL);
    expect(parse({ crNumber: ' 1234567 ' }).customer.crNumber).toBe('1234567');
  });

  it('an absent key stays absent — not undefined-as-a-value, not null', () => {
    const p = parse({ notes: 'x' });
    expect(Object.keys(p.customer)).toEqual(['notes']);
  });
});

describe('no coercion', () => {
  it('gpsCapturedAt null is refused, not 1970-01-01; a date string needs a zone', () => {
    const point = { gpsLat: 23.6, gpsLng: 58.4, gpsAccuracy: 5 };
    expect(branchIssue({ ...point, gpsCapturedAt: null }, 'gpsCapturedAt')).toBe(
      'Send the time the location was captured.'
    );
    expect(branchIssue({ ...point, gpsCapturedAt: '2026-09-28 09:00' }, 'gpsCapturedAt')).toBe(
      'Send the time the location was captured.'
    );
    expect(branchIssue({ ...point, gpsCapturedAt: 0 }, 'gpsCapturedAt')).toBe(
      'Send the time the location was captured.'
    );
    for (const ok of [
      '2026-09-28T09:00:00Z',
      '2026-09-28T09:00:00.123Z',
      '2026-09-28T13:00:00+04:00',
    ]) {
      const p = parse({}, [{ ...point, gpsCapturedAt: ok }]);
      expect(p.branches[0]!.gpsCapturedAt, ok).toBeInstanceOf(Date);
      expect(p.branches[0]!.gpsCapturedAt!.getTime()).toBe(Date.parse(ok));
    }
    // a server-side caller may pass a Date
    const d = new Date('2026-09-28T09:00:00Z');
    expect(parse({}, [{ ...point, gpsCapturedAt: d }]).branches[0]!.gpsCapturedAt!.getTime()).toBe(
      d.getTime()
    );
  });

  it('counts: null and strings are refused, not read as 0; bounds and whole numbers hold', () => {
    expect(branchIssue({ coolersCount: null }, 'coolersCount')).toBe(
      'Coolers cannot be empty — enter 0.'
    );
    expect(branchIssue({ coolersCount: '3' }, 'coolersCount')).toBe(
      'Coolers cannot be empty — enter 0.'
    );
    expect(branchIssue({ coolersCount: 1.5 }, 'coolersCount')).toBe(
      'Coolers must be a whole number.'
    );
    expect(branchIssue({ coolersCount: -1 }, 'coolersCount')).toBe('Coolers cannot be below 0.');
    expect(branchIssue({ standsCount: 101 }, 'standsCount')).toBe(
      'Stands cannot be more than 100.'
    );
    expect(parse({}, [{ emptyBottlesCount: 1000, coolersCount: 0 }]).branches[0]).toMatchObject({
      emptyBottlesCount: 1000,
      coolersCount: 0,
    });
  });
});

describe('F21 — equipmentConfirmed', () => {
  it('takes true or false (the service decides who may send false), never null', () => {
    expect(parse({}, [{ equipmentConfirmed: true }]).branches[0]!.equipmentConfirmed).toBe(true);
    expect(parse({}, [{ equipmentConfirmed: false }]).branches[0]!.equipmentConfirmed).toBe(false);
    expect(branchIssue({ equipmentConfirmed: null }, 'equipmentConfirmed')).toBeTruthy();
    expect(branchIssue({ equipmentConfirmed: 'yes' }, 'equipmentConfirmed')).toBeTruthy();
  });
});

describe('the GPS group travels whole (ruling 7)', () => {
  const at = '2026-09-28T09:00:00Z';

  it('latitude without longitude, or the reverse, is refused', () => {
    expect(branchIssue({ gpsLat: 23.6, gpsAccuracy: 5, gpsCapturedAt: at }, 'gpsLng')).toBe(
      GPS_PAIR_MESSAGE
    );
    expect(branchIssue({ gpsLng: 58.4, gpsAccuracy: 5, gpsCapturedAt: at }, 'gpsLat')).toBe(
      GPS_PAIR_MESSAGE
    );
  });

  it('a point without its capture time or its accuracy is refused; accuracy may be null', () => {
    expect(branchIssue({ gpsLat: 23.6, gpsLng: 58.4, gpsAccuracy: 5 }, 'gpsCapturedAt')).toBe(
      GPS_POINT_NEEDS_COMPANIONS_MESSAGE
    );
    expect(branchIssue({ gpsLat: 23.6, gpsLng: 58.4, gpsCapturedAt: at }, 'gpsAccuracy')).toBe(
      GPS_POINT_NEEDS_COMPANIONS_MESSAGE
    );
    const typed = parse({}, [{ gpsLat: 23.6, gpsLng: 58.4, gpsAccuracy: null, gpsCapturedAt: at }]);
    expect(typed.branches[0]!.gpsAccuracy).toBeNull();
  });

  it('accuracy, capture time or a reason without a point is refused', () => {
    expect(branchIssue({ gpsAccuracy: 5 }, 'gpsAccuracy')).toBe(GPS_COMPANIONS_NEED_POINT_MESSAGE);
    expect(branchIssue({ gpsCapturedAt: at }, 'gpsCapturedAt')).toBe(
      GPS_COMPANIONS_NEED_POINT_MESSAGE
    );
    expect(branchIssue({ gpsManualReason: 'Phone GPS broken today.' }, 'gpsManualReason')).toBe(
      GPS_COMPANIONS_NEED_POINT_MESSAGE
    );
  });

  it('the Oman envelope still holds', () => {
    expect(
      branchIssue({ gpsLat: 33.3, gpsLng: 44.4, gpsAccuracy: 5, gpsCapturedAt: at }, 'gpsLat')
    ).toBe('Latitude must be inside Oman (≤27°N).');
  });
});

describe('the envelope', () => {
  it('the patch schemas carry exactly the fields lib/edit-values.ts lists', () => {
    expect(Object.keys(customerPatchSchema.shape).sort()).toEqual([...CUSTOMER_EDIT_FIELDS].sort());
    expect(Object.keys(branchPatchSchema.innerType().shape).sort()).toEqual(
      [...BRANCH_EDIT_FIELDS, 'branchId', 'gpsManualReason', 'base', 'overrides'].sort()
    );
  });

  it('v, bases of every JSON kind, overrides and the item-22 id parse', () => {
    const p = submitEditSchema.parse({
      v: 2,
      customerId: CUSTOMER_ID,
      isDraft: false,
      submissionId: '6f1c2b1e-4a5d-4c3b-9e8f-0a1b2c3d4e5f',
      customer: { notes: 'Closed Fridays', altPhone: null },
      customerBase: { notes: null, altPhone: '+96891234567', unknownKey: 'dropped' },
      customerOverrides: ['notes'],
      branches: [
        {
          branchId: B1,
          equipmentConfirmed: true,
          coolersCount: 2,
          gpsLat: 23.6,
          gpsLng: 58.4,
          gpsAccuracy: 4.5,
          gpsCapturedAt: '2026-09-28T09:00:00.000Z',
          base: { equipmentConfirmed: false, coolersCount: 0, gpsLat: 23.588123, gpsLng: 58.3829 },
          overrides: ['coolersCount'],
        },
      ],
    });
    expect(p.customerBase).toEqual({ notes: null, altPhone: '+96891234567' });
    expect(p.customerOverrides).toEqual(['notes']);
    expect(p.branches[0]!.base).toEqual({
      equipmentConfirmed: false,
      coolersCount: 0,
      gpsLat: 23.588123,
      gpsLng: 58.3829,
    });
    expect(p.branches[0]!.overrides).toEqual(['coolersCount']);
    expect(p.isDraft).toBe(false);
  });

  it('a body from the old form is not the current payload', () => {
    const old = { customerId: CUSTOMER_ID, isDraft: false, customer: { notes: 'x' }, branches: [] };
    expect(isCurrentEditPayload(old)).toBe(false);
    expect(isCurrentEditPayload({ ...old, v: 1 })).toBe(false);
    expect(isCurrentEditPayload(null)).toBe(false);
    expect(isCurrentEditPayload(body())).toBe(true);
    expect(submitEditSchema.safeParse(old).success).toBe(false);
  });

  it('an unknown key is refused, at every level (.strict)', () => {
    expect(submitEditSchema.safeParse({ ...body(), extra: 1 }).success).toBe(false);
    expect(submitEditSchema.safeParse(body({ nmwcCode: 'X' })).success).toBe(false);
    expect(submitEditSchema.safeParse(body({}, [{ shopPhotoId: 'x' }])).success).toBe(false);
  });

  it('the same branch twice is refused on the form, not on a field', () => {
    const b = body({}, [{ address: 'Way 1' }]);
    const twice = { ...b, branches: [b.branches[0]!, { ...b.branches[0]!, address: 'Way 2' }] };
    const r = submitEditSchema.safeParse(twice);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues).toEqual([
        expect.objectContaining({ path: [], message: DUPLICATE_BRANCH_MESSAGE }),
      ]);
    }
    const two = { ...b, branches: [b.branches[0]!, { ...b.branches[0]!, branchId: B2 }] };
    expect(submitEditSchema.safeParse(two).success).toBe(true);
  });
});

describe('keysWithoutBase — a sent key must say what it was changed from', () => {
  const at = '2026-09-28T09:00:00Z';
  const parsed = (raw: unknown) => submitEditSchema.parse(raw) as ParsedSubmitEdit;

  it('nothing missing when every key has a base, null included', () => {
    expect(
      keysWithoutBase(parsed(body({ notes: 'x', altPhone: null }, [{ address: 'Way 1' }])))
    ).toEqual([]);
  });

  it('names every key without one', () => {
    const raw = {
      v: 2,
      customerId: CUSTOMER_ID,
      customer: { notes: 'x', contactRole: 'Owner' },
      customerBase: { notes: null },
      branches: [{ branchId: B1, address: 'Way 1', dayOfVisit: 'SUN', base: { address: 'Old' } }],
    };
    expect(keysWithoutBase(parsed(raw))).toEqual([
      'customer.contactRole',
      `branch.${B1}.dayOfVisit`,
    ]);
  });

  it('the GPS companions and a typed-in reason carry none, the point does', () => {
    const raw = {
      v: 2,
      customerId: CUSTOMER_ID,
      customer: {},
      customerBase: {},
      branches: [
        {
          branchId: B1,
          gpsLat: 23.6,
          gpsLng: 58.4,
          gpsAccuracy: null,
          gpsCapturedAt: at,
          gpsManualReason: 'Phone GPS broken today.',
          base: { gpsLat: null },
        },
      ],
    };
    expect(keysWithoutBase(parsed(raw))).toEqual([`branch.${B1}.gpsLng`]);
  });
});
