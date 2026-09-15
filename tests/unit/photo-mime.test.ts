// @vitest-environment node
/**
 * SEC-14e — a photograph must never be served as the type the uploader chose.
 *
 * The presigned PUT does not bind Content-Type (the S3 presigner marks that header
 * unsignable), finalize copies the stored type into `Attachment.mimeType`, and the
 * serving route used to echo that column back. A salesman could therefore store an
 * HTML document and have the app serve it from its own origin to the supervisor or
 * GM who opened the photo tile on the approvals screen.
 *
 * Two guards, because one alone is not enough:
 *   - the table test below pins the decision function, including the attacker case
 *     and the two availability cases that a later "tightening" would break;
 *   - the structural guard pins the route, because a correct helper that nothing
 *     calls is exactly the state this defect was in.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { serveHeadersFor, SERVABLE_IMAGE_MIME } from '@/lib/photo-mime';

const ROUTE = 'app/api/photos/[id]/route.ts';

/** A realistic server-minted key: date / user / kind / uuid.ext. */
const key = (ext: string) => `2026/09/15/usr_abc123/SHOP/0f0e0d0c-1b2a.${ext}`;

describe('serveHeadersFor — the type a photograph is served as', () => {
  it.each(SERVABLE_IMAGE_MIME)('serves a genuine %s inline, as itself', (mime) => {
    const ext = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1];
    const out = serveHeadersFor(mime, key(ext), 'att1');
    expect(out.contentType).toBe(mime);
    expect(out.contentDisposition).toBe(`inline; filename="photo-att1.${ext}"`);
  });

  // ---- availability: the cases a careless tightening would break ----

  it('still serves a type carrying parameters', () => {
    // `image/jpeg; charset=utf-8` is a legitimate thing for a client to send. An
    // exact-match implementation would turn every such photo into a download on
    // the approver's screen.
    expect(serveHeadersFor('image/jpeg; charset=utf-8', key('jpg'), 'a').contentType).toBe(
      'image/jpeg'
    );
  });

  it('still serves a type sent in upper case', () => {
    expect(serveHeadersFor('IMAGE/PNG', key('png'), 'a').contentType).toBe('image/png');
  });

  it('falls back to the key extension when the upload header was lost', () => {
    // PhotoCaptureSlot swallows a failed setRequestHeader, so a real photo can
    // legitimately arrive as octet-stream. It must still render, not download.
    const out = serveHeadersFor('application/octet-stream', key('png'), 'a');
    expect(out.contentType).toBe('image/png');
    expect(out.contentDisposition).toMatch(/^inline;/);
  });

  // ---- the attacker cases: these FAIL against the pre-fix route ----

  it('serves stored text/html as the key type, never as HTML', () => {
    const out = serveHeadersFor('text/html', key('jpg'), 'a');
    expect(out.contentType).toBe('image/jpeg');
    expect(out.contentDisposition).toMatch(/^inline;/);
  });

  it.each(['text/html', 'application/javascript', 'image/svg+xml', 'application/xhtml+xml'])(
    'never echoes %s back to the browser',
    (hostile) => {
      const out = serveHeadersFor(hostile, key('webp'), 'a');
      expect(out.contentType).not.toBe(hostile);
      expect(SERVABLE_IMAGE_MIME).toContain(out.contentType as (typeof SERVABLE_IMAGE_MIME)[number]);
    }
  );

  it('downloads rather than renders when neither source is usable', () => {
    // A hand-inserted row, or a future ETL from the old blob store, whose key
    // carries no extension. Nothing renders and nothing navigates.
    for (const [mime, k] of [
      ['text/html', 'legacy-key-with-no-extension'],
      ['', ''],
      ['text/html', 'weird.exe'],
    ] as const) {
      const out = serveHeadersFor(mime, k, 'a');
      expect(out.contentType).toBe('application/octet-stream');
      expect(out.contentDisposition).toMatch(/^attachment;/);
    }
  });

  it('sanitises the id before putting it in a filename', () => {
    // Quotes, slashes and dots all go, so neither the quoted-string nor the path
    // can be broken out of. Real ids are cuids and survive untouched.
    const out = serveHeadersFor('image/jpeg', key('jpg'), 'a"b/../c');
    expect(out.contentDisposition).toBe('inline; filename="photo-abc.jpg"');
    expect(serveHeadersFor('image/jpeg', key('jpg'), 'cm1x2y3z0000abcd').contentDisposition).toBe(
      'inline; filename="photo-cm1x2y3z0000abcd.jpg"'
    );
  });

  it('ignores a query string on the key', () => {
    expect(serveHeadersFor('text/html', `${key('png')}?x=1`, 'a').contentType).toBe('image/png');
  });
});

describe('the serving route actually uses it', () => {
  const src = readFileSync(ROUTE, 'utf8');

  it('imports serveHeadersFor', () => {
    // A correct helper nothing calls is the state this defect was already in.
    expect(src).toMatch(/serveHeadersFor/);
    expect(src).toMatch(/from '@\/lib\/photo-mime'/);
  });

  it('never uses the stored mimeType as a response Content-Type', () => {
    // The assertion that fails against the pre-fix route, which read
    // `'Content-Type': att.mimeType`.
    expect(src).not.toMatch(/'Content-Type':\s*att\.mimeType/);
  });

  it('does not export the helper from the route file', () => {
    // Next type-checks a route file's export surface against an allowed list, and
    // an extra export is a BUILD-TIME error — which in this repo surfaces AFTER
    // `prisma migrate deploy` has already run against production.
    expect(src).not.toMatch(/export\s+(function|const)\s+serveHeadersFor/);
  });
});

describe('the guarantee the pin leans on', () => {
  it('nosniff is still set globally', () => {
    // HTML bytes under an explicit `image/jpeg` are inert — unless the browser is
    // allowed to sniff. Nothing else in the tree asserts this header.
    const cfg = readFileSync('next.config.ts', 'utf8');
    expect(cfg).toMatch(/X-Content-Type-Options/);
    expect(cfg).toMatch(/nosniff/);
  });
});
