// Print the Next build ID the live production alias is serving (read from /login).
// Used by the merge procedure (docs/HANDOVER.md §2): record it before the push, and
// deploy-watch.sh waits for it to change.
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
