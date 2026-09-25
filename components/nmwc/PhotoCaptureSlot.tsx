'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Trash2, RefreshCw, Check, Loader2, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { attachPhotoAction, detachPhotoAction } from '@/services/photos';
import { ALREADY_ATTACHED_MESSAGE } from '@/lib/photo-attach';

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
          reject(
            new Error(
              "Your phone is sending HEIC photos. Open Settings → Camera → Formats and switch to 'Most Compatible' (JPEG)."
            )
          );
        } else {
          reject(new Error('Image decode failed.'));
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
 * fine while its bytes move, so the clock restarts on every progress event and
 * when the body has gone. 45 s leaves room for bytes the phone had buffered
 * before its last progress event to drain.
 */
export const UPLOAD_STALL_MS = 45_000;

/**
 * Presign, finalize and attach are small requests: they get as long as a
 * submit does (SUBMIT_TIMEOUT_MS), far past a normal answer and under the
 * server's 60 s limit.
 */
export const PHOTO_STEP_TIMEOUT_MS = 30_000;

/** The failure isRetryable() knows as a dropped connection. */
const networkError = () => new Error('Network error');

/** What a slot says when its attach got no answer — it may still have landed. */
const ATTACH_NO_ANSWER =
  'The photo is up, but attaching it got no answer. Tap Retry upload.';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500;
  // `fetch` throws a TypeError for network failures and CORS issues.
  if (err instanceof TypeError) return true;
  // XHR network error (we surface as generic Error with the marker message).
  if (err instanceof Error && err.message === 'Network error') return true;
  return false;
}

async function retryable<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      // Don't sleep after the last attempt.
      if (attempt < RETRY_DELAYS.length - 1) {
        await delay(RETRY_DELAYS[attempt]);
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
    // TOTAL time and would fail a slow upload that is still moving. The
    // ontimeout handler that stood here never ran — xhr.timeout was never set,
    // and 0 means no limit.
    let stall: ReturnType<typeof setTimeout> | undefined;
    const quiet = () => clearTimeout(stall);
    const watch = () => {
      quiet();
      stall = setTimeout(() => {
        xhr.abort();
        reject(networkError());
      }, UPLOAD_STALL_MS);
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
      watch();
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    // The body has gone: R2's answer gets a full stretch of its own.
    xhr.upload.onload = watch;
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
    watch();
    xhr.send(body);
  });
}

/**
 * A JSON POST with a limit (PHOTO_STEP_TIMEOUT_MS) on the whole exchange —
 * reading the reply included, since a body can stall after its headers. Given
 * up, it fails as a dropped connection, which retryable() tries again; an
 * AbortError it does not know would have ended the chain at the first stall.
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
    if (!res.ok) throw new HttpError(res.status, failMessage);
    return (await res.json()) as T;
  } catch (err) {
    if (abort.signal.aborted) throw networkError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop waiting after `ms`, for work that cannot be aborted: a server action
 * (lib/submit-client.ts). The work itself goes on, and may still land.
 */
function withinTime<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
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
  const [error, setError] = useState<string | null>(null);
  // B-08: retain the compressed blob in component state separate from the
  // <input file> element. e.currentTarget.value = '' kills the input but the
  // blob lives here so "Retry upload" can re-run the chain without forcing
  // the user to re-photograph the storefront.
  const [retainedBlob, setRetainedBlob] = useState<Blob | null>(null);
  const [retainedHash, setRetainedHash] = useState<string | null>(null);
  // The retained photo is up and finalized, but its attach got no answer: this
  // is its attachment. Retry then sends only the attach again, not the photo
  // over the same weak signal. services/photos.ts refuses a second attach of
  // one attachment and writes nothing, so after such a re-send "already
  // attached" means the first one landed. A new photo replaces it; an answered
  // attach ends it.
  const unanswered = useRef<string | null>(null);

  async function uploadChain(blob: Blob, hash: string) {
    const resend = unanswered.current;
    setError(null);
    setProgress('uploading');
    setUploadPct(resend ? 100 : 0);
    try {
      let attachmentId: string;
      if (resend) {
        attachmentId = resend;
      } else {
        // 1) Presign
        const presignData = await retryable(() =>
          postJson<{ url: string; key: string; headers: Record<string, string> }>(
            '/api/photos/presign',
            { kind, mimeType: 'image/jpeg', bytes: blob.size },
            'Could not get upload URL.'
          )
        );

        // 2) PUT to R2 with byte progress.
        await retryable(() =>
          putWithProgress(presignData.url, presignData.headers, blob, (pct) =>
            setUploadPct(pct)
          )
        );

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
          )
        ));
      }

      // 4) Wire to a customer/branch slot if requested.
      // PROD-006: the action returns `{ ok, code, message, fields? }` shape —
      // see lib/errors.ts (runAction). Surface the error message directly so
      // photo wiring failures (slot/kind mismatch, route scope, soft-deleted
      // attachment) reach the salesman instead of being lost to a generic SC
      // render error.
      if (attachTo) {
        const target =
          attachTo.kind === 'customer'
            ? { customerId: attachTo.customerId, slot: 'CR' as const }
            : { branchId: attachTo.branchId, slot: attachTo.slot };
        let attachRes: Awaited<ReturnType<typeof attachPhotoAction>>;
        try {
          attachRes = await withinTime(
            attachPhotoAction({ attachmentId, ...target }),
            PHOTO_STEP_TIMEOUT_MS,
            ATTACH_NO_ANSWER
          );
        } catch (e) {
          // No answer — the wait ran out, or the call failed on its way back.
          unanswered.current = attachmentId;
          throw e;
        }
        unanswered.current = null;
        const landedBefore =
          resend != null &&
          !attachRes.ok &&
          attachRes.fields?.attachmentId === ALREADY_ATTACHED_MESSAGE;
        if (!attachRes.ok && !landedBefore) {
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
      setError((e as Error).message);
      setProgress('error');
    }
  }

  async function onPicked(file: File) {
    setError(null);
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
      setError((e as Error).message);
      setProgress('error');
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

  async function actuallyClear() {
    if (disabled) return;
    if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    if (photo?.attachmentId && attachTo) {
      try {
        // detachPhotoAction returns the new ActionResult shape; we still
        // best-effort-clear locally on any failure (network / 404). The
        // form's stale state will reconcile on next refresh.
        await detachPhotoAction({ attachmentId: photo.attachmentId });
      } catch {
        /* still clear locally */
      }
    }
    setPhoto(null);
    setProgress('idle');
    setError(null);
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
    <div
      className={cn(
        'relative flex h-32 flex-col items-center justify-center overflow-hidden rounded-md border text-center text-sm',
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
          'relative z-10 flex h-full w-full flex-col items-center justify-center gap-1 p-2',
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
            <span className="text-[11px]">Uploading… {uploadPct}%</span>
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
        {error && progress !== 'error' && (
          <span className="text-[11px] font-medium">{error}</span>
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
      {!busy && !confirmingDelete && !disabled && (
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
              className="rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={actuallyClear}
              className="rounded-md bg-red-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-red-700"
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
