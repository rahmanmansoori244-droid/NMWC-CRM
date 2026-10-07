/**
 * The app's own fetch routes, called the way the phone calls them — for states
 * that are setup, not story. Every call goes through page.request, so the
 * page's context (its minted or signed-in session) is the caller.
 *
 *   POST /api/forms/customer-edit | customer-create | branch-close | branch-reactivate
 *   POST /api/photos/presign → PUT <presigned R2 url> → POST /api/photos/finalize → POST /api/photos/attach
 *
 * The routes refuse a cross-site Origin and anything but JSON, as the browser
 * sends them; these helpers send `Origin: http://localhost:<port>` and JSON.
 * Answers come back in the routes' own `{ ok, code, message, fields, data }`
 * shape plus the HTTP status; a refusal is returned, never thrown, so a spec can
 * assert on it. Only the photo upload throws, because its later steps cannot run
 * without the earlier ones.
 */
import { randomUUID } from 'node:crypto';
import type { APIResponse, Page } from '@playwright/test';
import type { AttachmentKind } from '@prisma/client';
import { editPayload, type EditPatch } from '../../../support/edit-payload';
import { BASE_URL, db } from './env';
import { sha256Hex, tinyJpeg, TINY_JPEG_SIZE } from './media';
import { assertFixtureKey } from './r2';
import type { World } from './types';

export type { EditPatch };

/** A route's answer: the JSON it sent, plus the HTTP status. */
export type ActionJson = {
  status: number;
  ok: boolean;
  code?: string;
  message?: string;
  fields?: Record<string, string>;
  current?: Record<string, unknown>;
  data?: unknown;
  /** Where a redirect pointed (the forced password change), when the route did not answer itself. */
  location?: string;
};

async function answer(res: APIResponse): Promise<ActionJson> {
  const status = res.status();
  if (status >= 300 && status < 400) {
    return { status, ok: false, code: 'REDIRECTED', location: res.headers()['location'] ?? '' };
  }
  const type = res.headers()['content-type'] ?? '';
  if (!type.includes('application/json')) {
    return { status, ok: false, code: 'NOT_JSON', message: (await res.text()).slice(0, 300) };
  }
  const json = (await res.json()) as Record<string, unknown>;
  return { status, ok: json.ok === true, ...json } as ActionJson;
}

/** POST JSON as the page's user, same-origin, never following a redirect. */
export async function postJson(page: Page, path: string, body: unknown): Promise<APIResponse> {
  return page.request.post(`${BASE_URL}${path}`, {
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    data: JSON.stringify(body),
    maxRedirects: 0,
    failOnStatusCode: false,
  });
}

/** POST /api/forms/<form>: the four field forms' submit, exactly as lib/submit-client.ts sends it. */
export async function postForm(
  page: Page,
  form: 'customer-edit' | 'customer-create' | 'branch-close' | 'branch-reactivate',
  body: Record<string, unknown>
): Promise<ActionJson> {
  return answer(await postJson(page, `/api/forms/${form}`, body));
}

/** The editId of a submit receipt ({ editId, state, submittedAt, replayed }), if any. */
export function receiptEditId(a: ActionJson): string | undefined {
  const d = a.data as { editId?: unknown } | undefined;
  return typeof d?.editId === 'string' ? d.editId : undefined;
}

/**
 * An enrichment (UPDATE) request, as the customer edit form sends it: patch v2
 * with every sent key's base read from the live row now (tests/support/edit-payload.ts),
 * a fresh submission id unless one is given. The request is adopted by `world`.
 */
export async function submitEnrichViaApi(page: Page, patch: EditPatch, o: { world?: World } = {}): Promise<ActionJson> {
  const body = await editPayload(db, { ...patch, submissionId: patch.submissionId ?? randomUUID() });
  const out = await postForm(page, 'customer-edit', body as unknown as Record<string, unknown>);
  const id = receiptEditId(out);
  if (id) o.world?.adopt.edit(id);
  return out;
}

/** A new-customer (CREATE) request: `body` is what the new-customer form sends (lib/validation/create.ts). */
export async function submitCreateViaApi(page: Page, body: Record<string, unknown>, o: { world?: World } = {}): Promise<ActionJson> {
  const out = await postForm(page, 'customer-create', { submissionId: randomUUID(), ...body });
  const id = receiptEditId(out);
  if (id) o.world?.adopt.edit(id);
  return out;
}

/** "Shop closed" on a branch, with its evidence photo (an attachment the caller uploaded). */
export async function closeBranchViaApi(
  page: Page,
  o: { branchId: string; reason: string; attachmentId: string; submissionId?: string },
  w?: World
): Promise<ActionJson> {
  const out = await postForm(page, 'branch-close', { submissionId: randomUUID(), ...o });
  const id = receiptEditId(out);
  if (id) w?.adopt.edit(id);
  return out;
}

/** A reactivation request for a closed branch, with its evidence photo. */
export async function requestReactivationViaApi(
  page: Page,
  o: { branchId: string; reason: string; attachmentId: string; submissionId?: string },
  w?: World
): Promise<ActionJson> {
  const out = await postForm(page, 'branch-reactivate', { submissionId: randomUUID(), ...o });
  const id = receiptEditId(out);
  if (id) w?.adopt.edit(id);
  return out;
}

export type UploadedPhoto = {
  attachmentId: string;
  key: string;
  deduped: boolean;
  /** The exact bytes PUT to R2. */
  bytes: Buffer;
  /** The attach route's answer, when an attach was asked for. */
  attached?: ActionJson;
};

/**
 * A photo through the real upload path: presign → PUT to R2 → finalize →
 * (optional) attach, as the page's user. The key the server mints is
 * <UTC ymd>/<that user's id>/<KIND>/<uuid>.<ext>; it is checked against the
 * world's fixture users and written to the crash registry BEFORE the PUT, so
 * only a fixture user's folder is ever written and the sweep can always find it.
 *
 * `bytes` defaults to a unique ~2 KB JPEG: finalize dedupes on (sha256, uploader),
 * so a reused image would come back as an older attachment (`deduped: true`).
 * Throws when a step before the attach refuses; the attach's refusal is returned.
 */
export async function uploadPhotoViaApi(
  page: Page,
  world: World,
  o: {
    kind: AttachmentKind;
    bytes?: Buffer;
    mimeType?: 'image/jpeg' | 'image/png' | 'image/webp';
    width?: number;
    height?: number;
    capturedLat?: number;
    capturedLng?: number;
    capturedAt?: Date;
    attach?: { customerId: string; slot: 'CR' } | { branchId: string; slot: 'SHOP' | 'SIGNBOARD' | 'FREE' };
  }
): Promise<UploadedPhoto> {
  const bytes = o.bytes ?? tinyJpeg(`${world.sfx}-api-${randomUUID()}`);
  const mimeType = o.mimeType ?? 'image/jpeg';
  const presign = await postJson(page, '/api/photos/presign', { kind: o.kind, mimeType, bytes: bytes.length });
  if (presign.status() !== 200) {
    throw new Error(`uploadPhotoViaApi: presign answered ${presign.status()} ${(await presign.text()).slice(0, 200)}`);
  }
  const { url, key, headers } = (await presign.json()) as { url: string; key: string; headers?: Record<string, string> };

  // The R2 guard: the bucket is production's. Only a fixture user's folder.
  assertFixtureKey(key, world.fixtureUserIds());
  world.registry.add('ymds', key.split('/').slice(0, 3).join('/'));
  world.registry.add('r2Keys', key);

  // The PUT goes to R2's own host; the page's localhost cookies do not travel there.
  const put = await page.request.put(url, {
    headers: { 'Content-Type': mimeType, ...headers },
    data: bytes,
    failOnStatusCode: false,
  });
  if (put.status() !== 200) throw new Error(`uploadPhotoViaApi: the R2 PUT answered ${put.status()}`);

  const isTiny = !o.bytes;
  const finalize = await postJson(page, '/api/photos/finalize', {
    key,
    kind: o.kind,
    hash: sha256Hex(bytes),
    width: o.width ?? (isTiny ? TINY_JPEG_SIZE.width : undefined),
    height: o.height ?? (isTiny ? TINY_JPEG_SIZE.height : undefined),
    capturedLat: o.capturedLat ?? 23.5881,
    capturedLng: o.capturedLng ?? 58.3829,
    ...(o.capturedAt ? { capturedAt: o.capturedAt.toISOString() } : {}),
  });
  if (finalize.status() !== 200) {
    throw new Error(`uploadPhotoViaApi: finalize answered ${finalize.status()} ${(await finalize.text()).slice(0, 200)}`);
  }
  const { attachmentId, deduped } = (await finalize.json()) as { attachmentId: string; deduped: boolean };
  world.adopt.attachment(attachmentId);

  const out: UploadedPhoto = { attachmentId, key, deduped, bytes };
  if (o.attach) out.attached = await answer(await postJson(page, '/api/photos/attach', { attachmentId, ...o.attach }));
  return out;
}
