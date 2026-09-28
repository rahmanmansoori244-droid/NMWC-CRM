/**
 * The Reactivations queue has no button called Reject: a Manager rejects a
 * reactivation with "Keep closed" (ReactivationDecisionForm), which is also what
 * the Manager guide says. The queue's warnings and the approval's two refusals
 * (d6148e8: STATE_CHANGED and a removed or missing evidence photo) told the
 * Manager to "reject" it, naming a button that is not there. They now name the
 * one that is, and this test reads that name off the rendered form — so a
 * relabelled button, or a message back to a bare "reject it", fails here.
 *
 * The page and the real form are rendered with the database, the session and
 * the two server actions mocked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import {
  REACTIVATION_EVIDENCE_NONE_MESSAGE,
  REACTIVATION_EVIDENCE_REMOVED_MESSAGE,
  REACTIVATION_STATE_CHANGED_MESSAGE,
} from '@/lib/status-evidence';

const SALES = 'u-sales';
const B1 = 'b1';

const h = vi.hoisted(() => ({
  items: [] as unknown[],
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u-mgr', role: 'MANAGER', username: 'mgr' } }) }));
vi.mock('@/lib/access', () => ({ loadScope: async () => ({ managedRegionIds: ['g1'] }) }));
vi.mock('@/lib/db', () => ({
  prisma: {
    customerEdit: { findMany: async () => h.items },
    attachment: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        h.rows.filter((r) => args.where.id.in.includes(r.id as string)),
    },
  },
}));
vi.mock('@/services/reactivations', () => ({
  approveReactivationAction: vi.fn(),
  rejectReactivationAction: vi.fn(),
}));

afterEach(cleanup);

function reactivation(id: string, attachmentChanges: unknown[]) {
  return {
    id,
    branchId: B1,
    submittedById: SALES,
    decisionReason: 'Open again.',
    attachmentChanges,
    submittedBy: { fullName: 'Salesman One' },
    customer: { id: 'c1', legalName: `Shop ${id}`, nmwcCode: 'NMWC-1' },
    branch: { id: B1, branchName: 'Main', shopPhotoId: null, signboardPhotoId: null, route: { code: 'C4' } },
  };
}

describe('every reactivation refusal names the button that rejects one', () => {
  it('the form rejects with "Keep closed", and the queue, both refusals and STATE_CHANGED all name it', async () => {
    h.items = [
      reactivation('gone', [{ kind: 'FREE', attachmentId: 'gone-photo', action: 'EVIDENCE' }]),
      reactivation('none', []),
    ];
    h.rows = [{ id: 'gone-photo', deletedAt: new Date(), capturedById: SALES, branchId: B1, branchExtraId: B1 }];
    const { default: Page } = await import('@/app/(app)/reactivations/page');
    render(await Page());
    const [gone, none] = screen.getAllByRole('listitem');

    // The form's reject: no button called Reject anywhere, one that opens the
    // reason box, and the same name on the one that sends it.
    expect(screen.queryAllByRole('button', { name: /reject/i })).toEqual([]);
    const opener = within(gone!).getAllByRole('button')[0]!;
    const label = opener.textContent!;
    expect(label).toBe('Keep closed');
    fireEvent.click(opener);
    expect(within(gone!).getByPlaceholderText('Why are you keeping it closed?')).toBeTruthy();
    expect(within(gone!).getByRole('button', { name: label })).toHaveProperty('type', 'submit');

    const names = new RegExp(`\\buse ${label} to reject (it|this request)\\b`, 'i');
    expect(gone!.textContent!.replace(/\s+/g, ' ')).toMatch(
      new RegExp(`Evidence photo removed since the request was sent — it cannot be approved; use ${label} to reject it\\.`)
    );
    expect(none!.textContent!.replace(/\s+/g, ' ')).toMatch(
      new RegExp(`No evidence photo attached — it cannot be approved; use ${label} to reject it\\.`)
    );
    for (const m of [
      REACTIVATION_EVIDENCE_REMOVED_MESSAGE,
      REACTIVATION_EVIDENCE_NONE_MESSAGE,
      REACTIVATION_STATE_CHANGED_MESSAGE,
    ]) {
      expect(m, m).toMatch(names);
    }
  });
});
