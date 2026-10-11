// @vitest-environment node
/**
 * F1 (2026-10-05): where an inbox row links (lib/notification-links.ts).
 *
 * The defect this pins: a reactivation is decided only on /reactivations
 * (services/edits.ts refuses it on /approvals with WRONG_LANE), yet its SLA
 * breach sent the Manager to /approvals/[id]. The inbox now reads
 * edit.isReactivation, and the two F1 kinds have a home: REACTIVATION_REQUESTED
 * on /reactivations for a Manager, REQUEST_FYI on the request's review page for
 * an approver.
 */
import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import { APPROVER_ROLES, hrefFor } from '@/lib/notification-links';

const row = (kind: string, over: Partial<Parameters<typeof hrefFor>[0]> = {}) => ({
  kind,
  editId: 'e1',
  customerId: 'c1',
  edit: { isReactivation: false },
  ...over,
});

describe('hrefFor', () => {
  it('sends a Manager to /reactivations for anything about a reactivation', () => {
    for (const kind of ['REACTIVATION_REQUESTED', 'SLA_BREACH', 'EDIT_SUBMITTED', 'REQUEST_FYI']) {
      expect(hrefFor(row(kind, { edit: { isReactivation: true } }), Role.MANAGER), kind).toBe('/reactivations');
    }
  });

  it('a REACTIVATION_REQUESTED row still reaches /reactivations once its request is gone', () => {
    // Notification.editId is ON DELETE SET NULL; the kind alone says where it belongs.
    expect(hrefFor(row('REACTIVATION_REQUESTED', { editId: null, edit: null }), Role.MANAGER)).toBe('/reactivations');
  });

  it('the GM opening a reactivation breach reads it on the review page (banner: decided elsewhere)', () => {
    expect(hrefFor(row('SLA_BREACH', { edit: { isReactivation: true } }), Role.GM)).toBe('/approvals/e1');
  });

  it('an Accountant told for information goes to the review page', () => {
    expect(hrefFor(row('REQUEST_FYI'), Role.ACCOUNTANT)).toBe('/approvals/e1');
    expect(hrefFor(row('REQUEST_FYI', { edit: { isReactivation: true } }), Role.ACCOUNTANT)).toBe('/approvals/e1');
  });

  it('keeps the existing review links for ordinary requests', () => {
    expect(hrefFor(row('EDIT_SUBMITTED'), Role.MANAGER)).toBe('/approvals/e1');
    expect(hrefFor(row('EDIT_STAGE_ADVANCED'), Role.FINANCE_MANAGER)).toBe('/approvals/e1');
    expect(hrefFor(row('SLA_BREACH'), Role.GM)).toBe('/approvals/e1');
  });

  it('the Sales Director opens a request on its review page, as the GM does (owner decisions 2026-10-11)', () => {
    for (const kind of ['EDIT_STAGE_ADVANCED', 'SLA_BREACH', 'EDIT_SUBMITTED']) {
      expect(hrefFor(row(kind), Role.SALES_DIRECTOR), kind).toBe('/approvals/e1');
      expect(hrefFor(row(kind), Role.SALES_DIRECTOR)).toBe(hrefFor(row(kind), Role.GM));
    }
    expect(APPROVER_ROLES).toContain(Role.SALES_DIRECTOR);
  });

  it('owner decisions 2026-10-11: the salesman’s signed-application alert, and a late one, open his own request', () => {
    const r = row('SIGNED_FORM_REQUESTED', { customerId: null });
    expect(hrefFor(r, Role.SALESMAN)).toBe('/customers/new?edit=e1');
    expect(hrefFor(row('SLA_BREACH', { customerId: null }), Role.SALESMAN)).toBe('/customers/new?edit=e1');
    // An approver's late row about the same request still opens its review page.
    expect(hrefFor(row('SLA_BREACH', { customerId: null }), Role.MANAGER)).toBe('/approvals/e1');
    // The print row to a supervisor or Manager is an ordinary review row.
    expect(hrefFor(row('EDIT_STAGE_ADVANCED', { customerId: null }), Role.MANAGER)).toBe('/approvals/e1');
  });

  it('roles that cannot open /approvals fall back to the customer, then to /work', () => {
    expect(hrefFor(row('SLA_BREACH', { edit: { isReactivation: true } }), Role.STEWARD)).toBe('/customers/c1');
    expect(hrefFor(row('EDIT_APPROVED_FINAL'), Role.SALESMAN)).toBe('/customers/c1');
    expect(hrefFor(row('EDIT_NEEDS_CORRECTION', { customerId: null }), Role.SALESMAN)).toBe('/work');
    expect(hrefFor(row('TEMIX_UPLOAD_READY'), Role.STEWARD)).toBe('/temix');
  });
});
