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
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Image decode failed'));
    im.src = dataUrl;
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
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Compression failed'))),
      'image/jpeg',
      quality
    );
  });
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

      // 4) Wire to a customer/branch slot if requested
      if (attachTo) {
        if (attachTo.kind === 'customer') {
          await attachPhotoAction({ attachmentId, customerId: attachTo.customerId, slot: 'CR' });
        } else {
          await attachPhotoAction({
            attachmentId,
            branchId: attachTo.branchId,
            slot: attachTo.slot,
          });
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

  async function clear() {
    if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    if (photo?.attachmentId && attachTo) {
      try {
        await detachPhotoAction({ attachmentId: photo.attachmentId });
      } catch {
        /* still clear locally */
      }
    }
    setPhoto(null);
    setProgress('idle');
    setError(null);
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
      {!busy && (
        <div className="absolute right-1 top-1 z-20 flex gap-1">
          {filled && (
            <button
              type="button"
              onClick={clear}
              className="rounded-full bg-white/90 p-1 text-red-600 shadow-sm hover:bg-white"
              aria-label="Remove photo"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          <label
            htmlFor={inputId}
            className="cursor-pointer rounded-full bg-white/90 p-1 text-brand-700 shadow-sm hover:bg-white"
            aria-label={filled ? 'Retake photo' : 'Capture photo'}
          >
            {filled ? <RefreshCw className="h-3.5 w-3.5" /> : <Camera className="h-3.5 w-3.5" />}
          </label>
        </div>
      )}
    </div>
  );
}
