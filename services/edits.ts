'use server';

import { prisma } from '@/lib/db';
import { Role, EditState, EditTarget, type Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import {
  ForbiddenError,
  ValidationError,
  ConflictError,
  NotFoundError,
  RateLimitError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
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
 * Validate that the would-be customer state (existing record + proposed
 * patches) has every mandatory field populated. Returns a flat map of
 * `path -> human message` suitable for ValidationError. Empty map ⇒ complete.
 *
 * Mandatory fields per PRD §6 / completeness scoring:
 *  Customer: legalName, channelId, subChannelId, primaryPhone, contactPerson,
 *            crNumber, crPhotoId
 *  Branch:   address (≥3 chars), gpsLat, gpsLng, dayOfVisit, shopPhotoId,
 *            signboardPhotoId
 */
function collectMissingMandatory(
  customer: {
    legalName: string;
    channelId: string | null;
    subChannelId: string | null;
    primaryPhone: string | null;
    contactPerson: string | null;
    crNumber: string | null;
    crPhotoId: string | null;
    branches: Array<{
      id: string;
      branchCode: string;
      address: string | null;
      gpsLat: number | null;
      gpsLng: number | null;
      dayOfVisit: string | null;
      shopPhotoId: string | null;
      signboardPhotoId: string | null;
    }>;
  },
  customerProposed: Record<string, unknown>,
  branchProposedById: Map<string, Record<string, unknown>>
): Record<string, string> {
  const errors: Record<string, string> = {};
  const merged = (k: keyof typeof customer, fallback: unknown) =>
    customerProposed[k as string] !== undefined ? customerProposed[k as string] : fallback;
  const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

  if (!isStr(merged('legalName', customer.legalName))) {
    errors['customer.legalName'] = 'Legal name is required.';
  }
  if (!isStr(merged('channelId', customer.channelId))) {
    errors['customer.channelId'] = 'Channel is required.';
  }
  if (!isStr(merged('subChannelId', customer.subChannelId))) {
    errors['customer.subChannelId'] = 'Sub-channel is required.';
  }
  if (!isStr(merged('primaryPhone', customer.primaryPhone))) {
    errors['customer.primaryPhone'] = 'Primary phone is required.';
  }
  if (!isStr(merged('contactPerson', customer.contactPerson))) {
    errors['customer.contactPerson'] = 'Contact person is required.';
  }
  if (!isStr(merged('crNumber', customer.crNumber))) {
    errors['customer.crNumber'] = 'CR number is required.';
  }
  // Photos are wired via attachPhotoAction, so we read from the live customer
  // (the edit payload does not carry photoId fields).
  if (!customer.crPhotoId) {
    errors['customer.crPhoto'] = 'CR document photo is required.';
  }

  for (const b of customer.branches) {
    const bp = branchProposedById.get(b.id) ?? {};
    const bMerged = (k: string, fallback: unknown) =>
      bp[k] !== undefined ? bp[k] : fallback;
    const tag = b.branchCode || b.id;
    const addr = bMerged('address', b.address);
    if (!isStr(addr) || (addr as string).trim().length < 3) {
      errors[`branch.${b.id}.address`] = `Branch ${tag}: address is required.`;
    }
    if (!isNum(bMerged('gpsLat', b.gpsLat)) || !isNum(bMerged('gpsLng', b.gpsLng))) {
      errors[`branch.${b.id}.gps`] = `Branch ${tag}: GPS coordinates are required.`;
    }
    if (!isStr(bMerged('dayOfVisit', b.dayOfVisit))) {
      errors[`branch.${b.id}.dayOfVisit`] = `Branch ${tag}: day of visit is required.`;
    }
    if (!b.shopPhotoId) {
      errors[`branch.${b.id}.shopPhoto`] = `Branch ${tag}: shop photo is required.`;
    }
    if (!b.signboardPhotoId) {
      errors[`branch.${b.id}.signboardPhoto`] = `Branch ${tag}: signboard photo is required.`;
    }
  }

  return errors;
}

/**
 * Salesman submits an edit. We collect ALL field changes across the customer
 * and any branches into a single CustomerEdit record (target=CUSTOMER), so
 * the supervisor reviews it as one decision.
 *
 * Concurrency: if there is already a SUBMITTED edit for this customer, block.
 */
/**
 * SafeAction-wrapped public entry. The form receives `{ ok, data?, code?,
 * message?, fields? }` — see lib/errors.ts. Throws are reserved for
 * programmer errors / framework signals (NEXT_REDIRECT).
 */
export async function submitEditAction(
  input: SubmitEditInput
): SafeAction<{ editId: string; state: EditState }> {
  return runAction(() => submitEditCore(input));
}

async function submitEditCore(input: SubmitEditInput): Promise<{ editId: string; state: EditState }> {
  const session = await requireUser();
  const lim = await checkLimit(`edit:${session.id}`, FORM_LIMIT);
  if (!lim.ok) {
    throw new RateLimitError(`Slow down — try again in ${lim.retryAfterSec}s.`);
  }
  const parsed = submitEditSchema.safeParse(input);
  if (!parsed.success) {
    // EL-02: map Zod issue paths to the form's `customer.<f>` / `branch.<id>.<f>`
    // keying so the EnrichmentForm can render the error inline next to the
    // offending field. Without this, salesmen on UAE-edge routes (Buraimi /
    // Khasab) would see a silent submit failure when their GPS captured outside
    // the bounding box.
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const p = issue.path;
      if (p[0] === 'branches' && typeof p[1] === 'number') {
        const idx = p[1] as number;
        const branchId = (input as { branches?: Array<{ branchId?: string }> })
          .branches?.[idx]?.branchId;
        if (branchId) {
          const sub = p.slice(2).join('.');
          // gpsLat/gpsLng both render under one `gps` slot in the form.
          const key = sub === 'gpsLat' || sub === 'gpsLng' ? 'gps' : sub;
          fields[`branch.${branchId}.${key}`] = issue.message;
          continue;
        }
      }
      if (p[0] === 'customer') {
        fields[`customer.${p.slice(1).join('.')}`] = issue.message;
        continue;
      }
      fields[p.join('.') || '_form'] = issue.message;
    }
    throw new ValidationError(fields);
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

  // EL-01 (Critical): customer-level CLOSED/SUSPENDED transitions must go
  // through the dedicated reactivation flow, exactly like the branch-level
  // guard further down. Without this, a Salesman could pick "Closed" from the
  // Status select on the edit form and have a Supervisor approve it — fully
  // bypassing the photo-evidence + Manager-only reactivation gate. Mirrors
  // the branch-status guard at the same severity.
  if (
    typeof customerProposed.status === 'string' &&
    customerProposed.status !== customer.status &&
    (customer.status === 'CLOSED' ||
      customer.status === 'SUSPENDED' ||
      customerProposed.status === 'CLOSED' ||
      customerProposed.status === 'SUSPENDED')
  ) {
    // Even Steward/Manager: route status flips through the dedicated action.
    // RBAC-05-021 — no silent bypass via the regular edit form for any role.
    throw new ValidationError({
      'customer.status':
        'Use the close-shop or reactivation action for status changes — not the edit form.',
    });
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

  // Hard duplicate phone check across DIFFERENT customers.
  //
  // EL-03: do NOT leak the colliding customer's `legalName` / NMWC code when
  // the caller has no scope on it. A Muscat salesman trying random phones used
  // to harvest the entire master through the error message. We resolve scope
  // and only show the friendly identifier when the caller can already see the
  // customer; otherwise the message is generic and the detail goes to the log.
  if (typeof customerProposed.primaryPhone === 'string') {
    const norm = customerProposed.primaryPhone;
    const collision = await prisma.customer.findFirst({
      where: {
        primaryPhoneNorm: norm,
        id: { not: customer.id },
        deletedAt: null,
      },
      select: {
        id: true,
        nmwcCode: true,
        legalName: true,
        branches: { select: { routeId: true, regionId: true, deletedAt: true } },
      },
    });
    if (collision) {
      const { canSeeCustomer, loadScope } = await import('@/lib/access');
      const sessionUser = { id: me.id, role: me.role, username: session.username };
      const scope = await loadScope(me.id);
      const visible = canSeeCustomer(sessionUser, collision, scope);
      logger.warn(
        { actor: me.id, phone: norm, dupId: collision.id, dupNmwc: collision.nmwcCode, visible },
        'edit.phone_collision'
      );
      if (visible) {
        throw new ValidationError({
          'customer.primaryPhone': `Phone already used by ${collision.legalName} (${collision.nmwcCode}).`,
        });
      }
      throw new ValidationError({
        'customer.primaryPhone':
          'This phone is already registered to another customer. Ask your supervisor to reconcile.',
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

  // Mandatory-field gate: salesmen cannot SUBMIT a customer for approval until
  // every required field is populated on the would-be-result. They can still
  // save partial work as a DRAFT (isDraft=true) and come back to it. Stewards
  // and Managers (direct-write) bypass this — they may legitimately patch a
  // single field on an incomplete legacy record.
  if (!isDraft && me.role === Role.SALESMAN) {
    const branchProposedById = new Map<string, Record<string, unknown>>();
    for (const bp of bInputs) branchProposedById.set(bp.branchId, bp as Record<string, unknown>);
    const missing = collectMissingMandatory(customer, customerProposed, branchProposedById);
    if (Object.keys(missing).length > 0) {
      throw new ValidationError(missing);
    }
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
      // QA-017 / EL-09 — partial unique index `CustomerEdit_open_per_customer`
      // enforces "one SUBMITTED edit per customer" at the DB level. The
      // PrismaClientKnownRequestError exposes `code` lazily, and through the
      // Server Action SuperJSON wrapper the error sometimes arrives as a plain
      // Error losing its code. We detect both by code and by message substring
      // so the user gets the friendly conflict instead of a 500.
      const code = (err as { code?: string })?.code;
      const message = err instanceof Error ? err.message : '';
      if (code === 'P2002' || /Unique constraint failed/i.test(message)) {
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
    // EL-11/EL-12: stamp lastStatusChangeAt whenever status actually changes
    // so reactivation evidence freshness is anchored to the closure event,
    // not just calendar time.
    if (branchUpdate.status !== undefined) {
      const current = await tx.branch.findUnique({
        where: { id: bp.branchId },
        select: { status: true },
      });
      if (current && current.status !== branchUpdate.status) {
        branchUpdate.lastStatusChangeAt = new Date();
      }
    }
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
/**
 * SafeAction-wrapped public entry. Production-critical: every error
 * thrown inside `approveEditCore` (STATUS_BYPASS, NEEDS_REUPLOAD,
 * DUPLICATE_PHONE, etc.) is converted to a returned `{ ok: false, ... }`
 * payload so the form can render the actionable message inline.
 */
export async function approveEditAction(formData: FormData): SafeAction<void> {
  return runAction(() => approveEditCore(formData));
}

async function approveEditCore(formData: FormData) {
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
  // QA-038: customer might have been merged or soft-deleted between submit and approve.
  if (!edit.customer || edit.customer.deletedAt) {
    throw new NotFoundError('Customer no longer exists (may have been merged or deleted).');
  }
  // RBAC-05-003 / EL-15: pull caller's region scope and pass into
  // canApproveSpecificEdit so a Manager can only approve edits whose customer
  // has at least one branch in their managed regions, and no one can approve
  // their own submission.
  const { loadScope } = await import('@/lib/access');
  const actorScope = await loadScope(session.id);
  const sessionUser = { id: session.id, role: session.role, username: session.username };
  if (
    !canApproveSpecificEdit(sessionUser, edit.submittedBy, {
      customerBranches: edit.customer.branches,
      managedRegionIds: actorScope.managedRegionIds,
    })
  ) {
    throw new ForbiddenError('You are not authorized to approve this edit.');
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

  // EL-01 (defense-in-depth): the submit-time guard rejects salesman /
  // supervisor / steward / manager attempts to flip customer.status to
  // CLOSED or SUSPENDED through the regular edit form — those must go
  // through markBranchClosedAction / requestReactivationAction with photo
  // evidence. But if a fieldChange of `customer.status` somehow ended up
  // in a SUBMITTED edit anyway (DB tampering, future bug, internal abuse),
  // the approve path used to apply it without question. Reject at approve
  // time too so the close-and-reactivate workflow is the only path.
  if (
    typeof customerProposed.status === 'string' &&
    customerProposed.status !== edit.customer.status &&
    (edit.customer.status === 'CLOSED' ||
      edit.customer.status === 'SUSPENDED' ||
      customerProposed.status === 'CLOSED' ||
      customerProposed.status === 'SUSPENDED')
  ) {
    throw new ConflictError(
      'STATUS_BYPASS',
      'This edit changes customer.status — that route is forbidden. Use the close-shop or reactivation action.'
    );
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

  // QA-039 + EL-10: drop branches that have been deleted OR reassigned to a
  // different customer since submission. The submitter's scope on those
  // branches at submit time may no longer hold; rather than write data without
  // a paper trail, we drop them and log the discrepancy.
  const liveBranches = await prisma.branch.findMany({
    where: { id: { in: [...branchProposedById.keys()] }, deletedAt: null },
    select: { id: true, customerId: true, routeId: true },
  });
  const liveBranchIds = new Set(
    liveBranches.filter((b) => b.customerId === edit.customerId).map((b) => b.id)
  );
  const droppedBranchIds = [...branchProposedById.keys()].filter((id) => !liveBranchIds.has(id));
  if (droppedBranchIds.length > 0) {
    logger.warn(
      { editId, customerId: edit.customerId, droppedBranchIds },
      'edit.approve.branches_dropped'
    );
  }
  const branchesPayload = Array.from(branchProposedById.entries())
    .filter(([id]) => liveBranchIds.has(id))
    .map(([branchId, obj]) => ({ branchId, ...obj })) as SubmitEditInput['branches'];

  // EL-04 (Critical): re-run the mandatory-field gate at approve time. The
  // submit-time gate enforces "salesman cannot submit a half-empty record",
  // but photos and other slot data live OUTSIDE `fieldChanges` and can be
  // detached after submit. Without this re-check, an APPROVED record could
  // land with no CR photo / no shop photo simply because the salesman tapped
  // the trash icon between submit and approve. Skip when the submitter was
  // not a Salesman (Steward/Manager direct-write bypasses the gate by design).
  if (submitterUser?.role === Role.SALESMAN) {
    const liveCustomer = await prisma.customer.findUniqueOrThrow({
      where: { id: edit.customerId! },
      include: { branches: { where: { deletedAt: null } } },
    });
    const missing = collectMissingMandatory(
      liveCustomer,
      customerProposed,
      branchProposedById
    );
    if (Object.keys(missing).length > 0) {
      throw new ConflictError(
        'NEEDS_REUPLOAD',
        `Required fields are now missing on this customer (${
          Object.keys(missing).length
        } missing). Reject the edit so the salesman can refill: ${Object.values(missing)
          .slice(0, 3)
          .join(' · ')}${Object.keys(missing).length > 3 ? ' · …' : ''}`
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    // PROD-001 fix: claim the edit atomically by transitioning SUBMITTED→APPROVED
    // in a single statement. If two approvals race, only one updateMany returns
    // count=1; the loser sees count=0 and surfaces a conflict instead of writing
    // a duplicate audit row + replaying applyEditChanges twice.
    const claim = await tx.customerEdit.updateMany({
      where: { id: editId, state: EditState.SUBMITTED },
      data: {
        state: EditState.APPROVED,
        reviewedById: session.id,
        reviewedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      throw new ConflictError(
        'NOT_PENDING',
        'This edit was just decided by another reviewer. Refresh to see the current state.'
      );
    }
    await applyEditChanges(tx, edit.customerId!, customerProposed, branchesPayload, session.id);
    // EL-05: persist the actual diff in the audit log, not just a count, so a
    // forensic Manager can answer "what did Supervisor X approve last week"
    // from `/audit` alone without joining CustomerEdit.fieldChanges manually.
    await tx.auditLog.create({
      data: {
        actorId: session.id,
        action: 'APPROVE',
        entityType: 'CustomerEdit',
        entityId: editId,
        after: {
          customerId: edit.customerId,
          changes: fieldChanges.length,
          fieldChanges: fieldChanges as unknown as Prisma.InputJsonValue,
          droppedBranchIds: droppedBranchIds.length > 0 ? droppedBranchIds : undefined,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  });

  logger.info({ editId, by: session.id }, 'edit.approve');
  revalidatePath(`/approvals`);
  revalidatePath(`/work`);
  revalidatePath(`/customers/${edit.customerId}`);
}

export async function rejectEditAction(formData: FormData): SafeAction<void> {
  return runAction(() => rejectEditCore(formData));
}

async function rejectEditCore(formData: FormData) {
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
    include: {
      submittedBy: { select: { id: true, supervisorId: true } },
      customer: {
        select: { branches: { select: { regionId: true, deletedAt: true } } },
      },
    },
  });
  if (!edit) throw new NotFoundError('Edit not found.');
  if (edit.state !== EditState.SUBMITTED) {
    throw new ConflictError('NOT_PENDING', `Edit is in state ${edit.state}.`);
  }
  // RBAC-05-003 / EL-15: same scope rules as approve. Manager rejecting is
  // also a privileged decision; require region overlap and forbid self-reject.
  const { loadScope: loadScopeReject } = await import('@/lib/access');
  const rejectScope = await loadScopeReject(session.id);
  if (
    !canApproveSpecificEdit(
      { id: session.id, role: session.role, username: session.username },
      edit.submittedBy,
      {
        customerBranches: edit.customer?.branches ?? [],
        managedRegionIds: rejectScope.managedRegionIds,
      }
    )
  ) {
    throw new ForbiddenError('You are not authorized to act on this edit.');
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
