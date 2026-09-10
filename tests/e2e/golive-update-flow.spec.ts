/**
 * GO-LIVE BROWSER WALK — the real UI, end to end, in a real Chromium:
 *
 *   salesman: sign in with route code + "12345" → forced password change →
 *             Today → search customer → Enrich → GPS (device geolocation) →
 *             3 photos (camera input → compress → R2 presign/PUT/finalize →
 *             attach) → fill fields → Submit for approval
 *   manager:  sign in → Approvals → open → sees photos + map link → Approve
 *   owner:    field-update report download (highlighted xlsx) + photo fetch
 *
 * Runs against `next dev` on :3000 (Playwright starts it) with the .env of
 * this checkout — i.e. the UAT database and the real R2 bucket. Fixtures are
 * created under a unique suffix and removed afterwards (DB rows AND the R2
 * objects the browser uploaded).
 *
 *   E2E_CHROMIUM=<path to chrome.exe> RUN_GOLIVE_E2E=1 \
 *     node scripts/qa/run-with-env.mjs playwright test tests/e2e/golive-update-flow.spec.ts --project=chromium
 */
import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import bcrypt from 'bcryptjs';
import { deflateSync } from 'node:zlib';

const ENABLED = process.env.RUN_GOLIVE_E2E === '1' && !!process.env.DATABASE_URL;
test.skip(!ENABLED, 'set RUN_GOLIVE_E2E=1 (and DATABASE_URL) to run the go-live browser walk');
test.describe.configure({ mode: 'serial' });

const sfx = `e2e${Date.now().toString(36)}`;
const INITIAL_PASSWORD = '12345';
const NEW_PASSWORD = `Route-${sfx}-2026!`;
const SHOP_GPS = { latitude: 23.5881, longitude: 58.3829, accuracy: 9 };

/** Minimal valid PNG (solid colour) — distinct bytes per slot so R2/finalize dedupe does not collapse them. */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      // a little gradient so the JPEG is not a flat block
      raw[o] = (rgb[0] + x) & 0xff;
      raw[o + 1] = (rgb[1] + y) & 0xff;
      raw[o + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const prisma = new PrismaClient();
const F = {
  regionId: '',
  routeId: '',
  // A TWO-character route code on purpose: real routes C1–C9 and W sign in with
  // two characters, and two of the three username schemas had already been
  // relaxed for that while the login action's own schema still demanded three.
  routeCode: `Z${Date.now() % 10}`,
  managerUsername: `e2e.mgr.${sfx}`,
  managerId: '',
  salesmanId: '',
  customerId: '',
  branchId: '',
  customerCode: `${sfx}-001`,
  customerName: `Al Fajr Trading ${sfx}`,
};

test.beforeAll(async () => {
  if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
  const clash = await prisma.route.findUnique({ where: { code: F.routeCode }, select: { id: true } });
  if (clash) throw new Error(`route ${F.routeCode} already exists on this database — pick another`);
  const gt = await prisma.channel.findFirstOrThrow({ where: { key: 'GENERAL_TRADE' } });
  const region = await prisma.region.create({
    data: { code: `E2R${sfx}`.toUpperCase(), name: `E2E Region ${sfx}` },
  });
  const route = await prisma.route.create({
    data: { code: F.routeCode, name: `E2E route ${sfx}`, regionId: region.id },
  });
  const hash = await bcrypt.hash(INITIAL_PASSWORD, 12);
  const manager = await prisma.user.create({
    data: {
      username: F.managerUsername,
      fullName: `E2E Manager ${sfx}`,
      role: 'MANAGER',
      passwordHash: hash,
      managedRegions: { connect: { id: region.id } },
    },
  });
  const salesman = await prisma.user.create({
    data: {
      username: F.routeCode.toLowerCase(),
      fullName: `E2E Salesman ${sfx}`,
      role: 'SALESMAN',
      passwordHash: hash,
      mustChangePassword: true, // exactly how the account master creates them
      supervisorId: manager.id,
      ownedRouteId: route.id,
    },
  });
  const customer = await prisma.customer.create({
    data: {
      nmwcCode: F.customerCode,
      legalName: F.customerName,
      paymentTerms: 'CASH',
      channelId: gt.id,
      temixCode: F.customerCode,
      branches: {
        create: {
          branchCode: `${F.customerCode}-01`,
          branchName: `${F.customerName} shop`,
          regionId: region.id,
          routeId: route.id,
          address: 'Imported address',
        },
      },
    },
    include: { branches: true },
  });
  F.regionId = region.id;
  F.routeId = route.id;
  F.managerId = manager.id;
  F.salesmanId = salesman.id;
  F.customerId = customer.id;
  F.branchId = customer.branches[0]!.id;
});

test.afterAll(async () => {
  if (!F.customerId) return;
  // R2 objects the browser uploaded.
  const atts = await prisma.attachment.findMany({
    where: { capturedById: F.salesmanId },
    select: { id: true, r2Key: true },
  });
  if (atts.length && process.env.R2_ACCOUNT_ID) {
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
    for (const a of atts) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: a.r2Key }))
        .catch(() => undefined);
    }
  }
  const users = [F.managerId, F.salesmanId];
  const editIds = (
    await prisma.customerEdit.findMany({ where: { customerId: F.customerId }, select: { id: true } })
  ).map((e) => e.id);
  await prisma.notification.deleteMany({ where: { OR: [{ editId: { in: editIds } }, { userId: { in: users } }] } });
  await prisma.editApproval.deleteMany({ where: { editId: { in: editIds } } });
  await prisma.customerEdit.deleteMany({ where: { id: { in: editIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
  await prisma.passwordHistory.deleteMany({ where: { userId: { in: users } } }).catch(() => undefined);
  await prisma.rateLimit.deleteMany({
    where: { key: { in: users.flatMap((u) => [`edit:${u}`, `photo:${u}`, `login:${F.routeCode.toLowerCase()}`, `login:${F.managerUsername}`]) } },
  });
  await prisma.customer.update({ where: { id: F.customerId }, data: { crPhotoId: null } });
  await prisma.branch.update({ where: { id: F.branchId }, data: { shopPhotoId: null, signboardPhotoId: null } });
  await prisma.attachment.deleteMany({ where: { capturedById: { in: users } } });
  await prisma.branch.deleteMany({ where: { customerId: F.customerId } });
  await prisma.customer.delete({ where: { id: F.customerId } });
  await prisma.user.updateMany({ where: { id: { in: users } }, data: { ownedRouteId: null, supervisorId: null } });
  await prisma.user.update({ where: { id: F.managerId }, data: { managedRegions: { set: [] } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.route.delete({ where: { id: F.routeId } });
  await prisma.region.delete({ where: { id: F.regionId } });
  await prisma.$disconnect();
});

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/login');
  // The button is inert until React has hydrated (a pre-hydration submit would
  // be a native GET with the credentials in the URL) — wait for the marker.
  await page.locator('form[data-hydrated="1"]').waitFor({ timeout: 120_000 });
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
}

/** `next dev` compiles routes on first hit; give client components time to hydrate. */
async function settled(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => undefined);
}

/** A `Field` in EnrichmentForm renders <label>text</label><input|textarea>. */
function field(page: Page, label: string) {
  return page.locator(`label:text-is("${label}") + input, label:text-is("${label}") + textarea`).first();
}

let editId = '';

test('salesman: route-code login, forced password change, Today, search, enrich with GPS + photos, submit', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    geolocation: SHOP_GPS,
    permissions: ['geolocation'],
    viewport: { width: 412, height: 915 }, // a phone
  });
  const page = await ctx.newPage();

  // 1. first login with the initial password lands on the forced change page
  await signIn(page, F.routeCode.toLowerCase(), INITIAL_PASSWORD);
  // AUTH-09: the forced-change page is what the salesman sees, whatever the
  // address bar says (the client router keeps the action's target URL when the
  // middleware redirects the RSC fetch).
  await expect(page.getByRole('heading', { name: /change password/i })).toBeVisible();
  await expect(page.getByText(/must change your password/i)).toBeVisible();
  await settled(page);
  await page.locator('input[name="currentPassword"]').fill(INITIAL_PASSWORD);
  await page.locator('input[name="newPassword"]').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: /change password/i }).click();
  await expect(page.getByText(/password changed/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  // the old password is dead
  await signIn(page, F.routeCode.toLowerCase(), INITIAL_PASSWORD);
  await expect(page.getByRole('alert')).toBeVisible();

  // 2. real login → Today
  await signIn(page, F.routeCode.toLowerCase(), NEW_PASSWORD);
  await expect(page).toHaveURL(/\/today/);
  await expect(page.getByText('Route customers')).toBeVisible();
  await expect(page.getByRole('link', { name: /all my customers/i }).first()).toBeVisible();

  // 3. search → profile → Enrich
  await page.goto(`/customers?q=${encodeURIComponent('al fajr')}`);
  await page.getByRole('link', { name: new RegExp(F.customerName) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/customers/${F.customerId}$`));
  await page.getByRole('link', { name: /enrich/i }).click();
  await expect(page).toHaveURL(new RegExp(`/customers/${F.customerId}/edit`));
  await settled(page);

  // 4. the gate is visible before anything is filled
  const submit = page.getByRole('button', { name: /submit for approval/i });
  await expect(submit).toBeDisabled();
  await expect(page.getByText(/cannot submit yet/i)).toBeVisible();

  // 5. fields
  const subSelect = page.locator('label:text-is("Sub-channel *") + select');
  await subSelect.selectOption({ index: 1 });
  await field(page, 'Primary phone *').fill('+968 9555 1234');
  await field(page, 'Contact person *').fill('Salim Al Balushi');
  await field(page, 'CR number').fill('CR-778899');
  await field(page, 'Address *').fill('Way 3012, Al Ghubra North, Muscat — opposite the bakery');
  await page.locator('label:has-text("Day of visit") + select').selectOption('SUN');

  // 6. GPS from the (emulated) device
  await page.getByRole('button', { name: /capture gps/i }).click();
  await expect(page.getByText(/23\.5881\d*, 58\.3829/)).toBeVisible();

  // 7. photos: CR (identity), then shop + signboard on the branch
  const inputs = page.locator('input[type="file"]');
  await inputs.nth(0).setInputFiles({ name: 'cr.png', mimeType: 'image/png', buffer: png(640, 480, [200, 40, 40]) });
  await inputs.nth(1).setInputFiles({ name: 'shop.png', mimeType: 'image/png', buffer: png(800, 600, [40, 160, 60]) });
  await inputs.nth(2).setInputFiles({ name: 'sign.png', mimeType: 'image/png', buffer: png(720, 400, [30, 60, 220]) });
  await expect
    .poll(
      async () => {
        const [c, b] = await Promise.all([
          prisma.customer.findUnique({ where: { id: F.customerId }, select: { crPhotoId: true } }),
          prisma.branch.findUnique({ where: { id: F.branchId }, select: { shopPhotoId: true, signboardPhotoId: true } }),
        ]);
        return [c?.crPhotoId, b?.shopPhotoId, b?.signboardPhotoId].filter(Boolean).length;
      },
      { timeout: 90_000, message: 'three photos wired to their slots (presign → R2 PUT → finalize → attach)' }
    )
    .toBe(3);
  await expect(page.getByText(/upload failed|could not get upload url|finalize failed/i)).toHaveCount(0);

  // 8. the gate clears WITHOUT a page reload, submit goes to the manager
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page).toHaveURL(new RegExp(`/customers/${F.customerId}$`));
  await expect(page.getByText(/submitted 1[0-9]? change|submitted \d+ change/i).first()).toBeVisible();
  const edit = await prisma.customerEdit.findFirstOrThrow({
    where: { customerId: F.customerId, state: 'SUBMITTED' },
  });
  editId = edit.id;
  expect(edit.pendingRole).toBe('SUPERVISOR');
  const changes = edit.fieldChanges as Array<{ field: string; after: unknown }>;
  expect(changes.some((c) => c.field === 'customer.primaryPhone')).toBe(true);
  expect(changes.some((c) => c.field.endsWith('.gpsLat') && Math.abs((c.after as number) - SHOP_GPS.latitude) < 0.001)).toBe(true);
  // the attachment carries the capture position too
  const att = await prisma.attachment.findFirst({ where: { capturedById: F.salesmanId, kind: 'SHOP' } });
  expect(att?.capturedLat).toBeCloseTo(SHOP_GPS.latitude, 3);
  expect(att?.mimeType).toBe('image/jpeg'); // compressed client-side
  // Work items shows it as awaiting approval
  await page.goto('/work');
  await expect(page.getByText(/awaiting approval/i).first()).toBeVisible();
  await ctx.close();
});

test('manager: sees the edit in Approvals with photos + map, approves; changes go live; report highlights them', async ({
  browser,
}) => {
  expect(editId, 'the salesman test must have submitted an edit').toBeTruthy();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, F.managerUsername, INITIAL_PASSWORD);
  await expect(page).toHaveURL(/\/dashboard/);
  // the new nav entry
  await page.getByRole('link', { name: /^approvals$/i }).first().click();
  await expect(page).toHaveURL(/\/approvals$/);
  await page.getByRole('link', { name: new RegExp(F.customerName) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/approvals/${editId}`));
  await settled(page);
  // diff + live evidence
  await expect(page.getByText('primaryPhone')).toBeVisible();
  await expect(page.getByText('+96895551234').first()).toBeVisible(); // stored normalized
  await expect(page.getByText(/photos & location on file/i)).toBeVisible();
  const photoImgs = page.locator('img[src^="/api/photos/"]');
  await expect(photoImgs).toHaveCount(3);
  // The imported branch has no GPS yet — the proposed pin is what the manager reviews.
  await expect(page.getByText(/no gps on file/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /view proposed location on map/i })).toBeVisible();
  // the photo bytes really come back from R2 through the scope-checked route
  const src = await photoImgs.first().getAttribute('src');
  const img = await page.request.get(src!);
  expect(img.status()).toBe(200);
  expect(img.headers()['content-type']).toBe('image/jpeg');
  expect((await img.body()).length).toBeGreaterThan(200);

  // approve (modal confirm)
  await page.getByRole('button', { name: /approve/i }).first().click();
  await page.getByRole('button', { name: /^approve$/i }).last().click();
  await expect(page).toHaveURL(/\/approvals$/);
  const after = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } });
  expect(after.state).toBe('APPROVED');
  const live = await prisma.customer.findUniqueOrThrow({
    where: { id: F.customerId },
    include: { branches: true },
  });
  expect(live.primaryPhone).toBe('+96895551234');
  expect(live.contactPerson).toBe('Salim Al Balushi');
  expect(live.branches[0]!.gpsLat).toBeCloseTo(SHOP_GPS.latitude, 3);
  expect(live.branches[0]!.dayOfVisit).toBe('SUN');

  // the profile now shows the photos and a map link
  await page.goto(`/customers/${F.customerId}`);
  await expect(page.getByRole('link', { name: /open in maps/i })).toBeVisible();
  await expect(page.locator('img[src^="/api/photos/"]')).toHaveCount(3);

  // field-update report with the changed cells highlighted (manager scope = the region)
  const since = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const res = await page.request.get(`/api/exports/changes?since=${since}&regionId=${F.regionId}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('spreadsheetml');
  expect(Number(res.headers()['x-row-count'])).toBe(1);
  expect(Number(res.headers()['x-changed-rows'])).toBe(1);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(new Uint8Array(await res.body()).buffer as ArrayBuffer);
  const ws = wb.getWorksheet('Customers')!;
  const header: string[] = [];
  ws.getRow(1).eachCell((c, i) => (header[i] = String(c.value)));
  const row = ws.getRow(2);
  const fill = (name: string) =>
    (row.getCell(header.indexOf(name)).fill as { fgColor?: { argb?: string } })?.fgColor?.argb ?? null;
  expect(String(row.getCell(header.indexOf('cust_code')).value)).toBe(F.customerCode);
  expect(fill('phone')).toBe('FFFFFF00');
  expect(fill('gps_lat')).toBe('FFFFFF00');
  expect(fill('shop_photo')).toBe('FFFFFF00');
  expect(fill('cust_name')).toBeNull();
  expect(wb.getWorksheet('Changes')!.rowCount).toBeGreaterThan(5);
  await ctx.close();
});
