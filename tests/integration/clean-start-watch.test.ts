// @vitest-environment node
/**
 * Go-live clean start: the RUNNER of the watch rehearsal (design section 3
 * step 5; scripts/ops/clean-start/rehearse-watch.ts holds the logic and says
 * why the runner is a gated suite, as tests/integration/golive-rehearsal.test.ts
 * is). It runs the real nightly integrity watch twice on a database that
 * reset.sql has JUST reset, and fails unless every status is the expected one.
 *
 * NOT part of the db-tests job: its database is never a reset one. The
 * clean-start workflow runs it after reset.sql and verify.sql:
 *
 *   RUN_CLEAN_START_WATCH=1 DATABASE_URL=<the reset copy> DIRECT_URL=<the same> \
 *     [CLEAN_START_FOREIGN_KEYS=<file: one key under seals/ per line, from PLAN>] \
 *     [CLEAN_START_WATCH_OUT=<file for the status table as JSON>] \
 *     npx vitest run tests/integration/clean-start-watch.test.ts
 *
 * Never production: both connection strings are checked with the shared guard
 * (rehearsalTarget: no production marker anywhere, whatever the command line).
 * It prints check ids, statuses and one yes/no line; never a count.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  rehearsalTarget,
  rehearseWatch,
  reportJson,
  reportLines,
} from '../../scripts/ops/clean-start/rehearse-watch';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

const ENABLED =
  process.env.RUN_CLEAN_START_WATCH === '1' &&
  !!(process.env.DIRECT_URL ?? process.env.DATABASE_URL);

describe.skipIf(!ENABLED)(
  'clean start: the first two nights of the integrity watch on the reset database',
  () => {
    let db: PrismaClient;

    beforeAll(() => {
      // Both: lib/db (reached through lib/integrity/run.ts) reads DATABASE_URL by itself.
      const url = rehearsalTarget(process.env.DIRECT_URL ?? process.env.DATABASE_URL);
      if (process.env.DATABASE_URL !== undefined) rehearsalTarget(process.env.DATABASE_URL);
      db = new PrismaClient({ datasourceUrl: url });
    });

    afterAll(async () => {
      await db?.$disconnect();
    });

    it('every check has the status the design expects, on the reset day and the next morning', async () => {
      const { runIntegrityWatch } = await import('@/lib/integrity/run');
      const keysFile = process.env.CLEAN_START_FOREIGN_KEYS;
      const foreignKeys = keysFile
        ? readFileSync(keysFile, 'utf8')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const r = await rehearseWatch(db, runIntegrityWatch, { foreignKeys });
      for (const line of reportLines(r)) console.log(line);
      if (process.env.CLEAN_START_WATCH_OUT)
        writeFileSync(process.env.CLEAN_START_WATCH_OUT, reportJson(r));
      expect(r.mismatches).toEqual([]);
    });
  }
);
