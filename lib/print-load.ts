/**
 * What each printout shows, read once for the page that renders it and for the
 * action that records the print (services/prints.ts), so the page on screen and
 * the PRINT row can never disagree about who may print what (owner decisions
 * 2026-10-11, part C of the credit flow).
 *
 * Scope is the scope the printer already reads in, never wider:
 *   - the credit application: a credit new-customer request, authorized by
 *     canSeeCustomer on its DRAFT branches (route, and the route's current
 *     region) — the same rule that lets the printer open its documents
 *     (lib/access.ts assertCanAccessAttachment, the edit-claimed branch);
 *   - the customer form: canSeeCustomer on the live customer, then only the
 *     branches filterBranchesByScope leaves (RBAC-05-001), as the profile page.
 * Out of scope, an unknown id and a role that may not print all answer null,
 * which the pages turn into a 404 and the action into NOT_FOUND — never "you may
 * not", so an id is not confirmed to someone who cannot see it.
 *
 * Every photo and document is listed by id only. The page shows it through
 * /api/photos/<id>, which checks scope again and records the view (PHOTO_VIEW;
 * strict and never cached for the CR copy and the credit documents).
 */
import type { CustomerStatus, DayOfWeek, PaymentTerms, Role } from '@prisma/client';
import { prisma } from './db';
import { canSeeCustomer, filterBranchesByScope, loadScope } from './access';
import type { SessionUser } from './permissions';
import { canPrint, creditApplicationAvailable, signatureRolesFor } from './print';
import {
  DECISION_FORM_UPLOADED,
  DECISION_REJECTED,
  parseChain,
  signedFormStepIndex,
  stepName,
} from './approval-chains';
import {
  CREDIT_DOCUMENT_KINDS,
  CREDIT_DOCUMENT_LABELS,
  DECISION_BOUND_KINDS,
  type DecisionBoundKind,
} from './credit-documents';
import { formatRequestedLimit } from './decision-token';

/** One label and value of an information grid. `wide` spans both columns (an address, the notes). */
export type PrintRow = { label: string; value: string | null; mono?: boolean; wide?: boolean };

export type PrintLocation = { lat: number; lng: number; accuracy: number | null; capturedAt: Date | null };

export type PrintBranch = { title: string; rows: PrintRow[]; location: PrintLocation | null };

/** A photo or a document page: `document` pages are shown whole, photos filled. */
export type PrintFigure = { id: string; caption: string; document: boolean };

export type PrintTrailStep = { step: string; decision: string; by: string | null; at: Date | null };

/** Who made this customer, as the CRM recorded it. */
export type PrintTrail =
  | {
      kind: 'request';
      requestId: string;
      submittedBy: string;
      submittedAt: Date | null;
      /** One row per step of the chain frozen on the request: who completed it in its last round. */
      steps: PrintTrailStep[];
      /** Send-backs between steps within that last round. */
      sentBackInRound: number;
      /** Rounds before it that went back to the salesman for correction. */
      earlierRounds: number;
    }
  | { kind: 'import'; at: Date | null }
  | { kind: 'none' };

export type CreditApplicationPrint = {
  editId: string;
  legalName: string;
  submittedBy: string;
  submittedAt: Date | null;
  /** When the signed form is due back (the step's deadline). */
  dueAt: Date | null;
  customer: PrintRow[];
  credit: PrintRow[];
  branches: PrintBranch[];
  figures: PrintFigure[];
  /** What the PRINT row records. */
  cycle: number;
  stepIndex: number;
};

export type CreditApplicationLoad =
  | { kind: 'ok'; print: CreditApplicationPrint }
  /** In scope, but outside its window: what the page says instead. */
  | { kind: 'unavailable'; legalName: string; message: string; customerId: string | null };

export type CustomerFormPrint = {
  customerId: string;
  nmwcCode: string;
  temixCode: string | null;
  legalName: string;
  status: CustomerStatus;
  paymentTerms: PaymentTerms;
  customer: PrintRow[];
  credit: PrintRow[] | null;
  branches: PrintBranch[];
  figures: PrintFigure[];
  trail: PrintTrail;
  signatures: Array<{ role: Role; title: string }>;
  /** What the PRINT row records: the onboarding request, and the branches printed. */
  requestId: string | null;
  branchIds: string[];
};

export const STATUS_LABEL: Record<CustomerStatus, string> = {
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  SUSPENDED: 'Suspended',
};

const TERMS_LABEL: Record<PaymentTerms, string> = { CASH: 'Cash', CREDIT: 'Credit' };

const DAY_LABEL: Record<DayOfWeek, string> = {
  SAT: 'Saturday',
  SUN: 'Sunday',
  MON: 'Monday',
  TUE: 'Tuesday',
  WED: 'Wednesday',
  THU: 'Thursday',
  FRI: 'Friday',
};

/** The documents in the order a reader expects them: the four credit documents, a guarantee, the signed form. */
const DOCUMENT_ORDER: readonly DecisionBoundKind[] = [...CREDIT_DOCUMENT_KINDS, 'GUARANTEE', 'CREDIT_FORM'];

type BranchLike = {
  branchName: string;
  address: string;
  areaDescription: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  gpsAccuracy: number | null;
  gpsCapturedAt: Date | null;
  dayOfVisit: DayOfWeek | null;
  openingHours: string | null;
  deliveryWindow: string | null;
  coolersCount: number;
  standsCount: number;
  emptyBottlesCount: number;
};

function locationOf(b: BranchLike): PrintLocation | null {
  if (b.gpsLat == null || b.gpsLng == null) return null;
  return { lat: b.gpsLat, lng: b.gpsLng, accuracy: b.gpsAccuracy, capturedAt: b.gpsCapturedAt };
}

/** The shop's own details, after the rows that say where it sits. */
function shopRows(b: BranchLike): PrintRow[] {
  return [
    { label: 'Address', value: b.address, wide: true },
    { label: 'Landmark', value: b.areaDescription, wide: true },
    { label: 'Day of visit', value: b.dayOfVisit ? DAY_LABEL[b.dayOfVisit] : null },
    { label: 'Opening hours', value: b.openingHours },
    { label: 'Delivery window', value: b.deliveryWindow },
    { label: 'Coolers', value: String(b.coolersCount) },
    { label: 'Stands', value: String(b.standsCount) },
    { label: 'Empty bottles', value: String(b.emptyBottlesCount) },
  ];
}

/** Each page of each document kind, captioned "Owner's ID card — page 1 of 2". */
function documentFigures(docs: ReadonlyArray<{ id: string; kind: string }>): PrintFigure[] {
  const out: PrintFigure[] = [];
  for (const kind of DOCUMENT_ORDER) {
    const pages = docs.filter((d) => d.kind === kind);
    pages.forEach((d, i) =>
      out.push({
        id: d.id,
        caption: pages.length > 1 ? `${CREDIT_DOCUMENT_LABELS[kind]} — page ${i + 1} of ${pages.length}` : CREDIT_DOCUMENT_LABELS[kind],
        document: true,
      })
    );
  }
  return out;
}

const CR_CAPTION = 'CR copy';

/** A draft branch's extra photos: a JSON list of attachment ids. */
function extrasOf(b: { extraPhotoAttachmentIds: unknown }): string[] {
  return Array.isArray(b.extraPhotoAttachmentIds)
    ? b.extraPhotoAttachmentIds.filter((x): x is string => typeof x === 'string')
    : [];
}

/** Which of these attachment ids are live — a slot may still name one removed since. */
async function liveIds(ids: ReadonlyArray<string | null | undefined>, extra: { editId?: string } = {}): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Set();
  const rows = await prisma.attachment.findMany({
    where: { id: { in: wanted }, deletedAt: null, ...(extra.editId ? { editId: extra.editId } : {}) },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * The credit application of a credit new-customer request, for `user`: null when
 * he may not print, it is not a credit new-customer request, or it is outside
 * his scope; 'unavailable', with the reason in words, outside its window.
 */
export async function loadCreditApplicationPrint(
  user: SessionUser,
  editId: string
): Promise<CreditApplicationLoad | null> {
  if (!canPrint(user.role)) return null;
  const edit = await prisma.customerEdit.findUnique({
    where: { id: editId },
    select: {
      id: true,
      process: true,
      state: true,
      approvalChain: true,
      currentStepIndex: true,
      cycle: true,
      customerId: true,
      submittedAt: true,
      slaDueAt: true,
      requestedCreditLimit: true,
      requestedPaymentTermDays: true,
      submittedBy: { select: { fullName: true } },
      customerDraft: {
        select: {
          legalName: true,
          paymentTerms: true,
          crNumber: true,
          primaryPhone: true,
          altPhone: true,
          contactPerson: true,
          contactRole: true,
          email: true,
          notes: true,
          crPhotoAttachmentId: true,
          channel: { select: { label: true } },
          subChannel: { select: { label: true } },
        },
      },
      // No orderBy: the order finalize and the review page read them in.
      branchDrafts: {
        select: {
          branchName: true,
          routeId: true,
          address: true,
          areaDescription: true,
          gpsLat: true,
          gpsLng: true,
          gpsAccuracy: true,
          gpsCapturedAt: true,
          dayOfVisit: true,
          openingHours: true,
          deliveryWindow: true,
          coolersCount: true,
          standsCount: true,
          emptyBottlesCount: true,
          shopPhotoAttachmentId: true,
          signboardPhotoAttachmentId: true,
          extraPhotoAttachmentIds: true,
          // The route's CURRENT region (final-hunt #7/#15): visibility == authorization.
          route: { select: { code: true, regionId: true, region: { select: { name: true } } } },
        },
      },
    },
  });
  if (!edit || edit.process !== 'CREATE' || !edit.customerDraft || edit.customerDraft.paymentTerms !== 'CREDIT') {
    return null;
  }
  const scope = await loadScope(user.id);
  const draftBranches = edit.branchDrafts.map((b) => ({ routeId: b.routeId, regionId: b.route.regionId, deletedAt: null }));
  if (!canSeeCustomer(user, { branches: draftBranches }, scope)) return null;

  const draft = edit.customerDraft;
  if (!creditApplicationAvailable(edit)) {
    return {
      kind: 'unavailable',
      legalName: draft.legalName,
      message: unavailableReason(edit),
      customerId: edit.state === 'APPROVED' ? edit.customerId : null,
    };
  }

  // The documents the customer is asked to sign for, as the request carries
  // them now: live and claimed by it. Not the signed form itself.
  const docs = await prisma.attachment.findMany({
    where: {
      editId: edit.id,
      deletedAt: null,
      kind: { in: [...CREDIT_DOCUMENT_KINDS, 'GUARANTEE'] },
    },
    select: { id: true, kind: true },
    orderBy: { createdAt: 'asc' },
  });
  const live = await liveIds(
    [
      draft.crPhotoAttachmentId,
      ...edit.branchDrafts.flatMap((b) => [b.shopPhotoAttachmentId, b.signboardPhotoAttachmentId, ...extrasOf(b)]),
    ],
    { editId: edit.id }
  );
  const many = edit.branchDrafts.length > 1;
  const figures: PrintFigure[] = [
    ...(draft.crPhotoAttachmentId && live.has(draft.crPhotoAttachmentId)
      ? [{ id: draft.crPhotoAttachmentId, caption: CR_CAPTION, document: true }]
      : []),
    ...documentFigures(docs),
    ...edit.branchDrafts.flatMap((b) => branchFigures(b.branchName, many, b.shopPhotoAttachmentId, b.signboardPhotoAttachmentId, extrasOf(b), live)),
  ];

  return {
    kind: 'ok',
    print: {
      editId: edit.id,
      legalName: draft.legalName,
      submittedBy: edit.submittedBy.fullName,
      submittedAt: edit.submittedAt,
      dueAt: edit.slaDueAt,
      customer: [
        { label: 'Type', value: 'New customer · Credit' },
        { label: 'Customer name', value: draft.legalName },
        { label: 'CR number', value: draft.crNumber, mono: true },
        { label: 'Channel', value: draft.channel?.label ?? null },
        { label: 'Sub-channel', value: draft.subChannel?.label ?? null },
        { label: 'Contact person', value: draft.contactPerson },
        { label: 'Designation', value: draft.contactRole },
        { label: 'Primary phone', value: draft.primaryPhone, mono: true },
        { label: 'Alternate phone', value: draft.altPhone, mono: true },
        { label: 'E-mail', value: draft.email },
        { label: 'Notes', value: draft.notes, wide: true },
      ],
      credit: [
        {
          label: 'Requested credit limit',
          value: edit.requestedCreditLimit != null ? `OMR ${formatRequestedLimit(edit.requestedCreditLimit)}` : null,
        },
        {
          label: 'Requested credit days',
          value: edit.requestedPaymentTermDays != null ? `${edit.requestedPaymentTermDays} days` : null,
        },
      ],
      branches: edit.branchDrafts.map((b, i) => ({
        title: many ? `Shop ${i + 1}: ${b.branchName}` : `Shop: ${b.branchName}`,
        rows: [
          { label: 'Shop name', value: b.branchName },
          { label: 'Region', value: b.route.region.name },
          { label: 'Route', value: b.route.code, mono: true },
          ...shopRows(b),
        ],
        location: locationOf(b),
      })),
      figures,
      cycle: edit.cycle,
      stepIndex: edit.currentStepIndex,
    },
  };
}

/** Where the request is, in words, when its credit application cannot be printed. */
function unavailableReason(edit: { state: string; approvalChain: unknown; currentStepIndex: number }): string {
  const chain = parseChain(edit.approvalChain);
  const formStep = signedFormStepIndex(chain);
  switch (edit.state) {
    case 'APPROVED':
      return 'The request has been approved and the customer created. Print the customer form instead.';
    case 'NEEDS_CORRECTION':
      return 'The request is back with the salesman for correction. It can be printed again once the Sales Director has approved it.';
    case 'DRAFT':
      return 'The request has not been sent yet.';
    case 'REJECTED':
      return 'The request is closed.';
  }
  if (formStep < 0) {
    return 'This request was sent before the signed credit application was part of the process, so it has none to print.';
  }
  const at = stepName(chain[edit.currentStepIndex]);
  return edit.currentStepIndex < formStep
    ? `It can be printed once the Sales Director has approved the request. It is now at the ${at} step.`
    : `The signed application has been uploaded. The request is now at the ${at} step.`;
}

function branchFigures(
  name: string,
  many: boolean,
  shop: string | null,
  signboard: string | null,
  extras: string[],
  live: Set<string>
): PrintFigure[] {
  const of = many ? ` — ${name}` : '';
  return [
    ...(shop && live.has(shop) ? [{ id: shop, caption: `Shop front${of}`, document: false }] : []),
    ...(signboard && live.has(signboard) ? [{ id: signboard, caption: `Signboard${of}`, document: false }] : []),
    ...extras.filter((id) => live.has(id)).map((id) => ({ id, caption: `Other photo${of}`, document: false })),
  ];
}

/**
 * The final customer form of a live customer, for `user`: null when he may not
 * print, it does not exist or is archived, or it is outside his scope. Only the
 * branches he can see are printed (RBAC-05-001), as on the profile.
 */
export async function loadCustomerFormPrint(user: SessionUser, customerId: string): Promise<CustomerFormPrint | null> {
  if (!canPrint(user.role)) return null;
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, deletedAt: null },
    select: {
      id: true,
      nmwcCode: true,
      temixCode: true,
      legalName: true,
      paymentTerms: true,
      status: true,
      crNumber: true,
      primaryPhone: true,
      altPhone: true,
      contactPerson: true,
      contactRole: true,
      email: true,
      notes: true,
      creditLimit: true,
      paymentTermDays: true,
      importBatchId: true,
      crPhotoId: true,
      channel: { select: { label: true } },
      subChannel: { select: { label: true } },
      branches: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          branchCode: true,
          branchName: true,
          routeId: true,
          regionId: true,
          deletedAt: true,
          status: true,
          address: true,
          areaDescription: true,
          gpsLat: true,
          gpsLng: true,
          gpsAccuracy: true,
          gpsCapturedAt: true,
          dayOfVisit: true,
          openingHours: true,
          deliveryWindow: true,
          coolersCount: true,
          standsCount: true,
          emptyBottlesCount: true,
          shopPhotoId: true,
          signboardPhotoId: true,
          region: { select: { name: true } },
          route: { select: { code: true } },
        },
      },
    },
  });
  if (!customer) return null;
  const scope = await loadScope(user.id);
  if (!canSeeCustomer(user, customer, scope)) return null;
  const branches = filterBranchesByScope(user, customer.branches, scope);
  const branchIds = branches.map((b) => b.id);

  const [docs, extras, request] = await Promise.all([
    prisma.attachment.findMany({
      where: { customerId: customer.id, deletedAt: null, kind: { in: [...DECISION_BOUND_KINDS] } },
      select: { id: true, kind: true },
      orderBy: { createdAt: 'asc' },
    }),
    branchIds.length > 0
      ? prisma.attachment.findMany({
          where: { branchExtraId: { in: branchIds }, deletedAt: null },
          select: { id: true, branchExtraId: true },
          orderBy: { createdAt: 'asc' },
        })
      : Promise.resolve([] as Array<{ id: string; branchExtraId: string | null }>),
    // The request that created it (owner decisions 2026-10-11: the approval
    // trail). The latest approved one: a merge never moves a request.
    prisma.customerEdit.findFirst({
      where: { customerId: customer.id, process: 'CREATE', state: 'APPROVED' },
      orderBy: { reviewedAt: 'desc' },
      select: {
        id: true,
        cycle: true,
        approvalChain: true,
        submittedAt: true,
        submittedBy: { select: { fullName: true } },
        steps: {
          orderBy: { at: 'asc' },
          select: { cycle: true, stepIndex: true, decision: true, at: true, actor: { select: { fullName: true } } },
        },
      },
    }),
  ]);
  // Extras were read live; the slots are checked, as one may name a photo removed since.
  const live = new Set([
    ...(await liveIds([customer.crPhotoId, ...branches.flatMap((b) => [b.shopPhotoId, b.signboardPhotoId])])),
    ...extras.map((x) => x.id),
  ]);
  const many = branches.length > 1;
  const figures: PrintFigure[] = [
    ...(customer.crPhotoId && live.has(customer.crPhotoId) ? [{ id: customer.crPhotoId, caption: CR_CAPTION, document: true }] : []),
    ...documentFigures(docs),
    ...branches.flatMap((b) =>
      branchFigures(
        b.branchName,
        many,
        b.shopPhotoId,
        b.signboardPhotoId,
        extras.filter((x) => x.branchExtraId === b.id).map((x) => x.id),
        live
      )
    ),
  ];

  const isCredit = customer.paymentTerms === 'CREDIT';
  return {
    customerId: customer.id,
    nmwcCode: customer.nmwcCode,
    temixCode: customer.temixCode,
    legalName: customer.legalName,
    status: customer.status,
    paymentTerms: customer.paymentTerms,
    customer: [
      { label: 'Customer name', value: customer.legalName },
      { label: 'Payment terms', value: TERMS_LABEL[customer.paymentTerms] },
      { label: 'CR number', value: customer.crNumber, mono: true },
      { label: 'Channel', value: customer.channel?.label ?? null },
      { label: 'Sub-channel', value: customer.subChannel?.label ?? null },
      { label: 'Contact person', value: customer.contactPerson },
      { label: 'Designation', value: customer.contactRole },
      { label: 'Primary phone', value: customer.primaryPhone, mono: true },
      { label: 'Alternate phone', value: customer.altPhone, mono: true },
      { label: 'E-mail', value: customer.email },
      { label: 'Notes', value: customer.notes, wide: true },
    ],
    credit: isCredit
      ? [
          {
            label: 'Credit limit',
            value: customer.creditLimit != null ? `OMR ${customer.creditLimit.toFixed(3)}` : 'Not recorded',
          },
          {
            label: 'Credit days',
            value: customer.paymentTermDays != null ? `${customer.paymentTermDays} days` : 'Not recorded',
          },
        ]
      : null,
    branches: branches.map((b, i) => ({
      title: many ? `Shop ${i + 1}: ${b.branchName}` : `Shop: ${b.branchName}`,
      rows: [
        { label: 'Shop name', value: b.branchName },
        { label: 'Branch code', value: b.branchCode, mono: true },
        { label: 'Region', value: b.region.name },
        { label: 'Route', value: b.route.code, mono: true },
        { label: 'Status', value: STATUS_LABEL[b.status] },
        ...shopRows(b),
      ],
      location: locationOf(b),
    })),
    figures,
    trail: request ? requestTrail(request) : await importTrail(customer.importBatchId),
    signatures: signatureRolesFor(customer.paymentTerms).map((role) => ({ role, title: stepName(role) })),
    requestId: request?.id ?? null,
    branchIds,
  };
}

/**
 * The onboarding request's last round, one row per step of the chain frozen on
 * it: who completed the step (approved it, or for the signed application
 * uploaded it) the last time in that round. A step sent back and taken again
 * shows its final taker; the send-backs are counted, not itemised — the full
 * history, reasons included, stays on the request's page.
 */
function requestTrail(request: {
  id: string;
  cycle: number;
  approvalChain: unknown;
  submittedAt: Date | null;
  submittedBy: { fullName: string };
  steps: Array<{ cycle: number; stepIndex: number; decision: string; at: Date; actor: { fullName: string } }>;
}): PrintTrail {
  const chain = parseChain(request.approvalChain);
  const round = request.steps.filter((s) => s.cycle === request.cycle);
  return {
    kind: 'request',
    requestId: request.id,
    submittedBy: request.submittedBy.fullName,
    submittedAt: request.submittedAt,
    steps: chain.map((step, i) => {
      const taken = [...round].reverse().find((s) => s.stepIndex === i && s.decision !== DECISION_REJECTED);
      return {
        step: stepName(step),
        decision: !taken
          ? 'Not recorded'
          : taken.decision === DECISION_FORM_UPLOADED
            ? 'Signed application uploaded'
            : 'Approved',
        by: taken?.actor.fullName ?? null,
        at: taken?.at ?? null,
      };
    }),
    sentBackInRound: round.filter((s) => s.decision === DECISION_REJECTED).length,
    earlierRounds: Math.max(0, request.cycle - 1),
  };
}

async function importTrail(importBatchId: string | null): Promise<PrintTrail> {
  if (!importBatchId) return { kind: 'none' };
  const batch = await prisma.importBatch.findUnique({ where: { id: importBatchId }, select: { uploadedAt: true } });
  return { kind: 'import', at: batch?.uploadedAt ?? null };
}
