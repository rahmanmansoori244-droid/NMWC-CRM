/**
 * Phase 1 Temix sync: outbound row shaping + archive/merge state decisions.
 */
import { describe, it, expect } from 'vitest';
import { PaymentTerms, TemixSyncState, Prisma } from '@prisma/client';
import {
  buildTemixRows,
  deactivationCode,
  deactivationsOfLiveCodes,
  mergeTemixClash,
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

describe('F11: mergeTemixClash', () => {
  const id = (nmwcCode: string, temixCode: string | null) => ({ nmwcCode, temixCode });

  it('the same Temix code on both sides is SHARED_CODE — the loser must not be deactivated', () => {
    expect(mergeTemixClash(id('N2', 'T1'), id('N1', 'T1'))).toBe('SHARED_CODE');
    // Under the migrated convention (nmwcCode == temixCode) too.
    expect(mergeTemixClash(id('N2', 'N1'), id('N1', 'N1'))).toBe('SHARED_CODE');
  });

  it("one side's Temix code being the other's customer code is CROSSED", () => {
    expect(mergeTemixClash(id('N2', 'N1'), id('N1', null))).toBe('CROSSED');
    expect(mergeTemixClash(id('N2', null), id('N1', 'N2'))).toBe('CROSSED');
    expect(mergeTemixClash(id('N2', 'T9'), id('N1', 'N2'))).toBe('CROSSED');
  });

  it('nothing shared is null — resolveArchiveTemixState decides as before', () => {
    expect(mergeTemixClash(id('N2', 'T2'), id('N1', 'T1'))).toBeNull();
    expect(mergeTemixClash(id('N2', null), id('N1', null))).toBeNull();
    expect(mergeTemixClash(id('N2', 'T2'), id('N1', null))).toBeNull();
    // Two uncoded rows never "share" a null code.
    expect(mergeTemixClash(id('N2', null), id('N1', 'T1'))).toBeNull();
  });
});

describe('F11: deactivationsOfLiveCodes — the batch invariant', () => {
  const at = new Date('2026-09-20T08:00:00Z');

  it('the reported case: UPSERT T1 and DEACTIVATE T1 in one batch is caught', () => {
    const winner = customer({ id: 'w', nmwcCode: 'N1', temixCode: 'T1' });
    const loser = customer({ id: 'l', nmwcCode: 'N2', temixCode: 'T1', deletedAt: at });
    // What the batch would have said without the invariant.
    expect(buildTemixRows([winner, loser], 'b').map((r) => `${r.sync_action}:${r.temix_code}`)).toEqual([
      'UPSERT:T1',
      'DEACTIVATE:T1',
    ]);
    expect(deactivationsOfLiveCodes([winner, loser], new Set(['T1']))).toEqual(['T1']);
  });

  it('a deactivation of a code a live customer outside the batch still holds is caught too', () => {
    const loser = customer({ nmwcCode: 'N2', temixCode: 'T1', deletedAt: at });
    expect(deactivationsOfLiveCodes([loser], new Set(['T1']))).toEqual(['T1']);
  });

  it('different codes pass, and so does a deactivation nobody live holds', () => {
    const winner = customer({ id: 'w', nmwcCode: 'N1', temixCode: 'T1' });
    const loser = customer({ id: 'l', nmwcCode: 'N2', temixCode: 'T2', deletedAt: at });
    expect(deactivationsOfLiveCodes([winner, loser], new Set(['T1']))).toEqual([]);
    expect(deactivationsOfLiveCodes([loser], new Set())).toEqual([]);
  });

  it('a live row is never a deactivation', () => {
    const live = customer({ temixCode: 'T1' });
    expect(deactivationsOfLiveCodes([live], new Set(['T1']))).toEqual([]);
  });

  it('an uncoded archive goes out under its customer code, and clashes when a live customer holds that as its Temix code', () => {
    const uncoded = customer({ nmwcCode: 'N2', temixCode: null, deletedAt: at });
    // What the batch would send for it: no temix_code, keyed on cust_code.
    expect(buildTemixRows([uncoded], 'b').map((r) => `${r.sync_action}:${r.temix_code}:${r.cust_code}`)).toEqual([
      'DEACTIVATE::N2',
    ]);
    expect(deactivationCode(uncoded)).toBe('N2');
    expect(deactivationsOfLiveCodes([uncoded], new Set(['N2']))).toEqual(['N2']);
    expect(deactivationsOfLiveCodes([uncoded], new Set(['T1']))).toEqual([]);
  });

  it('a coded row is deactivated by its Temix code, not its customer code', () => {
    const coded = customer({ nmwcCode: 'N2', temixCode: 'T2', deletedAt: at });
    expect(deactivationCode(coded)).toBe('T2');
    expect(deactivationsOfLiveCodes([coded], new Set(['N2']))).toEqual([]);
  });

  it('each clashing code once, sorted', () => {
    const rows = [
      customer({ id: 'a', temixCode: 'T3', deletedAt: at }),
      customer({ id: 'b', temixCode: 'T1', deletedAt: at }),
      customer({ id: 'c', temixCode: 'T3', deletedAt: at }),
    ];
    expect(deactivationsOfLiveCodes(rows, new Set(['T1', 'T3']))).toEqual(['T1', 'T3']);
  });
});
