'use server';

import { prisma } from '@/lib/db';
import { runBulk, type BulkOutcome } from '@/lib/bulk-run';
import { Role, EditState, EditTarget, EditProcess, type Prisma } from '@prisma/client';
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
import { redirect } from 'next/navigation';
import { logger } from '@/lib/logger';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';
import { isFieldLocked, canActOnStep } from '@/lib/permissions';
import { submitEditSchema, type SubmitEditInput } from '@/lib/validation/edit';
import { normalizePhone } from '@/lib/phone';
import { markManualGps, takeManualGpsReason, type FieldChange } from '@/lib/gps-manual';
import { normalizeCR } from '@/lib/cr';
import { scoreCustomer, scoreBranch } from '@/lib/completeness';
import { checkLimit, FORM_LIMIT } from '@/lib/rate-limit';
import { answerIfLanded, findReceipt, ownOpenRequestMessage } from '@/lib/submission-replay';
import { submissionIdSchema, type SubmitReceipt } from '@/lib/submission';
import {
  resolveChain,
  parseChain,
  isFinalStep,
  stepDeadline,
  resolveRejectTarget,
} from '@/lib/approval-chains';
import { resolveStepAudience, resolveStewardAudience, notifyUsers } from '@/lib/notifications';
import { finalizeCreateInTx, assertFinalizable } from '@/lib/create-finalize';
import { salesmanSubmitGate, isRequired, type SubmitGate } from '@/lib/submit-gate';

async function requireUser() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  return session.user;
}

/**
 * Convert a partial branch payload into a list of {field, before, after} diff entries.
 * Drops fields that are unchanged or `undefined`.
 */
// FieldChange comes from lib/gps-manual: it carries item 41's optional marker.

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
    paymentTerms: 'CASH' | 'CREDIT';
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
  branchProposedById: Map<string, Record<string, unknown>>,
  /**
   * 2026-05-11: when the actor is a SALESMAN, fields they cannot edit
   * (legalName always, crNumber on CREDIT) are NOT their responsibility.
   * Skip them from the missing-list so the salesman is never blocked by
   * data only the Steward can fix.
   */
  actorIsSalesman = false,
  /** Go-live: FULL (PRD §6) or CORE — see lib/submit-gate.ts. */
  gate: SubmitGate = salesmanSubmitGate()
): Record<string, string> {
  const errors: Record<string, string> = {};
  const merged = (k: keyof typeof customer, fallback: unknown) =>
    customerProposed[k as string] !== undefined ? customerProposed[k as string] : fallback;
  const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const req = (field: string) => isRequired(field, gate);

  // Lock-aware skips for salesman actor.
  const skipLegalName = actorIsSalesman; // always locked for salesman
  const skipCrNumber = actorIsSalesman && customer.paymentTerms === 'CREDIT';

  if (!skipLegalName && !isStr(merged('legalName', customer.legalName))) {
    errors['customer.legalName'] = 'Legal name is required.';
  }
  if (!isStr(merged('channelId', customer.channelId))) {
    errors['customer.channelId'] = 'Channel is required.';
  }
  if (req('subChannelId') && !isStr(merged('subChannelId', customer.subChannelId))) {
    errors['customer.subChannelId'] = 'Sub-channel is required.';
  }
  if (!isStr(merged('primaryPhone', customer.primaryPhone))) {
    errors['customer.primaryPhone'] = 'Primary phone is required.';
  }
  if (!isStr(merged('contactPerson', customer.contactPerson))) {
    errors['customer.contactPerson'] = 'Contact person is required.';
  }
  if (req('crNumber') && !skipCrNumber && !isStr(merged('crNumber', customer.crNumber))) {
    errors['customer.crNumber'] = 'CR number is required.';
  }
  // Photos are wired via attachPhotoAction, so we read from the live customer
  // (the edit payload does not carry photoId fields).
  if (req('crPhoto') && !customer.crPhotoId) {
    errors['customer.crPhoto'] = 'CR document photo is required.';
  }

  for (const b of customer.branches) {
    const bp = branchProposedById.get(b.id) ?? {};
    const bMerged = (k: string, fallback: unknown) => (bp[k] !== undefined ? bp[k] : fallback);
    const tag = b.branchCode || b.id;
    const addr = bMerged('address', b.address);
    if (!isStr(addr) || (addr as string).trim().length < 3) {
      errors[`branch.${b.id}.address`] = `Branch ${tag}: address is required.`;
    }
    if (!isNum(bMerged('gpsLat', b.gpsLat)) || !isNum(bMerged('gpsLng', b.gpsLng))) {
      errors[`branch.${b.id}.gps`] = `Branch ${tag}: GPS coordinates are required.`;
    }
    if (req('dayOfVisit') && !isStr(bMerged('dayOfVisit', b.dayOfVisit))) {
      errors[`branch.${b.id}.dayOfVisit`] = `Branch ${tag}: day of visit is required.`;
    }
    if (!b.shopPhotoId) {
      errors[`branch.${b.id}.shopPhoto`] = `Branch ${tag}: shop photo is required.`;
    }
    if (req('signboardPhoto') && !b.signboardPhotoId) {
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
export async function submitEditAction(input: SubmitEditInput): SafeAction<SubmitReceipt> {
  return runAction(() => submitEditCore(input));
}

async function submitEditCore(input: SubmitEditInput): Promise<SubmitReceipt> {
  const session = await requireUser();
  // Item 22: a retry of a submit that already landed is answered from what it
  // wrote, before anything else runs — not rate-limited, not re-validated
  // against a customer its own approval may have changed since.
  const submissionId = submissionIdSchema.safeParse(input?.submissionId).data;
  const rawCustomerId = typeof input?.customerId === 'string' ? input.customerId : undefined;
  const receipt = () =>
    rawCustomerId
      ? findReceipt(prisma, session.id, submissionId, {
          process: EditProcess.UPDATE,
          target: EditTarget.CUSTOMER,
          customerId: rawCustomerId,
        })
      : Promise.resolve(null);
  const replayed = await receipt();
  if (replayed) return replayed;
  // …and one that overlapped its first attempt, and was refused by what that
  // attempt changed (the one-open-edit index, "No changes to submit" after a
  // direct write), is answered the same way instead of with the refusal.
  return answerIfLanded(() => submitEditOnce(input, session, submissionId), receipt);
}

async function submitEditOnce(
  input: SubmitEditInput,
  session: Awaited<ReturnType<typeof requireUser>>,
  submissionId: string | undefined
): Promise<SubmitReceipt> {
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
        const branchId = (input as { branches?: Array<{ branchId?: string }> }).branches?.[idx]
          ?.branchId;
        if (branchId) {
          const sub = p.slice(2).join('.');
          // gpsLat/gpsLng (and a typed point's reason) render under one `gps` slot.
          const key = sub === 'gpsLat' || sub === 'gpsLng' || sub === 'gpsManualReason' ? 'gps' : sub;
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
    select: { id: true, ownedRouteId: true, role: true, supervisorId: true },
  });
  // final-hunt #17: a Manager's customer-level authorization (assertCanEditCustomer)
  // is any-branch-overlap — it passes if ANY branch is in a region they manage. On a
  // MULTI-region customer that must NOT let them write a branch in a region they do
  // not manage, so we capture their managed regions here for a per-branch guard in
  // the branch loop below. STEWARD stays unrestricted (data-ops role).
  let managerRegionIds: string[] | null = null;
  if (me.role === Role.SALESMAN) {
    const onMyRoute = customer.branches.some((b) => b.routeId === me.ownedRouteId);
    if (!onMyRoute) throw new ForbiddenError('This customer is not on your route.');
  } else if (me.role === Role.STEWARD || me.role === Role.MANAGER) {
    // SEC-H1: Manager/Steward direct-write must be region-scoped. Previously a
    // MANAGER fell straight through this gate with NO region check, so a
    // Muscat-only Manager could direct-write ANY customer nationwide (broken
    // object-level authorization; the write landed on the master with
    // reviewedById = self, looking self-approved in the audit). Manager region
    // scope is fail-closed everywhere else (read, approve, export) — only this
    // write path skipped it. `assertCanEditCustomer` re-uses that exact rule:
    // it is fail-closed for a Manager whose managedRegions is empty and returns
    // true for STEWARD (all-access data-ops role), so this closes the hole
    // without changing Steward behaviour. Dynamic import matches the existing
    // `@/lib/access` usage pattern in this file.
    const { loadScope, assertCanEditCustomer } = await import('@/lib/access');
    const scope = await loadScope(me.id);
    assertCanEditCustomer({ id: me.id, role: me.role, username: '' }, customer, scope);
    if (me.role === Role.MANAGER) managerRegionIds = scope.managedRegionIds;
  } else {
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
        // Item 22: when the open request is his own, say what it is — after a
        // lost reply this is how he learns his earlier submit arrived.
        existing.submittedById === session.id
          ? ownOpenRequestMessage(existing, { kind: 'update' })
          : 'A submitted edit is already pending review for this customer.'
      );
    }
  }

  // 2026-05-11: separated legalName + crNumber locks. legalName is now
  // locked for SALESMAN regardless of payment terms; crNumber stays locked
  // only when the customer is on CREDIT terms. Steward bypasses both.
  const customerProposed: Record<string, unknown> = { ...cInput };
  const sessionUserShape = { id: me.id, role: me.role, username: '' };
  if (isFieldLocked('legalName', sessionUserShape, customer)) {
    delete customerProposed.legalName;
  }
  if (isFieldLocked('crNumber', sessionUserShape, customer)) {
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

  // P1.3 (2026-05-10): phone duplicates are now ALLOWED across customers.
  // NMWC's real-world data has many shops sharing one owner-phone; the prior
  // hard-block was rejecting legitimate field submissions. We log a soft
  // notice when a phone is already on another customer (useful in steward
  // forensic reviews) but never throw.
  if (typeof customerProposed.primaryPhone === 'string') {
    const norm = customerProposed.primaryPhone;
    const collision = await prisma.customer.findFirst({
      where: { primaryPhoneNorm: norm, id: { not: customer.id }, deletedAt: null },
      select: { id: true, nmwcCode: true },
    });
    if (collision) {
      logger.info(
        { actor: me.id, customerId: customer.id, dupId: collision.id, dupNmwc: collision.nmwcCode },
        'edit.phone_shared_with_other_customer'
      );
    }
  }

  // Build customer-level diff
  const customerBefore: Record<string, unknown> = {};
  for (const f of CUSTOMER_FIELDS) customerBefore[f] = (customer as Record<string, unknown>)[f];
  const fieldChanges: FieldChange[] = diffFields(
    customerBefore,
    customerProposed,
    CUSTOMER_FIELDS
  ).map((c) => ({ ...c, field: `customer.${c.field}` }));

  // Credit status (CASH ↔ CREDIT) is decided at CREATE through the owner-locked
  // SUP→FM→GM→ACC credit chain and is thereafter owned by Temix (the authoritative
  // credit source). It must NEVER ride the single-Supervisor UPDATE chain: the
  // chain is resolved from the customer's CURRENT terms (resolveChain below), so a
  // CASH→CREDIT flip on an enrichment edit would grant CREDIT status — a credit
  // limit/terms and the outbound Temix credit push — with NO finance approval
  // (final-hunt #3). Reject the change here; terms move via a Temix refresh or a
  // fresh credit application, never the enrichment edit. (Mirrors the branch-status
  // guard below: significant lifecycle changes have dedicated lanes.)
  if (fieldChanges.some((c) => c.field === 'customer.paymentTerms')) {
    throw new ValidationError({
      'customer.paymentTerms':
        'Payment terms (CASH/CREDIT) cannot be changed from the customer edit — a credit change requires finance approval and comes from Temix or a new credit application.',
    });
  }

  // Branch-level diffs
  const branchById = new Map(customer.branches.map((b) => [b.id, b] as const));
  // What the direct-write lane applies: the same cleaned values the diff below is
  // built from, not the raw input — otherwise a typed point (item 41) would be
  // recorded with its accuracy cleared while the live branch kept the old one.
  const appliedBranches: Array<Record<string, unknown>> = [];
  for (const bp of bInputs) {
    const branch = branchById.get(bp.branchId);
    if (!branch) {
      throw new ValidationError({ branchId: `Unknown branch ${bp.branchId}` });
    }
    if (me.role === Role.SALESMAN && me.ownedRouteId && branch.routeId !== me.ownedRouteId) {
      throw new ForbiddenError('You can only edit branches on your route.');
    }
    // final-hunt #17: a Manager may only write branches in a region they manage —
    // the customer-level gate above is any-branch-overlap and does not bound which
    // branch of a multi-region customer they can touch (mirrors filterBranchesByScope).
    if (
      me.role === Role.MANAGER &&
      managerRegionIds &&
      !managerRegionIds.includes(branch.regionId)
    ) {
      throw new ForbiddenError('You can only edit branches in a region you manage.');
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

    // Item 41 (owner: option A): a point the salesman TYPED IN keeps that fact,
    // and the reason, on this branch's gps entries — only when the point moves,
    // and with the old accuracy cleared (lib/gps-manual.ts, takeManualGpsReason).
    const manualReason = takeManualGpsReason(branch, bpClean);

    const branchChanges = diffFields(branchBefore, bpClean, BRANCH_FIELDS).map((c) => ({
      ...c,
      field: `branch.${branch.id}.${c.field}`,
    }));
    if (manualReason) markManualGps(branchChanges, manualReason);
    fieldChanges.push(...branchChanges);
    appliedBranches.push(bpClean);
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
    const missing = collectMissingMandatory(
      customer,
      customerProposed,
      branchProposedById,
      /* actorIsSalesman */ true
    );
    if (Object.keys(missing).length > 0) {
      throw new ValidationError(missing);
    }
  }

  const editState: EditState = isDraft ? EditState.DRAFT : EditState.SUBMITTED;
  const submittedAt = isDraft ? null : new Date();

  // Phase 1b: resolve + FREEZE the approval chain onto the edit. Every submit
  // through this action is an enrichment UPDATE (the multi-step create-request
  // flow is a separate action), so the chain is a single Supervisor step —
  // behaviorally identical to the pre-Phase-1b flow. Frozen so an in-flight edit
  // stays deterministic even if the chain matrix later changes.
  const process = EditProcess.UPDATE;
  const chain = resolveChain(process, customer.paymentTerms);
  const firstStep = chain[0]!;
  const chainFields = {
    process,
    approvalChain: chain as unknown as Prisma.InputJsonValue,
    paymentTermsAtSubmit: customer.paymentTerms,
    currentStepIndex: 0,
    // INVARIANT: `cycle` starts at 1 and is never bumped today, because the only
    // way to re-submit after NEEDS_CORRECTION is a brand-new edit row (this action
    // always creates a new CustomerEdit). The step-back cascade + separation-of-
    // duty queries key off `cycle`; if the creation-flow increment adds a
    // "re-submit the SAME create-request" path, it MUST increment `cycle` there,
    // or stale prior-cycle EditApproval rows will poison the reject loop guard.
    cycle: 1,
  };
  // Only a queued (SUBMITTED) edit has a pending step + SLA clock.
  const pendingFields = isDraft
    ? {}
    : {
        pendingRole: firstStep.role,
        stageEnteredAt: submittedAt,
        slaDueAt: submittedAt ? stepDeadline(submittedAt, firstStep.slaHours) : null,
      };

  // For Steward/Manager: apply directly + audit (no approval queue)
  const isDirectWrite = !isDraft && (me.role === Role.STEWARD || me.role === Role.MANAGER);

  let edit;
  if (isDirectWrite) {
    // DG-06: audit rows now carry ip/userAgent. Take the request envelope once,
    // outside the transaction, so nothing extra runs while it is open
    // (services/users.ts does the same).
    const env = await getAuditEnvelope(me.id);
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
          // Item 22: an overlapping retry of this write is refused on the id
          // (the database holds it until this commits), so the master is never
          // written twice — before, it was: two APPROVED edits, two audit rows.
          submissionId,
          ...chainFields,
        },
      });
      await applyEditChanges(
        tx,
        customer.id,
        customerProposed,
        appliedBranches as unknown as SubmitEditInput['branches'],
        me.id
      );
      await writeAudit(tx, env, {
        action: 'UPDATE',
        entityType: 'Customer',
        entityId: customer.id,
        // SEC-03/09 (3): name the path. (UPDATE, Customer) is written by no other
        // code path in the app -- an approved change writes (APPROVE, CustomerEdit)
        // at finalize -- so these rows were already isolable by query. What was
        // missing is human-readable: a Manager reading /audit saw an empty reason
        // cell and no hint that no approver had ever seen this change, while every
        // other deliberate override in this codebase carries one. me.role is the
        // role held AT THE TIME of the write, which a later join to User cannot
        // recover. The prefix is a stable `reason LIKE 'direct-write:%'` anchor.
        reason: `direct-write: applied by ${me.role} with no approval chain`,
        before: customerBefore as unknown as Prisma.InputJsonValue,
        after: customerProposed as unknown as Prisma.InputJsonValue,
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
          submissionId,
          ...chainFields,
          ...pendingFields,
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
    // Tell the first approver a review is waiting (in-app Notification row).
    // Best-effort AFTER the edit exists — an UPDATE submit is a single insert,
    // not a transaction, and losing a notification is tolerable while losing
    // a submit is not. try/catch enforces that contract: a transient notify
    // failure must not convert an already-committed submit into a reported
    // error (the salesman's retry would dead-end on EDIT_LOCKED).
    if (!isDraft) {
      try {
        await notifyUsers(
          prisma,
          await resolveStepAudience(prisma, firstStep, { supervisorId: me.supervisorId }, [
            ...new Set(customer.branches.map((b) => b.regionId)),
          ]),
          {
            kind: 'EDIT_SUBMITTED',
            title: 'Edit awaiting your review',
            body: `${customer.legalName} (${customer.nmwcCode}) — changes submitted for approval.`,
            editId: edit.id,
            customerId: customer.id,
          }
        );
      } catch (err) {
        logger.warn({ editId: edit.id, err: (err as Error).message }, 'edit.submit.notify_failed');
      }
    }
  }

  logger.info(
    {
      editId: edit.id,
      customerId: customer.id,
      by: me.id,
      state: editState,
      changes: fieldChanges.length,
    },
    'edit.submit'
  );

  revalidatePath(`/customers/${customer.id}`);
  revalidatePath('/today');
  revalidatePath('/customers');
  revalidatePath('/work');
  return {
    editId: edit.id,
    state: edit.state,
    submittedAt: edit.submittedAt?.toISOString() ?? null,
    replayed: false,
  };
}

async function applyEditChanges(
  tx: Prisma.TransactionClient,
  customerId: string,
  customerProposed: Record<string, unknown>,
  branches: SubmitEditInput['branches'],
  actorId: string
) {
  // B-05 (Senior-audit 2026-05-10): Optimistic locking on Customer + Branch.
  // We re-read `version` inside the tx (Read Committed sees the latest
  // committed value at statement time) and the updateMany then atomically
  // checks version-match while bumping. If a concurrent direct-write or
  // approve already committed against this customer/branch, count=0 and we
  // throw VERSION_CONFLICT — the actor sees an actionable message instead of
  // silently last-write-wins.
  //
  // The PROD-001 atomic-claim on CustomerEdit prevents two supervisors from
  // approving the same edit in parallel; this protects the orthogonal race —
  // a Manager direct-write landing simultaneously with a Supervisor approve.

  // Build customer update payload
  let appliedAnything = false;
  const updateCustomer: Record<string, unknown> = {};
  for (const f of CUSTOMER_FIELDS) {
    if (customerProposed[f] !== undefined) {
      updateCustomer[f] = customerProposed[f];
      if (f === 'primaryPhone') updateCustomer.primaryPhoneNorm = customerProposed[f];
      if (f === 'crNumber')
        updateCustomer.crNumberNorm = normalizeCR(String(customerProposed[f] ?? ''));
    }
  }
  if (Object.keys(updateCustomer).length > 0) {
    appliedAnything = true;
    updateCustomer.lastEditedById = actorId;
    const currentCustomer = await tx.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { version: true },
    });
    const customerResult = await tx.customer.updateMany({
      where: { id: customerId, version: currentCustomer.version },
      data: {
        ...updateCustomer,
        version: { increment: 1 },
      } as Prisma.CustomerUpdateManyMutationInput,
    });
    if (customerResult.count === 0) {
      throw new ConflictError(
        'VERSION_CONFLICT',
        'This customer was modified by someone else while your changes were processing. Refresh and try again.'
      );
    }
  }

  // Branches — same versioned-updateMany pattern per branch.
  for (const bp of branches) {
    const branchUpdate: Record<string, unknown> = {};
    for (const f of BRANCH_FIELDS) {
      const v = (bp as unknown as Record<string, unknown>)[f];
      if (v === undefined) continue;
      branchUpdate[f] = v;
    }
    if (Object.keys(branchUpdate).length === 0) continue;
    appliedAnything = true;
    branchUpdate.lastEditedById = actorId;
    const currentBranch = await tx.branch.findUniqueOrThrow({
      where: { id: bp.branchId },
      select: { version: true, status: true },
    });
    // EL-11/EL-12: stamp lastStatusChangeAt whenever status actually changes
    // so reactivation evidence freshness is anchored to the closure event,
    // not just calendar time.
    if (branchUpdate.status !== undefined && currentBranch.status !== branchUpdate.status) {
      branchUpdate.lastStatusChangeAt = new Date();
    }
    const branchResult = await tx.branch.updateMany({
      where: { id: bp.branchId, version: currentBranch.version },
      data: { ...branchUpdate, version: { increment: 1 } } as Prisma.BranchUpdateManyMutationInput,
    });
    if (branchResult.count === 0) {
      throw new ConflictError(
        'VERSION_CONFLICT',
        'A branch was modified by someone else while your changes were processing. Refresh and try again.'
      );
    }
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

  // Phase 1 Temix sync: an applied master change re-queues the customer for
  // the next Temix batch. Guarded: SYNCED → obvious; UPLOADED → the change
  // landed AFTER the last batch was generated, so Temix does not have it and
  // the row must re-queue (the batch snapshot keeps its own ids). A row
  // already PENDING_UPLOAD stays put (no double-queue — Blueprint §8.3 "WHERE
  // SYNCED-style guard"), and DEACTIVATE_PENDING is never resurrected.
  // Whole-edit granularity for now — the TEMIX_RELEVANT_FIELDS whitelist is
  // an open owner question (Q-temix-fields); over-queueing is harmless
  // (Temix upserts on the code). Skipped when nothing was actually written
  // (e.g. every branch change was QA-039-dropped) — an all-no-op approval
  // must not churn the queue.
  if (appliedAnything) {
    await tx.customer.updateMany({
      where: { id: customerId, temixSyncState: { in: ['SYNCED', 'UPLOADED'] } },
      data: { temixSyncState: 'PENDING_UPLOAD', temixSyncPendingSince: new Date() },
    });
  }
}

/**
 * Supervisor approves an edit: applies the changes atomically and writes audit log.
 */
/**
 * SafeAction-wrapped public entry. Production-critical: every error
 * thrown inside `approveEditCore` (STATUS_BYPASS, NEEDS_REUPLOAD,
 * VERSION_CONFLICT, etc.) is converted to a returned `{ ok: false, ... }`
 * payload so the form can render the actionable message inline.
 */
export async function approveEditAction(formData: FormData): SafeAction<void> {
  return runAction(() => approveEditCore(formData));
}

/**
 * PERF (audit #31): approve-and-return in ONE round trip. The plain action
 * resolved on the client, which then router.push('/approvals')-ed — a second
 * full Oman round trip, plus the action response wastefully re-rendered the
 * detail page it was about to leave. redirect() inside the action makes the
 * action response CARRY the /approvals RSC payload (revalidatePath already ran
 * in the core, so it is fresh). On failure we return the SafeAction error and
 * the client renders it in place. NEXT_REDIRECT is thrown OUTSIDE runAction so
 * nothing swallows it.
 */
export async function approveEditAndGoAction(formData: FormData): SafeAction<void> {
  const res = await runAction(() => approveEditCore(formData));
  if (res.ok) redirect('/approvals');
  return res;
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
      // Phase 1 creation flow: a CREATE request (customerId = null) carries its
      // proposed payload in typed drafts; approver scope + finalize both read
      // from these instead of edit.customer. The route join gives the CURRENT
      // region — a route can be re-regioned mid-chain, and region-scoped
      // approval must match where the customer will actually materialize.
      customerDraft: true,
      branchDrafts: { include: { route: { select: { regionId: true } } } },
    },
  });
  if (!edit) throw new NotFoundError('Edit not found.');
  if (edit.state !== EditState.SUBMITTED) {
    throw new ConflictError('NOT_PENDING', `Edit is in state ${edit.state}.`);
  }
  // QA-C11 (Critical): a reactivation is a Manager-only decision (region-scoped +
  // photo-evidence gated) handled exclusively by approveReactivationAction. It is
  // created directly (no approvalChain), so the generic step engine would treat it
  // as a single SUPERVISOR step and let the submitter's Supervisor flip the branch
  // CLOSED->ACTIVE — bypassing the Manager gate. Refuse it here; the reactivation
  // action is the only lane.
  if (edit.isReactivation) {
    throw new ConflictError(
      'WRONG_LANE',
      'Reactivation requests are decided from the Reactivations queue by a Manager, not here.'
    );
  }
  const isCreate = edit.process === EditProcess.CREATE;
  if (isCreate) {
    // Integrity: a CREATE row must have its draft payload (written atomically
    // at submit). Fails closed with an actionable code if not.
    assertFinalizable(edit);
  } else if (!edit.customer || edit.customer.deletedAt) {
    // QA-038: customer might have been merged or soft-deleted between submit and approve.
    throw new NotFoundError('Customer no longer exists (may have been merged or deleted).');
  }
  // Phase 1b: step-aware authorization. Resolve the frozen chain + current step;
  // the actor must be authorized for THIS step (canActOnStep) — region scope for
  // scoped steps (Supervisor/Accountant), plus separation of duty (no
  // self-approval; no acting on two DIFFERENT steps of the same edit).
  // For CREATE the scope branches are the DRAFT branches (region-scoped
  // approvers act on where the customer WILL live).
  const { loadScope } = await import('@/lib/access');
  const actorScope = await loadScope(session.id);
  const sessionUser = { id: session.id, role: session.role, username: session.username };
  const scopeBranches = isCreate
    ? edit.branchDrafts.map((d) => ({ regionId: d.route.regionId, deletedAt: null }))
    : edit.customer!.branches;
  const scopeRegionIds = [...new Set(scopeBranches.map((b) => b.regionId))];
  const chain = parseChain(edit.approvalChain);
  const stepIndex = edit.currentStepIndex;
  const step = chain[stepIndex];
  if (!step) throw new ConflictError('NOT_PENDING', 'This edit has no pending step.');
  const priorStepDecisions = await prisma.editApproval.findMany({
    where: { editId, cycle: edit.cycle, stepIndex: { not: stepIndex } },
    select: { actorId: true },
  });
  if (
    !canActOnStep(sessionUser, step, edit.submittedBy, {
      customerBranches: scopeBranches,
      managedRegionIds: actorScope.managedRegionIds,
      priorStepActorIds: priorStepDecisions.map((d) => d.actorId),
    })
  ) {
    throw new ForbiddenError('You are not authorized to act on this step.');
  }

  // DG-06: one audit envelope for the whole action, captured here — after the
  // authorization gate and outside every transaction below. `session.id` (from
  // requireUser()) is the actor for every audit row this function writes. The
  // CREATE-final branch writes none of its own: lib/create-finalize.ts still
  // writes its two rows directly and has not been converted yet.
  const env = await getAuditEnvelope(session.id);

  const isFinal = isFinalStep(chain, stepIndex);
  const requestName = isCreate ? edit.customerDraft!.legalName : edit.customer!.legalName;

  // Non-final step (multi-step CREATE chains): advance the pointer atomically and
  // record the step decision. NO customer data is written until the FINAL step,
  // so the all-or-nothing apply semantics are preserved. UPDATE is a single
  // step, so this branch is never taken for an enrichment edit.
  if (!isFinal) {
    const nextStep = chain[stepIndex + 1]!;
    const advancedAt = new Date();
    await prisma.$transaction(
      async (tx) => {
        const claim = await tx.customerEdit.updateMany({
          where: {
            id: editId,
            state: EditState.SUBMITTED,
            currentStepIndex: stepIndex,
            cycle: edit.cycle,
          },
          data: {
            currentStepIndex: stepIndex + 1,
            pendingRole: nextStep.role,
            stageEnteredAt: advancedAt,
            slaDueAt: stepDeadline(advancedAt, nextStep.slaHours),
            // New stage, new SLA clock: a breach on the PREVIOUS stage must not
            // make this stage skip level-1 escalation (the sweep filters on
            // escalationLevel).
            escalationLevel: 0,
            slaBreachedAt: null,
            lastEscalatedAt: null,
          },
        });
        if (claim.count === 0) {
          throw new ConflictError(
            'NOT_PENDING',
            'This step was just decided by another reviewer. Refresh to see the current state.'
          );
        }
        await tx.editApproval.create({
          data: {
            editId,
            cycle: edit.cycle,
            stepIndex,
            role: step.role,
            decision: 'APPROVED',
            actorId: session.id,
          },
        });
        await writeAudit(tx, env, {
          action: 'STEP_APPROVE',
          entityType: 'CustomerEdit',
          entityId: editId,
          after: {
            stepIndex,
            role: step.role,
            advancedToRole: nextStep.role,
            cycle: edit.cycle,
          } as unknown as Prisma.InputJsonValue,
        });
        // Notify the next step's approvers + the submitter (progress). Inside
        // the tx so a lost claim race never notifies.
        const nextAudience = await resolveStepAudience(
          tx,
          nextStep,
          { supervisorId: edit.submittedBy.supervisorId },
          scopeRegionIds
        );
        await notifyUsers(tx, nextAudience, {
          kind: 'EDIT_STAGE_ADVANCED',
          title: 'Approval waiting on you',
          body: `${requestName} — request advanced to the ${nextStep.role} step.`,
          editId,
          customerId: edit.customerId ?? undefined,
        });
        await notifyUsers(tx, [edit.submittedById], {
          kind: 'EDIT_STAGE_ADVANCED',
          title: 'Request advanced',
          body: `${requestName} — approved at the ${step.role} step; now with ${nextStep.role}.`,
          editId,
          customerId: edit.customerId ?? undefined,
        });
        // Same remote-DB latency headroom as the final apply (final-hunt #32): claim
        // + step-decision + audit + two notification fan-outs must not trip the 5s
        // default interactive-transaction limit.
      },
      { timeout: 30_000, maxWait: 10_000 }
    );
    logger.info(
      { editId, by: session.id, stepIndex, advancedTo: stepIndex + 1 },
      'edit.step_approve'
    );
    revalidatePath('/approvals');
    revalidatePath('/work');
    return;
  }

  // ── FINAL step, CREATE process: materialize the drafts into a real
  // Customer + Branch[] (all-or-nothing, same tx as the claim). ──
  if (isCreate) {
    const finalizedAt = new Date();
    // DG-06: finalizeCreateInTx writes the FINALIZE + CREATE audit rows from
    // inside the transaction below, so it cannot read the request context
    // itself; the envelope is built out here and handed down.
    const finalizeEnv = await getAuditEnvelope(session.id);
    const result = await prisma.$transaction(
      async (tx) => {
        // PROD-001 pattern: claim the edit atomically; loser sees count=0.
        const claim = await tx.customerEdit.updateMany({
          where: {
            id: editId,
            state: EditState.SUBMITTED,
            currentStepIndex: stepIndex,
            cycle: edit.cycle,
          },
          data: {
            state: EditState.APPROVED,
            pendingRole: null,
            reviewedById: session.id,
            reviewedAt: finalizedAt,
          },
        });
        if (claim.count === 0) {
          throw new ConflictError(
            'NOT_PENDING',
            'This request was just decided by another reviewer. Refresh to see the current state.'
          );
        }
        await tx.editApproval.create({
          data: {
            editId,
            cycle: edit.cycle,
            stepIndex,
            role: step.role,
            decision: 'APPROVED',
            actorId: session.id,
          },
        });
        const finalized = await finalizeCreateInTx(
          tx,
          {
            id: edit.id,
            submittedById: edit.submittedById,
            cycle: edit.cycle,
            requestedCreditLimit: edit.requestedCreditLimit,
            requestedPaymentTermDays: edit.requestedPaymentTermDays,
            customerDraft: edit.customerDraft!,
            branchDrafts: edit.branchDrafts,
          },
          finalizeEnv,
          finalizedAt
        );
        // Submitter learns their customer is live; Stewards get the
        // Temix-upload-ready signal (temixSyncState is now PENDING_UPLOAD).
        await notifyUsers(tx, [edit.submittedById], {
          kind: 'EDIT_APPROVED_FINAL',
          title: 'New customer approved',
          body: `${finalized.legalName} is now live as ${finalized.nmwcCode}.`,
          editId,
          customerId: finalized.customerId,
        });
        const stewards = await resolveStewardAudience(tx);
        await notifyUsers(tx, stewards, {
          kind: 'EDIT_APPROVED_FINAL',
          title: 'Ready for Temix upload',
          body: `${finalized.legalName} (${finalized.nmwcCode}) was approved and is queued for the next Temix batch.`,
          editId,
          customerId: finalized.customerId,
        });
        return finalized;
        // Above Prisma's 5s default: finalize fans out ~7 statements per branch
        // (up to 10 branches) plus the identity-lock wait against a concurrent
        // same-shop submit.
      },
      { timeout: 30_000, maxWait: 10_000 }
    );
    logger.info(
      { editId, by: session.id, customerId: result.customerId, nmwcCode: result.nmwcCode },
      'create.finalize'
    );
    revalidatePath('/approvals');
    revalidatePath('/work');
    revalidatePath('/customers');
    revalidatePath(`/customers/${result.customerId}`);
    return;
  }

  // FINAL step of an UPDATE chain. Apply the changes to the live customer.
  // (Non-null: the CREATE process returned above; UPDATE was null-checked at
  // the top of this function.)
  const liveCustomer = edit.customer!;

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

  // A close-shop / branch-status request (markBranchClosedAction) is a salesman-
  // submitted UPDATE whose ONLY change is a branch status flip, gated by its OWN
  // fresh-photo evidence — NOT an enrichment edit. The EL-04 mandatory-field
  // re-check below must therefore skip it: otherwise an imported/legacy customer
  // (no field-captured CR/shop/signboard photos) could never have a branch closed,
  // because collectMissingMandatory scans the WHOLE customer and always fails
  // (final-hunt #1). Any non-status field change keeps the full EL-04 gate.
  const isStatusOnlyEdit =
    fieldChanges.length > 0 &&
    fieldChanges.every((c) => c.field.startsWith('branch.') && c.field.endsWith('.status'));

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
    customerProposed.status !== liveCustomer.status &&
    (liveCustomer.status === 'CLOSED' ||
      liveCustomer.status === 'SUSPENDED' ||
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
  const submitter = edit.submittedBy as {
    id: string;
    supervisorId: string | null;
    fullName: string;
  };
  const submitterUser = await prisma.user.findUnique({
    where: { id: submitter.id },
    select: { role: true },
  });
  // Go-live flow test (2026-09-10): the two locks are INDEPENDENT (2026-05-11 —
  // legalName always locked for a salesman, crNumber only on CREDIT). This block
  // still dropped BOTH whenever legalName was locked, i.e. for EVERY salesman
  // edit — so the CR number a salesman collected on a CASH customer was
  // discarded at approval, and the EL-04 re-check below then failed the
  // approval with "CR number is required". Evaluate each lock on its own.
  if (submitterUser?.role === Role.SALESMAN) {
    const submitterShape = { id: submitter.id, role: Role.SALESMAN, username: '' };
    if (isFieldLocked('legalName', submitterShape, liveCustomer)) {
      delete customerProposed.legalName;
    }
    if (isFieldLocked('crNumber', submitterShape, liveCustomer)) {
      delete customerProposed.crNumber;
    }
  }

  // P1.3 (2026-05-10): phone duplicates are now ALLOWED. Log a soft note
  // for the steward queue but do not block the approval.
  if (typeof customerProposed.primaryPhone === 'string') {
    const norm = customerProposed.primaryPhone;
    const collision = await prisma.customer.findFirst({
      where: { primaryPhoneNorm: norm, id: { not: edit.customerId! }, deletedAt: null },
      select: { id: true, nmwcCode: true },
    });
    if (collision) {
      logger.info(
        { editId, customerId: edit.customerId, dupId: collision.id, dupNmwc: collision.nmwcCode },
        'approve.phone_shared_with_other_customer'
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

  // EL-04 runs INSIDE the apply transaction (below) — see the note there. final-hunt
  // #22: reading the live customer's photo slots outside the tx was a TOCTOU — a
  // concurrent detachPhoto committing between the check and the apply let an APPROVED
  // record land with a missing CR/shop photo.

  await prisma.$transaction(
    async (tx) => {
      // PROD-001 fix: claim the edit atomically by transitioning SUBMITTED→APPROVED
      // in a single statement. If two approvals race, only one updateMany returns
      // count=1; the loser sees count=0 and surfaces a conflict instead of writing
      // a duplicate audit row + replaying applyEditChanges twice.
      const claim = await tx.customerEdit.updateMany({
        where: {
          id: editId,
          state: EditState.SUBMITTED,
          currentStepIndex: stepIndex,
          cycle: edit.cycle,
        },
        data: {
          state: EditState.APPROVED,
          pendingRole: null,
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
      await tx.editApproval.create({
        data: {
          editId,
          cycle: edit.cycle,
          stepIndex,
          role: step.role,
          decision: 'APPROVED',
          actorId: session.id,
        },
      });
      // EL-04 (Critical): re-run the mandatory-field gate at approve time. The
      // submit-time gate enforces "salesman cannot submit a half-empty record", but
      // photos and other slot data live OUTSIDE `fieldChanges` and can be detached
      // after submit. Without this, an APPROVED record could land with no CR/shop
      // photo because the salesman tapped the trash icon between submit and approve.
      // final-hunt #22: read the live customer via `tx` (not the global client) so the
      // check and the apply are in ONE transaction — a concurrent detach can no longer
      // slip between them. Skip for non-salesman submitters (Steward/Manager
      // direct-write) and for status-only close requests (they enrich nothing).
      if (submitterUser?.role === Role.SALESMAN && !isStatusOnlyEdit) {
        const liveCustomer = await tx.customer.findUniqueOrThrow({
          where: { id: edit.customerId! },
          include: { branches: { where: { deletedAt: null } } },
        });
        const missing = collectMissingMandatory(
          liveCustomer,
          customerProposed,
          branchProposedById,
          /* actorIsSalesman */ true
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
      await applyEditChanges(tx, edit.customerId!, customerProposed, branchesPayload, session.id);
      // EL-05: persist the actual diff in the audit log, not just a count, so a
      // forensic Manager can answer "what did Supervisor X approve last week"
      // from `/audit` alone without joining CustomerEdit.fieldChanges manually.
      await writeAudit(tx, env, {
        action: 'APPROVE',
        entityType: 'CustomerEdit',
        entityId: editId,
        after: {
          customerId: edit.customerId,
          changes: fieldChanges.length,
          fieldChanges: fieldChanges as unknown as Prisma.InputJsonValue,
          droppedBranchIds: droppedBranchIds.length > 0 ? droppedBranchIds : undefined,
        } as unknown as Prisma.InputJsonValue,
      });
      await notifyUsers(tx, [edit.submittedById], {
        kind: 'EDIT_APPROVED_FINAL',
        title: 'Edit approved',
        body: `${requestName} — your changes were approved and are now live.`,
        editId,
        customerId: edit.customerId ?? undefined,
      });
      // Match the CREATE finalize timeout (final-hunt #32): an UPDATE apply can
      // touch up to 10 branches + notifications over a remote DB, and the default
      // 5s interactive-transaction limit was tripping legitimately-sized approvals
      // (e.g. a close-shop) with an opaque "Transaction already closed" error.
    },
    { timeout: 30_000, maxWait: 10_000 }
  );

  logger.info({ editId, by: session.id }, 'edit.approve');
  revalidatePath(`/approvals`);
  revalidatePath(`/work`);
  revalidatePath(`/customers/${edit.customerId}`);
}

/**
 * B-11 (Senior-audit 2026-05-10): Bulk approve. Reviewer multi-selects edits
 * in the queue and approves them in one round trip. Each edit goes through
 * `approveEditAction` in its own transaction, so partial failures (a single
 * VERSION_CONFLICT, NEEDS_REUPLOAD, etc.) don't block the
 * other approvals. The result reports per-edit outcomes so the form can
 * surface "12 approved, 1 needs your attention" inline.
 *
 * Hard cap: 50 edits per call to bound the round-trip and keep approveEditCore
 * isolated transactions sane on Neon.
 */
export async function bulkApproveEditsAction(formData: FormData): SafeAction<BulkOutcome> {
  return runAction(async () => {
    await requireUser();
    const raw = String(formData.get('editIds') ?? '[]');
    let editIds: string[];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      editIds = parsed.map((x) => String(x));
    } catch {
      throw new ValidationError({ editIds: 'editIds must be a JSON array of strings.' });
    }
    if (editIds.length === 0) {
      throw new ValidationError({ editIds: 'Pick at least one edit.' });
    }
    if (editIds.length > 50) {
      throw new ValidationError({ editIds: 'Bulk limit is 50 edits per call.' });
    }
    // REL-04: each item commits on its own, so a throw escaping this loop
    // would leave approvals committed and the approver told nothing at all.
    const out = await runBulk(
      editIds,
      (editId) => {
        const fd = new FormData();
        fd.set('editId', editId);
        return approveEditAction(fd);
      },
      {
        onItemError: (editId, err) =>
          logger.warn(
            { editId, err: (err as Error)?.message },
            'edit.bulk.approve.item_threw'
          ),
      }
    );
    logger.info(
      {
        successes: out.successes.length,
        failures: out.failures.length,
        notAttempted: out.notAttempted.length,
      },
      'edit.bulk.approve'
    );
    return out;
  });
}

/**
 * B-11: Bulk reject. Same shape as bulkApprove but applies a single
 * `category` + `reason` to every selected edit.
 */
export async function bulkRejectEditsAction(formData: FormData): SafeAction<BulkOutcome> {
  return runAction(async () => {
    await requireUser();
    const raw = String(formData.get('editIds') ?? '[]');
    const reason = String(formData.get('reason') ?? '').trim();
    const category = String(formData.get('category') ?? 'other').trim();
    if (reason.length < 5 || reason.length > 1000) {
      throw new ValidationError({ reason: 'Reason must be 5–1000 characters.' });
    }
    let editIds: string[];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      editIds = parsed.map((x) => String(x));
    } catch {
      throw new ValidationError({ editIds: 'editIds must be a JSON array of strings.' });
    }
    if (editIds.length === 0) {
      throw new ValidationError({ editIds: 'Pick at least one edit.' });
    }
    if (editIds.length > 50) {
      throw new ValidationError({ editIds: 'Bulk limit is 50 edits per call.' });
    }
    const out = await runBulk(
      editIds,
      (editId) => {
        const fd = new FormData();
        fd.set('editId', editId);
        fd.set('reason', reason);
        fd.set('category', category);
        return rejectEditAction(fd);
      },
      {
        onItemError: (editId, err) =>
          logger.warn({ editId, err: (err as Error)?.message }, 'edit.bulk.reject.item_threw'),
      }
    );
    logger.info(
      {
        successes: out.successes.length,
        failures: out.failures.length,
        notAttempted: out.notAttempted.length,
      },
      'edit.bulk.reject'
    );
    return out;
  });
}

export async function rejectEditAction(formData: FormData): SafeAction<void> {
  return runAction(() => rejectEditCore(formData));
}

/** PERF (audit #31): reject-and-return in one round trip — see approveEditAndGoAction. */
export async function rejectEditAndGoAction(formData: FormData): SafeAction<void> {
  const res = await runAction(() => rejectEditCore(formData));
  if (res.ok) redirect('/approvals');
  return res;
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
        select: {
          legalName: true,
          branches: { select: { regionId: true, deletedAt: true } },
        },
      },
      // Phase 1 creation flow: CREATE requests derive scope + display name
      // from the drafts (customerId is null until finalize). Route join =
      // CURRENT region (matches the approve path).
      customerDraft: { select: { legalName: true } },
      branchDrafts: { select: { route: { select: { regionId: true } } } },
    },
  });
  if (!edit) throw new NotFoundError('Edit not found.');
  if (edit.state !== EditState.SUBMITTED) {
    throw new ConflictError('NOT_PENDING', `Edit is in state ${edit.state}.`);
  }
  // QA-C11 (Critical): reactivations are Manager-only and handled exclusively by
  // rejectReactivationAction — never the generic engine (see approveEditCore).
  if (edit.isReactivation) {
    throw new ConflictError(
      'WRONG_LANE',
      'Reactivation requests are decided from the Reactivations queue by a Manager, not here.'
    );
  }
  const rejectIsCreate = edit.process === EditProcess.CREATE;
  // Phase 1b: step-aware authorization — the rejecter must be the CURRENT step's
  // authorized approver (same rule as approve): region scope for scoped steps +
  // separation of duty (no self-reject; no acting on two different steps).
  const { loadScope: loadScopeReject } = await import('@/lib/access');
  const rejectScope = await loadScopeReject(session.id);
  const rejectScopeBranches = rejectIsCreate
    ? edit.branchDrafts.map((d) => ({ regionId: d.route.regionId, deletedAt: null }))
    : (edit.customer?.branches ?? []);
  const rejectRegionIds = [...new Set(rejectScopeBranches.map((b) => b.regionId))];
  const rejectRequestName = rejectIsCreate
    ? (edit.customerDraft?.legalName ?? '—')
    : (edit.customer?.legalName ?? '—');
  const rejectChain = parseChain(edit.approvalChain);
  const rejectStepIndex = edit.currentStepIndex;
  const rejectStep = rejectChain[rejectStepIndex];
  if (!rejectStep) throw new ConflictError('NOT_PENDING', 'This edit has no pending step.');
  const rejectPriorDecisions = await prisma.editApproval.findMany({
    where: { editId, cycle: edit.cycle, stepIndex: { not: rejectStepIndex } },
    select: { actorId: true },
  });
  if (
    !canActOnStep(
      { id: session.id, role: session.role, username: session.username },
      rejectStep,
      edit.submittedBy,
      {
        customerBranches: rejectScopeBranches,
        managedRegionIds: rejectScope.managedRegionIds,
        priorStepActorIds: rejectPriorDecisions.map((d) => d.actorId),
      }
    )
  ) {
    throw new ForbiddenError('You are not authorized to act on this step.');
  }

  // Owner-confirmed step-back cascade: a rejection returns the request to the
  // previous approver (step N-1); a rejection at the first step returns it to the
  // salesman (NEEDS_CORRECTION). Loop guard: a step rejecting this request a
  // second time in one cycle bails out to the salesman. For a single-step UPDATE
  // (stepIndex 0) this always resolves to the salesman — identical to today.
  const priorRejectsHere = await prisma.editApproval.count({
    where: { editId, cycle: edit.cycle, stepIndex: rejectStepIndex, decision: 'REJECTED' },
  });
  const target = resolveRejectTarget(rejectStepIndex, priorRejectsHere);
  const rejectedAt = new Date();

  // DG-06: envelope outside the transaction; `session.id` is the rejecting actor.
  const env = await getAuditEnvelope(session.id);
  await prisma.$transaction(async (tx) => {
    await tx.editApproval.create({
      data: {
        editId,
        cycle: edit.cycle,
        stepIndex: rejectStepIndex,
        role: rejectStep.role,
        decision: 'REJECTED',
        actorId: session.id,
        reason,
      },
    });
    const data: Prisma.CustomerEditUncheckedUpdateManyInput =
      target.kind === 'STEP_BACK'
        ? {
            currentStepIndex: target.toStepIndex,
            pendingRole: rejectChain[target.toStepIndex]!.role,
            stageEnteredAt: rejectedAt,
            slaDueAt: stepDeadline(rejectedAt, rejectChain[target.toStepIndex]!.slaHours),
            // New stage, new SLA clock (see the advance branch).
            escalationLevel: 0,
            slaBreachedAt: null,
            lastEscalatedAt: null,
            decisionReason: reason,
            decisionCategory: category,
            reviewedById: session.id,
            reviewedAt: rejectedAt,
          }
        : {
            state: EditState.NEEDS_CORRECTION,
            pendingRole: null,
            currentStepIndex: 0,
            // NEEDS_CORRECTION stops the clock; the salesman's rework is not
            // SLA-tracked in v1.
            slaDueAt: null,
            escalationLevel: 0,
            slaBreachedAt: null,
            lastEscalatedAt: null,
            decisionReason: reason,
            decisionCategory: category,
            reviewedById: session.id,
            reviewedAt: rejectedAt,
          };
    const claim = await tx.customerEdit.updateMany({
      where: {
        id: editId,
        state: EditState.SUBMITTED,
        currentStepIndex: rejectStepIndex,
        cycle: edit.cycle,
      },
      data,
    });
    if (claim.count === 0) {
      throw new ConflictError(
        'NOT_PENDING',
        'This edit was just decided by another reviewer. Refresh to see the current state.'
      );
    }
    await writeAudit(tx, env, {
      action: 'REJECT',
      entityType: 'CustomerEdit',
      entityId: editId,
      reason,
      after: {
        target: target.kind,
        fromStep: rejectStepIndex,
        cycle: edit.cycle,
      } as unknown as Prisma.InputJsonValue,
    });
    // Notifications (inside the tx — a lost claim race must not notify).
    if (target.kind === 'STEP_BACK') {
      // The request went back to the previous approver step; tell that step's
      // audience it is waiting on them again, and give the submitter a
      // progress ping (their request has NOT come back to them).
      const backStep = rejectChain[target.toStepIndex]!;
      const backAudience = await resolveStepAudience(
        tx,
        backStep,
        { supervisorId: edit.submittedBy.supervisorId },
        rejectRegionIds
      );
      await notifyUsers(tx, backAudience, {
        kind: 'EDIT_STAGE_ADVANCED',
        title: 'Request returned to your step',
        body: `${rejectRequestName} — rejected at the ${rejectStep.role} step and returned to ${backStep.role} for re-review.`,
        editId,
        customerId: edit.customerId ?? undefined,
      });
      await notifyUsers(tx, [edit.submittedById], {
        kind: 'EDIT_STAGE_ADVANCED',
        title: 'Request stepped back',
        body: `${rejectRequestName} — sent back one step for re-review (not returned to you).`,
        editId,
        customerId: edit.customerId ?? undefined,
      });
    } else {
      await notifyUsers(tx, [edit.submittedById], {
        kind: 'EDIT_NEEDS_CORRECTION',
        title: 'Needs correction',
        body: `${rejectRequestName} — returned to you: ${reason}`,
        editId,
        customerId: edit.customerId ?? undefined,
      });
    }
  });

  logger.info({ editId, by: session.id, category }, 'edit.reject');
  revalidatePath('/approvals');
  revalidatePath('/work');
  revalidatePath(`/customers/${edit.customerId}`);
}
