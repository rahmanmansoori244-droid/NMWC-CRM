/**
 * R2 access for the launch suite — the bucket in .env is PRODUCTION's photo
 * bucket, holding real customers' shopfronts.
 *
 * The suite may only touch keys laid out the way the app's presign lays them
 * out, under a FIXTURE user's id:  <UTC yyyy/mm/dd>/<fixtureUserId>/<KIND>/<name>
 * Every PUT, list and DeleteObject goes through assertFixtureKey()/
 * assertFixturePrefix() first. There is no function here that can list the
 * bucket, or a day, or delete by anything but one checked key.
 */
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { hasR2, safeError } from './env';

const KINDS = ['SHOP', 'SIGNBOARD', 'CR', 'GUARANTEE', 'FREE'] as const;
const YMD = /^\d{4}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;
/** cuid-shaped ids (Prisma's default and the suite's own newId()). */
const USER_ID = /^c[a-z0-9]{8,40}$/;

let client: S3Client | undefined;

function s3(): S3Client {
  if (!hasR2) throw new Error('R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).');
  if (client) return client;
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    // As lib/r2.ts: R2 rejects the SDK's default CRC32 on presigned PUTs, and
    // path-style keeps every request on the account host.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    forcePathStyle: true,
    maxAttempts: 3,
  });
  return client;
}

/** The bucket name — the only R2 value the suite may print. */
export function r2BucketName(): string {
  return process.env.R2_BUCKET ?? '';
}

/**
 * Throws unless `key` is <yyyy/mm/dd>/<one of fixtureUserIds>/<KIND>/<file> with
 * nothing else in it. This is the guard in front of every R2 write and delete.
 */
export function assertFixtureKey(key: string, fixtureUserIds: ReadonlySet<string>): void {
  const parts = key.split('/');
  const ok =
    parts.length === 6 &&
    YMD.test(parts.slice(0, 3).join('/')) &&
    USER_ID.test(parts[3]!) &&
    fixtureUserIds.has(parts[3]!) &&
    (KINDS as readonly string[]).includes(parts[4]!) &&
    /^[A-Za-z0-9._-]{1,120}$/.test(parts[5]!) &&
    !parts[5]!.startsWith('.');
  if (!ok) {
    throw new Error(
      `R2 GUARD: refusing key "${key}" — only <yyyy/mm/dd>/<fixture user id>/<KIND>/<file> may be written or deleted`
    );
  }
}

/** Throws unless the prefix is exactly <yyyy/mm/dd>/<fixture user id>/. */
export function assertFixturePrefix(ymd: string, userId: string, fixtureUserIds: ReadonlySet<string>): string {
  if (!YMD.test(ymd) || !USER_ID.test(userId) || !fixtureUserIds.has(userId)) {
    throw new Error(`R2 GUARD: refusing prefix "${ymd}/${userId}/" — not a fixture user's day`);
  }
  return `${ymd}/${userId}/`;
}

export async function putFixtureObject(
  key: string,
  body: Buffer,
  contentType: string,
  fixtureUserIds: ReadonlySet<string>
): Promise<void> {
  assertFixtureKey(key, fixtureUserIds);
  try {
    await s3().send(
      new PutObjectCommand({ Bucket: r2BucketName(), Key: key, Body: body, ContentType: contentType, ContentLength: body.length })
    );
  } catch (err) {
    throw safeError(err, 'R2 PUT failed');
  }
}

export async function deleteFixtureObject(key: string, fixtureUserIds: ReadonlySet<string>): Promise<void> {
  assertFixtureKey(key, fixtureUserIds);
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: r2BucketName(), Key: key }));
  } catch (err) {
    throw safeError(err, 'R2 DELETE failed');
  }
}

/** Keys under one fixture user's day — the only listing the suite performs. */
export async function listFixturePrefix(
  ymd: string,
  userId: string,
  fixtureUserIds: ReadonlySet<string>
): Promise<string[]> {
  const prefix = assertFixturePrefix(ymd, userId, fixtureUserIds);
  const keys: string[] = [];
  let token: string | undefined;
  try {
    do {
      const out = await s3().send(
        new ListObjectsV2Command({ Bucket: r2BucketName(), Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 })
      );
      for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  } catch (err) {
    throw safeError(err, 'R2 LIST failed');
  }
  return keys;
}
