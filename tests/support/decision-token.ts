/**
 * N01 test support: the decision token a freshly loaded approval page would
 * render for a request, read from the database the way the page reads it.
 *
 * Approve and reject refuse a call without a token, so every integration test
 * that decides a request sends one. Tests that hold a token across a change to
 * the request (a correction round, a step-back) are proving the refusal; every
 * other caller takes a fresh one right before deciding.
 */
import type { PrismaClient } from '@prisma/client';
import { decisionTokenFor } from '@/lib/decision-token';

export async function freshDecisionToken(prisma: PrismaClient, editId: string): Promise<string> {
  const row = await prisma.customerEdit.findUniqueOrThrow({
    where: { id: editId },
    select: {
      cycle: true,
      currentStepIndex: true,
      stageEnteredAt: true,
      requestedCreditLimit: true,
      requestedPaymentTermDays: true,
    },
  });
  return decisionTokenFor(row);
}
