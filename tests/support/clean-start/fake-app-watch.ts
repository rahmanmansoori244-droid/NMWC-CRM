/**
 * The clean-start end-to-end test's stand-in for production's
 * /api/cron/integrity-watch (called by the curl stand-in): the REAL
 * runIntegrityWatch, as the route runs it, on the test's "production" database,
 * with the seal store backed by the test's photo bucket FOLDER (so the old
 * chain, the foreign objects and the new genesis are the files the shell
 * scripts see). No alert leaves the machine.
 *
 *   FAKE_APP_DB_URL=… FAKE_S3_ROOT=… FAKE_PHOTOS_BUCKET=… node --import tsx tests/support/clean-start/fake-app-watch.ts
 *
 * Test-only, local only: it refuses any URL that is not on this machine.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { runIntegrityWatch } from '@/lib/integrity/run';

export function folderStore(bucketDir: string) {
  const path = (key: string) => join(bucketDir, ...key.split('/'));
  const walk = (d: string, base = ''): string[] =>
    existsSync(d)
      ? readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n), `${base}${n}/`) : [`${base}${n}`]))
      : [];
  return {
    async get(key: string) {
      return existsSync(path(key)) ? readFileSync(path(key), 'utf8') : null;
    },
    async put(key: string, body: string) {
      mkdirSync(dirname(path(key)), { recursive: true });
      writeFileSync(path(key), body);
    },
    async list(prefix: string) {
      return walk(bucketDir)
        .filter((k) => k.startsWith(prefix))
        .sort();
    },
  };
}

async function main() {
  const url = process.env.FAKE_APP_DB_URL ?? '';
  if (!/^postgresql:\/\/[^@]*@localhost:\d+\//.test(url)) throw new Error('fake app watch: a localhost URL only');
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    await runIntegrityWatch(db, {
      store: folderStore(join(process.env.FAKE_S3_ROOT ?? '', process.env.FAKE_PHOTOS_BUCKET ?? '')),
      inAppAlerts: false,
      alert: async () => true,
      audience: async () => [],
    });
  } finally {
    await db.$disconnect();
  }
}

if (/fake-app-watch\.ts$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
