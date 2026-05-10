'use client';

import { useId, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Trash2, RefreshCw, Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { attachPhotoAction, detachPhotoAction } from '@/services/photos';

export type PhotoSlotKind = 'SHOP' | 'SIGNBOARD' | 'CR' | 'FREE';
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

export function PhotoCaptureSlot({
  kind,
  required,
  initial,
  onChange,
  capturedLat,
  capturedLng,
  attachTo,
}: {
  kind: PhotoSlotKind;
  required?: boolean;
  initial?: AttachedPhoto | null;
  onChange?: (photo: AttachedPhoto | null) => void;
  capturedLat?: number;
  capturedLng?: number;
  /** When provided, the photo is wired to a customer/branch slot immediately after finalize. */
  attachTo?: AttachTarget;
}) {
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<AttachedPhoto | null>(initial ?? null);
  const [progress, setProgress] = useState<'idle' | 'compressing' | 'uploading' | 'done' | 'error'>(
    initial ? 'done' : 'idle'
  );
  const [error, setError] = useState<string | null>(null);

  async function onPicked(file: File) {
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('That file is not an image.');
      return;
    }
    setProgress('compressing');
    let blob: Blob;
    try {
      blob = await compressImage(file);
    } catch (e) {
      setError((e as Error).message);
      setProgress('error');
      return;
    }
    const hash = await sha256Hex(blob);

    setProgress('uploading');
    try {
      // 1) Presign
      const presign = await fetch('/api/photos/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, mimeType: 'image/jpeg', bytes: blob.size }),
      });
      if (!presign.ok) throw new Error('Could not get upload URL.');
      const presignData = (await presign.json()) as {
        url: string;
        key: string;
        headers: Record<string, string>;
      };

      // 2) PUT to R2
      const put = await fetch(presignData.url, {
        method: 'PUT',
        headers: presignData.headers,
        body: blob,
      });
      if (!put.ok) throw new Error('Upload failed.');

      // 3) Finalize
      const finalize = await fetch('/api/photos/finalize', {
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
      if (!finalize.ok) throw new Error('Finalize failed.');
      const { attachmentId } = (await finalize.json()) as { attachmentId: string };

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
                attachmentId,
                customerId: attachTo.customerId,
                slot: 'CR',
              })
            : await attachPhotoAction({
                attachmentId,
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
      const next: AttachedPhoto = { attachmentId, previewUrl };
      setPhoto(next);
      setProgress('done');
      onChange?.(next);
    } catch (e) {
      setError((e as Error).message);
      setProgress('error');
    }
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
    setConfirmingDelete(false);
    onChange?.(null);
  }

  const filled = photo != null;
  const busy = progress === 'compressing' || progress === 'uploading';
  const imgSrc = photo?.previewUrl ?? photo?.remoteUrl;

  return (
    <div
      className={cn(
        'relative flex h-32 flex-col items-center justify-center overflow-hidden rounded-md border text-center text-xs',
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
        <span className="text-[11px] font-medium">
          {LABELS[kind]}
          {required && !filled ? ' *' : ''}
        </span>
        {progress === 'compressing' && <span className="text-[10px]">Compressing…</span>}
        {progress === 'uploading' && <span className="text-[10px]">Uploading…</span>}
        {error && <span className="text-[10px] font-medium">{error}</span>}
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
          if (f) onPicked(f);
          e.currentTarget.value = '';
        }}
      />
      {!busy && !confirmingDelete && (
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
      {/* UXI-001: confirm dialog overlay. Required photos get a stronger
          warning because losing one mid-pilot means a return field visit. */}
      {confirmingDelete && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-white/95 p-3 text-center text-xs text-slate-900">
          <p className="font-semibold">
            Remove this {LABELS[kind]} photo?
          </p>
          {required && (
            <p className="text-[11px] text-red-700">
              This is required. You will need to capture a new one before submitting.
            </p>
          )}
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={actuallyClear}
              className="rounded-md bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700"
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
