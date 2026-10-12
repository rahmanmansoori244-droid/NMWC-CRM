// @vitest-environment node
/**
 * Gaps 4 and 7 (data audit 2026-10-10, lossless paths): lib/import-lineage.ts.
 *
 *  - differingCells / differingCustomerCells: a customer or shop the import row
 *    leaves as it is is not written — a cell that is unset (undefined: "leave as
 *    it is") never counts, and a value equal to the stored one does not either,
 *    whatever its type (dates by instant, decimals by value, null and undefined
 *    alike);
 *  - the per-entity audit row carries the before and after of the changed fields
 *    and the lineage (batch, import row, sheet row, lane), and its reason names
 *    them;
 *  - a Steward's correction keeps non-personal cells' values and only the
 *    fingerprints of personal ones.
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  IMPORT_AUDIT_REASON_PREFIX,
  NON_PERSONAL_IMPORT_CELLS,
  auditValue,
  changeAudit,
  correctionAudit,
  createAudit,
  differingCells,
  differingCustomerCells,
  importAuditReason,
  sameStoredValue,
} from '@/lib/import-lineage';
import { fingerprint } from '@/lib/fingerprint';

const lineage = { batchId: 'b1', importRowId: 'row-1', rowNumber: 14, lane: 'full' as const };

describe('sameStoredValue', () => {
  it('null and undefined are the same "no value"', () => {
    expect(sameStoredValue(null, undefined)).toBe(true);
    expect(sameStoredValue(undefined, null)).toBe(true);
    expect(sameStoredValue(null, '')).toBe(false);
  });

  it('dates compare by instant, decimals by value, everything else exactly', () => {
    expect(sameStoredValue(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00.000Z'))).toBe(true);
    expect(sameStoredValue(new Date('2026-10-01T00:00:00Z'), '2026-10-01T00:00:00Z')).toBe(true);
    expect(sameStoredValue(new Prisma.Decimal('5000.000'), 5000)).toBe(true);
    expect(sameStoredValue(5000, new Prisma.Decimal('5000.5'))).toBe(false);
    expect(sameStoredValue('CASH', 'CASH')).toBe(true);
    expect(sameStoredValue('cash', 'CASH')).toBe(false);
    expect(sameStoredValue(3, '3')).toBe(false);
  });
});

describe('differingCells', () => {
  const stored = {
    legalName: 'Al Noor',
    primaryPhone: '+96891111111',
    crNumber: null,
    channelId: 'ch1',
    subChannelId: 'sub1',
    creditLimit: new Prisma.Decimal('1000'),
    status: 'ACTIVE',
  };

  it('a row that restates the stored customer changes nothing: no write, no bump', () => {
    expect(
      differingCells(
        { legalName: 'Al Noor', primaryPhone: '+96891111111', crNumber: undefined, channelId: 'ch1', status: undefined },
        stored
      )
    ).toEqual([]);
    expect(differingCells({ creditLimit: 1000 }, stored)).toEqual([]);
  });

  it('names exactly the cells that differ, in the order written', () => {
    expect(
      differingCells({ status: 'ACTIVE', subChannelId: null, legalName: 'Al Noor Trading', creditLimit: 2000 }, stored)
    ).toEqual(['subChannelId', 'legalName', 'creditLimit']);
  });

  it('a blank cell (undefined) never clears a stored value', () => {
    expect(differingCells({ primaryPhone: undefined, crNumber: undefined }, stored)).toEqual([]);
  });

  it('the customer helper is the same rule', () => {
    expect(differingCustomerCells).toBe(differingCells);
  });
});

describe('the per-entity import audit row', () => {
  it('UPDATE: before and after of the changed fields only, the lineage in after', () => {
    const out = changeAudit(
      ['routeId', 'dayOfVisit'],
      { routeId: 'r1', dayOfVisit: 'SUN', address: 'Way 1' },
      { routeId: 'r2', dayOfVisit: 'MON', address: 'Way 1' },
      lineage
    );
    expect(out.before).toEqual({ routeId: 'r1', dayOfVisit: 'SUN' });
    expect(out.after).toEqual({
      routeId: 'r2',
      dayOfVisit: 'MON',
      batchId: 'b1',
      importRowId: 'row-1',
      rowNumber: 14,
      lane: 'full',
    });
  });

  it('CREATE: every value it was created with, JSON-safe, and the lineage', () => {
    const at = new Date('2026-10-12T05:00:00.000Z');
    expect(
      createAudit(
        { nmwcCode: 'C1', creditLimit: new Prisma.Decimal('250.5'), createdAt: at, crNumber: null, skipped: undefined },
        { ...lineage, lane: 'refresh' }
      )
    ).toEqual({
      nmwcCode: 'C1',
      creditLimit: '250.5',
      createdAt: '2026-10-12T05:00:00.000Z',
      crNumber: null,
      batchId: 'b1',
      importRowId: 'row-1',
      rowNumber: 14,
      lane: 'refresh',
    });
  });

  it('values are stored as JSON: decimals as text, dates as ISO instants', () => {
    expect(auditValue(new Prisma.Decimal('7.25'))).toBe('7.25');
    expect(auditValue(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
    expect(auditValue(undefined)).toBeNull();
    expect(auditValue(3)).toBe(3);
  });

  it("the reason names the batch, the sheet row and the lane, under one prefix the backup match leaves out", () => {
    expect(importAuditReason('b1', 14, 'backup')).toBe('import b1 row 14 (backup)');
    expect(importAuditReason('b1', 14, 'backup').startsWith(IMPORT_AUDIT_REASON_PREFIX)).toBe(true);
  });
});

describe("gap 7: a Steward's correction of an import row", () => {
  it('keeps old and new values of a non-personal cell, and only fingerprints of a personal one', () => {
    const out = correctionAudit(
      { day_of_visit: 'MON', phone: '+96892222222', cust_name: '' },
      { day_of_visit: 'SUN', phone: '+96891111111', cust_name: 'Old Name' }
    );
    expect(out.day_of_visit).toEqual({ from: 'SUN', to: 'MON' });
    expect(out.phone).toEqual({
      fromSha256: fingerprint('import:phone', '+96891111111'),
      toSha256: fingerprint('import:phone', '+96892222222'),
    });
    // A cell cleared: no value, no fingerprint.
    expect(out.cust_name).toEqual({ fromSha256: fingerprint('import:cust_name', 'Old Name'), toSha256: null });
    expect(JSON.stringify(out)).not.toContain('9222');
    expect(JSON.stringify(out)).not.toContain('Old Name');
  });

  it('the non-personal cells are codes, channel, visit day and status only', () => {
    for (const personal of ['cust_name', 'address', 'phone', 'cr_no', 'contact_person', 'notes']) {
      expect(NON_PERSONAL_IMPORT_CELLS.has(personal), personal).toBe(false);
    }
    for (const plain of ['cust_code', 'branch_code', 'channel', 'day_of_visit', 'customer_status']) {
      expect(NON_PERSONAL_IMPORT_CELLS.has(plain), plain).toBe(true);
    }
  });
});
