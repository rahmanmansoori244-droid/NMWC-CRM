/**
 * Test images. Every image the suite stores must have UNIQUE bytes: the photo
 * finalize dedupes on (sha256, uploader) whatever the slot, so a reused image
 * comes back as the old attachment (a wrong-kind attach, a "retake" that
 * replaces nothing, an orphan object in R2).
 */
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';

/** A 16×16 baseline JPEG (Chromium canvas, quality 0.6). */
const BASE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAABQb/xAAYEAACAwAAAAAAAAAAAAAAAAAABAUiMf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAYEQADAQEAAAAAAAAAAAAAAAAAAgUhMf/aAAwDAQACEQMRAD8Ak1IzKjicZlRZOMyo4pGZUI4mU+af/9k=',
  'base64'
);
export const TINY_JPEG_SIZE = { width: 16, height: 16 } as const;

/**
 * A valid ~2 KB JPEG whose bytes are unique to `seed` and to this call: a COM
 * (comment) segment carrying the seed and a random nonce is inserted after SOI.
 * Decoders ignore COM, so the image renders; its sha256 never repeats.
 */
export function tinyJpeg(seed: string | number, targetBytes = 2048): Buffer {
  const text = Buffer.from(`nmwc-e2e seed=${seed} nonce=${randomBytes(12).toString('hex')} `, 'ascii');
  const room = Math.max(text.length, Math.min(65_000, targetBytes - BASE_JPEG.length - 4));
  const payload = Buffer.alloc(room, 0x20);
  text.copy(payload, 0, 0, Math.min(text.length, room));
  const segLen = Buffer.alloc(2);
  segLen.writeUInt16BE(payload.length + 2);
  return Buffer.concat([BASE_JPEG.subarray(0, 2), Buffer.from([0xff, 0xfe]), segLen, payload, BASE_JPEG.subarray(2)]);
}

export function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/**
 * A PNG for a browser upload (the camera input). The app re-encodes it to JPEG in
 * the browser, so uniqueness must survive compression: the colours and the size
 * are random per call, never only a comment.
 */
export function uniquePng(): Buffer {
  const r = randomBytes(5);
  return png(320 + (r[3]! % 200), 240 + (r[4]! % 160), [r[0]!, r[1]!, r[2]!]);
}

/** Minimal valid PNG with a gradient (copied from the go-live spec; distinct per colour). */
export function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = (rgb[0] + x) & 0xff;
      raw[o + 1] = (rgb[1] + y) & 0xff;
      raw[o + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A JPEG the browser itself encodes — random noise on an OffscreenCanvas — for
 * the camera input when a test needs a big, realistic photo (the 5 MB file that
 * the app must compress). Unique bytes every call.
 */
export async function jpegInBrowser(page: Page, width: number, height: number, quality = 0.92): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ([w, h, q]) => {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      const img = ctx.createImageData(w, h);
      const buf = new Uint32Array(img.data.buffer);
      // Noise in 64 KiB slices (getRandomValues caps one call at 65,536 bytes).
      for (let i = 0; i < buf.length; i += 16_384) crypto.getRandomValues(buf.subarray(i, Math.min(buf.length, i + 16_384)));
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      ctx.putImageData(img, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    [width, height, quality] as const
  );
  return Buffer.from(b64, 'base64');
}

/** The first bytes of an HEIC file (ftyp heic) — a phone format the app must refuse or convert. */
export function fakeHeic(): Buffer {
  const ftyp = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypheic', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('mif1heic', 'ascii'),
  ]);
  return Buffer.concat([ftyp, randomBytes(512)]);
}

/** A minimal one-page PDF (a guarantee scanned as PDF; the app takes images only). */
export function tinyPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A plain-text file named like a photo would be — the wrong type entirely. */
export function textFile(text = `not an image ${randomBytes(6).toString('hex')}\n`): Buffer {
  return Buffer.from(text, 'utf8');
}
