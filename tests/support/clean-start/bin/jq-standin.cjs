/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS, run by node directly from the bash wrapper beside it */
// Local stand-in for jq, for the clean-start tests only (jq is not installed on
// every developer machine; GitHub's runners have the real one). It knows ONLY the
// programs scripts/ops/clean-start/*.sh run, each implemented here by hand, and
// refuses any other program, so a new jq use cannot pass a test silently.
// Supports: -r, -j, --arg NAME VALUE, one input file (or stdin).
'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
let raw = false;
let join = false;
const named = {};
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-r') raw = true;
  else if (a === '-j') { raw = true; join = true; }
  else if (a === '--arg') { named[args[i + 1]] = args[i + 2]; i += 2; }
  else rest.push(a);
}
const prog = (rest[0] || '').replace(/\s+/g, ' ').trim();
const file = rest[1];
let input;
try {
  input = JSON.parse(fs.readFileSync(file || 0, 'utf8'));
} catch {
  process.stderr.write('jq stand-in: input is not JSON\n');
  process.exit(5);
}
const arr = (v) => (Array.isArray(v) ? v : []);
const empty = Symbol('empty');
const alt = (v, d) => (v === undefined || v === null || v === false ? d : v);

const PROGRAMS = {
  '.commit // empty': (j) => [alt(j?.commit, empty)],
  '[.protection_rules[]? | select(.type == "required_reviewers") | (.reviewers // []) | length] | add // 0': (j) => {
    const xs = arr(j?.protection_rules).filter((r) => r?.type === 'required_reviewers').map((r) => arr(alt(r.reviewers, [])).length);
    return [xs.length ? xs.reduce((a, b) => a + b, 0) : 0];
  },
  '.total_count // 0': (j) => [alt(j?.total_count, 0)],
  '[.jobs[]? | select(.name == "Neon rehearsal" and .conclusion == "success")] | length': (j) => [
    arr(j?.jobs).filter((x) => x?.name === 'Neon rehearsal' && x?.conclusion === 'success').length,
  ],
  '.[]? | select(.name == "clean-start" and .type == "dir") | .sha': (j) =>
    arr(j).filter((x) => x?.name === 'clean-start' && x?.type === 'dir').map((x) => x.sha),
  '.[]? | select(.name == "clean-start.yml" and .type == "file") | .sha': (j) =>
    arr(j).filter((x) => x?.name === 'clean-start.yml' && x?.type === 'file').map((x) => x.sha),
  '.workflow_runs[]? | select(.display_title == "Clean start neon-rehearsal") | "\\(.id) \\(.head_sha) \\(.head_branch)"': (j) =>
    arr(j?.workflow_runs)
      .filter((x) => x?.display_title === 'Clean start neon-rehearsal')
      .map((x) => `${x.id} ${x.head_sha} ${x.head_branch ?? 'null'}`),
  '.project.history_retention_seconds // 0': (j) => [alt(j?.project?.history_retention_seconds, 0)],
  '.branches[]? | select(.default == true) | .id': (j) => arr(j?.branches).filter((b) => b?.default === true).map((b) => b.id),
  '.branch.id // empty': (j) => [alt(j?.branch?.id, empty)],
  '.databases[0].name // empty': (j) => [alt(arr(j?.databases)[0]?.name, empty)],
  '.databases[0].owner_name // empty': (j) => [alt(arr(j?.databases)[0]?.owner_name, empty)],
  '[.branches[]? | select(.name == $n)] | length': (j) => [arr(j?.branches).filter((b) => b?.name === named.n).length],
  '[.branches[]? | select(.name == $n and .parent_id == $p)] | length': (j) => [
    arr(j?.branches).filter((b) => b?.name === named.n && b?.parent_id === named.p).length,
  ],
  '.endpoints[]? | .host // empty': (j) => arr(j?.endpoints).map((e) => alt(e?.host, empty)),
  '.branches[]? | select(.name == $n) | .id':(j) => arr(j?.branches).filter((b) => b?.name === named.n).map((b) => b.id),
  '.branches[]? | .name': (j) => arr(j?.branches).map((b) => b?.name),
  '.uri // empty': (j) => [alt(j?.uri, empty)],
  '[.operations[]? | select($b == "" or .branch_id == $b) | select(.status != "finished" and .status != "skipped" and .status != "cancelled" and .status != "failed")] | length': (j) => [
    arr(j?.operations)
      .filter((o) => named.b === '' || o?.branch_id === named.b)
      .filter((o) => !['finished', 'skipped', 'cancelled', 'failed'].includes(o?.status)).length,
  ],
  '[.operations[]? | select($b != "" and .branch_id == $b and .status == "failed")] | length': (j) => [
    arr(j?.operations).filter((o) => named.b !== '' && o?.branch_id === named.b && o?.status === 'failed').length,
  ],
  '.seq': (j) => [j?.seq],
  '.hash': (j) => [j?.hash],
  '.r2Key': (j) => [j?.r2Key],
  '.bodyText': (j) => [j?.bodyText],
  '.prev // "null"': (j) => [alt(j?.prev, 'null')],
};

const fn = PROGRAMS[prog];
if (!fn) {
  process.stderr.write(`jq stand-in: unknown program: ${prog}\n`);
  process.exit(3);
}
let out = '';
for (const v of fn(input)) {
  if (v === empty) continue;
  const s = raw && typeof v === 'string' ? v : v === undefined ? 'null' : JSON.stringify(v);
  out += join ? s : `${s}\n`;
}
process.stdout.write(out);
