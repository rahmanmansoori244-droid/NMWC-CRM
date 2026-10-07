/**
 * The secret scan: no report, error context, trace or server log of a launch
 * run may hold a fixture password, a session token, a presigned R2 URL or the
 * value of a secret environment variable.
 *
 * Pure (fs, zlib, path): the reporter (secret-scan-reporter.ts) runs it in the
 * Playwright runner after the HTML report is written, and the sweep CLI runs it
 * read-only with --scan.
 *
 * The fixture passwords live only in the workers' memory, so the scan looks for
 * their SHAPE (world.ts generates every run password in it and checks that it
 * does). Session tokens and presigned URLs are found by shape too; env secrets
 * by value. Zip files (traces, the report's data) are opened, and the HTML
 * report's embedded base64 zip is decoded, so nothing hides in a compressed
 * entry. Hits name the file and the kind of secret — never the value.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO_ROOT, STATE_DIR } from './base';

/** Every run password matches this (world.ts asserts it when it makes one). */
export const FIXTURE_PASSWORD_SHAPE = /E2e-[A-Za-z0-9_-]{16}-9a/;

const SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ['fixture password', new RegExp(FIXTURE_PASSWORD_SHAPE.source, 'g')],
  // Auth.js session cookie: a JWE with alg "dir" / enc "A256CBC-HS512" — header..iv.ciphertext.tag
  ['session token', /eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2Q0JDLUhTNTEyIi[A-Za-z0-9_-]*\.\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  // A presigned R2 URL carries the access key id and a live signature.
  ['presigned R2 URL', /X-Amz-(?:Credential|Signature)(?:=|%3D)/gi],
];

/** Env values that must never be written anywhere (base.ts redacts the same ones from messages). */
const SECRET_ENV = [
  'AUTH_SECRET',
  'NEXTAUTH_SECRET',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'CRON_SECRET',
  'HEALTH_BEARER',
  'SEED_ADMIN_PASSWORD',
  'DATABASE_URL',
  'DIRECT_URL',
];

export type SecretHit = {
  /** The file on disk that holds it (a zip, the report's index.html, a log). */
  file: string;
  /** Where inside it: a zip entry, the report's embedded data. */
  entry?: string;
  /** Kind of secret → number of occurrences. Never the value. */
  kinds: Record<string, number>;
};

export type ScanResult = { files: number; entries: number; hits: SecretHit[]; unreadable: string[] };

function envNeedles(): Array<readonly [string, Buffer]> {
  const out: Array<readonly [string, Buffer]> = [];
  const seen = new Set<string>();
  const push = (label: string, v: string | undefined) => {
    if (!v || v.length < 8 || seen.has(v)) return;
    seen.add(v);
    out.push([label, Buffer.from(v, 'utf8')]);
  };
  for (const k of SECRET_ENV) {
    const v = process.env[k];
    push(`env ${k}`, v);
    if (v && /^postgres(ql)?:\/\//.test(v)) {
      try {
        const u = new URL(v);
        push(`${k} password`, decodeURIComponent(u.password));
        push(`${k} host`, u.hostname);
      } catch {
        /* not a URL */
      }
    }
  }
  return out;
}

function count(buf: Buffer, needle: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + needle.length)) n++;
  return n;
}

function scanBuffer(buf: Buffer, needles: ReadonlyArray<readonly [string, Buffer]>): Record<string, number> {
  const kinds: Record<string, number> = {};
  // latin1 maps every byte to one character, so the ASCII shapes match inside UTF-8 too.
  const text = buf.toString('latin1');
  for (const [label, re] of SHAPES) {
    const n = text.match(re)?.length ?? 0;
    if (n) kinds[label] = n;
  }
  for (const [label, needle] of needles) {
    const n = count(buf, needle);
    if (n) kinds[label] = (kinds[label] ?? 0) + n;
  }
  return kinds;
}

const isZip = (b: Buffer) => b.length >= 4 && b.readUInt32LE(0) === 0x04034b50;

/** The entries of a zip (stored or deflated), from its central directory. Throws on what it cannot read. */
export function zipEntries(buf: Buffer): Array<{ name: string; data: Buffer }> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || p === 0xffffffff) throw new Error('zip64 is not supported');
  const out: Array<{ name: string; data: Buffer }> = [];
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (size === 0xffffffff || local === 0xffffffff) throw new Error(`zip64 entry ${name}`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw) });
    else throw new Error(`zip method ${method} in ${name}`);
  }
  return out;
}

/** Scans a buffer and everything nested in it (zip entries, base64 zips in HTML). */
function scanNested(
  file: string,
  buf: Buffer,
  where: string | undefined,
  needles: ReadonlyArray<readonly [string, Buffer]>,
  res: ScanResult,
  depth = 0
): void {
  res.entries++;
  if (isZip(buf) && depth <= 3) {
    let entries: Array<{ name: string; data: Buffer }>;
    try {
      entries = zipEntries(buf);
    } catch (err) {
      // What cannot be opened cannot be shown clean: it counts as a hit.
      res.unreadable.push(`${file}${where ? ` › ${where}` : ''}: ${(err as Error).message}`);
      res.hits.push({ file, entry: where, kinds: { 'unscannable zip': 1 } });
      return;
    }
    for (const e of entries) scanNested(file, e.data, where ? `${where} › ${e.name}` : e.name, needles, res, depth + 1);
    return;
  }
  const kinds = scanBuffer(buf, needles);
  if (Object.keys(kinds).length) res.hits.push({ file, entry: where, kinds });
  if (depth > 3) return;
  // The HTML report inlines its data as a base64 zip.
  const text = buf.toString('latin1');
  const re = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    scanNested(file, Buffer.from(m[1]!, 'base64'), `${where ? `${where} › ` : ''}embedded zip`, needles, res, depth + 1);
  }
}

function filesUnder(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  const st = fs.statSync(p);
  if (!st.isDirectory()) return [p];
  const out: string[] = [];
  for (const e of fs.readdirSync(p)) out.push(...filesUnder(path.join(p, e)));
  return out;
}

/** Scans every file under `roots` (files or folders). Read-only. */
export function scanForSecrets(roots: string[]): ScanResult {
  const needles = envNeedles();
  const res: ScanResult = { files: 0, entries: 0, hits: [], unreadable: [] };
  for (const file of roots.flatMap(filesUnder)) {
    res.files++;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch (err) {
      res.unreadable.push(`${file}: ${(err as NodeJS.ErrnoException).code ?? 'unreadable'}`);
      continue;
    }
    scanNested(file, buf, undefined, needles, res);
  }
  return res;
}

/**
 * What a launch run writes: every playwright-report/launch-*, every
 * test-results/launch-* and the server logs in .e2e-launch/.
 */
export function launchArtifactRoots(): string[] {
  const roots: string[] = [];
  for (const base of ['playwright-report', 'test-results']) {
    const dir = path.join(REPO_ROOT, base);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir)) if (e.startsWith('launch-')) roots.push(path.join(dir, e));
  }
  if (fs.existsSync(STATE_DIR)) {
    for (const e of fs.readdirSync(STATE_DIR)) if (e.endsWith('.log')) roots.push(path.join(STATE_DIR, e));
  }
  return roots;
}

/** One line per hit: the file (relative), where inside, the kinds and counts. */
export function describeHit(h: SecretHit): string {
  const kinds = Object.entries(h.kinds)
    .map(([k, n]) => `${k} ×${n}`)
    .join(', ');
  return `${path.relative(REPO_ROOT, h.file)}${h.entry ? ` › ${h.entry}` : ''}: ${kinds}`;
}
