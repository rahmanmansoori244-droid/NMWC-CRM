// @vitest-environment node
/**
 * Phase 2: which server errors the enrichment form shows beside a field — an
 * explicit list now (lib/form-errors.ts). `customer.` used to claim every
 * customer key, and the form has no line for most of them: an error on the
 * notes, the contact role, a channel select, the status, the CR photo or the
 * payment terms was claimed, shown nowhere, and the submit seemed to do nothing.
 * Ruling 11: an error naming a branch the page does not show says to reload.
 */
import { describe, it, expect } from 'vitest';
import {
  enrichmentFormRendersError,
  RELOAD_FOR_BRANCH_HINT,
  surfaceUnrenderedErrors,
  withReloadHintForUnshownBranches,
} from '@/lib/form-errors';

describe('enrichmentFormRendersError — exactly the fields with a line of their own', () => {
  it('the five customer fields with an error line, and each shown branch’s location', () => {
    for (const k of [
      'customer.legalName',
      'customer.crNumber',
      'customer.primaryPhone',
      'customer.altPhone',
      'customer.contactPerson',
      'branch.b1.gps',
    ]) {
      expect(enrichmentFormRendersError(k, new Set(['b1'])), k).toBe(true);
    }
  });

  it('every other key surfaces at the top — the ones `customer.` used to swallow first', () => {
    for (const k of [
      'customer.notes',
      'customer.contactRole',
      'customer.channelId',
      'customer.subChannelId',
      'customer.status',
      'customer.crPhoto',
      'customer.paymentTerms',
      'branch.b1.address',
      'branch.b1.equipment',
      'branch.b1.dayOfVisit',
      'branch.b1.shopPhoto',
      'branch.b1.gpsManualReason',
      'branchId',
      '_form',
    ]) {
      expect(enrichmentFormRendersError(k, new Set(['b1'])), k).toBe(false);
    }
    const fields = {
      'customer.notes': 'Notes are too long.',
      'customer.contactPerson': 'Too short.',
    };
    expect(surfaceUnrenderedErrors(fields, (k) => enrichmentFormRendersError(k))._form).toBe(
      'Notes are too long.'
    );
  });

  it('the location of a branch the page does not show has no line here', () => {
    expect(enrichmentFormRendersError('branch.b9.gps', new Set(['b1']))).toBe(false);
    expect(enrichmentFormRendersError('branch.b9.gps')).toBe(true); // no set given: any branch
  });
});

describe('ruling 11 — an error on a branch this page does not show', () => {
  it('says to reload, and surfaces at the top', () => {
    const shown = new Set(['b1']);
    const fields = withReloadHintForUnshownBranches(
      {
        'branch.b9.gps': 'Branch MCT-0012: GPS coordinates are required.',
        'branch.b1.shopPhoto': 'Branch MCT-0011: shop photo is required.',
        'customer.primaryPhone': 'Primary phone is required.',
      },
      shown
    );
    expect(fields['branch.b9.gps']).toBe(
      `Branch MCT-0012: GPS coordinates are required. ${RELOAD_FOR_BRANCH_HINT}`
    );
    expect(fields['branch.b1.shopPhoto']).toBe('Branch MCT-0011: shop photo is required.');
    expect(fields['customer.primaryPhone']).toBe('Primary phone is required.');
    const surfaced = surfaceUnrenderedErrors(fields, (k) => enrichmentFormRendersError(k, shown));
    expect(surfaced._form).toContain(RELOAD_FOR_BRANCH_HINT);
  });

  it('leaves the answer alone when every branch named is shown', () => {
    const fields = { 'branch.b1.gps': 'x' };
    expect(withReloadHintForUnshownBranches(fields, new Set(['b1']))).toBe(fields);
  });
});
