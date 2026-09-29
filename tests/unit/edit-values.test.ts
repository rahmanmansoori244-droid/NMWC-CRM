/**
 * Phase 2 (F06, F20, F21): lib/edit-values.ts is the one place that says which
 * fields an edit carries, which may be emptied, and when two values are the
 * same. The form, the schema, the submit, the approval and the approval page all
 * decide with it, so a representational difference here would be a false
 * conflict (or a missed one) everywhere at once.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../support/strip-comments';
import type { Prisma } from '@prisma/client';
import { EDIT_PAYLOAD_VERSION as SCHEMA_PAYLOAD_VERSION } from '@/lib/validation/edit';
import {
  BRANCH_EDIT_FIELDS,
  BRANCH_EDIT_SELECT,
  BRANCH_FIELD_LABEL,
  CLEARABLE_BRANCH_FIELDS,
  CLEARABLE_CUSTOMER_FIELDS,
  CUSTOMER_EDIT_FIELDS,
  CUSTOMER_EDIT_SELECT,
  CUSTOMER_FIELD_LABEL,
  EDIT_PAYLOAD_VERSION,
  GPS_COMPANIONS,
  STALE_EQUIPMENT_MESSAGE,
  STALE_FIELD_MESSAGE,
  STALE_LOCATION_MESSAGE,
  classifyAgainstLive,
  classifyChanges,
  classifyPointAgainstLive,
  fieldLabel,
  fieldSlotKey,
  isUnmovedCoordinate,
  liveSnapshotOf,
  parseFieldPath,
  sameEditValue,
  slotFields,
  staleSlotMessage,
  toBaseValue,
  type LiveSnapshot,
} from '@/lib/edit-values';
import type { FieldChange } from '@/lib/gps-manual';

const B1 = 'ckbranch0000000000000001';
const B2 = 'ckbranch0000000000000002';

describe('the field lists', () => {
  it('customer and branch fields, with equipmentConfirmed on the branch (F21)', () => {
    expect(CUSTOMER_EDIT_FIELDS).toContain('notes');
    expect(BRANCH_EDIT_FIELDS).toContain('equipmentConfirmed');
    // every field has a label a person can read
    for (const f of CUSTOMER_EDIT_FIELDS) expect(CUSTOMER_FIELD_LABEL[f]).toBeTruthy();
    for (const f of BRANCH_EDIT_FIELDS) expect(BRANCH_FIELD_LABEL[f]).toBeTruthy();
  });

  it('the selects are Prisma selects of exactly those fields (a live snapshot to compare with)', () => {
    // Typed assignments: typecheck fails if a listed field is not a column.
    const customer: Prisma.CustomerSelect = CUSTOMER_EDIT_SELECT;
    const branch: Prisma.BranchSelect = BRANCH_EDIT_SELECT;
    expect(Object.keys(customer)).toEqual([...CUSTOMER_EDIT_FIELDS]);
    expect(Object.keys(branch)).toEqual([...BRANCH_EDIT_FIELDS]);
    expect(Object.values(branch).every((v) => v === true)).toBe(true);
  });

  it('one payload version, the same from the browser-safe module and from the schema', () => {
    expect(EDIT_PAYLOAD_VERSION).toBe(2);
    expect(SCHEMA_PAYLOAD_VERSION).toBe(EDIT_PAYLOAD_VERSION);
  });

  it('clearable: the owner-decided sets, CR number in and day of visit out (2026-09-29)', () => {
    expect([...CLEARABLE_CUSTOMER_FIELDS].sort()).toEqual(
      ['altPhone', 'contactRole', 'crNumber', 'notes', 'subChannelId'].sort()
    );
    expect([...CLEARABLE_BRANCH_FIELDS].sort()).toEqual(
      ['areaDescription', 'deliveryWindow', 'gpsAccuracy', 'openingHours'].sort()
    );
    expect(CLEARABLE_BRANCH_FIELDS.has('dayOfVisit')).toBe(false);
    for (const required of [
      'legalName',
      'channelId',
      'primaryPhone',
      'contactPerson',
      'status',
    ] as const) {
      expect(CLEARABLE_CUSTOMER_FIELDS.has(required), required).toBe(false);
    }
  });

  it('a module the browser imports: no zod and no Prisma runtime', () => {
    const src = stripComments(readFileSync('lib/edit-values.ts', 'utf8'), 'lib/edit-values.ts');
    for (const m of src.matchAll(/^import\s+(type\s+)?[^;]*from\s+'([^']+)'/gm)) {
      if (!m[1])
        expect(m[2], `runtime import of ${m[2]}`).not.toMatch(/zod|@prisma\/client|\.\/db|next\//);
    }
  });
});

describe('parseFieldPath / fieldLabel', () => {
  it('reads the stored keys, and nothing else', () => {
    expect(parseFieldPath('customer.notes')).toEqual({ scope: 'customer', field: 'notes' });
    expect(parseFieldPath(`branch.${B1}.gpsLat`)).toEqual({
      scope: 'branch',
      branchId: B1,
      field: 'gpsLat',
    });
    expect(parseFieldPath('draft.0.gps')).toBeNull();
    expect(parseFieldPath('customer.nmwcCode')).toBeNull();
    expect(parseFieldPath(`branch.${B1}.shopPhotoId`)).toBeNull();
    expect(parseFieldPath('branch..gpsLat')).toBeNull();
  });

  it('labels customer and branch status apart, and all four gps columns as one', () => {
    expect(fieldLabel('customer.status')).toBe('Status');
    expect(fieldLabel(`branch.${B1}.status`)).toBe('Branch status');
    expect(
      new Set(
        ['gpsLat', 'gpsLng', 'gpsAccuracy', 'gpsCapturedAt'].map((f) =>
          fieldLabel(`branch.${B1}.${f}`)
        )
      )
    ).toEqual(new Set(['Location']));
    expect(fieldLabel('draft.0.gps')).toBe('draft.0.gps');
  });
});

describe('sameEditValue', () => {
  it.each([
    ['notes', '', null, true],
    ['notes', null, undefined, true],
    ['notes', '', undefined, true],
    ['notes', 'a', null, false],
    ['notes', 'a', 'a', true],
    ['notes', 'a', 'a ', false],
    ['primaryPhone', '+96891234567', '+96891234567', true],
    ['primaryPhone', '+96891234567', '91234567', false],
    ['equipmentConfirmed', false, false, true],
    ['equipmentConfirmed', false, true, false],
    ['equipmentConfirmed', false, null, false],
    ['coolersCount', 0, 0, true],
    ['coolersCount', 0, null, false],
    ['coolersCount', 3, '3', false],
  ])('%s: %j vs %j → %s', (field, a, b, same) => {
    expect(sameEditValue(field, a, b)).toBe(same);
    expect(sameEditValue(field, b, a)).toBe(same);
  });

  it('floats survive JSON exactly', () => {
    for (const x of [23.588123, 58.3829, 0.1 + 0.2, 16.000001]) {
      expect(sameEditValue('gpsLat', x, JSON.parse(JSON.stringify({ x })).x)).toBe(true);
    }
    expect(sameEditValue('gpsLat', 23.588123, 23.588124)).toBe(false);
  });

  it('a capture time compares by instant: a Date against its ISO string, in any zone', () => {
    const d = new Date('2026-09-25T08:00:00.000Z');
    expect(sameEditValue('gpsCapturedAt', d, '2026-09-25T08:00:00.000Z')).toBe(true);
    expect(sameEditValue('gpsCapturedAt', d, '2026-09-25T12:00:00+04:00')).toBe(true);
    expect(sameEditValue(`branch.${B1}.gpsCapturedAt`, '2026-09-25T08:00:00Z', d)).toBe(true);
    expect(sameEditValue('gpsCapturedAt', d, '2026-09-25T08:00:01.000Z')).toBe(false);
    expect(sameEditValue('gpsCapturedAt', d, 'not a date')).toBe(false);
    expect(sameEditValue('gpsCapturedAt', 'not a date', 'not a date')).toBe(false);
  });

  it('toBaseValue is what JSON makes of a value', () => {
    const d = new Date('2026-09-25T08:00:00.000Z');
    expect(toBaseValue(d)).toBe('2026-09-25T08:00:00.000Z');
    expect(toBaseValue(undefined)).toBeNull();
    expect(toBaseValue(null)).toBeNull();
    expect(toBaseValue(0)).toBe(0);
    expect(toBaseValue(false)).toBe(false);
    expect(toBaseValue('x')).toBe('x');
    expect(toBaseValue(new Date('nope'))).toBeNull();
    for (const v of [d, 'x', 3.25, true, null])
      expect(sameEditValue('f', toBaseValue(v), v)).toBe(true);
  });
});

describe('classifyAgainstLive', () => {
  it('CONVERGED when the live value already is the new one — whatever the base', () => {
    expect(classifyAgainstLive('contactPerson', 'Old', 'New', 'New')).toBe('CONVERGED');
    expect(classifyAgainstLive('contactPerson', 'Other', 'New', 'New')).toBe('CONVERGED');
    expect(classifyAgainstLive('notes', 'x', null, '')).toBe('CONVERGED');
  });
  it('CHANGE when the live value is still the one the change was made against', () => {
    expect(classifyAgainstLive('contactPerson', 'Old', 'New', 'Old')).toBe('CHANGE');
    expect(classifyAgainstLive('notes', null, 'x', '')).toBe('CHANGE');
    expect(classifyAgainstLive('notes', 'x', null, 'x')).toBe('CHANGE');
  });
  it('STALE when it moved since', () => {
    expect(classifyAgainstLive('contactPerson', 'Old', 'New', 'Manager')).toBe('STALE');
    expect(classifyAgainstLive('notes', null, 'x', 'someone else')).toBe('STALE');
  });
  it('a GPS companion is never STALE on its own', () => {
    for (const f of GPS_COMPANIONS) {
      expect(classifyAgainstLive(f, 5, 8, 12)).toBe('CHANGE');
      expect(classifyAgainstLive(`branch.${B1}.${f}`, undefined, 8, 8)).toBe('CONVERGED');
    }
  });
});

describe('fieldSlotKey', () => {
  it('the location is one slot, and so is the equipment block', () => {
    for (const f of ['gpsLat', 'gpsLng', 'gpsAccuracy', 'gpsCapturedAt', 'gpsManualReason']) {
      expect(fieldSlotKey(`branch.${B1}.${f}`)).toBe(`branch.${B1}.gps`);
    }
    for (const f of ['coolersCount', 'standsCount', 'emptyBottlesCount', 'equipmentConfirmed']) {
      expect(fieldSlotKey(`branch.${B1}.${f}`)).toBe(`branch.${B1}.equipment`);
    }
  });
  it('every other path is its own slot', () => {
    expect(fieldSlotKey(`branch.${B1}.address`)).toBe(`branch.${B1}.address`);
    expect(fieldSlotKey('customer.primaryPhone')).toBe('customer.primaryPhone');
    expect(fieldSlotKey('_form')).toBe('_form');
    expect(fieldSlotKey('branchId')).toBe('branchId');
  });
  it('a slot’s columns are the ones a conflict hands back, and its STALE_FIELDS words', () => {
    // Every column of a group sits in that group's slot, so "Use this value"
    // on the slot takes back exactly what the conflict carried.
    for (const f of BRANCH_EDIT_FIELDS) {
      for (const g of slotFields(f)) {
        expect(fieldSlotKey(`branch.${B1}.${g}`), `${f} → ${g}`).toBe(fieldSlotKey(`branch.${B1}.${f}`));
      }
    }
    expect(slotFields('gpsCapturedAt')).toEqual(['gpsLat', 'gpsLng', 'gpsAccuracy', 'gpsCapturedAt']);
    expect(slotFields('coolersCount')).toEqual(['coolersCount', 'standsCount', 'emptyBottlesCount', 'equipmentConfirmed']);
    expect(slotFields('address')).toEqual(['address']);
    expect(staleSlotMessage(`branch.${B1}.gps`)).toBe(STALE_LOCATION_MESSAGE);
    expect(staleSlotMessage(`branch.${B1}.equipment`)).toBe(STALE_EQUIPMENT_MESSAGE);
    expect(staleSlotMessage('customer.notes')).toBe(STALE_FIELD_MESSAGE);
    // Ruling 14: the earlier write may have been the sender's own.
    for (const m of [STALE_FIELD_MESSAGE, STALE_LOCATION_MESSAGE, STALE_EQUIPMENT_MESSAGE]) {
      expect(m).toMatch(/after you opened this form/);
      expect(m).not.toMatch(/someone/i);
    }
  });
});

describe('classifyChanges', () => {
  const live = (): LiveSnapshot => ({
    customer: {
      contactPerson: 'Manager',
      notes: null,
      altPhone: '+96891234567',
      crNumber: '1234567',
    },
    branches: new Map([
      [
        B1,
        {
          address: 'Way 1',
          gpsLat: 23.5,
          gpsLng: 58.4,
          gpsAccuracy: 12,
          gpsCapturedAt: new Date('2026-09-20T08:00:00.000Z'),
          status: 'CLOSED',
          equipmentConfirmed: false,
        },
      ],
    ]),
  });
  const ch = (field: string, before: unknown, after: unknown): FieldChange => ({
    field,
    before,
    after,
  });

  it('splits apply / converged / stale, and reports a branch that is gone once', () => {
    const changes = [
      ch('customer.contactPerson', 'Old', 'Salesman'), // moved since → STALE
      ch('customer.notes', null, 'Closed Fridays'), // CHANGE
      ch('customer.altPhone', '+96891234567', null), // a clear → CHANGE
      ch('customer.crNumber', '7654321', '1234567'), // already there → CONVERGED
      ch(`branch.${B1}.status`, 'ACTIVE', 'CLOSED'), // a close already done → CONVERGED
      ch(`branch.${B2}.address`, 'a', 'b'), // not live on this customer → dropped
      ch(`branch.${B2}.dayOfVisit`, null, 'SUN'),
      ch('draft.0.gps', null, { lat: 1, lng: 2 }), // no edit field → ignored
    ];
    const r = classifyChanges(changes, live());
    expect(r.apply.map((c) => c.field)).toEqual(['customer.notes', 'customer.altPhone']);
    expect(r.converged).toEqual(['customer.crNumber', `branch.${B1}.status`]);
    expect(r.stale).toEqual([{ field: 'customer.contactPerson', live: 'Manager' }]);
    expect(r.droppedBranchIds).toEqual([B2]);
  });

  it('a close request against a branch now in a third status is STALE', () => {
    const snap = live();
    (snap.branches.get(B1) as Record<string, unknown>).status = 'SUSPENDED';
    const r = classifyChanges([ch(`branch.${B1}.status`, 'ACTIVE', 'CLOSED')], snap);
    expect(r.stale).toEqual([{ field: `branch.${B1}.status`, live: 'SUSPENDED' }]);
  });

  it('keeps the entries as given — item 41 markers and all', () => {
    const typed: FieldChange = {
      ...ch(`branch.${B1}.gpsLat`, 23.5, 23.6),
      gpsSource: 'MANUAL',
      gpsManualReason: 'no fix',
    };
    expect(classifyChanges([typed], live()).apply[0]).toBe(typed);
  });

  describe('GPS companions follow the point (ruling 7)', () => {
    const point = (lat: number, lng: number) => [
      ch(`branch.${B1}.gpsLat`, 23.5, lat),
      ch(`branch.${B1}.gpsLng`, 58.4, lng),
      ch(`branch.${B1}.gpsAccuracy`, 12, 4),
      ch(`branch.${B1}.gpsCapturedAt`, '2026-09-20T08:00:00.000Z', '2026-09-28T09:00:00.000Z'),
    ];

    it('a moved point is applied with its accuracy and capture time', () => {
      const r = classifyChanges(point(23.6, 58.5), live());
      expect(r.apply.map((c) => c.field.split('.')[2])).toEqual([
        'gpsLat',
        'gpsLng',
        'gpsAccuracy',
        'gpsCapturedAt',
      ]);
    });

    it('one coordinate moving is enough to carry them — and the point is written whole', () => {
      // The submit records the unmoved longitude beside the moved latitude.
      const r = classifyChanges(point(23.6, 58.4), live());
      expect(r.apply.map((c) => c.field.split('.')[2])).toEqual([
        'gpsLat',
        'gpsLng',
        'gpsAccuracy',
        'gpsCapturedAt',
      ]);
      expect(r.converged).toEqual([]);
    });

    it('when the point already is the new one, they are not written beside it', () => {
      const snap = live();
      Object.assign(snap.branches.get(B1) as Record<string, unknown>, {
        gpsLat: 23.6,
        gpsLng: 58.5,
      });
      const r = classifyChanges(point(23.6, 58.5), snap);
      expect(r.apply).toEqual([]);
      expect(r.converged).toHaveLength(4);
      expect(r.stale).toEqual([]);
    });

    it('when another writer moved the point, the point is STALE and they are not applied', () => {
      const snap = live();
      Object.assign(snap.branches.get(B1) as Record<string, unknown>, {
        gpsLat: 24.1,
        gpsLng: 57.9,
        gpsAccuracy: 30,
      });
      const r = classifyChanges(point(23.6, 58.5), snap);
      expect(r.stale.map((s) => s.field)).toEqual([`branch.${B1}.gpsLat`, `branch.${B1}.gpsLng`]);
      expect(r.apply).toEqual([]);
      expect(r.converged).toEqual([`branch.${B1}.gpsAccuracy`, `branch.${B1}.gpsCapturedAt`]);
    });

    it('a companion already equal to the live value is not rewritten', () => {
      const changes = point(23.6, 58.5);
      changes[2] = ch(`branch.${B1}.gpsAccuracy`, 12, 12);
      const r = classifyChanges(changes, live());
      expect(r.converged).toEqual([`branch.${B1}.gpsAccuracy`]);
    });
  });

  describe('the point is one value (phase-2 review, finding 2)', () => {
    const lat = `branch.${B1}.gpsLat`;
    const lng = `branch.${B1}.gpsLng`;
    const acc = `branch.${B1}.gpsAccuracy`;
    const cap = `branch.${B1}.gpsCapturedAt`;
    /** A latitude-only correction as the submit records it: the longitude beside it, unmoved. */
    const latitudeOnly = () => [
      ch(lat, 23.5, 23.6),
      ch(lng, 58.4, 58.4),
      ch(acc, 12, null),
      ch(cap, '2026-09-20T08:00:00.000Z', '2026-09-28T09:00:00.000Z'),
    ];
    const moved = (over: Record<string, unknown>) => {
      const snap = live();
      Object.assign(snap.branches.get(B1) as Record<string, unknown>, over);
      return snap;
    };

    it('another writer’s longitude-only correction since makes it STALE — never a point mixing the two', () => {
      const r = classifyChanges(latitudeOnly(), moved({ gpsLng: 58.5, gpsAccuracy: 5 }));
      expect(r.stale).toEqual([
        { field: lat, live: 23.5 },
        { field: lng, live: 58.5 },
      ]);
      expect(r.apply).toEqual([]);
      expect(r.converged).toEqual([acc, cap]);
    });

    it('a point another writer moved only partly toward this one is STALE, not half-converged', () => {
      // Both coordinates moved in the request; another writer has since set the
      // same latitude but not the same longitude.
      const r = classifyChanges(
        [ch(lat, 23.5, 23.6), ch(lng, 58.4, 58.5)],
        moved({ gpsLat: 23.6 })
      );
      expect(r.stale.map((s) => s.field)).toEqual([lat, lng]);
      expect(r.apply).toEqual([]);
    });

    it('the whole point already live is CONVERGED, companions and all', () => {
      const r = classifyChanges(latitudeOnly(), moved({ gpsLat: 23.6 }));
      expect(r.apply).toEqual([]);
      expect(r.converged).toEqual([lat, lng, acc, cap]);
      expect(r.stale).toEqual([]);
    });

    it('a request sent before patch v2, which recorded one coordinate alone, is judged on that one', () => {
      // Nothing was recorded about the longitude, so nothing can be checked about it.
      const r = classifyChanges([ch(lat, 23.5, 23.6)], moved({ gpsLng: 58.9 }));
      expect(r.apply.map((c) => c.field)).toEqual([lat]);
      expect(r.stale).toEqual([]);
    });

    it('classifyPointAgainstLive: the classifyAgainstLive rule, on the pair', () => {
      const p = (gpsLat: unknown, gpsLng: unknown) => ({ gpsLat, gpsLng });
      const was = p(23.5, 58.4);
      expect(classifyPointAgainstLive(was, p(23.6, 58.4), p(23.6, 58.4))).toBe('CONVERGED');
      expect(classifyPointAgainstLive(was, p(23.6, 58.4), p(23.5, 58.4))).toBe('CHANGE');
      expect(classifyPointAgainstLive(was, p(23.6, 58.4), p(23.5, 58.5))).toBe('STALE');
      expect(classifyPointAgainstLive(was, p(23.6, 58.5), p(23.6, 58.4))).toBe('STALE');
      // A branch with no point yet: null on both sides is the same point.
      expect(classifyPointAgainstLive(p(null, null), p(23.6, 58.4), p(null, null))).toBe('CHANGE');
    });

    it('isUnmovedCoordinate: only the partner coordinate at the value it had, by path or by name', () => {
      expect(isUnmovedCoordinate(ch(lng, 58.4, 58.4))).toBe(true);
      expect(isUnmovedCoordinate(ch('gpsLat', 23.5, 23.5))).toBe(true);
      expect(isUnmovedCoordinate(ch(lat, 23.5, 23.6))).toBe(false);
      expect(isUnmovedCoordinate(ch(acc, 12, 12))).toBe(false);
      expect(isUnmovedCoordinate(ch('customer.notes', 'x', 'x'))).toBe(false);
      // Not a coordinate a submit proposed: no number after it.
      expect(isUnmovedCoordinate({ field: lat })).toBe(false);
      expect(isUnmovedCoordinate(ch(lat, null, null))).toBe(false);
    });
  });

  it('liveSnapshotOf takes rows as Prisma returns them; a branch not passed is dropped', () => {
    const customerRow = { id: 'ckcustomer00000000000001', contactPerson: 'Manager', notes: null };
    const b1Row = { id: B1, address: 'Way 1', gpsCapturedAt: new Date('2026-09-20T08:00:00.000Z') };
    const snap = liveSnapshotOf(customerRow, [b1Row]);
    expect(snap.customer).toBe(customerRow);
    expect(snap.branches.get(B1)).toBe(b1Row);
    const r = classifyChanges(
      [
        ch('customer.notes', null, 'x'),
        ch(`branch.${B1}.address`, 'Way 1', 'Way 2'),
        ch(`branch.${B2}.address`, 'a', 'b'),
      ],
      snap
    );
    expect(r.apply.map((c) => c.field)).toEqual(['customer.notes', `branch.${B1}.address`]);
    expect(r.droppedBranchIds).toEqual([B2]);
  });
});
