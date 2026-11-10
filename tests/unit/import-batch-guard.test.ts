// Code review 2026-11-10, finding 6: the pure rules of lib/import-batch-guard.ts.
import { describe, it, expect } from 'vitest';
import {
  STAGED_BATCH_MAX_AGE_DAYS,
  batchAgeDays,
  batchAgeText,
  newerLoadRowMessage,
  newerLoadsRefusal,
  stagedBatchExpired,
  stagedBatchExpiredMessage,
} from '@/lib/import-batch-guard';

const NOW = new Date('2026-11-10T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 24 * 60 * 60 * 1000;

describe('the age of a staged batch', () => {
  it('is 7 days, one named number', () => {
    expect(STAGED_BATCH_MAX_AGE_DAYS).toBe(7);
  });
  it('counts whole days and says them plainly', () => {
    expect(batchAgeDays(ago(60_000), NOW)).toBe(0);
    expect(batchAgeText(ago(60_000), NOW)).toBe('today');
    expect(batchAgeText(ago(DAY + 1), NOW)).toBe('1 day ago');
    expect(batchAgeText(ago(12 * DAY), NOW)).toBe('12 days ago');
  });
  it('expires only when OLDER than the limit', () => {
    expect(stagedBatchExpired(ago(7 * DAY), NOW)).toBe(false);
    expect(stagedBatchExpired(ago(7 * DAY + 1), NOW)).toBe(true);
    expect(stagedBatchExpiredMessage(ago(8 * DAY), NOW)).toBe(
      'This batch was uploaded 8 days ago, and a staged batch older than 7 days can no longer be promoted: what it holds may be older than what is in the CRM now. Upload the sheet again to load it, and discard this batch.'
    );
  });
});

describe('customers a newer upload already loaded', () => {
  const loads = [
    { code: 'C1', filename: 'a.xlsx', rowNumber: 2 },
    { code: 'C2', filename: 'a.xlsx', rowNumber: 3 },
    { code: 'C3', filename: 'b.xlsx', rowNumber: 2 },
    { code: 'C4', filename: 'c.xlsx', rowNumber: 2 },
    { code: 'C5', filename: 'd.xlsx', rowNumber: 2 },
    { code: 'C6', filename: 'e.xlsx', rowNumber: 2 },
  ];
  it('the refusal names three customers and three files at most, and says what confirming does', () => {
    expect(newerLoadsRefusal(loads)).toBe(
      '6 customer(s) in this batch (for example C1, C2, C3) were loaded since from a newer upload ("a.xlsx", "b.xlsx", "c.xlsx" and 2 more). Loading this older batch would write its older values over theirs. Open Promote again and confirm that those customers are left out: their rows are then rejected, and the rest loads.'
    );
  });
  it('the row note names the newer file and row, and says to exclude it', () => {
    expect(newerLoadRowMessage(loads[0]!)).toBe(
      'Customer C1 was loaded since from a newer upload, "a.xlsx" (row 2), so this older row was not loaded over it. Exclude it.'
    );
    // No branch_code in it: the batch page offers no cell to correct.
    expect(newerLoadRowMessage(loads[0]!)).not.toMatch(/branch_?code/i);
  });
});
