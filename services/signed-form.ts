'use server';

/**
 * Owner decisions 2026-10-11 — the signed-application step of the CREDIT
 * new-customer chain (lib/approval-chains.ts): after the Sales Director approves,
 * the credit application is printed, the submitting salesman has the customer
 * sign and stamp it, and uploads a photo or scan of every page here. When he
 * confirms, the request moves on to the Finance Manager.
 *
 * Nobody approves this step (lib/permissions.ts canActOnStep refuses every actor
 * on a SUBMITTER step), so approveEditCore and rejectEditCore can never decide it
 * and "the submitter never approves" stays literally true. The salesman's own
 * upload is the only way through, and it is recorded as what it is: an
 * EditApproval row with decision FORM_UPLOADED (the approval trail, the service
 * levels and separation of duty read it) and an UPDATE audit row — never
 * STEP_APPROVE, so the ledger never reads as a self-approval.
 *
 * Bound to what he saw, like an approver's decision (lib/decision-token.ts): the
 * page renders the request's decision token and this action builds its claim
 * from it, so a confirm made on a page opened before a send-back, a withdraw or
 * a Manager's Remove of a document lands on nothing. The token is also the
 * replay key: a retry whose first try landed is answered from the FORM_UPLOADED
 * row it wrote, not refused (the item-22 fetch route, app/api/forms/[form]) —
 * but only while the request is no longer waiting at the step. Back at it (a
 * Finance Manager send-back since), "sent" would be false: the pages of a page
 * opened before that send-back were never claimed, so it is told to reload.
 */
import { z } from 'zod';
import { EditProcess, EditState, Role, type Prisma } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { src, withChangeContext } from '@/lib/change-context';
import { requireActor } from '@/lib/session';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ROUTE_INACTIVE_MESSAGE,
  ValidationError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { logger } from '@/lib/logger';
import { checkLimit, FORM_LIMIT } from '@/lib/rate-limit';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import {
  DECISION_FORM_UPLOADED,
  isSignedFormStep,
  parseChain,
  stepDeadline,
  stepName,
} from '@/lib/approval-chains';
import { stageSnapshot } from '@/lib/working-hours';
import {
  MISSING_TOKEN_MESSAGE,
  assertDecisionView,
  assertGuaranteesAsViewed,
  parseDecisionToken,
  type DecisionView,
} from '@/lib/decision-token';
import { notifyUsers, resolveStepAudience, settleRequestAlerts } from '@/lib/notifications';
import { MAX_SIGNED_FORM_PAGES, SIGNED_FORM_KIND } from '@/lib/credit-documents';
import { UNWIRED_LIVE } from '@/lib/photo-attach';

/** The answer: the request moved on (or had already, from this same confirm). */
export type SignedFormReceipt = { editId: string; pages: number; replayed: boolean };

/** Where the form puts every refusal about the pages (app/(app)/customers/new/SignedFormUpload.tsx). */
const FIELD = 'signedForm';

// Not exported: a 'use server' module exports async functions only.
const NOT_AT_SIGNED_FORM_MESSAGE =
  'This request is not waiting for your signed application. Reload the page to see where it is.';

const inputSchema = z.object({
  editId: z.string().cuid(),
  attachmentIds: z
    .array(z.string().cuid())
    .min(1, 'Add a photo of the signed and stamped application.')
    .max(MAX_SIGNED_FORM_PAGES, `At most ${MAX_SIGNED_FORM_PAGES} pages.`),
  decisionToken: z.string().max(300).optional(),
});

export async function submitSignedFormAction(input: {
  editId: string;
  attachmentIds: string[];
  decisionToken?: string;
}): SafeAction<SignedFormReceipt> {
  return runAction(() => submitSignedFormCore(input));
}

async function submitSignedFormCore(input: unknown): Promise<SignedFormReceipt> {
  const session = await requireActor(); // F15: refuses a session that must change its password
  if (session.role !== Role.SALESMAN) {
    throw new ForbiddenError('Only the salesman who sent this request uploads its signed application.');
  }
  const lim = await checkLimit(`edit:${session.id}`, FORM_LIMIT);
  if (!lim.ok) throw new RateLimitError(`Slow down — try again in ${lim.retryAfterSec}s.`);

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === 'attachmentIds') {
      // The count's own words; a malformed id is a page to take again.
      const countIssue = issue.code === 'too_small' || issue.code === 'too_big';
      throw new ValidationError({
        [FIELD]: countIssue ? issue.message : 'A page of the signed application is not valid. Take it again.',
      });
    }
    throw new ValidationError({ _form: 'This request could not be read. Reload the page.' });
  }
  const { editId } = parsed.data;
  const attachmentIds = [...new Set(parsed.data.attachmentIds)];
  if (attachmentIds.length !== parsed.data.attachmentIds.length) {
    throw new ValidationError({ [FIELD]: 'The same page is in the list twice. Remove one of them.' });
  }

  const edit = await prisma.customerEdit.findUnique({
    where: { id: editId },
    select: {
      id: true,
      process: true,
      state: true,
      submittedById: true,
      approvalChain: true,
      currentStepIndex: true,
      cycle: true,
      stageEnteredAt: true,
      slaDueAt: true,
      submittedAt: true,
      requestedCreditLimit: true,
      requestedPaymentTermDays: true,
      customerDraft: { select: { legalName: true } },
      branchDrafts: { select: { routeId: true, route: { select: { code: true, regionId: true } } } },
      submittedBy: { select: { supervisorId: true } },
    },
  });
  // A new-customer request is private to the salesman who sent it.
  if (!edit || edit.process !== EditProcess.CREATE || edit.submittedById !== session.id) {
    throw new NotFoundError('Request not found.');
  }

  // N01: the request as his page showed it. None is "reload".
  const expected = parseDecisionToken(parsed.data.decisionToken);
  if (!expected) throw new ValidationError({ _form: MISSING_TOKEN_MESSAGE }, MISSING_TOKEN_MESSAGE);

  const chain = parseChain(edit.approvalChain);
  const step = chain[edit.currentStepIndex];
  if (edit.state !== EditState.SUBMITTED || !isSignedFormStep(step)) {
    // A retry of a confirm that landed finds the request already moved on.
    const replay = await landed(editId, session.id, expected);
    if (replay) return replay;
    throw new ConflictError('NOT_PENDING', NOT_AT_SIGNED_FORM_MESSAGE);
  }
  const nextStep = chain[edit.currentStepIndex + 1];
  if (!nextStep) throw new ConflictError('NOT_PENDING', NOT_AT_SIGNED_FORM_MESSAGE);

  // The rule of a resubmit (services/creates.ts): his request only from the
  // route it was started on, and only while that route is active.
  const me = await prisma.user.findUniqueOrThrow({
    where: { id: session.id },
    select: { ownedRoute: { select: { id: true, code: true, isActive: true } } },
  });
  if (!me.ownedRoute) throw new ForbiddenError('You have no route assigned — ask your supervisor.');
  if (!me.ownedRoute.isActive) throw new ForbiddenError(ROUTE_INACTIVE_MESSAGE);
  const startedOn = [
    ...new Set(edit.branchDrafts.filter((b) => b.routeId !== me.ownedRoute!.id).map((b) => b.route.code)),
  ].join(', ');
  if (startedOn) {
    throw new ConflictError(
      'EDIT_LOCKED',
      `This request was started on route ${startedOn}, and you now work route ${me.ownedRoute.code}, so its signed application cannot be sent from here. Withdraw it, and the salesman of route ${startedOn} adds the shop afresh.`
    );
  }

  // N01: the page he confirmed on still shows the request as it is. One that
  // does not is stale, even when an upload from it landed before: the request
  // is waiting at the step again (a Finance Manager send-back), so these pages
  // were never sent, and "sent" would leave it waiting with nothing on the way
  // (review, 2026-10-11). He reloads and sees what the step holds now.
  assertDecisionView(expected, edit);

  // Every page: live, his own capture, taken as a signed-application page, on no
  // customer or branch, and on no other request.
  const pages = await prisma.attachment.findMany({
    where: { id: { in: attachmentIds } },
    select: {
      id: true,
      kind: true,
      deletedAt: true,
      capturedById: true,
      customerId: true,
      branchId: true,
      branchExtraId: true,
      editId: true,
    },
  });
  const byId = new Map(pages.map((p) => [p.id, p]));
  for (const id of attachmentIds) {
    const p = byId.get(id);
    if (!p || p.deletedAt) {
      throw new ValidationError({ [FIELD]: 'A page of the signed application was removed. Take it again.' });
    }
    if (p.capturedById !== session.id) {
      throw new ForbiddenError('You can only use photos you captured yourself.');
    }
    if (p.kind !== SIGNED_FORM_KIND) {
      throw new ValidationError({ [FIELD]: 'A photo here was taken for another slot. Take it again as a page of the signed application.' });
    }
    if (p.customerId || p.branchId || p.branchExtraId || (p.editId && p.editId !== editId)) {
      throw new ValidationError({ [FIELD]: 'A page here is already on another record. Take it again.' });
    }
  }

  const regionIds = [...new Set(edit.branchDrafts.map((b) => b.route.regionId))];
  const requestName = edit.customerDraft?.legalName ?? '—';
  const env = await getAuditEnvelope(session.id);
  const now = new Date();
  try {
    await withChangeContext(
      prisma,
      { actorId: session.id, source: src.edit(editId) },
      async (tx) => {
        // The claim is built from the token, not from the row read above: the
        // check and the write are one statement (as approveEditCore's advance).
        const claim = await tx.customerEdit.updateMany({
          where: {
            id: editId,
            submittedById: session.id,
            state: EditState.SUBMITTED,
            currentStepIndex: expected.stepIndex,
            cycle: expected.cycle,
            stageEnteredAt: expected.stageEnteredAt,
            requestedCreditLimit: expected.creditLimit,
            requestedPaymentTermDays: expected.paymentTermDays,
          },
          data: {
            currentStepIndex: expected.stepIndex + 1,
            pendingRole: nextStep.role,
            stageEnteredAt: now,
            slaDueAt: stepDeadline(now, nextStep.slaHours),
            // New stage, new SLA clock (see approveEditCore's advance).
            escalationLevel: 0,
            slaBreachedAt: null,
            lastEscalatedAt: null,
          },
        });
        if (claim.count === 0) {
          throw new ConflictError('NOT_PENDING', NOT_AT_SIGNED_FORM_MESSAGE);
        }
        // The documents he saw (credit documents, and the pages he kept after a
        // send-back) are still exactly the live ones — under the claim's lock.
        await assertGuaranteesAsViewed(tx, edit, expected);
        // His pages, claimed by this request; the count must match.
        const claimed = await tx.attachment.updateMany({
          where: {
            id: { in: attachmentIds },
            ...UNWIRED_LIVE,
            capturedById: session.id,
            kind: SIGNED_FORM_KIND,
            OR: [{ editId: null }, { editId }],
          },
          data: { editId },
        });
        if (claimed.count !== attachmentIds.length) {
          throw new ConflictError(
            'PHOTO_CONFLICT',
            'A page of the signed application was just used or removed elsewhere. Reload the page and check the pages.'
          );
        }
        // A page claimed by an earlier upload and not in this list is released
        // (soft-deleted, as a resubmit releases a dropped photo): after a Finance
        // Manager send-back, what he dropped is gone and what he kept stays.
        // Gap 15 (lossless paths): the fingerprint is kept, and each released
        // page has its SOFT_DELETE row.
        const released = await tx.attachment.findMany({
          where: { editId, kind: SIGNED_FORM_KIND, deletedAt: null, id: { notIn: attachmentIds } },
          select: { id: true, capturedById: true, capturedAt: true, hash: true },
          orderBy: { id: 'asc' },
        });
        if (released.length > 0) {
          await tx.attachment.updateMany({
            where: { id: { in: released.map((a) => a.id) }, deletedAt: null },
            data: { deletedAt: now },
          });
          for (const a of released) {
            await writeAudit(tx, env, {
              action: 'SOFT_DELETE',
              entityType: 'Attachment',
              entityId: a.id,
              reason: 'released: a page of the signed application left out of the new upload',
              before: {
                kind: SIGNED_FORM_KIND,
                editId,
                capturedById: a.capturedById,
                capturedAt: a.capturedAt.toISOString(),
                hash: a.hash,
              } as Prisma.InputJsonValue,
            });
          }
        }
        await tx.editApproval.create({
          data: {
            editId,
            cycle: edit.cycle,
            stepIndex: expected.stepIndex,
            role: step!.role,
            decision: DECISION_FORM_UPLOADED,
            actorId: session.id,
            // Item 9: the stage as it stood when he completed it.
            ...stageSnapshot(edit, now),
          },
        });
        await writeAudit(tx, env, {
          action: 'UPDATE',
          entityType: 'CustomerEdit',
          entityId: editId,
          reason: 'signed credit application uploaded by the salesman',
          after: {
            stepIndex: expected.stepIndex,
            cycle: edit.cycle,
            pages: attachmentIds.length,
            attachmentIds,
          } as unknown as Prisma.InputJsonValue,
        });
        // The rows that asked for this step are answered: the print rows held by
        // his supervisor or Managers, and his own must-act and late alerts (a
        // decision settles only other people's rows: lib/notifications.ts).
        await settleRequestAlerts(tx, { editId, submittedById: session.id });
        await tx.notification.updateMany({
          where: {
            editId,
            userId: session.id,
            readAt: null,
            kind: { in: ['SIGNED_FORM_REQUESTED', 'SLA_BREACH'] },
          },
          data: { readAt: now },
        });
        const audience = await resolveStepAudience(
          tx,
          nextStep,
          { id: session.id, supervisorId: edit.submittedBy.supervisorId },
          regionIds
        );
        await notifyUsers(tx, audience, {
          kind: 'EDIT_STAGE_ADVANCED',
          title: 'Approval waiting on you',
          body: `${requestName} — signed credit application uploaded; request advanced to the ${stepName(nextStep)} step.`,
          editId,
        });
      },
      // Same headroom as approveEditCore's advance: claim, the document lock,
      // two attachment writes, the decision, the audit and the fan-out.
      { timeout: 30_000, maxWait: 10_000 }
    );
  } catch (err) {
    // A retry that overlapped its first try: the claim missed because the first
    // one landed. Answered from what it wrote, never refused.
    if (err instanceof ConflictError && err.code === 'NOT_PENDING') {
      const replay = await landed(editId, session.id, expected);
      if (replay) return replay;
    }
    throw err;
  }

  logger.info({ editId, by: session.id, pages: attachmentIds.length }, 'create.signed_form');
  revalidatePath('/work');
  revalidatePath('/today');
  revalidatePath('/approvals');
  return { editId, pages: attachmentIds.length, replayed: false };
}

/**
 * Did a confirm made on this view already land? His FORM_UPLOADED row for the
 * same cycle and step, written at or after the visit the token names — one per
 * visit, so a send-back and a new upload are a new visit with a new entry time.
 *
 * Review (2026-10-11): never while the request is waiting at the step again. A
 * Finance Manager send-back after that upload brings it back, and a page opened
 * before the send-back still finds that upload's row: answered as landed, its
 * new pages would be left unclaimed while the client said "Sent". Read afresh,
 * not from the caller's row, since a claim that missed read it before the miss.
 */
async function landed(editId: string, actorId: string, view: DecisionView): Promise<SignedFormReceipt | null> {
  if (!view.stageEnteredAt) return null;
  const now = await prisma.customerEdit.findUnique({
    where: { id: editId },
    select: { state: true, approvalChain: true, currentStepIndex: true },
  });
  if (!now || (now.state === EditState.SUBMITTED && isSignedFormStep(parseChain(now.approvalChain)[now.currentStepIndex]))) {
    return null;
  }
  const row = await prisma.editApproval.findFirst({
    where: {
      editId,
      actorId,
      cycle: view.cycle,
      stepIndex: view.stepIndex,
      decision: DECISION_FORM_UPLOADED,
      at: { gte: view.stageEnteredAt },
    },
    select: { id: true },
  });
  if (!row) return null;
  const pages = await prisma.attachment.count({
    where: { editId, kind: SIGNED_FORM_KIND, deletedAt: null },
  });
  return { editId, pages, replayed: true };
}
