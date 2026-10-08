/**
 * Helpers for tests/e2e/launch/access-control.spec.ts (the deny side: pages,
 * deep links, route handlers, replayed server actions, the photo API contract
 * and the error pages). Additive: nothing here changes the shared support files.
 *
 * The raw photo calls exist because the shared uploadPhotoViaApi() always PUTs
 * the exact bytes with the presigned type and always finalizes: the contract
 * tests need each step on its own (a PUT of another length, a PUT as text/html,
 * a finalize of a key never uploaded or of another user's key). Every key is
 * still checked against the world's fixture users, and written to the crash
 * registry, BEFORE anything is PUT — the bucket is production's.
 */
import { expect, request as pwRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { resolveChain, stepDeadline } from '../../../../lib/approval-chains';
import { BASE_URL, db, safeError } from './env';
import { newId } from './ids';
import { assertFixtureKey } from './r2';
import type { World } from './types';

/** Escapes a value for use inside a RegExp. */
export function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The path of the page's current URL ('/dashboard'). */
export function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}

/**
 * Waits until React has hydrated the element (its props are attached): a click
 * on a client component before that does nothing.
 */
export async function hydrated(loc: Locator, timeout = 60_000): Promise<void> {
  await loc.waitFor({ state: 'attached', timeout });
  await expect
    .poll(() => loc.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps$'))), {
      timeout,
      message: 'the element is hydrated by React',
    })
    .toBe(true);
}

/** A request context with no session at all (a signed-out caller). Dispose it. */
export async function signedOutRequest(): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: BASE_URL });
}

// ── photos, step by step ─────────────────────────────────────────────────────

export type RawAnswer = { status: number; json: Record<string, unknown>; headers: Record<string, string> };

async function rawAnswer(res: { status(): number; headers(): Record<string, string>; text(): Promise<string> }): Promise<RawAnswer> {
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { _text: text.slice(0, 300) };
  }
  return { status: res.status(), json, headers: res.headers() };
}

/** POST /api/photos/presign as `req`'s user (a context's request, or a signed-out one). */
export async function presignRaw(req: APIRequestContext, body: Record<string, unknown>): Promise<RawAnswer> {
  return rawAnswer(
    await req.post(`${BASE_URL}/api/photos/presign`, {
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      data: JSON.stringify(body),
      maxRedirects: 0,
      failOnStatusCode: false,
    })
  );
}

/** POST /api/photos/finalize as `req`'s user. */
export async function finalizeRaw(req: APIRequestContext, body: Record<string, unknown>): Promise<RawAnswer> {
  return rawAnswer(
    await req.post(`${BASE_URL}/api/photos/finalize`, {
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      data: JSON.stringify(body),
      maxRedirects: 0,
      failOnStatusCode: false,
    })
  );
}

/**
 * A presign that is expected to succeed: returns the presigned URL and the key,
 * the key already checked to be a fixture user's folder and written to the
 * world's crash registry (so the sweep finds whatever is PUT under it).
 */
export async function presignForWorld(
  req: APIRequestContext,
  world: World,
  body: { kind: string; mimeType: string; bytes: number }
): Promise<{ url: string; key: string }> {
  const out = await presignRaw(req, body);
  if (out.status !== 200) throw new Error(`presignForWorld: presign answered ${out.status} ${JSON.stringify(out.json).slice(0, 200)}`);
  const { url, key } = out.json as { url: string; key: string };
  assertFixtureKey(key, world.fixtureUserIds());
  world.registry.add('ymds', key.split('/').slice(0, 3).join('/'));
  world.registry.add('r2Keys', key);
  return { url, key };
}

/**
 * PUTs bytes to a presigned R2 URL through Node's fetch, never a Playwright
 * call: the URL carries the R2 account id, the access key id and a live
 * signature, and a Playwright request is a report step titled with its URL.
 * Returns R2's status; errors are re-thrown without the URL.
 */
export async function putToR2(url: string, bytes: Buffer, contentType: string): Promise<number> {
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(60_000),
    });
    await res.arrayBuffer().catch(() => undefined);
    return res.status;
  } catch (err) {
    throw new Error(`putToR2: the R2 PUT failed (${(err as { name?: string }).name ?? 'error'})`);
  }
}

// ── server-action bodies ─────────────────────────────────────────────────────

/**
 * A captured multipart action body with one FormData field renamed so the
 * server no longer reads it (e.g. the approval's decisionToken). Throws when the
 * field is not in the body — a replay that still carried it could RUN.
 */
export function withoutFormField(body: Buffer, field: string): Buffer {
  const text = body.toString('latin1');
  const re = new RegExp(`name="([^"]*)${esc(field)}"`, 'g');
  if (!re.test(text)) throw new Error(`withoutFormField: the captured body has no "${field}" field`);
  const out = text.replace(new RegExp(`name="([^"]*)${esc(field)}"`, 'g'), 'name="$1droppedByTheTest"');
  if (out.includes(`${field}"`)) throw new Error(`withoutFormField: "${field}" is still in the body`);
  return Buffer.from(out, 'latin1');
}

// ── seeded rows ──────────────────────────────────────────────────────────────

/**
 * A SUBMITTED UPDATE whose fieldChanges is [{}] — a corrupt row, as no writer
 * leaves one — for the error boundary of /approvals/<id>. The SLA deadline is a
 * week out, so the escalation sweep never picks it up while it lives.
 */
export async function seedCorruptUpdateEdit(w: World, o: { customer: string; submitter: string }): Promise<string> {
  const cust = w.customer(o.customer);
  const submitter = w.user(o.submitter);
  const chain = resolveChain('UPDATE', cust.paymentTerms);
  const now = new Date();
  const id = newId();
  w.registry.add('editIds', id);
  const row: Prisma.CustomerEditUncheckedCreateInput = {
    id,
    target: 'CUSTOMER',
    customerId: cust.id,
    state: 'SUBMITTED',
    submittedById: submitter.id,
    submittedAt: now,
    fieldChanges: [{}] as unknown as Prisma.InputJsonValue,
    attachmentChanges: [] as unknown as Prisma.InputJsonValue,
    process: 'UPDATE',
    approvalChain: chain as unknown as Prisma.InputJsonValue,
    paymentTermsAtSubmit: cust.paymentTerms,
    currentStepIndex: 0,
    cycle: 1,
    pendingRole: chain[0]!.role,
    stageEnteredAt: now,
    slaDueAt: new Date(Math.max(stepDeadline(now, chain[0]!.slaHours).getTime(), now.getTime() + 7 * 86_400_000)),
    escalationLevel: 0,
  };
  try {
    await db.customerEdit.create({ data: row });
  } catch (err) {
    throw safeError(err, 'seedCorruptUpdateEdit insert failed');
  }
  return id;
}

/** A CUSTOMER import batch uploaded by a fixture Steward, its workbook named with the world's suffix. */
export async function seedImportBatch(
  w: World,
  o: { uploader: string; filename: string; status?: 'READY' | 'PROMOTED' | 'FAILED' }
): Promise<string> {
  if (!w.carriesSuffix(o.filename)) throw new Error('seedImportBatch: the filename must carry the world suffix');
  const id = newId();
  w.adopt.importBatch(id);
  try {
    await db.importBatch.create({
      data: { id, filename: o.filename, kind: 'CUSTOMER', uploadedById: w.user(o.uploader).id, status: o.status ?? 'READY' },
    });
  } catch (err) {
    throw safeError(err, 'seedImportBatch insert failed');
  }
  return id;
}

/** A Temix batch awaiting the Steward's "loaded" confirmation, holding no customer. */
export async function seedTemixBatch(w: World, o: { creator: string }): Promise<string> {
  const id = newId();
  w.adopt.temixBatch(id);
  try {
    await db.temixSyncBatch.create({
      data: { id, createdById: w.user(o.creator).id, rowCount: 0, customerIds: [] as unknown as Prisma.InputJsonValue, status: 'DONE' },
    });
  } catch (err) {
    throw safeError(err, 'seedTemixBatch insert failed');
  }
  return id;
}

// ── workbooks ────────────────────────────────────────────────────────────────

/** Every cell of every sheet of an xlsx, as text (for "is this branch code in the export"). */
export async function xlsxCellTexts(bytes: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        const v = cell.value;
        if (v === null || v === undefined) return;
        if (typeof v === 'object' && 'richText' in v) out.push(v.richText.map((r) => r.text).join(''));
        else if (typeof v === 'object' && 'text' in v) out.push(String((v as { text: unknown }).text));
        else out.push(String(v));
      });
    });
  });
  return out;
}
