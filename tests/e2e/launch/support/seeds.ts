/**
 * Seeded states that are setup, not story: requests and notifications written
 * straight into UAT the way the services write them.
 *
 * seedUpdateEdit() builds the body the enrichment form sends (patch v2, every
 * key with the value the form loaded), runs it through the app's own schema
 * (lib/validation/edit.ts — phones and CR numbers normalized exactly as a real
 * submit does), plans each change against the LIVE row with the app's own
 * classifyAgainstLive / classifyPointAgainstLive exactly as
 * services/edits.ts submitEditOnce does (before = the live value, GPS as a
 * point, companions only with a moved point, equipment counted), freezes the
 * chain with resolveChain/stepDeadline, records the salesman's submitGate, and
 * finally proves with planApproval() that an approval would apply every change
 * — no STALE_BEFORE, no dropped branch. It does NOT run the mandatory-field gate
 * (collectMissingMandatory is private to the service): seed on a customer whose
 * result is complete (FULL) when the test approves it, or submit through the
 * real /api/forms/customer-edit when the gate itself is under test.
 */
import type { EditState, NotificationKind, Prisma } from '@prisma/client';
import { resolveChain, stepDeadline } from '../../../../lib/approval-chains';
import { planApproval } from '../../../../lib/edit-approval';
import { salesmanBranches, submitGateRecord } from '../../../../lib/edit-scope';
import {
  BRANCH_EDIT_FIELDS,
  CUSTOMER_EDIT_FIELDS,
  EDIT_PAYLOAD_VERSION,
  EQUIPMENT_FIELDS,
  GPS_COMPANIONS,
  GPS_POINT_FIELDS,
  branchPath,
  classifyAgainstLive,
  classifyPointAgainstLive,
  sameEditValue,
  toBaseValue,
  type BaseValue,
  type BranchEditField,
} from '../../../../lib/edit-values';
import type { FieldChange } from '../../../../lib/gps-manual';
import { isFieldLocked } from '../../../../lib/permissions';
import { submitEditSchema } from '../../../../lib/validation/edit';
import { db, safeError } from './env';
import { newId } from './ids';
import type { World } from './types';

export type { FieldChange };
export { seedPhoto, seedPhotos, type PhotoSpec } from './photos';

/** The fields a test changes, as the form would send them (no bases — they are read live). */
export interface UpdatePatch {
  customer?: Record<string, unknown>;
  /** `branch` is a world branch key ('FULL', 'MULTI.A1'). */
  branches?: Array<{ branch: string } & Record<string, unknown>>;
}

const NO_BASE: ReadonlySet<string> = new Set(['gpsManualReason', ...GPS_COMPANIONS]);

const sent = (o: Record<string, unknown> | undefined) =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));

export async function seedUpdateEdit(
  w: World,
  o: {
    customer: string;
    submitter: string;
    patch: UpdatePatch;
    state?: Extract<EditState, 'DRAFT' | 'SUBMITTED' | 'NEEDS_CORRECTION' | 'REJECTED'>;
    submittedAt?: Date;
    stageEnteredAt?: Date;
    slaDueAt?: Date;
    escalationLevel?: number;
    decision?: { by: string; reason: string; category?: string; at?: Date };
  }
): Promise<{ id: string; fieldChanges: FieldChange[] }> {
  const state = o.state ?? 'SUBMITTED';
  const cust = w.customer(o.customer);
  const submitter = w.user(o.submitter);
  const live = await db.customer.findUniqueOrThrow({
    where: { id: cust.id },
    include: { branches: { where: { deletedAt: null } } },
  });
  const liveRow = live as unknown as Record<string, unknown>;

  // 1. The body the form sends, bases read from the live row.
  const customer = sent(o.patch.customer);
  const customerBase: Record<string, BaseValue> = {};
  for (const k of Object.keys(customer)) customerBase[k] = toBaseValue(liveRow[k]);
  const branchesIn = (o.patch.branches ?? []).map(({ branch, ...rest }) => {
    const id = w.branch(branch).id;
    const lb = live.branches.find((b) => b.id === id) as unknown as Record<string, unknown> | undefined;
    if (!lb) throw new Error(`seedUpdateEdit: branch ${branch} is not live on ${o.customer}`);
    const fields = sent(rest);
    const base: Record<string, BaseValue> = {};
    for (const k of Object.keys(fields)) if (!NO_BASE.has(k)) base[k] = toBaseValue(lb[k]);
    return { branchId: id, ...fields, base };
  });
  const parsed = submitEditSchema.safeParse({
    v: EDIT_PAYLOAD_VERSION,
    customerId: cust.id,
    isDraft: state === 'DRAFT',
    customer,
    customerBase,
    branches: branchesIn,
  });
  if (!parsed.success) {
    throw new Error(
      `seedUpdateEdit: not a body the form could send — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    );
  }
  const data = parsed.data;

  // 2. Planned against the live row, as submitEditOnce plans it.
  const actor = { id: submitter.id, role: submitter.role, username: '' };
  const proposed: Record<string, unknown> = { ...data.customer };
  if (isFieldLocked('legalName', actor, live)) delete proposed.legalName;
  if (isFieldLocked('crNumber', actor, live)) delete proposed.crNumber;
  const changes: FieldChange[] = [];
  const plan = (path: string, loaded: unknown, after: unknown, liveValue: unknown, verdict = classifyAgainstLive(path, loaded, after, liveValue)) => {
    if (verdict === 'CONVERGED') return null;
    if (verdict === 'STALE') throw new Error(`seedUpdateEdit: ${path} is stale against the live row`);
    return { field: path, before: liveValue ?? null, after } satisfies FieldChange;
  };
  for (const f of CUSTOMER_EDIT_FIELDS) {
    if (proposed[f] === undefined) continue;
    const c = plan(`customer.${f}`, data.customerBase[f], proposed[f], liveRow[f]);
    if (c) changes.push(c);
  }
  for (const bp of data.branches) {
    const branch = live.branches.find((b) => b.id === bp.branchId)!;
    if (submitter.role === 'SALESMAN' && branch.routeId !== submitter.routeId) {
      throw new Error(`seedUpdateEdit: branch ${branch.branchCode} is not on ${submitter.key}'s route — the app would refuse it`);
    }
    if (bp.gpsManualReason) throw new Error('seedUpdateEdit: a typed-in point (gpsManualReason) — submit it through the API instead');
    const lb = branch as unknown as Record<string, unknown>;
    const loaded = bp.base as Record<string, unknown>;
    const values = bp as unknown as Record<string, unknown>;
    const out: FieldChange[] = [];
    for (const f of BRANCH_EDIT_FIELDS) {
      if (GPS_POINT_FIELDS.has(f) || GPS_COMPANIONS.has(f) || values[f] === undefined) continue;
      const c = plan(branchPath(branch.id, f), loaded[f], values[f], lb[f]);
      if (c) out.push(c);
    }
    if ([...GPS_POINT_FIELDS].some((f) => values[f] !== undefined)) {
      const coordinate = (f: BranchEditField, from: Record<string, unknown>) => (values[f] === undefined ? lb[f] : from[f]);
      const verdict = classifyPointAgainstLive(
        { gpsLat: coordinate('gpsLat', loaded), gpsLng: coordinate('gpsLng', loaded) },
        { gpsLat: coordinate('gpsLat', values), gpsLng: coordinate('gpsLng', values) },
        { gpsLat: lb.gpsLat, gpsLng: lb.gpsLng }
      );
      for (const f of GPS_POINT_FIELDS) {
        const c = plan(branchPath(branch.id, f), coordinate(f, loaded), coordinate(f, values), lb[f], verdict);
        if (c) out.push(c);
      }
    }
    const planned = (f: BranchEditField) => out.some((c) => c.field === branchPath(branch.id, f));
    if ([...GPS_POINT_FIELDS].some(planned)) {
      for (const f of GPS_COMPANIONS) {
        if (values[f] === undefined || sameEditValue(f, values[f], lb[f])) continue;
        out.push({ field: branchPath(branch.id, f), before: lb[f] ?? null, after: values[f] });
      }
    }
    const counts = [...EQUIPMENT_FIELDS].filter((f) => f !== 'equipmentConfirmed');
    if (counts.some(planned) && !branch.equipmentConfirmed && values.equipmentConfirmed === undefined) {
      out.push({ field: branchPath(branch.id, 'equipmentConfirmed'), before: false, after: true });
    }
    changes.push(...out);
  }
  if (changes.length === 0) throw new Error('seedUpdateEdit: the patch changes nothing on the live row');
  if (changes.some((c) => c.field === 'customer.paymentTerms')) throw new Error('seedUpdateEdit: payment terms never ride an update');
  if (changes.some((c) => c.field.endsWith('.status')) && submitter.role === 'SALESMAN') {
    throw new Error('seedUpdateEdit: status flips go through close / reactivation, not an update');
  }

  // 3. Proof: an approval now would apply every change (no STALE_BEFORE, nothing dropped).
  const check = planApproval({
    fieldChanges: JSON.parse(JSON.stringify(changes)),
    submitterRole: submitter.role,
    customer: live,
    liveBranches: live.branches,
  });
  if (check.classified.stale.length > 0 || check.classified.droppedBranchIds.length > 0) {
    throw new Error(`seedUpdateEdit: would not approve cleanly — stale ${JSON.stringify(check.classified.stale)}`);
  }

  // 4. The row, as the service writes it.
  const chain = resolveChain('UPDATE', live.paymentTerms);
  const first = chain[0]!;
  const submittedAt = state === 'DRAFT' ? null : (o.submittedAt ?? new Date());
  const stageEnteredAt = state === 'SUBMITTED' ? (o.stageEnteredAt ?? submittedAt!) : null;
  const decidedAt = o.decision?.at ?? new Date();
  const id = newId();
  w.registry.add('editIds', id);
  const row: Prisma.CustomerEditUncheckedCreateInput = {
    id,
    target: 'CUSTOMER',
    customerId: cust.id,
    state,
    submittedById: submitter.id,
    submittedAt,
    fieldChanges: changes as unknown as Prisma.InputJsonValue,
    attachmentChanges: [] as unknown as Prisma.InputJsonValue,
    process: 'UPDATE',
    approvalChain: chain as unknown as Prisma.InputJsonValue,
    paymentTermsAtSubmit: live.paymentTerms,
    currentStepIndex: 0,
    cycle: 1,
    ...(state === 'SUBMITTED'
      ? {
          pendingRole: first.role,
          stageEnteredAt,
          slaDueAt: o.slaDueAt ?? stepDeadline(stageEnteredAt!, first.slaHours),
          escalationLevel: o.escalationLevel ?? 0,
        }
      : {}),
    ...(state === 'SUBMITTED' && submitter.role === 'SALESMAN'
      ? {
          submitGate: submitGateRecord(salesmanBranches(live.branches, submitter.routeId).map((b) => b.id)) as unknown as Prisma.InputJsonValue,
        }
      : {}),
    ...(state === 'NEEDS_CORRECTION' || state === 'REJECTED'
      ? {
          pendingRole: null,
          slaDueAt: null,
          decisionReason: o.decision?.reason ?? 'Seeded decision',
          decisionCategory: o.decision?.category ?? null,
          reviewedById: o.decision ? w.user(o.decision.by).id : null,
          reviewedAt: decidedAt,
        }
      : {}),
  };
  try {
    await db.customerEdit.create({ data: row });
    if (o.decision && (state === 'NEEDS_CORRECTION' || state === 'REJECTED')) {
      // The step ledger row a rejection writes (append-only; inserts are allowed).
      await db.editApproval.create({
        data: {
          editId: id,
          cycle: 1,
          stepIndex: 0,
          role: first.role,
          decision: 'REJECTED',
          actorId: w.user(o.decision.by).id,
          reason: o.decision.reason,
          at: decidedAt,
        },
      });
    }
  } catch (err) {
    throw safeError(err, 'seedUpdateEdit insert failed');
  }
  return { id, fieldChanges: changes };
}

/**
 * What approving `editId` would do NOW, by the app's own planner (lib/edit-approval
 * planApproval): the changes it would apply, and any that went stale.
 */
export async function approvalPlanFor(editId: string): Promise<{ apply: string[]; stale: string[]; dropped: string[] }> {
  const edit = await db.customerEdit.findUniqueOrThrow({
    where: { id: editId },
    select: { fieldChanges: true, customerId: true, submittedBy: { select: { role: true } } },
  });
  if (!edit.customerId) throw new Error('approvalPlanFor: a CREATE request has no live row to plan against');
  const live = await db.customer.findUniqueOrThrow({
    where: { id: edit.customerId },
    include: { branches: { where: { deletedAt: null } } },
  });
  const { classified } = planApproval({
    fieldChanges: edit.fieldChanges,
    submitterRole: edit.submittedBy.role,
    customer: live,
    liveBranches: live.branches,
  });
  return {
    apply: classified.apply.map((c) => c.field),
    stale: classified.stale.map((s) => s.field),
    dropped: classified.droppedBranchIds,
  };
}

/** An in-app notification row, as lib/notifications.ts writes one (no e-mail is sent: the outbox is off). */
export async function seedNotification(
  w: World,
  o: {
    user: string;
    kind: NotificationKind;
    title?: string;
    body?: string;
    editId?: string;
    customerId?: string;
    read?: boolean;
    createdAt?: Date;
  }
): Promise<string> {
  const id = newId();
  w.registry.add('notificationIds', id);
  await db.notification.create({
    data: {
      id,
      userId: w.user(o.user).id,
      kind: o.kind,
      title: o.title ?? w.name('Seeded notification'),
      body: o.body ?? w.name('Seeded body'),
      editId: o.editId ?? null,
      customerId: o.customerId ?? null,
      readAt: o.read ? new Date() : null,
      createdAt: o.createdAt ?? new Date(),
      // Done with the outbox: a seeded row is never e-mailed.
      emailedAt: new Date(),
      emailStatus: 'SKIPPED_SEEDED',
    },
  });
  return id;
}

