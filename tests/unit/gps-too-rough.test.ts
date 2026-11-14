// @vitest-environment node
/**
 * H14 (bug hunt round 1, finding 7): Capture GPS keeps its best reading whatever
 * its accuracy, so a tablet with only an approximate location could send a point
 * worse than ±10 km. The schemas cap the accuracy at 10,000 m (the database's
 * range, GPS_ACCURACY_MAX), on a draft as on a submit, and Save draft failed with
 * zod's "Number must be less than or equal to 10000" at the TOP of the form,
 * because the new-customer service did not map gpsAccuracy to the shop's GPS
 * field. The rule is unchanged; the refusal is now a sentence on the GPS field.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/session', () => ({
  requireActor: async () => ({ id: 'u-sales', role: 'SALESMAN', username: 'mct01' }),
}));
vi.mock('@/lib/submission-replay', () => ({
  findReceipt: async () => null,
  answerIfLanded: (fn: () => unknown) => fn(),
  shownTime: () => new Date(),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkLimit: async () => ({ ok: true }),
  FORM_LIMIT: {},
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { submitCreateAction } from '@/services/creates';
import { createBranchDraftSchema } from '@/lib/validation/create';
import { submitEditSchema, EDIT_PAYLOAD_VERSION } from '@/lib/validation/edit';
import { GPS_READING_TOO_ROUGH_MESSAGE } from '@/lib/gps-accuracy';
import { GPS_ACCURACY_MAX } from '@/lib/db-rules';
import { fieldSlotKey } from '@/lib/edit-values';

const point = { gpsLat: 23.588, gpsLng: 58.3829, gpsCapturedAt: new Date('2026-11-14T06:00:00Z') };

const draft = (gpsAccuracy: number) =>
  ({
    isDraft: true,
    customer: { legalName: 'Al Noor Trading', paymentTerms: 'CASH' },
    branches: [{ branchName: 'Main', ...point, gpsAccuracy }],
  }) as unknown as Parameters<typeof submitCreateAction>[0];

describe('a GPS reading rougher than ±10 km (H14)', () => {
  it('the sentence tells him to capture again or type the location', () => {
    expect(GPS_READING_TOO_ROUGH_MESSAGE).toBe(
      'This GPS reading is too rough to keep (worse than ±10 km). Step outside and capture GPS again, or enter the location by hand with a reason.'
    );
  });

  it('new customer, Save draft: refused on the shop’s GPS field in those words, nothing at the top', async () => {
    const r = await submitCreateAction(draft(12000));
    expect(r).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    const fields = (r as { fields?: Record<string, string> }).fields ?? {};
    expect(fields).toEqual({ 'branch.0.gps': GPS_READING_TOO_ROUGH_MESSAGE });
  });

  it('the rule is kept: exactly 10,000 m passes the schema, just over does not', () => {
    const base = { branchName: 'Main', ...point };
    expect(createBranchDraftSchema.safeParse({ ...base, gpsAccuracy: GPS_ACCURACY_MAX }).success).toBe(true);
    const over = createBranchDraftSchema.safeParse({ ...base, gpsAccuracy: GPS_ACCURACY_MAX + 0.5 });
    expect(over.success).toBe(false);
    expect(over.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['gpsAccuracy', GPS_READING_TOO_ROUGH_MESSAGE],
    ]);
  });

  it('customer edit: the same sentence, and it lands on the GPS slot', () => {
    const editBody = (gpsAccuracy: number) => {
      const b = { ...point, gpsAccuracy };
      return {
        v: EDIT_PAYLOAD_VERSION,
        customerId: 'ckcustomer00000000000001',
        customer: {},
        customerBase: {},
        branches: [
          {
            branchId: 'ckbranch0000000000000001',
            base: Object.fromEntries(Object.keys(b).map((k) => [k, null])),
            ...b,
          },
        ],
      };
    };
    const r = submitEditSchema.safeParse(editBody(12000));
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['branches.0.gpsAccuracy', GPS_READING_TOO_ROUGH_MESSAGE],
    ]);
    expect(fieldSlotKey('branch.b1.gpsAccuracy')).toBe('branch.b1.gps');
    expect(submitEditSchema.safeParse(editBody(GPS_ACCURACY_MAX)).success).toBe(true);
  });
});
