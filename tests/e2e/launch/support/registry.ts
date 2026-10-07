/**
 * The crash registry: one JSON file per world under .e2e-launch/registry/<runId>/.
 *
 * Every id, username and code a world creates is written here BEFORE the row is
 * inserted (ids are minted client-side), so a worker killed half-way leaves a
 * file that names everything it may have written. world.cleanup() and the
 * sweep read the file, delete, and mark it clean. The directory is outside every
 * Playwright outputDir, so the next run cannot wipe it before it is swept.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REGISTRY_DIR } from './env';

export const REGISTRY_LISTS = [
  'ymds',
  'userIds',
  'usernames',
  'regionIds',
  'regionCodes',
  'routeIds',
  'routeCodes',
  'customerIds',
  'branchIds',
  'editIds',
  'attachmentIds',
  'notificationIds',
  'importBatchIds',
  'temixBatchIds',
  'r2Keys',
  'ips',
] as const;
export type RegistryList = (typeof REGISTRY_LISTS)[number];

export type RegistryData = {
  v: 1;
  runId: string;
  name: string;
  /** Lower-case suffix every typed value of this world carries. */
  sfx: string;
  tag: string;
  host: string;
  runnerPid: number;
  workerPid: number;
  createdAt: string;
  updatedAt: string;
  clean: boolean;
  cleanedAt?: string;
  leftovers?: Record<string, number>;
  lastError?: string;
  /** Every cleanup pass, newest last (at most 20): who ran it and what it left. */
  attempts?: CleanupAttempt[];
} & Record<RegistryList, string[]>;

export type CleanupAttempt = { at: string; pid: number; clean: boolean; leftovers?: Record<string, number>; error?: string };

const MAX_ATTEMPTS_KEPT = 20;

function atomicWrite(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

export class Registry {
  private constructor(
    readonly file: string,
    readonly data: RegistryData
  ) {}

  static create(o: { runId: string; name: string; sfx: string; tag: string }): Registry {
    const file = path.join(REGISTRY_DIR, o.runId || 'no-run', `${o.name}.json`);
    if (fs.existsSync(file)) throw new Error(`registry ${file} already exists — the world name must be unique`);
    const now = new Date().toISOString();
    const data = {
      v: 1,
      runId: o.runId,
      name: o.name,
      sfx: o.sfx,
      tag: o.tag,
      host: os.hostname(),
      runnerPid: Number(process.env.E2E_RUNNER_PID ?? process.pid),
      workerPid: process.pid,
      createdAt: now,
      updatedAt: now,
      clean: false,
      ...Object.fromEntries(REGISTRY_LISTS.map((k) => [k, [] as string[]])),
    } as RegistryData;
    const r = new Registry(file, data);
    r.save();
    return r;
  }

  static load(file: string): Registry {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RegistryData>;
    for (const k of REGISTRY_LISTS) if (!Array.isArray(raw[k])) raw[k] = [];
    return new Registry(file, raw as RegistryData);
  }

  /** Records values (deduplicated) and persists at once. */
  add(list: RegistryList, ...values: Array<string | null | undefined>): void {
    const set = new Set(this.data[list]);
    let changed = false;
    for (const v of values) {
      if (v && !set.has(v)) {
        set.add(v);
        changed = true;
      }
    }
    if (!changed) return;
    this.data[list] = [...set];
    this.save();
  }

  /** Records one cleanup pass in the file's history (kept after the world is clean, for forensics). */
  private record(a: Omit<CleanupAttempt, 'at' | 'pid'>): void {
    const list = [...(this.data.attempts ?? []), { at: new Date().toISOString(), pid: process.pid, ...a }];
    this.data.attempts = list.slice(-MAX_ATTEMPTS_KEPT);
  }

  markClean(leftovers: Record<string, number>): void {
    this.record({ clean: true });
    this.data.clean = true;
    this.data.cleanedAt = new Date().toISOString();
    this.data.leftovers = leftovers;
    delete this.data.lastError;
    this.save();
  }

  markDirty(leftovers: Record<string, number> | undefined, error?: string): void {
    const nonZero = leftovers ? Object.fromEntries(Object.entries(leftovers).filter(([, n]) => n !== 0)) : undefined;
    this.record({ clean: false, leftovers: nonZero, error });
    this.data.clean = false;
    if (leftovers) this.data.leftovers = leftovers;
    if (error) this.data.lastError = error;
    this.save();
  }

  save(): void {
    this.data.updatedAt = new Date().toISOString();
    atomicWrite(this.file, this.data);
  }
}

/** Every registry file on this machine, oldest first. */
export function listRegistryFiles(): string[] {
  if (!fs.existsSync(REGISTRY_DIR)) return [];
  const files: string[] = [];
  for (const run of fs.readdirSync(REGISTRY_DIR)) {
    const dir = path.join(REGISTRY_DIR, run);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) files.push(path.join(dir, f));
  }
  return files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A registry may be swept by someone else only when its run is over. */
export function ownedByLiveRun(r: RegistryData, currentRunId: string): boolean {
  if (r.runId === currentRunId) return false;
  if (r.host !== os.hostname()) return true; // never sweep another machine's run
  const ageH = (Date.now() - Date.parse(r.createdAt)) / 3_600_000;
  if (ageH > 6) return false; // longer than any run (globalTimeout 3 h)
  return pidAlive(r.runnerPid);
}

/** Removes clean registry files older than `days`, and empty run folders. */
export function pruneCleanRegistries(days = 7): void {
  for (const f of listRegistryFiles()) {
    try {
      const r = Registry.load(f).data;
      if (r.clean && Date.now() - Date.parse(r.cleanedAt ?? r.updatedAt) > days * 86_400_000) fs.rmSync(f);
    } catch {
      /* unreadable: keep it for a person to look at */
    }
  }
  if (!fs.existsSync(REGISTRY_DIR)) return;
  for (const run of fs.readdirSync(REGISTRY_DIR)) {
    const dir = path.join(REGISTRY_DIR, run);
    try {
      if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  }
}
