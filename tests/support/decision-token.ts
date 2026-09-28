/**
 * N01 test support: the decision token a freshly loaded approval page would
 * render for a request, read from the database the way the page reads it —
 * the row, and for a new-customer request its live guarantee documents.
 *
 * Approve and reject refuse a call without a token, so every integration test
 * that decides a request sends one. Tests that hold a token across a change to
 * the request (a correction round, a step-back, a removed guarantee) are proving
 * the refusal; every other caller takes a fresh one right before deciding.
 */
import type { PrismaClient } from '@prisma/client';
import { decisionTokenFor } from '@/lib/decision-token';

export async function freshDecisionToken(prisma: PrismaClient, editId: string): Promise<string> {
  const row = await prisma.customerEdit.findUniqueOrThrow({
    where: { id: editId },
    select: {
      process: true,
      cycle: true,
      currentStepIndex: true,
      stageEnteredAt: true,
      requestedCreditLimit: true,
      requestedPaymentTermDays: true,
    },
  });
  // The approval page's own query (app/(app)/approvals/[id]/page.tsx).
  const guarantees =
    row.process === 'CREATE'
      ? await prisma.attachment.findMany({
          where: { editId, kind: 'GUARANTEE', deletedAt: null },
          select: { id: true },
        })
      : [];
  return decisionTokenFor(
    row,
    guarantees.map((g) => g.id)
  );
}
