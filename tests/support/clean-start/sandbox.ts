/**
 * A throw-away copy of the clean-start shell scripts beside a production host
 * list of the TEST's own — the way tests/unit/production-hosts.test.ts tests
 * the shared reader. The shared guard has deliberately no switch that replaces
 * the list (scripts/lib/production-hosts.cjs), so a test that needs "this is
 * production" copies the scripts next to a list naming a host of its own. The
 * real list and the real scripts are never changed.
 *
 * Also: the stand-ins in tests/support/clean-start/bin first on PATH (aws, curl,
 * jq, age, psql, pg_dump, date), a folder per bucket, a state folder for the
 * GitHub and Neon stand-ins, and logs of every storage and HTTP call.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export const BIN = resolve('tests/support/clean-start/bin');

/** A PATH with the stand-ins first, built from the parent's PATH whatever its spelling (Windows: Path). */
export function standinPath(extra: string[] = []): string {
  const parent = Object.entries(process.env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  return [...extra, BIN, parent].join(delimiter);
}

/** process.env without any PATH spelling (so ours is the only one) and without RUN_* gates or database URLs. */
export type Env = NodeJS.ProcessEnv & Record<string, string>;

export function baseEnv(): Env {
  const env: Env = { NODE_ENV: 'test' } as Env;
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.toUpperCase() === 'PATH') continue;
    if (/^RUN_/.test(k) || /^(DATABASE_URL|DIRECT_URL|PGHOST|PGHOSTADDR)$/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export type Sandbox = {
  root: string;
  s3: string;
  state: string;
  csDir: string;
  logs: { s3: string; http: string };
  env: Env;
  run: (cmd: string, env?: Record<string, string>) => { code: number; out: string; lines: string[] };
  put: (bucket: string, key: string, body: string | Buffer) => void;
  has: (bucket: string, key: string) => boolean;
  read: (bucket: string, key: string) => Buffer;
  s3Calls: () => Array<Record<string, unknown>>;
  done: () => void;
};

const SCRIPTS = [
  'scripts/ops/production-hosts.sh',
  'scripts/ops/dump-rowcounts.awk',
  'scripts/ops/clean-start/run.sh',
  'scripts/ops/clean-start/seal-archive.sh',
  'scripts/ops/clean-start/photo-delete.sh',
  'scripts/ops/clean-start/target-guard.sh',
];

export function sandbox(productionMarker: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'nmwc-cs-sh-'));
  for (const f of SCRIPTS) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    cpSync(f, join(root, f));
  }
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'production-hosts.txt'), `# test list\n${productionMarker}\n`);
  const s3 = join(root, 's3');
  const state = join(root, 'state');
  const csDir = join(root, 'work');
  for (const d of [s3, state, csDir]) mkdirSync(d, { recursive: true });
  const logs = { s3: join(root, 's3.log'), http: join(root, 'http.log') };
  const env: Env = {
    ...baseEnv(),
    PATH: standinPath(),
    CS_DIR: csDir,
    FAKE_S3_ROOT: s3,
    FAKE_S3_LOG: logs.s3,
    FAKE_HTTP_LOG: logs.http,
    FAKE_STATE_DIR: state,
    AWS_DEFAULT_REGION: 'auto',
    BACKUP_R2_ACCOUNT_ID: 'acct-backups',
    BACKUP_R2_BUCKET: 'backups',
    BACKUP_R2_ACCESS_KEY_ID: 'bk-key',
    BACKUP_R2_SECRET_ACCESS_KEY: 'bk-secret-zq',
    PHOTOS_R2_ACCOUNT_ID: 'acct-photos',
    PHOTOS_BUCKET: 'photos',
    CLEANSTART_R2_RO_ACCESS_KEY_ID: 'ro-key',
    CLEANSTART_R2_RO_SECRET_ACCESS_KEY: 'ro-secret-zq',
    CLEANSTART_R2_RW_ACCESS_KEY_ID: 'rw-key',
    CLEANSTART_R2_RW_SECRET_ACCESS_KEY: 'rw-secret-zq',
    FAKE_S3_READONLY_KEYS: 'ro-key',
  };
  const run = (cmd: string, extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', ['-c', `${cmd} 2>&1`], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });
    const out = r.stdout ?? '';
    return { code: r.status ?? -1, out, lines: out.split(/\r?\n/).filter((l) => l !== '') };
  };
  const obj = (bucket: string, key: string) => join(s3, bucket, ...key.split('/'));
  return {
    root,
    s3,
    state,
    csDir,
    logs,
    env,
    run,
    put: (bucket, key, body) => {
      mkdirSync(join(obj(bucket, key), '..'), { recursive: true });
      writeFileSync(obj(bucket, key), body);
    },
    has: (bucket, key) => existsSync(obj(bucket, key)),
    read: (bucket, key) => readFileSync(obj(bucket, key)),
    s3Calls: () =>
      existsSync(logs.s3)
        ? readFileSync(logs.s3, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}
