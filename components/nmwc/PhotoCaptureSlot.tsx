'use client';

import { useId, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Trash2, RefreshCw, Check, Loader2, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { attachPhotoAction, detachPhotoAction } from '@/services/photos';

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
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new HttpError(xhr.status, `Upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.ontimeout = () => reject(new Error('Network error'));
    xhr.send(body);
  });
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
   * Read-only rendering (e.g. a SUBMITTED create request): hides the
   * capture/retake/remove controls entirely so the slot cannot upload or
   * clear anything — a visually frozen view must not fire server calls.
   */
  disabled?: boolean;
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

  async function uploadChain(blob: Blob, hash: string) {
    setError(null);
    setProgress('uploading');
    setUploadPct(0);
    try {
      // 1) Presign
      const presignData = await retryable(async () => {
        const res = await fetch('/api/photos/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, mimeType: 'image/jpeg', bytes: blob.size }),
        });
        if (!res.ok) throw new HttpError(res.status, 'Could not get upload URL.');
        return (await res.json()) as {
          url: string;
          key: string;
          headers: Record<string, string>;
        };
      });

      // 2) PUT to R2 with byte progress.
      await retryable(() =>
        putWithProgress(presignData.url, presignData.headers, blob, (pct) =>
          setUploadPct(pct)
        )
      );

      // 3) Finalize
      const finalizeData = await retryable(async () => {
        const res = await fetch('/api/photos/finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: presignData.key,
            kind,
            hash,
            capturedAt: new Date().toISOString(),
            capturedLat,
            capturedLng,
          }),
        });
        if (!res.ok) throw new HttpError(res.status, 'Finalize failed.');
        return (await res.json()) as { attachmentId: string };
      });

      // 4) Wire to a customer/branch slot if requested.
      // PROD-006: the action returns `{ ok, code, message, fields? }` shape —
      // see lib/errors.ts (runAction). Surface the error message directly so
      // photo wiring failures (slot/kind mismatch, route scope, soft-deleted
      // attachment) reach the salesman instead of being lost to a generic SC
      // render error.
      if (attachTo) {
        const attachRes =
          attachTo.kind === 'customer'
            ? await attachPhotoAction({
                attachmentId: finalizeData.attachmentId,
                customerId: attachTo.customerId,
                slot: 'CR',
              })
            : await attachPhotoAction({
                attachmentId: finalizeData.attachmentId,
                branchId: attachTo.branchId,
                slot: attachTo.slot,
              });
        if (!attachRes.ok) {
          throw new Error(
            attachRes.fields
              ? Object.values(attachRes.fields).join(' ')
              : attachRes.message
          );
        }
      }

      const previewUrl = URL.createObjectURL(blob);
      const next: AttachedPhoto = { attachmentId: finalizeData.attachmentId, previewUrl };
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
    try {
      blob = await compressImage(file);
    } catch (e) {
      setError((e as Error).message);
      setProgress('error');
      return;
    }
    const hash = await sha256Hex(blob);
    // B-08: retain so a final-failure "Retry upload" works without re-photographing.
    setRetainedBlob(blob);
    setRetainedHash(hash);
    await uploadChain(blob, hash);
  }

  // UXI-001 (Critical): photo deletion is destructive. The user must
  // explicitly confirm — no more "one bad tap blanks a mandatory CR slot".
  // Required photos (CR / SHOP / SIGNBOARD) get a stronger warning since
  // losing them blocks customer submit until the salesman is back at the
  // shop.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function actuallyClear() {
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
          if (f && !disabled) onPicked(f);
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
          <span className="font-medium text-red-700">{error ?? 'Upload failed.'}</span>
          <button
            type="button"
            onClick={() => {
              if (retainedBlob && retainedHash) {
                void uploadChain(retainedBlob, retainedHash);
              }
            }}
            className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-700"
          >
            <RotateCw className="h-3.5 w-3.5" />
            Retry upload
          </button>
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
