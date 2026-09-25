/**
 * Benchmark item 41: a GPS point typed in by hand is kept, with the salesman's
 * reason, inside the change request (owner decision 2026-09-25, option A).
 *
 * The flag used to be lost at FOUR separate places — the payload builders, zod's
 * default strip, the service's field list, and a missing column — and a key that
 * zod strips fails silently. So these tests pin each hop, not only the ends.
 * The service writes are covered against a real database in
 * tests/integration/golive-update-flow.test.ts (sections 8 and 9, CI db-tests).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import { stripComments } from '../support/strip-comments';
import {
  countFieldChanges,
  gpsManualReasonSchema,
  hasManualGps,
  manualGpsMarker,
  manualGpsReasonForBranch,
  manualGpsReasonForPoint,
  markManualGps,
  type FieldChange,
} from '@/lib/gps-manual';
import { submitEditSchema } from '@/lib/validation/edit';
import { submitCreateSchema } from '@/lib/validation/create';

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/services/edits', () => ({ bulkApproveEditsAction: vi.fn(), bulkRejectEditsAction: vi.fn() }));

afterEach(cleanup);

const read = (f: string) => stripComments(readFileSync(f, 'utf8'), f);
const REASON = 'Phone GPS broken; read the point off Google Maps.';

describe('41 — the reason, as stored', () => {
  it('is stripped of HTML before its length is checked, and bounded', () => {
    expect(gpsManualReasonSchema.parse('  <b>' + REASON + '</b> ')).toBe(REASON);
    // '<b></b>ab' is 9 characters raw and 2 once stripped.
    expect(gpsManualReasonSchema.safeParse('<b></b>ab').success).toBe(false);
    expect(gpsManualReasonSchema.safeParse('x'.repeat(501)).success).toBe(false);
    expect(gpsManualReasonSchema.safeParse('x'.repeat(500)).success).toBe(true);
  });

  it('survives both submit schemas — zod strips an undeclared key without a word', () => {
    const edit = submitEditSchema.parse({
      customerId: 'ckabcdefghijklmnopqrstuvw',
      customer: {},
      branches: [{ branchId: 'ckabcdefghijklmnopqrstuvw', gpsLat: 23.6, gpsLng: 58.4, gpsManualReason: REASON }],
    });
    expect(edit.branches[0]!.gpsManualReason).toBe(REASON);
    const create = submitCreateSchema.parse({
      isDraft: true,
      customer: { legalName: 'Al Noor Trading', paymentTerms: 'CASH' },
      branches: [{ branchName: 'Main', gpsLat: 23.6, gpsLng: 58.4, gpsManualReason: REASON }],
    });
    expect(create.branches[0]!.gpsManualReason).toBe(REASON);
  });

  it('both forms send it, and only for a point marked as typed', () => {
    for (const f of ['app/(app)/customers/[id]/edit/EnrichmentForm.tsx', 'app/(app)/customers/new/CreateCustomerForm.tsx']) {
      expect(read(f), f).toMatch(/gpsManualReason:\s*s\.gps\?\.isManual\s*\?\s*s\.gps\.manualReason\s*:\s*undefined/);
    }
  });
});

describe('41 — the marker', () => {
  const changes = (): FieldChange[] => [
    { field: 'customer.contactRole', before: 'Owner', after: 'Partner' },
    { field: 'branch.b1.gpsLat', before: 23.5, after: 23.6 },
    { field: 'branch.b1.gpsLng', before: 58.3, after: 58.4 },
    { field: 'branch.b1.gpsAccuracy', before: 8, after: null },
    { field: 'branch.b1.address', before: 'Ruwi', after: 'Ruwi souq' },
  ];

  it('UPDATE: rides on the branch gps entries only, so the change count does not move', () => {
    const list = changes();
    markManualGps(list, REASON);
    expect(list.filter((c) => c.gpsSource === 'MANUAL').map((c) => c.field)).toEqual([
      'branch.b1.gpsLat',
      'branch.b1.gpsLng',
      'branch.b1.gpsAccuracy',
    ]);
    expect(countFieldChanges(list)).toBe(5);
    expect(manualGpsReasonForBranch(list, 'b1')).toBe(REASON);
    expect(manualGpsReasonForBranch(list, 'b2')).toBeNull();
    expect(manualGpsReasonForBranch(changes(), 'b1')).toBeNull();
  });

  it('CREATE: one element per typed branch, matched to its draft by its point, and never counted', () => {
    const list = [manualGpsMarker(0, 23.61, 58.41, REASON)];
    expect(list[0]).toEqual({
      field: 'draft.0.gps',
      before: null,
      after: { lat: 23.61, lng: 58.41 },
      gpsSource: 'MANUAL',
      gpsManualReason: REASON,
    });
    expect(manualGpsReasonForPoint(list, 23.61, 58.41)).toBe(REASON);
    // A draft at another point — or the same branch moved since — is not flagged.
    expect(manualGpsReasonForPoint(list, 23.62, 58.41)).toBeNull();
    expect(manualGpsReasonForPoint(list, null, 58.41)).toBeNull();
    expect(countFieldChanges(list)).toBe(0);
    expect(hasManualGps(list)).toBe(true);
  });

  it('reads defensively: fieldChanges is unvalidated JSON', () => {
    const junk = [null, 'x', 3, { field: 7 }, { field: 'branch.b1.gpsLat', gpsSource: 'OTHER', gpsManualReason: REASON }];
    expect(hasManualGps(junk)).toBe(false);
    expect(hasManualGps(null)).toBe(false);
    expect(manualGpsReasonForBranch(junk, 'b1')).toBeNull();
    expect(manualGpsReasonForPoint({ not: 'an array' }, 1, 2)).toBeNull();
    expect(countFieldChanges(junk)).toBe(1);
    expect(countFieldChanges(undefined)).toBe(0);
  });
});

describe('41 — the approval queue flags it before a bulk approve', () => {
  const item = (manualGps: boolean) => ({
    id: 'q1',
    ageHours: 2,
    changesCount: 3,
    sla: null,
    escalationLevel: 0,
    isCreate: false,
    manualGps,
    paymentTerms: null,
    customer: { legalName: 'Al Maha Foodstuff', nmwcCode: 'NMWC-018702', completenessScore: 60 },
    submittedByFullName: 'Salesman One',
  });

  it('shows a Typed GPS pill on the card, and only then', async () => {
    const { BulkApprovalQueue } = await import('@/app/(app)/approvals/BulkApprovalQueue');
    render(<BulkApprovalQueue items={[item(true)]} />);
    expect(screen.getByText('Typed GPS')).toBeTruthy();
    cleanup();
    render(<BulkApprovalQueue items={[item(false)]} />);
    expect(screen.queryByText('Typed GPS')).toBeNull();
  });

  it('the queue page derives the flag and the count from the marker-aware helpers', () => {
    const src = read('app/(app)/approvals/page.tsx');
    expect(src).toMatch(/manualGps:\s*hasManualGps\(e\.fieldChanges\)/);
    expect(src).toMatch(/changesCount\s*=\s*countFieldChanges\(e\.fieldChanges\)/);
    expect(read('app/(app)/customers/[id]/page.tsx')).toMatch(/\{countFieldChanges\(e\.fieldChanges\)\} change\(s\)/);
  });
});
