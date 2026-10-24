/**
 * Gap 28 (data audit 2026-10-10): the off-site copy of each seal, in R2 under
 * seals/ (lib/seal/chain.ts sealObjectKey), through the application's own R2
 * client (lib/r2.ts) and bucket.
 *
 * A seal is written once: if its object exists, it is read back and compared
 * (the same text is fine, a different one is a failure); if not, it is put. The
 * object holds the seal's body only — table names, key ranges, counts and
 * digests — never a row's content.
 *
 * Photo keys are `<ymd>/<user>/…`, so nothing collides with seals/, and the
 * photos' lifecycle rule expires only objects photo-gc TAGGED (gc-marked), which
 * a seal never is. OPERATIONS.md asks the owner to confirm no lifecycle rule on
 * the bucket expires seals/.
 *
 * Owner note, not configured here: until the bucket (or a separate one) locks
 * seals/, the application's own R2 token can overwrite these objects, so they
 * are a second copy, not an immutable one. The keys are fixed by the chain and
 * the seq (lib/seal/chain.ts sealObjectKey), so under such a lock a rewritten
 * seal can never get a copy of its own; and the whole of seals/ is listed, so a
 * copy the database no longer has a seal for is found.
 *
 * PURE of lib/db: scripts/ops/verify-seals.ts imports it.
 */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../r2';

export type SealStore = {
  /** The object's text, or null when it does not exist. */
  get(key: string): Promise<string | null>;
  /** Write it (the caller has checked it is absent). */
  put(key: string, body: string, hash: string): Promise<void>;
  /** Every key under the prefix (seals/). */
  list(prefix: string): Promise<string[]>;
};

/** A listing of more objects than this is refused: seals/ holds one per night. */
export const SEAL_LIST_MAX_KEYS = 20_000;

/** Whether R2 itself answered that the object is not there (as photo-gc reads it). */
function notFound(err: unknown): boolean {
  const e = err as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.name === 'NoSuchBucket' || e.Code === 'NoSuchBucket') return false;
  return e.name === 'NoSuchKey' || e.Code === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}

/** The R2 store, every call aborted at `signal` (a run's deadline, as photo-gc does). */
export function r2SealStore(signal?: AbortSignal): SealStore {
  return {
    async get(key) {
      try {
        const res = await r2().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { abortSignal: signal });
        return res.Body ? await res.Body.transformToString('utf-8') : '';
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },
    async put(key, body, hash) {
      await r2().send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          Metadata: { 'nmwc-seal-hash': hash },
        }),
        { abortSignal: signal }
      );
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const out = await r2().send(
          new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }),
          { abortSignal: signal }
        );
        for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
        if (keys.length > SEAL_LIST_MAX_KEYS) throw new Error(`more than ${SEAL_LIST_MAX_KEYS} objects under ${prefix}`);
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
}

export type OffsiteResult = 'stored' | 'present' | 'differs';

/** Put the seal's copy if it is absent; compare it if it is there. */
export async function ensureOffsite(store: SealStore, seal: { r2Key: string; bodyText: string; hash: string }): Promise<OffsiteResult> {
  const existing = await store.get(seal.r2Key);
  if (existing === null) {
    await store.put(seal.r2Key, seal.bodyText, seal.hash);
    return 'stored';
  }
  return existing === seal.bodyText ? 'present' : 'differs';
}
