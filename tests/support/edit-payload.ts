/**
 * Phase 2 test support: the body the customer edit form sends (patch v2,
 * lib/validation/edit.ts), built from the fields a test wants to send.
 *
 * Every key sent carries the value the form would have loaded for it — read
 * from the database now, the way freshDecisionToken reads a request — so the
 * body says "change this from what is live". A test proving a stale form passes
 * its own base instead (`customerBase` / a branch's `base`), which wins over the
 * read. Keys whose value is undefined are not sent, as the form does not send
 * an untouched field. GPS accuracy, capture time and a typed-in reason carry no
 * base: they travel with the point.
 */
import type { PrismaClient } from '@prisma/client';
import {
  BRANCH_EDIT_SELECT,
  CUSTOMER_EDIT_SELECT,
  EDIT_PAYLOAD_VERSION,
  GPS_COMPANIONS,
  toBaseValue,
  type BaseValue,
} from '@/lib/edit-values';
import type { SubmitEditInput } from '@/lib/validation/edit';

export type EditPatch = {
  customerId: string;
  isDraft?: boolean;
  submissionId?: string;
  customer?: Record<string, unknown>;
  customerBase?: Record<string, BaseValue>;
  customerOverrides?: string[];
  branches?: Array<{ branchId: string; base?: Record<string, BaseValue>; overrides?: string[] } & Record<string, unknown>>;
};

const NO_BASE: ReadonlySet<string> = new Set(['gpsManualReason', ...GPS_COMPANIONS]);

const sent = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export async function editPayload(prisma: PrismaClient, patch: EditPatch): Promise<SubmitEditInput> {
  const live = await prisma.customer.findUniqueOrThrow({
    where: { id: patch.customerId },
    select: { ...CUSTOMER_EDIT_SELECT, branches: { select: { id: true, ...BRANCH_EDIT_SELECT } } },
  });
  const liveCustomer = live as unknown as Record<string, unknown>;
  const customer = sent(patch.customer ?? {});
  const customerBase: Record<string, BaseValue> = {};
  for (const k of Object.keys(customer)) customerBase[k] = toBaseValue(liveCustomer[k]);

  const branches = (patch.branches ?? []).map(({ branchId, base: given, overrides, ...rest }) => {
    const fields = sent(rest);
    const liveBranch = live.branches.find((b) => b.id === branchId) as Record<string, unknown> | undefined;
    const base: Record<string, BaseValue> = {};
    for (const k of Object.keys(fields)) {
      if (!NO_BASE.has(k)) base[k] = toBaseValue(liveBranch?.[k]);
    }
    return { branchId, ...fields, base: { ...base, ...given }, ...(overrides ? { overrides } : {}) };
  });

  return {
    v: EDIT_PAYLOAD_VERSION,
    customerId: patch.customerId,
    ...(patch.isDraft !== undefined ? { isDraft: patch.isDraft } : {}),
    ...(patch.submissionId ? { submissionId: patch.submissionId } : {}),
    customer,
    customerBase: { ...customerBase, ...patch.customerBase },
    ...(patch.customerOverrides ? { customerOverrides: patch.customerOverrides } : {}),
    branches,
  } as SubmitEditInput;
}
