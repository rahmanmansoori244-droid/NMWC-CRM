// Print which deployment the live production alias is serving (read from /login), so
// deploy-watch.sh can tell a new deploy from the old one after an owner-approved merge.
// Owner/Claude production diagnostic only (docs/HANDOVER.md §5), not for Codex.
// The owner merges in GitHub; Codex checks GitHub CI results as described in §2.
//
//   node scripts/dev/build-id.cjs [url]            the deployment's identity
//   node scripts/dev/build-id.cjs --commit [url]   the commit its client code was built from
//
// The identity is Vercel's deployment ID (dpl_…). Next 16 writes it on the page's
// <html data-dpl-id="…">; a Next 15 page carries it on its asset URLs (?dpl=…). Every
// deployment has its own, a redeploy and an Instant Rollback included. Next 16 pages no
// longer carry the Next build ID this script used to read (the "b" field of the RSC
// payload, 2026-11-22), so a page with no deployment ID at all falls back to that build
// ID, and a page showing two different deployment IDs is refused rather than guessed.
//
// The commit is the Sentry release: next.config.ts inlines VERCEL_GIT_COMMIT_SHA into the
// client bundle as NEXT_PUBLIC_SENTRY_RELEASE, so one of the page's scripts holds
// release:"<40 hex>". It costs a few hundred KB, so deploy-watch.sh reads it once, after
// the deployment ID has changed. CI's post-deploy smoke reads the commit from /api/health
// with the monitor bearer; this needs no credential.
//
// On success: the value alone on stdout, exit 0. On any failure: nothing on stdout, the
// reason on stderr, exit 1 — so a network error can never read as a new deployment.
'use strict';

const DEFAULT_URL = 'https://nmwc-cm.vercel.app/login';
const BUILD_ID = /^[A-Za-z0-9_-]{10,}$/;

/** The deployment a page belongs to: { value } or { reason }. */
function deploymentIdentity(html) {
  const ids = new Set([...String(html).matchAll(/\bdpl_[A-Za-z0-9]{10,}\b/g)].map((m) => m[0]));
  if (ids.size === 1) return { value: [...ids][0] };
  if (ids.size > 1) return { reason: `the page names ${ids.size} different deployment IDs` };
  const b = String(html).match(/\\"b\\":\\"([^"\\]+)\\"/) || String(html).match(/"buildId":"([^"]+)"/);
  if (b && BUILD_ID.test(b[1])) return { value: b[1] };
  return { reason: 'no deployment ID or build ID found on the page' };
}

/** The page's own scripts, in page order, each once. */
function scriptSources(html) {
  return [...new Set([...String(html).matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]))];
}

/** The commit a script was built from (its inlined Sentry release), or null. */
function commitFromScript(js) {
  const found = new Set([...String(js).matchAll(/\brelease:\s*"([0-9a-f]{40})"/g)].map((m) => m[1]));
  return found.size === 1 ? [...found][0] : null;
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).pathname}`);
  return res.text();
}

async function main(argv) {
  const wantCommit = argv.includes('--commit');
  const url = argv.find((a) => /^https?:\/\//.test(a)) || DEFAULT_URL;
  const html = await fetchText(url);
  if (!wantCommit) {
    const id = deploymentIdentity(html);
    if (!id.value) throw new Error(id.reason);
    return id.value;
  }
  for (const src of scriptSources(html)) {
    const commit = commitFromScript(await fetchText(new URL(src, url)));
    if (commit) return commit;
  }
  throw new Error('no commit found in the page’s scripts');
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((value) => console.log(value))
    .catch((e) => {
      console.error(`build-id: ${e.message}`);
      process.exitCode = 1;
    });
}

module.exports = { deploymentIdentity, scriptSources, commitFromScript };
