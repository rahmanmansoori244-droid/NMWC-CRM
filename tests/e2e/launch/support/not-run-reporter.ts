/**
 * The "not run on UAT" summary (not-run.ts): every test skipped with
 * notRunHere() — a skip the environment forced, which would otherwise hide an
 * unverified fix behind a green run — with its project, file, title and reason.
 *
 * Written to test-results/launch-not-run.json, one entry per step (main,
 * exclusive, iphone), so step 2 keeps step 1's list; printed at the end of the
 * run. Under LAUNCH_FINAL=1 the summary is printed even when it is empty. A
 * `--list` run writes nothing. Listed before the secret scan, which stays last
 * (and scans this file too: it holds titles and reasons only).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { REPO_ROOT, hasR2 } from './env';
import { LAUNCH_FINAL, NOT_RUN_ON_UAT } from './not-run';

export const NOT_RUN_FILE = path.join(REPO_ROOT, 'test-results', 'launch-not-run.json');

type Row = { project: string; file: string; title: string; why: string };
type StepEntry = { runId: string; finishedAt: string; status: string; launchFinal: boolean; r2Configured: boolean; notRun: Row[] };

export default class NotRunReporter implements Reporter {
  private readonly rows: Row[] = [];

  printsToStdio(): boolean {
    return false;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== 'skipped') return;
    const note = [...(result.annotations ?? []), ...test.annotations].find(
      (a) => a.type === 'skip' && (a.description ?? '').startsWith(NOT_RUN_ON_UAT)
    );
    if (!note) return;
    this.rows.push({
      project: test.parent.project()?.name ?? '',
      file: path.relative(REPO_ROOT, test.location.file).replace(/\\/g, '/'),
      // ['', project, file, …describes, title]
      title: test.titlePath().slice(3).join(' › '),
      why: (note.description ?? '').slice(NOT_RUN_ON_UAT.length),
    });
  }

  onEnd(result: FullResult): void {
    if (process.argv.includes('--list')) return;
    const step = process.env.E2E_STEP ?? 'main';
    const rows = [...this.rows].sort((a, b) => `${a.file} ${a.title} ${a.project}`.localeCompare(`${b.file} ${b.title} ${b.project}`));
    const entry: StepEntry = {
      runId: process.env.E2E_RUN_ID ?? '',
      finishedAt: new Date().toISOString(),
      status: result.status,
      launchFinal: LAUNCH_FINAL,
      r2Configured: hasR2,
      notRun: rows,
    };
    let all: { steps: Record<string, StepEntry> } = { steps: {} };
    try {
      const read = JSON.parse(fs.readFileSync(NOT_RUN_FILE, 'utf8')) as { steps?: Record<string, StepEntry> };
      if (read && typeof read.steps === 'object' && read.steps) all = { steps: read.steps };
    } catch {
      /* first step of the run, or an unreadable file: start again */
    }
    all.steps[step] = entry;
    fs.mkdirSync(path.dirname(NOT_RUN_FILE), { recursive: true });
    fs.writeFileSync(NOT_RUN_FILE, `${JSON.stringify(all, null, 2)}\n`);

    const where = path.relative(REPO_ROOT, NOT_RUN_FILE).replace(/\\/g, '/');
    if (rows.length === 0) {
      if (LAUNCH_FINAL) console.log(`[launch not-run] step ${step}: every test that depends on this database ran here (${where}).`);
    } else {
      console.log(`[launch not-run] step ${step}: ${rows.length} test(s) NOT RUN ON UAT — not verified by this run (${where}):`);
      for (const r of rows) console.log(`  - [${r.project}] ${r.file} › ${r.title} — ${r.why}`);
    }
    if (!hasR2) {
      console.log('[launch not-run] R2 is not configured: the photo checks inside other tests (if (hasR2) …) did not run either.');
    }
  }
}
