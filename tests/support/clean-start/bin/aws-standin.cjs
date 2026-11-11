/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS, run by node directly from the bash wrapper beside it */
// Local stand-in for aws-cli, for the clean-start tests only: S3 against a
// FOLDER. Each bucket is a directory under FAKE_S3_ROOT; metadata sits beside
// it under FAKE_S3_ROOT/.meta. Every call is appended to FAKE_S3_LOG (one JSON
// line: the command, bucket, key and WHICH access key id made it — never a
// secret). Access keys listed in FAKE_S3_READONLY_KEYS may only read; a write
// with one fails as R2 would (AccessDenied). Prints what aws prints on stdout
// (e.g. "upload: …"), so a script that forgets to silence it is caught.
// Supports exactly what scripts/ops/clean-start uses:
//   s3 cp <src> <dst> [--content-type T] [--metadata k=v] [--checksum-algorithm X]
//   s3api list-objects-v2 --bucket B --prefix P --query 'Contents[].Key' --output text
//   s3api head-object --bucket B --key K
//   s3api delete-object --bucket B --key K
//   s3api delete-objects --bucket B --delete file://F
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.FAKE_S3_ROOT;
if (!ROOT) { process.stderr.write('aws stand-in: FAKE_S3_ROOT is not set\n'); process.exit(255); }
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const key = process.env.AWS_ACCESS_KEY_ID || '';
const readOnly = (process.env.FAKE_S3_READONLY_KEYS || '').split(',').filter(Boolean).includes(key);
const log = (entry) => {
  if (process.env.FAKE_S3_LOG) fs.appendFileSync(process.env.FAKE_S3_LOG, JSON.stringify({ ...entry, accessKeyId: key }) + '\n');
};
const objPath = (bucket, k) => {
  if (!bucket || !k || k.includes('..') || path.isAbsolute(k)) throw new Error('bad key');
  return path.join(ROOT, bucket, ...k.split('/'));
};
const metaPath = (bucket, k) => path.join(ROOT, '.meta', bucket, ...k.split('/')) + '.json';
const denied = (what) => { process.stderr.write(`An error occurred (AccessDenied) when calling the ${what} operation: Access Denied\n`); process.exit(1); };
const notFound = () => { process.stderr.write('An error occurred (404) when calling the HeadObject operation: Not Found\n'); process.exit(254); };
const s3url = (u) => { const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(u || ''); return m ? { bucket: m[1], key: m[2] } : null; };
if (process.env.FAKE_S3_FAIL_ALL === '1') { process.stderr.write('Could not connect to the endpoint URL\n'); process.exit(255); }
if (!opt('--endpoint-url')) { process.stderr.write('aws stand-in: every call must name --endpoint-url (R2)\n'); process.exit(255); }

const listAll = (dir, base = '') =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? listAll(path.join(dir, d.name), base + d.name + '/') : [base + d.name])
    : [];

const [svc, cmd] = argv;
if (svc === 's3' && cmd === 'cp') {
  const src = argv[2];
  const dst = argv[3];
  const from = s3url(src);
  const to = s3url(dst);
  if (from && !to) {
    const p = objPath(from.bucket, from.key);
    log({ op: 'get', bucket: from.bucket, key: from.key });
    if (!fs.existsSync(p)) { process.stderr.write('fatal error: An error occurred (404) when calling the HeadObject operation: Key "x" does not exist\n'); process.exit(1); }
    fs.copyFileSync(p, dst);
    process.stdout.write(`download: ${src} to ${dst}\n`);
  } else if (!from && to) {
    if (readOnly) denied('PutObject');
    const p = objPath(to.bucket, to.key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(src, p);
    const meta = {};
    const m = opt('--metadata');
    if (m) for (const kv of m.split(',')) { const [k, v] = kv.split('='); meta[k] = v; }
    fs.mkdirSync(path.dirname(metaPath(to.bucket, to.key)), { recursive: true });
    fs.writeFileSync(metaPath(to.bucket, to.key), JSON.stringify({ metadata: meta, contentType: opt('--content-type') || null }));
    log({ op: 'put', bucket: to.bucket, key: to.key, metadata: meta });
    process.stdout.write(`upload: ${src} to ${dst}\n`);
  } else { process.stderr.write('aws stand-in: cp needs one s3:// side\n'); process.exit(255); }
  process.exit(0);
}
if (svc === 's3api') {
  const bucket = opt('--bucket');
  if (cmd === 'list-objects-v2') {
    if (opt('--query') !== 'Contents[].Key' || opt('--output') !== 'text') { process.stderr.write('aws stand-in: only --query Contents[].Key --output text\n'); process.exit(255); }
    const prefix = opt('--prefix') || '';
    const keys = listAll(path.join(ROOT, bucket)).filter((k) => k.startsWith(prefix)).sort();
    log({ op: 'list', bucket, prefix });
    process.stdout.write((keys.length ? keys.join('\t') : 'None') + '\n');
    process.exit(0);
  }
  if (cmd === 'head-object') {
    const k = opt('--key');
    log({ op: 'head', bucket, key: k });
    // FAKE_S3_HEAD_FORBIDDEN=<substring>: a HEAD of a key containing it answers 403 (a
    // failure that is NOT "not found"), for the tests of the fail-closed "is it gone" checks.
    const forbid = process.env.FAKE_S3_HEAD_FORBIDDEN;
    if (forbid && k && k.includes(forbid)) {
      process.stderr.write('An error occurred (403) when calling the HeadObject operation: Forbidden\n');
      process.exit(254);
    }
    const p = objPath(bucket, k);
    if (!fs.existsSync(p)) notFound();
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath(bucket, k), 'utf8')).metadata; } catch { /* none */ }
    process.stdout.write(JSON.stringify({ ContentLength: fs.statSync(p).size, Metadata: meta }) + '\n');
    process.exit(0);
  }
  if (cmd === 'delete-object') {
    if (readOnly) denied('DeleteObject');
    const k = opt('--key');
    log({ op: 'delete', bucket, key: k });
    fs.rmSync(objPath(bucket, k), { force: true });
    fs.rmSync(metaPath(bucket, k), { force: true });
    process.stdout.write('\n');
    process.exit(0);
  }
  if (cmd === 'delete-objects') {
    if (readOnly) denied('DeleteObjects');
    const spec = opt('--delete') || '';
    if (!spec.startsWith('file://')) { process.stderr.write('aws stand-in: --delete file://… only\n'); process.exit(255); }
    const body = JSON.parse(fs.readFileSync(spec.slice(7), 'utf8'));
    if (!Array.isArray(body.Objects) || body.Objects.length > 1000) { process.stderr.write('MalformedXML: at most 1000 keys\n'); process.exit(254); }
    for (const o of body.Objects) {
      log({ op: 'delete', bucket, key: o.Key, batch: body.Objects.length });
      fs.rmSync(objPath(bucket, o.Key), { force: true });
      fs.rmSync(metaPath(bucket, o.Key), { force: true });
    }
    process.stdout.write(body.Quiet ? '{}\n' : JSON.stringify({ Deleted: body.Objects }) + '\n');
    process.exit(0);
  }
}
process.stderr.write(`aws stand-in: unsupported: ${svc} ${cmd}\n`);
process.exit(255);
