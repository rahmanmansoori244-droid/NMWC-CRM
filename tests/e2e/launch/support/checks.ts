/**
 * Watchers and assertions shared by every launch spec.
 *
 * watchPage() is attached by contextAs() to every page. A page error, a React
 * hydration error (#418/#423/#425, "Hydration failed", "did not match") or a CSP
 * refusal fails the test in its afterEach (installLaunchHooks), unless it is a
 * KNOWN bug on an allow-listed URL. The allow-list is by URL, not opted into per
 * test: many specs load /notifications, and #418 fires there on every full load
 * until the bug is fixed. When a bug is fixed, set `open: false` — its
 * allow-list entry then stops applying and its test.fail() marker shows the fix
 * as an unexpected pass.
 */
import { createHash } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AuditAction, AuditLog, Notification } from '@prisma/client';
import { db } from './env';

export type KnownBugId =
  | 'needsCorrectionNeverClears'
  | 'utcTimes'
  | 'notificationsHydration'
  | 'reactivationSilent'
  | 'reactivationReasonOverwritten'
  | 'closureLeavesCustomerActive'
  | 'rawSupervisorAudience'
  | 'noRegionEmptyState'
  | 'usersGreenRefusals'
  | 'ownRowActions'
  | 'managerAuditScope'
  | 'mustActNotCleared'
  | 'presignGeneric'
  | 'returnedUpdateNotPrefilled'
  | 'draftRows'
  | 'temixValidationFailed'
  | 'gmEscalationBroadcast'
  | 'stewardEscalationLink'
  | 'importGreen'
  | 'untrimmedReason'
  | 'strayEvidencePhoto'
  | 'finalCodeNotShown'
  | 'createReadonlyGps'
  | 'noProfileLink'
  | 'exportNotInMenu'
  | 'rejectedUnreachableOnPhone'
  | 'reactivationWording'
  | 'exportRawJson'
  | 'drawerA11y'
  | 'promoteLocale';

type Bug = { open: boolean; title: string; where: string };

/** Open defects, asserted only in their own tests: test.fail(KNOWN_BUGS.x.open, KNOWN_BUGS.x.title). */
export const KNOWN_BUGS: Record<KnownBugId, Bug> = {
  needsCorrectionNeverClears: {
    open: true,
    title: 'Returned work never leaves the Needs-correction lists after a resubmit',
    where: 'services/edits.ts (new row per resubmit); today/work/rejected pages count by submitter',
  },
  utcTimes: {
    open: true,
    title: 'Server-rendered dates and times are in UTC, four hours behind Oman',
    where: 'toLocale*String without timeZone on approvals/[id], audit, customers/[id], import, profile, rejected, team, temix, users, work, today header',
  },
  notificationsHydration: {
    open: true,
    title: '/notifications throws React #418 on every full load (createdAt formatted without timeZone)',
    where: 'app/(app)/notifications/NotificationList.tsx',
  },
  reactivationSilent: {
    open: true,
    title: 'The salesman is never told the outcome of a reactivation request',
    where: 'services/reactivations.ts approve / keep closed',
  },
  reactivationReasonOverwritten: {
    open: true,
    title: "'Keep closed' overwrites the salesman's own reason",
    where: 'services/reactivations.ts decisionReason',
  },
  closureLeavesCustomerActive: {
    open: true,
    title: "Closing a customer's only branch leaves the customer ACTIVE",
    where: 'services/edits.ts applyEditChanges',
  },
  rawSupervisorAudience: {
    open: true,
    title: 'An update / create request alerts submittedBy.supervisorId as stored (nobody when null or inactive)',
    where: 'lib/notifications.ts resolveStepAudience',
  },
  noRegionEmptyState: {
    open: true,
    title: "A region-less Manager/Accountant sees 'Nothing pending' instead of a missing-region warning",
    where: 'app/(app)/approvals/page.tsx, reactivations/page.tsx; /users cannot set regions',
  },
  usersGreenRefusals: {
    open: true,
    title: 'Refused password resets and disables are shown in success green',
    where: 'app/(app)/users/UserRowActions.tsx',
  },
  ownRowActions: {
    open: true,
    title: "Disable and Reset are offered on the viewer's own row and always fail",
    where: 'app/(app)/users/page.tsx',
  },
  managerAuditScope: {
    open: true,
    title: "A Manager's audit log hides his region's decisions and shows every region's user/import events",
    where: 'app/(app)/audit/page.tsx',
  },
  mustActNotCleared: {
    open: true,
    title: "A request decided by another manager still counts in the direct supervisor's red bell",
    where: 'services/notifications-actions.ts (only readAt writer)',
  },
  presignGeneric: {
    open: true,
    title: "A signed-out or rate-limited photo upload shows a generic 'Could not get upload URL.'",
    where: 'app/api/photos/presign + finalize; components/nmwc/PhotoCaptureSlot.tsx',
  },
  returnedUpdateNotPrefilled: {
    open: true,
    title: 'A returned update makes the salesman re-type everything (no reason, no returned values)',
    where: 'app/(app)/customers/[id]/edit/page.tsx',
  },
  draftRows: {
    open: true,
    title: "'Save draft' inserts a DRAFT row per save, shown as 'submitted N change(s)'",
    where: 'services/edits.ts; customers/[id] activity list',
  },
  temixValidationFailed: {
    open: true,
    title: "Temix refusals all read 'Validation failed'",
    where: 'services/temix.ts; app/(app)/temix/TemixActions.tsx',
  },
  gmEscalationBroadcast: {
    open: true,
    title: 'A late GM step notifies every active Manager in the company',
    where: 'lib/escalation.ts',
  },
  stewardEscalationLink: {
    open: true,
    title: 'Stewards escalated on a new-customer request are linked to /work, which does not list it',
    where: 'lib/notification-links.ts',
  },
  importGreen: {
    open: true,
    title: 'An import where every row was refused still reports in green',
    where: 'app/(app)/import/forms.tsx',
  },
  untrimmedReason: {
    open: true,
    title: 'The close-shop form accepts five spaces as a reason (the server then refuses)',
    where: 'components/nmwc/BranchStatusActions.tsx',
  },
  strayEvidencePhoto: {
    open: true,
    title: 'The close-shop evidence photo is attached live before submit and stays after Cancel',
    where: 'components/nmwc/BranchStatusActions.tsx',
  },
  finalCodeNotShown: {
    open: true,
    title: 'The Accountant never sees the NMWC code he has just created',
    where: 'services/edits.ts approveEditAndGoAction; approvals/[id] subtitle',
  },
  createReadonlyGps: {
    open: true,
    title: "A request in review still lets the salesman 'fix' its GPS chip",
    where: 'app/(app)/customers/new/CreateCustomerForm.tsx GpsCaptureButton',
  },
  noProfileLink: {
    open: true,
    title: 'Only salesmen can reach Change password (no profile link for other roles)',
    where: 'components/nmwc/Sidebar.tsx, TopBar.tsx',
  },
  exportNotInMenu: {
    open: true,
    title: 'Only the Steward menu offers Export, though Managers, Viewers and Supervisors may use it',
    where: 'components/nmwc/Sidebar.tsx; lib/permissions.ts',
  },
  rejectedUnreachableOnPhone: {
    open: true,
    title: 'On a phone a salesman cannot reach /rejected',
    where: 'components/nmwc/Sidebar.tsx tab bar; today Needs-correction tile',
  },
  reactivationWording: {
    open: true,
    title: "Reactivations are described as going to the supervisor (a Manager decides them)",
    where: 'app/(app)/rejected/page.tsx, work/page.tsx',
  },
  exportRawJson: {
    open: true,
    title: 'The export page leaves the app with raw JSON on an error',
    where: 'app/(app)/export/ExportFiltersForm.tsx',
  },
  drawerA11y: {
    open: true,
    title: 'The phone menu drawer has no dialog role, focus trap or close-on-current-item',
    where: 'components/nmwc/Sidebar.tsx MobileNavDrawer',
  },
  promoteLocale: {
    open: true,
    title: 'The Promote button breaks hydration in non-English browsers (toLocaleString without a locale)',
    where: 'app/(app)/import/[batchId]/PromoteButton.tsx',
  },
};

/** Console errors that are a KNOWN bug on a known page — by URL, for every test. */
const ALLOWED: Array<{ bug: KnownBugId; url: RegExp; text: RegExp; locales?: string[] }> = [
  { bug: 'notificationsHydration', url: /\/notifications(\?|#|$)/, text: /#418|#423|#425|Hydration|did not match/i },
  { bug: 'promoteLocale', url: /\/import\/[^/?#]+/, text: /#418|#423|#425|Hydration|did not match/i, locales: ['de-DE', 'ar-OM'] },
];

/** What makes a console error a failure. */
const FATAL_CONSOLE = /Hydration failed|did not match|Minified React error #(418|423|425)|Refused to|\[csp-violation\]/i;

type Problem = { url: string; text: string; kind: 'pageerror' | 'console' | 'csp' };
type Watch = { page: Page; problems: Problem[]; known: Problem[]; locale: string; muted: boolean };
const watches = new Map<string, Watch[]>();

function currentTestId(): string {
  try {
    return test.info().testId;
  } catch {
    return 'outside-test';
  }
}

function allowed(p: Problem, locale: string): KnownBugId | null {
  for (const a of ALLOWED) {
    if (!KNOWN_BUGS[a.bug].open) continue;
    if (a.locales && !a.locales.includes(locale)) continue;
    if (a.url.test(p.url) && a.text.test(p.text)) return a.bug;
  }
  return null;
}

/** Starts watching one page. contextAs() calls it for every page it opens. */
export function watchPage(page: Page, o: { locale?: string; testId?: string } = {}): { problems(): Problem[] } {
  const w: Watch = { page, problems: [], known: [], locale: o.locale ?? 'en-GB', muted: false };
  const id = o.testId ?? currentTestId();
  watches.set(id, [...(watches.get(id) ?? []), w]);
  const record = (p: Problem) => {
    if (!w.muted) (allowed(p, w.locale) ? w.known : w.problems).push(p);
  };
  page.on('pageerror', (err) => record({ url: page.url(), text: String(err?.message ?? err), kind: 'pageerror' }));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (FATAL_CONSOLE.test(text)) record({ url: page.url(), text, kind: text.includes('[csp-violation]') ? 'csp' : 'console' });
  });
  return { problems: () => [...w.problems] };
}

/**
 * Stops failing the test on this page's errors from now on. For a page the test
 * has deliberately broken and is about to close — captureServerAction() aborts
 * the action POST it captured, and React may report that as an uncaught error.
 */
export function mutePage(page: Page): void {
  for (const list of watches.values()) for (const w of list) if (w.page === page) w.muted = true;
}

/**
 * Context-level init script: the browser logs most CSP refusals itself; this
 * reports the ones raised only as a securitypolicyviolation event. contextAs()
 * installs it before the first page exists.
 */
export function cspListenerScript(): void {
  document.addEventListener('securitypolicyviolation', (e) => {
    console.error(`[csp-violation] Refused to load ${e.blockedURI} (${e.violatedDirective})`);
  });
}

/** Fails the current test on any unexpected page error, hydration error or CSP refusal. */
export function expectCleanConsole(): void {
  const id = currentTestId();
  const list = watches.get(id) ?? [];
  watches.delete(id);
  const problems = list.flatMap((w) => w.problems);
  const known = list.flatMap((w) => w.known);
  if (known.length > 0) {
    test.info().annotations.push({ type: 'known-bug-console', description: `${known.length} allow-listed console error(s)` });
  }
  expect(problems.map((p) => `${p.kind} on ${p.url}: ${p.text.slice(0, 300)}`), 'page errors / hydration / CSP').toEqual([]);
}

/** No horizontal scroll at the current viewport. */
export async function expectNoSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(1);
}

/** None of `needles` appears in the page text (scope leaks). */
export async function expectNoDataLeak(page: Page, needles: string[]): Promise<void> {
  const text = await page.locator('body').innerText();
  for (const n of needles) expect(text, `page must not show "${n}"`).not.toContain(n);
}

/** Whether the element at the locator's centre is the locator itself (not covered). */
export async function hitTest(page: Page, l: Locator): Promise<boolean> {
  const box = await l.boundingBox();
  if (!box) return false;
  const handle = await l.elementHandle();
  return page.evaluate(
    ([x, y, el]) => {
      const hit = document.elementFromPoint(x as number, y as number);
      return !!hit && (hit === el || (el as Element).contains(hit));
    },
    [box.x + box.width / 2, box.y + box.height / 2, handle] as const
  );
}

/**
 * Navigates with a full load. Use after a change made in ANOTHER context: the
 * client router reuses RSC payloads for 30 s (staleTimes.dynamic), so a tab or
 * Back navigation can show the page as it was before the change.
 */
export async function freshGoto(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'load' });
}

/**
 * Reloads until `check` passes. For data behind the 5-minute reference-data
 * cache (filter dropdowns), assert through URL parameters and the rows shown
 * instead of waiting for option lists.
 */
export async function reloadUntil(page: Page, check: () => Promise<boolean>, o: { timeout?: number; every?: number } = {}): Promise<void> {
  const deadline = Date.now() + (o.timeout ?? 60_000);
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('reloadUntil: condition never held');
    await page.waitForTimeout(o.every ?? 2_000);
    await page.reload({ waitUntil: 'load' });
  }
}

// ── database read-backs (read-only) ──────────────────────────────────────────

export type SnapshotTable = 'CustomerEdit' | 'Attachment' | 'Branch' | 'User' | 'ImportBatch' | 'TemixSyncBatch' | 'Customer';

/**
 * JSON with object keys sorted, for hashing. Dates and Prisma Decimals are
 * already strings here (JSON.stringify calls their toJSON before the replacer).
 */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'bigint') return `${v}n`;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    }
    return v;
  });
}

/**
 * A hash of every row the `where` selects in each table, for "nothing changed"
 * assertions (a refused replay, a skipped import). `where` is one filter for
 * every table, or a per-table map: snapshot(['Branch'], { Branch: { customerId } }).
 * Fixture rows only — pass a where that names them.
 */
export async function snapshot(
  tables: SnapshotTable[],
  where: Record<string, unknown> | Partial<Record<SnapshotTable, Record<string, unknown>>>
): Promise<string> {
  const perTable = tables.every((t) => !(t in where)) ? null : (where as Partial<Record<SnapshotTable, Record<string, unknown>>>);
  const parts: string[] = [];
  for (const t of [...tables].sort()) {
    const w = perTable ? perTable[t] : where;
    if (!w || Object.keys(w).length === 0) throw new Error(`snapshot(${t}): an empty where would read the whole table`);
    const model = (db as unknown as Record<string, { findMany(a: unknown): Promise<unknown[]> }>)[t.charAt(0).toLowerCase() + t.slice(1)]!;
    const rows = await model.findMany({ where: w, orderBy: { id: 'asc' } });
    parts.push(`${t}:${stable(rows)}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** The in-app notifications about one request, or of one user, oldest first. */
export async function notificationsFor(o: { editId?: string; userId?: string; customerId?: string }): Promise<Notification[]> {
  const where = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  if (Object.keys(where).length === 0) throw new Error('notificationsFor: name an editId, userId or customerId');
  return db.notification.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}

/** Audit rows by entity, actor and/or action, oldest first. */
export async function auditFor(o: { entityId?: string; actorId?: string; action?: AuditAction; entityType?: string }): Promise<AuditLog[]> {
  const where = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  if (!o.entityId && !o.actorId) throw new Error('auditFor: name an entityId or actorId (the audit log is large)');
  return db.auditLog.findMany({ where, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
}
