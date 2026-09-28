/**
 * X-AUTH-1: run after `next build`. Proves the change-password page's
 * server-action worker holds only the actions a session that must still change
 * its password is allowed to run.
 *
 * Next registers every export of each 'use server' module that a page's client
 * components import in that page's action worker, and runs any of them when its
 * action id is POSTed to the page's path. /profile/change-password is the one
 * page the middleware lets such a session reach. When its form imported its
 * action from services/users.ts, that worker also held createUser,
 * toggleUserActive, resetPassword and updateUserRole — a flagged Manager or
 * Steward could run all four without ever changing the password.
 *
 * A source check cannot see this: the worker is built from the whole client
 * import graph of the page AND its layouts. The build manifest can. Every action
 * also refuses a flagged session itself (lib/session.ts requireActor); this
 * keeps the page from carrying the actions in the first place.
 *
 *   npx tsx scripts/ci/check-action-workers.ts [.next/server/server-reference-manifest.json]
 */
import { readFileSync } from 'node:fs';

export const CHANGE_PASSWORD_WORKER = 'app/(app)/profile/change-password/page';

/** The change itself, plus sign-in/out, which the (app) layout's sign-out form brings. */
export const ALLOWED_ON_CHANGE_PASSWORD = ['changeOwnPasswordAction', 'loginAction', 'logoutAction'];

type ManifestEntry = { workers?: Record<string, unknown>; exportedName?: string };
export type ServerReferenceManifest = {
  node?: Record<string, ManifestEntry>;
  edge?: Record<string, ManifestEntry>;
};

/** The exported names of every action the given worker holds. */
export function workerActions(manifest: ServerReferenceManifest, worker: string): string[] {
  const names: string[] = [];
  for (const layer of [manifest.node, manifest.edge]) {
    for (const [id, entry] of Object.entries(layer ?? {})) {
      if (entry.workers && Object.hasOwn(entry.workers, worker)) names.push(entry.exportedName ?? `<unnamed ${id}>`);
    }
  }
  return names.sort();
}

/** Why the manifest fails the check; empty when it passes. */
export function actionWorkerProblems(manifest: ServerReferenceManifest): string[] {
  const held = workerActions(manifest, CHANGE_PASSWORD_WORKER);
  // Fail closed: a renamed page or a changed manifest format must not pass on nothing.
  if (!held.includes('changeOwnPasswordAction')) {
    return [
      `${CHANGE_PASSWORD_WORKER} holds no changeOwnPasswordAction — the page moved or the manifest format changed, so this check cannot see anything`,
    ];
  }
  return held
    .filter((name) => !ALLOWED_ON_CHANGE_PASSWORD.includes(name))
    .map((name) => `${name} is callable from ${CHANGE_PASSWORD_WORKER}, which a session that must change its password can reach`);
}

if (/check-action-workers\.ts$/.test(process.argv[1] ?? '')) {
  const file = process.argv[2] ?? '.next/server/server-reference-manifest.json';
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as ServerReferenceManifest;
  const problems = actionWorkerProblems(manifest);
  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  console.log(`ok ${CHANGE_PASSWORD_WORKER} holds only: ${workerActions(manifest, CHANGE_PASSWORD_WORKER).join(', ')}`);
}
