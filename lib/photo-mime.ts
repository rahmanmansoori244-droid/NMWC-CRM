/**
 * SEC-14e — what a stored photograph is SERVED as, decided here and nowhere else.
 *
 * The presigned upload does not bind Content-Type. `@aws-sdk/s3-request-presigner`
 * adds `content-type` to its unsignable-headers set by design, so it never appears
 * in SignedHeaders: the client may PUT the signed URL with any Content-Type it
 * likes, and R2 stores that. `app/api/photos/finalize/route.ts` then copies the
 * stored `head.ContentType` verbatim into `Attachment.mimeType`, and the serving
 * route used to echo that column straight back as the response Content-Type.
 *
 * So a salesman could request an ordinary presign, PUT an HTML document, finalize
 * it, attach it to a photo slot on his own route and submit the edit. The
 * supervisor or GM reviewing that edit opens the tile — every photo tile on the
 * approvals and customer screens is an `<a target="_blank">` to /api/photos/<id>,
 * and the role guide tells them to "tap one to open it full size" — and gets an
 * attacker-written page on the app's own origin, in the address bar, on the domain
 * they just signed into. Script execution was blocked by the nonce CSP, so this was
 * never stored XSS; a fake "your session expired" sign-in form on that page was the
 * realistic harm, since neither CSP declares `form-action`.
 *
 * The fix is to stop trusting the stored type, which is the only attacker-supplied
 * field in the decision. The order below is deliberate:
 *
 *   1. the stored type, but ONLY if it is one of the three servable image types;
 *   2. otherwise the extension of the R2 key, which is server-minted — the presign
 *      builds it from a zod-validated body (jpg|png|webp are the only reachable
 *      values) and the presigned PUT binds the exact Key in the signed path, so no
 *      object can exist at a `.html` key. That makes the key a strictly safer type
 *      source than the mime column, and it also rescues a legitimate upload whose
 *      Content-Type header was lost in transit rather than turning that photo into
 *      a download on the approver's screen;
 *   3. otherwise `application/octet-stream` as an attachment, which renders nothing
 *      and navigates nowhere.
 *
 * An attacker who stores `text/html` therefore gets his own key's `image/jpeg`
 * back. HTML bytes under an explicit image type are inert in every browser, and
 * `X-Content-Type-Options: nosniff` (next.config.ts) stops the sniffing path.
 *
 * DO NOT widen the accepted types without deciding the disposition at the same
 * time. The open GUARANTEE-as-PDF question (docs/discovery/blueprint-inputs/
 * data-model.md:114) is the live example: two integration fixtures already create
 * `application/pdf` GUARANTEE rows, and adding `pdf` here as `inline` would re-open
 * exactly the navigation surface this module closes. A PDF must be served as an
 * attachment.
 */

/** The three types a photograph may be served as inline. */
export const SERVABLE_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Servable type → the extension used in the download filename. */
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** R2 key extension → type. The key is server-minted; see the header comment. */
const FROM_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export type ServeHeaders = { contentType: string; contentDisposition: string };

/**
 * Response headers for one stored attachment.
 *
 * @param storedMime `Attachment.mimeType` — attacker-influenceable, never trusted
 *                   beyond membership of the servable set.
 * @param r2Key      `Attachment.r2Key` — server-minted, used for the fallback type.
 * @param attachmentId used only to build a filename; sanitised regardless.
 */
export function serveHeadersFor(
  storedMime: string,
  r2Key: string,
  attachmentId: string
): ServeHeaders {
  const safeId = (attachmentId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');

  // Parameters stripped and case folded, so a legitimate `image/jpeg; charset=…`
  // still renders inline. Availability matters as much as the pin: a tightening
  // edit here would blank every photo on the approvals screen.
  const base = (storedMime ?? '').split(';')[0].trim().toLowerCase();
  let type = EXT[base] ? base : '';

  if (!type) {
    const keyExt = (r2Key ?? '').split('?')[0].split('.').pop()?.toLowerCase() ?? '';
    type = FROM_EXT[keyExt] ?? '';
  }

  if (!type) {
    return {
      contentType: 'application/octet-stream',
      contentDisposition: `attachment; filename="photo-${safeId}.bin"`,
    };
  }
  return {
    contentType: type,
    contentDisposition: `inline; filename="photo-${safeId}.${EXT[type]}"`,
  };
}
