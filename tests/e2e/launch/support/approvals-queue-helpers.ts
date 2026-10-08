/**
 * Helpers for tests/e2e/launch/approvals-queue.spec.ts only (additive; no other
 * support file is changed).
 *
 *   approvableCustomer() — a customer spec whose customer-level request passes
 *     the approval re-check (EL-04) with no photo, under either submit gate.
 *   seedCreateRequest()  — a new-customer request at a given step of its chain,
 *     written as services/creates.ts writes one (the drafts, the frozen chain,
 *     the SLA clock), optionally with real photos in R2 claimed by the request.
 *   seedBranchRequest()  — a close-shop or reactivation request, written as
 *     services/reactivations.ts writes one, with its evidence photo wired onto
 *     the branch the way wireEvidence leaves it.
 *   createRequestViaApi() — a complete new-customer request sent through the
 *     real /api/forms/customer-create route, with real uploads.
 *   slaSweepImpact()     — what GET /api/cron/sla-escalate would touch that is
 *     NOT the world's (read-only), for the exclusive SLA test's precondition.
 *   tallyPhotoResponses(), imagesLoaded(), queueCard(), kpiTile(), bell().
 *   relayR2Puts()        — on a lane's own E2E_PORT, the page's photo PUTs to
 *     R2 are relayed from Node (R2's CORS admits http://localhost:3000 only).
 *
 * Every id is minted here and written to the world's registry BEFORE its row is
 * inserted, as the harness requires; every typed value carries the suffix.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { PaymentTerms, Prisma, Role } from '@prisma/client';
import { resolveChain, stepDeadline } from '../../../../lib/approval-chains';
import { normalizeCR } from '../../../../lib/cr';
import { DEFAULT_STAGE_SLA_MIN, STAGE_SLA_MINUTES } from '../../../../lib/working-hours';
import { receiptEditId, submitCreateViaApi, uploadPhotoViaApi } from './api';
import { db, hasR2, PORT, safeError } from './env';
import { newId } from './ids';
import { OMAN_TODAY, omanDayAfter } from './oman';
import { seedPhoto, seedPhotos, type PhotoSpec } from './photos';
import type { CustomerSpec, World } from './types';
import { MUSCAT } from './world';

const GPS = { lat: MUSCAT.lat, lng: MUSCAT.lng, accuracy: MUSCAT.accuracy };

/**
 * A customer whose CUSTOMER-LEVEL request (a contact-person change) can be
 * approved without any photo, whatever SALESMAN_SUBMIT_GATE is: on a CREDIT
 * customer the CR number and the CR document are not the salesman's (owner
 * decision 2), so the re-check reads channel, sub-channel, phone and contact
 * only — all present here — and no branch (owner decision 4). The queue tests
 * use it so dozens of requests can be approved without uploading to R2.
 */
export function approvableCustomer(key: string, route: string, extra: Partial<CustomerSpec> = {}): CustomerSpec {
  return {
    key,
    paymentTerms: 'CREDIT',
    creditLimit: '500.000',
    termDays: 30,
    phone: true,
    contact: 'Khalid Al Harthy',
    crNumber: true,
    subChannel: true,
    branches: [{ key: 'S', route, gps: GPS, day: omanDayAfter(2), address: 'Way 3012, Al Ghubra North, Muscat' }],
    ...extra,
  };
}

const counters = new WeakMap<World, number>();
function next(w: World): number {
  const n = (counters.get(w) ?? 0) + 1;
  counters.set(w, n);
  return n;
}

async function generalTrade(): Promise<{ channelId: string; subChannelId: string }> {
  const ch = await db.channel.findFirst({
    where: { key: 'GENERAL_TRADE' },
    select: { id: true, subChannels: { where: { isActive: true }, select: { id: true }, orderBy: { key: 'asc' }, take: 1 } },
  });
  if (!ch || ch.subChannels.length === 0) throw new Error('GENERAL_TRADE with an active sub-channel is not on this database');
  return { channelId: ch.id, subChannelId: ch.subChannels[0]!.id };
}

async function routeOf(w: World, userKey: string): Promise<{ routeId: string; regionId: string }> {
  const u = w.user(userKey);
  if (!u.routeId) throw new Error(`${userKey} has no route`);
  const r = await db.route.findUniqueOrThrow({ where: { id: u.routeId }, select: { id: true, regionId: true } });
  return { routeId: r.id, regionId: r.regionId };
}

/**
 * A new-customer request waiting at `step` (default the first, SUPERVISOR) of
 * its frozen chain, as services/creates.ts leaves a submitted one. Steps before
 * `step` are recorded as approved by `priorApprovers` (user keys, one per step).
 * With `photos` (and R2), real photos are stored and claimed by the request:
 * the CR document, a shop, a signboard and one extra photo per branch, and a
 * guarantee for a credit request.
 */
export async function seedCreateRequest(
  w: World,
  o: {
    submitter: string;
    paymentTerms?: PaymentTerms;
    step?: Role;
    priorApprovers?: string[];
    branches?: number;
    photos?: boolean;
    legalName?: string;
    submittedAt?: Date;
    stageEnteredAt?: Date;
    slaDueAt?: Date;
    escalationLevel?: number;
  }
): Promise<{ id: string; legalName: string; photoIds: string[] }> {
  const terms: PaymentTerms = o.paymentTerms ?? 'CASH';
  const chain = resolveChain('CREATE', terms);
  const stepIndex = o.step ? chain.findIndex((s) => s.role === o.step) : 0;
  if (stepIndex < 0) throw new Error(`seedCreateRequest: a ${terms} request has no ${o.step} step`);
  const n = next(w);
  const legalName = o.legalName ?? w.name(`New ${terms} shop ${n}`);
  if (!w.carriesSuffix(legalName)) throw new Error('seedCreateRequest: the legal name must carry the world suffix');
  const submitter = w.user(o.submitter);
  const { routeId, regionId } = await routeOf(w, o.submitter);
  const { channelId, subChannelId } = await generalTrade();
  const [phone] = await w.allocPhones(1);
  const cr = `CRN${w.SFX}${String(n).padStart(2, '0')}`;
  const submittedAt = o.submittedAt ?? new Date();
  const stageEnteredAt = o.stageEnteredAt ?? submittedAt;
  const step = chain[stepIndex]!;
  const id = newId();
  w.registry.add('editIds', id);
  const branchCount = o.branches ?? 1;
  const branchIds = Array.from({ length: branchCount }, () => newId());
  try {
    await db.customerEdit.create({
      data: {
        id,
        target: 'CUSTOMER',
        process: 'CREATE',
        customerId: null,
        state: 'SUBMITTED',
        submittedById: submitter.id,
        submittedAt,
        fieldChanges: [] as unknown as Prisma.InputJsonValue,
        attachmentChanges: [] as unknown as Prisma.InputJsonValue,
        paymentTermsAtSubmit: terms,
        approvalChain: chain as unknown as Prisma.InputJsonValue,
        currentStepIndex: stepIndex,
        pendingRole: step.role,
        cycle: 1,
        requestedCreditLimit: terms === 'CREDIT' ? '1500.000' : null,
        requestedPaymentTermDays: terms === 'CREDIT' ? 30 : null,
        stageEnteredAt,
        slaDueAt: o.slaDueAt ?? stepDeadline(stageEnteredAt, step.slaHours),
        escalationLevel: o.escalationLevel ?? 0,
      },
    });
    await db.editCustomerDraft.create({
      data: {
        editId: id,
        legalName,
        paymentTerms: terms,
        crNumber: cr,
        crNumberNorm: normalizeCR(cr),
        channelId,
        subChannelId,
        primaryPhone: phone!,
        primaryPhoneNorm: phone!,
        contactPerson: 'Saif Al Hinai',
      },
    });
    await db.editBranchDraft.createMany({
      data: branchIds.map((bid, i) => ({
        id: bid,
        editId: id,
        branchName: `${legalName} B${i + 1}`,
        regionId,
        routeId,
        address: 'Way 3012, Al Ghubra North, Muscat',
        gpsLat: GPS.lat,
        gpsLng: GPS.lng,
        gpsAccuracy: GPS.accuracy,
        gpsCapturedAt: submittedAt,
        dayOfVisit: OMAN_TODAY,
        extraPhotoAttachmentIds: [] as unknown as Prisma.InputJsonValue,
      })),
    });
    for (let i = 0; i < stepIndex; i++) {
      const by = o.priorApprovers?.[i];
      if (!by) continue;
      await db.editApproval.create({
        data: { editId: id, cycle: 1, stepIndex: i, role: chain[i]!.role, decision: 'APPROVED', actorId: w.user(by).id, at: stageEnteredAt },
      });
    }
  } catch (err) {
    throw safeError(err, 'seedCreateRequest insert failed');
  }

  const photoIds: string[] = [];
  if (o.photos && hasR2) {
    const specs: PhotoSpec[] = [{ kind: 'CR', capturedBy: o.submitter, editId: id }];
    if (terms === 'CREDIT') specs.push({ kind: 'GUARANTEE', capturedBy: o.submitter, editId: id });
    for (let i = 0; i < branchCount; i++) {
      specs.push(
        { kind: 'SHOP', capturedBy: o.submitter, editId: id },
        { kind: 'SIGNBOARD', capturedBy: o.submitter, editId: id },
        { kind: 'FREE', capturedBy: o.submitter, editId: id }
      );
    }
    const seeded = await seedPhotos(w, specs);
    photoIds.push(...seeded.map((p) => p.id));
    const byKind = (k: string) => seeded.filter((p) => p.kind === k);
    await db.editCustomerDraft.update({ where: { editId: id }, data: { crPhotoAttachmentId: byKind('CR')[0]!.id } });
    for (const [i, bid] of branchIds.entries()) {
      await db.editBranchDraft.update({
        where: { id: bid },
        data: {
          shopPhotoAttachmentId: byKind('SHOP')[i]!.id,
          signboardPhotoAttachmentId: byKind('SIGNBOARD')[i]!.id,
          extraPhotoAttachmentIds: [byKind('FREE')[i]!.id] as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }
  return { id, legalName, photoIds };
}

/**
 * A close-shop ("Mark closed") or reactivation request, as markBranchClosedCore /
 * requestReactivationCore write it: target BRANCH, the status flip as its only
 * change, the salesman's reason in decisionReason, pendingRole SUPERVISOR (close)
 * or MANAGER (reactivation) on the SLA clock, and the evidence photo — when R2 is
 * configured — on the branch as an extra photo, captured by the salesman.
 */
export async function seedBranchRequest(
  w: World,
  o: {
    kind: 'close' | 'reactivate';
    branch: string;
    submitter: string;
    reason?: string;
    evidence?: boolean;
    submittedAt?: Date;
    stageEnteredAt?: Date;
    slaDueAt?: Date;
    escalationLevel?: number;
  }
): Promise<{ id: string; evidenceId: string | null; reason: string }> {
  const branch = w.branch(o.branch);
  const close = o.kind === 'close';
  const submittedAt = o.submittedAt ?? new Date();
  const stageEnteredAt = o.stageEnteredAt ?? submittedAt;
  const role: Role = close ? 'SUPERVISOR' : 'MANAGER';
  const reason = o.reason ?? w.name(close ? 'Shop shut for good' : 'Shop open again');
  let evidenceId: string | null = null;
  if ((o.evidence ?? true) && hasR2) {
    const p = await seedPhoto(w, {
      kind: 'FREE',
      capturedBy: o.submitter,
      branchId: branch.id,
      branchExtraId: branch.id,
      capturedAt: submittedAt,
    });
    evidenceId = p.id;
  }
  const id = newId();
  w.registry.add('editIds', id);
  try {
    await db.customerEdit.create({
      data: {
        id,
        target: 'BRANCH',
        branchId: branch.id,
        customerId: branch.customerId,
        state: 'SUBMITTED',
        submittedById: w.user(o.submitter).id,
        submittedAt,
        isReactivation: !close,
        decisionReason: reason,
        pendingRole: role,
        stageEnteredAt,
        slaDueAt: o.slaDueAt ?? stepDeadline(stageEnteredAt, (STAGE_SLA_MINUTES[role] ?? DEFAULT_STAGE_SLA_MIN) / 60),
        escalationLevel: o.escalationLevel ?? 0,
        fieldChanges: [
          { field: `branch.${branch.id}.status`, before: close ? 'ACTIVE' : 'CLOSED', after: close ? 'CLOSED' : 'ACTIVE' },
        ] as unknown as Prisma.InputJsonValue,
        attachmentChanges: (evidenceId
          ? [{ kind: 'FREE', attachmentId: evidenceId, action: 'EVIDENCE' }]
          : []) as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    throw safeError(err, 'seedBranchRequest insert failed');
  }
  return { id, evidenceId, reason };
}

/**
 * A complete new-customer request sent by the salesman whose session `page`
 * holds, through the real route (POST /api/forms/customer-create), with every
 * photo the gate asks for uploaded through presign → R2 → finalize. Returns the
 * body, so the same request can be sent again after a send-back
 * (`{ ...body, editId }`). Needs R2.
 */
export async function createRequestViaApi(
  page: Page,
  w: World,
  o: { paymentTerms?: PaymentTerms } = {}
): Promise<{ editId: string; legalName: string; body: Record<string, unknown> }> {
  const terms: PaymentTerms = o.paymentTerms ?? 'CASH';
  const n = next(w);
  const legalName = w.name(`Api ${terms} shop ${n}`);
  const { channelId, subChannelId } = await generalTrade();
  const [phone] = await w.allocPhones(1);
  const up = async (kind: 'CR' | 'SHOP' | 'SIGNBOARD' | 'GUARANTEE') => (await uploadPhotoViaApi(page, w, { kind })).attachmentId;
  const cr = await up('CR');
  const shop = await up('SHOP');
  const sign = await up('SIGNBOARD');
  const guarantee = terms === 'CREDIT' ? await up('GUARANTEE') : null;
  const body: Record<string, unknown> = {
    customer: {
      legalName,
      paymentTerms: terms,
      crNumber: `CRA${w.SFX}${String(n).padStart(2, '0')}`,
      channelId,
      subChannelId,
      primaryPhone: phone,
      contactPerson: 'Saif Al Hinai',
      crPhotoAttachmentId: cr,
    },
    branches: [
      {
        branchName: `${legalName} B1`,
        address: 'Way 3012, Al Ghubra North, Muscat',
        gpsLat: GPS.lat,
        gpsLng: GPS.lng,
        gpsAccuracy: GPS.accuracy,
        gpsCapturedAt: new Date().toISOString(),
        dayOfVisit: OMAN_TODAY,
        shopPhotoAttachmentId: shop,
        signboardPhotoAttachmentId: sign,
        extraPhotoAttachmentIds: [],
      },
    ],
    ...(guarantee
      ? { credit: { requestedCreditLimit: 1500, requestedPaymentTermDays: 30 }, guaranteeAttachmentIds: [guarantee] }
      : {}),
  };
  const out = await submitCreateViaApi(page, body, { world: w });
  expect(out, JSON.stringify(out).slice(0, 400)).toMatchObject({ status: 200, ok: true });
  return { editId: receiptEditId(out)!, legalName, body };
}

/**
 * A step's SLA budget in working minutes, as the chain freezes it
 * (lib/approval-chains.ts stageHours) and the sweep reads it back.
 */
export function slaBudgetMin(role: Role): number {
  return Math.round(STAGE_SLA_MINUTES[role] ?? DEFAULT_STAGE_SLA_MIN);
}

/**
 * What one GET /api/cron/sla-escalate would touch that is NOT this world's
 * (read-only): overdue requests at level 0, level-1 requests the level-2 pass
 * may escalate, the Temix queue (a non-empty one pings every active Steward)
 * and read notifications older than 90 days (deleted by its clean-up pass).
 * TEMIX_QUEUE_WHERE is lib/temix.ts's, restated to keep that module out of the test.
 */
export async function slaSweepImpact(worldEditIds: string[]): Promise<{
  overdue: number;
  level2Candidates: number;
  temixQueue: number;
  notificationGc: number;
}> {
  const notMine = { notIn: worldEditIds.length ? worldEditIds : ['__none__'] };
  const [overdue, level2Candidates, temixQueue, notificationGc] = await Promise.all([
    db.customerEdit.count({ where: { id: notMine, state: 'SUBMITTED', slaDueAt: { lt: new Date() }, escalationLevel: 0 } }),
    db.customerEdit.count({ where: { id: notMine, state: 'SUBMITTED', escalationLevel: 1, stageEnteredAt: { not: null } } }),
    db.customer.count({
      where: { OR: [{ temixSyncState: 'PENDING_UPLOAD', deletedAt: null }, { temixSyncState: 'DEACTIVATE_PENDING' }] },
    }),
    db.notification.count({ where: { readAt: { not: null, lt: new Date(Date.now() - 90 * 86_400_000) } } }),
  ]);
  return { overdue, level2Candidates, temixQueue, notificationGc };
}

/** Counts every /api/photos/<id> response the page receives, by HTTP status. */
export function tallyPhotoResponses(page: Page): { byStatus(): Record<number, number>; total(): number } {
  const counts: Record<number, number> = {};
  page.on('response', (res) => {
    // GETs of /api/photos/<id> only (presign, finalize and attach are POSTs).
    if (res.request().method() !== 'GET') return;
    if (/^\/api\/photos\/[^/?#]+$/.test(new URL(res.url()).pathname)) counts[res.status()] = (counts[res.status()] ?? 0) + 1;
  });
  return { byStatus: () => ({ ...counts }), total: () => Object.values(counts).reduce((a, b) => a + b, 0) };
}

/** Every image the locator matches has loaded and decoded (naturalWidth > 0). */
export async function imagesLoaded(images: Locator): Promise<void> {
  const n = await images.count();
  expect(n, 'images to check').toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const img = images.nth(i);
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { timeout: 30_000 }).toBeGreaterThan(0);
  }
}

/** One card of the approval queue (BulkApprovalQueue), by the name it shows. */
export function queueCard(page: Page, legalName: string): Locator {
  return page.getByRole('main').getByRole('listitem').filter({ has: page.getByRole('heading', { level: 3, name: legalName }) });
}

/** The legal names on the queue's cards, top to bottom. */
export async function queueOrder(page: Page): Promise<string[]> {
  const names = await page.getByRole('main').getByRole('listitem').getByRole('heading', { level: 3 }).allInnerTexts();
  return names.map((t) => t.replace(/^New\s+/, '').trim());
}

/** A dashboard KPI tile (components/insights/KpiTile.tsx), by its label. */
export function kpiTile(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).first().locator('xpath=..');
}

/** The big figure of a KPI tile. */
export function kpiValue(page: Page, label: string): Locator {
  return kpiTile(page, label).locator(':scope > div').nth(1);
}

/** The top bar's bell link (components/nmwc/TopBar.tsx); its name carries both counts. */
export function bell(page: Page): Locator {
  return page.getByRole('link', { name: /^Notifications( \(|$)/ });
}

/** A presigned R2 URL (path-style, on the account host; lib/r2.ts). */
const R2_HOST = /^https:\/\/[^/]*\.r2\.cloudflarestorage\.com\//;
const relayed = new WeakSet<Page>();

/**
 * The bucket's CORS rule admits the browser's photo PUT from http://localhost:3000
 * only, the suite's default port (iphone.spec.ts; field-faults-helpers.ts
 * noteR2CorsRefusal). On a lane's own E2E_PORT the browser refuses every in-page
 * upload, and the slot says "No connection" — the environment, not the app.
 *
 * There, and only there, this page's PUTs to R2 are sent from Node instead — the
 * same presigned URL, Content-Type and body, to the same bucket — and R2's own
 * answer, its status and body, is handed back to the page; Playwright answers
 * the CORS preflight of a routed request and adds the page's origin to a
 * fulfilled answer. Everything the app does — compress, presign, PUT with
 * progress, finalize, attach, the slot's states — is unchanged. On port 3000
 * nothing is routed: the browser meets the bucket's own rule. A relay that
 * cannot reach R2 fails the PUT as a dropped connection, as the browser would.
 *
 * Node's fetch, NOT route.fetch(): that is a Playwright API call, a report step
 * titled with its URL, and a presigned URL carries the R2 account id, the
 * access key id and a live signature (support/api.ts uploadPhotoViaApi). The
 * URL is never logged, and an error is swallowed without it.
 */
export async function relayR2Puts(page: Page): Promise<void> {
  if (PORT === 3000 || relayed.has(page)) return;
  relayed.add(page);
  await page.route(R2_HOST, async (route) => {
    const req = route.request();
    if (req.method() !== 'PUT') return route.continue();
    // What the presign signs and the page sends: Content-Type (lib/r2.ts), any x-amz-*.
    const headers = Object.fromEntries(
      Object.entries(req.headers()).filter(([k]) => k === 'content-type' || k.startsWith('x-amz-'))
    );
    try {
      const res = await fetch(req.url(), {
        method: 'PUT',
        headers,
        body: new Uint8Array(req.postDataBuffer() ?? Buffer.alloc(0)),
        signal: AbortSignal.timeout(60_000),
      });
      const body = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type');
      await route.fulfill({ status: res.status, body, ...(contentType ? { contentType } : {}) });
    } catch {
      await route.abort('failed').catch(() => undefined);
    }
  });
  test.info().annotations.push({
    type: 'R2 CORS',
    description: `E2E_PORT=${PORT}: the page's photo PUTs to R2 were relayed from Node (the bucket's CORS admits http://localhost:3000 only)`,
  });
}
