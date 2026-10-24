// @vitest-environment node
/**
 * Gaps 19 and 20 (data audit 2026-10-10, lossless paths): lib/request-evidence.ts.
 *
 *  - a sent request's CREATE audit row is the request as sent;
 *  - an APPROVE row says what was actually written, what was already live, what
 *    the submitter's role was locked out of and the gate's shops;
 *  - a close or reactivation request stores what its evidence was checked
 *    against, and the approval reads it back (or finds the closure in the shop's
 *    dated history).
 */
import { describe, expect, it } from 'vitest';
import {
  approvalOutcome,
  closureFromHistory,
  evidenceEntry,
  readEvidenceEntry,
  sentRequestAudit,
} from '@/lib/request-evidence';

describe('sentRequestAudit', () => {
  it('is the request as sent: what, about whom, when, gated on what, with which chain', () => {
    const at = new Date('2026-10-12T06:00:00.000Z');
    expect(
      sentRequestAudit({
        process: 'UPDATE',
        target: 'BRANCH',
        state: 'SUBMITTED',
        customerId: 'c1',
        branchId: 'b1',
        isReactivation: true,
        fieldChanges: [{ field: 'branch.b1.status', before: 'CLOSED', after: 'ACTIVE' }],
        attachmentChanges: [{ action: 'EVIDENCE', attachmentId: 'a1' }],
        submitGate: null,
        submittedAt: at,
        approvalChain: null,
        pendingRole: 'MANAGER',
        cycle: 1,
        submissionId: 's-1',
        decisionReason: 'Reopened after renovation',
        routeIdAtSubmit: 'r1',
        regionIdsAtSubmit: ['g1'],
      })
    ).toEqual({
      process: 'UPDATE',
      target: 'BRANCH',
      state: 'SUBMITTED',
      customerId: 'c1',
      branchId: 'b1',
      isReactivation: true,
      fieldChanges: [{ field: 'branch.b1.status', before: 'CLOSED', after: 'ACTIVE' }],
      attachmentChanges: [{ action: 'EVIDENCE', attachmentId: 'a1' }],
      submitGate: null,
      submittedAt: '2026-10-12T06:00:00.000Z',
      approvalChain: null,
      pendingRole: 'MANAGER',
      cycle: 1,
      submissionId: 's-1',
      // Gap 18: where it was raised, sealed with the rest.
      routeIdAtSubmit: 'r1',
      regionIdsAtSubmit: ['g1'],
      requestReason: 'Reopened after renovation',
    });
  });

  it('gap 18: a row sent before the columns existed carries null and an empty list', () => {
    const row = sentRequestAudit({
      process: 'UPDATE',
      target: 'CUSTOMER',
      state: 'SUBMITTED',
      customerId: 'c1',
      branchId: null,
      isReactivation: false,
      fieldChanges: [],
      attachmentChanges: [],
      submittedAt: null,
      cycle: 1,
    });
    expect(row).toMatchObject({ routeIdAtSubmit: null, regionIdsAtSubmit: [] });
  });
});

describe('approvalOutcome', () => {
  it('splits what was asked into written, already live and locked out, and names the gate', () => {
    const asked = [
      { field: 'customer.legalName' },
      { field: 'customer.notes' },
      { field: 'branch.b1.dayOfVisit' },
      { field: 'branch.b1.openingHours' },
    ];
    expect(
      approvalOutcome({
        requested: asked,
        // The salesman may not change the legal name: dropped before the decision.
        considered: asked.slice(1),
        apply: [{ field: 'customer.notes' }, { field: 'branch.b1.openingHours' }],
        // An import had already set the visit day.
        converged: ['branch.b1.dayOfVisit'],
        gateBranchIds: ['b1'],
      })
    ).toEqual({
      applied: ['customer.notes', 'branch.b1.openingHours'],
      alreadyLive: ['branch.b1.dayOfVisit'],
      lockedOut: ['customer.legalName'],
      gateBranchIds: ['b1'],
    });
  });

  it('no gate (a Steward’s or a Manager’s request, or a close request) is null', () => {
    expect(
      approvalOutcome({ requested: [], considered: [], apply: [], converged: [], gateBranchIds: null }).gateBranchIds
    ).toBeNull();
  });
});

describe('gap 20: what the evidence was checked against', () => {
  const att = { id: 'a1', kind: 'FREE', capturedAt: new Date('2026-10-12T05:00:00.000Z') };

  it('is stored with the request and read back', () => {
    const closed = new Date('2026-09-01T08:00:00.000Z');
    const entry = evidenceEntry(att, closed);
    expect(entry).toEqual({
      kind: 'FREE',
      attachmentId: 'a1',
      action: 'EVIDENCE',
      evidenceCapturedAt: '2026-10-12T05:00:00.000Z',
      branchLastStatusChangeAt: '2026-09-01T08:00:00.000Z',
    });
    expect(readEvidenceEntry([entry])).toEqual({
      attachmentId: 'a1',
      evidenceCapturedAt: '2026-10-12T05:00:00.000Z',
      branchLastStatusChangeAt: '2026-09-01T08:00:00.000Z',
    });
  });

  it('a shop with no closure time on file is stored as none (null), a request from before as not recorded (undefined)', () => {
    expect(readEvidenceEntry([evidenceEntry(att, null)]).branchLastStatusChangeAt).toBeNull();
    expect(readEvidenceEntry([{ kind: 'FREE', attachmentId: 'a1', action: 'EVIDENCE' }])).toEqual({
      attachmentId: 'a1',
      evidenceCapturedAt: null,
      branchLastStatusChangeAt: undefined,
    });
    expect(readEvidenceEntry(null).attachmentId).toBeNull();
  });

  it('the closure from the dated history: when the current CLOSED stretch began', () => {
    const t = (d: string) => new Date(`2026-${d}T00:00:00.000Z`);
    // Newest first: a visit-day change while closed, the closure, earlier active rows.
    expect(
      closureFromHistory([
        { status: 'CLOSED', changeKind: 'UPDATE', validFrom: t('10-05') },
        { status: 'CLOSED', changeKind: 'UPDATE', validFrom: t('09-20') },
        { status: 'ACTIVE', changeKind: 'UPDATE', validFrom: t('08-01') },
        { status: 'ACTIVE', changeKind: 'BASELINE', validFrom: t('01-01') },
      ])
    ).toEqual(t('09-20'));
  });

  it('closed since before history began (the stretch starts on the baseline), or not closed: unknown', () => {
    const t = new Date('2026-01-01T00:00:00.000Z');
    expect(
      closureFromHistory([
        { status: 'CLOSED', changeKind: 'UPDATE', validFrom: new Date('2026-10-01T00:00:00Z') },
        { status: 'CLOSED', changeKind: 'BASELINE', validFrom: t },
      ])
    ).toBeNull();
    expect(closureFromHistory([{ status: 'ACTIVE', changeKind: 'UPDATE', validFrom: t }])).toBeNull();
    expect(closureFromHistory([])).toBeNull();
  });
});
