/**
 * Server actions, captured from a real page and replayed — for the deny side
 * (another role, a signed-out caller, a stale token) without a hand-built RSC
 * request.
 *
 *   const a = await captureServerAction(page, () => dialog.getByRole('button', { name: 'Approve' }).click());
 *   await page.close();                                        // the capture page is spent
 *   const r = await replayServerAction(viewerCtx.request, a);   // { refused: true, message: '…' }
 *
 * Capture ABORTS the POST in the browser (it never leaves the browser, so the
 * action does not run) and then mutes that page's console watcher: React may
 * report the failed action as an uncaught error, which is the test's doing.
 * Close the page afterwards. It does NOT hold the request: un-routing a paused
 * request makes Chromium send it on, and the action then RUNS (seen in the
 * harness run of 2026-10-07 — the approval landed although nothing was clicked
 * again).
 *
 * DANGER: a replay runs the action for real when the caller is allowed to. Never
 * replay an unscoped action (Temix Generate moves the WHOLE UAT queue) outside
 * the exclusive phase.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { mutePage } from './checks';
import { BASE_URL, REPO_ROOT } from './env';

export type CapturedAction = {
  url: string;
  /** The Next-Action id the page posted. */
  actionId: string;
  headers: Record<string, string>;
  body: Buffer;
};

export type ReplayResult = {
  status: number;
  text: string;
  /** The action answered `{ ok: false, … }`. */
  refused: boolean;
  /** Next did not find the action in that page's worker ("Server action not found"). */
  notFound: boolean;
  code?: string;
  message?: string;
  /** x-action-redirect / Location, when the action (or the middleware) redirected. */
  redirect: string | null;
};

/**
 * Runs `trigger` and returns the first server-action POST the page makes to the
 * app. `then: 'abort'` (default) fails it in the browser, so it never reaches
 * the server, and mutes the page's console watcher (close the page next);
 * `'send'` lets it through after copying it — the action then runs.
 */
export async function captureServerAction(
  page: Page,
  trigger: () => Promise<void>,
  o: { then?: 'abort' | 'send'; timeout?: number } = {}
): Promise<CapturedAction> {
  const then = o.then ?? 'abort';
  let resolve!: (a: CapturedAction) => void;
  const captured = new Promise<CapturedAction>((r) => (resolve = r));
  let done = false;
  const matcher = (url: URL) => url.origin === BASE_URL;
  const handler = async (route: Route) => {
    const req = route.request();
    if (done || req.method() !== 'POST') return route.fallback();
    const headers = await req.allHeaders();
    const actionId = headers['next-action'];
    if (!actionId) return route.fallback();
    done = true;
    if (then === 'abort') {
      mutePage(page);
      await route.abort('aborted');
    } else {
      await route.fallback();
    }
    resolve({ url: req.url(), actionId, headers, body: req.postDataBuffer() ?? Buffer.alloc(0) });
  };
  await page.route(matcher, handler);
  try {
    await trigger();
    return await Promise.race([
      captured,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('captureServerAction: the page made no server-action POST')), o.timeout ?? 20_000)
      ),
    ]);
  } finally {
    // Safe now: the captured request was already aborted (or sent, when asked).
    await page.unroute(matcher, handler).catch(() => undefined);
  }
}

const DROP = new Set(['host', 'cookie', 'content-length', 'connection', 'origin', 'referer', 'accept-encoding']);

/** Unescapes one JSON string body taken from an RSC line. */
function jsonString(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * POSTs a captured action again, as whoever `request` is signed in as (a
 * context's `ctx.request`, or a fresh `request.newContext()` for signed out),
 * from this origin. `path` sends it to another page's worker; `mutateBody`
 * edits the multipart body (e.g. another editId).
 */
export async function replayServerAction(
  request: APIRequestContext,
  a: CapturedAction,
  o: { path?: string; mutateBody?: (b: Buffer) => Buffer; headers?: Record<string, string> } = {}
): Promise<ReplayResult> {
  const url = o.path ? `${BASE_URL}${o.path}` : a.url;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.headers)) if (!DROP.has(k.toLowerCase()) && !k.startsWith(':')) headers[k] = v;
  headers.origin = BASE_URL;
  headers.referer = url;
  Object.assign(headers, o.headers);
  const res = await request.post(url, {
    headers,
    data: o.mutateBody ? o.mutateBody(a.body) : a.body,
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  const text = await res.text();
  const h = res.headers();
  return {
    status: res.status(),
    text,
    refused: /"ok":false/.test(text),
    notFound: res.status() === 404 || /Server action not found/i.test(text),
    code: jsonString(/"code":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]),
    message: jsonString(/"message":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]),
    redirect: h['x-action-redirect'] ?? h['location'] ?? null,
  };
}

type ManifestEntry = { workers?: Record<string, unknown>; exportedName?: string };
let manifest: { node?: Record<string, ManifestEntry>; edge?: Record<string, ManifestEntry> } | undefined;

/**
 * The id of `exportedName` in a page's action worker, from the build under test
 * (.next/server/server-reference-manifest.json — the file
 * scripts/ci/check-action-workers.ts reads). `worker` is e.g.
 * 'app/(app)/approvals/[id]/page'. Undefined when that worker does not hold it.
 */
export function actionIdFor(exportedName: string, worker: string): string | undefined {
  manifest ??= JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.next', 'server', 'server-reference-manifest.json'), 'utf8'));
  for (const layer of [manifest!.node, manifest!.edge]) {
    for (const [id, entry] of Object.entries(layer ?? {})) {
      if (entry.exportedName === exportedName && entry.workers && Object.hasOwn(entry.workers, worker)) return id;
    }
  }
  return undefined;
}
