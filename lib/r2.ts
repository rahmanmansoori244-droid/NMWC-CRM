import { S3Client } from '@aws-sdk/client-s3';

let _client: S3Client | null = null;

export function r2(): S3Client {
  if (_client) return _client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials are not configured. See .env.example.');
  }
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // NEW-PHOTO-013: AWS SDK v3 ≥ 3.729 enables "flexible checksums" by
    // default. For PutObject this hoists `x-amz-checksum-crc32=AAAAAA==`
    // (the CRC32 of an empty payload) and `x-amz-sdk-checksum-algorithm=CRC32`
    // into the presigned URL's query string. Cloudflare R2 then verifies the
    // uploaded body against that CRC32 and rejects every PUT — the browser's
    // `fetch` doesn't recompute or send a real CRC32. Browser-PUT photo
    // uploads silently fail with "Upload failed." in PhotoCaptureSlot.tsx.
    //
    // Repro before fix: any photo capture on the customer/branch edit form
    // returns network 400 from R2 with `XAmzContentChecksumMismatch`. The
    // server-side finalize never runs because the PUT step throws.
    //
    // Fix: opt out of automatic checksum calculation so the SDK signs the URL
    // without the bogus pre-computed CRC32. We still sign content-length and
    // host (R2 verifies those server-side). Server-to-server S3 calls in this
    // app (`HeadObjectCommand`, `GetObjectCommand`) don't send a body, so
    // they're unaffected.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return _client;
}

export const R2_BUCKET = process.env.R2_BUCKET ?? 'nmwc-photos';
