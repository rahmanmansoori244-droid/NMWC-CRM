/**
 * Which launch runs are alive on this machine: a heartbeat file per run,
 * .e2e-launch/runs/<runId>.alive, written by the Playwright runner (the config
 * calls holdRunLock() there) and refreshed every 30 s until the runner exits.
 *
 * A run is live while its file is fresh. A process id alone cannot say that:
 * Windows reuses ids within minutes, so a crashed run's dirty worlds could be
 * skipped for hours because an unrelated process got its id. A run that
 * crashes stops refreshing, and its worlds are sweepable three minutes later.
 *
 * Pure (fs, os, path) — playwright.launch.config.ts imports it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_DIR } from './base';

export const RUNS_DIR = path.join(STATE_DIR, 'runs');
const BEAT_MS = 30_000;
/** Older than this, the heartbeat is a dead run's. */
export const STALE_MS = 3 * 60_000;

const HELD = Symbol.for('nmwc.e2e.runLock');

export function runLockFile(runId: string): string {
  if (!/^[a-z0-9]{1,20}$/.test(runId)) throw new Error(`run id "${runId}" is not a launch run id`);
  return path.join(RUNS_DIR, `${runId}.alive`);
}

/** Writes the run's heartbeat now and every 30 s; removes it when this process exits. Idempotent. */
export function holdRunLock(runId: string): void {
  const g = globalThis as unknown as Record<symbol, string | undefined>;
  if (g[HELD] === runId) return;
  g[HELD] = runId;
  const file = runLockFile(runId);
  const startedAt = new Date().toISOString();
  const beat = () => {
    try {
      fs.mkdirSync(RUNS_DIR, { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ runId, pid: process.pid, host: os.hostname(), startedAt, beatAt: new Date().toISOString() })
      );
    } catch {
      /* a missed beat only makes the run look older */
    }
  };
  beat();
  setInterval(beat, BEAT_MS).unref();
  process.on('exit', () => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  });
}

/** True while the run's heartbeat file is fresher than STALE_MS. */
export function runIsLive(runId: string, now = Date.now()): boolean {
  try {
    return now - fs.statSync(runLockFile(runId)).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}

/** Removes heartbeat files of runs that are over (best effort). */
export function pruneRunLocks(now = Date.now()): void {
  if (!fs.existsSync(RUNS_DIR)) return;
  for (const f of fs.readdirSync(RUNS_DIR)) {
    const p = path.join(RUNS_DIR, f);
    try {
      if (now - fs.statSync(p).mtimeMs > 24 * 3_600_000) fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}
