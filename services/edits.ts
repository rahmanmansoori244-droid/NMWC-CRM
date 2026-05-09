'use server';

import { prisma } from '@/lib/db';
import { Role, EditState, EditTarget, type Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { ForbiddenError, ValidationError, ConflictError, NotFoundError, RateLimitError } from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { isFieldLocked, canApproveSpecificEdit } from '@/lib/permissions';
import { submitEditSchema, type SubmitEditInput } from '@/lib/validation/edit';
import { normalizePhone } from '@/lib/phone';
import { normalizeCR } from '@/lib/cr';
import { scoreCustomer, scoreBranch } from '@/lib/completeness';
import { checkLimit, FORM_LIMIT } from '@/lib/rate-limit';

async function requireUser() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  return session.user;
}

/**
 * Convert a partial branch payload into a list of {field, before, after} diff entries.
 * Drops fields that are unchanged or `undefined`.
 */
type FieldChange = { field: string; before: unknown; after: unknown };

function diffFields(
  previous: Record<string, unknown>,
  proposed: Record<string, unknown>,
  fields: readonly string[]
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of fields) {
    if (!(f in proposed) || proposed[f] === undefined) continue;
    if (previous[f] === proposed[f]) continue;
    if (
      previous[f] instanceof Date &&
      proposed[f] instanceof Date &&
      (previous[f] as Date).getTime() === (proposed[f] as Date).getTime()
    )
      continue;
    out.push({ field: f, before: previous[f] ?? null, after: proposed[f] ?? null });
  }
  return out;
}

const CUSTOMER_FIELDS = [
  'legalName',
  'paymentTerms',
  'crNumber',
  'channelId',
  'subChannelId',
  'primaryPhone',
  'altPhone',
  'contactPerson',
  'contactRole',
  'status',
  'notes',
] as const;

const BRANCH_FIELDS = [
  'branchName',
  'address',
  'areaDescription',
  'gpsLat',
  'gpsLng',
  'gpsAccuracy',
  'gpsCapturedAt',
  'dayOfVisit',
  'openingHours',
  'deliveryWindow',
  'coolersCount',
  'standsCount',
  'emptyBottlesCount',
  'status',
] as const;

/**
 * Salesman submits an edit. We collect ALL field changes across the customer
 * and any branches into a single CustomerEdit record (target=CUSTOMER), so
 * the supervisor reviews it as one decision.
 *
 * Concurrency: if there is already a SUBMITTED edit for this customer, block.
 */
export async function submitEditAction(input: SubmitEditInput): Promise<{ editId: string; state: EditState }> {
  const session = await requireUser();
  const lim = await checkLimit(`edit:${session.id}`, FORM_LIMIT);
  if (!lim.ok) {
    throw new RateLimitError(`Slow down — try again in ${lim.retryAfterSec}s.`);
  }
  const parsed = submitEditSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]))
    );
  }
  const { customerId, isDraft, customer: cInput, branches: bInputs } = parsed.data;

  // Fetch with branches and verify access
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      branches: { where: { deletedAt: null } },
    },
  });
  if (!customer || customer.deletedAt) throw new NotFoundError('Customer not found.');

  // Salesman scope: at least one branch must belong to his route
  const me = await prisma.user.findUniqueOrThrow({
    where: { id: session.id },
    select: { id: true, ownedRouteId: true, role: true },
  });
  if (me.role === Role.SALESMAN) {
    const onMyRoute = customer.branches.some((b) => b.routeId === me.ownedRouteId);
    if (!onMyRoute) throw new ForbiddenError('This customer is not on your route.');
  } else if (me.role !== Role.STEWARD && me.role !== Role.MANAGER) {
    throw new ForbiddenError(`Role ${me.role} cannot submit edits.`);
  }

  // Concurrency: only one open edit per customer
  if (!isDraft) {
    const existing = await prisma.customerEdit.findFirst({
      where: { customerId, state: EditState.SUBMITTED },
    });
    if (existing) {
      throw new ConflictError(
        'EDIT_LOCKED',
        'A submitted edit is already pending review for this customer.'
      );
    }
  }

  // Apply field locks (Credit customers — Salesman cannot change name/CR)
  const customerProposed: Record<string, unknown> = { ...cInput };
  if (
    me.role === Role.SALESMAN &&
    isFieldLocked('legalName', { id: me.id, role: me.role, username: '' }, customer)
  ) {
    delete customerProposed.legalName;
    delete customerProposed.crNumber;
  }

  // Normalize phone, CR
  if (typeof customerProposed.primaryPhone === 'string') {
    customerProposed.primaryPhone = normalizePhone(customerProposed.primaryPhone) ?? undefined;
  }
  if (typeof customerProposed.altPhone === 'string') {
    customerProposed.altPhone = normalizePhone(customerProposed.altPhone) ?? undefined;
  }
  if (typeof customerProposed.crNumber === 'string') {
    customerProposed.crNumber = customerProposed.crNumber.trim() || undefined;
  }

  // Hard duplicate phone check across DIFFERENT customers
  if (typeof customerProposed.primaryPhone === 'string') {
    const norm = customerProposed.primaryPhone;
    const collision = await prisma.customer.findFirst({
      where: {
        primaryPhoneNorm: norm,
        id: { not: customer.id },
        deletedAt: null,
      },
      select: { id: true, nmwcCode: true, legalName: true },
    });
    if (collision) {
      throw new ValidationError({
        'customer.primaryPhone': `Phone already used by ${collision.legalName} (${collision.nmwcCode}).`,
      });
    }
  }

  // Build customer-level diff
  const customerBefore: Record<string, unknown> = {};
  for (const f of CUSTOMER_FIELDS) customerBefore[f] = (customer as Record<string, unknown>)[f];
  const fieldChanges: FieldChange[] = diffFields(customerBefore, customerProposed, CUSTOMER_FIELDS).map(
    (c) => ({ ...c, field: `customer.${c.field}` })
  );

  // Branch-level diffs
  const branchById = new Map(customer.branches.map((b) => [b.id, b] as const));
  for (const bp of bInputs) {
    const branch = branchById.get(bp.branchId);
    if (!branch) {
      throw new ValidationError({ branchId: `Unknown branch ${bp.branchId}` });
    }
    if (me.role === Role.SALESMAN && me.ownedRouteId && branch.routeId !== me.ownedRouteId) {
      throw new ForbiddenError('You can only edit branches on your route.');
    }
    const branchBefore: Record<string, unknown> = {};
    for (const f of BRANCH_FIELDS) branchBefore[f] = (branch as Record<string, unknown>)[f];

    // Coerce date if string
    const bpClean: Record<string, unknown> = { ...bp };
    if (typeof bpClean.gpsCapturedAt === 'string') {
      bpClean.gpsCapturedAt = new Date(bpClean.gpsCapturedAt);
    }

    // QA-009 fix: status flips between CLOSED/SUSPENDED and ACTIVE must go
    // through the dedicated reactivation flow (Manager-only review with photo
    // evidence), not the regular edit flow.
    if (
      typeof bpClean.status === 'string' &&
      bpClean.status !== branch.status &&
      (branch.status === 'CLOSED' ||
        branch.status === 'SUSPENDED' ||
        bpClean.status === 'CLOSED' ||
        bpClean.status === 'SUSPENDED')
    ) {
      // Steward/Manager direct-write may still flip (admin override).
      if (me.role !== Role.STEWARD && me.role !== Role.MANAGER) {
        throw new ValidationError({
          [`branch.${branch.id}.status`]:
            'Use the close-shop or reactivation action for status changes — not the edit form.',
        });
      }
    }

    diffFields(branchBefore, bpClean, BRANCH_FIELDS).forEach((c) =>
      fieldChanges.push({ ...c, field: `branch.${branch.id}.${c.field}` })
    );
  }

  if (fieldChanges.length === 0 && !isDraft) {
    throw new ValidationError({ _form: 'No changes to submit.' });
  }

  const editState: EditState = isDraft ? EditState.DRAFT : EditState.SUBMITTED;
  const submittedAt = isDraft ? null : new Date();

  // For Steward/Manager: apply directly + audit (no approval queue)
  const isDirectWrite = !isDraft && (me.role === Role.STEWARD || me.role === Role.MANAGER);

  let edit;
  if (isDirectWrite) {
    edit = await prisma.$transaction(async (tx) => {
      const e = await tx.customerEdit.create({
        data: {
          target: EditTarget.CUSTOMER,
          customerId: customer.id,
          state: EditState.APPROVED,
          submittedById: me.id,
          submittedAt: new Date(),
          reviewedById: me.id,
          reviewedAt: new Date(),
          fieldChanges: fieldChanges as unknown as Prisma.InputJsonValue,
          attachmentChanges: [] as unknown as Prisma.InputJsonValue,
        },
      });
      await applyEditChanges(tx, customer.id, customerProposed, bInputs, me.id);
      await tx.auditLog.create({
        data: {
          actorId: me.id,
          action: 'UPDATE',
          entityType: 'Customer',
          entityId: customer.id,
          before: customerBefore as unknown as Prisma.InputJsonValue,
          after: customerProposed as unknown as Prisma.InputJsonValue,
        },
      });
      return e;
    });
  } else {
    try {
      edit = await prisma.customerEdit.create({
        data: {
          target: EditTarget.CUSTOMER,
          customerId: customer.id,
          state: editState,
          submittedById: me.id,
          submittedAt,
          fieldChanges: fieldChanges as unknown as Prisma.InputJsonValue,
          attachmentChanges: [] as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // QA-017 — partial unique index `CustomerEdit_open_per_customer`
      // enforces "one SUBMITTED edit per customer" at the DB level. Translate
      // the constraint violation into a friendly conflict response.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'P2002'
      ) {
        throw new ConflictError(
          'EDIT_LOCKED',
          'Another submission for this customer was just made. Refresh to see it.'
        );
      }
      throw err;
    }
  }

  logger.info(
    { editId: edit.id, customerId: customer.id, by: me.id, state: editState, changes: fieldChanges.length },
    'edit.submit'
  );

  revalidatePath(`/customers/${customer.id}`);
  revalidatePath('/today');
  revalidatePath('/customers');
  revalidatePath('/work');
  return { editId: edit.id, state: edit.state };
}

async function applyEditChanges(
  tx: Prisma.TransactionClient,
  customerId: string,
  customerProposed: Record<string, unknown>,
  branches: SubmitEditInput['branches'],
  actorId: string
) {
  // Build customer update payload
  const updateCustomer: Record<string, unknown> = {};
  for (const f of CUSTOMER_FIELDS) {
    if (customerProposed[f] !== undefined) {
      updateCustomer[f] = customerProposed[f];
      if (f === 'primaryPhone') updateCustomer.primaryPhoneNorm = customerProposed[f];
      if (f === 'crNumber') updateCustomer.crNumberNorm = normalizeCR(String(customerProposed[f] ?? ''));
    }
  }
  if (Object.keys(updateCustomer).length > 0) {
    updateCustomer.lastEditedById = actorId;
    await tx.customer.update({
      where: { id: customerId },
      data: updateCustomer as Prisma.CustomerUpdateInput,
    });
  }

  // Branches
  for (const bp of branches) {
    const branchUpdate: Record<string, unknown> = {};
    for (const f of BRANCH_FIELDS) {
      const v = (bp as unknown as Record<string, unknown>)[f];
      if (v === undefined) continue;
      branchUpdate[f] = v;
    }
    if (Object.keys(branchUpdate).length === 0) continue;
    branchUpdate.lastEditedById = actorId;
    await tx.branch.update({
      where: { id: bp.branchId },
      data: branchUpdate as Prisma.BranchUpdateInput,
    });
  }

  // Recompute completeness
  const fresh = await tx.customer.findUniqueOrThrow({
    where: { id: customerId },
    include: { branches: { where: { deletedAt: null } } },
  });
  const cScore = scoreCustomer(fresh, fresh.branches);
  await tx.customer.update({ where: { id: customerId }, data: { completenessScore: cScore } });
  for (const b of fresh.branches) {
    const bScore = scoreBranch(b);
    await tx.branch.update({ where: { id: b.id }, data: { completenessScore: bScore } });
  }
}

/**
 * Supervisor approves an edit: applies the changes atomically and writes audit log.
 */
export async function approveEditAction(formData: FormData) {
  const session = await requireUser();
  const editId = String(formData.get('editId') ?? '');
  if (!editId) throw new ValidationError({ editId: 'required' });

  const edit = await prisma.customerEdit.findUnique({
    where: { id: editId },
    include: {
      customer: { include: { branches: { where: { deletedAt: null } } } },
      submittedBy: { select: { id: true, supervisorId: true, fullName: true } },
    },
  });
  if (!edit) throw new NotFoundError('Edit not found.');
  if (edit.state !== EditState.SUBMITTED) {
    throw new ConflictError('NOT_PENDING', `Edit is in state ${edit.state}.`);
  }
  if (!canApproveSpecificEdit({ id: session.id, role: session.role, username: session.username }, edit.submittedBy)) {
    throw new ForbiddenError('You are not the supervisor for this edit.');
  }
  // QA-038: customer might have been merged or soft-deleted between submit and approve.
  if (!edit.customer || edit.customer.deletedAt) {
    throw new NotFoundError('Customer no longer exists (may have been merged or deleted).');
  }

  // Reconstruct payloads from fieldChanges array
  const fieldChanges = edit.fieldChanges as unknown as FieldChange[];
  const customerProposed: Record<string, unknown> = {};
  const branchProposedById = new Map<string, Record<string, unknown>>();
  for (const c of fieldChanges) {
    if (c.field.startsWith('customer.')) {
      customerProposed[c.field.slice('customer.'.length)] = c.after;
    } else if (c.field.startsWith('branch.')) {
      const rest = c.field.slice('branch.'.length);
      const dot = rest.indexOf('.');
      if (dot < 0) continue;
      const branchId = rest.slice(0, dot);
      const fieldName = rest.slice(dot + 1);
      const obj = branchProposedById.get(branchId) ?? {};
      obj[fieldName] = c.after;
      branchProposedById.set(branchId, obj);
    }
  }

  // QA-013: re-evaluate field locks against the CURRENT customer state. If
  // payment terms changed CASH→CREDIT between submit and approve, the locked
  // fields should now be dropped.
  const submitter = edit.submittedBy as { id: string; supervisorId: string | null; fullName: string };
  const submitterUser = await prisma.user.findUnique({ where: { id: submitter.id }, select: { role: true } });
  if (
    submitterUser?.role === Role.SALESMAN &&
    isFieldLocked(
      'legalName',
      { id: submitter.id, role: Role.SALESMAN, username: '' },
      edit.customer
    )
  ) {
    delete customerProposed.legalName;
    delete customerProposed.crNumber;
  }

  // QA-014: re-check duplicate phone against the current state of the master.
  if (typeof customerProposed.primaryPhone === 'string') {
    const norm = customerProposed.primaryPhone;
    const collision = await prisma.customer.findFirst({
      where: {
        primaryPhoneNorm: norm,
        id: { not: edit.customerId! },
        deletedAt: null,
      },
      select: { nmwcCode: true, legalName: true },
    });
    if (collision) {
      throw new ConflictError(
        'DUPLICATE_PHONE',
        `Phone now belongs to ${collision.legalName} (${collision.nmwcCode}). Reject and ask the salesman to fix.`
      );
    }
  }

  // QA-039: drop branches that have been deleted since submission.
  const liveBranches = await prisma.branch.findMany({
    where: { id: { in: [...branchProposedById.keys()] }, deletedAt: null },
    select: { id: true },
  });
  const liveBranchIds = new Set(liveBranches.map((b) => b.id));
  const branchesPayload = Array.from(branchProposedById.entries())
    .filter(([id]) => liveBranchIds.has(id))
    .map(([branchId, obj]) => ({ branchId, ...obj })) as SubmitEditInput['branches'];

  await prisma.$transaction(async (tx) => {
    await applyEditChanges(tx, edit.customerId!, customerProposed, branchesPayload, session.id);
    await tx.customerEdit.update({
      where: { id: editId },
      data: {
        state: EditState.APPROVED,
        reviewedById: session.id,
        reviewedAt: new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: session.id,
        action: 'APPROVE',
        entityType: 'CustomerEdit',
        entityId: editId,
        after: { customerId: edit.customerId, changes: fieldChanges.length } as unknown as Prisma.InputJsonValue,
      },
    });
  });

  logger.info({ editId, by: session.id }, 'edit.approve');
  revalidatePath(`/approvals`);
  revalidatePath(`/work`);
  revalidatePath(`/customers/${edit.customerId}`);
}

export async function rejectEditAction(formData: FormData) {
  const session = await requireUser();
  const editId = String(formData.get('editId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const category = String(formData.get('category') ?? 'other').trim();
  if (!editId) throw new ValidationError({ editId: 'required' });
  if (reason.length < 5 || reason.length > 1000) {
    throw new ValidationError({ reason: 'Reason must be 5–1000 characters.' });
  }

  const edit = await prisma.customerEdit.findUnique({
    where: { id: editId },
    include: { submittedBy: { select: { id: true, supervisorId: true } } },
  });
  if (!edit) throw new NotFoundError('Edit not found.');
  if (edit.state !== EditState.SUBMITTED) {
    throw new ConflictError('NOT_PENDING', `Edit is in state ${edit.state}.`);
  }
  if (
    !canApproveSpecificEdit(
      { id: session.id, role: session.role, username: session.username },
      edit.submittedBy
    )
  ) {
    throw new ForbiddenError('You are not the supervisor for this edit.');
  }

  await prisma.customerEdit.update({
    where: { id: editId },
    data: {
      state: EditState.NEEDS_CORRECTION,
      reviewedById: session.id,
      reviewedAt: new Date(),
      decisionReason: reason,
      decisionCategory: category,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: session.id,
      action: 'REJECT',
      entityType: 'CustomerEdit',
      entityId: editId,
      reason,
    },
  });

  logger.info({ editId, by: session.id, category }, 'edit.reject');
  revalidatePath('/approvals');
  revalidatePath('/work');
  revalidatePath(`/customers/${edit.customerId}`);
}
