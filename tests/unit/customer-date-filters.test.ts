// @vitest-environment node
/**
 * Follow-up 1, H12 (bug hunt round 1, finding 5): the /customers list's
 * "Created/Edited after/before" days, and "Export filtered", which reads the
 * same parser (services/customer-export.ts). A day was read as UTC midnight,
 * 04:00 in Oman, so a customer created at 01:30 Oman on the 19th was left out
 * of "after the 19th" and taken into "before the 19th". The bounds are now the
 * Oman day's, as the customer-master and field-update exports read theirs.
 */
import { describe, it, expect } from 'vitest';
import { applyCustomerFilters, parseCustomerFilters } from '@/lib/customer-filters';

// 01:30 Oman on 19 Nov 2026 is 21:30 UTC on the 18th.
const at0130Oman = new Date('2026-11-18T21:30:00.000Z');
const inRange = (d: Date, r: { gte?: Date; lte?: Date }) =>
  (!r.gte || d.getTime() >= r.gte.getTime()) && (!r.lte || d.getTime() <= r.lte.getTime());

describe('the list and export date filters read Oman days', () => {
  it('"after" starts at 00:00 Oman and "before" ends at 23:59:59.999 Oman of the day picked', () => {
    const f = parseCustomerFilters({
      createdAfter: '2026-11-19',
      createdBefore: '2026-11-19',
      editedAfter: '2026-11-19',
      editedBefore: '2026-11-19',
    });
    expect(f.createdAfter!.toISOString()).toBe('2026-11-18T20:00:00.000Z');
    expect(f.createdBefore!.toISOString()).toBe('2026-11-19T19:59:59.999Z');
    expect(f.editedAfter!.toISOString()).toBe('2026-11-18T20:00:00.000Z');
    expect(f.editedBefore!.toISOString()).toBe('2026-11-19T19:59:59.999Z');
  });

  it('a customer created at 01:30 Oman on the 19th is "after the 19th" and not "before the 18th"', () => {
    const where = (sp: Record<string, string>) =>
      applyCustomerFilters({}, undefined, parseCustomerFilters(sp), [], null);
    const after19 = where({ createdAfter: '2026-11-19' }).createdAt as { gte?: Date; lte?: Date };
    expect(inRange(at0130Oman, after19)).toBe(true);
    const before18 = where({ createdBefore: '2026-11-18' }).createdAt as { gte?: Date; lte?: Date };
    expect(inRange(at0130Oman, before18)).toBe(false);
    const edited19 = where({ editedAfter: '2026-11-19', editedBefore: '2026-11-19' }).updatedAt as {
      gte?: Date;
      lte?: Date;
    };
    expect(inRange(at0130Oman, edited19)).toBe(true);
  });

  it('anything but a real day is no filter', () => {
    for (const raw of ['', 'yesterday', '2026-02-30', '2026-11-19T10:00:00Z', '19/11/2026']) {
      expect(parseCustomerFilters({ createdAfter: raw }).createdAfter).toBeNull();
    }
  });
});
