/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS script run with plain node */
// Check that no known password literal appears in the documents this public repository
// hands to outside readers. Prints only whether one does — never a value.
//   node scripts/dev/leak-check.cjs [file ...]
// Default files: AUDITOR-BRIEF.md, AGENTS.md, docs/HANDOVER.md and docs/design/**.
// Exit 1 on a leak; exit 2 when a source it reads the literals from yields nothing (the
// check would otherwise pass while comparing against nothing — update the list below).
// Run it before committing any of those files. It works from any directory.
const fs = require('fs');
const path = require('path');

// File arguments are taken relative to where it was started; then work from the repo root.
const args = process.argv.slice(2).map((f) => path.resolve(f));
process.chdir(path.join(__dirname, '..', '..'));

const listDir = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const p = path.join(dir, d.name);
        return d.isDirectory() ? listDir(p) : [p];
      })
    : [];
const targets = args.length
  ? args
  : ['AUDITOR-BRIEF.md', 'AGENTS.md', 'docs/HANDOVER.md', ...listDir('docs/design')].filter((f) =>
      fs.existsSync(f)
    );

// Where known password literals live in this repository (the shared initial password,
// seed and synthetic passwords, the May pilot passwords). Each source must yield at least
// one value.
const SOURCES = [
  ['scripts/golive/build-masters.ts', /INITIAL_PASSWORD\s*=\s*['"`]([^'"`]+)['"`]/g],
  ['prisma/seed.ts', /SEED_ADMIN_PASSWORD\s*\?\?\s*['"`]([^'"`]+)['"`]/g],
  ['prisma/synthetic.ts', /SEED_ADMIN_PASSWORD\s*\?\?\s*['"`]([^'"`]+)['"`]/g],
  ['prisma/synthetic.ts', /bcrypt\.hash\(\s*['"`]([^'"`]+)['"`]/g],
  ['prisma/seed-muscat-pilot.ts', /bcrypt\.hash\(\s*['"`]([^'"`]+)['"`]/g],
  ['scripts/capture-guide-screenshots.ts', /password\s*:\s*['"`]([^'"`]+)['"`]/g],
  ['scripts/synthetic-launch-test.ts', /password\s*:\s*['"`]([^'"`]+)['"`]/g],
  ['tests/loadtest.mjs', /PWD\s*=\s*[^'"`\n]*['"`]([^'"`]+)['"`]/g],
];
const found = [];
let dead = 0;
for (const [file, re] of SOURCES) {
  const values = fs.existsSync(file)
    ? [...fs.readFileSync(file, 'utf8').matchAll(re)].map((m) => m[1]).filter((v) => v.length >= 4)
    : [];
  if (values.length === 0) {
    dead++;
    console.log(`the pattern for ${file} extracts nothing — refusing (update scripts/dev/leak-check.cjs)`);
  }
  for (const value of values) found.push({ file, value });
}
if (dead) process.exit(2);
const literals = [...new Map(found.map((f) => [f.value, f])).values()];
console.log(`password literals known: ${literals.length}; files checked: ${targets.length}`);

let leaks = 0;
for (const t of targets) {
  const text = fs.readFileSync(t, 'utf8');
  for (const l of literals) {
    // Whole-token match: a short literal must not match inside a longer number or word.
    const esc = l.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`).test(text)) {
      leaks++;
      console.log(`LEAK: a literal from ${l.file} appears in ${path.relative(process.cwd(), t)}`);
    }
  }
}
console.log(leaks ? `${leaks} leak(s)` : 'no known password literal appears in these files');
process.exitCode = leaks ? 1 : 0;
