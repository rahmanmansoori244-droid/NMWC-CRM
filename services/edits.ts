'use server';

import { prisma } from '@/lib/db';
import {
  BULK_DECISION_LIMIT,
  BULK_DECISION_LIMIT_MESSAGE,
  BULK_RUN_FIELD,
  CREDIT_BULK_REFUSED_MESSAGE,
  TEMIX_CODE_BULK_REFUSED_MESSAGE,
  runBulk,
  type BulkOutcome,
} from '@/lib/bulk-run';
import { Role, EditState, EditTarget, EditProcess, PaymentTerms, type Prisma } from '@prisma/client';
import { requireActor } from '@/lib/session';
import {
  ForbiddenError,
  ValidationError,
  ConflictError,
  NotFoundError,
  RateLimitError,
  FormOutdatedError,
  StaleFieldsError,
  ROUTE_INACTIVE_MESSAGE,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { logger } from '@/lib/logger';
import { getAuditEnvelope, writeAudit, type AuditEnvelope } from '@/lib/audit';
import {
  followBranchStatus,
  mergeStatusEvents,
  NO_STATUS_EVENTS,
  statusEvents,
} from '@/lib/customer-status';
import { isFieldLocked, canActOnStep, requestScopeBranches } from '@/lib/permissions';
import {
  EQUIPMENT_UNCONFIRM_MESSAGE,
  isCurrentEditPayload,
  keysWithoutBase,
  submitEditSchema,
  type SubmitEditInput,
} from '@/lib/validation/edit';
import { reportedIssues } from '@/lib/validation/fields';
import { gateScopeOf } from '@/lib/validation/gate-scope';
import {
  BRANCH_EDIT_FIELDS,
  CUSTOMER_EDIT_FIELDS,
  EQUIPMENT_FIELDS,
  GPS_COMPANIONS,
  GPS_POINT_FIELDS,
  branchPath,
  classifyAgainstLive,
  classifyChanges,
  classifyPointAgainstLive,
  fieldSlotKey,
  liveSnapshotOf,
  parseFieldPath,
  sameEditValue,
  slotFields,
  staleSlotMessage,
  toBaseValue,
  type BaseValue,
  type BranchEditField,
  type LiveVerdict,
} from '@/lib/edit-values';
import {
  gateBranchesForApproval,
  parseSubmitGate,
  salesmanBranches,
  submitGateRecord,
} from '@/lib/edit-scope';
import {
  channelPairInvalidMessage,
  planApproval,
  staleBeforeMessage,
  staleFieldLabels,
  storedFieldChanges,
} from '@/lib/edit-approval';
import { resolveChannelPair } from '@/lib/channel-pair';
import { markManualGps, takeManualGpsReason, type FieldChange } from '@/lib/gps-manual';
import { isGpsTooInaccurate, gpsTooInaccurateMessage } from '@/lib/gps-accuracy';
import { normalizeCR } from '@/lib/cr';
import { lockCustomerRow } from '@/lib/locks';
import { assertStatusEvidence, evidenceIds } from '@/lib/status-evidence';
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
import { stageSnapshot } from '@/lib/working-hours';
import {
  MISSING_TOKEN_MESSAGE,
  assertDecisionView,
  assertGuaranteesAsViewed,
  readDecisionToken,
} from '@/lib/decision-token';
import {
  resolveStepAudience,
  resolveStewardAudience,
  notifyUsers,
  settleRequestAlerts,
} from '@/lib/notifications';
import { notifySalesmanRequest } from '@/lib/notify-hierarchy';
import { finalizeCreateInTx, assertFinalizable } from '@/lib/create-finalize';
import { normalizeTemixCode, temixCodeProblem } from '@/lib/temix-code';
import { salesmanSubmitGate, isRequired, type SubmitGate } from '@/lib/submit-gate';
import { openReturnedIds, RETURNED_CLEARED_REASON } from '@/lib/returned-work';

async function requireUser() {
  return requireActor(); // F15: refuses a session that must change its password
}

// FieldChange comes from lib/gps-manual: it carries item 41's optional marker,
// and phase 2's overrodeLive ("Keep mine", ruling 1).

/** A branch's fields keyed by name, as applyEditChanges writes them. */
type BranchWrite = { branchId: string } & Record<string, unknown>;

/**
 * Stored (or planned) changes as the write takes them: the customer's fields,
 * and each branch's by id. `after: null` is a clear and is written as null; an
 * entry that names no edit field is ignored, as the write always ignored it.
 */
function payloadFromFieldChanges(changes: readonly FieldChange[]) {
  const customer: Record<string, unknown> = {};
  const byBranch = new Map<string, Record<string, unknown>>();
  for (const c of changes) {
    const p = parseFieldPath(c.field);
    if (!p) continue;
    if (p.scope === 'customer') {
      customer[p.field] = c.after;
      continue;
    }
    const fields = byBranch.get(p.branchId) ?? {};
    fields[p.field] = c.after;
    byBranch.set(p.branchId, fields);
  }
  const branches: BranchWrite[] = [...byBranch].map(([branchId, fields]) => ({
    branchId,
    ...fields,
  }));
  return { customer, byBranch, branches };
}

/** The channel pair a set of changes writes: absent keys are kept (lib/channel-pair.ts). */
function channelPairOf(customer: Record<string, unknown>) {
  return {
    channelId: customer.channelId as string | null | undefined,
    subChannelId: customer.subChannelId as string | null | undefined,
  };
}

/**
 * F06: the fields a submit named whose value changed after the form was opened.
 * Refused whole, before anything is written, with the value live now for each —
 * for a location or an equipment block, the whole group's, because the form
 * takes the group back as one ("Use this value", ruling 1). A stale channel
 * also hands back the sub-channel saved with it, without naming it: the form's
 * answer on the channel takes it as the sub-channel's base. A sub-channel sent
 * as the value already saved was left out above and is no conflict — but
 * without its saved value the form kept the one the page loaded as its base,
 * and a sub-channel then picked for the new channel was refused as stale a
 * second time (post-merge review of phase 2, finding 2).
 */
function staleFieldsError(
  paths: readonly string[],
  liveCustomer: Readonly<Record<string, unknown>>,
  liveBranches: ReadonlyMap<string, Readonly<Record<string, unknown>>>
): StaleFieldsError {
  const fields: Record<string, string> = {};
  const current: Record<string, BaseValue> = {};
  for (const path of paths) {
    const slot = fieldSlotKey(path);
    fields[slot] = staleSlotMessage(slot);
    const p = parseFieldPath(path);
    if (!p) continue;
    if (p.scope === 'customer') {
      current[path] = toBaseValue(liveCustomer[p.field]);
      if (p.field === 'channelId') {
        current['customer.subChannelId'] = toBaseValue(liveCustomer.subChannelId);
      }
      continue;
    }
    const branch = liveBranches.get(p.branchId);
    for (const f of slotFields(p.field)) {
      current[branchPath(p.branchId, f)] = toBaseValue(branch?.[f]);
    }
  }
  return new StaleFieldsError(fields, current);
}

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
 *
 * F05 (auditor recheck 2026-09-27): the branch checks run on `gateBranches`
 * only — a salesman's own route's branches at submit (lib/edit-scope.ts
 * salesmanBranches), the set frozen on the request at approval
 * (gateBranchesForApproval) — never on every branch of the customer: another
 * route's missing GPS blocked a salesman who could neither see nor edit it.
 * A proposed null (a clear) merges as missing.
 *
 * Owner decision 4 (2026-10-07, lib/validation/gate-scope.ts): callers pass only
 * the branches the request changes, and `customerFields` false when it changes
 * no customer-level field — then the customer's fields are not checked at all.
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
  },
  gateBranches: ReadonlyArray<{
    id: string;
    branchCode: string;
    address: string | null;
    gpsLat: number | null;
    gpsLng: number | null;
    dayOfVisit: string | null;
    shopPhotoId: string | null;
    signboardPhotoId: string | null;
  }>,
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
  gate: SubmitGate = salesmanSubmitGate(),
  /** Owner decision 4: whether the request changes a customer-level field. */
  customerFields = true
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
  // Owner decision 2 (2026-10-07): the CR document follows the CR number.
  const skipCrPhoto = skipCrNumber;

  if (customerFields) {
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
    if (req('crPhoto') && !skipCrPhoto && !customer.crPhotoId) {
      errors['customer.crPhoto'] = 'CR document photo is required.';
    }
  }

  for (const b of gateBranches) {
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
 *
 * Patch v2 (auditor recheck 2026-09-27, phase 2; lib/validation/edit.ts): the
 * form sends only the fields that were touched, each with the value it loaded.
 * Each is judged against the customer as it is now (lib/edit-values.ts): one
 * already holding the new value is left out, one whose loaded value no longer
 * matches is refused with STALE_FIELDS (F06) — so an untouched or stale value
 * can no longer put back something newer. null clears a clearable field (F20).
 */
/**
 * SafeAction-wrapped public entry. The form receives `{ ok, data?, code?,
 * message?, fields?, current? }` — see lib/errors.ts. Throws are reserved for
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

/** The longest branch id an error key is built from (submitEditOnce). */
const MAX_KEYED_BRANCH_ID = 64;

async function submitEditOnce(
  input: SubmitEditInput,
  session: Awaited<ReturnType<typeof requireUser>>,
  submissionId: string | undefined
): Promise<SubmitReceipt> {
  // Launch fix: a draft save has its own bucket. Every save spent one of the 60
  // an hour the submits share, so a salesman who saved often was told "Slow
  // down" when he came to submit. Read off the body before the schema runs: a
  // body that says draft can write nothing but a draft.
  const draftSave = (input as { isDraft?: unknown } | undefined)?.isDraft === true;
  const lim = await checkLimit(`${draftSave ? 'edit-draft' : 'edit'}:${session.id}`, FORM_LIMIT);
  if (!lim.ok) {
    throw new RateLimitError(`Slow down — try again in ${lim.retryAfterSec}s.`);
  }
  // Phase 2: a body without this build's `v` came from a tab opened before the
  // update, whose form sent every field it had loaded — exactly the overwrite
  // F06 removes. Refused whole, before its fields are read one by one. The
  // replay lookup (submitEditCore) has already run, so a retry of a submit that
  // landed before the update is still answered "already received".
  if (!isCurrentEditPayload(input)) throw new FormOutdatedError();
  const parsed = submitEditSchema.safeParse(input);
  if (!parsed.success) {
    // EL-02: map Zod issue paths to the form's `customer.<f>` / `branch.<id>.<f>`
    // keying so the EnrichmentForm can render the error inline next to the
    // offending field. Without this, salesmen on UAE-edge routes (Buraimi /
    // Khasab) would see a silent submit failure when their GPS captured outside
    // the bounding box. Only the first issues, their messages clipped
    // (reportedIssues, lib/validation/fields.ts): a body failing on more fields
    // than that was not built by the form, and every issue used to become a key
    // of the answer.
    const fields: Record<string, string> = {};
    for (const issue of reportedIssues(parsed.error.issues)) {
      const p = issue.path;
      if (p[0] === 'branches' && typeof p[1] === 'number') {
        const idx = p[1] as number;
        const branchId = (input as { branches?: Array<{ branchId?: unknown }> }).branches?.[idx]
          ?.branchId;
        // The id names the key only when it can be a real one (a cuid is 25
        // characters): z.string().cuid() takes any length, and a megabyte-long
        // id was repeated in the key of every field of its branch that failed.
        // Any other is keyed by its place, `branches.<i>.<f>`, as a missing id is.
        if (typeof branchId === 'string' && branchId && branchId.length <= MAX_KEYED_BRANCH_ID) {
          const sub = p.slice(2).join('.');
          const path = sub ? `branch.${branchId}.${sub}` : `branch.${branchId}`;
          // The location's columns (and a typed point's reason) render under one
          // `gps` slot, the equipment block's under one `equipment` slot.
          fields[fieldSlotKey(path)] = issue.message;
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
  // Every key sent must say what it was changed from. One that does not was not
  // built by this build's form: it cannot be told from a stale value.
  if (keysWithoutBase(parsed.data).length > 0) throw new FormOutdatedError();
  const {
    customerId,
    isDraft,
    customer: cInput,
    customerBase,
    customerOverrides,
    branches: bInputs,
  } = parsed.data;

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
    select: {
      id: true,
      ownedRouteId: true,
      role: true,
      supervisorId: true,
      ownedRoute: { select: { isActive: true } },
    },
  });
  // final-hunt #17: a Manager's customer-level authorization (assertCanEditCustomer)
  // is any-branch-overlap — it passes if ANY branch is in a region they manage. On a
  // MULTI-region customer that must NOT let them write a branch in a region they do
  // not manage, so we capture their managed regions here for a per-branch guard in
  // the branch loop below. STEWARD stays unrestricted (data-ops role).
  let managerRegionIds: string[] | null = null;
  if (me.role === Role.SALESMAN) {
    // Launch fix (P2): a switched-off route takes no new request from him, as
    // New customer already refused (services/creates.ts). A draft is still
    // saved: nothing of it goes for approval. A Manager's or Steward's direct
    // write below does not ask.
    if (!isDraft && me.ownedRoute?.isActive === false) {
      throw new ForbiddenError(ROUTE_INACTIVE_MESSAGE);
    }
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

  // F19: phones and the CR number arrive from the schema already checked and
  // normalized (lib/validation/fields.ts). An invalid phone is refused there,
  // for every role — it used to be dropped here without a word.

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

  // F06: each sent field against the customer as read above
  // (lib/edit-values.ts classifyAgainstLive). The value the form loaded still
  // live: a change, recorded with the live value as `before`. The new value
  // already live: nothing to do. Anything else changed after the form was
  // opened, and the whole submit is refused below, before anything is written.
  // A draft skips that refusal and records what was typed (ruling 1): UPDATE
  // drafts are never read back, so nothing can be written from one.
  const stalePaths: string[] = [];
  const plan = (
    path: string,
    loaded: unknown,
    proposed: unknown,
    live: unknown,
    keptMine: boolean,
    // A coordinate takes its point's verdict (classifyPointAgainstLive, below).
    verdict: LiveVerdict = classifyAgainstLive(path, loaded, proposed, live)
  ): FieldChange | null => {
    if (verdict === 'CONVERGED') return null;
    if (verdict === 'STALE' && !isDraft) {
      stalePaths.push(path);
      return null;
    }
    return {
      field: path,
      before: live ?? null,
      after: proposed,
      // Ruling 1, "Keep mine": the sender was shown this value, changed after
      // his form opened, and chose to replace it. The approval page says so.
      ...(keptMine ? { overrodeLive: toBaseValue(live) } : {}),
    };
  };

  const fieldChanges: FieldChange[] = [];
  const customerLoaded = customerBase as Record<string, unknown>;
  const customerKept = new Set<string>(customerOverrides ?? []);
  for (const f of CUSTOMER_EDIT_FIELDS) {
    if (customerProposed[f] === undefined) continue;
    const kept = customerKept.has(f);
    const c = plan(`customer.${f}`, customerLoaded[f], customerProposed[f], customer[f], kept);
    if (c) fieldChanges.push(c);
  }

  // Branch-level changes. Planned after each branch's authorization, so a
  // STALE_FIELDS answer never carries a value of a branch the sender may not edit.
  const branchById = new Map(customer.branches.map((b) => [b.id, b] as const));
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

    // The fields sent; the schema has already made gpsCapturedAt a Date.
    const bpClean: Record<string, unknown> = { ...bp };

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

    // F21, owner decision 3 (2026-09-29): a salesman only ever marks the
    // equipment counted; taking that back is a Steward's or a Manager's call.
    if (bpClean.equipmentConfirmed === false && me.role === Role.SALESMAN) {
      throw new ValidationError({ [`branch.${branch.id}.equipment`]: EQUIPMENT_UNCONFIRM_MESSAGE });
    }

    // Item 41 (owner: option A): a point the salesman TYPED IN keeps that fact,
    // and the reason, on this branch's gps entries — only when the point moves,
    // and with the old accuracy cleared (lib/gps-manual.ts, takeManualGpsReason).
    const manualReason = takeManualGpsReason(branch, bpClean);

    const live = branch as unknown as Record<string, unknown>;
    const loaded = bp.base as Record<string, unknown>;
    const kept = new Set<string>(bp.overrides ?? []);
    const branchChanges: FieldChange[] = [];
    for (const f of BRANCH_EDIT_FIELDS) {
      // The point and what describes it are planned below, as one.
      if (GPS_POINT_FIELDS.has(f) || GPS_COMPANIONS.has(f) || bpClean[f] === undefined) continue;
      const c = plan(branchPath(branch.id, f), loaded[f], bpClean[f], live[f], kept.has(f));
      if (c) branchChanges.push(c);
    }
    // The point is one value (phase-2 review, finding 2). Judged a coordinate at
    // a time, a correction of only the longitude and another writer's correction
    // of only the latitude could both land — a point neither of them entered. So
    // the pair is judged together, and when it moves BOTH coordinates are
    // recorded, the unmoved one at the value it has: the approval and the direct
    // write's re-check under the lock then judge the whole point
    // (lib/edit-values.ts classifyChanges). The schema sends the two together; a
    // coordinate not sent would stand at its live value.
    if ([...GPS_POINT_FIELDS].some((f) => bpClean[f] !== undefined)) {
      const coordinate = (f: BranchEditField, from: Record<string, unknown>) =>
        bpClean[f] === undefined ? live[f] : from[f];
      const pointVerdict = classifyPointAgainstLive(
        { gpsLat: coordinate('gpsLat', loaded), gpsLng: coordinate('gpsLng', loaded) },
        { gpsLat: coordinate('gpsLat', bpClean), gpsLng: coordinate('gpsLng', bpClean) },
        { gpsLat: live.gpsLat, gpsLng: live.gpsLng }
      );
      for (const f of GPS_POINT_FIELDS) {
        const path = branchPath(branch.id, f);
        const proposed = coordinate(f, bpClean);
        const c = plan(path, coordinate(f, loaded), proposed, live[f], kept.has(f), pointVerdict);
        if (c) branchChanges.push(c);
      }
    }
    const planned = (f: BranchEditField) =>
      branchChanges.some((c) => c.field === branchPath(branch.id, f));
    // Ruling 7: the capture time and accuracy describe the point, so they are
    // recorded only with a point that is itself recorded — never beside
    // coordinates that stay as they are.
    if ([...GPS_POINT_FIELDS].some(planned)) {
      for (const f of GPS_COMPANIONS) {
        if (bpClean[f] === undefined || sameEditValue(f, bpClean[f], live[f])) continue;
        const path = branchPath(branch.id, f);
        branchChanges.push({ field: path, before: live[f] ?? null, after: bpClean[f] });
      }
    }
    // F21: entering a count is counting — so a zero beside it is a real zero,
    // worth the score's equipment points. Recorded for any sender who did not
    // say otherwise himself; a hand-made payload gets the same.
    const counts = [...EQUIPMENT_FIELDS].filter((f) => f !== 'equipmentConfirmed');
    const counted =
      counts.some(planned) && !branch.equipmentConfirmed && bpClean.equipmentConfirmed === undefined;
    if (counted) {
      const path = branchPath(branch.id, 'equipmentConfirmed');
      branchChanges.push({ field: path, before: false, after: true });
    }
    if (manualReason) markManualGps(branchChanges, manualReason);
    fieldChanges.push(...branchChanges);
  }

  if (stalePaths.length > 0) throw staleFieldsError(stalePaths, customer, branchById);

  // F16: the channel pair the customer would carry must fit — CREATE's rule
  // (lib/channel-pair.ts), checked only when the channel or the sub-channel
  // changes, so a pair already mismatched on file never blocks an unrelated edit.
  // A channel change that leaves a sub-channel of the old channel clears it, as
  // a change of its own that the approver sees ("Cleared").
  const pair = await resolveChannelPair(prisma, customer, channelPairOf(customerProposed), {
    requireActiveChannel: true,
    clearMisfitSubChannel: true,
  });
  if (!pair.ok) throw new ValidationError({ [pair.field]: pair.message });
  if (pair.changed && pair.clearsSubChannel) {
    customerProposed.subChannelId = null;
    fieldChanges.push({
      field: 'customer.subChannelId',
      before: customer.subChannelId,
      after: null,
    });
  }

  // Credit status (CASH ↔ CREDIT) is decided at CREATE through the owner-locked
  // SUP→FM→GM→ACC credit chain and is thereafter owned by Temix (the authoritative
  // credit source). It must NEVER ride the single-Supervisor UPDATE chain: the
  // chain is resolved from the customer's CURRENT terms (resolveChain below), so a
  // CASH→CREDIT flip on an enrichment edit would grant CREDIT status — a credit
  // limit/terms and the outbound Temix credit push — with NO finance approval
  // (final-hunt #3). Reject the change here; terms move via a Temix refresh or a
  // fresh credit application, never the enrichment edit. (Mirrors the branch-status
  // guard above: significant lifecycle changes have dedicated lanes.)
  if (fieldChanges.some((c) => c.field === 'customer.paymentTerms')) {
    throw new ValidationError({
      'customer.paymentTerms':
        'Payment terms (CASH/CREDIT) cannot be changed from the customer edit — a credit change requires finance approval and comes from Temix or a new credit application.',
    });
  }

  if (fieldChanges.length === 0 && !isDraft) {
    throw new ValidationError({ _form: 'No changes to submit.' });
  }

  // Mandatory-field gate: salesmen cannot SUBMIT a customer for approval until
  // every required field is populated on the would-be-result. They can still
  // save partial work as a DRAFT (isDraft=true) and come back to it. Stewards
  // and Managers (direct-write) bypass this — they may legitimately patch a
  // single field on an incomplete legacy record.
  // F05: on the salesman's own branches only — the live branches on his route
  // as read here, never taken from the payload — and that set is frozen on the
  // request (CustomerEdit.submitGate) for the approval's re-check. It is the
  // rule his page applied when it loaded (salesmanBranches), applied again now,
  // so the two sets can differ (ruling 11): a branch put on his route after his
  // page loaded is gated too, and its error has no slot on that page, shows at
  // the top and tells him to reload (lib/form-errors.ts
  // withReloadHintForUnshownBranches); one taken off his route since is shown
  // but not gated.
  // Owner decision 4 (2026-10-07, lib/validation/gate-scope.ts): of those, only
  // the branches this request changes, and the customer-level fields only when
  // it changes one — a phone fix no longer waits for every shop's GPS and photo.
  // The record still stores ALL his branches here: the approval re-check takes
  // the ones its changes name, and they are the request's home for who may
  // decide it (lib/permissions.ts requestScopeBranches).
  let submitGate: Prisma.InputJsonValue | undefined;
  if (!isDraft && me.role === Role.SALESMAN) {
    const ownBranches = salesmanBranches(customer.branches, me.ownedRouteId);
    const scope = gateScopeOf(fieldChanges.map((c) => c.field));
    const gateBranches = ownBranches.filter((b) => scope.branchIds.has(b.id));
    const branchProposedById = new Map<string, Record<string, unknown>>();
    for (const bp of bInputs) branchProposedById.set(bp.branchId, bp as Record<string, unknown>);
    const missing = collectMissingMandatory(
      customer,
      gateBranches,
      customerProposed,
      branchProposedById,
      /* actorIsSalesman */ true,
      salesmanSubmitGate(),
      /* customerFields */ scope.customer
    );
    // The ±100 m GPS standard (lib/gps-accuracy.ts): a newly captured point
    // worse than the limit is refused here, at submit only. A point not sent
    // (unchanged) or typed in with a reason is not checked.
    for (const bp of bInputs) {
      if (bp.gpsLat === undefined || missing[`branch.${bp.branchId}.gps`]) continue;
      const branch = customer.branches.find((b) => b.id === bp.branchId);
      const moves = !branch || bp.gpsLat !== branch.gpsLat || bp.gpsLng !== branch.gpsLng;
      if (moves && isGpsTooInaccurate(bp.gpsAccuracy, bp.gpsManualReason)) {
        missing[`branch.${bp.branchId}.gps`] = gpsTooInaccurateMessage(
          `Branch ${branch?.branchCode || bp.branchId}`,
          bp.gpsAccuracy as number
        );
      }
    }
    if (Object.keys(missing).length > 0) {
      throw new ValidationError(missing);
    }
    submitGate = submitGateRecord(ownBranches.map((b) => b.id));
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
    // way to re-submit after NEEDS_CORRECTION is a brand-new edit row (a submit
    // always creates a new CustomerEdit; only a DRAFT is saved over in place, and
    // a draft is never submitted from). The step-back cascade + separation-of-
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
  let recorded = fieldChanges.length;
  if (isDirectWrite) {
    // DG-06: audit rows now carry ip/userAgent. Take the request envelope once,
    // outside the transaction, so nothing extra runs while it is open
    // (services/users.ts does the same).
    const env = await getAuditEnvelope(me.id);
    edit = await prisma.$transaction(
      async (tx) => {
        // F06: a direct write has no approver to catch a value that moved, so the
        // plan is judged again under the customer's row lock, against the row as
        // it is now — the same classifyChanges the approval uses. A writer that
        // landed between the read above and this lock (an import, another direct
        // write, an approval) either already set the same value (left out) or
        // makes this a STALE_FIELDS answer. The lock comes first (lib/locks.ts),
        // so a branch-only write no longer takes a branch before its customer.
        await lockCustomerRow(tx, customer.id);
        const now = await tx.customer.findUnique({
          where: { id: customer.id },
          include: { branches: { where: { deletedAt: null } } },
        });
        if (!now || now.deletedAt) throw new NotFoundError('Customer not found.');
        const nowBranches = new Map(now.branches.map((b) => [b.id, b] as const));
        // OCT-01: a waiting import may move a branch out of the Manager's
        // region. Reauthorize the locked snapshot before classifying changes
        // or returning any live conflict values, and before receipt/audit writes.
        const { assertCanEditCustomer } = await import('@/lib/access');
        assertCanEditCustomer(sessionUserShape, now, {
          ownedRouteId: me.ownedRouteId,
          teamRouteIds: [],
          managedRegionIds: managerRegionIds ?? [],
        });
        for (const bp of bInputs) {
          const branch = nowBranches.get(bp.branchId);
          if (!branch) {
            throw new ConflictError(
              'VERSION_CONFLICT',
              'A branch was modified by someone else while your changes were processing. Refresh and try again.'
            );
          }
          if (me.role === Role.MANAGER && !managerRegionIds?.includes(branch.regionId)) {
            throw new ForbiddenError('You can only edit branches in a region you manage.');
          }
        }
        const { apply, stale, droppedBranchIds } = classifyChanges(
          fieldChanges,
          liveSnapshotOf(now, now.branches)
        );
        if (stale.length > 0) throw staleFieldsError(stale.map((s) => s.field), now, nowBranches);
        if (droppedBranchIds.length > 0) {
          throw new ConflictError(
            'VERSION_CONFLICT',
            'A branch was modified by someone else while your changes were processing. Refresh and try again.'
          );
        }
        // An overlapping retry of a write that has just landed finds all of it
        // already live; answerIfLanded answers it with the first one's receipt.
        if (apply.length === 0) throw new ValidationError({ _form: 'No changes to submit.' });
        const write = payloadFromFieldChanges(apply);
        const pairNow = await resolveChannelPair(tx, now, channelPairOf(write.customer), {
          requireActiveChannel: true,
          clearMisfitSubChannel: false,
        });
        if (!pairNow.ok) throw new ValidationError({ [pairNow.field]: pairNow.message });
        recorded = apply.length;
        const e = await tx.customerEdit.create({
          data: {
            target: EditTarget.CUSTOMER,
            customerId: customer.id,
            state: EditState.APPROVED,
            submittedById: me.id,
            submittedAt: new Date(),
            reviewedById: me.id,
            reviewedAt: new Date(),
            fieldChanges: apply as unknown as Prisma.InputJsonValue,
            attachmentChanges: [] as unknown as Prisma.InputJsonValue,
            // Item 22: an overlapping retry of this write is refused on the id
            // (the database holds it until this commits), so the master is never
            // written twice — before, it was: two APPROVED edits, two audit rows.
            submissionId,
            ...chainFields,
          },
        });
        await applyEditChanges(tx, customer.id, write.customer, write.branches, me.id, {
          env,
          via: `direct write by ${me.role}`,
        });
        const customerBefore = Object.fromEntries(
          CUSTOMER_EDIT_FIELDS.map((f) => [f, toBaseValue(now[f])])
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
          after: write.customer as unknown as Prisma.InputJsonValue,
        });
        return e;
      },
      // The lock can wait behind a photo attach or an import on this customer.
      { timeout: 30_000, maxWait: 10_000 }
    );
  } else {
    // Launch fix (returned work): his sent-back updates of this customer that
    // this submit answers. Read before it exists; once it does they no longer
    // wait on him (lib/returned-work.ts), and each gets an audit row naming it.
    const answered = isDraft
      ? []
      : await openReturnedIds(prisma, me.id, { customerId: customer.id, updatesOnly: true });
    const answeredEnv = answered.length > 0 ? await getAuditEnvelope(me.id) : null;
    const submitted: Prisma.CustomerEditUncheckedCreateInput = {
      target: EditTarget.CUSTOMER,
      customerId: customer.id,
      state: editState,
      submittedById: me.id,
      submittedAt,
      fieldChanges: fieldChanges as unknown as Prisma.InputJsonValue,
      attachmentChanges: [] as unknown as Prisma.InputJsonValue,
      submissionId,
      // F05: a salesman's SUBMITTED request carries the branches it was gated on.
      ...(submitGate ? { submitGate } : {}),
      ...chainFields,
      ...pendingFields,
    };
    try {
      if (isDraft) {
        edit = await saveUpdateDraft(me.id, customer.id, {
          fieldChanges: submitted.fieldChanges,
          submissionId,
          ...chainFields,
        });
      } else if (!answeredEnv) {
        edit = await prisma.customerEdit.create({ data: submitted });
      } else {
        // F13: the trail on each request it answers commits with it, or neither does.
        edit = await prisma.$transaction(async (tx) => {
          const e = await tx.customerEdit.create({ data: submitted });
          for (const id of answered) {
            await writeAudit(tx, answeredEnv, {
              action: 'UPDATE',
              entityType: 'CustomerEdit',
              entityId: id,
              reason: 'resubmitted: answered by a new request',
              after: { state: EditState.NEEDS_CORRECTION, answeredBy: e.id } as Prisma.InputJsonValue,
            });
          }
          return e;
        });
      }
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
    // Best-effort AFTER the edit exists — an UPDATE submit is a single insert
    // (with the audit rows of what it answers), the notification is not part of
    // it, and losing a notification is tolerable while losing
    // a submit is not. try/catch enforces that contract: a transient notify
    // failure must not convert an already-committed submit into a reported
    // error (the salesman's retry would dead-end on EDIT_LOCKED).
    if (!isDraft) {
      try {
        // Owner decision 3: the regions of the request's scope, the Managers
        // who can decide it — not every region the customer spans.
        const scopeBranches = requestScopeBranches({
          branches: customer.branches,
          fieldChanges,
          homeBranchIds: salesmanBranches(customer.branches, me.ownedRouteId).map((b) => b.id),
          submitterRouteId: me.ownedRouteId,
        });
        const firstAudience = await resolveStepAudience(
          prisma,
          firstStep,
          { supervisorId: me.supervisorId },
          [...new Set(scopeBranches.map((b) => b.regionId))]
        );
        await notifyUsers(prisma, firstAudience, {
          kind: 'EDIT_SUBMITTED',
          title: 'Edit awaiting your review',
          body: `${customer.legalName} (${customer.nmwcCode}) — changes submitted for approval.`,
          editId: edit.id,
          customerId: customer.id,
        });
        // F1: the salesman's region's Accountant is told for information
        // (lib/notify-policy.ts). His region is the region of HIS branch of this
        // customer — he can touch only branches on his own route — not every
        // region a multi-region customer spans. Inside the same best-effort
        // try: this insert has already committed, so a failure here is logged and
        // the submit still stands (the SLA sweep remains the backstop).
        if (me.role === Role.SALESMAN) {
          await notifySalesmanRequest(prisma, {
            event: 'UPDATE',
            submitter: { id: me.id, supervisorId: me.supervisorId },
            regionId: customer.branches.find((b) => b.routeId === me.ownedRouteId)?.regionId ?? null,
            editId: edit.id,
            customerId: customer.id,
            subject: { legalName: customer.legalName, nmwcCode: customer.nmwcCode },
            alreadyTold: firstAudience,
          });
        }
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
      changes: recorded,
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

/**
 * Launch fix: ONE saved draft per person per customer, saved over in place.
 * "Save draft" inserted a new DRAFT row every time; nothing reads one back (the
 * form keeps its draft on the phone), and the customer's Recent activity listed
 * each as "submitted N change(s)". Serialized per person and customer with a
 * transaction-scoped advisory lock (lib/create-guards.ts takes them the same
 * way), so two saves at once cannot both insert. A submit is always a new row:
 * a draft never becomes a request, so the cycle invariant in submitEditOnce holds.
 */
async function saveUpdateDraft(
  submittedById: string,
  customerId: string,
  data: Pick<
    Prisma.CustomerEditUncheckedCreateInput,
    | 'fieldChanges'
    | 'submissionId'
    | 'process'
    | 'approvalChain'
    | 'paymentTermsAtSubmit'
    | 'currentStepIndex'
    | 'cycle'
  >
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`nmwc:edit-draft:${submittedById}:${customerId}`}, 42))`;
    const saved = await tx.customerEdit.findFirst({
      where: {
        submittedById,
        customerId,
        state: EditState.DRAFT,
        process: EditProcess.UPDATE,
        target: EditTarget.CUSTOMER,
        isReactivation: false,
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (saved) return tx.customerEdit.update({ where: { id: saved.id }, data });
    return tx.customerEdit.create({
      data: {
        ...data,
        target: EditTarget.CUSTOMER,
        customerId,
        state: EditState.DRAFT,
        submittedById,
        submittedAt: null,
        attachmentChanges: [] as unknown as Prisma.InputJsonValue,
      },
    });
  });
}

/**
 * Launch fix: the salesman clears a request sent back to him that he has
 * nothing to send again for: "the number on file is right", a Manager has since
 * written the values, or the customer is no longer on his route. A sent-back
 * request is answered only by a later request of his (lib/returned-work.ts), and
 * a submit with no change is refused ("No changes to submit."), so such a
 * request kept Today's red tile, its Work row and Needs correction for good.
 *
 * Nothing on the request changes. It stays NEEDS_CORRECTION with its reason, the
 * record of the decision (the dashboard counts it so). The audit row written
 * here is the trail, and it is what takes the request off his lists. Only his
 * own request, only a sent-back one, and never a new-customer request: he
 * withdraws that from its page (services/creates.ts withdrawCreateAction), which
 * also frees its CR and shop. Serialized per request, so a double tap writes one
 * row; one already answered or cleared answers ok and writes nothing.
 */
export async function clearReturnedEditAction(input: { editId: string }): SafeAction<{ editId: string }> {
  return runAction(() => clearReturnedEditCore(input));
}

async function clearReturnedEditCore(input: { editId: string }): Promise<{ editId: string }> {
  const me = await requireUser();
  const editId = typeof input?.editId === 'string' ? input.editId : '';
  if (!editId) throw new ValidationError({ editId: 'required' });
  const lim = await checkLimit(`edit:${me.id}`, FORM_LIMIT);
  if (!lim.ok) {
    throw new RateLimitError(`Slow down — try again in ${lim.retryAfterSec}s.`);
  }
  const edit = await prisma.customerEdit.findUnique({
    where: { id: editId },
    select: { id: true, process: true, state: true, submittedById: true, customerId: true },
  });
  // His own: anyone else's reads as not found.
  if (!edit || edit.submittedById !== me.id) throw new NotFoundError('Request not found.');
  if (edit.process === EditProcess.CREATE) {
    throw new ConflictError(
      'EDIT_LOCKED',
      'A new-customer request is withdrawn from its own page, which also frees its CR number and shop.'
    );
  }
  if (edit.state !== EditState.NEEDS_CORRECTION) {
    throw new ConflictError('EDIT_LOCKED', 'This request was not sent back to you, so there is nothing to clear.');
  }

  const env = await getAuditEnvelope(me.id);
  const cleared = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`nmwc:returned-clear:${editId}`}, 42))`;
    // Answered since, cleared by a tap a moment ago, or its customer archived:
    // it no longer waits on him, and that is the answer.
    const open = await openReturnedIds(tx, me.id, { customerId: edit.customerId ?? undefined });
    if (!open.includes(editId)) return false;
    await writeAudit(tx, env, {
      action: 'UPDATE',
      entityType: 'CustomerEdit',
      entityId: editId,
      reason: RETURNED_CLEARED_REASON,
      after: { state: EditState.NEEDS_CORRECTION, cleared: true } as Prisma.InputJsonValue,
    });
    return true;
  });

  if (cleared) logger.info({ editId, by: me.id }, 'edit.returned.clear');
  revalidatePath('/work');
  revalidatePath('/today');
  revalidatePath('/rejected');
  return { editId };
}

async function applyEditChanges(
  tx: Prisma.TransactionClient,
  customerId: string,
  customerProposed: Record<string, unknown>,
  branches: readonly BranchWrite[],
  actorId: string,
  // Owner decision 7: the customer's status follows a branch status this writes,
  // audited with this envelope (lib/customer-status.ts).
  statusAudit: { env: AuditEnvelope; via: string }
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
  for (const f of CUSTOMER_EDIT_FIELDS) {
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
  let statusChanges = NO_STATUS_EVENTS;
  for (const bp of branches) {
    const branchUpdate: Record<string, unknown> = {};
    for (const f of BRANCH_EDIT_FIELDS) {
      const v = bp[f];
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
      statusChanges = mergeStatusEvents(
        statusChanges,
        statusEvents(currentBranch.status, branchUpdate.status as typeof currentBranch.status)
      );
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

  // Owner decision 7: the last open branch closed closes the customer; a branch
  // reopened opens it. Under the customer's row lock both callers hold.
  await followBranchStatus(tx, statusAudit.env, customerId, statusChanges, {
    actorId,
    via: statusAudit.via,
  });

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
  // N01: the request as the approver's page showed it. Compared with the row
  // after the authorization gate, and the claims below are built from it.
  const expected = readDecisionToken(formData);

  const edit = await prisma.customerEdit.findUnique({
    where: { id: editId },
    include: {
      customer: { include: { branches: { where: { deletedAt: null } } } },
      // ownedRouteId, ownedRoute: the home of a request without a usable submitGate (owner decision 3).
      submittedBy: {
        select: { id: true, supervisorId: true, fullName: true, ownedRouteId: true, ownedRoute: { select: { regionId: true } } },
      },
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
  // Owner decision 2026-10-05 (X-APPR-1(a): no): a credit application is
  // approved one at a time from its own review page, at every step, never inside
  // a bulk approve. Only bulkApproveEditsAction sets the field; nothing is written.
  if (
    formData.get(BULK_RUN_FIELD) === '1' &&
    isCreate &&
    edit.customerDraft?.paymentTerms === PaymentTerms.CREDIT
  ) {
    throw new ValidationError({ decisions: CREDIT_BULK_REFUSED_MESSAGE }, CREDIT_BULK_REFUSED_MESSAGE);
  }
  // Owner decision 2026-10-08: the last step of a new-customer request needs the
  // Temix code the Accountant typed for it, which a bulk approve does not carry.
  if (
    formData.get(BULK_RUN_FIELD) === '1' &&
    isCreate &&
    isFinalStep(parseChain(edit.approvalChain), edit.currentStepIndex)
  ) {
    throw new ValidationError(
      { decisions: TEMIX_CODE_BULK_REFUSED_MESSAGE },
      TEMIX_CODE_BULK_REFUSED_MESSAGE
    );
  }
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
  // approvers act on where the customer WILL live). Owner decision 3
  // (2026-10-07): for an update or close request, the branches it is about
  // (requestScopeBranches) — a Manager must manage every one's region.
  const { loadScope } = await import('@/lib/access');
  const actorScope = await loadScope(session.id);
  const sessionUser = { id: session.id, role: session.role, username: session.username };
  const scopeBranches = isCreate
    ? edit.branchDrafts.map((d) => ({ regionId: d.route.regionId, deletedAt: null }))
    : requestScopeBranches({
        branches: edit.customer!.branches,
        fieldChanges: edit.fieldChanges,
        branchId: edit.branchId,
        homeBranchIds: parseSubmitGate(edit.submitGate)?.branchIds,
        submitterRouteId: edit.submittedBy.ownedRouteId,
        submitterRegionId: edit.submittedBy.ownedRoute?.regionId,
      });
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
  // N01: a page opened before a correction round, a step-back or another
  // reviewer's decision shows a request that no longer exists. Nothing is written.
  assertDecisionView(expected, edit);

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
            // N01: the view the approver decided on, not the row reloaded above —
            // the check and the claim are one statement. stageEnteredAt is the
            // visit: a step-back and a re-advance return to this index in the
            // same cycle (review, 2026-09-27).
            currentStepIndex: expected.stepIndex,
            cycle: expected.cycle,
            stageEnteredAt: expected.stageEnteredAt,
            requestedCreditLimit: expected.creditLimit,
            requestedPaymentTermDays: expected.paymentTermDays,
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
        // N01: the guarantee documents the page rendered, still exactly the live
        // ones — under the claim's lock, and locked themselves until commit.
        await assertGuaranteesAsViewed(tx, edit, expected);
        await tx.editApproval.create({
          data: {
            editId,
            cycle: edit.cycle,
            stepIndex,
            role: step.role,
            decision: 'APPROVED',
            actorId: session.id,
            // Item 9: the stage as it stood when decided (lib/working-hours.ts).
            ...stageSnapshot(edit, advancedAt),
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
        // This step's rows (and any breach pings) are answered: they stop
        // counting in their holders' bells before the next step's are written.
        await settleRequestAlerts(tx, { editId, submittedById: edit.submittedById });
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
    // Owner decision 2026-10-08: the Accountant created the customer in Temix
    // himself and typed its code on this page. Required, in the shape Temix codes
    // are stored (lib/temix-code.ts); finalize refuses one a live customer holds.
    const temixCode = normalizeTemixCode(formData.get('temixCode'));
    const temixCodeIssue = temixCodeProblem(temixCode);
    if (temixCodeIssue) throw new ValidationError({ temixCode: temixCodeIssue }, temixCodeIssue);
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
            // N01: the view the approver decided on (see the advance claim above).
            currentStepIndex: expected.stepIndex,
            cycle: expected.cycle,
            stageEnteredAt: expected.stageEnteredAt,
            requestedCreditLimit: expected.creditLimit,
            requestedPaymentTermDays: expected.paymentTermDays,
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
        // N01: before finalize binds them (see the advance claim above).
        await assertGuaranteesAsViewed(tx, edit, expected);
        await tx.editApproval.create({
          data: {
            editId,
            cycle: edit.cycle,
            stepIndex,
            role: step.role,
            decision: 'APPROVED',
            actorId: session.id,
            ...stageSnapshot(edit, finalizedAt),
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
          finalizedAt,
          temixCode
        );
        await settleRequestAlerts(tx, { editId, submittedById: edit.submittedById });
        // Submitter learns their customer is live, under both codes (owner
        // decision 2026-10-08); Stewards get the Temix-upload-ready signal
        // (temixSyncState is now PENDING_UPLOAD: the next batch updates the
        // Temix record the Accountant made with the full record).
        await notifyUsers(tx, [edit.submittedById], {
          kind: 'EDIT_APPROVED_FINAL',
          title: 'New customer approved',
          body: `${finalized.legalName} is now live as ${finalized.nmwcCode}, Temix code ${finalized.temixCode}.`,
          editId,
          customerId: finalized.customerId,
        });
        const stewards = await resolveStewardAudience(tx);
        await notifyUsers(tx, stewards, {
          kind: 'EDIT_APPROVED_FINAL',
          title: 'Ready for Temix upload',
          body: `${finalized.legalName} (${finalized.nmwcCode}, Temix code ${finalized.temixCode}) was approved and is queued for the next Temix batch.`,
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
      {
        editId,
        by: session.id,
        customerId: result.customerId,
        nmwcCode: result.nmwcCode,
        temixCode: result.temixCode,
      },
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

  // The stored changes, as written at submit (JSON, read defensively).
  const fieldChanges = storedFieldChanges(edit.fieldChanges);
  const stored = payloadFromFieldChanges(fieldChanges);

  // A close-shop / branch-status request (markBranchClosedAction) is a salesman-
  // submitted UPDATE whose ONLY change is a branch status flip, gated by its OWN
  // fresh-photo evidence — NOT an enrichment edit. The EL-04 mandatory-field
  // re-check below must therefore skip it: otherwise an imported/legacy customer
  // (no field-captured CR/shop/signboard photos) could never have a branch closed,
  // because collectMissingMandatory always fails there (final-hunt #1). Any
  // non-status field change keeps the full EL-04 gate.
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
  const proposedStatus = stored.customer.status;
  if (
    typeof proposedStatus === 'string' &&
    proposedStatus !== liveCustomer.status &&
    (liveCustomer.status === 'CLOSED' ||
      liveCustomer.status === 'SUSPENDED' ||
      proposedStatus === 'CLOSED' ||
      proposedStatus === 'SUSPENDED')
  ) {
    throw new ConflictError(
      'STATUS_BYPASS',
      'This edit changes customer.status — that route is forbidden. Use the close-shop or reactivation action.'
    );
  }

  // QA-013: field locks are re-evaluated against the CURRENT customer state —
  // under the lock, on the row the approval decides with (lib/edit-approval.ts
  // planApproval, lib/edit-scope.ts withoutSubmitterLockedFields). If payment
  // terms changed CASH→CREDIT between submit and approve, the CR number is
  // dropped; a salesman's legal name always is. Go-live flow test (2026-09-10):
  // the two locks are INDEPENDENT (2026-05-11 — legalName always locked for a
  // salesman, crNumber only on CREDIT); a CR number a salesman collected on a
  // CASH customer is kept. F05: the submitter's route is read too, for a request
  // sent before its gated branches were stored.
  const submitter = edit.submittedBy as {
    id: string;
    supervisorId: string | null;
    fullName: string;
  };
  const submitterUser = await prisma.user.findUnique({
    where: { id: submitter.id },
    select: { role: true, ownedRouteId: true },
  });

  // P1.3 (2026-05-10): phone duplicates are now ALLOWED. Log a soft note
  // for the steward queue but do not block the approval.
  if (typeof stored.customer.primaryPhone === 'string') {
    const norm = stored.customer.primaryPhone;
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
          // N01: the view the approver decided on (see the advance claim above).
          currentStepIndex: expected.stepIndex,
          cycle: expected.cycle,
          stageEnteredAt: expected.stageEnteredAt,
          requestedCreditLimit: expected.creditLimit,
          requestedPaymentTermDays: expected.paymentTermDays,
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
      // N01: an UPDATE has no guarantees to read; this refuses a token that states some.
      await assertGuaranteesAsViewed(tx, edit, expected);
      await tx.editApproval.create({
        data: {
          editId,
          cycle: edit.cycle,
          stepIndex,
          role: step.role,
          decision: 'APPROVED',
          actorId: session.id,
          ...stageSnapshot(edit, new Date()),
        },
      });
      // The customer's row lock before any branch write (lib/locks.ts): photo
      // attach and Remove take it first too, and applyEditChanges writes a
      // branch before its customer, so the two orders deadlocked on the same
      // branch (pre-merge review). It also makes the EL-04 read below truly
      // serialized against a concurrent Remove.
      await lockCustomerRow(tx, edit.customerId!);
      // F10: a close request is approved on the photo it was sent with, so that
      // photo must still stand now: live, the submitter's, on that branch. Read
      // under the lock Remove also takes; the 24-hour age rule is not re-applied
      // (lib/status-evidence.ts). A status-only request is a close request, and
      // one without evidence is refused, not waved through.
      if (isStatusOnlyEdit || evidenceIds(edit.attachmentChanges).length > 0) {
        await assertStatusEvidence(tx, {
          branchId: edit.branchId,
          submittedById: edit.submittedById,
          attachmentChanges: edit.attachmentChanges,
          queue: 'approvals',
        });
      }
      // Phase 2 (F06): the customer as it is NOW, read once under the lock; every
      // check below and the write itself decide with this row. The check before
      // the transaction cannot see an archive or merge that commits later.
      const now = await tx.customer.findUnique({
        where: { id: edit.customerId! },
        include: { branches: { where: { deletedAt: null } } },
      });
      if (!now || now.deletedAt) {
        throw new NotFoundError('Customer no longer exists (may have been merged or deleted).');
      }
      // Each stored change against that row (lib/edit-approval.ts). One whose
      // field has changed since it was sent — to anything but its own new value
      // — refuses the whole approval: writing it would put an older value back
      // over a newer one (an import, a Manager's direct write). The throw rolls
      // back the claim and the decision row above, so the request stays
      // SUBMITTED on the same stage and Reject still works.
      const { considered, classified } = planApproval({
        fieldChanges,
        submitterRole: submitterUser?.role,
        customer: now,
        liveBranches: now.branches,
      });
      if (classified.stale.length > 0) {
        logger.info(
          { editId, fields: classified.stale.map((s) => s.field) },
          'edit.approve.stale_before'
        );
        throw new ConflictError(
          'STALE_BEFORE',
          staleBeforeMessage(staleFieldLabels(classified.stale))
        );
      }
      // QA-039 + EL-10: changes to a branch deleted, or moved to another
      // customer, since submission are dropped and the discrepancy logged — the
      // submitter's scope on that branch may no longer hold.
      const droppedBranchIds = classified.droppedBranchIds;
      if (droppedBranchIds.length > 0) {
        logger.warn(
          { editId, customerId: edit.customerId, droppedBranchIds },
          'edit.approve.branches_dropped'
        );
      }
      const write = payloadFromFieldChanges(classified.apply);
      // F16: the channel pair this leaves on the customer must still fit —
      // a sub-channel retired, or moved to another channel, since submit; or,
      // for a request the old form sent, a channel change beside the
      // customer's sub-channel of the old channel, which that form never
      // cleared. The message says which (lib/edit-approval.ts).
      if (write.customer.channelId !== undefined || write.customer.subChannelId !== undefined) {
        const pair = await resolveChannelPair(tx, now, channelPairOf(write.customer), {
          requireActiveChannel: false,
          clearMisfitSubChannel: false,
        });
        if (!pair.ok) {
          throw new ConflictError(
            'CHANNEL_PAIR_INVALID',
            channelPairInvalidMessage(pair.field, considered)
          );
        }
      }
      // EL-04 (Critical): re-run the mandatory-field gate at approve time. The
      // submit-time gate enforces "salesman cannot submit a half-empty record", but
      // photos and other slot data live OUTSIDE `fieldChanges` and can be detached
      // after submit. Without this, an APPROVED record could land with no CR/shop
      // photo because the salesman tapped the trash icon between submit and approve.
      // final-hunt #22: read the live customer via `tx` (not the global client) so the
      // check and the apply are in ONE transaction — a concurrent detach can no longer
      // slip between them. Not for a request that is not gated (a Steward's or
      // Manager's) nor for status-only close requests (they enrich nothing).
      // F05: on the branches the request was gated on at submit, frozen on the row
      // (lib/edit-scope.ts gateBranchesForApproval) — never the customer's whole
      // branch list, so another route's branch, one created after submit, or a
      // route handover cannot fail it.
      // Owner decision 4 (2026-10-07): of that set, the branches the changes
      // to be written name, and the customer's fields only when one of them is
      // a customer-level change — the rule the submit applied.
      const scope = gateScopeOf(considered.map((c) => c.field));
      const { gateBranches: frozenGate, unreadable } = gateBranchesForApproval({
        submitGate: edit.submitGate,
        liveBranches: now.branches,
        fieldChanges,
        submitter: { role: submitterUser?.role, ownedRouteId: submitterUser?.ownedRouteId },
      });
      if (unreadable) logger.warn({ editId }, 'edit.approve.submit_gate_unreadable');
      const gateBranches = frozenGate?.filter((b) => scope.branchIds.has(b.id)) ?? null;
      if (gateBranches && !isStatusOnlyEdit) {
        const proposal = payloadFromFieldChanges(considered);
        const missing = collectMissingMandatory(
          now,
          gateBranches,
          proposal.customer,
          proposal.byBranch,
          /* actorIsSalesman */ true,
          salesmanSubmitGate(),
          /* customerFields */ scope.customer
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
      // Ruling 5: a request whose every change is already live writes nothing to
      // the customer — no version bump, no rescore, no Temix requeue. It is still
      // approved, audited and notified.
      if (classified.apply.length > 0) {
        await applyEditChanges(tx, edit.customerId!, write.customer, write.branches, session.id, {
          env,
          via: `approved request ${editId}`,
        });
      }
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
      await settleRequestAlerts(tx, { editId, submittedById: edit.submittedById });
      // A close-shop request (the only BRANCH-target request decided here) is told
      // in its own words: "your changes are live" does not say the shop is closed.
      const isCloseRequest = edit.target === EditTarget.BRANCH;
      await notifyUsers(tx, [edit.submittedById], {
        kind: 'EDIT_APPROVED_FINAL',
        title: isCloseRequest ? 'Close-shop request approved' : 'Edit approved',
        body: isCloseRequest
          ? `${requestName} — your close-shop request was approved; the branch is now closed.`
          : `${requestName} — your changes were approved and are now live.`,
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
 * N01: a bulk decision is a list of `{ editId, decisionToken }` — each card's own
 * view of its request — and every item is decided against its own token. An id
 * list alone (the old payload) is refused: it binds nothing.
 */
function readBulkDecisions(formData: FormData): { editIds: string[]; tokenOf: Map<string, string> } {
  const raw = formData.get('decisions');
  if (typeof raw !== 'string') {
    throw new ValidationError({ decisions: MISSING_TOKEN_MESSAGE }, MISSING_TOKEN_MESSAGE);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const items = Array.isArray(parsed) ? parsed : null;
  if (
    !items ||
    !items.every(
      (x) =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as { editId?: unknown }).editId === 'string' &&
        typeof (x as { decisionToken?: unknown }).decisionToken === 'string'
    )
  ) {
    throw new ValidationError({
      decisions: 'decisions must be a JSON array of { editId, decisionToken }.',
    });
  }
  const list = items as { editId: string; decisionToken: string }[];
  if (list.length === 0) {
    throw new ValidationError({ decisions: 'Pick at least one edit.' });
  }
  // The message too, not only the field: the queue has no `decisions` input and
  // shows the form-level message, which was the default "Validation failed".
  if (list.length > BULK_DECISION_LIMIT) {
    throw new ValidationError({ decisions: BULK_DECISION_LIMIT_MESSAGE }, BULK_DECISION_LIMIT_MESSAGE);
  }
  const tokenOf = new Map(list.map((d) => [d.editId, d.decisionToken]));
  // One token per request: a repeated id with two views of it has no answer.
  if (tokenOf.size !== list.length) {
    throw new ValidationError({ decisions: 'Each request can be picked only once.' });
  }
  return { editIds: list.map((d) => d.editId), tokenOf };
}

/**
 * B-11 (Senior-audit 2026-05-10): Bulk approve. Reviewer multi-selects edits
 * in the queue and approves them in one round trip. Each edit goes through
 * `approveEditAction` in its own transaction, so partial failures (a single
 * VERSION_CONFLICT, NEEDS_REUPLOAD, etc.) don't block the
 * other approvals. The result reports per-edit outcomes so the form can
 * surface "12 approved, 1 needs your attention" inline.
 *
 * Hard cap: BULK_DECISION_LIMIT (50, lib/bulk-run.ts) edits per call to bound
 * the round-trip and keep approveEditCore isolated transactions sane on Neon.
 */
export async function bulkApproveEditsAction(formData: FormData): SafeAction<BulkOutcome> {
  return runAction(async () => {
    await requireUser();
    const { editIds, tokenOf } = readBulkDecisions(formData);
    // REL-04: each item commits on its own, so a throw escaping this loop
    // would leave approvals committed and the approver told nothing at all.
    const out = await runBulk(
      editIds,
      (editId) => {
        const fd = new FormData();
        fd.set('editId', editId);
        fd.set('decisionToken', tokenOf.get(editId)!);
        // Owner decision 2026-10-05 (X-APPR-1(a): no): marks the item as part of
        // a bulk run, so approveEditCore refuses a credit application here.
        fd.set(BULK_RUN_FIELD, '1');
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
    const reason = String(formData.get('reason') ?? '').trim();
    const category = String(formData.get('category') ?? 'other').trim();
    if (reason.length < 5 || reason.length > 1000) {
      throw new ValidationError({ reason: 'Reason must be 5–1000 characters.' });
    }
    const { editIds, tokenOf } = readBulkDecisions(formData);
    const out = await runBulk(
      editIds,
      (editId) => {
        const fd = new FormData();
        fd.set('editId', editId);
        fd.set('decisionToken', tokenOf.get(editId)!);
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
  // N01: a rejection is bound to the request as the reviewer saw it, like an approval.
  const expected = readDecisionToken(formData);

  const edit = await prisma.customerEdit.findUnique({
    where: { id: editId },
    include: {
      submittedBy: { select: { id: true, supervisorId: true, ownedRouteId: true, ownedRoute: { select: { regionId: true } } } },
      customer: {
        select: {
          legalName: true,
          // Owner decision 3: what requestScopeBranches reads, as on approve.
          branches: { select: { id: true, routeId: true, regionId: true, deletedAt: true } },
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
    : requestScopeBranches({
        branches: edit.customer?.branches ?? [],
        fieldChanges: edit.fieldChanges,
        branchId: edit.branchId,
        homeBranchIds: parseSubmitGate(edit.submitGate)?.branchIds,
        submitterRouteId: edit.submittedBy.ownedRouteId,
        submitterRegionId: edit.submittedBy.ownedRoute?.regionId,
      });
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
  // N01: after the gate, before anything is written (see approveEditCore).
  assertDecisionView(expected, edit);

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
  // Launch fix (2026-10-07): a close-shop request (the only BRANCH-target request
  // decided here; reactivations were refused above) is refused for good, not sent
  // back. Nothing on it can be corrected — a new close request is a new row — so
  // as NEEDS_CORRECTION it sat on the salesman's Needs correction lists for ever.
  // It ends REJECTED, and the row below tells him why. Its decisionReason is HIS
  // reason for asking and is kept; the reviewer's reason is on the decision row
  // (EditApproval), the audit row and his notification.
  const isCloseRequest = edit.target === EditTarget.BRANCH;

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
        ...stageSnapshot(edit, rejectedAt),
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
            state: isCloseRequest ? EditState.REJECTED : EditState.NEEDS_CORRECTION,
            pendingRole: null,
            currentStepIndex: 0,
            // NEEDS_CORRECTION stops the clock; the salesman's rework is not
            // SLA-tracked in v1.
            slaDueAt: null,
            escalationLevel: 0,
            slaBreachedAt: null,
            lastEscalatedAt: null,
            ...(isCloseRequest ? {} : { decisionReason: reason }),
            decisionCategory: category,
            reviewedById: session.id,
            reviewedAt: rejectedAt,
          };
    // The EditApproval row above is inserted before this claim, in the same
    // transaction: a missed claim throws and rolls it back.
    const claim = await tx.customerEdit.updateMany({
      where: {
        id: editId,
        state: EditState.SUBMITTED,
        // N01: the view the reviewer rejected (see the advance claim in
        // approveEditCore); stageEnteredAt is the visit to the stage.
        currentStepIndex: expected.stepIndex,
        cycle: expected.cycle,
        stageEnteredAt: expected.stageEnteredAt,
        requestedCreditLimit: expected.creditLimit,
        requestedPaymentTermDays: expected.paymentTermDays,
      },
      data,
    });
    if (claim.count === 0) {
      throw new ConflictError(
        'NOT_PENDING',
        'This edit was just decided by another reviewer. Refresh to see the current state.'
      );
    }
    // N01: a rejection is bound to the guarantees shown too; a refusal rolls
    // back the decision row above with the claim.
    await assertGuaranteesAsViewed(tx, edit, expected);
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
    // Notifications (inside the tx — a lost claim race must not notify). The
    // rows that asked for this decision are answered first, so a step-back's
    // fresh rows to the previous step stay unread.
    await settleRequestAlerts(tx, { editId, submittedById: edit.submittedById });
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
      // EDIT_NEEDS_CORRECTION for a refused close too: it is the red row a
      // salesman acts on, and he must read why (he may need to send it again).
      await notifyUsers(tx, [edit.submittedById], {
        kind: 'EDIT_NEEDS_CORRECTION',
        title: isCloseRequest ? 'Close-shop request refused' : 'Needs correction',
        body: isCloseRequest
          ? `${rejectRequestName} — your close-shop request was refused, so the branch is not closed: ${reason}`
          : `${rejectRequestName} — returned to you: ${reason}`,
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
