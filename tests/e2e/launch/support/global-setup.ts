/**
 * Launch e2e global setup — runs once, after the webServer is up and before any
 * worker starts. It proves the ground the suite stands on, and fails the run
 * early with a plain reason when any of it is false:
 *
 *   0. not production (again); sweep the registries of crashed runs;
 *   1. the database answers on both URLs and UAT carries the F1 migrations;
 *   2. /api/health answers 200 {status:'ok'};
 *   3. the server under test reads THIS database (a probe account created here
 *      signs in through the page — a fixture round trip, not trust in port 3000);
 *   4. x-forwarded-for reaches the login limiter (bucket login:ip:<the run's probe address>);
 *   5. R2: a probe photo PUT under the probe user's folder streams back through
 *      /api/photos/<id>;
 *   6. sessions, each proven separately: UI sign-in, a MINTED cookie, and
 *      page.request carrying that cookie;
 *   7. the probe world is cleaned up to zero rows and zero objects.
 *
 * The answers reach the workers through process.env (E2E_MINT_OK,
 * E2E_PAGE_REQUEST_OK, E2E_ALIAS_OK).
 */
import { chromium, request as pwRequest, type FullConfig } from '@playwright/test';
import { Prisma } from '@prisma/client';
import { sweepStale, totalOf } from './cleanup';
import {
  BASE_URL,
  RUN_ID,
  SERVER_MODE,
  SESSION_COOKIE,
  assertNotProduction,
  chromiumExecutable,
  db,
  disconnectDb,
  hasR2,
  launchEnabled,
  ownerDb,
  redact,
} from './env';
import { OMAN_TODAY, RUN_OMAN_DATE } from './oman';
import { seedPhoto } from './photos';
import { smallHash } from './ids';
import { r2BucketName } from './r2';
import { pruneCleanRegistries } from './registry';
import { pruneRunLocks } from './runlock';
import { apiSignIn, deviceOptions, mintSessionCookie, signInViaUi } from './sessions';
import { createWorld } from './world';

/** The F1 migrations the build under test needs (prisma migrate status covers the rest). */
const F1_MIGRATIONS = ['20261005100000_notification_kinds_fyi_reactivation', '20261005100100_notification_email_outbox'];
/**
 * The probe's sign-in address: 198.18-19.248-255.x, a block no world uses
 * (world.ts keeps the third octet below 248), picked by the run id so a run
 * from another checkout does not share it — its cleanup would reset our bucket.
 */
const PROBE_HASH = smallHash(`probe:${RUN_ID}`);
const PROBE_IP = `198.${18 + (PROBE_HASH % 2)}.${248 + ((PROBE_HASH >>> 1) % 8)}.${1 + ((PROBE_HASH >>> 4) % 254)}`;

function log(msg: string): void {
  console.log(`[launch setup] ${msg}`);
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (!launchEnabled()) {
    log('RUN_LAUNCH_E2E is not 1 — nothing to prove; every launch test will skip.');
    return;
  }
  assertNotProduction();
  const t0 = Date.now();
  log(
    `run ${RUN_ID} · Oman date ${RUN_OMAN_DATE} (${OMAN_TODAY}) · server ${SERVER_MODE} at ${BASE_URL} · ` +
      `R2 bucket ${hasR2 ? r2BucketName() : '(not configured — photo tests skip)'}`
  );

  try {
    // 0. Crashed runs first, so their rows cannot confuse this one.
    const stale = await sweepStale(RUN_ID);
    if (stale.swept > 0) log(`swept ${stale.swept} world(s) left by earlier runs: ${stale.clean} clean, ${stale.dirty.length} still dirty`);
    for (const d of stale.dirty) log(`  still dirty: ${d.file} ${JSON.stringify(d.leftovers ?? d.error)}`);
    pruneCleanRegistries();
    pruneRunLocks();

    // 1. Database and schema (read-only).
    await db.$queryRaw`SELECT 1`;
    const applied = await ownerDb().$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE migration_name IN (${Prisma.join(F1_MIGRATIONS)}) AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const missing = F1_MIGRATIONS.filter((m) => !applied.some((a) => a.migration_name === m));
    if (missing.length) throw new Error(`UAT lacks migration(s) ${missing.join(', ')} — the build under test needs them`);

    // '@/…' aliases: support code uses relative imports either way; record it for spec authors.
    try {
      await import('@/lib/tz');
      process.env.E2E_ALIAS_OK = '1';
    } catch {
      process.env.E2E_ALIAS_OK = '0';
      log("note: Playwright did not resolve the '@/…' alias — use relative imports in specs");
    }
  } catch (err) {
    throw new Error(`[launch setup] ${redact(String((err as Error).message ?? err))}`);
  }

  // 2. Health.
  const api = await pwRequest.newContext({ baseURL: BASE_URL });
  const health = await api.get('/api/health');
  const body = (await health.json().catch(() => ({}))) as { status?: string };
  if (health.status() !== 200 || body.status !== 'ok') {
    await api.dispose();
    throw new Error(`[launch setup] /api/health answered ${health.status()} ${JSON.stringify(body)}`);
  }

  const world = await createWorld('pr', { users: [{ key: 'VW', role: 'VIEWER' }] });
  const vw = world.user('VW');
  const browser = await chromium.launch({ executablePath: chromiumExecutable() });
  const results: Record<string, boolean> = {};
  try {
    // 4. x-forwarded-for reaches the limiter. A wrong password for a name that
    //    does not exist: no audit row (unknown names are logged only), one bucket.
    world.adopt.ip(PROBE_IP);
    const probeName = `e2e.probe.${world.sfx}`;
    world.adopt.user(probeName);
    await db.rateLimit.deleteMany({ where: { key: { in: [`login:ip:${PROBE_IP}`, `login:user:${probeName}`] } } });
    const wrong = await apiSignIn(api, probeName, `not-the-password-${world.sfx}`, { ip: PROBE_IP });
    if (wrong.signedIn) throw new Error('a wrong password signed in');
    const bucket = await db.rateLimit.findUnique({ where: { key: `login:ip:${PROBE_IP}` } });
    results.xffHonoured = Boolean(bucket);
    if (!bucket) {
      throw new Error(
        `x-forwarded-for is NOT honoured: no login:ip:${PROBE_IP} bucket after a refused sign-in. ` +
          'Is the server under test reading this database?'
      );
    }

    // 5. R2 round trip under the probe user's own folder.
    let photoId: string | null = null;
    if (hasR2) {
      const photo = await seedPhoto(world, { kind: 'FREE', capturedBy: 'VW' });
      photoId = photo.id;
    }

    // 3 + 6a. UI sign-in: the server knows an account that exists only in this database.
    const uiCtx = await browser.newContext(deviceOptions('desktop'));
    const uiPage = await uiCtx.newPage();
    await signInViaUi(uiPage, vw.username, vw.password, { ip: world.ip(1) });
    // The action redirects to /home, which redirects to the role's page: wait for the last hop.
    await uiPage.waitForURL((u) => u.pathname === '/dashboard', { timeout: 60_000 }).catch(() => undefined);
    const landed = new URL(uiPage.url()).pathname;
    const jar = await uiCtx.cookies();
    const uiCookie = jar.find((c) => c.name === SESSION_COOKIE);
    const alert = await uiPage.getByRole('alert').textContent({ timeout: 1_000 }).catch(() => null);
    results.uiSignIn = landed === '/dashboard' && Boolean(uiCookie);
    await uiCtx.close();
    if (!results.uiSignIn) {
      throw new Error(
        `UI sign-in of the probe viewer did not reach /dashboard with a ${SESSION_COOKIE} cookie: landed on ${landed}; ` +
          `cookies [${jar.map((c) => `${c.name}${c.secure ? ' (Secure)' : ''}`).join(', ')}]; form said ${JSON.stringify(alert)} ` +
          '(wrong database behind the server, or the Secure cookie was dropped on http://localhost)'
      );
    }

    // 6b. A minted cookie opens the viewer's home without a sign-in.
    const mintCtx = await browser.newContext(deviceOptions('desktop'));
    await mintCtx.addCookies([await mintSessionCookie(vw)]);
    const stored = (await mintCtx.cookies()).some((c) => c.name === SESSION_COOKIE);
    const mintPage = await mintCtx.newPage();
    await mintPage.goto('/dashboard');
    results.mintedCookie = stored && new URL(mintPage.url()).pathname === '/dashboard' &&
      (await mintPage.getByRole('heading', { level: 1, name: 'Dashboard' }).isVisible().catch(() => false));

    // 6c. page.request carries the context's (Secure) cookie to http://localhost.
    const anon = await api.get(`/api/photos/${photoId ?? 'cprobe000000000000000000'}`);
    const authed = await mintPage.request.get(`/api/photos/${photoId ?? 'cprobe000000000000000000'}`);
    results.pageRequest = anon.status() === 401 && authed.status() === (photoId ? 200 : 404);
    if (photoId) {
      results.r2RoundTrip = authed.status() === 200 && (authed.headers()['content-type'] ?? '').startsWith('image/jpeg');
    }
    await mintCtx.close();

    process.env.E2E_MINT_OK = results.mintedCookie ? '1' : '0';
    process.env.E2E_PAGE_REQUEST_OK = results.pageRequest ? '1' : '0';
    if (!results.mintedCookie) log('minted cookies were NOT accepted — contextAs() will sign in through the page instead');
    if (!results.pageRequest) log('page.request did not carry the session cookie — use the page itself for authenticated calls');
    if (hasR2 && !results.r2RoundTrip) throw new Error('the probe photo did not stream back through /api/photos/<id>');
  } catch (err) {
    throw new Error(`[launch setup] ${redact(String((err as Error).message ?? err))}`);
  } finally {
    await browser.close().catch(() => undefined);
    await api.dispose().catch(() => undefined);
    // 7. The probe leaves nothing behind (a failed cleanup keeps its registry for the sweep).
    const out = await world.cleanup().catch((err: unknown) => ({ leftovers: { cleanupError: 1 }, error: String(err) }));
    probeLeftovers = out.leftovers;
    await disconnectDb();
  }
  if (totalOf(probeLeftovers) !== 0) {
    throw new Error(`[launch setup] the probe world left rows behind: ${JSON.stringify(probeLeftovers)}`);
  }
  log(`probes ${JSON.stringify({ ...results, aliasResolved: process.env.E2E_ALIAS_OK === '1' })} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

let probeLeftovers: Record<string, number> = {};
