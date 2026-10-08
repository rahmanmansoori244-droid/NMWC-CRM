/**
 * Helpers of tests/e2e/launch/create-chains.spec.ts only (new-customer requests
 * and their approval chains). A NEW file beside the shared support modules, which
 * stay untouched: it imports them, never the other way round.
 *
 *   seedCreateRequest   a CREATE request written straight into UAT as
 *                       services/creates.ts writes one (customer + branch drafts,
 *                       unbound photos claimed through editId, the chain frozen
 *                       at submit), optionally already decided up to a later
 *                       step as approveEditCore's advance leaves it (EditApproval
 *                       rows, the pointer, a fresh stage and SLA clock). Photos
 *                       are real R2 objects (seedPhotos), captured by the
 *                       submitter. It writes NO notification: tests that look at
 *                       notifications drive the real flow.
 *   fastForwardCreate   a seeded or real request moved on to a later step, the
 *                       way the non-final approve moves it.
 *   submitCreateRequestViaApi
 *                       the real path, as the phone sends it: every photo through
 *                       presign → R2 PUT → finalize, then POST
 *                       /api/forms/customer-create. The services run for real
 *                       (gate, duplicates, notifications).
 *   rewriteActionForm   a captured server-action body (multipart, React's
 *                       `<n>_<field>` names) with a field replaced or dropped —
 *                       for the deny-side replays (a credit id in a bulk approve,
 *                       an approve without its decision token).
 *   decisionTokenNow    the decision token of a request as a page rendered NOW
 *                       would carry it (lib/decision-token.ts).
 *   emailVerdictFor     what the e-mail outbox would decide for one notification
 *                       row, with a stand-in address (e-mail stays OFF in the
 *                       suite; nothing is sent, nothing is written).
 *   adoptStrayPhotos    photos a fixture salesman uploaded in a form that was
 *                       never saved — registered, so cleanup removes them.
 *
 * Every typed value carries the world's suffix (legal names, CR numbers, branch
 * names); phones come from world.allocPhones. Ids are minted here and registered
 * BEFORE the insert, like every other seed.
 */
import type { Page } from '@playwright/test';
import { Prisma, type DayOfWeek, type EditState, type PaymentTerms } from '@prisma/client';
import { parseChain, resolveChain, stepDeadline, type ApprovalStep } from '../../../../lib/approval-chains';
import { normalizeCR } from '../../../../lib/cr';
import { decisionTokenFor } from '../../../../lib/decision-token';
import { rowVerdict } from '../../../../lib/email/eligibility';
import { prismaOutboxStore } from '../../../../lib/email/outbox-store';
import { manualGpsMarker } from '../../../../lib/gps-manual';
import { stageSnapshot } from '../../../../lib/working-hours';
import { submitCreateViaApi, uploadPhotoViaApi, type ActionJson } from './api';
import { db, hasR2, safeError } from './env';
import { newId } from './ids';
import { OMAN_TODAY, omanYearNow } from './oman';
import { seedPhotos, type PhotoSpec } from './photos';
import type { SeededPhoto, World } from './types';

/** The chain arithmetic the assertions recompute (the frozen chain, the working-hours deadline). */
export { parseChain, stepDeadline };

/** The shop point the phone project reports, and a seeded draft's default. */
export const SHOP_POINT = { lat: 23.5881, lng: 58.3829, accuracy: 9 } as const;

// ── reference data ───────────────────────────────────────────────────────────

let channelCache: Promise<{ channelId: string; channelLabel: string; subChannelId: string; subChannelLabel: string }> | undefined;

/**
 * The channel pair a new-customer form offers first: GENERAL_TRADE and its
 * first active sub-channel by label (app/(app)/customers/new/page.tsx orders
 * sub-channels by label). Read once per worker.
 */
export function generalTrade(): Promise<{ channelId: string; channelLabel: string; subChannelId: string; subChannelLabel: string }> {
  channelCache ??= db.channel
    .findFirstOrThrow({
      where: { key: 'GENERAL_TRADE', isActive: true },
      select: {
        id: true,
        label: true,
        subChannels: { where: { isActive: true }, orderBy: { label: 'asc' }, take: 1, select: { id: true, label: true } },
      },
    })
    .then((c) => {
      const sub = c.subChannels[0];
      if (!sub) throw new Error('GENERAL_TRADE has no active sub-channel on this database');
      return { channelId: c.id, channelLabel: c.label, subChannelId: sub.id, subChannelLabel: sub.label };
    });
  return channelCache;
}

const crCounters = new Map<string, number>();

/** A CR number unique to this world: CR<SFX>K<n>. */
export function uniqueCr(world: World): string {
  const n = (crCounters.get(world.sfx) ?? 0) + 1;
  crCounters.set(world.sfx, n);
  return `CR${world.SFX}K${String(n).padStart(2, '0')}`;
}

/** The CodeSequence counter of this Oman year (the NEXT number finalize hands out), 1 when none yet. */
export async function codeSequenceNext(year = omanYearNow()): Promise<number> {
  const row = await db.codeSequence.findUnique({ where: { scope: `CUSTOMER-${year}` }, select: { next: true } });
  return row?.next ?? 1;
}

/** The serial number of an NMWC-YYYY-NNNNNN code. */
export function codeSeq(code: string): number {
  const m = /^NMWC-\d{4}-(\d{6})$/.exec(code);
  if (!m) throw new Error(`not an NMWC code: ${code}`);
  return Number(m[1]);
}

// ── seeded requests ──────────────────────────────────────────────────────────

export type CreateBranchSeed = {
  /** Default 'Main <sfx>' for the first branch, 'Branch <n> <sfx>' after. */
  name?: string;
  /** Default SHOP_POINT. null = no point (a draft only). */
  gps?: { lat: number; lng: number; accuracy: number | null } | null;
  /** A point typed in by hand, and why (item 41): no accuracy, a marker in fieldChanges. */
  manualReason?: string;
  /** Default OMAN_TODAY. */
  day?: DayOfWeek | null;
  address?: string;
  /** Shop and signboard photos (default true). */
  photos?: boolean;
  /** Extra (FREE) photos, at most 2 from the form. */
  extras?: number;
};

export type CreateSeed = {
  /** User key of a SALESMAN with a route. */
  submitter: string;
  paymentTerms?: PaymentTerms;
  legalName?: string;
  /** Default a fresh CR<SFX>K<n>; null = none. */
  crNumber?: string | null;
  /** Default a fresh +9689… number; null = none. */
  phone?: string | null;
  contact?: string | null;
  /** The CR document photo (default true). */
  crPhoto?: boolean;
  /** CREDIT only. Default 500, 30. */
  credit?: { limit: number; days: number };
  /** GUARANTEE documents (CREDIT default 1). */
  guarantees?: number;
  /** Default one branch. */
  branches?: CreateBranchSeed[];
  state?: Extract<EditState, 'DRAFT' | 'SUBMITTED' | 'NEEDS_CORRECTION'>;
  /** SUBMITTED: the chain step it waits at (default 0). */
  step?: number;
  /** User keys who approved steps 0..step-1, in order. */
  approvedBy?: string[];
  /** When the current stage began (default now). */
  stageEnteredAt?: Date;
  escalationLevel?: number;
  slaBreachedAt?: Date | null;
  /** NEEDS_CORRECTION: who sent it back, and why. */
  decision?: { by: string; reason: string; category?: string };
};

export type SeededCreate = {
  id: string;
  legalName: string;
  crNumber: string | null;
  phone: string | null;
  paymentTerms: PaymentTerms;
  chain: ApprovalStep[];
  branchNames: string[];
  photos: {
    cr: SeededPhoto | null;
    guarantees: SeededPhoto[];
    branches: Array<{ shop: SeededPhoto | null; signboard: SeededPhoto | null; extras: SeededPhoto[] }>;
  };
};

/**
 * A CREATE request at a given step, written as services/creates.ts writes the
 * submit and approveEditCore the advances before it. Needs R2 for its photos
 * (the caller skips without it).
 */
export async function seedCreateRequest(w: World, o: CreateSeed): Promise<SeededCreate> {
  if (!hasR2) throw new Error('seedCreateRequest: its photos need R2 — skip the test when hasR2 is false');
  const submitter = w.user(o.submitter);
  if (!submitter.routeId) throw new Error(`seedCreateRequest: ${o.submitter} owns no route`);
  const route = await db.route.findUniqueOrThrow({ where: { id: submitter.routeId }, select: { id: true, regionId: true } });
  const terms: PaymentTerms = o.paymentTerms ?? 'CASH';
  const isCredit = terms === 'CREDIT';
  const chain = resolveChain('CREATE', terms);
  const state = o.state ?? 'SUBMITTED';
  const step = state === 'SUBMITTED' ? (o.step ?? 0) : 0;
  if (step < 0 || step >= chain.length) throw new Error(`seedCreateRequest: step ${step} is not on a ${terms} chain`);
  const approvers = o.approvedBy ?? [];
  if (state === 'SUBMITTED' && approvers.length !== step) {
    throw new Error(`seedCreateRequest: step ${step} needs ${step} approver key(s), got ${approvers.length}`);
  }
  const ch = await generalTrade();
  const legalName = o.legalName ?? w.name(`Seeded ${terms === 'CASH' ? 'Cash' : 'Credit'} Store`);
  const crNumber = o.crNumber === undefined ? uniqueCr(w) : o.crNumber;
  const phone = o.phone === undefined ? (await w.allocPhones(1))[0]! : o.phone;
  const branches = (o.branches ?? [{}]).map((b, i) => ({
    name: b.name ?? (i === 0 ? w.name('Main') : w.name(`Branch ${i + 1}`)),
    gps: b.gps === undefined ? { ...SHOP_POINT } : b.gps,
    manualReason: b.manualReason,
    day: b.day === undefined ? OMAN_TODAY : b.day,
    address: b.address ?? 'Way 3012, Al Ghubra North, Muscat',
    photos: b.photos ?? true,
    extras: b.extras ?? 0,
  }));
  const now = new Date();
  const stageEnteredAt = o.stageEnteredAt ?? now;
  const id = newId();
  w.registry.add('editIds', id);

  const decided = state === 'NEEDS_CORRECTION';
  const credit = isCredit ? (o.credit ?? { limit: 500, days: 30 }) : null;
  const gpsMarkers = branches.flatMap((b, i) =>
    b.manualReason && b.gps ? [manualGpsMarker(i, b.gps.lat, b.gps.lng, b.manualReason)] : []
  );
  try {
    await db.customerEdit.create({
      data: {
        id,
        target: 'CUSTOMER',
        process: 'CREATE',
        customerId: null,
        submittedById: submitter.id,
        fieldChanges: gpsMarkers as unknown as Prisma.InputJsonValue,
        attachmentChanges: [] as unknown as Prisma.InputJsonValue,
        cycle: 1,
        state,
        requestedCreditLimit: credit ? new Prisma.Decimal(credit.limit.toFixed(3)) : null,
        requestedPaymentTermDays: credit ? credit.days : null,
        ...(state === 'DRAFT'
          ? {}
          : {
              submittedAt: stageEnteredAt,
              paymentTermsAtSubmit: terms,
              approvalChain: chain as unknown as Prisma.InputJsonValue,
              currentStepIndex: step,
            }),
        ...(state === 'SUBMITTED'
          ? {
              pendingRole: chain[step]!.role,
              stageEnteredAt,
              slaDueAt: stepDeadline(stageEnteredAt, chain[step]!.slaHours),
              escalationLevel: o.escalationLevel ?? 0,
              slaBreachedAt: o.slaBreachedAt ?? null,
            }
          : {}),
        ...(decided
          ? {
              pendingRole: null,
              slaDueAt: null,
              decisionReason: o.decision?.reason ?? 'Seeded: returned for correction',
              decisionCategory: o.decision?.category ?? 'other',
              reviewedById: o.decision ? w.user(o.decision.by).id : null,
              reviewedAt: now,
            }
          : {}),
      },
    });
  } catch (err) {
    throw safeError(err, 'seedCreateRequest: the request row');
  }

  // Unbound photos, claimed by the request through editId (the form uploads
  // them unbound; the submit claims them; finalize binds them to slots).
  type Planned = { slot: 'cr' | 'guarantee' | 'shop' | 'signboard' | 'extra'; branch?: number; spec: PhotoSpec };
  const planned: Planned[] = [];
  const photo = (kind: PhotoSpec['kind']): PhotoSpec => ({ kind, capturedBy: o.submitter, editId: id });
  if (o.crPhoto ?? true) planned.push({ slot: 'cr', spec: photo('CR') });
  for (let g = 0; g < (o.guarantees ?? (isCredit ? 1 : 0)); g++) planned.push({ slot: 'guarantee', spec: photo('GUARANTEE') });
  branches.forEach((b, i) => {
    if (b.photos) {
      planned.push({ slot: 'shop', branch: i, spec: photo('SHOP') });
      planned.push({ slot: 'signboard', branch: i, spec: photo('SIGNBOARD') });
    }
    for (let x = 0; x < b.extras; x++) planned.push({ slot: 'extra', branch: i, spec: photo('FREE') });
  });
  const seeded = await seedPhotos(w, planned.map((p) => p.spec));
  const out: SeededCreate['photos'] = {
    cr: null,
    guarantees: [],
    branches: branches.map(() => ({ shop: null, signboard: null, extras: [] })),
  };
  planned.forEach((p, i) => {
    const s = seeded[i]!;
    if (p.slot === 'cr') out.cr = s;
    else if (p.slot === 'guarantee') out.guarantees.push(s);
    else if (p.slot === 'shop') out.branches[p.branch!]!.shop = s;
    else if (p.slot === 'signboard') out.branches[p.branch!]!.signboard = s;
    else out.branches[p.branch!]!.extras.push(s);
  });

  try {
    await db.editCustomerDraft.create({
      data: {
        editId: id,
        legalName,
        paymentTerms: terms,
        crNumber,
        crNumberNorm: normalizeCR(crNumber),
        channelId: ch.channelId,
        subChannelId: ch.subChannelId,
        primaryPhone: phone,
        primaryPhoneNorm: phone,
        contactPerson: o.contact === undefined ? 'Salim Al Habsi' : o.contact,
        crPhotoAttachmentId: out.cr?.id ?? null,
      },
    });
    // One insert, in form order: finalize numbers the branches -01, -02 … in the
    // order the request loads them.
    await db.editBranchDraft.createMany({
      data: branches.map((b, i) => ({
        editId: id,
        branchName: b.name,
        regionId: route.regionId,
        routeId: route.id,
        address: b.address,
        gpsLat: b.gps?.lat ?? null,
        gpsLng: b.gps?.lng ?? null,
        gpsAccuracy: b.manualReason ? null : (b.gps?.accuracy ?? null),
        gpsCapturedAt: b.gps ? now : null,
        dayOfVisit: b.day,
        shopPhotoAttachmentId: out.branches[i]!.shop?.id ?? null,
        signboardPhotoAttachmentId: out.branches[i]!.signboard?.id ?? null,
        extraPhotoAttachmentIds: out.branches[i]!.extras.map((x) => x.id) as unknown as Prisma.InputJsonValue,
      })),
    });
    // The decisions of the steps already passed (append-only ledger), oldest first.
    for (let s = 0; s < approvers.length; s++) {
      await db.editApproval.create({
        data: {
          editId: id,
          cycle: 1,
          stepIndex: s,
          role: chain[s]!.role,
          decision: 'APPROVED',
          actorId: w.user(approvers[s]!).id,
          at: new Date(stageEnteredAt.getTime() - (approvers.length - s) * 60_000),
        },
      });
    }
    if (decided && o.decision) {
      await db.editApproval.create({
        data: {
          editId: id,
          cycle: 1,
          stepIndex: 0,
          role: chain[0]!.role,
          decision: 'REJECTED',
          actorId: w.user(o.decision.by).id,
          reason: o.decision.reason,
          at: now,
        },
      });
    }
  } catch (err) {
    throw safeError(err, 'seedCreateRequest: the drafts');
  }
  return {
    id,
    legalName,
    crNumber,
    phone,
    paymentTerms: terms,
    chain,
    branchNames: branches.map((b) => b.name),
    photos: out,
  };
}

/**
 * Moves a SUBMITTED request on to `toStep`, as approveEditCore's non-final
 * advance does for each step passed: an APPROVED EditApproval with the stage
 * snapshot, then the pointer, the pending role, a fresh stage and SLA clock.
 * No notification is written (see the header).
 */
export async function fastForwardCreate(w: World, editId: string, toStep: number, approvers: string[]): Promise<void> {
  const edit = await db.customerEdit.findUniqueOrThrow({
    where: { id: editId },
    select: { state: true, approvalChain: true, currentStepIndex: true, cycle: true, stageEnteredAt: true, slaDueAt: true, submittedAt: true },
  });
  if (edit.state !== 'SUBMITTED') throw new Error(`fastForwardCreate: the request is ${edit.state}`);
  const chain = parseChain(edit.approvalChain);
  if (toStep <= edit.currentStepIndex || toStep >= chain.length) throw new Error(`fastForwardCreate: cannot move from ${edit.currentStepIndex} to ${toStep}`);
  if (approvers.length !== toStep - edit.currentStepIndex) throw new Error('fastForwardCreate: one approver per step passed');
  let stage = { stageEnteredAt: edit.stageEnteredAt, slaDueAt: edit.slaDueAt, submittedAt: edit.submittedAt };
  for (let s = edit.currentStepIndex, k = 0; s < toStep; s++, k++) {
    const at = new Date();
    await db.editApproval.create({
      data: {
        editId,
        cycle: edit.cycle,
        stepIndex: s,
        role: chain[s]!.role,
        decision: 'APPROVED',
        actorId: w.user(approvers[k]!).id,
        at,
        ...stageSnapshot(stage, at),
      },
    });
    stage = { stageEnteredAt: at, slaDueAt: stepDeadline(at, chain[s + 1]!.slaHours), submittedAt: edit.submittedAt };
  }
  const enteredAt = new Date();
  await db.customerEdit.update({
    where: { id: editId },
    data: {
      currentStepIndex: toStep,
      pendingRole: chain[toStep]!.role,
      stageEnteredAt: enteredAt,
      slaDueAt: stepDeadline(enteredAt, chain[toStep]!.slaHours),
      escalationLevel: 0,
      slaBreachedAt: null,
      lastEscalatedAt: null,
    },
  });
}

// ── the real submit, over the phone's own routes ────────────────────────────

export type ApiCreate = {
  paymentTerms?: PaymentTerms;
  legalName: string;
  crNumber?: string | null;
  phone?: string | null;
  contact?: string;
  credit?: { limit: number | string; days: number | string };
  guarantees?: number;
  branches?: Array<{
    name?: string;
    gps?: { lat: number; lng: number; accuracy?: number };
    manualReason?: string;
    day?: DayOfWeek;
    address?: string;
    extras?: number;
  }>;
  isDraft?: boolean;
  editId?: string;
  /** Photos already uploaded (refused submits leave them unclaimed): reuse instead of uploading again. */
  reuse?: CreatePhotoIds;
};

export type CreatePhotoIds = {
  cr: string | null;
  guarantees: string[];
  branches: Array<{ shop: string | null; signboard: string | null; extras: string[] }>;
};

/**
 * Uploads every photo a new-customer request needs, as the page's salesman,
 * through presign → R2 PUT → finalize (no attach: the form leaves them unbound).
 */
export async function uploadCreatePhotos(
  page: Page,
  w: World,
  o: { credit?: boolean; guarantees?: number; branches: Array<{ extras?: number }> }
): Promise<CreatePhotoIds> {
  const up = async (kind: 'CR' | 'GUARANTEE' | 'SHOP' | 'SIGNBOARD' | 'FREE') => (await uploadPhotoViaApi(page, w, { kind })).attachmentId;
  const cr = await up('CR');
  const guarantees: string[] = [];
  for (let g = 0; g < (o.guarantees ?? (o.credit ? 1 : 0)); g++) guarantees.push(await up('GUARANTEE'));
  const branches: CreatePhotoIds['branches'] = [];
  for (const b of o.branches) {
    const shop = await up('SHOP');
    const signboard = await up('SIGNBOARD');
    const extras: string[] = [];
    for (let x = 0; x < (b.extras ?? 0); x++) extras.push(await up('FREE'));
    branches.push({ shop, signboard, extras });
  }
  return { cr, guarantees, branches };
}

/**
 * A new-customer request through the real route, as the page's salesman. Returns
 * the route's answer and the photo ids (so a refused attempt can be sent again
 * with the same photos). The request is registered with the world when it lands.
 */
export async function submitCreateRequestViaApi(
  page: Page,
  w: World,
  o: ApiCreate
): Promise<{ answer: ActionJson; editId: string | undefined; photos: CreatePhotoIds; body: Record<string, unknown> }> {
  const terms = o.paymentTerms ?? 'CASH';
  const branchesIn = o.branches ?? [{}];
  const photos =
    o.reuse ?? (await uploadCreatePhotos(page, w, { credit: terms === 'CREDIT', guarantees: o.guarantees, branches: branchesIn }));
  const ch = await generalTrade();
  const body: Record<string, unknown> = {
    ...(o.editId ? { editId: o.editId } : {}),
    isDraft: o.isDraft ?? false,
    customer: {
      legalName: o.legalName,
      paymentTerms: terms,
      ...(o.crNumber === null ? {} : { crNumber: o.crNumber ?? uniqueCr(w) }),
      channelId: ch.channelId,
      subChannelId: ch.subChannelId,
      ...(o.phone === null ? {} : { primaryPhone: o.phone ?? (await w.allocPhones(1))[0]! }),
      contactPerson: o.contact ?? 'Salim Al Habsi',
      ...(photos.cr ? { crPhotoAttachmentId: photos.cr } : {}),
    },
    ...(terms === 'CREDIT'
      ? { credit: { requestedCreditLimit: o.credit?.limit ?? 500, requestedPaymentTermDays: o.credit?.days ?? 30 } }
      : {}),
    guaranteeAttachmentIds: terms === 'CREDIT' ? photos.guarantees : [],
    branches: branchesIn.map((b, i) => {
      const gps = b.gps ?? { lat: SHOP_POINT.lat, lng: SHOP_POINT.lng, accuracy: SHOP_POINT.accuracy };
      return {
        branchName: b.name ?? (i === 0 ? w.name('Main') : w.name(`Branch ${i + 1}`)),
        address: b.address ?? 'Way 3012, Al Ghubra North, Muscat',
        gpsLat: gps.lat,
        gpsLng: gps.lng,
        ...(b.manualReason ? { gpsManualReason: b.manualReason } : gps.accuracy !== undefined ? { gpsAccuracy: gps.accuracy } : {}),
        gpsCapturedAt: new Date().toISOString(),
        dayOfVisit: b.day ?? OMAN_TODAY,
        coolersCount: 0,
        standsCount: 0,
        emptyBottlesCount: 0,
        shopPhotoAttachmentId: photos.branches[i]?.shop ?? undefined,
        signboardPhotoAttachmentId: photos.branches[i]?.signboard ?? undefined,
        extraPhotoAttachmentIds: photos.branches[i]?.extras ?? [],
      };
    }),
  };
  const answer = await submitCreateViaApi(page, body, { world: w });
  const editId = (answer.data as { editId?: string } | undefined)?.editId;
  return { answer, editId, photos, body };
}

// ── server-action replays ────────────────────────────────────────────────────

/**
 * A captured server-action body with fields replaced or removed. The body is
 * multipart: React's encodeReply names a FormData argument's entries
 * `<ref>_<field>` (and the argument list itself is part "0"), so a field is
 * matched by its own name or by the `_<name>` suffix.
 */
export function rewriteActionForm(
  body: Buffer,
  contentType: string,
  edit: { set?: Record<string, string>; drop?: string[] }
): Buffer {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) throw new Error(`rewriteActionForm: not a multipart body (${contentType})`);
  const b = boundary[1] ?? boundary[2]!;
  const text = body.toString('latin1');
  const delimiter = `--${b}`;
  const chunks = text.split(delimiter);
  // chunks[0] is the preamble (empty); the last starts with "--" (the close).
  const parts = chunks.slice(1, -1);
  const matches = (name: string, field: string) => name === field || name.endsWith(`_${field}`);
  const touched = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const m = /name="([^"]+)"/.exec(part);
    const name = m?.[1] ?? '';
    const drop = (edit.drop ?? []).find((f) => matches(name, f));
    if (drop) {
      touched.add(drop);
      continue;
    }
    const set = Object.keys(edit.set ?? {}).find((f) => matches(name, f));
    if (set) {
      touched.add(set);
      const headEnd = part.indexOf('\r\n\r\n');
      const value = Buffer.from(edit.set![set]!, 'utf8').toString('latin1');
      out.push(`${part.slice(0, headEnd + 4)}${value}\r\n`);
      continue;
    }
    out.push(part);
  }
  for (const f of [...Object.keys(edit.set ?? {}), ...(edit.drop ?? [])]) {
    if (!touched.has(f)) throw new Error(`rewriteActionForm: the captured body has no field "${f}"`);
  }
  return Buffer.from(`${out.map((p) => `${delimiter}${p}`).join('')}${delimiter}--\r\n`, 'latin1');
}

/** The decision token a page rendered now would carry for this request (lib/decision-token.ts). */
export async function decisionTokenNow(editId: string): Promise<string> {
  const row = await db.customerEdit.findUniqueOrThrow({
    where: { id: editId },
    select: { process: true, cycle: true, currentStepIndex: true, stageEnteredAt: true, requestedCreditLimit: true, requestedPaymentTermDays: true },
  });
  const guarantees = await db.attachment.findMany({
    where: { editId, kind: 'GUARANTEE', deletedAt: null },
    select: { id: true },
  });
  return decisionTokenFor(row, guarantees.map((g) => g.id));
}

// ── the e-mail outbox, decided without sending ───────────────────────────────

/**
 * What the outbox (lib/email/drain.ts) would decide for one notification row
 * NOW, by the drain's own rowVerdict, with the recipient's stored address
 * replaced by a stand-in (fixture accounts have none, and e-mail is off in the
 * suite: nothing is sent and nothing is written).
 */
export async function emailVerdictFor(notificationId: string): Promise<{ send: boolean; status: string | null }> {
  const n = await db.notification.findUniqueOrThrow({
    where: { id: notificationId },
    select: { id: true, userId: true, kind: true, editId: true, createdAt: true, readAt: true },
  });
  const store = prismaOutboxStore(db, { userIds: [n.userId] });
  const [recipient] = await store.loadRecipients([n.userId]);
  const [request] = n.editId ? await store.loadRequests([n.editId]) : [];
  const v = rowVerdict(
    { id: n.id, userId: n.userId, kind: n.kind, editId: n.editId, createdAt: n.createdAt, readAt: n.readAt },
    recipient ? { ...recipient, email: 'outbox.check@example.com' } : undefined,
    request,
    new Date()
  );
  return v.send ? { send: true, status: null } : { send: false, status: v.status };
}

// ── photos of a form never saved ─────────────────────────────────────────────

/**
 * Registers the photos `userKey` uploaded since `since` that no request or slot
 * claimed — a form never saved, a branch removed before a save. Unregistered,
 * cleanup would count them foreign and keep the salesman (the world stays dirty).
 */
export async function adoptStrayPhotos(w: World, userKey: string, since: Date): Promise<number> {
  const rows = await db.attachment.findMany({
    where: {
      capturedById: w.user(userKey).id,
      createdAt: { gte: since },
      editId: null,
      customerId: null,
      branchId: null,
      branchExtraId: null,
    },
    select: { id: true },
  });
  rows.forEach((r) => w.adopt.attachment(r.id));
  return rows.length;
}
