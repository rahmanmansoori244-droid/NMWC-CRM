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
  takeManualGpsReason,
  type FieldChange,
} from '@/lib/gps-manual';
import { enrichmentFormRendersError, surfaceUnrenderedErrors } from '@/lib/form-errors';
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

describe('41 — which submits carry the marker (services/edits.ts, per branch)', () => {
  const live = { gpsLat: 23.588, gpsLng: 58.3829 };
  const typed = (over: Record<string, unknown>) => ({
    branchId: 'b1',
    gpsLat: 23.588,
    gpsLng: 58.3829,
    // A typed point always carries a FRESH capture time (GpsCaptureButton).
    gpsCapturedAt: new Date('2026-09-25T08:00:00.000Z'),
    gpsManualReason: REASON,
    ...over,
  });

  it('a move of EITHER coordinate returns the reason and clears the accuracy', () => {
    for (const over of [{ gpsLat: 23.6012 }, { gpsLng: 58.4021 }, { gpsLat: 23.6012, gpsLng: 58.4021 }]) {
      const payload: Record<string, unknown> = typed(over);
      expect(takeManualGpsReason(live, payload), JSON.stringify(over)).toBe(REASON);
      expect(payload.gpsAccuracy).toBeNull();
      expect('gpsManualReason' in payload).toBe(false);
    }
  });

  it('a reason with the point unchanged returns nothing and touches nothing but the reason', () => {
    // Only the capture time differs — as it always does for a re-typed point.
    const payload: Record<string, unknown> = typed({});
    expect(takeManualGpsReason(live, payload)).toBeNull();
    expect('gpsAccuracy' in payload).toBe(false);
    expect('gpsManualReason' in payload).toBe(false);
  });

  it('a moved point with no reason is a device fix: nothing returned, accuracy kept', () => {
    const payload: Record<string, unknown> = { branchId: 'b1', gpsLat: 23.7, gpsLng: 58.5, gpsAccuracy: 6 };
    expect(takeManualGpsReason(live, payload)).toBeNull();
    expect(payload.gpsAccuracy).toBe(6);
  });

  it('a first point on a branch with none on file counts as a move', () => {
    expect(takeManualGpsReason({ gpsLat: null, gpsLng: null }, typed({}))).toBe(REASON);
  });
});

describe('41 — the enrichment form shows every error the server returns', () => {
  it('a branch error with no slot on the form surfaces at the top', () => {
    const fields = { 'branch.b1.address': 'Address is too short.', 'customer.contactPerson': 'Too short.' };
    expect(surfaceUnrenderedErrors(fields, enrichmentFormRendersError)._form).toBe('Address is too short.');
  });

  it("the branch's gps slot and customer fields render in place; an existing _form is kept", () => {
    expect(enrichmentFormRendersError('branch.b1.gps')).toBe(true);
    expect(enrichmentFormRendersError('customer.primaryPhone')).toBe(true);
    expect(enrichmentFormRendersError('branch.b1.gpsManualReason')).toBe(false);
    const inPlace = { 'branch.b1.gps': 'Latitude must be inside Oman (≥16°N).' };
    expect(surfaceUnrenderedErrors(inPlace, enrichmentFormRendersError)).toEqual(inPlace);
    const both = { _form: 'No changes to submit.', 'branch.b1.status': 'x' };
    expect(surfaceUnrenderedErrors(both, enrichmentFormRendersError)._form).toBe('No changes to submit.');
  });

  it('the form uses them, and shows the gps error beside the GPS button', () => {
    const src = read('app/(app)/customers/[id]/edit/EnrichmentForm.tsx');
    expect(src).toMatch(/setErrors\(surfaceUnrenderedErrors\(result\.fields, enrichmentFormRendersError\)\)/);
    expect(src).toMatch(/<GpsCaptureButton[\s\S]{0,300}?\/>\s*\{errors\[`branch\.\$\{b\.id\}\.gps`\] && \(/);
  });
});

describe('41 — what the salesman sees is what is submitted', () => {
  it('a restored local draft remounts the GPS buttons, once per draft', () => {
    const src = read('app/(app)/customers/[id]/edit/EnrichmentForm.tsx');
    expect(src).toMatch(/<GpsCaptureButton\s+key=\{restoreGeneration\}/);
    expect(src).toMatch(/if \(d\.branchStates\) \{\s*setBranchStates\([^;]*;\s*setRestoreGeneration\(\(g\) => g \+ 1\);/);
    // Once per draft key: a mid-session re-render must not re-restore and remount.
    expect(src).toMatch(/if \(restoredForKeyRef\.current === draftKey\) return;\s*restoredForKeyRef\.current = draftKey;/);
  });

  it('a resumed new-customer request keeps the Manual badge and its reason', () => {
    expect(read('app/(app)/customers/new/page.tsx')).toMatch(
      /gpsManualReason: manualGpsReasonForPoint\(edit\.fieldChanges, b\.gpsLat, b\.gpsLng\)/
    );
    expect(read('app/(app)/customers/new/CreateCustomerForm.tsx')).toMatch(
      /\.\.\.\(b\.gpsManualReason \? \{ isManual: true, manualReason: b\.gpsManualReason \} : \{\}\)/
    );
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
    // The queue pill reads UPDATE-shaped requests too, not only CREATE markers.
    expect(hasManualGps(list)).toBe(true);
    expect(hasManualGps(changes())).toBe(false);
  });

  it('UPDATE: a typed move of one coordinate is still found, and only for its own branch', () => {
    const b1: FieldChange[] = [{ field: 'branch.b1.gpsLng', before: 58.3, after: 58.4 }];
    const b2: FieldChange[] = [
      { field: 'branch.b2.gpsLat', before: 23.1, after: 23.2 },
      { field: 'branch.b2.gpsLng', before: 58.1, after: 58.2 },
    ];
    markManualGps(b1, REASON);
    const all = [...b1, ...b2];
    expect(manualGpsReasonForBranch(all, 'b1')).toBe(REASON);
    expect(manualGpsReasonForBranch(all, 'b2')).toBeNull();
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
    expect(manualGpsReasonForPoint(list, 23.61, 58.42)).toBeNull();
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
