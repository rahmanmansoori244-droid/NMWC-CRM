/**
 * Phase 1 Temix sync: outbound row shaping + archive/merge state decisions.
 */
import { describe, it, expect } from 'vitest';
import { PaymentTerms, TemixSyncState, Prisma } from '@prisma/client';
import {
  buildTemixRows,
  resolveArchiveTemixState,
  TEMIX_QUEUE_WHERE,
  type TemixExportCustomer,
} from '@/lib/temix';

function customer(over: Partial<TemixExportCustomer> = {}): TemixExportCustomer {
  return {
    id: 'c1',
    nmwcCode: 'NMWC-2026-000001',
    temixCode: null,
    legalName: 'Al Noor Trading',
    paymentTerms: PaymentTerms.CASH,
    creditLimit: null,
    paymentTermDays: null,
    crNumber: '1234567',
    primaryPhone: '+96891234567',
    altPhone: null,
    contactPerson: 'Said',
    deletedAt: null,
    channel: { label: 'Retail' },
    subChannel: { label: 'Grocery' },
    branches: [
      {
        branchCode: 'NMWC-2026-000001-01',
        branchName: 'Main',
        address: 'Way 123, Al Khuwair',
        dayOfVisit: 'MON',
        gpsLat: 23.6,
        gpsLng: 58.5,
        deletedAt: null,
        region: { name: 'Muscat', code: 'MCT' },
        route: { code: 'MCT-01' },
      },
    ],
    guaranteeDocs: 0,
    ...over,
  };
}

describe('buildTemixRows', () => {
  it('UPSERT lane: one row per LIVE branch with blank temix_code for CRM-born customers', () => {
    const rows = buildTemixRows([customer()], 'batch1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sync_action: 'UPSERT',
      sync_batch_id: 'batch1',
      temix_code: '',
      cust_code: 'NMWC-2026-000001',
      branch_code: 'NMWC-2026-000001-01',
      route: 'MCT-01',
    });
  });

  it('drops soft-deleted branches from the UPSERT lane but keeps the customer row', () => {
    const c = customer();
    c.branches[0]!.deletedAt = new Date();
    const rows = buildTemixRows([c], 'b');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.branch_code).toBe(''); // master row survives with blank branch fields
    expect(rows[0]!.sync_action).toBe('UPSERT');
  });

  it('DEACTIVATE lane: soft-deleted customer emits exactly ONE row, blank branch fields', () => {
    const c = customer({
      deletedAt: new Date(),
      temixCode: 'T-778',
      branches: [
        ...customer().branches,
        { ...customer().branches[0]!, branchCode: 'X-02' },
      ],
    });
    const rows = buildTemixRows([c], 'b');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sync_action: 'DEACTIVATE', temix_code: 'T-778', branch_code: '' });
  });

  it('credit columns only populate for CREDIT customers', () => {
    const cash = buildTemixRows([customer({ creditLimit: new Prisma.Decimal(500) })], 'b')[0]!;
    expect(cash.credit_limit).toBe('');
    const credit = buildTemixRows(
      [
        customer({
          paymentTerms: PaymentTerms.CREDIT,
          creditLimit: new Prisma.Decimal('500.125'),
          paymentTermDays: 30,
          guaranteeDocs: 2,
        }),
      ],
      'b'
    )[0]!;
    expect(credit.credit_limit).toBe(500.125);
    expect(credit.payment_term_days).toBe(30);
    expect(credit.guarantee_docs).toBe(2);
  });
});

describe('TEMIX_QUEUE_WHERE', () => {
  it('includes soft-deleted rows ONLY for the deactivation lane', () => {
    // Structural assertion: PENDING_UPLOAD requires deletedAt null; the
    // DEACTIVATE_PENDING arm must NOT carry a deletedAt filter (documented
    // exception — deactivation rows are soft-deleted by definition).
    const arms = TEMIX_QUEUE_WHERE.OR!;
    expect(arms).toHaveLength(2);
    expect(arms[0]).toEqual({
      temixSyncState: TemixSyncState.PENDING_UPLOAD,
      deletedAt: null,
    });
    expect(arms[1]).toEqual({ temixSyncState: TemixSyncState.DEACTIVATE_PENDING });
  });
});

describe('resolveArchiveTemixState', () => {
  it('queues deactivation when Temix knows the customer (code / uploaded / synced)', () => {
    expect(
      resolveArchiveTemixState({
        temixCode: 'T-1',
        lastTemixUploadAt: null,
        temixSyncState: TemixSyncState.PENDING_UPLOAD,
      })
    ).toBe(TemixSyncState.DEACTIVATE_PENDING);
    expect(
      resolveArchiveTemixState({
        temixCode: null,
        lastTemixUploadAt: new Date(),
        temixSyncState: TemixSyncState.UPLOADED,
      })
    ).toBe(TemixSyncState.DEACTIVATE_PENDING);
    // Migrated rows default to SYNCED even before the temixCode backfill.
    expect(
      resolveArchiveTemixState({
        temixCode: null,
        lastTemixUploadAt: null,
        temixSyncState: TemixSyncState.SYNCED,
      })
    ).toBe(TemixSyncState.DEACTIVATE_PENDING);
  });

  it('parks a never-uploaded CRM-born customer as SYNCED (Temix has nothing to deactivate)', () => {
    expect(
      resolveArchiveTemixState({
        temixCode: null,
        lastTemixUploadAt: null,
        temixSyncState: TemixSyncState.PENDING_UPLOAD,
      })
    ).toBe(TemixSyncState.SYNCED);
  });
});
