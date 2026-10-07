/**
 * Accessibility scans for the launch suite: Deque's axe-core through
 * @axe-core/playwright (pinned 4.13.0), WCAG 2.0 and 2.1, levels A and AA.
 *
 * LAUNCH POLICY — REPORT ONLY. Every scan is attached to the HTML report (the
 * axe JSON as returned), annotated on its test (rule, impact, node count) and
 * merged into test-results/launch-a11y-summary.json (rule, impact, count, page;
 * per project, per run). Nothing here fails a test on a violation. The one gate
 * is evaluated by the spec, on the phone project only, over the salesman's
 * screens and the GATE_RULES below — see a11y.spec.ts.
 *
 * Why these four rules gate and nothing else does:
 *   - each one makes a control unusable, not merely harder: a field or button
 *     with no accessible name is announced as "edit box" / "button" by TalkBack
 *     and VoiceOver, cannot be targeted by voice control ("tap Submit"), and a
 *     field's label is what tells a salesman which box takes the phone number,
 *     the CR number or the reason;
 *   - they are deterministic DOM checks (an element and its name), with no
 *     colour, layout or timing heuristics, so they do not flake between runs,
 *     between headless Chromium and a real phone, or with the data on screen;
 *   - the app already labels its fields (UAT-07: LabeledField's htmlFor/id; the
 *     icon buttons carry aria-label), so a hit is a regression, not old debt.
 * axe rates all four 'critical'. Contrast (serious), ARIA attribute misuse, list
 * structure, link names and the rest are reported for a person to triage after
 * launch. Touch-target size is WCAG 2.2 (`target-size`, tag wcag22aa) and is not
 * in the scanned tags at all.
 *
 * The summary file lives outside the step's output folder (Playwright wipes
 * that), keyed by E2E_RUN_ID: a new run starts it afresh. The phone and desktop
 * projects run in parallel workers, so it is rewritten under a lock directory
 * (mkdir is atomic) and replaced by rename. Its name starts with `launch-`, so
 * the secret-scan reporter checks it like every other launch artefact. Nothing
 * secret can reach it: no password is typed on a scanned page, and axe reads the
 * DOM only (no cookies, no headers).
 */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, redact } from './base';
import { RUN_ID } from './env';
import { projectDevice } from './sessions';

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeRuleResult = AxeResults['violations'][number];
export type Impact = 'critical' | 'serious' | 'moderate' | 'minor' | 'unknown';

/** The WCAG levels scanned: 2.0 and 2.1, A and AA. */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/** The project the gate holds on: the salesman's phone (Pixel 5, 412 px). */
export const GATE_PROJECT = 'phone';
/** Only violations axe rates at this impact gate. */
export const GATE_IMPACT: Impact = 'critical';

/** The must-not-ship rules on the salesman's phone screens, and why each one gates. */
export const GATE_RULES: Readonly<Record<string, string>> = {
  label:
    'A form field with no label: TalkBack reads "edit box", voice control cannot target it, and nothing says whether it takes the phone number, the CR number or the reason.',
  'select-name':
    'A drop-down (channel, sub-channel, visit day, status) with no name: the same failure as `label`, for <select>.',
  'button-name':
    'A button with no name (an icon-only Remove photo, Menu, Approve or Submit): announced as "button" and unreachable by voice control, so the salesman cannot capture, remove or submit.',
  'input-button-name':
    'An <input type="submit|button|reset"> with no value or label: the same failure as `button-name`.',
};

export interface A11yPageDef {
  label: string;
  /** The route, as a pattern (ids are fixture ids, different every run). */
  route: string;
  role: string;
  /** One of the salesman's phone screens: the gate applies on GATE_PROJECT. */
  gate: boolean;
}

/** Every page the a11y report scans, signed in as the role that uses it. */
export const A11Y_PAGES = {
  signIn: { label: 'Sign-in', route: '/login', role: 'signed out', gate: true },
  forcedChange: { label: 'Forced password change', route: '/profile/change-password', role: 'SALESMAN (must change password)', gate: true },
  today: { label: 'Today', route: '/today', role: 'SALESMAN', gate: true },
  search: { label: 'Customer search', route: '/customers?q=…', role: 'SALESMAN', gate: true },
  customer: { label: 'Customer page', route: '/customers/[id]', role: 'SALESMAN', gate: true },
  enrich: { label: 'Enrich form', route: '/customers/[id]/edit', role: 'SALESMAN', gate: true },
  newCustomer: { label: 'New-customer form', route: '/customers/new', role: 'SALESMAN', gate: true },
  needsCorrection: { label: 'Needs correction', route: '/rejected', role: 'SALESMAN', gate: true },
  notifications: { label: 'Notifications', route: '/notifications', role: 'SALESMAN', gate: true },
  approvals: { label: 'Approvals queue', route: '/approvals', role: 'MANAGER', gate: false },
  review: { label: 'Review page', route: '/approvals/[id]', role: 'MANAGER', gate: false },
  reactivations: { label: 'Reactivations', route: '/reactivations', role: 'MANAGER', gate: false },
  dashboard: { label: 'Dashboard', route: '/dashboard', role: 'MANAGER', gate: false },
  users: { label: 'Users', route: '/users', role: 'STEWARD', gate: false },
  import: { label: 'Import', route: '/import', role: 'STEWARD', gate: false },
  temix: { label: 'Temix', route: '/temix', role: 'STEWARD', gate: false },
} as const satisfies Record<string, A11yPageDef>;

export type A11yPageKey = keyof typeof A11Y_PAGES;
export const GATED_PAGES = (Object.keys(A11Y_PAGES) as A11yPageKey[]).filter((k) => A11Y_PAGES[k].gate);

export interface RuleCount {
  rule: string;
  impact: Impact;
  /** Nodes (elements) on the page that break the rule. */
  count: number;
  help: string;
  helpUrl: string;
  /** WCAG success criteria tags (wcag143, …). */
  wcag: string[];
  /** The first few CSS targets, to find the elements. */
  targets: string[];
}

export interface PageScan {
  key: A11yPageKey;
  label: string;
  route: string;
  role: string;
  project: string;
  device: string;
  /** The path actually scanned (fixture ids included). */
  path: string;
  scannedAt: string;
  axeVersion: string;
  violations: RuleCount[];
  /** "Needs review": axe could not decide (e.g. contrast over an image). */
  incomplete: RuleCount[];
  passes: number;
  /** Set when the page could not be reached or scanned; no results then. */
  error?: string;
}

export interface GateFinding {
  page: string;
  route: string;
  rule: string;
  impact: Impact;
  count: number;
  targets: string[];
}

interface SummaryRow {
  project: string;
  page: string;
  route: string;
  rule: string;
  impact: Impact;
  count: number;
}

interface SummaryFile {
  runId: string;
  updatedAt: string;
  axe: { package: string; version: string; tags: readonly string[] };
  policy: {
    mode: 'report-only';
    gate: { project: string; impact: Impact; rules: Readonly<Record<string, string>>; pages: string[] };
  };
  projects: Record<string, { pages: Partial<Record<A11yPageKey, PageScan>> }>;
  /** One row per (project, page, rule), worst impact first. */
  rows: SummaryRow[];
  /** Per rule, over every project and page. */
  byRule: Array<{ rule: string; impact: Impact; nodes: number; pages: number; projects: string[] }>;
  /** The gate's findings per project (only GATE_PROJECT is gated). */
  gate: Record<string, GateFinding[]>;
}

const IMPACT_ORDER: Impact[] = ['critical', 'serious', 'moderate', 'minor', 'unknown'];
const rank = (i: Impact) => IMPACT_ORDER.indexOf(i);
const MAX_TARGETS = 5;
/** Terminal colour codes in Playwright's error messages. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export const SUMMARY_FILE = path.join(REPO_ROOT, 'test-results', 'launch-a11y-summary.json');
const LOCK_DIR = path.join(REPO_ROOT, 'test-results', '.launch-a11y-summary.lock');

function currentProject(info: TestInfo = test.info()): string {
  return info.project.name;
}

// ── settle, scan, record ──────────────────────────────────────────────────────

/**
 * Waits until the page is the page, not its loading state: the load event, the
 * page's own h1 (not the skeleton's), no loading skeleton (.animate-pulse is
 * used only by the loading.tsx skeletons), the network quiet (bounded: Next's
 * link prefetching may keep it busy), web fonts in, and two frames painted.
 */
export async function settle(page: Page, o: { heading?: string | RegExp } = {}): Promise<void> {
  await page.waitForLoadState('load');
  if (o.heading !== undefined) {
    await expect(
      page.getByRole('heading', { level: 1, name: o.heading, ...(typeof o.heading === 'string' ? { exact: true } : {}) })
    ).toBeVisible();
  }
  await expect(page.locator('.animate-pulse'), 'loading skeletons are gone').toHaveCount(0);
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

function countRule(r: AxeRuleResult): RuleCount {
  return {
    rule: r.id,
    impact: (r.impact ?? 'unknown') as Impact,
    count: r.nodes.length,
    help: r.help,
    helpUrl: r.helpUrl,
    wcag: r.tags.filter((t) => /^wcag\d{3,4}$/.test(t)),
    targets: r.nodes.slice(0, MAX_TARGETS).map((n) => JSON.stringify(n.target)),
  };
}

const byImpactThenCount = (a: { impact: Impact; count: number; rule: string }, b: { impact: Impact; count: number; rule: string }) =>
  rank(a.impact) - rank(b.impact) || b.count - a.count || a.rule.localeCompare(b.rule);

function describeScan(s: PageScan): string {
  if (s.error) return `${s.label} (${s.route}): NOT SCANNED — ${s.error}`;
  if (s.violations.length === 0) return `${s.label} (${s.route}): no violations (${s.passes} rules passed, ${s.incomplete.length} to review)`;
  const nodes = s.violations.reduce((n, v) => n + v.count, 0);
  const list = s.violations.map((v) => `${v.rule} ${v.impact} ×${v.count}`).join('; ');
  return `${s.label} (${s.route}): ${s.violations.length} rule(s), ${nodes} node(s) — ${list}`;
}

/**
 * Settles the page, runs axe (WCAG 2.0/2.1 A and AA), attaches the JSON result
 * to the test, annotates the test with what it found and merges it into the
 * run's summary file. Never fails on a violation (report only).
 *
 * resultTypes keeps every violation and "needs review" node, and one example
 * node per passed / inapplicable rule — the result attached is axe's own, just
 * without a node list for each rule that passed.
 */
export async function scanPage(page: Page, key: A11yPageKey, o: { heading?: string | RegExp } = {}): Promise<PageScan> {
  const info = test.info();
  const def: A11yPageDef = A11Y_PAGES[key];
  await settle(page, o);
  const results = await new AxeBuilder({ page })
    .withTags([...WCAG_TAGS])
    .options({ resultTypes: ['violations', 'incomplete'] })
    // `next dev`'s error overlay (a shadow root); absent from the production build.
    .exclude('nextjs-portal')
    .analyze();
  await info.attach(`axe-${key}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  const url = new URL(page.url());
  const scan: PageScan = {
    key,
    label: def.label,
    route: def.route,
    role: def.role,
    project: currentProject(info),
    device: projectDevice(),
    path: `${url.pathname}${url.search}`,
    scannedAt: new Date().toISOString(),
    axeVersion: results.testEngine.version,
    violations: results.violations.map(countRule).sort(byImpactThenCount),
    incomplete: results.incomplete.map(countRule).sort(byImpactThenCount),
    passes: results.passes.length,
  };
  info.annotations.push({ type: 'a11y', description: describeScan(scan) });
  await recordScan(scan);
  return scan;
}

/** Records a page that could not be reached or scanned (the summary says so). */
export async function recordScanError(key: A11yPageKey, err: unknown): Promise<string> {
  const info = test.info();
  const def: A11yPageDef = A11Y_PAGES[key];
  const message = redact(String((err as { message?: unknown })?.message ?? err))
    .replace(ANSI, '')
    .split('\n')
    .slice(0, 6)
    .join(' ')
    .slice(0, 400);
  const scan: PageScan = {
    key,
    label: def.label,
    route: def.route,
    role: def.role,
    project: currentProject(info),
    device: projectDevice(),
    path: '',
    scannedAt: new Date().toISOString(),
    axeVersion: '',
    violations: [],
    incomplete: [],
    passes: 0,
    error: message,
  };
  info.annotations.push({ type: 'a11y', description: describeScan(scan) });
  await recordScan(scan).catch(() => undefined);
  return message;
}

/**
 * One test's scans: each page runs in its own step, and a page that cannot be
 * reached or scanned is recorded and does not stop the next one. `done()` then
 * fails the test, naming every page that was not scanned — an unscanned page is
 * a broken page or a broken fixture, not an accessibility finding.
 */
export function a11yScans(): { page(key: A11yPageKey, body: () => Promise<unknown>): Promise<void>; done(): void } {
  const errors: string[] = [];
  return {
    async page(key, body) {
      await test.step(`a11y: ${A11Y_PAGES[key].label}`, async () => {
        try {
          await body();
        } catch (err) {
          errors.push(`${A11Y_PAGES[key].label}: ${await recordScanError(key, err)}`);
        }
      });
    },
    done() {
      expect(errors, 'pages that could not be reached or scanned').toEqual([]);
    },
  };
}

// ── the gate ──────────────────────────────────────────────────────────────────

/** The must-not-ship findings among `scans` (gated pages, GATE_RULES, GATE_IMPACT). */
export function gateFindings(scans: PageScan[]): GateFinding[] {
  const out: GateFinding[] = [];
  for (const s of scans) {
    if (!A11Y_PAGES[s.key]?.gate) continue;
    for (const v of s.violations) {
      if (!(v.rule in GATE_RULES) || v.impact !== GATE_IMPACT) continue;
      out.push({ page: s.label, route: s.route, rule: v.rule, impact: v.impact, count: v.count, targets: v.targets });
    }
  }
  return out;
}

export function describeFinding(f: GateFinding): string {
  return `${f.page} (${f.route}): ${f.rule} ${f.impact} ×${f.count} — ${f.targets.join(', ')}`;
}

// ── the summary file ──────────────────────────────────────────────────────────

function emptySummary(): SummaryFile {
  return {
    runId: RUN_ID,
    updatedAt: new Date().toISOString(),
    axe: { package: '@axe-core/playwright', version: '', tags: WCAG_TAGS },
    policy: {
      mode: 'report-only',
      gate: {
        project: GATE_PROJECT,
        impact: GATE_IMPACT,
        rules: GATE_RULES,
        pages: GATED_PAGES.map((k) => `${A11Y_PAGES[k].label} (${A11Y_PAGES[k].route})`),
      },
    },
    projects: {},
    rows: [],
    byRule: [],
    gate: {},
  };
}

function readFileSummary(): SummaryFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8')) as SummaryFile;
    return parsed && parsed.runId === RUN_ID && parsed.projects ? parsed : null;
  } catch {
    return null;
  }
}

/** Recomputes rows, byRule and the gate from the per-project pages. */
function derive(s: SummaryFile): SummaryFile {
  const rows: SummaryRow[] = [];
  const rules = new Map<string, { rule: string; impact: Impact; nodes: number; pages: Set<string>; projects: Set<string> }>();
  const gate: Record<string, GateFinding[]> = {};
  for (const [project, part] of Object.entries(s.projects).sort(([a], [b]) => a.localeCompare(b))) {
    const scans = Object.values(part.pages).filter((p): p is PageScan => !!p);
    for (const p of scans) {
      if (p.axeVersion) s.axe.version = p.axeVersion;
      for (const v of p.violations) {
        rows.push({ project, page: p.label, route: p.route, rule: v.rule, impact: v.impact, count: v.count });
        const r = rules.get(v.rule) ?? { rule: v.rule, impact: v.impact, nodes: 0, pages: new Set(), projects: new Set() };
        if (rank(v.impact) < rank(r.impact)) r.impact = v.impact;
        r.nodes += v.count;
        r.pages.add(p.label);
        r.projects.add(project);
        rules.set(v.rule, r);
      }
    }
    if (project === GATE_PROJECT) gate[project] = gateFindings(scans);
  }
  s.rows = rows.sort((a, b) => byImpactThenCount(a, b) || a.project.localeCompare(b.project) || a.page.localeCompare(b.page));
  s.byRule = [...rules.values()]
    .map((r) => ({ rule: r.rule, impact: r.impact, nodes: r.nodes, pages: r.pages.size, projects: [...r.projects].sort() }))
    .sort((a, b) => rank(a.impact) - rank(b.impact) || b.nodes - a.nodes || a.rule.localeCompare(b.rule));
  s.gate = gate;
  s.updatedAt = new Date().toISOString();
  return s;
}

async function withSummaryLock<T>(fn: () => T): Promise<T> {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // A lock left by a worker that died mid-write is broken after a minute.
      try {
        if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > 60_000) fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      } catch {
        /* gone already */
      }
      if (Date.now() > deadline) throw new Error(`a11y summary: ${path.relative(REPO_ROOT, LOCK_DIR)} stayed locked for 30 s`);
      await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 100)));
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

function writeSummary(s: SummaryFile): void {
  const body = `${JSON.stringify(s, null, 2)}\n`;
  const tmp = `${SUMMARY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  try {
    fs.renameSync(tmp, SUMMARY_FILE);
  } catch {
    // Windows refuses a rename over a file another process holds open: write in place.
    fs.writeFileSync(SUMMARY_FILE, body);
    fs.rmSync(tmp, { force: true });
  }
}

/** Merges one page's scan into the run's summary file (replacing an older scan of the same page). */
export async function recordScan(scan: PageScan): Promise<void> {
  await withSummaryLock(() => {
    const s = readFileSummary() ?? emptySummary();
    const part = (s.projects[scan.project] ??= { pages: {} });
    part.pages[scan.key] = scan;
    writeSummary(derive(s));
  });
}

/** This run's scans of one project, in A11Y_PAGES order (empty when nothing was recorded). */
export async function projectScans(project: string): Promise<PageScan[]> {
  const s = await withSummaryLock(() => readFileSummary());
  const pages = s?.projects[project]?.pages ?? {};
  return (Object.keys(A11Y_PAGES) as A11yPageKey[]).map((k) => pages[k]).filter((p): p is PageScan => !!p);
}

/** The project's report: totals, one row per (page, rule), the gate, the pages not scanned. */
export function summaryMarkdown(project: string, scans: PageScan[]): string {
  const scanned = scans.filter((s) => !s.error);
  const missing = (Object.keys(A11Y_PAGES) as A11yPageKey[]).filter((k) => !scanned.some((s) => s.key === k));
  const rows = scanned
    .flatMap((s) => s.violations.map((v) => ({ ...v, page: s.label, route: s.route })))
    .sort((a, b) => byImpactThenCount(a, b) || a.page.localeCompare(b.page));
  const byImpact = IMPACT_ORDER.map((i) => [i, rows.filter((r) => r.impact === i).reduce((n, r) => n + r.count, 0)] as const).filter(([, n]) => n > 0);
  const findings = project === GATE_PROJECT ? gateFindings(scanned) : [];
  const lines = [
    `# Accessibility report — ${project}`,
    '',
    `axe-core ${scanned[0]?.axeVersion ?? '?'} (@axe-core/playwright), tags ${WCAG_TAGS.join(', ')}. Run ${RUN_ID}.`,
    `Launch policy: REPORT ONLY. The gate: ${GATE_IMPACT} ${Object.keys(GATE_RULES).join(' / ')} on the salesman's screens, ${GATE_PROJECT} project only.`,
    '',
    `Pages scanned: ${scanned.length} of ${Object.keys(A11Y_PAGES).length}. Nodes in violation: ${
      byImpact.map(([i, n]) => `${i} ${n}`).join(', ') || 'none'
    }.`,
    '',
    '| Rule | Impact | Count | Page | Route |',
    '| --- | --- | ---: | --- | --- |',
    ...(rows.length ? rows.map((r) => `| ${r.rule} | ${r.impact} | ${r.count} | ${r.page} | \`${r.route}\` |`) : ['| — | — | 0 | every scanned page | — |']),
    '',
    project === GATE_PROJECT
      ? `Gate findings: ${findings.length ? `${findings.length} — the gate test fails` : 'none.'}`
      : `Gate: not applied on ${project} (report only).`,
    ...findings.map((f) => `- ${describeFinding(f)}`),
  ];
  if (missing.length) {
    lines.push('', 'Not scanned:', ...missing.map((k) => `- ${A11Y_PAGES[k].label}${scans.find((s) => s.key === k)?.error ? ` — ${scans.find((s) => s.key === k)!.error}` : ''}`));
  }
  const review = scanned.flatMap((s) => s.incomplete.map((v) => `${v.rule} on ${s.label} ×${v.count}`));
  if (review.length) lines.push('', `Needs review (axe could not decide): ${review.join('; ')}.`);
  lines.push('', `Full detail: each scan's axe JSON is attached to its test; the merged run summary is ${path.relative(REPO_ROOT, SUMMARY_FILE)}.`);
  return `${lines.join('\n')}\n`;
}
