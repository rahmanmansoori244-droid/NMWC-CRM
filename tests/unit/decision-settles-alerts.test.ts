// @vitest-environment node
/**
 * Launch fix (2026-10-07): a decision settles the rows that asked for it.
 *
 * services/notifications-actions.ts was the only place that set
 * Notification.readAt, so when one of MCT's four Managers decided a request, the
 * salesman's direct supervisor kept its EDIT_SUBMITTED row unread, and his red bell
 * counted work that was already done. Now every decision path marks the rows that
 * asked anyone but the submitter to act on (or chase) that request read, on the
 * deciding transaction, before the next step's rows are written.
 *
 * Two halves: what settleRequestAlerts marks (against an in-memory table), and a
 * structural guard that every decision path calls it in the right place — the
 * defect was "nobody called it" (CLAUDE.md, Tests). Comments are stripped first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Prisma } from '@prisma/client';
import { settleRequestAlerts } from '@/lib/notifications';
import { SETTLED_ON_DECISION_KINDS, MUST_ACT_KINDS } from '@/lib/notify-policy';
import { stripComments } from '../support/strip-comments';

type Row = { id: string; userId: string; kind: string; editId: string | null; readAt: Date | null };

function table(rows: Row[]) {
  const tx = {
    notification: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { editId: string; readAt: null; kind: { in: string[] }; userId: { not: string } };
        data: { readAt: Date };
      }) => {
        const hit = rows.filter(
          (r) =>
            r.editId === where.editId &&
            r.readAt === null &&
            where.kind.in.includes(r.kind) &&
            r.userId !== where.userId.not
        );
        for (const r of hit) r.readAt = data.readAt;
        return { count: hit.length };
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, unread: () => rows.filter((r) => r.readAt === null).map((r) => r.id).sort() };
}

describe('settleRequestAlerts', () => {
  it('marks every approver’s must-act and breach rows about the request read, and nothing else', async () => {
    const earlier = new Date('2026-10-01T05:00:00Z');
    const { tx, unread } = table([
      { id: 'sup-asked', userId: 'sup', kind: 'EDIT_SUBMITTED', editId: 'e1', readAt: null },
      { id: 'mgr-asked', userId: 'mgr-b', kind: 'REACTIVATION_REQUESTED', editId: 'e1', readAt: null },
      { id: 'step-asked', userId: 'fm', kind: 'EDIT_STAGE_ADVANCED', editId: 'e1', readAt: null },
      { id: 'breach', userId: 'mgr-c', kind: 'SLA_BREACH', editId: 'e1', readAt: null },
      // Information, the submitter's own progress ping, another request, a row already read:
      { id: 'fyi', userId: 'acc', kind: 'REQUEST_FYI', editId: 'e1', readAt: null },
      { id: 'his-ping', userId: 'sal', kind: 'EDIT_STAGE_ADVANCED', editId: 'e1', readAt: null },
      { id: 'other-edit', userId: 'sup', kind: 'EDIT_SUBMITTED', editId: 'e2', readAt: null },
      { id: 'read', userId: 'mgr-d', kind: 'EDIT_SUBMITTED', editId: 'e1', readAt: earlier },
    ]);
    expect(await settleRequestAlerts(tx, { editId: 'e1', submittedById: 'sal' })).toBe(4);
    expect(unread()).toEqual(['fyi', 'his-ping', 'other-edit']);
  });

  it('the kinds it settles are the must-act kinds and SLA breaches', () => {
    expect([...SETTLED_ON_DECISION_KINDS].sort()).toEqual([...MUST_ACT_KINDS, 'SLA_BREACH'].sort());
  });
});

const src = (path: string) => stripComments(readFileSync(path, 'utf8'), path);

/** The text of one top-level `async function name(` up to the next one. */
function fnBody(s: string, name: string): string {
  const start = s.indexOf(`async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = s.indexOf('\nasync function ', start + 1);
  return s.slice(start, next === -1 ? undefined : next);
}

/** Every `settleRequestAlerts(tx, …)` in `s` comes after a claim and before the next notifyUsers. */
function settlesBeforeNotifying(s: string, expected: number) {
  const calls = [...s.matchAll(/settleRequestAlerts\(tx, \{ editId, submittedById: edit\.submittedById \}\)/g)];
  expect(calls.length).toBe(expected);
  for (const c of calls) {
    const at = c.index!;
    const claim = s.lastIndexOf('const claim = await tx.customerEdit.updateMany(', at);
    expect(claim, 'a claim before it').toBeGreaterThan(-1);
    const notify = s.indexOf('notifyUsers(tx,', at);
    expect(notify, 'a notification after it').toBeGreaterThan(at);
  }
}

describe('every decision path settles the rows that asked for it', () => {
  it('approve: on the step advance, the new-customer finalize and the update apply', () => {
    settlesBeforeNotifying(fnBody(src('services/edits.ts'), 'approveEditCore'), 3);
  });

  it('reject: before the step-back rows and the salesman’s row', () => {
    const s = fnBody(src('services/edits.ts'), 'rejectEditCore');
    settlesBeforeNotifying(s, 1);
    const settle = s.indexOf('settleRequestAlerts(tx,');
    expect(s.indexOf("kind: 'EDIT_STAGE_ADVANCED'")).toBeGreaterThan(settle);
    expect(s.indexOf("kind: 'EDIT_NEEDS_CORRECTION'")).toBeGreaterThan(settle);
  });

  it.each(['approveReactivationCore', 'rejectReactivationCore'])('%s', (fn) => {
    settlesBeforeNotifying(fnBody(src('services/reactivations.ts'), fn), 1);
  });
});
