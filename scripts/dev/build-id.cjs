// Print the Next build ID the live production alias is serving (read from /login).
// Owner/Claude production diagnostic only (docs/HANDOVER.md §5), not for Codex.
// deploy-watch.sh can wait for this ID to change after an owner-approved deployment.
// The owner merges in GitHub; Codex checks GitHub CI results as described in §2.
//   node scripts/dev/build-id.cjs [url]
// On success: the ID alone on stdout, exit 0. On any failure: nothing on stdout, the
// reason on stderr, exit 1 — so a network error can never read as a new build.
const url = process.argv[2] || 'https://nmwc-cm.vercel.app/login';
fetch(url, { redirect: 'follow' })
  .then((r) => r.text())
  .then((html) => {
    const m = html.match(/\\"b\\":\\"([^"\\]+)\\"/) || html.match(/"buildId":"([^"]+)"/);
    if (m && /^[A-Za-z0-9_-]{10,}$/.test(m[1])) {
      console.log(m[1]);
    } else {
      console.error('no build ID found on the page');
      process.exitCode = 1;
    }
  })
  .catch((e) => {
    console.error(`fetch failed: ${e.message}`);
    process.exitCode = 1;
  });
