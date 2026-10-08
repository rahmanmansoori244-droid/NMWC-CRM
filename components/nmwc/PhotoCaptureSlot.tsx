'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Trash2, RefreshCw, Check, Loader2, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ActionResult } from '@/lib/errors';

export type PhotoSlotKind = 'SHOP' | 'SIGNBOARD' | 'CR' | 'FREE' | 'GUARANTEE';
export type AttachTarget =
  | { kind: 'customer'; customerId: string; slot: 'CR' }
  | { kind: 'branch'; branchId: string; slot: 'SHOP' | 'SIGNBOARD' | 'FREE' };
export type AttachedPhoto = {
  attachmentId: string;
  previewUrl?: string;
  remoteUrl?: string;
};

const LABELS: Record<PhotoSlotKind, string> = {
  SHOP: 'Shop front',
  SIGNBOARD: 'Signboard',
  CR: 'CR document',
  FREE: 'Other',
  GUARANTEE: 'Guarantee doc',
};

/** A HEIC photo the browser cannot decode (NEW-PHOTO-012): how to stop sending them. */
export const HEIC_PHOTO_MESSAGE =
  "Your phone is sending HEIC photos. Open Settings → Camera → Formats and switch to 'Most Compatible' (JPEG).";
/** Any other photo the phone could not read or re-encode: a broken file, an unknown format. */
export const PHOTO_UNREADABLE_MESSAGE =
  'This phone could not read this photo. Take it again, or pick another photo.';
/** Said after either of them on a Retake: the photo already on the slot stays. */
export const PHOTO_KEPT_NOTE = 'Your earlier photo is kept.';

async function compressImage(file: File, maxLong = 1920, quality = 0.85): Promise<Blob> {
  // UXI-024: stream via URL.createObjectURL instead of FileReader.readAsDataURL.
  // Old path created a ~16 MB base64 string for a 12 MB HEIC and could OOM
  // older iPhones. createObjectURL is constant-time and ~1/3 the memory.
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => {
        // NEW-PHOTO-012: HEIC inputs on Chrome/Android cannot decode here.
        // Surface a useful hint instead of generic "decode failed".
        if (file.type === 'image/heic' || file.type === 'image/heif') {
          reject(new Error(HEIC_PHOTO_MESSAGE));
        } else {
          reject(new Error(PHOTO_UNREADABLE_MESSAGE));
        }
      };
      im.src = objectUrl;
    });
    let { width, height } = img;
    if (width > maxLong || height > maxLong) {
      const scale = maxLong / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context unavailable');
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Compression failed'))),
        'image/jpeg',
        quality
      );
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// B-08: simple wait helper — separate so retryable() is readable.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// B-08: the chain has 3 network steps (presign / R2 PUT / finalize). Each one
// gets up to 3 attempts with 500ms / 1500ms / 4500ms backoff. We only retry on
// transient failures (network errors or 5xx). 4xx is a hard fail — retrying a
// validation error is wasted radio time.
const RETRY_DELAYS = [500, 1500, 4500];

/**
 * How long the PUT may go without a sign of life (item 22 review). No step of
 * the chain had a limit: a connection that died without an error — a mapping
 * dropped somewhere on weak signal — left the slot "Uploading…" until the
 * phone's TCP stack gave up, many minutes later. Since e5d4043 a busy slot
 * holds Submit, so the whole form waited with it, with no way to cancel. A
 * stall now fails like a dropped connection: retried on a fresh one, then
 * "Retry upload", and the slot is no longer busy.
 *
 * Silence, not total time: a 1.6 MB photo on a slow link takes minutes and is
 * fine while its bytes move, so the clock restarts on every progress event.
 * That holds only until the body has gone — see postBodyDeadlineMs.
 */
export const UPLOAD_STALL_MS = 45_000;

/**
 * Once the whole body has been counted as sent, progress says nothing more: the
 * phone has handed the bytes to its send buffer — on Android cellular, hundreds
 * of KB to MBs — so progress reads 100% and the upload's load event fires within
 * seconds, and nothing fires again until R2 answers after the buffer has
 * drained. On a 50–150 kbps uplink that is 40–150 s later. A flat 45 s from
 * there aborted a PUT that was still moving, the retries did the same, and so
 * did every Retry upload: the mandatory photo could never go up (post-merge
 * review of 30ec23a).
 *
 * So from then on the PUT gets one deadline, set once and not restarted: the
 * silence limit, plus the time the body would take to drain at
 * DRAIN_FLOOR_BYTES_PER_S (4 KB/s, about 32 kbps) — 3¼ minutes for a typical
 * 600 KB photo. It stops growing at 2 MiB, so the longest is about 9¼
 * minutes, shorter than the presigned URL's 10-minute life
 * (PRESIGN_EXPIRES_S).
 */
export const DRAIN_FLOOR_BYTES_PER_S = 4 * 1024;
const DRAIN_BODY_CAP_BYTES = 2 * 1024 * 1024;
export function postBodyDeadlineMs(bytes: number): number {
  const drainS = Math.ceil(Math.min(bytes, DRAIN_BODY_CAP_BYTES) / DRAIN_FLOOR_BYTES_PER_S);
  return UPLOAD_STALL_MS + drainS * 1000;
}

/**
 * That deadline running out. Not retried: a retry would send the same bytes
 * into the same slow link and wait as long again. The salesman decides when.
 */
export const SLOW_LINK_MESSAGE =
  'The connection is too slow to finish sending this photo. Move to better signal, then tap Retry upload.';

/**
 * Presign, finalize, attach and detach are small requests: they get as long as
 * a submit does (SUBMIT_TIMEOUT_MS), far past a normal answer and under the
 * server's 60 s limit.
 */
export const PHOTO_STEP_TIMEOUT_MS = 30_000;

/** The failure isRetryable() knows as a dropped connection. */
const networkError = () => new Error('Network error');

/** What a slot says when its attach got no answer — it may still have landed. */
export const ATTACH_NO_ANSWER =
  'The photo is up, but attaching it got no answer. Tap Retry upload.';

/** The attach route's 401: turned away before anything was read. */
const ATTACH_SIGNED_OUT =
  'You need to sign in again, so the photo is not attached yet. Keep this page open, sign in in another tab, then tap Retry upload.';

/**
 * Presign's or finalize's 401. It read "Could not get upload URL." and was not
 * retried, so nothing said the session had ended; Retry upload after signing in
 * sends the kept photo from the start.
 */
export const UPLOAD_SIGNED_OUT =
  'You need to sign in again, so the photo is not sent yet. Keep this page open, sign in in another tab, then tap Retry upload.';

/**
 * A step that got no answer on all three tries: the connection dropped. The
 * slot showed the error's own text, which for fetch is the browser's ("Failed
 * to fetch" on Chrome, "Load failed" on Safari) and for the PUT was "Network
 * error"; neither said the photo is kept or what to do.
 */
export const UPLOAD_NO_CONNECTION =
  'No connection, so the photo is not sent yet. Keep this page open: the photo is held here until it is sent. Check the signal, then tap Retry upload.';

/**
 * Presign's 429 (PHOTO_LIMIT: 120 an hour, one back every 30 s). A wait up to
 * this long is waited out and the step tried again, as a dropped connection is;
 * a longer one, or a third refusal, ends with how long to wait.
 *
 * A minute, not 30 s: the durable limiter charges the refused call too and
 * floors the bucket at −1 (lib/rate-limit.ts), so an empty bucket owes two
 * refills and every photo 429 asks for 31–60 s. At 30 s the countdown never
 * ran: each 429 went straight to "Wait N seconds, then tap Retry upload"
 * (launch browser suite). A try sooner than asked is refused, and charged,
 * again — by this slot or by another one (photoLimitUntil, below).
 */
export const RATE_LIMIT_MAX_WAIT_S = 60;
/** Said on the slot while such a wait runs, second by second (below). */
export function rateLimitWaitMessage(secondsLeft: number): string {
  return `Too many photos — trying again in ${secondsLeft} s`;
}
export function rateLimitedMessage(retryAfterSec: number): string {
  const wait = retryAfterSec < 90 ? `${retryAfterSec} seconds` : `${Math.ceil(retryAfterSec / 60)} minutes`;
  return `Too many photos in a short time. Wait ${wait}, then tap Retry upload.`;
}

/** PHOTO_LIMIT gives a photo back every 30 s: one refill. */
export const PHOTO_REFILL_S = 30;

/**
 * The photo limit is his, not the slot's: presign charges one bucket per user
 * (`photo:<id>`), and a form has four or five slots, SHOP and SIGNBOARD side by
 * side. Each slot waiting out its own 429 did not work near the limit: a
 * sibling that tried in between spent the refill, so the retry at the time it
 * was given was refused and charged again. Two photos took about three
 * minutes, five refusals and two Retry uploads (launch review). So the slots
 * on the page keep one clock:
 *   - a 429 sets the earliest the next presign may go;
 *   - every presign waits for that first, counting down on its slot, without
 *     calling and without spending one of its tries;
 *   - while the limit is tight (that time has not passed by a whole refill),
 *     the presign that goes takes the next refill for itself: the next slot
 *     waits PHOTO_REFILL_S, when the bucket has a photo for it again, instead
 *     of being refused and charged.
 * Clear of the limit nothing waits: only a 429 sets the clock.
 */
let photoLimitUntil = 0;

/** A fresh page's clock (tests). */
export function resetPhotoLimitClock(): void {
  photoLimitUntil = 0;
}

function holdPhotos(seconds: number): void {
  photoLimitUntil = Math.max(photoLimitUntil, Date.now() + seconds * 1000);
}

/** Counts down to the clock, which another slot may move on while this waits. */
async function waitForPhotoLimit(onWait?: (secondsLeft: number | null) => void): Promise<void> {
  let waited = false;
  for (let left = photoLimitUntil - Date.now(); left > 0; left = photoLimitUntil - Date.now()) {
    waited = true;
    onWait?.(Math.ceil(left / 1000));
    await delay(left % 1000 || 1000);
  }
  if (waited) onWait?.(null);
}

/**
 * Before a presign: wait for the clock, then, while the limit is tight, take
 * the next refill. Nothing is awaited between the clock's check and the hold,
 * so of two slots whose waits end together only one goes. True when it took
 * the refill.
 */
async function takePhotoTurn(onWait?: (secondsLeft: number | null) => void): Promise<boolean> {
  await waitForPhotoLimit(onWait);
  if (Date.now() >= photoLimitUntil + PHOTO_REFILL_S * 1000) return false;
  holdPhotos(PHOTO_REFILL_S);
  return true;
}

/**
 * runAction's codes for a database that dropped or did not answer: not an
 * answer about the attach (lib/submit-client.ts treats them the same way).
 */
const TRANSIENT_DB_CODES = new Set(['DB_INTERRUPTED', 'DB_UNAVAILABLE']);

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * A 4xx whose body is the action shape `{ ok: false, code, message }` — a route
 * turning the request away before the service ran (lib/fetch-route.ts refuse):
 * signed out (401), a session that must change its password first (403
 * PASSWORD_CHANGE_REQUIRED), a body it would not read. An answer, with a message
 * to show; nothing about the photo was read or changed. As a bare HttpError the
 * attach called it "got no answer", and every Retry said the same. Presign's and
 * finalize's refusals are read into it too (readRefusal).
 */
class RefusedError extends HttpError {
  code: string;
  constructor(status: number, code: string, message: string) {
    super(status, message);
    this.code = code;
  }
}

/** Presign's 429: how long until the next photo may go. Its message says so. */
class RateLimitedError extends RefusedError {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(429, 'RATE_LIMITED', rateLimitedMessage(retryAfterSec));
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * The refusal in a 4xx reply's body, or null for any other body: the action
 * shape `{ ok: false, code, message }`, or presign's and finalize's own
 * `{ error, message }` — which this did not read, so every refusal there,
 * signed out included, showed as the step's bare failure.
 */
async function readRefusal(res: Response): Promise<{ code: string; message: string } | null> {
  try {
    const body = (await res.json()) as
      | { ok?: unknown; code?: unknown; error?: unknown; message?: unknown }
      | null;
    if (typeof body?.message !== 'string') return null;
    if (body.ok === false && typeof body.code === 'string') return { code: body.code, message: body.message };
    return typeof body.error === 'string' ? { code: body.error, message: body.message } : null;
  } catch {
    return null;
  }
}

/**
 * A 429's wait, in seconds: the body's retryAfterSec, else Retry-After, else
 * the longest a photo 429 asks for (one refill would be refused again).
 */
async function readRetryAfter(res: Response): Promise<number> {
  let sec: unknown;
  try {
    sec = ((await res.json()) as { retryAfterSec?: unknown } | null)?.retryAfterSec;
  } catch {
    /* not JSON: the header below */
  }
  if (typeof sec !== 'number') sec = Number(res.headers.get('Retry-After'));
  return typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? Math.ceil(sec) : RATE_LIMIT_MAX_WAIT_S;
}

/** A dropped connection, as fetch and putWithProgress report one. */
function isNoConnection(err: unknown): boolean {
  // `fetch` throws a TypeError for network failures and CORS issues.
  if (err instanceof TypeError) return true;
  // XHR network error (we surface as generic Error with the marker message).
  return err instanceof Error && err.message === 'Network error';
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500;
  return isNoConnection(err);
}

/**
 * `onWait` hears a 429's wait as it runs: the seconds left, once a second, then
 * null. A silent "Uploading… 0%" for up to a minute read as frozen, and the
 * salesman left the page (launch review).
 */
async function retryable<T>(
  fn: () => Promise<T>,
  onWait?: (secondsLeft: number | null) => void
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // A 429 says when the next try may go: that wait instead of the backoff,
      // when it is short enough to sit through. It goes on the page's photo
      // clock, so every slot waits for it — this one's Retry upload included.
      const waitSec =
        err instanceof RateLimitedError && err.retryAfterSec <= RATE_LIMIT_MAX_WAIT_S
          ? err.retryAfterSec
          : null;
      if (waitSec === null && !isRetryable(err)) throw err;
      if (waitSec !== null) holdPhotos(waitSec);
      // Don't sleep after the last attempt.
      if (attempt < RETRY_DELAYS.length - 1) {
        if (waitSec === null) {
          await delay(RETRY_DELAYS[attempt]);
        } else {
          await waitForPhotoLimit(onWait);
        }
      }
    }
  }
  throw lastErr;
}

// B-08: XHR-based PUT so we get upload progress events. fetch() doesn't
// expose progress on the request body, and the salesman is staring at a
// blank screen while a 1.6 MB JPEG goes up over 3G.
function putWithProgress(
  url: string,
  headers: Record<string, string>,
  body: Blob,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // A stall watchdog (UPLOAD_STALL_MS), not xhr.timeout: that bounds the
    // TOTAL time and would fail a slow upload that is still moving. xhr.timeout
    // stays 0, no limit, but the timeout event still fires: Chromium ends a
    // connection that dies of ERR_TIMED_OUT with it (ontimeout, below).
    let stall: ReturnType<typeof setTimeout> | undefined;
    let bodyGone = false;
    const quiet = () => clearTimeout(stall);
    // While bytes are still being counted out: silence is a dead connection.
    const watch = () => {
      if (bodyGone) return;
      quiet();
      stall = setTimeout(() => {
        xhr.abort();
        reject(networkError());
      }, UPLOAD_STALL_MS);
    };
    // After the last byte: one deadline for R2's answer, by the body's size.
    const drain = () => {
      if (bodyGone) return;
      bodyGone = true;
      quiet();
      stall = setTimeout(() => {
        // Rejected before the abort, whose handler would say "Network error" —
        // which retryable() would send straight back into the same slow link.
        reject(new Error(SLOW_LINK_MESSAGE));
        xhr.abort();
      }, postBodyDeadlineMs(body.size));
    };
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) {
      try {
        xhr.setRequestHeader(k, v);
      } catch {
        /* some browsers reject forbidden headers — ignore, presign decides */
      }
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.round((e.loaded / e.total) * 100));
        if (e.loaded >= e.total) {
          drain();
          return;
        }
      }
      watch();
    };
    xhr.upload.onload = drain;
    xhr.onload = () => {
      quiet();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new HttpError(xhr.status, `Upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => {
      quiet();
      reject(networkError());
    };
    xhr.onabort = () => {
      quiet();
      reject(networkError());
    };
    // Launch browser suite: unheard, a PUT ended this way was noticed only when
    // the watchdog gave up on it, UPLOAD_STALL_MS a try — about 2 1/4 minutes
    // for three, with Submit held. It is a dropped connection, like onerror.
    xhr.ontimeout = () => {
      quiet();
      reject(networkError());
    };
    watch();
    xhr.send(body);
  });
}

/**
 * A JSON POST with a limit (PHOTO_STEP_TIMEOUT_MS) on the whole exchange —
 * reading the reply included, since a body can stall after its headers. Given
 * up, the request is aborted and fails as a dropped connection, which
 * retryable() tries again; an AbortError it does not know would have ended the
 * chain at the first stall.
 */
async function postJson<T>(url: string, body: unknown, failMessage: string): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PHOTO_STEP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!res.ok) {
      if (res.status === 429) throw new RateLimitedError(await readRetryAfter(res));
      const refusal = res.status < 500 ? await readRefusal(res) : null;
      if (refusal) throw new RefusedError(res.status, refusal.code, refusal.message);
      throw new HttpError(res.status, failMessage);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (abort.signal.aborted) throw networkError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attach and detach go to app/api/photos/attach|detach, which reply with the
 * service's own `{ ok, … }` (lib/errors.ts runAction). Not server actions: a
 * server action cannot be aborted, and Next runs them one at a time, so after
 * an attach with no answer, Retry's re-send — and every other slot's attach,
 * and every Remove — queued behind the stalled one and never left the phone
 * (post-merge review of 30ec23a). The route's own refusal, a 4xx in that shape,
 * throws a RefusedError carrying its message. Anything else throws as no
 * answer: postJson's abort at PHOTO_STEP_TIMEOUT_MS, a dropped connection, a
 * server fault, a page that is not JSON.
 */
async function postAction(url: string, body: unknown): Promise<ActionResult<unknown>> {
  const reply = await postJson<ActionResult<unknown> | null>(url, body, ATTACH_NO_ANSWER);
  if (typeof reply?.ok !== 'boolean') throw new Error(ATTACH_NO_ANSWER);
  return reply;
}

export function PhotoCaptureSlot({
  kind,
  required,
  initial,
  onChange,
  capturedLat,
  capturedLng,
  attachTo,
  disabled,
  onBusyChange,
}: {
  kind: PhotoSlotKind;
  required?: boolean;
  initial?: AttachedPhoto | null;
  onChange?: (photo: AttachedPhoto | null) => void;
  capturedLat?: number;
  capturedLng?: number;
  /** When provided, the photo is wired to a customer/branch slot immediately after finalize. */
  attachTo?: AttachTarget;
  /**
   * Nothing new starts: no capture, retake or remove, no Retry upload (a
   * failed upload's message stays in view), and a Remove confirm left open
   * closes. Used for a read-only view (a SUBMITTED create request), where a
   * frozen view must not fire server calls, and by the field forms while a
   * submit is on its way or has arrived, where a photo started then would be
   * cut off by the page load after the answer (item 22 review). An upload
   * already running is not interrupted; the forms hold Submit for it.
   */
  disabled?: boolean;
  /**
   * true when a photo starts compressing or uploading, then exactly one false
   * when that ends — attached or failed. A slot that unmounts mid-upload does
   * not stop the upload, so its false comes when the upload ends, not at the
   * unmount. The field forms leave after Submit by a document load, which
   * aborts an upload still in flight: the photo was lost while the salesman
   * read "It arrived" (item 22 review). onChange cannot tell them — it fires
   * only once the photo is attached.
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<AttachedPhoto | null>(initial ?? null);
  const [progress, setProgress] = useState<'idle' | 'compressing' | 'uploading' | 'done' | 'error'>(
    initial ? 'done' : 'idle'
  );
  const [uploadPct, setUploadPct] = useState(0);
  // The seconds left of a 429's wait that retryable() is sitting through.
  const [rateWait, setRateWait] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A Remove the server refused. Its own line: in the failed-upload state the
  // upload error owns `error`, and a refusal shown there read as an upload
  // failure, or not at all (review of the phase-1 fixes).
  const [removeRefused, setRemoveRefused] = useState<string | null>(null);
  // B-08: retain the compressed blob in component state separate from the
  // <input file> element. e.currentTarget.value = '' kills the input but the
  // blob lives here so "Retry upload" can re-run the chain without forcing
  // the user to re-photograph the storefront.
  const [retainedBlob, setRetainedBlob] = useState<Blob | null>(null);
  const [retainedHash, setRetainedHash] = useState<string | null>(null);
  // The retained photo is up and finalized, but its attach got no answer (or
  // "the database dropped / did not respond", or the route's own refusal before
  // the attach was read, which are none either): this is its attachment. Retry then sends only the attach again, not the photo over
  // the same weak signal. That is safe because services/photos.ts answers an
  // attach of a photo to the slot it is already on with ok and writes nothing,
  // and refuses one on any other slot — so the re-send's answer is the truth
  // either way. A new photo replaces it; any other answer ends it.
  const unanswered = useRef<string | null>(null);

  async function uploadChain(blob: Blob, hash: string) {
    const resend = unanswered.current;
    setError(null);
    setRemoveRefused(null);
    setProgress('uploading');
    setUploadPct(resend ? 100 : 0);
    setRateWait(null);
    try {
      let attachmentId: string;
      if (resend) {
        attachmentId = resend;
      } else {
        // 1) Presign and 2) PUT to R2 with byte progress — retried TOGETHER, so
        // every try sends to a URL of its own. Retrying the PUT alone reused the
        // first URL: a connection that dropped during a long post-body wait sent
        // its third try after that URL's 10-minute life, R2 refused it (403),
        // and Submit had waited the whole time (pre-merge review).
        const presignData = await retryable(async () => {
          // Its turn on the photo clock first: near the limit, one slot per refill.
          const tight = await takePhotoTurn(setRateWait);
          const p = await postJson<{ url: string; key: string; headers: Record<string, string> }>(
            '/api/photos/presign',
            { kind, mimeType: 'image/jpeg', bytes: blob.size },
            'Could not get upload URL.'
          );
          // The refill it took runs from the server's grant, which this answer follows.
          if (tight) holdPhotos(PHOTO_REFILL_S);
          await putWithProgress(p.url, p.headers, blob, (pct) => setUploadPct(pct));
          return p;
        }, setRateWait);

        // 3) Finalize
        ({ attachmentId } = await retryable(() =>
          postJson<{ attachmentId: string }>(
            '/api/photos/finalize',
            {
              key: presignData.key,
              kind,
              hash,
              capturedAt: new Date().toISOString(),
              capturedLat,
              capturedLng,
            },
            'Finalize failed.'
          ),
          setRateWait
        ));
      }

      // 4) Wire to a customer/branch slot if requested.
      // PROD-006: the reply is the service's `{ ok, code, message, fields? }`
      // (lib/errors.ts runAction). Surface the error message directly so photo
      // wiring failures (slot/kind mismatch, route scope, soft-deleted
      // attachment) reach the salesman.
      if (attachTo) {
        const target =
          attachTo.kind === 'customer'
            ? { customerId: attachTo.customerId, slot: 'CR' as const }
            : { branchId: attachTo.branchId, slot: attachTo.slot };
        let attachRes: ActionResult<unknown>;
        try {
          attachRes = await postAction('/api/photos/attach', { attachmentId, ...target });
        } catch (e) {
          // No answer — given up and aborted, or it failed on its way back — or
          // turned away by the route before the attach was read (a RefusedError:
          // signed out, a password to change first). Either way nothing is
          // known about the attach, so Retry re-sends only it; the route's
          // refusal is shown as what it is, not as no answer.
          unanswered.current = attachmentId;
          throw new Error(
            e instanceof HttpError && e.status === 401
              ? ATTACH_SIGNED_OUT
              : e instanceof RefusedError
                ? e.message
                : ATTACH_NO_ANSWER
          );
        }
        // "May or may not have been saved" (lib/db-errors mayHaveCommitted) is
        // no answer either, and neither is "the database did not respond": that
        // one says nothing was saved by THIS call, not by an earlier one with no
        // answer. Keep the attachment, so Retry re-sends only the attach; as a
        // refusal it made the next Retry upload again and fail "already
        // attached" for a photo that was on the slot.
        if (!attachRes.ok && TRANSIENT_DB_CODES.has(attachRes.code)) {
          unanswered.current = attachmentId;
          throw new Error(attachRes.message);
        }
        unanswered.current = null;
        if (!attachRes.ok) {
          throw new Error(
            attachRes.fields
              ? Object.values(attachRes.fields).join(' ')
              : attachRes.message
          );
        }
      }

      const previewUrl = URL.createObjectURL(blob);
      const next: AttachedPhoto = { attachmentId, previewUrl };
      setPhoto(next);
      setProgress('done');
      setUploadPct(100);
      // Successful upload — we no longer need the retained blob.
      setRetainedBlob(null);
      setRetainedHash(null);
      onChange?.(next);
    } catch (e) {
      // The attach's failures arrive here already worded (above). A 401 here is
      // presign's or finalize's: the session ended, not the step. A dropped
      // connection, three times, is said in the app's words, not the browser's.
      setError(
        e instanceof HttpError && e.status === 401
          ? UPLOAD_SIGNED_OUT
          : isNoConnection(e)
            ? UPLOAD_NO_CONNECTION
            : (e as Error).message
      );
      setProgress('error');
    }
  }

  async function onPicked(file: File) {
    setError(null);
    setRemoveRefused(null);
    if (!file.type.startsWith('image/')) {
      setError('That file is not an image.');
      return;
    }
    setProgress('compressing');
    setUploadPct(0);
    let blob: Blob;
    let hash: string;
    try {
      blob = await compressImage(file);
      // Inside the try: a failed hash used to leave the slot "Compressing…" for
      // good — and now that a busy slot holds Submit, the form with it.
      hash = await sha256Hex(blob);
    } catch (e) {
      // Launch fix: said on the slot, and he picks again. The slot showed its
      // message only outside 'error' or beside Retry upload, which needs a kept
      // photo, so a photo it could not read left it red with no words. Any
      // failure here but HEIC's is "could not read": the canvas's or the
      // hash's own words mean nothing to him. A photo kept from an earlier
      // failed upload goes, or Retry upload would send that one, not this.
      // On a Retake the photo on the slot is still attached and counted: the
      // slot stays done and says so, not red as if it had lost it.
      const said =
        (e as Error).message === HEIC_PHOTO_MESSAGE ? HEIC_PHOTO_MESSAGE : PHOTO_UNREADABLE_MESSAGE;
      setError(photo ? `${said} ${PHOTO_KEPT_NOTE}` : said);
      unanswered.current = null;
      setRetainedBlob(null);
      setRetainedHash(null);
      setProgress(photo ? 'done' : 'error');
      return;
    }
    // B-08: retain so a final-failure "Retry upload" works without re-photographing.
    unanswered.current = null;
    setRetainedBlob(blob);
    setRetainedHash(hash);
    await uploadChain(blob, hash);
  }

  // The chain running now (a pick or a Retry). Unmounting does not stop it: it
  // runs on and still calls onChange. So a slot that goes mid-upload says
  // "not busy" when this ends, not when it unmounts (below).
  const chainRef = useRef<Promise<void> | null>(null);
  function run(chain: Promise<void>) {
    chainRef.current = chain;
    const ended = () => {
      if (chainRef.current === chain) chainRef.current = null;
    };
    void chain.then(ended, ended);
  }

  // UXI-001 (Critical): photo deletion is destructive. The user must
  // explicitly confirm — no more "one bad tap blanks a mandatory CR slot".
  // Required photos (CR / SHOP / SIGNBOARD) get a stronger warning since
  // losing them blocks customer submit until the salesman is back at the
  // shop.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // A confirm opened before the lock would still remove (and detach) after
  // Submit had gone (item 22 review): the lock closes it.
  useEffect(() => {
    if (disabled) setConfirmingDelete(false);
  }, [disabled]);

  // A Remove on its way: the confirm says so and takes no second tap. As a
  // server action it could queue behind a stalled attach for minutes, with the
  // confirm open and nothing happening (post-merge review of 30ec23a).
  const [removing, setRemoving] = useState(false);

  async function actuallyClear() {
    if (disabled || removing) return;
    if (photo?.attachmentId && attachTo) {
      setRemoving(true);
      let refused: string | null = null;
      try {
        // Over fetch, given up after PHOTO_STEP_TIMEOUT_MS. A refusal means the
        // server kept the photo — moved by a merge (PHOTO_CHANGED), not yours,
        // the database did not answer, a password to change first — so the
        // slot keeps it too and says why; clearing it told the form the photo
        // was gone. PHOTO_GONE alone means it is removed already. "Not found"
        // does not: the scope check says it for a customer archived or a route
        // reassigned while the form was open, and the photo stays on its slot
        // (post-merge review, 2026-09-29).
        const reply = await postAction('/api/photos/detach', { attachmentId: photo.attachmentId });
        if (!reply.ok && reply.code !== 'PHOTO_GONE') {
          refused = reply.fields ? Object.values(reply.fields).join(' ') : reply.message;
        }
      } catch (e) {
        if (e instanceof RefusedError) refused = e.message;
        /* otherwise no answer: still clear locally, best effort as before */
      } finally {
        setRemoving(false);
      }
      if (refused !== null) {
        setRemoveRefused(refused);
        setConfirmingDelete(false);
        return;
      }
    }
    if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    setPhoto(null);
    setProgress('idle');
    setError(null);
    setRemoveRefused(null);
    setUploadPct(0);
    setRetainedBlob(null);
    setRetainedHash(null);
    setConfirmingDelete(false);
    onChange?.(null);
  }

  const filled = photo != null;
  const busy = progress === 'compressing' || progress === 'uploading';
  // Driven by `busy` itself, not by each step of the chain, so every way in and
  // out — pick, Retry upload, attached, failed — is covered; the cleanup runs
  // when busy ends AND when the slot unmounts mid-upload, so a parent that
  // counts busy slots never drifts. The latest callback, without re-running
  // the effect (and reporting false-then-true) each time the parent renders.
  const onBusyChangeRef = useRef(onBusyChange);
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  });
  useEffect(() => {
    if (!busy) return;
    const report = onBusyChangeRef.current;
    report?.(true);
    return () => {
      // Busy ended: the chain is over, say so now. Unmounted mid-upload: the
      // chain runs on, so say it when that ends. Said at the unmount, false let
      // Submit go beside a photo still going up, and the page load after the
      // answer cut it off (item 22 review: the new-customer form re-keyed an
      // uploading slot when a sibling finished or was removed).
      const running = chainRef.current;
      if (!running) {
        report?.(false);
        return;
      }
      const ended = () => report?.(false);
      void running.then(ended, ended);
    };
  }, [busy]);
  const imgSrc = photo?.previewUrl ?? photo?.remoteUrl;
  const canRetry = progress === 'error' && retainedBlob != null && retainedHash != null;

  return (
    // isolate: the z-10/z-20/z-30 layers below stay inside this slot. Without
    // it they joined the page's stacking context and painted over the forms'
    // sticky Submit bar whenever a photo row scrolled behind it, so a tap on
    // Submit hit Retake or Remove photo (tests/unit/mobile-submit-bar.test.ts).
    // At least h-32, not exactly: a long message (the HEIC hint) grows the slot
    // rather than being cut off in a half-width slot on a phone.
    <div
      className={cn(
        'relative isolate flex min-h-32 flex-col items-center justify-center overflow-hidden rounded-md border text-center text-sm',
        filled
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
          : 'border-dashed border-slate-300 bg-slate-50 text-slate-500',
        progress === 'error' && 'border-red-300 bg-red-50 text-red-700'
      )}
    >
      {imgSrc && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imgSrc}
          alt={LABELS[kind]}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      <div
        className={cn(
          'relative z-10 flex w-full flex-1 flex-col items-center justify-center gap-1 p-2',
          imgSrc && 'bg-black/30 text-white backdrop-blur-sm'
        )}
      >
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : filled ? (
          <Check className="h-5 w-5" />
        ) : (
          <ImageIcon className="h-5 w-5" />
        )}
        <span className="text-xs font-medium">
          {LABELS[kind]}
          {required && !filled ? ' *' : ''}
        </span>
        {progress === 'compressing' && <span className="text-[11px]">Compressing…</span>}
        {progress === 'uploading' && (
          <>
            {rateWait !== null ? (
              <span role="status" className="text-[11px]">{rateLimitWaitMessage(rateWait)}</span>
            ) : (
              <span className="text-[11px]">Uploading… {uploadPct}%</span>
            )}
            {/* B-08: byte-progress bar so the salesman can tell the upload
                is actually moving over a slow 3G connection. */}
            <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-white/40">
              <div
                className="h-full bg-white transition-[width] duration-150 ease-out"
                style={{ width: `${uploadPct}%` }}
              />
            </div>
          </>
        )}
        {/* Every message but a failed upload's, which shows beside its Retry
            upload. A photo it could not read is in 'error' with no Retry: its
            message showed nowhere (launch browser suite). */}
        {error && !canRetry && (
          <span className="text-[11px] font-medium leading-snug">{error}</span>
        )}
        {removeRefused && (
          <span role="alert" className="text-[11px] font-medium text-red-700">
            {removeRefused}
          </span>
        )}
      </div>
      <input
        ref={fileInput}
        id={inputId}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (f && !disabled) run(onPicked(f));
          // B-08: clear the input value so the same file name can be
          // re-picked, but the compressed blob stays in retainedBlob.
          e.currentTarget.value = '';
        }}
      />
      {!busy && !confirmingDelete && !removing && !disabled && (
        <div className="absolute right-1 top-1 z-20 flex gap-1">
          {filled && (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-red-600 shadow-sm hover:bg-white"
              aria-label="Remove photo"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <label
            htmlFor={inputId}
            className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-white/90 text-brand-700 shadow-sm hover:bg-white"
            aria-label={filled ? 'Retake photo' : 'Capture photo'}
          >
            {filled ? <RefreshCw className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
          </label>
        </div>
      )}
      {/* B-08: retry overlay. After 3 attempts on each step we land here.
          Salesman taps once and the same compressed blob is re-pushed —
          no re-photograph needed (which on a phone with degraded battery
          would cost 30+ seconds). */}
      {canRetry && (
        <div className="absolute inset-x-1 bottom-1 z-20 flex flex-col items-center gap-1 rounded-md bg-white/95 p-2 text-center text-xs text-slate-900 shadow-sm">
          {/* The message stays while locked: in 'error' this is the only place
              it shows. The button does not — tapped during a submit, it
              started an upload that the page load after the answer cut off
              (item 22 review). */}
          <span className="font-medium text-red-700">{error ?? 'Upload failed.'}</span>
          {!disabled && (
            <button
              type="button"
              onClick={() => {
                if (disabled) return;
                if (retainedBlob && retainedHash) {
                  run(uploadChain(retainedBlob, retainedHash));
                }
              }}
              className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-700"
            >
              <RotateCw className="h-3.5 w-3.5" />
              Retry upload
            </button>
          )}
        </div>
      )}
      {/* UXI-001: confirm dialog overlay. Required photos get a stronger
          warning because losing one mid-pilot means a return field visit. */}
      {confirmingDelete && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-white/95 p-3 text-center text-sm text-slate-900">
          <p className="font-semibold">
            Remove this {LABELS[kind]} photo?
          </p>
          {required && (
            <p className="text-xs text-red-700">
              This is required. You will need to capture a new one before submitting.
            </p>
          )}
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              disabled={removing}
              className="rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={actuallyClear}
              disabled={removing}
              className="rounded-md bg-red-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:bg-slate-400"
            >
              {removing ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
